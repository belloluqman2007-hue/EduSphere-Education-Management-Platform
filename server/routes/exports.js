"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — CSV exports (Excel / Google Sheets / backup of a
   term's records)
   ----------------------------------------------------------------------------
   All exports are tenant-scoped exactly like the screens they come from: a
   madrasa admin gets their own rows, a teacher only rows of classes assigned
   to them, and a super admin must name the tenant with ?madrasaId=.

     GET /api/exports/students.csv?classId=&status=
     GET /api/exports/results.csv?classId=&termId=
     GET /api/exports/summary.csv?classId=&termId=
     GET /api/exports/attendance.csv?classId=&from=&to=
     GET /api/exports/fees.csv?termId=&classId=
     GET /api/exports/admissions.csv?status=            (admins only)
   ========================================================================== */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, toNum, cleanStr } = require("../util");
const { requireAuth, requireRole } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments } = require("../middleware/tenant");
const { requireFeature } = require("../middleware/subscription");
const csv = require("../services/csv");
const { requireStaffPermission } = require("../services/permissions");

const router = express.Router();
router.use(requireAuth);
// CSV exports are the Basic plan's "attendance analytics & exports". Bulk runs
// (whole-class report sheets, audit exports) are gated separately as
// `exports_bulk` on the routes that produce them.
router.use(requireFeature("exports"));

const STAFF = requireRole("madrasa_admin", "teacher", "super_admin");
const ADMINS = requireRole("madrasa_admin", "super_admin");

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required (super admin: ?madrasaId=N)." }); return null; }
  return tid;
}

/** For teachers: the class ids they may export, or null when unrestricted. */
async function teacherClassFilter(req, tid, requestedClassId) {
  if (req.user.role !== "teacher") return requestedClassId ? [requestedClassId] : null;
  const scope = await getTeacherAssignments(tid, req.user.id);
  if (scope.anyClassAnySubject) return requestedClassId ? [requestedClassId] : null;
  const assigned = [...scope.assignedClassIds];
  return requestedClassId ? assigned.filter((c) => c === requestedClassId) : assigned;
}

function inClause(ids) {
  return ids.map(() => "?").join(",");
}

function filename(req, kind) {
  const d = new Date().toISOString().slice(0, 10);
  return `${kind}-${d}.csv`;
}

/* ------------------------------ students -------------------------------- */

