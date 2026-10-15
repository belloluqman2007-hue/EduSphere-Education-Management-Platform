"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — shared utilities
   ========================================================================== */
const fs = require("fs");

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

/* ------------------------- crash-safe boot logging -------------------------
   console.error() buffers its output; process.exit() can drop whatever a pipe
   (a host's log collector, Render's included) has not drained yet. That is
   exactly what made a failing deploy log look like this on Render:

     Storage: warn — data=… (mount /)
     ⚠ [EPHEMERAL_UPLOADS] …
     ==> Exited with status 1          ← the actual error line was LOST

   fs.writeSync(2, …) bypasses console's buffering, and fatalExit() waits a
   moment (Atomics.wait sleeps without timers, so nothing keeps the loop alive)
   before exiting, giving the collector time to drain the pipe. A boot that is
   going to fail must at least SAY why on the way out. */
function writeFatal(lines) {
  const text = (Array.isArray(lines) ? lines : [lines]).join("\n") + "\n";
  try {
    fs.writeSync(2, text);
  } catch (e) {
    // fd 2 unavailable (should not happen) — fall back to console.
    console.error(text.trimEnd());
  }
}

function sleepAtomic(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) { /* no Atomics.wait on this platform — best effort */ }
}

/** Print lines to stderr crash-safely, then exit. */
function fatalExit(lines, code = 1) {
  writeFatal(lines);
  sleepAtomic(250);
  process.exit(code);
}

/* --------------------- database reachability failures ----------------------
   A boot that cannot reach its database must exit (it must never fall back to
   a fresh, empty database — that is how tenants "disappear"). But the raw
   mysql2 error (connect ETIMEDOUT) does not tell the operator what to DO.
   These helpers turn the common failure codes into the specific fix. */
const DB_CONNECT_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", // DNS
  "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE", // TCP
  "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", // MySQL
  "HANDSHAKE_NO_SSL_SUPPORT", "SECURE_AUTHENTICATION", "AUTH_SWITCH_PLUGIN_ERROR", // TLS/auth
]);

function isDbConnectError(err) {
  if (!err) return false;
  if (DB_CONNECT_CODES.has(err.code)) return true;
  return /getaddrinfo|connect etimedout|connection refused|connection lost|access denied|handshake|ssl|tls/i.test(String(err.message || ""));
}

function dbConnectFailureHints(err) {
  const code = (err && err.code) || "";
  const msg = String((err && err.message) || "");
  let what;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /getaddrinfo/i.test(msg)) {
    what = "the database hostname could not be resolved (DNS). The host does not exist, was renamed, or this network has no DNS for it.";
  } else if (code === "ECONNREFUSED" || /connection refused/i.test(msg)) {
    what = "nothing is listening at that host:port. Check the port in DATABASE_URL and that the database server is actually running.";
  } else if (code === "ER_ACCESS_DENIED_ERROR" || /access denied/i.test(msg)) {
    what = "the database rejected the credentials. Check the user and password inside DATABASE_URL.";
  } else if (code === "ER_BAD_DB_ERROR" || /unknown database/i.test(msg)) {
    what = "MySQL accepted the connection but that database name does not exist. Create it first (docs/DATABASE.md).";
  } else if (code === "HANDSHAKE_NO_SSL_SUPPORT" || /ssl|tls|handshake/i.test(msg)) {
    what = "the TLS handshake failed. If the server encrypts, set DB_SSL=true; if it does not, remove ssl-mode from DATABASE_URL and keep DB_SSL unset.";
  } else {
    what = "the TCP connection timed out. From this network the database is UNREACHABLE.";
  }
  return [
    "",
    "This boot failed because " + what,
    "",
    "Why this matters: the server refuses to boot without its database — falling back to an",
    "empty one is how saved data appears to vanish. Fix the connection and deploy again.",
    "Checklist (Render): Environment → DATABASE_URL / DB_* —",
    "  1. Is the database RUNNING? (Aiven/PlanetScale/RDS free tiers pause or expire — reopen its dashboard.)",
    "  2. Host and port typed correctly, and the hostname is public (not an internal-only name).",
    "  3. Firewall / VPC service allows connections from Render's egress IPs.",
    "  4. TLS matches the server: DB_SSL=true only when the server requires it.",
    "  5. The database itself exists (MySQL has no 'create on first connect').",
    "Full docs: docs/DEPLOYMENT.md → 'The deploy exits with status 1'.",
  ];
}

/** mysql://user:secret@host:3306/db → mysql://user:••••@host:3306/db (safe for logs). */
function maskDbUrl(url) {
  try {
    const u = new URL(String(url));
    // Built by hand rather than u.toString(): URL percent-encodes a password
    // it re-encodes, and a log full of %E2%80%A2 is unreadable.
    const auth = u.username + (u.password ? ":••••" : "") + (u.username || u.password ? "@" : "");
    return u.protocol + "//" + auth + u.host + u.pathname + u.search + u.hash;
  } catch (e) {
    return String(url).replace(/:\/\/([^:/@]+):[^:@/]*@/, "://$1:••••@");
  }
}

/**
 * Probe the database with a bounded retry so a database that is still waking
 * up (a paused free-tier instance, a cold start) does not fail the whole
 * deploy on the first attempt. Only REACHABILITY failures retry; a migration
 * error is never retried here. attempts=1 means "try once" (no retries).
 */
async function connectWithRetries(dbApi, { attempts = 3, delayMs = 5000, log = () => {} } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await dbApi.dialect(); // forces connect() + the SELECT 1 probe
      return;
    } catch (err) {
      if (attempt >= attempts || !isDbConnectError(err)) throw err;
      log(`Database not reachable (attempt ${attempt}/${attempts}): ${err.code || err.message} — retrying in ${Math.round(delayMs / 1000)}s…`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
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
  writeFatal,
  fatalExit,
  isDbConnectError,
  dbConnectFailureHints,
  maskDbUrl,
  connectWithRetries,
};
