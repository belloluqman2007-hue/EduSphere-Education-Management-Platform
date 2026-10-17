"use strict";
/* ============================================================================
   Complete Academic management
   ----------------------------------------------------------------------------
   Lessons and assignments extend the platform's original `homework` records;
   exams extend `exams`; marks continue to use the shared `results` gradebook.
   Every query is tenant-scoped and teacher writes are assignment-scoped.
   ========================================================================== */
const express = require("express");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const config = require("../config");
const { asyncHandler, err, ok, cleanStr, toNum, validDate, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments, teacherCanAccess } = require("../middleware/tenant");
const { fileUploader } = require("../middleware/upload");
const grading = require("../services/grading");
const { requireStaffPermission } = require("../services/permissions");
const { requireFeature } = require("../middleware/subscription");
const communication = require("../services/communication");

const router = express.Router();
router.use(requireAuth, requireTenant);
/* Online exams and the question bank are Premium ("randomisation, auto-grading,
   instant results, exam analytics"). Lessons and assignments are NOT gated —
   they are part of running a class on any plan. This router is mounted twice
   (/api/academic and the compatibility mount /api/exams), so the key is chosen
   from the full URL rather than from a single path prefix. */
router.use(requireFeature((req) => {
  const url = `${req.baseUrl || ""}${req.path || ""}`.replace(/\/+$/, "");
  if (/(^|\/)questions(\/|$)/.test(url)) return "question_bank";
  if (/(^|\/)exams(\/|$)/.test(url)) return "online_exams";
  if (url === "/api/academic" || url === "/api/exams") return "online_exams";
  return null;
}));
const ADMIN = requireRole("madrasa_admin", "super_admin");
const STAFF = requireRole("madrasa_admin", "teacher", "super_admin");
const attachmentUpload = fileUploader("files", "attachment", {
  dir: path.join(config.DATA_DIR, "private-academic-attachments"),
  extensions: [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv"],
  maxMb: 15,
});
const submissionUpload = fileUploader("submissions", "attachment", {
  dir: path.join(config.DATA_DIR, "private-assignment-submissions"),
  extensions: [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv"],
  maxMb: 15,
});

const TRACKS = new Set(["islamic", "western", "both"]);
const LESSON_STATUSES = new Set(["draft", "published", "completed", "archived"]);
const ASSIGNMENT_STATUSES = new Set(["draft", "published", "closed", "archived"]);
const EXAM_STATUSES = new Set(["draft", "scheduled", "ongoing", "completed", "published", "cancelled"]);
const EXAM_MODES = new Set(["offline", "online"]);
const ONLINE_EXAM_TYPES = new Set(["multiple_choice", "true_false", "short_answer", "long_answer", "essay", "fill_in_the_blank"]);
// A student may keep saving answers until the attempt expires; the SUBMIT
// window gets a short grace so a slow network never eats a finished paper.
// Everything is validated against SERVER time only.
const SUBMIT_GRACE_MS = 120 * 1000;

async function tenantId(req, res) {
  const id = effectiveTenantId(req);
  if (!id) { res.status(400).json({ error: "Institution context required." }); return null; }
  return Number(id);
}
function pick(body, snake, camel) { return body[snake] !== undefined ? body[snake] : body[camel]; }
function dateOrNull(value) { return value ? validDate(String(value).slice(0, 10)) : null; }
function timeOrEmpty(value) { const v = cleanStr(value, 5); return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : ""; }
function trackOf(value) { const v = cleanStr(value, 20).toLowerCase(); return TRACKS.has(v) ? v : "both"; }
function statusOf(kind, value, fallback) {
  const set = kind === "lesson" ? LESSON_STATUSES : ASSIGNMENT_STATUSES;
  const v = cleanStr(value, 20).toLowerCase();
  return set.has(v) ? v : fallback;
}
function pageInfo(req) {
  const page = Math.max(1, toNum(req.query.page, 1));
  const perPage = Math.min(100, Math.max(1, toNum(req.query.perPage, 20)));
  return { page, perPage, offset: (page - 1) * perPage };
}
function isAdmin(req) { return req.user.role === "madrasa_admin" || req.user.role === "super_admin"; }

async function academicRefs(tid, input, required = true) {
  const classId = toNum(pick(input, "class_id", "classId"), 0) || null;
  const subjectId = toNum(pick(input, "subject_id", "subjectId"), 0) || null;
  const sessionId = toNum(pick(input, "session_id", "sessionId"), 0) || null;
  const termId = toNum(pick(input, "term_id", "termId"), 0) || null;
  const teacherId = toNum(pick(input, "teacher_id", "teacherId"), 0) || null;
  if (required && (!classId || !subjectId)) return { error: "Class and subject are required." };
  const [cls, subject, session, term, teacher] = await Promise.all([
    classId ? db.get("SELECT id, name_en, education_track FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]) : null,
    subjectId ? db.get("SELECT id, name_en, education_track FROM subjects WHERE id = ? AND madrasa_id = ?", [subjectId, tid]) : null,
    sessionId ? db.get("SELECT id FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sessionId, tid]) : null,
    termId ? db.get("SELECT id, session_id FROM terms WHERE id = ? AND madrasa_id = ?", [termId, tid]) : null,
    teacherId ? db.get("SELECT id, full_name FROM users WHERE id = ? AND madrasa_id = ? AND role = 'teacher' AND is_active = 1", [teacherId, tid]) : null,
  ]);
  if (classId && !cls) return { error: "Class not found." };
  if (subjectId && !subject) return { error: "Subject not found." };
  if (sessionId && !session) return { error: "Academic session not found." };
  if (termId && !term) return { error: "Term not found." };
  if (term && sessionId && Number(term.session_id) !== sessionId) return { error: "The selected term does not belong to that academic session." };
  if (teacherId && !teacher) return { error: "Teacher not found." };
  return { classId, subjectId, sessionId: sessionId || (term ? Number(term.session_id) : null), termId, teacherId, cls, subject, teacher };
}

async function teacherMayUse(req, tid, classId, subjectId, teacherId) {
  if (isAdmin(req)) return true;
  if (req.user.role !== "teacher" || Number(teacherId || req.user.id) !== Number(req.user.id)) return false;
  const scope = await getTeacherAssignments(tid, req.user.id);
  return teacherCanAccess(scope, classId, subjectId);
}
function canChangeItem(req, item) {
  return isAdmin(req) || (req.user.role === "teacher" && Number(item.teacher_id || item.created_by) === Number(req.user.id));
}
async function addHistory(tid, entityType, entityId, action, userId, beforeStatus, afterStatus, summary) {
  await db.run("INSERT INTO academic_item_history (madrasa_id, entity_type, entity_id, action, from_status, to_status, summary, changed_by) VALUES (?,?,?,?,?,?,?,?)",
    [tid, entityType, entityId, action, beforeStatus || null, afterStatus || null, cleanStr(summary, 2000), userId]);
}

/* --------------------------- lessons / assignments -------------------- */
async function listItems(req, res, kind) {
  const tid = await tenantId(req, res); if (!tid) return;
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) return err(res, 403, "Staff access required.");
  const { page, perPage, offset } = pageInfo(req);
  const where = ["h.madrasa_id = ?", "h.kind = ?"]; const params = [tid, kind];
  if (req.query.includeArchived !== "true") where.push("h.status <> 'archived'");
  if (req.user.role === "teacher") { where.push("(h.teacher_id = ? OR (h.teacher_id IS NULL AND h.created_by = ?))"); params.push(req.user.id, req.user.id); }
  const filters = [["teacherId", "h.teacher_id"], ["classId", "h.class_id"], ["subjectId", "h.subject_id"], ["sessionId", "h.session_id"], ["termId", "h.term_id"]];
  for (const [query, column] of filters) if (req.query[query]) { where.push(`${column} = ?`); params.push(toNum(req.query[query], 0)); }
  if (req.query.status) { where.push("h.status = ?"); params.push(statusOf(kind, req.query.status, kind === "lesson" ? "draft" : "draft")); }
  if (req.query.from) { const d = validDate(req.query.from); if (d) { where.push(`COALESCE(h.${kind === "lesson" ? "lesson_date" : "assigned_date"}, h.created_at) >= ?`); params.push(d); } }
  if (req.query.to) { const d = validDate(req.query.to); if (d) { where.push(`COALESCE(h.${kind === "lesson" ? "lesson_date" : "due_date"}, h.created_at) <= ?`); params.push(d); } }
  const q = cleanStr(req.query.q || req.query.search, 120).toLowerCase();
  if (q) { const like = `%${q}%`; where.push("(LOWER(h.title) LIKE ? OR LOWER(h.topic) LIKE ? OR LOWER(h.details) LIKE ? OR LOWER(h.content) LIKE ?)"); params.push(like, like, like, like); }
  const sqlWhere = where.join(" AND ");
  const count = await db.get(`SELECT COUNT(*) AS n FROM homework h WHERE ${sqlWhere}`, params);
  const rows = await db.all(`SELECT h.*, c.name_en AS class_name, s.name_en AS subject_name, s.education_track AS subject_track,
      u.full_name AS teacher_name, a.label AS session_label, t.name_en AS term_name,
      (SELECT COUNT(*) FROM academic_attachments aa WHERE aa.madrasa_id=h.madrasa_id AND aa.entity_type=h.kind AND aa.entity_id=h.id) AS attachment_count,
      ${kind === "assignment" ? "(SELECT COUNT(*) FROM assignment_submissions x WHERE x.madrasa_id=h.madrasa_id AND x.assignment_id=h.id)" : "0"} AS submission_count
    FROM homework h
    LEFT JOIN classes c ON c.id=h.class_id AND c.madrasa_id=h.madrasa_id
    LEFT JOIN subjects s ON s.id=h.subject_id AND s.madrasa_id=h.madrasa_id
    LEFT JOIN users u ON u.id=h.teacher_id AND u.madrasa_id=h.madrasa_id
    LEFT JOIN academic_sessions a ON a.id=h.session_id AND a.madrasa_id=h.madrasa_id
    LEFT JOIN terms t ON t.id=h.term_id AND t.madrasa_id=h.madrasa_id
    WHERE ${sqlWhere} ORDER BY COALESCE(h.${kind === "lesson" ? "lesson_date" : "assigned_date"}, h.created_at) DESC, h.id DESC LIMIT ? OFFSET ?`, params.concat([perPage, offset]));
  const total = Number(count ? count.n : 0);
  ok(res, { [kind === "lesson" ? "lessons" : "assignments"]: rows, total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)) });
}
router.get("/lessons", requireStaffPermission("lessons.view"), asyncHandler((req, res) => listItems(req, res, "lesson")));
router.get("/assignments", requireStaffPermission("assignments.view"), asyncHandler((req, res) => listItems(req, res, "assignment")));

async function createItem(req, res, kind) {
  const tid = await tenantId(req, res); if (!tid) return;
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) return err(res, 403, "Staff access required.");
  const b = req.body || {}; const title = cleanStr(b.title, 200);
  if (!title) return err(res, 400, `${kind === "lesson" ? "Lesson" : "Assignment"} title is required.`);
  const refs = await academicRefs(tid, b, true); if (refs.error) return err(res, 400, refs.error);
  if (!refs.sessionId || !refs.termId) return err(res, 400, "Academic session and term are required.");
  const teacherId = req.user.role === "teacher" ? req.user.id : (refs.teacherId || req.user.id);
  if (!await teacherMayUse(req, tid, refs.classId, refs.subjectId, teacherId)) return err(res, 403, "You are not assigned to that class and subject.");
  const assignedDate = dateOrNull(pick(b, "assigned_date", "assignedDate"));
  const dueDate = dateOrNull(pick(b, "due_date", "dueDate"));
  const lessonDate = dateOrNull(pick(b, "lesson_date", "date") || b.lessonDate);
  if ((pick(b, "assigned_date", "assignedDate") && !assignedDate) || (pick(b, "due_date", "dueDate") && !dueDate) || ((pick(b, "lesson_date", "date") || b.lessonDate) && !lessonDate)) return err(res, 400, "Dates must use YYYY-MM-DD.");
  if (kind === "lesson" && !lessonDate) return err(res, 400, "Lesson date is required.");
  if (kind === "assignment" && (!assignedDate || !dueDate)) return err(res, 400, "Assigned date and due date are required.");
  if (assignedDate && dueDate && dueDate < assignedDate) return err(res, 400, "Due date cannot be before the assigned date.");
  const maximumScore = Math.max(1, Math.min(100000, Number(pick(b, "maximum_score", "maximumScore")) || 100));
  const status = statusOf(kind, b.status, "draft");
  const r = await db.run(`INSERT INTO homework
    (madrasa_id, class_id, subject_id, title, details, due_date, kind, created_by, teacher_id, topic, objectives, content,
     learning_materials, lesson_date, period, homework_text, assigned_date, maximum_score, session_id, term_id, status, education_track, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`, [
    tid, refs.classId, refs.subjectId, title, cleanStr(b.details || b.description || b.instructions, 10000), dueDate, kind, req.user.id,
    teacherId, cleanStr(b.topic, 255), cleanStr(b.objectives || b.lesson_objectives, 10000), cleanStr(b.content || b.lesson_content, 50000),
    cleanStr(b.learning_materials || b.materials, 10000), lessonDate, cleanStr(b.period, 40), cleanStr(b.homework || b.homework_text, 10000),
    assignedDate, maximumScore, refs.sessionId, refs.termId, status, trackOf(b.education_track || refs.subject?.education_track),
  ]);
  await db.insertIgnore("class_subjects", "madrasa_id, class_id, subject_id, session_id, term_id", [tid, refs.classId, refs.subjectId, refs.sessionId, refs.termId]);
  await addHistory(tid, kind, r.lastInsertRowid, "created", req.user.id, null, status, title);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: `${kind}.create`, entity: kind, entityId: String(r.lastInsertRowid), ip: req.ip });
  if (kind === "assignment" && status === "published") {
    await communication.notifyAudience(tid, { target_type: "specific_class", target_ids: [refs.classId] }, { type: "new_assignment", title: "New assignment published", body: `${title} is available for your class${dueDate ? ` until ${dueDate}` : ""}.`, entity_type: "assignment", entity_id: Number(r.lastInsertRowid) });
  }
  ok(res, { ok: true, id: r.lastInsertRowid, item: await db.get("SELECT * FROM homework WHERE id=? AND madrasa_id=?", [r.lastInsertRowid, tid]) });
}
router.post("/lessons", requireStaffPermission("lessons.create"), asyncHandler((req, res) => createItem(req, res, "lesson")));
router.post("/assignments", requireStaffPermission("assignments.create"), asyncHandler((req, res) => createItem(req, res, "assignment")));

