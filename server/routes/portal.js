"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — Student & Parent portals
   ----------------------------------------------------------------------------
   student:  own profile, dashboard, results history, report card, timetable,
             assignments (view + submit), attendance, fees, exams, library,
             announcements, notifications.
   parent:   linked children (parent_links) with a child switcher — dashboard,
             their results, report cards, attendance, fees, assignments,
             timetable, PTM, announcements, notifications.
   A parent can NEVER see a child they are not linked to, and a student can
   never see another student's data (backend-enforced on every endpoint).
   ========================================================================== */
const express = require("express");
const fs = require("fs");
const db = require("../db");
const { asyncHandler, err, ok, toNum, cleanStr, validDate } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { requireFeature } = require("../middleware/subscription");
const { effectiveTenantId } = require("../middleware/tenant");
const grading = require("../services/grading");
const reportSheet = require("../services/report-sheet");
const audit = require("../services/audit");

const router = express.Router();
router.use(requireAuth, requireTenant, requireRole("student", "parent"));
/* Student & parent portals are what the Basic plan sells ("keep parents
   informed automatically"). A school on Free still gets announcements and
   printable report cards; the gate below answers with the upgrade offer rather
   than a bare 403, and the frontend turns that into the upsell dialog.
   Super admins supporting a school are never gated (see the middleware). */
router.use(requireFeature("portals"));
// Taking an online exam is a Premium capability on top of having a portal.
router.use("/online-exams", requireFeature("online_exams"));

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required." }); return null; }
  return tid;
}

/** Resolves the student rows this user is allowed to see. */
async function accessibleStudents(req, tid) {
  if (req.user.role === "student") {
    const row = await db.get(
      `SELECT s.*, c.name_en AS class_en, c.name_ar AS class_ar
         FROM students s LEFT JOIN classes c ON c.id = s.class_id
        WHERE s.id = ? AND s.madrasa_id = ?`,
      [req.user.studentId, tid]
    );
    return row ? [row] : [];
  }
  // parent: linked children only
  return db.all(
    `SELECT s.*, c.name_en AS class_en, c.name_ar AS class_ar
       FROM students s
       JOIN parent_links pl ON pl.student_id = s.id AND pl.madrasa_id = s.madrasa_id
       LEFT JOIN classes c ON c.id = s.class_id
      WHERE pl.madrasa_id = ? AND pl.user_id = ? AND s.madrasa_id = ?`,
    [tid, req.user.id, tid]
  );
}

/* ------------------------------ me / profile --------------------------- */

router.get("/me", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const madrasa = await db.get("SELECT name_en, name_ar, logo_path, motto_en, motto_ar FROM madaris WHERE id = ?", [tid]);
  const out = {
    role: req.user.role,
    user: { id: req.user.id, username: req.user.username, fullName: req.user.fullName },
    madrasa,
    children: [],
  };
  // One query for all of the children's classes — a per-child lookup made
  // this "who am I" endpoint an N+1 for every parent with several children.
  const classIds = [...new Set(students.map((s) => Number(s.class_id)).filter(Boolean))];
  const classesById = new Map();
  if (classIds.length) {
    const rows = await db.all(`SELECT id, name_en, name_ar FROM classes WHERE id IN (${classIds.map(() => "?").join(",")})`, classIds);
    for (const c of rows) classesById.set(Number(c.id), c);
  }
  for (const s of students) {
    const cls = s.class_id ? classesById.get(Number(s.class_id)) : null;
    out.children.push(Object.assign({}, s, {
      classEn: cls ? cls.name_en : "",
      classAr: cls ? cls.name_ar : "",
    }));
  }
  if (req.user.role === "student" && out.children.length) out.self = out.children[0];
  ok(res, out);
}));

/* ------------------------------ results -------------------------------- */

/**
 * GET /api/portal/results?studentId=
 * student: own (studentId must equal their linked student id).
 * parent:  must be a linked child.
 */
router.get("/results", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const byId = new Map(students.map((s) => [s.id, s]));
  let target;
  if (req.user.role === "student") {
    target = byId.get(req.user.studentId);
  } else {
    const want = toNum(req.query.studentId, 0);
    target = byId.get(want) || null;
    if (!target) return err(res, 400, "studentId is required.");
  }
  if (!target) return err(res, 404, { error: "No student record found." });

  const summaries = await db.all(
    `SELECT ts.*, t.name_en AS term_name, t.name_ar AS term_name_ar, t.position AS term_position,
            a.label AS session_label
     FROM term_summaries ts
     JOIN terms t ON t.id = ts.term_id
     JOIN academic_sessions a ON a.id = ts.session_id
     WHERE ts.madrasa_id = ? AND ts.student_id = ? AND ts.published_at IS NOT NULL
     ORDER BY a.id DESC, t.position DESC`,
    [tid, target.id]
  );
  ok(res, {
    student: { id: target.id, admissionNo: target.admission_no, name: `${target.first_name} ${target.last_name}`.trim(), nameAr: target.name_ar, classEn: target.class_en, classAr: target.class_ar },
    terms: summaries,
  });
}));

/** Full subject detail for one term (for the portal results page). */
router.get("/results/:termId", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const termId = toNum(req.params.termId, 0);
  const students = await accessibleStudents(req, tid);
  const byId = new Map(students.map((s) => [s.id, s]));
  let target;
  if (req.user.role === "student") target = byId.get(req.user.studentId);
  else target = byId.get(toNum(req.query.studentId, 0));
  if (!target) return err(res, 404, { error: "Not found." });

  const cfg = await grading.getGradingConfig(tid);
  // Only results that finished the review workflow reach the portal — drafts
  // and returned marks never leave the staff workspace.
  const rows = await db.all(
    `SELECT r.*, su.name_en, su.name_ar FROM results r
     JOIN subjects su ON su.id = r.subject_id
     WHERE r.madrasa_id = ? AND r.student_id = ? AND r.term_id = ?
       AND r.status IN ('approved','published','locked')
     ORDER BY su.name_en`,
    [tid, target.id, termId]
  );
  const subjects = rows.map((r) => {
    const pct = grading.pctOf(cfg, r.total);
    const g = grading.gradeForPct(cfg, pct);
    return {
      nameEn: r.name_en, nameAr: r.name_ar,
      ca: Number(r.ca), exam: Number(r.exam), total: Number(r.total),
      pct: Math.round(pct * 10) / 10, grade: g.grade, remark: g.remark, remarkAr: g.remark_ar,
      pass: pct >= cfg.passMark,
    };
  });
  ok(res, { studentId: target.id, termId, subjects });
}));

