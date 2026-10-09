"use strict";
/* ============================================================================
   EduSphere — card credentials (what a printed QR code actually points at)
   ----------------------------------------------------------------------------
   A wallet card is printed once and carried for years, so the QR on it must
   outlive the print job. The earlier design encoded a 15-minute signed URL,
   which meant a card stopped verifying minutes after it left the printer.

   Instead every holder gets a durable, random `code`:

     • 12 random bytes → 24 hex characters. Not guessable, not sequential, and
       it leaks nothing about ids or tenant size.
     • One row per (tenant, holder_type, holder_id); reprints reuse the same
       code, so a card never goes stale because someone reprinted it.
     • Revoking flips `status` — the printed card starts reporting "not valid"
       immediately without touching the student or staff record.
     • The public lookup returns the same few identity fields that are already
       printed on the card. No guardian contacts, no fees, no results.

   The scan target is deliberately tiny and boring: a page plus a JSON
   endpoint, both rate limited, both usable by any phone camera.
   ========================================================================== */
const crypto = require("crypto");
const db = require("../db");
const { logActivity } = require("../util");

const HOLDER_TYPES = new Set(["student", "teacher"]);
const CODE_BYTES = 12;

function newCode() {
  return crypto.randomBytes(CODE_BYTES).toString("hex");
}

function normaliseCode(value) {
  const raw = String(value || "").trim().toLowerCase();
  return /^[a-z0-9-]{6,64}$/.test(raw) ? raw : "";
}

/** Absolute or relative? A printed QR needs a full URL a stranger can open. */
function cardVerifyUrl(req, code) {
  const path = `/verify/${code}`;
  const host = req && req.get ? req.get("host") : "";
  if (!host) return path;
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0];
  return `${proto}://${host}${path}`;
}

/**
 * Returns the holder's credential, creating it on first use. Rendering a card
 * must never fail because a code was never minted, so this is called by the
 * printer rather than by a separate "issue" step.
 */
async function ensureCardCredential(tid, holderType, holderId) {
  const type = HOLDER_TYPES.has(holderType) ? holderType : "student";
  const existing = await db.get(
    "SELECT * FROM card_credentials WHERE madrasa_id = ? AND holder_type = ? AND holder_id = ?",
    [tid, type, holderId]
  );
  if (existing && existing.status !== "revoked") return existing;
  const code = newCode();
  if (existing) {
    // A revoked card that is reprinted becomes a fresh credential: the old
    // code stays dead, which is the point of revoking it.
    await db.run(
      "UPDATE card_credentials SET code = ?, status = 'active', issued_at = CURRENT_TIMESTAMP, revoked_at = NULL, revoked_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [code, existing.id]
    );
    return { ...existing, code, status: "active", revoked_at: null };
  }
  const result = await db.run(
    "INSERT INTO card_credentials (madrasa_id, holder_type, holder_id, code, status) VALUES (?,?,?,?, 'active')",
    [tid, type, holderId, code]
  );
  return db.get("SELECT * FROM card_credentials WHERE id = ?", [Number(result.lastInsertRowid)]);
}

async function cardCredentialFor(tid, holderType, holderId) {
  const type = HOLDER_TYPES.has(holderType) ? holderType : "student";
  return db.get(
    "SELECT * FROM card_credentials WHERE madrasa_id = ? AND holder_type = ? AND holder_id = ?",
    [tid, type, holderId]
  );
}

/**
 * Records that a set of cards went to the printer. `print_count` turns a
 * "was this card ever issued?" question into a glance instead of a guess.
 */
async function noteCardsPrinted(rows, { madrasaId, userId, ip, holderType, side }) {
  const ids = rows.map((row) => Number(row.id)).filter(Boolean);
  if (!ids.length) return;
  const marks = new Date().toISOString().slice(0, 19).replace("T", " ");
  try {
    await db.run(
      `UPDATE card_credentials
          SET print_count = print_count + 1, last_printed_at = ?, updated_at = ?
        WHERE madrasa_id = ? AND holder_type = ? AND holder_id IN (${ids.map(() => "?").join(",")})`,
      [marks, marks, madrasaId, holderType, ...ids]
    );
  } catch (e) { /* a print counter must never break printing */ }
  void userId; void ip; void side;
}

/** Revoke (or restore) one holder's card. Returns the updated credential. */
async function setCardStatus(tid, holderType, holderId, status, byUserId) {
  const type = HOLDER_TYPES.has(holderType) ? holderType : "student";
  const credential = await cardCredentialFor(tid, type, holderId);
  if (!credential) return null;
  const revoked = status === "revoked";
  await db.run(
    `UPDATE card_credentials
        SET status = ?, revoked_at = ?, revoked_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND madrasa_id = ?`,
    [status, revoked ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, revoked ? byUserId || null : null, credential.id, tid]
  );
  return db.get("SELECT * FROM card_credentials WHERE id = ?", [credential.id]);
}

