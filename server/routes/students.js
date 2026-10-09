"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — Student management routes
   ----------------------------------------------------------------------------
   madrasa_admin: full CRUD for their madrasa only (plan limits enforced).
   teacher:       read-only, limited to assigned classes.
   ========================================================================== */
const express = require("express");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const config = require("../config");
const { asyncHandler, err, ok, cleanStr, toNum, validDate, validPhone, validEmail, logActivity, checkPlanLimits } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments } = require("../middleware/tenant");
const { imageUploader, fileUploader } = require("../middleware/upload");
const admission = require("../services/admission");
const { requirePermission } = require("../services/permissions");
const audit = require("../services/audit");
const profileMedia = require("../services/profile-media");
const cardCreds = require("../services/card-credentials");

const router = express.Router();
router.use(requireAuth, requireTenant);

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required." }); return null; }
  return tid;
}

const GROUP_TYPES = ["class", "house", "club", "society", "islamic", "quran", "academic", "sports", "graduation", "special_program", "custom"];
const STUDENT_STATUSES = ["active", "inactive", "graduated", "withdrawn", "suspended", "promoted"];

async function groupRow(req, res, id, tid) {
  const row = await db.get("SELECT * FROM student_groups WHERE id = ? AND madrasa_id = ?", [toNum(id, 0), tid]);
  if (!row) { err(res, 404, "Student group not found."); return null; }
  return row;
}

/* ------------------------------ groups ---------------------------------- */
// Groups are deliberately separate from classes. A student can be a member of
// many groups at once, while the existing class_id remains the academic
// placement used by attendance, results and timetable.
router.get("/groups", requirePermission("students.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) return err(res, 403, "Permission denied.");
  const where = ["g.madrasa_id = ?"]; const params = [tid];
  if (req.query.type && GROUP_TYPES.includes(cleanStr(req.query.type, 60))) { where.push("g.group_type = ?"); params.push(cleanStr(req.query.type, 60)); }
  if (req.query.status) { where.push("g.status = ?"); params.push(cleanStr(req.query.status, 20)); }
  if (req.query.search) { where.push("(LOWER(g.name) LIKE ? OR LOWER(g.description) LIKE ?)"); const q = `%${cleanStr(req.query.search, 100).toLowerCase()}%`; params.push(q, q); }
  const groups = await db.all(`
    SELECT g.*, u.full_name AS teacher_name,
      ls.first_name AS leader_first_name, ls.last_name AS leader_last_name,
      (SELECT COUNT(*) FROM student_group_members gm WHERE gm.group_id = g.id AND gm.madrasa_id = g.madrasa_id) AS member_count
    FROM student_groups g
    LEFT JOIN users u ON u.id = g.teacher_id AND u.madrasa_id = g.madrasa_id
    LEFT JOIN students ls ON ls.id = g.leader_student_id AND ls.madrasa_id = g.madrasa_id
    WHERE ${where.join(" AND ")} ORDER BY g.status, g.name`, params);
  ok(res, { groups: groups.map((g) => Object.assign(g, { member_count: Number(g.member_count || 0) })) });
}));

router.post("/groups", requirePermission("students.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {}; const name = cleanStr(b.name, 160);
  if (!name) return err(res, 400, "Group name is required.");
  const type = GROUP_TYPES.includes(cleanStr(b.group_type, 60)) ? cleanStr(b.group_type, 60) : "custom";
  const teacherId = b.teacher_id ? toNum(b.teacher_id, 0) : null;
  const leaderId = b.leader_student_id ? toNum(b.leader_student_id, 0) : null;
  if (teacherId && !await db.get("SELECT id FROM users WHERE id = ? AND madrasa_id = ? AND role = 'teacher'", [teacherId, tid])) return err(res, 400, "Unknown teacher.");
  if (leaderId && !await db.get("SELECT id FROM students WHERE id = ? AND madrasa_id = ?", [leaderId, tid])) return err(res, 400, "Unknown group leader.");
  const r = await db.run("INSERT INTO student_groups (madrasa_id, name, group_type, description, leader_student_id, teacher_id, status, created_by) VALUES (?,?,?,?,?,?,?,?)", [tid, name, type, cleanStr(b.description, 4000), leaderId, teacherId, "active", req.user.id]);
  const members = Array.isArray(b.student_ids) ? b.student_ids : [];
  for (const sid of members.map((x) => toNum(x, 0)).filter(Boolean)) {
    if (await db.get("SELECT id FROM students WHERE id = ? AND madrasa_id = ?", [sid, tid])) await db.insertIgnore("student_group_members", "madrasa_id, group_id, student_id", [tid, r.lastInsertRowid, sid]);
  }
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "student_group.create", entity: "student_group", entityId: String(r.lastInsertRowid), meta: { name, type }, ip: req.ip });
  ok(res, { ok: true, id: r.lastInsertRowid });
}));

router.get("/groups/:id", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const group = await groupRow(req, res, req.params.id, tid); if (!group) return;
  const [members, teachers] = await Promise.all([
    db.all(`SELECT s.*, c.name_en AS class_name FROM student_group_members gm JOIN students s ON s.id = gm.student_id AND s.madrasa_id = gm.madrasa_id LEFT JOIN classes c ON c.id = s.class_id WHERE gm.group_id = ? AND gm.madrasa_id = ? ORDER BY s.last_name, s.first_name`, [group.id, tid]),
    db.all("SELECT id, full_name, username FROM users WHERE madrasa_id = ? AND role = 'teacher' AND is_active = 1 ORDER BY full_name", [tid]),
  ]);
  ok(res, { group, members, teachers });
}));

