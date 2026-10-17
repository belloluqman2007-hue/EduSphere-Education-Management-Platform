"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — Madrasa Admin routes (tenant-scoped)
   ----------------------------------------------------------------------------
   Protected: madrasa_admin of THIS madrasa (or super_admin inspecting).
   The tenant id ALWAYS comes from the authenticated user (see tenant.js) —
   never from the request.
   ========================================================================== */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, clampNum, validDate, logActivity } = require("../util");
const { requireAuth, requireRole, requireTenant } = require("../middleware/auth");
const { requireStaffPermission } = require("../services/permissions");
const { getActiveMadrasa } = require("../middleware/tenant");
const { requireFeature } = require("../middleware/subscription");
const { imageUploader } = require("../middleware/upload");
const grading = require("../services/grading");
const analytics = require("../services/analytics");
const institution = require("../services/institution");

// Two routers share the same tenant scope:
//  router      -> mounted at /api/madrasa (profile, settings)
//  rootRouter  -> mounted at the API root (classes, subjects, sessions, grading)
const router = express.Router();
const rootRouter = express.Router();
router.use(requireAuth, requireTenant);

/**
 * Resolves the caller's madrasa (and verifies it is active) for this request.
 * super_admin may inspect a specific madrasa via ?madrasaId (for support).
 */
async function resolveMadrasa(req, res) {
  let mid;
  if (req.user.role === "super_admin") {
    mid = toNum((req.query && req.query.madrasaId) || 0);
    if (!mid) { res.status(400).json({ error: "madrasaId required for super admin." }); return null; }
  } else {
    mid = req.user.madrasaId;
  }
  const m = await getActiveMadrasa(mid);
  if (!m) { res.status(m ? 403 : 404).json({ error: "Madrasa not found or not active." }); return null; }
  req.madrasa = m;
  return m;
}

const adminOrSupport = (req, res, next) => {
  if (req.user.role === "madrasa_admin" || req.user.role === "super_admin") return next();
  return res.status(403).json({ error: "Madrasa administrators only." });
};

/* ------------------------- ADMIN → MY INSTITUTION ----------------------- */
// The eight "My Institution" screens live in their own file but are mounted
// INSIDE this router, so they inherit requireAuth + requireTenant and use the
// very same resolveMadrasa/adminOrSupport guards as every other tenant route.
router.use("/institution", require("./institution")(resolveMadrasa, adminOrSupport));

/* ------------------------------ profile -------------------------------- */

router.get("/profile", asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const settings = {};
  const rows = await db.all("SELECT key_name, value FROM settings WHERE madrasa_id = ?", [m.id]);
  rows.forEach((r) => { settings[r.key_name] = r.value; });
  const plan = await db.get("SELECT * FROM plans WHERE id = ?", [m.plan_id]);
  const category = m.category || "islamic";
  ok(res, { madrasa: m, settings, plan, category, terminology: institution.terminology(category) });
}));

router.put("/profile", adminOrSupport, requireStaffPermission("institution.settings"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const b = req.body || {};
  const fields = {
    name_en: [b.name_en, 160], name_ar: [b.name_ar, 160],
    motto_en: [b.motto_en, 160], motto_ar: [b.motto_ar, 160],
    address: [b.address, 255], city: [b.city, 80], state_name: [b.state_name, 80],
    phone: [b.phone, 60], email: [b.email, 120],
    // Website/brand fields — kept inside a small, safe field set so every
    // tenant site still fits the shared EduSphere template.
    tagline: [b.tagline, 200], whatsapp: [b.whatsapp, 60],
    facebook: [b.facebook, 200], instagram: [b.instagram, 200], maps_link: [b.maps_link, 255],
    admin_full_name: [b.admin_full_name, 160], admin_position: [b.admin_position, 80],
    admission_info: [b.admission_info, 4000],
  };
  const sets = [];
  const vals = [];
  for (const [f, [v, max]] of Object.entries(fields)) {
    if (v !== undefined) { sets.push(`${f} = ?`); vals.push(cleanStr(v, max)); }
  }
  if (b.brand_color !== undefined) {
    const c = cleanStr(b.brand_color, 20);
    if (c && !/^#[0-9a-fA-F]{3,8}$/.test(c)) return err(res, 400, "brand_color must be a hex color like #220b40.");
    sets.push("brand_color = ?"); vals.push(c);
  }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(m.id);
  await db.run(`UPDATE madaris SET ${sets.join(", ")} WHERE id = ?`, vals);
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "profile.update", entity: "madrasa", entityId: String(m.id), ip: req.ip });
  ok(res, { ok: true });
}));

router.post("/profile/logo", adminOrSupport, requireStaffPermission("institution.settings"), imageUploader("logos", "logo"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  if (!req.file) return err(res, 400, "No image uploaded.");
  await db.run("UPDATE madaris SET logo_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [`/uploads/logos/${req.file.filename}`, m.id]);
  ok(res, { ok: true, logoPath: `/uploads/logos/${req.file.filename}` });
}));

router.post("/profile/hero", adminOrSupport, requireStaffPermission("institution.settings"), imageUploader("hero", "hero"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  if (!req.file) return err(res, 400, "No image uploaded.");
  await db.run("UPDATE madaris SET hero_image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [`/uploads/hero/${req.file.filename}`, m.id]);
  ok(res, { ok: true, heroImagePath: `/uploads/hero/${req.file.filename}` });
}));

/* ------------------------------ gallery -------------------------------- */

router.get("/gallery", adminOrSupport, requireStaffPermission("website.view"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const rows = await db.all("SELECT * FROM gallery_images WHERE madrasa_id = ? ORDER BY sort_order, id", [m.id]);
  ok(res, { images: rows });
}));

router.post("/gallery", adminOrSupport, requireStaffPermission("website.edit"), imageUploader("gallery", "image"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  if (!req.file) return err(res, 400, "No image uploaded.");
  const caption = cleanStr((req.body || {}).caption, 200);
  const count = await db.get("SELECT COUNT(*) AS n FROM gallery_images WHERE madrasa_id = ?", [m.id]);
  if (Number(count.n) >= 40) return err(res, 400, "Gallery limit reached (40 images).");
  const r = await db.run(
    "INSERT INTO gallery_images (madrasa_id, image_path, caption, sort_order) VALUES (?,?,?,?)",
    [m.id, `/uploads/gallery/${req.file.filename}`, caption, Number(count.n)]
  );
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "gallery.add", entity: "gallery_image", entityId: String(r.lastInsertRowid), ip: req.ip });
  ok(res, { ok: true, id: r.lastInsertRowid, imagePath: `/uploads/gallery/${req.file.filename}` });
}));

router.delete("/gallery/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const row = await db.get("SELECT id FROM gallery_images WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
  if (!row) return err(res, 404, "Image not found.");
  await db.run("DELETE FROM gallery_images WHERE id = ?", [row.id]);
  ok(res, { ok: true });
}));