/* --------------------------------------------------------------------------
   Public verification
   ----------------------------------------------------------------------------
   The query is driven ONLY by the code: it is the capability. Nothing about
   the holder's id, tenant or role is accepted from the request.
   -------------------------------------------------------------------------- */
async function lookupCard(code) {
  const clean = normaliseCode(code);
  if (!clean) return null;
  const credential = await db.get("SELECT * FROM card_credentials WHERE code = ?", [clean]);
  if (!credential) return null;

  const school = await db.get(
    `SELECT id, name_en, name_ar, logo_path, motto_en, address, city, state_name, phone, status, category
       FROM madaris WHERE id = ?`,
    [credential.madrasa_id]
  );

  let holder = null;
  if (credential.holder_type === "teacher") {
    holder = await db.get(
      `SELECT u.id, u.full_name, u.is_active, p.staff_id, p.first_name, p.middle_name, p.last_name,
              p.photo_path, p.position, p.department, p.status, p.education_track, p.employment_date,
              p.specialization
         FROM teacher_profiles p
         JOIN users u ON u.id = p.user_id AND u.madrasa_id = p.madrasa_id
        WHERE p.madrasa_id = ? AND p.user_id = ?`,
      [credential.madrasa_id, credential.holder_id]
    );
  } else {
    holder = await db.get(
      `SELECT s.id, s.first_name, s.middle_name, s.last_name, s.admission_no, s.student_code,
              s.photo_path, s.status, s.education_track, s.program, s.class_id,
              c.name_en AS class_name, a.label AS session_label
         FROM students s
         LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id
         LEFT JOIN academic_sessions a ON a.id = s.session_id AND a.madrasa_id = s.madrasa_id
        WHERE s.madrasa_id = ? AND s.id = ?`,
      [credential.madrasa_id, credential.holder_id]
    );
  }
  if (!holder || !school) return null;
  return { credential, holder, school };
}

/**
 * The public projection: deliberately the same fields that are printed on the
 * card, plus a verdict a person with a camera can read at a glance.
 */
function cardVerificationView(result) {
  const { credential, holder, school } = result;
  const isTeacher = credential.holder_type === "teacher";
  const name = isTeacher
    ? [holder.first_name, holder.middle_name, holder.last_name].filter(Boolean).join(" ") || holder.full_name || ""
    : [holder.first_name, holder.middle_name, holder.last_name].filter(Boolean).join(" ");
  const holderActive = isTeacher
    ? holder.status === "active" && Number(holder.is_active) === 1
    : holder.status === "active" || holder.status === "promoted";
  const schoolActive = school.status === "active";
  const cardActive = credential.status === "active";
  const verdict = !cardActive ? "revoked" : !holderActive ? "inactive" : !schoolActive ? "closed" : "valid";
  return {
    code: credential.code,
    verdict,
    valid: verdict === "valid",
    holderType: isTeacher ? "teacher" : "student",
    name,
    photoPath: holder.photo_path || "",
    identifier: isTeacher ? holder.staff_id || "" : holder.admission_no || holder.student_code || "",
    role: isTeacher ? holder.position || "Teacher" : "Student",
    department: isTeacher ? holder.department || "" : holder.class_name || "",
    meta: isTeacher
      ? (holder.session_label || "")
      : [holder.class_name, holder.session_label].filter(Boolean).join(" · "),
    program: holder.program || holder.specialization || "",
    track: holder.education_track || "",
    holderStatus: holder.status || "",
    issuedAt: credential.issued_at || credential.created_at || "",
    printedTimes: Number(credential.print_count || 0),
    school: {
      name: school.name_en || "",
      nameAr: school.name_ar || "",
      logo: school.logo_path || "",
      motto: school.motto_en || "",
      city: school.city || "",
      state: school.state_name || "",
      phone: school.phone || "",
    },
  };
}

async function logVerification({ madrasaId, code, ip, valid }) {
  await logActivity(db, {
    madrasaId: madrasaId || null,
    userId: null,
    action: "card.verify",
    entity: "card_credentials",
    entityId: String(code || "").slice(0, 64),
    meta: { valid: Boolean(valid) },
    ip: ip || "",
  });
}

module.exports = {
  CODE_BYTES,
  HOLDER_TYPES,
  cardCredentialFor,
  cardVerifyUrl,
  ensureCardCredential,
  logVerification,
  lookupCard,
  newCode,
  normaliseCode,
  noteCardsPrinted,
  cardVerificationView,
  setCardStatus,
};
