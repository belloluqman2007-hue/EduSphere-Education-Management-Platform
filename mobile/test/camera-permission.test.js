"use strict";
/* ============================================================================
   CAMERA PERMISSION + THE QR ATTENDANCE SCANNER
   ----------------------------------------------------------------------------
   The three real answers a phone gives, and what the app does with each:

     granted              → open the camera, scan continuously with jsQR
     prompt (rationale)   → ask once, explain why, still offer the typed code
     denied-permanently   → do NOT ask again (the OS ignores it): explain, offer
                            an "Open camera settings" action, and the manual box

   The scanner itself is public/js/card-scanner.js — unchanged except for the
   permission gate and the torch button, so it still posts through the Phase 1
   `attendance.scan` path (test/card-scanner-csrf.test.js guards that).
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootNativeBridge, makeSecurePlugin, createDom, makeCapacitor, read, REPO } = require("./helpers");

const PLIST = read(path.join("mobile", "ios", "App", "App", "Info.plist"), REPO);
const MANIFEST = read(path.join("mobile", "android", "app", "src", "main", "AndroidManifest.xml"), REPO);
const MAIN_ACTIVITY = read(path.join("mobile", "android", "app", "src", "main", "java", "app", "edusphere", "mobile", "MainActivity.java"), REPO);
const SCANNER = read(path.join("public", "js", "card-scanner.js"), REPO);

const SCANNER_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>
  <div id="app"><div data-scanner data-mark-endpoint="/api/attendance/scan" data-mark-auto="1">
    <input type="text" name="code" disabled>
    <button type="button" data-scanner-open>Scan with camera</button>
    <button type="button" data-scanner-check>Check</button>
  </div>
  <p data-scanner-error hidden></p>
  <div data-scanner-result></div></div></body></html>`;

function fakeTrack(options) {
  const opts = options || {};
  const torchValues = [];
  return {
    torchValues,
    stop() {},
    getCapabilities: () => (opts.torch ? { torch: true } : {}),
    applyConstraints: (constraints) => {
      const advanced = (constraints && constraints.advanced) || [];
      for (const entry of advanced) if (typeof entry.torch === "boolean") torchValues.push(entry.torch);
      return Promise.resolve();
    },
  };
}

async function bootScanner(options) {
  const opts = options || {};
  const track = fakeTrack({ torch: opts.torch !== false });
  const camera = { calls: 0, constraints: [] };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
  const mobileShell = opts.mobileShell || null;

  const ctx = await bootNativeBridge({
    html: SCANNER_HTML,
    storage: { "edusphere.mobile.server": "https://school.edusphere.app" },
    secureOptions: opts.secureOptions || {},
    beforeEval: (window) => {
      window.jsQR = () => null; // the vendored decoder's contract, without the download
      window.HTMLMediaElement.prototype.play = () => Promise.resolve();
      window.HTMLMediaElement.prototype.pause = () => {};
      Object.defineProperty(window.navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: (constraints) => {
            camera.calls += 1;
            camera.constraints.push(constraints);
            if (opts.getUserMediaError) return Promise.reject(opts.getUserMediaError);
            return Promise.resolve(stream);
          },
        },
      });
      if (mobileShell) window.MobileShell = mobileShell;
    },
  });
  if (opts.installShell !== false) ctx.evalFile("mobile-shell.js");
  ctx.evalFile("card-scanner.js");
  return Object.assign(ctx, { track, camera, stream, doc: ctx.window.document });
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 15));

test("getCameraPermission reports the three real answers", async () => {
  for (const state of ["granted", "prompt", "prompt-with-rationale", "denied-permanently"]) {
    const ctx = await bootNativeBridge({ secureOptions: { camera: state } });
    const read = await ctx.mobile.camera.state();
    assert.equal(read.state, state, state + " is reported by getCameraPermission");
    const requested = await ctx.mobile.camera.request();
    assert.equal(requested.state, state, state + " survives a request too");
    ctx.close();
  }

  /* An unknown answer must still let the operator try: getUserMedia is the
     fallback prompt, so the bridge reports "prompt" rather than blocking. */
  const ctx = await bootNativeBridge({ secureOptions: { camera: "unknown" } });
  assert.equal((await ctx.mobile.camera.request()).state, "prompt");
  ctx.close();
});

test("a granted camera opens the scanner and offers the torch", async () => {
  const ctx = await bootScanner();
  ctx.doc.querySelector("[data-scanner-open]").click();
  await settle(40);

  assert.equal(ctx.camera.calls, 1, "the camera was opened exactly once");
  const constraints = ctx.camera.constraints[0];
  assert.equal(constraints.audio, false, "no microphone is ever requested");
  assert.equal(constraints.video.facingMode.ideal, "environment", "the rear camera is preferred");

  const viewport = ctx.doc.querySelector(".scan-viewport");
  assert.ok(viewport, "the framed viewfinder is shown");
  assert.ok(viewport.querySelector("video"), "with the live video element");
  const torch = viewport.querySelector("[data-scanner-torch]");
  assert.ok(torch, "a torch toggle is offered when the hardware reports it");
  assert.equal(torch.getAttribute("aria-pressed"), "false");

  torch.click();
  await settle(10);
  assert.equal(torch.getAttribute("aria-pressed"), "true");
  assert.deepEqual(ctx.track.torchValues, [true], "the torch was switched on");
  torch.click();
  await settle(10);
  assert.deepEqual(ctx.track.torchValues, [true, false], "and off again");
  ctx.close();
});

