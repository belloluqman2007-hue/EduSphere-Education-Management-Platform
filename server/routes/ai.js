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
const analytics = require("../services/analytics");
const grading = require("../services/grading");
const subscription = require("../services/subscription");
const { requireAuth, requireSuperAdmin } = require("../middleware/auth");
const { requireFeature } = require("../middleware/subscription");
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

/** Public, non-sensitive plan catalogue. Safe on every surface.
    It carries the OFFER (tagline, benefits, quick win) as well as the numbers,
    so the assistant can explain what a school GETS on each tier instead of
    reciting limits — the same copy the pricing page renders. */
async function planCatalogue() {
  const plans = await subscription.plansForUpgrade();
  return {
    plans: plans.map((p) => ({
      code: p.code,
      name: p.name,
      description: p.description || "",
      tagline: p.offer ? p.offer.tagline : "",
      promise: p.offer ? p.offer.promise : "",
      quick_win: p.offer ? p.offer.quick_win : "",
      headline: p.offer ? p.offer.headline : [],
      benefits: p.offer ? p.offer.benefit_groups : [],
      included: p.offer ? p.offer.benefits.map((b) => b.label) : [],
      not_included: p.offer ? p.offer.locked.slice(0, 12).map((b) => `${b.label} (${b.required_plan_name})`) : [],
      price_monthly_ngn: p.price_monthly_ngn !== undefined ? p.price_monthly_ngn : Number(p.price_ngn || 0),
      price_yearly_ngn: Number(p.price_yearly_ngn || 0),
      yearly_saves_ngn: p.offer ? p.offer.price.yearly_saves_ngn : 0,
      student_limit: Number(p.student_limit),   // -1 = unlimited
      teacher_limit: Number(p.teacher_limit),
      students_copy: p.offer ? p.offer.limits.students_copy : "",
      teachers_copy: p.offer ? p.offer.limits.teachers_copy : "",
      trial_days: Number(p.trial_days || 0),
    })),
    currency: "NGN",
    guidance: "Recommend a tier from what the school needs to DO next (fees and parent portals → Basic; AI, exams, payroll, branding → Premium), then quote its price and quick win. Never invent a price.",
  };
}

const TOOL_LIST_PLANS = {
  name: "list_plans",
  description: "List the EduSphere subscription plans (Free / Basic / Premium) with their Naira prices, student/teacher limits and what each tier INCLUDES. Use this whenever someone asks about pricing, plans, what a tier offers, or which plan fits them.",
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
   AI COPILOT — the Premium "AI-powered school" capabilities
   ----------------------------------------------------------------------------
   Four things a school on Premium can ask for, each behind its own feature key
   so the refusal names the exact capability and the tier that carries it:

     POST /api/ai/copilot/report-comments   ai_comments
     GET  /api/ai/copilot/at-risk           ai_risk_alerts
     POST /api/ai/copilot/questions         ai_questions
     GET  /api/ai/copilot/insights          analytics_advanced
     GET  /api/ai/copilot                   (entitlement list — never gated, it
                                             is what renders the upsell)

   DESIGN RULES
   • Every one of them works WITHOUT a model key. The deterministic path reads
     the school's own marks, registers and question bank and produces something
     a teacher can use immediately; when a model IS configured it is asked to
     refine that draft, and any failure falls back to the deterministic text.
     A paid feature that only works while a third party is up is not a feature.
   • Nothing is written unless the caller asks for it (`save: true` on
     question generation). Drafts stay drafts.
   • The tenant id comes from the session, and every query filters by it — the
     copilot reads one school's data and cannot be pointed at another.
   ========================================================================== */

const COPILOT_CAPABILITIES = [
  {
    capability: "report_comments", feature: "ai_comments",
    label: "Auto report comments",
    blurb: "A drafted comment for every student in a class, from their real marks, grade, position and attendance.",
    method: "POST", path: "/ai/copilot/report-comments",
  },
  {
    capability: "risk_alerts", feature: "ai_risk_alerts",
    label: "At-risk student alerts",
    blurb: "Students slipping on grades or attendance, ranked, with the reason and a message ready to send home.",
    method: "GET", path: "/ai/copilot/at-risk",
  },
  {
    capability: "questions", feature: "ai_questions",
    label: "Exam question generation",
    blurb: "Draft questions for a subject, class and topic — randomised from your question bank, or written for you.",
    method: "POST", path: "/ai/copilot/questions",
  },
  {
    capability: "analytics_qa", feature: "analytics_advanced",
    label: "Analytics Q&A",
    blurb: "Heatmaps, teacher performance, fee forecasting and the insights behind them, in plain language.",
    method: "GET", path: "/ai/copilot/insights",
  },
];

/** What this institution's copilot can do — and the offer for what it cannot. */
appRouter.get("/copilot", asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "No institution on this session.");
  const out = [];
  for (const cap of COPILOT_CAPABILITIES) {
    const gate = await subscription.checkFeature(tid, cap.feature);
    out.push(Object.assign({}, cap, {
      entitled: Boolean(gate.allowed),
      model_live: ai.enabled,
      gate: gate.allowed ? null : {
        reason: gate.reason,
        message: gate.message,
        hint: gate.hint,
        required_plan: gate.required_plan || null,
        upgrade: gate.upgrade || null,
      },
    }));
  }
  const summary = await subscription.summary(tid).catch(() => null);
  ok(res, {
    capabilities: out,
    model: ai.enabled ? ai.model : "",
    plan: summary ? { code: summary.plan.code, name: summary.plan.name } : null,
  });
}));

