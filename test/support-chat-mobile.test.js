"use strict";
/* ============================================================================
   CHAT & SUPPORT — phone / small-screen regression
   ----------------------------------------------------------------------------
   Reported bug: "it is only working on PC, can't press anything on phone."

   Cause: `.sc-drawer-backdrop` declared `display: block; position: fixed;
   inset: 0; z-index: 410` inside `@media (max-width: 1180px)`. The element is
   toggled with the `hidden` ATTRIBUTE, but `hidden` only hides something
   through the user-agent rule `[hidden] { display: none }` — and ANY author
   declaration of `display` out-ranks the user-agent origin, specificity
   notwithstanding. So on every screen narrower than 1180px (every phone, every
   tablet, every split window) an invisible wall covered the viewport and ate
   every tap, while a desktop at 1440px was completely unaffected. jsdom cannot
   see this — it ignores `@media` — so the suite parses the real stylesheet and
   asserts the cascade invariant instead, then drives the real SPA to prove the
   phone behaviour (one pane at a time, the details sheet, the backdrop, and a
   draft that survives a background refresh) still works.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { initEnv, setup, PASSWORD } = require("./helpers");
initEnv();

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch (e) { /* production install */ }
const skip = !JSDOM ? "jsdom devDependency not installed" : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------------------
   A tiny CSS reader. Enough to answer "which rules can paint this selector,
   and under which media condition?" — no new dependency, no guessing.
   -------------------------------------------------------------------------- */
function readCss(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Flattens a stylesheet into { selector, body, media } rules. */
function parseRules(text) {
  const rules = [];
  const walk = (source, media) => {
    let i = 0;
    while (i < source.length) {
      const open = source.indexOf("{", i);
      if (open === -1) break;
      const selector = source.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth += 1;
        else if (source[j] === "}") depth -= 1;
        j += 1;
      }
      const body = source.slice(open + 1, j - 1);
      if (/^@(media|supports)/i.test(selector)) walk(body, selector);
      else if (!selector.startsWith("@")) rules.push({ selector, body, media: media || "" });
      i = j;
    }
  };
  walk(text, "");
  return rules;
}

/** The FIRST value of a property (what the cascade would use last-wins aside). */
const declaration = (body, property) => {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(body);
  return m ? m[1].trim() : "";
};
/** Every value a rule declares for a property — a fallback pair such as
    `height: …100vh…; height: …100dvh…` is the point of the assertion. */
const declarations = (body, property) => {
  const out = [];
  const re = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "gi");
  let m;
  while ((m = re.exec(body))) out.push(m[1].trim());
  return out;
};
const isDisplayed = (body) => {
  const value = declaration(body, "display");
  return Boolean(value) && value !== "none";
};
/** `position: fixed` covering the whole viewport — i.e. able to block taps. */
const coversViewport = (body) =>
  /position\s*:\s*fixed/i.test(body) &&
  (/inset\s*:\s*0/i.test(body) ||
    (/top\s*:\s*0/i.test(body) && /left\s*:\s*0/i.test(body)) ||
    (/inset-block\s*:\s*0/i.test(body) && /inset-inline\s*:\s*0/i.test(body)));
/** True when a selector can only match an element that is in some open state. */
const isStateGated = (selector) =>
  /:not\(\[hidden\]\)|\[hidden\]|\[aria-hidden="false"\]|\.is-open|\.details-open/.test(selector);

const chatCss = readCss("public/css/support-chat.css");
const appCss = readCss("public/css/app.css");
const chatRules = parseRules(chatCss);

/* ==========================================================================
   1. The cascade — what made the phone unusable
   ========================================================================== */

