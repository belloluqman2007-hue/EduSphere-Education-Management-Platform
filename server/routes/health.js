"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — Student Health & Medical module
   ----------------------------------------------------------------------------
   Tenant-scoped medical records for students, shared unchanged by BOTH
   institution categories (Islamic School and Western Academy): the same
   tables, routes and screens serve each tenant — health vocabulary is
   category-neutral, so no labels are branched here.

     GET    /api/health/students/:studentId                (admin + teacher)
     PATCH  /api/health/students/:studentId                (admin only)
     GET    /api/health/students/:studentId/visits         (admin + teacher)
     POST   /api/health/students/:studentId/visits         (admin only)
     DELETE /api/health/visits/:id                         (admin only, soft)
     GET    /api/health/students/:studentId/vaccinations   (admin + teacher)
     POST   /api/health/students/:studentId/vaccinations   (admin only)
     GET    /api/health/reports/allergies                  (admin + teacher)
     GET    /api/health/reports/upcoming-vaccines          (admin + teacher)
     GET    /api/health/export.csv                         (admin only)

   Conventions (identical to the students/library modules):
     • every query filters on madrasa_id resolved from the session — a
       client-supplied tenant id is never trusted;
     • teachers are limited to students of their assigned classes;
     • medical data is SENSITIVE: it is never part of /api/exports/students.csv
       and has its own export above with an explicit admin permission check.
   ========================================================================== */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, validDate, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments } = require("../middleware/tenant");
const { requireFeature } = require("../middleware/subscription");
const csv = require("../services/csv");

const router = express.Router();
router.use(requireAuth, requireTenant);
// Student health records are part of the Premium "Academics" bundle.
router.use(requireFeature("health"));

const STAFF = requireRole("madrasa_admin", "teacher", "super_admin");
const ADMIN = requireRole("madrasa_admin");

const BLOOD_GROUPS = new Set(["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);
const GENOTYPES = new Set(["", "AA", "AS", "AC", "SS", "SC", "CC"]);

function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { err(res, 400, "Madrasa context required."); return null; }
  return tid;
}
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function iso(v) { return validDate(v) || null; }
function asBool(v) { return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true"; }

/** Loads a student of THIS tenant, or sends 404. */
async function loadStudent(req, res, tid, studentId) {
  const sid = toNum(studentId, 0);
  const student = await db.get(
    "SELECT id, class_id, first_name, last_name, admission_no, student_code, status FROM students WHERE id = ? AND madrasa_id = ?",
    [sid, tid]
  );
  if (!student) { err(res, 404, "Student not found."); return null; }
  // Teachers may only reach students of the classes they are assigned to
  // (same scope rule as GET /api/students/:id).
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!scope.anyClassAnySubject && (!student.class_id || !scope.assignedClassIds.has(Number(student.class_id)))) {
      err(res, 404, "Student not found.");
      return null;
    }
  }
  return student;
}

/** For teachers: restrict a school-wide report to their assigned classes. Returns null (unrestricted) or a class-id array. */
async function teacherClassScope(req, tid) {
  if (req.user.role !== "teacher") return null;
  const scope = await getTeacherAssignments(tid, req.user.id);
  if (scope.anyClassAnySubject) return null;
  return [...scope.assignedClassIds];
}

/* --------------------------- medical profile ---------------------------- */

router.get("/students/:studentId", STAFF, asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  const student = await loadStudent(req, res, tid, req.params.studentId); if (!student) return;
  const health = await db.get("SELECT * FROM student_health WHERE madrasa_id = ? AND student_id = ?", [tid, student.id]);
  ok(res, { health: health || null, hasProfile: !!health });
}));

