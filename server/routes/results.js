"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — Results & report card routes
   ----------------------------------------------------------------------------
   madrasa_admin: enter results for any class/subject/term in their madrasa.
   teacher:       only for (class, subject) pairs assigned to them.
   Both:          compute class term (totals, averages, positions, promotion)
                  and read printable report cards within the tenant.
   ========================================================================== */
const express = require("express");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const config = require("../config");
const { asyncHandler, err, ok, toNum, clampNum, logActivity } = require("../util");
const { requireAuth, requireTenant } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments, teacherCanAccess } = require("../middleware/tenant");
const grading = require("../services/grading");
const { fileUploader } = require("../middleware/upload");
const communication = require("../services/communication");
const { requirePermission, requireStaffPermission, can } = require("../services/permissions");
const audit = require("../services/audit");
const reportSheet = require("../services/report-sheet");

/* ----------------------------- result lifecycle -------------------------
   DRAFT → SUBMITTED → UNDER REVIEW → RETURNED | APPROVED → PUBLISHED → LOCKED

   Only the transitions below are legal, and each one names the permission it
   needs. Any other requested move is refused with 409 rather than silently
   applied, so a result can never skip review or be edited after locking.
------------------------------------------------------------------------- */
const RESULT_TRANSITIONS = {
  submit:    { from: ["draft", "returned"],            to: "submitted",    permission: "results.submit",  stamp: "submitted_at=CURRENT_TIMESTAMP" },
  review:    { from: ["submitted"],                    to: "under_review", permission: "results.approve", stamp: "reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP", extraParam: "user" },
  return:    { from: ["submitted", "under_review"],    to: "returned",     permission: "results.approve", stamp: "reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_note=?", extraParam: "user+note" },
  approve:   { from: ["submitted", "under_review"],    to: "approved",     permission: "results.approve", stamp: "approved_by=?,approved_at=CURRENT_TIMESTAMP", extraParam: "user" },
  publish:   { from: ["approved"],                     to: "published",    permission: "results.publish", stamp: "published_at=CURRENT_TIMESTAMP" },
  unpublish: { from: ["published"],                    to: "approved",     permission: "results.publish", stamp: "published_at=NULL" },
  lock:      { from: ["published"],                    to: "locked",       permission: "results.publish", stamp: "locked_by=?,locked_at=CURRENT_TIMESTAMP", extraParam: "user" },
  unlock:    { from: ["locked"],                       to: "published",    permission: "results.publish", stamp: "locked_by=NULL,locked_at=NULL" },
};

/** Statuses whose scores may no longer be changed by ordinary result entry. */
const FROZEN_STATUSES = ["published", "locked"];
const resultImport = fileUploader("imports", "file", { dir: path.join(config.DATA_DIR, "private-result-imports"), extensions: [".csv"], mimeTypes: ["text/csv", "application/vnd.ms-excel", "text/plain", "application/csv"], maxMb: 5 });

const router = express.Router();
router.use(requireAuth, requireTenant);
// The results workspace is STAFF-ONLY. requireStaffPermission (used per route
// below) deliberately lets student/parent roles through because some routers
// are shared with the portals — on its own that let an authenticated student
// read a classmate's report data through these staff endpoints (IDOR). The
// portals have their own /api/portal/* endpoints with record-level guards,
// so student/parent requests are refused here outright.
router.use((req, res, next) => {
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Permission denied." });
  }
  next();
});

function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); if (row.some((value) => value !== "")) rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); if (row.some((value) => value !== "")) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((value) => value.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] === undefined ? "" : values[index].trim()])));
}

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required." }); return null; }
  return tid;
}

/** Verifies caller may touch (classId, subjectId, termId); returns the class row or sends an error. */
async function guardAccess(req, res, tid, classId, subjectId, termId) {
  const cls = await db.get("SELECT * FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!cls) { res.status(404).json({ error: "Class not found." }); return null; }
  if (req.user.role === "teacher") {
    if (!subjectId) { res.status(404).json({ error: "Subject not found." }); return null; }
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!teacherCanAccess(scope, classId, subjectId)) {
      res.status(404).json({ error: "Not found." });
      return null;
    }
  }
  const term = await db.get("SELECT * FROM terms WHERE id = ? AND madrasa_id = ?", [termId, tid]);
  if (!term) { res.status(404).json({ error: "Term not found." }); return null; }
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) {
    res.status(403).json({ error: "Permission denied." });
    return null;
  }
  return cls;
}

/* ------------------------------ gradebook roster ---------------------- */

/**
 * GET /api/results/roster?classId=&termId=&subjectId=
 * Returns every active learner in the class, even before any score exists.
 * This is the authoritative gradebook input list; /class remains available
 * for integrations that only want saved result rows.
 */
