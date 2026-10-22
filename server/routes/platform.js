"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — Super Admin (platform-level) routes
   ----------------------------------------------------------------------------
   Everything here is protected by requireSuperAdmin. A super admin can:
     • manage madaris (create, suspend/activate, plan, profile, DELETE)
     • manage each madrasa's admin account
     • manage subscription plans
     • view platform statistics & activity
   ========================================================================== */
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, logActivity } = require("../util");
const { requireSuperAdmin } = require("../middleware/auth");
const analytics = require("../services/analytics");
const catalogue = require("../services/plan-catalogue");
const institution = require("../services/institution");
const mediaStore = require("../services/media-store");

const router = express.Router();
router.use(requireSuperAdmin);

function catalogueSubjectMeta(category, name) {
  const westernCategories = new Set(["Mathematics", "English", "Sciences", "Computer Science", "Technology", "Business", "Arts", "Social Sciences", "Languages"]);
  const islamicLanguage = new Set(["Arabic", "Arabic Language", "Nahw", "Sarf", "Arabic Reading", "Arabic Expression"]);
  if (category === "western") return { category: westernCategories.has(name) ? name : "Other Subjects", track: "western" };
  return { category: islamicLanguage.has(name) ? "Languages" : "Other Subjects", track: "islamic" };
}

/* ------------------------------ stats ---------------------------------- */

router.get("/stats", asyncHandler(async (req, res) => {
  const [madaris, active, admins, teachers, parents, studentsCount] = await Promise.all([
    db.get("SELECT COUNT(*) AS n FROM madaris"),
    db.get("SELECT COUNT(*) AS n FROM madaris WHERE status = 'active'"),
    db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'madrasa_admin' AND is_active = 1"),
    db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher' AND is_active = 1"),
    db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'parent' AND is_active = 1"),
    db.get("SELECT COUNT(*) AS n FROM students WHERE status IN ('active','promoted','suspended')"),
  ]);
  const pending = await db.get("SELECT COUNT(*) AS n FROM admission_requests WHERE status = 'pending'");
  const byPlan = await db.all(
    "SELECT p.code, COUNT(m.id) AS n FROM plans p LEFT JOIN madaris m ON m.plan_id = p.id GROUP BY p.code ORDER BY p.sort_order"
  );
  const recentActivity = await db.all(
    "SELECT a.*, u.username, m.slug AS madrasa_slug FROM activity_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN madaris m ON m.id = a.madrasa_id ORDER BY a.id DESC LIMIT 30"
  );
  ok(res, {
    madaris: Number(madaris.n),
    activeMadaris: Number(active.n),
    students: Number(studentsCount.n),
    teachers: Number(teachers.n),
    madrasaAdmins: Number(admins.n),
    parents: Number(parents.n),
    pendingApplications: Number(pending.n),
    byPlan,
    recentActivity,
  });
}));

/* ---------------------------- analytics -------------------------------- */

/**
 * GET /api/platform/analytics?months=12
 * Platform-wide dashboard aggregates: tenant growth, enrolment, plan mix,
 * fee collections and activity. Super admin only (enforced by the router-wide
 * requireSuperAdmin above). Contains no student-level data.
 */
router.get("/analytics", asyncHandler(async (req, res) => {
  const data = await analytics.platformAnalytics({ months: req.query.months });
  ok(res, { analytics: data });
}));

/* ------------------------------ madaris -------------------------------- */

router.get("/madaris", asyncHandler(async (req, res) => {
  const rows = await db.all(`
    SELECT m.*, p.code AS plan_code, p.name AS plan_name,
      (SELECT COUNT(*) FROM students s WHERE s.madrasa_id = m.id AND s.status IN ('active','promoted','suspended')) AS student_count,
      (SELECT COUNT(*) FROM users u WHERE u.madrasa_id = m.id AND u.role = 'teacher' AND u.is_active = 1) AS teacher_count
    FROM madaris m LEFT JOIN plans p ON p.id = m.plan_id
    ORDER BY m.id DESC
  `);
  ok(res, { madaris: rows });
}));