/* ------------------------------ report card ---------------------------- */

/**
 * GET /api/portal/report-card?termId=&studentId=  -> printable HTML
 * (studentId required for parents; must be a linked child).
 *
 * The publication gate is enforced server-side: an unpublished term summary is
 * never rendered in the portal, whatever the URL says.
 */
router.get("/report-card", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const termId = toNum(req.query.termId, 0);
  if (!termId) return err(res, 400, "termId is required.");
  const students = await accessibleStudents(req, tid);
  const byId = new Map(students.map((s) => [s.id, s]));
  let target;
  if (req.user.role === "student") target = byId.get(req.user.studentId);
  else target = byId.get(toNum(req.query.studentId, 0));
  if (!target) return err(res, 404, { error: "Report card not found." });

  const summary = await db.get(
    "SELECT published_at FROM term_summaries WHERE madrasa_id = ? AND student_id = ? AND term_id = ?",
    [tid, target.id, termId]
  );
  if (!summary || !summary.published_at) {
    return err(res, 403, "This report has not been published yet. Please check again later.");
  }
  const data = await reportSheet.buildReportSheet(tid, target.id, termId);
  if (!data) return err(res, 404, { error: "Report card not found. Results may not be computed yet." });
  await audit.record(req, {
    action: req.user.role === "student" ? "report.portal_view" : "report.parent_view",
    module: "academic", entity: "report_sheet", entityId: `${target.id}:${termId}`,
    meta: { student_id: target.id, term_id: termId },
  });
  res.type("html").send(reportSheet.renderReportSheetHTML(data, { portal: true }));
}));

/* ------------------------------ helpers -------------------------------- */

function todayIso() { return new Date().toISOString().slice(0, 10); }

/** English weekday name matching the timetable's `day` column. */
function todayName() {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getUTCDay()];
}

/** Published calendar events visible to this student/parent (audience rules). */
async function visibleEvents(tid, students, limit = 8) {
  const rows = await db.all(
    "SELECT id, title, description, event_type, start_date, end_date, start_time, end_time, location, audience, target_ids FROM calendar_events WHERE madrasa_id = ? AND status = 'published' AND COALESCE(end_date, start_date) >= ? ORDER BY start_date, start_time, id LIMIT 50",
    [tid, todayIso()]
  );
  const classes = new Set(students.map((s) => Number(s.class_id)).filter(Boolean));
  return rows.filter((e) => {
    const audience = e.audience || "all";
    if (audience === "all") return true;
    if (audience === "students" || audience === "parents") return true;
    if (audience === "specific_classes") {
      let ids = []; try { ids = JSON.parse(e.target_ids || "[]").map(Number); } catch (_) {}
      return [...classes].some((c) => ids.includes(c));
    }
    return false;
  }).slice(0, limit);
}

/** Outstanding fee balance for one student (3 bounded queries, no full-tenant scan). */
async function studentFeeSummary(tid, student) {
  const fees = await db.all(
    `SELECT f.id, f.amount_ngn, f.due_date FROM fee_items f
      WHERE f.madrasa_id = ? AND f.status = 'active'
        AND (f.class_id IS NULL OR f.class_id = ?)`,
    [tid, student.class_id || 0]
  );
  if (!fees.length) return { billed: 0, paid: 0, balance: 0 };
  const feeIds = fees.map((f) => Number(f.id));
  const marks = feeIds.map(() => "?").join(",");
  const [assigned, payments] = await Promise.all([
    db.all(`SELECT fee_item_id, amount_due FROM fee_assignments WHERE madrasa_id = ? AND student_id = ? AND fee_item_id IN (${marks})`, [tid, student.id].concat(feeIds)),
    db.all(`SELECT fee_item_id, SUM(amount_ngn) AS paid FROM fee_payments WHERE madrasa_id = ? AND student_id = ? AND status = 'successful' AND fee_item_id IN (${marks}) GROUP BY fee_item_id`, [tid, student.id].concat(feeIds)),
  ]);
  const assignedByFee = new Map(assigned.map((a) => [Number(a.fee_item_id), Number(a.amount_due)]));
  const paidByFee = new Map(payments.map((p) => [Number(p.fee_item_id), Number(p.paid)]));
  let billed = 0; let paid = 0; let earliestDue = null;
  for (const fee of fees) {
    const due = assignedByFee.has(Number(fee.id)) ? assignedByFee.get(Number(fee.id)) : Number(fee.amount_ngn);
    billed += due;
    paid += paidByFee.get(Number(fee.id)) || 0;
    if (due > (paidByFee.get(Number(fee.id)) || 0) && fee.due_date && (!earliestDue || String(fee.due_date).slice(0, 10) < earliestDue)) earliestDue = String(fee.due_date).slice(0, 10);
  }
  return { billed: Math.round(billed * 100) / 100, paid: Math.round(paid * 100) / 100, balance: Math.max(0, Math.round((billed - paid) * 100) / 100), nextDueDate: earliestDue };
}

/** Attendance totals for a set of students in one grouped query. */
async function attendanceSummaries(tid, studentIds) {
  const out = new Map();
  if (!studentIds.length) return out;
  const marks = studentIds.map(() => "?").join(",");
  const rows = await db.all(
    `SELECT student_id, status, COUNT(*) AS n FROM attendance
      WHERE madrasa_id = ? AND student_id IN (${marks})
      GROUP BY student_id, status`,
    [tid].concat(studentIds)
  );
  for (const row of rows) {
    const id = Number(row.student_id);
    if (!out.has(id)) out.set(id, { present: 0, absent: 0, late: 0, excused: 0, total: 0 });
    const entry = out.get(id);
    const key = ["present", "absent", "late", "excused"].includes(row.status) ? row.status : null;
    if (key) entry[key] = Number(row.n);
    entry.total += Number(row.n);
  }
  return out;
}

/* ------------------------------ dashboard ------------------------------- */

