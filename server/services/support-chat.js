"use strict";
/* ============================================================================
   CHAT & SUPPORT — shared service
   ----------------------------------------------------------------------------
   One architecture for BOTH sides of the conversation:

     • an authenticated institution user (Islamic school or Western academy —
       the same code path; the institution's own category simply travels with
       madrasa_id),
     • the EduSphere Super Admin / support desk.

   Nothing in here trusts a tenant id from the client. Every helper takes the
   madrasa id the ROUTE resolved from the authenticated session, and every
   institution-side query filters by it.

   The service owns:
     • the human-readable conversation code (#ES-<year>-<nnnn>), generated
       server-side inside a retry loop so two concurrent creations cannot
       collide,
     • listing / detail / message queries (paginated, indexed, no N+1),
     • per-message read tracking for each side,
     • private attachment storage (outside the publicly served /uploads tree),
     • in-app notifications through the EXISTING notification service.
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const db = require("../db");
const config = require("../config");
const communication = require("./communication");
const { cleanStr, toNum } = require("../util");

/* ------------------------------ vocabulary ------------------------------- */
/* Platform-support categories only. Academic subjects deliberately have no
   place here — this channel is for EduSphere product support. */
const CATEGORIES = [
  ["technical", "Technical Support"],
  ["account", "Account & Login"],
  ["institution_setup", "Institution Setup"],
  ["billing", "Billing & Subscription"],
  ["bug", "Bug Report"],
  ["feature_request", "Feature Request"],
  ["general", "General Enquiry"],
  ["other", "Other"],
];
const PRIORITIES = [["normal", "Normal"], ["high", "High"], ["urgent", "Urgent"]];
const STATUSES = [["open", "Open"], ["pending", "Pending"], ["replied", "Replied"], ["resolved", "Resolved"], ["closed", "Closed"]];

const CATEGORY_SET = new Set(CATEGORIES.map(([k]) => k));
const PRIORITY_SET = new Set(PRIORITIES.map(([k]) => k));
const STATUS_SET = new Set(STATUSES.map(([k]) => k));

const SIDE_INSTITUTION = "institution";
const SIDE_PLATFORM = "platform";

/* ------------------------------ attachments ------------------------------ */
/* Private directory: NOT under config.UPLOAD_DIR, which app.js serves
   statically. A support attachment may only ever leave the server through the
   authorised download route below. */
const ATTACHMENT_DIR = path.resolve(config.DATA_DIR, "support-chat");

const ATTACHMENT_TYPES = new Map([
  ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/png", [".png"]],
  ["application/pdf", [".pdf"]],
  ["application/msword", [".doc"]],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [".docx"]],
]);
const ATTACHMENT_EXTENSIONS = [".jpg", ".jpeg", ".png", ".pdf", ".doc", ".docx"];
const MAX_ATTACHMENT_MB = Math.max(1, Math.min(Number(config.MAX_UPLOAD_MB) || 5, 10));

/** True when the (multer-validated) MIME and the client extension agree. */
function attachmentTypeAllowed(mime, originalName) {
  const allowedExts = ATTACHMENT_TYPES.get(String(mime || "").toLowerCase());
  if (!allowedExts) return false;
  const ext = path.extname(String(originalName || "")).toLowerCase();
  return allowedExts.includes(ext);
}

/** A display name that can never be used to build a path. */
function safeDisplayName(originalName) {
  const base = path.basename(String(originalName || "file"));
  return cleanStr(base.replace(/[^A-Za-z0-9._ -]/g, "_"), 120) || "attachment";
}

/** Absolute path of a stored attachment, refusing anything outside the dir. */
function attachmentPath(storageName) {
  const name = path.basename(String(storageName || ""));
  const full = path.resolve(ATTACHMENT_DIR, name);
  if (!full.startsWith(ATTACHMENT_DIR + path.sep)) return null;
  return full;
}

function ensureAttachmentDir() {
  fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  return ATTACHMENT_DIR;
}

/* --------------------------- conversation code --------------------------- */

/**
 * Next free code for the current year, e.g. ES-2026-0012.
 * The sequence is derived from the codes already stored (never from the
 * client), and creation retries on the UNIQUE constraint so two simultaneous
 * inserts cannot produce the same code.
 */