router.patch("/groups/:id", requirePermission("students.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const group = await groupRow(req, res, req.params.id, tid); if (!group) return;
  const b = req.body || {}; const sets = []; const vals = [];
  if (b.name !== undefined) { const name = cleanStr(b.name, 160); if (!name) return err(res, 400, "Group name is required."); sets.push("name = ?"); vals.push(name); }
  if (b.group_type !== undefined) { const type = cleanStr(b.group_type, 60); if (!GROUP_TYPES.includes(type)) return err(res, 400, "Invalid group type."); sets.push("group_type = ?"); vals.push(type); }
  for (const [field, max] of [["description", 4000], ["status", 20]]) if (b[field] !== undefined) { sets.push(`${field} = ?`); vals.push(cleanStr(b[field], max)); }
  for (const [field, table, extra] of [["teacher_id", "users", " AND role = 'teacher'"], ["leader_student_id", "students", ""]]) {
    if (b[field] !== undefined) {
      const id = b[field] ? toNum(b[field], 0) : null;
      if (id && !await db.get(`SELECT id FROM ${table} WHERE id = ? AND madrasa_id = ?${extra}`, [id, tid])) return err(res, 400, field === "teacher_id" ? "Unknown teacher." : "Unknown group leader.");
      sets.push(`${field} = ?`); vals.push(id);
    }
  }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  sets.push("updated_at = CURRENT_TIMESTAMP"); vals.push(group.id);
  await db.run(`UPDATE student_groups SET ${sets.join(", ")} WHERE id = ? AND madrasa_id = ?`, vals.concat(tid));
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "student_group.update", entity: "student_group", entityId: String(group.id), ip: req.ip });
  ok(res, { ok: true });
}));

router.delete("/groups/:id", requirePermission("students.delete"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const group = await groupRow(req, res, req.params.id, tid); if (!group) return;
  await db.run("UPDATE student_groups SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [group.id, tid]);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "student_group.archive", entity: "student_group", entityId: String(group.id), ip: req.ip });
  ok(res, { ok: true });
}));

router.post("/groups/:id/members", requirePermission("students.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const group = await groupRow(req, res, req.params.id, tid); if (!group) return;
  const ids = Array.isArray(req.body && req.body.student_ids) ? req.body.student_ids : [req.body && req.body.student_id];
  let added = 0;
  for (const sid of ids.map((x) => toNum(x, 0)).filter(Boolean)) {
    if (await db.get("SELECT id FROM students WHERE id = ? AND madrasa_id = ?", [sid, tid])) { const r = await db.insertIgnore("student_group_members", "madrasa_id, group_id, student_id", [tid, group.id, sid]); added += r.changes ? 1 : 0; }
  }
  ok(res, { ok: true, added });
}));

router.delete("/groups/:id/members/:studentId", requirePermission("students.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const group = await groupRow(req, res, req.params.id, tid); if (!group) return;
  await db.run("DELETE FROM student_group_members WHERE madrasa_id = ? AND group_id = ? AND student_id = ?", [tid, group.id, toNum(req.params.studentId, 0)]);
  ok(res, { ok: true });
}));

/* ------------------------------ list ----------------------------------- */

router.get("/", requirePermission("students.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  // Only staff may list students (admins: whole madrasa, teachers: assigned classes)
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Permission denied." });
  }

  let classFilter = null;
  if (req.user.role === "teacher") {
    // Teachers may only list students of classes assigned to them.
    // If a classId query param is given, intersect with the assigned set.
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (scope.anyClassAnySubject) {
      classFilter = req.query.classId ? [toNum(req.query.classId, 0)] : null;
    } else {
      const assigned = [...scope.assignedClassIds];
      if (assigned.length === 0) { res.json({ students: [], total: 0 }); return; }
      classFilter = req.query.classId ? assigned.filter((c) => c === toNum(req.query.classId, 0)) : assigned;
      if (classFilter.length === 0) { res.json({ students: [], total: 0 }); return; }
    }
  } else if (req.query.classId) {
    classFilter = [toNum(req.query.classId, 0)];
  }

  const search = cleanStr(req.query.search, 100).toLowerCase();
  const page = Math.max(1, toNum(req.query.page, 1));
  const perPage = Math.min(200, Math.max(1, toNum(req.query.perPage, 50)));
  const offset = (page - 1) * perPage;

  let where = "s.madrasa_id = ?";
  const params = [tid];
  if (classFilter) {
    where += " AND s.class_id IN (" + classFilter.map(() => "?").join(",") + ")";
    params.push(...classFilter);
  }
  if (search) {
    where += " AND (LOWER(s.first_name) LIKE ? OR LOWER(s.last_name) LIKE ? OR LOWER(s.preferred_name) LIKE ? OR LOWER(s.admission_no) LIKE ? OR LOWER(s.student_code) LIKE ? OR LOWER(s.name_ar) LIKE ? OR LOWER(s.parent_name) LIKE ?)";
    const like = "%" + search + "%";
    params.push(like, like, like, like, like, like, like);
  }
  const filters = [["status", 20], ["gender", 10], ["section", 80], ["program", 120], ["education_track", 20]];
  for (const [field, max] of filters) {
    if (req.query[field]) { where += ` AND s.${field} = ?`; params.push(cleanStr(req.query[field], max)); }
  }
  if (req.query.sessionId) { where += " AND s.session_id = ?"; params.push(toNum(req.query.sessionId, 0)); }

  const allowedSort = { name: "s.last_name, s.first_name", admission: "s.admission_no", newest: "s.created_at", status: "s.status", class: "c.name_en" };
  const sortSql = allowedSort[cleanStr(req.query.sort, 20)] || "s.admission_no";
  const direction = cleanStr(req.query.direction, 4).toLowerCase() === "desc" ? "DESC" : "ASC";
  const total = await db.get(`SELECT COUNT(*) AS n FROM students s WHERE ${where}`, params);
  const rows = await db.all(
    `SELECT s.*, c.name_en AS class_en, c.name_ar AS class_ar, ic.name_en AS islamic_class_name, wc.name_en AS western_class_name, a.label AS session_label
     FROM students s LEFT JOIN classes c ON c.id = s.class_id
     LEFT JOIN classes ic ON ic.id = s.islamic_class_id AND ic.madrasa_id = s.madrasa_id
     LEFT JOIN classes wc ON wc.id = s.western_class_id AND wc.madrasa_id = s.madrasa_id
     LEFT JOIN academic_sessions a ON a.id = s.session_id
     WHERE ${where}
     ORDER BY ${sortSql} ${direction}, s.id DESC
     LIMIT ? OFFSET ?`,
    params.concat([perPage, offset])
  );
  ok(res, { students: rows, total: Number(total.n), page, perPage, totalPages: Math.max(1, Math.ceil(Number(total.n) / perPage)) });
}));