/**
 * GET /api/portal/dashboard
 * One aggregate for the student and parent portals. Everything is scoped to
 * the caller's own record / linked children, with a bounded number of queries.
 */
router.get("/dashboard", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const [madrasa, unread, events] = await Promise.all([
    db.get("SELECT name_en, name_ar, logo_path, category FROM madaris WHERE id = ?", [tid]),
    db.get("SELECT COUNT(*) AS n FROM notifications WHERE madrasa_id = ? AND recipient_user_id = ? AND read_at IS NULL", [tid, req.user.id]),
    visibleEvents(tid, students),
  ]);

  const day = todayName();
  const childSummaries = [];
  for (const s of students) {
    const classId = s.class_id ? Number(s.class_id) : null;
    const [todaySlots, attendance, pendingAssignments, upcomingExams, fee, latestSummary] = await Promise.all([
      classId
        ? db.all(
          `SELECT ts.period, ts.start_time, ts.end_time, ts.room, sub.name_en AS subject_en, sub.name_ar AS subject_ar
             FROM timetable_slots ts LEFT JOIN subjects sub ON sub.id = ts.subject_id
            WHERE ts.madrasa_id = ? AND ts.class_id = ? AND ts.day = ? AND (ts.term_id IS NULL OR ts.term_id IN (SELECT id FROM terms WHERE madrasa_id = ?))
            ORDER BY ts.period`,
          [tid, classId, day, tid]
        )
        : Promise.resolve([]),
      attendanceSummaries(tid, [s.id]).then((m) => m.get(Number(s.id)) || { present: 0, absent: 0, late: 0, excused: 0, total: 0 }),
      classId
        ? db.all(
          `SELECT h.id, h.title, h.due_date, sub.name_en AS subject_name,
                  (SELECT x.id FROM assignment_submissions x WHERE x.madrasa_id = h.madrasa_id AND x.assignment_id = h.id AND x.student_id = ?) AS submission_id,
                  (SELECT x.status FROM assignment_submissions x WHERE x.madrasa_id = h.madrasa_id AND x.assignment_id = h.id AND x.student_id = ?) AS submission_status
             FROM homework h LEFT JOIN subjects sub ON sub.id = h.subject_id
            WHERE h.madrasa_id = ? AND h.kind = 'assignment' AND h.status = 'published' AND h.class_id = ?
              AND (h.due_date IS NULL OR h.due_date >= ?)
              AND NOT EXISTS (SELECT 1 FROM assignment_submissions y WHERE y.madrasa_id = h.madrasa_id AND y.assignment_id = h.id AND y.student_id = ? AND y.status = 'graded')
            ORDER BY h.due_date IS NULL, h.due_date LIMIT 5`,
          [s.id, s.id, tid, classId, todayIso(), s.id]
        )
        : Promise.resolve([]),
      classId
        ? db.all(
          `SELECT e.id, e.title, e.exam_date, e.start_time, e.end_time, e.classroom, sub.name_en AS subject_name
             FROM exams e LEFT JOIN subjects sub ON sub.id = e.subject_id
            WHERE e.madrasa_id = ? AND e.class_id = ? AND e.status IN ('scheduled','ongoing','published') AND e.exam_date >= ?
            ORDER BY e.exam_date, e.start_time LIMIT 5`,
          [tid, classId, todayIso()]
        )
        : Promise.resolve([]),
      studentFeeSummary(tid, s),
      db.get(
        `SELECT ts.term_id, t.name_en AS term_name, a.label AS session_label, ts.average AS total_average, ts.overall_grade, ts.position, ts.published_at
           FROM term_summaries ts JOIN terms t ON t.id = ts.term_id JOIN academic_sessions a ON a.id = ts.session_id
          WHERE ts.madrasa_id = ? AND ts.student_id = ? AND ts.published_at IS NOT NULL
          ORDER BY ts.published_at DESC, ts.id DESC LIMIT 1`,
        [tid, s.id]
      ),
    ]);
    const attendancePct = attendance.total ? Math.round(((attendance.present + attendance.late + attendance.excused) / attendance.total) * 1000) / 10 : null;
    childSummaries.push({
      studentId: s.id,
      name: `${s.first_name} ${s.last_name}`.trim(),
      nameAr: s.name_ar,
      admissionNo: s.admission_no,
      classId,
      className: s.class_en || "",
      photoPath: s.photo_path || "",
      todaySlots,
      attendance,
      attendancePct,
      pendingAssignments,
      upcomingExams,
      fee,
      latestResult: latestSummary || null,
    });
  }

  // Active library loans across the student's own portal account / children's
  // student-linked accounts — one query per dashboard load.
  const studentIds = students.map((s) => Number(s.id));
  let library = { activeLoans: 0, overdue: 0 };
  if (studentIds.length) {
    const marks = studentIds.map(() => "?").join(",");
    const loanUsers = await db.all(`SELECT id FROM users WHERE madrasa_id = ? AND student_id IN (${marks}) AND is_active = 1`, [tid].concat(studentIds));
    if (loanUsers.length) {
      const um = loanUsers.map(() => "?").join(",");
      const loanRow = await db.get(
        `SELECT COUNT(*) AS active,
                SUM(CASE WHEN l.status IN ('active','overdue') AND l.due_date < ? THEN 1 ELSE 0 END) AS overdue
           FROM library_loans l WHERE l.madrasa_id = ? AND l.borrower_user_id IN (${um}) AND l.status IN ('active','overdue')`,
        [todayIso(), tid].concat(loanUsers.map((u) => u.id))
      );
      library = { activeLoans: Number(loanRow && loanRow.active || 0), overdue: Number(loanRow && loanRow.overdue || 0) };
    }
  }

  ok(res, {
    role: req.user.role,
    user: { id: req.user.id, fullName: req.user.fullName, fullNameAr: req.user.fullNameAr },
    madrasa,
    today: todayIso(),
    todayName: day,
    unreadNotifications: Number(unread.n || 0),
    events,
    library,
    children: childSummaries,
  });
}));

/* ------------------------------ assignments ----------------------------- */

/**
 * GET /api/portal/assignments  (student: own class; parent: ?studentId= child)
 * Published assignments for the student's class with the caller's own
 * submission state. Students never see drafts, closed/archived work, or
 * another class's assignments.
 */