router.get("/roster", requireStaffPermission("results.enter"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const classId = toNum(req.query.classId, 0);
  const termId = toNum(req.query.termId, 0);
  const subjectId = toNum(req.query.subjectId, 0);
  if (!classId || !termId || !subjectId) return err(res, 400, "classId, termId and subjectId are required.");
  const cls = await guardAccess(req, res, tid, classId, subjectId, termId);
  if (!cls) return;
  const subject = await db.get("SELECT id, name_en, name_ar FROM subjects WHERE id = ? AND madrasa_id = ?", [subjectId, tid]);
  if (!subject) return err(res, 404, "Subject not found.");
  const rows = await db.all(
    `SELECT s.id AS student_id, s.student_code, s.admission_no, s.first_name, s.last_name, s.name_ar,
            r.id AS result_id, r.ca, r.exam, r.total, r.status, r.grade, r.grade_point,
            r.teacher_remark, r.entered_by, r.modified_by, r.submitted_at, r.approved_at, r.published_at,
            eu.full_name AS entered_by_name, mu.full_name AS modified_by_name, au.full_name AS approved_by_name
       FROM students s
       LEFT JOIN results r ON r.madrasa_id = s.madrasa_id AND r.student_id = s.id
            AND r.term_id = ? AND r.subject_id = ?
       LEFT JOIN users eu ON eu.id = r.entered_by
       LEFT JOIN users mu ON mu.id = r.modified_by
       LEFT JOIN users au ON au.id = r.approved_by
      WHERE s.madrasa_id = ? AND s.class_id = ? AND s.status IN ('active','promoted','suspended')
      ORDER BY s.admission_no`,
    [termId, subjectId, tid, classId]
  );
  const cfg = await grading.getGradingConfig(tid);
  ok(res, { class: cls, subject, students: rows.map((r) => Object.assign({}, r, {
    ca: r.ca === null || r.ca === undefined ? "" : Number(r.ca),
    exam: r.exam === null || r.exam === undefined ? "" : Number(r.exam),
    total: r.total === null || r.total === undefined ? "" : Number(r.total),
    gradePoint: r.grade_point === null || r.grade_point === undefined ? "" : Number(r.grade_point),
    status: r.result_id ? (r.status || "approved") : "not_entered",
  })), config: { caMax: cfg.caMax, examMax: cfg.examMax, passMark: cfg.passMark, bands: cfg.bands } });
}));

/* ------------------------------ read class results --------------------- */

router.get("/class", requireStaffPermission("results.enter"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const classId = toNum(req.query.classId, 0);
  const termId = toNum(req.query.termId, 0);
  const subjectId = req.query.subjectId ? toNum(req.query.subjectId, 0) : null;
  if (!classId || !termId) return err(res, 400, "classId and termId are required.");
  const cls = await guardAccess(req, res, tid, classId, subjectId, termId);
  if (!cls) return;

  let where = "r.madrasa_id = ? AND r.term_id = ? AND r.class_id = ?";
  const params = [tid, termId, classId];
  if (subjectId) { where += " AND r.subject_id = ?"; params.push(subjectId); }
  const rows = await db.all(
    `SELECT r.*, su.name_en AS subject_en, su.name_ar AS subject_ar,
            s.admission_no, s.first_name, s.last_name, s.name_ar
     FROM results r
     JOIN students s ON s.id = r.student_id
     JOIN subjects su ON su.id = r.subject_id
     WHERE ${where}
     ORDER BY s.admission_no`,
    params
  );
  const cfg = await grading.getGradingConfig(tid);
  const students = rows.map((r) => Object.assign({}, r, {
    pct: grading.pctOf(cfg, r.total),
    grade: grading.gradeForPct(cfg, grading.pctOf(cfg, r.total)).grade,
  }));
  ok(res, { students, config: { caMax: cfg.caMax, examMax: cfg.examMax, passMark: cfg.passMark } });
}));

/* ------------------------------ bulk entry ----------------------------- */

/**
 * Body: { classId, termId, subjectId, entries: [{ studentId, ca, exam }] }
 * Upserts each entry. CA/exam are clamped to the madrasa's maxima.
 */