async function loadItem(req, res, kind, id) {
  const tid = await tenantId(req, res); if (!tid) return null;
  const row = await db.get(`SELECT h.*, c.name_en AS class_name, s.name_en AS subject_name, u.full_name AS teacher_name,
      a.label AS session_label, t.name_en AS term_name
    FROM homework h LEFT JOIN classes c ON c.id=h.class_id AND c.madrasa_id=h.madrasa_id
    LEFT JOIN subjects s ON s.id=h.subject_id AND s.madrasa_id=h.madrasa_id
    LEFT JOIN users u ON u.id=h.teacher_id AND u.madrasa_id=h.madrasa_id
    LEFT JOIN academic_sessions a ON a.id=h.session_id AND a.madrasa_id=h.madrasa_id
    LEFT JOIN terms t ON t.id=h.term_id AND t.madrasa_id=h.madrasa_id
    WHERE h.id=? AND h.madrasa_id=? AND h.kind=?`, [toNum(id, 0), tid, kind]);
  if (!row || (req.user.role === "teacher" && Number(row.teacher_id || row.created_by) !== Number(req.user.id))) { err(res, 404, `${kind === "lesson" ? "Lesson" : "Assignment"} not found.`); return null; }
  return { tid, row };
}
async function itemDetail(req, res, kind) {
  const loaded = await loadItem(req, res, kind, req.params.id); if (!loaded) return;
  const [attachments, history] = await Promise.all([
    db.all("SELECT id, display_name, original_name, mime_type, file_size, created_at FROM academic_attachments WHERE madrasa_id=? AND entity_type=? AND entity_id=? ORDER BY id DESC", [loaded.tid, kind, loaded.row.id]),
    db.all(`SELECT h.*, u.full_name AS changed_by_name FROM academic_item_history h LEFT JOIN users u ON u.id=h.changed_by
      WHERE h.madrasa_id=? AND h.entity_type=? AND h.entity_id=? ORDER BY h.id DESC`, [loaded.tid, kind, loaded.row.id]),
  ]);
  ok(res, { [kind]: loaded.row, attachments, history });
}
router.get("/lessons/:id", requireStaffPermission("lessons.view"), asyncHandler((req, res) => itemDetail(req, res, "lesson")));
router.get("/assignments/:id", requireStaffPermission("assignments.view"), asyncHandler((req, res) => itemDetail(req, res, "assignment")));

async function updateItem(req, res, kind) {
  const loaded = await loadItem(req, res, kind, req.params.id); if (!loaded) return;
  const { tid, row } = loaded; if (!canChangeItem(req, row)) return err(res, 403, "You cannot edit this record.");
  const b = req.body || {}; const sets = []; const vals = [];
  const stringFields = [
    ["title", "title", 200], ["details", "details", 10000], ["description", "details", 10000], ["instructions", "details", 10000],
    ["topic", "topic", 255], ["objectives", "objectives", 10000], ["content", "content", 50000],
    ["learning_materials", "learning_materials", 10000], ["period", "period", 40], ["homework_text", "homework_text", 10000], ["homework", "homework_text", 10000],
  ];
  const seen = new Set();
  for (const [key, col, max] of stringFields) if (b[key] !== undefined && !seen.has(col)) { const value = cleanStr(b[key], max); if (col === "title" && !value) return err(res, 400, "Title is required."); sets.push(`${col}=?`); vals.push(value); seen.add(col); }
  for (const [key, col] of [["lesson_date", "lesson_date"], ["date", "lesson_date"], ["assigned_date", "assigned_date"], ["due_date", "due_date"]]) if (b[key] !== undefined && !seen.has(col)) { const value = dateOrNull(b[key]); if (b[key] && !value) return err(res, 400, "Dates must use YYYY-MM-DD."); sets.push(`${col}=?`); vals.push(value); seen.add(col); }
  if (b.status !== undefined) { sets.push("status=?"); vals.push(statusOf(kind, b.status, row.status)); }
  if (b.education_track !== undefined) { sets.push("education_track=?"); vals.push(trackOf(b.education_track)); }
  if (b.maximum_score !== undefined) { const score = Number(b.maximum_score); if (!(score > 0 && score <= 100000)) return err(res, 400, "Maximum score must be greater than zero."); sets.push("maximum_score=?"); vals.push(score); }
  const changesRefs = ["class_id", "subject_id", "session_id", "term_id", "teacher_id"].some((key) => b[key] !== undefined);
  if (changesRefs) {
    const merged = Object.assign({}, row, b); const refs = await academicRefs(tid, merged, true); if (refs.error) return err(res, 400, refs.error);
    if (!refs.sessionId || !refs.termId) return err(res, 400, "Academic session and term are required.");
    const teacherId = req.user.role === "teacher" ? req.user.id : (refs.teacherId || row.teacher_id || req.user.id);
    if (!await teacherMayUse(req, tid, refs.classId, refs.subjectId, teacherId)) return err(res, 403, "You are not assigned to that class and subject.");
    for (const [col, val] of [["class_id", refs.classId], ["subject_id", refs.subjectId], ["session_id", refs.sessionId], ["term_id", refs.termId], ["teacher_id", teacherId]]) { sets.push(`${col}=?`); vals.push(val); }
  }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  sets.push("updated_at=CURRENT_TIMESTAMP"); vals.push(row.id, tid);
  await db.run(`UPDATE homework SET ${sets.join(",")} WHERE id=? AND madrasa_id=?`, vals);
  const after = await db.get("SELECT * FROM homework WHERE id=? AND madrasa_id=?", [row.id, tid]);
  await addHistory(tid, kind, row.id, "updated", req.user.id, row.status, after.status, cleanStr(b.change_note, 2000) || `Updated ${after.title}`);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: `${kind}.update`, entity: kind, entityId: String(row.id), ip: req.ip });
  ok(res, { ok: true, item: after });
}
router.patch("/lessons/:id", requireStaffPermission("lessons.create"), asyncHandler((req, res) => updateItem(req, res, "lesson")));
router.patch("/assignments/:id", requireStaffPermission("assignments.create"), asyncHandler((req, res) => updateItem(req, res, "assignment")));

