"use strict";
/* ============================================================================
   PLAN TIERS, FEATURE GATING & THE OFFER — tests
   ----------------------------------------------------------------------------
   Three properties are asserted here, because they are the ones that decide
   whether the tiers are real or decorative:

     • WHAT A TIER MEANS IS ONE SOURCE OF TRUTH — the catalogue that the seed
       writes, the middleware that refuses a request and the payload the pricing
       page renders all describe the same Free / Basic / Premium contents, and
       Premium is a strict superset of Basic, which is a strict superset of Free.
     • A GATED ACTION ANSWERS 403 WITH AN UPGRADE HINT — never a 404, never a
       silent success, never a dead-end error: the body carries the feature,
       the plan that includes it and the benefits of that plan, which is what
       public/js/api.js turns into the upsell dialog.
     • THE PLAN IS READ FROM THE SESSION'S TENANT — upgrading institution A
       unlocks A and leaves B exactly where it was, and an expired or suspended
       subscription still says "renew", not "upgrade".

   The fixture plan in test/helpers.js deliberately has every feature switched
   on so module tests can exercise their module; this file puts it back on the
   real Free tier before asserting anything.
   ========================================================================== */
const test = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
const catalogue = require("../server/services/plan-catalogue");

initEnv();

let ctx, admin, adminB, parent, teacher;

const freeId = () => ctx.db.get("SELECT id FROM plans WHERE code = 'free'").then((r) => Number(r.id));

/** Puts a madrasa on a plan code, creating the plan row from the catalogue. */
async function putOnPlan(madrasaId, code) {
  const id = await ensurePlanRow(code);
  await ctx.db.run("UPDATE madaris SET plan_id = ?, subscription_status = 'active', plan_expires_at = NULL, grace_ends_at = NULL WHERE id = ?", [id, madrasaId]);
  return id;
}

