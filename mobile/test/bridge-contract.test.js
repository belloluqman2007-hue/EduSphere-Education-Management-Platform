"use strict";
/* ============================================================================
   THE NATIVE BRIDGE CONTRACT
   ----------------------------------------------------------------------------
   `public/js/api.js` was written for the desktop shell (Phase 3). The mobile
   shell must present the SAME frozen object or the Bearer-token path silently
   becomes a second implementation. These tests run the real native-bridge.js
   against a stubbed Capacitor and hold the surface still.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bootNativeBridge, createDom, makeSecurePlugin } = require("./helpers");

const CONTRACT = [
  "appVersion",
  "clearDeviceToken",
  "deviceId",
  "deviceName",
  "getDeviceToken",
  "isNative",
  "mode",
  "openExternal",
  "platform",
  "print",
  "savePdf",
  "setDeviceToken",
];

test("the bridge exposes exactly the desktop contract, and it is frozen", async () => {
  const ctx = await bootNativeBridge();
  const bridge = ctx.window.__EDUSPHERE_NATIVE__;

  assert.ok(bridge, "window.__EDUSPHERE_NATIVE__ exists");
  assert.equal(Object.isFrozen(bridge), true, "the surface is frozen");
  assert.deepEqual(Object.keys(bridge).sort(), CONTRACT, "no extra or missing members");

  assert.equal(bridge.isNative, true);
  assert.equal(bridge.platform, "android");
  assert.equal(bridge.mode, "cloud", "the phone is a client of a school server");
  assert.equal(typeof bridge.deviceId, "string");
  assert.ok(bridge.deviceId.length >= 20, "a stable per-installation id");
  assert.equal(typeof bridge.deviceName, "string");
  for (const method of ["getDeviceToken", "setDeviceToken", "clearDeviceToken", "print", "savePdf", "openExternal"]) {
    assert.equal(typeof bridge[method], "function", method + " is a function");
  }
  assert.throws(() => { bridge.isNative = false; }, TypeError, "the frozen surface cannot be rewritten");
  ctx.close();
});

test("iOS reports platform ios so the server records the right device", async () => {
  const ctx = await bootNativeBridge({ platform: "ios" });
  assert.equal(ctx.window.__EDUSPHERE_NATIVE__.platform, "ios");
  ctx.close();
});

test("getDeviceToken() is synchronous and primed from the secure store", async () => {
  const ctx = await bootNativeBridge({
    secureOptions: { initial: { device_token: "eds_primed_from_keychain" } },
  });
  const bridge = ctx.window.__EDUSPHERE_NATIVE__;
  const token = bridge.getDeviceToken();
  assert.equal(token, "eds_primed_from_keychain");
  assert.equal(typeof token, "string", "a plain string, not a promise");
  ctx.close();
});

test("a minted token is written to the OS store and NEVER to localStorage", async () => {
  const ctx = await bootNativeBridge();
  const bridge = ctx.window.__EDUSPHERE_NATIVE__;

  await bridge.setDeviceToken("eds_brand_new_token");

  assert.equal(bridge.getDeviceToken(), "eds_brand_new_token");
  assert.equal(ctx.secure.secure.get("device_token"), "eds_brand_new_token", "the native store holds it");
  assert.equal(ctx.window.localStorage.getItem("edusphere.deviceToken"), null, "no token in localStorage");
  assert.equal(ctx.window.localStorage.getItem("device_token"), null);
  assert.equal(ctx.window.document.cookie, "", "no token in a cookie");

  const dump = JSON.stringify(Object.fromEntries(Object.entries(ctx.window.localStorage)));
  assert.equal(dump.indexOf("eds_brand_new_token"), -1, "the token appears nowhere in web storage");
  ctx.close();
});

test("clearing the token clears the OS store too", async () => {
  const ctx = await bootNativeBridge({
    secureOptions: { initial: { device_token: "eds_to_be_removed" } },
  });
  const bridge = ctx.window.__EDUSPHERE_NATIVE__;
  await bridge.clearDeviceToken();
  assert.equal(bridge.getDeviceToken(), "");
  assert.equal(ctx.secure.secure.get("device_token"), undefined);
  assert.deepEqual(ctx.secure.calls.remove, ["device_token"]);
  ctx.close();
});

test("a 401 during the cold start is deferred, so a slow prime cannot delete a healthy token", async () => {
  const ctx = await bootNativeBridge({
    waitForReady: false,
    secureOptions: { initial: { device_token: "eds_slow_disk_token" }, delayMs: 25 },
  });
  const bridge = ctx.window.__EDUSPHERE_NATIVE__;
  assert.equal(bridge.getDeviceToken(), "", "the prime has not finished yet");

  const result = await bridge.clearDeviceToken();
  assert.equal(result.deferred, true, "the clear waited for the prime");
  assert.equal(ctx.secure.calls.remove.length, 0, "nothing was deleted while the read was in flight");

  await ctx.mobile.ready;
  assert.equal(bridge.getDeviceToken(), "");
  assert.equal(ctx.secure.secure.get("device_token"), undefined, "the sign-out is honoured after the prime");
  ctx.close();
});

test("the device id is stable across restarts (it comes from the secure store)", async () => {
  const first = await bootNativeBridge();
  const id = first.window.__EDUSPHERE_NATIVE__.deviceId;
  const stored = first.secure.secure.get("device_id");
  assert.equal(stored, id, "the generated id was persisted for the next launch");

  const second = await bootNativeBridge({ secureOptions: { initial: { device_id: id } } });
  assert.equal(second.window.__EDUSPHERE_NATIVE__.deviceId, id, "a restart keeps the same device id");
  first.close();
  second.close();
});

test("openExternal refuses every scheme a page must not be able to fire", async () => {
  const ctx = await bootNativeBridge();
  const bridge = ctx.window.__EDUSPHERE_NATIVE__;

  assert.equal((await bridge.openExternal("https://school.edusphere.app/receipt/12")).ok, true);
  assert.equal((await bridge.openExternal("mailto:office@school.example")).ok, true);
  assert.equal((await bridge.openExternal("tel:+2348000000000")).ok, true);

  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "intent://scan#Intent;", "content://provider/x", "https://x.test/\nInjected: 1"]) {
    const result = await bridge.openExternal(bad);
    assert.equal(result.ok, false, bad + " must be blocked");
    assert.equal(result.reason, "blocked");
  }
  assert.equal(ctx.secure.calls.opened.length, 3, "only the three safe links reached the OS");
  ctx.close();
});

test("print uses the native sheet when available and savePdf fails honestly", async () => {
  const ctx = await bootNativeBridge();
  const bridge = ctx.window.__EDUSPHERE_NATIVE__;
  let printed = 0;
  ctx.window.print = () => { printed += 1; };

  const printedResult = await bridge.print({ jobName: "Report cards" });
  assert.equal(printedResult.ok, true);
  assert.equal(printedResult.method, "webview");
  assert.equal(printed, 1);

  const pdf = await bridge.savePdf({ filename: "report.pdf" });
  assert.equal(pdf.ok, false, "the bridge says so instead of pretending");
  assert.match(pdf.hint, /Print/i);
  ctx.close();
});

test("deep links are parsed against an allow-list", async () => {
  const ctx = await bootNativeBridge();
  const mobile = ctx.mobile;
  assert.ok(mobile, "window.__EDUSPHERE_MOBILE__ exists");

  /* Cross-realm objects: compare fields, not prototypes. */
  assert.equal(mobile.deepLink("edusphere://sync").action, "sync");
  const open = mobile.deepLink("edusphere://open/students");
  assert.equal(open.action, "open");
  assert.equal(open.path, "/students");
  const hub = mobile.deepLink("edusphere://hub?url=http://192.168.1.5:4123");
  assert.equal(hub.action, "hub");
  assert.equal(hub.serverUrl, "http://192.168.1.5:4123");
  assert.equal(mobile.deepLink("edusphere://settings").action, "settings");

  for (const bad of [
    "https://evil.example/open/students",
    "edusphere://open/../../etc/passwd",
    "edusphere://hub?url=http://evil.example",
    "edusphere://hub?url=https://user:pass@school.example",
    "javascript:alert(1)",
    "",
    "edusphere://open/" + "a".repeat(600),
  ]) {
    assert.equal(mobile.deepLink(bad), null, JSON.stringify(bad) + " must be refused");
  }
  ctx.close();
});

