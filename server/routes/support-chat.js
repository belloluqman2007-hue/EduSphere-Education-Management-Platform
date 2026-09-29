"use strict";
/* ============================================================================
   CHAT & SUPPORT — API routes
   ----------------------------------------------------------------------------
   Two routers over ONE data model (server/services/support-chat.js):

     router          mounted at /api/support/chat — the authenticated institution
                                                 user's side (Islamic AND
                                                 Western institutions alike)
     platformRouter  mounted at /api/platform/conversations — the Super Admin /
                                                 support desk side

   Security, on every request:
     • authentication is required (session cookie, CSRF on writes — both from
       the existing app-level stack),
     • the institution side resolves the tenant from the SESSION
       (effectiveTenantId) and filters every query by it, so changing a
       conversation id, user id, institution id or any body/URL parameter can
       never reach another institution's thread (answered 404, existence not
       leaked),
     • the platform side is behind requireSuperAdmin at the mount point,
     • attachments live outside the statically served uploads tree and are
       streamed only after the same authorisation check.
   ========================================================================== */
const express = require("express");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const db = require("../db");
const chat = require("../services/support-chat");
const { asyncHandler, err, ok, cleanStr, toNum, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { effectiveTenantId } = require("../middleware/tenant");
const { requirePermission } = require("../services/permissions");

/* ----------------------------- file uploads ------------------------------ */
/* The name on disk is generated here; the extension comes from the validated
   MIME type, never from the client's file name (no path traversal, no
   executable upload, no HTML served back from our own origin). */
const MIME_EXT = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["application/pdf", ".pdf"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
]);

function rejectUpload(message) {
  return Object.assign(new Error(message), { status: 400, expose: true });
}

const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try { cb(null, chat.ensureAttachmentDir()); }
      catch (e) { cb(e); }
    },
    filename: (req, file, cb) => {
      const ext = MIME_EXT.get(String(file.mimetype || "").toLowerCase()) || ".bin";
      cb(null, Date.now() + "-" + crypto.randomBytes(12).toString("hex") + ext);
    },
  }),
  limits: { fileSize: chat.MAX_ATTACHMENT_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!chat.attachmentTypeAllowed(file.mimetype, file.originalname)) {
      return cb(rejectUpload("Only JPG, JPEG, PNG, PDF, DOC or DOCX attachments are allowed."));
    }
    cb(null, true);
  },
}).single("attachment");

/** Runs the uploader and turns multer's errors into friendly 4xx messages. */
function receiveAttachment(req, res) {
  return new Promise((resolve) => {
    attachmentUpload(req, res, (e) => {
      if (!e) return resolve(null);
      if (e.code === "LIMIT_FILE_SIZE") return resolve(`The attachment is too large. The maximum size is ${chat.MAX_ATTACHMENT_MB} MB.`);
      if (e.code === "LIMIT_FILE_COUNT" || e.code === "LIMIT_UNEXPECTED_FILE") return resolve("Only one attachment can be sent with a message.");
      resolve(e.expose ? e.message : "The attachment could not be accepted.");
    });
  });
}

/** Deletes a just-stored file when the surrounding request cannot continue. */
function discard(file) {
  if (!file) return;
  try { fs.unlinkSync(path.resolve(file.path)); } catch (e) { /* nothing to undo */ }
}

