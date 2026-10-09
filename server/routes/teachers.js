"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — Teacher management routes
   ----------------------------------------------------------------------------
   Teachers remain authenticated users (`users.role = 'teacher'`). The added
   teacher_profiles/documents/application tables complete the professional
   admin workspace without creating an isolated teacher system.
   ========================================================================== */
const express = require("express");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const config = require("../config");
const {
  asyncHandler, err, ok, cleanStr, toNum, validPhone, validEmail, validDate,
  logActivity, checkPlanLimits,
} = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { requirePermission } = require("../services/permissions");
const { effectiveTenantId, getTeacherAssignments } = require("../middleware/tenant");
const { imageUploader, fileUploader } = require("../middleware/upload");
const staff = require("../services/staff");

const router = express.Router();
router.use(requireAuth, requireTenant);

const ADMIN = requireRole("madrasa_admin", "super_admin");
const STAFF_READ = requireRole("madrasa_admin", "teacher", "super_admin");

const TEACHER_STATUSES = new Set(["active", "inactive", "on_leave", "suspended", "archived"]);
const APPLICATION_STATUSES = new Set(["pending", "under_review", "shortlisted", "interviewed", "accepted", "rejected"]);
const TRACKS = new Set(["islamic", "western", "both"]);

const teacherPhotoUploader = imageUploader("teacher-photos", "photo");
const teacherDocumentUploader = fileUploader("teacher-files", "document", {
  dir: path.join(config.DATA_DIR, "private-teacher-documents"),
  extensions: [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".doc", ".docx", ".txt"],
  maxMb: 10,
});
const applicationDocumentUploader = fileUploader("teacher-application-files", "document", {
  dir: path.join(config.DATA_DIR, "private-teacher-documents"),
  extensions: [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".doc", ".docx", ".txt"],
  maxMb: 10,
});

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required." }); return null; }
  return tid;
}

function normalizeTrack(v) {
  const s = cleanStr(v, 20).toLowerCase();
  return TRACKS.has(s) ? s : "both";
}
function normalizeTeacherStatus(v, fallback = "active") {
  const s = cleanStr(v, 30).toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "onleave") return "on_leave";
  return TEACHER_STATUSES.has(s) ? s : fallback;
}
function normalizeAppStatus(v, fallback = "pending") {
  const s = cleanStr(v, 30).toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "approved") return "accepted";
  if (s === "on_hold" || s === "hold" || s === "needs_info" || s === "requested_info") return "under_review";
  return APPLICATION_STATUSES.has(s) ? s : fallback;
}
function displayStatus(v) {
  return normalizeTeacherStatus(v, "inactive");
}
function userActiveForStatus(status) {
  return ["active", "on_leave"].includes(status) ? 1 : 0;
}
function arr(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === "") return [];
  if (typeof v === "string") {
    try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) return parsed; } catch (_) { /* plain comma string */ }
    return v.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [v];
}
function jsonOrNull(v) {
  const a = arr(v).map((x) => cleanStr(x, 80)).filter(Boolean);
  return a.length ? JSON.stringify(a) : null;
}
function splitName(full) {
  const parts = cleanStr(full, 160).split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", middle: parts.length > 2 ? parts.slice(1, -1).join(" ") : "", last: parts.length > 1 ? parts[parts.length - 1] : "" };
}
function fullNameFrom(b, fallback = "") {
  const explicit = cleanStr(b.full_name, 160);
  if (explicit) return explicit;
  return [b.first_name, b.middle_name, b.last_name].map((x) => cleanStr(x, 100)).filter(Boolean).join(" ").trim() || cleanStr(fallback, 160);
}
function parsePositiveInt(v, max = 999) {
  const n = Math.max(0, Math.min(max, toNum(v, 0)));
  return Number.isFinite(n) ? n : 0;
}
function dateOrNull(value, label, res) {
  if (value === undefined || value === null || value === "") return null;
  const d = validDate(value);
  if (!d) { err(res, 400, `Invalid ${label} (use YYYY-MM-DD).`); return undefined; }
  return d;
}
function appPublic(row) {
  const status = normalizeAppStatus(row.status, "pending");
  const name = fullNameFrom(row, row.full_name);
  return Object.assign({}, row, {
    status,
    full_name: name,
    application_id: row.application_id || (row.id ? `TAPP-${String(row.id).padStart(5, "0")}` : ""),
  });
}

async function ensureApplicationRefs(tid) {
  const rows = await db.all("SELECT id FROM teacher_applications WHERE madrasa_id = ? AND (application_id IS NULL OR application_id = '')", [tid]);
  for (const row of rows) {
    await db.run("UPDATE teacher_applications SET application_id = ? WHERE id = ? AND madrasa_id = ?", [`TAPP-${String(row.id).padStart(5, "0")}`, row.id, tid]);
  }
}

async function ensureProfileForUser(tid, user, api = db) {
  const existing = await api.get("SELECT * FROM teacher_profiles WHERE madrasa_id = ? AND user_id = ?", [tid, user.id]);
  if (existing) return existing;
  const pieces = splitName(user.full_name || user.username || "Teacher");
  const generated = await staff.nextStaffId(tid, api);
  await api.run(
    `INSERT INTO teacher_profiles (madrasa_id, user_id, staff_id, first_name, middle_name, last_name, status, education_track)
     VALUES (?,?,?,?,?,?,?,?)`,
    [tid, user.id, generated.staffId, pieces.first, pieces.middle, pieces.last, user.is_active ? "active" : "inactive", "both"]
  );
  return api.get("SELECT * FROM teacher_profiles WHERE madrasa_id = ? AND user_id = ?", [tid, user.id]);
}

async function ensureProfilesForTenant(tid) {
  const users = await db.all("SELECT id, username, full_name, is_active FROM users WHERE madrasa_id = ? AND role = 'teacher'", [tid]);
  for (const user of users) await ensureProfileForUser(tid, user);
}

