"use strict";
/* ============================================================================
   PROFILE PICTURE — one hit target, and a teacher portrait that actually saves
   ----------------------------------------------------------------------------
   Two defects reported by a school and fixed together, because they were the
   same feature seen from both ends:

   1. SAVING A TEACHER PICTURE RETURNED 500. Every portrait/signature route in
      server/routes/teachers.js calls into services/profile-media (decode the
      canvas data URL, check the magic bytes, write disk + media_files), but the
      module was never required in that file. A ReferenceError inside an
      asyncHandler is not a 4xx the user can act on — it is "Internal server
      error", and it hit the admin editing a staff portrait and the teacher
      editing their own, through one shared call path. Students, the account
      page and the institution logo all worked, which is exactly why the hole
      survived: nothing exercised this route.

   2. CLICKING ANYWHERE AROUND THE PICTURE OPENED THE PICKER. attachAvatar()
      paints a "Change photo" film over the portrait with `position: absolute`
      and `inset: 0`. Absolutely positioned boxes are sized against the nearest
      POSITIONED ancestor — and the trigger host was statically positioned, so
      inside a dashboard modal the film was measured against
      .dash-modal-backdrop (position: fixed, the whole viewport). An invisible
      layer then covered the screen, and every stray click on it bubbled to the
      host and opened the editor. The fix makes the trigger its own containing
      block, shrink-wraps it to the avatar, and sets `pointer-events: none` on
      the film so it can never be the thing a click lands on; the handler then
      ignores any click that missed the portrait box so the surrounding padding
      belongs to the row or card underneath.

   Part one is driven over real HTTP against a real database and real files;
   part two is driven in jsdom against the real SPA with the geometry the
   browser would supply.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch (e) { /* production install */ }
const skipJsdom = !JSDOM ? "jsdom devDependency not installed" : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ROOT = path.join(__dirname, "..");

