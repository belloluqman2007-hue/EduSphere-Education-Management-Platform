"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — online admission applications (admin side)
   ----------------------------------------------------------------------------
   The public site writes rows into admission_requests (routes/public.js); this
   router is the review queue for a madrasa:

     GET    /api/admissions?status=pending&q=&page=
     GET    /api/admissions/:id
     POST   /api/admissions/:id/approve     → creates the student (+ optional
                                               parent / student portal accounts)
     POST   /api/admissions/:id/reject      → status + note
     POST   /api/admissions/:id/hold        → "on hold", with a note
     DELETE /api/admissions/:id             → discard the application only

   Isolation: a madrasa admin only ever sees their own rows (tenant id comes
   from the session). A super admin may list platform-wide or pass
   ?madrasaId=N to work inside one tenant.
   ========================================================================== */
const express = require("express");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const privateMedia = require("../services/private-media");
const config = require("../config");
const { asyncHandler, err, ok, cleanStr, toNum, logActivity, checkPlanLimits } = require("../util");
const { requireAuth, requireRole } = require("../middleware/auth");
const { requirePermission } = require("../services/permissions");
const { effectiveTenantId } = require("../middleware/tenant");
const { requireFeature } = require("../middleware/subscription");
const admission = require("../services/admission");
const { fileUploader, imageUploader } = require("../middleware/upload");
const communication = require("../services/communication");

const applicationDocumentUploader = fileUploader("files", "document", {
  dir: path.join(config.DATA_DIR, "private-student-documents"),
  privateStorage: true,
  extensions: [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".doc", ".docx"],
  maxMb: 10,
});

const router = express.Router();
router.use(requireAuth, requireRole("madrasa_admin", "super_admin"));
/* The online admissions PORTAL — pipeline view, entry requirements and the
   portal settings a school publishes — is Premium ("Branding & growth").
   Processing an application that already arrived is deliberately NOT gated:
   a school must always be able to act on the data it already holds. */
router.use(requireFeature((req) => {
  const p = String(req.path || "");
  if (/^\/(pipeline|requirements|settings)(\/|$)/.test(p)) return "admissions_portal";
  return null;
}));

const ADMIN = requireRole("madrasa_admin", "super_admin");

/** Resolves which tenant this call operates on. */
async function resolveTenant(req, res) {
  if (req.user.role === "madrasa_admin") return req.user.madrasaId;
  const mid = toNum((req.query && req.query.madrasaId) || (req.body && req.body.madrasa_id) || 0);
  if (!mid) return null; // platform-wide list for super admin
  const m = await db.get("SELECT id FROM madaris WHERE id = ?", [mid]);
  if (!m) { err(res, 404, "Madrasa not found."); return undefined; }
  return m.id;
}

async function loadRequest(req, res, id) {
  const tid = await resolveTenant(req, res);
  if (tid === undefined) return null;
  const row = await db.get("SELECT * FROM admission_requests WHERE id = ?", [toNum(id, 0)]);
  if (!row) { err(res, 404, "Application not found."); return null; }
  if (tid !== null && Number(row.madrasa_id) !== Number(tid)) { err(res, 404, "Application not found."); return null; }
  return row;
}

