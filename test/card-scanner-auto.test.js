"use strict";
/* ============================================================================
   CARD SCANNER — reads, checks and marks without pressing Check
   ----------------------------------------------------------------------------
   The attendance and ID-card screens used to stop at "type the code, press
   Check" on any browser without the built-in BarcodeDetector (Safari, iPhone,
   most Linux browsers). The camera now reads the QR itself, through the bundled
   jsQR decoder where needed, and the answer — who it is, whether they were
   marked — appears on screen with no further click.

   This drives the real card-scanner.js in a DOM with a fake camera. The decoder
   is stubbed to "see" a card code, so the test proves the flow (read → check →
   mark → result) rather than the optics.

   The stub fetch stands in for the server, so it enforces the server's rules:
   a state-changing call with no X-CSRF-Token is refused with the same 403 the
   real CSRF guard sends, and the stub itself fails the test rather than
   answering one. Marking a register from a scanner that forgot the token is the
   bug this file exists to catch, and it must break the suite, not the school.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch (e) { /* production install */ }
const skip = !JSDOM ? "jsdom devDependency not installed" : false;

const SCANNER_SRC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "card-scanner.js"), "utf8");
const CODE = "k3m9x2pq7r8t";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function markedPayload(overrides) {
  return Object.assign({
    ok: true,
    day: "2026-10-14",
    card: {
      valid: true, verdict: "valid", code: CODE, name: "Aisha Bello", identifier: "ADM-0042",
      holderType: "student", role: "Learner", photoPath: "", school: { name: "Test Madrasa" },
    },
    holder: { type: "student", id: 42, name: "Aisha Bello", className: "Grade 3", classId: 3 },
    marked: true,
    alreadyMarked: false,
    status: "present",
    message: "Aisha Bello marked present for 2026-10-14.",
    attendance: { status: "present", day: "2026-10-14", classId: 3, className: "Grade 3" },
    classToday: { marked: 1, present: 1, total: 20, remaining: 19 },
    printPath: "/documents/id-card/42",
  }, overrides || {});
}

/** A block shaped exactly like the dashboard's Scan & Mark screen. */
function blockHtml(attrs) {
  return `<div class="page">
    <div data-scanner ${attrs}>
      <input type="text" name="code" autocomplete="off">
      <button type="button" data-scanner-open>Scan with camera</button>
      <button type="button" data-scanner-check>Check</button>
    </div>
    <p data-scanner-error hidden></p>
    <div data-scanner-result></div>
  </div>`;
}

/**
 * A DOM with the real scanner in it.
 *
 * options.staleTokens  how many tokens the "server" will pretend to have
 *                      forgotten (so the scanner must refresh and retry)
 * options.csrfDown     the token endpoint answers 500 (nothing to hand out)
 * options.strictCsrf   default true: a mutating call with no token throws out
 *                      of the stub itself, so the suite fails loudly
 */
