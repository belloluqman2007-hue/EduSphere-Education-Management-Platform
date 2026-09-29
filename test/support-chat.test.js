"use strict";
/* ============================================================================
   CHAT & SUPPORT — tests
   ----------------------------------------------------------------------------
   One conversation model shared by Islamic and Western institutions, with the
   Super Admin on the other side. What is proven here:

     • an Islamic institution admin and a Western academy admin each open a
       conversation that belongs to THEIR institution,
     • the Super Admin sees both,
     • neither institution can read the other's conversation (IDOR / tenant
       isolation, by conversation id AND by attachment id),
     • unread counts move correctly in both directions and are cleared per
       message when a conversation is opened,
     • attachments are validated server-side and only served to participants,
     • an ordinary administrator cannot reach the Super Admin endpoints.
   ========================================================================== */
const test = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD, SA_PASSWORD } = require("./helpers");

initEnv();

let ctx;
let islamicAdmin, westernAdmin, teacher, parent, superAdmin;
let islamicId, westernId;

/** multipart/form-data POST through the cookie-aware test client. */
async function postForm(client, path, fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append("attachment", new Blob([file.data], { type: file.type }), file.name);
  const token = await client.csrf();
  return client.req("POST", path, null, { raw: true, rawBody: form, headers: { "X-CSRF-Token": token } });
}

test.before(async () => {
  ctx = await setup();
  // Madrasa A is the Islamic school; madrasa B becomes the Western academy.
  await ctx.db.run("UPDATE madaris SET category = 'islamic', name_en = 'Al-Noor Islamic School' WHERE id = ?", [ctx.madrasaA]);
  await ctx.db.run("UPDATE madaris SET category = 'western', name_en = 'Greenfield Academy' WHERE id = ?", [ctx.madrasaB]);
  islamicId = ctx.madrasaA; westernId = ctx.madrasaB;

  islamicAdmin = new Client(ctx.base); await islamicAdmin.login("admin-a", PASSWORD);
  westernAdmin = new Client(ctx.base); await westernAdmin.login("admin-b", PASSWORD);
  teacher = new Client(ctx.base); await teacher.login("teacher-a", PASSWORD);
  parent = new Client(ctx.base); await parent.login("parent-a", PASSWORD);
  superAdmin = new Client(ctx.base); await superAdmin.login("testadmin", SA_PASSWORD);
});
test.after(async () => { await ctx.close(); });

let islamicConversation = null;
let westernConversation = null;

test("Islamic and Western institutions use the same chat, each scoped to itself", async () => {
  const a = await islamicAdmin.api("POST", "/api/support/chat/conversations", {
    subject: "Login issue", message: "I'm unable to access my account.", category: "account", priority: "high",
  });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.match(a.data.conversation_code, /^ES-\d{4}-\d{4}$/, "the backend generates the readable code");
  islamicConversation = a.data.id;

  const b = await westernAdmin.api("POST", "/api/support/chat/conversations", {
    subject: "Subscription enquiry", message: "How do we upgrade our plan?", category: "billing",
  });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  westernConversation = b.data.id;
  assert.notEqual(a.data.conversation_code, b.data.conversation_code, "codes are unique");

  const rowA = await ctx.db.get("SELECT madrasa_id FROM support_conversations WHERE id = ?", [islamicConversation]);
  const rowB = await ctx.db.get("SELECT madrasa_id FROM support_conversations WHERE id = ?", [westernConversation]);
  assert.equal(Number(rowA.madrasa_id), islamicId, "belongs to the Islamic institution");
  assert.equal(Number(rowB.madrasa_id), westernId, "belongs to the Western academy");

  const listA = await islamicAdmin.api("GET", "/api/support/chat/conversations");
  assert.equal(listA.status, 200);
  assert.deepEqual(listA.data.conversations.map((c) => c.id), [islamicConversation], "only its own conversations");
});

