"use strict";
/* ============================================================================
   EduSphere — printable documents: ID cards and certificates
   ----------------------------------------------------------------------------
   This module deliberately returns HTML, not PDF files. The browser's print
   engine is the document renderer, which keeps the feature small, portable and
   consistent with the existing fee receipts and report cards. The layout and
   the QR encoder live in services/print-documents.js, services/
   id-card-designs.js and services/certificate-designs.js so the printed page
   and its on-screen preview cannot drift apart.

   Two rules the whole file obeys:
     • Every query is tenant-scoped from the authenticated user's session. No
       request can select a different madrasa by posting a madrasa_id.
     • A printed document must stay true after it leaves the printer. Card and
       certificate QR codes therefore point at durable, revocable codes rather
       than short-lived signed links.
   ========================================================================== */
const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const tokens = require("../services/tokens");
const { asyncHandler, err, ok, cleanStr, toNum, validDate, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments } = require("../middleware/tenant");
const { requireStaffPermission } = require("../services/permissions");
const institution = require("../services/institution");
const print = require("../services/print-documents");
const cardDesigns = require("../services/id-card-designs");
const certDesigns = require("../services/certificate-designs");
const cardCreds = require("../services/card-credentials");
const media = require("../services/profile-media");
const { imageUploader } = require("../middleware/upload");

const router = express.Router();
router.use(requireAuth, requireTenant);

const STAFF = requireRole("madrasa_admin", "teacher");
const ADMIN = requireRole("madrasa_admin");

const escapeHtml = print.escapeHtml;
const safeAssetPath = print.safeAssetPath;
const today = print.today;
const dateLabel = print.dateLabel;

const TEMPLATE_TYPES = new Set(certDesigns.CERT_TYPES.concat(["custom"]));
const MAX_TEMPLATE_LENGTH = 200000;
const MAX_CUSTOM_FIELD_LENGTH = 500;

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) {
    err(res, 400, "Madrasa context required.");
    return null;
  }
  return Number(tid);
}

function studentName(student) {
  return [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ").trim();
}

function staffName(row) {
  const fromProfile = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" ").trim();
  return fromProfile || row.full_name || "";
}

function initials(name) {
  const parts = String(name || "").split(/\s+/).filter(Boolean);
  if (!parts.length) return "S";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function truthyFlag(value) {
  return !(value === false || value === 0 || value === "0" || value === "false");
}

/* --------------------------- the rows we print --------------------------- */
/* Columns shared by every printable student card, so the single and bulk
   layouts cannot drift apart. Tenant scoping is applied by each caller. */
const STUDENT_DOC_SELECT = `
    SELECT s.*, c.name_en AS class_name, a.label AS session_label,
           m.name_en AS institution_name, m.name_ar AS institution_name_ar, m.logo_path,
           m.slug AS institution_slug, m.motto_en, m.category, m.brand_color, m.institution_type,
           m.address, m.city, m.state_name, m.phone
    FROM students s
    LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id
    LEFT JOIN academic_sessions a ON a.id = s.session_id AND a.madrasa_id = s.madrasa_id
    JOIN madaris m ON m.id = s.madrasa_id`;

/*
 * Staff cards are built from `users` LEFT JOIN `teacher_profiles`, not from the
 * profile table alone: a school can employ an administrator, a bursar or a
 * driver who has no teaching profile, and a freshly created teacher may not
 * have had their profile row written yet. A card is identification, so it must
 * exist for every member of staff — the profile only adds the fields it knows.
 */
const TEACHER_DOC_SELECT = `
    SELECT u.id, u.full_name, u.username, u.role, u.email, u.is_active, u.madrasa_id,
           u.phone AS user_phone,
           COALESCE(NULLIF(p.photo_path, ''), u.photo_path, '') AS photo_path,
           COALESCE(NULLIF(p.signature_path, ''), u.signature_path, '') AS signature_path,
           p.staff_id, p.first_name, p.middle_name, p.last_name, p.position, p.department,
           p.specialization, p.employment_type, p.emergency_contact, p.status AS profile_status,
           a.label AS session_label,
           m.name_en AS institution_name, m.name_ar AS institution_name_ar, m.logo_path,
           m.slug AS institution_slug, m.motto_en, m.category, m.brand_color, m.institution_type,
           m.address, m.city, m.state_name, m.phone, m.head_name, m.head_title
    FROM users u
    LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
    LEFT JOIN academic_sessions a ON a.id = p.academic_session_id AND a.madrasa_id = u.madrasa_id
    JOIN madaris m ON m.id = u.madrasa_id`;

async function studentDocumentRow(tid, studentId) {
  return db.get(`${STUDENT_DOC_SELECT} WHERE s.id = ? AND s.madrasa_id = ?`, [studentId, tid]);
}

async function staffDocumentRow(tid, userId) {
  return db.get(`${TEACHER_DOC_SELECT} WHERE u.id = ? AND u.madrasa_id = ?`, [userId, tid]);
}

async function assertTeacherCanSee(req, res, tid, student) {
  if (req.user.role !== "teacher") return true;
  const scope = await getTeacherAssignments(tid, req.user.id);
  if (scope.anyClassAnySubject || scope.assignedClassIds.has(Number(student.class_id))) return true;
  err(res, 404, "Student not found.");
  return false;
}

/* ------------------------- profile links (legacy QR) ----------------------
   Kept for the existing signed student-profile link; card QR codes no longer
   use it because it expires. See services/card-credentials.js.
-------------------------------------------------------------------------- */
function signedProfileUrl(req, student) {
  const token = tokens.sign({ purpose: "public-student-profile", m: Number(student.madrasa_id), s: Number(student.id) }, 15 * 60);
  const path = `/api/public/student-profile/${token}`;
  const host = req.get("host");
  if (!host) return path;
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0];
  return `${proto}://${host}${path}`;
}