async function classById(tid, classId, api = db) {
  if (!classId) return null;
  return api.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
}
async function subjectById(tid, subjectId, api = db) {
  if (!subjectId) return null;
  return api.get("SELECT id FROM subjects WHERE id = ? AND madrasa_id = ?", [subjectId, tid]);
}
async function sessionById(tid, sessionId, api = db) {
  if (!sessionId) return null;
  return api.get("SELECT id FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sessionId, tid]);
}

async function insertIgnoreRow(api, table, columns, values) {
  if (typeof api.insertIgnore === "function") return api.insertIgnore(table, columns, values);
  const dialect = typeof api.dialect === "string" ? api.dialect : await db.dialect();
  const verb = dialect === "sqlite" ? "INSERT OR IGNORE" : "INSERT IGNORE";
  return api.run(`${verb} INTO ${table} (${columns}) VALUES (${values.map(() => "?").join(",")})`, values);
}

async function assignmentExists(api, tid, userId, classId, subjectId) {
  const classSql = classId ? "class_id = ?" : "class_id IS NULL";
  const subjectSql = subjectId ? "subject_id = ?" : "subject_id IS NULL";
  const params = [tid, userId];
  if (classId) params.push(classId);
  if (subjectId) params.push(subjectId);
  return api.get(`SELECT id FROM teacher_assignments WHERE madrasa_id = ? AND user_id = ? AND ${classSql} AND ${subjectSql}`, params);
}

async function validateAssignments(tid, assignments) {
  if (assignments === undefined) return null;
  if (!Array.isArray(assignments)) return "Assignments must be a list.";
  for (const raw of assignments) {
    if (!raw) continue;
    const classId = raw.class_id || raw.classId ? toNum(raw.class_id || raw.classId, 0) : null;
    const subjectId = raw.subject_id || raw.subjectId ? toNum(raw.subject_id || raw.subjectId, 0) : null;
    const sessionId = raw.academic_session_id || raw.session_id ? toNum(raw.academic_session_id || raw.session_id, 0) : null;
    if (classId && !await classById(tid, classId)) return "Unknown class in assignment.";
    if (subjectId && !await subjectById(tid, subjectId)) return "Unknown subject in assignment.";
    if (sessionId && !await sessionById(tid, sessionId)) return "Unknown academic session in assignment.";
  }
  return null;
}

async function addAssignment(api, tid, userId, raw) {
  const classId = raw.class_id || raw.classId ? toNum(raw.class_id || raw.classId, 0) : null;
  const subjectId = raw.subject_id || raw.subjectId ? toNum(raw.subject_id || raw.subjectId, 0) : null;
  if (classId && !await classById(tid, classId, api)) throw new Error("Unknown class in assignment.");
  if (subjectId && !await subjectById(tid, subjectId, api)) throw new Error("Unknown subject in assignment.");
  const sessionId = raw.academic_session_id || raw.session_id ? toNum(raw.academic_session_id || raw.session_id, 0) : null;
  if (sessionId && !await sessionById(tid, sessionId, api)) throw new Error("Unknown academic session in assignment.");
  const role = cleanStr(raw.role, 40) || "subject_teacher";
  const assignedPeriods = raw.assigned_periods === undefined ? null : (Array.isArray(raw.assigned_periods) ? JSON.stringify(raw.assigned_periods) : cleanStr(raw.assigned_periods, 500));
  const notes = cleanStr(raw.notes, 500);
  if (classId && subjectId) await insertIgnoreRow(api, "class_subjects", "madrasa_id, class_id, subject_id", [tid, classId, subjectId]);
  const existing = await assignmentExists(api, tid, userId, classId, subjectId);
  if (existing) {
    await api.run("UPDATE teacher_assignments SET role = ?, academic_session_id = ?, assigned_periods = ?, notes = ? WHERE id = ? AND madrasa_id = ?", [role, sessionId, assignedPeriods, notes, existing.id, tid]);
    return existing.id;
  }
  const r = await api.run(
    `INSERT INTO teacher_assignments (madrasa_id, user_id, class_id, subject_id, role, academic_session_id, assigned_periods, notes, created_at)
     VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    [tid, userId, classId, subjectId, role, sessionId, assignedPeriods, notes]
  );
  return r.lastInsertRowid;
}

/** assignments: [{ class_id, subject_id?, role? }] (subject_id optional) */
async function setAssignments(tid, userId, assignments, api = db) {
  if (!Array.isArray(assignments)) return;
  await api.run("DELETE FROM teacher_assignments WHERE madrasa_id = ? AND user_id = ?", [tid, userId]);
  for (const raw of assignments) {
    if (!raw) continue;
    await addAssignment(api, tid, userId, raw);
  }
}

async function assignmentsFor(tid, userId) {
  return db.all(
    `SELECT ta.*, c.name_en AS class_name, c.name_ar AS class_name_ar, c.class_code,
            s.name_en AS subject_name, s.name_ar AS subject_name_ar, sess.label AS session_label
       FROM teacher_assignments ta
       LEFT JOIN classes c ON c.id = ta.class_id AND c.madrasa_id = ta.madrasa_id
       LEFT JOIN subjects s ON s.id = ta.subject_id AND s.madrasa_id = ta.madrasa_id
       LEFT JOIN academic_sessions sess ON sess.id = ta.academic_session_id
      WHERE ta.madrasa_id = ? AND ta.user_id = ?
      ORDER BY c.sort_order, c.name_en, s.name_en`,
    [tid, userId]
  );
}

function assignmentDto(a) {
  return {
    id: Number(a.id),
    classId: a.class_id ? Number(a.class_id) : null,
    subjectId: a.subject_id ? Number(a.subject_id) : null,
    role: a.role || "subject_teacher",
    assignedPeriods: a.assigned_periods || "",
    notes: a.notes || "",
    sessionId: a.academic_session_id ? Number(a.academic_session_id) : null,
    sessionLabel: a.session_label || "",
    class: a.class_id ? { id: Number(a.class_id), name_en: a.class_name || "", name_ar: a.class_name_ar || "", class_code: a.class_code || "" } : null,
    subject: a.subject_id ? { id: Number(a.subject_id), name_en: a.subject_name || "", name_ar: a.subject_name_ar || "" } : null,
  };
}

function teacherDto(row, assignments = []) {
  const first = row.first_name || splitName(row.full_name).first;
  const last = row.last_name || splitName(row.full_name).last;
  const computedName = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" ").trim();
  const status = displayStatus(row.status || (row.is_active ? "active" : "inactive"));
  return Object.assign({}, row, {
    id: Number(row.id),
    user_id: Number(row.id),
    profile_id: row.profile_id ? Number(row.profile_id) : null,
    first_name: first,
    middle_name: row.middle_name || "",
    last_name: last,
    full_name: computedName || row.full_name || "",
    email: row.email || "",
    phone: row.phone || "",
    staff_id: row.staff_id || "",
    photo_path: row.photo_path || "",
    // A teacher's certificate/card signature: their own profile first, then
    // the account-level one set from any device.
    signature_path: row.signature_path || row.account_signature_path || "",
    hasSignature: Boolean(row.signature_path || row.account_signature_path),
    public_display: Number(row.public_display) === 1,
    public_bio: row.public_bio || "",
    public_subjects: row.public_subjects || "",
    status,
    education_track: normalizeTrack(row.education_track),
    is_active: Number(row.is_active) === 1,
    assignments: assignments.map(assignmentDto),
    subjects: assignments.filter((a) => a.subject_id).map((a) => ({ id: Number(a.subject_id), name_en: a.subject_name || "", name_ar: a.subject_name_ar || "" })),
    classes: assignments.filter((a) => a.class_id).map((a) => ({ id: Number(a.class_id), name_en: a.class_name || "", name_ar: a.class_name_ar || "" })),
  });
}

async function loadTeacher(tid, id, res) {
  const user = await db.get(
    `SELECT u.*, p.id AS profile_id, p.staff_id, p.first_name, p.middle_name, p.last_name, p.photo_path, p.signature_path,
            p.gender, p.date_of_birth, p.nationality, p.state_name, p.lga, p.residential_address,
            p.alternative_phone, p.emergency_contact, p.emergency_relationship, p.employment_date,
            p.employment_type, p.position, p.department, p.education_track, p.qualifications,
            p.certifications, p.specialization, p.years_experience, p.academic_session_id,
            p.available_days, p.available_periods, p.employment_history, p.professional_development,
            p.awards, p.training, p.achievements, p.public_display, p.public_bio, p.public_subjects, p.status, p.source_application_id, p.archived_at,
            p.created_at AS profile_created_at, p.updated_at AS profile_updated_at
       FROM users u LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
      WHERE u.id = ? AND u.madrasa_id = ? AND u.role = 'teacher'`,
    [toNum(id, 0), tid]
  );
  if (!user) { if (res) err(res, 404, "Teacher not found."); return null; }
  if (!user.profile_id) await ensureProfileForUser(tid, user);
  const refreshed = user.profile_id ? user : await db.get(
    `SELECT u.*, p.id AS profile_id, p.staff_id, p.first_name, p.middle_name, p.last_name, p.photo_path, p.signature_path,
            p.gender, p.date_of_birth, p.nationality, p.state_name, p.lga, p.residential_address,
            p.alternative_phone, p.emergency_contact, p.emergency_relationship, p.employment_date,
            p.employment_type, p.position, p.department, p.education_track, p.qualifications,
            p.certifications, p.specialization, p.years_experience, p.academic_session_id,
            p.available_days, p.available_periods, p.employment_history, p.professional_development,
            p.awards, p.training, p.achievements, p.public_display, p.public_bio, p.public_subjects, p.status, p.source_application_id, p.archived_at,
            p.created_at AS profile_created_at, p.updated_at AS profile_updated_at
       FROM users u LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
      WHERE u.id = ? AND u.madrasa_id = ? AND u.role = 'teacher'`, [toNum(id, 0), tid]);
  return refreshed;
}

/* ------------------------------ stats ---------------------------------- */

router.get("/stats", requirePermission("teachers.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  await ensureProfilesForTenant(tid);
  const row = await db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN COALESCE(p.status, CASE WHEN u.is_active = 1 THEN 'active' ELSE 'inactive' END) = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN COALESCE(p.education_track, 'both') IN ('islamic','both') THEN 1 ELSE 0 END) AS islamic,
            SUM(CASE WHEN COALESCE(p.education_track, 'both') IN ('western','both') THEN 1 ELSE 0 END) AS western,
            SUM(CASE WHEN COALESCE(p.status, '') = 'on_leave' THEN 1 ELSE 0 END) AS on_leave
       FROM users u LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
      WHERE u.madrasa_id = ? AND u.role = 'teacher' AND COALESCE(p.status, '') <> 'archived'`,
    [tid]
  );
  ok(res, {
    total: Number(row.total || 0), active: Number(row.active || 0), islamic: Number(row.islamic || 0),
    western: Number(row.western || 0), onLeave: Number(row.on_leave || 0),
  });
}));

/* ------------------------------ list ----------------------------------- */

