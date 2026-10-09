"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — authentication routes
   ----------------------------------------------------------------------------
   • POST /api/auth/login           (rate-limited, constant-time-ish error)
   • POST /api/auth/logout
   • GET  /api/auth/me
   • POST /api/auth/change-password
   • POST /api/auth/forgot-password (rate-limited, no account enumeration)
   • POST /api/auth/reset-password  (single-use, expiring tokens)
   • GET  /api/auth/reset-requests  (admin-mediated link delivery)
   • GET  /api/csrf-token           (double-submit CSRF token)
   ========================================================================== */
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../db");
const config = require("../config");
const { cleanStr, logActivity, asyncHandler } = require("../util");
const permissionService = require("../services/permissions");
const profileMedia = require("../services/profile-media");
const { imageUploader } = require("../middleware/upload");

const router = express.Router();

/* ------------------------------ CSRF ----------------------------------- */

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

router.get("/csrf-token", (req, res) => {
  res.json({ csrfToken: ensureCsrfToken(req) });
});

/**
 * CSRF guard: every state-changing API call must present the session token
 * in the X-CSRF-Token header. Login is exempt (pre-auth), as is token fetch.
 */
function csrfGuard(req, res, next) {
  if (!["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) return next();
  const path = req.path;
  // Pre-auth endpoints: login (credentials), forgot/reset password (the
  // reset token itself is the bearer secret), and the payment webhook
  // (provider-HMAC-authenticated instead).
  if (path.startsWith("/auth/login") || path.startsWith("/auth/forgot-password") ||
      path.startsWith("/auth/reset-password") || path.startsWith("/csrf-token") ||
      path.endsWith("/fees/payment/webhook")) return next();
  const token = String(req.get("x-csrf-token") || "");
  if (!token || token !== (req.session && req.session.csrfToken)) {
    return res.status(403).json({ error: "CSRF token missing or invalid. Refresh the page and try again." });
  }
  next();
}

/* ------------------------- session-store errors ------------------------- */

/**
 * Turns a session-store failure into a message that says what to DO.
 * "Session save error." on its own told the administrator nothing: the
 * password was right, the account was right, and the only broken thing was
 * the write into app_sessions (historically MySQL rejecting a millisecond
 * epoch in a 4-byte INT column — see migration 014_session_expiry_bigint).
 */
function sessionStoreMessage(err) {
  const code = String((err && err.code) || "");
  const text = String((err && err.message) || "");
  if (code === "ER_WARN_DATA_OUT_OF_RANGE" || /out of range/i.test(text)) {
    return "Sign-in could not be completed: the session table is out of date. " +
      "Run \"npm run migrate\" on the server, then try again.";
  }
  if (code === "ER_NO_SUCH_TABLE" || /no such table|doesn't exist/i.test(text)) {
    return "Sign-in could not be completed: the session table is missing. " +
      "Run \"npm run migrate\" on the server, then try again.";
  }
  return "Sign-in could not be completed because the session could not be saved. " +
    "Please try again — if it keeps happening, the server log has the details.";
}

/* --------------------- session invalidation helper --------------------- */

/**
 * Removes every stored session that belongs to the given user. Used after a
 * password change/reset so an old (possibly stolen) session can no longer
 * act as the account. `exceptSid` keeps the caller's own live session alive
 * (the signed-in user changing their password should not log themselves out).
 *
 * Session rows are owned by express-session's JSON blob, so the user id is
 * matched by parsing the blob — the table is small (one row per live
 * session) and this runs only on password events, not per request.
 */
async function destroyUserSessions(userId, exceptSid) {
  const id = Number(userId);
  if (!id || !Number.isFinite(id)) return 0;
  const rows = await db.all("SELECT sid, data FROM app_sessions");
  let removed = 0;
  for (const row of rows) {
    if (exceptSid && row.sid === exceptSid) continue;
    let data = null;
    try { data = JSON.parse(row.data || "{}"); } catch (e) { continue; }
    if (data && Number(data.userId) === id) {
      await db.run("DELETE FROM app_sessions WHERE sid = ?", [row.sid]);
      removed += 1;
    }
  }
  return removed;
}

/* ------------------------------ login ---------------------------------- */

router.post("/login", async (req, res) => {
  const username = cleanStr(req.body && req.body.username, 100).toLowerCase();
  const password = String((req.body && req.body.password) || "");
  const remember = Boolean(req.body && req.body.remember);
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const user = await db.get("SELECT * FROM users WHERE username = ?", [username]);
  // Compare against a dummy hash when user is missing to keep timing even.
  const dummyHash = "$2a$10$C6UzMDM.H6dfI/f/IKcEeO7ZBpI7eC2FVWQvXxZK9yJ5r3KbLmNnS";
  const hash = user ? user.password_hash : dummyHash;
  let match = false;
  try { match = await bcrypt.compare(password, hash); } catch (e) { match = false; }
  if (!user || !match) {
    // A database with NO accounts at all is not a wrong password — it is an
    // un-provisioned platform, and "Invalid username or password" sends the
    // operator hunting for a typo that does not exist. This leaks nothing:
    // it can only ever fire when there is no one to enumerate.
    const any = await db.get("SELECT COUNT(*) AS n FROM users");
    if (any && Number(any.n) === 0) {
      return res.status(503).json({
        error: "This platform has no accounts yet, so no sign-in can succeed. " +
          "The administrator must create the super admin (set SUPER_ADMIN_PASSWORD, " +
          "then run \"npm run reset-admin-password\") before anyone can log in.",
        code: "NO_ACCOUNTS",
      });
    }
    return res.status(401).json({ error: "Invalid username or password." });
  }
  if (Number(user.is_active) !== 1) {
    return res.status(403).json({ error: "This account has been deactivated. Contact your administrator." });
  }

  // Madrasa-scoped users must belong to an ACTIVE madrasa.
  if (user.madrasa_id) {
    const madrasa = await db.get("SELECT id, status FROM madaris WHERE id = ?", [user.madrasa_id]);
    if (!madrasa || madrasa.status !== "active") {
      return res.status(403).json({ error: "Your madrasa account is not active. Contact the platform administrator." });
    }
  }

  // Madrasa-scoped users also carry their institution's category (islamic /
  // western) so the SPA can route straight to the right admin dashboard
  // without a second round trip.
  let category = null;
  let institutionName = null;
  if (user.madrasa_id) {
    const madrasa = await db.get("SELECT category, name_en, verified FROM madaris WHERE id = ?", [user.madrasa_id]);
    if (madrasa) { category = madrasa.category || "islamic"; institutionName = madrasa.name_en; }
  }

  req.session.regenerate((err) => {
    if (err) {
      console.error("Login failed while creating the session:", err);
      return res.status(500).json({ error: sessionStoreMessage(err), code: "SESSION_ERROR" });
    }
    req.session.userId = user.id;
    // "Remember me" lengthens the session cookie (default 30 days instead of
    // the 12-hour inactivity session). The role/tenant are unaffected — a
    // longer cookie never grants anything beyond the same account.
    if (remember) req.session.cookie.maxAge = config.SESSION_REMEMBER_MAX_AGE_MS;
    ensureCsrfToken(req);
    // Audit the sign-in. The password is of course never recorded — only who
    // signed in, in which role and institution, and from where.
    db.run(
      `INSERT INTO activity_log (madrasa_id, user_id, user_role, action, module, entity, entity_id, ip)
       VALUES (?,?,?,?,?,?,?,?)`,
      [user.madrasa_id, user.id, user.role, "login", "auth", "auth", String(user.id), String(req.ip || "").slice(0, 64)]
    ).catch(() => {
      // Fall back to the original shape if the audit columns are not yet
      // migrated; logging must never block a valid sign-in.
      logActivity(db, { madrasaId: user.madrasa_id, userId: user.id, action: "login", entity: "auth", entityId: String(user.id), ip: req.ip || "" });
    });
    req.session.save((saveErr) => {
      if (saveErr) {
        // The credentials WERE correct — only writing the session row failed.
        // Log the real driver error so the cause is visible in the server log
        // instead of the user staring at a bare "Session save error.".
        console.error("Login failed while saving the session:", saveErr);
        return res.status(500).json({ error: sessionStoreMessage(saveErr), code: "SESSION_SAVE_ERROR" });
      }
      res.json({
        ok: true,
        role: user.role,
        madrasaId: user.madrasa_id,
        category,
        institutionName,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          fullName: user.full_name,
          fullNameAr: user.full_name_ar,
        },
      });
    });
  });
});

router.post("/logout", (req, res) => {
  const uid = req.session && req.session.userId;
  const mid = req.user ? req.user.madrasaId : null;
  const role = req.user ? req.user.role : "";
  req.session.destroy(() => {
    res.clearCookie("mm_session");
    db.run(
      `INSERT INTO activity_log (madrasa_id, user_id, user_role, action, module, entity, entity_id, ip)
       VALUES (?,?,?,?,?,?,?,?)`,
      [mid, uid, role, "logout", "auth", "auth", String(uid || ""), String(req.ip || "").slice(0, 64)]
    ).catch(() => {
      logActivity(db, { madrasaId: mid, userId: uid, action: "logout", entity: "auth", entityId: String(uid || "") });
    });
    res.json({ ok: true });
  });
});

router.get("/me", asyncHandler(async (req, res) => {
  if (!req.user) return res.json({ loggedIn: false });
  let category = null;
  let institutionName = null;
  let institutionSlug = null;
  let verified = false;
  if (req.user.madrasaId) {
    const madrasa = await db.get("SELECT category, name_en, slug, verified FROM madaris WHERE id = ?", [req.user.madrasaId]);
    if (madrasa) {
      category = madrasa.category || "islamic";
      institutionName = madrasa.name_en;
      institutionSlug = madrasa.slug;
      verified = Number(madrasa.verified) === 1;
    }
  }
  let permissions = [];
  try { permissions = Array.from(await permissionService.effectivePermissions(req.user)).sort(); }
  catch (e) { permissions = permissionService.roleDefaults(req.user.role); }
  // The portrait shown in the shell is the one on the person's own record — a
  // student's ID photo, a teacher's staff photo — because that is the picture
  // they (or the office) last set. The account-level avatar is the fallback.
  let photoPath = "";
  try {
    const account = await db.get("SELECT photo_path FROM users WHERE id = ?", [req.user.id]);
    photoPath = (account && account.photo_path) || "";
    if (req.user.role === "student" && req.user.studentId) {
      const linked = await db.get("SELECT photo_path FROM students WHERE id = ? AND madrasa_id = ?", [req.user.studentId, req.user.madrasaId]);
      photoPath = (linked && linked.photo_path) || photoPath;
    } else if (req.user.role === "teacher") {
      const linked = await db.get("SELECT photo_path FROM teacher_profiles WHERE user_id = ? AND madrasa_id = ?", [req.user.id, req.user.madrasaId]);
      photoPath = (linked && linked.photo_path) || photoPath;
    }
  } catch (e) {
    /* an avatar is never a reason to fail a session bootstrap */
  }
  res.json({
    loggedIn: true,
    role: req.user.role,
    permissions,
    madrasaId: req.user.madrasaId,
    category,
    institutionName,
    institutionSlug,
    verified,
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      fullName: req.user.fullName,
      fullNameAr: req.user.fullNameAr,
      photoPath,
    },
  });
}));