test("a hub deep link stores the LAN address, a public http link is refused", async () => {
  const ctx = await bootNativeBridge();
  const result = await ctx.mobile.handleDeepLink("edusphere://hub?url=http://10.0.0.9:4123");
  assert.equal(result.ok, true);
  assert.equal(ctx.mobile.server.get(), "http://10.0.0.9:4123");
  assert.equal(ctx.window.__APP_CONFIG__.apiBase, "http://10.0.0.9:4123/api", "api.js will talk to the hub");

  assert.equal(ctx.mobile.server.set("http://school.example.com"), "");
  assert.equal(ctx.mobile.server.set("https://school.example.com/"), "https://school.example.com");
  ctx.close();
});

test("a browser window is left completely untouched", () => {
  const ctx = createDom(); // no window.Capacitor at all
  ctx.evalFile("native-bridge.js");
  assert.equal(ctx.window.__EDUSPHERE_NATIVE__, undefined, "no bridge in a browser");
  assert.equal(ctx.window.__EDUSPHERE_MOBILE__, undefined);
  ctx.close();
});

test("an existing desktop bridge is never overwritten", () => {
  const ctx = createDom({
    beforeEval: (window) => {
      window.__EDUSPHERE_NATIVE__ = Object.freeze({ isNative: true, platform: "linux", getDeviceToken: () => "eds_desktop" });
    },
  });
  ctx.window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android", Plugins: {} };
  ctx.evalFile("native-bridge.js");
  assert.equal(ctx.window.__EDUSPHERE_NATIVE__.platform, "linux", "the Electron shell wins");
  ctx.close();
});

test("a secure store that fails to write is reported, not swallowed silently", async () => {
  const secure = makeSecurePlugin();
  secure.plugin.setSecureValue = () => Promise.reject(new Error("keystore unavailable"));
  const ctx = await bootNativeBridge({ secure });
  const result = await ctx.window.__EDUSPHERE_NATIVE__.setDeviceToken("eds_x");
  assert.equal(result.persisted, false, "the caller learns that nothing was persisted");
  ctx.close();
});