async function openScanner(attrs, responder, options) {
  const opts = options || {};
  const dom = new JSDOM(`<!doctype html><html><body>${blockHtml(attrs)}</body></html>`, {
    url: "https://school.example/attendance",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const requests = [];   // every state-changing call the scanner made
  const csrfCalls = [];  // every request for a double-submit token
  const issues = [];     // ways the scanner broke the server's rules
  let issued = 0;        // tokens handed out so far
  const staleTokens = Number(opts.staleTokens || 0);
  const strict = opts.strictCsrf !== false;

  // The camera: a stream that cannot be torn down with any consequence.
  const fakeStream = { getTracks: () => [{ stop() {} }] };
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => fakeStream },
  });
  // A frame of a known size, so the software reader has pixels to look at.
  Object.defineProperty(window.HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 640 });
  Object.defineProperty(window.HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 480 });
  window.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage() {},
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
  });
  // A test DOM cannot play media; the flow under test does not depend on it.
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = () => {};
  // The software QR reader "reads" the card on the first frame it is shown.
  window.jsQR = () => ({ data: `https://school.example/verify/${CODE}` });
  // No native detector, as on Safari: the software reader must be the one used.
  delete window.BarcodeDetector;

  window.fetch = async (url, init) => {
    const target = String(url);
    const request = init || {};
    const method = String(request.method || "GET").toUpperCase();
    const headers = Object.assign({}, request.headers || {});
    const header = (name) => headers[name] !== undefined ? headers[name]
      : Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
        ? headers[Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())]
        : undefined;

    if (/\/csrf-token$/.test(target) && method === "GET") {
      csrfCalls.push({ url: target });
      if (opts.csrfDown) return { ok: false, status: 500, json: async () => null };
      issued += 1;
      return { ok: true, status: 200, json: async () => ({ csrfToken: `token-${issued}` }) };
    }

    if (method !== "GET" && method !== "HEAD") {
      requests.push({ url: target, method, headers, body: request.body ? JSON.parse(request.body) : null });
      // Exactly the rule the server's CSRF guard applies to every POST.
      const token = header("X-CSRF-Token");
      if (!token) {
        issues.push(`${method} ${target} was sent without an X-CSRF-Token header`);
        if (strict) throw new Error(`the scanner sent ${method} ${target} with no X-CSRF-Token header`);
        // With no token to be had (the endpoint that issues them is down) the
        // scanner has nothing to send: answer exactly as the server would, so
        // the test can prove the operator sees the server's own reason.
        return { ok: false, status: 403, json: async () => ({ error: "CSRF token missing or invalid. Refresh the page and try again." }) };
      }
      if (issued <= staleTokens || token !== `token-${issued}`) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: "CSRF token missing or invalid. Refresh the page and try again." }),
        };
      }
      const payload = responder(request.body ? JSON.parse(request.body) : null);
      return { ok: payload.__ok !== false, status: 200, json: async () => { const { __ok, ...rest } = payload; return rest; } };
    }

    requests.push({ url: target, method, headers, body: null });
    const payload = responder(null);
    return { ok: payload.__ok !== false, status: 200, json: async () => { const { __ok, ...rest } = payload; return rest; } };
  };

  window.eval(SCANNER_SRC);
  window.EduScanner.initAll(window.document);
  return { window, document: window.document, requests, csrfCalls, issues, dom };
}

test("the camera reads a card and marks the holder without pressing Check", { skip }, async () => {
  const page = await openScanner(
    'data-endpoint="/api/public/card/" data-mark-endpoint="/api/attendance/scan" data-mark-auto="1" data-mark-status="present" data-scan-date="2026-10-14"',
    () => markedPayload()
  );
  try {
  const { document, window } = page;
  const open = document.querySelector("[data-scanner-open]");
  open.click();

  // The viewport is a framed window under the controls, not a bare video.
  for (let i = 0; i < 50 && !document.querySelector(".scan-viewport video"); i++) await sleep(10);
  const video = document.querySelector(".scan-viewport video");
  assert.ok(video, "the camera preview is shown inside its frame");
  assert.ok(document.querySelector(".scan-viewport .scan-frame"), "the preview has a guide frame");
  assert.equal(video.muted, true, "muted so mobile browsers start it without a fuss");

  // The first decoded frame is enough: nobody presses Check.
  video.dispatchEvent(new window.Event("loadedmetadata"));
  for (let i = 0; i < 100 && page.requests.length === 0; i++) await sleep(10);
  for (let i = 0; i < 100 && !document.querySelector("[data-scanner-result] .scan-result"); i++) await sleep(10);

  assert.equal(page.requests.length, 1, "exactly one check was sent for one card");
  assert.equal(page.requests[0].url, "/api/attendance/scan");
  assert.equal(page.requests[0].method, "POST");
  // The whole point: marking a register is a state-changing call, and the server
  // refuses one that does not carry the session's double-submit token.
  assert.equal(page.requests[0].headers["X-CSRF-Token"], "token-1", "the marking POST carries the CSRF token");
  assert.deepEqual(page.csrfCalls.map((call) => call.url), ["/api/csrf-token"], "the token is fetched once and reused");
  assert.deepEqual(page.issues, [], "no state-changing call went out without a token");
  assert.equal(page.requests[0].body.code, CODE);
  assert.equal(page.requests[0].body.mark, undefined, "an auto-marking block does not send mark:false");
  assert.equal(page.requests[0].body.status, "present");

  const result = document.querySelector("[data-scanner-result] .scan-result");
  assert.ok(result, "the answer is displayed without any further press");
  assert.match(result.textContent, /Marked present/);
  assert.match(result.textContent, /Aisha Bello/, "the holder's name is shown");
  assert.match(result.textContent, /Grade 3/, "the holder's class is shown");
  assert.match(result.textContent, /1 of 20 marked/, "the register position is shown");

  // The camera is put away once the card has been read.
  assert.equal(document.querySelector(".scan-viewport"), null, "camera closes after the read");
  assert.equal(open.textContent, "Scan with camera");
  } finally {
    page.window.close();
  }
});