test("no chat overlay can paint itself over the page while it is hidden", () => {
  const offenders = chatRules
    .filter((r) => isDisplayed(r.body) && coversViewport(r.body) && !isStateGated(r.selector))
    .map((r) => `${r.media || "(unconditional)"} ${r.selector}`);
  assert.deepEqual(offenders, [],
    "a full-viewport overlay must be state-gated: an author `display` beats the " +
    "user-agent `[hidden] { display: none }`, so an ungated one covers the page " +
    "and swallows every tap on a phone. Offenders: " + offenders.join(", "));
});

test("the drawer backdrop keeps its own [hidden] guard and starts hidden in the markup", () => {
  // Defence in depth: the chat must not depend on a rule living in another file.
  const guard = chatRules.find((r) => r.selector === ".sc-drawer-backdrop[hidden]");
  assert.ok(guard, "`.sc-drawer-backdrop[hidden] { display: none }` must exist");
  assert.equal(declaration(guard.body, "display"), "none");

  const base = chatRules.find((r) => r.selector === ".sc-drawer-backdrop");
  assert.ok(base, "the backdrop's base rule must exist");
  assert.equal(declaration(base.body, "display"), "none", "hidden by default at every width");

  // …and the module renders it with the attribute set.
  const js = fs.readFileSync(path.join(__dirname, "..", "public/js/support-chat.js"), "utf8");
  assert.match(js, /id="scDrawerBackdrop"\s+hidden/, "the backdrop is rendered hidden");
});

test("`hidden` is guaranteed app-wide, not just inside the chat", () => {
  // The same mistake existed on `.dash-mi-error` and would recur anywhere a
  // component declares `display` on an element JS toggles with `hidden`.
  const guard = parseRules(appCss).find((r) => r.selector.trim() === "[hidden]");
  assert.ok(guard, "app.css must carry the global [hidden] guard");
  assert.match(declaration(guard.body, "display"), /none\s*!important/);
});

/* ==========================================================================
   2. The phone ergonomics that go with it
   ========================================================================== */

test("fields a phone focuses are 16px, or iOS Safari zooms the page away", () => {
  const block = chatRules.filter((r) => /max-width:\s*820px/.test(r.media) && /font-size\s*:\s*16px/.test(r.body));
  const selectors = block.map((r) => r.selector).join(" ");
  for (const field of [".sc-search input", ".sc-filter-row select", ".sc-composer-box textarea"]) {
    assert.ok(selectors.includes(field), `${field} must be 16px on a phone`);
  }
});

test("every chat control a thumb has to hit is at least 44px", () => {
  const coarse = chatRules.filter((r) => /pointer:\s*coarse/.test(r.media));
  assert.ok(coarse.length, "a `@media (pointer: coarse)` block must exist");
  const sizes = coarse.map((r) => [r.selector, Number((/(\d+)px/.exec(declaration(r.body, "min-height")) || /width\s*:\s*(\d+)px/.exec(r.body) || [])[1] || 0)]);
  for (const target of [".sc-icon-btn", ".sc-send", ".sc-back", ".sc-jump"]) {
    const hit = sizes.find(([sel]) => sel.includes(target));
    assert.ok(hit, `${target} must be sized up for touch`);
    assert.ok(hit[1] >= 44, `${target} is ${hit[1]}px on a coarse pointer — 44px is the minimum`);
  }
});

test("the composer clears the home indicator and the chat owns the viewport height", () => {
  assert.match(chatCss, /env\(safe-area-inset-bottom/, "safe-area insets are honoured");
  // A definite height is what makes the MESSAGE LIST the only scroller, so the
  // composer is on screen instead of below the fold.
  const page = chatRules.filter((r) => r.selector === ".sc-page");
  const heights = page.flatMap((r) => declarations(r.body, "height")).join(" ");
  assert.match(heights, /100vh/, "a vh fallback for older browsers");
  assert.match(heights, /100dvh/, "dvh so a mobile URL bar cannot hide the composer");
  assert.match(chatCss, /--sc-keyboard/, "the on-screen keyboard can shrink the chat instead of covering it");
});

/* ==========================================================================
   3. Behaviour in the real SPA at phone size
   ========================================================================== */

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
    key(el, key) { el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); },
    submit(form) { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); },
    close() { window.close(); },
  };
}