async function archiveItem(req, res, kind) {
  const loaded = await loadItem(req, res, kind, req.params.id); if (!loaded) return;
  if (!canChangeItem(req, loaded.row)) return err(res, 403, "You cannot archive this record.");
  await db.run("UPDATE homework SET status='archived', archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [loaded.row.id, loaded.tid]);
  await addHistory(loaded.tid, kind, loaded.row.id, "archived", req.user.id, loaded.row.status, "archived", cleanStr(req.body && req.body.note, 2000));
  ok(res, { ok: true, archived: true });
}
router.delete("/lessons/:id", requireStaffPermission("lessons.create"), asyncHandler((req, res) => archiveItem(req, res, "lesson")));
router.delete("/assignments/:id", requireStaffPermission("assignments.create"), asyncHandler((req, res) => archiveItem(req, res, "assignment")));

async function uploadItemAttachment(req, res, kind) {
  const loaded = await loadItem(req, res, kind, req.params.id); if (!loaded) return;
  if (!canChangeItem(req, loaded.row)) return err(res, 403, "You cannot attach files to this record.");
  if (!req.file) return err(res, 400, "Choose a file to upload.");
  const displayName = cleanStr(req.body && req.body.display_name, 200) || cleanStr(req.file.originalname, 200);
  const r = await db.run("INSERT INTO academic_attachments (madrasa_id,entity_type,entity_id,display_name,storage_path,original_name,mime_type,file_size,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)",
    [loaded.tid, kind, loaded.row.id, displayName, req.file.path, cleanStr(req.file.originalname, 255), cleanStr(req.file.mimetype, 120), Number(req.file.size || 0), req.user.id]);
  await addHistory(loaded.tid, kind, loaded.row.id, "attachment_added", req.user.id, loaded.row.status, loaded.row.status, displayName);
  ok(res, { ok: true, id: r.lastInsertRowid, displayName });
}
router.post("/lessons/:id/attachments", attachmentUpload, asyncHandler((req, res) => uploadItemAttachment(req, res, "lesson")));
router.post("/assignments/:id/attachments", attachmentUpload, asyncHandler((req, res) => uploadItemAttachment(req, res, "assignment")));
async function downloadItemAttachment(req, res, kind) {
  const loaded = await loadItem(req, res, kind, req.params.id); if (!loaded) return;
  const file = await db.get("SELECT * FROM academic_attachments WHERE id=? AND madrasa_id=? AND entity_type=? AND entity_id=?", [toNum(req.params.attachmentId, 0), loaded.tid, kind, loaded.row.id]);
  if (!file || !fs.existsSync(file.storage_path)) return err(res, 404, "Attachment not found.");
  res.download(file.storage_path, file.original_name || file.display_name);
}
router.get("/lessons/:id/attachments/:attachmentId", asyncHandler((req, res) => downloadItemAttachment(req, res, "lesson")));
router.get("/assignments/:id/attachments/:attachmentId", asyncHandler((req, res) => downloadItemAttachment(req, res, "assignment")));

/* -------------------------- assignment submissions --------------------- */
router.get("/assignments/:id/submissions", STAFF, requireStaffPermission("assignments.view"), asyncHandler(async (req, res) => {
  const loaded = await loadItem(req, res, "assignment", req.params.id); if (!loaded) return;
  const rows = await db.all(`SELECT st.id AS student_id, st.student_code, st.admission_no, st.first_name, st.last_name, st.photo_path,
      x.id AS submission_id, x.submission_text, x.original_name, x.submitted_at, x.status AS saved_status, x.score, x.feedback, x.graded_at,
      u.full_name AS graded_by_name
    FROM students st LEFT JOIN assignment_submissions x ON x.student_id=st.id AND x.assignment_id=? AND x.madrasa_id=st.madrasa_id
    LEFT JOIN users u ON u.id=x.graded_by
    WHERE st.madrasa_id=? AND st.class_id=? AND st.status IN ('active','promoted','suspended') ORDER BY st.admission_no`, [loaded.row.id, loaded.tid, loaded.row.class_id]);
  const due = loaded.row.due_date ? String(loaded.row.due_date).slice(0, 10) : "";
  rows.forEach((row) => {
    if (!row.submission_id) row.submission_status = "not_submitted";
    else if (row.saved_status === "graded" || row.score !== null) row.submission_status = "graded";
    else if (due && String(row.submitted_at || "").slice(0, 10) > due) row.submission_status = "late";
    else row.submission_status = "submitted";
  });
  ok(res, { assignment: loaded.row, submissions: rows, maximumScore: Number(loaded.row.maximum_score || 100) });
}));
router.put("/assignments/:id/submissions/:studentId", STAFF, requireStaffPermission("assignments.create"), asyncHandler(async (req, res) => {
  const loaded = await loadItem(req, res, "assignment", req.params.id); if (!loaded) return;
  if (!canChangeItem(req, loaded.row)) return err(res, 403, "You cannot grade this assignment.");
  const studentId = toNum(req.params.studentId, 0);
  if (!await db.get("SELECT id FROM students WHERE id=? AND madrasa_id=? AND class_id=?", [studentId, loaded.tid, loaded.row.class_id])) return err(res, 404, "Student not found in this class.");
  const score = Number(req.body && req.body.score);
  if (!Number.isFinite(score) || score < 0 || score > Number(loaded.row.maximum_score || 100)) return err(res, 400, `Score must be between 0 and ${Number(loaded.row.maximum_score || 100)}.`);
  const feedback = cleanStr(req.body && req.body.feedback, 5000);
  const existing = await db.get("SELECT id FROM assignment_submissions WHERE madrasa_id=? AND assignment_id=? AND student_id=?", [loaded.tid, loaded.row.id, studentId]);
  if (existing) await db.run("UPDATE assignment_submissions SET score=?, feedback=?, status='graded', graded_by=?, graded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?", [score, feedback, req.user.id, existing.id]);
  else await db.run("INSERT INTO assignment_submissions (madrasa_id,assignment_id,student_id,status,score,feedback,graded_by,graded_at,updated_at) VALUES (?,?,?,'graded',?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", [loaded.tid, loaded.row.id, studentId, score, feedback, req.user.id]);
  ok(res, { ok: true, status: "graded", score });
}));
router.post("/assignments/:id/submissions/me", submissionUpload, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  if (req.user.role !== "student" || !req.user.studentId) return err(res, 403, "Student account required.");
  const assignment = await db.get("SELECT * FROM homework WHERE id=? AND madrasa_id=? AND kind='assignment' AND status='published'", [toNum(req.params.id, 0), tid]);
  if (!assignment) return err(res, 404, "Published assignment not found.");
  const student = await db.get("SELECT id,class_id FROM students WHERE id=? AND madrasa_id=?", [req.user.studentId, tid]);
  if (!student || Number(student.class_id) !== Number(assignment.class_id)) return err(res, 404, "Assignment not found.");
  const text = cleanStr(req.body && req.body.submission_text, 20000);
  if (!text && !req.file) return err(res, 400, "Enter a response or attach a file.");
  const existing = await db.get("SELECT id,attachment_path FROM assignment_submissions WHERE madrasa_id=? AND assignment_id=? AND student_id=?", [tid, assignment.id, student.id]);
  const values = [text, req.file ? req.file.path : (existing ? existing.attachment_path : ""), req.file ? cleanStr(req.file.originalname, 255) : "", req.file ? cleanStr(req.file.mimetype, 120) : "", req.file ? Number(req.file.size || 0) : 0];
  if (existing) await db.run("UPDATE assignment_submissions SET submission_text=?,attachment_path=?,original_name=?,mime_type=?,file_size=?,submitted_at=CURRENT_TIMESTAMP,status='submitted',score=NULL,feedback=NULL,graded_by=NULL,graded_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?", values.concat([existing.id]));
  else await db.run("INSERT INTO assignment_submissions (madrasa_id,assignment_id,student_id,submission_text,attachment_path,original_name,mime_type,file_size,submitted_at,status,updated_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,'submitted',CURRENT_TIMESTAMP)", [tid, assignment.id, student.id].concat(values));
  ok(res, { ok: true, status: "submitted" });
}));
router.get("/assignments/:id/submissions/:studentId/attachment", STAFF, requireStaffPermission("assignments.view"), asyncHandler(async (req, res) => {
  const loaded = await loadItem(req, res, "assignment", req.params.id); if (!loaded) return;
  const sub = await db.get("SELECT * FROM assignment_submissions WHERE madrasa_id=? AND assignment_id=? AND student_id=?", [loaded.tid, loaded.row.id, toNum(req.params.studentId, 0)]);
  if (!sub || !sub.attachment_path || !fs.existsSync(sub.attachment_path)) return err(res, 404, "Submission attachment not found.");
  res.download(sub.attachment_path, sub.original_name || "submission");
}));

/* ------------------------------ question bank --------------------------- */
/*
 * A reusable bank of questions per subject and class level. It complements
 * the existing exams module (which owns scheduling, invigilation and marks)
 * without forcing an online-exam system: teachers build questions here and
 * reuse them when setting papers. Reads need questionbank.view; writes need
 * questionbank.manage; a teacher may only edit questions they created.
 */