router.put("/", requireStaffPermission("results.enter"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const b = req.body || {};
  const classId = toNum(b.classId, 0);
  const termId = toNum(b.termId, 0);
  const subjectId = toNum(b.subjectId, 0);
  const entries = Array.isArray(b.entries) ? b.entries : [];
  if (!classId || !termId || !subjectId || !entries.length) {
    return err(res, 400, "classId, termId, subjectId and entries[] are required.");
  }
  if (entries.length > 500) return err(res, 400, "Too many entries in one request (max 500).");

  const cls = await guardAccess(req, res, tid, classId, subjectId, termId);
  if (!cls) return;
  const subj = await db.get("SELECT id FROM subjects WHERE id = ? AND madrasa_id = ?", [subjectId, tid]);
  if (!subj) return err(res, 404, { error: "Subject not found." });
  const cfg = await grading.getGradingConfig(tid);

  // Students in this class
  const classStudents = new Set(
    (await db.all("SELECT id FROM students WHERE madrasa_id = ? AND class_id = ? AND status IN ('active','promoted','suspended')", [tid, classId])).map((r) => r.id)
  );

  const requestedStatus = ["draft", "submitted"].includes(String(b.status || "draft").toLowerCase())
    ? String(b.status || "draft").toLowerCase() : "draft";
  const prepared = [];
  const errors = [];
  for (const entry of entries) {
    const studentId = toNum(entry.studentId || entry.student_id, 0);
    if (!classStudents.has(studentId)) { errors.push(`Student ${studentId} is not in this class.`); continue; }
    const ca = Number(entry.ca === "" || entry.ca === null || entry.ca === undefined ? 0 : entry.ca);
    const exam = Number(entry.exam === "" || entry.exam === null || entry.exam === undefined ? 0 : entry.exam);
    if (!Number.isFinite(ca) || ca < 0 || ca > cfg.caMax) errors.push(`CA for student ${studentId} must be between 0 and ${cfg.caMax}.`);
    if (!Number.isFinite(exam) || exam < 0 || exam > cfg.examMax) errors.push(`Exam score for student ${studentId} must be between 0 and ${cfg.examMax}.`);
    if (errors.length) continue;
    const total = Math.round((ca + exam) * 100) / 100;
    const pct = grading.pctOf(cfg, total);
    const grade = grading.gradeForPct(cfg, pct);
    prepared.push({ studentId, ca, exam, total, grade: grade.grade, point: grade.point, remark: String(entry.teacherRemark || entry.teacher_remark || "").slice(0, 5000) });
  }
  if (errors.length) return err(res, 400, errors.join(" "));
  const term = await db.get("SELECT session_id FROM terms WHERE id = ? AND madrasa_id = ?", [termId, tid]);

  // Published and locked results are final. Rather than silently overwriting
  // them, refuse the whole request and name the students involved so the
  // administrator can unpublish deliberately (which is itself audited).
  const frozen = await db.all(
    `SELECT student_id, status FROM results
      WHERE madrasa_id=? AND class_id=? AND term_id=? AND subject_id=? AND status IN ('published','locked')`,
    [tid, classId, termId, subjectId]
  );
  const frozenIds = new Set(frozen.map((r) => Number(r.student_id)));
  const blocked = prepared.filter((e) => frozenIds.has(Number(e.studentId)));
  if (blocked.length) {
    return err(res, 409, `${blocked.length} result(s) in this subject are already published or locked and cannot be changed. Unpublish them first.`, {
      code: "RESULTS_FROZEN",
      studentIds: blocked.map((e) => e.studentId),
    });
  }

  await db.transaction(async (tx) => {
    for (const entry of prepared) {
      const existing = await tx.get(
        "SELECT id, entered_by FROM results WHERE madrasa_id = ? AND student_id = ? AND term_id = ? AND subject_id = ?",
        [tid, entry.studentId, termId, subjectId]
      );
      if (existing) {
        await tx.run(`UPDATE results SET ca=?, exam=?, total=?, grade=?, grade_point=?, teacher_remark=?, status=?,
          entered_by=COALESCE(entered_by,?), modified_by=?, submitted_at=?, approved_by=NULL, approved_at=NULL, published_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [entry.ca, entry.exam, entry.total, entry.grade, entry.point, entry.remark, requestedStatus, req.user.id, req.user.id, requestedStatus === "submitted" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, existing.id]);
      } else {
        await tx.run(`INSERT INTO results (madrasa_id,student_id,class_id,session_id,term_id,subject_id,ca,exam,total,status,grade,grade_point,teacher_remark,entered_by,modified_by,submitted_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tid, entry.studentId, classId, term.session_id, termId, subjectId, entry.ca, entry.exam, entry.total, requestedStatus, entry.grade, entry.point, entry.remark, req.user.id, req.user.id, requestedStatus === "submitted" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null]);
      }
    }
  });
  const updated = prepared.length;
  if (updated) await db.run("UPDATE term_summaries SET published_at=NULL WHERE madrasa_id=? AND class_id=? AND term_id=?", [tid, classId, termId]);
  await audit.record(req, { action: requestedStatus === "submitted" ? "results.submit" : "results.entry", module: "academic", entity: "results", entityId: `${classId}:${termId}:${subjectId}`, after: { status: requestedStatus }, meta: { class_id: classId, term_id: termId, subject_id: subjectId, updated } });
  ok(res, { ok: true, updated, errors: [], status: requestedStatus });
}));

