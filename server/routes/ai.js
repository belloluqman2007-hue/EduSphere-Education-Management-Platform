"use strict";
/* ============================================================================
   EDUSPHERE AI — routes
   ----------------------------------------------------------------------------
   Four mounts, one assistant with seven spaces (see services/ai-spaces.js):

     /api/ai/*            signed-in assistant — the space follows the ROLE
                          (super_admin | admin | teacher | student | parent)
     /api/public/ai/*     the public marketing website (+ the WhatsApp CTA)
     /api/ai/whatsapp     the WhatsApp line (webhook, provider-signature verified)
     /api/platform/ai/*   the operator's knowledge-base editor + space overview

   SECURITY MODEL (read this before adding a tool):
   The browser never chooses the space. It is derived from the role that
   requireAuth read from the database, so a student cannot ask for the
   administrator's assistant by changing a request parameter.
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
const aiConfig = require("../services/ai-config");
const spaces = require("../services/ai-spaces");
const whatsappLine = require("../services/whatsapp-line");
const analytics = require("../services/analytics");
const grading = require("../services/grading");
const subscription = require("../services/subscription");
const { requireAuth, requireRole, requireSuperAdmin } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments } = require("../middleware/tenant");
const { requireFeature } = require("../middleware/subscription");
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
const appLimiter = rateLimit({ windowMs: 60 * 1000, max: Math.max(1, Number(process.env.APP_AI_RATE_LIMIT || 20)) });
// The public assistant is the surface a stranger drives from one IP, so it is
// the tightest bucket. Tunable for the test suite and for a busy launch day.
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: Math.max(1, Number(process.env.PUBLIC_AI_RATE_LIMIT || 10)) });
/* "Test connection" spends a real (tiny) provider call, so it gets its own
   bucket. 5/minute is enough to fix a typo, useless for probing a key. */
const AI_TEST_RATE_LIMIT = Math.max(1, Number(process.env.AI_TEST_RATE_LIMIT || 5));
const aiTestLimiter = rateLimit({ windowMs: 60 * 1000, max: AI_TEST_RATE_LIMIT });

/* ============================================================================
   FALLBACK REPORTING AND THE REALISTIC PROBE
   ----------------------------------------------------------------------------
   A provider refusal used to be indistinguishable from "no key configured":
   both produced mode "knowledge-base" with no explanation. These helpers are
   what make the difference visible to the caller and to the dashboard.
   ========================================================================== */

/** The provider's HTTP status, when the failure had one. Never the key: the
    message text is scrubbed in services/ai.js before it reaches us. */
function providerHttpStatus(e) {
  const raw = Number(e && (e.providerStatus || e.provider_status));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** Attached to EVERY chat response, so "knowledge-base" is never again read as
    "the model worked". */
function fallbackFields(out) {
  return {
    fallback_reason: (out && out.fallback_reason) || null,
    provider_status: out && out.provider_status != null ? out.provider_status : null,
    degraded: Boolean(out && out.degraded),
    note: (out && out.note) || null,
  };
}

/** The route's safety net. ai.ask() already turns provider failures into a
    reported fallback; this covers an unexpected throw (a database error while
    saving, a bug) with the same promise: a real answer, plus the reason. */
async function degradedTurn(surface, message, e) {
  const hits = await ai.retrieve(surface, message, 3);
  const base = ai.fallbackAnswer(surface, message, hits) || await ai.menuAnswer(surface);
  const raw = Number(e && (e.providerStatus || e.provider_status));
  const reason = String((e && e.message) || "The assistant hit an unexpected error.")
    .replace(/\s+/g, " ").trim().slice(0, 300);
  return Object.assign({}, base, {
    toolCalls: base.toolCalls || [],
    fallback_reason: reason,
    provider_status: Number.isFinite(raw) && raw > 0 ? raw : null,
    degraded: true,
    note: `Model unavailable: ${reason}`,
  });
}

/* The realistic probe. It is built by services/ai.js `probe()` from the SAME
   system prompt, knowledge block, tool schemas and max_tokens a live public
   turn uses — only here the question is fixed, so a green result is evidence
   that the real chat path works rather than that a tiny request was accepted. */
const PROBE_QUESTION = "How do I register my school, and how much does the Basic plan cost?";
const PROBE_HISTORY = [
  { role: "user", content: "Hello, I run a small Islamic school in Ijebu-Ode." },
  { role: "assistant", content: "Welcome. I can explain registration, the plans and the prices. What would you like to know?" },
  { role: "user", content: PROBE_QUESTION },
];

/** A REAL knowledge block from the live table (the public space's own scopes),
    so the probe sends what a visitor's turn actually sends. */
async function probeKnowledge() {
  try { return await ai.retrieve("public", PROBE_QUESTION, 3); } catch (e) { return []; }
}

/* ============================================================================
   SHARED HELPERS FOR THE TOOLS
   ========================================================================== */

function todayIso() { return new Date().toISOString().slice(0, 10); }
function dayName() { return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getUTCDay()]; }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function r1(v) { return Math.round(n(v) * 10) / 10; }
function fullName(row) { return row ? `${row.first_name || ""} ${row.last_name || ""}`.trim() : ""; }

async function activeTerm(tid) {
  try { return await analytics.currentTerm(tid, todayIso()); } catch (e) { return null; }
}

/** One compact snapshot of the institution — the admin assistant's "how are we
    doing?" answer. Every figure is a real query against this tenant only. */
async function institutionSnapshot(tid) {
  const [students, teachers, classes, att, term, madrasa] = await Promise.all([
    db.get("SELECT COUNT(*) AS n FROM students WHERE madrasa_id = ? AND status IN ('active','promoted','suspended')", [tid]),
    db.get("SELECT COUNT(*) AS n FROM users WHERE madrasa_id = ? AND role = 'teacher' AND is_active = 1", [tid]),
    db.get("SELECT COUNT(*) AS n FROM classes WHERE madrasa_id = ? AND is_active = 1", [tid]),
    db.get(
      `SELECT COUNT(*) AS marked,
              SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present,
              SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late,
              SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent
         FROM attendance WHERE madrasa_id = ? AND day = ?`,
      [tid, todayIso()]
    ),
    activeTerm(tid),
    db.get("SELECT name_en, category FROM madaris WHERE id = ?", [tid]),
  ]);
  let fees = null;
  try {
    // Lazy require: fees.js is a large route module and this keeps the AI
    // route's load order unchanged. Its export is the SAME balance
    // calculation the finance screens use, so the AI cannot quote a different
    // number from the school's own report.
    const { buildBalances } = require("./fees");
    const rows = await buildBalances(tid, {});
    fees = {
      billed_ngn: Math.round(rows.reduce((s, x) => s + n(x.total_fees), 0)),
      collected_ngn: Math.round(rows.reduce((s, x) => s + n(x.amount_paid), 0)),
      outstanding_ngn: Math.round(rows.reduce((s, x) => s + n(x.outstanding_balance), 0)),
      students_owing: rows.filter((x) => n(x.outstanding_balance) > 0).length,
    };
  } catch (e) {
    fees = null;
  }
  return {
    institution: madrasa ? madrasa.name_en : "",
    category: madrasa ? madrasa.category || "islamic" : "",
    today: todayIso(),
    term: term ? { name: term.name_en, id: Number(term.id) } : null,
    students: n(students && students.n),
    teachers: n(teachers && teachers.n),
    classes: n(classes && classes.n),
    attendance_today: {
      marked: n(att && att.marked),
      present: n(att && att.present),
      late: n(att && att.late),
      absent: n(att && att.absent),
    },
    fees,
  };
}

/* ============================================================================
   PUBLIC, PLAN AND CONTACT TOOLS (shared where a space may use them)
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

async function contactDetails() {
  const s = await subscription.getSettings();
  const wa = await whatsappLine.line();
  return {
    email: s.billing_contact_email || "",
    phone: s.billing_contact_phone || "",
    whatsapp: wa.available ? { number: wa.display, link: wa.link } : null,
    register_islamic_school: "/register-madrasa",
    register_western_academy: "/register-academy",
    sign_in: "/login",
    plans_page: "/#plans",
    note: "Visitors can register their institution directly from the website, and can continue on WhatsApp at any time.",
  };
}

const TOOL_CONTACT = {
  name: "get_contact_details",
  description: "Get EduSphere's public contact details (email, phone, WhatsApp link) and the registration and sign-in URLs.",
  parameters: { type: "object", properties: {} },
  run: async () => contactDetails(),
};

/* ============================================================================
   INSTITUTION ADMIN
   ========================================================================== */