/**
 * "YYYY-MM-DD HH:MM:SS" in UTC — the shape both drivers hand back — for a given
 * LOCAL day and hour, so "Yesterday"/"Today" mean the same thing in the test
 * and on the screen whatever timezone the suite runs in.
 */
function stamp(daysAgo, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

let ctx;
before(async () => {
  ctx = await setup();
  await ctx.db.run("UPDATE madaris SET category = 'islamic', name_en = 'Al-Noor Islamic School' WHERE id = ?", [ctx.madrasaA]);

  // Two conversations: one spanning two days (day dividers, grouped messages)
  // and a second one to prove a draft never follows the reader across.
  for (const [code, subject, dayOffset] of [["ES-2099-0001", "Cannot print report cards", 0], ["ES-2099-0002", "Billing question", 0]]) {
    const cid = (await ctx.db.run(
      `INSERT INTO support_conversations (conversation_code, madrasa_id, created_by, subject, category, priority, status, last_message_preview, last_sender_side)
       VALUES (?, ?, ?, ?, 'technical', 'normal', 'open', 'Latest message', 'platform')`,
      [code, ctx.madrasaA, ctx.users.adminA, subject]
    )).lastInsertRowid;
    const rows = [
      ["institution", "madrasa_admin", "First question, asked yesterday.", stamp(dayOffset + 1, 9, 0)],
      ["institution", "madrasa_admin", "Adding one more line straight after.", stamp(dayOffset + 1, 9, 2)],
      ["platform", "super_admin", "Latest message", stamp(dayOffset, 10, 0)],
    ];
    for (const [side, role, body, at] of rows) {
      await ctx.db.run(
        "INSERT INTO support_chat_messages (conversation_id, madrasa_id, sender_id, sender_role, sender_side, body, created_at) VALUES (?,?,?,?,?,?,?)",
        [cid, ctx.madrasaA, ctx.users.adminA, role, side, body, at]
      );
    }
  }
});
after(async () => { if (ctx) await ctx.close(); });

test("the chat is operable on a phone: nothing covers it, one pane at a time", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-a", PASSWORD);
  try {
    await page.route("support/chat");
    let content = page.content();

    // --- The regression itself: the backdrop must never be in the way.
    const backdrop = content.querySelector("#scDrawerBackdrop");
    assert.ok(backdrop, "the drawer backdrop exists");
    assert.equal(backdrop.hidden, true, "and it starts hidden");
    assert.equal(backdrop.getAttribute("aria-hidden"), "true");

    // --- A phone shows the queue first; opening a thread swaps the pane.
    assert.equal(content.querySelector("#scLayout").getAttribute("data-view"), "list");
    assert.equal(content.querySelector("#scPage").getAttribute("data-view"), "list");

    const item = [...content.querySelectorAll(".sc-item")].find((b) => /Cannot print report cards/.test(b.textContent));
    assert.ok(item, "the seeded conversation is listed");
    page.click(item);
    await sleep(1300);
    content = page.content();

    assert.equal(content.querySelector("#scLayout").getAttribute("data-view"), "thread", "the thread pane is the one shown");
    assert.equal(content.querySelector("#scPage").getAttribute("data-view"), "thread", "so the page head can step aside");
    assert.ok(content.querySelector("#scBack"), "and there is a way back to the queue");
    assert.equal(content.querySelector("#scDrawerBackdrop").hidden, true, "opening a thread does not raise an overlay");

    // --- Messages: one .sc-msg each, day dividers between the days.
    assert.equal(content.querySelectorAll(".sc-msg").length, 3, "exactly one .sc-msg per message");
    const days = [...content.querySelectorAll(".sc-day span")].map((s) => s.textContent.trim());
    assert.deepEqual(days, ["Yesterday", "Today"], "the thread is divided by day");
    assert.ok(content.querySelectorAll(".sc-msg.is-grouped").length >= 1, "consecutive messages from one sender group");
    assert.match(content.querySelector(".sc-msg.is-mine .sc-ticks").textContent, /Sent|Read/, "delivery state is written in words");
    assert.equal(content.querySelector("#scJump").hidden, true, "no jump-to-latest control while at the latest");

    // --- The details sheet: opens, is closable three ways, traps no focus.
    const toggle = content.querySelector("#scDetailsToggle");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    page.click(toggle);
    await sleep(60);
    assert.equal(content.querySelector("#scDrawerBackdrop").hidden, false, "the backdrop appears with the sheet");
    assert.equal(content.querySelector("#scDrawerBackdrop").getAttribute("aria-hidden"), "false");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(page.doc.activeElement && page.doc.activeElement.id, "scDetailsClose", "focus moves into the sheet");
    assert.match(content.querySelector("#scDetails").textContent, /Conversation Details/);

    page.key(content.querySelector("#scDetails"), "Escape");
    await sleep(60);
    assert.equal(content.querySelector("#scDrawerBackdrop").hidden, true, "Escape closes the sheet");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(page.doc.activeElement && page.doc.activeElement.id, "scDetailsToggle",
      "and focus returns to the control that opened it");

    page.click(toggle);
    await sleep(60);
    page.click(content.querySelector("#scDrawerBackdrop"));
    await sleep(60);
    assert.equal(content.querySelector("#scDrawerBackdrop").hidden, true, "tapping outside closes the sheet");

    // --- Back to the queue, still nothing covering it.
    page.click(content.querySelector("#scBack"));
    await sleep(60);
    assert.equal(content.querySelector("#scLayout").getAttribute("data-view"), "list");
    assert.equal(content.querySelector("#scDrawerBackdrop").hidden, true);

    assert.deepEqual(page.errors, [], "no script errors");
  } finally { page.close(); }
});

