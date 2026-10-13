"use strict";
/* Tenant-scoped student and teacher attendance registers and reports. */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, toNum, cleanStr, validDate, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments, teacherCanMarkAttendance } = require("../middleware/tenant");
const communication = require("../services/communication");
const cardCreds = require("../services/card-credentials");

const router = express.Router();
router.use(requireAuth, requireTenant);
const ADMIN = requireRole("madrasa_admin", "super_admin");
/* Writing a register is a staff action and only a staff action. A learner who
   could POST their own attendance would make every register worthless, and a
   parent — whose account is a read-only window on their own children — must
   not be able to mark a class either. Reading a card needs no account at all
   (/verify/<code>, /api/public/card/<code>), so verification is still open to
   anyone holding the card. */
const STAFF_ROLE = requireRole("madrasa_admin", "super_admin", "teacher");

const STUDENT_STATUSES = new Set(["present", "absent", "late", "excused"]);
const TEACHER_STATUSES = new Set(["present", "absent", "late", "on_leave", "excused"]);

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required." }); return null; }
  return tid;
}
function timeOrBlank(value) {
  const s = cleanStr(value, 5);
  return s === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}
function attendanceValue(value, allowed, fallbackNotes = "") {
  if (typeof value === "object" && value !== null) return { status: cleanStr(value.status, 20).toLowerCase(), note: cleanStr(value.note || value.notes, 2000) };
  return { status: cleanStr(value, 20).toLowerCase(), note: fallbackNotes };
}

