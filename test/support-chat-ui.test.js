"use strict";
/* ============================================================================
   CHAT & SUPPORT — browser-level regression (jsdom)
   ----------------------------------------------------------------------------
   Drives the real admin SPA against the real API to prove the feature is wired
   end-to-end inside the EXISTING dashboard: the sidebar item and its unread
   badge, the three-pane Support & Messages page, starting a conversation,
   sending a message, the Super Admin's All Conversations screen, safe (escaped)
   message rendering, and the untouched pages still working afterwards — all
   without a single script error.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, PASSWORD, SA_PASSWORD } = require("./helpers");
initEnv();

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch (e) { /* production install */ }
const skip = !JSDOM ? "jsdom devDependency not installed" : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openAdmin(base, username, password) {
  let cookie = "";
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (error) => {
    if (!/Not implemented: window\.(scrollTo|HTMLCanvasElement)/i.test(String(error.message))) errors.push(String(error.message));
  });
  vc.on("error", (...args) => errors.push(args.map(String).join(" ")));
  const dom = await JSDOM.fromURL(base + "/admin", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.confirm = () => true;
      window.open = () => null;
      window.fetch = async (input, init = {}) => {
        const url = String(input).startsWith("http") ? input : base + input;
        const headers = new Headers(init.headers || {});
        if (cookie) headers.set("cookie", cookie);
        const response = await fetch(url, { ...init, headers });
        for (const value of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
          const pair = value.split(";", 1)[0]; const i = pair.indexOf("=");
          cookie = pair.slice(0, i) + "=" + pair.slice(i + 1);
        }
        return response;
      };
    },
  });
  const { window } = dom;
  for (let i = 0; i < 80 && !window.document.querySelector("#dashLoginForm"); i++) await sleep(50);
  assert.ok(window.document.querySelector("#dashLoginForm"), "admin sign-in form rendered");
  window.document.querySelector("#dlUser").value = username;
  window.document.querySelector("#dlPass").value = password;
  window.document.querySelector("#dashLoginForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 100 && !window.document.querySelector("#dashContent"); i++) await sleep(50);
  assert.ok(window.document.querySelector("#dashContent"), "authenticated dashboard shell rendered");
  await sleep(900);
  return {
    window, doc: window.document, errors,
    content: () => window.document.querySelector("#dashContent"),
    async route(route) { window.BelloDashboard.go(route); await sleep(1200); },
    click(el) { el.dispatchEvent(new window.Event("click", { bubbles: true })); },
    change(el) { el.dispatchEvent(new window.Event("change", { bubbles: true })); },
    submit(form) { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); },
    close() { window.close(); },
  };
}

let ctx;
before(async () => {
  ctx = await setup();
  await ctx.db.run("UPDATE madaris SET category = 'islamic', name_en = 'Al-Noor Islamic School' WHERE id = ?", [ctx.madrasaA]);
  await ctx.db.run("UPDATE madaris SET category = 'western', name_en = 'Greenfield Academy' WHERE id = ?", [ctx.madrasaB]);
});
after(async () => { if (ctx) await ctx.close(); });

test("an institution administrator starts and continues a conversation through the real UI", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-a", PASSWORD);
  try {
    assert.ok(page.window.EduSphereSupportChat, "the Chat & Support module is loaded");
    assert.ok(page.doc.body.classList.contains("dash-islamic"), "the existing Islamic theme is untouched");

    // The item lives inside the EXISTING Platform Support group.
    const group = [...page.doc.querySelectorAll(".dash-nav-link")].find((b) => b.textContent.trim().startsWith("Platform Support"));
    assert.ok(group, "the existing Platform Support sidebar group is still there");
    page.click(group);
    await sleep(200);
    const items = [...page.doc.querySelectorAll(".dash-nav-sub.is-open button")].map((b) => b.textContent.trim());
    assert.ok(items.some((t) => t.startsWith("Chat & Support")), "Chat & Support added to the existing group");
    assert.ok(items.includes("Support Tickets"), "the older ticket screens are preserved");

    await page.route("support/chat");
    let content = page.content();
    assert.match(content.querySelector("h2").textContent, /Support & Messages/);
    assert.match(content.textContent, /Contact EduSphere Support/);
    assert.ok(content.querySelector(".sc-layout"), "the three-pane layout rendered");
    assert.ok(content.querySelector("#scSearch").getAttribute("placeholder") === "Search conversations...");
    assert.match(content.textContent, /No conversations yet/, "professional empty state");

    // --- New Conversation
    page.click(content.querySelector("#scNewBtn"));
    await sleep(300);
    const modal = page.doc.querySelector(".dash-modal-backdrop");
    assert.ok(modal, "the existing modal component is reused");
    const form = modal.querySelector("#scNewForm");
    // Empty submit is refused in the browser with an accessible message.
    page.submit(form);
    await sleep(200);
    assert.equal(modal.querySelector("#scnError").hidden, false, "accessible validation message shown");

    modal.querySelector("#scnSubject").value = "Login issue";
    modal.querySelector("#scnCategory").value = "account";
    modal.querySelector("#scnPriority").value = "high";
    modal.querySelector("#scnMessage").value = "I'm unable to access my account <img src=x onerror=alert(1)>";
    page.submit(form);
    await sleep(1400);

    content = page.content();
    assert.match(content.textContent, /Login issue/, "the new conversation is listed and opened");
    assert.match(content.textContent, /ES-\d{4}-\d{4}/, "the server-generated code is shown");
    assert.ok(content.querySelector(".sc-msg"), "the first message renders in the thread");
    assert.equal(content.querySelector("img[src='x']"), null, "message text is escaped, never injected as HTML");
    assert.match(content.querySelector(".sc-details-pane").textContent, /Conversation Details/);
    assert.match(content.querySelector(".sc-details-pane").textContent, /Al-Noor Islamic School/);

    // --- Composer: empty send is refused, a real message is appended.
    const composer = content.querySelector("#scComposer");
    page.submit(composer);
    await sleep(300);
    assert.equal(content.querySelectorAll(".sc-msg").length, 1, "an empty message is never sent");
    content.querySelector("#scMessage").value = "Any update please?";
    page.submit(composer);
    await sleep(1400);
    content = page.content();
    assert.equal(content.querySelectorAll(".sc-msg").length, 2, "the message was sent and the thread refreshed");
    assert.match(content.textContent, /Any update please\?/);

    // The rest of the workspace still works.
    await page.route("dashboard");
    assert.match(page.content().textContent, /Dashboard|Welcome|Students/);
    await page.route("support/tickets");
    assert.match(page.content().querySelector("h2").textContent, /Support tickets/i, "the existing ticket page is unaffected");

    assert.deepEqual(page.errors, [], "no script errors");
  } finally { page.close(); }
});