/**
 * Portrait and signature for the signed-in account, plus the record it is
 * linked to. A student's or a teacher's OWN profile picture lives on their
 * student / teacher_profiles row (that is the one ID cards, registers and
 * portals read), so `photoPath` is resolved from there first and falls back to
 * the account's own avatar. Returning both paths keeps the UI honest about
 * what it is changing.
 */
async function accountIdentity(req) {
  const row = await db.get(
    `SELECT u.id, u.username, u.role, u.full_name, u.full_name_ar, u.email, u.phone, u.photo_path, u.signature_path,
            u.student_id, u.madrasa_id, u.created_at,
            s.photo_path AS student_photo_path, s.signature_path AS student_signature_path, s.admission_no, s.student_code,
            p.photo_path AS teacher_photo_path, p.signature_path AS teacher_signature_path, p.staff_id, p.position
       FROM users u
       LEFT JOIN students s ON s.id = u.student_id AND s.madrasa_id = u.madrasa_id
       LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
      WHERE u.id = ?`,
    [req.user.id]
  );
  return row;
}

function accountView(user) {
  const photo = user.photo_path || (user.role === "student" ? user.student_photo_path : "") || (user.role === "teacher" ? user.teacher_photo_path : "") || "";
  const signature = user.signature_path || (user.role === "teacher" ? user.teacher_signature_path : "") || "";
  const account = {
    id: user.id,
    username: user.username,
    role: user.role,
    full_name: user.full_name,
    full_name_ar: user.full_name_ar,
    email: user.email,
    phone: user.phone,
    created_at: user.created_at,
    photoPath: photo || "",
    signaturePath: signature || "",
    hasSignature: Boolean(signature),
    identifier: user.admission_no || user.student_code || user.staff_id || "",
    designation: user.position || "",
  };
  return account;
}

