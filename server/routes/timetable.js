"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — class timetables
   ----------------------------------------------------------------------------
     GET  /api/timetable?classId=&termId=        grid + slots for one class
     PUT  /api/timetable                          replace the whole week for a class
     POST /api/timetable/copy                     copy a week to other classes
     GET  /api/timetable/me                       teacher / student / parent view
     GET  /api/timetable/print?classId=&termId=   printable A4 week (same style as
                                                  the report cards)

   A slot is (class, day, period) — unique per madrasa — plus optional subject,
   teacher, room and clock times. Times are 'HH:MM' strings so SQLite and MySQL
   behave identically. Editing is madrasa_admin only; teachers and families can
   only read what concerns them (tenant + assignment scope enforced here).
   ========================================================================== */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, logActivity } = require("../util");
const { requireAuth, requireRole } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments } = require("../middleware/tenant");

const router = express.Router();
router.use(requireAuth);

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LABELS_AR = { Mon: "الإثنين", Tue: "الثلاثاء", Wed: "الأربعاء", Thu: "الخميس", Fri: "الجمعة", Sat: "السبت" };
const DEFAULT_PERIODS = [
  { period: 1, start: "08:00", end: "08:45" },
  { period: 2, start: "08:45", end: "09:30" },
  { period: 3, start: "09:30", end: "10:15" },
  { period: 4, start: "10:30", end: "11:15" },
  { period: 5, start: "11:15", end: "12:00" },
  { period: 6, start: "12:00", end: "12:45" },
];

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required." }); return null; }
  return tid;
}