router.get("/", requirePermission("admissions.view"), asyncHandler(async (req, res) => {
  const tid = await resolveTenant(req, res);
  if (tid === undefined) return;
  const allowedStatuses = ["pending", "under_review", "shortlisted", "interviewed", "accepted", "rejected", "waitlisted", "enrolled", "approved", "needs_info", "on_hold"];
  const status = allowedStatuses.includes(cleanStr(req.query.status, 20)) ? cleanStr(req.query.status, 20) : "";
  const q = cleanStr(req.query.q || req.query.search, 80).toLowerCase();
  const page = Math.max(1, toNum(req.query.page, 1));
  const perPage = Math.min(200, Math.max(1, toNum(req.query.perPage, 50)));

  const where = [];
  const params = [];
  if (tid !== null) { where.push("a.madrasa_id = ?"); params.push(tid); }
  if (status) { where.push("a.status = ?"); params.push(status); }
  if (req.query.sessionId) { where.push("a.desired_session_id = ?"); params.push(toNum(req.query.sessionId, 0)); }
  if (req.query.classId) { where.push("a.class_id = ?"); params.push(toNum(req.query.classId, 0)); }
  if (req.query.program) { where.push("a.program = ?"); params.push(cleanStr(req.query.program, 120)); }
  if (req.query.educationTrack) { const track = cleanStr(req.query.educationTrack, 20).toLowerCase(); if (["islamic", "western", "both"].includes(track)) { where.push("a.education_track = ?"); params.push(track); } }
  if (req.query.from) { const from = String(req.query.from).slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push("a.created_at >= ?"); params.push(from); } }
  if (req.query.to) { const to = String(req.query.to).slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push("a.created_at < ?"); const next = new Date(to + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 1); params.push(next.toISOString().slice(0, 10)); } }
  if (q) { where.push("(LOWER(a.first_name) LIKE ? OR LOWER(a.last_name) LIKE ? OR LOWER(a.parent_name) LIKE ? OR LOWER(a.parent_phone) LIKE ? OR LOWER(a.reference) LIKE ? OR LOWER(a.program) LIKE ?)"); const like = `%${q}%`; params.push(like, like, like, like, like, like); }
  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
  const countRow = await db.get(`SELECT COUNT(*) AS n FROM admission_requests a ${whereSql}`, params);
  const rows = await db.all(
    `SELECT a.*, c.name_en AS class_name, m.name_en AS madrasa_name, m.slug AS madrasa_slug, s.label AS session_label
     FROM admission_requests a
     LEFT JOIN classes c ON c.id = a.class_id
     LEFT JOIN academic_sessions s ON s.id = a.desired_session_id
     LEFT JOIN madaris m ON m.id = a.madrasa_id
     ${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    params.concat([perPage, (page - 1) * perPage])
  );
  const counts = await db.all("SELECT status, COUNT(*) AS n FROM admission_requests" + (tid !== null ? " WHERE madrasa_id = ?" : "") + " GROUP BY status", tid !== null ? [tid] : []);
  const statusCounts = { pending: 0, under_review: 0, shortlisted: 0, interviewed: 0, accepted: 0, rejected: 0, waitlisted: 0, enrolled: 0, approved: 0, needs_info: 0, on_hold: 0 };
  counts.forEach((c) => { statusCounts[c.status] = Number(c.n); });
  // Keep the original compact shape for existing consumers while exposing the
  // complete workflow counts to the admissions pipeline.
  const byStatus = { pending: statusCounts.pending, approved: statusCounts.approved + statusCounts.enrolled, on_hold: statusCounts.on_hold, rejected: statusCounts.rejected };
  ok(res, { requests: rows, total: Number(countRow.n), page, perPage, totalPages: Math.max(1, Math.ceil(Number(countRow.n) / perPage)), byStatus, statusCounts });
}));

/* Admission monitoring dashboard. Each stage links back to the same filtered
 * application list; legacy `approved` applications count as enrolled. */
router.get("/pipeline", requirePermission("admissions.view"), asyncHandler(async (req, res) => {
  const tid = await resolveTenant(req, res); if (tid === undefined) return;
  const where = []; const params = [];
  if (tid !== null) { where.push("madrasa_id=?"); params.push(tid); }
  if (req.query.sessionId) { where.push("desired_session_id=?"); params.push(toNum(req.query.sessionId, 0)); }
  if (req.query.classId) { where.push("class_id=?"); params.push(toNum(req.query.classId, 0)); }
  if (req.query.program) { where.push("program=?"); params.push(cleanStr(req.query.program, 120)); }
  if (req.query.educationTrack) { const track = cleanStr(req.query.educationTrack, 20).toLowerCase(); if (["islamic", "western", "both"].includes(track)) { where.push("education_track=?"); params.push(track); } }
  if (req.query.from) { const d = String(req.query.from).slice(0,10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { where.push("created_at>=?"); params.push(d); } }
  if (req.query.to) { const d = String(req.query.to).slice(0,10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { where.push("created_at<?"); const next = new Date(d+"T00:00:00Z"); next.setUTCDate(next.getUTCDate()+1); params.push(next.toISOString().slice(0,10)); } }
  const sql = where.length ? " WHERE " + where.join(" AND ") : "";
  const rows = await db.all("SELECT status,COUNT(*) AS n FROM admission_requests" + sql + " GROUP BY status", params);
  const counts = { pending:0, under_review:0, shortlisted:0, interviewed:0, accepted:0, rejected:0, waitlisted:0, enrolled:0, needs_info:0, on_hold:0 };
  rows.forEach((row) => { if (row.status === "approved") counts.enrolled += Number(row.n); else counts[row.status] = Number(row.n); });
  counts.total = Object.entries(counts).filter(([key]) => key !== "total").reduce((sum, [,value]) => sum + Number(value || 0), 0);
  const programmes = await db.all("SELECT DISTINCT program FROM admission_requests" + (tid !== null ? " WHERE madrasa_id=? AND program<>''" : " WHERE program<>''") + " ORDER BY program", tid !== null ? [tid] : []);
  ok(res, { counts, pipeline: [
    { key:"pending", label:"Application", count:counts.pending },
    { key:"under_review", label:"Review", count:counts.under_review + counts.needs_info + counts.on_hold },
    { key:"interviewed", label:"Interview", count:counts.shortlisted + counts.interviewed },
    { key:"accepted", label:"Decision / Accepted", count:counts.accepted },
    { key:"enrolled", label:"Enrolled", count:counts.enrolled },
  ], programmes: programmes.map((row) => row.program) });
}));

/* ------------------------- admission requirements ---------------------- */
router.get("/requirements", requirePermission("admissions.view"), asyncHandler(async (req, res) => {
  const tid = await resolveTenant(req, res); if (tid === undefined || tid === null) return tid === null ? err(res, 400, "Institution context required.") : undefined;
  const where = ["r.madrasa_id=?"]; const params = [tid];
  if (req.query.status) { where.push("r.status=?"); params.push(cleanStr(req.query.status,20).toLowerCase()); }
  else if (req.query.includeArchived !== "true") where.push("r.status<>'archived'");
  if (req.query.classId) { where.push("r.class_id=?"); params.push(toNum(req.query.classId,0)); }
  if (req.query.sessionId) { where.push("r.session_id=?"); params.push(toNum(req.query.sessionId,0)); }
  if (req.query.educationTrack) { where.push("r.education_track=?"); params.push(cleanStr(req.query.educationTrack,20).toLowerCase()); }
  if (req.query.program) { where.push("r.program=?"); params.push(cleanStr(req.query.program,120)); }
  const requirements = await db.all(`SELECT r.*,c.name_en AS class_name,s.label AS session_label,u.full_name AS created_by_name
    FROM admission_requirements r LEFT JOIN classes c ON c.id=r.class_id AND c.madrasa_id=r.madrasa_id
    LEFT JOIN academic_sessions s ON s.id=r.session_id AND s.madrasa_id=r.madrasa_id LEFT JOIN users u ON u.id=r.created_by
    WHERE ${where.join(" AND ")} ORDER BY r.status='active' DESC,r.is_required DESC,r.name`, params);
  ok(res, { requirements });
}));
router.post("/requirements", requirePermission("admissions.create"), asyncHandler(async (req, res) => {
  const tid = await resolveTenant(req, res); if (tid === undefined || tid === null) return tid === null ? err(res, 400, "Institution context required.") : undefined;
  const b=req.body||{}; const name=cleanStr(b.name||b.requirement_name,200); if(!name)return err(res,400,"Requirement name is required.");
  const classId=toNum(b.class_id||b.classId,0)||null;const sessionId=toNum(b.session_id||b.sessionId,0)||null;
  if(classId&&!await db.get("SELECT id FROM classes WHERE id=? AND madrasa_id=?",[classId,tid]))return err(res,400,"Class not found.");
  if(sessionId&&!await db.get("SELECT id FROM academic_sessions WHERE id=? AND madrasa_id=?",[sessionId,tid]))return err(res,400,"Academic session not found.");
  const track=["islamic","western","both"].includes(cleanStr(b.education_track,20).toLowerCase())?cleanStr(b.education_track,20).toLowerCase():"both";
  const status=["active","inactive"].includes(cleanStr(b.status,20).toLowerCase())?cleanStr(b.status,20).toLowerCase():"active";
  const r=await db.run("INSERT INTO admission_requirements (madrasa_id,name,description,is_required,document_type,class_id,program,education_track,session_id,status,created_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)",[tid,name,cleanStr(b.description,5000),b.is_required===false||b.is_required==="false"?0:1,cleanStr(b.document_type,100),classId,cleanStr(b.program,120),track,sessionId,status,req.user.id]);
  logActivity(db,{madrasaId:tid,userId:req.user.id,action:"admission_requirement.create",entity:"admission_requirement",entityId:String(r.lastInsertRowid),ip:req.ip});ok(res,{ok:true,id:r.lastInsertRowid});
}));
router.patch("/requirements/:id", requirePermission("admissions.create"), asyncHandler(async (req,res)=>{
  const tid=await resolveTenant(req,res);if(tid===undefined||tid===null)return tid===null?err(res,400,"Institution context required."):undefined;const id=toNum(req.params.id,0);const row=await db.get("SELECT * FROM admission_requirements WHERE id=? AND madrasa_id=?",[id,tid]);if(!row)return err(res,404,"Requirement not found.");const b=req.body||{};const sets=[];const vals=[];
  for(const [key,max] of [["name",200],["description",5000],["document_type",100],["program",120]])if(b[key]!==undefined){const value=cleanStr(b[key],max);if(key==="name"&&!value)return err(res,400,"Requirement name is required.");sets.push(`${key}=?`);vals.push(value);}
  if(b.is_required!==undefined){sets.push("is_required=?");vals.push(b.is_required===true||b.is_required==="true"?1:0);}
  if(b.status!==undefined){const status=cleanStr(b.status,20).toLowerCase();if(!["active","inactive","archived"].includes(status))return err(res,400,"Invalid requirement status.");sets.push("status=?");vals.push(status);sets.push("archived_at=?");vals.push(status==="archived"?new Date().toISOString().slice(0,19).replace("T"," "):null);}
  if(b.education_track!==undefined){const track=cleanStr(b.education_track,20).toLowerCase();if(!["islamic","western","both"].includes(track))return err(res,400,"Invalid education track.");sets.push("education_track=?");vals.push(track);}
  for(const [key,table] of [["class_id","classes"],["session_id","academic_sessions"]])if(b[key]!==undefined){const value=toNum(b[key],0)||null;if(value&&!await db.get(`SELECT id FROM ${table} WHERE id=? AND madrasa_id=?`,[value,tid]))return err(res,400,`${key==="class_id"?"Class":"Session"} not found.`);sets.push(`${key}=?`);vals.push(value);}
  if(!sets.length)return err(res,400,"Nothing to update.");sets.push("updated_at=CURRENT_TIMESTAMP");vals.push(id,tid);await db.run(`UPDATE admission_requirements SET ${sets.join(",")} WHERE id=? AND madrasa_id=?`,vals);ok(res,{ok:true,requirement:await db.get("SELECT * FROM admission_requirements WHERE id=? AND madrasa_id=?",[id,tid])});
}));
router.delete("/requirements/:id", requirePermission("admissions.create"), asyncHandler(async(req,res)=>{
  const tid=await resolveTenant(req,res);if(tid===undefined||tid===null)return tid===null?err(res,400,"Institution context required."):undefined;const id=toNum(req.params.id,0);const r=await db.run("UPDATE admission_requirements SET status='archived',archived_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?",[id,tid]);if(!r.changes)return err(res,404,"Requirement not found.");ok(res,{ok:true,archived:true});
}));

/* --------------------------- admission settings ------------------------ */
const ADMISSION_SETTING_KEYS = new Set([
  "admission_open","application_start_date","application_closing_date","available_session_ids","available_class_ids","available_programs",
  "application_fee","application_number_format","required_information","required_documents","interview_enabled","interview_duration_minutes","interview_instructions",
  "admission_number_format","automatic_admission_confirmation","acceptance_instructions","enrollment_instructions","enrollment_deadline_days",
  "email_notifications","sms_notifications","application_confirmation","interview_notification","acceptance_notification","rejection_notification",
]);
function settingOut(value) { try { return JSON.parse(value); } catch (_) { return value; } }
router.get("/settings", requirePermission("admissions.view"), asyncHandler(async(req,res)=>{
  const tid=await resolveTenant(req,res);if(tid===undefined||tid===null)return tid===null?err(res,400,"Institution context required."):undefined;
  const rows=await db.all("SELECT key_name,value FROM settings WHERE madrasa_id=?",[tid]);const settings={};rows.forEach((row)=>{if(ADMISSION_SETTING_KEYS.has(row.key_name))settings[row.key_name]=settingOut(row.value);});
  const m=await db.get("SELECT public_admissions FROM madaris WHERE id=?",[tid]);if(settings.admission_open===undefined)settings.admission_open=Number(m&&m.public_admissions)===1;
  ok(res,{settings});
}));
router.put("/settings", requirePermission("institution.settings"), asyncHandler(async(req,res)=>{
  const tid=await resolveTenant(req,res);if(tid===undefined||tid===null)return tid===null?err(res,400,"Institution context required."):undefined;const b=req.body||{};
  const start=b.application_start_date?String(b.application_start_date).slice(0,10):null;const close=b.application_closing_date?String(b.application_closing_date).slice(0,10):null;if((start&&!/^\d{4}-\d{2}-\d{2}$/.test(start))||(close&&!/^\d{4}-\d{2}-\d{2}$/.test(close)))return err(res,400,"Application dates must use YYYY-MM-DD.");if(start&&close&&close<start)return err(res,400,"Application closing date cannot be before its start date.");
  for(const key of ["available_session_ids","available_class_ids"]){if(b[key]!==undefined&&!Array.isArray(b[key]))return err(res,400,`${key} must be a list.`);if(Array.isArray(b[key])){const table=key==="available_session_ids"?"academic_sessions":"classes";for(const id of b[key])if(!await db.get(`SELECT id FROM ${table} WHERE id=? AND madrasa_id=?`,[toNum(id,0),tid]))return err(res,400,`One selected ${key==="available_session_ids"?"session":"class"} was not found.`);}}
  await db.transaction(async(tx)=>{for(const [key,value] of Object.entries(b)){if(!ADMISSION_SETTING_KEYS.has(key))continue;let saved;if(Array.isArray(value)||typeof value==="object")saved=JSON.stringify(value);else if(typeof value==="boolean")saved=value?"true":"false";else saved=cleanStr(value,10000);const existing=await tx.get("SELECT id FROM settings WHERE madrasa_id=? AND key_name=?",[tid,key]);if(existing)await tx.run("UPDATE settings SET value=? WHERE id=?",[saved,existing.id]);else await tx.run("INSERT INTO settings (madrasa_id,key_name,value) VALUES (?,?,?)",[tid,key,saved]);}
    if(b.admission_open!==undefined)await tx.run("UPDATE madaris SET public_admissions=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[b.admission_open?1:0,tid]);
  });
  logActivity(db,{madrasaId:tid,userId:req.user.id,action:"admission_settings.update",entity:"settings",entityId:String(tid),ip:req.ip});ok(res,{ok:true});
}));

router.get("/:id", requirePermission("admissions.view"), asyncHandler(async (req, res) => {
  const row = await loadRequest(req, res, req.params.id);
  if (!row) return;
  const cls = row.class_id ? await db.get("SELECT id, name_en, name_ar FROM classes WHERE id = ? AND madrasa_id = ?", [row.class_id, row.madrasa_id]) : null;
  const student = row.student_id ? await db.get("SELECT id, student_code, admission_no, first_name, last_name, status FROM students WHERE id = ? AND madrasa_id = ?", [row.student_id, row.madrasa_id]) : null;
  const session = row.desired_session_id ? await db.get("SELECT id,label FROM academic_sessions WHERE id=? AND madrasa_id=?", [row.desired_session_id, row.madrasa_id]) : null;
  const [history, documents, requirements] = await Promise.all([
    db.all("SELECT h.*,u.full_name AS changed_by_name FROM admission_application_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.application_id = ? AND h.madrasa_id = ? ORDER BY h.id DESC", [row.id, row.madrasa_id]),
    db.all("SELECT id, requirement_id, document_name, original_name, mime_type, file_size, verification_status, created_at FROM admission_documents WHERE application_id = ? AND madrasa_id = ? ORDER BY id DESC", [row.id, row.madrasa_id]),
    db.all(`SELECT * FROM admission_requirements WHERE madrasa_id=? AND status='active'
      AND (class_id IS NULL OR class_id=?) AND (session_id IS NULL OR session_id=?)
      AND (program='' OR program=?) AND (education_track='both' OR education_track=?) ORDER BY is_required DESC,name`,
      [row.madrasa_id, row.class_id || 0, row.desired_session_id || 0, row.program || "", row.education_track || "both"]),
  ]);
  const submittedRequirementIds = new Set(documents.map((doc) => Number(doc.requirement_id || 0)));
  const request = Object.assign({}, row, { class_name: cls ? cls.name_en : "", session_label: session ? session.label : "" });
  ok(res, { request, class: cls, session, student, history, documents, requirements: requirements.map((requirement) => Object.assign(requirement, { submitted: submittedRequirementIds.has(Number(requirement.id)) })) });
}));

router.patch("/:id", requirePermission("admissions.create"), asyncHandler(async (req, res) => {
  const row = await loadRequest(req, res, req.params.id); if (!row) return;
  const b = req.body || {}; const sets = []; const vals = [];
  const fields = [
    ["first_name", 100], ["middle_name", 100], ["last_name", 100], ["preferred_name", 100], ["name_ar", 160], ["gender", 10],
    ["nationality", 80], ["state_of_origin", 80], ["lga", 80], ["religion", 60], ["previous_school", 200], ["quran_level", 80],
    ["program", 120], ["islamic_program", 120], ["western_program", 120], ["education_track", 20], ["section", 80], ["parent_name", 160], ["father_name", 160], ["mother_name", 160],
    ["guardian_name", 160], ["guardian_relationship", 80], ["parent_phone", 60], ["alternative_phone", 60], ["parent_email", 120],
    ["address", 255], ["contact_phone", 60], ["contact_email", 120], ["previous_class", 120], ["emergency_contact", 160], ["additional_info", 4000], ["message", 2000], ["interview_notes", 2000], ["interview_time", 5], ["interview_location", 160], ["interview_status", 20], ["requested_information", 4000], ["fee_status", 20], ["fee_reference", 120],
  ];
  for (const [field, max] of fields) if (b[field] !== undefined) { sets.push(`${field} = ?`); vals.push(cleanStr(b[field], max)); }
  if (b.date_of_birth !== undefined) { const d = b.date_of_birth ? String(b.date_of_birth).slice(0, 10) : null; if (b.date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return err(res, 400, "Invalid date of birth."); sets.push("date_of_birth = ?"); vals.push(d); }
  if (b.interview_date !== undefined) { const d = b.interview_date ? String(b.interview_date).slice(0, 10) : null; sets.push("interview_date = ?"); vals.push(d); }
  if (b.class_id !== undefined) { const cid = b.class_id ? toNum(b.class_id, 0) : null; if (cid && !await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [cid, row.madrasa_id])) return err(res, 400, "Unknown class."); sets.push("class_id = ?"); vals.push(cid); }
  for (const field of ["islamic_class_id", "western_class_id"]) if (b[field] !== undefined) { const cid = b[field] ? toNum(b[field], 0) : null; if (cid && !await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [cid, row.madrasa_id])) return err(res, 400, "Unknown education-track class."); sets.push(`${field} = ?`); vals.push(cid); }
  if (b.desired_session_id !== undefined) { const sid = b.desired_session_id ? toNum(b.desired_session_id, 0) : null; if (sid && !await db.get("SELECT id FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sid, row.madrasa_id])) return err(res, 400, "Unknown academic session."); sets.push("desired_session_id = ?"); vals.push(sid); }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  vals.push(row.id, row.madrasa_id);
  await db.run(`UPDATE admission_requests SET ${sets.join(", ")} WHERE id = ? AND madrasa_id = ?`, vals);
  logActivity(db, { madrasaId: row.madrasa_id, userId: req.user.id, action: "admission.update", entity: "admission_request", entityId: String(row.id), ip: req.ip });
  ok(res, { ok: true });
}));

/** Approve/convert → create the student (and, optionally, portal accounts). */
async function approveApplication(req, res) {
  const row = await loadRequest(req, res, req.params.id);
  if (!row) return;
  if (["approved", "enrolled"].includes(row.status) && row.student_id) return err(res, 400, "This application was already converted to a student.");
  const b = req.body || {};
  const tid = row.madrasa_id;

  const limits = await checkPlanLimits(db, tid, "student");
  if (!limits.allowed) return err(res, 403, limits.message);

  const classId = b.class_id ? toNum(b.class_id, 0) : row.class_id || null;
  if (classId) {
    const c = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
    if (!c) return err(res, 400, "Unknown class.");
  }
  for (const field of ["islamic_class_id", "western_class_id"]) if (row[field] && !await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [row[field], tid])) return err(res, 400, "Unknown education-track class.");
  const session = await db.get("SELECT id FROM academic_sessions WHERE madrasa_id = ? ORDER BY is_current DESC, id DESC LIMIT 1", [tid]);
  const admissionNo = cleanStr(b.admission_no, 60).toUpperCase() || (await admission.nextAdmissionNo(tid)).admissionNo;
  const clash = await db.get("SELECT id FROM students WHERE madrasa_id = ? AND admission_no = ?", [tid, admissionNo]);
  if (clash) return err(res, 400, "That admission number is already in use.");

  const out = { studentId: 0, username: "", portalCreated: false };
  // Keep the legacy /approve contract for integrations; the explicit
  // CONVERT TO STUDENT action advances the modern pipeline to enrolled.
  const finalStatus = String(req.path || "").endsWith("/convert") ? "enrolled" : "approved";
  try {
    await db.transaction(async (tx) => {
      // Placeholders are generated from the column list, so a column can never
      // be added without its value (that mismatch is a 500 otherwise).
      const studentCode = cleanStr(b.student_code, 60).toUpperCase() || admissionNo;
      const codeClash = await tx.get("SELECT id FROM students WHERE madrasa_id = ? AND student_code = ?", [tid, studentCode]);
      if (codeClash) throw Object.assign(new Error("That student ID is already in use."), { status: 400 });
      const stuCols = ["madrasa_id", "admission_no", "student_code", "first_name", "middle_name", "last_name", "preferred_name", "name_ar", "gender", "date_of_birth",
        "nationality", "state_of_origin", "lga", "religion", "admission_date", "class_id", "section", "islamic_class_id", "western_class_id", "islamic_program", "western_program", "session_id", "program", "education_track", "student_type", "previous_school", "previous_class", "status",
        "parent_name", "father_name", "mother_name", "guardian_name", "guardian_relationship", "parent_phone", "alternative_phone", "parent_email", "address", "residential_address", "emergency_contact", "emergency_info", "photo_path", "notes", "source_request_id"];
      const stuVals = [
        tid, admissionNo, studentCode, row.first_name, cleanStr(row.middle_name, 100), row.last_name, row.preferred_name || "", row.name_ar || "", row.gender || "", row.date_of_birth || null,
        row.nationality || "", row.state_of_origin || "", row.lga || "", row.religion || "", new Date().toISOString().slice(0, 10), classId, row.section || "", row.islamic_class_id || null, row.western_class_id || null, row.islamic_program || "", row.western_program || "", row.desired_session_id || (session ? session.id : null), row.program || "", row.education_track || "both", row.student_type || "new", row.previous_school || "", row.previous_class || "", "active",
        row.parent_name || "", row.father_name || "", row.mother_name || "", row.guardian_name || "", row.guardian_relationship || "", row.parent_phone || row.contact_phone || "", row.alternative_phone || "", row.parent_email || row.contact_email || "", row.address || "", row.address || "", row.emergency_contact || "", row.additional_info || "", row.photo_path || "", cleanStr(b.notes, 2000) || ("Admitted from online application " + row.reference), row.id,
      ];
      if (stuVals.length !== stuCols.length) throw new Error("internal: students insert column/value mismatch");
      const r = await tx.run(
        `INSERT INTO students (${stuCols.join(", ")}) VALUES (${stuCols.map(() => "?").join(", ")})`,
        stuVals
      );
      out.studentId = r.lastInsertRowid;
      if (classId || (row.desired_session_id || (session && session.id))) await tx.run("INSERT INTO student_class_history (madrasa_id, student_id, from_class_id, to_class_id, from_session_id, to_session_id, action, changed_by) VALUES (?,?,?,?,?,?,?,?)", [tid, out.studentId, null, classId, null, row.desired_session_id || (session ? session.id : null), "enrollment", req.user.id]);
      const applicationDocs = await tx.all("SELECT document_name, storage_path, original_name, mime_type, file_size, uploaded_by FROM admission_documents WHERE application_id = ? AND madrasa_id = ?", [row.id, tid]);
      for (const doc of applicationDocs) await tx.run("INSERT INTO student_documents (madrasa_id, student_id, document_name, storage_path, original_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?,?)", [tid, out.studentId, doc.document_name, doc.storage_path, doc.original_name, doc.mime_type, doc.file_size, doc.uploaded_by || req.user.id]);

      // Optional: student portal account (username from admission number).
      const makeStudent = b.create_student_account === true || b.create_student_account === "true";
      const makeParent = b.create_parent_account === true || b.create_parent_account === "true";
      const password = String(b.password || "");
      if ((makeStudent || makeParent) && password.length < 8) {
        throw Object.assign(new Error("Portal password must be at least 8 characters."), { status: 400 });
      }
      const hash = (makeStudent || makeParent) ? await bcrypt.hash(password, 10) : "";
      if (makeStudent) {
        const username = cleanStr(b.student_username, 100).toLowerCase() || admissionNo.toLowerCase();
        const taken = await tx.get("SELECT id FROM users WHERE username = ?", [username]);
        if (taken) throw Object.assign(new Error("Username " + username + " is already taken."), { status: 400 });
        await tx.run(
          "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, student_id) VALUES (?,?,?,?,?,?)",
          [tid, username, hash, "student", `${row.first_name} ${row.last_name}`.trim(), out.studentId]
        );
        out.portalCreated = true;
        out.username = username;
      }
      if (makeParent) {
        const username = cleanStr(b.parent_username, 100).toLowerCase() || (admissionNo.toLowerCase() + "-p");
        const taken = await tx.get("SELECT id FROM users WHERE username = ?", [username]);
        if (taken) throw Object.assign(new Error("Username " + username + " is already taken."), { status: 400 });
        const pr = await tx.run(
          "INSERT INTO users (madrasa_id, username, password_hash, role, full_name, email, phone) VALUES (?,?,?,?,?,?,?)",
          [tid, username, hash, "parent", row.parent_name || "Parent", cleanStr(row.parent_email, 120), row.parent_phone]
        );
        await tx.run("INSERT INTO parent_links (madrasa_id, user_id, student_id) VALUES (?,?,?)", [tid, pr.lastInsertRowid, out.studentId]);
        out.portalCreated = true;
        out.parentUsername = username;
      }

      await tx.run(
        `UPDATE admission_requests SET status = ?, student_id = ?, reviewed_by = ?,
               reviewed_at = CURRENT_TIMESTAMP, review_note = ?, admission_no_assigned = ? WHERE id = ? AND madrasa_id = ?`,
        [finalStatus, out.studentId, req.user.id, cleanStr(b.note, 1000), admissionNo, row.id, tid]
      );
      await tx.run("INSERT INTO admission_application_history (madrasa_id, application_id, from_status, to_status, note, changed_by) VALUES (?,?,?,?,?,?)", [tid, row.id, row.status, finalStatus, cleanStr(b.note, 1000), req.user.id]);
    });
  } catch (e) {
    if (e && e.status === 400) return err(res, 400, e.message);
    console.error("Admission approval failed:", e);
    return err(res, 500, "Could not admit this student. Nothing was saved — please try again.");
  }

  const applicant = row.parent_email ? await db.get("SELECT id FROM users WHERE madrasa_id = ? AND is_active = 1 AND LOWER(email) = LOWER(?)", [tid, row.parent_email]) : null;
  if (applicant) await communication.createNotifications(tid, [applicant.id], { type: "admission_update", title: "Admission accepted", body: `Application ${row.reference} has been accepted.`, entity_type: "admission_request", entity_id: row.id });
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "admission.approve", entity: "student", entityId: String(out.studentId), meta: { reference: row.reference, admissionNo }, ip: req.ip });
  ok(res, { ok: true, status: finalStatus, studentId: out.studentId, admissionNo, portalCreated: out.portalCreated, username: out.username, parentUsername: out.parentUsername || "" });
}

router.post("/:id/approve", requirePermission("admissions.approve"), asyncHandler(approveApplication));
router.post("/:id/convert", requirePermission("admissions.approve"), asyncHandler(approveApplication));

async function setStatus(req, res, status) {
  const row = await loadRequest(req, res, req.params.id);
  if (!row) return;
  const note = cleanStr((req.body && (req.body.note || req.body.review_note)) || "", 2000);
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE admission_requests SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ? WHERE id = ? AND madrasa_id = ?",
      [status, req.user.id, note, row.id, row.madrasa_id]
    );
    await tx.run("INSERT INTO admission_application_history (madrasa_id, application_id, from_status, to_status, note, changed_by) VALUES (?,?,?,?,?,?)", [row.madrasa_id, row.id, row.status, status, note, req.user.id]);
  });
  const applicant = row.parent_email ? await db.get("SELECT id FROM users WHERE madrasa_id = ? AND is_active = 1 AND LOWER(email) = LOWER(?)", [row.madrasa_id, row.parent_email]) : null;
  if (applicant) await communication.createNotifications(row.madrasa_id, [applicant.id], { type: "admission_update", title: "Admission application updated", body: `Application ${row.reference} is now ${status.replace(/_/g, " ")}.`, entity_type: "admission_request", entity_id: row.id });
  logActivity(db, { madrasaId: row.madrasa_id, userId: req.user.id, action: "admission." + status, entity: "admission_request", entityId: String(row.id), meta: { reference: row.reference, note }, ip: req.ip });
  ok(res, { ok: true, status });
}

router.post("/:id/reject", requirePermission("admissions.reject"), asyncHandler((req, res) => setStatus(req, res, "rejected")));
router.post("/:id/hold", ADMIN, asyncHandler((req, res) => setStatus(req, res, "on_hold")));
router.post("/:id/waitlist", ADMIN, asyncHandler((req, res) => setStatus(req, res, "waitlisted")));
router.post("/:id/request-info", ADMIN, asyncHandler((req, res) => setStatus(req, res, "needs_info")));
router.post("/:id/under-review", ADMIN, asyncHandler((req, res) => setStatus(req, res, "under_review")));
router.post("/:id/shortlist", ADMIN, asyncHandler((req, res) => setStatus(req, res, "shortlisted")));
router.post("/:id/interviewed", ADMIN, asyncHandler((req, res) => setStatus(req, res, "interviewed")));
router.post("/:id/accept", requirePermission("admissions.approve"), asyncHandler((req, res) => setStatus(req, res, "accepted")));
router.post("/:id/reopen", ADMIN, asyncHandler((req, res) => setStatus(req, res, "pending")));
router.patch("/:id/review", ADMIN, asyncHandler(async (req, res) => {
  const row = await loadRequest(req, res, req.params.id); if (!row) return;
  const b = req.body || {};
  const allowed = ["pending", "under_review", "shortlisted", "interviewed", "accepted", "approved", "enrolled", "rejected", "waitlisted", "needs_info", "on_hold"];
  const status = allowed.includes(cleanStr(b.status, 30)) ? cleanStr(b.status, 30) : row.status;
  const note = cleanStr(b.review_note || b.note, 2000);
  const sets = ["status = ?", "review_note = ?", "reviewed_by = ?", "reviewed_at = CURRENT_TIMESTAMP"]; const vals = [status, note, req.user.id];
  if (b.interview_date !== undefined) { const d = b.interview_date ? String(b.interview_date).slice(0, 10) : null; if (b.interview_date && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return err(res, 400, "Invalid interview date."); sets.push("interview_date = ?"); vals.push(d); }
  if (b.interview_notes !== undefined) { sets.push("interview_notes = ?"); vals.push(cleanStr(b.interview_notes, 2000)); }
  if (b.interview_time !== undefined) { const time = cleanStr(b.interview_time, 5); if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return err(res, 400, "Invalid interview time."); sets.push("interview_time=?"); vals.push(time); }
  if (b.interview_location !== undefined) { sets.push("interview_location=?"); vals.push(cleanStr(b.interview_location, 160)); }
  if (b.interview_status !== undefined) { const interviewStatus = cleanStr(b.interview_status, 20).toLowerCase(); if (!["not_scheduled","scheduled","completed","cancelled"].includes(interviewStatus)) return err(res, 400, "Invalid interview status."); sets.push("interview_status=?"); vals.push(interviewStatus); }
  if (b.requested_information !== undefined) { sets.push("requested_information=?"); vals.push(cleanStr(b.requested_information, 4000)); }
  if (b.class_id !== undefined) { const classId = b.class_id ? toNum(b.class_id,0) : null; if (classId && !await db.get("SELECT id FROM classes WHERE id=? AND madrasa_id=?", [classId,row.madrasa_id])) return err(res,400,"Unknown class."); sets.push("class_id=?"); vals.push(classId); }
  if (b.fee_status !== undefined) { sets.push("fee_status = ?"); vals.push(cleanStr(b.fee_status, 20)); }
  vals.push(row.id, row.madrasa_id);
  await db.transaction(async (tx) => {
    await tx.run(`UPDATE admission_requests SET ${sets.join(", ")} WHERE id = ? AND madrasa_id = ?`, vals);
    if (row.status !== status) await tx.run("INSERT INTO admission_application_history (madrasa_id, application_id, from_status, to_status, note, changed_by) VALUES (?,?,?,?,?,?)", [row.madrasa_id, row.id, row.status, status, note, req.user.id]);
  });
  ok(res, { ok: true, status });
}));

router.post("/:id/photo", ADMIN, imageUploader("application-photos", "photo"), asyncHandler(async (req, res) => {
  const row = await loadRequest(req, res, req.params.id); if (!row) return;
  if (!req.file) return err(res, 400, "Choose a JPG, PNG or WEBP photo.");
  const photoPath = `/uploads/application-photos/${req.file.filename}`;
  await db.run("UPDATE admission_requests SET photo_path=? WHERE id=? AND madrasa_id=?", [photoPath, row.id, row.madrasa_id]);
  ok(res, { ok: true, photoPath });
}));

router.post("/:id/documents", ADMIN, applicationDocumentUploader, asyncHandler(async (req, res) => {
  const row = await loadRequest(req, res, req.params.id); if (!row) return;
  if (!req.file) return err(res, 400, "No document uploaded.");
  const name = cleanStr(req.body && req.body.document_name, 200) || cleanStr(req.file.originalname, 200);
  const requirementId = toNum(req.body && req.body.requirement_id, 0) || null;
  if (requirementId && !await db.get("SELECT id FROM admission_requirements WHERE id=? AND madrasa_id=?", [requirementId, row.madrasa_id])) return err(res, 400, "Admission requirement not found.");
  const r = await db.run("INSERT INTO admission_documents (madrasa_id, application_id, document_name, storage_path, original_name, mime_type, file_size, uploaded_by, requirement_id, verification_status) VALUES (?,?,?,?,?,?,?,?,?,'pending')", [row.madrasa_id, row.id, name, req.file.path, cleanStr(req.file.originalname, 255), cleanStr(req.file.mimetype, 120), Number(req.file.size || 0), req.user.id, requirementId]);
  ok(res, { ok: true, id: r.lastInsertRowid, documentName: name });
}));
router.get("/:id/documents/:documentId", ADMIN, requirePermission("admissions.view"), asyncHandler(async (req, res) => {
  const row = await loadRequest(req, res, req.params.id); if (!row) return;
  const doc = await db.get("SELECT * FROM admission_documents WHERE id = ? AND application_id = ? AND madrasa_id = ?", [toNum(req.params.documentId, 0), row.id, row.madrasa_id]);
  if (!doc || !await privateMedia.download(res, doc.storage_path, doc.original_name || doc.document_name)) return err(res, 404, "Document not found.");
}));

router.delete("/:id", requirePermission("admissions.approve"), asyncHandler(async (req, res) => {
  const row = await loadRequest(req, res, req.params.id);
  if (!row) return;
  if (row.student_id) return err(res, 400, "This application was admitted — delete the student record instead.");
  await db.run("DELETE FROM admission_requests WHERE id = ?", [row.id]);
  logActivity(db, { madrasaId: row.madrasa_id, userId: req.user.id, action: "admission.delete", entity: "admission_request", entityId: String(row.id), ip: req.ip });
  ok(res, { ok: true });
}));

module.exports = router;
