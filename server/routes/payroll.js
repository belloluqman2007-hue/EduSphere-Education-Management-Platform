"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — Payroll (tenant-scoped, madrasa admins)
   ----------------------------------------------------------------------------
   Additive finance module following the fees.js conventions exactly:
     • every query filtered by madrasa_id resolved from the session (never
       client-supplied) via effectiveTenantId — see middleware/tenant.js
     • role guards: ADMIN (madrasa_admin) for the whole ledger
     • activity logging through the shared util.logActivity
     • CSV export through services/csv.js
     • server-rendered printable payslip (like the fee receipt)

   Workflow: salary_structures (per teacher) + salary_advances (loans) feed
   pay_periods (one calendar month inside an academic session). Bulk
   processing computes one pay_slip per salaried teacher:
     gross = base + allowances (housing, transport, medical, other)
     deductions = tax + pension + other + advance repayment instalment
     net = gross - deductions (never below zero)
   Advance instalments are recorded inside the payslip's deductions JSON so a
   re-process restores the balances before recomputing — no double deduction.
   ========================================================================== */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, clampNum, validDate, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { requirePermission, requireStaffPermission } = require("../services/permissions");
const { effectiveTenantId } = require("../middleware/tenant");
const { requireFeature } = require("../middleware/subscription");
const csv = require("../services/csv");

const router = express.Router();
router.use(requireAuth, requireTenant);
// Payroll is a Premium capability ("Finance & HR: payroll, expenses, budgets").
router.use(requireFeature("payroll"));
const ADMIN = requireRole("madrasa_admin");

