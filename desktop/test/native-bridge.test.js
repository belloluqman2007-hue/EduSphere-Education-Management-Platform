"use strict";
/* ============================================================================
   The desktop shell must be INVISIBLE to the offline engine: `public/js/api.js`
   simply finds `window.__EDUSPHERE_NATIVE__` and switches to Bearer device
   tokens. This test runs the REAL api.js in jsdom against a stubbed bridge and
   proves:

     • the bridge's token is preferred over anything in localStorage,
     • a minted device token is handed to the bridge (OS keychain), and
       localStorage is left with NO token at all,
     • the sign-in body asks the server to issue a device token, with the real
       device id / name / platform,
     • `clearDeviceToken()` (sign-out / 401) clears the bridged token too.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (e) {
  JSDOM = null;
}

const API_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "public", "js", "api.js"), "utf8");
const LEGACY_KEY = "edusphere.deviceToken";

function makeBridge(initialToken) {
  const calls = { set: [], clear: 0 };
  let token = initialToken || "";
  const bridge = Object.freeze({
    isNative: true,
    appVersion: "1.0.0",
    platform: "linux",
    deviceId: "desk-11112222-3333-4444-5555-666677778888",
    deviceName: "Front office PC",
    mode: "hub",
    getDeviceToken: () => token,
    setDeviceToken: (value) => { token = String(value || ""); calls.set.push(token); return Promise.resolve({ persisted: true }); },
    clearDeviceToken: () => { token = ""; calls.clear += 1; return Promise.resolve({ ok: true }); },
    print: () => Promise.resolve({ ok: true }),
    savePdf: () => Promise.resolve({ ok: true }),
    openExternal: () => Promise.resolve({ ok: true }),
  });
  return { bridge, calls, peek: () => token };
}

function loadApi({ bridge, base = "https://school.example.com/api", fetchImpl, storageSeed } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://school.example.com/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.__APP_CONFIG__ = { apiBase: base };
  if (storageSeed) dom.window.localStorage.setItem(LEGACY_KEY, storageSeed);
  if (bridge) dom.window.__EDUSPHERE_NATIVE__ = bridge;
  dom.window.fetch = fetchImpl || (() => Promise.reject(new Error("offline")));
  dom.window.eval(API_SOURCE);
  return dom;
}

test("the native bridge's token wins over localStorage", { skip: !JSDOM && "jsdom not installed" }, () => {
  const { bridge } = makeBridge("eds_native_token_value");
  const dom = loadApi({ bridge, storageSeed: "eds_legacy_localstorage_token" });

  assert.equal(typeof dom.window.API, "object");
  assert.equal(dom.window.API.getDeviceToken(), "eds_native_token_value");
  dom.window.close();
});

test("a new device token goes to the OS keychain and never into web storage", { skip: !JSDOM && "jsdom not installed" }, () => {
  const { bridge, calls } = makeBridge("");
  const dom = loadApi({ bridge, storageSeed: "eds_legacy_localstorage_token" });
  const API = dom.window.API;

  API.setDeviceToken("eds_brand_new_token");

  assert.deepEqual(calls.set, ["eds_brand_new_token"], "the bridge stored the token");
  assert.equal(API.getDeviceToken(), "eds_brand_new_token");
  assert.equal(dom.window.localStorage.getItem(LEGACY_KEY), null, "no token is left in localStorage");

  API.clearDeviceToken();
  assert.equal(calls.clear, 1, "clearing goes through the shell");
  assert.equal(API.getDeviceToken(), "");
  dom.window.close();
});

test("signing in asks the server to mint a device token for this desktop", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const { bridge, calls } = makeBridge("");
  const requests = [];
  const fetchImpl = (url, options) => {
    requests.push({ url, options, body: options && options.body ? JSON.parse(options.body) : null });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true, user: { username: "admin" }, deviceToken: "eds_minted_by_server" }),
    });
  };
  const dom = loadApi({ bridge, fetchImpl });

  const result = await dom.window.API.login("admin", "correct horse battery", true);

  assert.equal(result.deviceToken, "eds_minted_by_server");
  const login = requests.find((r) => /\/auth\/login$/.test(r.url));
  assert.ok(login, "the sign-in request was made");
  assert.equal(login.body.issueDeviceToken, true, "the server is asked for a device token");
  assert.equal(login.body.deviceId, bridge.deviceId);
  assert.equal(login.body.deviceName, bridge.deviceName);
  assert.equal(login.body.platform, "linux", "the server records the real desktop platform");
  assert.deepEqual(calls.set, ["eds_minted_by_server"], "the minted token was persisted by the shell");
  assert.equal(dom.window.localStorage.getItem(LEGACY_KEY), null);
  dom.window.close();
});

test("without the native bridge the browser build keeps using localStorage", { skip: !JSDOM && "jsdom not installed" }, () => {
  const dom = loadApi({ bridge: null });
  dom.window.API.setDeviceToken("eds_browser_token");
  assert.equal(dom.window.localStorage.getItem(LEGACY_KEY), "eds_browser_token");
  assert.equal(dom.window.API.getDeviceToken(), "eds_browser_token");
  dom.window.API.clearDeviceToken();
  assert.equal(dom.window.localStorage.getItem(LEGACY_KEY), null);
  dom.window.close();
});

test("api.js sends the Bearer header and never a CSRF token when a device token exists", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const { bridge } = makeBridge("eds_bearer_token");
  const seen = [];
  const fetchImpl = (url, options) => {
    seen.push({ url, headers: (options && options.headers) || {} });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    });
  };
  const dom = loadApi({ bridge, fetchImpl });
  await dom.window.API.post("/students", { full_name: "Amina" });

  const post = seen.find((s) => /\/students$/.test(s.url));
  assert.ok(post);
  assert.equal(post.headers.Authorization, "Bearer eds_bearer_token");
  assert.equal(post.headers["X-CSRF-Token"], undefined, "native requests do not use cookies/CSRF");
  assert.equal(seen.some((s) => /csrf-token$/.test(s.url)), false, "no CSRF handshake is attempted");
  dom.window.close();
});
