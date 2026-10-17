"use strict";
/* Communication workspace: private messages, notification centre and the
 * existing parent/guardian directory. All joins include madrasa_id. */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { effectiveTenantId } = require("../middleware/tenant");
const { requireStaffPermission } = require("../services/permissions");
const { requireFeature } = require("../middleware/subscription");
const comm = require("../services/communication");
const delivery = require("../services/delivery");
const audit = require("../services/audit");
const { fileUploader } = require("../middleware/upload");
const messageAttachment = fileUploader("message-attachments", "attachment", { extensions: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".jpg", ".jpeg", ".png", ".webp"], maxMb: 15 });

const router = express.Router();
router.use(requireAuth, requireTenant);
/* Two-way messaging and the delivery log are Basic ("keep parents informed").
   The SMS and WhatsApp CHANNELS are Premium ("WhatsApp/SMS alerts"), so a
   broadcast is gated on the channel it asks for — an email or in-app send is
   judged on `messaging` alone. In-app notifications and announcements are not
   gated: every plan can tell its own community something. */
const channelFeature = (req) => {
  const channel = String((req.body && req.body.channel) || (req.query && req.query.channel) || "").toLowerCase();
  if (channel === "sms") return "sms";
  if (channel === "whatsapp") return "whatsapp";
  return "messaging";
};
const STAFF = requireRole("madrasa_admin", "teacher");
const ADMIN = requireRole("madrasa_admin");

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required." }); return null; }
  return tid;
}
function ids(v) { return comm.asIds(v); }

async function userInTenant(tid, id) {
  return db.get("SELECT id, role, full_name, username, email, phone, student_id FROM users WHERE id = ? AND madrasa_id = ? AND is_active = 1", [id, tid]);
}

/* ---------------------------- private messages ------------------------- */
router.get("/messages", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const q = cleanStr(req.query.search, 120).toLowerCase();
  const folder = cleanStr(req.query.folder, 20).toLowerCase() || "inbox";
  const params = [tid, req.user.id];
  let where = folder === "sent"
    ? "m.madrasa_id = ? AND m.user_id = ? AND m.message_type = 'direct'"
    : "m.madrasa_id = ? AND m.recipient_user_id = ? AND m.message_type = 'direct'";
  if (folder === "all") { where = "m.madrasa_id = ? AND (m.user_id = ? OR m.recipient_user_id = ?)"; params.push(req.user.id); }
  if (q) { where += " AND (LOWER(m.body) LIKE ? OR LOWER(COALESCE(c.subject,'')) LIKE ?)"; params.push(`%${q}%`, `%${q}%`); }
  const rows = await db.all(
    `SELECT m.id, m.conversation_id, m.user_id, m.recipient_user_id, m.body, m.created_at, m.read_at,
            m.attachment_path, m.attachment_name, c.subject,
            sender.full_name AS sender_name, recipient.full_name AS recipient_name
       FROM messages m
       LEFT JOIN communication_conversations c ON c.id = m.conversation_id AND c.madrasa_id = m.madrasa_id
       LEFT JOIN users sender ON sender.id = m.user_id AND sender.madrasa_id = m.madrasa_id
       LEFT JOIN users recipient ON recipient.id = m.recipient_user_id AND recipient.madrasa_id = m.madrasa_id
      WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT 300`, params
  );
  ok(res, { messages: rows });
}));

router.get("/conversations", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const rows = await db.all(
    `SELECT c.id, c.subject, c.kind, c.status, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM communication_participants p WHERE p.madrasa_id = c.madrasa_id AND p.conversation_id = c.id) AS participant_count,
            (SELECT COUNT(*) FROM messages m WHERE m.madrasa_id = c.madrasa_id AND m.conversation_id = c.id AND m.recipient_user_id = ? AND m.read_at IS NULL) AS unread_count,
            (SELECT m.body FROM messages m WHERE m.madrasa_id = c.madrasa_id AND m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM communication_conversations c
       JOIN communication_participants me ON me.conversation_id = c.id AND me.madrasa_id = c.madrasa_id AND me.user_id = ?
      WHERE c.madrasa_id = ? AND c.status <> 'deleted' AND me.archived_at IS NULL
      ORDER BY c.updated_at DESC, c.id DESC`, [req.user.id, req.user.id, tid]
  );
  ok(res, { conversations: rows });
}));

