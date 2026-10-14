"use strict";
/* ============================================================================
   SCANNING A CARD AGAINST THE REAL SERVER — the CSRF handshake
   ----------------------------------------------------------------------------
   Marking attendance from a scanned card is a state-changing call, so the real
   server answers it 403 unless it carries the session's double-submit token
   (server/routes/auth.js csrfGuard). The scanner posts with its own fetch, so
   it must fetch that token itself — and this file proves it against the real
   Express app with a real signed-in session, not against a stub.

   Three layers, because the bug that prompted this file slipped through all of
   them at once:

     1. The real public/js/api.js and public/js/card-scanner.js run in jsdom,
        their fetch is bridged to the booted server with the admin's session
        cookie, and a scan must actually move the register. A 403 here fails
        the suite.
     2. The same POST without the header is refused with the server's own
        message, so a regression that drops it cannot pass by accident.
     3. A source guard: no state-changing fetch anywhere in public/js may bypass
        window.API without naming the token, unless it can only reach the
        session-less /api/public surface.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch (e) { /* production install */ }
const skip = !JSDOM ? "jsdom devDependency not installed" : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PUBLIC_JS = path.join(__dirname, "..", "public", "js");
const readScript = (name) => fs.readFileSync(path.join(PUBLIC_JS, name), "utf8");
const SCANNER_SRC = readScript("card-scanner.js");
const API_SRC = readScript("api.js");

let ctx, adminA;

before(async () => {
  if (!JSDOM) return;
  ctx = await setup();
  adminA = new Client(ctx.base);
  await adminA.login("admin-a", PASSWORD);
});
after(async () => { if (ctx) await ctx.close(); });

/** Rendering a card mints its credential; the registry reads the code back. */
async function cardCode(client, holderType, holderId) {
  const page = await client.req("GET", `/api/documents/id-card/${holderId}`);
  assert.equal(page.status, 200, `card render failed: ${page.status}`);
  const credential = await client.api("GET", `/api/documents/card/${holderType}/${holderId}/credential`);
  assert.equal(credential.status, 200, JSON.stringify(credential.data));
  return credential.data.credential.code;
}

/**
 * A jsdom page whose fetch is bridged to the booted server with this client's
 * session cookie — a browser on the dashboard, without a browser.
 */
function openBrowser(html, client) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: `${ctx.base}/attendance`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  window.fetch = (url, init) => {
    const options = init || {};
    const target = /^https?:/i.test(String(url)) ? String(url) : ctx.base + String(url);
    const headers = Object.assign({}, options.headers || {});
    // jsdom has no cookie jar; the browser would send the session cookie here.
    headers.Cookie = client.cookieHeader();
    calls.push({ url: String(url), method: String(options.method || "GET").toUpperCase(), headers });
    return fetch(target, { method: options.method || "GET", headers, body: options.body });
  };
  // The real dashboard loads api.js first, then card-scanner.js.
  window.eval(API_SRC);
  window.eval(SCANNER_SRC);
  window.EduScanner.initAll(window.document);
  return { window, document: window.document, calls, dom };
}

const scanHtml = (extra) => `<div data-scanner data-mark-endpoint="/api/attendance/scan" ${extra}>
    <input type="text" name="code" autocomplete="off">
    <button type="button" data-scanner-open>Scan with camera</button>
    <button type="button" data-scanner-check>Check</button>
  </div>
  <p data-scanner-error hidden></p>
  <div data-scanner-result></div>`;

test("a signed-in scan marks the register through the server's CSRF guard", { skip }, async () => {
  const code = await cardCode(adminA, "student", ctx.studentA1);
  const day = "2026-10-15";
  const page = openBrowser(scanHtml(`data-mark-auto="1" data-mark-status="late" data-scan-date="${day}"`), adminA);
  try {
    page.document.querySelector("input[name=code]").value = code;
    page.document.querySelector("[data-scanner-check]").click();
    for (let i = 0; i < 400 && !page.document.querySelector("[data-scanner-result] .scan-result"); i++) await sleep(10);

    const error = page.document.querySelector("[data-scanner-error]");
    assert.equal(error.hidden, true, `the scan failed: ${error.textContent}`);
    const result = page.document.querySelector("[data-scanner-result] .scan-result");
    assert.ok(result, "the server's answer is displayed");
    assert.match(result.textContent, /Marked late/, "the operator is told the register moved");
    assert.match(result.textContent, /Alpha One/, "and who it moved for");

    // The scanner asked the real endpoint for the token, then posted with it —
    // through the dashboard's own api.js, so the two agree on the path.
    const tokenCall = page.calls.find((call) => /\/csrf-token$/.test(call.url));
    assert.ok(tokenCall, `no CSRF token was requested: ${JSON.stringify(page.calls.map((c) => c.url))}`);
    const post = page.calls.find((call) => call.method === "POST");
    assert.equal(post.url, "/api/attendance/scan", "the marking call went to the real endpoint, not /api/api/...");
    assert.ok(post.headers["X-CSRF-Token"], "the marking POST carried a token");

    // And the register really moved: the guard let a real write through.
    const register = await adminA.api("GET", `/api/attendance?classId=${ctx.classA1}&date=${day}`);
    assert.equal(register.status, 200);
    const alpha = register.data.students.find((row) => row.id === ctx.studentA1);
    assert.equal(alpha.status, "late");
  } finally {
    page.window.close();
  }
});

