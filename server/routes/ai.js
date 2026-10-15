"use strict";
/* ============================================================================
   EDUSPHERE AI — routes
   ----------------------------------------------------------------------------
   Four mounts, one assistant:

     /api/ai/*            logged-in dashboard assistant (tenant-scoped tools)
     /api/public/ai/*     the public marketing website
     /api/ai/whatsapp     the WhatsApp line (webhook, provider-signature verified)
     /api/platform/ai/*   the operator's knowledge-base editor

   SECURITY MODEL (read this before adding a tool):
   A tool's `run(args, ctx)` receives the tenant id from `ctx`, which the route
   built from the AUTHENTICATED SESSION. The model never supplies a tenant id,
   so prompt injection cannot make it read another institution's data.
   There is deliberately NO tool that changes a plan or approves a payment —
   the assistant can only REQUEST an upgrade, which still needs to be paid.
   ========================================================================== */
const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const config = require("../config");
const ai = require("../services/ai");
const subscription = require("../services/subscription");
const { requireAuth, requireSuperAdmin } = require("../middleware/auth");
const { effectiveTenantId } = require("../middleware/tenant");
const { asyncHandler, err, ok, cleanStr, toNum, logActivity } = require("../util");

const appRouter = express.Router();
const publicRouter = express.Router();
const whatsappRouter = express.Router();
const platformRouter = express.Router();

/* ----------------------- tiny in-memory rate limiter ---------------------- */
/* Deliberately separate from the global API limiter: the assistant is a
   paid-per-token surface and needs its own, tighter budget. */
const buckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${req.ip || "unknown"}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now > b.resetAt) { buckets.set(key, { count: 1, resetAt: now + windowMs }); return next(); }
    if (b.count >= max) return res.status(429).json({ error: "You are sending messages too quickly. Please wait a moment." });
    b.count += 1;
    next();
  };
}
const appLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

/* ============================================================================
   SHARED TOOLS
   ========================================================================== */

/** Public, non-sensitive plan catalogue. Safe on every surface. */
async function planCatalogue() {
  const plans = await subscription.plansForUpgrade();
  return {
    plans: plans.map((p) => ({
      code: p.code,
      name: p.name,
      description: p.description || "",
      price_monthly_ngn: p.price_monthly_ngn !== undefined ? p.price_monthly_ngn : Number(p.price_ngn || 0),
      price_yearly_ngn: Number(p.price_yearly_ngn || 0),
      student_limit: Number(p.student_limit),   // -1 = unlimited
      teacher_limit: Number(p.teacher_limit),
      trial_days: Number(p.trial_days || 0),
    })),
    currency: "NGN",
  };
}

const TOOL_LIST_PLANS = {
  name: "list_plans",
  description: "List the EduSphere subscription plans with their Naira prices and student/teacher limits. Use this whenever someone asks about pricing, plans or which plan fits them.",
  parameters: { type: "object", properties: {} },
  run: async () => planCatalogue(),
};

/* ============================================================================
   APP SURFACE (logged-in institution)
   ========================================================================== */