const PERIOD_STATUSES = new Set(["draft", "processed", "paid"]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ALLOWANCE_KEYS = ["housing", "transport", "medical", "other"];
const DEDUCTION_KEYS = ["tax", "pension", "other"];

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required." }); return null; }
  return tid;
}
function n(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function round2(v) { return Math.round((n(v) + Number.EPSILON) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function monthName(m) { return MONTHS[clampNum(m, 1, 12, 1) - 1]; }
function periodLabel(month, year) { return `${monthName(month)} ${year}`; }

/** Parses a stored JSON column; always returns an object. */
function parseJson(raw, fallback = {}) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  try { const v = JSON.parse(String(raw)); return (v && typeof v === "object" && !Array.isArray(v)) ? v : fallback; }
  catch (e) { return fallback; }
}

/** Coerces a submitted allowances/deductions payload to a clean
    { key: number >= 0 } object over the allowed keys. */
function moneyMap(raw, keys) {
  const out = {};
  const src = parseJson(raw);
  for (const key of keys) out[key] = round2(clampNum(src[key], 0, 999999999, 0));
  return out;
}
function sumValues(map) {
  return round2(Object.values(map || {}).reduce((a, v) => a + n(v), 0));
}

/** Teacher user record inside the tenant (users.id is the payroll key). */
async function teacherInTenant(tid, userId) {
  const id = toNum(userId, 0);
  if (!id) return null;
  return db.get("SELECT id, full_name, full_name_ar, username, is_active FROM users WHERE id = ? AND madrasa_id = ? AND role = 'teacher'", [id, tid]);
}

async function sessionInTenant(tid, sessionId) {
  const id = toNum(sessionId, 0);
  if (!id) return null;
  return db.get("SELECT id, label FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [id, tid]);
}

/* ------------------------- salary structures --------------------------- */

router.get("/structures", ADMIN, requireStaffPermission("payroll.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const where = ["s.madrasa_id = ?"]; const params = [tid];
  if (req.query.userId) { where.push("s.user_id = ?"); params.push(toNum(req.query.userId, 0)); }
  if (req.query.grade) { where.push("s.grade = ?"); params.push(cleanStr(req.query.grade, 60)); }
  const rows = await db.all(
    `SELECT s.*, u.full_name, u.full_name_ar, u.username, u.is_active
       FROM salary_structures s
       JOIN users u ON u.id = s.user_id AND u.madrasa_id = s.madrasa_id
      WHERE ${where.join(" AND ")}
      ORDER BY u.full_name, s.effective_from DESC, s.id DESC`,
    params
  );
  ok(res, {
    structures: rows.map((row) => Object.assign({}, row, {
      allowances: parseJson(row.allowances),
      deductions: parseJson(row.deductions),
      allowance_total: sumValues(parseJson(row.allowances)),
      deduction_total: sumValues(parseJson(row.deductions)),
    })),
  });
}));

function validateStructure(body) {
  const b = body || {};
  const grade = cleanStr(b.grade, 60);
  const base = round2(clampNum(b.base_ngn ?? b.base ?? 0, 0, 999999999, 0));
  const allowances = moneyMap(b.allowances, ALLOWANCE_KEYS);
  const deductions = moneyMap(b.deductions, DEDUCTION_KEYS);
  let effectiveFrom = b.effective_from ? validDate(b.effective_from) : null;
  if (b.effective_from && !effectiveFrom) return { error: "effective_from must be YYYY-MM-DD." };
  if (!effectiveFrom) effectiveFrom = today();
  if (base <= 0 && sumValues(allowances) <= 0) return { error: "Base salary or at least one allowance must be greater than zero." };
  return { grade, base, allowances, deductions, effectiveFrom };
}

router.post("/structures", requirePermission("payroll.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const teacher = await teacherInTenant(tid, b.user_id ?? b.userId);
  if (!teacher) return err(res, 400, "Select a teacher who belongs to this institution.");
  const v = validateStructure(b);
  if (v.error) return err(res, 400, v.error);
  let id;
  try {
    const r = await db.run(
      `INSERT INTO salary_structures (madrasa_id,user_id,grade,base_ngn,allowances,deductions,effective_from,created_by,updated_at)
       VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      [tid, teacher.id, v.grade, v.base, v.allowances, v.deductions, v.effectiveFrom, req.user.id]
    );
    id = Number(r.lastInsertRowid);
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message || ""))) return err(res, 400, "This teacher already has a salary structure with the same effective date.");
    throw e;
  }
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.structure.create", entity: "salary_structure", entityId: String(id), meta: { teacher: teacher.id, grade: v.grade, base: v.base }, ip: req.ip });
  ok(res, { ok: true, id });
}));

router.patch("/structures/:id", ADMIN, requireStaffPermission("payroll.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const id = toNum(req.params.id, 0);
  const row = await db.get("SELECT * FROM salary_structures WHERE id = ? AND madrasa_id = ?", [id, tid]);
  if (!row) return res.status(404).json({ error: "Salary structure not found." });
  const b = req.body || {};
  const merged = {
    grade: b.grade !== undefined ? b.grade : row.grade,
    base_ngn: b.base_ngn !== undefined ? b.base_ngn : row.base_ngn,
    allowances: b.allowances !== undefined ? b.allowances : parseJson(row.allowances),
    deductions: b.deductions !== undefined ? b.deductions : parseJson(row.deductions),
    effective_from: b.effective_from !== undefined ? b.effective_from : row.effective_from,
  };
  const v = validateStructure(merged);
  if (v.error) return err(res, 400, v.error);
  try {
    await db.run(
      "UPDATE salary_structures SET grade=?, base_ngn=?, allowances=?, deductions=?, effective_from=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
      [v.grade, v.base, v.allowances, v.deductions, v.effectiveFrom, id, tid]
    );
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message || ""))) return err(res, 400, "This teacher already has a salary structure with the same effective date.");
    throw e;
  }
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.structure.update", entity: "salary_structure", entityId: String(id), ip: req.ip });
  ok(res, { ok: true });
}));

router.delete("/structures/:id", ADMIN, requireStaffPermission("payroll.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const r = await db.run("DELETE FROM salary_structures WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!r.changes) return res.status(404).json({ error: "Salary structure not found." });
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.structure.delete", entity: "salary_structure", entityId: String(req.params.id), ip: req.ip });
  ok(res, { ok: true });
}));

/* ----------------------------- pay periods ------------------------------ */

/** Loads a period with its calendar + session context, tenant-scoped. */
async function loadPeriod(tid, id) {
  const period = await db.get(
    `SELECT p.*, s.label AS session_label FROM pay_periods p
       LEFT JOIN academic_sessions s ON s.id = p.session_id AND s.madrasa_id = p.madrasa_id
      WHERE p.id = ? AND p.madrasa_id = ?`,
    [toNum(id, 0), tid]
  );
  if (!period) return null;
  return Object.assign(period, {
    month_start: `${period.year}-${String(period.month).padStart(2, "0")}-01`,
    label: periodLabel(period.month, period.year),
  });
}

router.get("/periods", ADMIN, requireStaffPermission("payroll.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const where = ["p.madrasa_id = ?"]; const params = [tid];
  if (req.query.sessionId) { where.push("p.session_id = ?"); params.push(toNum(req.query.sessionId, 0)); }
  if (req.query.status && PERIOD_STATUSES.has(String(req.query.status))) { where.push("p.status = ?"); params.push(String(req.query.status)); }
  const rows = await db.all(
    `SELECT p.*, s.label AS session_label,
            (SELECT COUNT(*) FROM pay_slips ps WHERE ps.pay_period_id = p.id AND ps.madrasa_id = p.madrasa_id) AS slip_count,
            (SELECT COALESCE(SUM(ps.gross),0) FROM pay_slips ps WHERE ps.pay_period_id = p.id AND ps.madrasa_id = p.madrasa_id) AS total_gross,
            (SELECT COALESCE(SUM(ps.net),0) FROM pay_slips ps WHERE ps.pay_period_id = p.id AND ps.madrasa_id = p.madrasa_id) AS total_net
       FROM pay_periods p
       LEFT JOIN academic_sessions s ON s.id = p.session_id AND s.madrasa_id = p.madrasa_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.year DESC, p.month DESC, p.id DESC`,
    params
  );
  ok(res, { periods: rows.map((row) => Object.assign({}, row, { label: periodLabel(row.month, row.year) })) });
}));

router.post("/periods", requirePermission("payroll.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const session = await sessionInTenant(tid, b.session_id ?? b.sessionId);
  if (!session) return err(res, 400, "Choose an academic session that belongs to this institution.");
  const month = Math.trunc(toNum(b.month, 0));
  const year = Math.trunc(toNum(b.year, 0));
  if (month < 1 || month > 12) return err(res, 400, "Month must be between 1 (January) and 12 (December).");
  if (year < 1990 || year > 2200) return err(res, 400, "Enter a valid calendar year.");
  const dup = await db.get("SELECT id FROM pay_periods WHERE madrasa_id=? AND year=? AND month=?", [tid, year, month]);
  if (dup) return err(res, 400, `A pay period for ${periodLabel(month, year)} already exists.`);
  const r = await db.run(
    "INSERT INTO pay_periods (madrasa_id,session_id,month,year,status,created_by,updated_at) VALUES (?,?,?,?,'draft',?,CURRENT_TIMESTAMP)",
    [tid, session.id, month, year, req.user.id]
  );
  const id = Number(r.lastInsertRowid);
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.period.create", entity: "pay_period", entityId: String(id), meta: { month, year, session: session.id }, ip: req.ip });
  ok(res, { ok: true, id });
}));

router.delete("/periods/:id", ADMIN, requireStaffPermission("payroll.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const period = await loadPeriod(tid, req.params.id);
  if (!period) return res.status(404).json({ error: "Pay period not found." });
  if (period.status !== "draft") return err(res, 400, "Only draft periods can be deleted.");
  const slips = await db.get("SELECT COUNT(*) AS c FROM pay_slips WHERE pay_period_id=? AND madrasa_id=?", [period.id, tid]);
  if (Number(slips.c) > 0) return err(res, 400, "This period already has payslips.");
  await db.run("DELETE FROM pay_periods WHERE id=? AND madrasa_id=?", [period.id, tid]);
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.period.delete", entity: "pay_period", entityId: String(period.id), ip: req.ip });
  ok(res, { ok: true });
}));

/* --------------------------- payslip engine ----------------------------- */

/** The structure effective for a period: the newest one whose effective_from
    is on/before the period's month start, else the newest overall. */
async function effectiveStructure(api, tid, userId, monthStartIso) {
  let row = await api.get(
    "SELECT * FROM salary_structures WHERE madrasa_id=? AND user_id=? AND effective_from IS NOT NULL AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1",
    [tid, userId, monthStartIso]
  );
  if (!row) row = await api.get(
    "SELECT * FROM salary_structures WHERE madrasa_id=? AND user_id=? ORDER BY effective_from DESC, id DESC LIMIT 1",
    [tid, userId]
  );
  return row || null;
}

/** Adds back the advance instalments a stored payslip deducted, so a
    re-process or deletion never double-deducts a loan. */
async function restoreAdvanceDeductions(api, tid, deductionsRaw) {
  const ded = parseJson(deductionsRaw);
  const advances = Array.isArray(ded.advances) ? ded.advances : [];
  for (const entry of advances) {
    const advanceId = toNum(entry && entry.advance_id, 0);
    const amount = round2(entry && entry.amount);
    if (!advanceId || amount <= 0) continue;
    await api.run(
      // Ceiling at the advance's original `amount` column. MIN() is a
      // two-argument scalar in SQLite but an AGGREGATE in MySQL, so the
      // portable form is CASE WHEN (identical in both dialects).
      "UPDATE salary_advances SET balance = CASE WHEN balance + ? > amount THEN amount ELSE balance + ? END, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
      [amount, amount, advanceId, tid]
    );
  }
}

/** Computes one teacher's payslip for a period and upserts it.
    Returns true when a slip was written, false when there is no structure. */
async function computePayslip(api, tid, period, teacher, monthStartIso) {
  const structure = await effectiveStructure(api, tid, teacher.id, monthStartIso);
  if (!structure) return false;

  const allowances = parseJson(structure.allowances);
  const fixed = parseJson(structure.deductions);
  const base = round2(structure.base_ngn);
  const gross = round2(base + sumValues(allowances));
  const fixedTotal = sumValues(fixed);

  // Advance instalments: monthly slice of each outstanding loan, capped by the
  // remaining net so a payslip can never come out negative.
  let net = round2(gross - fixedTotal);
  const advanceLines = [];
  if (net > 0) {
    const advances = await api.all(
      "SELECT * FROM salary_advances WHERE madrasa_id=? AND user_id=? AND balance > 0 ORDER BY created_at, id",
      [tid, teacher.id]
    );
    for (const adv of advances) {
      if (net <= 0) break;
      const monthly = round2(n(adv.amount) / Math.max(1, Math.trunc(n(adv.repayment_months))));
      const instalment = round2(Math.min(monthly, n(adv.balance), net));
      if (instalment <= 0) continue;
      advanceLines.push({ advance_id: Number(adv.id), amount: instalment });
      net = round2(net - instalment);
    }
  }

  const deductions = {
    tax: round2(fixed.tax || 0),
    pension: round2(fixed.pension || 0),
    other: round2(fixed.other || 0),
    advances: advanceLines,
    advance_total: round2(advanceLines.reduce((a, x) => a + x.amount, 0)),
    total: round2(fixedTotal + advanceLines.reduce((a, x) => a + x.amount, 0)),
  };

  // Replace any previous slip for this (period, teacher) pair.
  const existing = await api.get("SELECT id, deductions FROM pay_slips WHERE madrasa_id=? AND pay_period_id=? AND user_id=?", [tid, period.id, teacher.id]);
  if (existing) {
    await restoreAdvanceDeductions(api, tid, existing.deductions);
    await api.run(
      "UPDATE pay_slips SET gross=?, deductions=?, net=?, paid_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [gross, deductions, net, existing.id]
    );
  } else {
    await api.run(
      "INSERT INTO pay_slips (madrasa_id,pay_period_id,user_id,gross,deductions,net,updated_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
      [tid, period.id, teacher.id, gross, deductions, net]
    );
  }

  // Apply this slip's instalments to the advance balances.
  for (const line of advanceLines) {
    await api.run(
      "UPDATE salary_advances SET balance = CASE WHEN balance - ? < 0 THEN 0 ELSE balance - ? END, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",
      [line.amount, line.amount, line.advance_id, tid]
    );
  }
  return true;
}

/** POST /periods/:id/process — bulk compute every salaried teacher's slip. */
router.post("/periods/:id/process", ADMIN, requireStaffPermission("payroll.process"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const period = await loadPeriod(tid, req.params.id);
  if (!period) return res.status(404).json({ error: "Pay period not found." });
  if (period.status === "paid") return err(res, 400, "This period is already paid; payslips can no longer be recomputed.");

  const result = await db.transaction(async (api) => {
    // Recompute idempotently: computePayslip() upserts each teacher's slip and
    // restores that slip's recorded advance instalments before reapplying
    // them, so re-processing never double-deducts a loan.
    const previous = await api.all("SELECT id, user_id FROM pay_slips WHERE madrasa_id=? AND pay_period_id=?", [tid, period.id]);
    const previousUserIds = new Set(previous.map((s) => Number(s.user_id)));

    const teachers = await api.all("SELECT id FROM users WHERE madrasa_id=? AND role='teacher' AND is_active=1", [tid]);
    const processedUserIds = new Set();
    let created = 0;
    for (const teacher of teachers) {
      const done = await computePayslip(api, tid, period, teacher, period.month_start);
      if (done) { created++; processedUserIds.add(Number(teacher.id)); }
    }

    // Drop slips the recomputation no longer covers (teacher deactivated or
    // their structure removed), restoring any instalments they carried.
    for (const slip of previous) {
      if (!processedUserIds.has(Number(slip.user_id))) {
        const row = await api.get("SELECT deductions FROM pay_slips WHERE id=?", [slip.id]);
        if (row) await restoreAdvanceDeductions(api, tid, row.deductions);
        await api.run("DELETE FROM pay_slips WHERE id=? AND madrasa_id=?", [slip.id, tid]);
      }
    }

    const totals = await api.get("SELECT COALESCE(SUM(gross),0) AS g, COALESCE(SUM(net),0) AS nt FROM pay_slips WHERE madrasa_id=? AND pay_period_id=?", [tid, period.id]);
    await api.run("UPDATE pay_periods SET status='processed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [period.id, tid]);
    return { created, totalGross: round2(totals.g), totalNet: round2(totals.nt) };
  });

  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.period.process", entity: "pay_period", entityId: String(period.id), meta: { created: result.created, totalNet: result.totalNet }, ip: req.ip });
  ok(res, { ok: true, created: result.created, totalGross: result.totalGross, totalNet: result.totalNet });
}));

/** POST /periods/:id/pay — finalise the period and stamp every slip paid. */
router.post("/periods/:id/pay", ADMIN, requireStaffPermission("payroll.approve"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const period = await loadPeriod(tid, req.params.id);
  if (!period) return res.status(404).json({ error: "Pay period not found." });
  if (period.status === "draft") return err(res, 400, "Process the period's payslips before marking it paid.");
  if (period.status === "paid") return err(res, 400, "This period is already marked paid.");
  const slips = await db.get("SELECT COUNT(*) AS c FROM pay_slips WHERE madrasa_id=? AND pay_period_id=?", [tid, period.id]);
  if (!Number(slips.c)) return err(res, 400, "This period has no payslips to pay.");
  await db.transaction(async (api) => {
    await api.run("UPDATE pay_slips SET paid_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE madrasa_id=? AND pay_period_id=? AND paid_at IS NULL", [tid, period.id]);
    await api.run("UPDATE pay_periods SET status='paid', updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [period.id, tid]);
  });
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.period.pay", entity: "pay_period", entityId: String(period.id), meta: { slips: Number(slips.c) }, ip: req.ip });
  ok(res, { ok: true, paid: Number(slips.c) });
}));

/* ------------------------------- payslips -------------------------------- */

router.get("/payslips", ADMIN, requireStaffPermission("payslips.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const where = ["ps.madrasa_id = ?"]; const params = [tid];
  if (req.query.periodId) { where.push("ps.pay_period_id = ?"); params.push(toNum(req.query.periodId, 0)); }
  if (req.query.userId) { where.push("ps.user_id = ?"); params.push(toNum(req.query.userId, 0)); }
  if (req.query.status === "paid") { where.push("ps.paid_at IS NOT NULL"); }
  if (req.query.status === "unpaid") { where.push("ps.paid_at IS NULL"); }
  if (req.query.sessionId) { where.push("p.session_id = ?"); params.push(toNum(req.query.sessionId, 0)); }
  const rows = await db.all(
    `SELECT ps.*, u.full_name, u.full_name_ar, u.username, p.month, p.year, p.status AS period_status,
            p.session_id, s.label AS session_label
       FROM pay_slips ps
       JOIN users u ON u.id = ps.user_id AND u.madrasa_id = ps.madrasa_id
       JOIN pay_periods p ON p.id = ps.pay_period_id AND p.madrasa_id = ps.madrasa_id
       LEFT JOIN academic_sessions s ON s.id = p.session_id AND s.madrasa_id = p.madrasa_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.year DESC, p.month DESC, u.full_name
      LIMIT 2000`,
    params
  );
  ok(res, {
    payslips: rows.map((row) => Object.assign({}, row, {
      deductions: parseJson(row.deductions),
      period_label: periodLabel(row.month, row.year),
    })),
    summary: {
      count: rows.length,
      totalGross: round2(rows.reduce((a, r) => a + n(r.gross), 0)),
      totalNet: round2(rows.reduce((a, r) => a + n(r.net), 0)),
      totalDeductions: round2(rows.reduce((a, r) => a + n(parseJson(r.deductions).total), 0)),
    },
  });
}));

/** POST /payslips — generate (or recompute) one teacher's slip for a period. */
router.post("/payslips", ADMIN, requireStaffPermission("payroll.process"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const period = await loadPeriod(tid, b.pay_period_id ?? b.periodId ?? b.period_id);
  if (!period) return res.status(404).json({ error: "Pay period not found." });
  if (period.status === "paid") return err(res, 400, "This period is already paid; payslips can no longer be recomputed.");
  const teacher = await teacherInTenant(tid, b.user_id ?? b.userId);
  if (!teacher) return err(res, 400, "Select a teacher who belongs to this institution.");

  let slipId = null;
  await db.transaction(async (api) => {
    const done = await computePayslip(api, tid, period, teacher, period.month_start);
    if (!done) return;
    const row = await api.get("SELECT id FROM pay_slips WHERE madrasa_id=? AND pay_period_id=? AND user_id=?", [tid, period.id, teacher.id]);
    slipId = row ? Number(row.id) : null;
    if (slipId && period.status === "draft") {
      await api.run("UPDATE pay_periods SET status='processed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [period.id, tid]);
    }
  });
  if (!slipId) return err(res, 400, "This teacher has no salary structure yet.");

  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.payslip.generate", entity: "pay_slip", entityId: String(slipId), meta: { period: period.id, teacher: teacher.id }, ip: req.ip });
  ok(res, { ok: true, id: slipId });
}));

router.get("/payslips/:id", ADMIN, requireStaffPermission("payslips.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await db.get(
    `SELECT ps.*, u.full_name, u.full_name_ar, u.username, p.month, p.year, p.status AS period_status,
            p.session_id, s.label AS session_label, m.name_en AS institution_name
       FROM pay_slips ps
       JOIN users u ON u.id = ps.user_id AND u.madrasa_id = ps.madrasa_id
       JOIN pay_periods p ON p.id = ps.pay_period_id AND p.madrasa_id = ps.madrasa_id
       LEFT JOIN academic_sessions s ON s.id = p.session_id AND s.madrasa_id = p.madrasa_id
       JOIN madaris m ON m.id = ps.madrasa_id
      WHERE ps.id = ? AND ps.madrasa_id = ?`,
    [toNum(req.params.id, 0), tid]
  );
  if (!row) return res.status(404).json({ error: "Payslip not found." });
  ok(res, { payslip: Object.assign({}, row, { deductions: parseJson(row.deductions), period_label: periodLabel(row.month, row.year) }) });
}));

router.delete("/payslips/:id", ADMIN, requireStaffPermission("payroll.process"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const slip = await db.get(
    "SELECT ps.*, p.status AS period_status FROM pay_slips ps JOIN pay_periods p ON p.id = ps.pay_period_id AND p.madrasa_id = ps.madrasa_id WHERE ps.id=? AND ps.madrasa_id=?",
    [toNum(req.params.id, 0), tid]
  );
  if (!slip) return res.status(404).json({ error: "Payslip not found." });
  if (slip.period_status === "paid" || slip.paid_at) return err(res, 400, "Paid payslips cannot be deleted.");
  await db.transaction(async (api) => {
    await restoreAdvanceDeductions(api, tid, slip.deductions);
    await api.run("DELETE FROM pay_slips WHERE id=? AND madrasa_id=?", [slip.id, tid]);
  });
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.payslip.delete", entity: "pay_slip", entityId: String(slip.id), ip: req.ip });
  ok(res, { ok: true });
}));

/** GET /payslips/:id/print — server-rendered printable payslip (same pattern
    as the fee receipt). Printing runs through /js/print.js so the page stays
    CSP-safe under script-src 'self' (no inline script handler). */
router.get("/payslips/:id/print", ADMIN, requireStaffPermission("payslips.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const p = await db.get(
    `SELECT ps.*, u.full_name, u.full_name_ar, u.username, p.month, p.year, p.status AS period_status,
            s.label AS session_label, m.name_en AS institution_name, m.address, m.phone
       FROM pay_slips ps
       JOIN users u ON u.id = ps.user_id AND u.madrasa_id = ps.madrasa_id
       JOIN pay_periods p ON p.id = ps.pay_period_id AND p.madrasa_id = ps.madrasa_id
       LEFT JOIN academic_sessions s ON s.id = p.session_id AND s.madrasa_id = p.madrasa_id
       JOIN madaris m ON m.id = ps.madrasa_id
      WHERE ps.id = ? AND ps.madrasa_id = ?`,
    [toNum(req.params.id, 0), tid]
  );
  if (!p) return res.status(404).send("Payslip not found");

  // Earnings breakdown: the structure effective at the period's month start.
  const monthStart = `${p.year}-${String(p.month).padStart(2, "0")}-01`;
  const structure = (await db.get(
    "SELECT * FROM salary_structures WHERE madrasa_id=? AND user_id=? AND effective_from IS NOT NULL AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1",
    [tid, p.user_id, monthStart]
  )) || (await db.get(
    "SELECT * FROM salary_structures WHERE madrasa_id=? AND user_id=? ORDER BY effective_from DESC, id DESC LIMIT 1",
    [tid, p.user_id]
  ));
  const allowances = structure ? parseJson(structure.allowances) : {};
  const ded = parseJson(p.deductions);
  const advanceTotal = round2((ded.advances || []).reduce((a, x) => a + n(x.amount), 0));

  const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ngn = (v) => "₦" + n(v).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const row = (label, value) => `<div class="row"><b>${esc(label)}</b><span>${esc(value)}</span></div>`;
  const money = (label, value) => `<div class="row"><b>${esc(label)}</b><span>${esc(ngn(value))}</span></div>`;

  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payslip ${esc(String(p.id).padStart(5, "0"))} — ${esc(p.full_name || p.username)}</title>
<style>
  body{font:15px/1.5 Arial,Helvetica,sans-serif;color:#1c1523;background:#fff;margin:0;padding:24px}
  .sheet{max-width:720px;margin:0 auto}
  h1{color:#220b40;margin:0 0 2px;font-size:1.35rem}
  .muted{color:#6b6575;margin:0 0 18px}
  .head{border-bottom:3px solid #220b40;padding-bottom:12px;margin-bottom:16px;display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}
  .badge{display:inline-block;border:1px solid #220b40;color:#220b40;border-radius:999px;padding:3px 12px;font-size:.78rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
  h2{font-size:1.05rem;margin:18px 0 6px;color:#220b40}
  .row{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid #e7e3ee;padding:8px 0}
  .row b{font-weight:600;color:#443b52}
  .total{border-top:3px double #220b40;border-bottom:none;margin-top:6px;padding-top:10px;font-weight:800}
  .total span{font-size:1.1rem;color:#220b40}
  .foot{margin-top:26px;display:flex;justify-content:space-between;gap:24px;color:#6b6575;font-size:.8rem;flex-wrap:wrap}
  .sig{border-top:1px solid #9a92a8;width:200px;text-align:center;padding-top:6px}
  .print-bar{max-width:720px;margin:0 auto 14px;text-align:right}
  .print-btn{font:600 14px Arial;padding:9px 18px;background:#220b40;color:#fff;border:none;border-radius:8px;cursor:pointer}
  @media print{.print-bar{display:none}body{padding:0}}
</style></head><body>
<div class="print-bar"><button type="button" class="print-btn" id="printPageBtn">Print payslip</button></div>
<div class="sheet">
  <div class="head">
    <div><h1>${esc(p.institution_name)}</h1><p class="muted">${esc([p.address, p.phone].filter(Boolean).join(" · "))}</p></div>
    <span class="badge">Payslip ${esc(String(p.id).padStart(5, "0"))}</span>
  </div>
  ${row("Staff member", p.full_name || p.username)}
  ${structure ? row("Grade", structure.grade || "—") : ""}
  ${row("Pay period", periodLabel(p.month, p.year))}
  ${row("Academic session", p.session_label || "—")}
  ${row("Pay date", p.paid_at ? String(p.paid_at).slice(0, 10) : "Not yet paid")}
  <h2>Earnings</h2>
  ${money("Basic salary", structure ? structure.base_ngn : p.gross)}
  ${allowances.housing ? money("Housing allowance", allowances.housing) : ""}
  ${allowances.transport ? money("Transport allowance", allowances.transport) : ""}
  ${allowances.medical ? money("Medical allowance", allowances.medical) : ""}
  ${allowances.other ? money("Other allowance", allowances.other) : ""}
  <div class="row total"><b>Gross pay</b><span>${esc(ngn(p.gross))}</span></div>
  <h2>Deductions</h2>
  ${ded.tax ? money("Tax", ded.tax) : ""}
  ${ded.pension ? money("Pension", ded.pension) : ""}
  ${ded.other ? money("Other deduction", ded.other) : ""}
  ${advanceTotal ? money("Loan / advance repayment", advanceTotal) : ""}
  <div class="row total"><b>Total deductions</b><span>${esc(ngn(ded.total))}</span></div>
  <h2>Net pay</h2>
  <div class="row total"><b>Net pay</b><span>${esc(ngn(p.net))}</span></div>
  <div class="foot">
    <div>System-generated payslip.${p.paid_at ? "" : " Payment not yet recorded."}</div>
    <div class="sig">Authorised signature</div>
  </div>
</div>
<script src="/js/print.js"></script>
</body></html>`);
}));

/* ------------------------- salary advances ------------------------------- */

router.get("/advances", ADMIN, requireStaffPermission("payroll.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const where = ["a.madrasa_id = ?"]; const params = [tid];
  if (req.query.userId) { where.push("a.user_id = ?"); params.push(toNum(req.query.userId, 0)); }
  if (req.query.status === "active") { where.push("a.balance > 0"); }
  if (req.query.status === "settled") { where.push("a.balance <= 0"); }
  const rows = await db.all(
    `SELECT a.*, u.full_name, u.full_name_ar, u.username
       FROM salary_advances a
       JOIN users u ON u.id = a.user_id AND u.madrasa_id = a.madrasa_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.created_at DESC, a.id DESC`,
    params
  );
  ok(res, {
    advances: rows.map((row) => Object.assign({}, row, {
      monthly_instalment: round2(n(row.amount) / Math.max(1, Math.trunc(n(row.repayment_months)))),
      repaid: round2(n(row.amount) - n(row.balance)),
    })),
    summary: {
      count: rows.length,
      outstanding: round2(rows.reduce((a, r) => a + Math.max(0, n(r.balance)), 0)),
      issued: round2(rows.reduce((a, r) => a + n(r.amount), 0)),
    },
  });
}));

router.post("/advances", ADMIN, requireStaffPermission("payroll.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const teacher = await teacherInTenant(tid, b.user_id ?? b.userId);
  if (!teacher) return err(res, 400, "Select a teacher who belongs to this institution.");
  const amount = round2(clampNum(b.amount ?? b.amount_ngn, 0, 999999999, 0));
  if (amount <= 0) return err(res, 400, "Advance amount must be greater than zero.");
  const months = Math.trunc(toNum(b.repayment_months ?? b.months, 0));
  if (!(months >= 1 && months <= 60)) return err(res, 400, "Repayment months must be between 1 and 60.");
  const r = await db.run(
    "INSERT INTO salary_advances (madrasa_id,user_id,amount,reason,repayment_months,balance,created_by,updated_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)",
    [tid, teacher.id, amount, cleanStr(b.reason, 255), months, amount, req.user.id]
  );
  const id = Number(r.lastInsertRowid);
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.advance.create", entity: "salary_advance", entityId: String(id), meta: { teacher: teacher.id, amount, months }, ip: req.ip });
  ok(res, { ok: true, id });
}));