router.get("/stats", requirePermission("students.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) return err(res, 403, "Permission denied.");
  const total = await db.get("SELECT COUNT(*) AS n FROM students WHERE madrasa_id = ?", [tid]);
  const active = await db.get("SELECT COUNT(*) AS n FROM students WHERE madrasa_id = ? AND status IN ('active','promoted')", [tid]);
  const graduated = await db.get("SELECT COUNT(*) AS n FROM students WHERE madrasa_id = ? AND status = 'graduated'", [tid]);
  const withdrawn = await db.get("SELECT COUNT(*) AS n FROM students WHERE madrasa_id = ? AND status = 'withdrawn'", [tid]);
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const cutoffDateTime = cutoff.toISOString().slice(0, 19).replace("T", " ");
  const newStudents = await db.get("SELECT COUNT(*) AS n FROM students WHERE madrasa_id = ? AND (admission_date >= ? OR created_at >= ?)", [tid, cutoffDate, cutoffDateTime]);
  const statuses = await db.all("SELECT status, COUNT(*) AS count FROM students WHERE madrasa_id = ? GROUP BY status", [tid]);
  ok(res, { total: Number(total.n), active: Number(active.n), newStudents: Number(newStudents.n), graduated: Number(graduated.n), withdrawn: Number(withdrawn.n), statuses });
}));

/* ------------------------------ create --------------------------------- */