function appTools(ctx) {
  return [
    TOOL_LIST_PLANS,
    {
      name: "get_my_subscription",
      description: "Get the caller's current plan, subscription status, renewal date and how many days are left.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const s = await subscription.summary(ctx.madrasaId);
        if (!s) return { error: "Subscription not found." };
        return {
          plan: s.plan.name,
          status: s.subscription.status,
          billing_cycle: s.subscription.billing_cycle,
          expires_at: s.subscription.expires_at,
          days_remaining: s.subscription.days_remaining,
          grace_ends_at: s.subscription.grace_ends_at,
        };
      },
    },
    {
      name: "get_my_usage",
      description: "Get how many students and teachers this institution currently has against its plan limits.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const s = await subscription.summary(ctx.madrasaId);
        if (!s) return { error: "Subscription not found." };
        return {
          students: { used: s.usage.students.count, limit: s.usage.students.limit, unlimited: s.usage.students.unlimited, percent: s.usage.students.percent },
          teachers: { used: s.usage.teachers.count, limit: s.usage.teachers.limit, unlimited: s.usage.teachers.unlimited, percent: s.usage.teachers.percent },
        };
      },
    },
    {
      name: "get_my_invoices",
      description: "List this institution's recent subscription invoices with their status and amounts.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const rows = await subscription.listInvoices(ctx.madrasaId, 10);
        return {
          invoices: rows.map((i) => ({
            invoice_no: i.invoice_no, plan: i.plan_name, amount_ngn: Number(i.amount_ngn),
            cycle: i.billing_cycle, status: i.status, reference: i.reference,
            created: String(i.created_at).slice(0, 10),
          })),
        };
      },
    },
    {
      name: "create_upgrade_request",
      description: "Create an upgrade or renewal REQUEST and return the payment instructions. This does NOT activate anything — the plan only changes once the payment is confirmed by the EduSphere team. Ask the user to confirm the plan and billing cycle first.",
      parameters: {
        type: "object",
        properties: {
          plan_code: { type: "string", description: "The plan code, e.g. basic or premium. Use list_plans to get valid codes." },
          billing_cycle: { type: "string", enum: ["monthly", "yearly"], description: "Billing cycle. Defaults to yearly." },
        },
        required: ["plan_code"],
      },
      run: async (args) => {
        const code = cleanStr(args.plan_code, 30).toLowerCase();
        const plan = await db.get("SELECT id, code, name FROM plans WHERE code = ? AND is_active = 1", [code]);
        if (!plan) return { error: `There is no active plan called "${code}".`, hint: "Call list_plans for the valid codes." };
        const cycle = args.billing_cycle === "monthly" ? "monthly" : "yearly";
        const out = await subscription.requestUpgrade(ctx.madrasaId, {
          planId: plan.id, cycle, method: "bank_transfer", note: "Requested via EduSphere AI", userId: ctx.userId || null,
        });
        const s = out.settings;
        return {
          ok: true,
          already_open: out.already_open,
          invoice_no: out.invoice.invoice_no,
          amount_ngn: Number(out.invoice.amount_ngn),
          plan: plan.name,
          cycle,
          reference: out.invoice.reference,
          pay_to: { bank: s.billing_bank_name, account_name: s.billing_account_name, account_number: s.billing_account_number },
          note: "Nothing is active yet. The user must transfer the amount using the reference, then attach proof of payment under Subscription → Invoices.",
        };
      },
    },
    {
      name: "escalate_to_human",
      description: "Open a support ticket with the EduSphere team and hand the conversation over to a person. Use this when the user asks for a human, or when you cannot answer.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "Short summary of what the user needs." } },
        required: ["summary"],
      },
      run: async (args) => {
        const summary = cleanStr(args.summary, 200) || "Assistance requested via EduSphere AI";
        const r = await db.run(
          "INSERT INTO support_tickets (madrasa_id, subject, body, category, priority, status, created_by) VALUES (?,?,?,?,?, 'open', ?)",
          [ctx.madrasaId, summary.slice(0, 190), `Raised by EduSphere AI on behalf of ${ctx.userName || "an administrator"}.\n\n${summary}`, "technical", "medium", ctx.userId || null]
        );
        logActivity(db, { madrasaId: ctx.madrasaId, userId: ctx.userId || null, action: "ai.escalate", entity: "support_ticket", entityId: String(r.lastInsertRowid) });
        return { ok: true, ticket_id: r.lastInsertRowid, message: "A support ticket has been opened. The EduSphere team will reply in Chat & Support." };
      },
    },
  ];
}

appRouter.use(requireAuth);

appRouter.get("/status", asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  const m = tid ? await db.get("SELECT name_en FROM madaris WHERE id = ?", [tid]) : null;
  ok(res, { enabled: true, ai_model: ai.enabled ? ai.model : "", live: ai.enabled, institution: m ? m.name_en : "" });
}));

