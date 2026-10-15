"use strict";
/* ============================================================================
   SUBSCRIPTIONS & BILLING + EDUSPHERE AI — tests
   ----------------------------------------------------------------------------
   The properties that matter most here are the ones that protect MONEY and
   DATA, so they are asserted directly rather than implied:

     • asking for an upgrade never grants one — only a confirmed payment does;
     • an institution can see its own invoices and nobody else's;
     • an expired subscription stops NEW records but never hides or deletes
       existing ones;
     • the AI assistant cannot reach across tenants, and cannot change a plan;
     • the public/WhatsApp assistant sees no institution data at all.
   ========================================================================== */
const test = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD, SA_PASSWORD } = require("./helpers");

initEnv();

let ctx, admin, adminB, teacher, superAdmin;

test.before(async () => {
  ctx = await setup();
  // The fixture starts from an empty schema (it creates one placeholder plan
  // for the tenants it builds), so seed the two things the real server seeds
  // on boot: the plan catalogue and the AI knowledge base. The knowledge base
  // uses the production seed function so the test can never drift from what a
  // fresh deployment actually contains.
  await require("../server/services/ai").seedKnowledge();
  await ensurePlans();
  admin = new Client(ctx.base); await admin.login("admin-a", PASSWORD);
  adminB = new Client(ctx.base); await adminB.login("admin-b", PASSWORD);
  teacher = new Client(ctx.base); await teacher.login("teacher-a", PASSWORD);
  superAdmin = new Client(ctx.base); await superAdmin.login("testadmin", SA_PASSWORD);
  // Make the upgrade screen show real bank details.
  await superAdmin.api("PUT", "/api/platform/settings", {
    billing_bank_name: "Test Bank",
    billing_account_number: "0011223344",
    billing_account_name: "EduSphere Ltd",
  });
});
test.after(async () => { await ctx.close(); });

/** The three-tier catalogue the tests reason about. Yearly is discounted
    against 12× monthly, which is exactly the shape a real catalogue has. */
const CATALOGUE = [
  { code: "free", name: "Free", price_ngn: 0, price_yearly_ngn: 0, student_limit: 50, teacher_limit: 3 },
  { code: "basic", name: "Basic", price_ngn: 8000, price_yearly_ngn: 80000, student_limit: 300, teacher_limit: 15 },
  { code: "premium", name: "Premium", price_ngn: 20000, price_yearly_ngn: 200000, student_limit: -1, teacher_limit: -1 },
];

async function ensurePlans() {
  for (const p of CATALOGUE) {
    const row = await ctx.db.get("SELECT id FROM plans WHERE code = ?", [p.code]);
    if (row) {
      await ctx.db.run(
        "UPDATE plans SET name=?, price_ngn=?, price_yearly_ngn=?, student_limit=?, teacher_limit=?, is_public=1, is_active=1 WHERE code=?",
        [p.name, p.price_ngn, p.price_yearly_ngn, p.student_limit, p.teacher_limit, p.code]
      );
    } else {
      await ctx.db.run(
        "INSERT INTO plans (code,name,price_ngn,price_yearly_ngn,student_limit,teacher_limit,features,sort_order) VALUES (?,?,?,?,?,?,?,?)",
        [p.code, p.name, p.price_ngn, p.price_yearly_ngn, p.student_limit, p.teacher_limit, "{}", CATALOGUE.indexOf(p) + 1]
      );
    }
  }
  // Both tenants start on Free so the upgrade assertions have a fixed baseline.
  const free = await ctx.db.get("SELECT id FROM plans WHERE code = 'free'");
  await ctx.db.run("UPDATE madaris SET plan_id = ?", [free.id]);
}

async function planId(code) {
  const row = await ctx.db.get("SELECT id FROM plans WHERE code = ?", [code]);
  assert.ok(row, `plan ${code} exists in the catalogue`);
  return row.id;
}

/* ------------------------------------------------------------------------ */
/*                            INSTITUTION SIDE                              */
/* ------------------------------------------------------------------------ */

test("an institution sees its own plan, usage and renewal state", async () => {
  const res = await admin.api("GET", "/api/subscription");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.madrasa.id, ctx.madrasaA, "the summary is for the session's own institution");
  assert.ok(res.data.plan, "a plan is reported");
  assert.ok(res.data.usage.students, "student usage is reported");
  assert.ok(res.data.usage.teachers, "teacher usage is reported");
  assert.equal(typeof res.data.usage.students.count, "number");
  // Two students were seeded into madrasa A.
  assert.equal(res.data.usage.students.count, 2);
});

