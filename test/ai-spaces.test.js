"use strict";
/* ============================================================================
   EDUSPHERE AI — one assistant, seven spaces
   ----------------------------------------------------------------------------
   The property under test is the one that matters: the assistant in a space
   knows that space's job and ONLY that space's answers. A student must never
   be told how to upgrade the school's subscription, the public website must
   never read console content, and the WhatsApp line must answer from the
   public answers and offer a human.

   The suite also proves the two entry points the product needs:
     • the public website can hand a visitor straight to WhatsApp, and
     • the same assistant answers when they get there.
   ========================================================================== */
const test = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD, SA_PASSWORD } = require("./helpers");

initEnv();
process.env.WHATSAPP_AI_DISPLAY_NUMBER = "2348012345678";
process.env.WHATSAPP_AI_VERIFY_TOKEN = "verify-me";

const spaces = require("../server/services/ai-spaces");
const ai = require("../server/services/ai");

let ctx, admin, teacher, student, parent, superAdmin;

test.before(async () => {
  ctx = await setup();
  await ai.seedKnowledge();
  admin = new Client(ctx.base); await admin.login("admin-a", PASSWORD);
  teacher = new Client(ctx.base); await teacher.login("teacher-a", PASSWORD);
  student = new Client(ctx.base); await student.login("student-a1", PASSWORD);
  parent = new Client(ctx.base); await parent.login("parent-a", PASSWORD);
  superAdmin = new Client(ctx.base); await superAdmin.login("testadmin", SA_PASSWORD);
});
test.after(async () => { await ctx.close(); });

/* ------------------------------------------------------------------------ */
/* the space registry                                                        */
/* ------------------------------------------------------------------------ */

test("a role gets exactly one space, and an unknown role gets the public one", () => {
  assert.equal(spaces.surfaceForRole("super_admin"), "super_admin");
  assert.equal(spaces.surfaceForRole("madrasa_admin"), "admin");
  assert.equal(spaces.surfaceForRole("teacher"), "teacher");
  assert.equal(spaces.surfaceForRole("student"), "student");
  assert.equal(spaces.surfaceForRole("parent"), "parent");
  assert.equal(spaces.surfaceForRole(""), "public");
  assert.equal(spaces.surfaceForRole("something_else"), "public");
});

test("no space can read another space's private answers", () => {
  const publicScopes = spaces.scopesFor("public");
  assert.ok(publicScopes.includes("public"));
  for (const forbidden of ["admin", "app", "super_admin", "teacher", "student", "parent"]) {
    assert.ok(!publicScopes.includes(forbidden), `the public website must not read the ${forbidden} scope`);
  }

  const studentScopes = spaces.scopesFor("student");
  assert.ok(studentScopes.includes("student"));
  for (const forbidden of ["admin", "app", "super_admin", "teacher", "parent", "whatsapp"]) {
    assert.ok(!studentScopes.includes(forbidden), `the student portal must not read the ${forbidden} scope`);
  }

  const parentScopes = spaces.scopesFor("parent");
  assert.ok(parentScopes.includes("parent"));
  assert.ok(!parentScopes.includes("student"), "a parent's space is not the student's space");

  const adminScopes = spaces.scopesFor("admin");
  assert.ok(adminScopes.includes("admin"));
  assert.ok(!adminScopes.includes("super_admin"), "a school administrator cannot read the console's answers");

  const whatsappScopes = spaces.scopesFor("whatsapp");
  assert.ok(whatsappScopes.includes("whatsapp"));
  assert.ok(whatsappScopes.includes("public"), "the WhatsApp line answers public questions");
  assert.ok(!whatsappScopes.includes("admin"));

  // The old `app` scope is an alias of `admin`, never of a narrower space.
  assert.ok(adminScopes.includes("app"), "old rows keep working after the rename");
});

test("every space carries its own greeting, suggestions and capability list", () => {
  const keys = ["public", "super_admin", "admin", "teacher", "student", "parent", "whatsapp"];
  const greetings = new Set();
  for (const key of keys) {
    const space = spaces.spaceOf(key);
    assert.ok(space.greeting && space.greeting.length > 20, `${key} has a greeting`);
    assert.ok(Array.isArray(space.suggestions) && space.suggestions.length >= 4, `${key} has suggestions`);
    assert.ok(Array.isArray(space.capabilities) && space.capabilities.length >= 3, `${key} describes what it can do`);
    assert.ok(space.systemPrompt && space.systemPrompt.length > 200, `${key} has its own prompt`);
    greetings.add(space.greeting);
  }
  assert.equal(greetings.size, keys.length, "no two spaces open with the same words");
});