/* ------------------------------ ID card data -----------------------------
   One normaliser per holder type, so the card engine sees one shape and a
   staff card gets exactly the same verification as a student card.
-------------------------------------------------------------------------- */
async function buildStudentHolder(req, tid, student) {
  const credential = await cardCreds.ensureCardCredential(tid, "student", Number(student.id));
  const school = print.schoolIdentity(student);
  const wantsQr = truthyFlag(req.query.qr === undefined ? "1" : req.query.qr);
  const fields = [
    { label: "Admission no.", value: student.admission_no },
    { label: "Class", value: student.class_name || "Not assigned" },
    { label: "Session", value: student.session_label || "Not set" },
    { label: "Programme", value: student.program || "" },
  ];
  const name = studentName(student);
  return {
    type: "student",
    id: Number(student.id),
    name,
    initials: initials(name),
    photoPath: safeAssetPath(student.photo_path),
    roleLabel: "Student",
    designation: [student.islamic_program, student.western_program].filter(Boolean).join(" · "),
    fields,
    meta: [
      { label: "School", value: school.address },
      { label: "Phone", value: school.phone },
    ],
    emergency: student.emergency_contact || student.parent_phone || "",
    serial: student.admission_no || student.student_code || "",
    validThrough: student.session_label || "",
    verifyUrl: wantsQr && credential ? cardCreds.cardVerifyUrl(req, credential.code) : "",
    credential,
    holderSignature: safeAssetPath(student.signature_path),
    issuerSignature: "",
    issuerName: student.head_name || "",
    school,
    theme: print.documentTheme(school),
  };
}

const STAFF_ROLE_LABELS = { madrasa_admin: "Administrator", teacher: "Teacher", parent: "Parent", super_admin: "Platform staff" };

async function buildTeacherHolder(req, tid, row) {
  const credential = await cardCreds.ensureCardCredential(tid, "teacher", Number(row.id));
  const school = print.schoolIdentity(row);
  const wantsQr = truthyFlag(req.query.qr === undefined ? "1" : req.query.qr);
  const name = staffName(row);
  const fields = [
    { label: "Staff ID", value: row.staff_id || "" },
    { label: "Department", value: row.department || "" },
    { label: "Session", value: row.session_label || "" },
    { label: "Specialty", value: row.specialization || "" },
  ].filter((field) => field.value);
  return {
    type: "teacher",
    id: Number(row.id),
    name,
    initials: initials(name),
    photoPath: safeAssetPath(row.photo_path),
    roleLabel: row.position || STAFF_ROLE_LABELS[row.role] || "Staff",
    designation: [row.position, row.employment_type].filter(Boolean).join(" · "),
    fields: fields.length ? fields : [{ label: "Role", value: STAFF_ROLE_LABELS[row.role] || "Staff" }],
    meta: [
      { label: "School", value: school.address },
      { label: "Phone", value: school.phone || row.user_phone },
      { label: "Email", value: row.email },
    ],
    emergency: row.emergency_contact || "",
    serial: row.staff_id || `STAFF-${row.id}`,
    validThrough: row.session_label || "",
    verifyUrl: wantsQr && credential ? cardCreds.cardVerifyUrl(req, credential.code) : "",
    credential,
    holderSignature: safeAssetPath(row.signature_path),
    issuerSignature: "",
    issuerName: row.head_name || "",
    school,
    theme: print.documentTheme(school),
  };
}

/**
 * The signature printed under "Principal" on a card back: the school's own
 * signatory choice (Settings → signature) when set, otherwise the first
 * administrator who has saved a signature. Names come from the institution
 * record so a card never prints a signature nobody authorised.
 */
async function issuerSignatureFor(tid) {
  const school = await db.get("SELECT head_name, head_title FROM madaris WHERE id = ?", [tid]);
  const setting = await db.get("SELECT value FROM settings WHERE madrasa_id = ? AND key_name = 'document_signatory'", [tid]);
  let configured = null;
  if (setting && setting.value) {
    try { configured = JSON.parse(String(setting.value)); } catch (e) { configured = null; }
  }
  if (configured && configured.principalUserId) {
    const account = await db.get("SELECT full_name, signature_path FROM users WHERE id = ? AND madrasa_id = ? AND is_active = 1",
      [Number(configured.principalUserId), tid]);
    if (account && safeAssetPath(account.signature_path)) {
      return { signaturePath: safeAssetPath(account.signature_path), name: account.full_name || "" };
    }
  }
  const admin = await db.get(
    `SELECT u.full_name, u.signature_path FROM users u
      WHERE u.madrasa_id = ? AND u.role IN ('madrasa_admin','super_admin') AND u.signature_path <> ''
      ORDER BY u.id LIMIT 1`,
    [tid]
  );
  if (admin) return { signaturePath: safeAssetPath(admin.signature_path), name: admin.full_name || "" };
  return { signaturePath: "", name: (school && school.head_name) || "" };
}

/* ------------------------------ single cards ---------------------------- */
const SIDE_LABELS = { front: ["Front"], back: ["Back"], both: ["Front", "Back"] };

function singleCardDocument(title, holder, side) {
  const wanted = SIDE_LABELS[side] ? side : "both";
  const issued = dateLabel(today());
  const prepared = Object.assign({}, holder, { issued, code: (holder.credential && holder.credential.code) || "" });
  const pages = (wanted === "both" ? [cardDesigns.idCardFront(prepared), cardDesigns.idCardBack(prepared)]
    : wanted === "back" ? [cardDesigns.idCardBack(prepared)] : [cardDesigns.idCardFront(prepared)]);
  const labels = SIDE_LABELS[wanted];
  const body = `<section class="id-single">${pages
    .map((page, index) => `<p class="id-side-label">${labels[index]}</p>${cardDesigns.idSlot(page)}`)
    .join("")}</section>`;
  return print.printShell(title, cardDesigns.ID_CARD_CSS + cardDesigns.ID_SINGLE_CSS, body, {
    badge: holder.type === "teacher" ? "Staff ID card" : "Student ID card",
  });
}

router.get("/id-card/bulk", STAFF, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const classId = toNum(req.query.classId, 0);
  if (!classId) return err(res, 400, "classId is required.");
  const klass = await db.get("SELECT id, name_en FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!klass) return err(res, 404, "Class not found.");
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!scope.anyClassAnySubject && !scope.assignedClassIds.has(classId)) return err(res, 404, "Class not found.");
  }
  const side = String(req.query.side || "front").toLowerCase() === "back" ? "back" : "front";
  const students = await db.all(`${STUDENT_DOC_SELECT}
    WHERE s.madrasa_id = ? AND s.class_id = ? AND s.status NOT IN ('withdrawn','inactive')
    ORDER BY s.last_name, s.first_name, s.id`, [tid, classId]);
  if (!students.length) return err(res, 404, "No students found in this class.");
  const issued = dateLabel(today());
  const cards = [];
  for (const student of students) {
    const holder = await buildStudentHolder(req, tid, student);
    const prepared = Object.assign({}, holder, { issued, code: (holder.credential && holder.credential.code) || "" });
    cards.push(side === "back" ? cardDesigns.idCardBack(prepared) : cardDesigns.idCardFront(prepared));
  }
  await cardCreds.noteCardsPrinted(students, { madrasaId: tid, userId: req.user.id, ip: req.ip, holderType: "student", side });
  const sheets = [];
  for (let i = 0; i < cards.length; i += 8) {
    sheets.push(`<section class="id-sheet">${cards.slice(i, i + 8).map(cardDesigns.idSlot).join("")}</section>`);
  }
  res.set("Cache-Control", "no-store");
  res.type("html").send(print.printShell(
    `ID cards — ${klass.name_en} (${side === "back" ? "backs" : "fronts"})`,
    cardDesigns.ID_CARD_CSS + cardDesigns.ID_SHEET_CSS,
    sheets.join(""),
    { badge: "Class set" }
  ));
}));