router.patch("/students/:studentId", ADMIN, asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  const student = await loadStudent(req, res, tid, req.params.studentId); if (!student) return;
  const b = req.body || {};
  const blood = cleanStr(b.blood_group, 8);
  const genotype = cleanStr(b.genotype, 8);
  if (!BLOOD_GROUPS.has(blood)) return err(res, 400, "Unknown blood group.");
  if (!GENOTYPES.has(genotype)) return err(res, 400, "Unknown genotype.");
  const values = {
    blood_group: blood,
    genotype,
    allergies: cleanStr(b.allergies, 2000),
    chronic_conditions: cleanStr(b.chronic_conditions, 2000),
    disabilities: cleanStr(b.disabilities, 2000),
    vision_notes: cleanStr(b.vision_notes, 1000),
    hearing_notes: cleanStr(b.hearing_notes, 1000),
    dietary_restrictions: cleanStr(b.dietary_restrictions, 1000),
    emergency_medication: cleanStr(b.emergency_medication, 2000),
  };
  const existing = await db.get("SELECT id FROM student_health WHERE madrasa_id = ? AND student_id = ?", [tid, student.id]);
  if (existing) {
    await db.run(
      `UPDATE student_health SET blood_group=?, genotype=?, allergies=?, chronic_conditions=?, disabilities=?,
        vision_notes=?, hearing_notes=?, dietary_restrictions=?, emergency_medication=?, last_updated=CURRENT_TIMESTAMP
       WHERE madrasa_id = ? AND student_id = ?`,
      [values.blood_group, values.genotype, values.allergies, values.chronic_conditions, values.disabilities,
        values.vision_notes, values.hearing_notes, values.dietary_restrictions, values.emergency_medication, tid, student.id]
    );
  } else {
    await db.run(
      `INSERT INTO student_health (madrasa_id, student_id, blood_group, genotype, allergies, chronic_conditions, disabilities,
        vision_notes, hearing_notes, dietary_restrictions, emergency_medication)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [tid, student.id, values.blood_group, values.genotype, values.allergies, values.chronic_conditions, values.disabilities,
        values.vision_notes, values.hearing_notes, values.dietary_restrictions, values.emergency_medication]
    );
  }
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "health.profile.update", entity: "student_health", entityId: String(student.id), ip: req.ip });
  const health = await db.get("SELECT * FROM student_health WHERE madrasa_id = ? AND student_id = ?", [tid, student.id]);
  ok(res, { ok: true, health });
}));

/* ---------------------------- sick-bay visits --------------------------- */

router.get("/students/:studentId/visits", STAFF, asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  const student = await loadStudent(req, res, tid, req.params.studentId); if (!student) return;
  const visits = await db.all(
    "SELECT * FROM health_visits WHERE madrasa_id = ? AND student_id = ? AND is_deleted = 0 ORDER BY visit_date DESC, id DESC LIMIT 200",
    [tid, student.id]
  );
  ok(res, { visits });
}));

router.post("/students/:studentId/visits", ADMIN, asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  const student = await loadStudent(req, res, tid, req.params.studentId); if (!student) return;
  const b = req.body || {};
  // Absent date defaults to today; a supplied-but-invalid date is rejected.
  const rawDate = b.visit_date === undefined || b.visit_date === null || String(b.visit_date).trim() === "";
  const visitDate = rawDate ? today() : iso(b.visit_date);
  if (!visitDate) return err(res, 400, "A valid visit date is required.");
  const complaint = cleanStr(b.complaint, 500);
  if (!complaint) return err(res, 400, "Complaint is required.");
  const referred = asBool(b.referred_out);
  const r = await db.run(
    `INSERT INTO health_visits (madrasa_id, student_id, visit_date, complaint, diagnosis, treatment, referred_out, referral_notes, attended_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [tid, student.id, visitDate, complaint, cleanStr(b.diagnosis, 500), cleanStr(b.treatment, 2000),
      referred ? 1 : 0, cleanStr(b.referral_notes, 500), cleanStr(b.attended_by, 160) || cleanStr(req.user.fullName, 160)]
  );
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "health.visit.create", entity: "health_visit", entityId: String(r.lastInsertRowid), ip: req.ip });
  ok(res, { ok: true, id: Number(r.lastInsertRowid) });
}));

router.delete("/visits/:id", ADMIN, asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  const id = toNum(req.params.id, 0);
  const r = await db.run(
    "UPDATE health_visits SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ? AND is_deleted = 0",
    [id, tid]
  );
  if (!r.changes) return err(res, 404, "Visit not found.");
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "health.visit.delete", entity: "health_visit", entityId: String(id), ip: req.ip });
  ok(res, { ok: true, deleted: true });
}));

/* ----------------------------- vaccinations ----------------------------- */

router.get("/students/:studentId/vaccinations", STAFF, asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  const student = await loadStudent(req, res, tid, req.params.studentId); if (!student) return;
  const vaccinations = await db.all(
    "SELECT * FROM vaccinations WHERE madrasa_id = ? AND student_id = ? ORDER BY date_given DESC, id DESC LIMIT 200",
    [tid, student.id]
  );
  ok(res, { vaccinations });
}));

router.post("/students/:studentId/vaccinations", ADMIN, asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  const student = await loadStudent(req, res, tid, req.params.studentId); if (!student) return;
  const b = req.body || {};
  const name = cleanStr(b.vaccine_name, 160);
  if (!name) return err(res, 400, "Vaccine name is required.");
  const dateGiven = iso(b.date_given);
  if (!dateGiven) return err(res, 400, "A valid date given is required.");
  const nextDue = iso(b.next_due);
  if (nextDue && nextDue < dateGiven) return err(res, 400, "Next due date cannot precede the date given.");
  const r = await db.run(
    `INSERT INTO vaccinations (madrasa_id, student_id, vaccine_name, dose, date_given, next_due, administered_by, notes)
     VALUES (?,?,?,?,?,?,?,?)`,
    [tid, student.id, name, cleanStr(b.dose, 60), dateGiven, nextDue, cleanStr(b.administered_by, 160), cleanStr(b.notes, 2000)]
  );
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "health.vaccination.create", entity: "vaccination", entityId: String(r.lastInsertRowid), ip: req.ip });
  ok(res, { ok: true, id: Number(r.lastInsertRowid) });
}));