test("the Super Admin works every institution's conversations and the user sees the badge", { skip }, async () => {
  // A Western academy conversation exists too — one shared architecture.
  await ctx.db.run(
    `INSERT INTO support_conversations (conversation_code, madrasa_id, created_by, subject, category, priority, status, last_message_preview, last_sender_side)
     VALUES ('ES-2099-0001', ?, ?, 'Subscription enquiry', 'billing', 'normal', 'open', 'How do we upgrade?', 'institution')`,
    [ctx.madrasaB, ctx.users.adminB]
  );
  const conversationB = (await ctx.db.get("SELECT id FROM support_conversations WHERE conversation_code = 'ES-2099-0001'")).id;
  await ctx.db.run(
    "INSERT INTO support_chat_messages (conversation_id, madrasa_id, sender_id, sender_role, sender_side, body) VALUES (?,?,?,?,'institution',?)",
    [conversationB, ctx.madrasaB, ctx.users.adminB, "madrasa_admin", "How do we upgrade?"]
  );

  const page = await openAdmin(ctx.base, "testadmin", SA_PASSWORD);
  try {
    const navLabels = [...page.doc.querySelectorAll(".dash-nav-link")].map((b) => b.textContent.trim());
    assert.ok(navLabels.some((t) => t.startsWith("Chat & Support")), "the Super Admin sidebar gained the item");
    assert.ok(navLabels.some((t) => t.startsWith("Support Tickets")), "the existing operator screens are preserved");

    await page.route("platform/conversations");
    let content = page.content();
    assert.match(content.querySelector("h2").textContent, /All Conversations/);
    assert.match(content.textContent, /Monitor and respond to support enquiries across all institutions/);
    assert.match(content.textContent, /Al-Noor Islamic School/, "the Islamic institution's conversation is visible");
    assert.match(content.textContent, /Greenfield Academy/, "so is the Western academy's");
    assert.ok(content.querySelector("#scInstitution"), "institution filter present");
    assert.ok(content.querySelector("#scPriority") && content.querySelector("#scCategory"), "priority and category filters present");

    // The sidebar badge is fed by the backend unread count.
    const badge = page.doc.querySelector('[data-nav-badge="supportChat"]');
    assert.ok(badge && !badge.hidden && Number(badge.textContent) >= 1, "unread conversations raise the sidebar badge");

    // Open the Islamic conversation and reply.
    const item = [...content.querySelectorAll(".sc-item")].find((b) => /Login issue/.test(b.textContent));
    assert.ok(item, "the Islamic conversation is in the queue");
    page.click(item);
    await sleep(1300);
    content = page.content();
    assert.ok(content.querySelector("#scComposer"), "the Super Admin can reply");
    content.querySelector("#scMessage").value = "We have reset your password.";
    page.submit(content.querySelector("#scComposer"));
    await sleep(1400);
    content = page.content();
    assert.match(content.textContent, /We have reset your password\./);

    // Status and priority controls.
    const status = content.querySelector("#scSetStatus");
    status.value = "resolved";
    page.change(status);
    await sleep(1300);
    assert.match(page.content().querySelector(".sc-thread-pills").textContent, /Resolved/);

    assert.deepEqual(page.errors, [], "no script errors");
  } finally { page.close(); }
});