router.get("/conversations/:id", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const id = toNum(req.params.id, 0);
  const allowed = await db.get("SELECT id FROM communication_participants WHERE madrasa_id = ? AND conversation_id = ? AND user_id = ? AND archived_at IS NULL", [tid, id, req.user.id]);
  if (!allowed) return res.status(404).json({ error: "Conversation not found." });
  const conversation = await db.get("SELECT * FROM communication_conversations WHERE id = ? AND madrasa_id = ?", [id, tid]);
  const participants = await db.all("SELECT p.user_id, p.participant_role, u.full_name, u.username, u.role FROM communication_participants p JOIN users u ON u.id = p.user_id AND u.madrasa_id = p.madrasa_id WHERE p.madrasa_id = ? AND p.conversation_id = ?", [tid, id]);
  const messages = await db.all("SELECT m.*, u.full_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.user_id AND u.madrasa_id = m.madrasa_id WHERE m.madrasa_id = ? AND m.conversation_id = ? ORDER BY m.id", [tid, id]);
  await db.run("UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE madrasa_id = ? AND conversation_id = ? AND recipient_user_id = ? AND read_at IS NULL", [tid, id, req.user.id]);
  await db.run("UPDATE communication_participants SET last_read_at = CURRENT_TIMESTAMP WHERE madrasa_id = ? AND conversation_id = ? AND user_id = ?", [tid, id, req.user.id]);
  ok(res, { conversation, participants, messages });
}));

router.post("/messages", requireFeature("messaging"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const recipientIds = [...new Set(ids(b.recipient_user_ids ?? b.recipient_ids ?? b.recipient_user_id))].filter((id) => id !== Number(req.user.id));
  if (!recipientIds.length) return err(res, 400, "At least one recipient is required.");
  const recipients = [];
  for (const id of recipientIds) {
    const u = await userInTenant(tid, id);
    if (!u) return err(res, 400, "One or more recipients are not available in this institution.");
    if (!comm.RECIPIENT_ROLES.includes(u.role)) return err(res, 400, "That user cannot receive internal messages.");
    // Student and parent accounts may only write to staff (administrators and
    // their teachers). A family account messaging an arbitrary student would
    // be unrestricted contact with minors — the backend refuses it outright.
    if ((req.user.role === "student" || req.user.role === "parent") && !comm.STAFF_ROLES.includes(u.role)) {
      return err(res, 400, "You can only message teachers and administrators.");
    }
    recipients.push(u);
  }
  const body = cleanStr(b.body ?? b.content, 10000); if (!body) return err(res, 400, "Message body is required.");
  const kind = recipientIds.length > 1 ? "group" : "individual";
  const result = await db.transaction(async (tx) => {
    const c = await tx.run("INSERT INTO communication_conversations (madrasa_id, subject, kind, created_by) VALUES (?,?,?,?)", [tid, cleanStr(b.subject, 200), kind, req.user.id]);
    const conversationId = Number(c.lastInsertRowid);
    const everyone = [Number(req.user.id)].concat(recipientIds);
    for (const userId of [...new Set(everyone)]) {
      const user = userId === Number(req.user.id) ? req.user : recipients.find((x) => Number(x.id) === userId);
      await tx.run("INSERT INTO communication_participants (madrasa_id, conversation_id, user_id, participant_role) VALUES (?,?,?,?)", [tid, conversationId, userId, user.role || ""]);
    }
    const idsOut = [];
    for (const recipientId of recipientIds) {
      const m = await tx.run(
        "INSERT INTO messages (madrasa_id, scope, user_id, author_name, body, conversation_id, recipient_user_id, message_type, attachment_path, attachment_name, attachment_mime) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [tid, "direct", req.user.id, cleanStr(req.user.fullName || req.user.username, 160), body, conversationId, recipientId, "direct", cleanStr(b.attachment_path, 500), cleanStr(b.attachment_name, 255), cleanStr(b.attachment_mime, 120)]
      );
      idsOut.push(Number(m.lastInsertRowid));
    }
    return { conversationId, messageIds: idsOut };
  });
  for (const recipient of recipients) {
    await comm.createNotifications(tid, [recipient.id], { type: "message", title: cleanStr(b.subject, 200) || "New message", body, entity_type: "conversation", entity_id: result.conversationId });
    await comm.recordCommunication(tid, { recipient_user_id: recipient.id, parent_user_id: recipient.role === "parent" ? recipient.id : null, channel: "in_app", message_type: "message", subject: cleanStr(b.subject, 200), message: body, sent_by: req.user.id });
  }
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "communication.message.send", entity: "conversation", entityId: String(result.conversationId), ip: req.ip });
  ok(res, Object.assign({ ok: true }, result));
}));