async function termContext(tid, day, requestedTerm, requestedSession) {
  let termId = requestedTerm ? toNum(requestedTerm, 0) : 0;
  let sessionId = requestedSession ? toNum(requestedSession, 0) : 0;
  if (termId) {
    const term = await db.get("SELECT id, session_id FROM terms WHERE id = ? AND madrasa_id = ?", [termId, tid]);
    if (!term) return { error: "Term not found." };
    if (sessionId && Number(term.session_id) !== sessionId) return { error: "Term does not belong to the selected session." };
    sessionId = Number(term.session_id);
  } else {
    const term = await db.get(
      `SELECT t.id, t.session_id FROM terms t JOIN academic_sessions s ON s.id = t.session_id
       WHERE t.madrasa_id = ? AND (t.start_date IS NULL OR t.start_date <= ?) AND (t.end_date IS NULL OR t.end_date >= ?)
       ${sessionId ? "AND t.session_id = ?" : ""} ORDER BY s.is_current DESC, s.id DESC, t.position LIMIT 1`,
      sessionId ? [tid, day, day, sessionId] : [tid, day, day]
    );
    if (term) { termId = Number(term.id); sessionId = Number(term.session_id); }
  }
  if (sessionId && !(await db.get("SELECT id FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sessionId, tid]))) return { error: "Academic session not found." };
  return { termId: termId || null, sessionId: sessionId || null };
}

async function checkClassAccess(req, res, tid, classId) {
  const cls = await db.get("SELECT * FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!cls) { res.status(404).json({ error: "Class not found." }); return null; }
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!teacherCanMarkAttendance(scope, classId)) { res.status(404).json({ error: "Not found." }); return null; }
  }
  return cls;
}

/* ------------------------------ scan to mark ------------------------------
   The other half of the QR code on every card. Verification answers "is this
   card real?"; this endpoint answers the question a gate, a bus or a register
   actually asks: "who is this, and are they here today?"

   One scan does all of it:

     • resolves the code inside THIS school only (a code from another tenant is
       not found, never "valid")
     • reports the verdict — valid / cancelled / inactive / school closed
     • marks the holder present (or late / absent / excused) in the register for
       the school's own calendar day, idempotently: scanning the same card twice
       updates nothing and says "already marked"
     • for staff cards, lets an administrator check a member of staff in at the
       school's local clock time
     • returns the roster position for the holder's class today, so a gate
       operator can see how many learners are still unmarked

   A cancelled card marks nothing. A teacher may only mark a class they are
   assigned to (the same rule as the hand-typed register), and staff attendance
   stays an administrator action. Every scan is written to the activity log.
-------------------------------------------------------------------------- */
async function notifyAttendanceOutcome(tid, studentId, status, day, userId) {
  if (status !== "absent" && status !== "late") return;
  const recipients = await db.all("SELECT user_id FROM parent_links WHERE madrasa_id = ? AND student_id = ?", [tid, studentId]);
  const studentUser = await db.get("SELECT id FROM users WHERE madrasa_id = ? AND student_id = ? AND is_active = 1", [tid, studentId]);
  const recipientIds = [...new Set(recipients.map((r) => Number(r.user_id)).concat(studentUser ? [Number(studentUser.id)] : []))];
  const title = status === "absent" ? "Student absent" : "Student late";
  await communication.createNotifications(tid, recipientIds, {
    type: status === "absent" ? "student_absent" : "student_late",
    title,
    body: `Attendance recorded as ${status} for ${day}.`,
    entity_type: "attendance",
    entity_id: studentId,
  });
  for (const recipientId of recipientIds) {
    await communication.recordCommunication(tid, {
      student_id: studentId, recipient_user_id: recipientId, parent_user_id: recipientId,
      channel: "in_app", message_type: "attendance_alert", subject: "Attendance alert",
      message: `Attendance recorded as ${status} for ${day}.`, sent_by: userId,
    });
  }
}

/** The wall clock the school actually reads, so a check-in time is honest. */
function schoolClock(timezone, when) {
  const date = when ? new Date(when) : new Date();
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: timezone || "Africa/Lagos", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  } catch (e) {
    return date.toISOString().slice(11, 16);
  }
}

router.post("/scan", STAFF_ROLE, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const code = cardCreds.normaliseCode(b.code || b.card_code || b.card);
  if (!code) return err(res, 400, "Scan a card or type the code printed under its QR.");
  const day = validDate(b.date) || new Date().toISOString().slice(0, 10);
  const mark = !(b.mark === false || b.mark === 0 || b.mark === "0");

  // The code is the capability, but only inside the school that minted it.
  const credential = await db.get("SELECT * FROM card_credentials WHERE madrasa_id = ? AND code = ?", [tid, code]);
  if (!credential) return err(res, 404, "That code does not belong to a card issued by this school.");
  const resolved = await cardCreds.lookupCard(code);
  if (!resolved) return err(res, 404, "The holder of that card is no longer on this school's register.");

  const card = cardCreds.cardVerificationView(resolved);
  const holder = resolved.holder;
  const isTeacher = card.holderType === "teacher";
  const school = await db.get("SELECT timezone FROM madaris WHERE id = ?", [tid]);
  const payload = {
    ok: true,
    day,
    card,
    verifyUrl: `/verify/${encodeURIComponent(card.code)}`,
    holder: {
      type: card.holderType,
      id: Number(holder.id),
      name: card.name,
      identifier: card.identifier,
      photoPath: card.photoPath,
      role: card.role,
      className: isTeacher ? "" : (holder.class_name || ""),
      classId: isTeacher ? null : (holder.class_id ? Number(holder.class_id) : null),
      department: isTeacher ? (holder.department || "") : "",
    },
    printPath: isTeacher ? `/documents/staff-id-card/${Number(holder.id)}` : `/documents/id-card/${Number(holder.id)}`,
  };

  // A card that no longer vouches for its holder cannot mark anything.
  if (!card.valid) {
    if (credential.status === "revoked") {
      await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "attendance.scan.blocked", entity: "card_credentials", entityId: String(credential.id), meta: { code: card.code, verdict: card.verdict }, ip: req.ip });
      return res.json(Object.assign(payload, {
        marked: false, reason: "revoked",
        message: "This card was cancelled — it cannot mark attendance. Ask for another form of identification.",
      }));
    }
    return res.json(Object.assign(payload, {
      marked: false, reason: card.verdict,
      message: card.verdict === "closed"
        ? "The issuing school is not active, so attendance cannot be marked from this card."
        : "This holder is not currently active, so nothing was marked. Check the office record.",
    }));
  }

  const context = await termContext(tid, day, b.termId || b.term_id, b.sessionId || b.session_id);
  if (context.error) return err(res, 400, context.error);

  /* --------------------------- a member of staff -------------------------- */
  if (isTeacher) {
    if (!["madrasa_admin", "super_admin"].includes(req.user.role)) {
      return res.json(Object.assign(payload, {
        marked: false, reason: "staff_admin_only",
        message: "The card is valid. Staff attendance is recorded by an administrator.",
      }));
    }
    if (!mark) return res.json(Object.assign(payload, { marked: false, reason: "verify_only", message: "Card checked. Nothing was marked." }));
    const status = TEACHER_STATUSES.has(String(b.status || "").toLowerCase()) ? String(b.status).toLowerCase() : "present";
    const checkIn = b.checkIn || b.check_in ? timeOrBlank(b.checkIn || b.check_in) : schoolClock(school && school.timezone);
    if (checkIn === null) return err(res, 400, "Check-in must use HH:MM.");
    const existing = await db.get("SELECT * FROM teacher_attendance WHERE madrasa_id = ? AND user_id = ? AND day = ?", [tid, holder.id, day]);
    const alreadyMarked = Boolean(existing && existing.status === status && String(existing.check_in || "") === String(checkIn || ""));
    if (existing) {
      await db.run(
        "UPDATE teacher_attendance SET status = ?, term_id = ?, session_id = ?, check_in = ?, notes = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
        [status, context.termId, context.sessionId, checkIn, cleanStr(b.note || b.notes, 2000), req.user.id, existing.id, tid]
      );
    } else {
      await db.run(
        "INSERT INTO teacher_attendance (madrasa_id, user_id, day, term_id, session_id, status, check_in, check_out, notes, recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [tid, holder.id, day, context.termId, context.sessionId, status, checkIn, cleanStr(b.check_out, 5), cleanStr(b.note || b.notes, 2000), req.user.id]
      );
    }
    await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "attendance.scan", entity: "teacher_attendance", entityId: String(holder.id), meta: { code: card.code, day, status, checkIn }, ip: req.ip });
    return res.json(Object.assign(payload, {
      marked: true, alreadyMarked, status, checkIn, message: alreadyMarked ? `${card.name} was already checked in at ${checkIn}.` : `${card.name} checked in at ${checkIn}.`,
      attendance: { status, day, checkIn },
    }));
  }

  /* ------------------------------ a learner ------------------------------- */
  const classId = Number(holder.class_id || 0);
  if (!classId) {
    return res.json(Object.assign(payload, {
      marked: false, reason: "no_class",
      message: "This learner is not assigned to a class, so there is no register to mark. Assign a class in the student profile first.",
    }));
  }
  if (req.user.role === "teacher") {
    const cls = await checkClassAccess(req, res, tid, classId);
    if (!cls) return;
  }
  if (!mark) return res.json(Object.assign(payload, { marked: false, reason: "verify_only", message: "Card checked. Nothing was marked." }));

  const status = STUDENT_STATUSES.has(String(b.status || "").toLowerCase()) ? String(b.status).toLowerCase() : "present";
  const existing = await db.get("SELECT * FROM attendance WHERE madrasa_id = ? AND student_id = ? AND day = ?", [tid, holder.id, day]);
  const alreadyMarked = Boolean(existing && existing.status === status);
  if (existing) {
    await db.run(
      "UPDATE attendance SET status = ?, class_id = ?, term_id = ?, session_id = ?, attendance_note = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
      [status, classId, context.termId, context.sessionId, cleanStr(b.note || b.notes, 2000) || existing.attendance_note || "", req.user.id, existing.id, tid]
    );
  } else {
    await db.run(
      "INSERT INTO attendance (madrasa_id, student_id, class_id, term_id, session_id, day, status, attendance_note, recorded_by) VALUES (?,?,?,?,?,?,?,?,?)",
      [tid, holder.id, classId, context.termId, context.sessionId, day, status, cleanStr(b.note || b.notes, 2000) || "Marked from an ID card scan", req.user.id]
    );
  }
  await notifyAttendanceOutcome(tid, holder.id, status, day, req.user.id);

  const totals = await db.get(
    "SELECT COUNT(*) AS marked, COALESCE(SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END), 0) AS present FROM attendance WHERE madrasa_id = ? AND class_id = ? AND day = ?",
    [tid, classId, day]
  );
  const roster = await db.get(
    "SELECT COUNT(*) AS total FROM students WHERE madrasa_id = ? AND class_id = ? AND status NOT IN ('withdrawn','inactive')",
    [tid, classId]
  );
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "attendance.scan", entity: "student", entityId: String(holder.id), meta: { code: card.code, day, status, classId, alreadyMarked }, ip: req.ip });

  const markedNow = Number(totals && totals.marked || 0);
  const total = Number(roster && roster.total || 0);
  return res.json(Object.assign(payload, {
    marked: true,
    alreadyMarked,
    status,
    message: alreadyMarked
      ? `${card.name} was already marked ${status} today.`
      : `${card.name} marked ${status} for ${day}.`,
    attendance: { status, day, classId, className: holder.class_name || "" },
    classToday: { marked: markedNow, present: Number(totals && totals.present || 0), total, remaining: Math.max(0, total - markedNow) },
  }));
}));