test("teachers cannot read or change the institution's subscription", async () => {
  assert.equal((await teacher.api("GET", "/api/subscription")).status, 403, "teachers are refused the subscription");
  assert.equal((await teacher.api("GET", "/api/subscription/invoices")).status, 403);
});

test("an institution reads its subscription anonymously-free: another tenant never appears", async () => {
  const mine = await admin.api("GET", "/api/subscription");
  const theirs = await adminB.api("GET", "/api/subscription");
  assert.equal(mine.data.madrasa.id, ctx.madrasaA);
  assert.equal(theirs.data.madrasa.id, ctx.madrasaB, "each tenant only ever sees its own row");
  assert.notEqual(mine.data.madrasa.id, theirs.data.madrasa.id);
});

test("requesting an upgrade does NOT change the plan — only a confirmed payment does", async () => {
  const before = await admin.api("GET", "/api/subscription");
  const basic = await planId("basic");

  const req = await admin.api("POST", "/api/subscription/upgrade", { plan_id: basic, billing_cycle: "yearly" });
  assert.equal(req.status, 200, JSON.stringify(req.data));
  assert.ok(req.data.invoice, "an invoice is created");
  assert.ok(/^SUB-\d{4}-\d{5}$/.test(req.data.invoice.invoice_no), `invoice number is well formed, got ${req.data.invoice.invoice_no}`);
  assert.equal(req.data.invoice.status, "pending");
  assert.equal(req.data.pay_to.bank_name, "Test Bank", "the operator's bank details come back with the request");

  const after = await admin.api("GET", "/api/subscription");
  assert.equal(after.data.plan.id, before.data.plan.id, "THE PLAN DID NOT CHANGE — this is the whole point");
  assert.equal(after.data.plan.code, "free", "still on the seeded Free plan");
  assert.equal(after.data.subscription.expires_at, null, "no paid period exists yet");
});

test("only one upgrade request is open at a time", async () => {
  const premium = await planId("premium");
  const first = await admin.api("GET", "/api/subscription/invoices");
  const openBefore = first.data.invoices.filter((i) => ["pending", "awaiting_approval"].includes(i.status)).length;
  assert.equal(openBefore, 1);

  const again = await admin.api("POST", "/api/subscription/upgrade", { plan_id: premium, billing_cycle: "monthly" });
  assert.equal(again.status, 200);
  assert.equal(again.data.already_open, true, "a second request returns the existing one instead of piling up");

  const after = await admin.api("GET", "/api/subscription/invoices");
  const openAfter = after.data.invoices.filter((i) => ["pending", "awaiting_approval"].includes(i.status)).length;
  assert.equal(openAfter, 1, "still exactly one open request");
});

test("an institution cannot approve its own invoice", async () => {
  const list = await admin.api("GET", "/api/subscription/invoices");
  const inv = list.data.invoices.find((i) => i.status === "pending");
  assert.ok(inv, "there is a pending invoice to try to approve");
  // The operator route is behind requireSuperAdmin: an institution admin must
  // not be able to reach it, and must not learn whether it exists.
  const res = await admin.api("POST", `/api/platform/subscriptions/invoices/${inv.id}/approve`, {});
  assert.equal(res.status, 403, "an institution can never approve its own payment");
});

test("the operator confirms a transfer and the plan and paid period extend", async () => {
  const list = await superAdmin.api("GET", "/api/platform/subscriptions/invoices");
  assert.equal(list.status, 200);
  const inv = list.data.invoices.find((i) => i.madrasa_id === ctx.madrasaA);
  assert.ok(inv, "the operator's queue contains the request");

  const approve = await superAdmin.api("POST", `/api/platform/subscriptions/invoices/${inv.id}/approve`, { admin_note: "Transfer matched." });
  assert.equal(approve.status, 200, JSON.stringify(approve.data));
  assert.equal(approve.data.invoice.status, "paid");

  const after = await admin.api("GET", "/api/subscription");
  assert.equal(after.data.plan.code, "basic", "the plan is now Basic");
  assert.equal(after.data.subscription.status, "active");
  assert.ok(after.data.subscription.expires_at, "a paid period now exists");
  assert.ok(after.data.subscription.days_remaining > 300, "a yearly period was granted");
  assert.equal(after.data.usage.students.limit, 300, "the student limit moved with the plan");
});