function validTime(v) {
  const s = cleanStr(v, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : "";
}

async function currentTermId(tid, requested) {
  if (requested) return toNum(requested, 0);
  const row = await db.get(
    `SELECT t.id FROM terms t JOIN academic_sessions s ON s.id = t.session_id
     WHERE t.madrasa_id = ? ORDER BY s.is_current DESC, s.id DESC, t.position ASC LIMIT 1`,
    [tid]
  );
  return row ? Number(row.id) : 0;
}

/**
 * A teacher can teach one class in a given day/period only. This is checked
 * server-side (not only in the timetable editor) so imports, copied weeks and
 * forged requests cannot create an impossible teaching schedule.
 *
 * `classId` is excluded because a replace-all save may retain its own slot.
 */
async function teacherSlotConflicts(tid, termId, classId, slots) {
  const requested = (slots || []).filter((slot) => slot.teacherId || slot.teacher_id);
  if (!requested.length) return [];
  const otherSlots = await db.all(
    `SELECT ts.day, ts.period, ts.teacher_id, c.name_en AS class_name, u.full_name AS teacher_name
       FROM timetable_slots ts
       LEFT JOIN classes c ON c.id = ts.class_id
       LEFT JOIN users u ON u.id = ts.teacher_id
      WHERE ts.madrasa_id = ? AND ts.class_id <> ? AND ts.teacher_id IS NOT NULL
        AND ${termId ? "ts.term_id = ?" : "ts.term_id IS NULL"}`,
    termId ? [tid, classId, termId] : [tid, classId]
  );
  const occupied = new Map(otherSlots.map((slot) => [
    `${slot.teacher_id}:${slot.day}:${slot.period}`,
    slot,
  ]));
  return requested.map((slot) => {
    const teacherId = slot.teacherId || slot.teacher_id;
    const clash = occupied.get(`${teacherId}:${slot.day}:${slot.period}`);
    return clash ? {
      key: `${teacherId}:${slot.day}:${slot.period}`,
      day: slot.day,
      period: Number(slot.period),
      teacherId: Number(teacherId),
      teacherName: clash.teacher_name || "This teacher",
      className: clash.class_name || "another class",
    } : null;
  }).filter(Boolean);
}

/** A physical room/classroom cannot host two different classes in the same period. */
async function roomSlotConflicts(tid, termId, classId, slots) {
  const requested = (slots || []).filter((slot) => cleanStr(slot.room, 60));
  if (!requested.length) return [];
  const otherSlots = await db.all(
    `SELECT ts.day, ts.period, ts.room, c.name_en AS class_name
       FROM timetable_slots ts
       LEFT JOIN classes c ON c.id = ts.class_id
      WHERE ts.madrasa_id = ? AND ts.class_id <> ? AND ts.room <> ''
        AND ${termId ? "ts.term_id = ?" : "ts.term_id IS NULL"}`,
    termId ? [tid, classId, termId] : [tid, classId]
  );
  const occupied = new Map(otherSlots.map((slot) => [`${String(slot.room).trim().toLowerCase()}:${slot.day}:${slot.period}`, slot]));
  return requested.map((slot) => {
    const roomKey = cleanStr(slot.room, 60).toLowerCase();
    const clash = occupied.get(`${roomKey}:${slot.day}:${slot.period}`);
    return clash ? {
      day: slot.day,
      period: Number(slot.period),
      room: clash.room || slot.room,
      className: clash.class_name || "another class",
    } : null;
  }).filter(Boolean);
}

async function insertIgnoreRow(api, table, columns, values) {
  if (typeof api.insertIgnore === "function") return api.insertIgnore(table, columns, values);
  const dialect = typeof api.dialect === "string" ? api.dialect : await db.dialect();
  const verb = dialect === "sqlite" ? "INSERT OR IGNORE" : "INSERT IGNORE";
  return api.run(`${verb} INTO ${table} (${columns}) VALUES (${values.map(() => "?").join(",")})`, values);
}

async function ensureTimetableAssignment(api, tid, classId, teacherId, subjectId) {
  // A timetable slot must make the subject part of the class catalogue, because
  // lessons/results need that class-subject link. It deliberately does NOT add
  // a teacher permission row: a one-off substitution in the timetable should
  // not silently grant class-register/results access. Administrators assign
  // those durable responsibilities in Teachers/Class Teachers.
  if (subjectId) await insertIgnoreRow(api, "class_subjects", "madrasa_id, class_id, subject_id", [tid, classId, subjectId]);
}

async function buildGrid(tid, classId, termId) {
  const slots = await db.all(
    `SELECT ts.*, su.name_en AS subject_en, su.name_ar AS subject_ar,
            u.full_name AS teacher_name, u.username AS teacher_username
     FROM timetable_slots ts
     LEFT JOIN subjects su ON su.id = ts.subject_id
     LEFT JOIN users u ON u.id = ts.teacher_id
     WHERE ts.madrasa_id = ? AND ts.class_id = ? AND (ts.term_id = ? OR (? = 0 AND ts.term_id IS NULL))
     ORDER BY ts.day, ts.period`,
    [tid, classId, termId, termId]
  );
  const periods = new Set(DEFAULT_PERIODS.map((p) => p.period));
  slots.forEach((s) => periods.add(Number(s.period)));
  const periodList = [...periods].sort((a, b) => a - b).map((p) => {
    const def = DEFAULT_PERIODS.find((d) => d.period === p) || {};
    const same = slots.filter((s) => Number(s.period) === p);
    return {
      period: p,
      start: def.start || (same[0] && same[0].start_time) || "",
      end: def.end || (same[0] && same[0].end_time) || "",
    };
  });
  return {
    days: DAYS,
    dayLabelsAr: DAY_LABELS_AR,
    periods: periodList,
    slots: slots.map((s) => ({
      id: Number(s.id),
      day: s.day,
      period: Number(s.period),
      startTime: s.start_time || "",
      endTime: s.end_time || "",
      subjectId: s.subject_id ? Number(s.subject_id) : null,
      subjectEn: s.subject_en || "",
      subjectAr: s.subject_ar || "",
      teacherId: s.teacher_id ? Number(s.teacher_id) : null,
      teacherName: s.teacher_name || "",
      room: s.room || "",
      notes: s.notes || "",
    })),
  };
}

/* ------------------------------ read (staff) ----------------------------- */

router.get("/", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) return err(res, 403, "Permission denied.");
  const classId = toNum(req.query.classId, 0);
  if (!classId) return err(res, 400, "classId is required.");
  const cls = await db.get("SELECT * FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!cls) return err(res, 404, "Class not found.");
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!scope.anyClassAnySubject && !scope.assignedClassIds.has(classId)) return err(res, 404, "Class not found.");
  }
  const termId = await currentTermId(tid, req.query.termId);
  const grid = await buildGrid(tid, classId, termId);
  ok(res, { class: cls, termId, ...grid });
}));

/* ------------------------------ write (admin) --------------------------- */