/* ------------------------------------------------------------------------ */
/* the server picks the space from the session                              */
/* ------------------------------------------------------------------------ */

test("each role's /api/ai/status reports that role's own space", async () => {
  const expected = [
    [superAdmin, "super_admin"],
    [admin, "admin"],
    [teacher, "teacher"],
    [student, "student"],
    [parent, "parent"],
  ];
  for (const [client, surface] of expected) {
    const res = await client.req("GET", "/api/ai/status");
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.surface, surface, `the server decided ${surface}`);
    assert.equal(res.data.space.key, surface);
    assert.ok(res.data.space.suggestions.length >= 4);
    assert.ok(Array.isArray(res.data.welcome.suggestions));
  }
});

test("an anonymous visitor cannot reach the signed-in assistant", async () => {
  const anon = new Client(ctx.base);
  assert.equal((await anon.req("GET", "/api/ai/status")).status, 401);
  assert.equal((await anon.api("POST", "/api/ai/chat", { message: "hello" })).status, 401);
});

/* ------------------------------------------------------------------------ */
/* the answers really differ per space                                      */
/* ------------------------------------------------------------------------ */

test("the administrator's assistant explains the upgrade; the student's does not", async () => {
  const adminRes = await admin.api("POST", "/api/ai/chat", { message: "How do I upgrade my subscription?" });
  assert.equal(adminRes.status, 200, JSON.stringify(adminRes.data));
  assert.match(adminRes.data.reply, /Subscription\s*→\s*Plans|payment reference|bank details/i);
  assert.equal(adminRes.data.surface, "admin");

  const studentRes = await student.api("POST", "/api/ai/chat", { message: "How do I upgrade my subscription?" });
  assert.equal(studentRes.status, 200, JSON.stringify(studentRes.data));
  assert.equal(studentRes.data.surface, "student");
  assert.doesNotMatch(studentRes.data.reply, /Subscription\s*→\s*Plans|payment reference|attach (a photo of )?your receipt/i,
    "a student is never given the school's billing instructions");
  assert.match(studentRes.data.reply, /results|attendance|fees|timetable/i, "they get their own space's menu instead");
});