router.get("/", requirePermission("teachers.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  await ensureProfilesForTenant(tid);

  const search = cleanStr(req.query.search || req.query.q, 100).toLowerCase();
  const page = Math.max(1, toNum(req.query.page, 1));
  const perPage = Math.min(200, Math.max(1, toNum(req.query.perPage, 50)));
  const offset = (page - 1) * perPage;
  const where = ["u.madrasa_id = ?", "u.role = 'teacher'"];
  const params = [tid];
  const status = cleanStr(req.query.status, 20).toLowerCase();
  if (status) { where.push("COALESCE(p.status, CASE WHEN u.is_active = 1 THEN 'active' ELSE 'inactive' END) = ?"); params.push(normalizeTeacherStatus(status, status)); }
  else { where.push("COALESCE(p.status, '') <> 'archived'"); }
  if (search) {
    where.push(`(LOWER(u.full_name) LIKE ? OR LOWER(u.username) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(u.phone) LIKE ? OR LOWER(COALESCE(p.staff_id,'')) LIKE ? OR LOWER(COALESCE(p.position,'')) LIKE ? OR LOWER(COALESCE(p.department,'')) LIKE ?)`);
    const like = `%${search}%`; params.push(like, like, like, like, like, like, like);
  }
  for (const [queryName, column, max] of [
    ["department", "p.department", 120], ["education_track", "p.education_track", 20], ["employment_type", "p.employment_type", 60], ["gender", "p.gender", 20], ["position", "p.position", 120],
  ]) {
    if (req.query[queryName]) { where.push(`${column} = ?`); params.push(cleanStr(req.query[queryName], max)); }
  }
  if (req.query.classId || req.query.class_id) {
    where.push("EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.madrasa_id = u.madrasa_id AND ta.user_id = u.id AND ta.class_id = ?)");
    params.push(toNum(req.query.classId || req.query.class_id, 0));
  }
  if (req.query.subjectId || req.query.subject_id) {
    where.push("EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.madrasa_id = u.madrasa_id AND ta.user_id = u.id AND ta.subject_id = ?)");
    params.push(toNum(req.query.subjectId || req.query.subject_id, 0));
  }

  const sortMap = {
    name: "u.full_name", staff: "p.staff_id", staffId: "p.staff_id", department: "p.department",
    position: "p.position", status: "p.status", employmentDate: "p.employment_date", newest: "u.created_at",
  };
  const sort = sortMap[cleanStr(req.query.sort, 30)] || "u.full_name";
  const direction = cleanStr(req.query.direction, 4).toLowerCase() === "desc" ? "DESC" : "ASC";
  const total = await db.get(`SELECT COUNT(*) AS n FROM users u LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id WHERE ${where.join(" AND ")}`, params);
  const rows = await db.all(
    `SELECT u.id, u.username, u.full_name, u.full_name_ar, u.email, u.phone, u.is_active, u.created_at,
            p.id AS profile_id, p.staff_id, p.first_name, p.middle_name, p.last_name,
            COALESCE(NULLIF(p.photo_path, ''), u.photo_path) AS photo_path,
            COALESCE(NULLIF(p.signature_path, ''), u.signature_path) AS signature_path,
            p.gender, p.date_of_birth, p.nationality, p.state_name, p.lga, p.residential_address,
            p.alternative_phone, p.emergency_contact, p.emergency_relationship, p.employment_date,
            p.employment_type, p.position, p.department, p.education_track, p.qualifications,
            p.certifications, p.specialization, p.years_experience, p.academic_session_id,
            p.available_days, p.available_periods, p.employment_history, p.professional_development,
            p.awards, p.training, p.achievements, p.public_display, p.public_bio, p.public_subjects, p.status, p.source_application_id, p.archived_at,
            p.created_at AS profile_created_at, p.updated_at AS profile_updated_at
       FROM users u LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${sort} ${direction}, u.id DESC LIMIT ? OFFSET ?`,
    params.concat([perPage, offset])
  );
  const subs = await db.all("SELECT * FROM subjects WHERE madrasa_id = ? ORDER BY name_en", [tid]);
  const classes = await db.all("SELECT * FROM classes WHERE madrasa_id = ? AND COALESCE(status,'active') <> 'archived' ORDER BY sort_order, name_en", [tid]);
  const teachers = [];
  for (const row of rows) teachers.push(teacherDto(row, await assignmentsFor(tid, row.id)));
  const stats = await db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN COALESCE(p.status, CASE WHEN u.is_active = 1 THEN 'active' ELSE 'inactive' END) = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN COALESCE(p.education_track, 'both') IN ('islamic','both') THEN 1 ELSE 0 END) AS islamic,
            SUM(CASE WHEN COALESCE(p.education_track, 'both') IN ('western','both') THEN 1 ELSE 0 END) AS western,
            SUM(CASE WHEN COALESCE(p.status, '') = 'on_leave' THEN 1 ELSE 0 END) AS on_leave
       FROM users u LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
      WHERE u.madrasa_id = ? AND u.role = 'teacher' AND COALESCE(p.status, '') <> 'archived'`, [tid]);
  ok(res, {
    teachers, classes, subjects: subs, total: Number(total.n || 0), page, perPage,
    totalPages: Math.max(1, Math.ceil(Number(total.n || 0) / perPage)),
    stats: { total: Number(stats.total || 0), active: Number(stats.active || 0), islamic: Number(stats.islamic || 0), western: Number(stats.western || 0), onLeave: Number(stats.on_leave || 0) },
  });
}));

/* ------------------------- recruitment applications --------------------- */

router.get("/applications", requirePermission("teachers.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  await ensureApplicationRefs(tid);
  const status = cleanStr(req.query.status, 30).toLowerCase();
  const q = cleanStr(req.query.search || req.query.q, 100).toLowerCase();
  const page = Math.max(1, toNum(req.query.page, 1));
  const perPage = Math.min(200, Math.max(1, toNum(req.query.perPage, 50)));
  const offset = (page - 1) * perPage;
  const where = ["madrasa_id = ?", "archived_at IS NULL"];
  const params = [tid];
  if (status) {
    const normalized = normalizeAppStatus(status, status);
    if (normalized === "accepted") { where.push("status IN ('accepted','approved')"); }
    else if (normalized === "under_review") { where.push("status IN ('under_review','on_hold')"); }
    else { where.push("status = ?"); params.push(normalized); }
  }
  if (req.query.position) { where.push("position_applied = ?"); params.push(cleanStr(req.query.position, 120)); }
  if (req.query.education_track) { where.push("education_track = ?"); params.push(normalizeTrack(req.query.education_track)); }
  if (q) {
    where.push("(LOWER(full_name) LIKE ? OR LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(phone) LIKE ? OR LOWER(position_applied) LIKE ? OR LOWER(application_id) LIKE ?)");
    const like = `%${q}%`; params.push(like, like, like, like, like, like, like);
  }
  const total = await db.get(`SELECT COUNT(*) AS n FROM teacher_applications WHERE ${where.join(" AND ")}`, params);
  const rows = await db.all(`SELECT * FROM teacher_applications WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`, params.concat([perPage, offset]));
  ok(res, { applications: rows.map(appPublic), total: Number(total.n || 0), page, perPage, totalPages: Math.max(1, Math.ceil(Number(total.n || 0) / perPage)) });
}));

router.post("/applications", requirePermission("teachers.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const b = req.body || {};
  const fullName = fullNameFrom(b);
  if (!fullName) return err(res, 400, "Applicant name is required.");
  if (b.phone && !validPhone(b.phone)) return err(res, 400, "Invalid phone number.");
  if (!validEmail(b.email)) return err(res, 400, "Invalid email address.");
  const appDate = dateOrNull(b.application_date || new Date().toISOString().slice(0, 10), "application date", res); if (appDate === undefined) return;
  const r = await db.run(
    `INSERT INTO teacher_applications (
      madrasa_id, application_id, full_name, first_name, middle_name, last_name, email, phone, message, status,
      application_date, position_applied, subjects_specialization, qualifications, certifications, specialization,
      experience_years, education_track, employment_type, contact_details, documents_summary, interview_date,
      interview_time, interview_location, interview_panel, interview_notes, review_note, requested_information, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    [
      tid, "", fullName, cleanStr(b.first_name, 100) || splitName(fullName).first, cleanStr(b.middle_name, 100) || splitName(fullName).middle,
      cleanStr(b.last_name, 100) || splitName(fullName).last, cleanStr(b.email, 120), cleanStr(b.phone, 60), cleanStr(b.message, 5000), normalizeAppStatus(b.status),
      appDate, cleanStr(b.position_applied || b.position, 120), cleanStr(b.subjects_specialization || b.specialization_subjects, 5000), cleanStr(b.qualifications, 5000),
      cleanStr(b.certifications, 5000), cleanStr(b.specialization, 200), parsePositiveInt(b.experience_years || b.years_experience, 80), normalizeTrack(b.education_track),
      cleanStr(b.employment_type, 60), cleanStr(b.contact_details, 2000), cleanStr(b.documents_summary, 2000), validDate(b.interview_date) || null,
      cleanStr(b.interview_time, 5), cleanStr(b.interview_location, 160), cleanStr(b.interview_panel, 255), cleanStr(b.interview_notes, 5000), cleanStr(b.review_note, 2000), cleanStr(b.requested_information, 3000),
    ]
  );
  const applicationId = `TAPP-${String(r.lastInsertRowid).padStart(5, "0")}`;
  await db.run("UPDATE teacher_applications SET application_id = ? WHERE id = ? AND madrasa_id = ?", [applicationId, r.lastInsertRowid, tid]);
  await db.run("INSERT INTO teacher_application_history (madrasa_id, application_id, from_status, to_status, note, changed_by) VALUES (?,?,?,?,?,?)", [tid, r.lastInsertRowid, null, normalizeAppStatus(b.status), "Application created", req.user.id]);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "teacher_application.create", entity: "teacher_application", entityId: String(r.lastInsertRowid), ip: req.ip });
  ok(res, { ok: true, id: r.lastInsertRowid, applicationId });
}));