/* ------------------------------ public site ---------------------------- */

/**
 * What the LOGGED-OUT public site may show for this madrasa, plus the
 * statistics the settings screen previews. Saved straight onto the madrasa
 * row so a directory query never needs a join.
 */
router.get("/public-site", adminOrSupport, requireStaffPermission("website.view"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const [pending, published, notices] = await Promise.all([
    db.get("SELECT COUNT(*) AS n FROM admission_requests WHERE madrasa_id = ? AND status = 'pending'", [m.id]),
    db.get("SELECT COUNT(*) AS n FROM term_summaries WHERE madrasa_id = ? AND published_at IS NOT NULL", [m.id]),
    db.get("SELECT COUNT(*) AS n FROM announcements WHERE madrasa_id = ? AND is_active = 1 AND publish_public = 1", [m.id]),
  ]);
  ok(res, {
    settings: {
      public_listing: Number(m.public_listing) === 1,
      public_results: Number(m.public_results) === 1,
      public_admissions: Number(m.public_admissions) === 1,
      description_en: m.description_en || "",
      description_ar: m.description_ar || "",
      founded_year: m.founded_year || "",
      website: m.website || "",
    },
    counts: {
      pendingApplications: Number(pending.n),
      publishedResults: Number(published.n),
      publicNotices: Number(notices.n),
    },
    urls: {
      // `site` is the canonical institution website. Legacy integration keys
      // remain for older portal clients and are not used for website links.
      site: `/schools/${m.slug}`,
      directory: `/madrasa/${m.slug}`,
      results: `/results-check?madrasa=${m.slug}`,
      apply: `/apply/${m.slug}`,
    },
  });
}));

router.put("/public-site", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const b = req.body || {};
  const sets = [];
  const vals = [];
  for (const flag of ["public_listing", "public_results", "public_admissions"]) {
    if (b[flag] !== undefined) { sets.push(`${flag} = ?`); vals.push(b[flag] ? 1 : 0); }
  }
  for (const [key, max] of [["description_en", 4000], ["description_ar", 4000], ["website", 160]]) {
    if (b[key] !== undefined) { sets.push(`${key} = ?`); vals.push(cleanStr(b[key], max)); }
  }
  if (b.founded_year !== undefined) {
    const y = cleanStr(b.founded_year, 8);
    if (y && !/^\d{4}$/.test(y)) return err(res, 400, "Founded year must be a 4-digit year.");
    sets.push("founded_year = ?"); vals.push(y);
  }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(m.id);
  await db.run(`UPDATE madaris SET ${sets.join(", ")} WHERE id = ?`, vals);
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "madrasa.public_site", entity: "madrasa", entityId: String(m.id), ip: req.ip });
  ok(res, { ok: true });
}));

/* ------------------------------ analytics ------------------------------ */

/**
 * GET /api/madrasa/analytics?months=12&attendanceDays=30&termId=N
 * Dashboard aggregates for THIS madrasa. madrasa_admin only (a super admin may
 * inspect a specific madrasa with ?madrasaId for support). The tenant id is
 * always resolved from the session user — never from the request.
 */
router.get("/analytics", adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const data = await analytics.tenantAnalytics(m.id, {
    months: req.query.months,
    attendanceDays: req.query.attendanceDays,
    termId: req.query.termId,
  });
  ok(res, { madrasaId: m.id, analytics: data });
}));

/**
 * GET /api/madrasa/analytics/advanced?months=6&attendanceDays=60&termId=N
 * The PREMIUM analytics view (`analytics_advanced`): attendance heatmaps,
 * teacher performance, fee forecasting, attendance patterns and the insight
 * list the AI copilot answers from. It is a separate endpoint rather than extra
 * keys on /analytics so a school below Premium keeps the dashboard it has, and
 * the 403 carries the offer that explains what would appear.
 */
router.get("/analytics/advanced", adminOrSupport, requireFeature("analytics_advanced"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const data = await analytics.advancedAnalytics(m.id, {
    months: req.query.months,
    attendanceDays: req.query.attendanceDays,
    termId: req.query.termId,
  });
  ok(res, { madrasaId: m.id, analytics: data });
}));

/**
 * GET /api/madrasa/dashboard
 * Everything the admin dashboard landing page needs in one call: the six
 * headline stat cards, today's attendance breakdown, today's classes, recent
 * applications and recent announcements — scoped strictly to this tenant.
 */
router.get("/dashboard", adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const today = new Date();
  const isoToday = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][today.getDay()];

  const [totals, attToday, pendingApps, todaysClasses, recentApps, recentAnnouncements, feesTotal, expensesTotal] = await Promise.all([
    db.get(
      `SELECT
         (SELECT COUNT(*) FROM students WHERE madrasa_id = ? AND status IN ('active','promoted','suspended')) AS students,
         (SELECT COUNT(*) FROM users WHERE madrasa_id = ? AND role = 'teacher' AND is_active = 1) AS teachers,
         (SELECT COUNT(*) FROM classes WHERE madrasa_id = ? AND is_active = 1) AS classes,
         (SELECT COUNT(*) FROM subjects WHERE madrasa_id = ? AND is_active = 1) AS subjects`,
      [m.id, m.id, m.id, m.id]
    ),
    db.all("SELECT status, COUNT(*) AS n FROM attendance WHERE madrasa_id = ? AND day = ? GROUP BY status", [m.id, isoToday]),
    db.get("SELECT COUNT(*) AS n FROM admission_requests WHERE madrasa_id = ? AND status = 'pending'", [m.id]),
    db.all(
      `SELECT ts.day, ts.period, ts.start_time, ts.end_time, c.name_en AS class_name,
              su.name_en AS subject_name, u.full_name AS teacher_name
         FROM timetable_slots ts
         JOIN classes c ON c.id = ts.class_id
         LEFT JOIN subjects su ON su.id = ts.subject_id
         LEFT JOIN users u ON u.id = ts.teacher_id
        WHERE ts.madrasa_id = ? AND ts.day = ?
        ORDER BY ts.period`,
      [m.id, dayName]
    ),
    db.all(
      `SELECT id, reference, status, first_name, last_name, created_at
         FROM admission_requests WHERE madrasa_id = ? ORDER BY id DESC LIMIT 6`,
      [m.id]
    ),
    db.all(
      `SELECT id, title, body, created_at FROM announcements
        WHERE madrasa_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 6`,
      [m.id]
    ),
    db.get("SELECT COALESCE(SUM(amount_ngn), 0) AS total FROM fee_payments WHERE madrasa_id = ? AND status = 'successful'", [m.id]),
    db.get("SELECT COALESCE(SUM(amount_ngn), 0) AS total FROM expenses WHERE madrasa_id = ? AND status = 'approved'", [m.id]),
  ]);

  const attMap = {};
  attToday.forEach((r) => { attMap[r.status] = Number(r.n); });
  const attMarked = Object.values(attMap).reduce((a, b) => a + b, 0);
  const totalStudents = totals ? Number(totals.students) : 0;
  const totalFeesCollected = feesTotal ? Number(feesTotal.total) : 0;
  const totalExpensesNgn = expensesTotal ? Number(expensesTotal.total) : 0;

  ok(res, {
    madrasaId: m.id,
    category: m.category || "islamic",
    total_fees_collected: totalFeesCollected,
    total_expenses_ngn: totalExpensesNgn,
    stats: {
      totalStudents,
      totalTeachers: totals ? Number(totals.teachers) : 0,
      totalClasses: totals ? Number(totals.classes) : 0,
      totalSubjects: totals ? Number(totals.subjects) : 0,
      pendingApplications: pendingApps ? Number(pendingApps.n) : 0,
      total_fees_collected: totalFeesCollected,
      total_expenses_ngn: totalExpensesNgn,
      totalFeesCollected,
      totalExpensesNgn,
      attendanceToday: {
        present: attMap.present || 0,
        absent: attMap.absent || 0,
        late: attMap.late || 0,
        excused: attMap.excused || 0,
        marked: attMarked,
        unmarked: Math.max(0, totalStudents - attMarked),
      },
    },
    todaysClasses: todaysClasses.map((r) => ({
      day: r.day, period: r.period, startTime: r.start_time, endTime: r.end_time,
      className: r.class_name, subjectName: r.subject_name || "—", teacherName: r.teacher_name || "—",
    })),
    recentApplications: recentApps.map((r) => ({
      id: r.id, reference: r.reference, status: r.status,
      name: `${r.first_name} ${r.last_name}`.trim(), createdAt: r.created_at,
    })),
    recentAnnouncements: recentAnnouncements.map((r) => ({
      id: r.id, title: r.title, body: r.body, createdAt: r.created_at,
    })),
  });
}));