/** Daily student register. */
router.get("/", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const classId = toNum(req.query.classId, 0); const day = validDate(req.query.date);
  if (!classId || !day) return err(res, 400, "classId and date (YYYY-MM-DD) are required.");
  const cls = await checkClassAccess(req, res, tid, classId); if (!cls) return;
  const context = await termContext(tid, day, req.query.termId, req.query.sessionId);
  if (context.error) return err(res, 400, context.error);
  const [students, marks] = await Promise.all([
    db.all("SELECT id, admission_no, first_name, last_name, name_ar FROM students WHERE madrasa_id = ? AND class_id = ? AND status IN ('active','promoted','suspended') ORDER BY admission_no", [tid, classId]),
    db.all("SELECT student_id, status, attendance_note, recorded_by, updated_at FROM attendance WHERE madrasa_id = ? AND class_id = ? AND day = ?", [tid, classId, day]),
  ]);
  const markMap = new Map(marks.map((m) => [Number(m.student_id), m]));
  ok(res, { date: day, class: cls, termId: context.termId, sessionId: context.sessionId,
    students: students.map((student) => Object.assign({}, student, markMap.has(Number(student.id)) ? markMap.get(Number(student.id)) : { status: "", attendance_note: "" })) });
}));

/** Save or edit a complete daily class register. */
router.post("/mark", STAFF_ROLE, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {}; const classId = toNum(b.classId || b.class_id, 0); const day = validDate(b.date);
  if (!classId || !day) return err(res, 400, "classId and date are required.");
  const cls = await checkClassAccess(req, res, tid, classId); if (!cls) return;
  const context = await termContext(tid, day, b.termId || b.term_id, b.sessionId || b.session_id);
  if (context.error) return err(res, 400, context.error);
  const statuses = b.statuses && typeof b.statuses === "object" ? b.statuses : {};
  const notes = b.notes && typeof b.notes === "object" ? b.notes : {};
  // Bounded batch: one register save covers one class (tens of students).
  // An arbitrary payload could otherwise demand thousands of queries in one
  // request — reject oversized batches up front.
  if (Object.keys(statuses).length > 500) {
    return err(res, 400, "Too many attendance entries in one request (limit 500). Save the register in smaller batches.");
  }
  let saved = 0;
  for (const [sid, raw] of Object.entries(statuses)) {
    const studentId = toNum(sid, 0); const value = attendanceValue(raw, STUDENT_STATUSES, cleanStr(notes[sid], 2000));
    if (!STUDENT_STATUSES.has(value.status)) continue;
    const student = await db.get("SELECT id FROM students WHERE id = ? AND madrasa_id = ? AND class_id = ?", [studentId, tid, classId]);
    if (!student) continue;
    const existing = await db.get("SELECT id FROM attendance WHERE madrasa_id = ? AND student_id = ? AND day = ?", [tid, studentId, day]);
    if (existing) {
      await db.run("UPDATE attendance SET status = ?, class_id = ?, term_id = ?, session_id = ?, attendance_note = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [value.status, classId, context.termId, context.sessionId, value.note, req.user.id, existing.id, tid]);
    } else {
      await db.run("INSERT INTO attendance (madrasa_id, student_id, class_id, term_id, session_id, day, status, attendance_note, recorded_by) VALUES (?,?,?,?,?,?,?,?,?)", [tid, studentId, classId, context.termId, context.sessionId, day, value.status, value.note, req.user.id]);
    }
    await notifyAttendanceOutcome(tid, studentId, value.status, day, req.user.id);
    saved++;
  }
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "attendance.mark", entity: "class", entityId: String(classId), meta: { date: day, saved }, ip: req.ip });
  ok(res, { ok: true, saved, date: day, termId: context.termId, sessionId: context.sessionId });
}));