/* ---------------------------- report comments ---------------------------- */

const COMMENT_BANDS = [
  { min: 80, opener: "has had an outstanding term", tone: "excellent" },
  { min: 65, opener: "has worked consistently well this term", tone: "strong" },
  { min: 50, opener: "has made steady progress this term", tone: "steady" },
  { min: 40, opener: "is working below the level we know is possible", tone: "developing" },
  { min: 0, opener: "needs focused support this coming term", tone: "at_risk" },
];

function bandFor(average, passMark) {
  const pctValue = Number(average);
  if (!Number.isFinite(pctValue)) return COMMENT_BANDS[COMMENT_BANDS.length - 1];
  if (pctValue < passMark && pctValue >= 40) return COMMENT_BANDS[3];
  return COMMENT_BANDS.find((b) => pctValue >= b.min) || COMMENT_BANDS[COMMENT_BANDS.length - 1];
}

function draftComment({ name, average, grade, position, classSize, attendanceRate, best, weakest, passMark }) {
  const band = bandFor(average, passMark);
  const first = String(name || "This student").split(" ")[0];
  const parts = [];
  parts.push(`${first} ${band.opener}${Number.isFinite(average) ? `, averaging ${average}%` : ""}${grade ? ` (grade ${grade})` : ""}.`);
  if (position && classSize) parts.push(`${first} placed ${position} of ${classSize} in the class.`);
  if (best) parts.push(`Strongest work was in ${best.subject} (${best.total}%).`);
  if (weakest && weakest.total < passMark) parts.push(`${weakest.subject} needs the most attention at ${weakest.total}%.`);
  else if (weakest) parts.push(`${weakest.subject} is the next subject to push, at ${weakest.total}%.`);
  if (attendanceRate !== null && attendanceRate !== undefined) {
    if (attendanceRate >= 90) parts.push("Attendance has been excellent.");
    else if (attendanceRate >= passMark) parts.push(`Attendance of ${attendanceRate}% is acceptable, and better attendance would lift these results further.`);
    else parts.push(`Attendance of ${attendanceRate}% is holding ${first} back — please help us get ${first} to school every day.`);
  }
  if (band.tone === "at_risk") parts.push("We will arrange extra support and would like to meet with the family.");
  else if (band.tone === "developing") parts.push("A short daily revision routine at home would make a real difference.");
  else parts.push("Keep up the encouragement at home — it is showing.");
  return parts.join(" ");
}

