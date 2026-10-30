"use strict";
/* ============================================================================
   api.js STILL PREFERS THE NATIVE BRIDGE ON A PHONE
   ----------------------------------------------------------------------------
   The whole point of Phase 4's bridge is that the Phase 1 Bearer-token path is
   reused, not reimplemented. This runs the REAL public/js/api.js inside a
   native-looking window and proves it: token from the Keychain/Keystore, no
   CSRF handshake, device metadata in the sign-in body, and nothing in
   localStorage.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootNativeBridge, createDom, makeCapacitor, makeSecurePlugin, read, REPO } = require("./helpers");

const SERVER = "https://school.edusphere.app";
const LEGACY_KEY = "edusphere.deviceToken";

async function bootApi(options) {
  const opts = options || {};
  const secure = makeSecurePlugin({ initial: opts.initial || {}, camera: "granted" });
  const requests = [];
  const ctx = await bootNativeBridge({
    secure,
    platform: opts.platform || "android",
    storage: { "edusphere.mobile.server": SERVER },
    beforeEval: (window) => {
      if (opts.seedLocalStorage) window.localStorage.setItem(LEGACY_KEY, opts.seedLocalStorage);
      window.fetch = opts.fetch || ((url, init) => {
        requests.push({ url: String(url), init: init || {} });
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
          json: async () => ({ ok: true, loggedIn: false }),
        });
      });
    },
  });
  ctx.evalFile("api.js");
  return Object.assign(ctx, { requests, secure });
}

test("the API base points at the school's server, not the WebView's asset host", async () => {
  const ctx = await bootApi();
  assert.equal(ctx.window.__APP_CONFIG__.apiBase, SERVER + "/api");
  assert.equal(ctx.window.API.url("/students"), SERVER + "/api/students");
  ctx.close();
});

test("the API reads its Bearer token from the OS store, not from localStorage", async () => {
  const ctx = await bootApi({
    initial: { device_token: "eds_from_keychain" },
    seedLocalStorage: "eds_stale_web_token",
  });
  assert.equal(ctx.window.API.getDeviceToken(), "eds_from_keychain", "the Keychain/Keystore wins");
  assert.equal(ctx.window.localStorage.getItem(LEGACY_KEY), null, "the stale web token was removed");
  ctx.close();
});

test("a request carries Authorization: Bearer and no CSRF token", async () => {
  const ctx = await bootApi({ initial: { device_token: "eds_bearer" } });
  await ctx.window.API.post("/students", { first_name: "Amina" });

  const post = ctx.requests.find((request) => /\/students$/.test(request.url));
  assert.ok(post, "the request was made");
  assert.equal(post.url, SERVER + "/api/students");
  assert.equal(post.init.headers.Authorization, "Bearer eds_bearer");
  assert.equal(post.init.headers["X-CSRF-Token"], undefined, "no cookie double-submit on a native device");
  assert.equal(ctx.requests.some((request) => /csrf-token$/.test(request.url)), false, "no CSRF handshake is attempted");
  ctx.close();
});

test("sign-in asks the server for a device token with the real device identity", async () => {
  const ctx = await bootApi({
    platform: "android",
    fetch: (url, init) => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true, user: { username: "admin" }, deviceToken: "eds_minted_on_signin" }),
    }),
  });
  const bridge = ctx.window.__EDUSPHERE_NATIVE__;
  const loginBody = {};
  ctx.window.fetch = (url, init) => {
    if (/\/auth\/login$/.test(String(url))) Object.assign(loginBody, JSON.parse(init.body));
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true, user: { username: "admin" }, deviceToken: "eds_minted_on_signin" }),
    });
  };

  await ctx.window.API.login("admin", "correct horse battery", true);

  assert.equal(loginBody.issueDeviceToken, true, "the server is asked to mint a device token");
  assert.equal(loginBody.deviceId, bridge.deviceId, "the stable installation id");
  assert.equal(loginBody.deviceName, bridge.deviceName);
  assert.equal(loginBody.platform, "android", "the server records the phone platform");
  assert.equal(ctx.window.API.getDeviceToken(), "eds_minted_on_signin", "the minted token is live");
  assert.equal(ctx.secure.secure.get("device_token"), "eds_minted_on_signin", "and persisted in the OS store");
  assert.equal(ctx.window.localStorage.getItem(LEGACY_KEY), null, "with nothing in web storage");
  ctx.close();
});

test("iOS reports platform ios in the sign-in body", async () => {
  const ctx = await bootApi({ platform: "ios" });
  let body = null;
  ctx.window.fetch = (url, init) => {
    body = JSON.parse(init.body);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true, deviceToken: "eds_ios" }),
    });
  };
  await ctx.window.API.login("admin", "password123", true);
  assert.equal(body.platform, "ios");
  assert.equal(body.issueDeviceToken, true);
  ctx.close();
});

test("a 401 clears the OS token too", async () => {
  const ctx = await bootApi({
    initial: { device_token: "eds_revoked" },
    fetch: () => Promise.resolve({
      ok: false,
      status: 401,
      headers: { get: () => "application/json" },
      json: async () => ({ error: "Session expired" }),
    }),
  });
  await assert.rejects(() => ctx.window.API.post("/students", {}));
  assert.equal(ctx.window.API.getDeviceToken(), "");
  assert.equal(ctx.secure.secure.get("device_token"), undefined, "the Keychain item was removed");
  ctx.close();
});

test("in a plain browser api.js keeps its Phase 2 behaviour (localStorage)", () => {
  const dom = createDom({ beforeEval: (window) => { window.__APP_CONFIG__ = { apiBase: "/api" }; } });
  dom.evalFile("api.js");
  dom.window.API.setDeviceToken("eds_browser_session");
  assert.equal(dom.window.localStorage.getItem(LEGACY_KEY), "eds_browser_session");
  assert.equal(dom.window.__EDUSPHERE_NATIVE__, undefined, "the browser has no native bridge");
  dom.close();
});

test("api.js contains no second token implementation", () => {
  const source = fs.readFileSync(path.join(REPO, "public", "js", "api.js"), "utf8");
  assert.equal((source.match(/localStorage\.setItem\(DEVICE_TOKEN_KEY/g) || []).length, 1,
    "one web-storage write, used ONLY when the native bridge is absent");
  assert.match(source, /if \(bridge\) \{[\s\S]{0,1200}dropLegacyWebToken\(\)/, "the native path scrubs the legacy web token");
});