router.put("/", requireRole("madrasa_admin", "super_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const b = req.body || {};
  const classId = toNum(b.classId || b.class_id, 0);
  const cls = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!cls) return err(res, 400, "Unknown class.");
  const termId = await currentTermId(tid, b.termId || b.term_id);
  const raw = Array.isArray(b.slots) ? b.slots : [];
  if (raw.length > 6 * 12) return err(res, 400, "Too many slots (max 72).");

  // Validate everything first so a bad row never wipes an existing timetable.
  const clean = [];
  const seen = new Set();
  for (const s of raw) {
    const day = DAYS.includes(cleanStr(s.day, 8)) ? cleanStr(s.day, 8) : null;
    const period = toNum(s.period, 0);
    if (!day || period < 1 || period > 12) {
      return err(res, 400, "Every slot needs a school day (Mon–Sat) and a period between 1 and 12.");
    }
    const key = day + ":" + period;
    if (seen.has(key)) return err(res, 400, "Two slots share " + day + " period " + period + ".");
    seen.add(key);
    const subjectId = s.subjectId ? toNum(s.subjectId, 0) : null;
    if (subjectId) {
      const su = await db.get("SELECT id FROM subjects WHERE id = ? AND madrasa_id = ?", [subjectId, tid]);
      if (!su) return err(res, 400, "Unknown subject in slot " + key + ".");
    }
    const teacherId = s.teacherId ? toNum(s.teacherId, 0) : null;
    if (teacherId) {
      const u = await db.get("SELECT id FROM users WHERE id = ? AND madrasa_id = ? AND role IN ('teacher','madrasa_admin')", [teacherId, tid]);
      if (!u) return err(res, 400, "Unknown teacher in slot " + key + ".");
    }
    clean.push({
      day, period,
      start: validTime(s.startTime || s.start_time),
      end: validTime(s.endTime || s.end_time),
      subjectId, teacherId,
      room: cleanStr(s.room, 60),
      notes: cleanStr(s.notes, 255),
    });
  }

  const conflicts = await teacherSlotConflicts(tid, termId, classId, clean);
  if (conflicts.length) {
    const conflict = conflicts[0];
    return err(res, 400, `${conflict.teacherName} is already assigned to ${conflict.className} on ${conflict.day}, period ${conflict.period}. Choose a different teacher or period.`);
  }
  const roomConflicts = await roomSlotConflicts(tid, termId, classId, clean);
  if (roomConflicts.length) {
    const conflict = roomConflicts[0];
    return err(res, 400, `${conflict.room} is already assigned to ${conflict.className} on ${conflict.day}, period ${conflict.period}. Choose a different classroom or period.`);
  }

  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM timetable_slots WHERE madrasa_id = ? AND class_id = ? AND (term_id = ? OR (term_id IS NULL AND ? = 0))", [tid, classId, termId, termId]);
    for (const s of clean) {
      await tx.run(
        `INSERT INTO timetable_slots (madrasa_id, class_id, term_id, day, period, start_time, end_time, subject_id, teacher_id, room, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [tid, classId, termId || null, s.day, s.period, s.start, s.end, s.subjectId, s.teacherId, s.room, s.notes]
      );
      if (s.subjectId) await insertIgnoreRow(tx, "class_subjects", "madrasa_id, class_id, subject_id", [tid, classId, s.subjectId]);
      await ensureTimetableAssignment(tx, tid, classId, s.teacherId, s.subjectId);
    }
  });
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "timetable.save", entity: "class", entityId: String(classId), meta: { slots: clean.length }, ip: req.ip });
  ok(res, { ok: true, saved: clean.length });
}));

/** Copy one class's week onto other classes (same term). */
router.post("/copy", requireRole("madrasa_admin", "super_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const from = toNum((req.body || {}).fromClassId, 0);
  const to = ((req.body || {}).toClassIds || []).map((x) => toNum(x, 0)).filter(Boolean);
  if (!from || !to.length) return err(res, 400, "fromClassId and toClassIds are required.");
  const termId = await currentTermId(tid, (req.body || {}).termId);
  const rows = await db.all("SELECT * FROM timetable_slots WHERE madrasa_id = ? AND class_id = ? AND (term_id = ? OR (? = 0 AND term_id IS NULL))", [tid, from, termId, termId]);
  if (!rows.length) return err(res, 400, "The source class has no timetable to copy.");
  if (to.includes(from)) return err(res, 400, "A class cannot be copied onto itself.");
  const rejected = [];
  const targets = [];
  for (const classId of to) {
    const cls = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
    if (!cls) { rejected.push({ classId, reason: "not_in_your_madrasa" }); continue; }
    targets.push(classId);
  }
  // Preserve the useful timetable-copy workflow while never giving one
  // teacher two simultaneous classes. Conflicting copies retain the class,
  // subject, room and time, but deliberately leave the teacher unassigned for
  // an administrator to resolve. Direct saves are rejected above instead.
  const targetRows = [];
  let teacherConflicts = 0;
  let roomConflicts = 0;
  for (const classId of targets) {
    const conflicts = await teacherSlotConflicts(tid, termId, classId, rows);
    const blocked = new Set(conflicts.map((c) => c.key));
    teacherConflicts += conflicts.length;
    const roomClashes = await roomSlotConflicts(tid, termId, classId, rows);
    const blockedRooms = new Set(roomClashes.map((c) => `${String(c.room || "").trim().toLowerCase()}:${c.day}:${c.period}`));
    roomConflicts += roomClashes.length;
    targetRows.push({
      classId,
      rows: rows.map((row) => Object.assign({}, row, {
        teacher_id: blocked.has(`${row.teacher_id}:${row.day}:${row.period}`) ? null : row.teacher_id,
        room: blockedRooms.has(`${String(row.room || "").trim().toLowerCase()}:${row.day}:${row.period}`) ? "" : row.room,
      })),
    });
  }

  let inserted = 0;
  await db.transaction(async (tx) => {
    for (const target of targetRows) {
      await tx.run("DELETE FROM timetable_slots WHERE madrasa_id = ? AND class_id = ? AND (term_id = ? OR (term_id IS NULL AND ? = 0))", [tid, target.classId, termId, termId]);
      for (const r of target.rows) {
        await tx.run(
          `INSERT INTO timetable_slots (madrasa_id, class_id, term_id, day, period, start_time, end_time, subject_id, teacher_id, room, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [tid, target.classId, termId || null, r.day, r.period, r.start_time, r.end_time, r.subject_id, r.teacher_id, r.room, r.notes]
        );
        if (r.subject_id) await insertIgnoreRow(tx, "class_subjects", "madrasa_id, class_id, subject_id", [tid, target.classId, r.subject_id]);
        await ensureTimetableAssignment(tx, tid, target.classId, r.teacher_id, r.subject_id);
        inserted++;
      }
    }
  });
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "timetable.copy", entity: "class", entityId: String(from), meta: { to, inserted, teacherConflicts, roomConflicts }, ip: req.ip });
  ok(res, { ok: true, inserted, copiedTo: targets.length, rejected, teacherConflicts, roomConflicts });
}));