async function loadApplication(req, res, id) {
  const tid = await tenantId(req, res); if (tid == null) return null;
  const app = await db.get("SELECT * FROM teacher_applications WHERE id = ? AND madrasa_id = ?", [toNum(id, 0), tid]);
  if (!app) { err(res, 404, "Teacher application not found."); return null; }
  return app;
}

router.get("/applications/:id", requirePermission("teachers.view"), asyncHandler(async (req, res) => {
  const app = await loadApplication(req, res, req.params.id); if (!app) return;
  const [history, documents, teacher] = await Promise.all([
    db.all("SELECT * FROM teacher_application_history WHERE madrasa_id = ? AND application_id = ? ORDER BY id DESC", [app.madrasa_id, app.id]),
    db.all("SELECT id, document_type, document_name, original_name, mime_type, file_size, created_at FROM teacher_application_documents WHERE madrasa_id = ? AND application_id = ? ORDER BY id DESC", [app.madrasa_id, app.id]),
    app.teacher_user_id ? db.get("SELECT id, full_name, email, phone FROM users WHERE id = ? AND madrasa_id = ?", [app.teacher_user_id, app.madrasa_id]) : null,
  ]);
  ok(res, { application: appPublic(app), history, documents, teacher });
}));

router.patch("/applications/:id", requirePermission("teachers.edit"), asyncHandler(async (req, res) => {
  const app = await loadApplication(req, res, req.params.id); if (!app) return;
  const b = req.body || {};
  const status = b.status !== undefined ? normalizeAppStatus(b.status, app.status) : normalizeAppStatus(app.status);
  const interviewDate = b.interview_date !== undefined ? dateOrNull(b.interview_date, "interview date", res) : undefined; if (interviewDate === undefined && b.interview_date !== undefined) return;
  const sets = ["status = ?", "updated_at = CURRENT_TIMESTAMP"];
  const vals = [status];
  const fields = {
    full_name: [fullNameFrom(b, app.full_name), 160], first_name: [b.first_name, 100], middle_name: [b.middle_name, 100], last_name: [b.last_name, 100],
    email: [b.email, 120], phone: [b.phone, 60], message: [b.message, 5000], position_applied: [b.position_applied, 120],
    subjects_specialization: [b.subjects_specialization, 5000], qualifications: [b.qualifications, 5000], certifications: [b.certifications, 5000],
    specialization: [b.specialization, 200], employment_type: [b.employment_type, 60], contact_details: [b.contact_details, 2000],
    documents_summary: [b.documents_summary, 2000], interview_time: [b.interview_time, 5], interview_location: [b.interview_location, 160],
    interview_panel: [b.interview_panel, 255], interview_notes: [b.interview_notes, 5000], review_note: [b.review_note || b.review_notes, 2000],
    requested_information: [b.requested_information, 3000],
  };
  for (const [field, [value, max]] of Object.entries(fields)) if (value !== undefined) { sets.push(`${field} = ?`); vals.push(cleanStr(value, max)); }
  if (b.phone && !validPhone(b.phone)) return err(res, 400, "Invalid phone number.");
  if (!validEmail(b.email)) return err(res, 400, "Invalid email address.");
  if (b.experience_years !== undefined || b.years_experience !== undefined) { sets.push("experience_years = ?"); vals.push(parsePositiveInt(b.experience_years || b.years_experience, 80)); }
  if (b.education_track !== undefined) { sets.push("education_track = ?"); vals.push(normalizeTrack(b.education_track)); }
  if (b.application_date !== undefined) { const d = dateOrNull(b.application_date, "application date", res); if (d === undefined) return; sets.push("application_date = ?"); vals.push(d); }
  if (b.interview_date !== undefined) { sets.push("interview_date = ?"); vals.push(interviewDate); }
  sets.push("reviewed_by = ?", "reviewed_at = CURRENT_TIMESTAMP"); vals.push(req.user.id);
  vals.push(app.id, app.madrasa_id);
  await db.transaction(async (tx) => {
    await tx.run(`UPDATE teacher_applications SET ${sets.join(", ")} WHERE id = ? AND madrasa_id = ?`, vals);
    if (normalizeAppStatus(app.status) !== status) await tx.run("INSERT INTO teacher_application_history (madrasa_id, application_id, from_status, to_status, note, changed_by) VALUES (?,?,?,?,?,?)", [app.madrasa_id, app.id, normalizeAppStatus(app.status), status, cleanStr(b.review_note || b.note || b.requested_information, 2000), req.user.id]);
  });
  logActivity(db, { madrasaId: app.madrasa_id, userId: req.user.id, action: "teacher_application." + status, entity: "teacher_application", entityId: String(app.id), ip: req.ip });
  ok(res, { ok: true, status });
}));