router.post("/messages/:id/attachment", messageAttachment, asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const id = toNum(req.params.id, 0);
  const message = await db.get("SELECT id, conversation_id FROM messages WHERE id = ? AND madrasa_id = ? AND (user_id = ? OR recipient_user_id = ?)", [id, tid, req.user.id, req.user.id]);
  if (!message) return res.status(404).json({ error: "Message not found." });
  if (!req.file) return err(res, 400, "Attachment is required.");
  const path = `/uploads/message-attachments/${req.file.filename}`;
  await db.run("UPDATE messages SET attachment_path = ?, attachment_name = ?, attachment_mime = ? WHERE id = ? AND madrasa_id = ?", [path, cleanStr(req.file.originalname, 255), cleanStr(req.file.mimetype, 120), id, tid]);
  ok(res, { ok: true, attachment_path: path, attachment_name: cleanStr(req.file.originalname, 255), attachment_mime: req.file.mimetype });
}));

router.patch("/conversations/:id/archive", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const id = toNum(req.params.id, 0);
  const p = await db.get("SELECT id FROM communication_participants WHERE madrasa_id = ? AND conversation_id = ? AND user_id = ?", [tid, id, req.user.id]);
  if (!p) return res.status(404).json({ error: "Conversation not found." });
  await db.run("UPDATE communication_participants SET archived_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [p.id, tid]); ok(res, { ok: true });
}));

router.patch("/messages/:id/read", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const r = await db.run("UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ? AND recipient_user_id = ?", [toNum(req.params.id, 0), tid, req.user.id]);
  if (!r.changes) return res.status(404).json({ error: "Message not found." }); ok(res, { ok: true });
}));

/* ---------------------------- notification centre --------------------- */
router.get("/notifications", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const limit = Math.min(300, Math.max(1, toNum(req.query.limit, 100)));
  const rows = await db.all("SELECT * FROM notifications WHERE madrasa_id = ? AND recipient_user_id = ? ORDER BY id DESC LIMIT ?", [tid, req.user.id, limit]);
  const unread = await db.get("SELECT COUNT(*) AS n FROM notifications WHERE madrasa_id = ? AND recipient_user_id = ? AND read_at IS NULL", [tid, req.user.id]);
  ok(res, { notifications: rows, unread: Number(unread.n || 0) });
}));
router.patch("/notifications/:id/read", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const r = await db.run("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ? AND recipient_user_id = ?", [toNum(req.params.id, 0), tid, req.user.id]);
  if (!r.changes) return res.status(404).json({ error: "Notification not found." }); ok(res, { ok: true });
}));
router.post("/notifications/read-all", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  await db.run("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE madrasa_id = ? AND recipient_user_id = ? AND read_at IS NULL", [tid, req.user.id]); ok(res, { ok: true });
}));
router.get("/notification-preferences", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  ok(res, { preferences: await db.all("SELECT * FROM notification_preferences WHERE madrasa_id = ? AND user_id = ? ORDER BY notification_type", [tid, req.user.id]) });
}));
router.put("/notification-preferences", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {}; const type = cleanStr(b.notification_type || "*", 50);
  const values = [b.in_app === false || b.in_app === "0" ? 0 : 1, b.email ? 1 : 0, b.sms ? 1 : 0, b.whatsapp ? 1 : 0];
  const existing = await db.get("SELECT id FROM notification_preferences WHERE madrasa_id = ? AND user_id = ? AND notification_type = ?", [tid, req.user.id, type]);
  if (existing) await db.run("UPDATE notification_preferences SET in_app=?,email=?,sms=?,whatsapp=? WHERE id=? AND madrasa_id=?", values.concat([existing.id, tid]));
  else await db.run("INSERT INTO notification_preferences (madrasa_id,user_id,notification_type,in_app,email,sms,whatsapp) VALUES (?,?,?,?,?,?,?)", [tid, req.user.id, type].concat(values));
  ok(res, { ok: true });
}));

