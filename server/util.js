"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — shared utilities
   ========================================================================== */

/** Wraps async route handlers so rejections hit the error middleware. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** JSON error helper. 404 (not 403) is used for tenant isolation so resource
    existence is not leaked across tenants. */
function err(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

function ok(res, data = {}) {
  return res.json(data);
}

/* ------------------------------ validation ------------------------------- */

function cleanStr(v, max = 255) {
  return String(v === null || v === undefined ? "" : v).trim().slice(0, max);
}

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === "";
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampNum(v, min, max, fallback) {
  const n = toNum(v, fallback);
  return Math.min(max, Math.max(min, n));
}

function validDate(v) {
  const s = cleanStr(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function validPhone(v) {
  const s = cleanStr(v, 20);
  return s === "" || /^[+\d][\d\s-]{5,19}$/.test(s);
}

function validEmail(v) {
  const s = cleanStr(v, 120);
  return s === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/* ------------------------------ activity log ----------------------------- */

async function logActivity(db, { madrasaId = null, userId = null, action, entity = "", entityId = "", meta = null, ip = "" }) {
  try {
    await db.run(
      "INSERT INTO activity_log (madrasa_id, user_id, action, entity, entity_id, meta, ip) VALUES (?,?,?,?,?,?,?)",
      [madrasaId, userId, action, entity, entityId, meta ? JSON.stringify(meta) : null, ip]
    );
  } catch (e) {
    // Logging must never break the request.
  }
}

/* --------------------------- plan limit checks --------------------------- */

/**
 * The single gate every "create" route in the platform already calls
 * (students, teachers, admissions). It answers two different questions:
 *
 *   1. Is this institution's subscription still valid?  (expired / suspended)
 *   2. Has it used up the allowance its plan pays for?  (student/teacher limit)
 *
 * The subscription dates are read fresh on every call rather than trusting a
 * stored status column, because a subscription expires at midnight — not when
 * somebody next remembers to update a row.
 *
 * @returns {{allowed:boolean, reason?:string, limit?:number, count?:number,
 *            plan?:string, message?:string}}
 *          `reason` is "ok" | "limit" | "expired" | "suspended".
 */
async function checkPlanLimits(db, madrasaId, kind) {
  let row = null;
  try {
    row = await db.get(
      `SELECT p.student_limit, p.teacher_limit, p.code AS plan_code, p.name AS plan_name,
              m.subscription_status, m.plan_expires_at, m.grace_ends_at,
              (SELECT COUNT(*) FROM students WHERE madrasa_id = m.id AND status IN ('active','promoted','suspended')) AS students,
              (SELECT COUNT(*) FROM users u WHERE u.madrasa_id = m.id AND u.role = 'teacher' AND u.is_active = 1) AS teachers
         FROM madaris m LEFT JOIN plans p ON p.id = m.plan_id WHERE m.id = ?`,
      [madrasaId]
    );
  } catch (e) {
    // Pre-042 database (no subscription columns yet): fall back to the
    // original, purely limit-based check rather than failing every create.
    row = await db.get(
      `SELECT p.student_limit, p.teacher_limit, p.code AS plan_code, p.name AS plan_name,
              NULL AS subscription_status, NULL AS plan_expires_at, NULL AS grace_ends_at,
              (SELECT COUNT(*) FROM students WHERE madrasa_id = m.id AND status IN ('active','promoted','suspended')) AS students,
              (SELECT COUNT(*) FROM users u WHERE u.madrasa_id = m.id AND u.role = 'teacher' AND u.is_active = 1) AS teachers
         FROM madaris m LEFT JOIN plans p ON p.id = m.plan_id WHERE m.id = ?`,
      [madrasaId]
    );
  }
  if (!row) return { allowed: true, reason: "ok" };

  const limit = kind === "student" ? Number(row.student_limit) : Number(row.teacher_limit);
  const count = kind === "student" ? Number(row.students) : Number(row.teachers);
  const planName = row.plan_name || row.plan_code;

  /* 1. Suspension always wins — it is a deliberate operator action. */
  if (String(row.subscription_status || "active") === "suspended") {
    return {
      allowed: false, reason: "suspended", limit, count, plan: row.plan_code,
      message: "This institution's subscription is suspended. Please settle the outstanding subscription to continue adding records.",
    };
  }

  /* 2. Expiry: a lapsed subscription stops NEW records once the grace period
        has run out. Existing data stays readable — this never deletes. */
  const expires = row.plan_expires_at ? String(row.plan_expires_at).slice(0, 10) : null;
  if (expires) {
    const today = new Date().toISOString().slice(0, 10);
    if (today > expires) {
      const graceEnd = row.grace_ends_at ? String(row.grace_ends_at).slice(0, 10) : null;
      if (!graceEnd || today > graceEnd) {
        return {
          allowed: false, reason: "expired", limit, count, plan: row.plan_code,
          message: "Your subscription has expired. Renew it from Subscription → Plans to continue adding records.",
        };
      }
    }
  }

  /* 3. The allowance itself. */
  if (limit < 0) return { allowed: true, reason: "ok", limit, count }; // unlimited
  return {
    allowed: count < limit,
    reason: count < limit ? "ok" : "limit",
    limit,
    count,
    plan: row.plan_code,
    message: `Plan limit reached: your ${planName} plan allows ${limit} ${kind}(s) (currently ${count}). Upgrade from Subscription → Plans to add more.`,
  };
}

module.exports = {
  asyncHandler,
  err,
  ok,
  cleanStr,
  isBlank,
  toNum,
  clampNum,
  validDate,
  validPhone,
  validEmail,
  logActivity,
  checkPlanLimits,
};