/** Per-madrasa key/value settings (admission prefix, notification preference,
 *  website page copy, etc.). Values remain private unless a public projection
 *  deliberately asks for them. */
router.get("/settings", adminOrSupport, requireStaffPermission("institution.settings"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const rows = await db.all("SELECT key_name, value FROM settings WHERE madrasa_id = ? ORDER BY key_name", [m.id]);
  const settings = {};
  rows.forEach((row) => { settings[row.key_name] = row.value; });
  ok(res, { settings });
}));

router.put("/settings", adminOrSupport, requireStaffPermission("institution.settings"), asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const dialect = await db.dialect();
  for (const [k, v] of Object.entries(req.body || {})) {
    const key = cleanStr(k, 80);
    if (!key) continue;
    const val = String(v === null || v === undefined ? "" : v);
    if (dialect === "sqlite") {
      await db.run("INSERT INTO settings (madrasa_id, key_name, value) VALUES (?,?,?) ON CONFLICT(madrasa_id, key_name) DO UPDATE SET value = excluded.value", [m.id, key, val]);
    } else {
      await db.run("INSERT INTO settings (madrasa_id, key_name, value) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [m.id, key, val]);
    }
  }
  ok(res, { ok: true });
}));

/* ------------------------------ classes -------------------------------- */