/* ---------------------------- parent communication --------------------- */
router.get("/parents", STAFF, requireStaffPermission("communication.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const q = cleanStr(req.query.search, 120).toLowerCase();
  const where = ["u.madrasa_id = ?", "u.role = 'parent'", "u.is_active = 1"]; const params = [tid];
  if (q) { where.push("(LOWER(COALESCE(u.full_name,'')) LIKE ? OR LOWER(COALESCE(u.username,'')) LIKE ? OR LOWER(COALESCE(u.email,'')) LIKE ? OR LOWER(COALESCE(u.phone,'')) LIKE ?)"); const x = `%${q}%`; params.push(x,x,x,x); }
  const parents = await db.all(`SELECT u.id,u.username,u.full_name,u.email,u.phone,u.is_active FROM users u WHERE ${where.join(" AND ")} ORDER BY u.full_name`, params);
  // Batched children lookup (was one query per parent — an N+1 that made this
  // page run one query per parent in the tenant). Same rows, one query per
  // chunk of parent ids, grouped here in memory.
  const childrenByParent = new Map();
  for (let i = 0; i < parents.length; i += 500) {
    const chunk = parents.slice(i, i + 500).map((p) => Number(p.id));
    if (!chunk.length) continue;
    const cm = chunk.map(() => "?").join(",");
    const rows = await db.all(`SELECT pl.user_id,s.id,s.admission_no,s.first_name,s.last_name,s.class_id,c.name_en AS class_name FROM parent_links pl JOIN students s ON s.id=pl.student_id AND s.madrasa_id=pl.madrasa_id LEFT JOIN classes c ON c.id=s.class_id AND c.madrasa_id=s.madrasa_id WHERE pl.madrasa_id=? AND pl.user_id IN (${cm}) ORDER BY s.last_name,s.first_name`, [tid].concat(chunk));
    for (const r of rows) {
      const uid = Number(r.user_id);
      if (!childrenByParent.has(uid)) childrenByParent.set(uid, []);
      childrenByParent.get(uid).push({ id: r.id, admission_no: r.admission_no, first_name: r.first_name, last_name: r.last_name, class_id: r.class_id, class_name: r.class_name });
    }
  }
  for (const p of parents) {
    p.children = childrenByParent.get(Number(p.id)) || [];
  }
  ok(res, { parents });
}));
router.get("/parents/:id/history", STAFF, requireStaffPermission("communication.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const parent = await userInTenant(tid, toNum(req.params.id, 0)); if (!parent || parent.role !== "parent") return res.status(404).json({ error: "Parent not found." });
  ok(res, { history: await db.all("SELECT * FROM communication_history WHERE madrasa_id = ? AND (recipient_user_id = ? OR parent_user_id = ?) ORDER BY id DESC LIMIT 300", [tid,parent.id,parent.id]) });
}));
router.post("/parents/send", STAFF, requireFeature(channelFeature), requireStaffPermission("communication.send"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {}; let recipientIds = ids(b.parent_ids ?? b.recipient_ids ?? b.parent_id);
  if (b.class_id) {
    const rows = await db.all("SELECT DISTINCT pl.user_id FROM parent_links pl JOIN students s ON s.id=pl.student_id AND s.madrasa_id=pl.madrasa_id WHERE pl.madrasa_id=? AND s.class_id=?", [tid, toNum(b.class_id,0)]); recipientIds = recipientIds.concat(rows.map((r) => r.user_id));
  }
  if (b.student_id) {
    const rows = await db.all("SELECT user_id FROM parent_links WHERE madrasa_id=? AND student_id=?", [tid, toNum(b.student_id,0)]); recipientIds = recipientIds.concat(rows.map((r) => r.user_id));
  }
  recipientIds = [...new Set(recipientIds)];
  const validParents = [];
  for (const recipientId of recipientIds) { const parent = await userInTenant(tid, recipientId); if (parent && parent.role === "parent") validParents.push(parent.id); }
  recipientIds = [...new Set(validParents)]; if (!recipientIds.length) return err(res, 400, "Choose at least one parent, class or student.");
  const body = cleanStr(b.message ?? b.body, 10000); if (!body) return err(res, 400, "Message is required.");
  const notificationIds = await comm.createNotifications(tid, recipientIds, { type: cleanStr(b.message_type,50) || "parent_communication", title: cleanStr(b.subject,200) || "School message", body });
  for (const recipientId of recipientIds) {
    const child = b.student_id ? toNum(b.student_id,0) : null;
    await comm.recordCommunication(tid, { recipient_user_id: recipientId, parent_user_id: recipientId, student_id: child, channel: cleanStr(b.channel,20) || "in_app", message_type: cleanStr(b.message_type,50) || "parent_communication", subject: cleanStr(b.subject,200), message: body, sent_by: req.user.id });
  }
  ok(res, { ok: true, recipientIds, notificationIds });
}));
router.get("/history", STAFF, requireStaffPermission("communication.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const studentId = toNum(req.query.studentId,0); const parentId = toNum(req.query.parentId,0);
  const where = ["madrasa_id = ?"]; const params = [tid]; if (studentId) { where.push("student_id = ?"); params.push(studentId); } if (parentId) { where.push("(parent_user_id = ? OR recipient_user_id = ?)"); params.push(parentId,parentId); }
  ok(res, { history: await db.all(`SELECT * FROM communication_history WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 500`, params) });
}));