appRouter.post("/chat", appLimiter, asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "No institution on this session.");
  const message = cleanStr(req.body && req.body.message, 4000);
  if (!message) return err(res, 400, "Type a message.");

  const m = await db.get("SELECT name_en FROM madaris WHERE id = ?", [tid]);
  const conv = await ai.conversation({ surface: "app", madrasaId: tid, userId: req.user.id, externalId: `user-${req.user.id}` });
  const history = await ai.history(conv.id);
  const messages = history.concat([{ role: "user", content: message }]);

  const ctx = { madrasaId: tid, userId: req.user.id, userName: req.user.full_name || req.user.username, institutionName: m ? m.name_en : "" };

  let out;
  try {
    out = await ai.ask({ surface: "app", messages, tools: appTools(ctx), context: ctx });
  } catch (e) {
    // The model is down; the knowledge base may still have the answer.
    const hits = await ai.retrieve("app", message, 3);
    const fb = ai.fallbackAnswer("app", message, hits);
    out = fb || { content: "The assistant is temporarily unavailable. Please use Chat & Support to reach the EduSphere team.", sources: [], mode: "error", toolCalls: [], tokens: null };
  }

  await ai.saveMessage(conv.id, "user", message);
  await ai.saveMessage(conv.id, "assistant", out.content, { sources: out.sources, tokens: out.tokens });
  ok(res, {
    reply: out.content,
    sources: out.sources || [],
    mode: out.mode,
    conversation_id: conv.id,
    actions: (out.toolCalls || []).map((t) => t.name),
  });
}));

appRouter.get("/history", asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  const conv = await ai.conversation({ surface: "app", madrasaId: tid, userId: req.user.id, externalId: `user-${req.user.id}` });
  ok(res, { conversation_id: conv.id, messages: await ai.history(conv.id, 50) });
}));

appRouter.post("/reset", asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  const conv = await ai.conversation({ surface: "app", madrasaId: tid, userId: req.user.id, externalId: `user-${req.user.id}` });
  await db.run("DELETE FROM ai_messages WHERE conversation_id = ?", [conv.id]);
  ok(res, { ok: true });
}));

/* ============================================================================
   PUBLIC WEBSITE SURFACE
   ========================================================================== */

function publicTools() {
  return [
    TOOL_LIST_PLANS,
    {
      name: "get_contact_details",
      description: "Get EduSphere's public contact details for sales and support.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const s = await subscription.getSettings();
        return {
          email: s.billing_contact_email || "",
          phone: s.billing_contact_phone || "",
          note: "Visitors can also register their institution directly from the EduSphere website.",
        };
      },
    },
    {
      name: "register_interest",
      description: "Record that a visitor wants a demo or wants to register their institution. Ask for the institution name and a contact detail first.",
      parameters: {
        type: "object",
        properties: {
          institution_name: { type: "string" },
          contact: { type: "string", description: "Email or phone number" },
          note: { type: "string" },
        },
        required: ["institution_name"],
      },
      run: async (args) => {
        const name = cleanStr(args.institution_name, 160);
        const contact = cleanStr(args.contact, 120);
        if (!name) return { error: "An institution name is needed." };
        logActivity(db, { userId: null, action: "ai.public_lead", entity: "lead", meta: { name, contact, note: cleanStr(args.note, 200) } });
        return { ok: true, message: "Thank you — the EduSphere team will reach out. You can also register directly on the website." };
      },
    },
  ];
}

publicRouter.post("/chat", publicLimiter, asyncHandler(async (req, res) => {
  const message = cleanStr(req.body && req.body.message, 2000);
  if (!message) return err(res, 400, "Type a message.");
  const sessionId = cleanStr(req.body && req.body.session_id, 80) || `anon-${req.ip || "unknown"}`;
  const conv = await ai.conversation({ surface: "public", externalId: sessionId });
  const history = await ai.history(conv.id);
  const messages = history.concat([{ role: "user", content: message }]);

  let out;
  try {
    out = await ai.ask({ surface: "public", messages, tools: publicTools(), context: {} });
  } catch (e) {
    const hits = await ai.retrieve("public", message, 3);
    const fb = ai.fallbackAnswer("public", message, hits);
    out = fb || { content: "The assistant is temporarily unavailable. Please try again shortly.", sources: [], mode: "error", toolCalls: [] };
  }

  await ai.saveMessage(conv.id, "user", message);
  await ai.saveMessage(conv.id, "assistant", out.content, { sources: out.sources, tokens: out.tokens });
  ok(res, { reply: out.content, sources: out.sources || [], mode: out.mode, session_id: sessionId });
}));