router.get("/staff-id-card/bulk", ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const side = String(req.query.side || "front").toLowerCase() === "back" ? "back" : "front";
  const search = cleanStr(req.query.q, 80);
  // `role` narrows the run: staff cards are printed for the whole office, not
  // only for the teaching body, but a school printing 40 teacher cards should
  // not have to tape four administrator cards onto the pile afterwards.
  const requestedRole = cleanStr(req.query.role, 20).toLowerCase();
  const roles = requestedRole === "teacher" ? ["teacher"] : requestedRole === "madrasa_admin" ? ["madrasa_admin"] : ["teacher", "madrasa_admin"];
  const where = ["u.madrasa_id = ?", "u.is_active = 1", `u.role IN (${roles.map(() => "?").join(",")})`];
  const params = [tid, ...roles];
  if (search) {
    where.push("(u.full_name LIKE ? OR p.first_name LIKE ? OR p.last_name LIKE ? OR p.staff_id LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const rows = await db.all(`${TEACHER_DOC_SELECT}
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(NULLIF(p.last_name, ''), u.full_name), u.id`, params);
  if (!rows.length) return err(res, 404, search ? "No staff matched that search." : "No active staff found.");
  const issued = dateLabel(today());
  const cards = [];
  for (const row of rows) {
    const holder = await buildTeacherHolder(req, tid, row);
    const prepared = Object.assign({}, holder, { issued, code: (holder.credential && holder.credential.code) || "" });
    cards.push(side === "back" ? cardDesigns.idCardBack(prepared) : cardDesigns.idCardFront(prepared));
  }
  await cardCreds.noteCardsPrinted(rows, { madrasaId: tid, userId: req.user.id, ip: req.ip, holderType: "teacher", side });
  const sheets = [];
  for (let i = 0; i < cards.length; i += 8) {
    sheets.push(`<section class="id-sheet">${cards.slice(i, i + 8).map(cardDesigns.idSlot).join("")}</section>`);
  }
  res.set("Cache-Control", "no-store");
  res.type("html").send(print.printShell(
    `Staff ID cards (${side === "back" ? "backs" : "fronts"})`,
    cardDesigns.ID_CARD_CSS + cardDesigns.ID_SHEET_CSS,
    sheets.join(""),
    { badge: `Staff · ${rows.length}` }
  ));
}));

router.get("/id-card/:studentId", STAFF, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const student = await studentDocumentRow(tid, toNum(req.params.studentId, 0));
  if (!student) { err(res, 404, "Student not found."); return; }
  if (!await assertTeacherCanSee(req, res, tid, student)) return;
  const holder = await buildStudentHolder(req, tid, student);
  const issuer = await issuerSignatureFor(tid);
  holder.issuerSignature = issuer.signaturePath;
  holder.issuerName = holder.issuerName || issuer.name;
  const side = String(req.query.side || "both").toLowerCase();
  res.set("Cache-Control", "no-store");
  res.type("html").send(singleCardDocument(`ID card — ${holder.name}`, holder, side));
}));

/* ----------------------------- my own card ---------------------------------
   Printing a card used to be something an administrator did for you. A student
   or a member of staff can now open their own, complete with the same QR code,
   because the moment a card is useful is the moment nobody is at a desk to
   issue it: the first day of term, an exam hall, a gate.
   Parents get no card; they get their children's, which is what a gate asks for.
--------------------------------------------------------------------------- */
router.get("/my-card", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const role = String(req.user.role || "");
  let holder = null;
  if (role === "student") {
    const student = await studentDocumentRow(tid, toNum(req.user.studentId, 0));
    if (!student) { err(res, 404, "No student record is linked to your account yet. Ask your school to confirm your admission."); return; }
    holder = await buildStudentHolder(req, tid, student);
  } else {
    const row = await staffDocumentRow(tid, Number(req.user.id));
    if (!row) { err(res, 404, "No staff record was found for your account."); return; }
    holder = await buildTeacherHolder(req, tid, row);
    // Only the principal's own signature belongs on the issuer line, and only
    // when the principal is the one printing.
    if (role === "madrasa_admin") {
      const issuer = await issuerSignatureFor(tid);
      holder.issuerSignature = issuer.signaturePath;
      holder.issuerName = holder.issuerName || issuer.name;
    }
  }
  const side = String(req.query.side || "both").toLowerCase();
  await cardCreds.noteCardsPrinted([holder], { madrasaId: tid, userId: req.user.id, ip: req.ip, holderType: role === "student" ? "student" : "teacher", side });
  res.set("Cache-Control", "no-store");
  res.type("html").send(singleCardDocument(`ID card — ${holder.name}`, holder, side));
}));

/** The card a signed-in person owns, as JSON, for the portal's own panel. */
router.get("/my-card/credential", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const isStudent = req.user.role === "student";
  const holderId = isStudent ? toNum(req.user.studentId, 0) : Number(req.user.id);
  if (!holderId) { err(res, 404, "No card has been issued for your account yet."); return; }
  const credential = await cardCreds.ensureCardCredential(tid, isStudent ? "student" : "teacher", holderId);
  if (!credential) { err(res, 404, "No card has been issued for your account yet."); return; }
  ok(res, {
    credential: {
      code: credential.code,
      status: credential.status,
      printedAt: credential.printed_at || "",
      printCount: Number(credential.print_count || 0),
      verifyUrl: cardCreds.cardVerifyUrl(req, credential.code),
    },
  });
}));

router.get("/staff-id-card/:userId", STAFF, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const requested = toNum(req.params.userId, 0);
  // A teacher may always print their own card; printing anyone else's is admin work.
  if (req.user.role !== "madrasa_admin" && Number(req.user.id) !== requested) {
    err(res, 403, "You can print only your own staff card.");
    return;
  }
  const row = await staffDocumentRow(tid, requested);
  if (!row) { err(res, 404, "Staff record not found."); return; }
  const holder = await buildTeacherHolder(req, tid, row);
  const issuer = await issuerSignatureFor(tid);
  // The principal signs staff cards; a teacher printing their own card leaves
  // the issuer line blank rather than inventing someone else's signature.
  if (req.user.role === "madrasa_admin") {
    holder.issuerSignature = issuer.signaturePath;
    holder.issuerName = holder.issuerName || issuer.name;
  }
  const side = String(req.query.side || "both").toLowerCase();
  res.set("Cache-Control", "no-store");
  res.type("html").send(singleCardDocument(`Staff ID card — ${holder.name}`, holder, side));
}));

/* ------------------------ card credential controls ----------------------- */
router.get("/card/:holderType/:holderId/credential", STAFF, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const type = req.params.holderType === "teacher" || req.params.holderType === "staff" ? "teacher" : "student";
  const id = toNum(req.params.holderId, 0);
  if (type === "teacher" && req.user.role !== "madrasa_admin" && Number(req.user.id) !== id) {
    err(res, 403, "You can view only your own card credential.");
    return;
  }
  const credential = await cardCreds.ensureCardCredential(tid, type, id);
  if (!credential) return err(res, 404, "Card not found.");
  ok(res, {
    credential: {
      code: credential.code,
      status: credential.status,
      issuedAt: credential.issued_at || credential.created_at,
      lastPrintedAt: credential.last_printed_at || "",
      printCount: Number(credential.print_count || 0),
      verifyUrl: cardCreds.cardVerifyUrl(req, credential.code),
    },
  });
}));

router.post("/card/:holderType/:holderId/status", ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const type = req.params.holderType === "teacher" || req.params.holderType === "staff" ? "teacher" : "student";
  const id = toNum(req.params.holderId, 0);
  const status = cleanStr(req.body && req.body.status, 20).toLowerCase();
  if (!["active", "revoked"].includes(status)) return err(res, 400, "status must be active or revoked.");
  const credential = await cardCreds.setCardStatus(tid, type, id, status, req.user.id);
  if (!credential) return err(res, 404, "No card has been printed for this holder yet.");
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: `card.${status}`, entity: "card_credentials", entityId: String(credential.id), meta: { type, holderId: id }, ip: req.ip });
  ok(res, { ok: true, status: credential.status, code: credential.code });
}));

/* --------------------------- certificate designs ------------------------
   A template is a design plus a filled form. The HTML editor is gone: what is
   stored is a design key and a bounded JSON config of plain text, which the
   renderer expands into the document.
-------------------------------------------------------------------------- */
async function readTemplateConfig(template) {
  const raw = template && template.config;
  let parsed = null;
  if (typeof raw === "string" && raw.trim()) {
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  } else if (raw && typeof raw === "object") {
    parsed = raw;
  }
  const legacyHtml = String((template && template.html_template) || "");
  if (!parsed && legacyHtml) {
    // Migration path for templates written before the design gallery existed:
    // the stored HTML is reduced to its text and mapped onto plain fields, so
    // an old template prints with the new renderer and no raw HTML survives.
    parsed = certDesigns.legacyConfigFromHtml(legacyHtml);
  }
  return certDesigns.normaliseConfig(parsed || {}, {
    type: certDesigns.CERT_TYPES.includes(String(template && template.type).toLowerCase()) ? String(template.type).toLowerCase() : "custom",
    designKey: template && template.design_key ? template.design_key : "",
  });
}

function templateView(template, config) {
  const design = certDesigns.designByKey(config.designKey) || certDesigns.designByKey(certDesigns.DESIGNS[0].key);
  return {
    id: template.id,
    madrasa_id: template.madrasa_id,
    name: template.name,
    type: config.type,
    designKey: design.key,
    designName: design.name,
    designTagline: design.tagline,
    swatch: design.swatch,
    config,
    created_at: template.created_at,
    archived_at: template.archived_at || null,
    // The dashboard lists templates with an Active/Archived pill and only
    // offers active ones for issuing; without this field every template
    // filtered as "inactive" and the issue wizard could never open.
    is_active: !template.archived_at,
    // Populated so an old HTML-only template still shows what it says.
    excerpt: String(config.body || "").slice(0, 160),
  };
}

/** Signatory names/signatures may reference a staff account; resolved at print. */
async function resolveSignatories(tid, signatories) {
  const out = [];
  for (const signatory of signatories) {
    const next = { ...signatory };
    if (next.userId && !next.signaturePath) {
      const account = await db.get(
        "SELECT full_name, signature_path FROM users WHERE id = ? AND madrasa_id = ? AND is_active = 1",
        [Number(next.userId), tid]
      );
      if (account) {
        next.signaturePath = safeAssetPath(account.signature_path);
        if (!next.name) next.name = account.full_name || "";
      }
    }
    out.push(next);
  }
  return out;
}

router.get("/certificate-designs", STAFF, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  ok(res, {
    designs: certDesigns.designList(),
    tokens: certDesigns.TOKENS,
    facts: certDesigns.FACTS,
    types: certDesigns.CERT_TYPES,
    typeDefaults: certDesigns.TYPE_DEFAULTS,
    defaultBodies: certDesigns.DEFAULT_BODY_TEMPLATES,
  });
}));

router.get(["/templates", "/certificate-templates"], ADMIN, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const rows = await db.all(
    "SELECT * FROM certificate_templates WHERE madrasa_id=? ORDER BY archived_at IS NOT NULL, name, id DESC",
    [tid]
  );
  const templates = [];
  for (const row of rows) templates.push(templateView(row, await readTemplateConfig(row)));
  ok(res, { templates });
}));

router.get(["/templates/:id", "/certificate-templates/:id"], ADMIN, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const template = await db.get("SELECT * FROM certificate_templates WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!template) return err(res, 404, "Certificate template not found.");
  const config = await readTemplateConfig(template);
  ok(res, { template: templateView(template, config), config });
}));

async function writeTemplate(tid, req, body, existing) {
  const name = cleanStr(body.name, 160);
  if (!name) return { status: 400, error: "Template name is required." };
  const requestedType = cleanStr(body.type, 30).toLowerCase();
  if (requestedType && !TEMPLATE_TYPES.has(requestedType)) return { status: 400, error: "Invalid certificate template type." };
  const type = requestedType || (existing ? existing.type : "custom");
  if (body.html_template !== undefined && String(body.html_template || "").length > MAX_TEMPLATE_LENGTH) {
    return { status: 400, error: "Certificate wording is too long." };
  }
  // An older client that still posts a block of HTML gets it converted, not
  // rejected: the markup is reduced to the wording it clearly carried, and the
  // school's design choice supplies the frame. Nothing executable is stored.
  const legacyHtml = body.config === undefined && typeof body.html_template === "string" && body.html_template.trim();
  const source = body.config || (legacyHtml
    ? Object.assign({}, body, certDesigns.legacyConfigFromHtml(body.html_template))
    : body);
  const config = certDesigns.normaliseConfig(source, { type, designKey: body.designKey || body.design_key });
  if (!config.title) return { status: 400, error: "A certificate needs a title, e.g. “Certificate of Achievement”." };
  if (!config.body) return { status: 400, error: "Write the certificate wording — what the certificate is for." };
  return { config, name, type };
}

router.post(["/templates", "/certificate-templates"], ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const result = await writeTemplate(tid, req, req.body || {});
  if (result.status) return err(res, result.status, result.error);
  // html_template is kept empty: plain text + a design key is the storage
  // format now, and an empty column proves nothing executable is stored.
  const insert = await db.run(
    "INSERT INTO certificate_templates (madrasa_id, name, type, html_template, design_key, config) VALUES (?,?,?,?,?,?)",
    [tid, result.name, result.type, "", result.config.designKey, JSON.stringify(result.config)]
  );
  const id = Number(insert.lastInsertRowid);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "certificate_template.create", entity: "certificate_template", entityId: String(id), meta: { designKey: result.config.designKey }, ip: req.ip });
  ok(res, { ok: true, id, config: result.config });
}));

router.patch(["/templates/:id", "/certificate-templates/:id"], ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const id = toNum(req.params.id, 0);
  const existing = await db.get("SELECT * FROM certificate_templates WHERE id=? AND madrasa_id=?", [id, tid]);
  if (!existing) return err(res, 404, "Certificate template not found.");
  const body = req.body || {};
  if (body.archived !== undefined) {
    const archivedAt = truthyFlag(body.archived) ? today() : null;
    await db.run("UPDATE certificate_templates SET archived_at=? WHERE id=? AND madrasa_id=?", [archivedAt, id, tid]);
    return ok(res, { ok: true, archivedAt });
  }
  const stored = await readTemplateConfig(existing);
  const merged = Object.assign({}, stored, body.config || {}, {
    title: body.title !== undefined ? body.title : stored.title,
    designKey: body.designKey || body.design_key || stored.designKey,
    type: body.type || stored.type,
  });
  const result = await writeTemplate(tid, req, { name: body.name !== undefined ? body.name : existing.name, type: body.type, config: merged }, existing);
  if (result.status) return err(res, result.status, result.error);
  await db.run(
    "UPDATE certificate_templates SET name=?, type=?, design_key=?, config=?, html_template='' WHERE id=? AND madrasa_id=?",
    [result.name, result.type, result.config.designKey, JSON.stringify(result.config), id, tid]
  );
  ok(res, { ok: true, config: result.config });
}));

/* ------------------------------ certificates ---------------------------- */
async function certificateRow(tid, id) {
  return db.get(`
    SELECT c.*, t.name AS template_name, t.type AS template_type, t.html_template, t.design_key, t.config AS template_config,
           s.first_name, s.middle_name, s.last_name, s.admission_no, s.student_code, s.class_id, s.session_id,
           s.photo_path, s.program, s.islamic_program, s.western_program, s.education_track, s.signature_path,
           cl.name_en AS class_name, a.label AS session_label,
           m.name_en AS institution_name, m.name_ar AS institution_name_ar, m.logo_path,
           m.motto_en, m.address, m.city, m.state_name, m.phone, m.category, m.brand_color, m.institution_type,
           m.head_name, m.head_title
    FROM certificates c
    JOIN certificate_templates t ON t.id=c.template_id AND t.madrasa_id=c.madrasa_id
    JOIN students s ON s.id=c.student_id AND s.madrasa_id=c.madrasa_id
    LEFT JOIN classes cl ON cl.id=s.class_id AND cl.madrasa_id=s.madrasa_id
    LEFT JOIN academic_sessions a ON a.id=s.session_id AND a.madrasa_id=s.madrasa_id
    JOIN madaris m ON m.id=c.madrasa_id
    WHERE c.id=? AND c.madrasa_id=?
  `, [id, tid]);
}

function certificateReference(row) {
  const year = String(row.issued_date || today()).slice(0, 4);
  return `CERT-${year}-${String(row.id).padStart(6, "0")}`;
}

/** Every fact the certificate can print, resolved from the student record. */
function certificateFacts(row, customFields) {
  const track = String(row.education_track || "").toLowerCase();
  const trackLabel = track === "both" ? "Islamic + Western" : track === "western" ? "Western / general" : track === "islamic" ? "Islamic education" : "";
  return {
    identifier: row.admission_no || row.student_code || "",
    class: row.class_name || "",
    session: row.session_label || "",
    term: customFields.term || "",
    program: [row.program, row.islamic_program, row.western_program].filter(Boolean).join(" · ") || "",
    track: trackLabel,
    result: customFields.result || "",
    date: dateLabel(row.issued_date),
    guardian: row.parent_name || "",
  };
}

function certificateValues(row, config, customFields, facts) {
  return {
    holder_name: studentName(row),
    student_name: studentName(row),
    name: studentName(row),
    identifier: facts.identifier,
    admission_no: row.admission_no || "",
    class: facts.class,
    session: facts.session,
    term: facts.term,
    date: facts.date,
    school: row.institution_name || "",
    program: facts.program,
    track: facts.track,
    result: facts.result,
    reference: certificateReference(row),
    award: config.award || "",
    custom_field_1: customFields.custom_field_1,
    custom_field_2: customFields.custom_field_2,
    custom_field_3: customFields.custom_field_3,
  };
}

function certificateUrl(req, code) {
  const path = `/verify/certificate/${code}`;
  const host = req.get("host");
  if (!host) return path;
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0];
  return `${proto}://${host}${path}`;
}

async function renderCertificate(row, req, { interactive = true } = {}) {
  const templateConfig = await readTemplateConfig({
    config: row.template_config,
    html_template: row.html_template,
    design_key: row.design_key,
    type: row.template_type,
  });
  // A certificate is a snapshot: the wording chosen when it was issued wins
  // over anything the template says today, otherwise editing a template would
  // silently rewrite documents people already hold.
  let own = null;
  const rawOwn = row.config;
  if (typeof rawOwn === "string" && rawOwn.trim()) { try { own = JSON.parse(rawOwn); } catch (e) { own = null; } } else if (rawOwn && typeof rawOwn === "object") own = rawOwn;
  const custom = normalizeCustomFields(row.custom_fields);
  const merged = certDesigns.normaliseConfig(Object.assign({}, templateConfig, own || {}, { customFields: custom }), { type: row.template_type });
  merged.signatories = await resolveSignatories(row.madrasa_id, merged.signatories);
  merged.photoPath = merged.showPhoto ? safeAssetPath(row.photo_path) : "";

  // term/result may have been typed at issue time (own.facts), stored in the
  // custom-fields blob, or left blank by an older record.
  const facts = certificateFacts(row, custom);
  // Whoever issued the certificate typed a term or a grade, so it prints — even
  // on a template saved before those facts were part of the default strip.
  for (const key of ["term", "result"]) {
    if (facts[key] && !merged.facts.includes(key)) merged.facts.push(key);
  }
  if (own && own.facts) {
    for (const key of certDesigns.FACTS.map((f) => f.key)) {
      if (own.facts[key]) facts[key] = cleanStr(own.facts[key], 120);
    }
  }
  const values = certificateValues(row, merged, custom, facts);
  const school = print.schoolIdentity(row);
  const verifyUrl = merged.showQr && row.verify_code ? certificateUrl(req, row.verify_code) : "";
  const rendered = certDesigns.renderCertificateDocument({
    school,
    config: merged,
    facts,
    values,
    ref: certificateReference(row),
    issued: dateLabel(row.issued_date),
    templateName: row.template_name,
    verifyUrl,
    forPreview: !interactive,
  });
  return print.printShell(`Certificate — ${studentName(row)}`, certDesigns.CERTIFICATE_CSS, rendered.markup, {
    interactive,
    badge: merged.title || row.template_name || "Certificate",
  });
}

/** Live preview used by the editor: sample school data, no print bar. */
async function renderTemplatePreview(req, tid, configInput, type) {
  const madrasa = await db.get(`SELECT name_en AS institution_name, name_ar AS institution_name_ar, logo_path, badge_path,
      motto_en, address, city, state_name, phone, category, brand_color, institution_type, head_name, head_title
      FROM madaris WHERE id = ?`, [tid]);
  if (!madrasa) return null;
  const school = print.schoolIdentity(madrasa);
  const config = certDesigns.normaliseConfig(configInput, { type });
  // Signatory signatures resolve here too, exactly as they do at print time:
  // a school choosing who signs has to see the actual ink, not an empty line.
  config.signatories = await resolveSignatories(tid, config.signatories);
  const facts = certDesigns.previewFacts();
  const values = {
    holder_name: "Amina Yusuf", student_name: "Amina Yusuf", identifier: facts.identifier, admission_no: facts.identifier,
    class: facts.class, session: facts.session, term: facts.term, date: dateLabel(today()), school: school.name,
    program: facts.program, track: "Islamic + Western", result: facts.result, reference: `CERT-${today().slice(0, 4)}-000001`,
    award: config.award, custom_field_1: "Outstanding character", custom_field_2: "Principal's Award", custom_field_3: "",
  };
  const rendered = certDesigns.renderCertificateDocument({
    school,
    config: Object.assign(config, { photoPath: "" }),
    facts,
    values,
    ref: values.reference,
    issued: values.date,
    templateName: "Preview",
    verifyUrl: "",
    forPreview: true,
  });
  return print.printShell("Certificate preview", certDesigns.CERTIFICATE_CSS, rendered.markup, { interactive: false });
}

router.post(["/templates/preview", "/certificate-templates/preview"], ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const body = req.body || {};
  if (String(body.html_template || "").length > MAX_TEMPLATE_LENGTH) return err(res, 400, "Certificate wording is too long.");
  // The preview accepts the same shape the form posts, so the editor can send
  // its live form state straight through without a save first.
  const rendered = await renderTemplatePreview(req, tid, body.config || body, body.type || "custom");
  if (!rendered) return err(res, 404, "Madrasa not found.");
  res.set("Cache-Control", "no-store");
  res.type("html").send(rendered);
}));