rootRouter.get("/classes", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const rows = await db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM class_subjects cs WHERE cs.class_id = c.id) AS subject_count,
            (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.status IN ('active','promoted','suspended')) AS student_count
     FROM classes c WHERE c.madrasa_id = ? AND c.is_active = 1 ORDER BY c.sort_order, c.id`,
    [m.id]
  );
  // Attach subjects per class
  const cs = await db.all("SELECT * FROM class_subjects WHERE madrasa_id = ? ORDER BY id", [m.id]);
  const subs = await db.all("SELECT * FROM subjects WHERE madrasa_id = ?", [m.id]);
  const subMap = new Map(subs.map((s) => [s.id, s]));
  rows.forEach((r) => {
    r.subjects = cs.filter((x) => x.class_id === r.id).map((x) => subMap.get(x.subject_id)).filter(Boolean);
  });
  ok(res, { classes: rows });
}));

rootRouter.post("/classes", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const b = req.body || {};
  const nameEn = cleanStr(b.name_en, 120);
  if (!nameEn) return err(res, 400, "Class name is required.");
  const dup = await db.get("SELECT id FROM classes WHERE madrasa_id = ? AND name_en = ?", [m.id, nameEn]);
  if (dup) return err(res, 400, "A class with this name already exists.");
  const r = await db.run("INSERT INTO classes (madrasa_id, name_en, name_ar, sort_order) VALUES (?,?,?,?)", [m.id, nameEn, cleanStr(b.name_ar, 120), toNum(b.sort_order, 0)]);
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "class.create", entity: "class", entityId: String(r.lastInsertRowid), ip: req.ip });
  ok(res, { ok: true, id: r.lastInsertRowid });
}));

async function loadClass(req, res, id) {
  const m = req.madrasa || await resolveMadrasa(req, res);
  if (!m) return null;
  const row = await db.get("SELECT * FROM classes WHERE id = ? AND madrasa_id = ?", [toNum(id, 0), m.id]);
  if (!row) { res.status(404).json({ error: "Class not found." }); return null; }
  return row;
}

rootRouter.patch("/classes/:id", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const c = await loadClass(req, res, req.params.id);
  if (!c) return;
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.name_en !== undefined) { sets.push("name_en = ?"); vals.push(cleanStr(b.name_en, 120)); }
  if (b.name_ar !== undefined) { sets.push("name_ar = ?"); vals.push(cleanStr(b.name_ar, 120)); }
  if (b.sort_order !== undefined) { sets.push("sort_order = ?"); vals.push(toNum(b.sort_order, 0)); }
  if (b.is_active !== undefined) { sets.push("is_active = ?"); vals.push(b.is_active ? 1 : 0); }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  vals.push(c.id);
  await db.run(`UPDATE classes SET ${sets.join(", ")} WHERE id = ?`, vals);
  ok(res, { ok: true });
}));

rootRouter.delete("/classes/:id", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const c = await loadClass(req, res, req.params.id);
  if (!c) return;
  const usage = await db.get("SELECT COUNT(*) AS n FROM students WHERE class_id = ? AND status IN ('active','promoted','suspended')", [c.id]);
  if (Number(usage.n) > 0) return err(res, 400, "This class still has students. Move them first.");
  await db.run("DELETE FROM class_subjects WHERE class_id = ?", [c.id]);
  await db.run("DELETE FROM classes WHERE id = ?", [c.id]);
  logActivity(db, { madrasaId: req.madrasa.id, userId: req.user.id, action: "class.delete", entity: "class", entityId: String(c.id), ip: req.ip });
  ok(res, { ok: true });
}));

/** Set the subjects for a class (replace all). */
rootRouter.put("/classes/:id/subjects", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const c = await loadClass(req, res, req.params.id);
  if (!c) return;
  const subjectIds = Array.isArray(req.body && req.body.subject_ids) ? req.body.subject_ids.map((x) => toNum(x, 0)).filter(Boolean) : [];
  await db.run("DELETE FROM class_subjects WHERE class_id = ? AND madrasa_id = ?", [c.id, req.madrasa.id]);
  for (const sid of subjectIds) {
    const s = await db.get("SELECT id FROM subjects WHERE id = ? AND madrasa_id = ?", [sid, req.madrasa.id]);
    if (s) await db.insertIgnore("class_subjects", "madrasa_id, class_id, subject_id", [req.madrasa.id, c.id, sid]);
  }
  ok(res, { ok: true });
}));

/* ------------------------------ subjects ------------------------------- */

const SUBJECT_CATEGORIES = [
  "Mathematics", "English", "Sciences", "Computer Science", "Technology",
  "Business", "Arts", "Social Sciences", "Languages", "Other Subjects",
];
const SUBJECT_TRACKS = new Set(["islamic", "western", "both"]);
const SUBJECT_STATUSES = new Set(["active", "inactive", "archived"]);

function subjectTrack(value) {
  const track = cleanStr(value, 20).toLowerCase();
  return SUBJECT_TRACKS.has(track) ? track : "both";
}
function subjectCategory(value) {
  const category = cleanStr(value, 80);
  return category || "Other Subjects";
}
function subjectStatus(value, fallback = "active") {
  const status = cleanStr(value, 20).toLowerCase();
  return SUBJECT_STATUSES.has(status) ? status : fallback;
}

rootRouter.get("/subjects/categories", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const rows = await db.all(
    `SELECT category, COUNT(*) AS subject_count
       FROM subjects WHERE madrasa_id = ? AND status <> 'archived'
      GROUP BY category ORDER BY category`, [m.id]
  );
  const counts = new Map(rows.map((row) => [row.category, Number(row.subject_count)]));
  ok(res, { categories: SUBJECT_CATEGORIES.map((name) => ({ name, subject_count: counts.get(name) || 0 })), tracks: ["islamic", "western", "both"] });
}));

rootRouter.get("/subjects", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const where = ["s.madrasa_id = ?"];
  const params = [m.id];
  const status = cleanStr(req.query.status, 20).toLowerCase();
  if (status && status !== "all") { where.push("s.status = ?"); params.push(subjectStatus(status, "active")); }
  else if (req.query.includeArchived !== "true" && status !== "all") where.push("s.is_active = 1");
  const search = cleanStr(req.query.search, 120);
  if (search) { where.push("(s.name_en LIKE ? OR s.name_ar LIKE ? OR s.subject_code LIKE ? OR s.category LIKE ?)"); const q = `%${search}%`; params.push(q, q, q, q); }
  if (req.query.category) { where.push("s.category = ?"); params.push(subjectCategory(req.query.category)); }
  if (req.query.educationTrack) { where.push("s.education_track = ?"); params.push(subjectTrack(req.query.educationTrack)); }
  const rows = await db.all(
    `SELECT s.*,
       (SELECT COUNT(*) FROM class_subjects cs WHERE cs.madrasa_id = s.madrasa_id AND cs.subject_id = s.id AND cs.status <> 'archived') AS class_count,
       (SELECT COUNT(*) FROM teacher_assignments ta WHERE ta.madrasa_id = s.madrasa_id AND ta.subject_id = s.id AND ta.status <> 'archived') AS teacher_count,
       (SELECT COUNT(DISTINCT st.id) FROM students st JOIN class_subjects cs2 ON cs2.class_id = st.class_id AND cs2.madrasa_id = st.madrasa_id WHERE cs2.subject_id = s.id AND cs2.madrasa_id = s.madrasa_id AND st.status IN ('active','promoted','suspended')) AS student_count
       FROM subjects s WHERE ${where.join(" AND ")} ORDER BY s.category, s.name_en`, params
  );
  rows.forEach((row) => {
    row.is_active = Number(row.is_active) === 1;
    row.class_count = Number(row.class_count || 0);
    row.teacher_count = Number(row.teacher_count || 0);
    row.student_count = Number(row.student_count || 0);
  });
  ok(res, { subjects: rows, categories: SUBJECT_CATEGORIES });
}));

rootRouter.post("/subjects", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const b = req.body || {};
  const nameEn = cleanStr(b.name_en, 120);
  const nameAr = cleanStr(b.name_ar, 120);
  if (!nameEn && !nameAr) return err(res, 400, "Subject name (English or Arabic) is required.");
  const nameKey = nameEn || nameAr;
  const code = cleanStr(b.subject_code || b.code, 60).toUpperCase();
  const dup = await db.get(
    `SELECT id FROM subjects WHERE madrasa_id = ? AND (name_en = ? OR name_ar = ?${code ? " OR subject_code = ?" : ""})`,
    code ? [m.id, nameEn, nameAr, code] : [m.id, nameEn, nameAr]
  );
  if (dup) return err(res, 400, "A subject with this name or code already exists.");
  const track = subjectTrack(b.education_track || b.educationTrack);
  const category = subjectCategory(b.category);
  const status = subjectStatus(b.status, b.is_active === false ? "inactive" : "active");
  const sessionId = b.session_id || b.sessionId ? toNum(b.session_id || b.sessionId, 0) : null;
  const termId = b.term_id || b.termId ? toNum(b.term_id || b.termId, 0) : null;
  if (sessionId && !(await db.get("SELECT id FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sessionId, m.id]))) return err(res, 400, "Academic session not found.");
  if (termId && !(await db.get("SELECT id FROM terms WHERE id = ? AND madrasa_id = ?", [termId, m.id]))) return err(res, 400, "Term not found.");
  const r = await db.run(
    `INSERT INTO subjects (madrasa_id, name_en, name_ar, is_active, subject_code, category, description, education_track, academic_level, session_id, term_id, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [m.id, nameEn || nameKey, nameAr, status === "active" ? 1 : 0, code, category, cleanStr(b.description, 5000), track, cleanStr(b.academic_level || b.academicLevel, 80), sessionId, termId, status]
  );
  const subject = await db.get("SELECT * FROM subjects WHERE id = ? AND madrasa_id = ?", [r.lastInsertRowid, m.id]);
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "subject.create", entity: "subject", entityId: String(r.lastInsertRowid), meta: { category, education_track: track }, ip: req.ip });
  ok(res, { ok: true, id: r.lastInsertRowid, subject });
}));