/** POST /advances/:id/repay — record a repayment received outside payroll. */
router.post("/advances/:id/repay", ADMIN, requireStaffPermission("payroll.process"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const advance = await db.get("SELECT * FROM salary_advances WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!advance) return res.status(404).json({ error: "Salary advance not found." });
  const amount = round2(clampNum((req.body || {}).amount, 0, 999999999, 0));
  if (amount <= 0) return err(res, 400, "Repayment amount must be greater than zero.");
  if (n(advance.balance) <= 0) return err(res, 400, "This advance is already fully repaid.");
  const applied = round2(Math.min(amount, n(advance.balance)));
  await db.run("UPDATE salary_advances SET balance = CASE WHEN balance - ? < 0 THEN 0 ELSE balance - ? END, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [applied, applied, advance.id, tid]);
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.advance.repay", entity: "salary_advance", entityId: String(advance.id), meta: { applied }, ip: req.ip });
  ok(res, { ok: true, applied, balance: round2(n(advance.balance) - applied) });
}));

router.delete("/advances/:id", ADMIN, requireStaffPermission("payroll.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const advance = await db.get("SELECT * FROM salary_advances WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!advance) return res.status(404).json({ error: "Salary advance not found." });
  if (round2(n(advance.balance)) !== round2(n(advance.amount))) {
    return err(res, 400, "This advance already has repayments deducted and cannot be deleted.");
  }
  await db.run("DELETE FROM salary_advances WHERE id=? AND madrasa_id=?", [advance.id, tid]);
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.advance.delete", entity: "salary_advance", entityId: String(advance.id), ip: req.ip });
  ok(res, { ok: true });
}));