test("a check-only block shows the holder but marks nothing until an action is pressed", { skip }, async () => {
  const page = await openScanner(
    'data-endpoint="/api/public/card/" data-mark-endpoint="/api/attendance/scan"',
    () => markedPayload({ marked: false, reason: "verify_only", message: "Card checked. Nothing was marked." })
  );
  try {
  const { document, window } = page;
  document.querySelector("[data-scanner-open]").click();
  for (let i = 0; i < 50 && !document.querySelector(".scan-viewport video"); i++) await sleep(10);
  document.querySelector(".scan-viewport video").dispatchEvent(new window.Event("loadedmetadata"));
  for (let i = 0; i < 100 && !document.querySelector("[data-scanner-result] .scan-result"); i++) await sleep(10);

  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].body.mark, false, "a check-only block sends mark:false");
  assert.equal(page.requests[0].headers["X-CSRF-Token"], "token-1", "even a verify-only POST is token-stamped");
  assert.deepEqual(page.issues, []);
  const result = document.querySelector("[data-scanner-result] .scan-result");
  assert.ok(result, "the holder is shown straight away");
  assert.match(result.textContent, /Aisha Bello/);
  assert.ok(result.querySelector("[data-scan-mark='late']"), "the gate can still choose to mark late");
  } finally {
    page.window.close();
  }
});

test("a read that is not a card code keeps the camera looking instead of stopping", { skip }, async () => {
  const page = await openScanner(
    'data-endpoint="/api/public/card/" data-mark-endpoint="/api/attendance/scan" data-mark-auto="1"',
    () => ({ __ok: false, error: "That code does not belong to a card issued by this school." })
  );
  try {
    const { document, window } = page;
    document.querySelector("[data-scanner-open]").click();
    for (let i = 0; i < 50 && !document.querySelector(".scan-viewport video"); i++) await sleep(10);
    document.querySelector(".scan-viewport video").dispatchEvent(new window.Event("loadedmetadata"));
    for (let i = 0; i < 100 && page.requests.length === 0; i++) await sleep(10);
    for (let i = 0; i < 100 && document.querySelector("[data-scanner-error]").hidden; i++) await sleep(10);

    const error = document.querySelector("[data-scanner-error]");
    assert.equal(error.hidden, false, "the reason is shown to the operator");
    assert.match(error.textContent, /does not belong/);

    // Scanning resumes on its own (the operator never stopped it), so the next card can be held up.
    let resumed = false;
    for (let i = 0; i < 300 && !resumed; i++) {
      await sleep(10);
      resumed = Boolean(document.querySelector(".scan-viewport video"));
    }
    assert.ok(resumed, "the camera restarts after a miss");
    assert.equal(page.requests.length, 1, "the miss was checked once, not in a loop");
    assert.equal(page.requests[0].headers["X-CSRF-Token"], "token-1");
    assert.deepEqual(page.issues, []);
  } finally {
    page.window.close();
  }
});