function adminTools(ctx) {
  return [
    TOOL_LIST_PLANS,
    TOOL_CONTACT,
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
      name: "get_institution_snapshot",
      description: "Get a live snapshot of THIS institution: students on roll, teachers, classes, today's attendance, the current term, and the fee position (billed, collected, outstanding). Use it for 'how are we doing?' questions.",
      parameters: { type: "object", properties: {} },
      run: async () => institutionSnapshot(ctx.madrasaId),
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

/* ============================================================================
   TEACHER — only their own classes, and only read-only
   ========================================================================== */

async function teacherScope(tid, userId) {
  const scope = await getTeacherAssignments(tid, userId);
  const classIds = scope.anyClassAnySubject
    ? (await db.all("SELECT id FROM classes WHERE madrasa_id = ? AND is_active = 1", [tid])).map((c) => Number(c.id))
    : [...scope.assignedClassIds];
  return { scope, classIds };
}

function teacherTools(ctx) {
  return [
    {
      name: "get_my_classes",
      description: "List the classes and subjects assigned to this teacher, with the number of students in each class.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const { scope, classIds } = await teacherScope(ctx.madrasaId, ctx.userId);
        const classes = classIds.length
          ? await db.all(
            `SELECT c.id, c.name_en,
                    (SELECT COUNT(*) FROM students s WHERE s.madrasa_id = c.madrasa_id AND s.class_id = c.id AND s.status IN ('active','promoted','suspended')) AS students
               FROM classes c WHERE c.madrasa_id = ? AND c.id IN (${classIds.map(() => "?").join(",")}) ORDER BY c.sort_order, c.name_en`,
            [ctx.madrasaId].concat(classIds)
          )
          : [];
        const assignments = [...scope.classSubjects].map((k) => {
          const [classId, subjectId] = k.split(":").map(Number);
          return { class_id: classId, subject_id: subjectId };
        });
        return {
          classes: classes.map((c) => ({ id: Number(c.id), name: c.name_en, students: n(c.students) })),
          subject_pairs: assignments,
          note: classes.length ? undefined : "No classes are assigned to this teacher yet — the school administrator controls this under Teachers → Teaching assignments.",
        };
      },
    },
    {
      name: "get_my_timetable",
      description: "Get this teacher's own timetable slots. Defaults to today; pass a day name (Monday…Saturday) for another day.",
      parameters: {
        type: "object",
        properties: { day: { type: "string", description: "Optional English day name, e.g. Monday." } },
      },
      run: async (args) => {
        const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].includes(String(args.day || "")) ? String(args.day) : dayName();
        const rows = await db.all(
          `SELECT ts.period, ts.start_time, ts.end_time, ts.room, c.name_en AS class_name, sub.name_en AS subject_name
             FROM timetable_slots ts
             JOIN classes c ON c.id = ts.class_id AND c.madrasa_id = ts.madrasa_id
             LEFT JOIN subjects sub ON sub.id = ts.subject_id
            WHERE ts.madrasa_id = ? AND ts.teacher_id = ? AND ts.day = ?
            ORDER BY ts.period`,
          [ctx.madrasaId, ctx.userId, day]
        );
        return { day, slots: rows.map((r) => ({ period: Number(r.period), time: `${r.start_time || ""}–${r.end_time || ""}`, class: r.class_name, subject: r.subject_name || "", room: r.room || "" })) };
      },
    },
    {
      name: "get_my_pending_work",
      description: "What is waiting on this teacher today: classes that meet but still have no attendance register, their own assignments with ungraded submissions, and the result workflow counts for their class/subject pairs.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const day = dayName();
        const today = todayIso();
        const slots = await db.all(
          "SELECT DISTINCT class_id, c.name_en FROM timetable_slots ts JOIN classes c ON c.id = ts.class_id WHERE ts.madrasa_id = ? AND ts.teacher_id = ? AND ts.day = ?",
          [ctx.madrasaId, ctx.userId, day]
        );
        const classIds = slots.map((s) => Number(s.class_id));
        let attendancePending = [];
        if (classIds.length) {
          const marked = await db.all(
            `SELECT DISTINCT class_id FROM attendance WHERE madrasa_id = ? AND day = ? AND class_id IN (${classIds.map(() => "?").join(",")})`,
            [ctx.madrasaId, today].concat(classIds)
          );
          const markedSet = new Set(marked.map((m) => Number(m.class_id)));
          attendancePending = slots.filter((s) => !markedSet.has(Number(s.class_id))).map((s) => s.name_en);
        }
        const ungraded = await db.get(
          `SELECT COUNT(*) AS n FROM assignment_submissions x
             JOIN homework h ON h.id = x.assignment_id AND h.madrasa_id = x.madrasa_id
            WHERE x.madrasa_id = ? AND x.score IS NULL
              AND (h.teacher_id = ? OR (h.teacher_id IS NULL AND h.created_by = ?))`,
          [ctx.madrasaId, ctx.userId, ctx.userId]
        );
        const term = await activeTerm(ctx.madrasaId);
        let results = { draft: 0, submitted: 0, returned: 0, approved: 0, published: 0 };
        if (term) {
          const rows = await db.all(
            "SELECT status, COUNT(*) AS n FROM results WHERE madrasa_id = ? AND term_id = ? AND (entered_by = ? OR modified_by = ?) GROUP BY status",
            [ctx.madrasaId, term.id, ctx.userId, ctx.userId]
          );
          for (const row of rows) if (results[row.status] !== undefined) results[row.status] = n(row.n);
        }
        return { day, attendance_pending: attendancePending, ungraded_submissions: n(ungraded && ungraded.n), results, term: term ? term.name_en : null };
      },
    },
  ];
}

/* ============================================================================
   STUDENT — their own record, nothing else
   ========================================================================== */

async function studentRow(tid, studentId) {
  if (!studentId) return null;
  return db.get(
    `SELECT s.*, c.name_en AS class_en FROM students s
       LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id
      WHERE s.id = ? AND s.madrasa_id = ?`,
    [studentId, tid]
  );
}

async function studentResults(tid, studentId, limitTerms = 4) {
  const terms = await db.all(
    `SELECT ts.term_id, ts.average, ts.overall_grade, ts.position, ts.published_at,
            t.name_en AS term_name, a.label AS session_label
       FROM term_summaries ts
       JOIN terms t ON t.id = ts.term_id
       JOIN academic_sessions a ON a.id = ts.session_id
      WHERE ts.madrasa_id = ? AND ts.student_id = ? AND ts.published_at IS NOT NULL
      ORDER BY ts.published_at DESC, ts.id DESC LIMIT ?`,
    [tid, studentId, limitTerms]
  );
  const out = terms.map((t) => ({
    term: t.term_name,
    session: t.session_label,
    average: t.average === null || t.average === undefined ? null : r1(t.average),
    grade: t.overall_grade || "",
    position: t.position ? Number(t.position) : null,
    published_at: String(t.published_at).slice(0, 10),
  }));
  if (terms.length) {
    const latest = terms[0];
    const subjects = await db.all(
      `SELECT sub.name_en, r.total, r.status FROM results r
         JOIN subjects sub ON sub.id = r.subject_id AND sub.madrasa_id = r.madrasa_id
        WHERE r.madrasa_id = ? AND r.student_id = ? AND r.term_id = ?
          AND r.status IN ('approved','published','locked')
        ORDER BY sub.name_en`,
      [tid, studentId, latest.term_id]
    );
    out[0].subjects = subjects.map((s) => ({ subject: s.name_en, total: r1(s.total), status: s.status }));
  }
  return out;
}