router.get(["/templates/preview/:id", "/certificate-templates/preview/:id"], ADMIN, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const template = await db.get("SELECT * FROM certificate_templates WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!template) return err(res, 404, "Certificate template not found.");
  const config = await readTemplateConfig(template);
  const rendered = await renderTemplatePreview(req, tid, config, config.type);
  if (!rendered) return err(res, 404, "Madrasa not found.");
  res.set("Cache-Control", "no-store");
  res.type("html").send(rendered);
}));

function normalizeCustomFields(value) {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch (_) { source = {}; }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) source = {};
  const out = {};
  for (let i = 1; i <= 3; i++) out[`custom_field_${i}`] = cleanStr(source[`custom_field_${i}`] ?? source[String(i)] ?? "", MAX_CUSTOM_FIELD_LENGTH);
  // `term` and `result` are ordinary certificate facts, kept beside the
  // custom fields rather than in a second column.
  out.term = cleanStr(source.term, 80);
  out.result = cleanStr(source.result, 80);
  return out;
}

router.post("/certificates", ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const templateId = toNum(b.template_id, 0);
  const template = await db.get("SELECT id, type, config, design_key, html_template FROM certificate_templates WHERE id=? AND madrasa_id=? AND archived_at IS NULL", [templateId, tid]);
  if (!template) return err(res, 400, "Active certificate template not found.");
  let ids = Array.isArray(b.student_ids) ? b.student_ids : (b.student_id !== undefined ? [b.student_id] : []);
  ids = [...new Set(ids.map((id) => toNum(id, 0)).filter((id) => id > 0))];
  if (!ids.length) return err(res, 400, "At least one student_id is required.");
  const issuedDate = b.issued_date === undefined || b.issued_date === "" ? today() : validDate(b.issued_date);
  if (!issuedDate) return err(res, 400, "issued_date must be YYYY-MM-DD.");
  const customFields = normalizeCustomFields(Object.assign({}, b.custom_fields, { term: b.term ?? (b.custom_fields || {}).term, result: b.result ?? (b.custom_fields || {}).result }));
  const ownConfig = b.overrides && typeof b.overrides === "object"
    ? certDesigns.normaliseConfig(Object.assign({}, b.overrides, { customFields }), { type: template.type, designKey: template.design_key })
    : null;
  const students = [];
  for (const id of ids) {
    const row = await db.get("SELECT id FROM students WHERE id=? AND madrasa_id=?", [id, tid]);
    if (!row) return err(res, 400, "One or more students were not found in this madrasa.");
    students.push(row.id);
  }
  const created = await db.transaction(async (tx) => {
    const out = [];
    for (const id of students) {
      // The code is minted here, not at print time, so re-issuing the same
      // certificate keeps the QR that may already be in someone's hand.
      const verifyCode = crypto.randomBytes(12).toString("hex");
      const r = await tx.run(
        "INSERT INTO certificates (madrasa_id,student_id,template_id,custom_fields,issued_date,verify_code,config) VALUES (?,?,?,?,?,?,?)",
        [tid, id, templateId, JSON.stringify(customFields), issuedDate, verifyCode, ownConfig ? JSON.stringify(ownConfig) : null]
      );
      out.push({ id: Number(r.lastInsertRowid), verifyCode });
    }
    return out;
  });
  for (const row of created) logActivity(db, { madrasaId: tid, userId: req.user.id, action: "certificate.issue", entity: "certificate", entityId: String(row.id), meta: { templateId, issuedDate }, ip: req.ip });
  ok(res, { ok: true, id: created[0].id, ids: created.map((row) => row.id), verifyCode: created[0].verifyCode, verifyUrl: certificateUrl(req, created[0].verifyCode) });
}));

