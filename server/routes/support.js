"use strict";
/* ============================================================================
   Platform support tickets — institution side
   ----------------------------------------------------------------------------
   An institution administrator raises a ticket with the platform operator
   (EduSphere). This is the tenant's half: create, list and reply to tickets that
   belong to YOUR institution only. The operator's queue lives in
   /api/platform/tickets (super admin).

   Tenant isolation is absolute: every query filters by the caller's own
   madrasa_id, and notes marked internal_only by the operator are never
   returned to the institution.
   ========================================================================== */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { effectiveTenantId } = require("../middleware/tenant");
const { requirePermission } = require("../services/permissions");
const { gateFeature } = require("../middleware/subscription");

const router = express.Router();
router.use(requireAuth, requireTenant, requireRole("madrasa_admin"));
const ADMIN = requireRole("madrasa_admin");

const CATEGORIES = new Set(["general", "billing", "technical", "admissions", "data", "feature_request", "security"]);
const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const STATUSES = new Set(["open", "in_progress", "awaiting_reply", "resolved", "closed"]);

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { res.status(400).json({ error: "Madrasa context required." }); return null; }
  return tid;
}

async function ticketRow(tid, id) {
  return db.get(
    `SELECT t.*, m.name_en AS madrasa_name, u.full_name AS created_by_name
       FROM support_tickets t
       JOIN madaris m ON m.id = t.madrasa_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE t.id = ? AND t.madrasa_id = ?`,
    [id, tid]
  );
}

/* ------------------------------- list/create ----------------------------- */

router.get("/tickets", requirePermission("support.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const where = ["t.madrasa_id = ?"]; const params = [tid];
  if (req.query.status && STATUSES.has(cleanStr(req.query.status, 20))) { where.push("t.status = ?"); params.push(cleanStr(req.query.status, 20)); }
  if (req.query.priority && PRIORITIES.has(cleanStr(req.query.priority, 20))) { where.push("t.priority = ?"); params.push(cleanStr(req.query.priority, 20)); }
  const rows = await db.all(
    `SELECT t.*, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM support_ticket_notes n WHERE n.ticket_id = t.id AND n.internal_only = 0) AS note_count
       FROM support_tickets t
       LEFT JOIN users u ON u.id = t.created_by
      WHERE ${where.join(" AND ")} ORDER BY t.updated_at DESC, t.id DESC LIMIT 200`,
    params
  );
  ok(res, { tickets: rows });
}));

router.post("/tickets", requirePermission("support.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const subject = cleanStr(b.subject, 200);
  const body = cleanStr(b.body, 10000);
  if (!subject) return err(res, 400, "Subject is required.");
  if (!body) return err(res, 400, "Please describe the issue.");
  const category = CATEGORIES.has(cleanStr(b.category, 40)) ? cleanStr(b.category, 40) : "general";
  const priority = PRIORITIES.has(cleanStr(b.priority, 20)) ? cleanStr(b.priority, 20) : "medium";
  // Every plan can raise a ticket and get an answer. Jumping the queue is what
  // "priority support + onboarding" (Premium) sells, so `urgent` is the gate —
  // and the refusal tells the school exactly what upgrading would change.
  if (priority === "urgent") {
    if (!(await gateFeature(req, res, tid, "priority_support"))) return;
  }
  const result = await db.run(
    "INSERT INTO support_tickets (madrasa_id, subject, body, category, priority, status, created_by) VALUES (?,?,?,?,?,'open',?)",
    [tid, subject, body, category, priority, req.user.id]
  );
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "support.ticket.create", entity: "support_ticket", entityId: String(result.lastInsertRowid), meta: { subject, priority }, ip: req.ip });
  ok(res, { ok: true, id: Number(result.lastInsertRowid) });
}));

/* ------------------------------ detail/reply ----------------------------- */

router.get("/tickets/:id", requirePermission("support.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const ticket = await ticketRow(tid, toNum(req.params.id, 0));
  if (!ticket) return err(res, 404, "Ticket not found.");
  // The operator's internal notes are for the operator only.
  const notes = await db.all(
    `SELECT n.id, n.note, n.created_at, n.author_role, u.full_name AS author_name
       FROM support_ticket_notes n
       LEFT JOIN users u ON u.id = n.author_user_id
      WHERE n.ticket_id = ? AND n.madrasa_id = ? AND n.internal_only = 0
      ORDER BY n.id`,
    [ticket.id, tid]
  );
  ok(res, { ticket, notes });
}));

router.post("/tickets/:id/notes", requirePermission("support.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const ticket = await ticketRow(tid, toNum(req.params.id, 0));
  if (!ticket) return err(res, 404, "Ticket not found.");
  if (["resolved", "closed"].includes(ticket.status)) return err(res, 409, "This ticket is closed. Raise a new ticket to continue.");
  const note = cleanStr(req.body && req.body.note, 10000);
  if (!note) return err(res, 400, "Reply cannot be empty.");
  await db.run(
    "INSERT INTO support_ticket_notes (madrasa_id, ticket_id, author_user_id, author_role, note, internal_only) VALUES (?,?,?,?,?,0)",
    [tid, ticket.id, req.user.id, req.user.role, note]
  );
  // A reply from the institution puts the ball back in the operator's court.
  await db.run("UPDATE support_tickets SET status='open', updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [ticket.id, tid]);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "support.ticket.reply", entity: "support_ticket", entityId: String(ticket.id), ip: req.ip });
  ok(res, { ok: true });
}));

/** The institution may close its own ticket once it is satisfied. */
router.patch("/tickets/:id", requirePermission("support.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const ticket = await ticketRow(tid, toNum(req.params.id, 0));
  if (!ticket) return err(res, 404, "Ticket not found.");
  const status = cleanStr(req.body && req.body.status, 20);
  if (!["closed", "open"].includes(status)) return err(res, 400, "You can only close or reopen your own ticket.");
  await db.run("UPDATE support_tickets SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND madrasa_id=?", [status, ticket.id, tid]);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: `support.ticket.${status === "closed" ? "close" : "reopen"}`, entity: "support_ticket", entityId: String(ticket.id), ip: req.ip });
  ok(res, { ok: true });
}));

module.exports = { router, CATEGORIES, PRIORITIES, STATUSES };