async function studentAttendance(tid, studentId) {
  const rows = await db.all(
    "SELECT status, COUNT(*) AS n FROM attendance WHERE madrasa_id = ? AND student_id = ? GROUP BY status",
    [tid, studentId]
  );
  const out = { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
  for (const row of rows) {
    if (out[row.status] !== undefined) out[row.status] = n(row.n);
    out.total += n(row.n);
  }
  out.percentage = out.total ? r1(((out.present + out.late + out.excused) / out.total) * 100) : null;
  return out;
}

async function studentFees(tid, student) {
  const fees = await db.all(
    `SELECT f.id, f.amount_ngn, f.due_date, f.name_en FROM fee_items f
      WHERE f.madrasa_id = ? AND f.status = 'active' AND (f.class_id IS NULL OR f.class_id = ?)`,
    [tid, student.class_id || 0]
  );
  if (!fees.length) return { billed_ngn: 0, paid_ngn: 0, balance_ngn: 0, next_due_date: null, items: [] };
  const feeIds = fees.map((f) => Number(f.id));
  const marks = feeIds.map(() => "?").join(",");
  const [assigned, payments] = await Promise.all([
    db.all(`SELECT fee_item_id, amount_due FROM fee_assignments WHERE madrasa_id = ? AND student_id = ? AND fee_item_id IN (${marks})`, [tid, student.id].concat(feeIds)),
    db.all(`SELECT fee_item_id, SUM(amount_ngn) AS paid FROM fee_payments WHERE madrasa_id = ? AND student_id = ? AND status = 'successful' AND fee_item_id IN (${marks}) GROUP BY fee_item_id`, [tid, student.id].concat(feeIds)),
  ]);
  const assignedBy = new Map(assigned.map((a) => [Number(a.fee_item_id), n(a.amount_due)]));
  const paidBy = new Map(payments.map((p) => [Number(p.fee_item_id), n(p.paid)]));
  let billed = 0; let paid = 0; let nextDue = null;
  const items = [];
  for (const fee of fees) {
    const due = assignedBy.has(Number(fee.id)) ? assignedBy.get(Number(fee.id)) : n(fee.amount_ngn);
    const got = paidBy.get(Number(fee.id)) || 0;
    billed += due; paid += got;
    const outstanding = Math.max(0, due - got);
    if (outstanding > 0 && fee.due_date && (!nextDue || String(fee.due_date).slice(0, 10) < nextDue)) nextDue = String(fee.due_date).slice(0, 10);
    items.push({ item: fee.name_en, due_ngn: due, paid_ngn: got, outstanding_ngn: outstanding, due_date: fee.due_date ? String(fee.due_date).slice(0, 10) : null });
  }
  return {
    billed_ngn: Math.round(billed), paid_ngn: Math.round(paid),
    balance_ngn: Math.max(0, Math.round(billed - paid)), next_due_date: nextDue, items,
  };
}

async function classTimetable(tid, classId, day) {
  if (!classId) return [];
  const rows = await db.all(
    `SELECT ts.period, ts.start_time, ts.end_time, ts.room, sub.name_en AS subject_name
       FROM timetable_slots ts LEFT JOIN subjects sub ON sub.id = ts.subject_id
      WHERE ts.madrasa_id = ? AND ts.class_id = ? AND ts.day = ?
      ORDER BY ts.period`,
    [tid, classId, day]
  );
  return rows.map((r) => ({ period: Number(r.period), time: `${r.start_time || ""}–${r.end_time || ""}`, subject: r.subject_name || "", room: r.room || "" }));
}

function studentTools(ctx) {
  return [
    {
      name: "get_my_profile",
      description: "Get the student's own record: name, admission number, class and institution.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const s = await studentRow(ctx.madrasaId, ctx.studentId);
        if (!s) return { error: "No student record is linked to this login. The school office can link it." };
        return { name: fullName(s), name_ar: s.name_ar || "", admission_no: s.admission_no, class: s.class_en || "", status: s.status, institution: ctx.institutionName || "" };
      },
    },
    {
      name: "get_my_results",
      description: "Get the student's own PUBLISHED term results, newest first, with the subject marks of the latest published term.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const s = await studentRow(ctx.madrasaId, ctx.studentId);
        if (!s) return { error: "No student record is linked to this login." };
        const terms = await studentResults(ctx.madrasaId, s.id);
        return { terms, note: terms.length ? undefined : "No term has been published yet." };
      },
    },
    {
      name: "get_my_attendance",
      description: "Get the student's own attendance totals and percentage.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const s = await studentRow(ctx.madrasaId, ctx.studentId);
        if (!s) return { error: "No student record is linked to this login." };
        return studentAttendance(ctx.madrasaId, s.id);
      },
    },
    {
      name: "get_my_fees",
      description: "Get the student's own fee statement: billed, paid, outstanding balance and the next due date.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const s = await studentRow(ctx.madrasaId, ctx.studentId);
        if (!s) return { error: "No student record is linked to this login." };
        return studentFees(ctx.madrasaId, s);
      },
    },
    {
      name: "get_my_timetable",
      description: "Get the student's class timetable for today, or for a named day.",
      parameters: {
        type: "object",
        properties: { day: { type: "string", description: "Optional English day name, e.g. Monday." } },
      },
      run: async (args) => {
        const s = await studentRow(ctx.madrasaId, ctx.studentId);
        if (!s) return { error: "No student record is linked to this login." };
        const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].includes(String(args.day || "")) ? String(args.day) : dayName();
        return { day, slots: await classTimetable(ctx.madrasaId, s.class_id, day) };
      },
    },
    {
      name: "get_my_assignments",
      description: "List the student's pending published assignments for their class, with due dates and submission state.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const s = await studentRow(ctx.madrasaId, ctx.studentId);
        if (!s || !s.class_id) return { error: "No class is assigned to this student yet." };
        const rows = await db.all(
          `SELECT h.id, h.title, h.due_date, sub.name_en AS subject_name,
                  (SELECT x.status FROM assignment_submissions x WHERE x.madrasa_id = h.madrasa_id AND x.assignment_id = h.id AND x.student_id = ?) AS submission_status
             FROM homework h LEFT JOIN subjects sub ON sub.id = h.subject_id
            WHERE h.madrasa_id = ? AND h.kind = 'assignment' AND h.status = 'published' AND h.class_id = ?
              AND (h.due_date IS NULL OR h.due_date >= ?)
            ORDER BY h.due_date IS NULL, h.due_date LIMIT 12`,
          [s.id, ctx.madrasaId, s.class_id, todayIso()]
        );
        return { assignments: rows.map((r) => ({ title: r.title, subject: r.subject_name || "", due_date: r.due_date ? String(r.due_date).slice(0, 10) : null, status: r.submission_status || "not submitted" })) };
      },
    },
    {
      name: "get_my_exams",
      description: "List the student's class exams that are scheduled, ongoing or published, soonest first.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const s = await studentRow(ctx.madrasaId, ctx.studentId);
        if (!s || !s.class_id) return { error: "No class is assigned to this student yet." };
        const rows = await db.all(
          `SELECT e.title, e.exam_date, e.start_time, e.end_time, e.classroom, sub.name_en AS subject_name, e.status
             FROM exams e LEFT JOIN subjects sub ON sub.id = e.subject_id
            WHERE e.madrasa_id = ? AND e.class_id = ? AND e.status IN ('scheduled','ongoing','published') AND e.exam_date >= ?
            ORDER BY e.exam_date, e.start_time LIMIT 12`,
          [ctx.madrasaId, s.class_id, todayIso()]
        );
        return { exams: rows.map((r) => ({ title: r.title, subject: r.subject_name || "", date: String(r.exam_date).slice(0, 10), time: `${r.start_time || ""}–${r.end_time || ""}`, room: r.classroom || "", status: r.status })) };
      },
    },
    {
      name: "get_my_library",
      description: "List the student's active library loans, due dates and any overdue fines.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const rows = await db.all(
          `SELECT b.title, l.issue_date, l.due_date, l.status, l.fine_ngn
             FROM library_loans l JOIN library_books b ON b.id = l.book_id AND b.madrasa_id = l.madrasa_id
            WHERE l.madrasa_id = ? AND l.borrower_user_id = ? AND l.status IN ('active','overdue')
            ORDER BY l.due_date`,
          [ctx.madrasaId, ctx.userId]
        );
        return { loans: rows.map((r) => ({ title: r.title, issued: String(r.issue_date).slice(0, 10), due: String(r.due_date).slice(0, 10), status: r.status, fine_ngn: n(r.fine_ngn) })) };
      },
    },
    {
      name: "get_my_quran_progress",
      description: "For Islamic institutions: the student's own recorded Qur'an progress entries.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const s = await studentRow(ctx.madrasaId, ctx.studentId);
        if (!s) return { error: "No student record is linked to this login." };
        let rows = [];
        try {
          rows = await db.all(
            `SELECT surah, juz, ayah_from, ayah_to, memorization_progress, revision_progress, performance_status, teacher_comments, progress_date
               FROM quran_progress WHERE madrasa_id = ? AND student_id = ? ORDER BY progress_date DESC, id DESC LIMIT 10`,
            [ctx.madrasaId, s.id]
          );
        } catch (e) { rows = []; }
        return { entries: rows.map((r) => ({ surah: r.surah, juz: r.juz || "", ayahs: r.ayah_from ? `${r.ayah_from}–${r.ayah_to || ""}` : "", memorisation: n(r.memorization_progress), revision: n(r.revision_progress), status: r.performance_status, comment: r.teacher_comments || "", date: String(r.progress_date).slice(0, 10) })) };
      },
    },
  ];
}

/* ============================================================================
   PARENT — only children linked to this account
   ========================================================================== */

async function linkedChildren(tid, parentUserId) {
  return db.all(
    `SELECT s.*, c.name_en AS class_en
       FROM students s
       JOIN parent_links pl ON pl.student_id = s.id AND pl.madrasa_id = s.madrasa_id
       LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id
      WHERE pl.madrasa_id = ? AND pl.user_id = ? AND s.madrasa_id = ?`,
    [tid, parentUserId, tid]
  );
}

async function childOverview(tid, student) {
  const [results, attendance, fees, exams, timetable] = await Promise.all([
    studentResults(tid, student.id, 2),
    studentAttendance(tid, student.id),
    studentFees(tid, student),
    student.class_id
      ? db.all(
        `SELECT e.title, e.exam_date, e.start_time, e.end_time, sub.name_en AS subject_name
           FROM exams e LEFT JOIN subjects sub ON sub.id = e.subject_id
          WHERE e.madrasa_id = ? AND e.class_id = ? AND e.exam_date >= ?
          ORDER BY e.exam_date LIMIT 6`,
        [tid, student.class_id, todayIso()]
      )
      : [],
    classTimetable(tid, student.class_id, dayName()),
  ]);
  return {
    child: { student_id: Number(student.id), name: fullName(student), class: student.class_en || "", admission_no: student.admission_no },
    latest_result: results.length ? results[0] : null,
    attendance,
    fees,
    upcoming_exams: exams.map((e) => ({ title: e.title, subject: e.subject_name || "", date: String(e.exam_date).slice(0, 10), time: `${e.start_time || ""}–${e.end_time || ""}` })),
    today_timetable: timetable,
  };
}

function parentTools(ctx) {
  return [
    {
      name: "get_my_children",
      description: "List the children linked to this parent account, with their class and admission number.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const children = await linkedChildren(ctx.madrasaId, ctx.userId);
        return {
          children: children.map((c) => ({ student_id: Number(c.id), name: fullName(c), class: c.class_en || "", admission_no: c.admission_no })),
          note: children.length ? undefined : "No child is linked to this account yet — the school office creates that link.",
        };
      },
    },
    {
      name: "get_child_overview",
      description: "Get one linked child's published result, attendance, fee balance, upcoming exams and today's timetable. Only children linked to this account can be read.",
      parameters: {
        type: "object",
        properties: { student_id: { type: "number", description: "The child's student id from get_my_children." } },
        required: ["student_id"],
      },
      run: async (args) => {
        const children = await linkedChildren(ctx.madrasaId, ctx.userId);
        const wanted = Number(args.student_id || 0);
        const child = children.find((c) => Number(c.id) === wanted);
        if (!child) return { error: "That child is not linked to this parent account." };
        return childOverview(ctx.madrasaId, child);
      },
    },
    {
      name: "get_my_meetings",
      description: "List this parent's upcoming parent-teacher meeting bookings with the child, teacher, time and status.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        let rows = [];
        try {
          rows = await db.all(
            `SELECT b.slot_time, b.status, b.notes, s.first_name, s.last_name,
                    tps.date AS session_date, tps.location, u.full_name AS teacher_name
               FROM ptm_bookings b
               JOIN students s ON s.id = b.student_id AND s.madrasa_id = b.madrasa_id
               JOIN ptm_sessions tps ON tps.id = b.ptm_session_id AND tps.madrasa_id = b.madrasa_id
               JOIN users u ON u.id = b.teacher_user_id AND u.madrasa_id = b.madrasa_id
              WHERE b.madrasa_id = ? AND b.parent_user_id = ? AND b.status <> 'cancelled'
              ORDER BY tps.date DESC, b.slot_time LIMIT 10`,
            [ctx.madrasaId, ctx.userId]
          );
        } catch (e) { rows = []; }
        return {
          meetings: rows.map((r) => ({
            child: `${r.first_name} ${r.last_name}`.trim(),
            teacher: r.teacher_name,
            date: String(r.session_date).slice(0, 10),
            time: r.slot_time,
            location: r.location || "",
            status: r.status,
          })),
        };
      },
    },
  ];
}

/* ============================================================================
   SUPER ADMIN — the platform as a whole, read-only
   ========================================================================== */

