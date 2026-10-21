"use strict";
/* ============================================================================
   SUBSCRIPTIONS & BILLING — shared service
   ----------------------------------------------------------------------------
   One place that answers "what is this institution entitled to, and until
   when?". It owns:

     • the effective status (active / grace / expired / suspended) derived from
       plan_expires_at + grace_ends_at, never from a stale column alone,
     • usage against the plan's student/teacher limits,
     • FEATURE ENTITLEMENTS — which catalogue keys this plan carries, the
       `checkFeature()` gate every premium route uses, and the upgrade offer
       that goes back with a refusal,
     • the invoice lifecycle (request → proof → operator approval → period
       extension),
     • the warning sweep that messages an institution before it hits a wall.

   It is deliberately payment-provider agnostic. Phase 1 is bank transfer with
   operator approval; when a gateway is enabled later the SAME rows are marked
   paid by a webhook, and nothing in this file has to change.

   Nothing here trusts a tenant id from the client: every function takes the
   madrasa id the ROUTE resolved from the authenticated session.
   ========================================================================== */
const db = require("../db");
const communication = require("./communication");
const catalogue = require("./plan-catalogue");
const { cleanStr, toNum, logActivity } = require("../util");

/* ------------------------------ constants -------------------------------- */

const STATUSES = new Set(["active", "grace", "expired", "suspended"]);
const CYCLES = { monthly: { days: 30, label: "monthly" }, yearly: { days: 365, label: "yearly" } };
const INVOICE_STATUSES = new Set(["pending", "awaiting_approval", "paid", "rejected", "cancelled"]);

const SETTING_DEFAULTS = {
  billing_bank_name: "",
  billing_account_number: "",
  billing_account_name: "",
  billing_transfer_note: "Use your institution name as the transfer reference.",
  billing_contact_email: "",
  billing_contact_phone: "",
  billing_currency: "NGN",
  billing_grace_days: "14",
  billing_warn_percent: "80",
  billing_enabled: "1",
  whatsapp_ai_number: "",
  whatsapp_ai_message: "",
};

/* ------------------------------ date helpers ----------------------------- */

