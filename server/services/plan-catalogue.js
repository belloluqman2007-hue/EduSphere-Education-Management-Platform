"use strict";
/* ============================================================================
   PLAN CATALOGUE — the single source of truth for what each tier MEANS
   ----------------------------------------------------------------------------
   Three things live here and nowhere else:

     1. FEATURE KEYS   every capability that can be switched on or off per plan
                       (`plans.features` JSON), with a human label, the group it
                       belongs to and the lowest tier that includes it.
     2. TIER CONTENTS  which keys Free / Basic / Premium carry. Free is minimal,
                       Basic is mid, Premium is everything.
     3. THE OFFER      the marketing copy for each tier — tagline, benefit
                       groups, the "quick win" and the headline a school sees
                       when it is asked to upgrade.

   WHY A SEPARATE MODULE
   The seed, the subscription service, the feature middleware, the API payloads
   and the dashboard UI must all describe the SAME tiers. When the copy lived in
   the seed and the limits lived in the UI, the two drifted. Everything below is
   data; the seed writes it into `plans`, the service reads it back, and the UI
   renders whatever the service returns — so a school is never promised
   something the server will not honour.

   COMPATIBILITY
   `plans.features` rows written before this catalogue exist (they hold four
   keys, or `{}`). `normalizeFeatures()` therefore fills any catalogue key that
   is MISSING from the stored JSON with the tier default, while an explicit
   value always wins — an operator who switched a feature on for one school
   keeps that decision.
   ========================================================================== */

/* ------------------------------ feature groups --------------------------- */
/* Order matters: it is the order the pricing page and the upsell modal use. */
const FEATURE_GROUPS = [
  { key: "core", title: "Core school operations", icon: "school" },
  { key: "money", title: "Fees & payments", icon: "money" },
  { key: "family", title: "Parents, portals & messaging", icon: "users" },
  { key: "ai", title: "AI copilot", icon: "spark" },
  { key: "insight", title: "Analytics & exports", icon: "chart" },
  { key: "exams", title: "Online exams", icon: "exam" },
  { key: "finance_hr", title: "Finance & HR", icon: "finance" },
  { key: "academics", title: "Academics & documents", icon: "document" },
  { key: "growth", title: "Branding & growth", icon: "building" },
  { key: "trust", title: "Trust & operations", icon: "shield" },
  { key: "support", title: "Support", icon: "support" },
];

/* ------------------------------ feature keys ----------------------------- */
/* `tier` is the LOWEST plan that includes the key. Anything above it inherits
   the key (Premium inherits everything), which is what makes the tiers
   monotonic — and what the tests assert. */