router.get("/assignments", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const byId = new Map(students.map((s) => [Number(s.id), s]));
  const target = resolveStudentTarget(req, byId);
  if (!target) return err(res, 404, { error: "No student record found." });
  if (!target.class_id) return ok(res, { student: studentBrief(target), assignments: [] });

  const rows = await db.all(
    `SELECT h.id, h.title, h.details, h.due_date, h.assigned_date, h.maximum_score, h.status,
            sub.name_en AS subject_name, sub.name_ar AS subject_ar, u.full_name AS teacher_name,
            (SELECT COUNT(*) FROM academic_attachments aa WHERE aa.madrasa_id = h.madrasa_id AND aa.entity_type = 'assignment' AND aa.entity_id = h.id) AS attachment_count,
            x.id AS submission_id, x.submission_text, x.original_name, x.submitted_at, x.status AS submission_status, x.score, x.feedback, x.graded_at
       FROM homework h
       LEFT JOIN subjects sub ON sub.id = h.subject_id AND sub.madrasa_id = h.madrasa_id
       LEFT JOIN users u ON u.id = h.teacher_id AND u.madrasa_id = h.madrasa_id
       LEFT JOIN assignment_submissions x ON x.madrasa_id = h.madrasa_id AND x.assignment_id = h.id AND x.student_id = ?
      WHERE h.madrasa_id = ? AND h.kind = 'assignment' AND h.status IN ('published','closed') AND h.class_id = ?
      ORDER BY h.due_date IS NULL, h.due_date DESC, h.id DESC LIMIT 200`,
    [target.id, tid, target.class_id]
  );
  const assignments = rows.map((r) => Object.assign({}, r, {
    submission: r.submission_id ? {
      submittedAt: r.submitted_at, status: r.submission_status, score: r.score,
      feedback: r.feedback, gradedAt: r.graded_at, fileName: r.original_name,
    } : null,
    // A graded submission is released; otherwise the student may still
    // resubmit while the assignment is published and not yet past due.
    canSubmit: r.status === "published" && (!r.due_date || String(r.due_date).slice(0, 10) >= todayIso()),
  }));
  ok(res, { student: studentBrief(target), assignments });
}));

/**
 * GET /api/portal/assignments/:id  — full detail incl. attachments list.
 */
router.get("/assignments/:id", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const byId = new Map(students.map((s) => [Number(s.id), s]));
  const target = resolveStudentTarget(req, byId);
  if (!target) return err(res, 404, { error: "No student record found." });
  const assignment = await db.get(
    `SELECT h.*, sub.name_en AS subject_name, sub.name_ar AS subject_ar, u.full_name AS teacher_name
       FROM homework h
       LEFT JOIN subjects sub ON sub.id = h.subject_id AND sub.madrasa_id = h.madrasa_id
       LEFT JOIN users u ON u.id = h.teacher_id AND u.madrasa_id = h.madrasa_id
      WHERE h.id = ? AND h.madrasa_id = ? AND h.kind = 'assignment' AND h.status IN ('published','closed')`,
    [toNum(req.params.id, 0), tid]
  );
  // Existence is not leaked: a wrong-class id answers 404.
  if (!assignment || !target.class_id || Number(assignment.class_id) !== Number(target.class_id)) {
    return err(res, 404, { error: "Assignment not found." });
  }
  const attachments = await db.all(
    "SELECT id, display_name, original_name, mime_type, file_size, created_at FROM academic_attachments WHERE madrasa_id = ? AND entity_type = 'assignment' AND entity_id = ? ORDER BY id",
    [tid, assignment.id]
  );
  const submission = await db.get(
    "SELECT id, submission_text, original_name, mime_type, file_size, submitted_at, status, score, feedback, graded_at FROM assignment_submissions WHERE madrasa_id = ? AND assignment_id = ? AND student_id = ?",
    [tid, assignment.id, target.id]
  );
  ok(res, {
    student: studentBrief(target),
    assignment: {
      id: assignment.id, title: assignment.title, details: assignment.details,
      subjectName: assignment.subject_name, subjectNameAr: assignment.subject_ar,
      teacherName: assignment.teacher_name, dueDate: assignment.due_date,
      assignedDate: assignment.assigned_date, maximumScore: assignment.maximum_score,
      status: assignment.status, homeworkText: assignment.homework_text,
    },
    attachments,
    submission: submission || null,
    canSubmit: assignment.status === "published" && (!assignment.due_date || String(assignment.due_date).slice(0, 10) >= todayIso()),
  });
}));

/**
 * GET /api/portal/assignments/:id/attachments/:attachmentId — download for the
 * assigned student (or a linked parent). Path is never taken from the client.
 */
router.get("/assignments/:id/attachments/:attachmentId", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const byId = new Map(students.map((s) => [Number(s.id), s]));
  const target = resolveStudentTarget(req, byId);
  if (!target) return err(res, 404, { error: "Assignment not found." });
  const assignment = await db.get("SELECT * FROM homework WHERE id = ? AND madrasa_id = ? AND kind = 'assignment' AND status IN ('published','closed')", [toNum(req.params.id, 0), tid]);
  if (!assignment || !target.class_id || Number(assignment.class_id) !== Number(target.class_id)) {
    return err(res, 404, { error: "Assignment not found." });
  }
  const attachment = await db.get(
    "SELECT * FROM academic_attachments WHERE id = ? AND madrasa_id = ? AND entity_type = 'assignment' AND entity_id = ?",
    [toNum(req.params.attachmentId, 0), tid, assignment.id]
  );
  if (!attachment || !attachment.storage_path || !fs.existsSync(attachment.storage_path)) {
    return err(res, 404, { error: "Attachment not found." });
  }
  res.download(attachment.storage_path, attachment.original_name || attachment.display_name || "attachment");
}));

/** Student's own submission file (never another student's). */
router.get("/assignments/:id/submission/attachment", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const byId = new Map(students.map((s) => [Number(s.id), s]));
  const target = resolveStudentTarget(req, byId);
  if (!target) return err(res, 404, { error: "Submission not found." });
  const sub = await db.get(
    "SELECT * FROM assignment_submissions WHERE madrasa_id = ? AND assignment_id = ? AND student_id = ?",
    [tid, toNum(req.params.id, 0), target.id]
  );
  if (!sub || !sub.attachment_path || !fs.existsSync(sub.attachment_path)) {
    return err(res, 404, { error: "Submission not found." });
  }
  res.download(sub.attachment_path, sub.original_name || "submission");
}));