router.get("/students.csv", STAFF, requireStaffPermission("students.export"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const classIds = await teacherClassFilter(req, tid, toNum(req.query.classId, 0) || null);
  if (classIds && !classIds.length) return csv.sendCsv(res, filename(req, "students"), csv.toCsv([], []));
  const where = ["s.madrasa_id = ?"];
  const params = [tid];
  if (classIds) { where.push(`s.class_id IN (${inClause(classIds)})`); params.push(...classIds); }
  if (req.query.status) { where.push("s.status = ?"); params.push(cleanStr(req.query.status, 20)); }
  if (req.query.gender) { where.push("s.gender = ?"); params.push(cleanStr(req.query.gender, 10)); }
  if (req.query.sessionId) { where.push("s.session_id = ?"); params.push(toNum(req.query.sessionId, 0)); }
  if (req.query.program) { where.push("s.program = ?"); params.push(cleanStr(req.query.program, 120)); }
  if (req.query.education_track) { where.push("s.education_track = ?"); params.push(cleanStr(req.query.education_track, 20)); }
  if (req.query.section) { where.push("s.section = ?"); params.push(cleanStr(req.query.section, 80)); }
  if (req.query.search) { const q = `%${cleanStr(req.query.search, 100).toLowerCase()}%`; where.push("(LOWER(s.first_name) LIKE ? OR LOWER(s.last_name) LIKE ? OR LOWER(s.admission_no) LIKE ? OR LOWER(s.student_code) LIKE ? OR LOWER(s.parent_name) LIKE ?)"); params.push(q, q, q, q, q); }

  const rows = await db.all(
    `SELECT s.*, c.name_en AS class_en, s2.label AS session_label,
            (SELECT SUM(p.amount_ngn) FROM fee_payments p WHERE p.student_id = s.id AND p.madrasa_id = s.madrasa_id) AS paid
     FROM students s
     LEFT JOIN classes c ON c.id = s.class_id
     LEFT JOIN academic_sessions s2 ON s2.id = s.session_id
     WHERE ${where.join(" AND ")} ORDER BY c.sort_order, s.admission_no`,
    params
  );
  const age = (dob) => {
    if (!dob) return "";
    const b = new Date(String(dob).slice(0, 10));
    if (Number.isNaN(b.getTime())) return "";
    const now = new Date();
    let a = now.getFullYear() - b.getFullYear();
    if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a--;
    return a;
  };
  csv.sendCsv(res, filename(req, "students"), csv.toCsv(rows, [
    { label: "Admission No", key: "admission_no" },
    { label: "First Name", key: "first_name" },
    { label: "Last Name", key: "last_name" },
    { label: "Student ID", key: "student_code" },
    { label: "Middle Name", key: "middle_name" },
    { label: "Arabic Name", key: "name_ar" },
    { label: "Gender", key: "gender" },
    { label: "Date of Birth", key: "date_of_birth" },
    { label: "Age", value: (r) => age(r.date_of_birth) },
    { label: "Class", key: "class_en" },
    { label: "Section", key: "section" },
    { label: "Session", key: "session_label" },
    { label: "Program", key: "program" },
    { label: "Education Track", key: "education_track" },
    { label: "Islamic Program", key: "islamic_program" },
    { label: "Western Program", key: "western_program" },
    { label: "Status", key: "status" },
    { label: "Parent/Guardian", key: "parent_name" },
    { label: "Parent Phone", key: "parent_phone" },
    { label: "Alternative Phone", key: "alternative_phone" },
    { label: "Parent Email", key: "parent_email" },
    { label: "Fees Paid (₦)", value: (r) => csv.num(r.paid || 0, 0) },
    { label: "Address", key: "address" },
    { label: "Enrolled On", value: (r) => String(r.created_at || "").slice(0, 10) },
  ]));
}));

/* -------------------------- student group members ----------------------- */
router.get("/student-groups/:id.csv", ADMINS, requireStaffPermission("students.export"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const group = await db.get("SELECT id, name FROM student_groups WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!group) return err(res, 404, "Student group not found.");
  const rows = await db.all(`SELECT s.*, c.name_en AS class_en, ss.label AS session_label FROM student_group_members gm JOIN students s ON s.id = gm.student_id AND s.madrasa_id = gm.madrasa_id LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN academic_sessions ss ON ss.id = s.session_id WHERE gm.group_id = ? AND gm.madrasa_id = ? ORDER BY s.last_name, s.first_name`, [group.id, tid]);
  csv.sendCsv(res, filename(req, "student-group"), csv.toCsv(rows, [
    { label: "Admission No", key: "admission_no" }, { label: "Student ID", key: "student_code" },
    { label: "Student", value: (r) => `${r.first_name} ${r.last_name}`.trim() }, { label: "Gender", key: "gender" },
    { label: "Class", key: "class_en" }, { label: "Session", key: "session_label" }, { label: "Status", key: "status" },
    { label: "Parent / Guardian", key: "parent_name" }, { label: "Phone", key: "parent_phone" },
  ]));
}));

/* ------------------------------ results -------------------------------- */