appRouter.post("/copilot/report-comments", requireFeature("ai_comments"), asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "No institution on this session.");
  const b = req.body || {};
  const classId = toNum(b.class_id, 0);
  if (!classId) return err(res, 400, "class_id is required.");
  // Both ids are validated against THIS tenant — a copilot that could be pointed
  // at another school's class would be a data leak with a friendly interface.
  const klass = await db.get("SELECT id, name_en, name_ar FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!klass) return err(res, 404, "Class not found.");

  let term = null;
  const termId = toNum(b.term_id, 0);
  if (termId) term = await db.get("SELECT id, name_en, position FROM terms WHERE id = ? AND madrasa_id = ?", [termId, tid]);
  if (!term) term = await analytics.currentTerm(tid, new Date().toISOString().slice(0, 10));
  if (!term) return err(res, 400, "This institution has no academic term yet — create one under Academics first.");

  const cfg = await grading.getGradingConfig(tid);
  const students = await db.all(
    `SELECT s.id, s.admission_no, s.first_name, s.last_name, s.name_ar,
            ts.average, ts.overall_grade, ts.position, ts.subject_count,
            ts.attendance_percentage, ts.teacher_comment
       FROM students s
       LEFT JOIN term_summaries ts ON ts.student_id = s.id AND ts.madrasa_id = s.madrasa_id AND ts.term_id = ?
      WHERE s.madrasa_id = ? AND s.class_id = ? AND s.status IN ('active','promoted','suspended')
      ORDER BY ts.position IS NULL, ts.position, s.first_name`,
    [term.id, tid, classId]
  );
  if (!students.length) return err(res, 404, "That class has no students on roll.");

  const subjectRows = await db.all(
    `SELECT r.student_id, sub.name_en AS subject, r.total
       FROM results r
       JOIN subjects sub ON sub.id = r.subject_id AND sub.madrasa_id = r.madrasa_id
      WHERE r.madrasa_id = ? AND r.class_id = ? AND r.term_id = ?
      ORDER BY r.student_id, r.total DESC`,
    [tid, classId, term.id]
  );
  const byStudent = new Map();
  for (const r of subjectRows) {
    const list = byStudent.get(Number(r.student_id)) || [];
    list.push({ subject: r.subject, total: Number(r.total) });
    byStudent.set(Number(r.student_id), list);
  }
  const attRows = await db.all(
    `SELECT student_id, COUNT(*) AS marked,
            SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS attended
       FROM attendance
      WHERE madrasa_id = ? AND class_id = ? AND term_id = ?
      GROUP BY student_id`,
    [tid, classId, term.id]
  );
  const attByStudent = new Map(attRows.map((r) => [Number(r.student_id), { marked: Number(r.marked), attended: Number(r.attended || 0) }]));

  const drafts = students.map((s) => {
    const average = s.average === null || s.average === undefined ? NaN : Number(s.average);
    const subjects = byStudent.get(Number(s.id)) || [];
    const att = attByStudent.get(Number(s.id));
    const attendanceRate = att && att.marked >= 5 ? Math.round((att.attended / att.marked) * 1000) / 10
      : (s.attendance_percentage !== null && s.attendance_percentage !== undefined && Number(s.attendance_percentage) > 0 ? Number(s.attendance_percentage) : null);
    const comment = draftComment({
      name: `${s.first_name} ${s.last_name}`.trim(),
      average: Number.isFinite(average) ? Math.round(average * 10) / 10 : NaN,
      grade: s.overall_grade || "",
      position: s.position ? Number(s.position) : null,
      classSize: students.length,
      attendanceRate,
      best: subjects.length ? subjects[0] : null,
      weakest: subjects.length ? subjects[subjects.length - 1] : null,
      passMark: Number(cfg.passMark),
    });
    return {
      student_id: Number(s.id),
      admission_no: s.admission_no,
      name: `${s.first_name} ${s.last_name}`.trim(),
      name_ar: s.name_ar || "",
      average: Number.isFinite(average) ? Math.round(average * 10) / 10 : null,
      grade: s.overall_grade || "",
      position: s.position ? Number(s.position) : null,
      attendance_rate: attendanceRate,
      subjects: subjects.length,
      existing_comment: s.teacher_comment || "",
      comment,
      mode: "template",
    };
  });

  let mode = "template";
  // With a model configured the drafts are refined in ONE call (token cost
  // matters), and any failure keeps the deterministic text — the teacher still
  // gets a usable comment either way.
  if (ai.enabled && b.polish !== false) {
    try {
      const out = await ai.ask({
        surface: "app",
        messages: [{
          role: "user",
          content:
            `Refine these ${drafts.length} school report comments for ${klass.name_en}, ${term.name_en}. ` +
            `Keep each under 60 words, warm and specific, British/Nigerian school English, no invented facts. ` +
            `Reply with a JSON array of {"student_id": n, "comment": "..."} and nothing else.\n\n` +
            JSON.stringify(drafts.map((d) => ({ student_id: d.student_id, comment: d.comment, average: d.average, attendance_rate: d.attendance_rate }))),
        }],
        tools: [],
        context: { madrasaId: tid, userId: req.user.id },
      });
      const text = String((out && out.content) || "");
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          const refined = new Map(parsed.filter((p) => p && p.student_id).map((p) => [Number(p.student_id), String(p.comment || "").trim()]));
          for (const d of drafts) {
            const better = refined.get(d.student_id);
            if (better && better.length > 20) { d.comment = better.slice(0, 1200); d.mode = "model"; }
          }
          mode = drafts.some((d) => d.mode === "model") ? "model" : "template";
        }
      }
    } catch (e) {
      mode = "template"; // the drafts above already stand on their own
    }
  }

  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "ai.copilot.report_comments", entity: "class", entityId: String(classId), meta: { term_id: term.id, count: drafts.length, mode } });
  ok(res, {
    ok: true,
    mode,
    model: ai.enabled ? ai.model : "",
    class: { id: Number(klass.id), name: klass.name_en, name_ar: klass.name_ar || "" },
    term: { id: Number(term.id), name: term.name_en },
    grading: { pass_mark: Number(cfg.passMark) },
    count: drafts.length,
    comments: drafts,
    note: "These are drafts. Review them, then save from Results → Report cards (the comment field) — nothing is written to a report sheet here.",
  });
}));