/** The signed-in account can keep its own visible contact details current.
 * This deliberately cannot alter role, tenant, username or activation state. */
router.get("/account", asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  const user = await accountIdentity(req);
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json({ account: accountView(user) });
}));
router.put("/account", asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  const b = req.body || {};
  const fields = [];
  const values = [];
  for (const [key, max] of [["full_name", 160], ["full_name_ar", 160], ["email", 120], ["phone", 60]]) {
    if (b[key] !== undefined) { fields.push(`${key} = ?`); values.push(cleanStr(b[key], max)); }
  }
  if (!fields.length) return res.status(400).json({ error: "Nothing to update." });
  values.push(req.user.id);
  await db.run(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, values);
  logActivity(db, { madrasaId: req.user.madrasaId, userId: req.user.id, action: "account.update", entity: "user", entityId: String(req.user.id), ip: req.ip });
  res.json({ ok: true });
}));

/* ---------------------- own profile picture & signature ------------------
   Every role can change its own portrait, and staff can store the picture of
   their own signature that certificates and ID cards print. The rule is
   strict on purpose: an account may only ever write to ITS OWN row, the id is
   taken from the session and never from the request body.

   Where the account is linked to a student or a staff profile, the portrait is
   written to both, so the change shows up on the ID card, in the register and
   in the portal at the same time — one action, one truth.
-------------------------------------------------------------------------- */
const avatarUploader = imageUploader("avatars", "photo");
const avatarSignature = imageUploader("signatures", "signature");