test("the Super Admin sees both institutions' conversations and can filter", async () => {
  const all = await superAdmin.api("GET", "/api/platform/conversations");
  assert.equal(all.status, 200, JSON.stringify(all.data));
  const ids = all.data.conversations.map((c) => c.id);
  assert.ok(ids.includes(islamicConversation) && ids.includes(westernConversation));
  const names = all.data.conversations.map((c) => c.institution_name);
  assert.ok(names.includes("Al-Noor Islamic School") && names.includes("Greenfield Academy"));

  const filtered = await superAdmin.api("GET", `/api/platform/conversations?madrasaId=${westernId}&status=open`);
  assert.deepEqual(filtered.data.conversations.map((c) => c.id), [westernConversation]);

  const searched = await superAdmin.api("GET", "/api/platform/conversations?q=unable%20to%20access");
  assert.deepEqual(searched.data.conversations.map((c) => c.id), [islamicConversation], "message text is searchable");
});

test("one institution can never reach another institution's conversation", async () => {
  const cross1 = await westernAdmin.api("GET", `/api/support/chat/conversations/${islamicConversation}`);
  assert.equal(cross1.status, 404, "Western admin is refused the Islamic conversation");
  const cross2 = await islamicAdmin.api("GET", `/api/support/chat/conversations/${westernConversation}`);
  assert.equal(cross2.status, 404, "Islamic admin is refused the Western conversation");
  const crossPost = await islamicAdmin.api("POST", `/api/support/chat/conversations/${westernConversation}/messages`, { message: "hello" });
  assert.equal(crossPost.status, 404, "and cannot post into it either");
  const crossRead = await islamicAdmin.api("PATCH", `/api/support/chat/conversations/${westernConversation}/read`);
  assert.equal(crossRead.status, 404);
});

test("unread counts move in both directions and clear per message", async () => {
  // The institution's first message is unread for the support desk.
  const beforeAdmin = await superAdmin.api("GET", "/api/platform/conversations/unread-count");
  assert.ok(beforeAdmin.data.unread >= 2, "support sees the institutions' messages as unread");

  // The user has nothing unread yet.
  const userBefore = await islamicAdmin.api("GET", "/api/support/chat/conversations/unread-count");
  assert.equal(userBefore.data.unread, 0);

  // Support replies → the user has one unread.
  const reply = await superAdmin.api("POST", `/api/platform/conversations/${islamicConversation}/messages`, { message: "We have reset your password." });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  const userAfter = await islamicAdmin.api("GET", "/api/support/chat/conversations/unread-count");
  assert.equal(userAfter.data.unread, 1);
  const detail = await islamicAdmin.api("GET", `/api/support/chat/conversations/${islamicConversation}`);
  assert.equal(detail.data.conversation.status, "replied", "a support reply moves the status on");

  // Opening it marks that message read; the user's own message is untouched.
  const marked = await islamicAdmin.api("PATCH", `/api/support/chat/conversations/${islamicConversation}/read`);
  assert.equal(marked.data.marked, 1);
  assert.equal(marked.data.unread, 0);
  const stillUnreadForSupport = await ctx.db.get(
    "SELECT COUNT(*) AS n FROM support_chat_messages WHERE conversation_id = ? AND sender_side = 'institution' AND read_at IS NULL",
    [islamicConversation]
  );
  assert.equal(Number(stillUnreadForSupport.n), 1, "the institution's own message stays unread for support");

  // Support opens it → its side is cleared, and only its side.
  const adminRead = await superAdmin.api("PATCH", `/api/platform/conversations/${islamicConversation}/read`);
  assert.equal(adminRead.data.marked, 1);
});

test("status and priority transitions are Super-Admin controlled and notify the user", async () => {
  const s = await superAdmin.api("PATCH", `/api/platform/conversations/${islamicConversation}/status`, { status: "resolved" });
  assert.equal(s.status, 200);
  const p = await superAdmin.api("PATCH", `/api/platform/conversations/${islamicConversation}/priority`, { priority: "urgent" });
  assert.equal(p.status, 200);
  const bad = await superAdmin.api("PATCH", `/api/platform/conversations/${islamicConversation}/status`, { status: "deleted" });
  assert.equal(bad.status, 400, "unknown statuses are refused");

  const detail = await islamicAdmin.api("GET", `/api/support/chat/conversations/${islamicConversation}`);
  assert.equal(detail.data.conversation.status, "resolved");
  assert.equal(detail.data.conversation.priority, "urgent");

  const notes = await ctx.db.all(
    "SELECT type FROM notifications WHERE madrasa_id = ? AND entity_type = 'support_conversation'",
    [islamicId]
  );
  assert.ok(notes.some((n) => n.type === "support_chat_reply"), "the reply used the existing notification system");
  assert.ok(notes.some((n) => n.type === "support_chat_status"), "so does a status change");

  // A user message reopens a resolved conversation.
  const again = await islamicAdmin.api("POST", `/api/support/chat/conversations/${islamicConversation}/messages`, { message: "It happened again." });
  assert.equal(again.status, 200);
  const after = await islamicAdmin.api("GET", `/api/support/chat/conversations/${islamicConversation}`);
  assert.equal(after.data.conversation.status, "open");
});

