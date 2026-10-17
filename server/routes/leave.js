"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — Staff Leave (tenant-scoped)
   ----------------------------------------------------------------------------
   Additive HR module that follows the fees.js / teachers.js / payroll.js
   conventions exactly:
     • every query is filtered by madrasa_id resolved from the session through
       effectiveTenantId (middleware/tenant.js) — never from the client
     • role guards reuse requireAuth + requireTenant + requireRole
     • every state change is written to the shared activity log (util.logActivity)
     • CSV export goes through services/csv.js

   It deliberately REUSES what already exists instead of duplicating it:
     • staff identity        → users (role = 'teacher'), teacher_profiles
     • the academic calendar → academic_sessions / terms
     • the staff register    → teacher_attendance (an approved leave writes the
                               existing 'on_leave' status, it does not invent a
                               second attendance ledger)
     • the timetable week    → routes/timetable.js DAYS (Mon–Sat)

   Workflow: leave_types (admin-configurable catalogue, days-per-year) feed
   leave_requests (pending → approved | rejected | cancelled). Approving a
   request writes 'on_leave' rows into teacher_attendance for every covered
   working day and refreshes leave_balances (entitlement − days taken this
   session). Rejecting or cancelling an approved request reverses both.
   ========================================================================== */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, clampNum, validDate, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { requirePermission, requireStaffPermission } = require("../services/permissions");
const { effectiveTenantId } = require("../middleware/tenant");
const { requireFeature } = require("../middleware/subscription");
const csv = require("../services/csv");
const { DAYS } = require("./timetable");
const attendance = require("./attendance");

const router = express.Router();
router.use(requireAuth, requireTenant);
// Leave management ships with the Premium "Finance & HR" bundle.
router.use(requireFeature("leave"));

/* Same guard vocabulary as teachers.js: administrators own the catalogue and
   the approvals, teachers reach their own records through the staff routes. */
const ADMIN = requireRole("madrasa_admin", "super_admin");
const STAFF = requireRole("madrasa_admin", "teacher", "super_admin");

const REQUEST_STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);
const TYPE_STATUSES = new Set(["active", "inactive", "archived"]);
const MAX_LEAVE_SPAN_DAYS = 366;

/** The working week the register and timetable already use (Mon–Sat). */
const WORKING_DAY_INDEXES = new Set(
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    .map((label, index) => (DAYS.includes(label) ? index : -1))
    .filter((index) => index >= 0)
);

/* The catalogue a madrasa starts with. It is only ever inserted once per
   tenant (guarded by the existing settings table) so an administrator who
   removes or renames a type never has it silently recreated. */
const DEFAULT_LEAVE_TYPES = [
  { name: "Annual Leave", name_ar: "إجازة سنوية", code: "annual", days_per_year: 21, paid: 1, colour: "#2d6f8f", description: "Planned yearly leave entitlement." },
  { name: "Sick Leave", name_ar: "إجازة مرضية", code: "sick", days_per_year: 14, paid: 1, colour: "#a5352d", description: "Medical absence, certificate may be required." },
  { name: "Maternity / Paternity Leave", name_ar: "إجازة أمومة / أبوة", code: "maternity_paternity", days_per_year: 90, paid: 1, colour: "#7b3f8c", description: "Leave around the birth or adoption of a child." },
  { name: "Study Leave", name_ar: "إجازة دراسية", code: "study", days_per_year: 10, paid: 1, colour: "#146848", description: "Approved study, training or professional development." },
  { name: "Emergency Leave", name_ar: "إجازة طارئة", code: "emergency", days_per_year: 5, paid: 1, colour: "#8a5a12", description: "Urgent personal or family circumstances." },
  { name: "Unpaid Leave", name_ar: "إجازة بدون راتب", code: "unpaid", days_per_year: 0, paid: 0, colour: "#5f5b6b", description: "Approved absence without pay." },
];

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required." }); return null; }
  return tid;
}