async function ensurePlanRow(code) {
  const row = await ctx.db.get("SELECT id FROM plans WHERE code = ?", [code]);
  if (row) return Number(row.id);
  const meta = catalogue.TIERS[code];
  const prices = { free: [0, 0], basic: [8000, 80000], premium: [20000, 200000] }[code];
  const limits = { free: [50, 3], basic: [300, 15], premium: [-1, -1] }[code];
  const r = await ctx.db.run(
    `INSERT INTO plans (code,name,name_ar,description,price_ngn,price_yearly_ngn,trial_days,student_limit,teacher_limit,features,sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [code, meta.name, meta.name_ar, meta.tagline, prices[0], prices[1], code === "free" ? 0 : 14,
     limits[0], limits[1], JSON.stringify(catalogue.featuresForTier(code)), catalogue.TIER_ORDER.indexOf(code) + 1]
  );
  return Number(r.lastInsertRowid);
}

/** Rewrites a plan's entitlements without touching its limits or pricing. */
async function setPlanFeatures(code, features) {
  await ctx.db.run("UPDATE plans SET features = ? WHERE code = ?", [JSON.stringify(features), code]);
}

test.before(async () => {
  ctx = await setup();
  admin = new Client(ctx.base); await admin.login("admin-a", PASSWORD);
  adminB = new Client(ctx.base); await adminB.login("admin-b", PASSWORD);
  parent = new Client(ctx.base); await parent.login("parent-a", PASSWORD);
  teacher = new Client(ctx.base); await teacher.login("teacher-a", PASSWORD);

  // The full catalogue exists from the start, exactly as the seed leaves a
  // fresh deployment: three plans, each carrying its tier's real feature map.
  await ensurePlanRow("basic");
  await ensurePlanRow("premium");
  await setPlanFeatures("free", catalogue.featuresForTier("free"));
  await setPlanFeatures("basic", catalogue.featuresForTier("basic"));
  await setPlanFeatures("premium", catalogue.featuresForTier("premium"));
  // Both tenants start on the REAL Free tier.
  await putOnPlan(ctx.madrasaA, "free");
  await putOnPlan(ctx.madrasaB, "free");
});
test.after(async () => { await ctx.close(); });

/* ============================================================================
   1. THE CATALOGUE — what each tier contains and what it promises
   ========================================================================== */

test("every feature key has a label, a group and a lowest tier", () => {
  assert.ok(catalogue.FEATURE_KEYS.length >= 30, "the catalogue carries the full feature list");
  for (const key of catalogue.FEATURE_KEYS) {
    const meta = catalogue.FEATURES[key];
    assert.ok(meta, `${key} is described`);
    assert.ok(meta.label && meta.label.length > 1, `${key} has a human label`);
    assert.ok(catalogue.FEATURE_GROUPS.some((g) => g.key === meta.group), `${key} belongs to a known group`);
    assert.ok(catalogue.TIER_ORDER.includes(meta.tier), `${key} names a real tier`);
    assert.ok(meta.blurb, `${key} explains itself`);
  }
});

test("tiers are strictly increasing: Free ⊂ Basic ⊂ Premium", () => {
  const free = new Set(catalogue.tierFeatureKeys("free"));
  const basic = new Set(catalogue.tierFeatureKeys("basic"));
  const premium = new Set(catalogue.tierFeatureKeys("premium"));

  assert.ok(free.size < basic.size && basic.size < premium.size, "each tier adds capability");
  assert.equal(premium.size, catalogue.FEATURE_KEYS.length, "Premium includes everything on offer");

  for (const key of free) assert.ok(basic.has(key), `Basic includes the Free feature ${key}`);
  for (const key of basic) assert.ok(premium.has(key), `Premium includes the Basic feature ${key}`);

  // The advertised split, so a copy change cannot quietly drop a selling point.
  assert.ok(free.has("attendance") && free.has("report_cards") && free.has("announcements"),
    "Free keeps the paperless basics");
  assert.ok(!free.has("fees") && !free.has("portals") && !free.has("messaging"),
    "Free does not include fees, portals or messaging");
  assert.ok(basic.has("fees") && basic.has("portals") && basic.has("messaging") && basic.has("exports"),
    "Basic adds fees, portals, messaging and exports");
  assert.ok(!basic.has("ai") && !basic.has("payroll") && !basic.has("online_exams"),
    "Basic stops short of AI, payroll and online exams");
  for (const key of ["ai_comments", "ai_questions", "ai_risk_alerts", "analytics_advanced", "online_exams",
                     "payroll", "expenses", "leave", "health", "id_cards", "certificates",
                     "branding_custom", "custom_domain", "admissions_portal", "multi_campus",
                     "api_access", "sso", "backups_restore", "priority_support"]) {
    assert.ok(premium.has(key), `Premium includes ${key}`);
  }
});

test("each tier states benefits, not only limits", () => {
  for (const code of catalogue.TIER_ORDER) {
    const tier = catalogue.TIERS[code];
    assert.ok(tier.tagline.length > 8, `${code} has a tagline`);
    assert.ok(tier.quick_win.length > 8, `${code} has a quick win`);
    assert.ok(Array.isArray(tier.headline) && tier.headline.length > 0, `${code} has upgrade headlines`);
    assert.ok(tier.benefit_groups.length > 0, `${code} lists benefit groups`);
    for (const group of tier.benefit_groups) {
      assert.ok(group.title, `${code}: every benefit group is titled`);
      assert.ok(group.items.length > 0, `${code}: every benefit group says what you GET`);
    }
  }
  // The copy the product brief specifies, verbatim.
  assert.equal(catalogue.TIERS.free.tagline, "Start running your school digitally");
  assert.equal(catalogue.TIERS.basic.tagline, "Everything a growing school needs");
  assert.equal(catalogue.TIERS.premium.tagline, "A modern, AI-powered school");
  assert.equal(catalogue.TIERS.premium.limits_copy.students, "Unlimited students");
  assert.equal(catalogue.TIERS.basic.limits_copy.students, "300 students");
});

test("offerFor() turns a raw plan row into the offer the UI renders", () => {
  const offer = catalogue.offerFor({
    id: 7, code: "premium", name: "Premium", description: "", price_ngn: 20000,
    price_yearly_ngn: 200000, student_limit: -1, teacher_limit: -1, trial_days: 14,
    features: "not-json-at-all",            // a corrupt cell must not break the page
  });
  assert.equal(offer.code, "premium");
  assert.equal(offer.known_tier, true);
  assert.equal(offer.limits.students, -1);
  assert.equal(offer.limits.students_copy, "Unlimited students");
  assert.equal(offer.price.yearly_saves_ngn, 20000 * 12 - 200000, "yearly is sold as a saving");
  assert.ok(offer.benefits.every((b) => b.key && b.label), "benefits are labelled features");
  assert.ok(offer.benefit_groups.length > 0, "benefits are grouped for the card");
  // A corrupt cell is repaired from the tier, never read as "everything off".
  assert.deepEqual(Object.keys(offer.features).sort(), catalogue.FEATURE_KEYS.slice().sort());
  assert.equal(offer.features.payroll, true);

  const custom = catalogue.offerFor({ id: 9, code: "partner", name: "Partner", features: '{"payroll": true}' });
  assert.equal(custom.known_tier, false, "an operator-defined plan is still renderable");
  assert.equal(custom.features.payroll, true);
  assert.equal(custom.features.library, false, "unknown tiers start with nothing switched on");
});

test("entitlements() splits what is included from what an upgrade would add", () => {
  const free = catalogue.entitlements(catalogue.featuresForTier("free"), "free");
  assert.equal(free.plan_code, "free");
  assert.ok(free.enabled_keys.includes("attendance"));
  assert.ok(free.locked_keys.includes("payroll") && free.locked_keys.includes("ai_comments"));
  assert.equal(free.next_tier.code, "basic", "the next step up from Free is Basic");
  assert.ok(free.next_tier.new_features.some((f) => f.key === "fees"), "it says what the upgrade adds");

  const premium = catalogue.entitlements(catalogue.featuresForTier("premium"), "premium");
  assert.deepEqual(premium.locked_keys, [], "Premium has nothing left to unlock");
  assert.equal(premium.next_tier, null);
});

/* ============================================================================
   2. THE PUBLIC OFFER — anonymous, tenant-free, and it sells
   ========================================================================== */

test("GET /api/public/plans is anonymous and describes all three tiers", async () => {
  const res = await new Client(ctx.base).req("GET", "/api/public/plans");
  assert.equal(res.status, 200, "no session needed to see the pricing page");

  const codes = res.data.plans.map((p) => p.code);
  assert.deepEqual(codes, catalogue.TIER_ORDER, "tiers are offered in order");

  for (const plan of res.data.plans) {
    assert.ok(plan.tagline && plan.promise, `${plan.code} leads with a promise`);
    assert.ok(plan.quick_win, `${plan.code} states its quick win`);
    assert.ok(plan.benefit_groups.length > 0, `${plan.code} lists what you GET`);
    assert.ok(plan.limits.students_copy && plan.limits.teachers_copy, `${plan.code} phrases limits as capacity`);
    assert.ok(Array.isArray(plan.included) && plan.included.length > 0, `${plan.code} lists included features`);
    assert.equal(plan.price.currency, "NGN");
  }

  const premium = res.data.plans.find((p) => p.code === "premium");
  assert.equal(premium.price.monthly_ngn, 20000);
  assert.equal(premium.price.yearly_saves_ngn, 40000, "the yearly saving is shown, not just the price");
  assert.ok(premium.included.some((f) => f.key === "ai_comments"), "AI copilot is advertised on Premium");

  // The comparison matrix is the "why upgrade" table.
  assert.equal(res.data.comparison.length, catalogue.FEATURE_KEYS.length);
  const payrollRow = res.data.comparison.find((r) => r.key === "payroll");
  assert.equal(payrollRow.free, false);
  assert.equal(payrollRow.basic, false);
  assert.equal(payrollRow.premium, true);
  assert.equal(payrollRow.required_plan, "premium");
  assert.ok(res.data.comparison.every((r) => r.premium === true), "Premium ticks every box");
  assert.ok(res.data.how_payment_works.length >= 3, "it explains how to pay");

  // Nothing about any institution may leak through a public endpoint.
  const raw = JSON.stringify(res.data);
  assert.ok(!/madrasa_id|madrasaId/.test(raw), "no tenant column names");
  assert.ok(!/Test Madrasa/.test(raw), "no institution data");
  assert.ok(!/"plan_id"|"student"|"madrasa"/i.test(raw), "no institution or plan-row identifiers");
});

test("GET /api/subscription/plans tells an admin what they have and what they are missing", async () => {
  await putOnPlan(ctx.madrasaA, "free");
  const res = await admin.req("GET", "/api/subscription/plans");
  assert.equal(res.status, 200);
  assert.equal(res.data.current_plan_code, "free", "the page knows the current tier");
  assert.ok(res.data.entitlements.locked_keys.includes("payroll"), "it names what is locked");
  assert.equal(res.data.entitlements.next_tier.code, "basic");
  for (const plan of res.data.plans) {
    assert.ok(plan.offer, `${plan.code} carries its offer copy`);
    assert.ok(plan.offer.benefit_groups.length > 0, `${plan.code} states its benefits`);
  }
});

/* ============================================================================
   3. THE GATE — 403 + upgrade hint, and only for what the plan lacks
   ========================================================================== */

/** Asserts the refusal contract every gated route shares. */
function assertGated(res, featureKey, requiredPlan) {
  assert.equal(res.status, 403, "a gated action is refused, not hidden");
  assert.equal(res.data.code, "feature_gated", "the body says why");
  assert.equal(res.data.feature.key, featureKey);
  assert.ok(res.data.feature.label, "the refusal names the feature in words");
  assert.equal(res.data.required_plan.code, requiredPlan);
  assert.match(res.data.error, new RegExp(requiredPlan, "i"), "the message names the plan that includes it");
  assert.ok(res.data.hint && res.data.hint.length > 10, "it hints at the upgrade");
  assert.equal(res.data.upgrade.route, "subscription/plans", "it points at the upgrade screen");
  assert.ok(res.data.upgrade.benefit_groups.length > 0, "it sells the upgrade, not just the block");
  assert.equal(res.data.upgrade.api, "/api/subscription/plans");
}

test("Free is refused on Basic and Premium routes, with the upgrade hint", async () => {
  await putOnPlan(ctx.madrasaA, "free");

  assertGated(await admin.api("POST", "/api/fees/payments", { student_id: ctx.studentA1, amount_ngn: 100 }), "fees", "basic");
  assertGated(await admin.req("GET", "/api/exports/students.csv"), "exports", "basic");
  assertGated(await parent.req("GET", "/api/portal/me"), "portals", "basic");
  assertGated(await admin.req("GET", "/api/academic/questions"), "question_bank", "premium");
  assertGated(await admin.req("GET", "/api/payroll/structures"), "payroll", "premium");
  assertGated(await admin.req("GET", "/api/madrasa/analytics/advanced"), "analytics_advanced", "premium");
  assertGated(await admin.api("POST", "/api/ai/copilot/report-comments", { class_id: ctx.classA1 }), "ai_comments", "premium");
  assertGated(await admin.req("GET", "/api/ai/copilot/at-risk"), "ai_risk_alerts", "premium");

  // A teacher is not the buyer: the refusal says so instead of dangling a CTA.
  const teacherGate = await teacher.req("GET", "/api/payroll/structures");
  assert.equal(teacherGate.status, 403);
  assert.equal(teacherGate.data.can_upgrade, false, "only an administrator is offered the upgrade");
});

test("Free keeps everything Free promises", async () => {
  await putOnPlan(ctx.madrasaA, "free");

  const attendance = await admin.req("GET", "/api/attendance/?classId=" + ctx.classA1);
  assert.notEqual(attendance.status, 403, "attendance tracking is a Free feature");

  const analytics = await admin.req("GET", "/api/madrasa/analytics");
  assert.notEqual(analytics.status, 403, "the core dashboard still works on Free");

  const students = await admin.req("GET", "/api/students");
  assert.notEqual(students.status, 403, "student records are a Free feature");

  // Reads are never gated by the fee plan flag: a school that downgrades must
  // still be able to see what parents already paid.
  const feesRead = await admin.req("GET", "/api/fees/payments");
  assert.notEqual(feesRead.status, 403, "the existing fee ledger stays readable");
});

test("the copilot index reports what this institution may use", async () => {
  await putOnPlan(ctx.madrasaA, "free");
  const free = await admin.req("GET", "/api/ai/copilot");
  assert.equal(free.status, 200, "the capability list itself is never gated");
  const caps = Object.fromEntries(free.data.capabilities.map((c) => [c.capability, c]));
  assert.ok(caps.report_comments && caps.questions && caps.risk_alerts && caps.analytics_qa, "all four are advertised");
  for (const cap of Object.values(caps)) {
    assert.equal(cap.entitled, false, `${cap.capability} is locked on Free`);
    assert.ok(cap.gate && cap.gate.required_plan.code === "premium", `${cap.capability} says what unlocks it`);
    assert.ok(cap.blurb, `${cap.capability} explains itself`);
  }

  await putOnPlan(ctx.madrasaA, "premium");
  const premium = await admin.req("GET", "/api/ai/copilot");
  for (const cap of premium.data.capabilities) {
    assert.equal(cap.entitled, true, `${cap.capability} unlocks on Premium`);
    assert.equal(cap.gate, null);
  }
  await putOnPlan(ctx.madrasaA, "free");
});

/* ============================================================================
   4. THE SERVICE — checkFeature() semantics
   ========================================================================== */

test("checkFeature() answers per key, and fails open on keys it does not know", async () => {
  const subscription = require("../server/services/subscription");
  await putOnPlan(ctx.madrasaA, "free");

  const denied = await subscription.checkFeature(ctx.madrasaA, "payroll");
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "feature");
  assert.equal(denied.code, "feature_gated");
  assert.equal(denied.required_plan.code, "premium");
  assert.ok(denied.upgrade.headline.length > 0, "the refusal carries the sales copy");

  const allowed = await subscription.checkFeature(ctx.madrasaA, "attendance");
  assert.equal(allowed.allowed, true, "Free may use what Free includes");
  assert.equal(allowed.reason, "ok");

  const unknown = await subscription.checkFeature(ctx.madrasaA, "time_machine");
  assert.equal(unknown.allowed, true, "an unregistered key must not lock a school out");
  assert.equal(unknown.reason, "unknown_feature");

  await putOnPlan(ctx.madrasaA, "premium");
  for (const key of catalogue.FEATURE_KEYS) {
    const gate = await subscription.checkFeature(ctx.madrasaA, key);
    assert.equal(gate.allowed, true, `Premium includes ${key}`);
  }
  await putOnPlan(ctx.madrasaA, "free");
});

test("a mid-tier plan the operator customised is respected exactly", async () => {
  const subscription = require("../server/services/subscription");
  await ensurePlanRow("basic");
  await setPlanFeatures("basic", Object.assign(catalogue.featuresForTier("basic"), { payroll: true, library: false }));
  await putOnPlan(ctx.madrasaA, "basic");

  assert.equal((await subscription.checkFeature(ctx.madrasaA, "payroll")).allowed, true, "an added key is honoured");
  assert.equal((await subscription.checkFeature(ctx.madrasaA, "library")).allowed, false, "a removed key is honoured");
  assert.equal((await subscription.checkFeature(ctx.madrasaA, "fees")).allowed, true, "Basic keeps fees");

  const gate = await admin.req("GET", "/api/payroll/structures");
  assert.notEqual(gate.status, 403, "the HTTP gate reads the same customised map");
  await putOnPlan(ctx.madrasaA, "free");
});

test("an expired or suspended subscription says renew, not upgrade", async () => {
  const subscription = require("../server/services/subscription");
  await putOnPlan(ctx.madrasaA, "premium");

  await ctx.db.run(
    "UPDATE madaris SET plan_expires_at = '2020-01-01', grace_ends_at = '2020-01-15', subscription_status = 'active' WHERE id = ?",
    [ctx.madrasaA]
  );
  const expired = await subscription.checkFeature(ctx.madrasaA, "payroll");
  assert.equal(expired.allowed, false);
  assert.equal(expired.reason, "expired", "expiry outranks the plan contents");
  assert.notEqual(expired.code, "feature_gated", "Premium never gets an upsell for a feature it already has");

  const blocked = await admin.req("GET", "/api/payroll/structures");
  assert.equal(blocked.status, 403);
  assert.notEqual(blocked.data.code, "feature_gated");
  assert.match(blocked.data.error, /expired|renew/i);

  await ctx.db.run(
    "UPDATE madaris SET plan_expires_at = NULL, grace_ends_at = NULL, subscription_status = 'suspended' WHERE id = ?",
    [ctx.madrasaA]
  );
  const suspended = await subscription.checkFeature(ctx.madrasaA, "payroll");
  assert.equal(suspended.allowed, false);
  assert.equal(suspended.reason, "suspended");

  await putOnPlan(ctx.madrasaA, "free");
});

test("enforcement can be switched off for the whole platform", async () => {
  const subscription = require("../server/services/subscription");
  await putOnPlan(ctx.madrasaA, "free");
  await subscription.setSetting("billing_enabled", "0");

  const gate = await subscription.checkFeature(ctx.madrasaA, "payroll");
  assert.equal(gate.allowed, true);
  assert.equal(gate.reason, "enforcement_disabled", "an operator can stop gating without editing plans");
  const res = await admin.req("GET", "/api/payroll/structures");
  assert.notEqual(res.status, 403);

  await subscription.setSetting("billing_enabled", "1");
  assert.equal((await subscription.checkFeature(ctx.madrasaA, "payroll")).allowed, false, "switching it back on re-gates");
});

/* ============================================================================
   5. UPGRADE + TENANT ISOLATION
   ========================================================================== */

test("upgrading unlocks the route immediately, and only for that institution", async () => {
  await putOnPlan(ctx.madrasaA, "free");
  await putOnPlan(ctx.madrasaB, "free");
  assert.equal((await admin.req("GET", "/api/payroll/structures")).status, 403);
  assert.equal((await adminB.req("GET", "/api/payroll/structures")).status, 403);

  await putOnPlan(ctx.madrasaA, "premium");

  const unlocked = await admin.req("GET", "/api/payroll/structures");
  assert.notEqual(unlocked.status, 403, "A can use payroll straight after the upgrade");
  const advanced = await admin.req("GET", "/api/madrasa/analytics/advanced");
  assert.equal(advanced.status, 200, "advanced analytics answers");
  assert.ok(advanced.data.analytics && Array.isArray(advanced.data.analytics.attendanceHeatmap), "with real advanced output");
  assert.ok(Array.isArray(advanced.data.analytics.insights), "and plain-language insights");

  const stillLocked = await adminB.req("GET", "/api/payroll/structures");
  assertGated(stillLocked, "payroll", "premium");
  assert.equal((await adminB.req("GET", "/api/madrasa/analytics/advanced")).status, 403, "B did not inherit A's plan");

  // A's premium data is A's alone.
  assert.equal(String(advanced.data.madrasaId), String(ctx.madrasaA));

  await putOnPlan(ctx.madrasaA, "free");
});

test("a plan row is never shared across tenants by accident", async () => {
  // Both institutions on the same plan ROW: the gate must still evaluate each
  // tenant separately (the plan is looked up through the madrasa, not the user).
  const id = await putOnPlan(ctx.madrasaA, "basic");
  await ctx.db.run("UPDATE madaris SET plan_id = ? WHERE id = ?", [id, ctx.madrasaB]);
  await setPlanFeatures("basic", catalogue.featuresForTier("basic"));

  assert.notEqual((await admin.req("GET", "/api/fees/items")).status, 403, "A on Basic may use fees");
  assert.notEqual((await adminB.req("GET", "/api/fees/items")).status, 403, "B on Basic may use fees");
  assertGated(await admin.req("GET", "/api/payroll/structures"), "payroll", "premium");
  assertGated(await adminB.req("GET", "/api/payroll/structures"), "payroll", "premium");

  await putOnPlan(ctx.madrasaA, "free");
  await putOnPlan(ctx.madrasaB, "free");
});

test("the copilot only ever answers for the caller's own institution", async () => {
  await putOnPlan(ctx.madrasaA, "premium");
  await putOnPlan(ctx.madrasaB, "premium");

  const risk = await admin.req("GET", "/api/ai/copilot/at-risk");
  assert.equal(risk.status, 200);
  assert.ok(Array.isArray(risk.data.students));
  for (const s of risk.data.students) {
    const row = await ctx.db.get("SELECT madrasa_id FROM students WHERE id = ?", [s.id]);
    assert.equal(Number(row.madrasa_id), Number(ctx.madrasaA), "no student from another school is named");
  }

  const comments = await admin.api("POST", "/api/ai/copilot/report-comments", { class_id: ctx.classA1 });
  assert.equal(comments.status, 200);
  assert.ok(comments.data.comments.every((c) => c.student_id), "each draft names a student");
  assert.ok(comments.data.grading && comments.data.grading.pass_mark, "graded against the school's own pass mark");

  const foreignClass = await admin.api("POST", "/api/ai/copilot/report-comments", { class_id: ctx.classB1 });
  assert.notEqual(foreignClass.status, 200, "another school's class is not drafted");

  await putOnPlan(ctx.madrasaA, "free");
  await putOnPlan(ctx.madrasaB, "free");
});

/* ============================================================================
   6. SEEDING — the catalogue reaches a database that predates it
   ========================================================================== */

test("seedPlans/syncPlanOffers fill the offer without undoing operator edits", async () => {
  const { syncPlanOffers } = require("../server/seed");

  // A plan row created before the offer existed: blank description, no yearly
  // price, and a features cell missing every new key.
  await ctx.db.run(
    "UPDATE plans SET description = '', price_yearly_ngn = 0, trial_days = 0, features = '{\"payroll\": false}' WHERE code = 'free'"
  );
  const first = await syncPlanOffers();
  assert.ok(first > 0, "the sync reports that it repaired rows");

  const free = await ctx.db.get("SELECT * FROM plans WHERE code = 'free'");
  const features = JSON.parse(free.features);
  assert.equal(features.attendance, true, "Free's own features were filled in");
  assert.equal(features.payroll, false, "a deliberate OFF stays OFF");
  assert.equal(free.description, catalogue.TIERS.free.tagline, "a blank tagline is filled from the catalogue");
  assert.equal(Number(free.student_limit), 50, "limits are left exactly as they were");

  const second = await syncPlanOffers();
  assert.equal(second, 0, "running it again changes nothing");

  await putOnPlan(ctx.madrasaA, "free");
  await putOnPlan(ctx.madrasaB, "free");
});

test("the AI knowledge base carries the tier answers and re-seeds idempotently", async () => {
  const ai = require("../server/services/ai");
  await ai.seedKnowledge();
  const afterFirst = await ctx.db.get("SELECT COUNT(*) AS n FROM ai_knowledge");

  const premiumAnswer = await ctx.db.get(
    "SELECT answer FROM ai_knowledge WHERE scope = 'public' AND LOWER(question) = ?",
    ["what is included in the premium plan?"]
  );
  assert.ok(premiumAnswer, "the assistant can answer what Premium includes");
  assert.match(premiumAnswer.answer, /AI copilot|Payroll/i, "the answer mentions real Premium benefits");
  assert.doesNotMatch(premiumAnswer.answer, /undefined|\[object Object\]/, "and is rendered, not dumped");

  const compare = await ctx.db.get(
    "SELECT answer FROM ai_knowledge WHERE scope = 'public' AND question LIKE '%difference between%plans%'"
  );
  assert.ok(compare, "it can also compare the tiers");

  const gated = await ctx.db.get(
    "SELECT answer FROM ai_knowledge WHERE scope = 'admin' AND question LIKE '%not included in my plan%'"
  );
  assert.ok(gated, "an in-app answer tells a blocked user what to do");

  // An operator edit must survive a re-seed, and no duplicates may appear.
  await ctx.db.run("UPDATE ai_knowledge SET answer = 'Edited by the operator.' WHERE scope = 'public' AND LOWER(question) = ?",
    ["what is included in the premium plan?"]);
  const inserted = await ai.seedKnowledge();
  assert.equal(inserted, 0, "nothing new to insert the second time");
  const afterSecond = await ctx.db.get("SELECT COUNT(*) AS n FROM ai_knowledge");
  assert.equal(Number(afterSecond.n), Number(afterFirst.n), "no duplicate answers");
  const kept = await ctx.db.get("SELECT answer FROM ai_knowledge WHERE scope = 'public' AND LOWER(question) = ?",
    ["what is included in the premium plan?"]);
  assert.equal(kept.answer, "Edited by the operator.", "operator edits are never overwritten");
});