function superAdminTools() {
  return [
    TOOL_LIST_PLANS,
    {
      name: "get_platform_overview",
      description: "Platform-wide totals: institutions (total and active), students, teachers, administrators, parent accounts, plan mix, subscription status mix and pending work (registrations, payment requests, tickets).",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const [madaris, active, students, teachers, admins, parents] = await Promise.all([
          db.get("SELECT COUNT(*) AS n FROM madaris"),
          db.get("SELECT COUNT(*) AS n FROM madaris WHERE status = 'active'"),
          db.get("SELECT COUNT(*) AS n FROM students WHERE status IN ('active','promoted','suspended')"),
          db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher' AND is_active = 1"),
          db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'madrasa_admin' AND is_active = 1"),
          db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'parent' AND is_active = 1"),
        ]);
        let plans = [];
        let subs = [];
        let pending = { registrations: 0, payment_requests: 0, tickets: 0 };
        try {
          plans = await db.all("SELECT p.code, p.name, COUNT(m.id) AS n FROM plans p LEFT JOIN madaris m ON m.plan_id = p.id GROUP BY p.code, p.name ORDER BY p.sort_order");
        } catch (e) { plans = []; }
        try {
          subs = await db.all("SELECT COALESCE(subscription_status,'active') AS status, COUNT(*) AS n FROM madaris GROUP BY COALESCE(subscription_status,'active')");
        } catch (e) { subs = []; }
        try { pending.registrations = n((await db.get("SELECT COUNT(*) AS n FROM madrasa_registrations WHERE status = 'Pending'")).n); } catch (e) { /* optional */ }
        try { pending.payment_requests = n((await db.get("SELECT COUNT(*) AS n FROM subscription_invoices WHERE status IN ('pending','awaiting_approval')")).n); } catch (e) { /* optional */ }
        try { pending.tickets = n((await db.get("SELECT COUNT(*) AS n FROM support_tickets WHERE status IN ('open','awaiting_reply')")).n); } catch (e) { /* optional */ }
        return {
          institutions: { total: n(madaris && madaris.n), active: n(active && active.n) },
          students: n(students && students.n),
          teachers: n(teachers && teachers.n),
          administrators: n(admins && admins.n),
          parent_accounts: n(parents && parents.n),
          plans: plans.map((p) => ({ code: p.code, name: p.name, institutions: n(p.n) })),
          subscriptions: subs.map((s) => ({ status: s.status, institutions: n(s.n) })),
          pending,
        };
      },
    },
    {
      name: "list_institutions",
      description: "List institutions with their plan, status, student and teacher counts, subscription status and expiry. Optionally filter by status (active/suspended) or by a name search.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Optional: active or suspended." },
          search: { type: "string", description: "Optional name or slug fragment." },
          limit: { type: "number", description: "Maximum rows, default 25." },
        },
      },
      run: async (args) => {
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 25));
        const where = ["1=1"];
        const params = [];
        if (args.status) { where.push("m.status = ?"); params.push(cleanStr(args.status, 20)); }
        if (args.search) { where.push("(LOWER(m.name_en) LIKE ? OR LOWER(m.slug) LIKE ?)"); const q = `%${cleanStr(args.search, 80).toLowerCase()}%`; params.push(q, q); }
        const rows = await db.all(
          `SELECT m.id, m.name_en, m.slug, m.status, m.city, m.state_name,
                  p.code AS plan_code, p.name AS plan_name,
                  COALESCE(m.subscription_status,'active') AS subscription_status, m.plan_expires_at,
                  (SELECT COUNT(*) FROM students s WHERE s.madrasa_id = m.id AND s.status IN ('active','promoted','suspended')) AS students,
                  (SELECT COUNT(*) FROM users u WHERE u.madrasa_id = m.id AND u.role = 'teacher' AND u.is_active = 1) AS teachers
             FROM madaris m LEFT JOIN plans p ON p.id = m.plan_id
            WHERE ${where.join(" AND ")}
            ORDER BY m.name_en LIMIT ?`,
          params.concat([limit])
        );
        return {
          institutions: rows.map((r) => ({
            id: Number(r.id), name: r.name_en, slug: r.slug, status: r.status,
            plan: r.plan_name || r.plan_code || "—", subscription_status: r.subscription_status,
            expires_at: r.plan_expires_at ? String(r.plan_expires_at).slice(0, 10) : null,
            students: n(r.students), teachers: n(r.teachers), location: [r.city, r.state_name].filter(Boolean).join(", "),
          })),
        };
      },
    },
    {
      name: "list_payment_requests",
      description: "List subscription invoices that are pending or awaiting approval, with the institution, plan, amount and reference. Use this to tell the operator what money is waiting to be checked.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        let rows = [];
        try {
          rows = await db.all(
            `SELECT i.invoice_no, i.amount_ngn, i.billing_cycle, i.status, i.reference, i.created_at,
                    m.name_en AS madrasa_name, p.name AS plan_name
               FROM subscription_invoices i
               JOIN madaris m ON m.id = i.madrasa_id
               LEFT JOIN plans p ON p.id = i.plan_id
              WHERE i.status IN ('pending','awaiting_approval')
              ORDER BY i.id DESC LIMIT 50`
          );
        } catch (e) { rows = []; }
        return { payment_requests: rows.map((r) => ({ invoice_no: r.invoice_no, institution: r.madrasa_name, plan: r.plan_name || "", amount_ngn: n(r.amount_ngn), cycle: r.billing_cycle, status: r.status, reference: r.reference, created: String(r.created_at).slice(0, 10) })) };
      },
    },
    {
      name: "list_registrations",
      description: "List school registration applications. Defaults to Pending; pass status Approved or Rejected for history.",
      parameters: { type: "object", properties: { status: { type: "string", description: "Pending (default), Approved or Rejected." } } },
      run: async (args) => {
        const status = ["Pending", "Approved", "Rejected"].includes(String(args.status || "")) ? String(args.status) : "Pending";
        let rows = [];
        try {
          rows = await db.all(
            `SELECT registration_id, name, city, state_name, admin_full_name, admin_email, admin_phone, submitted_at, status
               FROM madrasa_registrations WHERE status = ? ORDER BY id DESC LIMIT 40`,
            [status]
          );
        } catch (e) { rows = []; }
        return { status, registrations: rows.map((r) => ({ reference: r.registration_id, institution: r.name, location: [r.city, r.state_name].filter(Boolean).join(", "), administrator: r.admin_full_name, email: r.admin_email || "", phone: r.admin_phone || "", submitted_at: r.submitted_at ? String(r.submitted_at).slice(0, 10) : null })) };
      },
    },
    {
      name: "list_support_tickets",
      description: "List support tickets from institutions, newest first. Optionally filter by status (open, awaiting_reply, resolved, closed).",
      parameters: { type: "object", properties: { status: { type: "string" } } },
      run: async (args) => {
        const where = ["1=1"];
        const params = [];
        if (args.status) { where.push("t.status = ?"); params.push(cleanStr(args.status, 20)); }
        let rows = [];
        try {
          rows = await db.all(
            `SELECT t.id, t.subject, t.status, t.priority, t.category, t.created_at, m.name_en AS madrasa_name
               FROM support_tickets t LEFT JOIN madaris m ON m.id = t.madrasa_id
              WHERE ${where.join(" AND ")}
              ORDER BY t.id DESC LIMIT 40`,
            params
          );
        } catch (e) { rows = []; }
        return { tickets: rows.map((r) => ({ id: Number(r.id), subject: r.subject, institution: r.madrasa_name || "", status: r.status, priority: r.priority, category: r.category, created: String(r.created_at).slice(0, 10) })) };
      },
    },
    {
      name: "get_recent_activity",
      description: "Recent audited actions across the platform, with the user and institution.",
      parameters: { type: "object", properties: { limit: { type: "number" } } },
      run: async (args) => {
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
        let rows = [];
        try {
          rows = await db.all(
            `SELECT a.action, a.entity, a.entity_id, a.created_at, u.username, m.name_en AS madrasa_name
               FROM activity_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN madaris m ON m.id = a.madrasa_id
              ORDER BY a.id DESC LIMIT ?`,
            [limit]
          );
        } catch (e) { rows = []; }
        return { activity: rows.map((r) => ({ action: r.action, entity: r.entity || "", entity_id: r.entity_id || "", user: r.username || "system", institution: r.madrasa_name || "platform", at: String(r.created_at).slice(0, 19) })) };
      },
    },
    {
      name: "get_ai_knowledge_stats",
      description: "How many AI knowledge-base answers exist per space, and how many are active.",
      parameters: { type: "object", properties: {} },
      run: async () => ({ spaces: await ai.knowledgeStats() }),
    },
  ];
}

/* ============================================================================
   PUBLIC / WHATSAPP TOOLS
   ========================================================================== */