const FEATURE_DEFS = [
  /* ---- Free: the paperless basics ------------------------------------ */
  { key: "attendance", tier: "free", group: "core", label: "Attendance tracking", blurb: "Daily class register, late/absent/excused statuses and per-term rates — the paper register replaced." },
  { key: "student_records", tier: "free", group: "core", label: "Student & teacher records", blurb: "Admission numbers, profiles, classes, subjects and assignments for every student and teacher." },
  { key: "report_cards", tier: "free", group: "core", label: "Printable report cards", blurb: "CA + exam grading, positions and a print-ready report card for every student." },
  { key: "announcements", tier: "free", group: "core", label: "Announcements", blurb: "Publish notices to staff, students or parents from one place." },
  { key: "support_community", tier: "free", group: "support", label: "Community support", blurb: "Guides, the community forum and the EduSphere AI assistant for how-to answers." },

  /* ---- Basic: everything a growing school needs ----------------------- */
  { key: "fees", tier: "basic", group: "money", label: "Fees & payments", blurb: "Fee structures, invoices, receipts, part payments and online payment links for parents." },
  { key: "portals", tier: "basic", group: "family", label: "Student & parent portals", blurb: "Every family logs in to see results, attendance, fees and notices for their own children." },
  { key: "messaging", tier: "basic", group: "family", label: "Two-way messaging + delivery log", blurb: "Message parents and staff, thread replies and see exactly what was delivered to whom." },
  { key: "notifications_push", tier: "basic", group: "family", label: "Automatic notifications", blurb: "Results published, fees due, attendance alerts — sent without anybody remembering." },
  { key: "exports", tier: "basic", group: "insight", label: "Attendance analytics & exports", blurb: "Class/subject averages, pass rates and CSV exports of students, attendance and results." },
  { key: "library", tier: "basic", group: "academics", label: "Library & loans", blurb: "Catalogue, issue/return, overdue tracking and fines." },
  { key: "support_email", tier: "basic", group: "support", label: "Email support", blurb: "The EduSphere team answers by email and through Chat & Support." },

  /* ---- Premium: a modern, AI-powered school --------------------------- */
  { key: "ai", tier: "premium", group: "ai", label: "EduSphere AI copilot", blurb: "The assistant that knows your institution — usage, plan, invoices and how-to answers." },
  { key: "ai_comments", tier: "premium", group: "ai", label: "AI report comments", blurb: "Draft a term's worth of personalised report comments from real marks and attendance in seconds." },
  { key: "ai_risk_alerts", tier: "premium", group: "ai", label: "At-risk student alerts", blurb: "Students slipping on grades or attendance, ranked with the reason and a suggested next step." },
  { key: "ai_questions", tier: "premium", group: "ai", label: "AI exam question generation", blurb: "Generate draft questions for a subject, class and topic — ready to drop into the question bank." },
  { key: "analytics_advanced", tier: "premium", group: "insight", label: "Advanced analytics", blurb: "Attendance heatmaps, teacher performance, fee forecasting and attendance patterns — plus analytics Q&A." },
  { key: "exports_bulk", tier: "premium", group: "insight", label: "Bulk reports & audit exports", blurb: "Whole-class report sheets in one print run and machine-readable audit exports." },
  { key: "online_exams", tier: "premium", group: "exams", label: "Online exams", blurb: "Question randomisation, auto-grading of objective papers, instant results and exam analytics." },
  { key: "question_bank", tier: "premium", group: "exams", label: "Question bank", blurb: "A reusable, tagged bank of questions that feeds every online exam." },
  { key: "sms", tier: "premium", group: "family", label: "SMS alerts", blurb: "Bulk SMS to parents — fees due, results out, emergencies." },
  { key: "whatsapp", tier: "premium", group: "family", label: "WhatsApp alerts", blurb: "The same broadcasts on WhatsApp, where parents actually read them." },
  { key: "payroll", tier: "premium", group: "finance_hr", label: "Payroll", blurb: "Salary structures, pay periods, payslips and staff advances." },
  { key: "expenses", tier: "premium", group: "finance_hr", label: "Expenses & budgets", blurb: "Categories, approvals, receipts, budget allocation and financial reports." },
  { key: "leave", tier: "premium", group: "finance_hr", label: "Leave management", blurb: "Leave types, requests, approvals, balances and the staff calendar." },
  { key: "health", tier: "premium", group: "academics", label: "Health records", blurb: "Allergies, conditions, visits and vaccinations per student, with the allergy report." },
  { key: "id_cards", tier: "premium", group: "academics", label: "ID cards", blurb: "Server-rendered student and staff ID cards with QR verification." },
  { key: "certificates", tier: "premium", group: "academics", label: "Certificates", blurb: "Designed certificates in bulk, each with a public verification code." },
  { key: "custom_report_templates", tier: "premium", group: "academics", label: "Custom report templates", blurb: "Build your own report sheet — layout, colours, grading remarks and logo." },
  { key: "branding_custom", tier: "premium", group: "growth", label: "Theme builder & branding", blurb: "Your colours, fonts, header and homepage layout on your own school website." },
  { key: "custom_domain", tier: "premium", group: "growth", label: "Custom domain", blurb: "Serve your school website from www.yourschool.com." },
  { key: "admissions_portal", tier: "premium", group: "growth", label: "Admissions portal", blurb: "Online applications, requirements, pipeline and enrolment conversion." },
  { key: "multi_campus", tier: "premium", group: "growth", label: "Multi-campus", blurb: "Run several campuses under one institution with per-campus reporting." },
  { key: "sso", tier: "premium", group: "trust", label: "2FA / SSO", blurb: "Two-factor authentication and single sign-on for staff accounts." },
  { key: "backups_restore", tier: "premium", group: "trust", label: "Automated backups & restore", blurb: "Scheduled encrypted backups of your data with self-service restore." },
  { key: "api_access", tier: "premium", group: "trust", label: "API access", blurb: "Read and write your own data through the EduSphere API with issued keys." },
  { key: "priority_support", tier: "premium", group: "support", label: "Priority support + onboarding", blurb: "Urgent ticket routing, a named onboarding contact and data migration help." },
];