rootRouter.get("/subjects/:id", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const id = toNum(req.params.id, 0);
  const subject = await db.get("SELECT * FROM subjects WHERE id = ? AND madrasa_id = ?", [id, m.id]);
  if (!subject) return err(res, 404, "Subject not found.");
  const [classes, teachers, students, timetable, lessons, assignments, exams, results] = await Promise.all([
    db.all(`SELECT c.*, cs.session_id AS subject_session_id, cs.term_id AS subject_term_id,
              (SELECT COUNT(*) FROM students st WHERE st.class_id = c.id AND st.madrasa_id = c.madrasa_id AND st.status IN ('active','promoted','suspended')) AS student_count
       FROM class_subjects cs JOIN classes c ON c.id = cs.class_id AND c.madrasa_id = cs.madrasa_id
      WHERE cs.madrasa_id = ? AND cs.subject_id = ? AND cs.status <> 'archived' ORDER BY c.sort_order, c.name_en`, [m.id, id]),
    db.all(`SELECT ta.*, u.full_name, u.email, u.phone, c.name_en AS class_name
       FROM teacher_assignments ta JOIN users u ON u.id = ta.user_id AND u.madrasa_id = ta.madrasa_id
       LEFT JOIN classes c ON c.id = ta.class_id AND c.madrasa_id = ta.madrasa_id
      WHERE ta.madrasa_id = ? AND ta.subject_id = ? AND ta.status <> 'archived' ORDER BY u.full_name`, [m.id, id]),
    db.all(`SELECT st.id, st.admission_no, st.first_name, st.last_name, c.name_en AS class_name
       FROM students st JOIN class_subjects cs ON cs.class_id = st.class_id AND cs.madrasa_id = st.madrasa_id
       LEFT JOIN classes c ON c.id = st.class_id AND c.madrasa_id = st.madrasa_id
      WHERE st.madrasa_id = ? AND cs.subject_id = ? AND cs.status <> 'archived' AND st.status IN ('active','promoted','suspended')
      ORDER BY st.admission_no`, [m.id, id]),
    db.all(`SELECT ts.*, c.name_en AS class_name, u.full_name AS teacher_name
       FROM timetable_slots ts JOIN classes c ON c.id = ts.class_id AND c.madrasa_id = ts.madrasa_id
       LEFT JOIN users u ON u.id = ts.teacher_id AND u.madrasa_id = ts.madrasa_id
      WHERE ts.madrasa_id = ? AND ts.subject_id = ? ORDER BY ts.day, ts.period`, [m.id, id]),
    db.all(`SELECT h.*, c.name_en AS class_name FROM homework h LEFT JOIN classes c ON c.id = h.class_id AND c.madrasa_id = h.madrasa_id WHERE h.madrasa_id = ? AND h.subject_id = ? AND h.kind = 'lesson' ORDER BY h.created_at DESC`, [m.id, id]),
    db.all(`SELECT h.*, c.name_en AS class_name FROM homework h LEFT JOIN classes c ON c.id = h.class_id AND c.madrasa_id = h.madrasa_id WHERE h.madrasa_id = ? AND h.subject_id = ? AND h.kind = 'assignment' ORDER BY h.created_at DESC`, [m.id, id]),
    db.all(`SELECT e.*, c.name_en AS class_name FROM exams e LEFT JOIN classes c ON c.id = e.class_id AND c.madrasa_id = e.madrasa_id WHERE e.madrasa_id = ? AND e.subject_id = ? ORDER BY e.exam_date DESC, e.id DESC`, [m.id, id]),
    db.all(`SELECT r.*, st.admission_no, st.first_name, st.last_name FROM results r JOIN students st ON st.id = r.student_id AND st.madrasa_id = r.madrasa_id WHERE r.madrasa_id = ? AND r.subject_id = ? ORDER BY r.updated_at DESC`, [m.id, id]),
  ]);
  ok(res, { subject, classes, teachers, students, timetable, lessons, assignments, exams, results });
}));

rootRouter.put("/subjects/:id/classes", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const subjectId = toNum(req.params.id, 0);
  const subject = await db.get("SELECT id FROM subjects WHERE id = ? AND madrasa_id = ?", [subjectId, m.id]);
  if (!subject) return err(res, 404, "Subject not found.");
  const raw = Array.isArray(req.body && req.body.classes) ? req.body.classes : (Array.isArray(req.body && req.body.class_ids) ? req.body.class_ids.map((classId) => ({ class_id: classId })) : []);
  const rows = [];
  const seenClassRows = new Set();
  for (const item of raw) {
    const classId = toNum(item.class_id || item.classId || item.id, 0);
    if (!classId || !(await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, m.id]))) continue;
    const sessionId = toNum(item.session_id || item.sessionId, 0) || null; const termId = toNum(item.term_id || item.termId, 0) || null;
    const key = `${classId}`; if (seenClassRows.has(key)) continue; seenClassRows.add(key);
    rows.push({ classId, sessionId, termId });
  }
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM class_subjects WHERE madrasa_id = ? AND subject_id = ?", [m.id, subjectId]);
    for (const row of rows) await tx.run("INSERT INTO class_subjects (madrasa_id, class_id, subject_id, session_id, term_id) VALUES (?,?,?,?,?)", [m.id, row.classId, subjectId, row.sessionId, row.termId]);
  });
  ok(res, { ok: true, assigned: rows.length });
}));

rootRouter.put("/subjects/:id/teachers", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const subjectId = toNum(req.params.id, 0);
  if (!(await db.get("SELECT id FROM subjects WHERE id = ? AND madrasa_id = ?", [subjectId, m.id]))) return err(res, 404, "Subject not found.");
  const raw = Array.isArray(req.body && req.body.teachers) ? req.body.teachers : [];
  const rows = [];
  for (const item of raw) {
    const userId = toNum(item.user_id || item.userId || item.id, 0);
    if (!userId || !(await db.get("SELECT id FROM users WHERE id = ? AND madrasa_id = ? AND role = 'teacher'", [userId, m.id]))) continue;
    const classId = toNum(item.class_id || item.classId, 0) || null;
    if (classId && !(await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, m.id]))) continue;
    rows.push({ userId, classId, role: cleanStr(item.role, 40) || "subject_teacher", sessionId: toNum(item.academic_session_id || item.session_id || item.sessionId, 0) || null, termId: toNum(item.term_id || item.termId, 0) || null, notes: cleanStr(item.notes, 500) });
  }
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM teacher_assignments WHERE madrasa_id = ? AND subject_id = ?", [m.id, subjectId]);
    for (const row of rows) {
      await tx.run(`INSERT INTO teacher_assignments (madrasa_id, user_id, class_id, subject_id, role, academic_session_id, term_id, notes, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`, [m.id, row.userId, row.classId, subjectId, row.role, row.sessionId, row.termId, row.notes, "active"]);
    }
  });
  ok(res, { ok: true, assigned: rows.length });
}));