/* ------------------------------ portal read ----------------------------- */

async function studentsOfUser(req, tid) {
  if (req.user.role === "student") {
    const row = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [req.user.studentId, tid]);
    return row ? [row] : [];
  }
  return db.all(
    `SELECT s.* FROM students s
     JOIN parent_links pl ON pl.student_id = s.id AND pl.madrasa_id = s.madrasa_id
     WHERE pl.madrasa_id = ? AND pl.user_id = ?`,
    [tid, req.user.id]
  );
}

router.get("/me", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const termId = await currentTermId(tid, req.query.termId);

  if (req.user.role === "teacher") {
    const rows = await db.all(
      `SELECT ts.*, c.name_en AS class_en, c.name_ar AS class_ar, su.name_en AS subject_en, su.name_ar AS subject_ar
       FROM timetable_slots ts JOIN classes c ON c.id = ts.class_id
       LEFT JOIN subjects su ON su.id = ts.subject_id
       WHERE ts.madrasa_id = ? AND ts.teacher_id = ? AND (ts.term_id = ? OR (? = 0 AND ts.term_id IS NULL))
       ORDER BY ts.day, ts.period`,
      [tid, req.user.id, termId, termId]
    );
    const slots = rows.map((r) => ({
      day: r.day, period: Number(r.period), startTime: r.start_time, endTime: r.end_time,
      className: r.class_en || "", classNameAr: r.class_ar || "",
      subjectEn: r.subject_en || "", subjectAr: r.subject_ar || "", room: r.room || "",
    }));
    return ok(res, { kind: "teacher", termId, slots, days: DAYS, dayLabelsAr: DAY_LABELS_AR });
  }

  if (!["student", "parent"].includes(req.user.role)) return err(res, 403, "Use /api/timetable?classId= for the class view.");
  const students = await studentsOfUser(req, tid);
  const out = [];
  for (const s of students) {
    if (!s.class_id) { out.push({ studentId: s.id, name: `${s.first_name} ${s.last_name}`.trim(), classId: null, slots: [] }); continue; }
    const cls = await db.get("SELECT id, name_en, name_ar FROM classes WHERE id = ?", [s.class_id]);
    const grid = await buildGrid(tid, Number(s.class_id), termId);
    out.push({ studentId: s.id, name: `${s.first_name} ${s.last_name}`.trim(), admissionNo: s.admission_no, class: cls, ...grid });
  }
  ok(res, { kind: req.user.role, termId, days: DAYS, dayLabelsAr: DAY_LABELS_AR, students: out });
}));

/* ------------------------------ printable week -------------------------- */