async function convertApplication(req, res) {
  const app = await loadApplication(req, res, req.params.id); if (!app) return;
  if (app.teacher_user_id) return err(res, 400, "This application has already been converted to a teacher.");
  const b = req.body || {};
  const limitCheck = await checkPlanLimits(db, app.madrasa_id, "teacher");
  if (!limitCheck.allowed) return err(res, 403, limitCheck.message, { limit: limitCheck.limit, count: limitCheck.count });
  const fullName = fullNameFrom(app, app.full_name);
  const generated = await staff.nextStaffId(app.madrasa_id);
  const staffId = cleanStr(b.staff_id || generated.staffId, 60).toUpperCase();
  if (await db.get("SELECT id FROM teacher_profiles WHERE madrasa_id = ? AND staff_id = ?", [app.madrasa_id, staffId])) return err(res, 400, "That Staff ID is already in use.");
  const assignmentError = await validateAssignments(app.madrasa_id, b.assignments || []);
  if (assignmentError) return err(res, 400, assignmentError);
  const username = cleanStr(b.username, 100).toLowerCase() || await staff.uniqueUsername(staffId || fullName);
  const password = String(b.password || "") || staff.temporaryPassword();
  if (!/^[a-z0-9_.-]{3,}$/.test(username)) return err(res, 400, "Username must be 3+ chars (letters, numbers, dot, dash, underscore).");
  if (password.length < 8) return err(res, 400, "Password must be at least 8 characters.");
  if (await db.get("SELECT id FROM users WHERE username = ?", [username])) return err(res, 400, "That username is already taken.");
  let teacherId = 0;
  await db.transaction(async (tx) => {
    const user = await tx.run(
      "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, email, phone) VALUES (?,?,?,?,?,?,?)",
      [app.madrasa_id, username, await bcrypt.hash(password, 10), "teacher", fullName, app.email || "", app.phone || ""]
    );
    teacherId = user.lastInsertRowid;
    await tx.run(
      `INSERT INTO teacher_profiles (
        madrasa_id, user_id, staff_id, first_name, middle_name, last_name, gender, nationality, employment_date,
        employment_type, position, department, education_track, qualifications, certifications, specialization,
        years_experience, status, source_application_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        app.madrasa_id, teacherId, staffId, app.first_name || splitName(fullName).first, app.middle_name || splitName(fullName).middle,
        app.last_name || splitName(fullName).last, "", "", validDate(b.employment_date) || new Date().toISOString().slice(0, 10),
        app.employment_type || cleanStr(b.employment_type, 60), app.position_applied || cleanStr(b.position, 120), cleanStr(b.department, 120),
        normalizeTrack(app.education_track), app.qualifications || "", app.certifications || "", app.specialization || app.subjects_specialization || "",
        parsePositiveInt(app.experience_years, 80), "active", app.id,
      ]
    );
    await setAssignments(app.madrasa_id, teacherId, Array.isArray(b.assignments) ? b.assignments : [], tx);
    const docs = await tx.all("SELECT * FROM teacher_application_documents WHERE madrasa_id = ? AND application_id = ?", [app.madrasa_id, app.id]);
    for (const doc of docs) {
      await tx.run("INSERT INTO teacher_documents (madrasa_id, user_id, document_type, document_name, storage_path, original_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)", [app.madrasa_id, teacherId, doc.document_type, doc.document_name, doc.storage_path, doc.original_name, doc.mime_type, doc.file_size, doc.uploaded_by || req.user.id]);
    }
    await tx.run("UPDATE teacher_applications SET status = 'accepted', review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, teacher_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [cleanStr(b.review_note || app.review_note, 2000), req.user.id, teacherId, app.id]);
    if (normalizeAppStatus(app.status) !== "accepted") await tx.run("INSERT INTO teacher_application_history (madrasa_id, application_id, from_status, to_status, note, changed_by) VALUES (?,?,?,?,?,?)", [app.madrasa_id, app.id, normalizeAppStatus(app.status), "accepted", "Converted to teacher", req.user.id]);
  });
  logActivity(db, { madrasaId: app.madrasa_id, userId: req.user.id, action: "teacher_application.convert", entity: "teacher_application", entityId: String(app.id), meta: { teacherId, staffId }, ip: req.ip });
  ok(res, { ok: true, teacherId, staffId, username, tempPassword: b.password ? undefined : password });
}

router.post("/applications/:id/convert", ADMIN, asyncHandler(convertApplication));
/** Backward-compatible alias used by older dashboard code/tests. */
router.post("/applications/:id/approve", ADMIN, asyncHandler(convertApplication));

router.post("/applications/:id/documents", ADMIN, applicationDocumentUploader, asyncHandler(async (req, res) => {
  const app = await loadApplication(req, res, req.params.id); if (!app) return;
  if (!req.file) return err(res, 400, "No document uploaded.");
  const name = cleanStr(req.body && req.body.document_name, 200) || cleanStr(req.file.originalname, 200);
  const type = cleanStr(req.body && req.body.document_type, 60) || "other";
  const r = await db.run("INSERT INTO teacher_application_documents (madrasa_id, application_id, document_type, document_name, storage_path, original_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)", [app.madrasa_id, app.id, type, name, req.file.path, cleanStr(req.file.originalname, 255), cleanStr(req.file.mimetype, 120), Number(req.file.size || 0), req.user.id]);
  ok(res, { ok: true, id: r.lastInsertRowid, documentName: name });
}));

router.get("/applications/:id/documents/:documentId", ADMIN, asyncHandler(async (req, res) => {
  const app = await loadApplication(req, res, req.params.id); if (!app) return;
  const doc = await db.get("SELECT * FROM teacher_application_documents WHERE id = ? AND application_id = ? AND madrasa_id = ?", [toNum(req.params.documentId, 0), app.id, app.madrasa_id]);
  if (!doc || !fs.existsSync(doc.storage_path)) return err(res, 404, "Document not found.");
  res.download(doc.storage_path, doc.original_name || doc.document_name);
}));

/* ------------------------------ create --------------------------------- */

router.post("/", requirePermission("teachers.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const b = req.body || {};
  const fullName = fullNameFrom(b);
  const pieces = { first: cleanStr(b.first_name, 100), middle: cleanStr(b.middle_name, 100), last: cleanStr(b.last_name, 100) };
  if (!fullName || !pieces.first) return err(res, 400, "First name and full teacher name are required.");
  if (b.phone && !validPhone(b.phone)) return err(res, 400, "Invalid phone number.");
  if (b.alternative_phone && !validPhone(b.alternative_phone)) return err(res, 400, "Invalid alternative phone number.");
  if (!validEmail(b.email)) return err(res, 400, "Invalid email address.");
  const dob = dateOrNull(b.date_of_birth, "date of birth", res); if (dob === undefined) return;
  const employmentDate = dateOrNull(b.employment_date || new Date().toISOString().slice(0, 10), "employment date", res); if (employmentDate === undefined) return;
  const limitCheck = await checkPlanLimits(db, tid, "teacher");
  if (!limitCheck.allowed) return err(res, 403, limitCheck.message, { limit: limitCheck.limit, count: limitCheck.count });

  const generated = await staff.nextStaffId(tid);
  const staffId = cleanStr(b.staff_id || generated.staffId, 60).toUpperCase();
  if (await db.get("SELECT id FROM teacher_profiles WHERE madrasa_id = ? AND staff_id = ?", [tid, staffId])) return err(res, 400, "That Staff ID is already in use.");
  const username = cleanStr(b.username, 100).toLowerCase() || await staff.uniqueUsername(staffId || fullName);
  const password = String(b.password || "") || staff.temporaryPassword();
  if (!/^[a-z0-9_.-]{3,}$/.test(username)) return err(res, 400, "Username must be 3+ chars (letters, numbers, dot, dash, underscore).");
  if (password.length < 8) return err(res, 400, "Password must be at least 8 characters.");
  if (await db.get("SELECT id FROM users WHERE username = ?", [username])) return err(res, 400, "That username is already taken.");
  const sessionId = b.academic_session_id ? toNum(b.academic_session_id, 0) : null;
  if (sessionId && !await sessionById(tid, sessionId)) return err(res, 400, "Unknown academic session.");
  const assignmentError = await validateAssignments(tid, b.assignments || []);
  if (assignmentError) return err(res, 400, assignmentError);
  const status = normalizeTeacherStatus(b.status, "active");
  let teacherId = 0;
  await db.transaction(async (tx) => {
    const u = await tx.run(
      "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, full_name_ar, email, phone, is_active) VALUES (?,?,?,?,?,?,?,?,?)",
      [tid, username, await bcrypt.hash(password, 10), "teacher", fullName, cleanStr(b.full_name_ar, 160), cleanStr(b.email, 120), cleanStr(b.phone, 60), userActiveForStatus(status)]
    );
    teacherId = u.lastInsertRowid;
    await tx.run(
      `INSERT INTO teacher_profiles (
        madrasa_id, user_id, staff_id, first_name, middle_name, last_name, gender, date_of_birth, nationality, state_name, lga,
        residential_address, alternative_phone, emergency_contact, emergency_relationship, employment_date, employment_type,
        position, department, education_track, qualifications, certifications, specialization, years_experience,
        academic_session_id, available_days, available_periods, employment_history, professional_development, awards,
        training, achievements, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tid, teacherId, staffId, pieces.first, pieces.middle, pieces.last, cleanStr(b.gender, 20), dob, cleanStr(b.nationality, 80), cleanStr(b.state_name || b.state, 80), cleanStr(b.lga, 80),
        cleanStr(b.residential_address || b.address, 255), cleanStr(b.alternative_phone, 60), cleanStr(b.emergency_contact, 160), cleanStr(b.emergency_relationship || b.emergency_contact_relationship, 80),
        employmentDate, cleanStr(b.employment_type, 60), cleanStr(b.position, 120), cleanStr(b.department, 120), normalizeTrack(b.education_track),
        cleanStr(b.qualifications, 5000), cleanStr(b.certifications, 5000), cleanStr(b.specialization, 200), parsePositiveInt(b.years_experience, 80),
        sessionId, jsonOrNull(b.available_days), cleanStr(b.available_periods, 1000), cleanStr(b.employment_history, 5000), cleanStr(b.professional_development, 5000),
        cleanStr(b.awards, 5000), cleanStr(b.training, 5000), cleanStr(b.achievements, 5000), status,
      ]
    );
    await setAssignments(tid, teacherId, Array.isArray(b.assignments) ? b.assignments : [], tx);
  });
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "teacher.create", entity: "user", entityId: String(teacherId), meta: { staffId }, ip: req.ip });
  ok(res, { ok: true, id: teacherId, staffId, username, tempPassword: b.password ? undefined : password });
}));

/* --------------------------- teacher dashboard --------------------------- */

/**
 * GET /api/teachers/dashboard
 * One aggregate for the teacher workspace: today's timetable, assigned
 * classes/subjects with student counts, attendance still unmarked today,
 * assignments awaiting grading, results awaiting entry/correction, recent
 * announcements and upcoming calendar events. Every query is scoped to the
 * teacher's own assignments inside their own tenant.
 */
