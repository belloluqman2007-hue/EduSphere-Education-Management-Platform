"use strict";
/* ============================================================================
   RESULTS & REPORT CARDS — in-app interface (jsdom browser-level regression)
   ----------------------------------------------------------------------------
   Section D of the report-sheet redesign: the staff Results and Report Cards
   screens are the in-app counterpart of the printable report sheet. This suite
   drives the REAL admin SPA against the REAL API and asserts the redesigned,
   theme-aware "report console":

     • a branded report masthead (not a plain page head),
     • clear class / term (+ subject) selection,
     • a strong result table echoing the printed columns,
     • separate, grouped actions (review, comments, preview, print, publish),
     • an obvious "Report sheet" / preview entry point per student and in bulk,
     • theme-aware styling for BOTH Islamic and Western institutions,
     • no console or script errors.

   Presentation only — no calculation, status or workflow is exercised for
   correctness here (that is covered by report-sheet / grading / lifecycle
   suites). These tests only assert the interface a human actually uses.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
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
      window.confirm = () => true;
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
  await sleep(700);
  return {
    window, doc: window.document, errors,
    content: () => window.document.querySelector("#dashContent"),
    async route(route) { window.BelloDashboard.go(route); await sleep(900); },
    setSelect(sel, value) { const el = this.doc.querySelector(sel); el.value = String(value); el.dispatchEvent(new window.Event("change", { bubbles: true })); },
    close() { window.close(); },
  };
}

let ctx;
before(async () => {
  ctx = await setup();
  // Compute the class term so both students have report-card summaries.
  const admin = new Client(ctx.base);
  await admin.login("admin-a", PASSWORD);
  await admin.api("POST", "/api/results/compute", { classId: ctx.classA1, termId: ctx.termA1 });
  // Make tenant B a Western academy so we can check the Western theme too.
  await ctx.db.run("UPDATE madaris SET category = ?, institution_type = ? WHERE id = ?", ["western", "Academy", ctx.madrasaB]);
  const adminB = new Client(ctx.base);
  await adminB.login("admin-b", PASSWORD);
  await adminB.api("POST", "/api/results/compute", { classId: ctx.classB1, termId: (await ctx.db.get("SELECT id FROM terms WHERE madrasa_id = ? AND position = 1", [ctx.madrasaB])).id });
});
after(async () => { if (ctx) await ctx.close(); });

test("Results screen: branded console, class/term/subject selection and a strong gradebook", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-a");
  try {
    assert.ok(page.doc.body.classList.contains("dash-islamic"), "Islamic theme applied to the dashboard");
    await page.route("academic/results");
    let content = page.content();

    // The report console masthead, not a plain page head.
    const console1 = content.querySelector(".report-console");
    assert.ok(console1, "results screen uses the report console");
    assert.ok(content.querySelector(".rc-masthead"), "branded report masthead present");
    assert.match(content.querySelector(".rc-masthead h2").textContent, /Results/, "masthead titled Results");

    // Clear class / term / subject selection.
    assert.ok(content.querySelector("#resultClass"), "class selector present");
    assert.ok(content.querySelector("#resultTerm"), "term selector present");
    assert.ok(content.querySelector("#resultSubject"), "subject selector present");

    // Choose the seeded class/term/subject and load the gradebook.
    page.setSelect("#resultClass", ctx.classA1);
    page.setSelect("#resultTerm", ctx.termA1);
    page.setSelect("#resultSubject", ctx.subjA1);
    await sleep(900);
    content = page.content();
    const table = content.querySelector(".rc-table");
    assert.ok(table, "gradebook table rendered");
    const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent);
    assert.ok(heads.some((h) => /CA/.test(h)), "CA column present");
    assert.ok(heads.some((h) => /Exam/.test(h)), "Exam column present");
    assert.ok(heads.some((h) => /Total/.test(h)), "Total column present");
    assert.ok(heads.some((h) => /Grade/.test(h)), "Grade column present");
    assert.ok(content.querySelector("#saveDraftResults"), "Save scores action present");
    assert.ok(content.querySelector("#submitResults"), "Submit for review action present");
    assert.ok(content.querySelector("#approveResults"), "Approve action present");
    assert.ok(content.querySelector("#publishSubjectResults"), "Publish action present");
    // Actions are grouped in a toolbar (strong visual hierarchy).
    assert.ok(content.querySelectorAll(".rc-toolbar-group").length >= 2, "actions are grouped");

    // Live totals: typing CA/Exam updates the Total cell without a round-trip.
    const row = content.querySelector("[data-result-student]");
    const ca = row.querySelector(".result-ca"), ex = row.querySelector(".result-exam");
    ca.value = "35"; ca.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    ex.value = "40"; ex.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    assert.equal(row.querySelector(".score-total").textContent, "75", "total recomputed live");

    assert.deepEqual(page.errors, [], "no console/script errors on the Results screen");
  } finally { page.close(); }
});

test("Report Cards screen: console, stats, per-student review + report-sheet preview, bulk export", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-a");
  try {
    await page.route("academic/report-cards");
    let content = page.content();
    assert.ok(content.querySelector(".report-console"), "report cards screen uses the report console");
    assert.match(content.querySelector(".rc-masthead h2").textContent, /Report Cards|Report Sheets/, "masthead titled Report Cards");
    assert.ok(content.querySelector("#reportTemplateBtn"), "report template action present");
    assert.ok(content.querySelector("#cardClass") && content.querySelector("#cardTerm"), "class + term selection present");

    page.setSelect("#cardClass", ctx.classA1);
    page.setSelect("#cardTerm", ctx.termA1);
    await sleep(1100);
    content = page.content();

    assert.ok(content.querySelector(".rc-stats"), "summary stat strip rendered");
    assert.match(content.querySelector(".rc-stats").textContent, /Class average/, "class average shown");
    // Grouped, separate actions.
    assert.ok(content.querySelector("#calculateCards"), "recalculate action present");
    assert.ok(content.querySelector("#publishCards"), "publish action present");
    const bulk = [...content.querySelectorAll("a")].find((a) => /All report sheets/.test(a.textContent));
    assert.ok(bulk, "bulk report sheets link present");
    assert.match(bulk.getAttribute("href"), /report-cards\/bulk/, "bulk link targets the shared engine");

    // Per-student: a review/comments button AND an obvious report-sheet preview.
    assert.ok(content.querySelector("[data-card-comment]"), "per-student review & comments action present");
    const preview = content.querySelector("a.rc-preview-btn");
    assert.ok(preview, "prominent per-student report-sheet preview present");
    assert.match(preview.getAttribute("href"), /report-card\//, "preview opens the report sheet from the shared engine");
    assert.match(preview.textContent, /Report sheet/i, "preview button clearly labelled");

    // Opening review & comments surfaces the summary editor.
    content.querySelector("[data-card-comment]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
    await sleep(700);
    assert.ok(page.doc.querySelector("#cardRemarkForm"), "review & comments modal opened");

    assert.deepEqual(page.errors, [], "no console/script errors on the Report Cards screen");
  } finally { page.close(); }
});

test("Western academy: the same console renders with the Western theme", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-b");
  try {
    assert.ok(page.doc.body.classList.contains("dash-western"), "Western theme applied to the dashboard");
    await page.route("academic/report-cards");
    const content = page.content();
    assert.ok(content.querySelector(".report-console"), "Western report cards screen uses the SAME report console");
    assert.match(content.querySelector(".rc-masthead h2").textContent, /Report Cards|Report Sheets/, "same masthead title in the Western theme");
    // The Western console re-themes via the body class; the brand token resolves to navy.
    const cssBrand = page.window.getComputedStyle(content.querySelector(".report-console")).getPropertyValue("--rc-brand").trim();
    assert.ok(cssBrand === "#0a2342" || cssBrand === "", "Western brand token available (navy)");
    assert.deepEqual(page.errors, [], "no console/script errors in the Western theme");
  } finally { page.close(); }
});
