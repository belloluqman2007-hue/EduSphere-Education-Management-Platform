"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — seed
   ----------------------------------------------------------------------------
   1. Creates the default subscription plans (FREE / BASIC / PREMIUM) if absent.
   2. Creates the single platform SUPER ADMIN on a fresh database, using the
      SUPER_ADMIN_USERNAME / SUPER_ADMIN_PASSWORD environment variables.
      (Nothing is created if a super admin already exists.)
   3. With the --demo flag, creates two fully-populated demo madaris so the
      platform (and tenant isolation) can be tried immediately.

   Usage:  npm run seed          (plans + super admin)
           npm run seed -- --demo (also demo data)
   ========================================================================== */
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("./db");
const config = require("./config");
const { migrate } = require("./migrate");
const grading = require("./services/grading");
const catalogue = require("./services/plan-catalogue");

/* ------------------------------ date helpers ------------------------------
   Demo data is generated RELATIVE TO TODAY so the dashboards, attendance
   screens and analytics windows are always populated whenever the seed runs.
   (The previously hard-coded 2025/2026 dates went stale and left every
   analytics chart empty.) */
function isoDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function daysAgo(n, from = new Date()) {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

/* The three tiers and everything they mean live in ONE place — the plan
   catalogue. The seed only decides prices, limits and trial length; the
   feature keys and the marketing copy come from the catalogue so the pricing
   page, the feature gates and the assistant can never disagree with each
   other. Limits and expiry behaviour are deliberately unchanged. */
const DEFAULT_PLANS = [
  {
    code: "free", name: catalogue.TIERS.free.name, name_ar: catalogue.TIERS.free.name_ar,
    description: catalogue.TIERS.free.tagline,
    price_ngn: 0, price_yearly_ngn: 0, trial_days: 0,
    student_limit: 50, teacher_limit: 3,
    features: catalogue.featuresForTier("free"),
    sort_order: 1,
  },
  {
    code: "basic", name: catalogue.TIERS.basic.name, name_ar: catalogue.TIERS.basic.name_ar,
    description: catalogue.TIERS.basic.tagline,
    // Yearly = ten monthly payments, i.e. two months free.
    price_ngn: 8000, price_yearly_ngn: 80000, trial_days: 14,
    student_limit: 300, teacher_limit: 15,
    features: catalogue.featuresForTier("basic"),
    sort_order: 2,
  },
  {
    code: "premium", name: catalogue.TIERS.premium.name, name_ar: catalogue.TIERS.premium.name_ar,
    description: catalogue.TIERS.premium.tagline,
    price_ngn: 20000, price_yearly_ngn: 200000, trial_days: 14,
    student_limit: -1, teacher_limit: -1,
    features: catalogue.featuresForTier("premium"),
    sort_order: 3,
  },
];

async function seedPlans() {
  const existing = await db.get("SELECT COUNT(*) AS n FROM plans");
  if (existing && Number(existing.n) > 0) return 0;
  let n = 0;
  for (const p of DEFAULT_PLANS) {
    try {
      await db.run(
        `INSERT INTO plans
           (code, name, name_ar, description, price_ngn, price_yearly_ngn, trial_days,
            student_limit, teacher_limit, features, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [p.code, p.name, p.name_ar, p.description, p.price_ngn, p.price_yearly_ngn, p.trial_days,
          p.student_limit, p.teacher_limit, JSON.stringify(p.features), p.sort_order]
      );
    } catch (e) {
      // A database migrated before the offer columns existed: fall back to the
      // original column set rather than refusing to seed a catalogue at all.
      await db.run(
        "INSERT INTO plans (code, name, name_ar, price_ngn, student_limit, teacher_limit, features, sort_order) VALUES (?,?,?,?,?,?,?,?)",
        [p.code, p.name, p.name_ar, p.price_ngn, p.student_limit, p.teacher_limit, JSON.stringify(p.features), p.sort_order]
      );
    }
    n++;
  }
  return n;
}

/**
 * Brings an ALREADY-SEEDED catalogue up to date with the current tier offers.
 *
 * A deployment that ran the old seed has `plans.features` with four keys, so
 * every premium capability would read as "off" and the pricing page would have
 * nothing to sell. This is the idempotent repair, and it is deliberately
 * conservative — it only ever FILLS GAPS:
 *
 *   • a feature key the stored JSON does not mention → the tier default
 *     (an explicit true/false the operator set is never overwritten),
 *   • an empty `description` → the tier tagline,
 *   • a zero `price_yearly_ngn` on a paid plan → ten monthly payments,
 *   • a zero `trial_days` on a paid plan → the catalogue's trial length.
 *
 * Prices the operator set, student/teacher limits, plan names and any custom
 * plan rows are left exactly as they are.
 */
async function syncPlanOffers() {
  let updated = 0;
  for (const p of DEFAULT_PLANS) {
    let row = null;
    try {
      row = await db.get("SELECT * FROM plans WHERE code = ?", [p.code]);
    } catch (e) {
      return updated; // no plans table yet (pre-migration boot) — nothing to sync
    }
    if (!row) continue;

    const stored = catalogue.parseFeatures(row.features);
    const features = catalogue.normalizeFeatures(stored, p.code);
    const sets = [];
    const vals = [];
    if (JSON.stringify(features) !== JSON.stringify(stored)) {
      sets.push("features = ?"); vals.push(JSON.stringify(features));
    }
    if (!String(row.description || "").trim()) {
      sets.push("description = ?"); vals.push(p.description);
    }
    if (Number(row.price_ngn || 0) > 0 && Number(row.price_yearly_ngn || 0) <= 0) {
      sets.push("price_yearly_ngn = ?"); vals.push(p.price_yearly_ngn);
    }
    if (Number(row.price_ngn || 0) > 0 && Number(row.trial_days || 0) <= 0) {
      sets.push("trial_days = ?"); vals.push(p.trial_days);
    }
    if (!sets.length) continue;
    vals.push(row.id);
    await db.run(`UPDATE plans SET ${sets.join(", ")} WHERE id = ?`, vals);
    updated++;
  }
  return updated;
}

/**
 * Creates the ONE platform super admin on a database that has none.
 *
 * WHY THIS NO LONGER "SKIPS" SILENTLY
 * Outside production SUPER_ADMIN_PASSWORD is usually unset (there is no .env
 * on a fresh clone). The seed used to log one line and return, so the boot
 * finished with an EMPTY users table — and every sign-in attempt, including
 * the documented `admin`, answered "Invalid username or password" with no
 * hint that the account had never been created. That is the reported
 * "I type admin / … and nothing happens".
 *
 * Now a development boot generates a random password instead, writes it to
 * `.dev-credentials.txt` (git-ignored) and prints it, so there is always a
 * working way in. Production still refuses to invent a secret: it throws, so
 * the deploy fails loudly instead of coming up permanently unreachable.
 */
/**
 * Repairs super-admin accounts stored with upper-case characters.
 * Login lower-cases the typed username before looking it up, so an account
 * seeded as "Admin" (older seeds copied SUPER_ADMIN_USERNAME verbatim) could
 * never be matched — the only account on the platform was unreachable.
 * Idempotent, and skips a row whose lower-cased name is already taken.
 */
async function normalizeSuperAdminUsernames() {
  const rows = await db.all("SELECT id, username FROM users WHERE role = 'super_admin'");
  let fixed = 0;
  for (const row of rows) {
    const lower = String(row.username || "").toLowerCase();
    if (lower === row.username) continue;
    const clash = await db.get("SELECT id FROM users WHERE username = ? AND id <> ?", [lower, row.id]);
    if (clash) {
      console.warn(`Super admin "${row.username}" cannot be normalised to "${lower}" — that username is taken.`);
      continue;
    }
    await db.run("UPDATE users SET username = ? WHERE id = ?", [lower, row.id]);
    console.log(`Super admin username normalised: "${row.username}" -> "${lower}" (sign-in is case-insensitive).`);
    fixed++;
  }
  return fixed;
}

async function seedSuperAdmin() {
  await normalizeSuperAdminUsernames();
  const existing = await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin'");
  if (existing && Number(existing.n) > 0) return false;

  let password = config.SUPER_ADMIN_PASSWORD;
  let generated = false;
  if (!password) {
    if (config.IS_PRODUCTION) {
      throw new Error(
        "SUPER_ADMIN_PASSWORD is not set and this database has no super admin. " +
        "Refusing to start a production platform that nobody can sign in to. " +
        "Set SUPER_ADMIN_PASSWORD (Render → Environment) and redeploy, or run " +
        "`npm run reset-admin-password` against this database."
      );
    }
    // Development/test convenience: a usable account beats an empty table.
    password = "Dev-" + crypto.randomBytes(9).toString("base64url") + "!";
    generated = true;
  }

  const hash = bcrypt.hashSync(password, 10);
  await db.run(
    "INSERT INTO users (madrasa_id, username, password_hash, role, full_name) VALUES (NULL, ?, ?, 'super_admin', 'Platform Super Admin')",
    [config.SUPER_ADMIN_USERNAME, hash]
  );

  if (generated) {
    writeDevCredentials(config.SUPER_ADMIN_USERNAME, password);
    console.log("──────────────────────────────────────────────────────────────");
    console.log("  SUPER_ADMIN_PASSWORD was not set, so a development super");
    console.log("  admin was created with a generated password:");
    console.log(`      username: ${config.SUPER_ADMIN_USERNAME}`);
    console.log(`      password: ${password}`);
    console.log("  (also written to .dev-credentials.txt — git-ignored)");
    console.log("  Set SUPER_ADMIN_PASSWORD in .env to choose your own.");
    console.log("──────────────────────────────────────────────────────────────");
  } else {
    console.log(`Super admin created: ${config.SUPER_ADMIN_USERNAME} (change the password after first login).`);
  }
  return true;
}

/** Best-effort note of the generated dev password; never fatal. */
function writeDevCredentials(username, password) {
  try {
    const fs = require("fs");
    const path = require("path");
    fs.writeFileSync(
      path.join(process.cwd(), ".dev-credentials.txt"),
      "EduSphere — local development super admin (generated " + new Date().toISOString() + ")\n" +
      "Sign in at /login\n\n" +
      "  username: " + username + "\n" +
      "  password: " + password + "\n\n" +
      "This file is git-ignored and applies to the local dev database only.\n",
      { mode: 0o600 }
    );
  } catch (e) {
    console.warn("Could not write .dev-credentials.txt: " + e.message);
  }
}

/* --------------------------- demo data ---------------------------------- */

const DEMO_SUBJECTS = [
  ["Qur'an (Tajwid)", "تجويد القرآن"],
  ["Hadith", "الحديث"],
  ["Fiqh", "الفقه"],
  ["Arabic Grammar (Nahw)", "النحو"],
  ["Arabic Morphology (Sarf)", "الصرف"],
  ["Sirah", "السيرة"],
  ["Tahdhib (Adab)", "التهذيب"],
  ["Arabic Language", "اللغة العربية"],
  ["English", "اللغة الإنجليزية"],
  ["Mathematics", "الرياضيات"],
];

function makeAdmissionNo(prefix, n) {
  return `${prefix}${String(n).padStart(4, "0")}`;
}

async function createDemoMadrasa(slug, names, city, planCode, prefix) {
  const plan = await db.get("SELECT * FROM plans WHERE code = ?", [planCode]);
  const r = await db.run(
    `INSERT INTO madaris (slug, name_en, name_ar, motto_en, motto_ar, address, city, state_name, phone, email, plan_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      slug, names.en, names.ar, "Knowledge, Faith, Character", "العلم والإيمان والأخلاق",
      `12 Market Road, ${city}`, city, "Ogun", "+234 803 000 0000", `info@${slug}.example`,
      plan ? plan.id : 1,
    ]
  );
  const mid = r.lastInsertRowid;

  // Users
  async function mkUser(username, role, fullName, arName = "") {
    const hash = bcrypt.hashSync("Demo1234!", 10);
    const res = await db.run(
      "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, full_name_ar, email, phone) VALUES (?,?,?,?,?,?,?,?)",
      [mid, username, hash, role, fullName, arName, `${username}@${slug}.example`, "+234 800 000 0000"]
    );
    return res.lastInsertRowid;
  }
  const adminId = await mkUser(`${slug}-admin`, "madrasa_admin", "Madrasa Administrator", "مدير المدرسة");

  // Sessions + terms — dates are RELATIVE TO TODAY. The academic year runs
  // 1 September -> 31 August, so "today" always falls inside a session.
  const today = new Date();
  const todayStr = isoDate(today);
  const startY = today.getMonth() >= 8 ? today.getFullYear() : today.getFullYear() - 1;
  const on = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const s = await db.run(
    "INSERT INTO academic_sessions (madrasa_id, label, start_date, end_date, is_current) VALUES (?,?,?,?,1)",
    [mid, `${startY}/${startY + 1}`, on(startY, 9, 1), on(startY + 1, 8, 31)]
  );
  const sessionId = s.lastInsertRowid;
  const termDefs = [
    [1, "First Term", "الفترة الأولى", on(startY, 9, 1), on(startY, 12, 19)],
    [2, "Second Term", "الفترة الثانية", on(startY + 1, 1, 8), on(startY + 1, 3, 27)],
    [3, "Third Term", "الفترة الثالثة", on(startY + 1, 4, 13), on(startY + 1, 7, 17)],
  ];
  const termIds = {};
  let currentTermId = null;
  for (const [pos, en, ar, sd, ed] of termDefs) {
    const t = await db.run(
      "INSERT INTO terms (madrasa_id, session_id, position, name_en, name_ar, start_date, end_date) VALUES (?,?,?,?,?,?,?)",
      [mid, sessionId, pos, en, ar, sd, ed]
    );
    termIds[pos] = t.lastInsertRowid;
    if (sd <= todayStr && todayStr <= ed) currentTermId = t.lastInsertRowid;
  }
  // Between terms (school holiday): report on the most recently ended one.
  if (!currentTermId) {
    const ended = termDefs.filter(([, , , , ed]) => ed < todayStr);
    currentTermId = ended.length ? termIds[ended[ended.length - 1][0]] : termIds[1];
  }

  // Grading config: CA 40 / Exam 60, pass 50, classic bands
  await db.run(
    `INSERT INTO grading_config (madrasa_id, ca_max, exam_max, pass_mark, promotion_min_average, promotion_require_pass, grade_bands)
     VALUES (?, 40, 60, 50, 50, 1, ?)`,
    [mid, JSON.stringify([
      { min: 75, grade: "A", remark: "Excellent", remark_ar: "ممتاز" },
      { min: 65, grade: "B", remark: "Very Good", remark_ar: "جيد جداً" },
      { min: 55, grade: "C", remark: "Good", remark_ar: "جيد" },
      { min: 45, grade: "D", remark: "Fair", remark_ar: "مقبول" },
      { min: 40, grade: "E", remark: "Weak", remark_ar: "ضعيف" },
      { min: 0, grade: "F", remark: "Fail", remark_ar: "راسب" },
    ])]
  );

  // Classes
  const classes = [
    ["Al-Qur'an Class 1", "قسم القرآن الأول", "Beginner"],
    ["Al-Qur'an Class 2", "قسم القرآن الثاني", "Intermediate"],
    ["Arabic Studies 1", "قسم اللغة العربية الأول", "Advanced"],
    ["Arabic Studies 2", "قسم اللغة العربية الثاني", "Advanced"],
  ];
  const classIds = {};
  for (let i = 0; i < classes.length; i++) {
    const [en, ar, level] = classes[i];
    const c = await db.run(
      "INSERT INTO classes (madrasa_id, name_en, name_ar, sort_order) VALUES (?,?,?,?)",
      [mid, en, ar, i + 1]
    );
    classIds[level + i] = c.lastInsertRowid;
  }

  // Subjects (per madrasa, EN + AR)
  const subjectIds = {};
  for (const [en, ar] of DEMO_SUBJECTS) {
    const st = await db.run("INSERT INTO subjects (madrasa_id, name_en, name_ar, category, education_track, status) VALUES (?,?,?,?,?,?)", [mid, en, ar, ["English", "Mathematics"].includes(en) ? en : "Other Subjects", ["English", "Mathematics"].includes(en) ? "both" : "islamic", "active"]);
    subjectIds[en] = st.lastInsertRowid;
  }
  // Every class gets Qur'an + Fiqh + Arabic Language + English + Maths
  const coreSubjects = ["Qur'an (Tajwid)", "Fiqh", "Arabic Language", "English", "Mathematics"];
  for (const cid of Object.values(classIds)) {
    for (const sname of coreSubjects) {
      await db.insertIgnore("class_subjects", "madrasa_id, class_id, subject_id", [mid, cid, subjectIds[sname]]);
    }
  }

  // Teachers + assignments
  const teacher1 = await mkUser(`${slug}-ust1`, "teacher", "Ustadh Ibrahim Oluwaseun", "الشيخ إبراهيم");
  await db.insertIgnore("teacher_assignments", "madrasa_id, user_id, class_id, subject_id", [mid, teacher1, classIds["Beginner0"], subjectIds["Qur'an (Tajwid)"]]);
  await db.insertIgnore("teacher_assignments", "madrasa_id, user_id, class_id, subject_id", [mid, teacher1, classIds["Intermediate1"], subjectIds["Fiqh"]]);

  // Students
  const demoStudents = [
    ["Adeyemi", "Kunle", "أديمي كوني", "M", "2012-04-11", 0, "Parent of Kunle", "Parent1234!"],
    ["Ogunlana", "Sola", "أوغونلانا سولا", "F", "2011-11-02", 0, "Parent of Sola", "Parent1234!"],
    ["Adebayo", "Ibrahim", "أديبايو إبراهيم", "M", "2013-06-19", 2, "Parent of Ibrahim", "Parent1234!"],
    ["Olalekan", "Folake", "أولاليكان فوليك", "F", "2012-01-25", 3, "Parent of Folake", "Parent1234!"],
  ];
  const studentIds = [];
  for (let i = 0; i < demoStudents.length; i++) {
    const [first, last, ar, gender, dob, ci, pname] = demoStudents[i];
    const classId = Object.values(classIds)[ci];
    const st = await db.run(
       `INSERT INTO students (madrasa_id, admission_no, first_name, last_name, name_ar, gender, date_of_birth, class_id, session_id, parent_name, parent_phone, address)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [mid, makeAdmissionNo(prefix, i + 1), first, last, ar, gender, dob, classId, sessionId, pname, "+234 801 111 2222", `${city}, Ogun State`]
    );
    studentIds.push(st.lastInsertRowid);
  }

  // Parent accounts linked to first two students
  for (let i = 0; i < 2; i++) {
    const puser = await db.run(
      "INSERT INTO users (madrasa_id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)",
      // demoStudents rows are ARRAYS ([first, last, …]) — reading .last_name
      // off them produced the literal name "Guardian of undefined" in every
      // screen that shows a parent (now including the PTM booking grid).
      [mid, `${slug}-parent${i + 1}`, bcrypt.hashSync("Parent1234!", 10), "parent", `Guardian of ${demoStudents[i][1]}`]
    );
    await db.insertIgnore("parent_links", "madrasa_id, user_id, student_id", [mid, puser.lastInsertRowid, studentIds[i]]);
  }
  // Student portal accounts for the first two students (linked to their records)
  for (let i = 0; i < 2; i++) {
    const r = await db.run(
      "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, student_id) VALUES (?,?,?,?,?,?)",
      [mid, `${slug}-stu${i + 1}`, bcrypt.hashSync("Student1234!", 10), "student", `${demoStudents[i][0]} ${demoStudents[i][1]}`, studentIds[i]]
    );
  }

  // Results: every demo student, in the CURRENT term, across all core subjects.
  // The profiles are chosen to span the grade bands A -> F so the performance
  // charts have a visible shape.
  const termId = currentTermId;
  const scoreProfile = [
    { ca: 36, exam: 55 }, // ~91% -> A
    { ca: 28, exam: 42 }, // ~70% -> B
    { ca: 22, exam: 33 }, // ~55% -> C
    { ca: 12, exam: 18 }, // ~30% -> F
  ];
  const classesWithResults = new Set();
  for (let i = 0; i < studentIds.length; i++) {
    const sid = studentIds[i];
    const stu = await db.get("SELECT class_id FROM students WHERE id = ?", [sid]);
    const base = scoreProfile[i % scoreProfile.length];
    for (let j = 0; j < coreSubjects.length; j++) {
      const ca = Math.min(40, base.ca + (j % 3));
      const exam = Math.min(60, base.exam + (j % 4));
      await db.run(
        `INSERT INTO results (madrasa_id, student_id, class_id, session_id, term_id, subject_id, ca, exam, total)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [mid, sid, stu.class_id, sessionId, termId, subjectIds[coreSubjects[j]], ca, exam, ca + exam]
      );
    }
    classesWithResults.add(stu.class_id);
  }

  // Attendance: the last 20 weekdays ending today, so the attendance charts are
  // populated whenever the demo is created.
  const schoolDays = [];
  for (let back = 0; schoolDays.length < 20; back++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue; // weekends are not school days
    schoolDays.unshift(isoDate(day));
  }
  for (const sid of studentIds) {
    const stu = await db.get("SELECT class_id FROM students WHERE id = ?", [sid]);
    for (let i = 0; i < schoolDays.length; i++) {
      const absent = (sid + i) % 9 === 0;
      const excused = !absent && (sid + i) % 13 === 0;
      const status = absent ? "absent" : excused ? "excused" : "present";
      await db.insertIgnore("attendance", "madrasa_id, student_id, class_id, term_id, day, status, recorded_by",
        [mid, sid, stu.class_id, termId, schoolDays[i], status, adminId]);
    }
  }

  // Fees: two items for the current term, with payments spread over the last
  // few months across several methods. Student 1 settles in full, student 2
  // pays part, the rest owe a balance.
  const fee1 = await db.run(
    "INSERT INTO fee_items (madrasa_id, term_id, name_en, name_ar, amount_ngn) VALUES (?,?,?,?,?)",
    [mid, termId, "Current Term Tuition", "رسوم الفصل الحالي", 5000]
  );
  const fee2 = await db.run(
    "INSERT INTO fee_items (madrasa_id, term_id, name_en, name_ar, amount_ngn) VALUES (?,?,?,?,?)",
    [mid, termId, "Book Fee", "رسوم الكتب", 1500]
  );
  const receipts = [
    [studentIds[0], fee1.lastInsertRowid, 5000, 3, "cash", "RECP-0001"],
    [studentIds[0], fee2.lastInsertRowid, 1500, 3, "cash", "RECP-0002"],
    [studentIds[1], fee1.lastInsertRowid, 4000, 41, "bank", "RECP-0003"],
    [studentIds[2], fee2.lastInsertRowid, 1500, 78, "transfer", "RECP-0004"],
    [studentIds[3], fee1.lastInsertRowid, 2000, 120, "cash", "RECP-0005"],
  ];
  for (const [sid, itemId, amount, daysBack, method, ref] of receipts) {
    await db.run(
      "INSERT INTO fee_payments (madrasa_id, student_id, fee_item_id, amount_ngn, payment_date, method, reference, recorded_by) VALUES (?,?,?,?,?,?,?,?)",
      [mid, sid, itemId, amount, daysAgo(daysBack, today), method, ref, adminId]
    );
  }

  // Publish the term summaries so results analytics, positions and report cards
  // are populated immediately (normally an admin triggers this per class).
  for (const cid of classesWithResults) {
    await grading.computeClassTerm(mid, cid, termId, adminId);
  }
  // Mark the demo term as PUBLISHED: report cards are only visible to the
  // student/parent portals and to the public result checker once a summary has
  // been published, so the demo would otherwise show empty result screens.
  await db.run(
    "UPDATE term_summaries SET published_at = CURRENT_TIMESTAMP WHERE madrasa_id = ? AND term_id = ? AND published_at IS NULL",
    [mid, termId]
  );

  // Announcements — one school-wide, one published on the PUBLIC site so the
  // logged-out madrasa page has something to show.
  await db.run(
    "INSERT INTO announcements (madrasa_id, title, body, audience, is_active, created_by) VALUES (?,?,?,?,1,?)",
    [mid, "Examination Commencement", "First term examinations will commence on the 15th of December. Students should arrive at 8:00 AM sharp. / تبدأ امتحانات الفصل الأول في 15 ديسمبر. على الطلاب الحضور في الساعة 8:00 صباحاً.", "all", adminId]
  );
  await db.run(
    `INSERT INTO announcements (madrasa_id, title, body, audience, is_active, created_by, publish_public, publish_until)
     VALUES (?,?,?,?,1,?,?,?)`,
    [mid, `${names.en} — admissions open`,
      "Applications for the coming session are being accepted online. Parents may apply in two minutes and will receive a reference number to track the request. / التسجيل مفتوح للالتحاق بالمدرسة عبر الطلب الإلكتروني.",
      "all", adminId, 1, on(startY + 1, 6, 30)]
  );

  // Public-site profile for the demo tenant.
  await db.run(
    `UPDATE madaris SET
       description_en = ?, description_ar = ?, founded_year = ?, website = ?,
       public_listing = 1, public_results = ?, public_admissions = ?
     WHERE id = ?`,
    [
      "A model madrasa combining Qur'an memorisation, Arabic and the Nigerian classroom subjects, with printable report cards, attendance and fee records for every student.",
      "مدرسة نموذجية تجمع بين حفظ القرآن والعلوم العربية والمواد الدراسية، مع بطاقات نتائج مطبوعة وحضور وسجلات رسوم لكل طالب.",
      String(startY - 8),
      `https://${slug}.example`,
      slug === "demo-quraniyya" ? 1 : 0,   // results published for one madrasa only
      slug === "demo-quraniyya" ? 1 : 0,   // online admission for one madrasa only
      mid,
    ]
  );

  // Weekly timetable: Mon-Thu, 4 periods, core subjects rotating, the demo
  // ustadh taking the classes he is assigned to.
  const days = ["Mon", "Tue", "Wed", "Thu"];
  for (const cid of Object.values(classIds)) {
    for (let d = 0; d < days.length; d++) {
      for (let pno = 1; pno <= 4; pno++) {
        const subject = coreSubjects[(d + pno) % coreSubjects.length];
        await db.insertIgnore(
          "timetable_slots",
          "madrasa_id, class_id, term_id, day, period, start_time, end_time, subject_id, teacher_id, room",
          [mid, cid, termId, days[d], pno, ["08:00", "08:50", "09:40", "10:30"][pno - 1], ["08:50", "09:40", "10:30", "11:20"][pno - 1],
           subjectIds[subject], teacher1, pno <= 2 ? "Hall A" : "Hall B"]
        );
      }
    }
  }

  // Two pending online applications, so the admission queue is not empty.
  if (slug === "demo-quraniyya") {
    const demoApps = [
      ["ADM-DEMO-0001", "Aisha", "Adewale", "عائشة أدواله", "F", "2013-02-14", "Qur'an Intro", "Barrister Adewale", "+234 802 333 4444", "aisha.adewale@example"],
      ["ADM-DEMO-0002", "Musa", "Balogun", "موسى بالوغون", "M", "2011-09-30", "Hifz Programme", "Alhaji Balogun", "+234 803 555 6666", ""],
    ];
    for (const [ref, first, last, ar, gender, dob, level, pname, phone, email] of demoApps) {
      await db.run(
        `INSERT INTO admission_requests
          (madrasa_id, reference, status, first_name, last_name, name_ar, gender, date_of_birth, class_id,
           quran_level, parent_name, parent_phone, parent_email, address, message)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [mid, ref, "pending", first, last, ar, gender, dob, Object.values(classIds)[0], level,
         pname, phone, email, `${city}, Ogun State`, "Please advise on the entrance assessment date."]
      );
    }
  }

  // Settings: admission prefix
  await db.insertIgnore("settings", "madrasa_id, key_name, value", [mid, "admission_prefix", prefix]);

  return { mid, adminId, teacher1, studentIds, planCode, termId };
}

async function seedDemo() {
  const a = await createDemoMadrasa(
    "demo-quraniyya",
    { en: "Al-Quraniyya Model Madrasa", ar: "مدرسة القرونية النموذجية" },
    "Ijebu-Ode", "basic", "ALQ"
  );
  const b = await createDemoMadrasa(
    "demo-fatihah",
    { en: "Fatihah Islamic Studies College", ar: "كلية الفاتحة للدراسات الإسلامية" },
    "Ijebu-Ode", "free", "FAT"
  );
  console.log("Demo data created:");
  console.log(`  Madrasa A: ${a.mid} (plan: ${a.planCode})`);
  console.log(`  Madrasa B: ${b.mid} (plan: ${b.planCode})`);
  console.log("  Demo logins (password for all demo users is shown in docs/README demo section)");
}

/**
 * Full seed run: migrate + plans + super admin (+ demo data when requested).
 * Used by the CLI below; the server entry point only needs seedPlans() and
 * seedSuperAdmin() (both idempotent) to bootstrap a fresh database on boot.
 */
async function runSeed({ demo = false } = {}) {
  await migrate();
  const plans = await seedPlans();
  if (plans) console.log(`Seeded ${plans} subscription plan(s).`);
  const synced = await syncPlanOffers();
  if (synced) console.log(`Updated ${synced} plan(s) with the current tier offers.`);
  await seedSuperAdmin();
  if (demo) {
    const existing = await db.get("SELECT COUNT(*) AS n FROM madaris");
    if (existing && Number(existing.n) > 0) {
      console.log("Demo madaris already exist — skipping demo data.");
    } else {
      await seedDemo();
    }
  }
  await db.close();
}

module.exports = { DEFAULT_PLANS, seedPlans, syncPlanOffers, seedSuperAdmin, seedDemo, runSeed, normalizeSuperAdminUsernames };

if (require.main === module) {
  require("./db-target").announce({ allowCreate: true });
  runSeed({ demo: process.argv.includes("--demo") }).catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
