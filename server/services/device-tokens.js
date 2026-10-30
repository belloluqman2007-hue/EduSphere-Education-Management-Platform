"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — native app & offline device bearer tokens
   ----------------------------------------------------------------------------
   Web browsers continue to use httpOnly DB-backed session cookies + CSRF.
   Native desktop (Electron) and mobile/tablet (Capacitor Android/iOS) shells
   run from embedded origins (capacitor://localhost, app://edusphere, etc.) and
   must stay signed in across multi-day offline stretches without relying on
   ephemeral WebView cookie jars.

   Security properties:
     • Raw tokens ("eds_" + 64 hex chars = 256 bits of entropy) are returned
       ONCE at login and NEVER stored in plaintext in the database — only the
       SHA-256 hash lives in `device_auth_tokens`.
     • Every authenticated request re-reads `users.is_active` and (for tenant
       accounts) `madaris.status = 'active'`, so deactivating a user or
       suspending an institution takes effect immediately.
     • Tokens are revoked on logout, password change, password reset, or via
       `DELETE /api/auth/devices/:id` if a phone/tablet is lost.
   ========================================================================== */
const crypto = require("crypto");
const db = require("../db");
const config = require("../config");
const { cleanStr } = require("../util");

const TOKEN_PREFIX = "eds_";
const TOUCH_GRACE_MS = 60000;
const ALLOWED_PLATFORMS = new Set(["web", "desktop", "electron", "windows", "macos", "linux", "android", "ios", "ipad", "tablet", "mobile", "native"]);

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken || "")).digest("hex");
}

function normalizePlatform(raw) {
  const s = cleanStr(raw, 40).toLowerCase();
  return ALLOWED_PLATFORMS.has(s) ? s : "native";
}

/**
 * Inspects the Authorization header.
 * Returns { present: false, token: null } when no Bearer header was sent, or
 * { present: true, token: "<string>" } when `Authorization: Bearer ...` is set.
 */
function extractBearerToken(req) {
  const header = String((req && req.get && req.get("authorization")) || "").trim();
  if (!header) return { present: false, token: null };
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return { present: true, token: "" };
  return { present: true, token: match[1].trim() };
}

/**
 * Mints a new device token for `userId`. If `deviceId` is provided, any prior
 * active token for the same `(userId, deviceId)` is rotated (revoked) first so
 * repeated sign-ins on the same device never pile up.
 */
async function issueToken(opts = {}) {
  const userId = Number(opts.userId);
  if (!userId || !Number.isFinite(userId)) throw new Error("userId is required to issue a device token.");
  const madrasaId = opts.madrasaId ? Number(opts.madrasaId) : null;
  const deviceId = cleanStr(opts.deviceId, 120);
  const deviceName = cleanStr(opts.deviceName, 160);
  const platform = normalizePlatform(opts.platform);
  const ip = cleanStr(opts.ip, 64);
  const now = Date.now();
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : config.DEVICE_TOKEN_MAX_AGE_MS;
  const expiresAt = now + ttlMs;

  if (deviceId) {
    await db.run(
      "UPDATE device_auth_tokens SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL",
      [now, userId, deviceId]
    );
  }

  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const ins = await db.run(
    `INSERT INTO device_auth_tokens
       (madrasa_id, user_id, token_hash, device_id, device_name, platform, last_used_at, expires_at, revoked_at, created_ip)
     VALUES (?,?,?,?,?,?,?,?,NULL,?)`,
    [madrasaId, userId, tokenHash, deviceId, deviceName, platform, now, expiresAt, ip]
  );

  return {
    tokenId: Number(ins.lastInsertRowid),
    token,
    expiresAtMs: expiresAt,
    expiresAt: new Date(expiresAt).toISOString(),
    platform,
    deviceId,
    deviceName,
  };
}

/**
 * Validates a raw Bearer token, checks user & tenant liveness, and performs
 * throttled rolling expiry touch. Returns `{ user, tokenRow }` or `null`.
 */