router.get("/certificates", STAFF, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const where = ["c.madrasa_id=?"]; const params = [tid];
  if (req.query.studentId !== undefined) { const studentId = toNum(req.query.studentId, 0); if (!studentId) return err(res, 400, "studentId must be a valid id."); where.push("c.student_id=?"); params.push(studentId); }
  const rows = await db.all(`SELECT c.id,c.madrasa_id,c.student_id,c.template_id,c.custom_fields,c.issued_date,c.verify_code,c.created_at,
        t.name AS template_name,t.type AS template_type,t.design_key,
        s.first_name,s.middle_name,s.last_name,s.admission_no
      FROM certificates c
      JOIN certificate_templates t ON t.id=c.template_id AND t.madrasa_id=c.madrasa_id
      JOIN students s ON s.id=c.student_id AND s.madrasa_id=c.madrasa_id
      WHERE ${where.join(" AND ")} ORDER BY c.issued_date DESC,c.id DESC LIMIT 500`, params);
  ok(res, {
    certificates: rows.map((row) => Object.assign({}, row, {
      student_name: studentName(row),
      designName: (certDesigns.designByKey(row.design_key) || {}).name || "Heritage Classic",
      verifyUrl: row.verify_code ? certificateUrl(req, row.verify_code) : "",
    })),
  });
}));