router.patch("/:id", STAFF_ROLE, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await db.get("SELECT * FROM attendance WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!row) return err(res, 404, "Attendance record not found.");
  const cls = await checkClassAccess(req, res, tid, Number(row.class_id)); if (!cls) return;
  const value = attendanceValue(req.body && (req.body.status || req.body), STUDENT_STATUSES, cleanStr(req.body && (req.body.attendance_note || req.body.note), 2000));
  if (!STUDENT_STATUSES.has(value.status)) return err(res, 400, "Attendance status is invalid.");
  await db.run("UPDATE attendance SET status = ?, attendance_note = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [value.status, value.note, req.user.id, row.id, tid]);
  ok(res, { ok: true, record: await db.get("SELECT * FROM attendance WHERE id = ? AND madrasa_id = ?", [row.id, tid]) });
}));

/** Attendance history for a class or individual learner. */
router.get("/history", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const classId = toNum(req.query.classId, 0); const studentId = toNum(req.query.studentId, 0);
  const from = validDate(req.query.from) || "0000-01-01"; const to = validDate(req.query.to) || "9999-12-31";
  const where = ["a.madrasa_id = ?", "a.day >= ?", "a.day <= ?"]; const params = [tid, from, to];
  if (classId) { where.push("a.class_id = ?"); params.push(classId); }
  if (studentId) { where.push("a.student_id = ?"); params.push(studentId); }
  // Bounded read: the UI asks for one class over one month, but a client that
  // omits from/to must not be able to pull the tenant's whole register in one
  // response. 2000 covers a large class over a full term with headroom.
  const limit = Math.min(2000, Math.max(1, toNum(req.query.limit, 2000)));
  const rows = await db.all(`SELECT a.*, s.admission_no, s.first_name, s.last_name, c.name_en AS class_name, t.name_en AS term_name, ses.label AS session_label, u.full_name AS recorded_by_name
    FROM attendance a JOIN students s ON s.id = a.student_id AND s.madrasa_id = a.madrasa_id
    LEFT JOIN classes c ON c.id = a.class_id AND c.madrasa_id = a.madrasa_id
    LEFT JOIN terms t ON t.id = a.term_id AND t.madrasa_id = a.madrasa_id
    LEFT JOIN academic_sessions ses ON ses.id = a.session_id AND ses.madrasa_id = a.madrasa_id
    LEFT JOIN users u ON u.id = a.recorded_by AND u.madrasa_id = a.madrasa_id
    WHERE ${where.join(" AND ")} ORDER BY a.day DESC, s.admission_no LIMIT ?`, params.concat([limit]));
  ok(res, { from, to, truncated: rows.length >= limit, records: rows });
}));