/** Streams an attachment as a download, never inline (no rendered HTML/SVG). */
function sendAttachment(res, row) {
  const full = chat.attachmentPath(row.storage_name);
  if (!full || !fs.existsSync(full)) return err(res, 404, "This attachment is no longer available.");
  res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${chat.safeDisplayName(row.file_name).replace(/"/g, "")}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(full).pipe(res);
}

/** Vocabulary the UI renders from — one source of truth, served by the API. */
function vocabulary() {
  return {
    categories: chat.CATEGORIES.map(([value, label]) => ({ value, label })),
    priorities: chat.PRIORITIES.map(([value, label]) => ({ value, label })),
    statuses: chat.STATUSES.map(([value, label]) => ({ value, label })),
    maxAttachmentMb: chat.MAX_ATTACHMENT_MB,
    attachmentTypes: chat.ATTACHMENT_EXTENSIONS,
  };
}

/* ========================================================================== */
/*  INSTITUTION SIDE  — /api/support/conversations                            */
/* ========================================================================== */

const router = express.Router();
// Authenticated staff of one institution. Which staff exactly is decided by
// the EXISTING granular permission system (support.chat), not by a new role.
router.use(requireAuth, requireTenant, requireRole("madrasa_admin", "teacher"));

/** The caller's own institution, from the session. Never from the client. */
function tenantOf(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { err(res, 400, "An institution context is required."); return null; }
  return tid;
}

router.get("/meta", requirePermission("support.chat"), asyncHandler(async (req, res) => {
  const tid = tenantOf(req, res); if (tid == null) return;
  ok(res, Object.assign(vocabulary(), { unread: await chat.institutionUnreadCount(tid) }));
}));

router.get("/conversations/unread-count", requirePermission("support.chat"), asyncHandler(async (req, res) => {
  const tid = tenantOf(req, res); if (tid == null) return;
  ok(res, { unread: await chat.institutionUnreadCount(tid) });
}));

router.get("/conversations", requirePermission("support.chat"), asyncHandler(async (req, res) => {
  const tid = tenantOf(req, res); if (tid == null) return;
  const data = await chat.listConversations({
    madrasaId: tid,
    viewerSide: chat.SIDE_INSTITUTION,
    status: req.query.status,
    search: req.query.q,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  ok(res, Object.assign(data, { unread: await chat.institutionUnreadCount(tid) }));
}));

router.post("/conversations", requirePermission("support.chat"), asyncHandler(async (req, res) => {
  const tid = tenantOf(req, res); if (tid == null) return;
  const uploadError = await receiveAttachment(req, res);
  if (uploadError) return err(res, 400, uploadError);
  const b = req.body || {};
  const subject = cleanStr(b.subject, 200);
  const body = cleanStr(b.message, 8000);
  if (!subject) { discard(req.file); return err(res, 400, "Please give the conversation a subject."); }
  if (!body) { discard(req.file); return err(res, 400, "Please write your message."); }

  const created = await chat.createConversation({
    madrasaId: tid,
    user: req.user,
    subject,
    body,
    category: chat.normalizeCategory(b.category),
    priority: chat.normalizePriority(b.priority),
  });
  const conversation = { id: created.id, madrasa_id: tid, created_by: req.user.id };
  const messageId = await chat.addMessage(conversation, {
    senderId: req.user.id, senderRole: req.user.role, side: chat.SIDE_INSTITUTION, body, hasAttachment: Boolean(req.file),
  });
  if (req.file) await chat.recordAttachment(conversation, messageId, req.file, req.user.id);
  await chat.touchConversation(conversation, { side: chat.SIDE_INSTITUTION, body, status: "open" });

  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "support.chat.create", entity: "support_conversation", entityId: String(created.id), meta: { code: created.conversation_code }, ip: req.ip });
  ok(res, { ok: true, id: created.id, conversation_code: created.conversation_code });
}));

/** Loads a conversation for THIS institution or answers 404. */
async function ownConversation(req, res) {
  const tid = tenantOf(req, res); if (tid == null) return null;
  const conversation = await chat.getConversation(req.params.id, tid);
  if (!conversation) { err(res, 404, "This conversation is no longer available."); return null; }
  return conversation;
}

router.get("/conversations/:id", requirePermission("support.chat"), asyncHandler(async (req, res) => {
  const conversation = await ownConversation(req, res); if (!conversation) return;
  const [thread, attachments] = await Promise.all([
    chat.listMessages(conversation.id, { limit: req.query.limit, before: req.query.before }),
    chat.listAttachments(conversation.id),
  ]);
  ok(res, { conversation, messages: thread.messages, hasMore: thread.hasMore, attachments });
}));

router.post("/conversations/:id/messages", requirePermission("support.chat"), asyncHandler(async (req, res) => {
  const uploadError = await receiveAttachment(req, res);
  const conversation = await ownConversation(req, res);
  if (!conversation) { discard(req.file); return; }
  if (uploadError) { return err(res, 400, uploadError); }
  const body = cleanStr(req.body && req.body.message, 8000);
  if (!body && !req.file) return err(res, 400, "Write a message before sending.");

  const messageId = await chat.addMessage(conversation, {
    senderId: req.user.id, senderRole: req.user.role, side: chat.SIDE_INSTITUTION, body, hasAttachment: Boolean(req.file),
  });
  if (req.file) await chat.recordAttachment(conversation, messageId, req.file, req.user.id);
  await chat.touchConversation(conversation, {
    side: chat.SIDE_INSTITUTION, body: body || "Attachment", status: chat.statusAfterMessage(conversation.status, chat.SIDE_INSTITUTION),
  });
  logActivity(db, { madrasaId: conversation.madrasa_id, userId: req.user.id, action: "support.chat.message", entity: "support_conversation", entityId: String(conversation.id), ip: req.ip });
  ok(res, { ok: true, id: messageId });
}));

router.patch("/conversations/:id/read", requirePermission("support.chat"), asyncHandler(async (req, res) => {
  const conversation = await ownConversation(req, res); if (!conversation) return;
  const marked = await chat.markRead(conversation.id, chat.SIDE_INSTITUTION);
  ok(res, { ok: true, marked, unread: await chat.institutionUnreadCount(conversation.madrasa_id) });
}));

/** The institution may resolve/reopen/close its OWN conversation. */
router.patch("/conversations/:id", requirePermission("support.chat"), asyncHandler(async (req, res) => {
  const conversation = await ownConversation(req, res); if (!conversation) return;
  const status = cleanStr(req.body && req.body.status, 20).toLowerCase();
  if (!["resolved", "closed", "open"].includes(status)) {
    return err(res, 400, "You can only resolve, close or reopen your own conversation.");
  }
  await db.run(
    `UPDATE support_conversations
        SET status = ?, updated_at = CURRENT_TIMESTAMP,
            resolved_at = ${status === "resolved" ? "CURRENT_TIMESTAMP" : "resolved_at"},
            closed_at = ${status === "closed" ? "CURRENT_TIMESTAMP" : "NULL"}
      WHERE id = ? AND madrasa_id = ?`,
    [status, conversation.id, conversation.madrasa_id]
  );
  logActivity(db, { madrasaId: conversation.madrasa_id, userId: req.user.id, action: "support.chat.status", entity: "support_conversation", entityId: String(conversation.id), meta: { status }, ip: req.ip });
  ok(res, { ok: true, status });
}));

router.get("/conversations/:id/attachments/:attachmentId", requirePermission("support.chat"), asyncHandler(async (req, res) => {
  const conversation = await ownConversation(req, res); if (!conversation) return;
  const row = await chat.getAttachment(conversation.id, req.params.attachmentId);
  if (!row) return err(res, 404, "This attachment is no longer available.");
  sendAttachment(res, row);
}));

/* ========================================================================== */
/*  SUPER ADMIN SIDE  — /api/platform/conversations                           */
/* ========================================================================== */

const platformRouter = express.Router();

platformRouter.get("/meta", asyncHandler(async (req, res) => {
  ok(res, Object.assign(vocabulary(), { unread: await chat.platformUnreadCount() }));
}));

platformRouter.get("/unread-count", asyncHandler(async (req, res) => {
  ok(res, { unread: await chat.platformUnreadCount() });
}));

platformRouter.get("/", asyncHandler(async (req, res) => {
  const data = await chat.listConversations({
    madrasaId: toNum(req.query.madrasaId, 0) || null,
    viewerSide: chat.SIDE_PLATFORM,
    status: req.query.status,
    priority: req.query.priority,
    category: req.query.category,
    search: req.query.q,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  const counts = {};
  for (const row of await db.all("SELECT status, COUNT(*) AS n FROM support_conversations GROUP BY status")) counts[row.status] = Number(row.n);
  const institutions = await db.all(
    `SELECT m.id, m.name_en AS name, m.category
       FROM madaris m
      WHERE EXISTS (SELECT 1 FROM support_conversations c WHERE c.madrasa_id = m.id)
      ORDER BY m.name_en`
  );
  ok(res, Object.assign(data, { counts, institutions, unread: await chat.platformUnreadCount() }));
}));

async function anyConversation(req, res) {
  const conversation = await chat.getConversation(req.params.id, null);
  if (!conversation) { err(res, 404, "Conversation not found."); return null; }
  return conversation;
}

platformRouter.get("/:id", asyncHandler(async (req, res) => {
  const conversation = await anyConversation(req, res); if (!conversation) return;
  const [thread, attachments] = await Promise.all([
    chat.listMessages(conversation.id, { limit: req.query.limit, before: req.query.before }),
    chat.listAttachments(conversation.id),
  ]);
  ok(res, { conversation, messages: thread.messages, hasMore: thread.hasMore, attachments });
}));

platformRouter.post("/:id/messages", asyncHandler(async (req, res) => {
  const uploadError = await receiveAttachment(req, res);
  const conversation = await anyConversation(req, res);
  if (!conversation) { discard(req.file); return; }
  if (uploadError) return err(res, 400, uploadError);
  const body = cleanStr(req.body && req.body.message, 8000);
  if (!body && !req.file) return err(res, 400, "Write a reply before sending.");

  const messageId = await chat.addMessage(conversation, {
    senderId: req.user.id, senderRole: req.user.role, side: chat.SIDE_PLATFORM, body, hasAttachment: Boolean(req.file),
  });
  if (req.file) await chat.recordAttachment(conversation, messageId, req.file, req.user.id);
  await chat.touchConversation(conversation, {
    side: chat.SIDE_PLATFORM, body: body || "Attachment", status: chat.statusAfterMessage(conversation.status, chat.SIDE_PLATFORM),
  });
  // Existing in-app notification system — the preview never carries the body.
  await chat.notifyInstitution(conversation, {
    type: "support_chat_reply",
    title: "EduSphere Support replied",
    body: `There is a new reply on support conversation ${conversation.conversation_code}.`,
  });
  logActivity(db, { madrasaId: conversation.madrasa_id, userId: req.user.id, action: "support.chat.reply", entity: "support_conversation", entityId: String(conversation.id), ip: req.ip });
  ok(res, { ok: true, id: messageId });
}));

platformRouter.patch("/:id/status", asyncHandler(async (req, res) => {
  const conversation = await anyConversation(req, res); if (!conversation) return;
  const status = cleanStr(req.body && req.body.status, 20).toLowerCase();
  if (!chat.isStatus(status)) return err(res, 400, "Unknown conversation status.");
  await db.run(
    `UPDATE support_conversations
        SET status = ?, updated_at = CURRENT_TIMESTAMP,
            resolved_at = ${status === "resolved" ? "CURRENT_TIMESTAMP" : "resolved_at"},
            closed_at = ${status === "closed" ? "CURRENT_TIMESTAMP" : "NULL"}
      WHERE id = ?`,
    [status, conversation.id]
  );
  await chat.notifyInstitution(conversation, {
    type: "support_chat_status",
    title: "Support conversation updated",
    body: `Conversation ${conversation.conversation_code} is now marked ${status}.`,
  });
  logActivity(db, { madrasaId: conversation.madrasa_id, userId: req.user.id, action: "support.chat.admin_status", entity: "support_conversation", entityId: String(conversation.id), meta: { status }, ip: req.ip });
  ok(res, { ok: true, status });
}));

platformRouter.patch("/:id/priority", asyncHandler(async (req, res) => {
  const conversation = await anyConversation(req, res); if (!conversation) return;
  const priority = cleanStr(req.body && req.body.priority, 20).toLowerCase();
  if (!chat.PRIORITY_SET.has(priority)) return err(res, 400, "Unknown conversation priority.");
  await db.run("UPDATE support_conversations SET priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [priority, conversation.id]);
  logActivity(db, { madrasaId: conversation.madrasa_id, userId: req.user.id, action: "support.chat.admin_priority", entity: "support_conversation", entityId: String(conversation.id), meta: { priority }, ip: req.ip });
  ok(res, { ok: true, priority });
}));

platformRouter.patch("/:id/read", asyncHandler(async (req, res) => {
  const conversation = await anyConversation(req, res); if (!conversation) return;
  const marked = await chat.markRead(conversation.id, chat.SIDE_PLATFORM);
  ok(res, { ok: true, marked, unread: await chat.platformUnreadCount() });
}));

platformRouter.get("/:id/attachments/:attachmentId", asyncHandler(async (req, res) => {
  const conversation = await anyConversation(req, res); if (!conversation) return;
  const row = await chat.getAttachment(conversation.id, req.params.attachmentId);
  if (!row) return err(res, 404, "This attachment is no longer available.");
  sendAttachment(res, row);
}));

module.exports = { router, platformRouter };