router.get("/results.csv", STAFF, requireStaffPermission("report_cards.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const classId = toNum(req.query.classId, 0);
  const termId = toNum(req.query.termId, 0);
  if (!termId) return err(res, 400, "termId is required.");
  const classIds = await teacherClassFilter(req, tid, classId || null);
  if (classIds && !classIds.length) return csv.sendCsv(res, filename(req, "results"), csv.toCsv([], []));
  const where = ["r.madrasa_id = ?", "r.term_id = ?"];
  const params = [tid, termId];
  if (classId) { where.push("r.class_id = ?"); params.push(classId); }
  else if (classIds) { where.push(`r.class_id IN (${inClause(classIds)})`); params.push(...classIds); }
  const rows = await db.all(
    `SELECT r.*, s.admission_no, s.first_name, s.last_name, c.name_en AS class_en, su.name_en AS subject_en
     FROM results r
     JOIN students s ON s.id = r.student_id
     JOIN subjects su ON su.id = r.subject_id
     LEFT JOIN classes c ON c.id = r.class_id
     WHERE ${where.join(" AND ")} ORDER BY c.name_en, s.admission_no, su.name_en`,
    params
  );
  csv.sendCsv(res, filename(req, "results"), csv.toCsv(rows, [
    { label: "Class", key: "class_en" },
    { label: "Admission No", key: "admission_no" },
    { label: "Student", value: (r) => `${r.first_name} ${r.last_name}`.trim() },
    { label: "Subject", key: "subject_en" },
    { label: "CA", value: (r) => csv.num(r.ca) },
    { label: "Exam", value: (r) => csv.num(r.exam) },
    { label: "Total", value: (r) => csv.num(r.total) },
    { label: "Date Recorded", value: (r) => String(r.updated_at || r.created_at || "").slice(0, 10) },
  ]));
}));

/** One row per student per term: totals, average, position, promotion. */
router.get("/summary.csv", STAFF, requireStaffPermission("report_cards.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const classId = toNum(req.query.classId, 0);
  const termId = toNum(req.query.termId, 0);
  if (!termId) return err(res, 400, "termId is required.");
  const where = ["ts.madrasa_id = ?", "ts.term_id = ?"];
  const params = [tid, termId];
  if (classId) { where.push("ts.class_id = ?"); params.push(classId); }
  const rows = await db.all(
    `SELECT ts.*, s.admission_no, s.first_name, s.last_name, c.name_en AS class_en,
            t.name_en AS term_name, a.label AS session_label
     FROM term_summaries ts
     JOIN students s ON s.id = ts.student_id
     LEFT JOIN classes c ON c.id = ts.class_id
     LEFT JOIN terms t ON t.id = ts.term_id
     LEFT JOIN academic_sessions a ON a.id = ts.session_id
     WHERE ${where.join(" AND ")} ORDER BY ts.position IS NULL, ts.position, s.admission_no`,
     params
  );
  csv.sendCsv(res, filename(req, "term-summary"), csv.toCsv(rows, [
    { label: "Session", key: "session_label" },
    { label: "Term", key: "term_name" },
    { label: "Class", key: "class_en" },
    { label: "Admission No", key: "admission_no" },
    { label: "Student", value: (r) => `${r.first_name} ${r.last_name}`.trim() },
    { label: "Subjects", value: (r) => r.subject_count },
    { label: "Total", value: (r) => csv.num(r.total) },
    { label: "Average %", value: (r) => csv.num(r.average, 1) },
    { label: "Grade", key: "overall_grade" },
    { label: "Position", value: (r) => (r.position === null || r.position === undefined ? "" : r.position) },
    { label: "Attendance (days)", value: (r) => r.attendance_days },
    { label: "Promotion", key: "promotion_status" },
    { label: "Published", value: (r) => (r.published_at ? "yes" : "no") },
  ]));
}));

/* ------------------------------ attendance ------------------------------ */