router.get("/student/:studentId", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const studentId = toNum(req.params.studentId, 0); const limit = Math.min(1000, Math.max(1, toNum(req.query.limit, 60)));
  const student = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [studentId, tid]);
  if (!student) return err(res, 404, "Student not found.");
  if (req.user.role === "teacher") { const scope = await getTeacherAssignments(tid, req.user.id); if (!scope.anyClassAnySubject && (!student.class_id || !scope.assignedClassIds.has(Number(student.class_id)))) return err(res, 404, "Not found."); }
  const rows = await db.all("SELECT day, status, attendance_note, term_id, session_id, recorded_by, updated_at FROM attendance WHERE madrasa_id = ? AND student_id = ? ORDER BY day DESC LIMIT ?", [tid, studentId, limit]);
  ok(res, { student, attendance: rows });
}));

async function studentReport(req, res) {
  const tid = await tenantId(req, res); if (tid == null) return;
  const studentId = toNum(req.params.studentId || req.query.studentId, 0);
  if (!studentId) return err(res, 400, "studentId is required.");
  const from = validDate(req.query.from) || "0000-01-01"; const to = validDate(req.query.to) || "9999-12-31";
  const student = await db.get("SELECT s.*, c.name_en AS class_name FROM students s LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id WHERE s.id = ? AND s.madrasa_id = ?", [studentId, tid]);
  if (!student) return err(res, 404, "Student not found.");
  const rows = await db.all(`SELECT status, COUNT(*) AS n FROM attendance WHERE madrasa_id = ? AND student_id = ? AND day >= ? AND day <= ? GROUP BY status`, [tid, studentId, from, to]);
  const totals = { totalSchoolDays: 0, totalRecordedDays: 0, presentDays: 0, absentDays: 0, lateDays: 0, excusedDays: 0 };
  rows.forEach((row) => { const n = Number(row.n); totals.totalRecordedDays += n; if (row.status === "present") totals.presentDays += n; if (row.status === "absent") totals.absentDays += n; if (row.status === "late") totals.lateDays += n; if (row.status === "excused") totals.excusedDays += n; });
  const schoolDays = await db.get("SELECT COUNT(DISTINCT day) AS n FROM attendance WHERE madrasa_id = ? AND class_id = ? AND day >= ? AND day <= ?", [tid, student.class_id, from, to]);
  totals.totalSchoolDays = Number(schoolDays && schoolDays.n || totals.totalRecordedDays);
  const percentage = totals.totalRecordedDays ? Math.round((totals.presentDays / totals.totalRecordedDays) * 1000) / 10 : 0;
  const attendedPercentage = totals.totalRecordedDays ? Math.round(((totals.presentDays + totals.lateDays) / totals.totalRecordedDays) * 1000) / 10 : 0;
  ok(res, { from, to, student, ...totals, attendancePercentage: percentage, attendance_percentage: percentage, attendedPercentage, records: await db.all("SELECT day, status, attendance_note, term_id, session_id FROM attendance WHERE madrasa_id = ? AND student_id = ? AND day >= ? AND day <= ? ORDER BY day DESC LIMIT 1000", [tid, studentId, from, to]) });
}
router.get("/student/:studentId/report", ADMIN, asyncHandler(studentReport));