function studentBrief(s) {
  return { id: s.id, name: `${s.first_name} ${s.last_name}`.trim(), admissionNo: s.admission_no, classId: s.class_id, className: s.class_en || "" };
}

/** Picks the student the request is about: the caller's own record, or (for a
 *  parent) the linked child named by ?studentId — never a client-trusted id. */
function resolveStudentTarget(req, byId) {
  if (req.user.role === "student") return byId.get(Number(req.user.studentId)) || null;
  return byId.get(toNum(req.query.studentId, 0)) || null;
}

/* --------------------------------- exams -------------------------------- */

/**
 * GET /api/portal/exams — the exam timetable for the student's class
 * (or ?studentId= child). Only scheduled/ongoing/published sittings appear.
 */
router.get("/exams", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const byId = new Map(students.map((s) => [Number(s.id), s]));
  const target = resolveStudentTarget(req, byId);
  if (!target) return err(res, 404, { error: "No student record found." });
  if (!target.class_id) return ok(res, { student: studentBrief(target), exams: [] });
  const exams = await db.all(
    `SELECT e.id, e.title, e.exam_date, e.start_time, e.end_time, e.duration_minutes, e.classroom,
            e.total_marks, e.status, e.mode, e.instructions, sub.name_en AS subject_name, sub.name_ar AS subject_ar
       FROM exams e LEFT JOIN subjects sub ON sub.id = e.subject_id AND sub.madrasa_id = e.madrasa_id
      WHERE e.madrasa_id = ? AND e.class_id = ? AND e.status IN ('scheduled','ongoing','published')
      ORDER BY e.exam_date IS NULL, e.exam_date, e.start_time LIMIT 100`,
    [tid, target.class_id]
  );
  ok(res, { student: studentBrief(target), exams });
}));

/* ---------------------------- online exams ------------------------------ */

/** Server-side window of an online exam (never a client timestamp). */
function onlineWindow(exam) {
  if (!exam.exam_date || !exam.start_time || !exam.end_time) return null;
  const start = new Date(`${String(exam.exam_date).slice(0, 10)}T${String(exam.start_time).slice(0, 5)}:00`);
  const end = new Date(`${String(exam.exam_date).slice(0, 10)}T${String(exam.end_time).slice(0, 5)}:00`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  return { start, end };
}
function ts(v) {
  if (!v) return NaN;
  if (v instanceof Date) return v.getTime();
  return new Date(String(v).replace(" ", "T")).getTime();
}
/** Server-local "YYYY-MM-DD HH:MM:SS" — the datetime convention the rest of
 *  the schema uses (CURRENT_TIMESTAMP semantics), safe for both the SQLite
 *  TEXT columns and MySQL TIMESTAMP columns (dateStrings reads it back). */
function sqlLocalTs(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Loads an online exam for a portal user and validates the class link. */
async function loadOnlineExam(req, res, tid, target) {
  const exam = await db.get(
    `SELECT e.*, sub.name_en AS subject_name, sub.name_ar AS subject_ar, c.name_en AS class_name
       FROM exams e LEFT JOIN subjects sub ON sub.id = e.subject_id AND sub.madrasa_id = e.madrasa_id
       LEFT JOIN classes c ON c.id = e.class_id AND c.madrasa_id = e.madrasa_id
      WHERE e.id = ? AND e.madrasa_id = ?`,
    [toNum(req.params.id, 0), tid]
  );
  if (!exam || exam.mode !== "online") { err(res, 404, "Online examination not found."); return null; }
  if (Number(exam.class_id) !== Number(target.class_id)) { err(res, 404, "Online examination not found."); return null; }
  return exam;
}

/** Public shape of one exam for the listing (no answers, no explanations).
 *  Attempts and question aggregates are batch-fetched by the caller so the
 *  listing stays at three queries regardless of exam count. */
function onlineExamCard(req, exam, target, now, attemptsByExam, totalsByExam) {
  const window = onlineWindow(exam);
  const state = !window ? "open" : (now < window.start.getTime() ? "upcoming" : (now > window.end.getTime() ? "closed" : "open"));
  const attempt = attemptsByExam.get(Number(exam.id)) || null;
  const q = totalsByExam.get(Number(exam.id)) || { n: 0, total: 0 };
  const released = Boolean(exam.results_released_at);
  const windowEnded = window ? now > window.end.getTime() : true;
  const scoreVisible = Boolean(attempt && attempt.status !== "in_progress" && (released || windowEnded));
  return {
    id: exam.id, title: exam.title, subject_name: exam.subject_name, subject_ar: exam.subject_ar,
    exam_date: exam.exam_date, start_time: exam.start_time, end_time: exam.end_time,
    duration_minutes: exam.duration_minutes, total_marks: Number(q.total) || Number(exam.total_marks),
    question_count: Number(q.n), instructions: exam.instructions, status: exam.status,
    state, results_released: released,
    attempt: attempt ? {
      status: attempt.status, started_at: attempt.started_at, submitted_at: attempt.submitted_at,
      expires_at: attempt.expires_at,
      score: scoreVisible ? attempt.score : null,
      auto_score: scoreVisible ? attempt.auto_score : null,
    } : null,
    can_take: req.user.role === "student" && ["scheduled", "ongoing", "published"].includes(exam.status) &&
      state === "open" && (!attempt || attempt.status === "in_progress"),
  };
}

/**
 * GET /api/portal/online-exams — every online examination of the student's
 * class (or ?studentId= child) with the caller's own attempt state. Correct
 * answers are never part of this payload.
 */
router.get("/online-exams", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const byId = new Map(students.map((s) => [Number(s.id), s]));
  const target = resolveStudentTarget(req, byId);
  if (!target) return err(res, 404, "No student record found.");
  if (!target.class_id) return ok(res, { student: studentBrief(target), exams: [] });
  const rows = await db.all(
    `SELECT e.* FROM exams e WHERE e.madrasa_id=? AND e.class_id=? AND e.mode='online'
       AND e.status IN ('scheduled','ongoing','published','completed') ORDER BY e.exam_date DESC, e.start_time LIMIT 60`,
    [tid, target.class_id]
  );
  if (!rows.length) return ok(res, { student: studentBrief(target), exams: [], serverTime: new Date().toISOString() });
  const examIds = rows.map((e) => Number(e.id));
  const marks = examIds.map(() => "?").join(",");
  const attemptRows = await db.all(
    `SELECT * FROM exam_attempts WHERE madrasa_id=? AND student_id=? AND exam_id IN (${marks})`,
    [tid, target.id].concat(examIds)
  );
  const attemptsByExam = new Map(attemptRows.map((a) => [Number(a.exam_id), a]));
  const totalRows = await db.all(
    `SELECT exam_id, COUNT(*) AS n, COALESCE(SUM(marks),0) AS total FROM exam_questions WHERE madrasa_id=? AND exam_id IN (${marks}) GROUP BY exam_id`,
    [tid].concat(examIds)
  );
  const totalsByExam = new Map(totalRows.map((t) => [Number(t.exam_id), t]));
  const now = Date.now();
  ok(res, {
    student: studentBrief(target),
    exams: rows.map((exam) => onlineExamCard(req, exam, target, now, attemptsByExam, totalsByExam)),
    serverTime: new Date().toISOString(),
  });
}));