router.post("/", requirePermission("students.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const b = req.body || {};
  const firstName = cleanStr(b.first_name, 100);
  const lastName = cleanStr(b.last_name, 100);
  if (!firstName) return err(res, 400, "First name is required.");

  const limitCheck = await checkPlanLimits(db, tid, "student");
  if (!limitCheck.allowed) return err(res, 403, limitCheck.message, { limit: limitCheck.limit, count: limitCheck.count });

  const classId = b.class_id ? toNum(b.class_id, 0) : null;
  if (classId) {
    const c = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
    if (!c) return err(res, 400, "Unknown class.");
  }
  const sessionId = b.session_id ? toNum(b.session_id, 0) : null;
  if (sessionId) {
    const s = await db.get("SELECT id FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sessionId, tid]);
    if (!s) return err(res, 400, "Unknown academic session.");
  }
  const islamicClassId = b.islamic_class_id ? toNum(b.islamic_class_id, 0) : null;
  const westernClassId = b.western_class_id ? toNum(b.western_class_id, 0) : null;
  for (const cid of [islamicClassId, westernClassId].filter(Boolean)) if (!await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [cid, tid])) return err(res, 400, "Unknown education-track class.");
  const dob = validDate(b.date_of_birth);
  const admissionDate = validDate(b.admission_date) || new Date().toISOString().slice(0, 10);
  if (b.date_of_birth && !dob) return err(res, 400, "Invalid date of birth (use YYYY-MM-DD).");
  if (b.admission_date && !validDate(b.admission_date)) return err(res, 400, "Invalid admission date.");
  const phone = validPhone(b.parent_phone) ? cleanStr(b.parent_phone, 60) : null;
  const altPhone = validPhone(b.alternative_phone) ? cleanStr(b.alternative_phone, 60) : null;
  if (phone === null || altPhone === null) return err(res, 400, "Invalid guardian phone number.");
  if (!validEmail(b.parent_email)) return err(res, 400, "Invalid guardian email.");

  const requestedAdmission = cleanStr(b.admission_no, 60).toUpperCase();
  const { admissionNo: generatedAdmission } = await admission.nextAdmissionNo(tid);
  const admissionNo = requestedAdmission || generatedAdmission;
  const studentCode = cleanStr(b.student_code, 60).toUpperCase() || admissionNo;
  if (await db.get("SELECT id FROM students WHERE madrasa_id = ? AND admission_no = ?", [tid, admissionNo])) return err(res, 400, "That admission number is already in use.");
  if (await db.get("SELECT id FROM students WHERE madrasa_id = ? AND student_code = ?", [tid, studentCode])) return err(res, 400, "That student ID is already in use.");

  const r = await db.run(
    `INSERT INTO students (
      madrasa_id, admission_no, student_code, first_name, middle_name, last_name, preferred_name, name_ar,
      gender, date_of_birth, nationality, state_of_origin, lga, religion, admission_date, class_id, section,
      islamic_class_id, western_class_id, islamic_program, western_program, session_id, program, education_track, student_type, previous_school, previous_class, status,
      parent_name, father_name, mother_name, guardian_name, guardian_relationship, parent_phone, alternative_phone,
      parent_email, address, residential_address, emergency_contact, emergency_info, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tid, admissionNo, studentCode, firstName, cleanStr(b.middle_name, 100), lastName, cleanStr(b.preferred_name, 100), cleanStr(b.name_ar, 160),
      cleanStr(b.gender, 10), dob, cleanStr(b.nationality, 80), cleanStr(b.state_of_origin, 80), cleanStr(b.lga, 80), cleanStr(b.religion, 60), admissionDate, classId, cleanStr(b.section, 80),
      islamicClassId, westernClassId, cleanStr(b.islamic_program, 120), cleanStr(b.western_program, 120), sessionId, cleanStr(b.program, 120), ["islamic", "western", "both"].includes(cleanStr(b.education_track, 20)) ? cleanStr(b.education_track, 20) : "both", cleanStr(b.student_type, 20) || "new", cleanStr(b.previous_school, 200), cleanStr(b.previous_class, 120), "active",
      cleanStr(b.parent_name, 160), cleanStr(b.father_name, 160), cleanStr(b.mother_name, 160), cleanStr(b.guardian_name, 160), cleanStr(b.guardian_relationship, 80), phone, altPhone,
      cleanStr(b.parent_email, 120), cleanStr(b.address, 255), cleanStr(b.residential_address, 255), cleanStr(b.emergency_contact, 160), cleanStr(b.emergency_info, 2000), cleanStr(b.notes, 2000),
    ]
  );
  if (classId || sessionId) await db.run("INSERT INTO student_class_history (madrasa_id, student_id, from_class_id, to_class_id, from_session_id, to_session_id, action, changed_by) VALUES (?,?,?,?,?,?,?,?)", [tid, r.lastInsertRowid, null, classId, null, sessionId, "enrollment", req.user.id]);
  await audit.record(req, { action: "student.create", module: "students", entity: "student", entityId: r.lastInsertRowid, after: { admission_no: admissionNo, student_code: studentCode, first_name: firstName, last_name: lastName, class_id: classId } });
  ok(res, { ok: true, id: r.lastInsertRowid, studentId: studentCode, studentCode, admissionNo });
}));

/* ------------------------------ read one ------------------------------- */

router.get("/:id", requirePermission("students.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  // Only staff may fetch a student record by id. Students/parents use /api/portal.
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Permission denied." });
  }
  const sid = toNum(req.params.id, 0);
  const s = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [sid, tid]);
  if (!s) return res.status(404).json({ error: "Student not found." });
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!scope.anyClassAnySubject && (!s.class_id || !scope.assignedClassIds.has(Number(s.class_id)))) {
      return res.status(404).json({ error: "Student not found." });
    }
  }
  const classRow = s.class_id ? await db.get("SELECT * FROM classes WHERE id = ? AND madrasa_id = ?", [s.class_id, tid]) : null;
  const [islamicClass, westernClass] = await Promise.all([
    s.islamic_class_id ? db.get("SELECT id, name_en, name_ar FROM classes WHERE id = ? AND madrasa_id = ?", [s.islamic_class_id, tid]) : null,
    s.western_class_id ? db.get("SELECT id, name_en, name_ar FROM classes WHERE id = ? AND madrasa_id = ?", [s.western_class_id, tid]) : null,
  ]);
  const [terms, results, attendance, payments, documents, groups, statusHistory, classHistory, communications, lifeRecords, homework, application] = await Promise.all([
    db.all(`SELECT ts.*, t.name_en AS term_name, t.name_ar AS term_name_ar, t.position FROM term_summaries ts JOIN terms t ON t.id = ts.term_id WHERE ts.madrasa_id = ? AND ts.student_id = ? ORDER BY t.position DESC, ts.id DESC LIMIT 20`, [tid, s.id]),
    db.all(`SELECT r.*, su.name_en AS subject_name, su.name_ar AS subject_name_ar, t.name_en AS term_name FROM results r LEFT JOIN subjects su ON su.id = r.subject_id LEFT JOIN terms t ON t.id = r.term_id WHERE r.madrasa_id = ? AND r.student_id = ? ORDER BY r.id DESC LIMIT 100`, [tid, s.id]),
    db.all("SELECT a.*, c.name_en AS class_name FROM attendance a LEFT JOIN classes c ON c.id = a.class_id WHERE a.madrasa_id = ? AND a.student_id = ? ORDER BY a.day DESC LIMIT 100", [tid, s.id]),
    db.all(`SELECT p.*, f.name_en AS fee_name FROM fee_payments p LEFT JOIN fee_items f ON f.id = p.fee_item_id WHERE p.madrasa_id = ? AND p.student_id = ? ORDER BY p.payment_date DESC, p.id DESC LIMIT 100`, [tid, s.id]),
    db.all("SELECT id, document_name, original_name, mime_type, file_size, created_at FROM student_documents WHERE madrasa_id = ? AND student_id = ? ORDER BY id DESC", [tid, s.id]),
    db.all(`SELECT g.*, gm.joined_at FROM student_group_members gm JOIN student_groups g ON g.id = gm.group_id AND g.madrasa_id = gm.madrasa_id WHERE gm.madrasa_id = ? AND gm.student_id = ? AND g.status != 'archived' ORDER BY g.name`, [tid, s.id]),
    db.all("SELECT * FROM student_status_history WHERE madrasa_id = ? AND student_id = ? ORDER BY id DESC LIMIT 50", [tid, s.id]),
    db.all(`SELECT h.*, fc.name_en AS from_class_name, tc.name_en AS to_class_name FROM student_class_history h LEFT JOIN classes fc ON fc.id = h.from_class_id LEFT JOIN classes tc ON tc.id = h.to_class_id WHERE h.madrasa_id = ? AND h.student_id = ? ORDER BY h.id DESC LIMIT 50`, [tid, s.id]),
    db.all("SELECT * FROM student_communications WHERE madrasa_id = ? AND student_id = ? ORDER BY id DESC LIMIT 100", [tid, s.id]),
    db.all("SELECT * FROM student_life_records WHERE madrasa_id = ? AND student_id = ? ORDER BY record_date DESC, id DESC LIMIT 100", [tid, s.id]),
    s.class_id ? db.all("SELECT h.*, su.name_en AS subject_name FROM homework h LEFT JOIN subjects su ON su.id = h.subject_id WHERE h.madrasa_id = ? AND h.class_id = ? ORDER BY h.due_date DESC, h.id DESC LIMIT 100", [tid, s.class_id]) : [],
    s.source_request_id ? db.get("SELECT id, reference, status, created_at, reviewed_at, review_note FROM admission_requests WHERE id = ? AND madrasa_id = ?", [s.source_request_id, tid]) : null,
  ]);
  const paid = payments.filter((p) => !p.status || p.status === "successful").reduce((sum, p) => sum + Number(p.amount_ngn || 0), 0);
  const assignedTotal = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount_due),0) AS total FROM fee_assignments WHERE madrasa_id = ? AND student_id = ?", [tid, s.id]);
  const feeTotal = Number(assignedTotal && assignedTotal.n) > 0
    ? assignedTotal
    : await db.get("SELECT COALESCE(SUM(amount_ngn), 0) AS total FROM fee_items WHERE madrasa_id = ? AND status = 'active' AND (class_id IS NULL OR class_id = ?)", [tid, s.class_id]);
  const messageHistory = await db.all("SELECT id, scope, author_name, body, created_at FROM messages WHERE madrasa_id = ? AND (scope != 'direct' OR user_id = ? OR recipient_user_id = ?) ORDER BY id DESC LIMIT 50", [tid, req.user.id, req.user.id]);
  // Portal-account status (additive; never exposes password hashes). Both the
  // student login and the linked parent logins are read from the SAME tables
  // the login flow uses (users / parent_links), always scoped to this tenant.
  const portalAccounts = await readPortalAccounts(tid, s.id);
  ok(res, {
    student: Object.assign({}, s, { class_en: classRow ? classRow.name_en : "", class_ar: classRow ? classRow.name_ar : "", islamic_class_name: islamicClass ? islamicClass.name_en : "", western_class_name: westernClass ? westernClass.name_en : "" }),
    terms, results, attendance, payments, documents, groups, statusHistory, classHistory, communications, lifeRecords, homework,
    application, finance: { paid, billed: Number(feeTotal && feeTotal.total || 0), outstanding: Math.max(0, Number(feeTotal && feeTotal.total || 0) - paid) },
    communicationHistory: messageHistory,
    portalAccount: portalAccounts.student,
    parentAccounts: portalAccounts.parents,
  });
}));

/* ------------------------------ update --------------------------------- */

router.patch("/:id", requirePermission("students.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const s = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!s) return res.status(404).json({ error: "Student not found." });
  const b = req.body || {};
  const sets = [];
  const vals = [];
  const fieldMap = {
    first_name: 100, middle_name: 100, last_name: 100, name_ar: 160, preferred_name: 100, gender: 10,
    nationality: 80, state_of_origin: 80, lga: 80, religion: 60, section: 80, program: 120, islamic_program: 120, western_program: 120,
    education_track: 20, student_type: 20, previous_school: 200, previous_class: 120,
    parent_name: 160, father_name: 160, mother_name: 160, guardian_name: 160, guardian_relationship: 80,
    address: 255, residential_address: 255, emergency_contact: 160, emergency_info: 2000, notes: 2000,
  };
  for (const [f, max] of Object.entries(fieldMap)) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(cleanStr(b[f], max)); }
  }
  if (b.date_of_birth !== undefined) {
    const d = b.date_of_birth ? validDate(b.date_of_birth) : null;
    if (b.date_of_birth && !d) return err(res, 400, "Invalid date of birth.");
    sets.push("date_of_birth = ?"); vals.push(d);
  }
  if (b.parent_phone !== undefined || b.alternative_phone !== undefined) {
    if (b.parent_phone !== undefined) {
      if (!validPhone(b.parent_phone)) return err(res, 400, "Invalid parent phone.");
      sets.push("parent_phone = ?"); vals.push(cleanStr(b.parent_phone, 60));
    }
    if (b.alternative_phone !== undefined) {
      if (!validPhone(b.alternative_phone)) return err(res, 400, "Invalid alternative phone.");
      sets.push("alternative_phone = ?"); vals.push(cleanStr(b.alternative_phone, 60));
    }
  }
  if (b.parent_email !== undefined) {
    if (!validEmail(b.parent_email)) return err(res, 400, "Invalid parent email.");
    sets.push("parent_email = ?"); vals.push(cleanStr(b.parent_email, 120));
  }
  for (const dateField of ["admission_date"]) {
    if (b[dateField] !== undefined) {
      const d = b[dateField] ? validDate(b[dateField]) : null;
      if (b[dateField] && !d) return err(res, 400, `Invalid ${dateField}.`);
      sets.push(`${dateField} = ?`); vals.push(d);
    }
  }
  if (b.education_track !== undefined && !["islamic", "western", "both"].includes(cleanStr(b.education_track, 20))) return err(res, 400, "Invalid education track.");
  if (b.class_id !== undefined) {
    const cid = b.class_id ? toNum(b.class_id, 0) : null;
    if (cid) {
      const c = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [cid, tid]);
      if (!c) return err(res, 400, "Unknown class.");
    }
    sets.push("class_id = ?"); vals.push(cid);
  }
  for (const field of ["islamic_class_id", "western_class_id"]) {
    if (b[field] !== undefined) {
      const cid = b[field] ? toNum(b[field], 0) : null;
      if (cid && !await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [cid, tid])) return err(res, 400, "Unknown education-track class.");
      sets.push(`${field} = ?`); vals.push(cid);
    }
  }
  if (b.session_id !== undefined) {
    const sessionId = b.session_id ? toNum(b.session_id, 0) : null;
    if (sessionId && !await db.get("SELECT id FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sessionId, tid])) return err(res, 400, "Unknown academic session.");
    sets.push("session_id = ?"); vals.push(sessionId);
  }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  const oldClass = s.class_id;
  const oldSession = s.session_id;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(s.id);
  await db.run(`UPDATE students SET ${sets.join(", ")} WHERE id = ?`, vals);
  if (b.class_id !== undefined || b.session_id !== undefined) {
    const newClass = b.class_id ? toNum(b.class_id, 0) : (b.class_id === null || b.class_id === "" ? null : oldClass);
    const newSession = b.session_id ? toNum(b.session_id, 0) : (b.session_id === null || b.session_id === "" ? null : oldSession);
    if (Number(newClass || 0) !== Number(oldClass || 0) || Number(newSession || 0) !== Number(oldSession || 0)) {
      await db.run("INSERT INTO student_class_history (madrasa_id, student_id, from_class_id, to_class_id, from_session_id, to_session_id, action, changed_by) VALUES (?,?,?,?,?,?,?,?)", [tid, s.id, oldClass, newClass, oldSession, newSession, "placement", req.user.id]);
    }
  }
  const after = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [s.id, tid]);
  await audit.record(req, { action: "student.update", module: "students", entity: "student", entityId: s.id, before: s, after });
  ok(res, { ok: true });
}));

/* ------------------------------ status / promote ----------------------- */

router.patch("/:id/status", requirePermission("students.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const s = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!s) return res.status(404).json({ error: "Student not found." });
  const status = cleanStr((req.body || {}).status, 20);
  if (!["active", "promoted", "graduated", "withdrawn", "suspended"].includes(status)) {
    return err(res, 400, "Invalid status.");
  }
  const reason = cleanStr((req.body || {}).reason, 500);
  await db.transaction(async (tx) => {
    await tx.run("UPDATE students SET status = ?, archived_at = CASE WHEN ? IN ('inactive','withdrawn') THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [status, status, s.id]);
    await tx.run("INSERT INTO student_status_history (madrasa_id, student_id, from_status, to_status, reason, changed_by) VALUES (?,?,?,?,?,?)", [tid, s.id, s.status || null, status, reason, req.user.id]);
  });
  await audit.record(req, { action: "student.status", module: "students", entity: "student", entityId: s.id, before: { status: s.status }, after: { status }, meta: { reason } });
  ok(res, { ok: true });
}));

/** Promote a student to another class (optionally next session). */
router.post("/:id/promote", requirePermission("students.promote"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const s = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!s) return res.status(404).json({ error: "Student not found." });
  const b = req.body || {};
  const classId = b.class_id ? toNum(b.class_id, 0) : null;
  if (classId) {
    const c = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
    if (!c) return err(res, 400, "Unknown target class.");
  }
  const sessionId = b.session_id ? toNum(b.session_id, 0) : null;
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE students SET class_id = COALESCE(?, class_id), session_id = COALESCE(?, session_id), status = 'promoted', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [classId, sessionId, s.id]
    );
    await tx.run("INSERT INTO student_class_history (madrasa_id, student_id, from_class_id, to_class_id, from_session_id, to_session_id, action, changed_by) VALUES (?,?,?,?,?,?,?,?)", [tid, s.id, s.class_id, classId || s.class_id, s.session_id, sessionId || s.session_id, "promotion", req.user.id]);
    if (s.status !== "promoted") await tx.run("INSERT INTO student_status_history (madrasa_id, student_id, from_status, to_status, reason, changed_by) VALUES (?,?,?,?,?,?)", [tid, s.id, s.status, "promoted", "Promoted by administrator", req.user.id]);
  });
  await audit.record(req, { action: "student.promote", module: "students", entity: "student", entityId: s.id, before: { class_id: s.class_id, session_id: s.session_id, status: s.status }, after: { class_id: classId || s.class_id, session_id: sessionId || s.session_id, status: "promoted" } });
  ok(res, { ok: true });
}));

/** Bulk promote: all students of a class -> target class (admin). */
router.post("/bulk-promote", requirePermission("students.promote"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const b = req.body || {};
  const fromClassId = toNum(b.from_class_id, 0);
  const toClassId = b.to_class_id ? toNum(b.to_class_id, 0) : null;
  if (!fromClassId) return err(res, 400, "from_class_id is required.");
  if (toClassId) {
    const c = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [toClassId, tid]);
    if (!c) return err(res, 400, "Unknown target class.");
  }
  const res2 = await db.run(
    "UPDATE students SET class_id = ?, status = 'promoted', updated_at = CURRENT_TIMESTAMP WHERE madrasa_id = ? AND class_id = ? AND status IN ('active','promoted')",
    [toClassId || fromClassId, tid, fromClassId]
  );
  await audit.record(req, { action: "student.bulk_promote", module: "students", entity: "class", entityId: fromClassId, before: { class_id: fromClassId }, after: { class_id: toClassId || fromClassId }, meta: { moved: res2.changes } });
  ok(res, { ok: true, moved: res2.changes });
}));

router.post("/bulk-status", requirePermission("students.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const ids = Array.isArray(req.body && req.body.student_ids) ? req.body.student_ids.map((x) => toNum(x, 0)).filter(Boolean) : [];
  const status = cleanStr(req.body && req.body.status, 20);
  if (!ids.length) return err(res, 400, "Select at least one student.");
  if (!STUDENT_STATUSES.includes(status) || status === "promoted") return err(res, 400, "Invalid bulk status.");
  let changed = 0;
  for (const sid of ids) {
    const s = await db.get("SELECT id, status FROM students WHERE id = ? AND madrasa_id = ?", [sid, tid]);
    if (!s || s.status === status) continue;
    await db.transaction(async (tx) => {
      await tx.run("UPDATE students SET status = ?, archived_at = CASE WHEN ? IN ('inactive','withdrawn') THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [status, status, sid, tid]);
      await tx.run("INSERT INTO student_status_history (madrasa_id, student_id, from_status, to_status, reason, changed_by) VALUES (?,?,?,?,?,?)", [tid, sid, s.status, status, cleanStr(req.body.reason, 500), req.user.id]);
    });
    changed++;
  }
  await audit.record(req, { action: "student.bulk_status", module: "students", entity: "student", after: { status }, meta: { count: changed, requested: ids.length } });
  ok(res, { ok: true, changed });
}));

router.post("/:id/restore", requirePermission("students.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const s = await db.get("SELECT id, status FROM students WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!s) return err(res, 404, "Student not found.");
  await db.transaction(async (tx) => {
    await tx.run("UPDATE students SET status = 'active', archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [s.id, tid]);
    await tx.run("INSERT INTO student_status_history (madrasa_id, student_id, from_status, to_status, reason, changed_by) VALUES (?,?,?,?,?,?)", [tid, s.id, s.status, "active", cleanStr(req.body && req.body.reason, 500) || "Restored by administrator", req.user.id]);
  });
  await audit.record(req, { action: "student.restore", module: "students", entity: "student", entityId: s.id, before: { status: s.status }, after: { status: "active" } });
  ok(res, { ok: true });
}));

router.post("/:id/communication", requireRole("madrasa_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const sid = toNum(req.params.id, 0); if (!await db.get("SELECT id FROM students WHERE id = ? AND madrasa_id = ?", [sid, tid])) return err(res, 404, "Student not found.");
  const message = cleanStr(req.body && req.body.message, 5000); if (!message) return err(res, 400, "Message is required.");
  const r = await db.run("INSERT INTO student_communications (madrasa_id, student_id, channel, subject, message, created_by) VALUES (?,?,?,?,?,?)", [tid, sid, cleanStr(req.body.channel, 30) || "note", cleanStr(req.body.subject, 200), message, req.user.id]);
  ok(res, { ok: true, id: r.lastInsertRowid });
}));

router.post("/:id/life-records", requireRole("madrasa_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const sid = toNum(req.params.id, 0); if (!await db.get("SELECT id FROM students WHERE id = ? AND madrasa_id = ?", [sid, tid])) return err(res, 404, "Student not found.");
  const title = cleanStr(req.body && req.body.title, 200); if (!title) return err(res, 400, "Title is required.");
  const category = ["activity", "award", "achievement", "discipline"].includes(cleanStr(req.body.category, 30)) ? cleanStr(req.body.category, 30) : "activity";
  const recordDate = req.body.record_date ? validDate(req.body.record_date) : null; if (req.body.record_date && !recordDate) return err(res, 400, "Invalid record date.");
  const r = await db.run("INSERT INTO student_life_records (madrasa_id, student_id, category, title, details, record_date, created_by) VALUES (?,?,?,?,?,?,?)", [tid, sid, category, title, cleanStr(req.body.details, 4000), recordDate, req.user.id]);
  ok(res, { ok: true, id: r.lastInsertRowid });
}));
router.delete("/:id/life-records/:recordId", requireRole("madrasa_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  await db.run("DELETE FROM student_life_records WHERE id = ? AND student_id = ? AND madrasa_id = ?", [toNum(req.params.recordId, 0), toNum(req.params.id, 0), tid]);
  ok(res, { ok: true });
}));

const privateDocumentUploader = fileUploader("files", "document", {
  dir: path.join(config.DATA_DIR, "private-student-documents"),
  extensions: [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".doc", ".docx"],
  maxMb: 10,
});

router.post("/:id/documents", requireRole("madrasa_admin"), privateDocumentUploader, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const sid = toNum(req.params.id, 0); if (!await db.get("SELECT id FROM students WHERE id = ? AND madrasa_id = ?", [sid, tid])) return err(res, 404, "Student not found.");
  if (!req.file) return err(res, 400, "No document uploaded.");
  const name = cleanStr(req.body && req.body.document_name, 200) || cleanStr(req.file.originalname, 200);
  const r = await db.run("INSERT INTO student_documents (madrasa_id, student_id, document_name, storage_path, original_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?,?)", [tid, sid, name, req.file.path, cleanStr(req.file.originalname, 255), cleanStr(req.file.mimetype, 120), Number(req.file.size || 0), req.user.id]);
  ok(res, { ok: true, id: r.lastInsertRowid, documentName: name });
}));

router.get("/:id/documents/:documentId", requireRole("madrasa_admin", "teacher", "super_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const student = await db.get("SELECT id, class_id FROM students WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!student) return err(res, 404, "Document not found.");
  if (req.user.role === "teacher") { const scope = await getTeacherAssignments(tid, req.user.id); if (!scope.anyClassAnySubject && (!student.class_id || !scope.assignedClassIds.has(Number(student.class_id)))) return err(res, 404, "Document not found."); }
  const doc = await db.get("SELECT * FROM student_documents WHERE id = ? AND student_id = ? AND madrasa_id = ?", [toNum(req.params.documentId, 0), student.id, tid]);
  if (!doc || !fs.existsSync(doc.storage_path)) return err(res, 404, "Document not found.");
  res.download(doc.storage_path, doc.original_name || doc.document_name);
}));

router.delete("/:id/documents/:documentId", requireRole("madrasa_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const doc = await db.get("SELECT * FROM student_documents WHERE id = ? AND student_id = ? AND madrasa_id = ?", [toNum(req.params.documentId, 0), toNum(req.params.id, 0), tid]);
  if (!doc) return err(res, 404, "Document not found.");
  if (doc.storage_path && fs.existsSync(doc.storage_path)) fs.unlinkSync(doc.storage_path);
  await db.run("DELETE FROM student_documents WHERE id = ? AND madrasa_id = ?", [doc.id, tid]);
  ok(res, { ok: true });
}));

/* ------------------------------ photo ----------------------------------
   The student portrait is the one ID cards, registers and portals print, so it
   is written here rather than onto the login account. A student's own portal
   account may update its own picture through /api/auth/account/photo, which
   mirrors into this row; a parent may not (their account is a guardian view, not
   the student's identity).

   Three shapes are accepted by one endpoint so every client behaves the same:
     • multipart file (a camera shot or a picked file)
     • JSON { photoDataUrl } (an image cropped in the browser)
     • DELETE (back to initials)
-------------------------------------------------------------------------- */
const studentPhotoUploader = imageUploader("photos", "photo");

async function storeStudentPhoto(req, res, tid, student, buffer) {
  const previous = student.photo_path || "";
  const photoPath = await profileMedia.writeImage(buffer, "photos", { maxBytes: profileMedia.MAX_PHOTO_BYTES });
  await db.run("UPDATE students SET photo_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [photoPath, student.id, tid]);
  // Keep the linked login account's avatar in step, or the portal top bar
  // would go on showing the old face after a successful change.
  const account = await db.get("SELECT id, photo_path FROM users WHERE student_id = ? AND madrasa_id = ? AND role = 'student'", [student.id, tid]);
  if (account) {
    await db.run("UPDATE users SET photo_path = ? WHERE id = ?", [photoPath, account.id]);
    if (account.photo_path) profileMedia.deleteStored(account.photo_path);
  }
  if (previous) profileMedia.deleteStored(previous);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "student.photo.update", entity: "student", entityId: String(student.id), ip: req.ip });
  ok(res, { ok: true, photoPath });
}

router.post("/:id/photo", requireRole("madrasa_admin"), (req, res, next) => {
  if (req.is("multipart/form-data")) return studentPhotoUploader(req, res, next);
  next();
}, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const s = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!s) return res.status(404).json({ error: "Student not found." });
  if (req.file) return storeStudentPhoto(req, res, tid, s, fs.readFileSync(req.file.path));
  const dataUrl = (req.body && (req.body.photoDataUrl || req.body.dataUrl)) || "";
  if (!dataUrl) return err(res, 400, "No image uploaded.");
  return storeStudentPhoto(req, res, tid, s, profileMedia.decodeDataUrl(dataUrl, { maxBytes: profileMedia.MAX_PHOTO_BYTES }));
}));

router.delete("/:id/photo", requireRole("madrasa_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const s = await db.get("SELECT id, photo_path FROM students WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!s) return res.status(404).json({ error: "Student not found." });
  await db.run("UPDATE students SET photo_path = '', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [s.id, tid]);
  await db.run("UPDATE users SET photo_path = '' WHERE student_id = ? AND madrasa_id = ? AND role = 'student'", [s.id, tid]);
  if (s.photo_path) profileMedia.deleteStored(s.photo_path);
  ok(res, { ok: true, photoPath: "" });
}));

/** A student's own signature, on file for consent forms and exam cards. */
router.put("/:id/signature", requireRole("madrasa_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const s = await db.get("SELECT id, signature_path FROM students WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!s) return res.status(404).json({ error: "Student not found." });
  const dataUrl = (req.body && (req.body.signatureDataUrl || req.body.dataUrl)) || "";
  if (!dataUrl) return err(res, 400, "Draw a signature first.");
  const signaturePath = await profileMedia.saveDataUrl(dataUrl, "signatures", { maxBytes: profileMedia.MAX_SIGNATURE_BYTES });
  await db.run("UPDATE students SET signature_path = ? WHERE id = ? AND madrasa_id = ?", [signaturePath, s.id, tid]);
  if (s.signature_path) profileMedia.deleteStored(s.signature_path);
  ok(res, { ok: true, signaturePath });
}));

/* ------------------------------ portal account ------------------------- */

/**
 * Reads the login accounts attached to one student, for the student-profile
 * "Portal access" panel. Tenant id is always the SERVER-derived one; only
 * non-sensitive columns are selected (never password_hash).
 */
async function readPortalAccounts(tid, studentId) {
  const student = await db.get(
    "SELECT id, username, is_active, created_at FROM users WHERE student_id = ? AND madrasa_id = ? AND role = 'student'",
    [studentId, tid]
  );
  const parents = await db.all(
    `SELECT u.id, u.username, u.full_name, u.phone, u.is_active, u.created_at
       FROM parent_links pl JOIN users u ON u.id = pl.user_id AND u.madrasa_id = pl.madrasa_id
      WHERE pl.madrasa_id = ? AND pl.student_id = ? AND u.role = 'parent'
      ORDER BY u.username`,
    [tid, studentId]
  );
  for (const p of parents) {
    p.is_active = Number(p.is_active) === 1;
    p.children = await db.all(
      `SELECT s.id, s.first_name, s.last_name, s.admission_no
         FROM parent_links pl JOIN students s ON s.id = pl.student_id AND s.madrasa_id = pl.madrasa_id
        WHERE pl.madrasa_id = ? AND pl.user_id = ? ORDER BY s.first_name, s.last_name`,
      [tid, p.id]
    );
  }
  return {
    student: student ? { id: student.id, username: student.username, is_active: Number(student.is_active) === 1, created_at: student.created_at } : null,
    parents,
  };
}

/** Create (or reset) the student's portal login account. */
router.post("/:id/portal-account", requireRole("madrasa_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const s = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!s) return res.status(404).json({ error: "Student not found." });
  const b = req.body || {};
  const username = cleanStr(b.username, 100).toLowerCase();
  const password = String(b.password || "");
  if (!username || password.length < 8) return err(res, 400, "username and a password of at least 8 characters are required.");
  if (!/^[a-z0-9_.-]{3,}$/.test(username)) return err(res, 400, "Invalid username format.");
  const hash = await require("bcryptjs").hash(password, 10);

  const existing = await db.get("SELECT id FROM users WHERE student_id = ? AND madrasa_id = ? AND role = 'student'", [s.id, tid]);
  if (existing) {
    await db.run("UPDATE users SET username = ?, password_hash = ?, is_active = 1 WHERE id = ?", [username, hash, existing.id]);
    return ok(res, { ok: true, id: existing.id, created: false });
  }
  const clash = await db.get("SELECT id FROM users WHERE username = ?", [username]);
  if (clash) return err(res, 400, "That username is already taken.");
  const r = await db.run(
    "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, student_id) VALUES (?,?,?,?,?,?)",
    [tid, username, hash, "student", `${s.first_name} ${s.last_name}`.trim(), s.id]
  );
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "student.portal_account", entity: "user", entityId: String(r.lastInsertRowid), ip: req.ip });
  ok(res, { ok: true, id: r.lastInsertRowid, created: true });
}));

/** Create a parent account and link one or more students to it. */
router.post("/:id/parent-account", requireRole("madrasa_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const s = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!s) return res.status(404).json({ error: "Student not found." });
  const b = req.body || {};
  const username = cleanStr(b.username, 100).toLowerCase();
  const password = String(b.password || "");
  const studentIds = Array.isArray(b.student_ids) ? b.student_ids.map((x) => toNum(x, 0)).filter(Boolean) : [s.id];
  if (!username || password.length < 8) return err(res, 400, "username and a password of at least 8 characters are required.");
  if (!/^[a-z0-9_.-]{3,}$/.test(username)) return err(res, 400, "Invalid username format.");
  const clash = await db.get("SELECT id FROM users WHERE username = ?", [username]);
  if (clash) return err(res, 400, "That username is already taken.");
  const hash = await require("bcryptjs").hash(password, 10);
  const r = await db.run(
    "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, phone) VALUES (?,?,?,?,?,?)",
    [tid, username, hash, "parent", cleanStr(b.full_name, 160) || s.parent_name, cleanStr(b.phone, 60) || s.parent_phone]
  );
  for (const sid of studentIds) {
    const st = await db.get("SELECT id FROM students WHERE id = ? AND madrasa_id = ?", [sid, tid]);
    if (st) await db.insertIgnore("parent_links", "madrasa_id, user_id, student_id", [tid, r.lastInsertRowid, sid]);
  }
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "student.parent_account", entity: "user", entityId: String(r.lastInsertRowid), ip: req.ip });
  ok(res, { ok: true, id: r.lastInsertRowid });
}));

/* ------------------------------ import (CSV) --------------------------- */

/**
 * CSV columns: first_name,last_name,name_ar,gender,date_of_birth,class (name en),
 * parent_name,parent_phone,address
 * Class is matched by English name (created if missing is NOT automatic — must
 * pre-create classes). Duplicate admission numbers are never produced: each
 * import row gets the next sequential number.
 */
router.post("/import", requirePermission("students.import"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const text = String((req.body || {}).csv || (req.body || {}).file || "");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return err(res, 400, "No CSV content provided.");

  // Parse header
  function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  }
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const idx = (name) => header.indexOf(name);

  if (idx("first_name") === -1) {
    return err(res, 400, "CSV must have a first_name column (and optionally last_name, name_ar, gender, date_of_birth, class, parent_name, parent_phone, address).");
  }

  const classNames = new Map();
  const allClasses = await db.all("SELECT id, name_en FROM classes WHERE madrasa_id = ?", [tid]);
  allClasses.forEach((c) => classNames.set(c.name_en.toLowerCase(), c.id));

  const results = { inserted: 0, errors: [] };
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const get = (name) => (idx(name) >= 0 ? cols[idx(name)] || "" : "");
    const firstName = cleanStr(get("first_name"), 100);
    if (!firstName) { results.errors.push(`Line ${i + 1}: first_name required`); continue; }
    const dob = validDate(get("date_of_birth"));
    const clsName = cleanStr(get("class"), 120).toLowerCase();
    const classId = clsName ? classNames.get(clsName) : null;
    if (clsName && !classId) { results.errors.push(`Line ${i + 1}: unknown class "${get("class")}"`); continue; }

    const limitCheck = await checkPlanLimits(db, tid, "student");
    if (!limitCheck.allowed) { results.errors.push(`Line ${i + 1}: ${limitCheck.message}`); continue; }

    const { admissionNo } = await admission.nextAdmissionNo(tid);
    await db.run(
      `INSERT INTO students (madrasa_id, admission_no, first_name, last_name, name_ar, gender, date_of_birth, class_id, parent_name, parent_phone, address)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tid, admissionNo, firstName, cleanStr(get("last_name"), 100), cleanStr(get("name_ar"), 160),
        cleanStr(get("gender"), 10), dob, classId,
        cleanStr(get("parent_name"), 160), cleanStr(get("parent_phone"), 60), cleanStr(get("address"), 255),
      ]
    );
    results.inserted++;
  }
  await audit.record(req, { action: "student.import", module: "students", entity: "student", meta: { inserted: results.inserted, errors: results.errors.length } });
  ok(res, results);
}));

module.exports = router;