/* ------------------------------ teacher register ----------------------- */
router.get("/teachers", ADMIN, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const day = validDate(req.query.date);
  if (!day) return err(res, 400, "date (YYYY-MM-DD) is required.");
  const [teachers, marks] = await Promise.all([
    db.all("SELECT u.id, u.full_name, u.full_name_ar, u.email, u.phone, u.is_active, tp.department FROM users u LEFT JOIN teacher_profiles tp ON tp.user_id = u.id AND tp.madrasa_id = u.madrasa_id WHERE u.madrasa_id = ? AND u.role = 'teacher' ORDER BY u.full_name", [tid]),
    db.all("SELECT user_id, status, term_id, session_id, check_in, check_out, notes, recorded_by FROM teacher_attendance WHERE madrasa_id = ? AND day = ?", [tid, day]),
  ]);
  const markMap = new Map(marks.map((mark) => [Number(mark.user_id), mark]));
  ok(res, { date: day, teachers: teachers.map((teacher) => Object.assign({}, teacher, markMap.get(Number(teacher.id)) || { status: "", check_in: "", check_out: "", notes: "" })) });
}));

router.post("/teachers/mark", ADMIN, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {}; const day = validDate(b.date);
  if (!day) return err(res, 400, "date (YYYY-MM-DD) is required.");
  const context = await termContext(tid, day, b.termId || b.term_id, b.sessionId || b.session_id);
  if (context.error) return err(res, 400, context.error);
  const statuses = b.statuses && typeof b.statuses === "object" ? b.statuses : {}; const details = b.details && typeof b.details === "object" ? b.details : {};
  let saved = 0;
  for (const [rawId, raw] of Object.entries(statuses)) {
    const userId = toNum(rawId, 0); const detail = typeof raw === "object" && raw !== null ? raw : (details[rawId] || {});
    const value = attendanceValue(raw, TEACHER_STATUSES, cleanStr(detail.notes || detail.note, 2000));
    if (!userId || !TEACHER_STATUSES.has(value.status)) continue;
    const teacher = await db.get("SELECT id FROM users WHERE id = ? AND madrasa_id = ? AND role = 'teacher'", [userId, tid]);
    if (!teacher) continue;
    const checkIn = timeOrBlank(detail.check_in || detail.checkIn || b.check_in); const checkOut = timeOrBlank(detail.check_out || detail.checkOut || b.check_out);
    if (checkIn === null || checkOut === null) return err(res, 400, "Check-in and check-out times must use HH:MM.");
    const existing = await db.get("SELECT id FROM teacher_attendance WHERE madrasa_id = ? AND user_id = ? AND day = ?", [tid, userId, day]);
    if (existing) await db.run("UPDATE teacher_attendance SET status = ?, term_id = ?, session_id = ?, check_in = ?, check_out = ?, notes = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [value.status, context.termId, context.sessionId, checkIn, checkOut, value.note, req.user.id, existing.id, tid]);
    else await db.run("INSERT INTO teacher_attendance (madrasa_id, user_id, day, term_id, session_id, status, check_in, check_out, notes, recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?)", [tid, userId, day, context.termId, context.sessionId, value.status, checkIn, checkOut, value.note, req.user.id]);
    saved++;
  }
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "teacher_attendance.mark", entity: "teacher_attendance", meta: { date: day, saved }, ip: req.ip });
  ok(res, { ok: true, saved, date: day, termId: context.termId, sessionId: context.sessionId });
}));