router.get("/dashboard", requireRole("teacher", "madrasa_admin"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const scope = await getTeacherAssignments(tid, req.user.id);
  const classIds = scope.anyClassAnySubject
    ? (await db.all("SELECT id FROM classes WHERE madrasa_id = ? AND is_active = 1", [tid])).map((c) => Number(c.id))
    : [...scope.assignedClassIds];
  const classes = classIds.length
    ? await db.all(`SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.madrasa_id = c.madrasa_id AND s.class_id = c.id AND s.status IN ('active','promoted','suspended')) AS student_count
                     FROM classes c WHERE c.madrasa_id = ? AND c.id IN (${classIds.map(() => "?").join(",")}) ORDER BY c.sort_order, c.name_en`, [tid].concat(classIds))
    : [];
  const subjectRows = scope.anyClassAnySubject
    ? await db.all("SELECT * FROM subjects WHERE madrasa_id = ? AND is_active = 1 ORDER BY name_en", [tid])
    : await db.all(
      `SELECT DISTINCT sub.* FROM subjects sub
        JOIN teacher_assignments ta ON ta.subject_id = sub.id AND ta.madrasa_id = sub.madrasa_id
       WHERE sub.madrasa_id = ? AND ta.user_id = ? AND sub.is_active = 1 ORDER BY sub.name_en`,
      [tid, req.user.id]
    );
  const today = new Date().toISOString().slice(0, 10);
  const dayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getUTCDay()];

  const todaySlots = await db.all(
    `SELECT ts.period, ts.start_time, ts.end_time, ts.room, c.name_en AS class_name, c.id AS class_id,
            sub.name_en AS subject_name, sub.name_ar AS subject_ar
       FROM timetable_slots ts
       JOIN classes c ON c.id = ts.class_id AND c.madrasa_id = ts.madrasa_id
       LEFT JOIN subjects sub ON sub.id = ts.subject_id
      WHERE ts.madrasa_id = ? AND ts.teacher_id = ? AND ts.day = ?
      ORDER BY ts.period`,
    [tid, req.user.id, dayName]
  );

  // Classes with no attendance register yet today (only for classes that meet
  // today, i.e. have a timetable slot for this teacher).
  const classesToday = [...new Set(todaySlots.map((s) => Number(s.class_id)))];
  let attendancePending = [];
  if (classesToday.length) {
    const marks = classesToday.map(() => "?").join(",");
    const marked = await db.all(`SELECT DISTINCT class_id FROM attendance WHERE madrasa_id = ? AND day = ? AND class_id IN (${marks})`, [tid, today].concat(classesToday));
    const markedSet = new Set(marked.map((m) => Number(m.class_id)));
    attendancePending = classesToday.filter((c) => !markedSet.has(c));
  }

  // Assignments with ungraded submissions (teacher's own assignments).
  const assignmentsPending = await db.all(
    `SELECT h.id, h.title, h.due_date, c.name_en AS class_name, sub.name_en AS subject_name,
            (SELECT COUNT(*) FROM assignment_submissions x WHERE x.madrasa_id = h.madrasa_id AND x.assignment_id = h.id AND x.score IS NULL) AS ungraded
       FROM homework h
       LEFT JOIN classes c ON c.id = h.class_id AND c.madrasa_id = h.madrasa_id
       LEFT JOIN subjects sub ON sub.id = h.subject_id AND sub.madrasa_id = h.madrasa_id
      WHERE h.madrasa_id = ? AND h.kind = 'assignment' AND h.status = 'published'
        AND (h.teacher_id = ? OR (h.teacher_id IS NULL AND h.created_by = ?))
        AND EXISTS (SELECT 1 FROM assignment_submissions x2 WHERE x2.madrasa_id = h.madrasa_id AND x2.assignment_id = h.id AND x2.score IS NULL)
      ORDER BY h.due_date IS NULL, h.due_date LIMIT 10`,
    [tid, req.user.id, req.user.id]
  );

  // Result workflow counts for this teacher's class-subject pairs. Bounded by
  // the current term so the counters reflect live work, not all history.
  let resultCounts = { draft: 0, submitted: 0, returned: 0, approved: 0, published: 0 };
  const pairList = scope.anyClassAnySubject ? [] : [...scope.classSubjects].map((k) => k.split(":").map(Number));
  if (scope.anyClassAnySubject || pairList.length) {
    const currentTerm = await db.get(
      `SELECT t.id FROM terms t JOIN academic_sessions s ON s.id = t.session_id
        WHERE t.madrasa_id = ? ORDER BY s.is_current DESC, s.id DESC, t.position DESC LIMIT 1`,
      [tid]
    );
    if (currentTerm) {
      const where = ["r.madrasa_id = ?", "r.term_id = ?", "(r.entered_by = ? OR r.modified_by = ?)"];
      const params = [tid, currentTerm.id, req.user.id, req.user.id];
      if (!scope.anyClassAnySubject && pairList.length) {
        where.push("( " + pairList.map(() => "(r.class_id = ? AND r.subject_id = ?)").join(" OR ") + " )");
        for (const [cid, sid] of pairList) params.push(cid, sid);
      } else if (!scope.anyClassAnySubject) {
        where.length = 0; // no assignments → nothing to count
      }
      if (where.length) {
        const grouped = await db.all(`SELECT r.status, COUNT(*) AS n FROM results r WHERE ${where.join(" AND ")} GROUP BY r.status`, params);
        for (const row of grouped) if (resultCounts[row.status] !== undefined) resultCounts[row.status] = Number(row.n);
      }
    }
  }

  const [announcements, events, unread] = await Promise.all([
    db.all("SELECT id, title, body, created_at FROM announcements WHERE madrasa_id = ? AND is_active = 1 AND status = 'published' AND (audience = 'all' OR audience = 'teachers' OR target_type IN ('all','teachers','staff')) ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT 5", [tid]),
    db.all("SELECT id, title, event_type, start_date, end_date, start_time, end_time, location FROM calendar_events WHERE madrasa_id = ? AND status = 'published' AND COALESCE(end_date, start_date) >= ? AND audience IN ('all','teachers','staff') ORDER BY start_date, start_time LIMIT 6", [tid, today]),
    db.get("SELECT COUNT(*) AS n FROM notifications WHERE madrasa_id = ? AND recipient_user_id = ? AND read_at IS NULL", [tid, req.user.id]),
  ]);

  const nextSlot = todaySlots.find((s) => s.start_time && s.start_time >= new Date().toISOString().slice(11, 16)) || null;

  ok(res, {
    teacher: { id: req.user.id, fullName: req.user.fullName },
    today, todayName: dayName,
    classes,
    subjects: subjectRows,
    todaySlots,
    nextSlot,
    attendancePending,
    assignmentsPending,
    resultCounts,
    announcements,
    events,
    unreadNotifications: Number(unread.n || 0),
  });
}));

router.get("/:id", requirePermission("teachers.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await loadTeacher(tid, req.params.id, res); if (!row) return;
  if (req.user.role === "teacher" && Number(req.user.id) !== Number(row.id)) return err(res, 403, "Permission denied.");
  const assignments = await assignmentsFor(tid, row.id);
  const [documents, timetable, attendance, statusHistory, homework, messages, classTeacherOf, assistantOf] = await Promise.all([
    db.all("SELECT id, document_type, document_name, original_name, mime_type, file_size, created_at FROM teacher_documents WHERE madrasa_id = ? AND user_id = ? ORDER BY id DESC", [tid, row.id]),
    db.all(`SELECT ts.*, c.name_en AS class_name, s.name_en AS subject_name FROM timetable_slots ts LEFT JOIN classes c ON c.id = ts.class_id LEFT JOIN subjects s ON s.id = ts.subject_id WHERE ts.madrasa_id = ? AND ts.teacher_id = ? ORDER BY ts.day, ts.period`, [tid, row.id]),
    db.all("SELECT * FROM teacher_attendance WHERE madrasa_id = ? AND user_id = ? ORDER BY day DESC LIMIT 100", [tid, row.id]),
    db.all("SELECT * FROM teacher_status_history WHERE madrasa_id = ? AND user_id = ? ORDER BY id DESC LIMIT 50", [tid, row.id]),
    db.all("SELECT id, kind, title, class_id, subject_id, due_date, created_at FROM homework WHERE madrasa_id = ? AND created_by = ? ORDER BY id DESC LIMIT 100", [tid, row.id]),
    db.all("SELECT id, scope, body, created_at FROM messages WHERE madrasa_id = ? AND (user_id = ? OR author_name = ?) ORDER BY id DESC LIMIT 100", [tid, row.id, row.full_name || ""]),
    db.all("SELECT id, name_en, class_code FROM classes WHERE madrasa_id = ? AND class_teacher_id = ? AND COALESCE(status,'active') <> 'archived'", [tid, row.id]),
    db.all("SELECT id, name_en, class_code FROM classes WHERE madrasa_id = ? AND assistant_teacher_id = ? AND COALESCE(status,'active') <> 'archived'", [tid, row.id]),
  ]);
  const lessons = homework.filter((h) => h.kind === "lesson").length;
  const assignmentCount = homework.filter((h) => h.kind !== "lesson").length;
  ok(res, {
    teacher: teacherDto(row, assignments),
    assignments: assignments.map(assignmentDto), documents, timetable, attendance, statusHistory,
    academicResponsibilities: { lessons, assignments: assignmentCount, exams: 0, results: 0, attendanceResponsibilities: assignments.filter((a) => a.class_id).length },
    communication: messages, classTeacherOf, assistantOf,
  });
}));

/* ------------------------------ update --------------------------------- */