/* ------------------------------ CSV import ----------------------------- */
router.post("/import", requireStaffPermission("results.enter"), resultImport, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  if (!req.file) return err(res, 400, "Choose a CSV file.");
  try {
    const classId = toNum(req.body && (req.body.classId || req.body.class_id), 0);
    const termId = toNum(req.body && (req.body.termId || req.body.term_id), 0);
    const subjectId = toNum(req.body && (req.body.subjectId || req.body.subject_id), 0);
    if (!classId || !termId || !subjectId) return err(res, 400, "Class, term and subject are required for import.");
    const cls = await guardAccess(req, res, tid, classId, subjectId, termId); if (!cls) return;
    const cfg = await grading.getGradingConfig(tid);
    const parsed = parseCsv(fs.readFileSync(req.file.path, "utf8"));
    if (!parsed.length || parsed.length > 1000) return err(res, 400, "CSV must contain between 1 and 1000 data rows.");
    const students = await db.all("SELECT id,admission_no,student_code FROM students WHERE madrasa_id=? AND class_id=? AND status IN ('active','promoted','suspended')", [tid, classId]);
    const byCode = new Map(); students.forEach((student) => { byCode.set(String(student.id), student); byCode.set(String(student.admission_no || "").toLowerCase(), student); byCode.set(String(student.student_code || "").toLowerCase(), student); });
    const entries = []; const errors = [];
    parsed.forEach((row, index) => {
      const key = String(row.student_id || row.student_code || row.admission_no || "").toLowerCase(); const student = byCode.get(key);
      const ca = Number(row.ca); const exam = Number(row.exam || row.examination_score);
      if (!student) errors.push(`Row ${index + 2}: student was not found in this class.`);
      else if (!Number.isFinite(ca) || ca < 0 || ca > cfg.caMax) errors.push(`Row ${index + 2}: CA must be between 0 and ${cfg.caMax}.`);
      else if (!Number.isFinite(exam) || exam < 0 || exam > cfg.examMax) errors.push(`Row ${index + 2}: exam must be between 0 and ${cfg.examMax}.`);
      else entries.push({ studentId: Number(student.id), ca, exam, remark: String(row.teacher_remark || row.remark || "").slice(0, 5000) });
    });
    if (errors.length) return res.status(400).json({ error: "Import validation failed.", errors });
    const term = await db.get("SELECT session_id FROM terms WHERE id=? AND madrasa_id=?", [termId, tid]); const status = req.body.status === "submitted" ? "submitted" : "draft";
    await db.transaction(async (tx) => { for (const entry of entries) {
      const total = Math.round((entry.ca + entry.exam) * 100) / 100; const grade = grading.gradeForPct(cfg, grading.pctOf(cfg, total));
      const current = await tx.get("SELECT id FROM results WHERE madrasa_id=? AND student_id=? AND term_id=? AND subject_id=?", [tid, entry.studentId, termId, subjectId]);
      if (current) await tx.run("UPDATE results SET ca=?,exam=?,total=?,grade=?,grade_point=?,teacher_remark=?,status=?,modified_by=?,submitted_at=?,approved_by=NULL,approved_at=NULL,published_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?", [entry.ca, entry.exam, total, grade.grade, grade.point, entry.remark, status, req.user.id, status === "submitted" ? new Date().toISOString().slice(0,19).replace("T"," ") : null, current.id]);
      else await tx.run("INSERT INTO results (madrasa_id,student_id,class_id,session_id,term_id,subject_id,ca,exam,total,status,grade,grade_point,teacher_remark,entered_by,modified_by,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [tid, entry.studentId, classId, term.session_id, termId, subjectId, entry.ca, entry.exam, total, status, grade.grade, grade.point, entry.remark, req.user.id, req.user.id, status === "submitted" ? new Date().toISOString().slice(0,19).replace("T"," ") : null]);
    }});
    await db.run("UPDATE term_summaries SET published_at=NULL WHERE madrasa_id=? AND class_id=? AND term_id=?", [tid, classId, termId]);
    logActivity(db, { madrasaId: tid, userId: req.user.id, action: "results.import", entity: "results", entityId: `${classId}:${termId}:${subjectId}`, meta: { imported: entries.length }, ip: req.ip });
    ok(res, { ok: true, imported: entries.length, status });
  } finally { try { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (_) { /* cleanup only */ } }
}));