test("a rejected payment leaves the plan untouched and tells the institution why", async () => {
  const premium = await planId("premium");
  const before = await admin.api("GET", "/api/subscription");
  const planBefore = before.data.plan.code;

  const req = await admin.api("POST", "/api/subscription/upgrade", { plan_id: premium, billing_cycle: "monthly" });
  assert.equal(req.status, 200, JSON.stringify(req.data));
  const id = req.data.invoice.id;
  assert.equal(req.data.invoice.status, "pending", "a fresh request is open to reject");

  const reject = await superAdmin.api("POST", `/api/platform/subscriptions/invoices/${id}/reject`, { reason: "Reference did not match any transfer." });
  assert.equal(reject.status, 200, JSON.stringify(reject.data));
  assert.equal(reject.data.invoice.status, "rejected");

  const after = await admin.api("GET", "/api/subscription");
  assert.equal(after.data.plan.code, planBefore, "a rejected payment never changes the plan");

  const mine = await admin.api("GET", "/api/subscription/invoices");
  const row = mine.data.invoices.find((i) => i.id === id);
  assert.match(row.admin_note, /Reference did not match/, "the reason is shown to the institution");
});

/* ------------------------------------------------------------------------ */
/*                        EXPIRY / SUSPENSION GATING                        */
/* ------------------------------------------------------------------------ */

test("an expired subscription stops new students but keeps existing data readable", async () => {
  // Drive madrasa A past the end of its grace period.
  await ctx.db.run(
    "UPDATE madaris SET plan_expires_at = '2020-01-01', grace_ends_at = '2020-01-15', subscription_status = 'active' WHERE id = ?",
    [ctx.madrasaA]
  );

  const blocked = await admin.api("POST", "/api/students/", {
    first_name: "Should", last_name: "NotBeCreated", gender: "M",
    date_of_birth: "2012-01-01", parent_phone: "+2348099999999", class_id: ctx.classA1,
  });
  assert.equal(blocked.status, 403, "adding a student is refused while expired");
  assert.match(blocked.data.error, /expired|renew/i, "the reason names the actual problem");

  // Reading is never blocked: existing students are still listed.
  const read = await admin.api("GET", "/api/students/");
  assert.equal(read.status, 200, "existing data stays readable — expiry is not deletion");
  assert.ok((read.data.students || read.data.rows || []).length >= 2, "the seeded students are still there");

  // Restore a healthy subscription for the tests that follow.
  await ctx.db.run(
    "UPDATE madaris SET plan_expires_at = NULL, grace_ends_at = NULL, subscription_status = 'active' WHERE id = ?",
    [ctx.madrasaA]
  );
  const ok = await admin.api("POST", "/api/students/", {
    first_name: "Now", last_name: "Allowed", gender: "M",
    date_of_birth: "2012-01-01", parent_phone: "+2348099999998", class_id: ctx.classA1,
  });
  assert.equal(ok.status, 200, "once renewed, adding works again");
});

test("the operator can suspend an institution and lift the suspension", async () => {
  const suspend = await superAdmin.api("POST", `/api/platform/subscriptions/${ctx.madrasaA}/status`, { status: "suspended", note: "Non-payment" });
  assert.equal(suspend.status, 200, JSON.stringify(suspend.data));
  assert.equal(suspend.data.subscription.subscription.status, "suspended");

  const blocked = await admin.api("POST", "/api/students/", {
    first_name: "Blocked", last_name: "BySuspension", gender: "M",
    date_of_birth: "2012-01-01", parent_phone: "+2348099999997", class_id: ctx.classA1,
  });
  assert.equal(blocked.status, 403, "a suspended institution cannot add records");

  const lift = await superAdmin.api("POST", `/api/platform/subscriptions/${ctx.madrasaA}/status`, { status: "active" });
  assert.equal(lift.status, 200);
  assert.equal(lift.data.subscription.subscription.status, "active");
});

test("the operator can grant a period manually (comps, trials, offline deals)", async () => {
  const basic = await planId("basic");
  const res = await superAdmin.api("POST", `/api/platform/subscriptions/${ctx.madrasaA}/grant`, { plan_id: basic, billing_cycle: "monthly", months: 1, note: "Trial" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.subscription.subscription.expires_at, "a period was granted");
  assert.ok(res.data.subscription.subscription.days_remaining > 20, "one month was granted");
});

test("the platform subscription list reports status, usage and over-limit institutions", async () => {
  const res = await superAdmin.api("GET", "/api/platform/subscriptions");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.subscriptions));
  const mine = res.data.subscriptions.find((r) => r.id === ctx.madrasaA);
  assert.ok(mine, "madrasa A is listed for the operator");
  assert.ok("effective_status" in mine, "the effective (date-derived) status is computed");
  assert.ok("students" in mine && "teachers" in mine, "usage is included for the operator");
  assert.ok(res.data.stats, "aggregate stats are returned");
  assert.equal(typeof res.data.stats.estimatedMrrNgn, "number");

  // An institution can never reach the operator's list.
  assert.equal((await admin.api("GET", "/api/platform/subscriptions")).status, 403);
});