router.get("/certificates/:id", STAFF, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await certificateRow(tid, toNum(req.params.id, 0));
  if (!row) return res.status(404).type("html").send("Certificate not found");
  if (!await assertTeacherCanSee(req, res, tid, row)) return;
  res.type("html").send(await renderCertificate(row, req, { interactive: true }));
}));

/* --------------------------- signature capture ---------------------------
   A signature is a picture of a person's handwriting, stored on their own
   account. The pad in the browser sends a PNG data URL; an upload is also
   accepted for people who sign on paper and photograph it.
-------------------------------------------------------------------------- */
const signatureUploader = imageUploader("signatures", "signature");

router.post("/my-signature", STAFF, signatureUploader, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  if (!req.file) return err(res, 400, "No signature image was received.");
  const signaturePath = `/uploads/signatures/${req.file.filename}`;
  await db.run("UPDATE users SET signature_path = ? WHERE id = ? AND madrasa_id = ?", [signaturePath, req.user.id, tid]);
  if (req.user.role === "teacher") {
    await db.run("UPDATE teacher_profiles SET signature_path = ? WHERE user_id = ? AND madrasa_id = ?", [signaturePath, req.user.id, tid]);
  }
  ok(res, { ok: true, signaturePath });
}));

/* -------------------------- card verification (staff) -------------------
   The dashboard scanner uses this; the public page lives in routes/public.js.
   Same projection, but it also says which class/department so office staff can
   match a physical card against the register.
-------------------------------------------------------------------------- */
router.get("/verify-card/:code", STAFF, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const code = cardCreds.normaliseCode(req.params.code);
  if (!code) return err(res, 400, "Enter or scan the code printed on the card.");
  const result = await cardCreds.lookupCard(code);
  if (!result || Number(result.madrasa_id || result.credential.madrasa_id) !== tid) return err(res, 404, "No card matches that code in your school.");
  const view = cardCreds.cardVerificationView(result);
  const studentExtra = view.holderType === "student"
    ? await db.get("SELECT parent_name, parent_phone, class_id FROM students WHERE id=? AND madrasa_id=?", [result.credential.holder_id, tid])
    : await db.get("SELECT position, department, email FROM teacher_profiles p JOIN users u ON u.id=p.user_id AND u.madrasa_id=p.madrasa_id WHERE p.user_id=? AND p.madrasa_id=?", [result.credential.holder_id, tid]);
  ok(res, { card: Object.assign(view, { contact: studentExtra || {} }) });
}));