/* ------------------------------ moderation workflow -------------------- */
/*
   The complete result lifecycle. Every stage checks a granular permission on
   the server, and every stage writes an audit record with the previous and
   new status — including the exceptional moves (unpublish, unlock) that
   reopen an otherwise final result.
*/
router.post("/workflow", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const classId = toNum(b.classId || b.class_id, 0);
  const termId = toNum(b.termId || b.term_id, 0);
  const subjectId = toNum(b.subjectId || b.subject_id, 0);
  const action = String(b.action || "").toLowerCase();
  const note = String(b.note || b.review_note || "").slice(0, 2000);

  const transition = RESULT_TRANSITIONS[action];
  if (!classId || !termId || !subjectId || !transition) {
    return err(res, 400, `classId, termId, subjectId and a valid action (${Object.keys(RESULT_TRANSITIONS).join(", ")}) are required.`);
  }
  const cls = await guardAccess(req, res, tid, classId, subjectId, termId); if (!cls) return;

  // Server-side permission check for this specific stage.
  if (!(await can(req, transition.permission))) {
    return err(res, 403, "You do not have permission to perform this action.", { requiredPermission: transition.permission });
  }
  // A teacher may only move their OWN entries forward to submitted.
  if (req.user.role === "teacher" && !["submit"].includes(action)) {
    return err(res, 403, "Teachers may submit results for review; approval and publishing are done by the administration.");
  }
  if (action === "return" && !note) {
    return err(res, 400, "Explain what must be corrected before returning results to the teacher.");
  }

  // Report what is actually there, so an illegal move gets a useful 409
  // instead of a bare "nothing to do".
  const present = await db.all(
    "SELECT status, COUNT(*) AS n FROM results WHERE madrasa_id=? AND class_id=? AND term_id=? AND subject_id=? GROUP BY status",
    [tid, classId, termId, subjectId]
  );
  if (!present.length) return err(res, 404, "No results have been entered for this class, subject and term yet.");

  const params = [transition.to];
  if (transition.extraParam === "user") params.push(req.user.id);
  if (transition.extraParam === "user+note") params.push(req.user.id, note);
  params.push(req.user.id, tid, classId, termId, subjectId, ...transition.from);
  const placeholders = transition.from.map(() => "?").join(",");

  const result = await db.run(
    `UPDATE results SET status=?,${transition.stamp},modified_by=?,updated_at=CURRENT_TIMESTAMP
      WHERE madrasa_id=? AND class_id=? AND term_id=? AND subject_id=? AND status IN (${placeholders})`,
    params
  );
  if (!result.changes) {
    return err(res, 409, `No results are in a state that can be ${action}ed. Current state: ` +
      present.map((r) => `${r.n} ${r.status}`).join(", ") + ".", {
      code: "INVALID_STATUS_TRANSITION",
      expected: transition.from,
      current: present.map((r) => ({ status: r.status, count: Number(r.n) })),
    });
  }
  if (action === "unpublish") {
    await db.run("UPDATE term_summaries SET published_at=NULL WHERE madrasa_id=? AND class_id=? AND term_id=?", [tid, classId, termId]);
  }

  await audit.record(req, {
    action: `results.${action}`, module: "academic", entity: "results",
    entityId: `${classId}:${termId}:${subjectId}`,
    before: { statuses: present.map((r) => ({ status: r.status, count: Number(r.n) })) },
    after: { status: transition.to, count: result.changes },
    meta: { class_id: classId, term_id: termId, subject_id: subjectId, note: note || undefined },
  });
  ok(res, { ok: true, action, status: transition.to, count: result.changes });
}));

/* ------------------------------ compute term --------------------------- */

router.post("/compute", requireStaffPermission("results.enter"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const b = req.body || {};
  const classId = toNum(b.classId, 0);
  const termId = toNum(b.termId, 0);
  if (!classId || !termId) return err(res, 400, "classId and termId are required.");
  const cls = await guardAccess(req, res, tid, classId, null, termId);
  if (!cls) return;
  const out = await grading.computeClassTerm(tid, classId, termId, req.user.id);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "results.compute", entity: "class_term", meta: { class_id: classId, term_id: termId }, ip: req.ip });
  ok(res, out);
}));

/* ------------------------------ class term summary --------------------- */

router.get("/summary", requireStaffPermission("report_cards.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const classId = toNum(req.query.classId, 0);
  const termId = toNum(req.query.termId, 0);
  if (!classId || !termId) return err(res, 400, "classId and termId are required.");
  const rows = await db.all(
    `SELECT ts.*, s.admission_no, s.first_name, s.last_name, s.name_ar, s.photo_path
     FROM term_summaries ts JOIN students s ON s.id = ts.student_id
     WHERE ts.madrasa_id = ? AND ts.class_id = ? AND ts.term_id = ?
     ORDER BY ts.position`,
    [tid, classId, termId]
  );
  ok(res, { students: rows });
}));

/* ------------------------------ comments & publishing ------------------ */