rootRouter.patch("/subjects/:id/archive", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res); if (!m) return;
  const id = toNum(req.params.id, 0); const subject = await db.get("SELECT id FROM subjects WHERE id = ? AND madrasa_id = ?", [id, m.id]);
  if (!subject) return err(res, 404, "Subject not found.");
  const archived = req.body && req.body.archived !== undefined ? Boolean(req.body.archived) : true;
  await db.run("UPDATE subjects SET status = ?, is_active = ?, archived_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [archived ? "archived" : "active", archived ? 0 : 1, archived ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, id, m.id]);
  ok(res, { ok: true, archived });
}));

rootRouter.patch("/subjects/:id", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const s = await db.get("SELECT * FROM subjects WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
  if (!s) return err(res, 404, "Subject not found.");
  const b = req.body || {};
  const sets = [];
  const vals = [];
  const fieldMap = {
    name_en: ["name_en", 120], name_ar: ["name_ar", 120], subject_code: ["subject_code", 60],
    description: ["description", 5000], academic_level: ["academic_level", 80], category: ["category", 80],
  };
  for (const [key, [column, max]] of Object.entries(fieldMap)) if (b[key] !== undefined) { sets.push(`${column} = ?`); vals.push(cleanStr(b[key], max)); }
  if (b.education_track !== undefined || b.educationTrack !== undefined) { sets.push("education_track = ?"); vals.push(subjectTrack(b.education_track || b.educationTrack)); }
  if (b.status !== undefined || b.is_active !== undefined) {
    const status = subjectStatus(b.status, b.is_active ? "active" : "inactive");
    sets.push("status = ?", "is_active = ?", status === "archived" ? "archived_at = CURRENT_TIMESTAMP" : "archived_at = NULL"); vals.push(status, status === "active" ? 1 : 0);
  }
  for (const [key, column] of [["session_id", "session_id"], ["term_id", "term_id"]]) if (b[key] !== undefined || b[key.replace("_id", "Id")] !== undefined) { sets.push(`${column} = ?`); vals.push(toNum(b[key] ?? b[key.replace("_id", "Id")], 0) || null); }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(s.id, m.id);
  await db.run(`UPDATE subjects SET ${sets.join(", ")} WHERE id = ? AND madrasa_id = ?`, vals);
  const updated = await db.get("SELECT * FROM subjects WHERE id = ? AND madrasa_id = ?", [s.id, m.id]);
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "subject.update", entity: "subject", entityId: String(s.id), ip: req.ip });
  ok(res, { ok: true, subject: updated });
}));

rootRouter.delete("/subjects/:id", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const s = await db.get("SELECT * FROM subjects WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
  if (!s) return err(res, 404, "Subject not found.");
  const used = await db.get("SELECT COUNT(*) AS n FROM results WHERE subject_id = ? AND madrasa_id = ?", [s.id, m.id]);
  if (Number(used.n) > 0) return err(res, 400, "This subject has result records. Archive or deactivate it instead of deleting.");
  try {
    await db.transaction(async (tx) => {
      await tx.run("DELETE FROM timetable_slots WHERE subject_id = ? AND madrasa_id = ?", [s.id, m.id]);
      await tx.run("DELETE FROM homework WHERE subject_id = ? AND madrasa_id = ?", [s.id, m.id]);
      await tx.run("DELETE FROM exams WHERE subject_id = ? AND madrasa_id = ?", [s.id, m.id]);
      await tx.run("DELETE FROM teacher_assignments WHERE subject_id = ? AND madrasa_id = ?", [s.id, m.id]);
      await tx.run("DELETE FROM class_subjects WHERE subject_id = ? AND madrasa_id = ?", [s.id, m.id]);
      await tx.run("DELETE FROM subjects WHERE id = ? AND madrasa_id = ?", [s.id, m.id]);
    });
  } catch (e) {
    // A user-facing validation error is preferable to the old opaque 500.
    return err(res, 409, "This subject is still in use. Archive it instead of deleting.");
  }
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "subject.delete", entity: "subject", entityId: String(s.id), ip: req.ip });
  ok(res, { ok: true, id: s.id });
}));

/* ------------------------------ sessions & terms ----------------------- */

rootRouter.get("/sessions", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const rows = await db.all("SELECT * FROM academic_sessions WHERE madrasa_id = ? ORDER BY id DESC", [m.id]);
  // Batched terms lookup (was one query per session — an N+1 on a hot,
  // every-page-load endpoint). Same rows, grouped here in memory.
  const termsBySession = new Map();
  if (rows.length) {
    const sm = rows.map(() => "?").join(",");
    const allTerms = await db.all(`SELECT * FROM terms WHERE madrasa_id = ? AND session_id IN (${sm}) ORDER BY position`, [m.id].concat(rows.map((r) => r.id)));
    for (const t of allTerms) {
      const sid = Number(t.session_id);
      if (!termsBySession.has(sid)) termsBySession.set(sid, []);
      termsBySession.get(sid).push(t);
    }
  }
  for (const r of rows) {
    r.terms = termsBySession.get(Number(r.id)) || [];
  }
  ok(res, { sessions: rows });
}));

rootRouter.post("/sessions", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const b = req.body || {};
  const label = cleanStr(b.label || b.name, 40); // e.g. "2026/2027"
  if (!/^\d{4}([/ -]\d{4})?$/.test(label)) return err(res, 400, "Session name should look like 2026/2027.");
  const startDate = b.start_date ? validDate(b.start_date) : null;
  const endDate = b.end_date ? validDate(b.end_date) : null;
  if ((b.start_date && !startDate) || (b.end_date && !endDate)) return err(res, 400, "Session dates must use YYYY-MM-DD.");
  if (startDate && endDate && endDate < startDate) return err(res, 400, "Session end date cannot be before its start date.");
  const status = ["upcoming", "active", "completed", "archived"].includes(cleanStr(b.status, 20).toLowerCase()) ? cleanStr(b.status, 20).toLowerCase() : "upcoming";
  const dup = await db.get("SELECT id FROM academic_sessions WHERE madrasa_id = ? AND label = ?", [m.id, label]);
  if (dup) return err(res, 400, "That session already exists.");
  let id;
  await db.transaction(async (tx) => {
    if (status === "active") await tx.run("UPDATE academic_sessions SET is_current=0,status=CASE WHEN status='active' THEN 'completed' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=?", [m.id]);
    const r = await tx.run(
      "INSERT INTO academic_sessions (madrasa_id,label,start_date,end_date,is_current,status,updated_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
      [m.id, label, startDate, endDate, status === "active" ? 1 : 0, status]
    );
    id = r.lastInsertRowid;
    if (status === "active") await tx.run("UPDATE terms SET is_current=0,status=CASE WHEN status='active' THEN 'completed' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=? AND session_id<>?", [m.id, id]);
    if (b.create_default_terms !== false) {
      const defaults = [["First Term", "الفترة الأولى"], ["Second Term", "الفترة الثانية"], ["Third Term", "الفترة الثالثة"]];
      for (let i = 0; i < defaults.length; i++) await tx.run("INSERT INTO terms (madrasa_id,session_id,position,name_en,name_ar,status) VALUES (?,?,?,?,?,'upcoming')", [m.id, id, i + 1, defaults[i][0], defaults[i][1]]);
    }
    await tx.run("INSERT INTO academic_period_history (madrasa_id,entity_type,entity_id,action,from_status,to_status,note,changed_by) VALUES (?,'session',?,'created',NULL,?,?,?)", [m.id, id, status, cleanStr(b.note, 2000), req.user.id]);
  });
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "session.create", entity: "session", entityId: String(id), ip: req.ip });
  ok(res, { ok: true, id });
}));