const QUESTION_TYPES = new Set(["multiple_choice", "short_answer", "long_answer", "true_false", "fill_in_the_blank"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const QUESTION_STATUSES = new Set(["active", "archived"]);

async function questionInput(tid, body, current = {}) {
  const b = body || {};
  const text = cleanStr(b.question_text !== undefined ? b.question_text : current.question_text, 5000);
  if (!text) return { error: "Question text is required." };
  const typeRaw = cleanStr(b.question_type !== undefined ? b.question_type : current.question_type, 30);
  const type = QUESTION_TYPES.has(typeRaw) ? typeRaw : "short_answer";
  let options = b.options !== undefined ? b.options : current.options;
  if (options !== undefined && options !== null && typeof options !== "string") options = JSON.stringify(options);
  if (typeof options === "string" && options.length > 8000) return { error: "Options are too long." };
  const marks = Number(b.marks !== undefined ? b.marks : current.marks);
  if (!Number.isFinite(marks) || marks <= 0 || marks > 500) return { error: "Marks must be between 0.5 and 500." };
  const difficultyRaw = cleanStr(b.difficulty !== undefined ? b.difficulty : current.difficulty, 20);
  const difficulty = DIFFICULTIES.has(difficultyRaw) ? difficultyRaw : "medium";
  const statusRaw = cleanStr(b.status !== undefined ? b.status : current.status, 20);
  const status = QUESTION_STATUSES.has(statusRaw) ? statusRaw : "active";
  const subjectId = b.subject_id !== undefined ? (toNum(b.subject_id, 0) || null) : (current.subject_id || null);
  const classId = b.class_id !== undefined ? (toNum(b.class_id, 0) || null) : (current.class_id || null);
  if (subjectId && !await db.get("SELECT id FROM subjects WHERE id = ? AND madrasa_id = ?", [subjectId, tid])) return { error: "Unknown subject." };
  if (classId && !await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid])) return { error: "Unknown class." };
  return {
    text, type, options: options == null ? "" : String(options),
    correctAnswer: cleanStr(b.correct_answer !== undefined ? b.correct_answer : current.correct_answer, 2000),
    marks, difficulty, status, subjectId, classId,
    explanation: cleanStr(b.explanation !== undefined ? b.explanation : current.explanation, 5000),
    tags: cleanStr(b.tags !== undefined ? b.tags : current.tags, 255),
  };
}

router.get("/questions", STAFF, requireStaffPermission("questionbank.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const { page, perPage, offset } = pageInfo(req);
  const where = ["q.madrasa_id = ?"]; const params = [tid];
  if (req.query.includeArchived !== "true") where.push("q.status <> 'archived'");
  if (req.user.role === "teacher") where.push("(q.created_by = ? OR q.status = 'active')");
  if (req.user.role === "teacher") params.push(req.user.id);
  for (const [query, column, numeric] of [["subjectId", "q.subject_id", true], ["classId", "q.class_id", true], ["difficulty", "q.difficulty", false], ["type", "q.question_type", false]]) {
    if (req.query[query]) { where.push(`${column} = ?`); params.push(numeric ? toNum(req.query[query], 0) : cleanStr(req.query[query], 40)); }
  }
  const q = cleanStr(req.query.q || req.query.search, 120).toLowerCase();
  if (q) { const like = `%${q}%`; where.push("(LOWER(q.question_text) LIKE ? OR LOWER(q.tags) LIKE ?)"); params.push(like, like); }
  const sqlWhere = where.join(" AND ");
  const count = await db.get(`SELECT COUNT(*) AS n FROM question_bank q WHERE ${sqlWhere}`, params);
  const rows = await db.all(
    `SELECT q.*, s.name_en AS subject_name, c.name_en AS class_name, u.full_name AS created_by_name
       FROM question_bank q
       LEFT JOIN subjects s ON s.id = q.subject_id AND s.madrasa_id = q.madrasa_id
       LEFT JOIN classes c ON c.id = q.class_id AND c.madrasa_id = q.madrasa_id
       LEFT JOIN users u ON u.id = q.created_by
      WHERE ${sqlWhere} ORDER BY q.id DESC LIMIT ? OFFSET ?`,
    params.concat([perPage, offset])
  );
  const total = Number(count ? count.n : 0);
  ok(res, { questions: rows, total, page, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)) });
}));