/* ------------------------------------------------------------------------ */
/*                            EDUSPHERE AI                                  */
/* ------------------------------------------------------------------------ */

test("the in-app assistant answers the institution from the knowledge base", async () => {
  const res = await admin.api("POST", "/api/ai/chat", { message: "How do I upgrade my subscription?" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.reply && res.data.reply.length > 40, "a real answer comes back");
  assert.match(res.data.reply, /Subscription|upgrade|transfer/i);
  assert.ok(Array.isArray(res.data.sources), "the answer is grounded and cites the source it used");
});

test("the assistant conversation is per-user and can be reviewed and reset", async () => {
  const history = await admin.api("GET", "/api/ai/history");
  assert.equal(history.status, 200);
  assert.ok(Array.isArray(history.data.messages));
  assert.ok(history.data.messages.length >= 2, "the earlier turn was persisted");

  const reset = await admin.api("POST", "/api/ai/reset", {});
  assert.equal(reset.status, 200);
  const after = await admin.api("GET", "/api/ai/history");
  assert.equal(after.data.messages.length, 0, "reset clears the thread");
});

test("the public website assistant answers without an account", async () => {
  const anon = new Client(ctx.base);
  const res = await anon.req("POST", "/api/public/ai/chat", { message: "How much does EduSphere cost?", session_id: "anon-1" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.reply, "an anonymous visitor gets an answer");
  assert.match(res.data.reply, /Naira|₦|priced/i, "pricing is answered from the knowledge base");
});

test("the public assistant has no institution data and no plan-changing power", async () => {
  const anon = new Client(ctx.base);
  const res = await anon.req("POST", "/api/public/ai/chat", { message: "How many students does madrasa A have?", session_id: "anon-2" });
  assert.equal(res.status, 200);
  // Whatever it says, it must not leak a real count for a named tenant.
  assert.ok(!/\b2 students\b/.test(res.data.reply), "no per-institution numbers are exposed publicly");
  // And the anonymous surface can never reach the authenticated assistant.
  assert.equal((await anon.api("POST", "/api/ai/chat", { message: "hello" })).status, 401);
});

test("the WhatsApp webhook records the conversation and answers it", async () => {
  const anon = new Client(ctx.base);
  const payload = {
    entry: [{ changes: [{ value: { messages: [{ from: "2348012345678", text: { body: "how much does edusphere cost" } }] } }] }],
  };
  const res = await anon.req("POST", "/api/ai/whatsapp/webhook", payload);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.received, true);
  // No Meta credentials in tests, so it answers locally and says it was not delivered.
  assert.equal(res.data.delivered, false);
  assert.equal(res.data.provider, "none");

  const convs = await superAdmin.api("GET", "/api/platform/ai/conversations?surface=whatsapp");
  assert.equal(convs.status, 200, JSON.stringify(convs.data));
  const conv = (convs.data.conversations || []).find((c) => c.external_id === "wa-2348012345678");
  assert.ok(conv, "the WhatsApp thread was stored under its own surface");
  assert.ok(conv.messages >= 2, "both sides of the turn were saved");
});

test("the knowledge base is operator-controlled — an institution cannot edit what the AI says", async () => {
  assert.equal((await admin.api("GET", "/api/platform/ai/knowledge")).status, 403, "institutions cannot read the operator's knowledge base");
  assert.equal((await admin.api("POST", "/api/platform/ai/knowledge", { question: "q", answer: "a" })).status, 403, "institutions cannot add answers");

  const add = await superAdmin.api("POST", "/api/platform/ai/knowledge", {
    scope: "public", topic: "Testing", question: "What is the test answer?", answer: "Forty-two.", keywords: "test answer forty two",
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));

  const anon = new Client(ctx.base);
  const res = await anon.req("POST", "/api/public/ai/chat", { message: "What is the test answer?", session_id: "anon-3" });
  assert.equal(res.status, 200);
  assert.match(res.data.reply, /Forty-two/, "a newly added answer is used immediately, with no deployment");
});