function isAdmin(req) { return ["madrasa_admin", "super_admin"].includes(req.user.role); }
function n(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function dayStamp(iso) { return Date.parse(String(iso).slice(0, 10) + "T00:00:00Z"); }

/** Every working day (Mon–Sat) covered by an inclusive date range. */
function leaveDays(startIso, endIso) {
  const out = [];
  let cursor = dayStamp(startIso);
  const last = dayStamp(endIso);
  if (!Number.isFinite(cursor) || !Number.isFinite(last) || last < cursor) return out;
  while (cursor <= last) {
    const date = new Date(cursor);
    if (WORKING_DAY_INDEXES.has(date.getUTCDay())) out.push(date.toISOString().slice(0, 10));
    cursor += 86400000;
    if (out.length > MAX_LEAVE_SPAN_DAYS) break;
  }
  return out;
}
function calendarSpanDays(startIso, endIso) {
  const first = dayStamp(startIso); const last = dayStamp(endIso);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.floor((last - first) / 86400000) + 1;
}

/* ------------------------------ catalogue ------------------------------- */

/** Seeds the starter catalogue once per tenant (both institution categories
    get the same catalogue — only wording differs in the UI). */
async function ensureLeaveTypes(tid) {
  const marker = await db.get("SELECT value FROM settings WHERE madrasa_id = ? AND key_name = 'leave_types_seeded'", [tid]);
  if (marker && String(marker.value) === "1") return;
  const existing = await db.get("SELECT COUNT(*) AS n FROM leave_types WHERE madrasa_id = ?", [tid]);
  if (!Number(existing && existing.n)) {
    let sort = 0;
    for (const type of DEFAULT_LEAVE_TYPES) {
      sort += 10;
      await db.run(
        `INSERT INTO leave_types (madrasa_id,name,name_ar,code,days_per_year,paid,description,colour,status,sort_order,updated_at)
         VALUES (?,?,?,?,?,?,?,?,'active',?,CURRENT_TIMESTAMP)`,
        [tid, type.name, type.name_ar, type.code, type.days_per_year, type.paid, type.description, type.colour, sort]
      ).catch(() => { /* a concurrent request already inserted it */ });
    }
  }
  await db.run(
    "INSERT INTO settings (madrasa_id, key_name, value) VALUES (?,?,?)",
    [tid, "leave_types_seeded", "1"]
  ).catch(async () => {
    await db.run("UPDATE settings SET value = ? WHERE madrasa_id = ? AND key_name = 'leave_types_seeded'", ["1", tid]);
  });
}

async function typeInTenant(tid, typeId) {
  const id = toNum(typeId, 0);
  if (!id) return null;
  return db.get("SELECT * FROM leave_types WHERE id = ? AND madrasa_id = ?", [id, tid]);
}

/** Staff member inside this tenant. Leave follows the same staff identity as
    the register and payroll: an active users row with the teacher role. */
async function staffInTenant(tid, userId) {
  const id = toNum(userId, 0);
  if (!id) return null;
  return db.get(
    "SELECT id, full_name, full_name_ar, username, is_active FROM users WHERE id = ? AND madrasa_id = ? AND role = 'teacher'",
    [id, tid]
  );
}

async function sessionInTenant(tid, sessionId) {
  const id = toNum(sessionId, 0);
  if (!id) return null;
  return db.get("SELECT id, label, start_date, end_date, is_current FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [id, tid]);
}
async function currentSession(tid) {
  return db.get("SELECT id, label, start_date, end_date, is_current FROM academic_sessions WHERE madrasa_id = ? ORDER BY is_current DESC, id DESC LIMIT 1", [tid]);
}
/** The session a leave date falls inside, else the tenant's current session. */
async function sessionForDate(tid, dayIso) {
  const covering = await db.get(
    `SELECT id, label, start_date, end_date, is_current FROM academic_sessions
      WHERE madrasa_id = ? AND start_date IS NOT NULL AND end_date IS NOT NULL AND start_date <= ? AND end_date >= ?
      ORDER BY is_current DESC, id DESC LIMIT 1`,
    [tid, dayIso, dayIso]
  );
  return covering || (await currentSession(tid));
}

/* ------------------------------ balances -------------------------------- */

/**
 * Recomputes and stores the (staff, type, session) balance rows.
 * leave_balances is a maintained summary, never an independent truth: the
 * numbers are always derived here from approved leave_requests, so the table
 * cannot drift from the requests it summarises (and the same code path works
 * on SQLite and MySQL, where views/triggers differ).
 */
async function refreshBalances(tid, { userId = null, sessionId = null, typeId = null } = {}) {
  const sessions = sessionId
    ? [await sessionInTenant(tid, sessionId)].filter(Boolean)
    : await db.all("SELECT id FROM academic_sessions WHERE madrasa_id = ?", [tid]);
  if (!sessions.length) return 0;
  const types = typeId
    ? [await typeInTenant(tid, typeId)].filter(Boolean)
    : await db.all("SELECT id, days_per_year FROM leave_types WHERE madrasa_id = ?", [tid]);
  if (!types.length) return 0;
  const staff = userId
    ? [await staffInTenant(tid, userId)].filter(Boolean)
    : await db.all("SELECT id FROM users WHERE madrasa_id = ? AND role = 'teacher'", [tid]);
  if (!staff.length) return 0;

  let written = 0;
  for (const session of sessions) {
    for (const type of types) {
      const entitlement = Math.max(0, Math.trunc(n(type.days_per_year)));
      for (const person of staff) {
        const row = await db.get(
          "SELECT COALESCE(SUM(days),0) AS taken FROM leave_requests WHERE madrasa_id=? AND user_id=? AND type_id=? AND session_id=? AND status='approved'",
          [tid, person.id, type.id, session.id]
        );
        const taken = Math.max(0, Math.trunc(n(row && row.taken)));
        const remaining = entitlement - taken;
        const existing = await db.get(
          "SELECT id FROM leave_balances WHERE madrasa_id=? AND user_id=? AND type_id=? AND session_id=?",
          [tid, person.id, type.id, session.id]
        );
        if (existing) {
          await db.run(
            "UPDATE leave_balances SET entitlement=?, taken=?, remaining=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
            [entitlement, taken, remaining, existing.id, tid]
          );
        } else {
          await db.run(
            "INSERT INTO leave_balances (madrasa_id,user_id,type_id,session_id,entitlement,taken,remaining,updated_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)",
            [tid, person.id, type.id, session.id, entitlement, taken, remaining]
          );
        }
        written++;
      }
    }
  }
  return written;
}

/* ------------------------- attendance integration ------------------------ */

/** Marker written into teacher_attendance.notes so a reversal only ever
    removes the rows this module created (a manually marked day is kept). */
function leaveMarker(requestId) { return `[leave #${requestId}]`; }

/**
 * Writes the existing 'on_leave' status into teacher_attendance for every
 * working day the approved leave covers. Days already marked are updated so
 * the register agrees with the approval; the marker records the origin.
 */
async function applyLeaveToRegister(tid, request, typeName, reviewerId) {
  const days = leaveDays(request.start_date, request.end_date);
  const note = `On approved leave — ${typeName} ${leaveMarker(request.id)}`.slice(0, 2000);
  let written = 0;
  for (const day of days) {
    const context = await attendance.termContext(tid, day, null, request.session_id || null);
    const termId = context && !context.error ? context.termId : null;
    const sessionId = context && !context.error ? context.sessionId : (request.session_id || null);
    const existing = await db.get("SELECT id, status FROM teacher_attendance WHERE madrasa_id=? AND user_id=? AND day=?", [tid, request.user_id, day]);
    if (existing) {
      await db.run(
        "UPDATE teacher_attendance SET status='on_leave', term_id=?, session_id=?, notes=?, recorded_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
        [termId, sessionId, note, reviewerId, existing.id, tid]
      );
    } else {
      await db.run(
        "INSERT INTO teacher_attendance (madrasa_id,user_id,day,term_id,session_id,status,check_in,check_out,notes,recorded_by) VALUES (?,?,?,?,?,'on_leave','','',?,?)",
        [tid, request.user_id, day, termId, sessionId, note, reviewerId]
      );
    }
    written++;
  }
  return written;
}

/** Removes only the register rows this module wrote for a leave. */
async function removeLeaveFromRegister(tid, request) {
  const r = await db.run(
    "DELETE FROM teacher_attendance WHERE madrasa_id=? AND user_id=? AND day >= ? AND day <= ? AND status='on_leave' AND notes LIKE ?",
    [tid, request.user_id, request.start_date, request.end_date, `%${leaveMarker(request.id)}%`]
  );
  return Number(r.changes || 0);
}

/* ------------------------------ shaping --------------------------------- */

const REQUEST_SELECT = `
  SELECT lr.*, lt.name AS type_name, lt.name_ar AS type_name_ar, lt.code AS type_code,
         lt.colour AS type_colour, lt.paid AS type_paid, lt.days_per_year,
         u.full_name, u.full_name_ar, u.username, tp.department, tp.staff_id,
         s.label AS session_label, r.full_name AS reviewed_by_name
    FROM leave_requests lr
    JOIN leave_types lt ON lt.id = lr.type_id AND lt.madrasa_id = lr.madrasa_id
    JOIN users u ON u.id = lr.user_id AND u.madrasa_id = lr.madrasa_id
    LEFT JOIN teacher_profiles tp ON tp.user_id = lr.user_id AND tp.madrasa_id = lr.madrasa_id
    LEFT JOIN academic_sessions s ON s.id = lr.session_id AND s.madrasa_id = lr.madrasa_id
    LEFT JOIN users r ON r.id = lr.reviewed_by AND r.madrasa_id = lr.madrasa_id`;

/** Public shape of a request. `reason`/`review_note` are private to the owner
    and administrators, so a colleague-visible calendar never leaks them. */
function requestDto(row, { includePrivate = true } = {}) {
  const out = Object.assign({}, row, {
    days: Number(row.days || 0),
    type_paid: Number(row.type_paid) === 1,
    teacher_name: row.full_name || row.username || "",
    start_date: row.start_date ? String(row.start_date).slice(0, 10) : null,
    end_date: row.end_date ? String(row.end_date).slice(0, 10) : null,
  });
  if (!includePrivate) { out.reason = ""; out.review_note = ""; }
  return out;
}

/* ------------------------------ leave types ------------------------------ */

router.get("/types", STAFF, requireStaffPermission("staff_leave.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  await ensureLeaveTypes(tid);
  const where = ["madrasa_id = ?"]; const params = [tid];
  const status = cleanStr(req.query.status, 20).toLowerCase();
  if (status && TYPE_STATUSES.has(status)) { where.push("status = ?"); params.push(status); }
  else if (!req.query.includeArchived) { where.push("status <> 'archived'"); }
  const rows = await db.all(`SELECT * FROM leave_types WHERE ${where.join(" AND ")} ORDER BY sort_order, name`, params);
  ok(res, {
    types: rows.map((row) => Object.assign({}, row, {
      paid: Number(row.paid) === 1,
      days_per_year: Number(row.days_per_year || 0),
    })),
  });
}));

function validateType(body, fallback = {}) {
  const b = body || {};
  const name = cleanStr(b.name ?? b.name_en ?? fallback.name, 80);
  if (!name) return { error: "A leave type name is required." };
  const days = Math.trunc(clampNum(b.days_per_year ?? b.days ?? fallback.days_per_year ?? 0, 0, 366, 0));
  const paidRaw = b.paid !== undefined ? b.paid : fallback.paid;
  const paid = paidRaw === false || paidRaw === 0 || paidRaw === "0" || paidRaw === "false" ? 0 : 1;
  const status = TYPE_STATUSES.has(cleanStr(b.status, 20).toLowerCase())
    ? cleanStr(b.status, 20).toLowerCase()
    : (fallback.status || "active");
  return {
    name,
    name_ar: cleanStr(b.name_ar ?? fallback.name_ar, 80),
    code: cleanStr(b.code ?? fallback.code, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "_"),
    days_per_year: days,
    paid,
    description: cleanStr(b.description ?? fallback.description, 500),
    colour: cleanStr(b.colour ?? b.color ?? fallback.colour, 20),
    status,
    sort_order: Math.trunc(clampNum(b.sort_order ?? fallback.sort_order ?? 0, 0, 9999, 0)),
  };
}

router.post("/types", ADMIN, requirePermission("staff_leave.approve"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  await ensureLeaveTypes(tid);
  const v = validateType(req.body);
  if (v.error) return err(res, 400, v.error);
  // Without an explicit position a new type goes to the END of the catalogue:
  // sort_order 0 would otherwise float it above the seeded defaults.
  if (!v.sort_order) {
    const last = await db.get("SELECT COALESCE(MAX(sort_order),0) AS n FROM leave_types WHERE madrasa_id = ?", [tid]);
    v.sort_order = Number(last.n || 0) + 10;
  }
  let id;
  try {
    const r = await db.run(
      `INSERT INTO leave_types (madrasa_id,name,name_ar,code,days_per_year,paid,description,colour,status,sort_order,created_by,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      [tid, v.name, v.name_ar, v.code, v.days_per_year, v.paid, v.description, v.colour, v.status, v.sort_order, req.user.id]
    );
    id = Number(r.lastInsertRowid);
  } catch (e) {
    if (/UNIQUE|Duplicate/i.test(String(e.message || ""))) return err(res, 400, "A leave type with this name already exists.");
    throw e;
  }
  await refreshBalances(tid, { typeId: id });
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "leave.type.create", entity: "leave_type", entityId: String(id), meta: { name: v.name, days: v.days_per_year }, ip: req.ip });
  ok(res, { ok: true, id });
}));

router.patch("/types/:id", ADMIN, requireStaffPermission("staff_leave.approve"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await typeInTenant(tid, req.params.id);
  if (!row) return err(res, 404, "Leave type not found.");
  const v = validateType(req.body, row);
  if (v.error) return err(res, 400, v.error);
  try {
    await db.run(
      "UPDATE leave_types SET name=?, name_ar=?, code=?, days_per_year=?, paid=?, description=?, colour=?, status=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
      [v.name, v.name_ar, v.code, v.days_per_year, v.paid, v.description, v.colour, v.status, v.sort_order, row.id, tid]
    );
  } catch (e) {
    if (/UNIQUE|Duplicate/i.test(String(e.message || ""))) return err(res, 400, "A leave type with this name already exists.");
    throw e;
  }
  await refreshBalances(tid, { typeId: row.id });
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "leave.type.update", entity: "leave_type", entityId: String(row.id), ip: req.ip });
  ok(res, { ok: true });
}));

router.delete("/types/:id", ADMIN, requireStaffPermission("staff_leave.approve"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await typeInTenant(tid, req.params.id);
  if (!row) return err(res, 404, "Leave type not found.");
  const used = await db.get("SELECT COUNT(*) AS n FROM leave_requests WHERE madrasa_id=? AND type_id=?", [tid, row.id]);
  if (Number(used.n) > 0) {
    // History is never rewritten: a type that has requests is archived so the
    // existing records keep their meaning.
    await db.run("UPDATE leave_types SET status='archived', updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [row.id, tid]);
    await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "leave.type.archive", entity: "leave_type", entityId: String(row.id), ip: req.ip });
    return ok(res, { ok: true, archived: true, deleted: false });
  }
  await db.run("DELETE FROM leave_balances WHERE madrasa_id=? AND type_id=?", [tid, row.id]);
  await db.run("DELETE FROM leave_types WHERE id=? AND madrasa_id=?", [row.id, tid]);
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "leave.type.delete", entity: "leave_type", entityId: String(row.id), ip: req.ip });
  // Both flags are always present so the caller never has to test for
  // undefined to know which of the two outcomes happened.
  ok(res, { ok: true, archived: false, deleted: true });
}));

/* ------------------------------- balances -------------------------------- */

/** GET /balances?sessionId=&userId=&typeId= — entitlement, taken, remaining
    per staff member per leave type for one academic session. */
router.get("/balances", STAFF, requireStaffPermission("staff_leave.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  await ensureLeaveTypes(tid);
  const session = req.query.sessionId ? await sessionInTenant(tid, req.query.sessionId) : await currentSession(tid);
  if (!session) return ok(res, { session: null, balances: [], types: [], totals: { entitlement: 0, taken: 0, remaining: 0, pending: 0 } });

  const requestedUser = toNum(req.query.userId, 0);
  const userId = isAdmin(req) ? (requestedUser || null) : req.user.id;
  if (userId) {
    const person = await staffInTenant(tid, userId);
    if (!person) return err(res, 404, "Staff member not found.");
  }
  await refreshBalances(tid, { sessionId: session.id, userId: userId || null });

  const where = ["lb.madrasa_id = ?", "lb.session_id = ?", "lt.status <> 'archived'"];
  const params = [tid, session.id];
  if (userId) { where.push("lb.user_id = ?"); params.push(userId); }
  if (req.query.typeId) { where.push("lb.type_id = ?"); params.push(toNum(req.query.typeId, 0)); }
  const rows = await db.all(
    `SELECT lb.*, lt.name AS type_name, lt.name_ar AS type_name_ar, lt.code AS type_code, lt.colour AS type_colour,
            lt.paid AS type_paid, u.full_name, u.full_name_ar, u.username, tp.department, tp.staff_id,
            (SELECT COALESCE(SUM(days),0) FROM leave_requests lr
              WHERE lr.madrasa_id = lb.madrasa_id AND lr.user_id = lb.user_id AND lr.type_id = lb.type_id
                AND lr.session_id = lb.session_id AND lr.status = 'pending') AS pending
       FROM leave_balances lb
       JOIN leave_types lt ON lt.id = lb.type_id AND lt.madrasa_id = lb.madrasa_id
       JOIN users u ON u.id = lb.user_id AND u.madrasa_id = lb.madrasa_id
       LEFT JOIN teacher_profiles tp ON tp.user_id = lb.user_id AND tp.madrasa_id = lb.madrasa_id
      WHERE ${where.join(" AND ")}
      ORDER BY u.full_name, lt.sort_order, lt.name`,
    params
  );
  const balances = rows.map((row) => Object.assign({}, row, {
    entitlement: Number(row.entitlement || 0),
    taken: Number(row.taken || 0),
    remaining: Number(row.remaining || 0),
    pending: Number(row.pending || 0),
    type_paid: Number(row.type_paid) === 1,
    teacher_name: row.full_name || row.username || "",
  }));
  const types = await db.all("SELECT id, name, name_ar, code, colour, days_per_year, paid FROM leave_types WHERE madrasa_id = ? AND status <> 'archived' ORDER BY sort_order, name", [tid]);
  ok(res, {
    session,
    types: types.map((t) => Object.assign({}, t, { paid: Number(t.paid) === 1, days_per_year: Number(t.days_per_year || 0) })),
    balances,
    totals: balances.reduce((out, row) => ({
      entitlement: out.entitlement + row.entitlement,
      taken: out.taken + row.taken,
      remaining: out.remaining + row.remaining,
      pending: out.pending + row.pending,
    }), { entitlement: 0, taken: 0, remaining: 0, pending: 0 }),
  });
}));

/* ------------------------------- calendar -------------------------------- */

/** GET /calendar?month=&year= — every approved leave touching that month,
    already expanded into the working days the grid has to colour. */
router.get("/calendar", STAFF, requireStaffPermission("staff_leave.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  await ensureLeaveTypes(tid);
  const now = new Date();
  const month = Math.trunc(clampNum(req.query.month, 1, 12, now.getUTCMonth() + 1));
  const year = Math.trunc(clampNum(req.query.year, 1990, 2200, now.getUTCFullYear()));
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const where = ["lr.madrasa_id = ?", "lr.status = 'approved'", "lr.start_date <= ?", "lr.end_date >= ?"];
  const params = [tid, monthEnd, monthStart];
  if (req.query.typeId) { where.push("lr.type_id = ?"); params.push(toNum(req.query.typeId, 0)); }
  if (req.query.userId && isAdmin(req)) { where.push("lr.user_id = ?"); params.push(toNum(req.query.userId, 0)); }
  const rows = await db.all(`${REQUEST_SELECT} WHERE ${where.join(" AND ")} ORDER BY lr.start_date, u.full_name`, params);

  const includePrivate = isAdmin(req);
  const leaves = rows.map((row) => {
    const dto = requestDto(row, { includePrivate: includePrivate || Number(row.user_id) === Number(req.user.id) });
    dto.days_in_month = leaveDays(row.start_date, row.end_date).filter((d) => d >= monthStart && d <= monthEnd);
    return dto;
  });
  const byDay = {};
  for (const leave of leaves) {
    for (const day of leave.days_in_month) {
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push({
        request_id: leave.id, user_id: leave.user_id, teacher_name: leave.teacher_name,
        type_id: leave.type_id, type_name: leave.type_name, type_colour: leave.type_colour,
      });
    }
  }
  const types = await db.all("SELECT id, name, name_ar, code, colour FROM leave_types WHERE madrasa_id = ? AND status <> 'archived' ORDER BY sort_order, name", [tid]);
  ok(res, {
    month, year, from: monthStart, to: monthEnd, days_in_month: lastDay,
    first_weekday: new Date(Date.UTC(year, month - 1, 1)).getUTCDay(),
    working_days: DAYS,
    types, leaves, byDay,
    summary: { leaves: leaves.length, staff: new Set(leaves.map((l) => Number(l.user_id))).size },
  });
}));

/* ---------------------------- my leave (staff) --------------------------- */

/** GET /me — self-service: own balances, own requests and the catalogue.
    This is what a teacher portal / teacher dashboard renders. */
router.get("/me", STAFF, requireStaffPermission("staff_leave.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  await ensureLeaveTypes(tid);
  const person = await staffInTenant(tid, req.user.id);
  const session = req.query.sessionId ? await sessionInTenant(tid, req.query.sessionId) : await currentSession(tid);
  const types = await db.all("SELECT id, name, name_ar, code, colour, days_per_year, paid FROM leave_types WHERE madrasa_id = ? AND status = 'active' ORDER BY sort_order, name", [tid]);
  if (!person) {
    // Administrators have no teacher record of their own; they still get the
    // catalogue so the same screen can be reused for approvals.
    return ok(res, { staff: null, session, types, balances: [], requests: [] });
  }
  if (session) await refreshBalances(tid, { sessionId: session.id, userId: person.id });
  const balances = session ? await db.all(
    `SELECT lb.*, lt.name AS type_name, lt.name_ar AS type_name_ar, lt.colour AS type_colour, lt.paid AS type_paid,
            (SELECT COALESCE(SUM(days),0) FROM leave_requests lr WHERE lr.madrasa_id=lb.madrasa_id AND lr.user_id=lb.user_id
               AND lr.type_id=lb.type_id AND lr.session_id=lb.session_id AND lr.status='pending') AS pending
       FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.type_id AND lt.madrasa_id = lb.madrasa_id
      WHERE lb.madrasa_id=? AND lb.user_id=? AND lb.session_id=? AND lt.status <> 'archived'
      ORDER BY lt.sort_order, lt.name`,
    [tid, person.id, session.id]
  ) : [];
  const requests = await db.all(`${REQUEST_SELECT} WHERE lr.madrasa_id = ? AND lr.user_id = ? ORDER BY lr.start_date DESC, lr.id DESC LIMIT 200`, [tid, person.id]);
  ok(res, {
    staff: person, session, types,
    balances: balances.map((row) => Object.assign({}, row, {
      entitlement: Number(row.entitlement || 0), taken: Number(row.taken || 0),
      remaining: Number(row.remaining || 0), pending: Number(row.pending || 0), type_paid: Number(row.type_paid) === 1,
    })),
    requests: requests.map((row) => requestDto(row)),
  });
}));

/* ------------------------------- requests -------------------------------- */

function buildRequestFilters(req, tid) {
  const where = ["lr.madrasa_id = ?"]; const params = [tid];
  const status = cleanStr(req.query.status, 20).toLowerCase();
  if (status && REQUEST_STATUSES.has(status)) { where.push("lr.status = ?"); params.push(status); }
  if (req.query.typeId) { where.push("lr.type_id = ?"); params.push(toNum(req.query.typeId, 0)); }
  if (req.query.sessionId) { where.push("lr.session_id = ?"); params.push(toNum(req.query.sessionId, 0)); }
  if (req.query.from) { const from = validDate(req.query.from); if (from) { where.push("lr.end_date >= ?"); params.push(from); } }
  if (req.query.to) { const to = validDate(req.query.to); if (to) { where.push("lr.start_date <= ?"); params.push(to); } }
  if (req.query.search) {
    const like = `%${cleanStr(req.query.search, 100).toLowerCase()}%`;
    where.push("(LOWER(u.full_name) LIKE ? OR LOWER(u.username) LIKE ? OR LOWER(COALESCE(lr.reason,'')) LIKE ?)");
    params.push(like, like, like);
  }
  // A teacher only ever sees their own applications; an administrator may
  // filter by staff member. Never client-trusted for the tenant itself.
  if (isAdmin(req)) {
    if (req.query.userId) { where.push("lr.user_id = ?"); params.push(toNum(req.query.userId, 0)); }
  } else {
    where.push("lr.user_id = ?"); params.push(req.user.id);
  }
  return { where, params };
}

router.get("/", STAFF, requireStaffPermission("staff_leave.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  await ensureLeaveTypes(tid);
  const { where, params } = buildRequestFilters(req, tid);
  const page = Math.max(1, toNum(req.query.page, 1));
  const perPage = Math.min(200, Math.max(1, toNum(req.query.perPage, 50)));
  const total = await db.get(
    `SELECT COUNT(*) AS n FROM leave_requests lr JOIN users u ON u.id = lr.user_id AND u.madrasa_id = lr.madrasa_id WHERE ${where.join(" AND ")}`,
    params
  );
  const rows = await db.all(
    `${REQUEST_SELECT} WHERE ${where.join(" AND ")} ORDER BY lr.start_date DESC, lr.id DESC LIMIT ? OFFSET ?`,
    params.concat([perPage, (page - 1) * perPage])
  );
  const stats = await db.get(
    `SELECT SUM(CASE WHEN lr.status='pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN lr.status='approved' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN lr.status='rejected' THEN 1 ELSE 0 END) AS rejected,
            SUM(CASE WHEN lr.status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
            COALESCE(SUM(CASE WHEN lr.status='approved' THEN lr.days ELSE 0 END),0) AS approved_days,
            COUNT(*) AS total
       FROM leave_requests lr JOIN users u ON u.id = lr.user_id AND u.madrasa_id = lr.madrasa_id
      WHERE lr.madrasa_id = ?${isAdmin(req) ? "" : " AND lr.user_id = ?"}`,
    isAdmin(req) ? [tid] : [tid, req.user.id]
  );
  ok(res, {
    requests: rows.map((row) => requestDto(row)),
    total: Number(total.n || 0), page, perPage,
    totalPages: Math.max(1, Math.ceil(Number(total.n || 0) / perPage)),
    stats: {
      total: Number(stats.total || 0), pending: Number(stats.pending || 0), approved: Number(stats.approved || 0),
      rejected: Number(stats.rejected || 0), cancelled: Number(stats.cancelled || 0), approvedDays: Number(stats.approved_days || 0),
    },
  });
}));

/** CSV export of the same filtered list (Excel-safe, shared csv service). */
router.get("/export.csv", STAFF, requireStaffPermission("staff_leave.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const { where, params } = buildRequestFilters(req, tid);
  const rows = await db.all(`${REQUEST_SELECT} WHERE ${where.join(" AND ")} ORDER BY lr.start_date DESC, lr.id DESC LIMIT 5000`, params);
  csv.sendCsv(res, `staff-leave-${todayIso()}.csv`, csv.toCsv(rows, [
    { label: "Staff Member", value: (r) => r.full_name || r.username },
    { label: "Staff ID", key: "staff_id" },
    { label: "Department", key: "department" },
    { label: "Leave Type", key: "type_name" },
    { label: "Paid", value: (r) => (Number(r.type_paid) === 1 ? "Yes" : "No") },
    { label: "Start Date", value: (r) => String(r.start_date || "").slice(0, 10) },
    { label: "End Date", value: (r) => String(r.end_date || "").slice(0, 10) },
    { label: "Working Days", value: (r) => Number(r.days || 0) },
    { label: "Status", key: "status" },
    { label: "Session", key: "session_label" },
    { label: "Reason", key: "reason" },
    { label: "Reviewed By", key: "reviewed_by_name" },
    { label: "Review Note", key: "review_note" },
  ]));
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "leave.export", entity: "leave_request", meta: { rows: rows.length }, ip: req.ip });
}));

/** Approved leave that overlaps a window (used by submit and approve). */
async function overlappingApproved(tid, userId, startDate, endDate, excludeId = 0) {
  return db.get(
    `SELECT lr.id, lr.start_date, lr.end_date, lt.name AS type_name
       FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.type_id AND lt.madrasa_id = lr.madrasa_id
      WHERE lr.madrasa_id = ? AND lr.user_id = ? AND lr.status = 'approved' AND lr.id <> ?
        AND lr.start_date <= ? AND lr.end_date >= ?
      ORDER BY lr.start_date LIMIT 1`,
    [tid, userId, toNum(excludeId, 0), endDate, startDate]
  );
}

async function loadRequest(tid, id) {
  return db.get(`${REQUEST_SELECT} WHERE lr.id = ? AND lr.madrasa_id = ?`, [toNum(id, 0), tid]);
}

/** POST / — a teacher submits their own application; an administrator may
    submit on behalf of a staff member by passing user_id. */
router.post("/", STAFF, requireStaffPermission("staff_leave.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  await ensureLeaveTypes(tid);
  const b = req.body || {};
  const targetUserId = isAdmin(req) ? toNum(b.user_id ?? b.userId, 0) : req.user.id;
  if (!targetUserId) return err(res, 400, "Select the staff member this leave is for.");
  const person = await staffInTenant(tid, targetUserId);
  if (!person) return err(res, 400, "Select a staff member who belongs to this institution.");
  if (!isAdmin(req) && Number(person.id) !== Number(req.user.id)) return err(res, 403, "You can only request leave for yourself.");

  const type = await typeInTenant(tid, b.type_id ?? b.typeId);
  if (!type) return err(res, 400, "Select a leave type from this institution's catalogue.");
  if (type.status !== "active") return err(res, 400, "This leave type is no longer available.");

  const start = validDate(b.start_date ?? b.startDate);
  const end = validDate(b.end_date ?? b.endDate) || start;
  if (!start || !end) return err(res, 400, "Start and end dates are required (YYYY-MM-DD).");
  if (end < start) return err(res, 400, "The end date cannot be before the start date.");
  if (calendarSpanDays(start, end) > MAX_LEAVE_SPAN_DAYS) return err(res, 400, `A single leave request cannot span more than ${MAX_LEAVE_SPAN_DAYS} days.`);
  const days = leaveDays(start, end).length;
  if (!days) return err(res, 400, `The selected dates contain no working days (${DAYS.join(", ")}).`);

  const clash = await overlappingApproved(tid, person.id, start, end);
  if (clash) {
    return err(res, 409, `This staff member already has approved ${clash.type_name} from ${String(clash.start_date).slice(0, 10)} to ${String(clash.end_date).slice(0, 10)}.`, { code: "LEAVE_OVERLAP" });
  }
  // An IDENTICAL pending request (same staff member, same type, same dates)
  // is a duplicate submission — a double-clicked form, or two administrators
  // filing the same application. Merely *overlapping* pending requests stay
  // allowed: they are legitimate competing applications, and the overlap is
  // enforced at approval time, when only one of them can win.
  const duplicate = await db.get(
    `SELECT id FROM leave_requests
      WHERE madrasa_id = ? AND user_id = ? AND type_id = ?
        AND start_date = ? AND end_date = ? AND status = 'pending'
      LIMIT 1`,
    [tid, person.id, type.id, start, end]
  );
  if (duplicate) {
    return err(res, 409, `An identical ${type.name} request for ${start} to ${end} is already awaiting approval.`, { code: "LEAVE_DUPLICATE", requestId: duplicate.id });
  }

  const session = b.session_id ? await sessionInTenant(tid, b.session_id) : await sessionForDate(tid, start);
  const r = await db.run(
    `INSERT INTO leave_requests (madrasa_id,user_id,type_id,session_id,start_date,end_date,days,reason,status,created_by,updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'pending', ?, CURRENT_TIMESTAMP)`,
    [tid, person.id, type.id, session ? session.id : null, start, end, days, cleanStr(b.reason, 2000), req.user.id]
  );
  const id = Number(r.lastInsertRowid);
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "leave.request.create", entity: "leave_request", entityId: String(id), meta: { staff: person.id, type: type.id, start, end, days }, ip: req.ip });
  ok(res, { ok: true, id, days, session_id: session ? session.id : null, status: "pending" });
}));

router.get("/:id", STAFF, requireStaffPermission("staff_leave.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await loadRequest(tid, req.params.id);
  if (!row) return err(res, 404, "Leave request not found.");
  if (!isAdmin(req) && Number(row.user_id) !== Number(req.user.id)) return err(res, 404, "Leave request not found.");
  ok(res, { request: requestDto(row), days: leaveDays(row.start_date, row.end_date) });
}));

/** PATCH /:id — edit a pending application (owner or administrator). */
router.patch("/:id", STAFF, requireStaffPermission("staff_leave.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await loadRequest(tid, req.params.id);
  if (!row) return err(res, 404, "Leave request not found.");
  if (!isAdmin(req) && Number(row.user_id) !== Number(req.user.id)) return err(res, 404, "Leave request not found.");
  if (row.status !== "pending") return err(res, 400, "Only a pending request can be edited.");
  const b = req.body || {};

  const type = b.type_id || b.typeId ? await typeInTenant(tid, b.type_id ?? b.typeId) : { id: row.type_id };
  if (!type) return err(res, 400, "Select a leave type from this institution's catalogue.");
  const start = b.start_date || b.startDate ? validDate(b.start_date ?? b.startDate) : String(row.start_date).slice(0, 10);
  const end = b.end_date || b.endDate ? validDate(b.end_date ?? b.endDate) : String(row.end_date).slice(0, 10);
  if (!start || !end) return err(res, 400, "Start and end dates must be YYYY-MM-DD.");
  if (end < start) return err(res, 400, "The end date cannot be before the start date.");
  if (calendarSpanDays(start, end) > MAX_LEAVE_SPAN_DAYS) return err(res, 400, `A single leave request cannot span more than ${MAX_LEAVE_SPAN_DAYS} days.`);
  const days = leaveDays(start, end).length;
  if (!days) return err(res, 400, `The selected dates contain no working days (${DAYS.join(", ")}).`);
  const clash = await overlappingApproved(tid, row.user_id, start, end, row.id);
  if (clash) return err(res, 409, `This staff member already has approved ${clash.type_name} covering those dates.`);
  const session = b.session_id ? await sessionInTenant(tid, b.session_id) : await sessionForDate(tid, start);
  await db.run(
    "UPDATE leave_requests SET type_id=?, start_date=?, end_date=?, days=?, session_id=?, reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
    [type.id, start, end, days, session ? session.id : row.session_id, b.reason !== undefined ? cleanStr(b.reason, 2000) : row.reason, row.id, tid]
  );
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "leave.request.update", entity: "leave_request", entityId: String(row.id), ip: req.ip });
  ok(res, { ok: true, days });
}));

/** Shared approve/reject handler — PATCH /:id/approve | /:id/reject. */
function review(decision) {
  return asyncHandler(async (req, res) => {
    const tid = await tenantId(req, res); if (tid == null) return;
    const row = await loadRequest(tid, req.params.id);
    if (!row) return err(res, 404, "Leave request not found.");
    if (row.status !== "pending") return err(res, 400, `This request is already ${row.status}.`);
    const note = cleanStr((req.body || {}).note ?? (req.body || {}).review_note, 2000);

    let attendanceRows = 0;
    if (decision === "approved") {
      const clash = await overlappingApproved(tid, row.user_id, row.start_date, row.end_date, row.id);
      if (clash) {
        return err(res, 409, `Cannot approve: this staff member already has approved ${clash.type_name} from ${String(clash.start_date).slice(0, 10)} to ${String(clash.end_date).slice(0, 10)}.`);
      }
    }
    await db.run(
      "UPDATE leave_requests SET status=?, reviewed_by=?, review_note=?, reviewed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
      [decision, req.user.id, note, row.id, tid]
    );
    if (decision === "approved") {
      attendanceRows = await applyLeaveToRegister(tid, row, row.type_name, req.user.id);
    }
    await refreshBalances(tid, { userId: row.user_id, sessionId: row.session_id || null, typeId: row.type_id });
    await logActivity(db, {
      madrasaId: tid, userId: req.user.id, action: `leave.request.${decision === "approved" ? "approve" : "reject"}`,
      entity: "leave_request", entityId: String(row.id),
      meta: { staff: row.user_id, days: Number(row.days || 0), attendanceRows, note: note || undefined }, ip: req.ip,
    });
    ok(res, { ok: true, status: decision, attendanceRows });
  });
}

router.patch("/:id/approve", ADMIN, requireStaffPermission("staff_leave.approve"), review("approved"));
router.patch("/:id/reject", ADMIN, requireStaffPermission("staff_leave.approve"), review("rejected"));

/** PATCH /:id/cancel — the owner withdraws, or an administrator cancels an
    approved leave (which also reverses the register rows it created). */
router.patch("/:id/cancel", STAFF, requireStaffPermission("staff_leave.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await loadRequest(tid, req.params.id);
  if (!row) return err(res, 404, "Leave request not found.");
  const owner = Number(row.user_id) === Number(req.user.id);
  if (!isAdmin(req) && !owner) return err(res, 404, "Leave request not found.");
  if (!["pending", "approved"].includes(row.status)) return err(res, 400, `This request is already ${row.status}.`);
  if (!isAdmin(req) && row.status === "approved" && String(row.start_date).slice(0, 10) <= todayIso()) {
    return err(res, 400, "Approved leave that has already started can only be cancelled by an administrator.");
  }
  const note = cleanStr((req.body || {}).note ?? (req.body || {}).review_note, 2000);
  let removed = 0;
  if (row.status === "approved") removed = await removeLeaveFromRegister(tid, row);
  await db.run(
    "UPDATE leave_requests SET status='cancelled', reviewed_by=?, review_note=?, reviewed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
    [req.user.id, note, row.id, tid]
  );
  await refreshBalances(tid, { userId: row.user_id, sessionId: row.session_id || null, typeId: row.type_id });
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "leave.request.cancel", entity: "leave_request", entityId: String(row.id), meta: { staff: row.user_id, attendanceRowsRemoved: removed }, ip: req.ip });
  ok(res, { ok: true, status: "cancelled", attendanceRowsRemoved: removed });
}));

/** DELETE /:id — administrators remove a record entirely (register rows this
    module created are reversed first). */
router.delete("/:id", ADMIN, requireStaffPermission("staff_leave.approve"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await loadRequest(tid, req.params.id);
  if (!row) return err(res, 404, "Leave request not found.");
  const removed = row.status === "approved" ? await removeLeaveFromRegister(tid, row) : 0;
  await db.run("DELETE FROM leave_requests WHERE id=? AND madrasa_id=?", [row.id, tid]);
  await refreshBalances(tid, { userId: row.user_id, sessionId: row.session_id || null, typeId: row.type_id });
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "leave.request.delete", entity: "leave_request", entityId: String(row.id), meta: { attendanceRowsRemoved: removed }, ip: req.ip });
  ok(res, { ok: true, attendanceRowsRemoved: removed });
}));

module.exports = router;
// Exported for tests and for any future module that needs the same working-day
// rules (Mon–Sat, matching the timetable) without duplicating them.
module.exports.leaveDays = leaveDays;
module.exports.DEFAULT_LEAVE_TYPES = DEFAULT_LEAVE_TYPES;