/* ------------------------------ at-risk alerts --------------------------- */

const RISK_ACTIONS = {
  low_grades: "Book a revision clinic for this subject and share the specific topics the student is losing marks on.",
  low_attendance: "Call the family this week and agree a return-to-school plan; log the contact on the student record.",
  missing_results: "Results for this term have not been recorded yet — the class teacher should complete the gradebook.",
};

function riskMessage({ name, reasons, average, attendanceRate, className, school }) {
  const first = String(name || "your child").split(" ")[0];
  const bits = [];
  if (reasons.includes("low_grades")) bits.push(`an average of ${average}% this term`);
  if (reasons.includes("low_attendance")) bits.push(`attendance of ${attendanceRate}%`);
  if (reasons.includes("missing_results")) bits.push("results that are still being completed");
  const body = `Assalamu alaikum. We would like to discuss ${first}'s progress in ${className || "class"}: ${bits.join(" and ")}. ` +
    "Could we agree a short plan together this week?";
  return school ? `${body} — ${school}` : body;
}

appRouter.get("/copilot/at-risk", requireFeature("ai_risk_alerts"), asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "No institution on this session.");
  const todayIso = new Date().toISOString().slice(0, 10);
  let term = null;
  const termId = toNum(req.query.termId, 0);
  if (termId) term = await db.get("SELECT id, name_en FROM terms WHERE id = ? AND madrasa_id = ?", [termId, tid]);
  if (!term) term = await analytics.currentTerm(tid, todayIso);
  const cfg = await grading.getGradingConfig(tid);
  const passMark = Number(cfg.passMark);
  const madrasa = await db.get("SELECT name_en FROM madaris WHERE id = ?", [tid]);
  const schoolName = madrasa ? madrasa.name_en : "";

  const rows = await db.all(
    `SELECT s.id, s.admission_no, s.first_name, s.last_name, s.name_ar, s.parent_name, s.parent_phone,
            c.name_en AS class_en, c.id AS class_id,
            ts.average, ts.overall_grade, ts.position, ts.id AS summary_id
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN term_summaries ts ON ts.student_id = s.id AND ts.madrasa_id = s.madrasa_id AND ts.term_id = ?
      WHERE s.madrasa_id = ? AND s.status IN ('active','promoted','suspended')`,
    [term ? term.id : 0, tid]
  );
  const since = new Date(Date.now() - 59 * 86400000).toISOString().slice(0, 10);
  const attRows = await db.all(
    `SELECT student_id, COUNT(*) AS marked,
            SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS attended
       FROM attendance WHERE madrasa_id = ? AND day >= ? AND day <= ?
      GROUP BY student_id`,
    [tid, since, todayIso]
  );
  const attByStudent = new Map(attRows.map((r) => [Number(r.student_id), { marked: Number(r.marked), attended: Number(r.attended || 0) }]));
  const classHasSummaries = new Set(rows.filter((r) => r.summary_id).map((r) => Number(r.class_id)));

  const atRisk = rows.map((s) => {
    const average = s.average === null || s.average === undefined ? null : Math.round(Number(s.average) * 10) / 10;
    const att = attByStudent.get(Number(s.id));
    const attendanceRate = att && att.marked >= 5 ? Math.round((att.attended / att.marked) * 1000) / 10 : null;
    const reasons = [];
    if (average !== null && average < passMark) reasons.push("low_grades");
    if (attendanceRate !== null && attendanceRate < 75) reasons.push("low_attendance");
    if (average === null && classHasSummaries.has(Number(s.class_id))) reasons.push("missing_results");
    if (!reasons.length) return null;
    const score = reasons.length * 20 +
      (average !== null ? Math.max(0, passMark - average) : 0) +
      (attendanceRate !== null ? Math.max(0, 75 - attendanceRate) * 0.5 : 0);
    const name = `${s.first_name} ${s.last_name}`.trim();
    return {
      student_id: Number(s.id),
      admission_no: s.admission_no,
      name,
      name_ar: s.name_ar || "",
      class_id: s.class_id ? Number(s.class_id) : null,
      class_name: s.class_en || "",
      average,
      grade: s.overall_grade || "",
      position: s.position ? Number(s.position) : null,
      attendance_rate: attendanceRate,
      attendance_days_marked: att ? att.marked : 0,
      reasons,
      risk_score: Math.round(score),
      severity: reasons.length > 1 || score >= 45 ? "high" : score >= 25 ? "medium" : "low",
      actions: reasons.map((r) => ({ reason: r, action: RISK_ACTIONS[r] || "Review this student's record with the class teacher." })),
      parent_name: s.parent_name || "",
      parent_phone: s.parent_phone || "",
      draft_parent_message: riskMessage({ name, reasons, average, attendanceRate, className: s.class_en, school: schoolName }),
    };
  }).filter(Boolean)
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, 100);

  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "ai.copilot.at_risk", entity: "madrasa", entityId: String(tid), meta: { count: atRisk.length, term_id: term ? term.id : null } });
  ok(res, {
    ok: true,
    term: term ? { id: Number(term.id), name: term.name_en } : null,
    thresholds: { pass_mark: passMark, attendance_floor: 75, attendance_window_days: 60 },
    count: atRisk.length,
    high: atRisk.filter((s) => s.severity === "high").length,
    students: atRisk,
    note: "Ranked by risk score: more than one reason, then how far below the pass mark, then attendance.",
  });
}));