test("a half-typed message survives a refresh and never follows the reader", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-a", PASSWORD);
  try {
    await page.route("support/chat");
    let content = page.content();
    page.click([...content.querySelectorAll(".sc-item")].find((b) => /Cannot print report cards/.test(b.textContent)));
    await sleep(1300);
    content = page.content();

    // Typing arms the send button; an empty composer leaves it muted.
    const send = content.querySelector("#scSend");
    assert.ok(send.classList.contains("is-idle"), "nothing to send yet");
    assert.equal(send.disabled, false, "but it is not disabled — Enter must still submit");

    content.querySelector("#scMessage").value = "Drafting on my phone…";
    content.querySelector("#scMessage").dispatchEvent(new page.window.Event("input", { bubbles: true }));
    assert.equal(send.classList.contains("is-idle"), false, "the send button arms");

    // A background refresh of the SAME thread must not eat the draft. This is
    // what a 20-second poll used to do mid-sentence.
    page.click([...content.querySelectorAll(".sc-item")].find((b) => /Cannot print report cards/.test(b.textContent)));
    await sleep(1300);
    content = page.content();
    assert.equal(content.querySelector("#scMessage").value, "Drafting on my phone…", "the draft survives a repaint");
    assert.equal(content.querySelectorAll(".sc-msg").length, 3, "and the thread is still intact");

    // Opening a DIFFERENT conversation must not carry the draft over.
    page.click(content.querySelector("#scBack"));
    await sleep(60);
    page.click([...page.content().querySelectorAll(".sc-item")].find((b) => /Billing question/.test(b.textContent)));
    await sleep(1300);
    content = page.content();
    assert.equal(content.querySelector("#scMessage").value, "", "a draft belongs to the conversation it was typed in");
    assert.match(content.querySelector(".sc-thread-title h3").textContent, /Billing question/);

    assert.deepEqual(page.errors, [], "no script errors");
  } finally { page.close(); }
});