function publicTools() {
  return [
    TOOL_LIST_PLANS,
    TOOL_CONTACT,
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

function whatsappTools(ctx) {
  return [
    TOOL_LIST_PLANS,
    TOOL_CONTACT,
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

appRouter.use(requireAuth);

/** The space for this request. Decided by the role the SERVER authenticated in
    `requireAuth` — a browser can never claim to be the operator. */
function currentSurface(req) {
  return spaces.surfaceForRole(req.user.role);
}

function conversationExternalId(surface, req) {
  return `${surface}-user-${req.user.id}`;
}

/** Who is asking, in the model's words. Built from the session, never from the
    request body, and never carrying another tenant's identity. */
async function requestContext(req, surface, tid) {
  const context = {
    role: req.user.role,
    userName: req.user.fullName || req.user.username,
    today: todayIso(),
  };
  if (!tid) return context;
  const m = await db.get("SELECT name_en, category FROM madaris WHERE id = ?", [tid]);
  if (m) {
    context.institutionName = m.name_en;
    context.category = m.category || "islamic";
  }
  if (surface === "admin") {
    try {
      const s = await subscription.summary(tid);
      if (s) {
        context.plan = s.plan.name;
        context.subscriptionStatus = s.subscription.status;
      }
    } catch (e) { /* the assistant still works without a subscription row */ }
  }
  if (surface === "student" && req.user.studentId) {
    const s = await studentRow(tid, req.user.studentId);
    if (s) context.studentName = fullName(s);
  }
  if (surface === "parent") {
    const children = await linkedChildren(tid, req.user.id);
    context.children = children.map((c) => fullName(c)).filter(Boolean);
  }
  return context;
}

function toolsFor(surface, ctx) {
  switch (surface) {
    case "super_admin": return superAdminTools();
    case "admin": return adminTools(ctx);
    case "teacher": return teacherTools(ctx);
    case "student": return studentTools(ctx);
    case "parent": return parentTools(ctx);
    case "school": return schoolTools(ctx);
    default: return publicTools();
  }
}

appRouter.get("/status", asyncHandler(async (req, res) => {
  const surface = currentSurface(req);
  const tid = effectiveTenantId(req) || req.user.madrasaId || null;
  const m = tid ? await db.get("SELECT name_en FROM madaris WHERE id = ?", [tid]) : null;
  // Resolved, not read from config.AI: a model connected under Platform → AI
  // Assistant is live on the next request, and `source` says which layer won.
  const modelCfg = await aiConfig.resolve();
  ok(res, {
    surface,
    role: req.user.role,
    space: spaces.publicSpace(surface),
    welcome: await ai.welcome(surface),
    live: modelCfg.enabled,
    source: modelCfg.source,
    ai_model: modelCfg.enabled ? modelCfg.model : "",
    institution: m ? m.name_en : "",
    whatsapp: await whatsappLine.line(),
  });
}));

appRouter.post("/chat", appLimiter, asyncHandler(async (req, res) => {
  const surface = currentSurface(req);
  const tid = effectiveTenantId(req) || req.user.madrasaId || null;
  if (spaces.isTenantSurface(surface) && !tid) return err(res, 400, "No institution on this session.");

  const message = cleanStr(req.body && req.body.message, 4000);
  if (!message) return err(res, 400, "Type a message.");

  const context = await requestContext(req, surface, tid);
  context.madrasaId = tid;
  context.userId = req.user.id;

  const conv = await ai.conversation({
    surface,
    madrasaId: surface === "super_admin" ? null : tid,
    userId: req.user.id,
    externalId: conversationExternalId(surface, req),
  });
  const history = await ai.history(conv.id);
  const messages = history.concat([{ role: "user", content: message }]);

  let out;
  try {
    out = await ai.ask({ surface, messages, tools: toolsFor(surface, context), context });
  } catch (e) {
    // The model is down; the knowledge base (or the space's own menu) may
    // still answer, and it is still scoped to this space. The reason travels
    // with it, so the caller can tell a refusal from "no model configured".
    out = await degradedTurn(surface, message, e);
  }

  await ai.saveMessage(conv.id, "user", message);
  await ai.saveMessage(conv.id, "assistant", out.content, { sources: out.sources, tokens: out.tokens });
  ok(res, Object.assign({
    reply: out.content,
    sources: out.sources || [],
    mode: out.mode,
    surface,
    conversation_id: conv.id,
    actions: (out.toolCalls || []).map((t) => t.name),
  }, fallbackFields(out)));
}));

appRouter.get("/history", asyncHandler(async (req, res) => {
  const surface = currentSurface(req);
  const tid = effectiveTenantId(req) || req.user.madrasaId || null;
  const conv = await ai.conversation({
    surface,
    madrasaId: surface === "super_admin" ? null : tid,
    userId: req.user.id,
    externalId: conversationExternalId(surface, req),
  });
  ok(res, { surface, conversation_id: conv.id, messages: await ai.history(conv.id, 50) });
}));

appRouter.post("/reset", asyncHandler(async (req, res) => {
  const surface = currentSurface(req);
  const tid = effectiveTenantId(req) || req.user.madrasaId || null;
  const conv = await ai.conversation({
    surface,
    madrasaId: surface === "super_admin" ? null : tid,
    userId: req.user.id,
    externalId: conversationExternalId(surface, req),
  });
  await db.run("DELETE FROM ai_messages WHERE conversation_id = ?", [conv.id]);
  ok(res, { ok: true, surface });
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

/* The copilot reads whole-school data, so it is for the people who run the
   school. A student or parent gets a plain 403 rather than a school-wide view. */
appRouter.use("/copilot", requireRole("madrasa_admin", "super_admin"));

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
  const modelCfg = await aiConfig.resolve();
  const out = [];
  for (const cap of COPILOT_CAPABILITIES) {
    const gate = await subscription.checkFeature(tid, cap.feature);
    out.push(Object.assign({}, cap, {
      entitled: Boolean(gate.allowed),
      model_live: modelCfg.enabled,
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
    model: modelCfg.enabled ? modelCfg.model : "",
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
  const modelCfg = await aiConfig.resolve();
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
  if (modelCfg.enabled && b.polish !== false) {
    try {
      const out = await ai.ask({
        surface: "admin",
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
    model: modelCfg.enabled ? modelCfg.model : "",
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
  const modelCfg = await aiConfig.resolve();
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

    if (modelCfg.enabled && b.use_model !== false) {
      try {
        const out = await ai.ask({
          surface: "admin",
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
    model: modelCfg.enabled ? modelCfg.model : "",
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
  const modelCfg = await aiConfig.resolve();
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
  if (modelCfg.enabled && req.query.polish !== "false") {
    try {
      const out = await ai.ask({
        surface: "admin",
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
   ----------------------------------------------------------------------------
   What a visitor can do here:
     GET  /api/public/ai/info     the space, the WhatsApp line and the links
     GET  /api/public/ai/whatsapp the WhatsApp line on its own (the CTA)
     POST /api/public/ai/chat     ask the public assistant
     GET  /api/public/ai/status   is the assistant live? (kept for compatibility)
   ========================================================================== */

async function publicInfo() {
  const wa = await whatsappLine.line();
  const s = await subscription.getSettings();
  const modelCfg = await aiConfig.resolve();
  return {
    surface: "public",
    space: spaces.publicSpace("public"),
    welcome: await ai.welcome("public"),
    live: modelCfg.enabled,
    source: modelCfg.source,
    model: modelCfg.enabled ? modelCfg.model : "",
    whatsapp: wa,
    contact: { email: s.billing_contact_email || "", phone: s.billing_contact_phone || "" },
    links: {
      register_islamic_school: "/register-madrasa",
      register_western_academy: "/register-academy",
      sign_in: "/login",
      plans: "/#plans",
      registration_status: "/register-madrasa",
    },
  };
}

publicRouter.get("/info", asyncHandler(async (req, res) => {
  ok(res, await publicInfo());
}));

/* The CTA on its own: a tiny endpoint so the website can render the WhatsApp
   button without loading the whole assistant. */
publicRouter.get("/whatsapp", asyncHandler(async (req, res) => {
  const wa = await whatsappLine.line();
  ok(res, { whatsapp: wa, message: wa.available ? "Chat with EduSphere on WhatsApp" : "The WhatsApp line is not configured yet." });
}));

publicRouter.get("/status", asyncHandler(async (req, res) => {
  const modelCfg = await aiConfig.resolve();
  ok(res, {
    surface: "public",
    enabled: true, // the assistant itself is always available — the key only decides conversational depth
    live: modelCfg.enabled,
    source: modelCfg.source,
    model: modelCfg.enabled ? modelCfg.model : "",
  });
}));

publicRouter.post("/chat", publicLimiter, asyncHandler(async (req, res) => {
  const message = cleanStr(req.body && req.body.message, 2000);
  if (!message) return err(res, 400, "Type a message.");
  const sessionId = cleanStr(req.body && req.body.session_id, 80) || `anon-${req.ip || "unknown"}`;
  const conv = await ai.conversation({ surface: "public", externalId: sessionId });
  const history = await ai.history(conv.id);
  const messages = history.concat([{ role: "user", content: message }]);

  let out;
  try {
    out = await ai.ask({ surface: "public", messages, tools: publicTools(), context: { today: todayIso() } });
  } catch (e) {
    out = await degradedTurn("public", message, e);
  }

  await ai.saveMessage(conv.id, "user", message);
  await ai.saveMessage(conv.id, "assistant", out.content, { sources: out.sources, tokens: out.tokens });
  ok(res, Object.assign({
    reply: out.content,
    sources: out.sources || [],
    mode: out.mode,
    session_id: sessionId,
    surface: "public",
    whatsapp: await whatsappLine.line(),
    suggestions: spaces.publicSpace("public").suggestions,
  }, fallbackFields(out)));
}));

/* ============================================================================
   ONE SCHOOL'S PUBLIC WEBSITE — the per-institution assistant
   ----------------------------------------------------------------------------
   Every institution has its own public website at /schools/<slug>, and the
   assistant mounted there belongs to THAT school. The slug comes from the URL
   and is resolved to a tenant id ON THE SERVER; the browser never names a
   tenant, and every tool below reads only that tenant's PUBLIC projections.

   What it can never see: students, marks, results, fees, payments, staff
   records, subscriptions — none of those tables is queried here at all. What
   it can see is exactly what the school published for the public page: its
   profile, programmes, admissions status, public news and events, and the
   contact details the school chose to publish.
   ========================================================================== */

/** The school behind a public URL, or null. Same visibility rules as the
    directory: active, publicly listed. */
async function findPublicSchool(slug) {
  const s = String(slug || "").trim().toLowerCase().slice(0, 80);
  if (!s) return null;
  return db.get(
    `SELECT id, slug, name_en, name_ar, category, institution_type, motto_en, tagline,
            description_en, short_description, city, state_name, town, address,
            phone, email, whatsapp, website, maps_link, founded_year, levels_offered,
            admission_status, public_admissions, logo_path
       FROM madaris
      WHERE slug = ? AND status = 'active' AND public_listing = 1`,
    [s]
  );
}

/** The widget's description of this school's assistant. The school's own name
    leads, so a visitor never mistakes it for the platform assistant. */
async function schoolInfo(slug) {
  const school = await findPublicSchool(slug);
  if (!school) return null;
  const wa = await whatsappLine.line();
  const space = spaces.publicSpace("school");
  const name = school.name_en || "this school";
  return {
    surface: "school",
    school: { slug: school.slug, name: school.name_en || "", category: school.category || "islamic" },
    space: Object.assign({}, space, {
      key: "school",
      label: `${name} · Assistant`,
      subtitle: `Ask about ${name}`,
      greeting:
        `Hello! I'm the assistant for ${name}. ` +
        "I can tell you what the school has published — who it is, the programmes it offers, " +
        "how admissions work, and the latest news and events. What would you like to know?",
      suggestions: [
        `What is happening at ${name}?`,
        "What programmes does the school offer?",
        "How do I apply for admission?",
        "What are the latest news and events?",
      ],
    }),
    whatsapp: wa,
    contact: {
      phone: school.phone || "",
      email: school.email || "",
      whatsapp: school.whatsapp || "",
      website: school.website || "",
    },
    links: {
      school_page: `/schools/${encodeURIComponent(school.slug)}`,
      apply: `/schools/${encodeURIComponent(school.slug)}#admissions`,
    },
  };
}

/** The school's tools. Every one of them is closed over ctx.madrasaId — the
    tenant id the SERVER resolved from the slug — so the model can never point
    one at another school, and none of them can reach a private table. */
function schoolTools(ctx) {
  const tid = ctx.madrasaId;
  const overview = async () => {
    const m = await db.get(
      `SELECT name_en, name_ar, institution_type, category, motto_en, tagline, description_en, short_description,
              city, state_name, town, address, founded_year, levels_offered, phone, email, whatsapp, website, maps_link
         FROM madaris WHERE id = ?`,
      [tid]
    );
    if (!m) return { error: "This school's page is not available." };
    return {
      name: m.name_en,
      name_arabic: m.name_ar || "",
      type: m.institution_type || (m.category === "western" ? "Academy" : "Madrasa"),
      motto: m.motto_en || m.tagline || "",
      about: m.short_description || m.description_en || "",
      location: [m.town, m.city, m.state_name].filter(Boolean).join(", "),
      address: m.address || "",
      founded: m.founded_year || "",
      levels: m.levels_offered || "",
      phone: m.phone || "", email: m.email || "", whatsapp: m.whatsapp || "", website: m.website || "",
    };
  };
  return [
    {
      name: "school_overview",
      description: "Who this school is: name, type, motto, about, location, levels offered and published contact details. Use it for any 'tell me about this school' question.",
      parameters: { type: "object", properties: {} },
      run: overview,
    },
    {
      name: "school_programmes",
      description: "The programmes, classes and subjects this school offers publicly, with their levels and durations.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const [programs, classes, subjects] = await Promise.all([
          db.all(
            "SELECT title, description, level_name, duration, category FROM public_programs WHERE madrasa_id = ? AND is_published = 1 ORDER BY sort_order, id LIMIT 30",
            [tid]
          ).catch(() => []),
          db.all("SELECT name_en FROM classes WHERE madrasa_id = ? AND is_active = 1 ORDER BY sort_order, id LIMIT 60", [tid]).catch(() => []),
          db.all("SELECT name_en, category FROM subjects WHERE madrasa_id = ? AND is_active = 1 ORDER BY name_en LIMIT 60", [tid]).catch(() => []),
        ]);
        return {
          programmes: programs.map((p) => ({
            title: p.title, level: p.level_name || "", duration: p.duration || "",
            description: String(p.description || "").slice(0, 400),
          })),
          classes: classes.map((c) => c.name_en).filter(Boolean),
          subjects: subjects.map((s) => s.name_en).filter(Boolean),
        };
      },
    },
    {
      name: "school_admissions",
      description: "Whether admissions are open right now, and how a family applies on this page.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const m = await db.get("SELECT admission_status, public_admissions, name_en FROM madaris WHERE id = ?", [tid]);
        if (!m) return { error: "This school's page is not available." };
        const open = Number(m.public_admissions) === 1 && String(m.admission_status || "open").toLowerCase() !== "closed";
        return {
          admissions_open: open,
          status: m.admission_status || "open",
          how_to_apply: open
            ? "Use the Apply for Admission form in the Admissions section of this page — it takes a few minutes and the school office follows up."
            : "Admissions are currently closed on this page. The school office can still be contacted directly using the details on this page.",
          apply_section: "#admissions",
        };
      },
    },
    {
      name: "school_news",
      description: "The school's latest public news and notices, newest first.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const rows = await db.all(
          `SELECT title, body, created_at, category FROM announcements
            WHERE madrasa_id = ? AND is_active = 1 AND publish_public = 1
              AND (publish_until IS NULL OR publish_until >= ?)
            ORDER BY created_at DESC, id DESC LIMIT 8`,
          [tid, todayIso()]
        ).catch(() => []);
        return { news: rows.map((r) => ({ title: r.title, category: r.category || "news", date: String(r.created_at || "").slice(0, 10), body: String(r.body || "").slice(0, 500) })) };
      },
    },
    {
      name: "school_events",
      description: "Upcoming public events at this school (today onwards), soonest first.",
      parameters: { type: "object", properties: {} },
      run: async () => {
        const rows = await db.all(
          `SELECT title, body, event_date, event_location FROM announcements
            WHERE madrasa_id = ? AND is_active = 1 AND publish_public = 1
              AND event_date IS NOT NULL AND event_date <> '' AND event_date >= ?
              AND (publish_until IS NULL OR publish_until >= ?)
            ORDER BY event_date ASC, id ASC LIMIT 8`,
          [tid, todayIso(), todayIso()]
        ).catch(() => []);
        return { events: rows.map((r) => ({ title: r.title, date: String(r.event_date || "").slice(0, 10), location: r.event_location || "", body: String(r.body || "").slice(0, 400) })) };
      },
    },
  ];
}

/**
 * The school assistant's answer when no model is connected — or when the
 * provider is down. The platform promises no dead end in every other space,
 * and this space's real content lives in its own tools, so a small rule-based
 * router calls the SAME tools the model would call and formats the result.
 * A visitor on a school page gets a real answer about that school either way.
 */
async function schoolDeterministicAnswer(message, ctx) {
  const tools = schoolTools(ctx);
  const run = async (name) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return null;
    try { return await tool.run({}); } catch (e) { return null; }
  };
  const q = String(message || "").toLowerCase();
  const has = (...words) => words.some((w) => q.includes(w));
  const name = ctx.schoolName || "the school";
  const list = (items, empty) => (items && items.length ? items : [empty || "—"]);

  if (has("news", "happening", "going on", "update", "notice", "announcement", "latest", "event")) {
    const [news, events] = await Promise.all([run("school_news"), run("school_events")]);
    const lines = [`Here is what is happening at ${name} right now:`, ""];
    lines.push("Latest news and notices:");
    for (const n of list(news.news, "No public notices at the moment.").slice(0, 5)) {
      lines.push(typeof n === "string" ? `• ${n}` : `• ${n.title}${n.date ? ` (${n.date})` : ""}${n.body ? ` — ${n.body.split("\n")[0].slice(0, 180)}` : ""}`);
    }
    lines.push("", "Upcoming events:");
    for (const e of list(events.events, "No upcoming public events yet.").slice(0, 5)) {
      lines.push(typeof e === "string" ? `• ${e}` : `• ${e.title}${e.date ? ` — ${e.date}` : ""}${e.location ? `, ${e.location}` : ""}`);
    }
    return { content: lines.join("\n"), sources: [], mode: "school-direct", toolCalls: [] };
  }

  if (has("admission", "apply", "application", "enrol", "enroll", "join", "intake")) {
    const adm = await run("school_admissions");
    if (adm && adm.admissions_open) {
      return {
        content: `Admissions at ${name} are open. Use the **Apply for Admission** form in the Admissions section of this page — it takes a few minutes, and the school office follows up with you. You can also reach the school directly using the contact details on this page.`,
        sources: [], mode: "school-direct", toolCalls: [],
      };
    }
    return {
      content: `Admissions at ${name} are currently closed on this page. The school office can still help — their contact details are on this page.`,
      sources: [], mode: "school-direct", toolCalls: [],
    };
  }

  if (has("programme", "program", "class", "subject", "curriculum", "offer", "teach", "level")) {
    const p = await run("school_programmes");
    const lines = [`What ${name} offers:`];
    if (p.programmes && p.programmes.length) {
      for (const prog of p.programmes.slice(0, 8)) {
        lines.push(`• ${prog.title}${prog.level ? ` — ${prog.level}` : ""}${prog.duration ? ` (${prog.duration})` : ""}`);
      }
    } else {
      lines.push("• The school has not published a programme list yet.");
    }
    if (p.subjects && p.subjects.length) lines.push("", `Subjects include: ${p.subjects.slice(0, 20).join(", ")}.`);
    if (p.classes && p.classes.length) lines.push(`Classes: ${p.classes.slice(0, 20).join(", ")}.`);
    return { content: lines.join("\n"), sources: [], mode: "school-direct", toolCalls: [] };
  }

  if (has("about", "who are you", "where", "location", "address", "contact", "motto", "founded", "history", "tell me")) {
    const o = await run("school_overview");
    if (o && !o.error) {
      const lines = [`${o.name}${o.type ? ` is a ${o.type}` : ""}${o.location ? ` in ${o.location}` : ""}.`];
      if (o.motto) lines.push(`Motto: ${o.motto}`);
      if (o.about) lines.push("", o.about);
      if (o.levels) lines.push("", `Levels offered: ${o.levels}`);
      if (o.founded) lines.push(`Founded: ${o.founded}`);
      const contact = [o.phone && `Phone ${o.phone}`, o.email && `Email ${o.email}`, o.whatsapp && `WhatsApp ${o.whatsapp}`].filter(Boolean);
      if (contact.length) lines.push("", `Contact: ${contact.join(" · ")}`);
      return { content: lines.join("\n"), sources: [], mode: "school-direct", toolCalls: [] };
    }
  }

  // A greeting, or anything else: what this assistant can actually answer.
  return {
    content:
      `Hello! I'm the assistant for ${name}. I can tell you what the school has published — ` +
      "who it is, the programmes it offers, whether admissions are open, and the latest news and events. " +
      "What would you like to know?",
    sources: [], mode: "school-direct", toolCalls: [],
  };
}

publicRouter.get("/school/:slug", publicLimiter, asyncHandler(async (req, res) => {
  const info = await schoolInfo(req.params.slug);
  if (!info) return err(res, 404, "That school's assistant is not available.");
  ok(res, info);
}));

publicRouter.post("/school/:slug/chat", publicLimiter, asyncHandler(async (req, res) => {
  const school = await findPublicSchool(req.params.slug);
  if (!school) return err(res, 404, "That school's assistant is not available.");

  const message = cleanStr(req.body && req.body.message, 2000);
  if (!message) return err(res, 400, "Type a message.");
  const sessionId = cleanStr(req.body && req.body.session_id, 80) || `school-${school.slug}-${req.ip || "unknown"}`;

  // The tenant id comes from the slug the SERVER resolved — never from the
  // request body — and every tool is closed over it.
  const ctx = { madrasaId: school.id, slug: school.slug, schoolName: school.name_en || "", today: todayIso() };
  const conv = await ai.conversation({ surface: "school", madrasaId: school.id, externalId: `school-${school.slug}-${sessionId}` });
  const history = await ai.history(conv.id);
  const messages = history.concat([{ role: "user", content: message }]);

  let out;
  try {
    out = await ai.ask({ surface: "school", messages, tools: schoolTools(ctx), context: ctx });
    // With no model connected the knowledge base can only answer platform-wide
    // facts; this space's real content lives in its own tools, so answer from
    // those instead of a generic menu.
    if (out && out.fallback_reason === "no_model_configured") {
      const local = await schoolDeterministicAnswer(message, ctx);
      if (local) out = local;
    }
  } catch (e) {
    out = (await schoolDeterministicAnswer(message, ctx)) || (await degradedTurn("school", message, e));
  }

  await ai.saveMessage(conv.id, "user", message);
  await ai.saveMessage(conv.id, "assistant", out.content, { sources: out.sources, tokens: out.tokens });
  const info = await schoolInfo(school.slug);
  ok(res, Object.assign({
    reply: out.content,
    sources: out.sources || [],
    mode: out.mode,
    session_id: sessionId,
    surface: "school",
    school: info ? info.school : { slug: school.slug, name: school.name_en || "" },
    suggestions: info ? info.space.suggestions : [],
  }, fallbackFields(out)));
}));

/* ============================================================================
   WHATSAPP SURFACE
   ----------------------------------------------------------------------------
   The same assistant, on the number customers already message. Two ways in:
     • the public website's "Chat on WhatsApp" button (wa.me/<number>)
     • someone messaging the line directly
   Either way the conversation is stored under its own surface and answered
   from the WhatsApp space's knowledge and short-reply prompt.
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

const WA_GREETINGS = new Set(["hi", "hello", "hey", "hi there", "hello there", "start", "menu", "good morning", "good afternoon", "good evening"]);
const WA_HUMAN = /^(human|agent|person|support|talk to (a )?(human|person|agent)|speak to (a )?(human|person|agent))$/i;

async function whatsappMenuReply() {
  const space = spaces.spaceOf("whatsapp");
  const wa = await whatsappLine.line();
  const lines = [space.greeting, "", "You can ask me:"];
  for (const q of space.suggestions.slice(0, 4)) lines.push(`• ${q}`);
  if (wa.available) lines.push("", `Or use the website: ${wa.link}`.slice(0, 900));
  lines.push("", "Reply *human* at any time to speak to our team.");
  return lines.filter((l) => l !== "").join("\n");
}

async function whatsappEscalate(from, conversationId, summary) {
  try { await db.run("UPDATE ai_conversations SET escalated = 1 WHERE id = ?", [conversationId]); } catch (e) { /* non-fatal */ }
  logActivity(db, { action: "ai.whatsapp_escalate", entity: "ai_conversation", entityId: String(conversationId), meta: { from, summary: summary || "Requested a human" } });
  return "Thank you — I have handed this conversation to the EduSphere team. Someone will continue right here shortly. You do not need to repeat anything.";
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
  const type = String(message.type || "text");
  const incoming = String((message.text && message.text.body) || "").trim();

  const conv = await ai.conversation({ surface: "whatsapp", externalId: `wa-${from}` });
  const ctx = { conversationId: conv.id, from, surface: "whatsapp" };

  // A greeting, a non-text message, or an empty one gets the menu — the same
  // thing a person would do, instead of an error.
  if (!incoming || type !== "text") {
    const reply = !incoming || WA_GREETINGS.has(incoming.toLowerCase())
      ? await whatsappMenuReply()
      : "I can read text messages here. Tell me what you need in a few words — registration, plans, or how EduSphere works — or reply *human* to speak to our team.";
    await ai.saveMessage(conv.id, "user", incoming || `[${type}]`);
    await ai.saveMessage(conv.id, "assistant", reply);
    const delivery = await sendWhatsApp(from, reply);
    return res.json({ received: true, delivered: delivery.ok, provider: delivery.provider, mode: "menu" });
  }

  if (WA_GREETINGS.has(incoming.toLowerCase())) {
    const reply = await whatsappMenuReply();
    await ai.saveMessage(conv.id, "user", incoming);
    await ai.saveMessage(conv.id, "assistant", reply);
    const delivery = await sendWhatsApp(from, reply);
    return res.json({ received: true, delivered: delivery.ok, provider: delivery.provider, mode: "menu" });
  }

  if (WA_HUMAN.test(incoming)) {
    const reply = await whatsappEscalate(from, conv.id, incoming);
    await ai.saveMessage(conv.id, "user", incoming);
    await ai.saveMessage(conv.id, "assistant", reply);
    const delivery = await sendWhatsApp(from, reply);
    return res.json({ received: true, delivered: delivery.ok, provider: delivery.provider, mode: "escalated" });
  }

  const history = await ai.history(conv.id, 12);
  const messages = history.concat([{ role: "user", content: incoming }]);

  let out;
  try {
    out = await ai.ask({ surface: "whatsapp", messages, tools: whatsappTools(ctx), context: ctx });
  } catch (e) {
    out = await degradedTurn("whatsapp", incoming, e);
  }

  await ai.saveMessage(conv.id, "user", incoming);
  await ai.saveMessage(conv.id, "assistant", out.content, { sources: out.sources, tokens: out.tokens });
  const delivery = await sendWhatsApp(from, out.content);
  res.json(Object.assign({
    received: true, delivered: delivery.ok, provider: delivery.provider, mode: out.mode,
    surface: "whatsapp",
  }, fallbackFields(out)));
}));

/* ============================================================================
   PLATFORM — knowledge base editor + space overview
   ========================================================================== */
platformRouter.use(requireSuperAdmin);

/* ============================================================================
   AI PROVIDER CONFIGURATION — the dashboard layer
   ----------------------------------------------------------------------------
   The super admin connects a model here instead of editing .env on the server:

     GET  /api/platform/ai/settings   stored values + the RESOLVED answer
     PUT  /api/platform/ai/settings   save (blank/sentinel key = keep existing)
     POST /api/platform/ai/test       a probe against UNSAVED values
                                      (mode "real" by default; "small" = 8 tokens)
     GET  /api/platform/ai/diagnose   resolved config + one REALISTIC probe
                                      that mirrors a live public turn

   The environment wins per field (services/ai-config.js), so the payload says
   exactly which layer supplied each value. The API key is NEVER returned —
   only key_set and key_last4 — and it is stored AES-256-GCM encrypted.
   ========================================================================== */

/** One payload for the card and for every save/test that needs to re-render. */
async function aiSettingsPayload() {
  const stored = await subscription.getSettings();
  const resolved = await aiConfig.resolve();
  const env = config.AI;
  return {
    settings: {
      provider: aiConfig.normalizeProvider(stored.ai_provider) || "none",
      base_url: String(stored.ai_base_url || ""),
      model: String(stored.ai_model || ""),
      enabled: !["0", "false", "no", "off"].includes(String(stored.ai_enabled == null ? "1" : stored.ai_enabled).trim().toLowerCase()),
    },
    resolved: {
      enabled: resolved.enabled,
      provider: resolved.provider,
      base_url: resolved.baseUrl,
      model: resolved.model,
      source: resolved.source,
      key_set: resolved.keySet,
      key_last4: resolved.keyLast4,
      origins: resolved.origins,
    },
    // Which fields the environment pins. Values are never echoed — only the
    // fact that the form is not authoritative for that field.
    env: {
      api_key_set: Boolean(env.apiKey),
      base_url_set: Boolean(env.baseUrl),
      model_set: Boolean(env.model),
      locked: resolved.locked,
    },
    presets: aiConfig.PRESETS,
    mask: aiConfig.SECRET_MASK,
    // The last realistic probe, if one has run in this process. A failed one
    // is what turns the card's pill red; the result never carries the key.
    last_probe: ai.lastProbe(),
    whatsapp: await whatsappLine.line(),
  };
}

platformRouter.get("/settings", asyncHandler(async (req, res) => {
  ok(res, await aiSettingsPayload());
}));

platformRouter.put("/settings", asyncHandler(async (req, res) => {
  const b = req.body || {};
  const provider = b.provider === undefined ? undefined : cleanStr(b.provider, 40).toLowerCase();
  if (provider !== undefined && !aiConfig.normalizeProvider(provider)) {
    return err(res, 400, "Choose a provider: openai, groq, openrouter, custom or none.");
  }
  let enabled = b.enabled === undefined
    ? undefined
    : !(b.enabled === false || b.enabled === 0 || b.enabled === "0" || b.enabled === "false" || b.enabled === "off");
  // Picking "none" is an explicit "no model": switch the assistant back to the
  // knowledge base rather than saving a configuration that claims to be on.
  if (provider === "none") enabled = false;

  const before = await aiConfig.resolve();
  // Switching the model on without a key/base URL would save a setting that
  // reads as "enabled" while the assistant silently stays on the knowledge
  // base. Refuse it with the reason instead.
  if (enabled === true) {
    const rawKey = String(b.api_key == null ? "" : b.api_key).trim();
    const hasKey = (rawKey && !aiConfig.isSecretMask(rawKey)) || before.keySet;
    const rawBase = b.base_url === undefined ? undefined : cleanStr(b.base_url, 500);
    const preset = aiConfig.PRESETS[aiConfig.normalizeProvider(provider) || before.provider] || aiConfig.PRESETS.custom;
    const hasBase = rawBase === undefined ? Boolean(before.baseUrl || preset.baseUrl) : Boolean(rawBase || preset.baseUrl);
    if (!hasKey || !hasBase) {
      return err(res, 400, "Add an API key and a base URL (or pick a provider preset) before switching the model on.");
    }
  }

  let resolved;
  try {
    resolved = await aiConfig.save({
      provider,
      baseUrl: b.base_url !== undefined ? b.base_url : b.baseUrl,
      model: b.model,
      apiKey: b.api_key !== undefined ? b.api_key : b.apiKey,
      enabled,
      clearApiKey: b.clear_api_key === true || b.clear_key === true,
    });
  } catch (e) {
    return err(res, e.status || 400, e.message || "Could not save the AI settings.");
  }

  // Audited WITHOUT the secret: provider, model and whether a key exists.
  logActivity(db, {
    userId: req.user.id, action: "platform.ai.provider", entity: "settings", ip: req.ip,
    meta: { provider: resolved.provider, model: resolved.model, enabled: resolved.enabled, key_set: resolved.keySet, source: resolved.source },
  });
  ok(res, await aiSettingsPayload());
}));

/**
 * POST /api/platform/ai/test — a probe against the values currently in the
 * form, saved or not. Rate-limited because it spends a real provider call.
 *
 * `mode`:
 *   "real" (default) — the same payload a live public turn sends: the public
 *      system prompt, a real knowledge block, the three public tool schemas,
 *      the same history cap and max_tokens 700. A green result HERE is
 *      evidence that /api/public/ai/chat will use the model.
 *   "small" — the historical 8-token one-liner. Kept because it is the fastest
 *      way to prove a key is accepted at all, but it can pass while a real turn
 *      fails, so it is no longer the default and must never be presented as
 *      "the assistant works".
 *
 * A provider refusal is a 200 with ok:false, the provider's own scrubbed
 * message and its HTTP status, so "invalid key" / "429" is diagnosable.
 */
platformRouter.post("/test", aiTestLimiter, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const current = await aiConfig.resolve();
  const provider = aiConfig.normalizeProvider(b.provider) || current.provider || "custom";
  const preset = aiConfig.PRESETS[provider] || aiConfig.PRESETS.custom;
  const mode = String(b.mode || "real").trim().toLowerCase() === "small" ? "small" : "real";

  const submittedBase = String(b.base_url !== undefined ? b.base_url : (b.baseUrl || "")).trim();
  let baseUrl = current.baseUrl || preset.baseUrl || "";
  if (submittedBase) {
    const checked = aiConfig.validateBaseUrl(submittedBase);
    if (!checked.ok) return err(res, 400, checked.error);
    baseUrl = checked.value;
  }

  const submittedKey = String(b.api_key !== undefined ? b.api_key : (b.apiKey || "")).trim();
  const apiKey = submittedKey && !aiConfig.isSecretMask(submittedKey) ? submittedKey : current.apiKey;
  const model = cleanStr(b.model, 120) || preset.model || current.model || "";

  if (!baseUrl) return err(res, 400, "Add a base URL (or choose a provider) before testing.");
  if (!apiKey) return err(res, 400, "Add an API key before testing.");
  if (!model) return err(res, 400, "Add a model name before testing.");

  // The values typed into the form, exercised without saving them.
  const config = { enabled: true, apiKey, baseUrl, model, provider };
  // Only a probe of the LIVE configuration updates the card's "last real
  // probe". Testing an unsaved key or URL must not claim the saved one failed.
  const testsLiveConfig = apiKey === current.apiKey &&
    baseUrl === (current.baseUrl || "") &&
    model === (current.model || "") &&
    provider === current.provider;

  if (mode === "real") {
    const out = await ai.probe({
      surface: "public",
      tools: publicTools(),
      hits: await probeKnowledge(),
      history: PROBE_HISTORY,
      context: { today: todayIso() },
      config,
      timeoutMs: 20000,
      record: testsLiveConfig,
    });
    return ok(res, {
      ok: out.ok,
      mode: "real",
      latencyMs: out.latencyMs,
      // The model the provider reports when it answers, otherwise the one asked
      // for — the same contract the tiny probe always had.
      model: out.model || model,
      httpStatus: out.httpStatus,
      error: out.error,
      tokens: out.tokens,
      request: out.request,
    });
  }

  const started = Date.now();
  try {
    const data = await ai.chatCompletion(
      {
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 8,
        temperature: 0,
      },
      { config, timeoutMs: 15000 }
    );
    ok(res, {
      ok: true,
      mode: "small",
      latencyMs: Date.now() - started,
      model: (data && data.model) || model,
      httpStatus: 200,
      error: null,
    });
  } catch (e) {
    ok(res, {
      ok: false,
      mode: "small",
      latencyMs: Date.now() - started,
      model,
      httpStatus: providerHttpStatus(e),
      error: String((e && e.message) || "The provider refused the request."),
    });
  }
}));

/**
 * GET /api/platform/ai/diagnose — why does the assistant fall back?
 *
 * Reads the resolved configuration (which layer supplied each field), then
 * sends the REALISTIC public turn once and reports the provider's answer
 * verbatim: `{ ok, latencyMs, httpStatus, error, mode, tokens }` plus the size
 * of what was sent. Behind requireSuperAdmin (the whole platformRouter is).
 * The API key is never returned, in any field.
 */
platformRouter.get("/diagnose", aiTestLimiter, asyncHandler(async (req, res) => {
  const resolved = await aiConfig.resolve();
  const summary = {
    enabled: resolved.enabled,
    provider: resolved.provider,
    model: resolved.model,
    base_url: resolved.baseUrl,
    source: resolved.source,
    key_set: resolved.keySet,
    key_last4: resolved.keyLast4,
    origins: resolved.origins,
    locked: resolved.locked,
  };

  const hits = await probeKnowledge();
  const out = await ai.probe({
    surface: "public",
    tools: publicTools(),
    hits,
    history: PROBE_HISTORY,
    context: { today: todayIso() },
    config: resolved,
    timeoutMs: 20000,
  });

  ok(res, {
    ok: out.ok,
    resolved: summary,
    surface: "public",
    mode: out.mode,
    latencyMs: out.latencyMs,
    httpStatus: out.httpStatus,
    error: out.error,
    tokens: out.tokens,
    request: out.request,
    knowledge_entries: hits.length,
    // The last result any real probe produced, so the dashboard can explain a
    // failure without spending another provider call.
    last_probe: ai.lastProbe(),
  });
}));

/** The spaces, in the operator's language, with real counts. This is what the
    knowledge editor renders as its scope picker and help panel. */
platformRouter.get("/spaces", asyncHandler(async (req, res) => {
  const modelCfg = await aiConfig.resolve();
  const stats = await ai.knowledgeStats();
  const byScope = new Map(stats.map((s) => [s.scope, s]));
  const out = Object.keys(spaces.SPACES).map((key) => {
    const space = spaces.spaceOf(key);
    const stat = byScope.get(key) || { total: 0, active: 0 };
    return {
      key,
      label: space.label,
      subtitle: space.subtitle,
      audience: space.audience,
      scopes: space.scopes,
      suggestions: space.suggestions,
      capabilities: space.capabilities,
      answers: stat.total,
      active_answers: stat.active,
      handoff: space.handoff,
    };
  });
  const all = byScope.get("all") || { total: 0, active: 0 };
  ok(res, {
    spaces: out,
    everywhere: { scope: "all", label: "Everywhere", answers: all.total, active_answers: all.active },
    live: modelCfg.enabled,
    source: modelCfg.source,
    model: modelCfg.enabled ? modelCfg.model : "",
    whatsapp: await whatsappLine.line(),
    scopes: spaces.ALL_SCOPES,
  });
}));

platformRouter.get("/knowledge", asyncHandler(async (req, res) => {
  const modelCfg = await aiConfig.resolve();
  const scope = cleanStr(req.query.scope, 20);
  const rows = scope && scope !== "all"
    ? await db.all("SELECT * FROM ai_knowledge WHERE scope = ? ORDER BY sort_order, id", [scope])
    : await db.all("SELECT * FROM ai_knowledge ORDER BY scope, sort_order, id");
  ok(res, { entries: rows, live: modelCfg.enabled, source: modelCfg.source, model: modelCfg.enabled ? modelCfg.model : "" });
}));

function validScope(value) {
  const scope = cleanStr(value, 20);
  return spaces.ALL_SCOPES.includes(scope) ? scope : null;
}

platformRouter.post("/knowledge", asyncHandler(async (req, res) => {
  const b = req.body || {};
  const question = cleanStr(b.question, 255);
  const answer = cleanStr(b.answer, 8000);
  if (!question || !answer) return err(res, 400, "A question and an answer are required.");
  const scope = validScope(b.scope) || "public";
  const r = await db.run(
    "INSERT INTO ai_knowledge (scope, topic, question, answer, keywords, sort_order) VALUES (?,?,?,?,?,?)",
    [scope, cleanStr(b.topic, 80), question, answer, cleanStr(b.keywords, 500), toNum(b.sort_order, 99)]
  );
  ok(res, { ok: true, id: r.lastInsertRowid, scope });
}));

platformRouter.patch("/knowledge/:id", asyncHandler(async (req, res) => {
  const id = toNum(req.params.id, 0);
  if (!await db.get("SELECT id FROM ai_knowledge WHERE id = ?", [id])) return err(res, 404, "Entry not found.");
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.scope !== undefined) {
    const scope = validScope(b.scope);
    if (!scope) return err(res, 400, "Unknown scope.");
    sets.push("scope = ?"); vals.push(scope);
  }
  for (const [f, max] of [["topic", 80], ["question", 255], ["keywords", 500]]) {
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
  ok(res, { conversations: rows, surfaces: Object.keys(spaces.SPACES) });
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