rootRouter.patch("/sessions/:id", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const s = await db.get("SELECT * FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
  if (!s) return res.status(404).json({ error: "Session not found." });
  const b = req.body || {}; const sets = []; const vals = [];
  if (b.label !== undefined || b.name !== undefined) { const label = cleanStr(b.label || b.name, 40); if (!/^\d{4}([/ -]\d{4})?$/.test(label)) return err(res, 400, "Session name should look like 2026/2027."); const dup = await db.get("SELECT id FROM academic_sessions WHERE madrasa_id=? AND label=? AND id<>?", [m.id, label, s.id]); if (dup) return err(res, 400, "That session already exists."); sets.push("label=?"); vals.push(label); }
  let startDate = s.start_date ? String(s.start_date).slice(0, 10) : null; let endDate = s.end_date ? String(s.end_date).slice(0, 10) : null;
  for (const [field, setter] of [["start_date", (v) => { startDate = v; }], ["end_date", (v) => { endDate = v; }]]) if (b[field] !== undefined) { const date = b[field] ? validDate(b[field]) : null; if (b[field] && !date) return err(res, 400, "Session dates must use YYYY-MM-DD."); setter(date); sets.push(`${field}=?`); vals.push(date); }
  if (startDate && endDate && endDate < startDate) return err(res, 400, "Session end date cannot be before its start date.");
  let status = s.status || (Number(s.is_current) === 1 ? "active" : "upcoming");
  if (b.status !== undefined) { const next = cleanStr(b.status, 20).toLowerCase(); if (!["upcoming", "active", "completed", "archived"].includes(next)) return err(res, 400, "Invalid session status."); status = next; sets.push("status=?"); vals.push(status); sets.push("archived_at=?"); vals.push(status === "archived" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null); }
  const makeCurrent = b.is_current === true || status === "active";
  if (!sets.length && b.is_current === undefined) return err(res, 400, "Nothing to update.");
  await db.transaction(async (tx) => {
    if (makeCurrent) {
      await tx.run("UPDATE academic_sessions SET is_current=0,status=CASE WHEN status='active' THEN 'completed' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=? AND id<>?", [m.id, s.id]);
      await tx.run("UPDATE terms SET is_current=0,status=CASE WHEN status='active' THEN 'completed' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=? AND session_id<>?", [m.id, s.id]);
    }
    if (b.is_current !== undefined || b.status !== undefined) { sets.push("is_current=?"); vals.push(makeCurrent ? 1 : 0); }
    sets.push("updated_at=CURRENT_TIMESTAMP"); vals.push(s.id, m.id);
    await tx.run(`UPDATE academic_sessions SET ${sets.join(",")} WHERE id=? AND madrasa_id=?`, vals);
    await tx.run("INSERT INTO academic_period_history (madrasa_id,entity_type,entity_id,action,from_status,to_status,note,changed_by) VALUES (?,'session',?,'updated',?,?,?,?)", [m.id, s.id, s.status || null, status, cleanStr(b.note, 2000), req.user.id]);
  });
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "session.update", entity: "session", entityId: String(s.id), ip: req.ip });
  ok(res, { ok: true, session: await db.get("SELECT * FROM academic_sessions WHERE id=? AND madrasa_id=?", [s.id, m.id]) });
}));

rootRouter.post("/sessions/:id/terms", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const s = await db.get("SELECT * FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
  if (!s) return res.status(404).json({ error: "Session not found." });
  const b = req.body || {};
  const pos = toNum(b.position, 0);
  const nameEn = cleanStr(b.name_en, 60);
  if (!pos || !nameEn) return err(res, 400, "position and name_en are required.");
  const dup = await db.get("SELECT id FROM terms WHERE madrasa_id = ? AND session_id = ? AND position = ?", [m.id, s.id, pos]);
  if (dup) return err(res, 400, "A term with this position already exists.");
  const startDate = b.start_date ? validDate(b.start_date) : null; const endDate = b.end_date ? validDate(b.end_date) : null; const deadline = b.result_submission_deadline ? validDate(b.result_submission_deadline) : null;
  if ((b.start_date && !startDate) || (b.end_date && !endDate) || (b.result_submission_deadline && !deadline)) return err(res, 400, "Term dates must use YYYY-MM-DD.");
  if (startDate && endDate && endDate < startDate) return err(res, 400, "Term end date cannot be before its start date.");
  const status = ["upcoming", "active", "completed", "closed"].includes(cleanStr(b.status, 20).toLowerCase()) ? cleanStr(b.status, 20).toLowerCase() : "upcoming";
  let id;
  await db.transaction(async (tx) => {
    if (status === "active") {
      await tx.run("UPDATE terms SET is_current=0,status=CASE WHEN status='active' THEN 'completed' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=?", [m.id]);
      await tx.run("UPDATE academic_sessions SET is_current=0,status=CASE WHEN status='active' THEN 'completed' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=? AND id<>?", [m.id, s.id]);
      await tx.run("UPDATE academic_sessions SET is_current=1,status='active',updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [s.id, m.id]);
    }
    const r = await tx.run(
      "INSERT INTO terms (madrasa_id,session_id,position,name_en,name_ar,start_date,end_date,result_submission_deadline,status,is_current,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)",
      [m.id, s.id, pos, nameEn, cleanStr(b.name_ar, 60), startDate, endDate, deadline, status, status === "active" ? 1 : 0]
    );
    id = r.lastInsertRowid;
    await tx.run("INSERT INTO academic_period_history (madrasa_id,entity_type,entity_id,action,from_status,to_status,note,changed_by) VALUES (?,'term',?,'created',NULL,?,?,?)", [m.id, id, status, cleanStr(b.note, 2000), req.user.id]);
  });
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "term.create", entity: "term", entityId: String(id), ip: req.ip });
  ok(res, { ok: true, id });
}));

/* Update a term's names and dates. Term position is deliberately immutable
 * once results exist; create a new ordered term instead of changing history. */
