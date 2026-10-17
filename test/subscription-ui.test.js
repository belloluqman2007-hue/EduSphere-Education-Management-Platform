"use strict";
/* ============================================================================
   SUBSCRIPTION TIERS — browser-level regression (jsdom)
   ----------------------------------------------------------------------------
   The tiers are a sales surface, so this drives the real admin SPA against the
   real API and asserts what a head actually sees:

     • three offer cards in tier order, each stating its promise, its limits as
       capacity, its quick win and grouped benefits (never a bare ceiling list);
     • the current tier is marked, and the next one is flagged as recommended;
     • the yearly/monthly switch re-prices every card and shows the saving;
     • the "compare every feature" matrix ticks Premium on every row;
     • a gated API call made from inside the page pops the upsell dialog, and
       the dialog's own button lands on the upgrade form for that plan —
       the dead-end toast this replaced is the bug being guarded against;
     • all of it without a single console or script error.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, PASSWORD } = require("./helpers");
const catalogue = require("../server/services/plan-catalogue");
initEnv();

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch (e) { /* production install */ }
const skip = !JSDOM ? "jsdom devDependency not installed" : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openAdmin(base, username) {
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
  window.document.querySelector("#dlPass").value = PASSWORD;
  window.document.querySelector("#dashLoginForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 100 && !window.document.querySelector("#dashContent"); i++) await sleep(50);
  assert.ok(window.document.querySelector("#dashContent"), "authenticated dashboard shell rendered");
  await sleep(900);
  return {
    window, doc: window.document, errors,
    content: () => window.document.querySelector("#dashContent"),
    async route(route) { window.BelloDashboard.go(route); await sleep(1200); },
    text: () => window.document.querySelector("#dashContent").textContent,
    close() { window.close(); },
  };
}

/** The teacher workspace is its own shell (#portalRoot), reached at /teacher. */
async function openTeacher(base, username) {
  let cookie = "";
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (error) => {
    if (!/Not implemented: window\.(scrollTo|HTMLCanvasElement)/i.test(String(error.message))) errors.push(String(error.message));
  });
  vc.on("error", (...args) => errors.push(args.map(String).join(" ")));
  const dom = await JSDOM.fromURL(base + "/teacher", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.scrollTo = () => {};
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
  for (let i = 0; i < 80 && !window.document.querySelector("#portalLoginForm"); i++) await sleep(50);
  assert.ok(window.document.querySelector("#portalLoginForm"), "teacher sign-in form rendered");
  window.document.querySelector("#plUser").value = username;
  window.document.querySelector("#plPass").value = PASSWORD;
  window.document.querySelector("#portalLoginForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  for (let i = 0; i < 100 && !window.document.querySelector("#portalContent"); i++) await sleep(50);
  assert.ok(window.document.querySelector("#portalContent"), "authenticated teacher workspace rendered");
  await sleep(900);
  return { window, doc: window.document, errors, close() { window.close(); } };
}

let ctx;
before(async () => {
  ctx = await setup();
  // The fixture plan carries every feature so module tests can run; this file is
  // about the TIERS, so it restores the real Free tier and publishes the other
  // two — exactly what a fresh seeded deployment looks like.
  await ctx.db.run("UPDATE plans SET features = ?, description = ? WHERE code = 'free'",
    [JSON.stringify(catalogue.featuresForTier("free")), catalogue.TIERS.free.tagline]);
  for (const code of ["basic", "premium"]) {
    const meta = catalogue.TIERS[code];
    const prices = code === "basic" ? [8000, 80000] : [20000, 200000];
    const limits = code === "basic" ? [300, 15] : [-1, -1];
    await ctx.db.run(
      `INSERT INTO plans (code,name,name_ar,description,price_ngn,price_yearly_ngn,trial_days,student_limit,teacher_limit,features,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [code, meta.name, meta.name_ar, meta.tagline, prices[0], prices[1], 14, limits[0], limits[1],
       JSON.stringify(catalogue.featuresForTier(code)), catalogue.TIER_ORDER.indexOf(code) + 1]
    );
  }
  // Real bank details, so the upgrade dialog shows a payable instruction.
  const subscription = require("../server/services/subscription");
  await subscription.setSetting("billing_bank_name", "Test Bank");
  await subscription.setSetting("billing_account_name", "EduSphere Ltd");
  await subscription.setSetting("billing_account_number", "0011223344");
});
after(async () => { if (ctx) await ctx.close(); });

test("the plans screen sells three tiers and a gated click ends in an upgrade form", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-a");
  try {
    assert.ok(page.window.EduSphereSubscription, "the subscription module is loaded");
    assert.ok(page.window.EduSphereUpsell, "the upsell dialog is available to every module");

    await page.route("subscription/plans");
    const cards = [...page.content().querySelectorAll(".sub-plan")];
    assert.equal(cards.length, 3, "all three tiers are offered");
    assert.deepEqual(cards.map((c) => [...c.classList].find((k) => k.startsWith("sub-plan-") && k !== "sub-plan-flags")),
      ["sub-plan-free", "sub-plan-basic", "sub-plan-premium"], "in tier order");

    const text = page.text();
    // The brief's copy, verbatim, on the screen.
    for (const expected of [
      "Start running your school digitally", "Replace paper registers and manual report cards.",
      "Everything a growing school needs", "Collect fees online and keep parents informed automatically.",
      "A modern, AI-powered school", "Save teacher hours, boost parent satisfaction, and grow enrollment.",
    ]) assert.ok(text.includes(expected), `the screen promises: ${expected}`);

    // Benefits, not only ceilings.
    assert.ok(cards.every((c) => c.querySelectorAll(".sub-benefit-group li").length > 0), "every card lists what you GET");
    assert.ok(cards.every((c) => c.querySelector(".sub-quickwin")), "every card states its quick win");
    assert.ok(cards.every((c) => c.querySelectorAll(".sub-plan-limits li").length === 2), "every card states its capacity");
    assert.ok(cards[2].textContent.includes("Unlimited students"), "Premium is sold as unlimited, not as -1");
    assert.ok(cards[1].textContent.includes("300 students"), "Basic states 300 students");

    // Where this school stands, and what it should do next.
    assert.ok(cards[0].classList.contains("is-current"), "Free is marked as the current plan");
    assert.ok(cards[0].querySelector("button[disabled]"), "the current card has no upgrade button");
    assert.ok(cards[1].classList.contains("is-recommended"), "Basic is flagged as the recommended next step");
    assert.ok(text.includes("You are on Free"), "the upsell banner names the current plan");
    assert.ok(text.includes("Upgrade to Basic"), "and offers the obvious next action");

    /* ------------------------- billing cycle -------------------------- */
    assert.ok(text.includes("₦80,000"), "yearly pricing is the default");
    assert.ok(text.includes("save ₦16,000"), "the yearly saving is shown");
    const monthly = page.content().querySelector('[data-cycle="monthly"]');
    monthly.dispatchEvent(new page.window.Event("click", { bubbles: true }));
    await sleep(900);
    const monthlyText = page.text();
    assert.ok(monthlyText.includes("₦8,000"), "monthly pricing after the switch");
    assert.ok(monthlyText.includes("/ month"), "labelled per month");
    assert.ok(!monthlyText.includes("₦80,000"), "the yearly figure is gone");
    page.content().querySelector('[data-cycle="yearly"]').dispatchEvent(new page.window.Event("click", { bubbles: true }));
    await sleep(900);

    /* ------------------------- compare matrix ------------------------- */
    const rows = [...page.content().querySelectorAll(".sub-compare tbody tr")].filter((r) => !r.classList.contains("sub-compare-group"));
    assert.ok(rows.length >= catalogue.FEATURE_KEYS.length, "one comparison row per capability");
    for (const row of rows) {
      const cells = [...row.querySelectorAll("td")];
      const last = cells[cells.length - 1];
      assert.ok(last.querySelector(".sub-yes"), `Premium includes ${row.querySelector("th, td").textContent.trim()}`);
    }
    const payrollRow = rows.find((r) => /payroll/i.test(r.textContent));
    assert.ok(payrollRow.querySelectorAll(".sub-no").length === 2, "payroll is marked absent on Free and Basic");

    /* ----------------------- everything-included ---------------------- */
    const details = [...page.content().querySelectorAll("[data-sub-details]")].pop();
    details.dispatchEvent(new page.window.Event("click", { bubbles: true }));
    await sleep(600);
    assert.ok(page.doc.querySelector(".dash-modal-backdrop"), "the included-features dialog opens");
    assert.match(page.doc.querySelector(".dash-modal").textContent, /Everything included/i);
    page.doc.querySelector(".dash-modal-close").dispatchEvent(new page.window.Event("click", { bubbles: true }));
    await sleep(300);
    assert.ok(!page.doc.querySelector(".dash-modal-backdrop"), "and closes again");

    /* --------------------------- upgrade CTA -------------------------- */
    const upgradeBtn = [...page.content().querySelectorAll("[data-sub-upgrade]")].find((b) => b.getAttribute("data-sub-code") === "basic");
    upgradeBtn.dispatchEvent(new page.window.Event("click", { bubbles: true }));
    await sleep(600);
    const modal = page.doc.querySelector(".dash-modal");
    assert.ok(modal, "the upgrade dialog opens");
    assert.match(modal.textContent, /Upgrade to Basic/);
    assert.ok(modal.querySelector("#subUpgradeForm select[name='billing_cycle']"), "it asks for a billing cycle");
    assert.match(modal.textContent, /Test Bank/, "and shows the account to pay");
    assert.match(modal.textContent, /Nothing changes until/, "with the reassurance that a request is not a charge");
    modal.querySelector("#subUpgradeCancel").dispatchEvent(new page.window.Event("click", { bubbles: true }));
    await sleep(300);

    /* ------------- a gated action pops the upsell, not a toast ---------- */
    await page.route("subscription/overview");
    let gateError = null;
    await page.window.API.get("/payroll/structures").catch((e) => { gateError = e; });
    assert.ok(gateError, "payroll really is refused on Free");
    assert.equal(gateError.data.code, "feature_gated");
    await sleep(700);

    const upsell = page.doc.querySelector(".sub-upsell-backdrop");
    assert.ok(upsell, "the upsell dialog opened by itself");
    assert.match(upsell.textContent, /Payroll is included in Premium/, "it names the feature and the tier");
    assert.match(upsell.textContent, /A modern, AI-powered school/, "with the tier's promise");
    assert.ok(upsell.querySelectorAll(".sub-benefit-group li").length > 3, "and the benefits that come with it");
    assert.match(upsell.textContent, /₦200,000/, "with the price");
    assert.match(upsell.textContent, /save ₦40,000/, "and the yearly saving");
    const upsellUpgrade = upsell.querySelector("[data-upsell-upgrade]");
    assert.match(upsellUpgrade.textContent, /Upgrade to Premium/, "one obvious action");

    upsellUpgrade.dispatchEvent(new page.window.Event("click", { bubbles: true }));
    await sleep(1200);
    assert.ok(!page.doc.querySelector(".sub-upsell-backdrop"), "the upsell closes");
    const premiumModal = page.doc.querySelector(".dash-modal");
    assert.ok(premiumModal, "and hands over to the upgrade form");
    assert.match(premiumModal.textContent, /Upgrade to Premium/);
    assert.ok(premiumModal.querySelector("#subUpgradeForm"), "ready to submit");

    /* ------------------------------- hygiene -------------------------- */
    const noisy = page.errors.filter((e) => !/Could not parse CSS|Error: Not implemented/i.test(e));
    assert.deepEqual(noisy, [], "no script errors while selling the tiers");
  } finally {
    page.close();
  }
});

test("a teacher sees the explanation without an upgrade button they cannot use", { skip }, async () => {
  const page = await openTeacher(ctx.base, "teacher-a");
  try {
    // The upsell lives in subscription.js, which the SPA loads on EVERY page —
    // so a gated action in the teacher workspace is answered, not swallowed.
    assert.ok(page.window.EduSphereUpsell, "the upsell dialog is loaded in the teacher workspace");
    let gateError = null;
    await page.window.API.get("/payroll/structures").catch((e) => { gateError = e; });
    assert.ok(gateError, "payroll is refused for a teacher on Free");
    assert.equal(gateError.data.can_upgrade, false, "the refusal says a teacher is not the buyer");
    await sleep(700);
    const upsell = page.doc.querySelector(".sub-upsell-backdrop");
    assert.ok(upsell, "the dialog still explains itself");
    assert.match(upsell.textContent, /Ask your school administrator/i);
    assert.ok(!upsell.querySelector("[data-upsell-upgrade]"), "with no upgrade button");
    upsell.querySelector("[data-upsell-close]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
    await sleep(300);
    assert.ok(!page.doc.querySelector(".sub-upsell-backdrop"), "and it closes");
    const noisy = page.errors.filter((e) => !/Could not parse CSS|Error: Not implemented/i.test(e));
    assert.deepEqual(noisy, [], "no script errors in the teacher workspace");
  } finally {
    page.close();
  }
});