function readImageField(req, names) {
  for (const name of names) {
    if (req.body && typeof req.body[name] === "string" && req.body[name].trim()) return req.body[name];
  }
  return "";
}

/** Only a student account may write into students.*, only a teacher into teacher_profiles.* */
async function mirrorPortrait(req, path) {
  const user = await db.get("SELECT id, role, student_id, madrasa_id FROM users WHERE id = ?", [req.user.id]);
  if (!user) return;
  if (user.role === "student" && user.student_id) {
    await db.run("UPDATE students SET photo_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
      [path, user.student_id, user.madrasa_id]);
  } else if (user.role === "teacher") {
    await db.run("UPDATE teacher_profiles SET photo_path = ? WHERE user_id = ? AND madrasa_id = ?",
      [path, user.id, user.madrasa_id]);
  }
}

async function mirrorSignature(req, path) {
  const user = await db.get("SELECT id, role, madrasa_id FROM users WHERE id = ?", [req.user.id]);
  if (!user || user.role !== "teacher") return;
  await db.run("UPDATE teacher_profiles SET signature_path = ? WHERE user_id = ? AND madrasa_id = ?",
    [path, user.id, user.madrasa_id]);
}

async function storePortrait(req, res, buffer) {
  const previous = await db.get("SELECT photo_path FROM users WHERE id = ?", [req.user.id]);
  const path = await profileMedia.writeImage(buffer, "avatars", { maxBytes: profileMedia.MAX_PHOTO_BYTES });
  await db.run("UPDATE users SET photo_path = ? WHERE id = ?", [path, req.user.id]);
  await mirrorPortrait(req, path);
  if (previous && previous.photo_path) profileMedia.deleteStored(previous.photo_path);
  logActivity(db, { madrasaId: req.user.madrasaId, userId: req.user.id, action: "account.photo.update", entity: "user", entityId: String(req.user.id), ip: req.ip });
  res.json({ ok: true, photoPath: path });
}