router.post("/questions", STAFF, requireStaffPermission("questionbank.manage"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const input = await questionInput(tid, req.body);
  if (input.error) return err(res, 400, input.error);
  const r = await db.run(
    `INSERT INTO question_bank (madrasa_id, subject_id, class_id, question_text, question_type, options, correct_answer, marks, difficulty, explanation, tags, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [tid, input.subjectId, input.classId, input.text, input.type, input.options, input.correctAnswer, input.marks, input.difficulty, input.explanation, input.tags, input.status, req.user.id]
  );
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "question.create", entity: "question", entityId: String(r.lastInsertRowid), ip: req.ip });
  ok(res, { ok: true, id: Number(r.lastInsertRowid) });
}));

router.patch("/questions/:id", STAFF, requireStaffPermission("questionbank.manage"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const row = await db.get("SELECT * FROM question_bank WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!row) return err(res, 404, "Question not found.");
  if (req.user.role === "teacher" && Number(row.created_by) !== Number(req.user.id)) return err(res, 403, "You can only edit questions you created.");
  const input = await questionInput(tid, req.body, row);
  if (input.error) return err(res, 400, input.error);
  await db.run(
    `UPDATE question_bank SET subject_id=?, class_id=?, question_text=?, question_type=?, options=?, correct_answer=?, marks=?, difficulty=?, explanation=?, tags=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?`,
    [input.subjectId, input.classId, input.text, input.type, input.options, input.correctAnswer, input.marks, input.difficulty, input.explanation, input.tags, input.status, row.id, tid]
  );
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "question.update", entity: "question", entityId: String(row.id), ip: req.ip });
  ok(res, { ok: true });
}));

router.delete("/questions/:id", STAFF, requireStaffPermission("questionbank.manage"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const row = await db.get("SELECT * FROM question_bank WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!row) return err(res, 404, "Question not found.");
  if (req.user.role === "teacher" && Number(row.created_by) !== Number(req.user.id)) return err(res, 403, "You can only delete questions you created.");
  await db.run("UPDATE question_bank SET status='archived', updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [row.id, tid]);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "question.archive", entity: "question", entityId: String(row.id), ip: req.ip });
  ok(res, { ok: true, archived: true });
}));

/* ------------------------------ examinations --------------------------- */
async function examConflict(tid, exam, excludeId) {
  if (!exam.examDate || !exam.startTime || !exam.endTime) return null;
  const params = [tid, exam.examDate, exam.endTime, exam.startTime];
  let sql = `SELECT e.id,e.title,e.class_id,e.invigilator_id,e.classroom,e.start_time,e.end_time,c.name_en AS class_name
    FROM exams e LEFT JOIN classes c ON c.id=e.class_id
    WHERE e.madrasa_id=? AND e.exam_date=? AND e.status <> 'cancelled' AND e.start_time < ? AND e.end_time > ?`;
  if (excludeId) { sql += " AND e.id<>?"; params.push(excludeId); }
  const clashes = await db.all(sql, params);
  return clashes.find((row) => Number(row.class_id) === Number(exam.classId)
    || (exam.invigilatorId && Number(row.invigilator_id) === Number(exam.invigilatorId))
    || (exam.classroom && String(row.classroom).trim().toLowerCase() === String(exam.classroom).trim().toLowerCase())) || null;
}
async function examInput(tid, b, current = {}) {
  const refs = await academicRefs(tid, Object.assign({}, current, { teacher_id: current.invigilator_id || current.teacher_id }, b), true); if (refs.error) return refs;
  if (!refs.sessionId || !refs.termId) return { error: "Academic session and term are required." };
  const rawDate = pick(b, "exam_date", "examDate") !== undefined ? pick(b, "exam_date", "examDate") : current.exam_date;
  const examDate = dateOrNull(rawDate); if (rawDate && !examDate) return { error: "Exam date must use YYYY-MM-DD." };
  const rawStart = pick(b, "start_time", "startTime") !== undefined ? pick(b, "start_time", "startTime") : current.start_time;
  const rawEnd = pick(b, "end_time", "endTime") !== undefined ? pick(b, "end_time", "endTime") : current.end_time;
  const startTime = timeOrEmpty(rawStart); const endTime = timeOrEmpty(rawEnd);
  if ((rawStart && !startTime) || (rawEnd && !endTime)) return { error: "Exam times must use HH:MM." };
  if (startTime && endTime && endTime <= startTime) return { error: "End time must be after start time." };
  const statusRaw = b.status !== undefined ? b.status : current.status;
  const status = EXAM_STATUSES.has(cleanStr(statusRaw, 20).toLowerCase()) ? cleanStr(statusRaw, 20).toLowerCase() : "draft";
  const modeRaw = cleanStr(pick(b, "mode", "mode") !== undefined ? b.mode : current.mode, 20).toLowerCase();
  const mode = EXAM_MODES.has(modeRaw) ? modeRaw : "offline";
  return Object.assign(refs, {
    examDate, startTime, endTime,
    durationMinutes: startTime && endTime ? (Number(endTime.slice(0,2))*60+Number(endTime.slice(3))) - (Number(startTime.slice(0,2))*60+Number(startTime.slice(3))) : Math.max(0, toNum(pick(b,"duration_minutes","durationMinutes") || current.duration_minutes, 0)),
    invigilatorId: refs.teacherId || null,
    classroom: cleanStr(b.classroom !== undefined ? b.classroom : current.classroom, 120), status, mode,
  });
}
async function listExams(req, res) {
  const tid = await tenantId(req, res); if (!tid) return;
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) return err(res, 403, "Staff access required.");
  const { page, perPage, offset } = pageInfo(req); const where=["e.madrasa_id=?"]; const params=[tid];
  for (const [q,col] of [["classId","e.class_id"],["subjectId","e.subject_id"],["sessionId","e.session_id"],["termId","e.term_id"],["teacherId","e.invigilator_id"]]) if(req.query[q]){where.push(`${col}=?`);params.push(toNum(req.query[q],0));}
  if(req.query.status){where.push("e.status=?");params.push(cleanStr(req.query.status,20).toLowerCase());}
  if(req.query.from){const d=validDate(req.query.from);if(d){where.push("e.exam_date>=?");params.push(d);}}
  if(req.query.to){const d=validDate(req.query.to);if(d){where.push("e.exam_date<=?");params.push(d);}}
  const q=cleanStr(req.query.q||req.query.search,120).toLowerCase(); if(q){where.push("(LOWER(e.title) LIKE ? OR LOWER(e.classroom) LIKE ? OR LOWER(s.name_en) LIKE ? OR LOWER(c.name_en) LIKE ?)");const like=`%${q}%`;params.push(like,like,like,like);}
  if(req.user.role==="teacher"){where.push("(e.invigilator_id=? OR EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.madrasa_id=e.madrasa_id AND ta.user_id=? AND (ta.class_id=e.class_id OR ta.class_id IS NULL) AND (ta.subject_id=e.subject_id OR ta.subject_id IS NULL)))");params.push(req.user.id,req.user.id);}
  const w=where.join(" AND "); const count=await db.get(`SELECT COUNT(*) AS n FROM exams e LEFT JOIN classes c ON c.id=e.class_id LEFT JOIN subjects s ON s.id=e.subject_id WHERE ${w}`,params);
  const rows=await db.all(`SELECT e.*,c.name_en AS class_name,s.name_en AS subject_name,a.label AS session_label,t.name_en AS term_name,u.full_name AS invigilator_name,
      (SELECT COUNT(*) FROM results r WHERE r.madrasa_id=e.madrasa_id AND r.class_id=e.class_id AND r.subject_id=e.subject_id AND (e.term_id IS NULL OR r.term_id=e.term_id)) AS result_count
    FROM exams e LEFT JOIN classes c ON c.id=e.class_id AND c.madrasa_id=e.madrasa_id LEFT JOIN subjects s ON s.id=e.subject_id AND s.madrasa_id=e.madrasa_id
    LEFT JOIN academic_sessions a ON a.id=e.session_id LEFT JOIN terms t ON t.id=e.term_id LEFT JOIN users u ON u.id=e.invigilator_id
    WHERE ${w} ORDER BY e.exam_date DESC,e.start_time,e.id DESC LIMIT ? OFFSET ?`,params.concat([perPage,offset]));
  const total=Number(count?count.n:0); ok(res,{exams:rows,total,page,perPage,totalPages:Math.max(1,Math.ceil(total/perPage))});
}
router.get(["/exams", "/"], requireStaffPermission("exams.view"), asyncHandler(listExams));
router.post(["/exams", "/"], requireStaffPermission("exams.create"), asyncHandler(async(req,res)=>{
  const tid=await tenantId(req,res);if(!tid)return;
  // Administrators create examinations as before. A TEACHER may create one
  // only when the granular exams.create permission has been granted (it is
  // not a teacher default) and only for their own class/subject assignment.
  if(req.user.role==="teacher"){
    const b0=req.body||{};
    const refs=await academicRefs(tid,Object.assign({},b0,{teacher_id:req.user.id}),true);
    if(refs.error||!await teacherMayUse(req,tid,refs.classId,refs.subjectId,req.user.id))
      return err(res,403,"You are not assigned to that class and subject.");
  } else if(!isAdmin(req)) return err(res,403,"Staff access required.");
  const b=req.body||{};const title=cleanStr(b.title||b.name,200);if(!title)return err(res,400,"Examination name is required.");
  const input=await examInput(tid,b);if(input.error)return err(res,400,input.error);const conflict=await examConflict(tid,input,null);if(conflict)return err(res,409,`Timetable conflict with ${conflict.title} (${conflict.start_time}–${conflict.end_time}).`);
  const cfg=await grading.getGradingConfig(tid);const totalMarks=Number(pick(b,"total_marks","maximumMarks"))||cfg.examMax;
  if(!(totalMarks>0&&totalMarks<=cfg.examMax))return err(res,400,`Maximum marks must be between 1 and the configured examination maximum (${cfg.examMax}).`);
  // An online sitting must be takeable: date + time window are mandatory and
  // (when it goes live immediately) it needs at least one question.
  if(input.mode==="online"){
    if(!input.examDate||!input.startTime||!input.endTime)return err(res,400,"An online examination needs a date, a start time and an end time.");
    if(["scheduled","ongoing","published"].includes(input.status)){
      // A brand-new exam has no questions yet, so it can only start as a draft.
      return err(res,400,"An online examination needs at least one question before it can be scheduled or published. Create it as a draft first, add questions, then publish.");
    }
  }
  const r=await db.run(`INSERT INTO exams (madrasa_id,title,description,class_id,subject_id,session_id,term_id,exam_date,total_marks,status,created_by,start_time,end_time,duration_minutes,invigilator_id,classroom,instructions,education_track,mode,published_at,cancelled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[tid,title,cleanStr(b.description,5000),input.classId,input.subjectId,input.sessionId,input.termId,input.examDate,totalMarks,input.status,req.user.id,input.startTime,input.endTime,input.durationMinutes,input.invigilatorId,input.classroom,cleanStr(b.instructions,10000),trackOf(b.education_track||input.subject?.education_track),input.mode,input.status==="published"?new Date().toISOString().slice(0,19).replace("T"," "):null,input.status==="cancelled"?new Date().toISOString().slice(0,19).replace("T"," "):null]);
  await db.insertIgnore("class_subjects","madrasa_id,class_id,subject_id,session_id,term_id",[tid,input.classId,input.subjectId,input.sessionId,input.termId]);
  await addHistory(tid,"exam",r.lastInsertRowid,"created",req.user.id,null,input.status,title);logActivity(db,{madrasaId:tid,userId:req.user.id,action:"exam.create",entity:"exam",entityId:String(r.lastInsertRowid),meta:{mode:input.mode},ip:req.ip});
  if (["scheduled", "published"].includes(input.status)) await communication.notifyAudience(tid,{target_type:"specific_class",target_ids:[input.classId]},{type:"examination_scheduled",title:"Examination scheduled",body:`${title} is scheduled for ${input.examDate}.`,entity_type:"exam",entity_id:Number(r.lastInsertRowid)});
  ok(res,{ok:true,id:r.lastInsertRowid,exam:await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?",[r.lastInsertRowid,tid])});
}));
router.get(["/exams/:id", "/:id"], STAFF, requireStaffPermission("exams.view"), asyncHandler(async(req,res)=>{
  const tid=await tenantId(req,res);if(!tid)return;const exam=await db.get(`SELECT e.*,c.name_en AS class_name,s.name_en AS subject_name,a.label AS session_label,t.name_en AS term_name,u.full_name AS invigilator_name FROM exams e LEFT JOIN classes c ON c.id=e.class_id LEFT JOIN subjects s ON s.id=e.subject_id LEFT JOIN academic_sessions a ON a.id=e.session_id LEFT JOIN terms t ON t.id=e.term_id LEFT JOIN users u ON u.id=e.invigilator_id WHERE e.id=? AND e.madrasa_id=?`,[toNum(req.params.id,0),tid]);if(!exam)return err(res,404,"Examination not found.");
  const history=await db.all("SELECT h.*,u.full_name AS changed_by_name FROM academic_item_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.madrasa_id=? AND h.entity_type='exam' AND h.entity_id=? ORDER BY h.id DESC",[tid,exam.id]);ok(res,{exam,history});
}));
router.patch(["/exams/:id", "/:id"], requireStaffPermission("exams.create"), asyncHandler(async(req,res)=>{
  const tid=await tenantId(req,res);if(!tid)return;const id=toNum(req.params.id,0);const row=await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?",[id,tid]);if(!row)return err(res,404,"Examination not found.");
  if(req.user.role==="teacher"&&!await mayManageExam(req,tid,row))return err(res,404,"Examination not found.");
  if(!isAdmin(req)&&req.user.role!=="teacher")return err(res,403,"Staff access required.");
  const b=req.body||{};const input=await examInput(tid,b,row);if(input.error)return err(res,400,input.error);const conflict=await examConflict(tid,input,id);if(conflict)return err(res,409,`Timetable conflict with ${conflict.title} (${conflict.start_time}–${conflict.end_time}).`);
  const title=b.title!==undefined?cleanStr(b.title,200):row.title;if(!title)return err(res,400,"Examination name is required.");const total=b.total_marks!==undefined?Number(b.total_marks):Number(row.total_marks);const cfg=await grading.getGradingConfig(tid);if(!(total>0&&total<=cfg.examMax))return err(res,400,`Maximum marks must be between 1 and the configured examination maximum (${cfg.examMax}).`);
  // Publishing an online sitting requires a real, takeable paper. The check
  // runs only when the new state is online AND going live — drafts stay free.
  if(input.mode==="online"&&["scheduled","ongoing","published"].includes(input.status)){
    const q=await db.get("SELECT COUNT(*) AS n FROM exam_questions WHERE exam_id=? AND madrasa_id=?",[id,tid]);
    if(!q||Number(q.n)<1)return err(res,400,"An online examination needs at least one question before it can be scheduled or published. Add questions first.");
    if(!input.examDate||!input.startTime||!input.endTime)return err(res,400,"An online examination needs a date, a start time and an end time.");
    const attempted=await db.get("SELECT COUNT(*) AS n FROM exam_attempts WHERE exam_id=? AND madrasa_id=?",[id,tid]);
    if(Number(attempted.n)>0&&(input.classId!==Number(row.class_id)||input.subjectId!==Number(row.subject_id)))
      return err(res,409,"Students have already started this examination, so its class and subject can no longer change.");
  }
  await db.run(`UPDATE exams SET title=?,description=?,class_id=?,subject_id=?,session_id=?,term_id=?,exam_date=?,total_marks=?,status=?,start_time=?,end_time=?,duration_minutes=?,invigilator_id=?,classroom=?,instructions=?,education_track=?,mode=?,published_at=?,cancelled_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?`,[title,b.description!==undefined?cleanStr(b.description,5000):row.description,input.classId,input.subjectId,input.sessionId,input.termId,input.examDate,total,input.status,input.startTime,input.endTime,input.durationMinutes,input.invigilatorId,input.classroom,b.instructions!==undefined?cleanStr(b.instructions,10000):row.instructions,trackOf(b.education_track||row.education_track),input.mode,input.status==="published"?(row.published_at||new Date().toISOString().slice(0,19).replace("T"," ")):null,input.status==="cancelled"?(row.cancelled_at||new Date().toISOString().slice(0,19).replace("T"," ")):null,id,tid]);
  await addHistory(tid,"exam",id,"updated",req.user.id,row.status,input.status,cleanStr(b.change_note,2000)||`Updated ${title}`);
  // Going live with an online sitting notifies the class — the portal is the
  // only place the paper can be taken, so students must learn it exists.
  if(input.mode==="online"&&["scheduled","ongoing","published"].includes(input.status)&&!["scheduled","ongoing","published"].includes(row.status||"")){
    await communication.notifyAudience(tid,{target_type:"specific_class",target_ids:[input.classId]},{type:"online_exam_published",title:"Online examination available",body:`${title} can now be taken in your portal between ${input.startTime} and ${input.endTime} on ${input.examDate}.`,entity_type:"exam",entity_id:id});
  }
  ok(res,{ok:true,exam:await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?",[id,tid])});
}));
router.delete(["/exams/:id", "/:id"], requireStaffPermission("exams.create"), asyncHandler(async(req,res)=>{
  const tid=await tenantId(req,res);if(!tid)return;const id=toNum(req.params.id,0);const row=await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?",[id,tid]);if(!row)return err(res,404,"Examination not found.");
  if(req.user.role==="teacher"&&!await mayManageExam(req,tid,row))return err(res,404,"Examination not found.");
  if(!isAdmin(req)&&req.user.role!=="teacher")return err(res,403,"Staff access required.");
  await db.run("UPDATE exams SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",[id,tid]);await addHistory(tid,"exam",id,"cancelled",req.user.id,row.status,"cancelled",cleanStr(req.body&&req.body.note,2000));ok(res,{ok:true,cancelled:true});
}));

router.get(["/exams/:id/marks", "/:id/marks"], STAFF, requireStaffPermission("exams.view"), asyncHandler(async(req,res)=>{
  const tid=await tenantId(req,res);if(!tid)return;const exam=await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?",[toNum(req.params.id,0),tid]);if(!exam)return err(res,404,"Examination not found.");
  if(req.user.role==="teacher"){const scope=await getTeacherAssignments(tid,req.user.id);if(Number(exam.invigilator_id)!==Number(req.user.id)&&!teacherCanAccess(scope,exam.class_id,exam.subject_id))return err(res,404,"Examination not found.");}
  const rows=await db.all(`SELECT s.id AS student_id,s.admission_no,s.first_name,s.last_name,r.id AS result_id,r.exam,r.ca,r.total,r.status,r.teacher_remark FROM students s LEFT JOIN results r ON r.student_id=s.id AND r.madrasa_id=s.madrasa_id AND r.term_id=? AND r.subject_id=? WHERE s.madrasa_id=? AND s.class_id=? AND s.status IN ('active','promoted','suspended') ORDER BY s.admission_no`,[exam.term_id,exam.subject_id,tid,exam.class_id]);
  const cfg=await grading.getGradingConfig(tid);ok(res,{exam,students:rows,maximumMarks:Math.min(Number(exam.total_marks),cfg.examMax),config:{caMax:cfg.caMax,examMax:cfg.examMax}});
}));
router.put(["/exams/:id/marks", "/:id/marks"], STAFF, requireStaffPermission("results.enter"), asyncHandler(async(req,res)=>{
  const tid=await tenantId(req,res);if(!tid)return;const exam=await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?",[toNum(req.params.id,0),tid]);if(!exam)return err(res,404,"Examination not found.");
  if(req.user.role==="teacher"){const scope=await getTeacherAssignments(tid,req.user.id);if(!teacherCanAccess(scope,exam.class_id,exam.subject_id))return err(res,403,"You are not assigned to enter these marks.");}
  const cfg=await grading.getGradingConfig(tid);const max=Math.min(Number(exam.total_marks),cfg.examMax);const entries=Array.isArray(req.body&&req.body.entries)?req.body.entries:[];if(!entries.length||entries.length>500)return err(res,400,"Provide between 1 and 500 marks.");let updated=0;
  for(const entry of entries){const studentId=toNum(entry.studentId||entry.student_id,0);if(!await db.get("SELECT id FROM students WHERE id=? AND madrasa_id=? AND class_id=?",[studentId,tid,exam.class_id]))continue;const score=Number(entry.score!==undefined?entry.score:entry.exam);if(!Number.isFinite(score)||score<0||score>max)return err(res,400,`Examination scores must be between 0 and ${max}.`);const existing=await db.get("SELECT * FROM results WHERE madrasa_id=? AND student_id=? AND term_id=? AND subject_id=?",[tid,studentId,exam.term_id,exam.subject_id]);const ca=existing?Number(existing.ca):0;const total=Math.round((ca+score)*100)/100;const pct=grading.pctOf(cfg,total);const grade=grading.gradeForPct(cfg,pct);const point=grading.gradePointForPct?grading.gradePointForPct(cfg,pct):0;
    if(existing)await db.run("UPDATE results SET exam=?,total=?,grade=?,grade_point=?,teacher_remark=?,status='draft',modified_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[score,total,grade.grade,point,cleanStr(entry.remark||entry.teacher_remark,5000),req.user.id,existing.id]);else await db.run("INSERT INTO results (madrasa_id,student_id,class_id,session_id,term_id,subject_id,ca,exam,total,status,grade,grade_point,teacher_remark,entered_by,modified_by) VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?)",[tid,studentId,exam.class_id,exam.session_id,exam.term_id,exam.subject_id,0,score,total,grade.grade,point,cleanStr(entry.remark||entry.teacher_remark,5000),req.user.id,req.user.id]);updated++;}
  if(updated)await db.run("UPDATE term_summaries SET published_at=NULL WHERE madrasa_id=? AND class_id=? AND term_id=?",[tid,exam.class_id,exam.term_id]);
  logActivity(db,{madrasaId:tid,userId:req.user.id,action:"exam.marks",entity:"exam",entityId:String(exam.id),meta:{updated},ip:req.ip});ok(res,{ok:true,updated,status:"draft"});
}));

/* ==========================================================================
   ONLINE EXAMINATIONS
   ----------------------------------------------------------------------------
   An exam with mode='online' is taken in the student portal. Teachers/admins
   attach questions (written directly or imported from the question bank);
   students get exactly ONE attempt, server-validated timing, locked
   submissions and automatic grading of objective questions. Subjective
   answers are graded by the teacher. Correct answers never leave the staff
   API before the results are released.
   ========================================================================== */

/** A teacher may manage an exam when they are its invigilator or creator AND
 *  still hold the class/subject assignment. Admins manage everything in
 *  their tenant. */
async function mayManageExam(req, tid, exam) {
  if (isAdmin(req)) return true;
  if (req.user.role !== "teacher") return false;
  if (Number(exam.invigilator_id) !== Number(req.user.id) && Number(exam.created_by) !== Number(req.user.id)) return false;
  const scope = await getTeacherAssignments(tid, req.user.id);
  return teacherCanAccess(scope, exam.class_id, exam.subject_id);
}

/** Marks-entry style access (same rule as the offline marks gradebook): a
 *  teacher assigned to the exam's class+subject may view attempts, grade
 *  subjective answers and release results. */
async function mayWorkExam(req, tid, exam) {
  if (isAdmin(req)) return true;
  if (req.user.role !== "teacher") return false;
  const scope = await getTeacherAssignments(tid, req.user.id);
  return teacherCanAccess(scope, exam.class_id, exam.subject_id);
}

/** Server-side exam window: exam_date + start/end times, evaluated with the
 *  server clock only (never a client timestamp). */
function examWindow(exam) {
  if (!exam || !exam.exam_date || !exam.start_time || !exam.end_time) return null;
  const start = new Date(`${String(exam.exam_date).slice(0, 10)}T${String(exam.start_time).slice(0, 5)}:00`);
  const end = new Date(`${String(exam.exam_date).slice(0, 10)}T${String(exam.end_time).slice(0, 5)}:00`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  return { start, end };
}

/** Normalises an answer/correct-answer pair for objective auto-grading. */
function normalizeAnswer(value, options) {
  let v = String(value === null || value === undefined ? "" : value).trim();
  if (!v) return "";
  // A multiple-choice answer may arrive as the option text, its 1-based
  // index or its letter. Resolve indexes/letters to the option text so both
  // conventions grade identically.
  if (Array.isArray(options) && options.length) {
    const lower = v.toLowerCase();
    const byLetter = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
    let idx = /^\d+$/.test(v) ? Number(v) : (byLetter[lower] || 0);
    if (idx >= 1 && idx <= options.length) v = String(options[idx - 1]);
    else if (lower === "true" || lower === "false") {
      const match = options.find((o) => String(o).trim().toLowerCase() === lower);
      if (match !== undefined) v = String(match);
    }
  }
  return v.replace(/\s+/g, " ").toLowerCase();
}

/** Grades one objective answer. Subjective types return null (manual). */
function gradeAnswer(question, answerText) {
  if (!question || question.question_type === "long_answer" || question.question_type === "essay") return null;
  let options = question.options;
  if (typeof options === "string" && options.trim()) {
    try { options = JSON.parse(options); } catch (e) { options = null; }
  } else if (!Array.isArray(options)) options = null;
  const correct = normalizeAnswer(question.correct_answer, options);
  if (!correct) return null;
  const given = normalizeAnswer(answerText, options);
  if (!given) return false;
  return given === correct;
}

/** Sums the question marks of an exam (the live paper total). */
async function examQuestionTotal(tid, examId) {
  const r = await db.get("SELECT COALESCE(SUM(marks),0) AS total, COUNT(*) AS n FROM exam_questions WHERE exam_id=? AND madrasa_id=?", [examId, tid]);
  return { total: Number(r.total), count: Number(r.n) };
}

/** (Re)grades an attempt's objective answers and refreshes the score. */
async function regradeAttempt(tid, attempt) {
  const questions = await db.all("SELECT * FROM exam_questions WHERE exam_id=? AND madrasa_id=? ORDER BY position, id", [attempt.exam_id, tid]);
  const answers = await db.all("SELECT * FROM exam_answers WHERE attempt_id=? AND madrasa_id=?", [attempt.id, tid]);
  const byQuestion = new Map(answers.map((a) => [Number(a.exam_question_id), a]));
  let auto = 0, total = 0;
  for (const q of questions) {
    total += Number(q.marks);
    const a = byQuestion.get(Number(q.id));
    const objective = gradeAnswer(q, a ? a.answer_text : "");
    if (objective !== null) {
      const awarded = objective ? Number(q.marks) : 0;
      auto += awarded;
      if (a) {
        await db.run("UPDATE exam_answers SET is_correct=?, marks_awarded=?, graded_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
          [objective ? 1 : 0, awarded, a.id, tid]);
      }
    }
  }
  // score = auto (objective) + teacher-awarded subjective marks.
  const subjective = answers.filter((a) => a.marks_awarded !== null && a.marks_awarded !== undefined && a.is_correct === null)
    .reduce((sum, a) => sum + Number(a.marks_awarded), 0);
  const score = Math.round((auto + subjective) * 100) / 100;
  await db.run("UPDATE exam_attempts SET auto_score=?, score=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
    [Math.round(auto * 100) / 100, score, attempt.id, tid]);
  return { auto: Math.round(auto * 100) / 100, score, total: Math.round(total * 100) / 100 };
}

/* ------------------------- question management -------------------------- */

function parseOptions(options) {
  if (options === undefined || options === null) return "";
  if (typeof options === "string") return options.length > 8000 ? null : options;
  try { const s = JSON.stringify(options); return s.length > 8000 ? null : s; } catch (e) { return null; }
}

async function examQuestionInput(body, current = {}) {
  const b = body || {};
  const text = cleanStr(b.question_text !== undefined ? b.question_text : current.question_text, 5000);
  if (!text) return { error: "Question text is required." };
  const typeRaw = cleanStr(b.question_type !== undefined ? b.question_type : current.question_type, 30);
  const type = ONLINE_EXAM_TYPES.has(typeRaw) ? typeRaw : "multiple_choice";
  const options = parseOptions(b.options !== undefined ? b.options : current.options);
  if (options === null) return { error: "Options are too long." };
  if ((type === "multiple_choice" || type === "true_false") && options !== "") {
    let parsed = null;
    try { parsed = JSON.parse(options); } catch (e) { parsed = null; }
    if (!Array.isArray(parsed) || !parsed.length) return { error: "Multiple-choice and true/false questions need a list of options." };
  }
  const marks = Number(b.marks !== undefined ? b.marks : current.marks);
  if (!Number.isFinite(marks) || marks <= 0 || marks > 500) return { error: "Marks must be between 0.5 and 500." };
  return {
    text, type, options: options || "",
    correctAnswer: cleanStr(b.correct_answer !== undefined ? b.correct_answer : current.correct_answer, 2000),
    marks,
    explanation: cleanStr(b.explanation !== undefined ? b.explanation : current.explanation, 5000),
  };
}

router.get(["/exams/:id/questions"], STAFF, requireStaffPermission("exams.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const exam = await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!exam) return err(res, 404, "Examination not found.");
  if (req.user.role === "teacher" && !await mayManageExam(req, tid, exam)) {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!teacherCanAccess(scope, exam.class_id, exam.subject_id)) return err(res, 404, "Examination not found.");
  }
  const rows = await db.all("SELECT * FROM exam_questions WHERE exam_id=? AND madrasa_id=? ORDER BY position, id", [exam.id, tid]);
  const totals = await examQuestionTotal(tid, exam.id);
  ok(res, { exam: { id: exam.id, title: exam.title, mode: exam.mode, status: exam.status }, questions: rows, questionCount: totals.count, questionTotal: totals.total });
}));

router.post("/exams/:id/questions", requireStaffPermission("exams.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const exam = await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!exam) return err(res, 404, "Examination not found.");
  if (req.user.role === "teacher" && !await mayManageExam(req, tid, exam)) return err(res, 404, "Examination not found.");
  if (!isAdmin(req) && req.user.role !== "teacher") return err(res, 403, "Staff access required.");
  const attempted = await db.get("SELECT COUNT(*) AS n FROM exam_attempts WHERE exam_id=? AND madrasa_id=?", [exam.id, tid]);
  if (Number(attempted.n) > 0) return err(res, 409, "Students have already started this examination, so its questions are locked.");
  const b = req.body || {};
  let input, bankId = null;
  if (b.question_bank_id) {
    // Import an existing question-bank entry (tenant-scoped).
    const bank = await db.get("SELECT * FROM question_bank WHERE id=? AND madrasa_id=? AND status='active'", [toNum(b.question_bank_id, 0), tid]);
    if (!bank) return err(res, 404, "Question-bank entry not found.");
    bankId = bank.id;
    input = await examQuestionInput({
      question_text: bank.question_text, question_type: bank.question_type,
      options: bank.options, correct_answer: bank.correct_answer,
      marks: bank.marks, explanation: bank.explanation,
    });
  } else {
    input = await examQuestionInput(b);
  }
  if (input.error) return err(res, 400, input.error);
  if (["multiple_choice", "true_false"].includes(input.type) && !input.correctAnswer)
    return err(res, 400, "This question type needs the correct answer recorded for automatic grading.");
  const pos = await db.get("SELECT COALESCE(MAX(position),0) AS p FROM exam_questions WHERE exam_id=? AND madrasa_id=?", [exam.id, tid]);
  const r = await db.run(
    `INSERT INTO exam_questions (madrasa_id, exam_id, question_bank_id, position, question_text, question_type, options, correct_answer, marks, explanation, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [tid, exam.id, bankId, Number(pos.p) + 1, input.text, input.type, input.options, input.correctAnswer, input.marks, input.explanation, req.user.id]
  );
  // Keep the declared total in step with the paper while nobody has sat it.
  if (exam.mode === "online") {
    const totals = await examQuestionTotal(tid, exam.id);
    await db.run("UPDATE exams SET total_marks=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [totals.total, exam.id, tid]);
  }
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "exam.question.add", entity: "exam", entityId: String(exam.id), meta: { questionId: Number(r.lastInsertRowid), type: input.type }, ip: req.ip });
  ok(res, { ok: true, id: Number(r.lastInsertRowid) });
}));

router.patch("/exams/:id/questions/:questionId", requireStaffPermission("exams.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const row = await db.get("SELECT * FROM exam_questions WHERE id=? AND exam_id=? AND madrasa_id=?", [toNum(req.params.questionId, 0), toNum(req.params.id, 0), tid]);
  if (!row) return err(res, 404, "Question not found.");
  const exam = await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?", [row.exam_id, tid]);
  if (req.user.role === "teacher" && !await mayManageExam(req, tid, exam)) return err(res, 404, "Question not found.");
  const attempted = await db.get("SELECT COUNT(*) AS n FROM exam_attempts WHERE exam_id=? AND madrasa_id=?", [row.exam_id, tid]);
  if (Number(attempted.n) > 0) return err(res, 409, "Students have already started this examination, so its questions are locked.");
  const input = await examQuestionInput(req.body, row);
  if (input.error) return err(res, 400, input.error);
  await db.run("UPDATE exam_questions SET question_text=?, question_type=?, options=?, correct_answer=?, marks=?, explanation=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
    [input.text, input.type, input.options, input.correctAnswer, input.marks, input.explanation, row.id, tid]);
  if (exam && exam.mode === "online") {
    const totals = await examQuestionTotal(tid, exam.id);
    await db.run("UPDATE exams SET total_marks=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [totals.total, exam.id, tid]);
  }
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "exam.question.update", entity: "exam", entityId: String(row.exam_id), meta: { questionId: row.id }, ip: req.ip });
  ok(res, { ok: true });
}));

router.delete("/exams/:id/questions/:questionId", requireStaffPermission("exams.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const row = await db.get("SELECT * FROM exam_questions WHERE id=? AND exam_id=? AND madrasa_id=?", [toNum(req.params.questionId, 0), toNum(req.params.id, 0), tid]);
  if (!row) return err(res, 404, "Question not found.");
  const exam = await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?", [row.exam_id, tid]);
  if (req.user.role === "teacher" && !await mayManageExam(req, tid, exam)) return err(res, 404, "Question not found.");
  const attempted = await db.get("SELECT COUNT(*) AS n FROM exam_attempts WHERE exam_id=? AND madrasa_id=?", [row.exam_id, tid]);
  if (Number(attempted.n) > 0) return err(res, 409, "Students have already started this examination, so its questions are locked.");
  await db.run("DELETE FROM exam_questions WHERE id=? AND madrasa_id=?", [row.id, tid]);
  // Re-close the positions so the paper stays 1..n.
  const remaining = await db.all("SELECT id FROM exam_questions WHERE exam_id=? AND madrasa_id=? ORDER BY position, id", [row.exam_id, tid]);
  let p = 0;
  for (const q of remaining) { p += 1; await db.run("UPDATE exam_questions SET position=? WHERE id=? AND madrasa_id=?", [p, q.id, tid]); }
  if (exam && exam.mode === "online") {
    const totals = await examQuestionTotal(tid, exam.id);
    await db.run("UPDATE exams SET total_marks=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [totals.total, exam.id, tid]);
  }
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "exam.question.remove", entity: "exam", entityId: String(row.exam_id), meta: { questionId: row.id }, ip: req.ip });
  ok(res, { ok: true });
}));

/** Bulk-import questions from the tenant's question bank. */
router.post("/exams/:id/questions/import", requireStaffPermission("exams.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const exam = await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!exam) return err(res, 404, "Examination not found.");
  if (req.user.role === "teacher" && !await mayManageExam(req, tid, exam)) return err(res, 404, "Examination not found.");
  const attempted = await db.get("SELECT COUNT(*) AS n FROM exam_attempts WHERE exam_id=? AND madrasa_id=?", [exam.id, tid]);
  if (Number(attempted.n) > 0) return err(res, 409, "Students have already started this examination, so its questions are locked.");
  const ids = Array.isArray(req.body && req.body.question_ids) ? req.body.question_ids.map((x) => toNum(x, 0)).filter(Boolean).slice(0, 200) : [];
  if (!ids.length) return err(res, 400, "Select at least one question-bank entry to import.");
  const marks = `${ids.map(() => "?").join(",")}`;
  const bank = await db.all(`SELECT * FROM question_bank WHERE madrasa_id=? AND id IN (${marks}) AND status='active'`, [tid].concat(ids));
  if (!bank.length) return err(res, 404, "No matching question-bank entries.");
  let pos = Number((await db.get("SELECT COALESCE(MAX(position),0) AS p FROM exam_questions WHERE exam_id=? AND madrasa_id=?", [exam.id, tid])).p);
  for (const q of bank) {
    pos += 1;
    await db.run(
      `INSERT INTO exam_questions (madrasa_id, exam_id, question_bank_id, position, question_text, question_type, options, correct_answer, marks, explanation, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [tid, exam.id, q.id, pos, q.question_text, q.question_type, q.options || "", q.correct_answer || "", q.marks, q.explanation || "", req.user.id]
    );
  }
  if (exam.mode === "online") {
    const totals = await examQuestionTotal(tid, exam.id);
    await db.run("UPDATE exams SET total_marks=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [totals.total, exam.id, tid]);
  }
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "exam.question.import", entity: "exam", entityId: String(exam.id), meta: { imported: bank.length }, ip: req.ip });
  ok(res, { ok: true, imported: bank.length });
}));

/* --------------------------- attempts & grading -------------------------- */

router.get("/exams/:id/attempts", STAFF, requireStaffPermission("exams.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const exam = await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!exam) return err(res, 404, "Examination not found.");
  if (req.user.role === "teacher" && !await mayWorkExam(req, tid, exam)) return err(res, 404, "Examination not found.");
  const totals = await examQuestionTotal(tid, exam.id);
  const rows = await db.all(
    `SELECT a.*, s.admission_no, s.first_name, s.last_name
       FROM exam_attempts a JOIN students s ON s.id = a.student_id AND s.madrasa_id = a.madrasa_id
      WHERE a.exam_id=? AND a.madrasa_id=? ORDER BY s.admission_no LIMIT 500`,
    [exam.id, tid]
  );
  ok(res, {
    exam: { id: exam.id, title: exam.title, mode: exam.mode, status: exam.status, total_marks: exam.total_marks, results_released_at: exam.results_released_at },
    questionTotal: totals.total, questionCount: totals.count,
    attempts: rows.map((r) => ({
      id: r.id, student_id: r.student_id, admission_no: r.admission_no,
      name: `${r.first_name} ${r.last_name}`, status: r.status,
      started_at: r.started_at, submitted_at: r.submitted_at, expires_at: r.expires_at,
      auto_score: r.auto_score, score: r.score, graded: r.status === "graded",
    })),
  });
}));

router.get("/exams/:id/attempts/:attemptId", STAFF, requireStaffPermission("exams.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const exam = await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!exam) return err(res, 404, "Examination not found.");
  if (req.user.role === "teacher" && !await mayWorkExam(req, tid, exam)) return err(res, 404, "Examination not found.");
  const attempt = await db.get(
    `SELECT a.*, s.admission_no, s.first_name, s.last_name
       FROM exam_attempts a JOIN students s ON s.id = a.student_id AND s.madrasa_id = a.madrasa_id
      WHERE a.id=? AND a.exam_id=? AND a.madrasa_id=?`,
    [toNum(req.params.attemptId, 0), exam.id, tid]
  );
  if (!attempt) return err(res, 404, "Attempt not found.");
  const questions = await db.all("SELECT * FROM exam_questions WHERE exam_id=? AND madrasa_id=? ORDER BY position, id", [exam.id, tid]);
  const answers = await db.all("SELECT * FROM exam_answers WHERE attempt_id=? AND madrasa_id=?", [attempt.id, tid]);
  const byQuestion = new Map(answers.map((a) => [Number(a.exam_question_id), a]));
  ok(res, {
    attempt: {
      id: attempt.id, student_id: attempt.student_id, admission_no: attempt.admission_no,
      name: `${attempt.first_name} ${attempt.last_name}`, status: attempt.status,
      started_at: attempt.started_at, submitted_at: attempt.submitted_at,
      auto_score: attempt.auto_score, score: attempt.score,
    },
    exam: { id: exam.id, title: exam.title, results_released_at: exam.results_released_at },
    questions: questions.map((q) => {
      const a = byQuestion.get(Number(q.id));
      return {
        id: q.id, position: q.position, question_text: q.question_text, question_type: q.question_type,
        options: q.options, correct_answer: q.correct_answer, marks: q.marks,
        answer_text: a ? a.answer_text : "", is_correct: a ? a.is_correct : null,
        marks_awarded: a ? a.marks_awarded : null,
      };
    }),
  });
}));