const FEATURES = {};
for (const def of FEATURE_DEFS) FEATURES[def.key] = Object.freeze(Object.assign({}, def));
const FEATURE_KEYS = Object.freeze(FEATURE_DEFS.map((d) => d.key));

/* --------------------------------- tiers --------------------------------- */

const TIER_ORDER = Object.freeze(["free", "basic", "premium"]);

const TIERS = {
  free: {
    code: "free",
    name: "Free",
    name_ar: "مجاني",
    tagline: "Start running your school digitally",
    promise: "The paperless basics, free forever — no card, no trial clock.",
    badge: "Free forever",
    quick_win: "Replace paper registers and manual report cards.",
    quick_win_detail: "Teachers mark attendance on a phone, report cards print themselves, and the office stops re-typing the same names every term.",
    benefit_groups: [
      {
        title: "Everything you need to go paperless",
        items: [
          "Attendance tracking that replaces the paper register",
          "Basic student & teacher records",
          "Printable report cards with CA + exam grading and positions",
          "Announcements for staff, students and parents",
          "Community support and the EduSphere AI how-to assistant",
        ],
      },
    ],
    limits_copy: { students: "50 students", teachers: "3 teachers" },
    headline: ["Attendance tracking", "Printable report cards", "Student & teacher records"],
  },
  basic: {
    code: "basic",
    name: "Basic",
    name_ar: "أساسي",
    tagline: "Everything a growing school needs",
    promise: "Fees, portals and messaging — the three things a growing school is asked for every week.",
    badge: "Most popular",
    quick_win: "Collect fees online and keep parents informed automatically.",
    quick_win_detail: "Invoices and receipts go out on their own, parents pay from the portal, and every family can see results, attendance and balances without a phone call to the office.",
    benefit_groups: [
      { title: "Everything in Free, plus", items: ["Unlimited announcements, records and printable report cards"] },
      {
        title: "Get paid on time",
        items: [
          "Fees & payments — invoices, receipts and online payments",
          "Part payments, balances and per-student fee history",
        ],
      },
      {
        title: "Keep parents informed",
        items: [
          "Student & parent portals (results, attendance, fees)",
          "Two-way messaging with a delivery log",
          "Automatic notifications when results or fees change",
        ],
      },
      {
        title: "See how the school is doing",
        items: [
          "Attendance analytics & CSV exports",
          "Basic analytics — class/subject averages and pass rates",
          "Standard report templates",
          "Library & loan tracking",
        ],
      },
      { title: "Support", items: ["Email support from the EduSphere team"] },
    ],
    limits_copy: { students: "300 students", teachers: "15 teachers" },
    headline: ["Fees & online payments", "Student & parent portals", "Messaging + delivery log"],
  },
  premium: {
    code: "premium",
    name: "Premium",
    name_ar: "مميز",
    tagline: "A modern, AI-powered school",
    promise: "Everything, unlimited — with the AI copilot, advanced analytics and the finance, HR and branding tools a large school runs on.",
    badge: "Everything included",
    quick_win: "Save teacher hours, boost parent satisfaction, and grow enrollment.",
    quick_win_detail: "Report comments draft themselves, at-risk students surface before they fail, exams grade online, and your school website, admissions and payroll all live in one place.",
    benefit_groups: [
      { title: "Everything in Basic, plus", items: ["Unlimited students & teachers", "Every module switched on"] },
      {
        title: "AI copilot",
        items: [
          "Auto report comments from real marks and attendance",
          "At-risk student alerts with suggested next steps",
          "Exam question generation into your question bank",
          "Analytics Q&A — ask your data questions in plain language",
        ],
      },
      {
        title: "Advanced analytics",
        items: [
          "Attendance heatmaps by class and weekday",
          "Teacher performance across classes and subjects",
          "Fee forecasting from your actual collection trend",
          "Attendance patterns and the at-risk watch list",
        ],
      },
      {
        title: "Online exams",
        items: ["Question randomisation", "Auto-grading and instant results", "Exam analytics per question and per class"],
      },
      {
        title: "Parent experience",
        items: ["Online fee payment and payment plans", "WhatsApp / SMS alerts", "PTM booking"],
      },
      {
        title: "Finance & HR",
        items: ["Payroll and payslips", "Expenses, budgets and financial reports", "Leave management"],
      },
      {
        title: "Branding & growth",
        items: ["Custom domain", "Theme builder", "Admissions portal", "Alumni", "Multi-campus"],
      },
      {
        title: "Academics",
        items: ["Custom report templates", "Bulk report sheets", "Behaviour ratings", "ID cards", "Health records", "Certificates"],
      },
      {
        title: "Trust & operations",
        items: ["Audit exports", "2FA / SSO", "Automated backups & restore", "API access", "Priority support + onboarding"],
      },
    ],
    limits_copy: { students: "Unlimited students", teachers: "Unlimited teachers" },
    headline: ["AI copilot", "Advanced analytics", "Online exams", "Payroll, expenses & leave"],
  },
};

