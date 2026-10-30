"use strict";
/* ============================================================================
   Shared harness for the mobile tests.
   ----------------------------------------------------------------------------
   The REAL web files run inside jsdom against a STUBBED Capacitor — exactly
   how `desktop/test` runs the real preload against a stubbed Electron. Nothing
   is faked at the business layer: the bridge, the storage adapter, the shell
   wiring and api.js are the shipped files.

   No Android SDK, no simulator, no Xcode.
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const MOBILE = path.resolve(__dirname, "..");
const REPO = path.resolve(MOBILE, "..");
const PUBLIC = path.join(REPO, "public");

function read(relative, root) {
  return fs.readFileSync(path.join(root || MOBILE, relative), "utf8");
}

function script(name) {
  return fs.readFileSync(path.join(PUBLIC, "js", name), "utf8");
}

const DEFAULT_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body><div id="app"></div></body></html>`;

/**
 * A fake `EduSphereNative` plugin: an encrypted-store stand-in for the
 * AndroidKeyStore / Keychain. `initial` seeds the store, `delayMs` slows the
 * first read so a cold-start race can be tested on purpose.
 */
function makeSecurePlugin(options) {
  const opts = options || {};
  const secure = new Map(Object.entries(opts.initial || {}));
  const calls = { set: [], remove: [], cameraRequests: 0, settings: 0, opened: [], sqlite: [] };
  let cameraState = opts.camera === undefined ? "granted" : opts.camera;
  const plugin = {
    getSecureValue: ({ key }) => {
      const value = secure.get(key) || "";
      return opts.delayMs
        ? new Promise((resolve) => setTimeout(() => resolve({ value }), opts.delayMs))
        : Promise.resolve({ value });
    },
    setSecureValue: ({ key, value }) => {
      secure.set(key, String(value));
      calls.set.push([key, String(value)]);
      return Promise.resolve({ persisted: true });
    },
    removeSecureValue: ({ key }) => {
      secure.delete(key);
      calls.remove.push(key);
      return Promise.resolve({ removed: true });
    },
    openExternal: ({ url }) => {
      calls.opened.push(url);
      return Promise.resolve({ opened: true });
    },
    getDeviceModel: () => Promise.resolve({ model: opts.platform === "ios" ? "iPhone" : "Pixel 7" }),
    getCameraPermission: () => Promise.resolve({ state: typeof cameraState === "function" ? cameraState() : cameraState }),
    requestCameraPermission: () => {
      calls.cameraRequests += 1;
      if (typeof cameraState === "function") cameraState = cameraState();
      return Promise.resolve({ state: cameraState });
    },
    openAppSettings: () => {
      calls.settings += 1;
      return Promise.resolve({ opened: true });
    },
  };
  if (opts.sqlite) {
    plugin.sqliteExec = (payload) => { calls.sqlite.push({ kind: "exec", ...payload }); return Promise.resolve(opts.sqlite.execute(payload.sql, payload.params)); };
    plugin.sqliteQuery = (payload) => { calls.sqlite.push({ kind: "query", ...payload }); return Promise.resolve(opts.sqlite.query(payload.sql, payload.params)); };
  }
  return { plugin, calls, secure, setCameraState: (next) => { cameraState = next; } };
}

/** `window.Capacitor` as the native WebView injects it. */
function makeCapacitor(options) {
  const opts = options || {};
  return {
    isNativePlatform: () => opts.native !== false,
    getPlatform: () => opts.platform || "android",
    Plugins: Object.assign({}, opts.plugins || {}),
  };
}

function makeAppPlugin(options) {
  const opts = options || {};
  const listeners = {};
  const calls = { exitApp: 0, openUrl: [] };
  return {
    listeners,
    calls,
    plugin: {
      addListener: (event, handler) => {
        listeners[event] = handler;
        return Promise.resolve({ remove: () => { delete listeners[event]; } });
      },
      getInfo: () => Promise.resolve({ version: "1.0.0", build: "1" }),
      getLaunchUrl: () => Promise.resolve({ url: "" }),
      exitApp: () => { calls.exitApp += 1; },
      openUrl: (payload) => { calls.openUrl.push(payload.url); return Promise.resolve({}); },
    },
  };
}

function makeNetworkPlugin(options) {
  const opts = options || {};
  const listeners = {};
  const calls = { getStatus: 0 };
  return {
    listeners,
    calls,
    plugin: {
      getStatus: () => {
        calls.getStatus += 1;
        return Promise.resolve({ connected: opts.connected !== false, connectionType: "wifi" });
      },
      addListener: (event, handler) => {
        listeners[event] = handler;
        return Promise.resolve({ remove: () => { delete listeners[event]; } });
      },
    },
  };
}

/**
 * Creates a jsdom window that looks like the native WebView: a same-origin-ish
 * https URL (so localStorage exists — the bridge must still never put a token
 * there), `window.Capacitor`, and a virtual console that records jsdom errors
 * instead of printing them.
 */
function createDom(options) {
  const opts = options || {};
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  virtualConsole.on("error", (message) => errors.push(new Error(String(message))));
  const dom = new JSDOM(opts.html || DEFAULT_HTML, {
    url: opts.url || "https://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  if (opts.capacitor) dom.window.Capacitor = opts.capacitor;
  for (const [key, value] of Object.entries(opts.storage || {})) {
    dom.window.localStorage.setItem(key, value);
  }
  if (opts.beforeEval) opts.beforeEval(dom.window);
  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    errors,
    evalFile(name) {
      dom.window.eval(script(name));
    },
    evalSource(source) {
      dom.window.eval(source);
    },
    close() {
      dom.window.close();
    },
  };
}

/** Loads native-bridge.js into a native-looking window and waits for its prime. */
async function bootNativeBridge(options) {
  const opts = options || {};
  const secure = opts.secure || makeSecurePlugin(opts.secureOptions || {});
  const app = opts.app || makeAppPlugin();
  const network = opts.network || makeNetworkPlugin();
  const plugins = Object.assign({
    EduSphereNative: secure.plugin,
    App: app.plugin,
    Network: network.plugin,
  }, opts.extraPlugins || {});
  const dom = createDom({
    html: opts.html,
    url: opts.url,
    storage: opts.storage,
    capacitor: makeCapacitor({ platform: opts.platform || "android", plugins }),
    beforeEval: opts.beforeEval,
  });
  dom.evalFile("native-bridge.js");
  if (opts.waitForReady !== false) {
    const mobile = dom.window.__EDUSPHERE_MOBILE__;
    if (mobile && mobile.ready) await mobile.ready;
  }
  return Object.assign(dom, { secure, app, network, mobile: dom.window.__EDUSPHERE_MOBILE__ });
}

/** A minimal in-memory SQL driver with the plugin's `{execute, query}` shape. */
function memorySqliteDriver() {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  return {
    db,
    execute(sql, params) {
      const statement = db.prepare(sql);
      const args = Array.isArray(params) ? params : [];
      const info = args.length ? statement.run(...args) : statement.run();
      return { rowsAffected: Number(info.changes) };
    },
    query(sql, params) {
      const statement = db.prepare(sql);
      const args = Array.isArray(params) ? params : [];
      return { rows: args.length ? statement.all(...args) : statement.all() };
    },
    close() {
      try { db.close(); } catch (e) { /* already closed */ }
    },
  };
}

module.exports = {
  MOBILE,
  REPO,
  PUBLIC,
  read,
  script,
  createDom,
  bootNativeBridge,
  makeCapacitor,
  makeSecurePlugin,
  makeAppPlugin,
  makeNetworkPlugin,
  memorySqliteDriver,
  DEFAULT_HTML,
};