/* ------------------------- external delivery providers ------------------ */
/* Read-only provider status. Deliberately returns booleans only — an API key
 * or password must never reach the browser. */
router.get("/delivery/providers", ADMIN, requireFeature("messaging"), requireStaffPermission("communication.templates"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  ok(res, { providers: delivery.providerStatus() });
}));

/* Delivery log = the existing communication_history table filtered to the
 * channels that leave the platform (plus in-app rows when asked). */
router.get("/delivery/log", STAFF, requireFeature("messaging"), requireStaffPermission("communication.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const where = ["h.madrasa_id = ?"]; const params = [tid];
  const channel = cleanStr(req.query.channel, 20).toLowerCase();
  if (channel && channel !== "all") { where.push("h.channel = ?"); params.push(channel); }
  else where.push("h.channel <> 'in_app'");
  const status = cleanStr(req.query.status, 20).toLowerCase();
  if (status && status !== "all") { where.push("h.delivery_status = ?"); params.push(status); }
  const limit = Math.min(500, Math.max(1, toNum(req.query.limit, 200)));
  const rows = await db.all(
    `SELECT h.id, h.channel, h.message_type, h.subject, h.message, h.delivery_status, h.error_message,
            h.provider, h.provider_message_id, h.recipient_address, h.retry_count, h.delivered_at,
            h.created_at AS sent_at, h.recipient_user_id,
            u.full_name AS recipient_name, u.username AS recipient_username
       FROM communication_history h
       LEFT JOIN users u ON u.id = h.recipient_user_id AND u.madrasa_id = h.madrasa_id
      WHERE ${where.join(" AND ")} ORDER BY h.id DESC LIMIT ?`, params.concat([limit])
  );
  const totals = await db.all(
    "SELECT delivery_status AS status, COUNT(*) AS n FROM communication_history WHERE madrasa_id = ? AND channel <> 'in_app' GROUP BY delivery_status",
    [tid]
  );
  ok(res, { log: rows, totals });
}));

/**
 * Retries a FAILED outbound message.
 *
 * Only a failed row can be retried (a delivered message must never be sent
 * twice), the retry count is capped so a permanently bad address cannot be
 * hammered, and the original row is updated in place rather than duplicated —
 * so the delivery log stays one row per message with an honest attempt count.
 */