/**
 * POST /api/portal/online-exams/:id/start — begins (or resumes) the caller's
 * own single attempt. Every rule is enforced here, on the server: window,
 * status, class membership, one attempt per student, attempt expiry.
 */
router.post("/online-exams/:id/start", asyncHandler(async (req, res) => {
  if (req.user.role !== "student") return err(res, 403, "Only students take examinations.");
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const target = students.length ? students[0] : null;
  if (!target) return err(res, 404, "No student record found.");
  const exam = await loadOnlineExam(req, res, tid, target);
  if (!exam) return;
  if (!["scheduled", "ongoing", "published"].includes(exam.status)) return err(res, 409, "This examination is not open.");
  const now = Date.now();
  const window = onlineWindow(exam);
  if (window) {
    if (now < window.start.getTime()) return err(res, 409, "This examination has not started yet.");
    if (now > window.end.getTime()) return err(res, 409, "This examination has already ended.");
  }
  const questions = await db.all(
    "SELECT id, position, question_text, question_type, options, marks FROM exam_questions WHERE exam_id=? AND madrasa_id=? ORDER BY position, id",
    [exam.id, tid]
  );
  if (!questions.length) return err(res, 409, "This examination has no questions yet.");
  let attempt = await db.get("SELECT * FROM exam_attempts WHERE exam_id=? AND madrasa_id=? AND student_id=?", [exam.id, tid, target.id]);
  const deadline = (a) => ts(a.expires_at);
  if (attempt && attempt.status === "in_progress") {
    const expires = deadline(attempt);
    // A lapsed attempt is finalized with whatever was saved — it can never be
    // reopened, so the paper cannot be finished after time ran out.
    if (Number.isFinite(expires) && now > expires + 120 * 1000) {
      const locked = await db.run(
        "UPDATE exam_attempts SET status='submitted', submitted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='in_progress'",
        [attempt.id]
      );
      if (Number(locked.changes) > 0) await finalizeAttempt(tid, attempt);
      return err(res, 409, "Your time for this examination ran out. It was submitted with the answers you had saved.");
    }
  } else if (attempt) {
    return err(res, 409, "You have already submitted this examination.");
  }
  if (!attempt) {
    const windowEnd = window ? window.end.getTime() : null;
    const durationMs = Math.max(1, Number(exam.duration_minutes) || 0) * 60 * 1000;
    let expiresAt;
    if (durationMs > 0) expiresAt = windowEnd ? new Date(Math.min(now + durationMs, windowEnd)) : new Date(now + durationMs);
    else expiresAt = windowEnd ? new Date(windowEnd) : new Date(now + 60 * 60 * 1000);
    try {
      await db.run(
        "INSERT INTO exam_attempts (madrasa_id, exam_id, student_id, user_id, status, expires_at) VALUES (?,?,?,?, 'in_progress', ?)",
        [tid, exam.id, target.id, req.user.id, sqlLocalTs(expiresAt)]
      );
    } catch (e) {
      // The UNIQUE (exam_id, student_id) constraint is the duplicate-attempt
      // backstop when two tabs race; the loser resumes the winner's attempt.
      if (!/unique|duplicate/i.test(String(e && e.message))) throw e;
    }
    attempt = await db.get("SELECT * FROM exam_attempts WHERE exam_id=? AND madrasa_id=? AND student_id=?", [exam.id, tid, target.id]);
  }
  if (!attempt || attempt.status !== "in_progress") return err(res, 409, "You have already submitted this examination.");
  const saved = await db.all("SELECT exam_question_id, answer_text FROM exam_answers WHERE attempt_id=? AND madrasa_id=?", [attempt.id, tid]);
  ok(res, {
    exam: {
      id: exam.id, title: exam.title, subject_name: exam.subject_name, instructions: exam.instructions,
      exam_date: exam.exam_date, start_time: exam.start_time, end_time: exam.end_time,
      duration_minutes: exam.duration_minutes, total_marks: Number(exam.total_marks), question_count: questions.length,
    },
    questions: questions.map((q) => ({
      id: q.id, position: q.position, question_text: q.question_text,
      question_type: q.question_type, options: q.options, marks: q.marks,
    })),
    answers: saved.map((a) => ({ question_id: a.exam_question_id, answer: a.answer_text })),
    attempt: { id: attempt.id, started_at: attempt.started_at, expires_at: attempt.expires_at },
    serverTime: new Date().toISOString(),
  });
}));

/**
 * PUT /api/portal/online-exams/:id/answers — autosave. Strictly inside the
 * attempt's time budget; the graded/locked state refuses writes.
 */