/* ------------------------------ CSV export ------------------------------- */

/** GET /periods/:id/export.csv — one row per payslip in the period. */
router.get("/periods/:id/export.csv", ADMIN, requireStaffPermission("payroll.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const period = await loadPeriod(tid, req.params.id);
  if (!period) return res.status(404).json({ error: "Pay period not found." });
  const rows = await db.all(
    `SELECT ps.*, u.full_name, u.username
       FROM pay_slips ps
       JOIN users u ON u.id = ps.user_id AND u.madrasa_id = ps.madrasa_id
      WHERE ps.madrasa_id = ? AND ps.pay_period_id = ?
      ORDER BY u.full_name`,
    [tid, period.id]
  );
  const ded = (row) => parseJson(row.deductions);
  const adv = (row) => round2((ded(row).advances || []).reduce((a, x) => a + n(x.amount), 0));
  csv.sendCsv(res, `payroll-${period.year}-${String(period.month).padStart(2, "0")}.csv`, csv.toCsv(rows, [
    { label: "Staff Member", key: "full_name" },
    { label: "Username", key: "username" },
    { label: "Pay Period", value: () => periodLabel(period.month, period.year) },
    { label: "Session", value: () => period.session_label || "" },
    { label: "Gross (₦)", value: (r) => csv.num(r.gross, 2) },
    { label: "Tax (₦)", value: (r) => csv.num(ded(r).tax, 2) },
    { label: "Pension (₦)", value: (r) => csv.num(ded(r).pension, 2) },
    { label: "Other Deduction (₦)", value: (r) => csv.num(ded(r).other, 2) },
    { label: "Advance Repayment (₦)", value: (r) => csv.num(adv(r), 2) },
    { label: "Total Deductions (₦)", value: (r) => csv.num(ded(r).total, 2) },
    { label: "Net Pay (₦)", value: (r) => csv.num(r.net, 2) },
    { label: "Paid", value: (r) => (r.paid_at ? "Yes" : "No") },
    { label: "Paid At", value: (r) => (r.paid_at ? String(r.paid_at).slice(0, 10) : "") },
  ]));
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "payroll.export", entity: "pay_period", entityId: String(period.id), meta: { rows: rows.length }, ip: req.ip });
}));

module.exports = router;