const MAX_DELIVERY_RETRIES = 3;
router.post("/delivery/:id/retry", ADMIN, requireFeature("messaging"), requireStaffPermission("communication.send"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await db.get(
    "SELECT * FROM communication_history WHERE id = ? AND madrasa_id = ?",
    [toNum(req.params.id, 0), tid]
  );
  if (!row) return err(res, 404, "Message not found.");
  if (row.delivery_status !== "failed") {
    return err(res, 409, "Only a failed message can be retried.", { code: "INVALID_STATUS_TRANSITION", current: row.delivery_status });
  }
  const attempts = Number(row.retry_count || 0);
  if (attempts >= MAX_DELIVERY_RETRIES) {
    return err(res, 409, `This message has already been retried ${attempts} times. Correct the recipient's contact details first.`, { code: "RETRY_LIMIT" });
  }

  // Re-resolve the address from the user record so a corrected phone number
  // or email address is actually picked up by the retry.
  let address = cleanStr(row.recipient_address, 255);
  if (row.recipient_user_id) {
    const user = await db.get("SELECT email, phone FROM users WHERE id = ? AND madrasa_id = ?", [row.recipient_user_id, tid]);
    if (user) {
      const resolved = row.channel === "email" ? delivery.validEmail(user.email) : delivery.normalisePhone(user.phone);
      if (resolved) address = resolved;
    }
  }
  if (!address) return err(res, 400, "There is still no contact detail on file for this recipient.");

  const result = await delivery.send(row.channel, address, { subject: row.subject, message: row.message });
  const status = result.ok ? "sent" : result.skipped ? "skipped" : "failed";
  await db.run(
    `UPDATE communication_history
        SET delivery_status = ?, error_message = ?, provider = ?, provider_message_id = ?,
            recipient_address = ?, retry_count = ?, delivered_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE delivered_at END
      WHERE id = ? AND madrasa_id = ?`,
    [status, cleanStr(result.error || result.reason || "", 500), cleanStr(result.provider || "", 30),
     cleanStr(result.id || result.messageId || "", 160), address, attempts + 1, status, row.id, tid]
  );
  await audit.record(req, {
    action: "communication.retry", module: "communication", entity: "communication_history", entityId: row.id,
    before: { delivery_status: "failed", retry_count: attempts },
    after: { delivery_status: status, retry_count: attempts + 1 },
    meta: { channel: row.channel },
  });
  ok(res, { ok: result.ok === true, status, retry_count: attempts + 1, error: result.error || result.reason || null });
}));

/* Send a single test message to the administrator's own address/number. */
router.post("/delivery/test", ADMIN, requireFeature(channelFeature), requireStaffPermission("communication.send"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const channel = cleanStr(b.channel, 20).toLowerCase();
  if (!["email", "sms", "whatsapp"].includes(channel)) return err(res, 400, "Choose email, sms or whatsapp.");
  const me = await userInTenant(tid, req.user.id);
  const recipient = cleanStr(b.to, 255) || (channel === "email" ? (me && me.email) || "" : (me && me.phone) || "");
  if (!recipient) return err(res, 400, `Add a destination ${channel === "email" ? "email address" : "phone number"} first.`);
  const message = cleanStr(b.message, 500) || "Test message from your school dashboard. Delivery is working.";
  const subject = cleanStr(b.subject, 200) || "Delivery test";
  const result = await delivery.send(channel, recipient, { subject, message });
  await comm.recordCommunication(tid, {
    recipient_user_id: req.user.id, channel, message_type: "delivery_test", subject, message,
    delivery_status: result.ok ? "sent" : result.skipped ? "skipped" : "failed",
    error_message: result.error || result.reason || "", provider: result.provider,
    provider_message_id: result.messageId, recipient_address: recipient, sent_by: req.user.id,
  });
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "delivery.test", entity: "communication", entityId: channel, meta: { ok: !!result.ok }, ip: req.ip });
  ok(res, { ok: !!result.ok, skipped: !!result.skipped, provider: result.provider, messageId: result.messageId, error: result.error || result.reason || "" });
}));