router.put("/online-exams/:id/answers", asyncHandler(async (req, res) => {
  if (req.user.role !== "student") return err(res, 403, "Only students take examinations.");
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const target = students.length ? students[0] : null;
  if (!target) return err(res, 404, "No student record found.");
  const exam = await loadOnlineExam(req, res, tid, target);
  if (!exam) return;
  const attempt = await db.get("SELECT * FROM exam_attempts WHERE exam_id=? AND madrasa_id=? AND student_id=?", [exam.id, tid, target.id]);
  if (!attempt || attempt.status !== "in_progress") return err(res, 409, "This attempt is no longer open.");
  const expires = ts(attempt.expires_at);
  if (Number.isFinite(expires) && Date.now() > expires) return err(res, 409, "Your time has run out — submit what you have saved.");
  const incoming = Array.isArray(req.body && req.body.answers) ? req.body.answers.slice(0, 200) : [];
  if (!incoming.length) return err(res, 400, "No answers supplied.");
  const questions = await db.all("SELECT id FROM exam_questions WHERE exam_id=? AND madrasa_id=?", [exam.id, tid]);
  const validIds = new Set(questions.map((q) => Number(q.id)));
  for (const a of incoming) {
    if (!validIds.has(toNum(a.question_id || a.questionId, 0))) return err(res, 400, "One of the answers does not belong to this examination.");
  }
  for (const a of incoming) {
    const qid = toNum(a.question_id || a.questionId, 0);
    const text = cleanStr(a.answer !== undefined ? a.answer : a.answer_text, 8000);
    const existing = await db.get("SELECT id FROM exam_answers WHERE attempt_id=? AND exam_question_id=? AND madrasa_id=?", [attempt.id, qid, tid]);
    if (existing) await db.run("UPDATE exam_answers SET answer_text=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [text, existing.id, tid]);
    else await db.run("INSERT INTO exam_answers (madrasa_id, attempt_id, exam_question_id, answer_text) VALUES (?,?,?,?)", [tid, attempt.id, qid, text]);
  }
  ok(res, { ok: true, saved: incoming.length, serverTime: new Date().toISOString(), expires_at: attempt.expires_at });
}));

/** Grades the objective answers of a submitted attempt and returns totals. */
async function finalizeAttempt(tid, attempt) {
  const questions = await db.all("SELECT * FROM exam_questions WHERE exam_id=? AND madrasa_id=? ORDER BY position, id", [attempt.exam_id, tid]);
  const answers = await db.all("SELECT * FROM exam_answers WHERE attempt_id=? AND madrasa_id=?", [attempt.id, tid]);
  const byQuestion = new Map(answers.map((a) => [Number(a.exam_question_id), a]));
  let auto = 0, total = 0;
  for (const q of questions) {
    total += Number(q.marks);
    const a = byQuestion.get(Number(q.id));
    if (!a) continue;
    let options = q.options;
    if (typeof options === "string" && options.trim()) { try { options = JSON.parse(options); } catch (e) { options = null; } }
    if (q.question_type === "multiple_choice" || q.question_type === "true_false" || q.question_type === "short_answer" || q.question_type === "fill_in_the_blank") {
      const correct = String(q.correct_answer || "").trim().toLowerCase();
      if (correct) {
        const given = String(a.answer_text || "").trim().toLowerCase();
        const isCorrect = given === correct;
        await db.run("UPDATE exam_answers SET is_correct=?, marks_awarded=?, graded_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
          [isCorrect ? 1 : 0, isCorrect ? Number(q.marks) : 0, a.id, tid]);
        if (isCorrect) auto += Number(q.marks);
      }
    }
  }
  const subjective = answers.filter((a) => a.is_correct === null && a.marks_awarded !== null && a.marks_awarded !== undefined)
    .reduce((sum, a) => sum + Number(a.marks_awarded), 0);
  const score = Math.round((auto + subjective) * 100) / 100;
  await db.run("UPDATE exam_attempts SET auto_score=?, score=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
    [Math.round(auto * 100) / 100, score, attempt.id, tid]);
  return { auto: Math.round(auto * 100) / 100, score, total: Math.round(total * 100) / 100 };
}

/**
 * POST /api/portal/online-exams/:id/submit — locks the attempt exactly once.
 * A short grace window (2 minutes) lets a finished paper survive a slow
 * network; after that the submission is refused. Duplicate submissions and
 * post-deadline edits are impossible by construction.
 */
router.post("/online-exams/:id/submit", asyncHandler(async (req, res) => {
  if (req.user.role !== "student") return err(res, 403, "Only students take examinations.");
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const target = students.length ? students[0] : null;
  if (!target) return err(res, 404, "No student record found.");
  const exam = await loadOnlineExam(req, res, tid, target);
  if (!exam) return;
  const attempt = await db.get("SELECT * FROM exam_attempts WHERE exam_id=? AND madrasa_id=? AND student_id=?", [exam.id, tid, target.id]);
  if (!attempt) return err(res, 409, "You have not started this examination.");
  if (attempt.status !== "in_progress") return err(res, 409, "This examination has already been submitted.");
  const expires = ts(attempt.expires_at);
  if (Number.isFinite(expires) && Date.now() > expires + 120 * 1000) {
    // Too late: lock whatever is saved, without accepting this submission.
    await db.run("UPDATE exam_attempts SET status='submitted', submitted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='in_progress'", [attempt.id]);
    const fresh = await db.get("SELECT * FROM exam_attempts WHERE id=?", [attempt.id]);
    await finalizeAttempt(tid, fresh);
    return err(res, 409, "Your time had already run out; the saved answers were submitted for you.");
  }
  const locked = await db.run(
    "UPDATE exam_attempts SET status='submitted', submitted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='in_progress'",
    [attempt.id]
  );
  if (!Number(locked.changes)) return err(res, 409, "This examination has already been submitted.");
  const fresh = await db.get("SELECT * FROM exam_attempts WHERE id=?", [attempt.id]);
  const result = await finalizeAttempt(tid, fresh);
  const window = onlineWindow(exam);
  const released = Boolean(exam.results_released_at);
  const windowEnded = window ? Date.now() > window.end.getTime() : true;
  ok(res, {
    ok: true, submitted_at: fresh.submitted_at,
    auto_score: result.auto, score: result.score, total: result.total,
    score_visible: released || windowEnded, results_released: released,
    message: "Your examination has been submitted.",
  });
}));

/**
 * GET /api/portal/online-exams/:id/review — the caller's own marked paper.
 * Available once results are released (or the window has closed). This is
 * the ONLY place correct answers and explanations reach a student, and only
 * for their own attempt.
 */
router.get("/online-exams/:id/review", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const byId = new Map(students.map((s) => [Number(s.id), s]));
  const target = resolveStudentTarget(req, byId);
  if (!target) return err(res, 404, "No student record found.");
  const exam = await loadOnlineExam(req, res, tid, target);
  if (!exam) return;
  const attempt = await db.get("SELECT * FROM exam_attempts WHERE exam_id=? AND madrasa_id=? AND student_id=?", [exam.id, tid, target.id]);
  if (!attempt || attempt.status === "in_progress") return err(res, 404, "No submitted examination to review.");
  const window = onlineWindow(exam);
  const released = Boolean(exam.results_released_at);
  const windowEnded = window ? Date.now() > window.end.getTime() : true;
  if (!released && !windowEnded) return err(res, 403, "Results for this examination have not been released yet.");
  const questions = await db.all("SELECT * FROM exam_questions WHERE exam_id=? AND madrasa_id=? ORDER BY position, id", [exam.id, tid]);
  const answers = await db.all("SELECT * FROM exam_answers WHERE attempt_id=? AND madrasa_id=?", [attempt.id, tid]);
  const byQuestion = new Map(answers.map((a) => [Number(a.exam_question_id), a]));
  ok(res, {
    exam: {
      id: exam.id, title: exam.title, subject_name: exam.subject_name,
      total_marks: Number(exam.total_marks), results_released: released,
    },
    attempt: { status: attempt.status, submitted_at: attempt.submitted_at, auto_score: attempt.auto_score, score: attempt.score },
    questions: questions.map((q) => {
      const a = byQuestion.get(Number(q.id));
      return {
        id: q.id, position: q.position, question_text: q.question_text, question_type: q.question_type,
        options: q.options, marks: q.marks,
        answer: a ? a.answer_text : "", is_correct: a ? a.is_correct : null, marks_awarded: a ? a.marks_awarded : null,
        correct_answer: q.correct_answer, explanation: q.explanation,
      };
    }),
  });
}));