/** Teacher/admin grading of subjective answers + overrides. */
router.put("/exams/:id/attempts/:attemptId/grade", requireStaffPermission("results.enter"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const exam = await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!exam) return err(res, 404, "Examination not found.");
  if (req.user.role === "teacher" && !await mayWorkExam(req, tid, exam)) return err(res, 403, "You are not assigned to grade this examination.");
  const attempt = await db.get("SELECT * FROM exam_attempts WHERE id=? AND exam_id=? AND madrasa_id=?", [toNum(req.params.attemptId, 0), exam.id, tid]);
  if (!attempt) return err(res, 404, "Attempt not found.");
  if (attempt.status !== "submitted" && attempt.status !== "graded") return err(res, 409, "Only a submitted attempt can be graded.");
  const entries = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
  if (!entries.length || entries.length > 200) return err(res, 400, "Provide between 1 and 200 answers to grade.");
  const questions = await db.all("SELECT * FROM exam_questions WHERE exam_id=? AND madrasa_id=?", [exam.id, tid]);
  const byId = new Map(questions.map((q) => [Number(q.id), q]));
  for (const entry of entries) {
    const q = byId.get(toNum(entry.question_id || entry.questionId, 0));
    if (!q) return err(res, 400, "One of the answers does not belong to this examination.");
    const awarded = Number(entry.marks_awarded !== undefined ? entry.marks_awarded : entry.marks);
    if (!Number.isFinite(awarded) || awarded < 0 || awarded > Number(q.marks))
      return err(res, 400, `Awarded marks must be between 0 and ${q.marks}.`);
  }
  for (const entry of entries) {
    const q = byId.get(toNum(entry.question_id || entry.questionId, 0));
    const awarded = Number(entry.marks_awarded !== undefined ? entry.marks_awarded : entry.marks);
    const existing = await db.get("SELECT * FROM exam_answers WHERE attempt_id=? AND exam_question_id=? AND madrasa_id=?", [attempt.id, q.id, tid]);
    if (existing) {
      await db.run("UPDATE exam_answers SET marks_awarded=?, graded_by=?, graded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
        [awarded, req.user.id, existing.id, tid]);
    } else {
      await db.run("INSERT INTO exam_answers (madrasa_id, attempt_id, exam_question_id, answer_text, marks_awarded, graded_by, graded_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
        [tid, attempt.id, q.id, "", awarded, req.user.id]);
    }
  }
  const result = await regradeAttempt(tid, attempt);
  await db.run("UPDATE exam_attempts SET status='graded', updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [attempt.id, tid]);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "exam.attempt.grade", entity: "exam", entityId: String(exam.id), meta: { attemptId: attempt.id, score: result.score }, ip: req.ip });
  ok(res, { ok: true, score: result.score, autoScore: result.auto, total: result.total });
}));