test("the student's assistant knows the student space", async () => {
  const res = await student.api("POST", "/api/ai/chat", { message: "What were my last results?" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.surface, "student");
  assert.match(res.data.reply, /Results/i);
  assert.match(res.data.reply, /published|report card/i);
});

test("the parent's assistant knows the parent space", async () => {
  const res = await parent.api("POST", "/api/ai/chat", { message: "How do I pay school fees online?" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.surface, "parent");
  assert.match(res.data.reply, /Pay online|provider|receipt/i);
});

test("the teacher's assistant knows the teacher space", async () => {
  const res = await teacher.api("POST", "/api/ai/chat", { message: "How do I mark attendance?" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.surface, "teacher");
  assert.match(res.data.reply, /Attendance|register/i);
  assert.match(res.data.reply, /present|absent|late/i);
});

test("the operator's assistant knows the console, and is told what it cannot do", async () => {
  const res = await superAdmin.api("POST", "/api/ai/chat", { message: "How do I approve a school registration?" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.surface, "super_admin");
  assert.match(res.data.reply, /Registrations/i);
  assert.match(res.data.reply, /Approve/i);
});

test("a student and a parent have no AI copilot over school-wide data", async () => {
  assert.equal((await student.req("GET", "/api/ai/copilot")).status, 403);
  assert.equal((await parent.req("GET", "/api/ai/copilot")).status, 403);
  assert.equal((await teacher.req("GET", "/api/ai/copilot")).status, 403);
  const ok = await admin.req("GET", "/api/ai/copilot");
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(Array.isArray(ok.data.capabilities));
});

/* ------------------------------------------------------------------------ */
/* knowledge written for one space is invisible to the others               */
/* ------------------------------------------------------------------------ */

test("a space-specific answer is only ever used inside that space", async () => {
  const add = await superAdmin.api("POST", "/api/platform/ai/knowledge", {
    scope: "student",
    topic: "Testing",
    question: "What is the student-only secret?",
    answer: "STUDENT-ONLY-MARKER: ask the class teacher.",
    keywords: "student only secret marker",
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));

  const asStudent = await student.api("POST", "/api/ai/chat", { message: "What is the student-only secret?" });
  assert.equal(asStudent.status, 200, JSON.stringify(asStudent.data));
  assert.match(asStudent.data.reply, /STUDENT-ONLY-MARKER/);

  const asPublic = new Client(ctx.base);
  const publicRes = await asPublic.req("POST", "/api/public/ai/chat", { message: "What is the student-only secret?", session_id: "scope-1" });
  assert.equal(publicRes.status, 200);
  assert.doesNotMatch(publicRes.data.reply, /STUDENT-ONLY-MARKER/, "the public site cannot read a portal answer");

  const asParent = await parent.api("POST", "/api/ai/chat", { message: "What is the student-only secret?" });
  assert.doesNotMatch(asParent.data.reply, /STUDENT-ONLY-MARKER/, "a parent's space is not the student's space");
});

test("console content never leaks into a school dashboard", async () => {
  const add = await superAdmin.api("POST", "/api/platform/ai/knowledge", {
    scope: "super_admin",
    topic: "Testing",
    question: "What is the operator-only secret?",
    answer: "OPERATOR-ONLY-MARKER: only the console may see this.",
    keywords: "operator only secret marker console",
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));

  const adminRes = await admin.api("POST", "/api/ai/chat", { message: "What is the operator-only secret?" });
  assert.doesNotMatch(adminRes.data.reply, /OPERATOR-ONLY-MARKER/);

  const opRes = await superAdmin.api("POST", "/api/ai/chat", { message: "What is the operator-only secret?" });
  assert.match(opRes.data.reply, /OPERATOR-ONLY-MARKER/);
});

test("the operator can see the spaces, their audiences and their answer counts", async () => {
  const res = await superAdmin.req("GET", "/api/platform/ai/spaces");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const keys = (res.data.spaces || []).map((s) => s.key);
  for (const key of ["public", "super_admin", "admin", "teacher", "student", "parent", "whatsapp"]) {
    assert.ok(keys.includes(key), `the editor lists ${key}`);
  }
  const studentSpace = res.data.spaces.find((s) => s.key === "student");
  assert.ok(studentSpace.answers >= 5, "the student space ships with real answers");
  assert.match(studentSpace.audience, /student/i);
  assert.ok(res.data.whatsapp.available, "the operator can see the WhatsApp line");
  assert.equal(res.data.whatsapp.number, "2348012345678");

  assert.equal((await admin.req("GET", "/api/platform/ai/spaces")).status, 403, "schools cannot read the operator's editor");
});

test("an answer saved for WhatsApp does not appear on the public website", async () => {
  const add = await superAdmin.api("POST", "/api/platform/ai/knowledge", {
    scope: "whatsapp",
    topic: "Testing",
    question: "What is the WhatsApp-only secret?",
    answer: "WHATSAPP-ONLY-MARKER: reply human for the team.",
    keywords: "whatsapp only secret marker",
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));

  const anon = new Client(ctx.base);
  const publicRes = await anon.req("POST", "/api/public/ai/chat", { message: "What is the WhatsApp-only secret?", session_id: "scope-2" });
  assert.doesNotMatch(publicRes.data.reply, /WHATSAPP-ONLY-MARKER/);

  const wa = await anon.req("POST", "/api/ai/whatsapp/webhook", {
    entry: [{ changes: [{ value: { messages: [{ from: "2348000000009", type: "text", text: { body: "What is the WhatsApp-only secret?" } }] } }] }],
  });
  assert.equal(wa.status, 200, JSON.stringify(wa.data));
  const convs = await superAdmin.req("GET", "/api/platform/ai/conversations?surface=whatsapp");
  const conv = (convs.data.conversations || []).find((c) => c.external_id === "wa-2348000000009");
  assert.ok(conv, "the WhatsApp thread is stored under its own surface");
  const detail = await superAdmin.req("GET", `/api/platform/ai/conversations/${conv.id}`);
  const last = (detail.data.messages || []).filter((m) => m.role === "assistant").pop();
  assert.match(last.content, /WHATSAPP-ONLY-MARKER/);
});

test("conversations are separated by space, not mixed in one thread", async () => {
  const adminHistory = await admin.req("GET", "/api/ai/history");
  assert.equal(adminHistory.status, 200);
  const text = (adminHistory.data.messages || []).map((m) => m.content).join("\n");
  assert.doesNotMatch(text, /What were my last results\?/, "the student's turn is not in the administrator's history");
  assert.equal(adminHistory.data.surface, "admin");
});

/* ------------------------------------------------------------------------ */
/* the public website → WhatsApp hand-off                                   */
/* ------------------------------------------------------------------------ */

test("the public website is told the WhatsApp number and a working wa.me link", async () => {
  const anon = new Client(ctx.base);
  const res = await anon.req("GET", "/api/public/ai/info");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.surface, "public");
  assert.equal(res.data.space.key, "public");
  assert.ok(res.data.whatsapp.available);
  assert.equal(res.data.whatsapp.number, "2348012345678");
  assert.ok(res.data.whatsapp.link.startsWith("https://wa.me/2348012345678"), "the button opens WhatsApp directly");
  assert.ok(res.data.whatsapp.link.includes("text="), "with a friendly first message");
  assert.equal(res.data.links.register_islamic_school, "/register-madrasa");
  assert.equal(res.data.links.register_western_academy, "/register-academy");

  const cta = await anon.req("GET", "/api/public/ai/whatsapp");
  assert.equal(cta.status, 200);
  assert.equal(cta.data.whatsapp.number, "2348012345678");
});

test("a local Nigerian number is normalised for wa.me", () => {
  const { digits, link } = require("../server/services/whatsapp-line");
  assert.equal(digits("0803 123 4567"), "2348031234567");
  assert.equal(digits("+234 803 123 4567"), "2348031234567");
  assert.equal(digits("002348031234567"), "2348031234567");
  assert.ok(link("08031234567", "Hello there").startsWith("https://wa.me/2348031234567?text=Hello%20there"));
  assert.equal(link("", "x"), "");
});

test("the public assistant answers registration from its knowledge base", async () => {
  const anon = new Client(ctx.base);
  const res = await anon.req("POST", "/api/public/ai/chat", { message: "How do I register my school?", session_id: "reg-1" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.match(res.data.reply, /register-madrasa|administrator|institution/i);
  assert.ok(res.data.suggestions.length >= 4);
  assert.ok(res.data.whatsapp && res.data.whatsapp.link, "the reply carries the WhatsApp hand-off too");
});

test("the WhatsApp line answers, offers a human and escalates when asked", async () => {
  const anon = new Client(ctx.base);

  const verify = await anon.req("GET", "/api/ai/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123");
  assert.equal(verify.status, 200);
  assert.equal(await verify.res.text(), "abc123");

  const greeting = await anon.req("POST", "/api/ai/whatsapp/webhook", {
    entry: [{ changes: [{ value: { messages: [{ from: "2348000000010", type: "text", text: { body: "hello" } }] } }] }],
  });
  assert.equal(greeting.status, 200, JSON.stringify(greeting.data));
  assert.equal(greeting.data.mode, "menu", "a greeting gets the menu, not an error");

  const answer = await anon.req("POST", "/api/ai/whatsapp/webhook", {
    entry: [{ changes: [{ value: { messages: [{ from: "2348000000011", type: "text", text: { body: "how much does edusphere cost" } }] } }] }],
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.data));
  assert.match(String(answer.data.mode), /knowledge-base|menu|ai/);

  const human = await anon.req("POST", "/api/ai/whatsapp/webhook", {
    entry: [{ changes: [{ value: { messages: [{ from: "2348000000012", type: "text", text: { body: "human" } }] } }] }],
  });
  assert.equal(human.status, 200, JSON.stringify(human.data));
  assert.equal(human.data.mode, "escalated");

  const convs = await superAdmin.req("GET", "/api/platform/ai/conversations?surface=whatsapp");
  const conv = (convs.data.conversations || []).find((c) => c.external_id === "wa-2348000000012");
  assert.ok(conv, "the escalation is stored");
  assert.equal(Number(conv.escalated), 1, "and marked for a human");
});

test("without a configured number the products say so instead of opening a dead link", async () => {
  const { line } = require("../server/services/whatsapp-line");
  // Temporarily blank both the env value and the stored value. The module
  // reads config on each call, so this is a real check of the fallback.
  const original = process.env.WHATSAPP_AI_DISPLAY_NUMBER;
  const config = require("../server/config");
  const saved = config.WHATSAPP_AI.displayNumber;
  try {
    config.WHATSAPP_AI.displayNumber = "";
    await ctx.db.run("DELETE FROM platform_settings WHERE key_name IN ('whatsapp_ai_number','public_contact_phone','billing_contact_phone')");
    const out = await line();
    assert.equal(out.available, false);
    assert.equal(out.link, "");
  } finally {
    config.WHATSAPP_AI.displayNumber = saved || original || "";
  }
});