async function verifyBearerToken(rawToken) {
  const raw = String(rawToken || "").trim();
  if (!raw.startsWith(TOKEN_PREFIX) || raw.length < 40 || raw.length > 200) return null;

  const now = Date.now();
  const row = await db.get("SELECT * FROM device_auth_tokens WHERE token_hash = ?", [hashToken(raw)]);
  if (!row) return null;
  if (row.revoked_at !== null && row.revoked_at !== undefined) return null;
  if (!Number.isFinite(Number(row.expires_at)) || Number(row.expires_at) <= now) return null;

  const u = await db.get(
    "SELECT id, madrasa_id, username, role, full_name, full_name_ar, student_id, is_active FROM users WHERE id = ?",
    [row.user_id]
  );
  if (!u || Number(u.is_active) !== 1) return null;

  if (u.madrasa_id) {
    const madrasa = await db.get("SELECT id, status FROM madaris WHERE id = ?", [u.madrasa_id]);
    if (!madrasa || madrasa.status !== "active") return null;
  }

  // Rolling touch at most once per minute so burst API / sync requests do not
  // turn every read into a database write.
  if (now - Number(row.last_used_at || 0) >= TOUCH_GRACE_MS) {
    const nextExpiry = Math.max(Number(row.expires_at), now + config.DEVICE_TOKEN_MAX_AGE_MS);
    db.run(
      "UPDATE device_auth_tokens SET last_used_at = ?, expires_at = ? WHERE id = ?",
      [now, nextExpiry, row.id]
    ).catch(() => { /* non-fatal */ });
  }

  return {
    tokenRow: row,
    user: {
      id: u.id,
      madrasaId: u.madrasa_id,
      username: u.username,
      role: u.role,
      fullName: u.full_name,
      fullNameAr: u.full_name_ar,
      studentId: u.student_id ? Number(u.student_id) : null,
    },
  };
}

async function revokeTokenById(tokenId, userId) {
  const id = Number(tokenId);
  const uid = Number(userId);
  if (!id || !uid) return 0;
  const r = await db.run(
    "UPDATE device_auth_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    [Date.now(), id, uid]
  );
  return Number(r.changes || 0);
}

async function revokeRawToken(rawToken) {
  const raw = String(rawToken || "").trim();
  if (!raw.startsWith(TOKEN_PREFIX)) return 0;
  const r = await db.run(
    "UPDATE device_auth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
    [Date.now(), hashToken(raw)]
  );
  return Number(r.changes || 0);
}

/**
 * Revokes all active device tokens of `userId` (used on password change/reset).
 * Pass `exceptTokenId` to keep the caller's own device signed in.
 */
async function revokeUserTokens(userId, exceptTokenId = null) {
  const uid = Number(userId);
  if (!uid || !Number.isFinite(uid)) return 0;
  const now = Date.now();
  if (exceptTokenId) {
    const r = await db.run(
      "UPDATE device_auth_tokens SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL",
      [now, uid, Number(exceptTokenId)]
    );
    return Number(r.changes || 0);
  }
  const r = await db.run(
    "UPDATE device_auth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    [now, uid]
  );
  return Number(r.changes || 0);
}

async function listUserDevices(userId, currentTokenId = null) {
  const uid = Number(userId);
  if (!uid) return [];
  const now = Date.now();
  const rows = await db.all(
    `SELECT id, device_id, device_name, platform, last_used_at, expires_at, created_ip, created_at
       FROM device_auth_tokens
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_used_at DESC, id DESC LIMIT 50`,
    [uid, now]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    deviceId: r.device_id || "",
    deviceName: r.device_name || "",
    platform: r.platform || "native",
    lastUsedAt: r.last_used_at ? new Date(Number(r.last_used_at)).toISOString() : null,
    expiresAt: r.expires_at ? new Date(Number(r.expires_at)).toISOString() : null,
    createdIp: r.created_ip || "",
    createdAt: r.created_at,
    current: currentTokenId ? Number(r.id) === Number(currentTokenId) : false,
  }));
}

/** Deletes expired tokens and tokens revoked more than 7 days ago. */
async function pruneExpiredTokens() {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const r = await db.run(
    "DELETE FROM device_auth_tokens WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)",
    [now, sevenDaysAgo]
  );
  return { changes: Number((r && r.changes) || 0) };
}

module.exports = {
  TOKEN_PREFIX,
  hashToken,
  extractBearerToken,
  issueToken,
  verifyBearerToken,
  revokeTokenById,
  revokeRawToken,
  revokeUserTokens,
  listUserDevices,
  pruneExpiredTokens,
};