router.put("/summary/:studentId", requireStaffPermission("results.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const b = req.body || {};
  const studentId = toNum(req.params.studentId, 0);
  const termId = toNum(b.termId, 0);
  if (!studentId || !termId) return err(res, 400, "termId is required.");
  const row = await db.get(
    "SELECT * FROM term_summaries WHERE madrasa_id = ? AND student_id = ? AND term_id = ?",
    [tid, studentId, termId]
  );
  if (!row) return res.status(404).json({ error: "Summary not found — run compute first." });
  const sets = [];
  const vals = [];
  if (b.teacher_comment !== undefined) { sets.push("teacher_comment = ?"); vals.push(String(b.teacher_comment).slice(0, 2000)); }
  if (b.head_comment !== undefined) { sets.push("head_comment = ?"); vals.push(String(b.head_comment).slice(0, 2000)); }
  if (b.attendance_days !== undefined) { sets.push("attendance_days = ?"); vals.push(clampNum(b.attendance_days, 0, 365, 0)); }
  // The four lifecycle statuses the engine computes stay primary; the extra
  // values below are manual decisions an administrator may record on the
  // existing summary row (no second promotion system is created).
  if (b.promotion_status !== undefined && ["promoted", "repeating", "graduated", "pending", "promoted_trial", "withdrawn", "completed"].includes(b.promotion_status)) {
    sets.push("promotion_status = ?"); vals.push(b.promotion_status);
  }
  if (b.behaviour !== undefined && b.behaviour !== null && typeof b.behaviour === "object") {
    // Only the institution's configured categories, rated 1–5, are stored.
    const template = await reportSheet.getReportTemplate(tid);
    const ratings = {};
    for (const cat of template.behaviourCategories) {
      const v = Number(b.behaviour[cat.key]);
      if (Number.isInteger(v) && v >= 1 && v <= 5) ratings[cat.key] = v;
    }
    sets.push("behaviour_ratings = ?"); vals.push(JSON.stringify(ratings));
  }
  if (b.publish !== undefined) {
    if (!(await can(req, "results.publish"))) return err(res, 403, "You do not have permission to publish report cards.", { requiredPermission: "results.publish" });
    sets.push(b.publish ? "published_at = CURRENT_TIMESTAMP" : "published_at = NULL");
  }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  vals.push(row.id);
  await db.run(`UPDATE term_summaries SET ${sets.join(", ")} WHERE id = ?`, vals);
  await audit.record(req, { action: "results.summary", module: "academic", entity: "term_summary", entityId: row.id, before: { published_at: row.published_at, promotion_status: row.promotion_status }, after: { updated: sets.length } });
  ok(res, { ok: true });
}));

/**
 * PUT|POST /results/summaries/publish   { classId, termId, publish = true }
 *
 * Publishes (or retracts) the whole class for a term in one action. Publishing
 * recomputes the summaries, stamps published_at, and is what makes results
 * visible to the student/parent portals and to the public result checker;
 * retracting clears the stamp so a wrong result can be fixed and republished.
 */
async function publishSummaries(req, res) {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  if (!(await can(req, "results.publish"))) {
    return res.status(403).json({ error: "Only the madrasa administration may publish results.", requiredPermission: "results.publish" });
  }
  const b = req.body || {};
  const classId = toNum(b.classId !== undefined ? b.classId : req.query.classId, 0);
  const termId = toNum(b.termId !== undefined ? b.termId : req.query.termId, 0);
  const publish = b.publish !== false;
  if (!classId || !termId) return err(res, 400, "classId and termId are required.");
  const cls = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!cls) return err(res, 404, "Class not found in your madrasa.");
  const term = await db.get("SELECT id FROM terms WHERE id = ? AND madrasa_id = ?", [termId, tid]);
  if (!term) return err(res, 404, "Term not found in your madrasa.");

  let count = 0;
  if (publish) {
    const pending = await db.get("SELECT COUNT(*) AS n FROM results WHERE madrasa_id=? AND class_id=? AND term_id=? AND status NOT IN ('approved','published','locked')", [tid, classId, termId]);
    if (Number(pending && pending.n || 0) > 0) return err(res, 409, "Submit and approve every result before publishing report cards.");
    await grading.computeClassTerm(tid, classId, termId, req.user.id);
    await db.run("UPDATE results SET status='published',published_at=CURRENT_TIMESTAMP,modified_by=?,updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=? AND class_id=? AND term_id=? AND status='approved'", [req.user.id, tid, classId, termId]);
    await db.run(
      `UPDATE term_summaries SET published_at = CURRENT_TIMESTAMP
       WHERE madrasa_id = ? AND class_id = ? AND term_id = ?`,
      [tid, classId, termId]
    );
    const n = await db.get(
      "SELECT COUNT(*) AS n FROM term_summaries WHERE madrasa_id = ? AND class_id = ? AND term_id = ? AND published_at IS NOT NULL",
      [tid, classId, termId]
    );
    count = n ? Number(n.n) : 0;
    if (!count) return err(res, 400, "No results to publish for this class and term yet.");
  } else {
    await db.run("UPDATE results SET status='approved',published_at=NULL,modified_by=?,updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=? AND class_id=? AND term_id=? AND status='published'", [req.user.id, tid, classId, termId]);
    await db.run(
      "UPDATE term_summaries SET published_at = NULL WHERE madrasa_id = ? AND class_id = ? AND term_id = ?",
      [tid, classId, termId]
    );
    const n = await db.get(
      "SELECT COUNT(*) AS n FROM term_summaries WHERE madrasa_id = ? AND class_id = ? AND term_id = ?",
      [tid, classId, termId]
    );
    count = n ? Number(n.n) : 0;
  }
  logActivity(db, {
    madrasaId: tid, userId: req.user.id,
    action: publish ? "results.publish" : "results.unpublish",
    entity: "term_summary", entityId: `${classId}:${termId}`, meta: { count }, ip: req.ip,
  });
  if (publish) await communication.notifyAudience(tid, { target_type: "specific_class", target_ids: [classId] }, { type: "result_published", title: "Result published", body: "A report card result is now available in the student and parent portal.", entity_type: "term_summary", entity_id: termId });
  ok(res, { ok: true, published: publish, count });
}