test("a card is marked again after the page's token has gone stale", { skip }, async () => {
  // The server has forgotten the first token it handed out — the tab was left
  // open, or the session was re-saved somewhere else. The scanner must fetch a
  // fresh token and retry once, instead of showing the operator a 403.
  const page = await openScanner(
    'data-mark-endpoint="/api/attendance/scan" data-mark-auto="1" data-mark-status="late" data-scan-date="2026-10-14"',
    () => markedPayload({
      status: "late",
      message: "Aisha Bello marked late for 2026-10-14.",
      attendance: { status: "late", day: "2026-10-14", classId: 3, className: "Grade 3" },
    }),
    { staleTokens: 1 }
  );
  try {
    const { document } = page;
    document.querySelector("input[name=code]").value = CODE;
    document.querySelector("[data-scanner-check]").click();
    for (let i = 0; i < 200 && !document.querySelector("[data-scanner-result] .scan-result"); i++) await sleep(10);

    assert.equal(page.requests.length, 2, "the refused call is retried exactly once");
    assert.equal(page.requests[0].headers["X-CSRF-Token"], "token-1", "the stale token was sent first");
    assert.equal(page.requests[1].headers["X-CSRF-Token"], "token-2", "the retry carries the refreshed token");
    assert.deepEqual(page.csrfCalls.map((call) => call.url), ["/api/csrf-token", "/api/csrf-token"], "the token is refreshed, not guessed");
    const result = document.querySelector("[data-scanner-result] .scan-result");
    assert.ok(result, "the retry's answer is the one displayed");
    assert.match(result.textContent, /Marked late/);
    assert.equal(document.querySelector("[data-scanner-error]").hidden, true, "the stale token is never shown to the operator");
    assert.deepEqual(page.issues, []);
  } finally {
    page.window.close();
  }
});

test("the stub refuses a state-changing call with no CSRF token, as the server does", { skip }, async () => {
  // Guards the guard: if this ever stops rejecting, the three tests above stop
  // proving anything and a forgotten header would slip through again.
  const page = await openScanner('data-mark-endpoint="/api/attendance/scan"', () => markedPayload());
  try {
    await assert.rejects(
      () => page.window.fetch("/api/attendance/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: CODE }),
      }),
      /X-CSRF-Token/
    );
    assert.equal(page.issues.length, 1);
    // …and the same call WITH the token the page was handed is answered normally.
    const token = (await (await page.window.fetch("/api/csrf-token", { credentials: "same-origin" })).json()).csrfToken;
    const answered = await page.window.fetch("/api/attendance/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ code: CODE }),
    });
    assert.equal(answered.status, 200);
  } finally {
    page.window.close();
  }
});

test("a session-less check asks for no token: the public page is GET only", { skip }, async () => {
  // /verify/<code> is opened by a stranger's phone with no cookie at all. That
  // page must keep working with nothing but the code: no token request, no
  // session, and an anonymous GET.
  const page = await openScanner(
    'data-endpoint="/api/public/card/"',
    () => ({ card: markedPayload().card, holder: null, marked: false }),
    {}
  );
  try {
    const { document } = page;
    document.querySelector("input[name=code]").value = CODE;
    document.querySelector("[data-scanner-check]").click();
    for (let i = 0; i < 200 && !document.querySelector("[data-scanner-result] .scan-result"); i++) await sleep(10);

    assert.deepEqual(page.csrfCalls, [], "no session means nothing to prove: no token is requested");
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].method, "GET");
    assert.equal(page.requests[0].headers["X-CSRF-Token"], undefined, "a GET needs no token");
    assert.match(page.requests[0].url, /^\/api\/public\/card\//);
    const result = document.querySelector("[data-scanner-result] .scan-result");
    assert.ok(result, "the holder's card is still shown");
    assert.match(result.textContent, /Aisha Bello/);
  } finally {
    page.window.close();
  }
});

test("a token endpoint that cannot answer leaves the server's own message on screen", { skip }, async () => {
  // Nothing to hand out (session store down): the scan must fail with a real
  // message, once, and never pretend the card was marked.
  const page = await openScanner(
    'data-mark-endpoint="/api/attendance/scan" data-mark-auto="1"',
    () => markedPayload(),
    { csrfDown: true, strictCsrf: false }
  );
  try {
    const { document } = page;
    document.querySelector("input[name=code]").value = CODE;
    document.querySelector("[data-scanner-check]").click();
    for (let i = 0; i < 200 && document.querySelector("[data-scanner-error]").hidden; i++) await sleep(10);

    const error = document.querySelector("[data-scanner-error]");
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /CSRF token missing or invalid/, "the server's reason is shown, not swallowed");
    assert.equal(document.querySelector("[data-scanner-result] .scan-result"), null, "nothing claims the register was written");
    assert.equal(page.requests.length, 1, "no retry against a server that answered 403 with no token to offer");
  } finally {
    page.window.close();
  }
});
