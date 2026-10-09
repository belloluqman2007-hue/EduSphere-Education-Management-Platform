"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — rate limiting
   ----------------------------------------------------------------------------
   • global API limiter (per IP)
   • stricter login limiter (per IP) — anti brute-force
   Both limits come from environment variables.
   ========================================================================== */
const rateLimit = require("express-rate-limit");
const config = require("../config");

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.API_RATE_LIMIT,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.LOGIN_RATE_LIMIT,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Per IP+username: stops account brute-forcing without starving one IP
  // that legitimately hosts many users (e.g. a madrasa office).
  keyGenerator: (req) => {
    let username = "";
    try {
      const b = req.body;
      if (b && typeof b.username === "string") username = b.username.toLowerCase().slice(0, 100);
    } catch (e) { /* no body */ }
    return (req.ip || "unknown") + ":" + (username || "?");
  },
  message: { error: "Too many login attempts. Please wait and try again." },
});

/* Password-reset requests: unauthenticated surface, so it gets its own
   strict per-IP bucket. The response is always generic (no account
   enumeration), but the token table must still not be spammable. */
const resetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.PASSWORD_RESET_RATE_LIMIT,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many password reset requests. Please wait and try again." },
});

/* ---------------------------------------------------------------------------
   PUBLIC (logged-out) endpoints.
   These are reachable without an account, so they get their own limits: the
   directory is cheap to read, while result verification and admission
   submissions are rate limited hard enough that guessing an admission number
   plus surname is not practical.
--------------------------------------------------------------------------- */
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PUBLIC_RATE_LIMIT || 600),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

const publicWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.PUBLIC_APPLY_LIMIT || 8),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many submissions from this connection. Please try again later." },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PUBLIC_VERIFY_LIMIT || 12),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    let slug = "";
    try { slug = String((req.body && req.body.madrasaSlug) || "").toLowerCase().slice(0, 80); } catch (e) { /* no body */ }
    return (req.ip || "unknown") + ":" + (slug || "?");
  },
  message: { error: "Too many verification attempts. Please wait a few minutes and try again." },
});

/**
 * Card / certificate QR verification. Stricter than the general public bucket
 * (it is the one an unauthenticated stranger can hit repeatedly) but looser
 * than the result checker: a school gate or registry desk legitimately scans
 * dozens of cards in a row from one connection, and a scanner that starts
 * answering 429 halfway through a fresh-card printing morning is worse than
 * the theoretical enumeration it prevents — the code is 12 random bytes.
 */
const scanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.CARD_SCAN_LIMIT || 120),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many verification attempts from this connection. Please wait a few minutes." },
});

module.exports = { apiLimiter, loginLimiter, resetRequestLimiter, publicLimiter, publicWriteLimiter, verifyLimiter, scanLimiter };