/* -------------------------------- reports ------------------------------- */

// Students with known allergies — for canteen menus and trip planning.
router.get("/reports/allergies", STAFF, asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  const classIds = await teacherClassScope(req, tid);
  const where = ["h.madrasa_id = ?", "TRIM(COALESCE(h.allergies, '')) <> ''"];
  const params = [tid];
  if (classIds) {
    if (!classIds.length) return ok(res, { students: [] });
    where.push(`s.class_id IN (${classIds.map(() => "?").join(",")})`);
    params.push(...classIds);
  }
  const students = await db.all(
    `SELECT h.student_id, h.allergies, h.dietary_restrictions, h.emergency_medication,
            s.admission_no, s.first_name, s.last_name, s.status, c.name_en AS class_en
     FROM student_health h
     JOIN students s ON s.id = h.student_id AND s.madrasa_id = h.madrasa_id
     LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = h.madrasa_id
     WHERE ${where.join(" AND ")}
     ORDER BY c.sort_order, s.last_name, s.first_name`,
    params
  );
  ok(res, { students });
}));

// Vaccinations whose next dose falls within the next 30 days.
router.get("/reports/upcoming-vaccines", STAFF, asyncHandler(async (req, res) => {
  const tid = tenantId(req, res); if (!tid) return;
  const classIds = await teacherClassScope(req, tid);
  const from = today();
  const to = addDays(from, 30);
  const where = ["v.madrasa_id = ?", "v.next_due IS NOT NULL", "v.next_due >= ?", "v.next_due <= ?"];
  const params = [tid, from, to];
  if (classIds) {
    if (!classIds.length) return ok(res, { vaccinations: [] });
    where.push(`s.class_id IN (${classIds.map(() => "?").join(",")})`);
    params.push(...classIds);
  }
  const vaccinations = await db.all(
    `SELECT v.*, s.admission_no, s.first_name, s.last_name, s.parent_name, s.parent_phone, c.name_en AS class_en
     FROM vaccinations v
     JOIN students s ON s.id = v.student_id AND s.madrasa_id = v.madrasa_id
     LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id
     WHERE ${where.join(" AND ")}
     ORDER BY v.next_due, s.last_name, s.first_name`,
    params
  );
  ok(res, { vaccinations, from, to });
}));

/* --------------------------- sensitive CSV export ----------------------- */
// Deliberately SEPARATE from /api/exports/students.csv (which never includes
// medical data). Explicit admin permission check: madrasa admins export their
// own tenant; the platform super admin must name the tenant with ?madrasaId.
router.get("/export.csv", asyncHandler(async (req, res) => {
  if (!req.user || (req.user.role !== "madrasa_admin" && req.user.role !== "super_admin")) {
    return err(res, 403, "Only administrators may export medical records.");
  }
  const tid = tenantId(req, res); if (!tid) return;
  const rows = await db.all(
    `SELECT h.*, s.admission_no, s.first_name, s.last_name, c.name_en AS class_en
     FROM student_health h
     JOIN students s ON s.id = h.student_id AND s.madrasa_id = h.madrasa_id
     LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id
     WHERE h.madrasa_id = ?
     ORDER BY c.sort_order, s.last_name, s.first_name`,
    [tid]
  );
  csv.sendCsv(res, `student-health-${today()}.csv`, csv.toCsv(rows, [
    { label: "Admission No", key: "admission_no" },
    { label: "First Name", key: "first_name" },
    { label: "Last Name", key: "last_name" },
    { label: "Class", key: "class_en" },
    { label: "Blood Group", key: "blood_group" },
    { label: "Genotype", key: "genotype" },
    { label: "Allergies", key: "allergies" },
    { label: "Chronic Conditions", key: "chronic_conditions" },
    { label: "Disabilities", key: "disabilities" },
    { label: "Vision", key: "vision_notes" },
    { label: "Hearing", key: "hearing_notes" },
    { label: "Dietary Restrictions", key: "dietary_restrictions" },
    { label: "Emergency Medication", key: "emergency_medication" },
    { label: "Last Updated", value: (r) => String(r.last_updated || "").slice(0, 10) },
  ]));
}));

module.exports = router;
