"use strict";
/* ============================================================================
   PROFILE PHOTO + CERTIFICATE ISSUE — browser-level regression (jsdom)
   ----------------------------------------------------------------------------
   Two flows that broke in the interface and are now pinned here:

   1. Changing a profile picture. Picking a photo used to throw
      "Cannot set properties of null (setting 'src')" — the crop preview <img>
      carries a data-pp-image attribute but the editor queried a .pp-image
      class that does not exist — so no preview ever painted and the dialog
      reported an error the moment a file was chosen.
   2. Issuing a certificate. "Issue Certificate" claimed no template existed
      even when one did, because the dashboard filters templates on
      `is_active`, a field the templates endpoint never returned.

   Both are driven here through the real SPA against the real API: pick a
   photo, save it, watch the row change; open the issue wizard, tick a
   student, generate, watch the certificate land.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch (e) { /* production install */ }
const skip = !JSDOM ? "jsdom devDependency not installed" : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A real 1×1 PNG: the stubbed canvas returns it from toDataURL, and the
// server's magic-byte check accepts it, so the save exercises the real write.
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function openAdmin(base, username) {
  let cookie = "";
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (error) => {
    if (!/Not implemented: window\.(scrollTo|HTMLCanvasElement|alert)|getContext|getUserMedia/i.test(String(error.message))) errors.push(String(error.message));
  });
  vc.on("error", (...args) => errors.push(args.map(String).join(" ")));
  const dom = await JSDOM.fromURL(base + "/admin", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.confirm = () => true;
      window.open = () => null;
      // jsdom ships no image decoder and no canvas 2D context; stub just enough
      // of the decode → crop → encode pipeline for the editor's save path to
      // run for real (the network call and the database write are not stubbed).
      window.Image = class {
        constructor() { this.naturalWidth = 800; this.naturalHeight = 600; this.width = 800; this.height = 600; }
        set src(value) { this._src = value; setTimeout(() => { if (this.onload) this.onload(); }, 0); }
        get src() { return this._src; }
      };
      const proto = window.HTMLCanvasElement.prototype;
      proto.getContext = () => ({
        fillRect() {}, drawImage() {},
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }),
        fillStyle: null, strokeStyle: null, lineWidth: 1, lineJoin: null, lineCap: null,
        beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      });
      proto.toDataURL = () => TINY_PNG;
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
    click(el) { el.dispatchEvent(new window.Event("click", { bubbles: true })); },
    toasts: () => [...window.document.querySelectorAll(".dash-toast")].map((n) => n.textContent),
    close() { window.close(); },
  };
}

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { if (ctx) await ctx.close(); });

test("picking a photo paints the crop preview instead of throwing, and saving stores it", { skip }, async () => {
  const page = await openAdmin(ctx.base, "admin-a");
  try {
    await page.route("settings/account");
    const host = page.content().querySelector(".account-identity [data-pp-avatar-host]");
    assert.ok(host, "the account card carries the portrait control");
    page.click(host);
    await sleep(300);
    const dialog = page.doc.querySelector(".pp-dialog");
    assert.ok(dialog, "the editor dialog opened");

    const fileInput = dialog.querySelector("[data-pp-file]");
    assert.ok(fileInput, "the dialog offers a file picker");
    const pngBytes = Buffer.from(TINY_PNG.split(",")[1], "base64");
    const file = new page.window.File([pngBytes], "portrait.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await sleep(400);

    // The regression: this status line used to read
    // "Cannot set properties of null (setting 'src')".
    const status = dialog.querySelector("[data-pp-status]");
    assert.match(status.textContent, /loaded/, `picking a photo announces the image (saw: ${status.textContent})`);
    assert.ok(!/error|null/i.test(status.textContent), "picking a photo shows no error");
    const preview = dialog.querySelector("[data-pp-image]");
    assert.ok(preview && !preview.hidden, "the crop preview is painted and visible");

    page.click(dialog.querySelector("[data-pp-save]"));
    await sleep(1500);
    assert.ok(page.toasts().some((t) => /picture now appears everywhere/i.test(t)), "the save is confirmed with a toast");
    const row = await ctx.db.get("SELECT photo_path FROM users WHERE id = ?", [ctx.users.adminA]);
    assert.match(row.photo_path || "", /^\/uploads\//, "the portrait is stored on the account row");
    const served = await page.window.fetch(row.photo_path);
    assert.equal(served.status, 200, "and the stored file is served");
    assert.deepEqual(page.errors, [], "no script errors while changing a photo");
  } finally { page.close(); }
});

test("the issue wizard opens with an active template and generates a certificate", { skip }, async () => {
  const admin = new Client(ctx.base);
  assert.equal((await admin.login("admin-a", PASSWORD)).status, 200);
  const created = await admin.api("POST", "/api/documents/templates", {
    name: "UI Issue Test",
    type: "custom",
    config: { title: "Certificate of Achievement", body: "This certifies that {{holder_name}} completed the course." },
  });
  assert.equal(created.status, 200);
  const templateId = created.data.id;

  const page = await openAdmin(ctx.base, "admin-a");
  try {
    await page.route("documents/issue");
    // The regression: this screen used to say "You need at least one
    // certificate template before issuing" even with an active template.
    const wizard = page.doc.querySelector(".cd-issue");
    assert.ok(wizard, "the issue wizard opens when an active template exists");
    const templateSelect = wizard.querySelector("[data-issue-template]");
    assert.ok([...templateSelect.options].some((o) => Number(o.value) === Number(templateId)), "the template is selectable");

    const box = wizard.querySelector("[data-issue-student]");
    assert.ok(box, "students are listed to certify");
    box.checked = true;
    box.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await sleep(150);
    assert.match(wizard.querySelector("[data-issue-count]").textContent, /1 selected/);

    page.click(wizard.querySelector("[data-issue-go]"));
    await sleep(2000);
    assert.ok(page.toasts().some((t) => /certificate ready to print/i.test(t)), `issuing confirms with a toast (saw: ${page.toasts().join(" | ")})`);
    const rows = await ctx.db.all("SELECT id, verify_code FROM certificates WHERE template_id = ? AND student_id = ?", [templateId, ctx.studentA1]);
    assert.equal(rows.length, 1, "exactly one certificate was minted for the ticked student");
    assert.match(rows[0].verify_code, /^[0-9a-f]{24}$/, "with a permanent verification code");
    assert.deepEqual(page.errors, [], "no script errors while issuing a certificate");
  } finally { page.close(); }
});