router.post("/madaris", asyncHandler(async (req, res) => {
  const b = req.body || {};
  const slug = cleanStr(b.slug, 80).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  const nameEn = cleanStr(b.name_en, 160);
  if (!slug || !nameEn) return err(res, 400, "A unique slug and English name are required.");
  const exists = await db.get("SELECT id FROM madaris WHERE slug = ?", [slug]);
  if (exists) return err(res, 400, "That slug is already taken.");

  // An omitted plan falls back to the first plan; an explicitly blank/invalid
  // id is an error (the UI must always send a real plan id).
  let planId;
  if (b.plan_id === undefined) planId = 1;
  else planId = toNum(b.plan_id, 0);
  if (!planId) return err(res, 400, "Choose a valid plan.");
  const plan = await db.get("SELECT id FROM plans WHERE id = ?", [planId]);
  if (!plan) return err(res, 400, "Unknown plan.");

  // Validate the optional madrasa-admin credentials UP FRONT. Previously a
  // blank, short or already-taken admin account was silently skipped, so the
  // madrasa was created with NO way to log in to it.
  const adminUser = cleanStr(b.admin_username, 100).toLowerCase();
  const adminPass = String(b.admin_password || "");
  const adminGiven = !!(adminUser || adminPass || b.admin_full_name);
  if (adminGiven) {
    if (!adminUser || !adminPass) return err(res, 400, "Admin username and password are required when creating an admin account.");
    if (!/^[a-z0-9_.-]{3,}$/.test(adminUser)) return err(res, 400, "Username must be 3+ chars (letters, numbers, dot, dash, underscore).");
    if (adminPass.length < 8) return err(res, 400, "Admin password must be at least 8 characters.");
    const taken = await db.get("SELECT id FROM users WHERE username = ?", [adminUser]);
    if (taken) return err(res, 400, "That username is already taken.");
  }

  // Islamic School vs Western Academy. An explicit category wins; otherwise
  // the institution_type catalogue decides; otherwise safe default islamic.
  const category = institution.normalizeCategory(b.category, b.institution_type);
  const institutionType = cleanStr(b.institution_type, 60)
    || (category === "western" ? "Academy" : "Madrasa");
  const brandColor = cleanStr(b.brand_color, 20);
  if (brandColor && !/^#[0-9a-fA-F]{3,8}$/.test(brandColor)) return err(res, 400, "brand_color must be a hex color like #200A3D.");

  // Create the madrasa and its first administrator as ONE unit: if any
  // statement fails the whole thing rolls back, so a madrasa can never exist
  // without a login (or a login point at nothing). The manual compensating
  // deletes this replaces were the reason a half-created tenant could look
  // like it "disappeared".
  let adminCreated = false;
  let mid = 0;
  const adminHash = adminGiven ? await bcrypt.hash(adminPass, 10) : "";
  try {
    const created = await db.transaction(async (tx) => {
      const cols = ["slug", "name_en", "name_ar", "category", "institution_type", "brand_color",
                    "motto_en", "motto_ar", "address", "city", "state_name",
                    "phone", "email", "plan_id", "status", "description_en", "description_ar",
                    "founded_year", "website", "public_listing", "public_results", "public_admissions"];
      const vals = [
        slug, nameEn, cleanStr(b.name_ar, 160), category, institutionType,
        brandColor || institution.categoryConfig(category).primaryColor,
        cleanStr(b.motto_en, 160), cleanStr(b.motto_ar, 160),
        cleanStr(b.address, 255), cleanStr(b.city, 80), cleanStr(b.state_name, 80),
        cleanStr(b.phone, 60), cleanStr(b.email, 120), plan.id, "active",
        cleanStr(b.description_en, 4000), cleanStr(b.description_ar, 4000),
        /^\d{4}$/.test(cleanStr(b.founded_year, 8)) ? cleanStr(b.founded_year, 8) : "",
        cleanStr(b.website, 160),
        b.public_listing === false ? 0 : 1,
        b.public_results === true ? 1 : 0,
        b.public_admissions === true ? 1 : 0,
      ];
      if (cols.length !== vals.length) throw new Error("internal: madrasa insert column/value mismatch");
      const r = await tx.run(
        `INSERT INTO madaris (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        vals
      );
      const id = r.lastInsertRowid;
      let adminCreated = false;
      if (adminGiven) {
        await tx.run(
          "INSERT INTO users (madrasa_id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)",
          [id, adminUser, adminHash, "madrasa_admin", cleanStr(b.admin_full_name, 160) || "Madrasa Administrator"]
        );
        adminCreated = true;
      }
      // Seed a starter academic session, its three terms and the subject
      // catalogue for this category so the new admin's dashboard is ready to
      // use on day one (mirrors registration approval).
      const year = new Date().getFullYear();
      const s = await tx.run(
        "INSERT INTO academic_sessions (madrasa_id, label, is_current) VALUES (?,?,1)",
        [id, `${year}/${year + 1}`]
      );
      const termDefaults = ["First Term", "Second Term", "Third Term"];
      for (let i = 0; i < termDefaults.length; i++) {
        await tx.run(
          "INSERT INTO terms (madrasa_id, session_id, position, name_en) VALUES (?,?,?,?)",
          [id, s.lastInsertRowid, i + 1, termDefaults[i]]
        );
      }
      for (const subjectName of institution.subjectCatalogue(category)) {
        const meta = catalogueSubjectMeta(category, subjectName);
        await tx.run("INSERT INTO subjects (madrasa_id, name_en, category, education_track, status) VALUES (?,?,?,?,?)", [id, subjectName, meta.category, meta.track, "active"]);
      }
      return { id, adminCreated };
    });
    mid = created.id;
    adminCreated = created.adminCreated;
  } catch (e) {
    console.error("Failed to create madrasa (rolled back):", e);
    return err(res, 500, "Could not create the madrasa. Nothing was saved — please try again.");
  }

  logActivity(db, { userId: req.user.id, action: "madrasa.create", entity: "madrasa", entityId: String(mid), meta: { slug }, ip: req.ip });
  ok(res, { ok: true, id: mid, adminCreated });
}));

async function loadMadrasa(req, res, id) {
  const mid = toNum(id, 0);
  const row = await db.get("SELECT * FROM madaris WHERE id = ?", [mid]);
  if (!row) { res.status(404).json({ error: "Madrasa not found." }); return null; }
  return row;
}

router.get("/madaris/:id", asyncHandler(async (req, res) => {
  const m = await loadMadrasa(req, res, req.params.id);
  if (!m) return;
  const [plan, admin] = await Promise.all([
    db.get("SELECT * FROM plans WHERE id = ?", [m.plan_id]),
    db.get("SELECT id, username, full_name, email, phone, is_active FROM users WHERE madrasa_id = ? AND role = 'madrasa_admin'", [m.id]),
  ]);
  // Same aggregate columns as the list view, so the detail page can show real
  // student/teacher counts instead of falling back to zero.
  const counts = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM students s WHERE s.madrasa_id = m.id AND s.status IN ('active','promoted','suspended')) AS student_count,
       (SELECT COUNT(*) FROM users u WHERE u.madrasa_id = m.id AND u.role = 'teacher' AND u.is_active = 1) AS teacher_count
     FROM madaris m WHERE m.id = ?`,
    [m.id]
  );
  ok(res, {
    madrasa: Object.assign({}, m, {
      student_count: counts ? Number(counts.student_count) : 0,
      teacher_count: counts ? Number(counts.teacher_count) : 0,
      plan_code: plan ? plan.code : "",
    }),
    plan,
    admin,
  });
}));

router.patch("/madaris/:id", asyncHandler(async (req, res) => {
  const m = await loadMadrasa(req, res, req.params.id);
  if (!m) return;
  const b = req.body || {};
  const fields = ["name_en", "name_ar", "motto_en", "motto_ar", "address", "city", "state_name", "phone", "email", "notes",
                   "description_en", "description_ar", "founded_year", "website"];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(cleanStr(b[f], f === "notes" ? 2000 : 255)); }
  }
  if (b.status !== undefined && ["active", "suspended"].includes(b.status)) { sets.push("status = ?"); vals.push(b.status); }
  for (const flag of ["public_listing", "public_results", "public_admissions"]) {
    if (b[flag] !== undefined) { sets.push(`${flag} = ?`); vals.push(b[flag] ? 1 : 0); }
  }
  if (b.founded_year !== undefined && (cleanStr(b.founded_year, 8) === "" || /^\d{4}$/.test(cleanStr(b.founded_year, 8)))) {
    sets.push("founded_year = ?"); vals.push(cleanStr(b.founded_year, 8));
  }
  if (b.plan_id !== undefined) {
    const plan = await db.get("SELECT id FROM plans WHERE id = ?", [toNum(b.plan_id, 0)]);
    if (!plan) return err(res, 400, "Unknown plan.");
    sets.push("plan_id = ?"); vals.push(plan.id);
  }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(m.id);
  await db.run(`UPDATE madaris SET ${sets.join(", ")} WHERE id = ?`, vals);
  logActivity(db, { userId: req.user.id, madrasaId: m.id, action: "madrasa.update", entity: "madrasa", entityId: String(m.id), meta: { fields: sets.map((s) => s.split(" ")[0]) }, ip: req.ip });
  ok(res, { ok: true });
}));

/** Create or reset the madrasa's admin account. */
router.post("/madaris/:id/admin", asyncHandler(async (req, res) => {
  const m = await loadMadrasa(req, res, req.params.id);
  if (!m) return;
  const b = req.body || {};
  const username = cleanStr(b.username, 100).toLowerCase();
  const password = String(b.password || "");
  if (!username || password.length < 8) return err(res, 400, "Username and a password of at least 8 characters are required.");
  const existing = await db.get("SELECT id, username FROM users WHERE madrasa_id = ? AND role = 'madrasa_admin'", [m.id]);
  if (existing) {
    // Reset existing admin (optionally change the username)
    const hash = await bcrypt.hash(password, 10);
    if (existing.username !== username) {
      const clash = await db.get("SELECT id FROM users WHERE username = ?", [username]);
      if (clash) return err(res, 400, "That username is taken by another account.");
    }
    await db.run(
      "UPDATE users SET username = ?, password_hash = ?, full_name = ?, email = ?, phone = ?, is_active = 1 WHERE id = ?",
      [username, hash, cleanStr(b.full_name, 160) || existing.username, cleanStr(b.email, 120), cleanStr(b.phone, 60), existing.id]
    );
    logActivity(db, { userId: req.user.id, madrasaId: m.id, action: "madrasa.admin.reset", entity: "user", entityId: String(existing.id), ip: req.ip });
  } else {
    const clash = await db.get("SELECT id FROM users WHERE username = ?", [username]);
    if (clash) return err(res, 400, "That username is taken by another account.");
    const hash = await bcrypt.hash(password, 10);
    const r = await db.run(
      "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, email, phone) VALUES (?,?,?,?,?,?,?)",
      [m.id, username, hash, "madrasa_admin", cleanStr(b.full_name, 160) || "Madrasa Administrator", cleanStr(b.email, 120), cleanStr(b.phone, 60)]
    );
    logActivity(db, { userId: req.user.id, madrasaId: m.id, action: "madrasa.admin.create", entity: "user", entityId: String(r.lastInsertRowid), ip: req.ip });
  }
  ok(res, { ok: true, username });
}));

/* --------------------------- delete an institution --------------------- */
/**
 * DELETE /api/platform/madaris/:id
 *
 * Permanently removes an institution and EVERY row that belongs to it —
 * students, teachers, classes, results, fees, files, the lot. This is the
 * "delete completely" an operator needs for a test tenant, a duplicate or a
 * school that asked for its data to be erased; suspending is NOT the same
 * thing and is still the right tool for a school that is merely behind on
 * payment.
 *
 * Safety:
 *   • the tenant's tables are discovered from the LIVE schema (every table
 *     with a madrasa_id column), so a table added by a later migration is
 *     purged too instead of being orphaned;
 *   • everything runs in ONE transaction — a failure removes nothing;
 *   • a tenant holding a platform operator account is refused;
 *   • the uploads this tenant stored are unlinked after the commit, and a
 *     failed unlink never fails the request (the database is the source of
 *     truth for media, and it is already gone).
 */
router.delete("/madaris/:id", asyncHandler(async (req, res) => {
  const m = await loadMadrasa(req, res, req.params.id);
  if (!m) return;

  const operator = await db.get("SELECT id FROM users WHERE madrasa_id = ? AND role = 'super_admin' LIMIT 1", [m.id]);
  if (operator) {
    return err(res, 400, "This institution holds a platform operator account and cannot be deleted.");
  }

  const dialect = await db.dialect();
  let tenantTables = [];
  if (dialect === "mysql") {
    const rows = await db.all(
      "SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'madrasa_id'"
    );
    tenantTables = rows.map((r) => String(r.t || r.TABLE_NAME));
  } else {
    const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    for (const r of rows) {
      const cols = await db.all(`PRAGMA table_info(${r.name})`);
      if (cols.some((c) => String(c.name) === "madrasa_id")) tenantTables.push(String(r.name));
    }
  }
  tenantTables = tenantTables.filter((t) => t && t !== "madaris");

  // Uploads this tenant stored — collected before the rows disappear, removed
  // after the commit (best effort: the DB row is the source of truth).
  let mediaPaths = [];
  try {
    const media = await db.all("SELECT web_path FROM media_files WHERE madrasa_id = ? LIMIT 5000", [m.id]);
    mediaPaths = media.map((r) => r.web_path).filter(Boolean);
  } catch (e) { /* a database without the media table simply has nothing to unlink */ }

  let rowsRemoved = 0;
  try {
    await db.transaction(async (tx) => {
      if (dialect === "mysql") await tx.run("SET FOREIGN_KEY_CHECKS = 0");
      else await tx.run("PRAGMA defer_foreign_keys = TRUE");
      for (const t of tenantTables) {
        const r = await tx.run(`DELETE FROM ${t} WHERE madrasa_id = ?`, [m.id]);
        rowsRemoved += Number(r.changes || 0);
      }
      // A registration that was promoted into this institution keeps its audit
      // row; only the now-dead link is cleared.
      await tx.run("UPDATE madrasa_registrations SET promoted_madrasa_id = NULL WHERE promoted_madrasa_id = ?", [m.id]);
      await tx.run("DELETE FROM madaris WHERE id = ?", [m.id]);
      if (dialect === "mysql") await tx.run("SET FOREIGN_KEY_CHECKS = 1");
    });
  } catch (e) {
    console.error("Failed to delete madrasa " + m.id + " (rolled back):", e);
    return err(res, 500, "Could not delete the institution. Nothing was removed — please try again.");
  }

  for (const webPath of mediaPaths) {
    try { await mediaStore.remove(webPath); } catch (e) { /* the disk copy is optional */ }
  }

  logActivity(db, { userId: req.user.id, action: "madrasa.delete", entity: "madrasa", entityId: String(m.id), meta: { slug: m.slug, name: m.name_en, rows: rowsRemoved }, ip: req.ip });
  ok(res, { ok: true, deleted: m.id, slug: m.slug, rowsRemoved });
}));

/* ------------------------------ registrations ---------------------------
   Public institution registrations land in `madrasa_registrations` as
   'Pending'. A super admin reviews them here; approving PROMOTES the
   registration into a real, active `madaris` row plus its first
   madrasa_admin login (reusing the password the applicant chose at sign-up),
   so the institution can immediately log in and land in the right
   dashboard (Islamic or Western) by category/institution_type. Nothing is
   ever promoted automatically. */

router.get("/registrations", asyncHandler(async (req, res) => {
  const status = cleanStr(req.query.status, 20);
  const rows = status
    ? await db.all("SELECT * FROM madrasa_registrations WHERE status = ? ORDER BY id DESC", [status])
    : await db.all("SELECT * FROM madrasa_registrations ORDER BY id DESC");
  ok(res, {
    registrations: rows.map((r) => ({
      id: r.id,
      registrationId: r.registration_id,
      status: r.status,
      name: r.name,
      officialName: r.official_name,
      category: r.category || institution.normalizeCategory(null, r.institution_type),
      institutionType: r.institution_type,
      city: r.city,
      town: r.town,
      stateName: r.state_name,
      adminFullName: r.admin_full_name,
      adminEmail: r.admin_email,
      adminPhone: r.admin_phone,
      submittedAt: r.submitted_at,
      reviewedAt: r.reviewed_at,
      reviewNote: r.review_note,
      promotedMadrasaId: r.promoted_madrasa_id,
    })),
  });
}));

router.get("/registrations/:id", asyncHandler(async (req, res) => {
  const row = await db.get("SELECT * FROM madrasa_registrations WHERE id = ?", [toNum(req.params.id, 0)]);
  if (!row) return err(res, 404, "Registration not found.");
  ok(res, {
    registration: Object.assign({}, row, {
      subjects: JSON.parse(row.subjects_json || "[]"),
      ageGroups: JSON.parse(row.age_groups_json || "[]"),
      category: row.category || institution.normalizeCategory(null, row.institution_type),
      admin_password_hash: undefined,
    }),
  });
}));

/**
 * POST /api/platform/registrations/:id/approve
 * Body (optional): { slug, plan_id }
 * Creates the live madrasa + its admin login from the stored application,
 * marks the registration Approved, and links the two records both ways.
 */
router.post("/registrations/:id/approve", asyncHandler(async (req, res) => {
  const reg = await db.get("SELECT * FROM madrasa_registrations WHERE id = ?", [toNum(req.params.id, 0)]);
  if (!reg) return err(res, 404, "Registration not found.");
  if (reg.status !== "Pending") return err(res, 400, `This registration is already ${reg.status}.`);

  const b = req.body || {};
  let slug = cleanStr(b.slug, 80).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) {
    slug = reg.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || ("institution-" + reg.id);
  }
  // Guarantee uniqueness even if the derived slug collides.
  let candidate = slug;
  let n = 1;
  while (await db.get("SELECT id FROM madaris WHERE slug = ?", [candidate])) {
    candidate = `${slug}-${++n}`;
  }
  slug = candidate;

  const planId = toNum(b.plan_id, 0) || 1;
  const plan = await db.get("SELECT id FROM plans WHERE id = ?", [planId]);
  if (!plan) return err(res, 400, "Unknown plan.");

  const category = reg.category || institution.normalizeCategory(null, reg.institution_type);
  let adminUsername = cleanStr(reg.admin_username, 100) || (slug + "-admin");
  if (await db.get("SELECT id FROM users WHERE username = ?", [adminUsername])) {
    adminUsername = `${slug}-admin-${reg.id}`;
  }
  const adminPasswordHash = reg.admin_password_hash
    || await bcrypt.hash(crypto_randomPassword(), 10); // safety net for legacy rows with no stored hash

  let mid = 0;
  try {
    const created = await db.transaction(async (tx) => {
      const r = await tx.run(
        `INSERT INTO madaris
          (slug, name_en, address, city, town, state_name, phone, email, plan_id, status,
           description_en, founded_year, website, category, institution_type, verified, brand_color,
           tagline, whatsapp, facebook, instagram, maps_link, admin_full_name, admin_position,
           public_listing)
         VALUES (?,?,?,?,?,?,?,?,?, 'active', ?,?,?,?,?,1, ?, ?,?,?,?,?,?,?, 1)`,
        [
          slug, reg.name, reg.address, reg.city, reg.town || "", reg.state_name, reg.phone, reg.email, plan.id,
          reg.description, reg.year_established, reg.website, category, reg.institution_type,
          institution.categoryConfig(category).primaryColor,
          reg.official_name, reg.whatsapp, reg.facebook, reg.instagram, reg.maps_link,
          reg.admin_full_name, reg.admin_position,
        ]
      );
      const id = r.lastInsertRowid;
      await tx.run(
        "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, email, phone) VALUES (?,?,?,?,?,?,?)",
        [id, adminUsername, adminPasswordHash, "madrasa_admin", reg.admin_full_name || "Administrator", reg.admin_email, reg.admin_phone]
      );
      // Seed the three standard terms under a starter session so the new
      // dashboard's Academic/Attendance/Results screens have somewhere to
      // record data on day one.
      const year = new Date().getFullYear();
      const s = await tx.run(
        "INSERT INTO academic_sessions (madrasa_id, label, is_current) VALUES (?,?,1)",
        [id, `${year}/${year + 1}`]
      );
      const defaults = [["First Term"], ["Second Term"], ["Third Term"]];
      for (let i = 0; i < defaults.length; i++) {
        await tx.run(
          "INSERT INTO terms (madrasa_id, session_id, position, name_en) VALUES (?,?,?,?)",
          [id, s.lastInsertRowid, i + 1, defaults[i][0]]
        );
      }
      // Seed subjects from the fixed catalogue for this category so the new
      // admin's Islamic Subjects / Academic Programs screens are populated.
      for (const subjectName of institution.subjectCatalogue(category)) {
        const meta = catalogueSubjectMeta(category, subjectName);
        await tx.run("INSERT INTO subjects (madrasa_id, name_en, category, education_track, status) VALUES (?,?,?,?,?)", [id, subjectName, meta.category, meta.track, "active"]);
      }
      return { id };
    });
    mid = created.id;
  } catch (e) {
    console.error("Failed to promote registration (rolled back):", e);
    return err(res, 500, "Could not create the institution. Nothing was saved — please try again.");
  }

  await db.run(
    "UPDATE madrasa_registrations SET status = 'Approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, promoted_madrasa_id = ? WHERE id = ?",
    [req.user.id, mid, reg.id]
  );
  logActivity(db, { userId: req.user.id, madrasaId: mid, action: "registration.approve", entity: "madrasa_registration", entityId: String(reg.id), meta: { slug, category }, ip: req.ip });
  ok(res, { ok: true, madrasaId: mid, slug, username: adminUsername, category });
}));

router.post("/registrations/:id/reject", asyncHandler(async (req, res) => {
  const reg = await db.get("SELECT * FROM madrasa_registrations WHERE id = ?", [toNum(req.params.id, 0)]);
  if (!reg) return err(res, 404, "Registration not found.");
  if (reg.status !== "Pending") return err(res, 400, `This registration is already ${reg.status}.`);
  const note = cleanStr((req.body || {}).note, 2000);
  await db.run(
    "UPDATE madrasa_registrations SET status = 'Rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ? WHERE id = ?",
    [req.user.id, note, reg.id]
  );
  logActivity(db, { userId: req.user.id, action: "registration.reject", entity: "madrasa_registration", entityId: String(reg.id), meta: { note }, ip: req.ip });
  ok(res, { ok: true });
}));

function crypto_randomPassword() {
  return require("crypto").randomBytes(12).toString("base64url");
}

/* ------------------------------ plans ---------------------------------- */

/**
 * Plans.features is the entitlement map every gate reads, so it is validated on
 * the way in: catalogue keys are coerced to booleans, keys the catalogue does
 * not know are kept only if they were already boolean (an operator's own
 * experiment, never a string that would read as truthy), and a plan whose code
 * matches a known tier starts from that tier's defaults so a brand-new "basic"
 * row cannot be created with nothing switched on.
 */
function normaliseFeatureInput(input, planCode) {
  const raw = input && typeof input === "object" ? input : {};
  const out = catalogue.featuresForTier(planCode);
  for (const [key, value] of Object.entries(raw)) {
    if (catalogue.isKnownFeature(key)) out[key] = Boolean(value);
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

router.get("/plans", asyncHandler(async (req, res) => {
  const rows = await db.all(
    `SELECT p.*, (SELECT COUNT(*) FROM madaris m WHERE m.plan_id = p.id) AS madaris_count
     FROM plans p ORDER BY p.sort_order`
  );
  ok(res, {
    plans: rows.map((p) => {
      // `features` is the NORMALISED map (stored values + tier defaults for any
      // key the row predates) and `offer` is the marketing copy for that tier,
      // so the operator edits exactly what a school is shown and gated on.
      const offer = catalogue.offerFor(p);
      return Object.assign({}, p, { features: offer.features, offer });
    }),
    // The catalogue the editor renders: groups, every switchable key with its
    // label/blurb/lowest tier, and the tier presets.
    feature_catalogue: {
      groups: catalogue.FEATURE_GROUPS.map((g) => ({ key: g.key, title: g.title })),
      features: catalogue.FEATURE_KEYS.map((key) => ({
        key,
        label: catalogue.FEATURES[key].label,
        blurb: catalogue.FEATURES[key].blurb,
        group: catalogue.FEATURES[key].group,
        minimum_tier: catalogue.FEATURES[key].tier,
      })),
      tiers: catalogue.TIER_ORDER.map((code) => ({
        code,
        name: catalogue.TIERS[code].name,
        tagline: catalogue.TIERS[code].tagline,
        feature_keys: catalogue.tierFeatureKeys(code),
      })),
    },
  });
}));

router.post("/plans", asyncHandler(async (req, res) => {
  const b = req.body || {};
  const code = cleanStr(b.code, 30).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const name = cleanStr(b.name, 80);
  if (!code || !name) return err(res, 400, "code and name are required.");
  const exists = await db.get("SELECT id FROM plans WHERE code = ?", [code]);
  if (exists) return err(res, 400, "Plan code already exists.");
  const r = await db.run(
    `INSERT INTO plans (code, name, name_ar, description, price_ngn, price_yearly_ngn, student_limit, teacher_limit, trial_days, is_public, features, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      code, name, cleanStr(b.name_ar, 80), cleanStr(b.description, 255),
      toNum(b.price_ngn, 0), toNum(b.price_yearly_ngn, 0),
      toNum(b.student_limit, -1), toNum(b.teacher_limit, -1),
      toNum(b.trial_days, 0), b.is_public === false || b.is_public === 0 || b.is_public === "0" ? 0 : 1,
      JSON.stringify(normaliseFeatureInput(b.features, code)), toNum(b.sort_order, 99),
    ]
  );
  ok(res, { ok: true, id: r.lastInsertRowid });
}));

router.patch("/plans/:id", asyncHandler(async (req, res) => {
  const b = req.body || {};
  const p = await db.get("SELECT * FROM plans WHERE id = ?", [toNum(req.params.id, 0)]);
  if (!p) return res.status(404).json({ error: "Plan not found." });
  const fields = ["name", "name_ar", "description", "price_ngn", "price_yearly_ngn", "student_limit", "teacher_limit", "trial_days", "sort_order", "is_active", "is_public"];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (b[f] === undefined) continue;
    sets.push(`${f} = ?`);
    if (f === "name" || f === "name_ar") vals.push(cleanStr(b[f], 80));
    else if (f === "description") vals.push(cleanStr(b[f], 255));
    else vals.push(toNum(b[f], 0));
  }
  if (b.features !== undefined) { sets.push("features = ?"); vals.push(JSON.stringify(normaliseFeatureInput(b.features, p.code))); }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  vals.push(p.id);
  await db.run(`UPDATE plans SET ${sets.join(", ")} WHERE id = ?`, vals);
  ok(res, { ok: true });
}));

/* ------------------------------ activity ------------------------------- */

router.get("/activity", asyncHandler(async (req, res) => {
  const mid = toNum(req.query.madrasaId, 0);
  const limit = Math.min(200, toNum(req.query.limit, 50));
  const base = `SELECT a.*, u.username, m.slug AS madrasa_slug, m.name_en AS madrasa_name
                 FROM activity_log a
                 LEFT JOIN users u ON u.id = a.user_id
                 LEFT JOIN madaris m ON m.id = a.madrasa_id`;
  const rows = mid
    ? await db.all(base + " WHERE a.madrasa_id = ? ORDER BY a.id DESC LIMIT ?", [mid, limit])
    : await db.all(base + " ORDER BY a.id DESC LIMIT ?", [limit]);
  ok(res, { activity: rows });
}));

/* ------------------------------ diagnostics ---------------------------- */

/**
 * GET /api/platform/diagnostics
 * The same storage verdict the backups screen shows, at the path ops runbooks
 * and docs/PERSISTENCE.md reference: { persistence, backups, uptimeSeconds… }.
 * Safe to curl on a production box:
 *   curl -H "Cookie: $SESSION" https://host/api/platform/diagnostics
 */
router.get("/diagnostics", asyncHandler(async (req, res) => {
  const persistence = require("../services/persistence");
  const backup = require("../services/backup");
  const config = require("../config");
  const report = await persistence.report(db);
  const backups = await backup.list();
  ok(res, {
    persistence: report,
    backups: {
      directory: config.BACKUP_DIR,
      count: backups.length,
      newest: backups[0] || null,
      intervalMinutes: Number(config.BACKUP_INTERVAL_MINUTES || 0),
      keep: Number(config.BACKUP_KEEP || 10),
      onPersistentVolume: persistence.describeStorage(config.BACKUP_DIR).onPersistentVolume,
    },
    uptimeSeconds: Math.round(process.uptime()),
    bootedAt: report.marker ? report.marker.lastBootAt : null,
    bootCount: report.marker ? report.marker.bootCount : null,
    host: require("os").hostname(),
  });
}));

/* ------------------------------ support tickets ------------------------ */
/*
 * The operator's half of the support-ticket workflow (the institution's half
 * lives in /api/support). The queue is platform-wide; every action is audited
 * against the tenant that owns the ticket.
 */
const { CATEGORIES: TICKET_CATEGORIES, PRIORITIES: TICKET_PRIORITIES, STATUSES: TICKET_STATUSES } = require("./support");

router.get("/tickets", asyncHandler(async (req, res) => {
  const where = ["1=1"]; const params = [];
  const status = cleanStr(req.query.status, 20);
  if (status && TICKET_STATUSES.has(status)) { where.push("t.status = ?"); params.push(status); }
  const priority = cleanStr(req.query.priority, 20);
  if (priority && TICKET_PRIORITIES.has(priority)) { where.push("t.priority = ?"); params.push(priority); }
  const madrasaId = toNum(req.query.madrasaId, 0);
  if (madrasaId) { where.push("t.madrasa_id = ?"); params.push(madrasaId); }
  if (req.query.q) {
    const like = `%${cleanStr(req.query.q, 120).toLowerCase()}%`;
    where.push("(LOWER(t.subject) LIKE ? OR LOWER(COALESCE(t.body,'')) LIKE ? OR LOWER(m.name_en) LIKE ?)");
    params.push(like, like, like);
  }
  const tickets = await db.all(
    `SELECT t.*, m.name_en AS madrasa_name, m.slug AS madrasa_slug, u.full_name AS created_by_name,
            a.full_name AS assigned_to_name
       FROM support_tickets t
       JOIN madaris m ON m.id = t.madrasa_id
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN users a ON a.id = t.assigned_to
      WHERE ${where.join(" AND ")} ORDER BY CASE t.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'awaiting_reply' THEN 3 WHEN 'resolved' THEN 4 ELSE 5 END, t.updated_at DESC, t.id DESC LIMIT 300`,
    params
  );
  const counts = {};
  for (const row of await db.all("SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status")) counts[row.status] = Number(row.n);
  ok(res, { tickets, counts });
}));

router.get("/tickets/:id", asyncHandler(async (req, res) => {
  const id = toNum(req.params.id, 0);
  const ticket = await db.get(
    `SELECT t.*, m.name_en AS madrasa_name, m.slug AS madrasa_slug, u.full_name AS created_by_name,
            a.full_name AS assigned_to_name
       FROM support_tickets t
       JOIN madaris m ON m.id = t.madrasa_id
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN users a ON a.id = t.assigned_to
      WHERE t.id = ?`, [id]
  );
  if (!ticket) return err(res, 404, "Ticket not found.");
  const notes = await db.all(
    `SELECT n.*, u.full_name AS author_name FROM support_ticket_notes n
       LEFT JOIN users u ON u.id = n.author_user_id
      WHERE n.ticket_id = ? ORDER BY n.id`, [id]
  );
  ok(res, { ticket, notes });
}));

router.patch("/tickets/:id", asyncHandler(async (req, res) => {
  const id = toNum(req.params.id, 0);
  const ticket = await db.get("SELECT * FROM support_tickets WHERE id = ?", [id]);
  if (!ticket) return err(res, 404, "Ticket not found.");
  const b = req.body || {};
  const sets = []; const vals = [];
  const status = cleanStr(b.status, 20);
  if (status) {
    if (!TICKET_STATUSES.has(status)) return err(res, 400, "Unknown ticket status.");
    sets.push("status = ?"); vals.push(status);
    sets.push("resolved_at = " + (["resolved", "closed"].includes(status) ? "CURRENT_TIMESTAMP" : "NULL"));
  }
  const priority = cleanStr(b.priority, 20);
  if (priority) {
    if (!TICKET_PRIORITIES.has(priority)) return err(res, 400, "Unknown ticket priority.");
    sets.push("priority = ?"); vals.push(priority);
  }
  if (b.assigned_to !== undefined) {
    const assignee = toNum(b.assigned_to, 0);
    if (assignee && !await db.get("SELECT id FROM users WHERE id = ? AND role = 'super_admin' AND is_active = 1", [assignee])) {
      return err(res, 400, "Tickets can only be assigned to a platform administrator.");
    }
    sets.push("assigned_to = ?"); vals.push(assignee || null);
  }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(id);
  await db.run(`UPDATE support_tickets SET ${sets.join(", ")} WHERE id = ?`, vals);
  logActivity(db, { madrasaId: ticket.madrasa_id, userId: req.user.id, action: "platform.ticket.update", entity: "support_ticket", entityId: String(id), meta: { status, priority }, ip: req.ip });
  ok(res, { ok: true });
}));

router.post("/tickets/:id/notes", asyncHandler(async (req, res) => {
  const id = toNum(req.params.id, 0);
  const ticket = await db.get("SELECT * FROM support_tickets WHERE id = ?", [id]);
  if (!ticket) return err(res, 404, "Ticket not found.");
  const note = cleanStr(req.body && req.body.note, 10000);
  if (!note) return err(res, 400, "Note cannot be empty.");
  const internalOnly = req.body && (req.body.internal_only === true || req.body.internal_only === "1" || req.body.internal_only === 1) ? 1 : 0;
  await db.run(
    "INSERT INTO support_ticket_notes (madrasa_id, ticket_id, author_user_id, author_role, note, internal_only) VALUES (?,?,?,?,?,?)",
    [ticket.madrasa_id, ticket.id, req.user.id, req.user.role, note, internalOnly]
  );
  // A public (non-internal) operator reply moves the ticket to awaiting the
  // institution's response; an internal note leaves the status untouched.
  if (!internalOnly) {
    await db.run("UPDATE support_tickets SET status='awaiting_reply', updated_at=CURRENT_TIMESTAMP WHERE id=?", [ticket.id]);
  }
  logActivity(db, { madrasaId: ticket.madrasa_id, userId: req.user.id, action: internalOnly ? "platform.ticket.internal_note" : "platform.ticket.reply", entity: "support_ticket", entityId: String(ticket.id), ip: req.ip });
  ok(res, { ok: true });
}));

/* ------------------------------ platform settings ---------------------- */

/* Keys stored as "0"/"1" but spoken about as booleans everywhere else. */
const BOOL_KEYS = new Set(["public_directory_enabled"]);
/* Values that must NEVER reach a browser. GET /settings used to return every
   platform_settings row verbatim; the AI provider key lives in this table, so
   it is redacted to the sentinel instead. PUT treats the sentinel (or an
   omitted field) as "leave unchanged", so a round-trip from the settings form
   cannot blank a secret by accident. The real key is written only through
   Platform → AI Assistant, which encrypts it at rest. */
const SECRET_KEYS = new Set(["ai_api_key"]);
const SECRET_MASK = "••••";

const PLATFORM_SETTING_DEFAULTS = {
  public_site_title: "EduSphere",
  public_site_tagline: "Multi-Madrasa Management Platform",
  public_site_intro: "",
  public_contact_email: "",
  public_contact_phone: "",
  public_apply_url: "",
  public_directory_enabled: "1",
  // Where institutions send their subscription transfers, and the rules that
  // govern the billing lifecycle. Every field is optional: with the bank
  // details blank the upgrade screen says so instead of inventing an account.
  billing_bank_name: "",
  billing_account_number: "",
  billing_account_name: "",
  billing_transfer_note: "Use your institution name as the transfer reference.",
  billing_contact_email: "",
  billing_contact_phone: "",
  billing_currency: "NGN",
  billing_grace_days: "14",
  billing_warn_percent: "80",
  billing_enabled: "1",
  // The customer-facing WhatsApp line used by the public website's "Chat on
  // WhatsApp" button and by the assistant's hand-off. International format;
  // a Nigerian 0803… number is normalised to 234803… automatically.
  whatsapp_ai_number: "",
  whatsapp_ai_message: "Hello EduSphere, I would like to know more about the platform.",
};

/** Replaces every stored secret with the sentinel before the response leaves. */
function redactSecrets(out) {
  for (const key of SECRET_KEYS) {
    if (key in out) out[key] = out[key] ? SECRET_MASK : "";
  }
  return out;
}

router.get("/settings", asyncHandler(async (req, res) => {
  const rows = await db.all("SELECT key_name, value FROM platform_settings");
  // Defaults first, so the settings screen always shows the live values even
  // on a database where nobody has saved anything yet.
  const out = Object.assign({}, PLATFORM_SETTING_DEFAULTS);
  rows.forEach((r) => { out[r.key_name] = r.value; });
  for (const k of BOOL_KEYS) out[k] = !(out[k] === "0" || out[k] === "false" || out[k] === false || out[k] === 0);
  ok(res, { settings: redactSecrets(out) });
}));

router.put("/settings", asyncHandler(async (req, res) => {
  const b = req.body || {};
  const dialect = await db.dialect();
  for (const [k, v] of Object.entries(b)) {
    const key = cleanStr(k, 80);
    if (!key) continue;
    if (SECRET_KEYS.has(key)) {
      const incoming = String(v == null ? "" : v).trim();
      // Sentinel, blank or missing → leave the stored secret exactly as it is.
      if (!incoming || incoming === SECRET_MASK || /^•+$/.test(incoming)) continue;
      return err(res, 400, "The AI provider key is saved under Platform → AI Assistant, where it is stored encrypted. Please set it there.");
    }
    let val = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (BOOL_KEYS.has(key)) val = (v === true || v === 1 || v === "1" || v === "true") ? "1" : "0";
    if (dialect === "sqlite") {
      await db.run(
        `INSERT INTO platform_settings (key_name, value) VALUES (?, ?)
         ON CONFLICT(key_name) DO UPDATE SET value = excluded.value`,
        [key, val]
      );
    } else {
      await db.run(
        "INSERT INTO platform_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
        [key, val]
      );
    }
  }
  logActivity(db, { userId: req.user.id, action: "platform.settings", entity: "settings", ip: req.ip });
  ok(res, { ok: true });
}));

module.exports = router;