test("no torch button when the camera has no torch", async () => {
  const ctx = await bootScanner({ torch: false });
  ctx.doc.querySelector("[data-scanner-open]").click();
  await settle(40);
  assert.equal(ctx.doc.querySelector("[data-scanner-torch]"), null, "nothing is offered that does not exist");
  ctx.close();
});

test("a permanently denied camera explains the route to Settings and never calls getUserMedia", async () => {
  const ctx = await bootScanner({ secureOptions: { camera: "denied-permanently" } });
  ctx.doc.querySelector("[data-scanner-open]").click();
  await settle(60);

  assert.equal(ctx.camera.calls, 0, "the camera was never opened");
  const error = ctx.doc.querySelector("[data-scanner-error]");
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /Settings/, "the operator is told where to fix it");
  assert.match(error.textContent, /type the code/i, "and that the typed code still works");

  const settingsButton = ctx.doc.querySelector("[data-scanner-settings]");
  assert.ok(settingsButton, "an action opens the app settings");
  settingsButton.click();
  await settle(10);
  assert.equal(ctx.secure.calls.settings, 1, "the settings screen was requested");

  const input = ctx.doc.querySelector("input[name=code]");
  assert.equal(ctx.doc.activeElement, input, "the manual code box is focused, so work continues");
  ctx.close();
});

test("a rationale state still lets the operator type the code", async () => {
  const ctx = await bootScanner({ secureOptions: { camera: "prompt-with-rationale" } });
  ctx.doc.querySelector("[data-scanner-open]").click();
  await settle(60);
  assert.equal(ctx.camera.calls, 0, "the refusal is respected");
  assert.match(ctx.doc.querySelector("[data-scanner-error]").textContent, /type the code/i);
  assert.equal(ctx.doc.querySelector("[data-scanner-settings]"), null, "no Settings detour for a state that can still prompt");
  ctx.close();
});

test("a refused getUserMedia at the OS level falls back to the manual box", async () => {
  const denied = new Error("Permission denied");
  denied.name = "NotAllowedError";
  const ctx = await bootScanner({ secureOptions: { camera: "granted" }, getUserMediaError: denied });
  ctx.doc.querySelector("[data-scanner-open]").click();
  await settle(60);
  assert.equal(ctx.camera.calls, 1, "the OS was asked");
  assert.match(ctx.doc.querySelector("[data-scanner-error]").textContent, /type the code printed under the QR/i);
  ctx.close();
});

test("opening the scanner is the ONLY thing that asks for the camera", async () => {
  const ctx = await bootScanner();
  await settle(80);
  assert.equal(ctx.camera.calls, 0, "nothing asks on load");
  assert.equal(ctx.doc.querySelector(".scan-viewport"), null, "and no viewfinder is mounted");
  ctx.close();
});

test("the native permission is requested only from the scanner, through mobile-shell", async () => {
  assert.match(SCANNER, /function cameraGate\(\)/, "the scanner owns the gate");
  assert.match(SCANNER, /shell\.requestCamera\(\)/, "it asks mobile-shell, not the plugin directly");
  assert.equal(/MOBILE\.camera\.request\(\)/.test(SCANNER), false, "the scanner never bypasses the shell");
  const bridge = read(path.join("public", "js", "native-bridge.js"), REPO);
  const requestCalls = (bridge.match(/requestCameraPermission\(/g) || []).length;
  assert.ok(requestCalls <= 2, "the bridge only wraps the plugin method; it never calls it at boot");
  assert.equal(/requestCamera\(\s*\)/.test(bridge), false, "no eager permission request at start-up");
});

test("platform files declare the camera permission and its privacy text", () => {
  assert.match(MANIFEST, /<uses-permission android:name="android\.permission\.CAMERA" \/>/);
  assert.match(MANIFEST, /<uses-feature android:name="android\.hardware\.camera" android:required="false" \/>/,
    "the app still installs on a tablet without a camera");
  assert.equal(/requestPermissions|CAMERA/.test(MAIN_ACTIVITY), false, "the Activity never asks at launch");
  assert.match(PLIST, /<key>NSCameraUsageDescription<\/key>\s*<string>[\s\S]{10,}?<\/string>/, "iOS explains the use");
  assert.match(PLIST, /attendance scanner|ID card/i, "the explanation names the actual purpose");
});

test("the scanner still reuses the Phase 1 attendance.scan mutation path", () => {
  assert.match(SCANNER, /window\.API\.post/, "offline scans go through window.API, so the Outbox queues them");
  assert.equal(/fetch\([^)]*attendance\/scan/.test(SCANNER), false, "no new raw mutating fetch was added");
  assert.match(SCANNER, /attendance\.scan|markEndpoint/, "the marking endpoint stays configurable");
});

test("torch is switched off again when the camera closes", async () => {
  const ctx = await bootScanner();
  ctx.doc.querySelector("[data-scanner-open]").click();
  await settle(40);
  ctx.doc.querySelector("[data-scanner-open]").click();
  await settle(20);
  assert.deepEqual(ctx.track.torchValues, [false], "the LED is turned off with the camera");
  assert.equal(ctx.doc.querySelector(".scan-viewport"), null);
  ctx.close();
});