/* ------------------------------ derived maps ----------------------------- */

/** Keys included in a tier = its own keys plus every lower tier's keys. */
function tierFeatureKeys(code) {
  const tier = String(code || "").toLowerCase();
  const idx = TIER_ORDER.indexOf(tier);
  if (idx < 0) return [];
  const allowed = TIER_ORDER.slice(0, idx + 1);
  return FEATURE_KEYS.filter((k) => allowed.includes(FEATURES[k].tier));
}

/** The `{ key: bool }` object stored in `plans.features` for a tier. */
function featuresForTier(code) {
  const out = {};
  const on = new Set(tierFeatureKeys(code));
  for (const key of FEATURE_KEYS) out[key] = on.has(key);
  return out;
}

function isKnownFeature(key) {
  return Object.prototype.hasOwnProperty.call(FEATURES, String(key || ""));
}

function featureMeta(key) {
  return FEATURES[String(key || "")] || null;
}

/** Lowest tier that includes a key, or null for an unknown key. */
function minimumTierFor(key) {
  const meta = featureMeta(key);
  return meta ? meta.tier : null;
}

/**
 * The tier a school on `currentCode` must move to in order to get `key`.
 * Returns null when the current tier already includes it (or the key is
 * unknown), so callers never build an "upgrade to where you already are" CTA.
 */
function upgradeTierFor(currentCode, key) {
  const meta = featureMeta(key);
  if (!meta) return null;
  const from = TIER_ORDER.indexOf(String(currentCode || "").toLowerCase());
  const need = TIER_ORDER.indexOf(meta.tier);
  if (need < 0) return null;
  if (from < 0) return TIERS[meta.tier];          // unknown/legacy plan code
  if (need <= from) return null;                   // already entitled
  return TIERS[TIER_ORDER[need]];
}