test("attachments are validated, stored privately and served only to participants", async () => {
  const good = await postForm(islamicAdmin, `/api/support/chat/conversations/${islamicConversation}/messages`,
    { message: "Here is the screenshot." },
    { name: "screen.png", type: "image/png", data: Buffer.from("89504e470d0a1a0a", "hex") });
  assert.equal(good.status, 200, JSON.stringify(good.data));

  const row = await ctx.db.get("SELECT * FROM support_chat_attachments WHERE conversation_id = ? ORDER BY id DESC", [islamicConversation]);
  assert.ok(row, "the attachment was recorded");
  assert.notEqual(row.storage_name, "screen.png", "the client's file name is never used on disk");
  assert.match(row.storage_name, /^\d+-[0-9a-f]{24}\.png$/);

  const download = await islamicAdmin.api("GET", `/api/support/chat/conversations/${islamicConversation}/attachments/${row.id}`);
  assert.equal(download.status, 200, "a participant may download it");
  assert.match(download.res.headers.get("content-disposition") || "", /attachment;/);

  const stranger = await westernAdmin.api("GET", `/api/support/chat/conversations/${islamicConversation}/attachments/${row.id}`);
  assert.equal(stranger.status, 404, "another institution may not");

  const script = await postForm(islamicAdmin, `/api/support/chat/conversations/${islamicConversation}/messages`,
    { message: "malicious" },
    { name: "evil.html", type: "text/html", data: Buffer.from("<script>alert(1)</script>") });
  assert.equal(script.status, 400, "executable/HTML uploads are refused server-side");

  const spoofed = await postForm(islamicAdmin, `/api/support/chat/conversations/${islamicConversation}/messages`,
    { message: "spoofed" },
    { name: "evil.html", type: "image/png", data: Buffer.from("not a png") });
  assert.equal(spoofed.status, 400, "a mismatched MIME/extension pair is refused");
});

test("empty messages and unknown conversations are refused cleanly", async () => {
  const empty = await islamicAdmin.api("POST", `/api/support/chat/conversations/${islamicConversation}/messages`, { message: "   " });
  assert.equal(empty.status, 400);
  const missing = await islamicAdmin.api("GET", "/api/support/chat/conversations/999999");
  assert.equal(missing.status, 404);
  assert.match(String(missing.data.error), /no longer available/i);
  const noSubject = await islamicAdmin.api("POST", "/api/support/chat/conversations", { subject: "", message: "hi" });
  assert.equal(noSubject.status, 400);
});

test("a teacher may use Chat & Support; parents and students may not", async () => {
  const created = await teacher.api("POST", "/api/support/chat/conversations", { subject: "Result entry question", message: "How do I submit results?" });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const list = await teacher.api("GET", "/api/support/chat/conversations");
  assert.equal(list.status, 200);
  assert.ok(list.data.conversations.every((c) => Number(c.madrasa_id) === islamicId));

  const parentTry = await parent.api("GET", "/api/support/chat/conversations");
  assert.equal(parentTry.status, 403, "parents have no Chat & Support access");
});

test("ordinary users cannot reach the Super Admin conversation API", async () => {
  for (const client of [islamicAdmin, westernAdmin, teacher, parent]) {
    const r = await client.api("GET", "/api/platform/conversations");
    assert.equal(r.status, 403, "platform-wide queue is Super Admin only");
    const d = await client.api("GET", `/api/platform/conversations/${islamicConversation}`);
    assert.equal(d.status, 403);
    const s = await client.api("PATCH", `/api/platform/conversations/${islamicConversation}/status`, { status: "closed" });
    assert.equal(s.status, 403);
  }
  const anon = new Client(ctx.base);
  assert.equal((await anon.api("GET", "/api/support/chat/conversations")).status, 401);
  assert.equal((await anon.api("GET", "/api/platform/conversations")).status, 401);
});