/* ------------------------ signatures of the school -----------------------
   Three things live here: whose signature a document prints (the institution
   choice), the picture of it, and a directory the template editor uses to
   offer "print the signature of…" as a dropdown rather than a paste box.
-------------------------------------------------------------------------- */
const SIGNATORY_KEY = "document_signatory";

router.get("/signatories", STAFF, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const rows = await db.all(
    `SELECT u.id, u.full_name, u.role, u.signature_path, p.position, p.department, p.staff_id,
            p.first_name, p.middle_name, p.last_name
       FROM users u
       LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
      WHERE u.madrasa_id = ? AND u.is_active = 1 AND u.role IN ('madrasa_admin','teacher','super_admin')
      ORDER BY (u.role = 'madrasa_admin') DESC, u.full_name, u.id`,
    [tid]
  );
  const people = rows.map((row) => ({
    id: row.id,
    name: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" ").trim() || row.full_name || "",
    role: row.role,
    title: [row.position, row.department].filter(Boolean).join(" · "),
    staffId: row.staff_id || "",
    hasSignature: Boolean(safeAssetPath(row.signature_path)),
    signaturePath: safeAssetPath(row.signature_path),
  }));
  const setting = await db.get("SELECT value FROM settings WHERE madrasa_id = ? AND key_name = ?", [tid, SIGNATORY_KEY]);
  let stored = null;
  if (setting && setting.value) { try { stored = JSON.parse(String(setting.value)); } catch (e) { stored = null; } }
  const school = await db.get("SELECT head_name, head_title FROM madaris WHERE id = ?", [tid]);
  ok(res, {
    people,
    signatory: {
      principalUserId: Number((stored && stored.principalUserId) || 0) || null,
      principalName: (stored && stored.principalName) || (school && school.head_name) || "",
      principalTitle: (stored && stored.principalTitle) || (school && school.head_title) || "",
    },
  });
}));