const publishHandler = asyncHandler(publishSummaries);
router.put("/summaries/publish", publishHandler);
router.post("/summaries/publish", publishHandler);

/* ------------------------------ report card ---------------------------- */

async function loadReportData(req, res, studentId, termId) {
  const tid = await tenantId(req, res);
  if (tid == null) return null;
  const data = await grading.reportCardData(tid, studentId, termId);
  if (!data) { res.status(404).json({ error: "Report card not found." }); return null; }
  // Teacher may only see report cards for assigned classes
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!scope.anyClassAnySubject && !scope.assignedClassIds.has(Number(data.student.classId || 0))) {
      res.status(404).json({ error: "Not found." });
      return null;
    }
  }
  return data;
}

router.get("/report-card-data/:studentId/:termId", requireStaffPermission("report_cards.view"), asyncHandler(async (req, res) => {
  const data = await loadReportData(req, res, toNum(req.params.studentId, 0), toNum(req.params.termId, 0));
  if (!data) return;
  ok(res, data);
}));

/**
 * Authorises a staff request for one student's report sheet: the student must
 * belong to the caller's tenant, and a teacher must be assigned to the
 * student's class. Returns the student row (for id/class context) or null
 * after sending the error.
 */
async function guardStudentSheet(req, res, tid, studentId) {
  const student = await db.get(
    "SELECT id, class_id, first_name, last_name FROM students WHERE id = ? AND madrasa_id = ?",
    [studentId, tid]
  );
  if (!student) { res.status(404).json({ error: "Report sheet not found." }); return null; }
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!scope.anyClassAnySubject && !scope.assignedClassIds.has(Number(student.class_id || 0))) {
      res.status(404).json({ error: "Not found." });
      return null;
    }
  }
  return student;
}

/**
 * GET /results/report-sheet/:studentId/:termId — the complete printable
 * dataset (subjects, totals, attendance, behaviour, class performance,
 * completeness and workflow status) for the admin preview screen.
 */
router.get("/report-sheet/:studentId/:termId", requireStaffPermission("report_cards.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const studentId = toNum(req.params.studentId, 0);
  const termId = toNum(req.params.termId, 0);
  if (!await guardStudentSheet(req, res, tid, studentId)) return;
  const data = await reportSheet.buildReportSheet(tid, studentId, termId);
  if (!data) return err(res, 404, "Report sheet not found.");
  await audit.record(req, { action: "report.view_data", module: "academic", entity: "report_sheet", entityId: `${studentId}:${termId}`, meta: { student_id: studentId, term_id: termId } });
  ok(res, data);
}));

/** Completeness report for a whole class/term: missing + unapproved results. */
router.get("/report-completeness", requireStaffPermission("report_cards.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const classId = toNum(req.query.classId, 0);
  const termId = toNum(req.query.termId, 0);
  if (!classId || !termId) return err(res, 400, "classId and termId are required.");
  const cls = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!cls) return err(res, 404, "Class not found.");
  const term = await db.get("SELECT id FROM terms WHERE id = ? AND madrasa_id = ?", [termId, tid]);
  if (!term) return err(res, 404, "Term not found.");
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!scope.anyClassAnySubject && !scope.assignedClassIds.has(classId)) return err(res, 404, "Class not found.");
  }
  const check = await reportSheet.classCompleteness(tid, classId, termId);
  const students = [];
  for (const [studentId, entry] of check.byStudent) {
    students.push({ studentId, missing: entry.missing, pending: entry.pending, complete: entry.complete });
  }
  ok(res, {
    subjects: check.subjects,
    studentCount: check.studentCount,
    complete: students.length > 0 && students.every((s) => s.complete),
    students,
  });
}));