publicRouter.get("/status", asyncHandler(async (req, res) => {
  ok(res, { enabled: true, live: ai.enabled, model: ai.enabled ? ai.model : "" });
}));

/* ============================================================================
   WHATSAPP SURFACE
   ========================================================================== */

const WA = config.WHATSAPP_AI || { provider: "none", token: "", phoneNumberId: "", verifyToken: "" };

async function sendWhatsApp(to, text) {
  if (WA.provider === "meta" && WA.token && WA.phoneNumberId) {
    const r = await fetch(`https://graph.facebook.com/v20.0/${WA.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body: text } }),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, provider: "meta", data };
  }
  // Provider not configured: the reply is still stored and returned in the
  // webhook response so the integration can be tested end-to-end without a
  // live WhatsApp line.
  return { ok: false, provider: WA.provider || "none", skipped: true };
}

function whatsappTools(ctx) {
  return [
    TOOL_LIST_PLANS,
    {
      name: "escalate_to_human",
      description: "Hand this WhatsApp conversation to the EduSphere support team. Use it when the person asks for a human or agent, or when you cannot help.",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: [] },
      run: async (args) => {
        await db.run("UPDATE ai_conversations SET escalated = 1 WHERE id = ?", [ctx.conversationId]);
        logActivity(db, { action: "ai.whatsapp_escalate", entity: "ai_conversation", entityId: String(ctx.conversationId), meta: { from: ctx.from, summary: cleanStr(args && args.summary, 200) } });
        return { ok: true, message: "Handed to the EduSphere team — someone will continue this chat shortly." };
      },
    },
  ];
}

/** Meta Cloud API sends the payload; the signature is HMAC-SHA256 of the RAW
    body with the app secret, in the x-hub-signature-256 header. */
function validWhatsAppSignature(raw, signature) {
  if (!WA.appSecret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", WA.appSecret).update(raw).digest("hex");
  const a = Buffer.from(String(signature || ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

whatsappRouter.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] || "");
  if (mode === "subscribe" && WA.verifyToken && token === WA.verifyToken) {
    return res.status(200).send(String(req.query["hub.challenge"] || ""));
  }
  res.status(403).send("Forbidden");
});

whatsappRouter.post("/webhook", express.json({ verify: (req, _res, buf) => { req.rawBody = buf ? buf.toString("utf8") : ""; } }), asyncHandler(async (req, res) => {
  // When an app secret is configured the signature MUST validate; without one
  // the endpoint stays usable for local testing but says so in the log.
  if (WA.appSecret) {
    const sig = req.get("x-hub-signature-256") || "";
    if (!validWhatsAppSignature(req.rawBody || JSON.stringify(req.body || {}), sig)) {
      return res.status(401).json({ error: "Invalid signature." });
    }
  }

  const body = req.body || {};
  const entry = (body.entry && body.entry[0]) || {};
  const change = (entry.changes && entry.changes[0]) || {};
  const value = change.value || {};
  const message = (value.messages && value.messages[0]) || null;
  if (!message || !message.from) return res.json({ received: true }); // status updates etc.

  const from = String(message.from);
  const incoming = String((message.text && message.text.body) || "").trim();
  if (!incoming) {
    await sendWhatsApp(from, "Send a message and EduSphere AI will help. Reply *human* at any time to speak to our team.");
    return res.json({ received: true });
  }

  const conv = await ai.conversation({ surface: "whatsapp", externalId: `wa-${from}` });
  const history = await ai.history(conv.id, 12);
  const messages = history.concat([{ role: "user", content: incoming }]);
  const ctx = { conversationId: conv.id, from, surface: "whatsapp" };

  let out;
  try {
    out = await ai.ask({ surface: "whatsapp", messages, tools: whatsappTools(ctx), context: ctx });
  } catch (e) {
    const hits = await ai.retrieve("whatsapp", incoming, 3);
    const fb = ai.fallbackAnswer("whatsapp", incoming, hits);
    out = fb || { content: "I am having trouble answering right now. Reply *human* and our team will take over.", sources: [], mode: "error", toolCalls: [] };
  }

  await ai.saveMessage(conv.id, "user", incoming);
  await ai.saveMessage(conv.id, "assistant", out.content, { sources: out.sources, tokens: out.tokens });
  const delivery = await sendWhatsApp(from, out.content);
  res.json({ received: true, delivered: delivery.ok, provider: delivery.provider, mode: out.mode });
}));

/* ============================================================================
   PLATFORM — knowledge base editor
   ========================================================================== */
platformRouter.use(requireSuperAdmin);

platformRouter.get("/knowledge", asyncHandler(async (req, res) => {
  const scope = cleanStr(req.query.scope, 20);
  const rows = scope && scope !== "all"
    ? await db.all("SELECT * FROM ai_knowledge WHERE scope = ? ORDER BY sort_order, id", [scope])
    : await db.all("SELECT * FROM ai_knowledge ORDER BY scope, sort_order, id");
  ok(res, { entries: rows, live: ai.enabled, model: ai.enabled ? ai.model : "" });
}));

platformRouter.post("/knowledge", asyncHandler(async (req, res) => {
  const b = req.body || {};
  const question = cleanStr(b.question, 255);
  const answer = cleanStr(b.answer, 8000);
  if (!question || !answer) return err(res, 400, "A question and an answer are required.");
  const r = await db.run(
    "INSERT INTO ai_knowledge (scope, topic, question, answer, keywords, sort_order) VALUES (?,?,?,?,?,?)",
    [cleanStr(b.scope, 20) || "public", cleanStr(b.topic, 80), question, answer, cleanStr(b.keywords, 500), toNum(b.sort_order, 99)]
  );
  ok(res, { ok: true, id: r.lastInsertRowid });
}));

platformRouter.patch("/knowledge/:id", asyncHandler(async (req, res) => {
  const id = toNum(req.params.id, 0);
  if (!await db.get("SELECT id FROM ai_knowledge WHERE id = ?", [id])) return err(res, 404, "Entry not found.");
  const b = req.body || {};
  const sets = [];
  const vals = [];
  for (const [f, max] of [["scope", 20], ["topic", 80], ["question", 255], ["keywords", 500]]) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(cleanStr(b[f], max)); }
  }
  if (b.answer !== undefined) { sets.push("answer = ?"); vals.push(cleanStr(b.answer, 8000)); }
  if (b.is_active !== undefined) { sets.push("is_active = ?"); vals.push(b.is_active ? 1 : 0); }
  if (b.sort_order !== undefined) { sets.push("sort_order = ?"); vals.push(toNum(b.sort_order, 99)); }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  vals.push(id);
  await db.run(`UPDATE ai_knowledge SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, vals);
  ok(res, { ok: true });
}));