function parseFeatures(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

/**
 * Stored features + tier defaults for anything the row does not mention.
 * An explicit `false` is kept: an operator who turned a feature off for one
 * school made a decision, and a re-seed must not silently reverse it.
 */
function normalizeFeatures(raw, planCode) {
  const stored = parseFeatures(raw);
  const defaults = featuresForTier(planCode);
  const out = Object.assign({}, defaults);
  for (const [key, value] of Object.entries(stored)) out[key] = Boolean(value);
  return out;
}

/** True when a (possibly legacy) features object entitles a tenant to `key`. */
function isFeatureEnabled(features, key, planCode) {
  const normalised = normalizeFeatures(features, planCode);
  return Boolean(normalised[String(key)]);
}

/* --------------------------------- offers -------------------------------- */

function limitCopy(n, noun) {
  const v = Number(n);
  if (!Number.isFinite(v)) return `Unlimited ${noun}`;
  if (v < 0) return `Unlimited ${noun}`;
  return `${v.toLocaleString("en-NG")} ${noun}`;
}

/**
 * The full, renderable offer for one plan row: marketing copy from this
 * catalogue, prices and limits from the database (the operator owns those).
 */
function offerFor(plan) {
  const row = plan || {};
  const code = String(row.code || "").toLowerCase();
  const tier = TIERS[code] || null;
  const features = normalizeFeatures(row.features, code);
  const enabled = FEATURE_KEYS.filter((k) => features[k]);
  const students = Number(row.student_limit === undefined ? -1 : row.student_limit);
  const teachers = Number(row.teacher_limit === undefined ? -1 : row.teacher_limit);
  const monthly = Number(row.price_ngn || 0);
  const yearly = Number(row.price_yearly_ngn || 0) || (monthly > 0 ? monthly * 10 : 0);

  return {
    id: row.id === undefined ? null : Number(row.id),
    code: code || String(row.code || ""),
    name: row.name || (tier ? tier.name : String(row.code || "")),
    name_ar: row.name_ar || (tier ? tier.name_ar : ""),
    description: row.description || (tier ? tier.tagline : ""),
    known_tier: Boolean(tier),
    tagline: tier ? tier.tagline : (row.description || ""),
    promise: tier ? tier.promise : "",
    badge: tier ? tier.badge : "",
    quick_win: tier ? tier.quick_win : "",
    quick_win_detail: tier ? tier.quick_win_detail : "",
    benefit_groups: tier ? tier.benefit_groups : [],
    headline: tier ? tier.headline : [],
    limits: {
      students,
      teachers,
      students_copy: limitCopy(students, "students"),
      teachers_copy: limitCopy(teachers, "teachers"),
    },
    price: {
      monthly_ngn: monthly,
      yearly_ngn: yearly,
      currency: "NGN",
      yearly_saves_ngn: monthly > 0 ? Math.max(0, monthly * 12 - yearly) : 0,
    },
    trial_days: Number(row.trial_days || 0),
    features,
    feature_keys: enabled,
    benefits: enabled.map((k) => ({ key: k, label: FEATURES[k].label, group: FEATURES[k].group, blurb: FEATURES[k].blurb })),
    locked: FEATURE_KEYS.filter((k) => !features[k]).map((k) => ({
      key: k,
      label: FEATURES[k].label,
      group: FEATURES[k].group,
      blurb: FEATURES[k].blurb,
      required_plan: FEATURES[k].tier,
      required_plan_name: TIERS[FEATURES[k].tier] ? TIERS[FEATURES[k].tier].name : FEATURES[k].tier,
    })),
  };
}

/** Every published tier offer, in upgrade order — used by the marketing API. */
function offersFor(plans) {
  const rows = Array.isArray(plans) ? plans : [];
  const byCode = new Map(rows.map((p) => [String(p.code || "").toLowerCase(), p]));
  return TIER_ORDER.filter((code) => byCode.has(code)).map((code) => offerFor(byCode.get(code)));
}

/**
 * What a tenant has, grouped for the "What your plan includes" card, plus what
 * the next tier would unlock. `features` is the stored (possibly legacy) JSON.
 */
function entitlements(features, planCode) {
  const normalised = normalizeFeatures(features, planCode);
  const groups = [];
  for (const group of FEATURE_GROUPS) {
    const items = FEATURE_KEYS.filter((k) => FEATURES[k].group === group.key && normalised[k])
      .map((k) => ({ key: k, label: FEATURES[k].label, blurb: FEATURES[k].blurb }));
    if (items.length) groups.push({ key: group.key, title: group.title, icon: group.icon, items });
  }
  const lockedGroups = [];
  for (const group of FEATURE_GROUPS) {
    const items = FEATURE_KEYS.filter((k) => FEATURES[k].group === group.key && !normalised[k])
      .map((k) => ({
        key: k, label: FEATURES[k].label, blurb: FEATURES[k].blurb,
        required_plan: FEATURES[k].tier,
        required_plan_name: TIERS[FEATURES[k].tier] ? TIERS[FEATURES[k].tier].name : FEATURES[k].tier,
      }));
    if (items.length) lockedGroups.push({ key: group.key, title: group.title, icon: group.icon, items });
  }
  const idx = TIER_ORDER.indexOf(String(planCode || "").toLowerCase());
  const next = idx >= 0 && idx < TIER_ORDER.length - 1 ? TIERS[TIER_ORDER[idx + 1]] : null;
  return {
    plan_code: String(planCode || ""),
    enabled: groups,
    locked: lockedGroups,
    enabled_keys: FEATURE_KEYS.filter((k) => normalised[k]),
    locked_keys: FEATURE_KEYS.filter((k) => !normalised[k]),
    next_tier: next
      ? {
          code: next.code, name: next.name, tagline: next.tagline, quick_win: next.quick_win,
          headline: next.headline, benefit_groups: next.benefit_groups,
          new_features: tierFeatureKeys(next.code).filter((k) => !normalised[k])
            .map((k) => ({ key: k, label: FEATURES[k].label, blurb: FEATURES[k].blurb })),
        }
      : null,
  };
}

/**
 * The 403 payload a gated route sends: enough for the UI to render a real
 * upsell without another round trip, and enough for a human to understand why
 * the action was refused.
 */
function gatePayload(key, planCode, planName) {
  const meta = featureMeta(key);
  const target = upgradeTierFor(planCode, key);
  const group = meta ? FEATURE_GROUPS.find((g) => g.key === meta.group) : null;
  return {
    code: "feature_gated",
    feature: meta
      ? { key: meta.key, label: meta.label, group: meta.group, group_title: group ? group.title : "", blurb: meta.blurb, required_plan: meta.tier }
      : { key: String(key), label: String(key), group: "", group_title: "", blurb: "", required_plan: null },
    current_plan: { code: String(planCode || ""), name: planName || planCode || "" },
    required_plan: target
      ? {
          code: target.code, name: target.name, tagline: target.tagline, quick_win: target.quick_win,
          headline: target.headline, benefit_groups: target.benefit_groups,
        }
      : null,
    message: meta && target
      ? `${meta.label} is included in the ${target.name} plan — "${target.tagline}". Your ${planName || planCode} plan does not include it yet.`
      : `This action is not included in your ${planName || planCode} plan.`,
    hint: target
      ? `Upgrade to ${target.name} to unlock ${meta ? meta.label : "this feature"}: ${target.headline.join(", ")}.`
      : "",
    upgrade_route: "subscription/plans",
  };
}

module.exports = {
  FEATURE_GROUPS,
  FEATURES,
  FEATURE_KEYS,
  TIERS,
  TIER_ORDER,
  tierFeatureKeys,
  featuresForTier,
  isKnownFeature,
  featureMeta,
  minimumTierFor,
  upgradeTierFor,
  parseFeatures,
  normalizeFeatures,
  isFeatureEnabled,
  limitCopy,
  offerFor,
  offersFor,
  entitlements,
  gatePayload,
};