async function nextConversationCode(year) {
  const prefix = `ES-${year}-`;
  const row = await db.get(
    "SELECT conversation_code AS code FROM support_conversations WHERE conversation_code LIKE ? ORDER BY conversation_code DESC LIMIT 1",
    [prefix + "%"]
  );
  const last = row ? toNum(String(row.code).slice(prefix.length), 0) : 0;
  return prefix + String(last + 1).padStart(4, "0");
}

/* ------------------------------ validation ------------------------------- */

function normalizeCategory(v) {
  const s = cleanStr(v, 40).toLowerCase();
  return CATEGORY_SET.has(s) ? s : "general";
}
function normalizePriority(v) {
  const s = cleanStr(v, 20).toLowerCase();
  return PRIORITY_SET.has(s) ? s : "normal";
}
function isStatus(v) {
  return STATUS_SET.has(cleanStr(v, 20).toLowerCase());
}

function preview(body) {
  return cleanStr(String(body || "").replace(/\s+/g, " "), 180);
}

/* ------------------------------- creation -------------------------------- */

/**
 * Creates a conversation plus its first message. `madrasaId` and `user` come
 * from the authenticated session — never from the request body.
 */
async function createConversation({ madrasaId, user, subject, body, category, priority }) {
  const year = new Date().getFullYear();
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = await nextConversationCode(year);
    try {
      const result = await db.run(
        `INSERT INTO support_conversations
           (conversation_code, madrasa_id, created_by, subject, category, priority, status, last_message_preview, last_sender_side)
         VALUES (?,?,?,?,?,?,'open',?,?)`,
        [code, madrasaId, user.id, subject, category, priority, preview(body), SIDE_INSTITUTION]
      );
      return { id: Number(result.lastInsertRowid), conversation_code: code };
    } catch (e) {
      if (!/unique|duplicate/i.test(e.message || "")) throw e;
      lastError = e; // another request took this code — try the next one
    }
  }
  throw lastError || new Error("Could not allocate a conversation code.");
}

/** Appends a message and refreshes the conversation's activity fields. */
async function addMessage(conversation, { senderId, senderRole, side, body, hasAttachment }) {
  const result = await db.run(
    `INSERT INTO support_chat_messages
       (conversation_id, madrasa_id, sender_id, sender_role, sender_side, body, has_attachment)
     VALUES (?,?,?,?,?,?,?)`,
    [conversation.id, conversation.madrasa_id, senderId, senderRole, side, body, hasAttachment ? 1 : 0]
  );
  return Number(result.lastInsertRowid);
}

/** Status transition applied automatically when someone posts a message. */
function statusAfterMessage(current, side) {
  if (side === SIDE_PLATFORM) return "replied";
  // An institution message always puts the ball back in the support queue,
  // including on a resolved/closed thread the user chose to continue.
  return "open";
}

async function touchConversation(conversation, { side, body, status }) {
  const sets = [
    "last_message_at = CURRENT_TIMESTAMP",
    "updated_at = CURRENT_TIMESTAMP",
    "last_message_preview = ?",
    "last_sender_side = ?",
    "status = ?",
  ];
  const params = [preview(body), side, status];
  if (status === "resolved") sets.push("resolved_at = CURRENT_TIMESTAMP");
  if (status !== "closed") sets.push("closed_at = NULL");
  params.push(conversation.id);
  await db.run(`UPDATE support_conversations SET ${sets.join(", ")} WHERE id = ?`, params);
}

/* --------------------------------- reads --------------------------------- */

/**
 * Marks the OTHER side's messages in this conversation as read, message by
 * message (never a blanket conversation flag), and returns how many changed.
 */
async function markRead(conversationId, readerSide) {
  const otherSide = readerSide === SIDE_PLATFORM ? SIDE_INSTITUTION : SIDE_PLATFORM;
  const r = await db.run(
    "UPDATE support_chat_messages SET read_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND sender_side = ? AND read_at IS NULL",
    [conversationId, otherSide]
  );
  return Number(r.changes || 0);
}