router.get("/attendance.csv", STAFF, requireStaffPermission("students.export"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const classId = toNum(req.query.classId, 0);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || "")) ? String(req.query.from) : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || "")) ? String(req.query.to) : "";
  const where = ["a.madrasa_id = ?"];
  const params = [tid];
  if (classId) { where.push("a.class_id = ?"); params.push(classId); }
  if (req.query.sessionId) { where.push("a.session_id = ?"); params.push(toNum(req.query.sessionId, 0)); }
  if (req.query.termId) { where.push("a.term_id = ?"); params.push(toNum(req.query.termId, 0)); }
  if (req.query.educationTrack) { where.push("c.education_track = ?"); params.push(cleanStr(req.query.educationTrack, 20)); }
  if (req.query.program) { where.push("c.program LIKE ?"); params.push(`%${cleanStr(req.query.program, 120)}%`); }
  if (from) { where.push("a.day >= ?"); params.push(from); }
  if (to) { where.push("a.day <= ?"); params.push(to); }
  const rows = await db.all(
    `SELECT a.student_id, s.admission_no, s.first_name, s.last_name, c.name_en AS class_en,
            SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late,
            SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN a.status = 'excused' THEN 1 ELSE 0 END) AS excused,
            COUNT(*) AS days
     FROM attendance a
     JOIN students s ON s.id = a.student_id
     LEFT JOIN classes c ON c.id = a.class_id
     WHERE ${where.join(" AND ")}
     GROUP BY a.student_id, s.admission_no, s.first_name, s.last_name, c.name_en
     ORDER BY c.name_en, s.admission_no`,
    params
  );
  csv.sendCsv(res, filename(req, "attendance"), csv.toCsv(rows, [
    { label: "Class", key: "class_en" },
    { label: "Admission No", key: "admission_no" },
    { label: "Student", value: (r) => `${r.first_name} ${r.last_name}`.trim() },
    { label: "Days Present", value: (r) => Number(r.present) },
    { label: "Days Absent", value: (r) => Number(r.absent) },
    { label: "Late", value: (r) => Number(r.late) },
    { label: "Excused", value: (r) => Number(r.excused) },
    { label: "Sessions Recorded", value: (r) => Number(r.days) },
    { label: "Attendance %", value: (r) => (Number(r.days) ? csv.num(((Number(r.present) + Number(r.late)) / Number(r.days)) * 100, 1) : "") },
  ]));
}));

/* ------------------------- teacher attendance --------------------------- */
router.get("/teacher-attendance.csv", ADMINS, requireStaffPermission("teachers.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || "")) ? String(req.query.from) : "0000-01-01";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || "")) ? String(req.query.to) : "9999-12-31";
  const where = ["ta.madrasa_id = ?", "ta.day >= ?", "ta.day <= ?"]; const params = [tid, from, to];
  if (req.query.teacherId) { where.push("ta.user_id = ?"); params.push(toNum(req.query.teacherId, 0)); }
  if (req.query.sessionId) { where.push("ta.session_id = ?"); params.push(toNum(req.query.sessionId, 0)); }
  if (req.query.termId) { where.push("ta.term_id = ?"); params.push(toNum(req.query.termId, 0)); }
  if (req.query.department) { where.push("tp.department = ?"); params.push(cleanStr(req.query.department, 120)); }
  const rows = await db.all(`SELECT u.full_name, tp.department,
      SUM(CASE WHEN ta.status = 'present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN ta.status = 'absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN ta.status = 'late' THEN 1 ELSE 0 END) AS late,
      SUM(CASE WHEN ta.status = 'on_leave' THEN 1 ELSE 0 END) AS on_leave,
      SUM(CASE WHEN ta.status = 'excused' THEN 1 ELSE 0 END) AS excused, COUNT(*) AS days
    FROM teacher_attendance ta JOIN users u ON u.id = ta.user_id AND u.madrasa_id = ta.madrasa_id
    LEFT JOIN teacher_profiles tp ON tp.user_id = ta.user_id AND tp.madrasa_id = ta.madrasa_id
    WHERE ${where.join(" AND ")} GROUP BY ta.user_id, u.full_name, tp.department ORDER BY u.full_name`, params);
  csv.sendCsv(res, filename(req, "teacher-attendance"), csv.toCsv(rows, [
    { label: "Teacher", key: "full_name" }, { label: "Department", key: "department" },
    { label: "Present", value: (r) => Number(r.present) }, { label: "Absent", value: (r) => Number(r.absent) },
    { label: "Late", value: (r) => Number(r.late) }, { label: "On Leave", value: (r) => Number(r.on_leave) },
    { label: "Excused", value: (r) => Number(r.excused) }, { label: "Days Recorded", value: (r) => Number(r.days) },
    { label: "Attendance %", value: (r) => Number(r.days) ? csv.num((Number(r.present) / Number(r.days)) * 100, 1) : "" },
  ]));
}));

/* ------------------------------ fees ----------------------------------- */