/** A real PNG — a 1×1 stub trips the server's "too small to print" guards. */
function pngDataUrl(width, height) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0)]);
  for (let x = 0; x < width; x++) { row[1 + x * 4] = 40; row[2 + x * 4] = 90; row[3 + x * 4] = 140; row[4 + x * 4] = 255; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const crc32 = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const makeChunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, body])), 0);
    return Buffer.concat([len, type, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk(Buffer.from("IHDR"), ihdr),
    makeChunk(Buffer.from("IDAT"), zlib.deflateSync(raw, { level: 6 })),
    makeChunk(Buffer.from("IEND"), Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}
const pngBytes = (width, height) => Buffer.from(pngDataUrl(width, height).split(",")[1], "base64");

/** Multipart upload with one file field, as the browser's picker sends it. */
async function uploadFile(client, url, field, body, mime, filename) {
  const form = new FormData();
  form.append(field, new Blob([body], { type: mime }), filename);
  const token = await client.csrf();
  const res = await fetch(client.base + url, {
    method: "POST", headers: { Cookie: client.cookieHeader(), "X-CSRF-Token": token }, body: form,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, data };
}

let ctx;
let admin;
let teacher;
let adminB;

before(async () => {
  ctx = await setup();
  admin = new Client(ctx.base);
  assert.equal((await admin.login("admin-a", PASSWORD)).status, 200);
  teacher = new Client(ctx.base);
  assert.equal((await teacher.login("teacher-a", PASSWORD)).status, 200);
  adminB = new Client(ctx.base);
  assert.equal((await adminB.login("admin-b", PASSWORD)).status, 200);
});
after(async () => { if (ctx) await ctx.close(); });

/* ------------------------------ 1: the 500 ------------------------------ */

test("an administrator saves a teacher portrait from the cropped image the browser sends", async () => {
  const r = await admin.api("POST", `/api/teachers/${ctx.users.teacherA}/photo`, { photoDataUrl: pngDataUrl(240, 240) });
  assert.equal(r.status, 200, `saving a staff portrait must not 500 (got ${r.status}: ${JSON.stringify(r.data)})`);
  const photoPath = r.data && r.data.photoPath;
  assert.match(photoPath || "", /^\/uploads\/teacher-photos\//, "the portrait is stored under its own context");

  // The picture is read from two places, and both have to agree.
  const profile = await ctx.db.get("SELECT photo_path FROM teacher_profiles WHERE user_id = ? AND madrasa_id = ?", [ctx.users.teacherA, ctx.madrasaA]);
  const account = await ctx.db.get("SELECT photo_path FROM users WHERE id = ?", [ctx.users.teacherA]);
  assert.equal(profile.photo_path, photoPath, "the staff record (directory, ID card) holds it");
  assert.equal(account.photo_path, photoPath, "and so does the account (portal header)");

  const served = await fetch(ctx.base + photoPath, { headers: { Cookie: admin.cookieHeader() } });
  assert.equal(served.status, 200, "the stored file is served back to its school");
  assert.match(served.headers.get("content-type") || "", /^image\/png/, "as an image");
  assert.equal((await fetch(ctx.base + photoPath)).status, 404, "anonymous access is denied");
  assert.equal((await adminB.req("GET", photoPath)).status, 404, "another school cannot read the portrait");
});

test("a teacher replaces their own portrait without an administrator", async () => {
  const r = await teacher.api("POST", `/api/teachers/${ctx.users.teacherA}/photo`, { photoDataUrl: pngDataUrl(200, 200) });
  assert.equal(r.status, 200, `a teacher's own portrait must save (got ${r.status}: ${JSON.stringify(r.data)})`);
  const row = await ctx.db.get("SELECT photo_path FROM users WHERE id = ?", [ctx.users.teacherA]);
  assert.equal(row.photo_path, r.data.photoPath, "written on the account row");
});

test("a teacher portrait also saves as a multipart file upload", async () => {
  const r = await uploadFile(admin, `/api/teachers/${ctx.users.teacherA}/photo`, "photo", pngBytes(220, 220), "image/png", "staff.png");
  assert.equal(r.status, 200, `a file upload must save too (got ${r.status}: ${JSON.stringify(r.data)})`);
  assert.match((r.data && r.data.photoPath) || "", /^\/uploads\/teacher-photos\/.+\.png$/, "stored with a generated image name");
});

test("a teacher signature saves, and removing the portrait clears both rows", async () => {
  const sig = await admin.api("PUT", `/api/teachers/${ctx.users.teacherA}/signature`, { signatureDataUrl: pngDataUrl(300, 120) });
  assert.equal(sig.status, 200, `the signature route shares the same service (got ${sig.status}: ${JSON.stringify(sig.data)})`);
  assert.match((sig.data && sig.data.signaturePath) || "", /^\/uploads\/signatures\//);

  const removed = await admin.api("DELETE", `/api/teachers/${ctx.users.teacherA}/photo`, {});
  assert.equal(removed.status, 200, `removing a portrait must not 500 (got ${removed.status}: ${JSON.stringify(removed.data)})`);
  const profile = await ctx.db.get("SELECT photo_path FROM teacher_profiles WHERE user_id = ? AND madrasa_id = ?", [ctx.users.teacherA, ctx.madrasaA]);
  const account = await ctx.db.get("SELECT photo_path FROM users WHERE id = ?", [ctx.users.teacherA]);
  assert.equal(profile.photo_path, "", "cleared on the staff record");
  assert.equal(account.photo_path, "", "and on the account");
});

test("the ID card the portrait prints on is reachable for the same teacher", async () => {
  // Same class of defect, same file: `cardCreds` was used without being
  // required, so the card beside the picture answered 500 as well.
  const r = await admin.api("GET", `/api/teachers/${ctx.users.teacherA}/card`);
  assert.equal(r.status, 200, `the staff card must load (got ${r.status}: ${JSON.stringify(r.data)})`);
  assert.match(r.data.credential.code, /^[0-9a-f]{24}$/, "with the permanent code printed under the QR");
});

test("one madrasa cannot write a portrait onto another madrasa's teacher", async () => {
  const r = await adminB.api("POST", `/api/teachers/${ctx.users.teacherA}/photo`, { photoDataUrl: pngDataUrl(240, 240) });
  assert.equal(r.status, 404, `cross-tenant writes are refused, not answered with a 500 (got ${r.status})`);
});

test("a disguised upload on the teacher route is not stored as HTML", async () => {
  const r = await uploadFile(admin, `/api/teachers/${ctx.users.teacherA}/photo`, "photo",
    Buffer.from("<script>alert(document.cookie)</script>"), "image/png", "evil.html");
  const stored = (JSON.stringify(r.data || "").match(/\/uploads\/[^"\\]+/) || [])[0] || null;
  if (stored) {
    assert.ok(!/\.html?$/i.test(stored), `the stored name is generated, never the client's (got ${stored})`);
    assert.match(stored, /\.(png|jpe?g|webp)$/, "with an extension from the allowed image types");
  }
});

/* --------------------------- 2: the click target --------------------------- */

test("the portrait film can never be a page-wide click magnet", () => {
  const css = fs.readFileSync(path.join(ROOT, "public", "css", "profile-documents.css"), "utf8");
  const rule = (selector) => {
    const at = css.indexOf(selector + " {");
    assert.ok(at >= 0, `${selector} is styled`);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.match(rule(".pp-trigger"), /position:\s*relative/, "the trigger is its own containing block, so the film is measured against the picture");
  assert.match(rule(".pp-trigger"), /width:\s*fit-content/, "and shrink-wrapped to it, so a stretched cell is not part of the button");
  assert.match(rule(".pp-overlay"), /pointer-events:\s*none/, "the film itself is never what a click lands on");
});

test("clicking the portrait opens the editor; clicking beside it does not", { skip: skipJsdom }, async () => {
  let cookie = "";
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (error) => {
    if (!/Not implemented: window\.(scrollTo|HTMLCanvasElement|alert)|getContext|getUserMedia/i.test(String(error.message))) errors.push(String(error.message));
  });
  vc.on("error", (...args) => errors.push(args.map(String).join(" ")));
  const dom = await JSDOM.fromURL(ctx.base + "/admin", {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.confirm = () => true;
      window.open = () => null;
      window.fetch = async (input, init = {}) => {
        const url = String(input).startsWith("http") ? input : ctx.base + input;
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
  try {
    for (let i = 0; i < 80 && !window.document.querySelector("#dashLoginForm"); i++) await sleep(50);
    window.document.querySelector("#dlUser").value = "admin-a";
    window.document.querySelector("#dlPass").value = PASSWORD;
    window.document.querySelector("#dashLoginForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 100 && !window.document.querySelector("#dashContent"); i++) await sleep(50);
    window.BelloDashboard.go("settings/account");
    await sleep(1200);

    const host = window.document.querySelector(".account-identity [data-pp-avatar-host]");
    assert.ok(host, "the account card carries the portrait control");
    // The trigger owns its own box instead of borrowing the page's.
    assert.equal(host.style.position, "relative", "the host is the containing block for the film");
    assert.equal(host.getAttribute("role"), "button", "the picture is a real button to a keyboard");
    const film = host.querySelector(".pp-overlay");
    assert.ok(film, "the hover film exists");
    assert.equal(film.getAttribute("aria-hidden"), "true", "and is decoration, not a second control");

    // jsdom has no layout engine, so hand the picture the box a browser would.
    const picture = host.querySelector(".pp-avatar");
    assert.ok(picture, "the portrait is inside the trigger");
    picture.getBoundingClientRect = () => ({ left: 0, top: 0, right: 88, bottom: 88, width: 88, height: 88, x: 0, y: 0 });

    const clickAt = (x, y, on) => (on || host).dispatchEvent(new window.MouseEvent("click", {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }));

    // Beside the picture: the padding belongs to the card, and must not open.
    clickAt(400, 300);
    await sleep(150);
    assert.equal(window.document.querySelector(".pp-dialog"), null, "clicking beside the portrait does not open the picker");

    // On the picture: it opens, exactly once.
    clickAt(40, 40, picture);
    await sleep(250);
    const dialog = window.document.querySelector(".pp-dialog");
    assert.ok(dialog, "clicking the portrait opens the picker");
    assert.equal(window.document.querySelectorAll(".pp-dialog").length, 1, "and one dialog, not one per listener");
    assert.match(dialog.textContent, /Change profile picture|Choose image/, "the editor offers to pick a new picture");

    dialog.querySelector("[data-pp-close]").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
    await sleep(150);
    assert.equal(window.document.querySelector(".pp-dialog"), null, "and closes again");

    // The keyboard path is a button press with no pointer, so it must keep
    // working exactly as the picture click does.
    host.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    await sleep(250);
    const viaKey = window.document.querySelector(".pp-dialog");
    assert.ok(viaKey, "Enter on the focused portrait opens the picker too");
    viaKey.querySelector("[data-pp-close]").dispatchEvent(new window.Event("click", { bubbles: true }));
    await sleep(150);
    assert.equal(window.document.querySelector(".pp-dialog"), null, "and Escape-equivalent close returns to the profile");

    assert.deepEqual(errors, [], "no script error while driving the portrait control");
  } finally { window.close(); }
});