platformRouter.delete("/knowledge/:id", asyncHandler(async (req, res) => {
  await db.run("DELETE FROM ai_knowledge WHERE id = ?", [toNum(req.params.id, 0)]);
  ok(res, { ok: true });
}));

platformRouter.get("/conversations", asyncHandler(async (req, res) => {
  const surface = cleanStr(req.query.surface, 20);
  const rows = surface
    ? await db.all(
        `SELECT c.*, (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS messages,
                (SELECT content FROM ai_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
           FROM ai_conversations c WHERE c.surface = ? ORDER BY c.updated_at DESC LIMIT 100`, [surface])
    : await db.all(
        `SELECT c.*, (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS messages,
                (SELECT content FROM ai_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
           FROM ai_conversations c ORDER BY c.updated_at DESC LIMIT 100`);
  ok(res, { conversations: rows });
}));

platformRouter.get("/conversations/:id", asyncHandler(async (req, res) => {
  const id = toNum(req.params.id, 0);
  const conv = await db.get(
    `SELECT c.*, m.name_en AS madrasa_name FROM ai_conversations c LEFT JOIN madaris m ON m.id = c.madrasa_id WHERE c.id = ?`, [id]
  );
  if (!conv) return err(res, 404, "Conversation not found.");
  ok(res, { conversation: conv, messages: await ai.history(id, 200) });
}));

module.exports = { router: appRouter, publicRouter, whatsappRouter, platformRouter };