/** POST /api/auth/account/photo — multipart file OR a canvas data URL. */
router.post("/account/photo", (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (req.is("multipart/form-data")) return avatarUploader(req, res, next);
  next();
}, asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (req.file) return storePortrait(req, res, require("fs").readFileSync(req.file.path));
  const dataUrl = readImageField(req, ["photoDataUrl", "dataUrl", "photo"]);
  if (!dataUrl) return res.status(400).json({ error: "Choose an image or take a photo first." });
  return storePortrait(req, res, profileMedia.decodeDataUrl(dataUrl, { maxBytes: profileMedia.MAX_PHOTO_BYTES }));
}));

/** DELETE /api/auth/account/photo — back to initials everywhere. */
router.delete("/account/photo", asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  const previous = await db.get("SELECT photo_path FROM users WHERE id = ?", [req.user.id]);
  await db.run("UPDATE users SET photo_path = '' WHERE id = ?", [req.user.id]);
  await mirrorPortrait(req, "");
  if (previous && previous.photo_path) profileMedia.deleteStored(previous.photo_path);
  res.json({ ok: true, photoPath: "" });
}));

/** PUT /api/auth/account/signature — the drawing the certificate prints. */
router.put("/account/signature", asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  const dataUrl = readImageField(req, ["signatureDataUrl", "dataUrl", "signature"]);
  if (!dataUrl) return res.status(400).json({ error: "Draw your signature first." });
  const previous = await db.get("SELECT signature_path FROM users WHERE id = ?", [req.user.id]);
  const path = await profileMedia.saveDataUrl(dataUrl, "signatures", { maxBytes: profileMedia.MAX_SIGNATURE_BYTES });
  await db.run("UPDATE users SET signature_path = ? WHERE id = ?", [path, req.user.id]);
  await mirrorSignature(req, path);
  if (previous && previous.signature_path) profileMedia.deleteStored(previous.signature_path);
  logActivity(db, { madrasaId: req.user.madrasaId, userId: req.user.id, action: "account.signature.update", entity: "user", entityId: String(req.user.id), ip: req.ip });
  res.json({ ok: true, signaturePath: path });
}));

router.post("/account/signature", (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (!req.is("multipart/form-data")) return next();
  return avatarSignature(req, res, next);
}, asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (!req.file) return res.status(400).json({ error: "Choose an image of your signature." });
  const previous = await db.get("SELECT signature_path FROM users WHERE id = ?", [req.user.id]);
  const path = `/uploads/signatures/${req.file.filename}`;
  await db.run("UPDATE users SET signature_path = ? WHERE id = ?", [path, req.user.id]);
  await mirrorSignature(req, path);
  if (previous && previous.signature_path) profileMedia.deleteStored(previous.signature_path);
  res.json({ ok: true, signaturePath: path });
}));

router.delete("/account/signature", asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  const previous = await db.get("SELECT signature_path FROM users WHERE id = ?", [req.user.id]);
  await db.run("UPDATE users SET signature_path = '' WHERE id = ?", [req.user.id]);
  await mirrorSignature(req, "");
  if (previous && previous.signature_path) profileMedia.deleteStored(previous.signature_path);
  res.json({ ok: true, signaturePath: "" });
}));

router.post("/change-password", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  const current = String((req.body && req.body.currentPassword) || "");
  const next = String((req.body && req.body.newPassword) || "");
  if (next.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  const user = await db.get("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
  if (!user) return res.status(404).json({ error: "User not found." });
  const match = await bcrypt.compare(current, user.password_hash);
  if (!match) return res.status(400).json({ error: "Current password is incorrect." });
  const hash = await bcrypt.hash(next, 10);
  await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.user.id]);
  // A password change invalidates every OTHER session of this account (other
  // browsers/devices). This session stays: the user just proved they own it.
  const killed = await destroyUserSessions(req.user.id, req.sessionID);
  logActivity(db, { madrasaId: req.user.madrasaId, userId: req.user.id, action: "change_password", entity: "auth", entityId: String(req.user.id), ip: req.ip, meta: { sessionsInvalidated: killed } });
  res.json({ ok: true });
});

/* ---------------------- forgot / reset password ------------------------- */