router.patch("/teachers/:id", ADMIN, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await db.get("SELECT * FROM teacher_attendance WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), tid]);
  if (!row) return err(res, 404, "Teacher attendance record not found.");
  const b = req.body || {}; const status = cleanStr(b.status, 20).toLowerCase();
  if (!TEACHER_STATUSES.has(status)) return err(res, 400, "Teacher attendance status is invalid.");
  const checkIn = timeOrBlank(b.check_in ?? b.checkIn ?? row.check_in); const checkOut = timeOrBlank(b.check_out ?? b.checkOut ?? row.check_out);
  if (checkIn === null || checkOut === null) return err(res, 400, "Check-in and check-out times must use HH:MM.");
  await db.run("UPDATE teacher_attendance SET status = ?, check_in = ?, check_out = ?, notes = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [status, checkIn, checkOut, cleanStr(b.notes || b.note, 2000), req.user.id, row.id, tid]);
  ok(res, { ok: true, record: await db.get("SELECT * FROM teacher_attendance WHERE id = ? AND madrasa_id = ?", [row.id, tid]) });
}));

async function teacherReport(req, res) {
  const tid = await tenantId(req, res); if (tid == null) return;
  const from = validDate(req.query.from) || "0000-01-01"; const to = validDate(req.query.to) || "9999-12-31";
  const teacherId = toNum(req.params.teacherId || req.query.teacherId, 0); const department = cleanStr(req.query.department, 120);
  const where = ["ta.madrasa_id = ?", "ta.day >= ?", "ta.day <= ?"]; const params = [tid, from, to];
  if (teacherId) {
    // Same convention as the student report below: a filter naming a record
    // that does not belong to this tenant is "not found", not an empty report.
    // Returning 200 with no rows made a foreign id indistinguishable from a
    // teacher who simply has no attendance marked yet.
    if (!(await db.get("SELECT id FROM users WHERE id = ? AND madrasa_id = ?", [teacherId, tid]))) return err(res, 404, "Teacher not found.");
    where.push("ta.user_id = ?"); params.push(teacherId);
  }
  if (department) { where.push("tp.department = ?"); params.push(department); }
  const rows = await db.all(`SELECT ta.user_id AS teacher_id, u.full_name, tp.department,
      SUM(CASE WHEN ta.status = 'present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN ta.status = 'absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN ta.status = 'late' THEN 1 ELSE 0 END) AS late,
      SUM(CASE WHEN ta.status = 'on_leave' THEN 1 ELSE 0 END) AS on_leave,
      SUM(CASE WHEN ta.status = 'excused' THEN 1 ELSE 0 END) AS excused,
      COUNT(ta.id) AS marked
    FROM teacher_attendance ta JOIN users u ON u.id = ta.user_id AND u.madrasa_id = ta.madrasa_id
    LEFT JOIN teacher_profiles tp ON tp.user_id = ta.user_id AND tp.madrasa_id = ta.madrasa_id
    WHERE ${where.join(" AND ")} GROUP BY ta.user_id, u.full_name, tp.department ORDER BY u.full_name`, params);
  const records = await db.all(`SELECT ta.*, u.full_name, tp.department, ses.label AS session_label, t.name_en AS term_name, r.full_name AS recorded_by_name
    FROM teacher_attendance ta JOIN users u ON u.id = ta.user_id AND u.madrasa_id = ta.madrasa_id
    LEFT JOIN teacher_profiles tp ON tp.user_id = ta.user_id AND tp.madrasa_id = ta.madrasa_id
    LEFT JOIN academic_sessions ses ON ses.id = ta.session_id AND ses.madrasa_id = ta.madrasa_id
    LEFT JOIN terms t ON t.id = ta.term_id AND t.madrasa_id = ta.madrasa_id
    LEFT JOIN users r ON r.id = ta.recorded_by AND r.madrasa_id = ta.madrasa_id
    WHERE ${where.join(" AND ")} ORDER BY ta.day DESC, u.full_name`, params);
  const stats = rows.reduce((out, row) => { for (const key of ["present", "absent", "late", "on_leave", "excused", "marked"]) out[key] = (out[key] || 0) + Number(row[key] || 0); return out; }, {});
  stats.attendancePercentage = stats.marked ? Math.round((stats.present / stats.marked) * 1000) / 10 : 0;
  stats.attendedPercentage = stats.marked ? Math.round(((stats.present + stats.late) / stats.marked) * 1000) / 10 : 0;
  ok(res, { from, to, teacherId: teacherId || null, department: department || null, teachers: rows.map((row) => Object.assign({}, row, { present: Number(row.present || 0), absent: Number(row.absent || 0), late: Number(row.late || 0), on_leave: Number(row.on_leave || 0), excused: Number(row.excused || 0), marked: Number(row.marked || 0), attendancePercentage: Number(row.marked) ? Math.round((Number(row.present) / Number(row.marked)) * 1000) / 10 : 0, attendedPercentage: Number(row.marked) ? Math.round(((Number(row.present) + Number(row.late)) / Number(row.marked)) * 1000) / 10 : 0 })), records, stats });
}
router.get("/teacher/:teacherId/report", ADMIN, asyncHandler(teacherReport));