router.put("/signatories", ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const value = {
    principalUserId: b.principalUserId ? toNum(b.principalUserId, 0) : null,
    principalName: cleanStr(b.principalName, 120),
    principalTitle: cleanStr(b.principalTitle, 80),
  };
  if (value.principalUserId) {
    const account = await db.get("SELECT id FROM users WHERE id = ? AND madrasa_id = ? AND is_active = 1", [value.principalUserId, tid]);
    if (!account) return err(res, 400, "The chosen signatory does not belong to this school.");
  }
  const existing = await db.get("SELECT id FROM settings WHERE madrasa_id = ? AND key_name = ?", [tid, SIGNATORY_KEY]);
  if (existing) await db.run("UPDATE settings SET value = ? WHERE id = ?", [JSON.stringify(value), existing.id]);
  else await db.run("INSERT INTO settings (madrasa_id, key_name, value) VALUES (?,?,?)", [tid, SIGNATORY_KEY, JSON.stringify(value)]);
  ok(res, { ok: true, signatory: value });
}));

router.put("/my-signature", STAFF, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  let signaturePath = "";
  if (b.signatureDataUrl || b.dataUrl) {
    signaturePath = await media.saveDataUrl(b.signatureDataUrl || b.dataUrl, "signatures", { maxBytes: media.MAX_SIGNATURE_BYTES });
  } else if (typeof b.signaturePath === "string" && b.signaturePath === "") {
    // Clear it.
    await db.run("UPDATE users SET signature_path = '' WHERE id = ? AND madrasa_id = ?", [req.user.id, tid]);
    if (req.user.role === "teacher") await db.run("UPDATE teacher_profiles SET signature_path = '' WHERE user_id = ? AND madrasa_id = ?", [req.user.id, tid]);
    return ok(res, { ok: true, signaturePath: "" });
  } else {
    return err(res, 400, "Draw or upload a signature first.");
  }
  const previous = await db.get("SELECT signature_path FROM users WHERE id = ? AND madrasa_id = ?", [req.user.id, tid]);
  await db.run("UPDATE users SET signature_path = ? WHERE id = ? AND madrasa_id = ?", [signaturePath, req.user.id, tid]);
  if (req.user.role === "teacher") {
    await db.run("UPDATE teacher_profiles SET signature_path = ? WHERE user_id = ? AND madrasa_id = ?", [signaturePath, req.user.id, tid]);
  }
  if (previous && previous.signature_path) media.deleteStored(previous.signature_path);
  ok(res, { ok: true, signaturePath });
}));

/* --------------------------- the card registry ---------------------------
   Which cards exist, whether they are still live, and how often they have
  been printed. This is what the ID-card screen shows so "revoking a lost
   card" is a button rather than a support ticket.
-------------------------------------------------------------------------- */
router.get("/cards", STAFF, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const holderType = req.query.holderType === "teacher" || req.query.holderType === "staff" ? "teacher" : "student";
  if (holderType === "teacher") {
    const rows = await db.all(`
      SELECT u.id, u.full_name, u.role, u.is_active,
             COALESCE(NULLIF(p.photo_path, ''), u.photo_path, '') AS photo_path,
             p.first_name, p.middle_name, p.last_name, p.staff_id, p.position, p.department, p.status,
             cc.code, cc.status AS card_status, cc.print_count, cc.issued_at, cc.last_printed_at
        FROM users u
        LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
        LEFT JOIN card_credentials cc ON cc.madrasa_id = u.madrasa_id AND cc.holder_type = 'teacher' AND cc.holder_id = u.id
       WHERE u.madrasa_id = ? AND u.role IN ('teacher','madrasa_admin') AND u.is_active = 1
       ORDER BY COALESCE(NULLIF(p.last_name, ''), u.full_name), u.id LIMIT 500`, [tid]);
    return ok(res, { holderType, cards: rows.map((row) => ({
      id: row.id,
      name: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" ").trim() || row.full_name || "",
      identifier: row.staff_id || "",
      role: row.position || STAFF_ROLE_LABELS[row.role] || "Staff",
      detail: row.department || "",
      hasPhoto: Boolean(safeAssetPath(row.photo_path)),
      holderStatus: row.status || (Number(row.is_active) === 1 ? "active" : "inactive"),
      cardCode: row.code || "",
      cardStatus: row.card_status || "not-issued",
      printCount: Number(row.print_count || 0),
      issuedAt: row.issued_at || row.last_printed_at || "",
    })) });
  }
  const rows = await db.all(`
    SELECT s.id, s.admission_no, s.first_name, s.middle_name, s.last_name, s.photo_path, s.status,
           c.name_en AS class_name,
           cc.code, cc.status AS card_status, cc.print_count, cc.issued_at, cc.last_printed_at
      FROM students s
      LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id
      LEFT JOIN card_credentials cc ON cc.madrasa_id = s.madrasa_id AND cc.holder_type = 'student' AND cc.holder_id = s.id
     WHERE s.madrasa_id = ? AND s.status NOT IN ('withdrawn','inactive')
     ORDER BY s.last_name, s.first_name, s.id LIMIT 500`, [tid]);
  ok(res, { holderType, cards: rows.map((row) => ({
    id: row.id,
    name: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" "),
    identifier: row.admission_no || "",
    role: "Student",
    detail: row.class_name || "",
    hasPhoto: Boolean(safeAssetPath(row.photo_path)),
    holderStatus: row.status,
    cardCode: row.code || "",
    cardStatus: row.card_status || "not-issued",
    printCount: Number(row.print_count || 0),
    issuedAt: row.issued_at || row.last_printed_at || "",
  })) });
}));

module.exports = router;
module.exports._private = {
  documentTheme: print.documentTheme,
  idCardFrontMarkup: cardDesigns.idCardFront,
  idCardBackMarkup: cardDesigns.idCardBack,
  qrSvg: print.qrSvg,
  readTemplateConfig,
  renderCertificate,
  renderTemplatePreview,
  normalizeCustomFields,
  signedProfileUrl,
  certificateReference,
};