/* ------------------------------- contacts ------------------------------- */

/**
 * GET /api/portal/contacts — the people this user may message: the teachers
 * assigned to their (children's) class(es) plus institution administrators.
 * This is the portal's directory; the message route independently refuses
 * non-listed recipients for student/parent senders.
 */
router.get("/contacts", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const students = await accessibleStudents(req, tid);
  const classIds = [...new Set(students.map((s) => Number(s.class_id)).filter(Boolean))];
  const teachers = classIds.length
    ? await db.all(
      `SELECT DISTINCT u.id, u.full_name, u.role, GROUP_CONCAT(sub.name_en) AS subjects
         FROM teacher_assignments ta
         JOIN users u ON u.id = ta.user_id AND u.madrasa_id = ta.madrasa_id AND u.is_active = 1 AND u.role = 'teacher'
         LEFT JOIN subjects sub ON sub.id = ta.subject_id AND sub.madrasa_id = ta.madrasa_id
        WHERE ta.madrasa_id = ? AND ta.class_id IN (${classIds.map(() => "?").join(",")})
        GROUP BY u.id, u.full_name ORDER BY u.full_name`,
      [tid].concat(classIds)
    )
    : [];
  const admins = await db.all(
    "SELECT id, full_name, role FROM users WHERE madrasa_id = ? AND role = 'madrasa_admin' AND is_active = 1 ORDER BY full_name",
    [tid]
  );
  ok(res, {
    contacts: admins.concat(teachers.map((t) => Object.assign({}, t, { subjects: t.subjects || "" }))),
  });
}));

/* ------------------------------ announcements -------------------------- */

router.get("/announcements", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const aud = req.user.role === "student" ? "students" : "parents";
  await db.run("UPDATE announcements SET status='published', is_active=1, published_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=? AND status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at<=CURRENT_TIMESTAMP", [tid]);
  const candidates = await db.all(
    "SELECT id, title, body, audience, target_type, target_ids, created_at FROM announcements WHERE madrasa_id = ? AND is_active = 1 AND status = 'published' AND (scheduled_at IS NULL OR scheduled_at <= CURRENT_TIMESTAMP) ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT 200",
    [tid]
  );
  const students = await accessibleStudents(req, tid);
  const allowedStudentIds = new Set(students.map((s) => Number(s.id)));
  const allowedClasses = new Set(students.map((s) => Number(s.class_id)).filter(Boolean));
  const visible = candidates.filter((a) => {
    const type = String(a.target_type || a.audience || 'all');
    if (type === 'all' || type === 'institution' || a.audience === 'all' || a.audience === aud) return true;
    if (type === 'students' || type === 'parents') return type === aud;
    let targetIds = []; try { targetIds = JSON.parse(a.target_ids || '[]').map(Number); } catch (_) {}
    if (type === 'individual_users') return targetIds.includes(Number(req.user.id));
    if (type === 'specific_class') return students.some((s) => targetIds.includes(Number(s.class_id)));
    if (type === 'specific_student_group') return false; // group membership is evaluated below when present
    if (type === 'islamic_section' || type === 'western_section') return students.some((s) => String(s.section || '').toLowerCase().includes(type.split('_')[0]) || String(s.education_track || '').toLowerCase() === type.split('_')[0] || s.education_track === 'both');
    return false;
  });
  // Groups are resolved against the existing group-member and parent-link rows;
  // this avoids broadening a private announcement to every portal user.
  for (const a of candidates.filter((x) => x.target_type === 'specific_student_group')) {
    let groupIds = []; try { groupIds = JSON.parse(a.target_ids || '[]').map(Number); } catch (_) {}
    if (!groupIds.length) continue;
    const marks = groupIds.map(() => '?').join(',');
    const rows = await db.all(`SELECT DISTINCT s.id FROM student_group_members gm JOIN students s ON s.id=gm.student_id AND s.madrasa_id=gm.madrasa_id WHERE gm.madrasa_id=? AND gm.group_id IN (${marks})`, [tid].concat(groupIds));
    const childIds = new Set(rows.map((r) => Number(r.id)));
    const allowed = req.user.role === 'student' ? childIds.has(Number(req.user.studentId)) : students.some((s) => childIds.has(Number(s.id)));
    if (allowed && !visible.includes(a)) visible.push(a);
  }
  ok(res, { announcements: visible });
}));

module.exports = router;