/* -------------------------- question generation -------------------------- */

const QUESTION_TEMPLATES = [
  { type: "short_answer", difficulty: "easy", text: (t, s) => `Define ${t} as it is used in ${s}.`, marks: 3 },
  { type: "short_answer", difficulty: "medium", text: (t, s) => `State three key points about ${t} in ${s}.`, marks: 6 },
  { type: "long_answer", difficulty: "hard", text: (t, s) => `Explain the importance of ${t}, giving two examples from ${s}.`, marks: 10 },
  { type: "true_false", difficulty: "easy", text: (t) => `True or false: ${t} applies in every case. (Correct the statement if it is false.)`, marks: 2 },
  { type: "fill_in_the_blank", difficulty: "easy", text: (t) => `Complete: The first step when studying ${t} is ______.`, marks: 2 },
  { type: "multiple_choice", difficulty: "medium", text: (t, s) => `Which statement about ${t} in ${s} is correct?`, marks: 4,
    options: ["(correct answer — review before publishing)", "(distractor 1)", "(distractor 2)", "(distractor 3)"] },
  { type: "multiple_choice", difficulty: "hard", text: (t, s) => `A student says the following about ${t}: "It always gives the same result." Which response is most accurate?`, marks: 4,
    options: ["(correct answer — review before publishing)", "(distractor 1)", "(distractor 2)", "(distractor 3)"] },
  { type: "short_answer", difficulty: "medium", text: (t) => `Give one example of ${t} and explain why it fits.`, marks: 5 },
];