router.patch("/:id", requirePermission("teachers.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const u = await loadTeacher(tid, req.params.id, res);
  if (!u) return;
  const b = req.body || {};
  const userSets = [];
  const userVals = [];
  const profileSets = [];
  const profileVals = [];
  if (b.first_name !== undefined || b.middle_name !== undefined || b.last_name !== undefined || b.full_name !== undefined) {
    const fullName = fullNameFrom(b, u.full_name);
    if (!fullName) return err(res, 400, "Teacher name cannot be empty.");
    userSets.push("full_name = ?"); userVals.push(fullName);
    if (b.first_name !== undefined) { profileSets.push("first_name = ?"); profileVals.push(cleanStr(b.first_name, 100)); }
    if (b.middle_name !== undefined) { profileSets.push("middle_name = ?"); profileVals.push(cleanStr(b.middle_name, 100)); }
    if (b.last_name !== undefined) { profileSets.push("last_name = ?"); profileVals.push(cleanStr(b.last_name, 100)); }
  }
  if (b.full_name_ar !== undefined) { userSets.push("full_name_ar = ?"); userVals.push(cleanStr(b.full_name_ar, 160)); }
  if (b.email !== undefined) { if (!validEmail(b.email)) return err(res, 400, "Invalid email address."); userSets.push("email = ?"); userVals.push(cleanStr(b.email, 120)); }
  if (b.phone !== undefined) { if (b.phone && !validPhone(b.phone)) return err(res, 400, "Invalid phone number."); userSets.push("phone = ?"); userVals.push(cleanStr(b.phone, 60)); }
  if (b.password) { if (String(b.password).length < 8) return err(res, 400, "Password must be at least 8 characters."); userSets.push("password_hash = ?"); userVals.push(await bcrypt.hash(String(b.password), 10)); }
  const status = b.status !== undefined ? normalizeTeacherStatus(b.status, u.status || (u.is_active ? "active" : "inactive")) : (b.is_active !== undefined ? (b.is_active ? "active" : "inactive") : null);
  if (status) { profileSets.push("status = ?"); profileVals.push(status); profileSets.push("archived_at = ?"); profileVals.push(status === "archived" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null); userSets.push("is_active = ?"); userVals.push(userActiveForStatus(status)); }

  const profileFields = {
    gender: [b.gender, 20], nationality: [b.nationality, 80], state_name: [b.state_name || b.state, 80], lga: [b.lga, 80],
    residential_address: [b.residential_address || b.address, 255], alternative_phone: [b.alternative_phone, 60], emergency_contact: [b.emergency_contact, 160],
    emergency_relationship: [b.emergency_relationship || b.emergency_contact_relationship, 80], employment_type: [b.employment_type, 60],
    position: [b.position, 120], department: [b.department, 120], qualifications: [b.qualifications, 5000], certifications: [b.certifications, 5000],
    specialization: [b.specialization, 200], available_periods: [b.available_periods, 1000], employment_history: [b.employment_history, 5000],
    professional_development: [b.professional_development, 5000], awards: [b.awards, 5000], training: [b.training, 5000], achievements: [b.achievements, 5000],
    public_bio: [b.public_bio, 5000], public_subjects: [b.public_subjects, 500],
  };
  for (const [field, [value, max]] of Object.entries(profileFields)) if (value !== undefined) { profileSets.push(`${field} = ?`); profileVals.push(cleanStr(value, max)); }
  if (b.alternative_phone && !validPhone(b.alternative_phone)) return err(res, 400, "Invalid alternative phone number.");
  if (b.public_display !== undefined) { profileSets.push("public_display = ?"); profileVals.push(b.public_display === true || b.public_display === 1 || b.public_display === "1" ? 1 : 0); }
  if (b.education_track !== undefined) { profileSets.push("education_track = ?"); profileVals.push(normalizeTrack(b.education_track)); }
  if (b.years_experience !== undefined) { profileSets.push("years_experience = ?"); profileVals.push(parsePositiveInt(b.years_experience, 80)); }
  if (b.academic_session_id !== undefined) { const sid = b.academic_session_id ? toNum(b.academic_session_id, 0) : null; if (sid && !await sessionById(tid, sid)) return err(res, 400, "Unknown academic session."); profileSets.push("academic_session_id = ?"); profileVals.push(sid); }
  if (b.available_days !== undefined) { profileSets.push("available_days = ?"); profileVals.push(jsonOrNull(b.available_days)); }
  if (b.date_of_birth !== undefined) { const d = dateOrNull(b.date_of_birth, "date of birth", res); if (d === undefined) return; profileSets.push("date_of_birth = ?"); profileVals.push(d); }
  if (b.employment_date !== undefined) { const d = dateOrNull(b.employment_date, "employment date", res); if (d === undefined) return; profileSets.push("employment_date = ?"); profileVals.push(d); }
  if (b.staff_id !== undefined) {
    const staffId = cleanStr(b.staff_id, 60).toUpperCase();
    if (!staffId) return err(res, 400, "Staff ID cannot be empty.");
    const dup = await db.get("SELECT id FROM teacher_profiles WHERE madrasa_id = ? AND staff_id = ? AND user_id <> ?", [tid, staffId, u.id]);
    if (dup) return err(res, 400, "That Staff ID is already in use.");
    profileSets.push("staff_id = ?"); profileVals.push(staffId);
  }
  const assignmentError = b.assignments !== undefined ? await validateAssignments(tid, b.assignments) : null;
  if (assignmentError) return err(res, 400, assignmentError);

  await db.transaction(async (tx) => {
    if (userSets.length) await tx.run(`UPDATE users SET ${userSets.join(", ")} WHERE id = ? AND madrasa_id = ? AND role = 'teacher'`, userVals.concat([u.id, tid]));
    if (profileSets.length) await tx.run(`UPDATE teacher_profiles SET ${profileSets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND madrasa_id = ?`, profileVals.concat([u.id, tid]));
    if (b.assignments !== undefined) await setAssignments(tid, u.id, Array.isArray(b.assignments) ? b.assignments : [], tx);
    if (status && normalizeTeacherStatus(u.status || (u.is_active ? "active" : "inactive")) !== status) await tx.run("INSERT INTO teacher_status_history (madrasa_id, user_id, from_status, to_status, reason, changed_by) VALUES (?,?,?,?,?,?)", [tid, u.id, normalizeTeacherStatus(u.status || (u.is_active ? "active" : "inactive")), status, cleanStr(b.reason, 500), req.user.id]);
  });
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "teacher.update", entity: "user", entityId: String(u.id), ip: req.ip });
  ok(res, { ok: true });
}));

router.patch("/:id/status", requirePermission("teachers.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const t = await loadTeacher(tid, req.params.id, res); if (!t) return;
  const status = normalizeTeacherStatus(req.body && req.body.status, "active");
  await db.transaction(async (tx) => {
    await tx.run("UPDATE users SET is_active = ? WHERE id = ? AND madrasa_id = ?", [userActiveForStatus(status), t.id, tid]);
    await tx.run("UPDATE teacher_profiles SET status = ?, archived_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND madrasa_id = ?", [status, status === "archived" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, t.id, tid]);
    await tx.run("INSERT INTO teacher_status_history (madrasa_id, user_id, from_status, to_status, reason, changed_by) VALUES (?,?,?,?,?,?)", [tid, t.id, normalizeTeacherStatus(t.status || (t.is_active ? "active" : "inactive")), status, cleanStr(req.body && req.body.reason, 500), req.user.id]);
  });
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "teacher.status", entity: "user", entityId: String(t.id), meta: { status }, ip: req.ip });
  ok(res, { ok: true, status });
}));

router.post("/bulk-status", requirePermission("teachers.edit"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const ids = arr(req.body && req.body.teacher_ids).map((x) => toNum(x, 0)).filter(Boolean);
  const status = normalizeTeacherStatus(req.body && req.body.status, "active");
  if (!ids.length) return err(res, 400, "Select at least one teacher.");
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const id of ids) {
      const row = await tx.get("SELECT u.id, u.is_active, p.status FROM users u LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id WHERE u.id = ? AND u.madrasa_id = ? AND u.role = 'teacher'", [id, tid]);
      if (!row) continue;
      await tx.run("UPDATE users SET is_active = ? WHERE id = ? AND madrasa_id = ?", [userActiveForStatus(status), id, tid]);
      await tx.run("UPDATE teacher_profiles SET status = ?, archived_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND madrasa_id = ?", [status, status === "archived" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, id, tid]);
      await tx.run("INSERT INTO teacher_status_history (madrasa_id, user_id, from_status, to_status, reason, changed_by) VALUES (?,?,?,?,?,?)", [tid, id, normalizeTeacherStatus(row.status || (row.is_active ? "active" : "inactive")), status, cleanStr(req.body.reason, 500), req.user.id]);
      updated++;
    }
  });
  ok(res, { ok: true, updated });
}));