function today() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(iso, days) {
  const d = iso ? new Date(iso + "T00:00:00Z") : new Date();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function daysBetween(fromIso, toIso) {
  const a = new Date((fromIso || today()) + "T00:00:00Z").getTime();
  const b = new Date(toIso + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}
function isoOrNull(v) {
  return v ? String(v).slice(0, 10) : null;
}

/* ------------------------------ settings --------------------------------- */

async function getSettings() {
  let rows = [];
  try {
    rows = await db.all("SELECT key_name, value FROM platform_settings");
  } catch (e) {
    rows = [];
  }
  const out = Object.assign({}, SETTING_DEFAULTS);
  for (const r of rows || []) if (r.key_name in out) out[r.key_name] = r.value == null ? "" : String(r.value);
  out.billing_grace_days = Math.max(0, toNum(out.billing_grace_days, 14));
  out.billing_warn_percent = Math.min(100, Math.max(1, toNum(out.billing_warn_percent, 80)));
  out.billing_enabled = !(out.billing_enabled === "0" || out.billing_enabled === "false");
  return out;
}

async function setSetting(key, value) {
  const dialect = await db.dialect();
  if (dialect === "sqlite") {
    await db.run(
      `INSERT INTO platform_settings (key_name, value) VALUES (?, ?)
       ON CONFLICT(key_name) DO UPDATE SET value = excluded.value`,
      [key, String(value)]
    );
  } else {
    await db.run(
      "INSERT INTO platform_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [key, String(value)]
    );
  }
}

/* ------------------------------ core reads ------------------------------- */

async function tenantRow(madrasaId) {
  return db.get(
    `SELECT m.id, m.name_en, m.slug, m.plan_id, m.status, m.billing_cycle,
            m.plan_starts_at, m.plan_expires_at, m.grace_ends_at,
            m.subscription_status, m.billing_reference,
            p.code AS plan_code, p.name AS plan_name, p.name_ar AS plan_name_ar,
            p.price_ngn, p.price_yearly_ngn, p.student_limit, p.teacher_limit,
            p.features, p.trial_days, p.description
       FROM madaris m LEFT JOIN plans p ON p.id = m.plan_id
      WHERE m.id = ?`,
    [madrasaId]
  );
}

async function usage(madrasaId) {
  const [students, teachers] = await Promise.all([
    db.get("SELECT COUNT(*) AS n FROM students WHERE madrasa_id = ? AND status IN ('active','promoted','suspended')", [madrasaId]),
    db.get("SELECT COUNT(*) AS n FROM users WHERE madrasa_id = ? AND role = 'teacher' AND is_active = 1", [madrasaId]),
  ]);
  return { students: Number((students && students.n) || 0), teachers: Number((teachers && teachers.n) || 0) };
}

/** The status that APPLIES NOW, derived from the dates (a stored status can be
    stale the moment a date passes — midnight is not a request we can serve). */
function effectiveStatus(row, settings) {
  if (!row) return "active";
  const stored = String(row.subscription_status || "active");
  if (stored === "suspended") return "suspended";
  const expires = isoOrNull(row.plan_expires_at);
  if (!expires) return stored === "expired" ? "active" : stored; // never billed yet → treated as active
  const todayIso = today();
  if (todayIso <= expires) return "active";
  const graceEnd = isoOrNull(row.grace_ends_at);
  if (graceEnd && todayIso <= graceEnd) return "grace";
  return "expired";
}

function limitsOf(row) {
  return {
    students: row ? Number(row.student_limit) : -1,
    teachers: row ? Number(row.teacher_limit) : -1,
  };
}

function metricFor(kind, count, limit, warnPercent) {
  const unlimited = limit < 0;
  const pct = unlimited || limit === 0 ? 0 : Math.round((count / limit) * 100);
  return {
    kind,
    count,
    limit,                       // -1 = unlimited
    unlimited,
    remaining: unlimited ? null : Math.max(0, limit - count),
    percent: pct,
    state: unlimited || pct < warnPercent ? "ok" : pct < 100 ? "warning" : "full",
  };
}

/* ------------------------------ summary ---------------------------------- */

async function summary(madrasaId) {
  const settings = await getSettings();
  const row = await tenantRow(madrasaId);
  if (!row) return null;
  const used = await usage(madrasaId);
  const limits = limitsOf(row);
  const status = effectiveStatus(row, settings);
  const expires = isoOrNull(row.plan_expires_at);
  const graceEnd = isoOrNull(row.grace_ends_at);
  let features = {};
  try { features = JSON.parse(row.features || "{}"); } catch (e) { features = {}; }

  // A suspended/expired institution still reads its data; only writes are
  // gated. `blocks` tells the UI which write actions will be refused.
  const blocks = status === "suspended" || status === "expired";

  // The offer (marketing copy + normalised entitlements) is computed from the
  // shared catalogue so this payload, the pricing page and the upsell modal all
  // describe the same product.
  const offer = catalogue.offerFor({
    id: row.plan_id, code: row.plan_code, name: row.plan_name, name_ar: row.plan_name_ar,
    description: row.description, price_ngn: row.price_ngn, price_yearly_ngn: row.price_yearly_ngn,
    trial_days: row.trial_days, student_limit: limits.students, teacher_limit: limits.teachers,
    features: row.features,
  });
  const entitled = catalogue.entitlements(offer.features, row.plan_code);

  return {
    madrasa: { id: row.id, name: row.name_en, slug: row.slug, status: row.status },
    plan: {
      id: row.plan_id,
      code: row.plan_code,
      name: row.plan_name,
      name_ar: row.plan_name_ar,
      description: row.description || "",
      price_monthly_ngn: Number(row.price_ngn || 0),
      price_yearly_ngn: Number(row.price_yearly_ngn || 0),
      trial_days: Number(row.trial_days || 0),
      features: offer.features,
      student_limit: limits.students,
      teacher_limit: limits.teachers,
      // What this plan GETS a school, in the words the pricing page uses.
      offer,
    },
    entitlements: entitled,
    subscription: {
      status,
      billing_cycle: String(row.billing_cycle || "yearly"),
      starts_at: isoOrNull(row.plan_starts_at),
      expires_at: expires,
      grace_ends_at: graceEnd,
      days_remaining: expires ? daysBetween(today(), expires) : null,
      grace_days_remaining: graceEnd ? daysBetween(today(), graceEnd) : null,
      billing_reference: row.billing_reference || "",
      blocks_writes: blocks,
    },
    usage: {
      students: metricFor("student", used.students, limits.students, settings.billing_warn_percent),
      teachers: metricFor("teacher", used.teachers, limits.teachers, settings.billing_warn_percent),
    },
    warn_percent: settings.billing_warn_percent,
    billing_enabled: settings.billing_enabled,
  };
}

/* --------------------------- capacity / gating --------------------------- */

/**
 * The gate every "create" route must pass.
 * Returns { allowed, reason, message, ...metric }. `reason` is one of:
 *   "ok" | "limit" | "expired" | "suspended"
 */
async function capacity(madrasaId, kind) {
  const settings = await getSettings();
  const row = await tenantRow(madrasaId);
  if (!row) return { allowed: true, reason: "ok" };
  const status = effectiveStatus(row, settings);

  if (status === "suspended") {
    return {
      allowed: false, reason: "suspended",
      message: "This institution's subscription is suspended. Please settle the outstanding subscription to continue adding records.",
    };
  }
  if (status === "expired") {
    return {
      allowed: false, reason: "expired",
      message: "Your subscription has expired. Renew it from Subscription → Plans to continue adding records.",
    };
  }

  const used = await usage(madrasaId);
  const limits = limitsOf(row);
  const metric = metricFor(kind === "student" ? "student" : "teacher",
    kind === "student" ? used.students : used.teachers,
    kind === "student" ? limits.students : limits.teachers,
    settings.billing_warn_percent);

  if (!metric.unlimited && metric.count >= metric.limit) {
    return {
      allowed: false, reason: "limit", metric,
      limit: metric.limit, count: metric.count,
      message: `Plan limit reached: your ${row.plan_name || row.plan_code} plan allows ${metric.limit} ${metric.kind}(s) and you have ${metric.count}. Upgrade your plan to add more.`,
    };
  }
  return { allowed: true, reason: "ok", metric };
}

/* --------------------------- feature entitlements ------------------------ */

/**
 * The normalised entitlement map for one institution: every catalogue key set
 * to true/false, with legacy `plans.features` rows filled from their tier
 * defaults. `null` when the institution does not exist.
 */
async function featureSet(madrasaId) {
  const id = Number(madrasaId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await tenantRow(id);
  if (!row) return null;
  const offer = catalogue.offerFor(row);
  return {
    madrasa_id: id,
    plan: { id: row.plan_id, code: row.plan_code, name: row.plan_name || row.plan_code || "" },
    status: effectiveStatus(row),
    features: offer.features,
    offer,
    entitlements: catalogue.entitlements(offer.features, row.plan_code),
  };
}

/** Grouped "what your plan includes / what the next tier unlocks" for the UI. */
async function entitlements(madrasaId) {
  const set = await featureSet(madrasaId);
  return set ? set.entitlements : null;
}

/**
 * THE FEATURE GATE.
 *
 * Answers "may this institution use `key`?" — the companion to `capacity()`,
 * which answers "may it add another student?". Same rules about trust: the
 * madrasa id always comes from the route's authenticated session, never from
 * the client, and the plan is read fresh (a stored status column can be stale
 * the moment a date passes).
 *
 * Order of precedence, deliberately identical to `capacity()` so a school that
 * is suspended or expired gets the SAME answer it has always got:
 *   1. suspended → refused (operator action, nothing else matters)
 *   2. expired   → refused (renew)
 *   3. feature   → refused with an upgrade hint naming the tier that has it
 *   4. otherwise → allowed
 *
 * Two cases fail OPEN on purpose, and both are documented here rather than
 * hidden in a catch block:
 *   • no tenant / no plan row (platform operator, or a pre-plans database) —
 *     there is nothing to bill and no tier to compare against;
 *   • `billing_enabled = 0`, the operator's master switch for enforcement.
 * An UNKNOWN feature key also fails open (with `reason: "unknown_feature"`):
 * gating is a commercial control, not a security one — roles and tenant
 * isolation are — and a typo in a route must not lock a school out of a module
 * it has paid for.
 *
 * @returns {{allowed:boolean, reason:string, key:string, feature?:object,
 *            plan?:object, required_plan?:object, message?:string, hint?:string,
 *            upgrade?:object}}
 */
async function checkFeature(madrasaId, key, preloaded = {}) {
  const id = Number(madrasaId);
  const featureKey = String(key || "");
  if (!Number.isInteger(id) || id <= 0) {
    return { allowed: true, reason: "no_tenant", key: featureKey };
  }
  const row = preloaded.row !== undefined ? preloaded.row : await tenantRow(id);
  if (!row) return { allowed: true, reason: "no_tenant", key: featureKey };

  const settings = preloaded.settings || (await getSettings());
  const status = effectiveStatus(row, settings);
  const planCode = String(row.plan_code || "");
  const planName = row.plan_name || planCode || "your plan";
  const planInfo = { id: row.plan_id, code: planCode, name: planName };

  if (status === "suspended") {
    return {
      allowed: false, reason: "suspended", key: featureKey, plan: planInfo,
      message: "This institution's subscription is suspended. Please settle the outstanding subscription to continue.",
    };
  }
  if (status === "expired") {
    return {
      allowed: false, reason: "expired", key: featureKey, plan: planInfo,
      message: "Your subscription has expired. Renew it from Subscription → Plans to continue using this feature.",
    };
  }
  if (!settings.billing_enabled) {
    return { allowed: true, reason: "enforcement_disabled", key: featureKey, plan: planInfo };
  }
  if (!catalogue.isKnownFeature(featureKey)) {
    return { allowed: true, reason: "unknown_feature", key: featureKey, plan: planInfo };
  }

  const features = catalogue.normalizeFeatures(row.features, planCode);
  if (features[featureKey]) {
    return { allowed: true, reason: "ok", key: featureKey, plan: planInfo, feature: catalogue.featureMeta(featureKey) };
  }

  const gate = catalogue.gatePayload(featureKey, planCode, planName);
  const target = catalogue.upgradeTierFor(planCode, featureKey);
  return Object.assign({ allowed: false, reason: "feature", key: featureKey, plan: planInfo }, gate, {
    // Everything the upsell UI needs to render a real offer, plus the CTA an
    // administrator can actually click. Teachers/students/parents see the same
    // explanation without a button they are not allowed to press.
    upgrade: target
      ? {
          required_plan_code: target.code,
          required_plan_name: target.name,
          tagline: target.tagline,
          quick_win: target.quick_win,
          headline: target.headline,
          benefit_groups: target.benefit_groups,
          route: "subscription/plans",
          api: "/api/subscription/plans",
        }
      : null,
  });
}

/**
 * Convenience wrapper for routes that resolve their own tenant: returns the
 * gate result, or `null` when the caller should simply continue.
 */
async function assertFeature(res, madrasaId, key, extra = {}) {
  const gate = await checkFeature(madrasaId, key);
  if (gate.allowed) return gate;
  res.status(403).json(Object.assign({ error: gate.message }, gate, extra));
  return null;
}

/* ------------------------------ warnings --------------------------------- */

async function alreadyNoticed(madrasaId, key) {
  const r = await db.get("SELECT id FROM subscription_notices WHERE madrasa_id = ? AND notice_key = ?", [madrasaId, key]);
  return Boolean(r);
}
async function markNoticed(madrasaId, key) {
  try {
    await db.run("INSERT INTO subscription_notices (madrasa_id, notice_key) VALUES (?, ?)", [madrasaId, key]);
  } catch (e) { /* unique violation = already sent, which is the point */ }
}
async function adminUserIds(madrasaId) {
  const rows = await db.all("SELECT id FROM users WHERE madrasa_id = ? AND role = 'madrasa_admin' AND is_active = 1", [madrasaId]);
  return rows.map((r) => r.id);
}
async function notifyAdmins(madrasaId, payload) {
  const ids = await adminUserIds(madrasaId);
  if (!ids.length) return 0;
  await communication.createNotifications(madrasaId, ids, payload);
  return ids.length;
}

/**
 * Sends the "you are approaching / past your limit" and "renewal is due"
 * messages. Idempotent: each notice is recorded once per (key) so a busy
 * dashboard never spams the same school.
 */
async function sweep(madrasaId) {
  const settings = await getSettings();
  if (!settings.billing_enabled) return { sent: [] };
  const row = await tenantRow(madrasaId);
  if (!row) return { sent: [] };

  const sent = [];
  const used = await usage(madrasaId);
  const limits = limitsOf(row);

  for (const kind of ["student", "teacher"]) {
    const limit = kind === "student" ? limits.students : limits.teachers;
    const count = kind === "student" ? used.students : used.teachers;
    if (limit < 0) continue; // unlimited
    const pct = limit === 0 ? 100 : Math.round((count / limit) * 100);
    if (pct >= 100) {
      const key = `limit:${kind}:full:${limit}`;
      if (!await alreadyNoticed(madrasaId, key)) {
        await notifyAdmins(madrasaId, {
          type: "subscription_limit",
          title: `${kind === "student" ? "Student" : "Teacher"} limit reached`,
          body: `You have reached your plan limit of ${limit} ${kind}(s) on the ${row.plan_name || row.plan_code} plan. Upgrade your subscription to add more — existing records are unaffected.`,
          entity_type: "subscription", entity_id: row.id,
        });
        await markNoticed(madrasaId, key);
        sent.push(key);
      }
    } else if (pct >= settings.billing_warn_percent) {
      const key = `limit:${kind}:warn:${limit}:${settings.billing_warn_percent}`;
      if (!await alreadyNoticed(madrasaId, key)) {
        await notifyAdmins(madrasaId, {
          type: "subscription_limit",
          title: `You are at ${pct}% of your ${kind} limit`,
          body: `${count} of ${limit} ${kind}(s) used on the ${row.plan_name || row.plan_code} plan. Consider upgrading before you reach the limit.`,
          entity_type: "subscription", entity_id: row.id,
        });
        await markNoticed(madrasaId, key);
        sent.push(key);
      }
    }
  }

  // Renewal reminders.
  const expires = isoOrNull(row.plan_expires_at);
  if (expires) {
    const days = daysBetween(today(), expires);
    for (const threshold of [30, 14, 7, 1]) {
      if (days > threshold || days < 0) continue;
      const key = `renewal:${threshold}:${expires}`;
      if (await alreadyNoticed(madrasaId, key)) continue;
      await notifyAdmins(madrasaId, {
        type: "subscription_renewal",
        title: days <= 0 ? "Your subscription expires today" : `Your subscription expires in ${days} day${days === 1 ? "" : "s"}`,
        body: `The ${row.plan_name || row.plan_code} plan for this institution ends on ${expires}. Renew from Subscription → Plans to avoid interruption.`,
        entity_type: "subscription", entity_id: row.id,
      });
      await markNoticed(madrasaId, key);
      sent.push(key);
      break; // one reminder per sweep is plenty
    }
  }
  return { sent };
}

/** Clears the warning de-duplication rows after a plan change, so a school
    that upgrades (and later downgrades) is warned again for the new limit. */
async function clearNotices(madrasaId, prefix) {
  if (prefix) await db.run("DELETE FROM subscription_notices WHERE madrasa_id = ? AND notice_key LIKE ?", [madrasaId, prefix + "%"]);
  else await db.run("DELETE FROM subscription_notices WHERE madrasa_id = ?", [madrasaId]);
}

/* ------------------------------ invoices --------------------------------- */

function invoiceNo(id) {
  return `SUB-${new Date().getUTCFullYear()}-${String(id).padStart(5, "0")}`;
}

async function plansForUpgrade() {
  const rows = await db.all(
    "SELECT id, code, name, name_ar, description, price_ngn, price_yearly_ngn, student_limit, teacher_limit, features, trial_days, sort_order FROM plans WHERE is_active = 1 AND is_public = 1 ORDER BY sort_order, price_ngn"
  );
  return rows.map((p) => {
    // The offer carries the normalised feature map, the tier marketing copy and
    // the rendered benefit list, so the pricing page never hard-codes a tier.
    const offer = catalogue.offerFor(p);
    return Object.assign({}, p, {
      features: offer.features,
      offer,
      price_ngn: Number(p.price_ngn || 0),
      price_yearly_ngn: Number(p.price_yearly_ngn || 0),
    });
  });
}

function cyclePrice(plan, cycle) {
  const yearly = Number(plan.price_yearly_ngn || 0);
  const monthly = Number(plan.price_ngn || 0);
  if (cycle === "yearly") return yearly > 0 ? yearly : monthly * 12;
  return monthly;
}

/**
 * Creates a renewal/upgrade request. Deliberately does NOT touch the plan: an
 * institution asking for an upgrade is not yet entitled to it.
 */
async function requestUpgrade(madrasaId, { planId, cycle, method, note, userId }) {
  const plan = await db.get("SELECT * FROM plans WHERE id = ? AND is_active = 1", [planId]);
  if (!plan) throw Object.assign(new Error("That plan is not available."), { status: 404 });
  const billingCycle = CYCLES[cycle] ? cycle : "yearly";
  const amount = cyclePrice(plan, billingCycle);
  const settings = await getSettings();

  // One open request at a time: a pile of duplicate invoices is exactly the
  // mess an approval queue must not have.
  const open = await db.get(
    "SELECT id, invoice_no FROM subscription_invoices WHERE madrasa_id = ? AND status IN ('pending','awaiting_approval') ORDER BY id DESC",
    [madrasaId]
  );
  if (open) {
    return { invoice: await db.get("SELECT * FROM subscription_invoices WHERE id = ?", [open.id]), already_open: true, settings };
  }

  const row = await tenantRow(madrasaId);
  const todayIso = today();
  // Continue from the CURRENT end date when it is still in the future, so an
  // early renewal never loses paid days.
  const from = row && isoOrNull(row.plan_expires_at) && isoOrNull(row.plan_expires_at) >= todayIso ? isoOrNull(row.plan_expires_at) : todayIso;
  const periodEnd = addDays(from, CYCLES[billingCycle].days);

  const reference = `ES${row ? row.id : 0}-${Date.now().toString(36).toUpperCase()}`;
  const r = await db.run(
    `INSERT INTO subscription_invoices
       (madrasa_id, plan_id, invoice_no, amount_ngn, billing_cycle, period_start, period_end,
        status, payment_method, reference, payer_note, requested_by, created_at, updated_at)
     VALUES (?,?,'',?,?,?,?, 'pending',?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [madrasaId, plan.id, amount, billingCycle, from, periodEnd,
      method === "card" ? "card" : "bank_transfer", reference, cleanStr(note, 2000), userId || null]
  );
  const id = r.lastInsertRowid;
  // Two separate statements on purpose: the invoice number belongs to
  // subscription_invoices, the payment reference is echoed onto the tenant so
  // the operator can match an incoming transfer to it.
  await db.run("UPDATE subscription_invoices SET invoice_no = ?, reference = ? WHERE id = ?", [invoiceNo(id), reference, id]);
  await db.run("UPDATE madaris SET billing_reference = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [reference, madrasaId]);

  logActivity(db, { madrasaId, userId: userId || null, action: "subscription.request", entity: "subscription_invoice", entityId: String(id), meta: { plan: plan.code, cycle: billingCycle, amount } });
  return { invoice: await db.get("SELECT * FROM subscription_invoices WHERE id = ?", [id]), already_open: false, settings };
}

async function listInvoices(madrasaId, limit = 50) {
  return db.all(
    `SELECT i.*, p.name AS plan_name, p.code AS plan_code
       FROM subscription_invoices i LEFT JOIN plans p ON p.id = i.plan_id
      WHERE i.madrasa_id = ?
      ORDER BY i.id DESC LIMIT ?`,
    [madrasaId, limit]
  );
}

async function getInvoice(id) {
  return db.get(
    `SELECT i.*, p.name AS plan_name, p.code AS plan_code, m.name_en AS madrasa_name, m.slug
       FROM subscription_invoices i
       LEFT JOIN plans p ON p.id = i.plan_id
       LEFT JOIN madaris m ON m.id = i.madrasa_id
      WHERE i.id = ?`,
    [id]
  );
}

/**
 * Applies a paid period. The single place that extends entitlement.
 * `actorId` is the operator who approved (null for an automated webhook).
 */
async function activate(invoiceId, actorId, adminNote) {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw Object.assign(new Error("Invoice not found."), { status: 404 });
  if (!["pending", "awaiting_approval"].includes(inv.status)) {
    throw Object.assign(new Error(`This invoice is already ${inv.status}.`), { status: 409 });
  }
  const now = today();
  const from = inv.period_start && inv.period_start > now ? inv.period_start : now;
  const periodEnd = inv.period_end && inv.period_end > from ? inv.period_end : addDays(from, CYCLES[inv.billing_cycle] ? CYCLES[inv.billing_cycle].days : 365);

  await db.run(
    `UPDATE madaris
        SET plan_id = ?, billing_cycle = ?, plan_starts_at = COALESCE(plan_starts_at, ?),
            plan_expires_at = ?, grace_ends_at = NULL, subscription_status = 'active',
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [inv.plan_id, inv.billing_cycle, from, periodEnd, inv.madrasa_id]
  );
  await db.run(
    "UPDATE subscription_invoices SET status = 'paid', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [actorId || null, cleanStr(adminNote, 2000) || null, invoiceId]
  );
  // Warnings keyed to the old limit/expiry no longer apply.
  await clearNotices(inv.madrasa_id);
  logActivity(db, { madrasaId: inv.madrasa_id, userId: actorId || null, action: "subscription.activate", entity: "subscription_invoice", entityId: String(invoiceId), meta: { plan: inv.plan_code, cycle: inv.billing_cycle, amount: inv.amount_ngn, until: periodEnd } });

  await notifyAdmins(inv.madrasa_id, {
    type: "subscription_activated",
    title: "Subscription activated",
    body: `Your ${inv.plan_name || inv.plan_code} subscription is now active until ${periodEnd}. Thank you.`,
    entity_type: "subscription", entity_id: inv.madrasa_id,
  });
  return { invoice: await getInvoice(invoiceId), expires_at: periodEnd };
}

async function rejectInvoice(invoiceId, actorId, reason) {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw Object.assign(new Error("Invoice not found."), { status: 404 });
  if (!["pending", "awaiting_approval"].includes(inv.status)) {
    throw Object.assign(new Error(`This invoice is already ${inv.status}.`), { status: 409 });
  }
  await db.run(
    "UPDATE subscription_invoices SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [actorId || null, cleanStr(reason, 2000), invoiceId]
  );
  logActivity(db, { madrasaId: inv.madrasa_id, userId: actorId || null, action: "subscription.reject", entity: "subscription_invoice", entityId: String(invoiceId), meta: { reason: cleanStr(reason, 200) } });
  await notifyAdmins(inv.madrasa_id, {
    type: "subscription_rejected",
    title: "Payment could not be confirmed",
    body: reason
      ? `We could not confirm your payment for ${inv.invoice_no}. Reason: ${reason}`
      : `We could not confirm your payment for ${inv.invoice_no}. Please contact EduSphere support.`,
    entity_type: "subscription", entity_id: inv.madrasa_id,
  });
  return getInvoice(invoiceId);
}

/** Operator-side manual grant: comped accounts, trials, offline deals. */
async function grant(madrasaId, { planId, cycle, months, note, actorId }) {
  const plan = await db.get("SELECT id FROM plans WHERE id = ?", [planId]);
  if (!plan) throw Object.assign(new Error("Unknown plan."), { status: 400 });
  const row = await tenantRow(madrasaId);
  if (!row) throw Object.assign(new Error("Institution not found."), { status: 404 });
  const billingCycle = CYCLES[cycle] ? cycle : String(row.billing_cycle || "yearly");
  const now = today();
  const from = row.plan_expires_at && row.plan_expires_at > now ? row.plan_expires_at : now;
  const periodEnd = addDays(from, months ? Math.round(Number(months) * 30.44) : CYCLES[billingCycle].days);

  await db.run(
    `UPDATE madaris SET plan_id = ?, billing_cycle = ?, plan_starts_at = COALESCE(plan_starts_at, ?),
       plan_expires_at = ?, grace_ends_at = NULL, subscription_status = 'active', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [planId, billingCycle, from, periodEnd, madrasaId]
  );
  await clearNotices(madrasaId);
  logActivity(db, { madrasaId, userId: actorId || null, action: "subscription.grant", entity: "madrasa", entityId: String(madrasaId), meta: { plan_id: planId, cycle: billingCycle, until: periodEnd, note: cleanStr(note, 200) } });
  return summary(madrasaId);
}

async function setStatus(madrasaId, status, actorId, note) {
  if (!STATUSES.has(status)) throw Object.assign(new Error("Unknown subscription status."), { status: 400 });
  const settings = await getSettings();
  const graceDays = Number(settings.billing_grace_days || 14);
  if (status === "grace") {
    const row = await tenantRow(madrasaId);
    const expires = isoOrNull(row && row.plan_expires_at) || today();
    await db.run(
      "UPDATE madaris SET subscription_status = 'grace', grace_ends_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [addDays(expires, graceDays), madrasaId]
    );
  } else {
    await db.run(
      "UPDATE madaris SET subscription_status = ?, grace_ends_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [status, madrasaId]
    );
  }
  await clearNotices(madrasaId);
  logActivity(db, { madrasaId, userId: actorId || null, action: "subscription.status", entity: "madrasa", entityId: String(madrasaId), meta: { status, note: cleanStr(note, 200) } });
  return summary(madrasaId);
}

/* --------------------------- platform-wide views ------------------------- */

async function platformList() {
  const settings = await getSettings();
  const rows = await db.all(
    `SELECT m.id, m.name_en, m.slug, m.plan_id, m.status, m.billing_cycle,
            m.plan_starts_at, m.plan_expires_at, m.grace_ends_at, m.subscription_status,
            p.name AS plan_name, p.code AS plan_code, p.price_ngn, p.price_yearly_ngn,
            p.student_limit, p.teacher_limit,
            (SELECT COUNT(*) FROM students s WHERE s.madrasa_id = m.id AND s.status IN ('active','promoted','suspended')) AS students,
            (SELECT COUNT(*) FROM users u WHERE u.madrasa_id = m.id AND u.role = 'teacher' AND u.is_active = 1) AS teachers,
            (SELECT COUNT(*) FROM subscription_invoices i WHERE i.madrasa_id = m.id AND i.status IN ('pending','awaiting_approval')) AS open_invoices
       FROM madaris m LEFT JOIN plans p ON p.id = m.plan_id
      ORDER BY m.name_en`
  );
  return rows.map((r) => {
    const status = effectiveStatus(r, settings);
    return Object.assign({}, r, {
      effective_status: status,
      days_remaining: r.plan_expires_at ? daysBetween(today(), isoOrNull(r.plan_expires_at)) : null,
      students: Number(r.students || 0),
      teachers: Number(r.teachers || 0),
      open_invoices: Number(r.open_invoices || 0),
      over_limit: (Number(r.student_limit) >= 0 && Number(r.students) > Number(r.student_limit)) ||
                  (Number(r.teacher_limit) >= 0 && Number(r.teachers) > Number(r.teacher_limit)),
    });
  });
}

async function platformPending() {
  return db.all(
    `SELECT i.*, p.name AS plan_name, p.code AS plan_code, m.name_en AS madrasa_name, m.slug,
            u.full_name AS requested_by_name
       FROM subscription_invoices i
       LEFT JOIN plans p ON p.id = i.plan_id
       LEFT JOIN madaris m ON m.id = i.madrasa_id
       LEFT JOIN users u ON u.id = i.requested_by
      WHERE i.status IN ('pending','awaiting_approval')
      ORDER BY i.id ASC`
  );
}

async function platformStats() {
  const list = await platformList();
  const pending = await platformPending();
  const expiring = list.filter((r) => r.days_remaining !== null && r.days_remaining >= 0 && r.days_remaining <= 30);
  const byStatus = {};
  let mrr = 0;
  for (const r of list) {
    byStatus[r.effective_status] = (byStatus[r.effective_status] || 0) + 1;
    // Normalised to a monthly figure so yearly and monthly plans add up.
    const yearly = Number(r.price_yearly_ngn || 0);
    const monthly = Number(r.price_ngn || 0);
    mrr += r.billing_cycle === "yearly" ? (yearly || monthly * 12) / 12 : monthly;
  }
  return {
    institutions: list.length,
    byStatus,
    pendingApprovals: pending.length,
    pendingAmountNgn: pending.reduce((a, i) => a + Number(i.amount_ngn || 0), 0),
    expiringSoon: expiring.length,
    overLimit: list.filter((r) => r.over_limit).length,
    estimatedMrrNgn: Math.round(mrr),
  };
}

/** Moves past-due institutions into (and then out of) the grace period.
    Cheap and idempotent — safe to call on any request that reads billing. */
async function reconcile() {
  const settings = await getSettings();
  if (!settings.billing_enabled) return { changed: 0 };
  const graceDays = Number(settings.billing_grace_days || 14);
  const rows = await db.all(
    "SELECT id, plan_expires_at, grace_ends_at, subscription_status FROM madaris WHERE plan_expires_at IS NOT NULL AND subscription_status NOT IN ('suspended','expired')"
  );
  let changed = 0;
  const now = today();
  for (const r of rows) {
    const expires = isoOrNull(r.plan_expires_at);
    if (!expires || now <= expires) continue;
    const graceEnd = isoOrNull(r.grace_ends_at) || addDays(expires, graceDays);
    if (now <= graceEnd) {
      if (r.subscription_status !== "grace") { await db.run("UPDATE madaris SET subscription_status='grace', grace_ends_at=? WHERE id=?", [graceEnd, r.id]); changed++; }
    } else if (r.subscription_status !== "expired") {
      await db.run("UPDATE madaris SET subscription_status='expired' WHERE id=?", [r.id]);
      changed++;
      await notifyAdmins(r.id, {
        type: "subscription_expired",
        title: "Your subscription has expired",
        body: "The grace period has ended. Your data is safe and still readable; adding new records is paused until you renew.",
        entity_type: "subscription", entity_id: r.id,
      });
    }
  }
  return { changed };
}

module.exports = {
  STATUSES, CYCLES, INVOICE_STATUSES, SETTING_DEFAULTS,
  catalogue,
  getSettings, setSetting,
  summary, usage, capacity, sweep, reconcile,
  checkFeature, featureSet, entitlements, assertFeature,
  plansForUpgrade, cyclePrice, requestUpgrade, listInvoices, getInvoice,
  activate, rejectInvoice, grant, setStatus,
  platformList, platformPending, platformStats,
  today, addDays, daysBetween, isoOrNull,
};