test("the same write without the header is refused, and with it is accepted", { skip }, async () => {
  const code = await cardCode(adminA, "student", ctx.studentA2);
  const day = "2026-10-16";
  const body = JSON.stringify({ code, date: day, status: "present" });
  const send = (headers) => fetch(`${ctx.base}/api/attendance/scan`, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json", Cookie: adminA.cookieHeader() }, headers),
    body,
  });

  // This is exactly what the scanner used to send, and why the operator saw
  // "CSRF token missing or invalid".
  const bare = await send({});
  assert.equal(bare.status, 403, "a marking POST with no token is refused");
  assert.match((await bare.json()).error, /CSRF token missing or invalid/);

  const stale = await send({ "X-CSRF-Token": "not-the-session-token" });
  assert.equal(stale.status, 403, "a forged token is refused");

  const stamped = await send({ "X-CSRF-Token": await adminA.csrf() });
  assert.equal(stamped.status, 200, JSON.stringify(await stamped.clone().json()));
  assert.equal((await stamped.json()).marked, true, "the session's own token is what makes the write land");
});

test("the public verification page still works for a stranger: no session, no token", { skip }, async () => {
  const code = await cardCode(adminA, "student", ctx.studentA1);
  const stranger = new Client(ctx.base); // no cookies at all — a phone at a gate

  const page = await stranger.req("GET", `/verify/${code}`);
  assert.equal(page.status, 200, "the QR's URL renders for anyone");
  const html = await page.res.text();
  assert.match(html, /\/js\/card-scanner\.js/, "the page ships the scanner");
  assert.ok(!/data-mark-endpoint/.test(html), "the public page can only read a card: it carries no marking endpoint");

  const lookup = await fetch(`${ctx.base}/api/public/card/${code}`, { headers: { Accept: "application/json" } });
  assert.equal(lookup.status, 200, "a card is checked with no cookie and no token");
  const view = await lookup.json();
  assert.equal(view.card.valid, true);
  assert.equal(view.card.code, code);

  // …and nothing can be written from that page: no session, no token, and the
  // register stays exactly as it was.
  const write = await fetch(`${ctx.base}/api/attendance/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, date: "2026-10-19" }),
  });
  assert.equal(write.status, 403, "a session-less write is refused");
  const register = await adminA.api("GET", `/api/attendance?classId=${ctx.classA1}&date=2026-10-19`);
  assert.equal(register.data.students.find((row) => row.id === ctx.studentA1).status, "", "no register was touched");
});

/* ---------------------------------------------------------------------------
   Source guard — the check that would have caught this bug in review.

   api.js attaches X-CSRF-Token to every state-changing call in one place. Any
   OTHER file that calls fetch with a mutating method must either name the token
   itself or only ever reach /api/public (mounted before the session and CSRF
   middleware). The check reads the call site and the function it sits in, so
   the token may be attached just above the call.
--------------------------------------------------------------------------- */
function fetchCallSites(source) {
  const sites = [];
  const pattern = /fetch\(/g;
  let match;
  while ((match = pattern.exec(source))) {
    let depth = 0;
    let end = match.index + match[0].length;
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") { if (depth === 0) { end = i + 1; break; } depth--; }
    }
    sites.push({ text: source.slice(match.index, end), index: match.index });
  }
  return sites;
}

/** The function a call site lives in, found by walking back to its head. */
function enclosingFunction(source, index) {
  const head = source.lastIndexOf("function", index);
  const arrow = source.lastIndexOf("=>", index);
  const start = Math.max(head, arrow < 0 ? -1 : arrow - 40);
  if (start < 0) return source.slice(Math.max(0, index - 600), index);
  return source.slice(start, index);
}

const MUTATING = /method:\s*["'](POST|PUT|PATCH|DELETE)["']/;
const TOKEN = /X-CSRF-Token/;

/** Every .js file under public/js, vendor bundles included. */
function allScripts(dir, prefix) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...allScripts(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".js")) found.push(rel);
  }
  return found;
}

test("no state-changing fetch in public/js bypasses CSRF protection", () => {
  const violations = [];
  for (const name of allScripts(PUBLIC_JS, "")) {
    const source = fs.readFileSync(path.join(PUBLIC_JS, name), "utf8");
    // api.js is where the token is attached for everyone else, by design.
    if (name === "api.js") {
      assert.ok(TOKEN.test(source), "api.js attaches the token to every mutating call");
      continue;
    }
    for (const site of fetchCallSites(source)) {
      if (!MUTATING.test(site.text)) continue;
      if (TOKEN.test(site.text) || TOKEN.test(enclosingFunction(source, site.index))) continue;
      // The pre-session surface: /api/public is mounted before the session and
      // CSRF middleware, so it is closed to session-cookie writes by design.
      if (/\/api\/public\//.test(site.text) || /\/api\/public\//.test(enclosingFunction(source, site.index))) continue;
      const line = source.slice(0, site.index).split("\n").length;
      violations.push(`${name}:${line} sends ${MUTATING.exec(site.text)[1]} without an X-CSRF-Token header`);
    }
  }

  assert.deepEqual(violations, [], `state-changing fetch calls with no CSRF token:\n${violations.join("\n")}`);
});