/** A single printable document containing every eligible report card. */
async function bulkReportCardsHandler(req, res) {
  const tid = await tenantId(req, res); if (tid == null) return;
  const classId = toNum(req.query.classId, 0); const termId = toNum(req.query.termId, 0);
  if (!classId || !termId) return err(res, 400, "classId and termId are required.");
  if (!await db.get("SELECT id FROM classes WHERE id=? AND madrasa_id=?", [classId, tid])) return err(res, 404, "Class not found.");
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!scope.anyClassAnySubject && !scope.assignedClassIds.has(classId)) return err(res, 404, "Class not found.");
  }
  const sheets = await reportSheet.buildClassReportSheets(tid, classId, termId);
  if (!sheets || !sheets.length) return err(res, 404, "No approved results are available for report cards.");
  await audit.record(req, { action: "report.bulk_generate", module: "academic", entity: "report_sheet", entityId: `${classId}:${termId}`, after: { count: sheets.length }, meta: { class_id: classId, term_id: termId, count: sheets.length } });
  res.type("html").send(reportSheet.renderBulkReportSheets(sheets));
}

const bulkHandler = requireStaffPermission("report_cards.generate");
router.get("/report-cards/bulk", bulkHandler, asyncHandler(bulkReportCardsHandler));
/** Alias so the batch path reads the way the UI talks about it. */
router.get("/report-sheets/bulk", bulkHandler, asyncHandler(bulkReportCardsHandler));

/** Printable report card HTML (standalone document; print to PDF in browser). */
router.get("/report-card/:studentId/:termId", requireStaffPermission("report_cards.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const studentId = toNum(req.params.studentId, 0);
  const termId = toNum(req.params.termId, 0);
  if (!await guardStudentSheet(req, res, tid, studentId)) return;
  const sheet = await reportSheet.buildReportSheet(tid, studentId, termId);
  if (!sheet) return err(res, 404, "Report sheet not found.");
  await audit.record(req, { action: "report.print", module: "academic", entity: "report_sheet", entityId: `${studentId}:${termId}`, meta: { student_id: studentId, term_id: termId } });
  res.type("html").send(reportSheet.renderReportSheetHTML(sheet));
}));

/* -------------------------- report template ---------------------------- */

/** The institution's report sheet configuration (layout, sections, branding). */
router.get("/report-template", requireStaffPermission("report_cards.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const template = await reportSheet.getReportTemplate(tid);
  ok(res, { template, defaults: reportSheet.DEFAULT_TEMPLATE });
}));

/**
 * PUT /results/report-template — save the configuration. Admins (and any user
 * granted report_cards.templates) may change it; the change is audited.
 */
router.put("/report-template", requireStaffPermission("report_cards.templates"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const before = await reportSheet.getReportTemplate(tid);
  const template = await reportSheet.saveReportTemplate(tid, req.body || {});
  await audit.record(req, {
    action: "report.template", module: "academic", entity: "report_template", entityId: String(tid),
    before: { layout: before.layout, orientation: before.orientation },
    after: { layout: template.layout, orientation: template.orientation },
  });
  ok(res, { ok: true, template });
}));

/** Template preview with clearly-marked sample data (never a real student). */
router.get("/report-template/preview", requireStaffPermission("report_cards.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const stored = await reportSheet.getReportTemplate(tid);
  const incoming = req.query.template ? reportSheet.normaliseTemplate(String(req.query.template)) : stored;
  const cfg = await grading.getGradingConfig(tid);
  // Preview in this tenant's own theme (existing institution category).
  const inst = await db.get("SELECT category, institution_type FROM madaris WHERE id = ?", [tid]);
  const sample = reportSheet.sampleReportSheet(incoming, cfg, inst ? (inst.category || inst.institution_type) : "");
  res.type("html").send(reportSheet.renderReportSheetHTML(sample)
    .replace("<body>", '<body data-sample-preview="1">')
    .replace('class="doc-title"', 'class="doc-title" title="Sample preview"'));
}));

/*
   Back-compat delegates: the printable document is produced by the single
   report engine in services/report-sheet.js (which wraps the grading
   service's calculations). These aliases keep the historical exports of this
   module working for any caller that imported them directly.
*/
function renderReportCard(d) {
  return reportSheet.renderReportSheetHTML(d);
}

function renderBulkReportCards(cards) {
  return reportSheet.renderBulkReportSheets(cards);
}

module.exports = { router, renderReportCard, renderBulkReportCards };