router.get("/fees.csv", ADMINS, requireStaffPermission("payments.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const termId = toNum(req.query.termId, 0) || null;
  const classId = toNum(req.query.classId, 0) || null;

  // Placeholder order must match the SQL text exactly: subqueries first, then
  // the outer WHERE clause.
  const params = [];
  const paidTerm = termId ? " AND p.fee_item_id IN (SELECT id FROM fee_items fi2 WHERE fi2.madrasa_id = s.madrasa_id AND fi2.term_id = ?)" : "";
  if (termId) params.push(termId);
  const dueTerm = termId ? " AND fi.term_id = ?" : "";
  if (termId) params.push(termId);

  const where = ["s.madrasa_id = ?", "s.status IN ('active','promoted','suspended')"];
  params.push(tid);
  if (classId) { where.push("s.class_id = ?"); params.push(classId); }

  const rows = await db.all(
    `SELECT s.id, s.admission_no, s.first_name, s.last_name, c.name_en AS class_en, s.parent_name, s.parent_phone,
            (SELECT COALESCE(SUM(p.amount_ngn),0) FROM fee_payments p
              WHERE p.student_id = s.id AND p.madrasa_id = s.madrasa_id${paidTerm}) AS paid,
            (SELECT COALESCE(SUM(fi.amount_ngn),0) FROM fee_items fi
              WHERE fi.madrasa_id = s.madrasa_id${dueTerm}) AS due
     FROM students s LEFT JOIN classes c ON c.id = s.class_id
     WHERE ${where.join(" AND ")} ORDER BY c.name_en, s.admission_no`,
    params
  );
  csv.sendCsv(res, filename(req, "fees"), csv.toCsv(rows, [
    { label: "Class", key: "class_en" },
    { label: "Admission No", key: "admission_no" },
    { label: "Student", value: (r) => `${r.first_name} ${r.last_name}`.trim() },
    { label: "Parent", key: "parent_name" },
    { label: "Parent Phone", key: "parent_phone" },
    { label: "Billed (N)", value: (r) => csv.num(r.due || 0, 0) },
    { label: "Paid (N)", value: (r) => csv.num(r.paid || 0, 0) },
    { label: "Outstanding (N)", value: (r) => csv.num((Number(r.due) || 0) - (Number(r.paid) || 0), 0) },
  ]));
}));

/* ------------------------------ admission queue ----------------------- */

router.get("/admissions.csv", ADMINS, requireStaffPermission("admissions.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const status = cleanStr(req.query.status, 20);
  const where = ["a.madrasa_id = ?"];
  const params = [tid];
  if (status) { where.push("a.status = ?"); params.push(status); }
  const rows = await db.all(
    `SELECT a.*, c.name_en AS class_name FROM admission_requests a
     LEFT JOIN classes c ON c.id = a.class_id
     WHERE ${where.join(" AND ")} ORDER BY a.id DESC`,
    params
  );
  csv.sendCsv(res, filename(req, "admissions"), csv.toCsv(rows, [
    { label: "Reference", key: "reference" },
    { label: "Status", key: "status" },
    { label: "Applicant", value: (r) => `${r.first_name} ${r.last_name}`.trim() },
    { label: "Arabic Name", key: "name_ar" },
    { label: "Gender", key: "gender" },
    { label: "Date of Birth", key: "date_of_birth" },
    { label: "Class Applied For", key: "class_name" },
    { label: "Previous School", key: "previous_school" },
    { label: "Quran Level", key: "quran_level" },
    { label: "Parent", key: "parent_name" },
    { label: "Phone", key: "parent_phone" },
    { label: "Email", key: "parent_email" },
    { label: "Address", key: "address" },
    { label: "Message", key: "message" },
    { label: "Admission No (if admitted)", key: "admission_no_assigned" },
    { label: "Reviewed At", key: "reviewed_at" },
    { label: "Review Note", key: "review_note" },
    { label: "Submitted", key: "created_at" },
  ]));
}));

/* ------------------------------ teachers ------------------------------- */

