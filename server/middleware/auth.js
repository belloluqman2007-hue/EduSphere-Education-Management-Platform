"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — authentication & role middleware
   ----------------------------------------------------------------------------
   Roles:
     super_admin    — platform operator (madrasa_id = NULL)
     madrasa_admin  — manages ONE madrasa
     teacher        — assigned classes/subjects within one madrasa
     student        — own records only
     parent         — linked children only

   Sessions are MySQL/SQLite-backed (app_sessions) and hold ONLY a user id.
   The authoritative record (role, madrasa_id, is_active) is re-read from the
   database on every request, so deactivating a user takes effect immediately
   and a stolen-but-valid cookie can't outlive an account being disabled.
   ========================================================================== */
const db = require("../db");
const deviceTokens = require("../services/device-tokens");

/**
 * Loads the current user from either:
 *   1. an explicit `Authorization: Bearer eds_...` device token (native PC,
 *      phone & tablet apps), or
 *   2. the DB-backed session cookie (web browser).
 * Attaches a fresh DB record to `req.user`. When a Bearer header is sent,
 * authentication never falls back to a session cookie, preventing a bogus
 * Authorization header from bypassing cookie CSRF checks.
 */
async function loadUser(req, res, next) {
  req.user = null;
  req.authMethod = null;
  req.deviceTokenId = null;

  const bearer = deviceTokens.extractBearerToken(req);
  if (bearer.present) {
    try {
      const verified = await deviceTokens.verifyBearerToken(bearer.token);
      if (verified) {
        req.user = verified.user;
        req.authMethod = "bearer";
        req.deviceTokenId = Number(verified.tokenRow.id);
      } else {
        req.authMethod = "bearer_invalid";
      }
    } catch (e) {
      req.authMethod = "bearer_invalid";
    }
    return next();
  }

  const uid = req.session && req.session.userId;
  if (uid) {
    try {
      const u = await db.get(
        "SELECT id, madrasa_id, username, role, full_name, full_name_ar, student_id, is_active FROM users WHERE id = ?",
        [uid]
      );
      if (u && u.is_active === 1) {
        req.user = {
          id: u.id,
          madrasaId: u.madrasa_id,
          username: u.username,
          role: u.role,
          fullName: u.full_name,
          fullNameAr: u.full_name_ar,
          studentId: u.student_id ? Number(u.student_id) : null,
        };
        req.authMethod = "session";
      } else {
        // Account removed or deactivated — clear the stale session.
        req.session.userId = null;
      }
    } catch (e) {
      /* DB hiccup: treat as unauthenticated rather than crash */
    }
  }
  next();
}

/** Requires any authenticated user. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  next();
}

/** Requires one of the given roles. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required." });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission to perform this action." });
    }
    next();
  };
}

/** Requires a tenant (madrasa) context: user must belong to a madrasa. */
function requireTenant(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (req.user.role === "super_admin") return next();
  if (!req.user.madrasaId) {
    return res.status(403).json({ error: "No madrasa is associated with your account." });
  }
  next();
}

/** Super admin only. */
const requireSuperAdmin = requireRole("super_admin");

module.exports = { loadUser, requireAuth, requireRole, requireTenant, requireSuperAdmin };