/** Central reporting endpoint: use type=student|teacher and the same filters in exports. */
router.get(["/report", "/reports"], ADMIN, asyncHandler(async (req, res) => {
  if (String(req.query.type || "student").toLowerCase() === "teacher") return teacherReport(req, res);
  const tid = await tenantId(req, res); if (tid == null) return;
  const from = validDate(req.query.from); const to = validDate(req.query.to);
  if (!from || !to || from > to) return err(res, 400, "A valid from and to date are required.");
  const classId = toNum(req.query.classId, 0); const studentId = toNum(req.query.studentId, 0);
  const where = ["a.madrasa_id = ?", "a.day >= ?", "a.day <= ?"]; const params = [tid, from, to];
  if (classId) { if (!(await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]))) return err(res, 404, "Class not found."); where.push("a.class_id = ?"); params.push(classId); }
  if (studentId) { if (!(await db.get("SELECT id FROM students WHERE id = ? AND madrasa_id = ?", [studentId, tid]))) return err(res, 404, "Student not found."); where.push("a.student_id = ?"); params.push(studentId); }
  if (req.query.sessionId) { where.push("a.session_id = ?"); params.push(toNum(req.query.sessionId, 0)); }
  if (req.query.termId) { where.push("a.term_id = ?"); params.push(toNum(req.query.termId, 0)); }
  if (req.query.educationTrack) { where.push("c.education_track = ?"); params.push(cleanStr(req.query.educationTrack, 20).toLowerCase()); }
  if (req.query.program) { where.push("(c.program LIKE ? OR EXISTS (SELECT 1 FROM class_subjects csx JOIN subjects sx ON sx.id = csx.subject_id WHERE csx.class_id = c.id AND sx.category LIKE ?))"); const q = `%${cleanStr(req.query.program, 80)}%`; params.push(q, q); }
  const rows = await db.all(`SELECT s.id, s.admission_no, s.first_name, s.last_name, c.name_en AS class_en,
    SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
    SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
    SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late,
    SUM(CASE WHEN a.status = 'excused' THEN 1 ELSE 0 END) AS excused, COUNT(a.id) AS marked
    FROM attendance a JOIN students s ON s.id = a.student_id AND s.madrasa_id = a.madrasa_id LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id
    WHERE ${where.join(" AND ")} GROUP BY s.id, s.admission_no, s.first_name, s.last_name, c.name_en ORDER BY c.name_en, s.admission_no`, params);
  const students = rows.map((row) => { const marked = Number(row.marked || 0); const present = Number(row.present || 0); const late = Number(row.late || 0); return Object.assign({}, row, { present, absent: Number(row.absent || 0), late, excused: Number(row.excused || 0), marked, total_recorded_days: marked, attendance_percentage: marked ? Math.round((present / marked) * 1000) / 10 : 0, attended_percentage: marked ? Math.round(((present + late) / marked) * 1000) / 10 : 0 }); });
  const totals = students.reduce((out, row) => { for (const key of ["present", "absent", "late", "excused", "marked"]) out[key] = (out[key] || 0) + Number(row[key] || 0); return out; }, { present: 0, absent: 0, late: 0, excused: 0, marked: 0 });
  totals.attendancePercentage = totals.marked ? Math.round((totals.present / totals.marked) * 1000) / 10 : 0; totals.attendedPercentage = totals.marked ? Math.round(((totals.present + totals.late) / totals.marked) * 1000) / 10 : 0;
  ok(res, { from, to, classId: classId || null, studentId: studentId || null, students, totals, statistics: { totalPresent: totals.present, totalAbsent: totals.absent, totalLate: totals.late, totalExcused: totals.excused, attendancePercentage: totals.attendancePercentage } });
}));

module.exports = router;
// Additive export (the router itself is unchanged): the staff-leave module
// resolves the same term/session context when it writes 'on_leave' rows into
// this register, instead of duplicating the resolution rules.
module.exports.termContext = termContext;
module.exports.TEACHER_STATUSES = TEACHER_STATUSES;