router.get("/teachers.csv", ADMINS, requireStaffPermission("teachers.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const where = ["u.madrasa_id = ?", "u.role = 'teacher'", "COALESCE(p.status, '') <> 'archived'"];
  const params = [tid];
  if (req.query.status) { where.push("COALESCE(p.status, CASE WHEN u.is_active = 1 THEN 'active' ELSE 'inactive' END) = ?"); params.push(cleanStr(req.query.status, 20)); }
  if (req.query.department) { where.push("p.department = ?"); params.push(cleanStr(req.query.department, 120)); }
  if (req.query.education_track) { where.push("p.education_track = ?"); params.push(cleanStr(req.query.education_track, 20)); }
  if (req.query.employment_type) { where.push("p.employment_type = ?"); params.push(cleanStr(req.query.employment_type, 60)); }
  if (req.query.classId) { where.push("EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.madrasa_id = u.madrasa_id AND ta.user_id = u.id AND ta.class_id = ?)"); params.push(toNum(req.query.classId, 0)); }
  if (req.query.subjectId) { where.push("EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.madrasa_id = u.madrasa_id AND ta.user_id = u.id AND ta.subject_id = ?)"); params.push(toNum(req.query.subjectId, 0)); }
  if (req.query.search) { const q = `%${cleanStr(req.query.search, 100).toLowerCase()}%`; where.push("(LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.phone) LIKE ? OR LOWER(p.staff_id) LIKE ? OR LOWER(p.position) LIKE ? OR LOWER(p.department) LIKE ?)"); params.push(q, q, q, q, q, q); }
  const rows = await db.all(
    `SELECT u.full_name, u.email, u.phone, u.username, u.is_active,
            p.staff_id, p.gender, p.position, p.department, p.education_track, p.employment_type,
            p.employment_date, p.status, p.qualifications, p.certifications, p.specialization,
            GROUP_CONCAT(DISTINCT s.name_en) AS subjects,
            GROUP_CONCAT(DISTINCT c.name_en) AS classes
       FROM users u
       LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
       LEFT JOIN teacher_assignments ta ON ta.user_id = u.id AND ta.madrasa_id = u.madrasa_id
       LEFT JOIN subjects s ON s.id = ta.subject_id AND s.madrasa_id = ta.madrasa_id
       LEFT JOIN classes c ON c.id = ta.class_id AND c.madrasa_id = ta.madrasa_id
      WHERE ${where.join(" AND ")}
      GROUP BY u.id, u.full_name, u.email, u.phone, u.username, u.is_active,
               p.staff_id, p.gender, p.position, p.department, p.education_track,
               p.employment_type, p.employment_date, p.status, p.qualifications,
               p.certifications, p.specialization
      ORDER BY u.full_name`, params);
  csv.sendCsv(res, filename(req, "teachers"), csv.toCsv(rows, [
    { label: "Staff ID", key: "staff_id" }, { label: "Full Name", key: "full_name" },
    { label: "Gender", key: "gender" }, { label: "Phone", key: "phone" }, { label: "Email", key: "email" },
    { label: "Position", key: "position" }, { label: "Department", key: "department" },
    { label: "Subjects", key: "subjects" }, { label: "Classes", key: "classes" },
    { label: "Education Track", key: "education_track" }, { label: "Employment Type", key: "employment_type" },
    { label: "Employment Date", key: "employment_date" }, { label: "Status", key: "status" },
    { label: "Qualifications", key: "qualifications" }, { label: "Certifications", key: "certifications" },
    { label: "Specialization", key: "specialization" }, { label: "Username", key: "username" },
  ]));
}));

/* ------------------------------- classes ------------------------------- */