function esc(v) {
  return String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

router.get("/print", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const classId = toNum(req.query.classId, 0);
  if (!classId) return err(res, 400, "classId is required.");
  const cls = await db.get("SELECT * FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!cls) return err(res, 404, "Class not found.");
  const termId = await currentTermId(tid, req.query.termId);
  const grid = await buildGrid(tid, classId, termId);
  const m = await db.get("SELECT name_en, name_ar, logo_path, motto_en, address, city, phone FROM madaris WHERE id = ?", [tid]);
  const term = termId ? await db.get("SELECT t.name_en, s.label FROM terms t JOIN academic_sessions s ON s.id = t.session_id WHERE t.id = ?", [termId]) : null;

  const at = (day, period) => grid.slots.find((s) => s.day === day && s.period === period);
  const body = grid.days.map((day) => {
    const cells = grid.periods.map((p) => {
      const s = at(day, p.period);
      if (!s) return "<td class='empty-cell'>&nbsp;</td>";
      return `<td><b>${esc(s.subjectEn || "—")}</b>${s.subjectAr ? `<div class="ar">${esc(s.subjectAr)}</div>` : ""}
        <div class="time">${esc(p.start)}–${esc(p.end)}</div>
        ${s.teacherName ? `<div class="t">${esc(s.teacherName)}</div>` : ""}
        ${s.room ? `<div class="r">${esc(s.room)}</div>` : ""}</td>`;
    }).join("");
    return `<tr><th class="day">${esc(day)}<div class="ar">${esc(DAY_LABELS_AR[day] || "")}</div></th>${cells}</tr>`;
  }).join("");

  res.type("html").send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Timetable — ${esc(cls.name_en)}</title>
<style>
 @page { size: A4 landscape; margin: 10mm; }
 * { box-sizing: border-box; }
 body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #1a2b1f; margin: 0; padding: 14px; }
 .head { display: flex; gap: 14px; align-items: center; border-bottom: 2px solid #14532d; padding-bottom: 10px; }
 .head img { width: 62px; height: 62px; object-fit: contain; }
 .m1 { font-size: 19px; font-weight: 700; color: #14532d; }
 .m2 { font-size: 12px; color: #4b5563; }
 h1 { font-size: 15px; text-align: center; letter-spacing: 1px; text-transform: uppercase; margin: 10px 0 8px; }
 table { width: 100%; border-collapse: collapse; font-size: 11px; }
 th, td { border: 1px solid #9ca3af; padding: 5px 6px; vertical-align: top; text-align: center; }
 th { background: #14532d; color: #fff; }
 th.day { background: #0f3d21; width: 78px; }
 .empty-cell { background: #f7f8f7; }
 .time { color: #374151; font-size: 10px; }
 .t, .r { color: #4b5563; font-size: 10px; }
 .ar { direction: rtl; font-size: 11px; color: #14532d; }
 .foot { margin-top: 8px; font-size: 10px; color: #6b7280; text-align: center; }
 .noprint { text-align: center; margin: 10px 0; }
 .noprint button { padding: 8px 16px; border: 0; border-radius: 8px; background: #14532d; color: #fff; font-size: 13px; cursor: pointer; }
 @media print { .noprint { display: none; } }
</style></head><body>
<div class="head">
  ${m.logo_path ? `<img src="${esc(m.logo_path)}" alt="">` : ""}
  <div style="flex:1">
    <div class="m1">${esc(m.name_en)}</div>
    <div class="m2">${esc(m.name_ar || "")} ${m.motto_en ? "• " + esc(m.motto_en) : ""}</div>
    <div class="m2">${esc([m.address, m.city].filter(Boolean).join(", "))} ${m.phone ? "• " + esc(m.phone) : ""}</div>
  </div>
</div>
<h1>Class Timetable — ${esc(cls.name_en)}${cls.name_ar ? " • " + esc(cls.name_ar) : ""}</h1>
<div class="m2" style="text-align:center;margin-bottom:6px">${term ? esc(term.label) + " — " + esc(term.name_en) : ""}</div>
<table><thead><tr><th>Day</th>${grid.periods.map((p) => `<th>P${p.period}<div class="time">${esc(p.start)}–${esc(p.end)}</div></th>`).join("")}</tr></thead>
<tbody>${body}</tbody></table>
<div class="noprint"><button type="button" id="printPageBtn">Print timetable</button></div>
<div class="foot">Generated ${esc(new Date().toLocaleString())} • EduSphere Education Platform</div>
<script src="/js/print.js"></script>
</body></html>`);
}));

module.exports = { router, DAYS, DEFAULT_PERIODS };