/** Fisher-Yates with an explicit seed source, so a re-run differs (that IS the
    "randomisation" Premium sells) while staying reproducible in a test. */
function shuffle(list, rand = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

appRouter.post("/copilot/questions", requireFeature("ai_questions"), asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "No institution on this session.");
  const b = req.body || {};
  const subjectId = toNum(b.subject_id, 0);
  const classId = toNum(b.class_id, 0);
  const count = Math.min(30, Math.max(1, toNum(b.count, 5)));
  const topic = cleanStr(b.topic, 160) || "this topic";
  const difficulty = ["easy", "medium", "hard"].includes(String(b.difficulty)) ? String(b.difficulty) : null;

  if (!subjectId) return err(res, 400, "subject_id is required.");
  const subject = await db.get("SELECT id, name_en FROM subjects WHERE id = ? AND madrasa_id = ?", [subjectId, tid]);
  if (!subject) return err(res, 404, "Subject not found.");
  let klass = null;
  if (classId) {
    klass = await db.get("SELECT id, name_en FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
    if (!klass) return err(res, 404, "Class not found.");
  }

  /* 1. Reuse first: a school that already has a bank gets a RANDOMISED paper
        from its own questions — the cheapest and most relevant generation. */
  const bankWhere = ["q.madrasa_id = ?", "q.status = 'active'"];
  const bankParams = [tid];
  if (subjectId) { bankWhere.push("(q.subject_id = ? OR q.subject_id IS NULL)"); bankParams.push(subjectId); }
  if (classId) { bankWhere.push("(q.class_id = ? OR q.class_id IS NULL)"); bankParams.push(classId); }
  if (difficulty) { bankWhere.push("q.difficulty = ?"); bankParams.push(difficulty); }
  const bankRows = await db.all(
    `SELECT q.id, q.question_text, q.question_type, q.options, q.correct_answer, q.marks, q.difficulty, q.explanation, q.tags
       FROM question_bank q WHERE ${bankWhere.join(" AND ")} ORDER BY q.id DESC LIMIT 500`,
    bankParams
  );
  const seed = Number(b.seed) || Date.now();
  let rand = null;
  if (Number.isFinite(seed)) {
    let state = seed >>> 0 || 1;
    rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  }

  let questions = [];
  let mode = "template";
  if (bankRows.length >= count) {
    mode = "bank";
    questions = shuffle(bankRows, rand).slice(0, count).map((q) => ({
      source: "question_bank",
      question_bank_id: Number(q.id),
      question_text: q.question_text,
      question_type: q.question_type,
      options: q.options || "",
      correct_answer: q.correct_answer || "",
      marks: Number(q.marks),
      difficulty: q.difficulty,
      explanation: q.explanation || "",
      tags: q.tags || "",
      needs_review: false,
    }));
  }

  /* 2. Otherwise write drafts. With a model configured, ask it for JSON; the
        template bank is the fallback AND the shape the model output must match. */
  if (!questions.length) {
    const wanted = difficulty
      ? QUESTION_TEMPLATES.filter((t) => t.difficulty === difficulty)
      : QUESTION_TEMPLATES;
    const pool = shuffle(wanted.length ? wanted : QUESTION_TEMPLATES, rand);
    questions = Array.from({ length: count }, (_, i) => {
      const t = pool[i % pool.length];
      return {
        source: "generated",
        question_text: t.text(topic, subject.name_en),
        question_type: t.type,
        options: t.options ? JSON.stringify(t.options) : "",
        correct_answer: "",
        marks: t.marks,
        difficulty: t.difficulty,
        explanation: "",
        tags: `ai-generated, ${topic}`.slice(0, 255),
        needs_review: true,
      };
    });

    if (ai.enabled && b.use_model !== false) {
      try {
        const out = await ai.ask({
          surface: "app",
          messages: [{
            role: "user",
            content:
              `Write ${count} examination questions on "${topic}" for ${subject.name_en}` +
              `${klass ? `, class ${klass.name_en}` : ""}${difficulty ? `, difficulty ${difficulty}` : ""}. ` +
              `Mix question types (multiple_choice, short_answer, true_false, fill_in_the_blank). ` +
              `Reply with a JSON array only, each item: {"question_text","question_type","options" (array or ""),"correct_answer","marks","difficulty","explanation"}.`,
          }],
          tools: [],
          context: { madrasaId: tid, userId: req.user.id },
        });
        const text = String((out && out.content) || "");
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed) && parsed.length) {
            const allowedTypes = new Set(["multiple_choice", "short_answer", "long_answer", "true_false", "fill_in_the_blank"]);
            questions = parsed.slice(0, count).map((q) => ({
              source: "model",
              question_text: cleanStr(q.question_text, 4000),
              question_type: allowedTypes.has(String(q.question_type)) ? String(q.question_type) : "short_answer",
              options: Array.isArray(q.options) ? JSON.stringify(q.options) : cleanStr(q.options, 2000),
              correct_answer: cleanStr(q.correct_answer, 2000),
              marks: Math.min(500, Math.max(1, toNum(q.marks, 5))),
              difficulty: ["easy", "medium", "hard"].includes(String(q.difficulty)) ? String(q.difficulty) : "medium",
              explanation: cleanStr(q.explanation, 5000),
              tags: `ai-generated, ${topic}`.slice(0, 255),
              needs_review: true,
            })).filter((q) => q.question_text.length > 3);
            mode = questions.length ? "model" : "template";
          }
        }
      } catch (e) {
        mode = "template";
      }
    }
  }

  /* 3. Optional save: drafts only enter the bank when the caller asks. */
  let saved = 0;
  if (b.save === true && questions.length) {
    for (const q of questions) {
      await db.run(
        `INSERT INTO question_bank
           (madrasa_id, subject_id, class_id, question_text, question_type, options, correct_answer,
            marks, difficulty, explanation, tags, status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tid, subjectId, classId || null, q.question_text, q.question_type, q.options || "", q.correct_answer || "",
          q.marks, q.difficulty, q.explanation || "", q.tags || "", "active", req.user.id]
      );
      saved++;
    }
  }

  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "ai.copilot.questions", entity: "subject", entityId: String(subjectId), meta: { topic, count: questions.length, mode, saved } });
  ok(res, {
    ok: true,
    mode,
    model: ai.enabled ? ai.model : "",
    subject: { id: Number(subject.id), name: subject.name_en },
    class: klass ? { id: Number(klass.id), name: klass.name_en } : null,
    topic,
    count: questions.length,
    saved,
    questions,
    note: mode === "bank"
      ? "Randomised from your own question bank — regenerate for a different paper."
      : saved
        ? "Saved to Academic → Question Bank. Review anything marked needs_review before publishing an exam."
        : "Drafts only — nothing was saved. Pass save: true to add them to your question bank.",
  });
}));

/* ------------------------------ analytics Q&A ---------------------------- */

appRouter.get("/copilot/insights", requireFeature("analytics_advanced"), asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "No institution on this session.");
  const data = await analytics.advancedAnalytics(tid, {
    months: req.query.months,
    attendanceDays: req.query.attendanceDays,
    termId: req.query.termId,
  });
  const lines = data.insights.map((i) => `${i.title}. ${i.detail}`);
  let answer = lines.length
    ? lines.join("\n")
    : "Nothing is being flagged right now — attendance, results and fee collection all look steady for this window.";
  let mode = "computed";
  if (ai.enabled && req.query.polish !== "false") {
    try {
      const out = await ai.ask({
        surface: "app",
        messages: [{
          role: "user",
          content: `Summarise these school analytics insights for a head teacher in under 120 words. Use only the facts given.\n\n${answer}\n\nTerm: ${data.term ? data.term.nameEn : "n/a"}. Attendance window: ${data.window.days} days.`,
        }],
        tools: [],
        context: { madrasaId: tid, userId: req.user.id },
      });
      const text = String((out && out.content) || "").trim();
      if (text.length > 40) { answer = text; mode = "model"; }
    } catch (e) { /* the computed summary already answers */ }
  }
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "ai.copilot.insights", entity: "madrasa", entityId: String(tid), meta: { insights: data.insights.length, mode } });
  ok(res, { ok: true, mode, answer, insights: data.insights, analytics: data });
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