router.get("/classes.csv", STAFF, requireStaffPermission("classes.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const classIds = await teacherClassFilter(req, tid, toNum(req.query.classId, 0) || null);
  if (classIds && !classIds.length) return csv.sendCsv(res, filename(req, "classes"), csv.toCsv([], []));
  const where = ["c.madrasa_id = ?", "COALESCE(c.status, '') <> 'archived'"];
  const params = [tid];
  if (classIds) { where.push(`c.id IN (${inClause(classIds)})`); params.push(...classIds); }
  if (req.query.status) { where.push("COALESCE(c.status, CASE WHEN c.is_active = 1 THEN 'active' ELSE 'inactive' END) = ?"); params.push(cleanStr(req.query.status, 20)); }
  if (req.query.education_track) { where.push("c.education_track = ?"); params.push(cleanStr(req.query.education_track, 20)); }
  if (req.query.program) { where.push("c.program = ?"); params.push(cleanStr(req.query.program, 120)); }
  if (req.query.level) { where.push("c.level_name = ?"); params.push(cleanStr(req.query.level, 80)); }
  if (req.query.sessionId) { where.push("c.session_id = ?"); params.push(toNum(req.query.sessionId, 0)); }
  const rows = await db.all(
    `SELECT c.*, sess.label AS session_label, term.name_en AS term_name,
            ct.full_name AS class_teacher, at.full_name AS assistant_teacher,
            (SELECT COUNT(*) FROM students s WHERE s.madrasa_id = c.madrasa_id AND s.class_id = c.id AND s.status IN ('active','promoted','suspended')) AS student_count,
            (SELECT COUNT(*) FROM class_subjects cs WHERE cs.madrasa_id = c.madrasa_id AND cs.class_id = c.id) AS subject_count,
            (SELECT GROUP_CONCAT(su.name_en) FROM class_subjects cs JOIN subjects su ON su.id = cs.subject_id WHERE cs.madrasa_id = c.madrasa_id AND cs.class_id = c.id) AS subjects
       FROM classes c
       LEFT JOIN academic_sessions sess ON sess.id = c.session_id
       LEFT JOIN terms term ON term.id = c.term_id
       LEFT JOIN users ct ON ct.id = c.class_teacher_id
       LEFT JOIN users at ON at.id = c.assistant_teacher_id
      WHERE ${where.join(" AND ")} ORDER BY c.sort_order, c.name_en`, params);
  csv.sendCsv(res, filename(req, "classes"), csv.toCsv(rows, [
    { label: "Class Name", key: "name_en" }, { label: "Class Code", key: "class_code" },
    { label: "Education Track", key: "education_track" }, { label: "Program", key: "program" },
    { label: "Level", key: "level_name" }, { label: "Section/Arm", key: "section_arm" },
    { label: "Academic Session", key: "session_label" }, { label: "Current Term/Semester", key: "term_name" },
    { label: "Students", key: "student_count" }, { label: "Class Teacher", key: "class_teacher" },
    { label: "Assistant Teacher", key: "assistant_teacher" }, { label: "Subjects", key: "subject_count" },
    { label: "Subject Names", key: "subjects" }, { label: "Capacity", key: "max_capacity" }, { label: "Status", key: "status" },
    { label: "Description", key: "description" },
  ]));
}));

/* ------------------------------ timetable ------------------------------- */