rootRouter.patch("/terms/:id", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const term = await db.get("SELECT * FROM terms WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
  if (!term) return res.status(404).json({ error: "Term not found." });
  const b = req.body || {};
  const sets = []; const vals = [];
  if (b.name_en !== undefined) { const name = cleanStr(b.name_en, 60); if (!name) return err(res, 400, "English term name is required."); sets.push("name_en = ?"); vals.push(name); }
  if (b.name_ar !== undefined) { sets.push("name_ar = ?"); vals.push(cleanStr(b.name_ar, 60)); }
  let startDate = term.start_date ? String(term.start_date).slice(0, 10) : null; let endDate = term.end_date ? String(term.end_date).slice(0, 10) : null;
  for (const field of ["start_date", "end_date", "result_submission_deadline"]) if (b[field] !== undefined) { const date = b[field] ? validDate(b[field]) : null; if (b[field] && !date) return err(res, 400, "Term dates must use YYYY-MM-DD."); if (field === "start_date") startDate = date; if (field === "end_date") endDate = date; sets.push(`${field}=?`); vals.push(date); }
  if (startDate && endDate && endDate < startDate) return err(res, 400, "Term end date cannot be before its start date.");
  let status = term.status || (Number(term.is_current) === 1 ? "active" : "upcoming");
  if (b.status !== undefined) { const next = cleanStr(b.status, 20).toLowerCase(); if (!["upcoming", "active", "completed", "closed"].includes(next)) return err(res, 400, "Invalid term status."); status = next; sets.push("status=?"); vals.push(status); }
  const makeCurrent = b.is_current === true || status === "active";
  if (!sets.length && b.is_current === undefined) return err(res, 400, "Nothing to update.");
  await db.transaction(async (tx) => {
    if (makeCurrent) {
      await tx.run("UPDATE terms SET is_current=0,status=CASE WHEN status='active' THEN 'completed' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=? AND id<>?", [m.id, term.id]);
      await tx.run("UPDATE academic_sessions SET is_current=0,status=CASE WHEN status='active' THEN 'completed' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=? AND id<>?", [m.id, term.session_id]);
      await tx.run("UPDATE academic_sessions SET is_current=1,status='active',updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [term.session_id, m.id]);
    }
    if (b.is_current !== undefined || b.status !== undefined) { sets.push("is_current=?"); vals.push(makeCurrent ? 1 : 0); }
    sets.push("updated_at=CURRENT_TIMESTAMP"); vals.push(term.id, m.id);
    await tx.run(`UPDATE terms SET ${sets.join(",")} WHERE id=? AND madrasa_id=?`, vals);
    await tx.run("INSERT INTO academic_period_history (madrasa_id,entity_type,entity_id,action,from_status,to_status,note,changed_by) VALUES (?,'term',?,'updated',?,?,?,?)", [m.id, term.id, term.status || null, status, cleanStr(b.note, 2000), req.user.id]);
  });
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "term.update", entity: "term", entityId: String(term.id), ip: req.ip });
  ok(res, { ok: true, term: await db.get("SELECT * FROM terms WHERE id=? AND madrasa_id=?", [term.id, m.id]) });
}));

rootRouter.get("/sessions/:id/history", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res); if (!m) return;
  const id = toNum(req.params.id, 0); if (!await db.get("SELECT id FROM academic_sessions WHERE id=? AND madrasa_id=?", [id, m.id])) return err(res, 404, "Session not found.");
  const history = await db.all("SELECT h.*,u.full_name AS changed_by_name FROM academic_period_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.madrasa_id=? AND h.entity_type='session' AND h.entity_id=? ORDER BY h.id DESC", [m.id, id]);
  ok(res, { history });
}));
rootRouter.get("/terms/:id/history", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res); if (!m) return;
  const id = toNum(req.params.id, 0); if (!await db.get("SELECT id FROM terms WHERE id=? AND madrasa_id=?", [id, m.id])) return err(res, 404, "Term not found.");
  const history = await db.all("SELECT h.*,u.full_name AS changed_by_name FROM academic_period_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.madrasa_id=? AND h.entity_type='term' AND h.entity_id=? ORDER BY h.id DESC", [m.id, id]);
  ok(res, { history });
}));

/* ------------------------------ grading config ------------------------- */

rootRouter.get("/grading", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const cfg = await grading.getGradingConfig(m.id);
  ok(res, {
    caMax: cfg.caMax,
    examMax: cfg.examMax,
    passMark: cfg.passMark,
    promotionMinAverage: cfg.promotionMinAverage,
    promotionRequirePass: cfg.promotionRequirePass,
    bands: cfg.bands,
  });
}));

rootRouter.put("/grading", requireAuth, requireTenant, adminOrSupport, asyncHandler(async (req, res) => {
  const m = await resolveMadrasa(req, res);
  if (!m) return;
  const b = req.body || {};
  const existing = await db.get("SELECT id FROM grading_config WHERE madrasa_id = ?", [m.id]);
  const caMax = clampNum(b.ca_max, 1, 100, 40);
  const examMax = clampNum(b.exam_max, 1, 100, 60);
  const passMark = clampNum(b.pass_mark, 0, 100, 50);
  const promoAvg = b.promotion_min_average === null || b.promotion_min_average === "" ? null : clampNum(b.promotion_min_average, 0, 100, 50);
  const requirePass = b.promotion_require_pass === undefined ? 1 : (b.promotion_require_pass ? 1 : 0);
  let bands = grading.DEFAULT_BANDS;
  if (Array.isArray(b.bands) && b.bands.length) {
    bands = b.bands
      .filter((x) => x && x.grade)
      .map((x) => ({
        min: clampNum(x.min, 0, 100, 0),
        grade: cleanStr(x.grade, 5),
        point: clampNum(x.point, 0, 20, 0),
        remark: cleanStr(x.remark, 60),
        remark_ar: cleanStr(x.remark_ar, 60),
      }))
      .sort((a, z) => z.min - a.min);
  }
  if (existing) {
    await db.run(
      "UPDATE grading_config SET ca_max=?, exam_max=?, pass_mark=?, promotion_min_average=?, promotion_require_pass=?, grade_bands=? WHERE madrasa_id=?",
      [caMax, examMax, passMark, promoAvg, requirePass, JSON.stringify(bands), m.id]
    );
  } else {
    await db.run(
      "INSERT INTO grading_config (madrasa_id, ca_max, exam_max, pass_mark, promotion_min_average, promotion_require_pass, grade_bands) VALUES (?,?,?,?,?,?,?)",
      [m.id, caMax, examMax, passMark, promoAvg, requirePass, JSON.stringify(bands)]
    );
  }
  logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "grading.update", entity: "grading", entityId: String(m.id), ip: req.ip });
  ok(res, { ok: true });
}));

// resolveMadrasa/adminOrSupport are exported so the My Institution router
// (routes/institution.js) enforces tenancy through exactly the same code path
// instead of re-implementing it.
module.exports = { router, rootRouter, resolveMadrasa, adminOrSupport };