/** Unread replies waiting for one institution (support → institution). */
async function institutionUnreadCount(madrasaId) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM support_chat_messages m
       JOIN support_conversations c ON c.id = m.conversation_id
      WHERE c.madrasa_id = ? AND m.madrasa_id = ? AND m.sender_side = ? AND m.read_at IS NULL`,
    [madrasaId, madrasaId, SIDE_PLATFORM]
  );
  return Number((row && row.n) || 0);
}

/** Unread institution messages waiting for the support desk (platform-wide). */
async function platformUnreadCount() {
  const row = await db.get(
    "SELECT COUNT(*) AS n FROM support_chat_messages WHERE sender_side = ? AND read_at IS NULL",
    [SIDE_INSTITUTION]
  );
  return Number((row && row.n) || 0);
}

/* -------------------------------- queries -------------------------------- */

const LIST_COLUMNS = `
  c.id, c.conversation_code, c.madrasa_id, c.subject, c.category, c.priority, c.status,
  c.created_at, c.updated_at, c.last_message_at, c.last_message_preview, c.last_sender_side,
  c.resolved_at, c.closed_at, c.created_by`;

/**
 * Conversation list for one side.
 *
 * `scope.madrasaId` (institution side) is applied as a hard filter; the
 * platform side may pass an OPTIONAL madrasaId filter, which is only a view
 * filter because the caller is already proven to be the super admin.
 *
 * Unread counts are computed with one correlated subquery per row inside the
 * same statement — no per-conversation follow-up query (no N+1).
 */
async function listConversations({ madrasaId = null, viewerSide, status = "", priority = "", category = "", search = "", limit = 30, offset = 0 }) {
  const unreadSide = viewerSide === SIDE_PLATFORM ? SIDE_INSTITUTION : SIDE_PLATFORM;
  const where = [];
  const params = [];
  if (madrasaId) { where.push("c.madrasa_id = ?"); params.push(madrasaId); }
  if (isStatus(status)) { where.push("c.status = ?"); params.push(cleanStr(status, 20).toLowerCase()); }
  if (PRIORITY_SET.has(cleanStr(priority, 20).toLowerCase())) { where.push("c.priority = ?"); params.push(cleanStr(priority, 20).toLowerCase()); }
  if (CATEGORY_SET.has(cleanStr(category, 40).toLowerCase())) { where.push("c.category = ?"); params.push(cleanStr(category, 40).toLowerCase()); }
  const q = cleanStr(search, 120);
  if (q) {
    // Wildcards are stripped rather than escaped: ESCAPE clauses are written
    // differently by the two drivers, and a literal % in a support search is
    // never meaningful.
    const like = `%${q.replace(/[%_]/g, " ")}%`;
    where.push(`(c.subject LIKE ? OR c.conversation_code LIKE ?
       OR EXISTS (SELECT 1 FROM support_chat_messages sm WHERE sm.conversation_id = c.id AND sm.body LIKE ?))`);
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await db.all(
    `SELECT ${LIST_COLUMNS},
            m.name_en AS institution_name, m.category AS institution_category,
            u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM support_chat_messages sm
              WHERE sm.conversation_id = c.id AND sm.sender_side = ? AND sm.read_at IS NULL) AS unread_count,
            (SELECT COUNT(*) FROM support_chat_messages sm2 WHERE sm2.conversation_id = c.id) AS message_count
       FROM support_conversations c
       JOIN madaris m ON m.id = c.madrasa_id
       LEFT JOIN users u ON u.id = c.created_by
       ${clause}
      ORDER BY c.last_message_at DESC, c.id DESC
      LIMIT ? OFFSET ?`,
    [unreadSide].concat(params, [Math.max(1, Math.min(toNum(limit, 30), 100)), Math.max(0, toNum(offset, 0))])
  );
  const totalRow = await db.get(
    `SELECT COUNT(*) AS n FROM support_conversations c ${clause}`,
    params
  );
  return { conversations: rows, total: Number((totalRow && totalRow.n) || 0) };
}

/**
 * One conversation, scoped. `madrasaId` null means the platform side (super
 * admin). For an institution caller the id AND the tenant must both match, so
 * changing the id in the URL can never reach another institution's thread.
 */
async function getConversation(id, madrasaId) {
  const cid = toNum(id, 0);
  if (!cid) return null;
  const params = [cid];
  let clause = "c.id = ?";
  if (madrasaId) { clause += " AND c.madrasa_id = ?"; params.push(madrasaId); }
  return db.get(
    `SELECT ${LIST_COLUMNS},
            m.name_en AS institution_name, m.category AS institution_category, m.institution_type,
            u.full_name AS created_by_name, u.username AS created_by_username, u.role AS created_by_role,
            a.full_name AS assigned_to_name
       FROM support_conversations c
       JOIN madaris m ON m.id = c.madrasa_id
       LEFT JOIN users u ON u.id = c.created_by
       LEFT JOIN users a ON a.id = c.assigned_to
      WHERE ${clause}`,
    params
  );
}

/**
 * Messages of a conversation, newest-last, paginated backwards from `before`
 * so a long history loads incrementally instead of all at once.
 */
async function listMessages(conversationId, { limit = 40, before = 0 } = {}) {
  const take = Math.max(1, Math.min(toNum(limit, 40), 100));
  const params = [conversationId];
  let clause = "m.conversation_id = ?";
  if (toNum(before, 0) > 0) { clause += " AND m.id < ?"; params.push(toNum(before, 0)); }
  const rows = await db.all(
    `SELECT m.id, m.conversation_id, m.sender_side, m.sender_role, m.body, m.has_attachment,
            m.created_at, m.read_at, u.full_name AS sender_name
       FROM support_chat_messages m
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE ${clause}
      ORDER BY m.id DESC
      LIMIT ?`,
    params.concat([take])
  );
  rows.reverse();
  // One extra query for every attachment in the page (not one per message).
  const ids = rows.filter((r) => r.has_attachment).map((r) => r.id);
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    const atts = await db.all(
      `SELECT id, message_id, file_name, mime_type, file_size FROM support_chat_attachments WHERE message_id IN (${marks})`,
      ids
    );
    const byMessage = new Map();
    for (const a of atts) {
      if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
      byMessage.get(a.message_id).push(a);
    }
    for (const r of rows) r.attachments = byMessage.get(r.id) || [];
  }
  for (const r of rows) if (!r.attachments) r.attachments = [];
  const more = rows.length === take
    ? Boolean(await db.get("SELECT 1 AS x FROM support_chat_messages WHERE conversation_id = ? AND id < ? LIMIT 1", [conversationId, rows[0].id]))
    : false;
  return { messages: rows, hasMore: more };
}

/** Every attachment on a conversation (details panel). */
async function listAttachments(conversationId) {
  return db.all(
    `SELECT a.id, a.message_id, a.file_name, a.mime_type, a.file_size, a.created_at, u.full_name AS uploaded_by_name
       FROM support_chat_attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.conversation_id = ? ORDER BY a.id`,
    [conversationId]
  );
}

/** Attachment row, scoped to the conversation it claims to belong to. */
async function getAttachment(conversationId, attachmentId) {
  return db.get(
    "SELECT * FROM support_chat_attachments WHERE id = ? AND conversation_id = ?",
    [toNum(attachmentId, 0), conversationId]
  );
}

async function recordAttachment(conversation, messageId, file, uploadedBy) {
  await db.run(
    `INSERT INTO support_chat_attachments
       (conversation_id, message_id, madrasa_id, uploaded_by, file_name, storage_name, mime_type, file_size)
     VALUES (?,?,?,?,?,?,?,?)`,
    [conversation.id, messageId, conversation.madrasa_id, uploadedBy,
      safeDisplayName(file.originalname), path.basename(file.filename), cleanStr(file.mimetype, 120), Number(file.size) || 0]
  );
}

/* ----------------------------- notifications ----------------------------- */
/*
   The platform already has one in-app notification system (notifications +
   server/services/communication.js). It is tenant-scoped, so it is used for
   the INSTITUTION side. The super admin sits outside every tenant, so their
   "unread" signal is the backend-computed count on the operator queue rather
   than a second notification framework.

   Previews never carry the message body — only that a reply arrived.
*/
async function notifyInstitution(conversation, { type, title, body }) {
  try {
    const recipients = new Set();
    if (conversation.created_by) recipients.add(Number(conversation.created_by));
    if (!recipients.size) return;
    await communication.createNotifications(conversation.madrasa_id, [...recipients], {
      type,
      title,
      body,
      entity_type: "support_conversation",
      entity_id: conversation.id,
    });
  } catch (e) {
    // A notification must never fail the message that triggered it.
  }
}

module.exports = {
  CATEGORIES, PRIORITIES, STATUSES,
  CATEGORY_SET, PRIORITY_SET, STATUS_SET,
  SIDE_INSTITUTION, SIDE_PLATFORM,
  ATTACHMENT_DIR, ATTACHMENT_EXTENSIONS, ATTACHMENT_TYPES, MAX_ATTACHMENT_MB,
  attachmentTypeAllowed, safeDisplayName, attachmentPath, ensureAttachmentDir,
  normalizeCategory, normalizePriority, isStatus, preview,
  createConversation, addMessage, statusAfterMessage, touchConversation,
  markRead, institutionUnreadCount, platformUnreadCount,
  listConversations, getConversation, listMessages, listAttachments, getAttachment,
  recordAttachment, notifyInstitution,
};