/** Releases results: students can then see their paper, per-question marks,
 *  correct answers and explanations. Audited and notified. */
router.post("/exams/:id/release-results", requireStaffPermission("exams.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (!tid) return;
  const exam = await db.get("SELECT * FROM exams WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!exam) return err(res, 404, "Examination not found.");
  if (req.user.role === "teacher" && !await mayWorkExam(req, tid, exam)) return err(res, 403, "You are not assigned to this examination.");
  if (exam.mode !== "online") return err(res, 400, "Only online examinations release paper results here.");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await db.run("UPDATE exams SET results_released_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [now, exam.id, tid]);
  await addHistory(tid, "exam", exam.id, "results_released", req.user.id, exam.status, exam.status, "Online examination results released");
  const attempts = await db.all("SELECT student_id FROM exam_attempts WHERE exam_id=? AND madrasa_id=?", [exam.id, tid]);
  const users = await db.all(
    `SELECT DISTINCT u.id AS user_id FROM users u WHERE u.madrasa_id=? AND (
       (u.role='student' AND u.student_id IN (${attempts.length ? attempts.map(() => "?").join(",") : "NULL"}))
       OR (u.role='parent' AND EXISTS (SELECT 1 FROM parent_links pl WHERE pl.madrasa_id=? AND pl.user_id=u.id AND pl.student_id IN (${attempts.length ? attempts.map(() => "?").join(",") : "NULL"})))
     )`,
    attempts.length ? [tid].concat(attempts.map((a) => a.student_id), tid, attempts.map((a) => a.student_id)) : [tid, tid]
  );
  if (users.length) {
    await communication.createNotifications(tid, users.map((u) => u.user_id), {
      type: "exam_results_released", title: "Examination results released",
      body: `Results for ${exam.title} are now available in your portal.`,
      entity_type: "exam", entity_id: exam.id,
    });
  }
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "exam.results.release", entity: "exam", entityId: String(exam.id), ip: req.ip });
  ok(res, { ok: true, released_at: now });
}));

module.exports = router;
