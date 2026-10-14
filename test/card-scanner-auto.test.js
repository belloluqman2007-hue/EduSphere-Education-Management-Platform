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

async function openScanner(attrs, responder) {
  const dom = new JSDOM(`<!doctype html><html><body>${blockHtml(attrs)}</body></html>`, {
    url: "https://school.example/attendance",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const requests = [];

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
    const body = init && init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), body });
    const payload = responder(body);
    return { ok: payload.__ok !== false, status: 200, json: async () => { const { __ok, ...rest } = payload; return rest; } };
  };

  window.eval(SCANNER_SRC);
  window.EduScanner.initAll(window.document);
  return { window, document: window.document, requests, dom };
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
  } finally {
    page.window.close();
  }
});
