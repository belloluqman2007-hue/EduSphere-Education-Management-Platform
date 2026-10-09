"use strict";
/* ============================================================================
   IDENTITY, ID CARDS AND CERTIFICATES — browser-level regression (jsdom)
   ----------------------------------------------------------------------------
   These are the three things that used to be impossible in the interface:
     • changing a profile picture at all,
     • printing an ID card for a member of staff (students only, before),
     • editing a certificate without being handed a textarea of raw HTML.
   The server-side print tests cover the paper; this file drives the real SPA
   against the real API and proves the *screens* exist, are wired to the right
   endpoints, and run without a script error — which under a `script-src 'self'`
   Content Security Policy is the difference between a feature and a dead button.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, PASSWORD } = require("./helpers");
initEnv();

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch (e) { /* production install */ }
const skip = !JSDOM ? "jsdom devDependency not installed" : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openAdmin(base, username) {
  let cookie = "";
  const errors = [];
  const opened = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (error) => {
    // jsdom has no canvas and no media pipeline; the avatar editor and the
    // camera scanner legitimately need both, so those are not UI defects.
    if (!/Not implemented: window\.(scrollTo|HTMLCanvasElement|alert)|getContext|getUserMedia/i.test(String(error.message))) errors.push(String(error.message));
  });
  vc.on("error", (...args) => errors.push(args.map(String).join(" ")));
  const dom = await JSDOM.fromURL(base + "/admin", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.confirm = () => true;
      // window.open is how every print document is launched; record the URL the
      // UI asked for instead of pretending a printer exists.
      window.open = (url) => { opened.push(String(url)); return null; };
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
    window, doc: window.document, errors, opened,
    content: () => window.document.querySelector("#dashContent"),
    async route(route) { window.BelloDashboard.go(route); await sleep(1100); },
    click(el) { el.dispatchEvent(new window.Event("click", { bubbles: true })); },
    close() { window.close(); },
  };
}

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { if (ctx) await ctx.close(); });

test("ID card screen prints student AND staff cards and carries a camera verifier", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-a");
  try {
    assert.ok(page.window.EduProfile, "the portrait module is loaded");
    assert.ok(page.window.EduScanner, "the card scanner module is loaded");
    assert.ok(page.window.EduCertificates, "the certificate designer module is loaded");

    // The screen moved under "Documents" because it is no longer students-only.
    const group = [...page.doc.querySelectorAll(".dash-nav-link")].find((b) => b.textContent.trim() === "Documents");
    assert.ok(group, "Documents group present in the sidebar");
    page.click(group);
    await sleep(150);
    const labels = [...page.doc.querySelectorAll(".dash-nav-sub.is-open button")].map((b) => b.textContent.trim());
    assert.ok(labels.includes("ID Cards"), "ID Cards is a documents screen now");

    await page.route("students/id-cards");
    let content = page.content();
    assert.match(content.querySelector("h2").textContent, /ID Cards/);
    const tabs = [...content.querySelectorAll("[data-idc-tab]")].map((b) => b.getAttribute("data-idc-tab"));
    assert.deepEqual(tabs, ["student", "teacher"], "both card audiences are one screen apart");

    // --- the staff half, which did not exist before
    page.click(content.querySelector('[data-idc-tab="teacher"]'));
    await sleep(700);
    content = page.content();
    assert.ok(content.querySelector("#idCardStaffRole"), "staff cards can be narrowed by role");
    page.click(content.querySelector("#printStaffFronts"));
    await sleep(150);
    assert.ok(
      page.opened.some((url) => /\/documents\/staff-id-card\/bulk\?side=front/.test(url)),
      `staff fronts go to the staff print endpoint (saw: ${page.opened.join(" | ")})`
    );
    page.click(content.querySelector("#printStaffBacks"));
    await sleep(150);
    assert.ok(page.opened.some((url) => /staff-id-card\/bulk\?side=back/.test(url)), "staff backs are a separate sheet");

    // --- the registry: what has been issued, and can it still be used
    const registry = content.querySelector("#idCardRegistry");
    assert.match(registry.textContent, /cards/i, "the registry lists cards");
    assert.ok(registry.querySelector("[data-card-print]"), "a listed card can be reprinted");

    // --- verification, because a QR nobody can check is decoration
    const scanner = content.querySelector("[data-scanner]");
    assert.ok(scanner, "the screen embeds a scanner");
    assert.equal(scanner.getAttribute("data-endpoint"), "/api/public/card/", "it reads this school's public lookup");
    assert.ok(scanner.querySelector("[data-scanner-open]"), "camera button present");
    assert.ok(scanner.querySelector("[data-scanner-check]"), "typed-code fallback present");
    assert.ok(content.querySelector("[data-scanner-result]"), "the answer renders inline");

    assert.deepEqual(page.errors, [], "no script errors while driving the card screen");
  } finally { page.close(); }
});