/* -------------------------------- bulk send ----------------------------- */
async function resolveBulkRecipients(tid, target) {
  const t = cleanStr(target, 60) || "all_parents";
  if (t.startsWith("class:")) {
    const classId = toNum(t.slice(6), 0);
    if (!classId) return [];
    return db.all(
      `SELECT DISTINCT u.id, u.full_name, u.username, u.email, u.phone
         FROM parent_links pl
         JOIN students s ON s.id = pl.student_id AND s.madrasa_id = pl.madrasa_id
         JOIN users u ON u.id = pl.user_id AND u.madrasa_id = pl.madrasa_id
        WHERE pl.madrasa_id = ? AND s.class_id = ? AND u.is_active = 1`, [tid, classId]
    );
  }
  if (t === "outstanding_fees") {
    const { buildBalances } = require("./fees");
    const rows = await buildBalances(tid, {});
    const ids = [...new Set(rows.filter((r) => r.outstanding_balance > 0 && r.parent_user_id).map((r) => Number(r.parent_user_id)))];
    if (!ids.length) return [];
    return db.all(
      `SELECT id, full_name, username, email, phone FROM users WHERE madrasa_id = ? AND is_active = 1 AND id IN (${ids.map(() => "?").join(",")})`,
      [tid].concat(ids)
    );
  }
  return db.all("SELECT id, full_name, username, email, phone FROM users WHERE madrasa_id = ? AND role = 'parent' AND is_active = 1", [tid]);
}

router.post("/bulk", ADMIN, requireFeature(channelFeature), requireStaffPermission("communication.send"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const channel = cleanStr(b.channel, 20).toLowerCase();
  if (!["sms", "email", "whatsapp"].includes(channel)) return err(res, 400, "Channel must be sms, email or whatsapp.");
  const target = cleanStr(b.target, 60) || "all_parents";
  if (!(target === "all_parents" || target === "outstanding_fees" || /^class:\d+$/.test(target))) return err(res, 400, "Unknown target audience.");
  const message = cleanStr(b.message, 5000);
  if (!message) return err(res, 400, "Message is required.");
  const subject = cleanStr(b.subject, 200) || "School message";

  const recipients = await resolveBulkRecipients(tid, target);
  let sent = 0, failed = 0, skipped = 0;
  const results = [];
  for (const user of recipients) {
    const address = channel === "email" ? delivery.validEmail(user.email) : delivery.normalisePhone(user.phone);
    if (!address) {
      failed++;
      results.push({ user_id: user.id, name: user.full_name || user.username, status: "failed", error: "No contact detail on file." });
      await comm.recordCommunication(tid, { recipient_user_id: user.id, parent_user_id: user.id, channel, message_type: "bulk_message", subject, message, delivery_status: "failed", error_message: "No contact detail on file.", sent_by: req.user.id });
      continue;
    }
    const r = await delivery.send(channel, address, { subject, message });
    const status = r.ok ? "sent" : r.skipped ? "skipped" : "failed";
    if (r.ok) sent++; else if (r.skipped) skipped++; else failed++;
    results.push({ user_id: user.id, name: user.full_name || user.username, status, error: r.error || r.reason || "" });
    await comm.recordCommunication(tid, {
      recipient_user_id: user.id, parent_user_id: user.id, channel, message_type: "bulk_message", subject, message,
      delivery_status: status, error_message: r.error || r.reason || "", provider: r.provider,
      provider_message_id: r.messageId, recipient_address: address, sent_by: req.user.id,
    });
  }
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "communication.bulk", entity: "communication", entityId: target, meta: { channel, sent, failed, skipped }, ip: req.ip });
  ok(res, { ok: true, sent, failed, skipped, recipients: recipients.length, results });
}));

/* Friendly aliases used by integrations while the admin UI keeps the
 * Communication section as the only entry point. A root request is the
 * notification centre when this router is mounted at /api/notifications. */
router.get("/", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const rows = await db.all("SELECT * FROM notifications WHERE madrasa_id = ? AND recipient_user_id = ? ORDER BY id DESC LIMIT 100", [tid, req.user.id]);
  const unread = await db.get("SELECT COUNT(*) AS n FROM notifications WHERE madrasa_id = ? AND recipient_user_id = ? AND read_at IS NULL", [tid, req.user.id]);
  ok(res, { notifications: rows, unread: Number(unread.n || 0) });
}));
module.exports = router;