/* ------------------------------ photo & signature ----------------------
   A teacher's portrait is stored twice on purpose: teacher_profiles is the
   staff record the directory and the ID card read, users is what the portal top
   bar and every cross-module listing read. Writing both keeps them identical
   without a join at every read site. The account row is also written when the
   teacher themself calls this (a staff member fixing their own picture is not
   an administrative act), so `/:id` may equal the caller for teachers.
-------------------------------------------------------------------------- */
async function storeTeacherPortrait(req, res, tid, teacher, buffer) {
  const userId = Number(teacher.id);
  const previous = teacher.photo_path || "";
  const photoPath = await profileMedia.writeImage(buffer, "teacher-photos", { maxBytes: profileMedia.MAX_PHOTO_BYTES });
  await db.run("UPDATE teacher_profiles SET photo_path = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND madrasa_id = ?", [photoPath, userId, tid]);
  await db.run("UPDATE users SET photo_path = ? WHERE id = ? AND madrasa_id = ?", [photoPath, userId, tid]);
  if (previous) profileMedia.deleteStored(previous);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "teacher.photo.update", entity: "user", entityId: String(userId), ip: req.ip });
  ok(res, { ok: true, photoPath });
}

router.post("/:id/photo", (req, res, next) => {
  // Admin for anyone; a teacher may replace only their own portrait.
  if (req.user && req.user.role === "teacher" && Number(req.params.id) === Number(req.user.id)) return teacherPhotoUploader(req, res, next);
  return ADMIN(req, res, () => teacherPhotoUploader(req, res, next));
}, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const t = await loadTeacher(tid, req.params.id, res); if (!t) return;
  if (req.file) return storeTeacherPortrait(req, res, tid, t, fs.readFileSync(req.file.path));
  const dataUrl = (req.body && (req.body.photoDataUrl || req.body.dataUrl)) || "";
  if (!dataUrl) return err(res, 400, "No image uploaded.");
  return storeTeacherPortrait(req, res, tid, t, profileMedia.decodeDataUrl(dataUrl, { maxBytes: profileMedia.MAX_PHOTO_BYTES }));
}));

router.delete("/:id/photo", (req, res, next) => {
  if (req.user && req.user.role === "teacher" && Number(req.params.id) === Number(req.user.id)) return next();
  return ADMIN(req, res, next);
}, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const t = await loadTeacher(tid, req.params.id, res); if (!t) return;
  await db.run("UPDATE teacher_profiles SET photo_path = '', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND madrasa_id = ?", [t.id, tid]);
  await db.run("UPDATE users SET photo_path = '' WHERE id = ? AND madrasa_id = ?", [t.id, tid]);
  if (t.photo_path) profileMedia.deleteStored(t.photo_path);
  ok(res, { ok: true, photoPath: "" });
}));

/** Signature picture used on ID cards and certificates. Data URL or file. */
router.put("/:id/signature", (req, res, next) => {
  if (req.user && req.user.role === "teacher" && Number(req.params.id) === Number(req.user.id)) return next();
  return ADMIN(req, res, next);
}, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const t = await loadTeacher(tid, req.params.id, res); if (!t) return;
  const dataUrl = (req.body && (req.body.signatureDataUrl || req.body.dataUrl)) || "";
  if (!dataUrl) return err(res, 400, "Draw a signature first.");
  const signaturePath = await profileMedia.saveDataUrl(dataUrl, "signatures", { maxBytes: profileMedia.MAX_SIGNATURE_BYTES });
  await db.run("UPDATE teacher_profiles SET signature_path = ? WHERE user_id = ? AND madrasa_id = ?", [signaturePath, t.id, tid]);
  await db.run("UPDATE users SET signature_path = ? WHERE id = ? AND madrasa_id = ?", [signaturePath, t.id, tid]);
  if (t.signature_path) profileMedia.deleteStored(t.signature_path);
  ok(res, { ok: true, signaturePath });
}));

/**
 * Staff card details for the ID-card screen: the credential the printed QR
 * carries, its status and how many times it went to the printer.
 */
router.get("/:id/card", (req, res, next) => {
  if (req.user && req.user.role === "teacher" && Number(req.params.id) === Number(req.user.id)) return next();
  return requirePermission("teachers.view")(req, res, next);
}, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const t = await loadTeacher(tid, req.params.id, res); if (!t) return;
  const credential = await cardCreds.ensureCardCredential(tid, "teacher", Number(t.id));
  if (!credential) return err(res, 404, "Card not found.");
  ok(res, { credential: { code: credential.code, status: credential.status, printCount: Number(credential.print_count || 0), issuedAt: credential.issued_at || credential.created_at } });
}));

router.post("/:id/documents", ADMIN, teacherDocumentUploader, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const t = await loadTeacher(tid, req.params.id, res); if (!t) return;
  if (!req.file) return err(res, 400, "No document uploaded.");
  const name = cleanStr(req.body && req.body.document_name, 200) || cleanStr(req.file.originalname, 200);
  const type = cleanStr(req.body && req.body.document_type, 60) || "other";
  const r = await db.run("INSERT INTO teacher_documents (madrasa_id, user_id, document_type, document_name, storage_path, original_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)", [tid, t.id, type, name, req.file.path, cleanStr(req.file.originalname, 255), cleanStr(req.file.mimetype, 120), Number(req.file.size || 0), req.user.id]);
  ok(res, { ok: true, id: r.lastInsertRowid, documentName: name });
}));

router.get("/:id/documents/:documentId", STAFF_READ, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const t = await loadTeacher(tid, req.params.id, res); if (!t) return;
  if (req.user.role === "teacher" && Number(req.user.id) !== Number(t.id)) return err(res, 404, "Document not found.");
  const doc = await db.get("SELECT * FROM teacher_documents WHERE id = ? AND user_id = ? AND madrasa_id = ?", [toNum(req.params.documentId, 0), t.id, tid]);
  if (!doc || !fs.existsSync(doc.storage_path)) return err(res, 404, "Document not found.");
  res.download(doc.storage_path, doc.original_name || doc.document_name);
}));

router.delete("/:id/documents/:documentId", ADMIN, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const doc = await db.get("SELECT * FROM teacher_documents WHERE id = ? AND user_id = ? AND madrasa_id = ?", [toNum(req.params.documentId, 0), toNum(req.params.id, 0), tid]);
  if (!doc) return err(res, 404, "Document not found.");
  if (doc.storage_path && fs.existsSync(doc.storage_path)) fs.unlinkSync(doc.storage_path);
  await db.run("DELETE FROM teacher_documents WHERE id = ? AND madrasa_id = ?", [doc.id, tid]);
  ok(res, { ok: true });
}));

router.delete("/:id", requirePermission("teachers.delete"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const t = await loadTeacher(tid, req.params.id, res); if (!t) return;
  await db.transaction(async (tx) => {
    await tx.run("UPDATE users SET is_active = 0 WHERE id = ? AND madrasa_id = ?", [t.id, tid]);
    await tx.run("UPDATE teacher_profiles SET status = 'archived', archived_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND madrasa_id = ?", [new Date().toISOString().slice(0, 19).replace("T", " "), t.id, tid]);
    await tx.run("INSERT INTO teacher_status_history (madrasa_id, user_id, from_status, to_status, reason, changed_by) VALUES (?,?,?,?,?,?)", [tid, t.id, normalizeTeacherStatus(t.status || (t.is_active ? "active" : "inactive")), "archived", "Archived by administrator", req.user.id]);
  });
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "teacher.archive", entity: "user", entityId: String(t.id), ip: req.ip });
  ok(res, { ok: true });
}));

/* ------------------------------ teacher self-service ------------------- */

router.get("/me/assignments", requireRole("teacher"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;
  const scope = await getTeacherAssignments(tid, req.user.id);
  const classes = scope.anyClassAnySubject
    ? await db.all("SELECT * FROM classes WHERE madrasa_id = ? AND is_active = 1 ORDER BY sort_order", [tid])
    : await db.all("SELECT * FROM classes WHERE madrasa_id = ? AND id IN (" + (scope.assignedClassIds.size ? [...scope.assignedClassIds].map(() => "?").join(",") : "NULL") + ") ORDER BY sort_order", [tid].concat([...scope.assignedClassIds]));
  const subjects = await db.all("SELECT * FROM subjects WHERE madrasa_id = ? AND is_active = 1", [tid]);
  const subMap = new Map(subjects.map((s) => [s.id, s]));
  const rows = await db.all("SELECT * FROM teacher_assignments WHERE madrasa_id = ? AND user_id = ?", [tid, req.user.id]);
  ok(res, {
    classes,
    subjects: [...scope.classSubjects].map((k) => {
      const [c, s] = k.split(":").map(Number);
      return { classId: c, subject: subMap.get(s) };
    }),
    assignments: rows,
  });
}));

module.exports = router;