test("certificate templates are chosen from a gallery, never edited as HTML", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-a");
  try {
    await page.route("documents/templates");
    let content = page.content();
    assert.match(content.querySelector("h2").textContent, /Certificate Templates/);
    assert.ok(content.querySelector("#addCertificateTemplate"), "a template can be created");
    assert.ok(
      !content.querySelector("#certificateHtmlTemplate"),
      "the raw-HTML textarea is gone from the list screen"
    );

    page.click(content.querySelector("#addCertificateTemplate"));
    await sleep(700);
    const modal = page.doc.querySelector(".dash-modal");
    assert.ok(modal, "the designer opened in the shared modal");
    assert.ok(modal.classList.contains("cd-modal"), "it gets the designer layout");

    // A gallery of real previews, each selectable.
    const designs = [...modal.querySelectorAll("[data-design]")];
    assert.ok(designs.length >= 5, `several preset designs are offered (saw ${designs.length})`);
    assert.ok(modal.querySelector(".cd-thumb-frame"), "each design shows the rendered page, not a label");

    // Ordinary labelled fields — the whole point of the redesign.
    for (const key of ["title", "kicker", "body", "award", "closing"]) {
      assert.ok(modal.querySelector(`[data-cd="${key}"]`), `the ${key} field is a form field`);
    }
    assert.ok(modal.querySelector("[data-cd-facts]"), "which facts to print is a choice, not markup");
    assert.ok(modal.querySelector("[data-cd-signatory]"), "a signatory row is present");
    assert.ok(modal.querySelector("[data-sig-user]"), "a signatory is picked from real staff accounts");
    assert.ok(modal.querySelector("[data-cd-frame]"), "the editor previews the printed page");
    assert.ok(
      !modal.querySelector("[data-cd=\"html\"], #certificateHtmlTemplate, textarea[name=html_template]"),
      "there is no HTML editor anywhere in the designer"
    );

    // Choosing a different design is a click, and it is remembered as the selection.
    page.click(designs[1]);
    await sleep(150);
    assert.equal(designs[1].getAttribute("aria-checked"), "true", "the gallery behaves like radios");

    assert.deepEqual(page.errors, [], "no script errors while opening the designer");
  } finally { page.close(); }
});

test("a profile picture can be changed from every screen that shows a person", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-a");
  try {
    // Students: the profile hero is the picture everyone expects to be able to fix.
    await page.route("students/all");
    let content = page.content();
    page.click(content.querySelector("[data-profile]"));
    await sleep(900);
    let modal = page.doc.querySelector(".dash-modal");
    assert.ok(modal, "the student profile opened");
    let host = modal.querySelector("#profileAvatarHost");
    assert.ok(host, "the profile hero carries the portrait control");
    assert.ok(host.classList.contains("pp-trigger"), "the portrait is clickable, not decorative");
    assert.equal(host.getAttribute("role"), "button", "and it is a real button to a keyboard");

    // Staff directory: the teacher profile is where a member of staff is managed,
    // and it now carries the same portrait control and the signature that
    // certificates print — previously there was no way to set either.
    page.click(modal.querySelector(".dash-modal-close"));
    await sleep(200);
    await page.route("teachers/all");
    content = page.content();
    page.click(content.querySelector("[data-teacher-profile]"));
    await sleep(900);
    modal = page.doc.querySelector(".dash-modal");
    assert.ok(modal, "the teacher profile opened");
    const heroAvatar = modal.querySelector("#tcProfileAvatar");
    assert.ok(heroAvatar && heroAvatar.classList.contains("pp-trigger"), "the hero portrait opens the picture picker");
    const strip = modal.querySelector("#tcTeacherIdentity");
    assert.ok(strip && strip.querySelector("[data-pp-staff-avatar]"), "the identity strip offers a portrait control");
    assert.ok(strip.querySelector("[data-pp-staff-signature]"), "and a signature pad");
    assert.ok(strip.querySelector("[data-pp-staff-card]"), "and printing the staff ID card");
    page.click(strip.querySelector("[data-pp-staff-card]"));
    await sleep(150);
    assert.ok(page.opened.some((url) => /\/documents\/staff-id-card\/\d+/.test(url)), "the staff card print URL is used");

    // Own account: every role can fix its own picture without an intermediary.
    page.click(modal.querySelector(".dash-modal-close"));
    await sleep(200);
    await page.route("settings/account");
    content = page.content();
    const card = content.querySelector(".account-identity");
    assert.ok(card, "the account screen shows the identity card");
    assert.ok(card.querySelector("[data-pp-avatar-host]"), "with the portrait control");
    assert.ok(card.querySelector("[data-pp-signature]"), "and a signature that can be drawn");
    // The card panel sits beside the identity card (it fetches its own state), so
    // it is asserted against the page rather than the card.
    const own = content.querySelector(".my-card");
    assert.ok(own, "the person's own card panel is on the account screen");
    assert.ok(
      own.querySelector("[data-scanner-check]") || /no card has been issued/i.test(own.textContent),
      "it either offers a live code check or says plainly that no card exists yet"
    );

    assert.deepEqual(page.errors, [], "no script errors while driving the portrait controls");
  } finally { page.close(); }
});