router.get("/timetable.csv", STAFF, requireStaffPermission("classes.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const requestedClassId = toNum(req.query.classId, 0) || null;
  const classIds = await teacherClassFilter(req, tid, requestedClassId);
  if (classIds && !classIds.length) return csv.sendCsv(res, filename(req, "timetable"), csv.toCsv([], []));
  const where = ["ts.madrasa_id = ?"];
  const params = [tid];
  if (classIds) { where.push(`ts.class_id IN (${inClause(classIds)})`); params.push(...classIds); }
  if (req.query.termId) { where.push("ts.term_id = ?"); params.push(toNum(req.query.termId, 0)); }
  if (req.query.teacherId) { where.push("ts.teacher_id = ?"); params.push(toNum(req.query.teacherId, 0)); }
  const rows = await db.all(
    `SELECT ts.day, ts.period, ts.start_time, ts.end_time, ts.room, ts.notes,
            c.name_en AS class_name, c.class_code, term.name_en AS term_name, sess.label AS session_label,
            su.name_en AS subject_name, u.full_name AS teacher_name, p.staff_id
       FROM timetable_slots ts
       JOIN classes c ON c.id = ts.class_id AND c.madrasa_id = ts.madrasa_id
       LEFT JOIN terms term ON term.id = ts.term_id
       LEFT JOIN academic_sessions sess ON sess.id = term.session_id
       LEFT JOIN subjects su ON su.id = ts.subject_id AND su.madrasa_id = ts.madrasa_id
       LEFT JOIN users u ON u.id = ts.teacher_id AND u.madrasa_id = ts.madrasa_id
       LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
      WHERE ${where.join(" AND ")}
      ORDER BY c.sort_order, c.name_en,
        CASE ts.day WHEN 'Mon' THEN 1 WHEN 'Tue' THEN 2 WHEN 'Wed' THEN 3 WHEN 'Thu' THEN 4 WHEN 'Fri' THEN 5 WHEN 'Sat' THEN 6 ELSE 9 END,
        ts.period`, params);
  csv.sendCsv(res, filename(req, "timetable"), csv.toCsv(rows, [
    { label: "Class", key: "class_name" }, { label: "Class Code", key: "class_code" },
    { label: "Session", key: "session_label" }, { label: "Term/Semester", key: "term_name" },
    { label: "Day", key: "day" }, { label: "Period", key: "period" },
    { label: "Start", key: "start_time" }, { label: "End", key: "end_time" },
    { label: "Subject", key: "subject_name" }, { label: "Teacher", key: "teacher_name" },
    { label: "Staff ID", key: "staff_id" }, { label: "Classroom", key: "room" },
    { label: "Notes", key: "notes" },
  ]));
}));

/* ------------------------------ expenses ------------------------------- */

router.get("/expenses.csv", ADMINS, requireStaffPermission("expenses.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const where = ["e.madrasa_id = ?"];
  const params = [tid];

  if (req.query.from) { where.push("e.payment_date >= ?"); params.push(validDate(req.query.from) || ""); }
  if (req.query.to) { where.push("e.payment_date <= ?"); params.push(validDate(req.query.to) || ""); }
  if (req.query.sessionId) { where.push("e.session_id = ?"); params.push(toNum(req.query.sessionId, 0)); }
  if (req.query.termId) { where.push("e.term_id = ?"); params.push(toNum(req.query.termId, 0)); }
  if (req.query.categoryId) { where.push("e.category_id = ?"); params.push(toNum(req.query.categoryId, 0)); }
  if (req.query.vendor) { where.push("LOWER(e.vendor) LIKE ?"); params.push("%" + cleanStr(req.query.vendor, 180).toLowerCase() + "%"); }
  if (req.query.status) {
    const s = cleanStr(req.query.status, 20).toLowerCase();
    if (s !== "all") { where.push("e.status = ?"); params.push(s); }
  } else {
    where.push("e.status = 'approved'");
  }

  const rows = await db.all(
    `SELECT e.*, c.name AS category_name, c.type AS category_type, s.label AS session_label, t.name_en AS term_name, u_a.full_name AS approved_by_name
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id AND c.madrasa_id = e.madrasa_id
       LEFT JOIN academic_sessions s ON s.id = e.session_id AND s.madrasa_id = e.madrasa_id
       LEFT JOIN terms t ON t.id = e.term_id AND t.madrasa_id = e.madrasa_id
       LEFT JOIN users u_a ON u_a.id = e.approved_by
      WHERE ${where.join(" AND ")}
      ORDER BY e.payment_date ASC, e.id ASC`,
    params
  );

  csv.sendCsv(res, filename(req, "expenses"), csv.toCsv(rows, [
    { label: "Date", key: "payment_date" },
    { label: "Session", value: (r) => r.session_label || "" },
    { label: "Term", value: (r) => r.term_name || "" },
    { label: "Category", value: (r) => r.category_name || "" },
    { label: "Category Type", value: (r) => r.category_type || "" },
    { label: "Vendor", key: "vendor" },
    { label: "Description", key: "description" },
    { label: "Payment Method", key: "payment_method" },
    { label: "Amount (NGN)", value: (r) => csv.num(r.amount_ngn, 2) },
    { label: "Status", key: "status" },
    { label: "Approved By", value: (r) => r.approved_by_name || "" },
  ]));
}));

module.exports = router;