/** Reset tokens are encrypted at rest so an administrator (or the email
 *  provider, when configured) can deliver the link, while a database dump
 *  alone never contains a usable secret. Key derived from SESSION_SECRET. */
function resetTokenKey() {
  return crypto.scryptSync(String(config.SESSION_SECRET || "bello-dev-secret"), "bello-password-reset-v1", 32);
}
function encryptResetToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", resetTokenKey(), iv);
  const ct = Buffer.concat([cipher.update(String(token), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}
function decryptResetToken(enc) {
  try {
    const buf = Buffer.from(String(enc || ""), "base64");
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", resetTokenKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (e) {
    return null;
  }
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

const GENERIC_RESET_RESPONSE = {
  ok: true,
  message: "If that account exists, a password reset link has been created. " +
    "If an email address is on file and email delivery is configured, it has been sent; " +
    "otherwise your institution's administrator can hand you the link.",
};

/**
 * POST /api/auth/forgot-password — rate-limited (resetRequestLimiter).
 * Accepts a username OR an email address. NEVER reveals whether the account
 * exists: the response is byte-identical either way. Only ACTIVE accounts
 * get a token; inactive ones get the same generic answer.
 */
router.post("/forgot-password", async (req, res) => {
  const identifier = cleanStr(req.body && (req.body.identifier || req.body.username || req.body.email), 160).toLowerCase().trim();
  if (!identifier) {
    return res.status(400).json({ error: "Enter your username or email address." });
  }
  try {
    const user = await db.get(
      "SELECT id, username, full_name, email, madrasa_id, role, is_active FROM users WHERE LOWER(username) = ? OR (email <> '' AND LOWER(email) = ?)",
      [identifier, identifier]
    );
    if (user && Number(user.is_active) === 1) {
      // One live token per account: previous unused tokens die immediately.
      await db.run("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL", [user.id]);
      const token = crypto.randomBytes(32).toString("hex");
      // Naive server-local format — the schema's datetime convention, valid
      // for both SQLite TEXT and MySQL TIMESTAMP columns.
      const expiry = new Date(Date.now() + config.PASSWORD_RESET_EXPIRY_MINUTES * 60 * 1000);
      const p2 = (n) => String(n).padStart(2, "0");
      const expiresAt = `${expiry.getFullYear()}-${p2(expiry.getMonth() + 1)}-${p2(expiry.getDate())} ${p2(expiry.getHours())}:${p2(expiry.getMinutes())}:${p2(expiry.getSeconds())}`;
      await db.run(
        "INSERT INTO password_reset_tokens (user_id, token_hash, token_encrypted, expires_at, requested_ip) VALUES (?,?,?,?,?)",
        [user.id, hashResetToken(token), encryptResetToken(token), expiresAt, String(req.ip || "").slice(0, 64)]
      );
      // Best-effort email delivery. Many self-hosted installs have no email
      // provider; the admin-mediated link (GET /auth/reset-requests) covers
      // them, and the user-facing answer stays generic either way.
      if (user.email) {
        try {
          const link = `${config.PUBLIC_URL}/reset-password?token=${token}`;
          await require("../services/delivery").sendEmail(
            user.email,
            "Reset your EduSphere password",
            `<p>Hello ${user.full_name || user.username},</p>` +
              `<p>Somebody asked to reset the password of your EduSphere account <strong>${user.username}</strong>.</p>` +
              `<p>Open this link within ${config.PASSWORD_RESET_EXPIRY_MINUTES} minutes to choose a new password:</p>` +
              `<p><a href="${link}">${link}</a></p>` +
              `<p>If you did not ask for this, you can ignore this message — the link expires on its own and the password stays unchanged.</p>`,
            `Reset your EduSphere password: ${link}`
          );
        } catch (e) { /* delivery failure must not change the response */ }
      }
      logActivity(db, {
        madrasaId: user.madrasa_id, userId: user.id, action: "password_reset.request",
        entity: "auth", entityId: String(user.id), ip: req.ip,
      });
    } else if (user) {
      // Deactivated account: still the generic answer, but audited.
      logActivity(db, {
        madrasaId: user.madrasa_id, userId: user.id, action: "password_reset.request_refused_inactive",
        entity: "auth", entityId: String(user.id), ip: req.ip,
      });
    }
  } catch (e) {
    // Never surface a database/delivery error here: it would both leak state
    // and hand an attacker a oracle of a different shape.
    console.error("forgot-password failed:", e && e.message);
  }
  res.json(GENERIC_RESET_RESPONSE);
});

/**
 * POST /api/auth/reset-password — consumes a single-use, expiring token and
 * sets the new password. Every session of the account is invalidated (this
 * endpoint is used while NOT signed in, so nothing is preserved).
 */
router.post("/reset-password", async (req, res) => {
  const token = cleanStr(req.body && req.body.token, 200);
  const next = String((req.body && req.body.newPassword) || "");
  if (!token) return res.status(400).json({ error: "A reset token is required." });
  if (next.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
  const row = await db.get(
    "SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL",
    [hashResetToken(token)]
  );
  // The same generic error covers unknown, expired and already-used tokens:
  // the caller learns nothing about which one failed.
  const INVALID = { error: "This reset link is invalid or has expired. Request a new one." };
  if (!row) return res.status(400).json(INVALID);
  const expires = row.expires_at ? new Date(String(row.expires_at).replace(" ", "T")).getTime() : NaN;
  if (!Number.isFinite(expires) || expires < Date.now()) {
    await db.run("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
    return res.status(400).json(INVALID);
  }
  // Consume the token atomically: if a concurrent request already used it,
  // changes === 0 and this request is the one that loses.
  const consumed = await db.run(
    "UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL",
    [row.id]
  );
  if (!consumed || !Number(consumed.changes)) return res.status(400).json(INVALID);
  const user = await db.get("SELECT id, username, madrasa_id, is_active FROM users WHERE id = ?", [row.user_id]);
  if (!user || Number(user.is_active) !== 1) return res.status(400).json(INVALID);
  const hash = await bcrypt.hash(next, 10);
  await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, user.id]);
  // Password changed from an unauthenticated flow: drop EVERY session.
  await destroyUserSessions(user.id, null);
  logActivity(db, {
    madrasaId: user.madrasa_id, userId: user.id, action: "password_reset.complete",
    entity: "auth", entityId: String(user.id), ip: req.ip,
  });
  res.json({ ok: true, message: "Your password has been updated. You can now sign in with the new password." });
});

/**
 * GET /api/auth/reset-requests — pending reset links for the administrator.
 * Institution admins see only their own tenant's users; the super admin sees
 * every request. This is the delivery channel for installs without an email
 * provider (an institution admin can already set any tenant account's
 * password directly, so revealing the link grants no new power).
 */
router.get("/reset-requests", asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (!["madrasa_admin", "super_admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Administrator access required." });
  }
  const tenantFilter = req.user.role === "super_admin" ? "" : " AND u.madrasa_id = ? ";
  const params = req.user.role === "super_admin" ? [] : [req.user.madrasaId];
  // Expiry is evaluated in JS (not SQL) because the column is TEXT on SQLite
  // (ISO strings) and TIMESTAMP on MySQL — one comparison rule for both.
  const rows = await db.all(
    `SELECT t.id, t.expires_at, t.created_at, t.requested_ip, u.username, u.full_name, u.role AS user_role,
            u.madrasa_id, m.name_en AS institution_name, t.token_encrypted
       FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN madaris m ON m.id = u.madrasa_id
      WHERE t.used_at IS NULL${tenantFilter}
      ORDER BY t.id DESC LIMIT 100`,
    params
  );
  const now = Date.now();
  const requests = rows.map((r) => {
    const token = decryptResetToken(r.token_encrypted);
    const exp = r.expires_at ? new Date(String(r.expires_at).replace(" ", "T")).getTime() : NaN;
    return {
      id: r.id,
      username: r.username,
      fullName: r.full_name,
      userRole: r.user_role,
      institutionName: r.institution_name,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      expired: !Number.isFinite(exp) || exp < now,
      // The shareable link is only included while the token is still usable.
      resetLink: token && Number.isFinite(exp) && exp >= now
        ? `/reset-password?token=${token}`
        : null,
    };
  });
  res.json({ requests });
}));

module.exports = { router, csrfGuard, ensureCsrfToken };
