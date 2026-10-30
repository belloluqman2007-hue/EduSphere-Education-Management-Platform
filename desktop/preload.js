"use strict";
/* ============================================================================
   EduSphere Desktop — preload (the ONLY bridge between the app and the shell)
   ----------------------------------------------------------------------------
   Security posture of every window the app opens:
       contextIsolation: true    → page JS and preload JS run in separate worlds
       nodeIntegration:  false   → no `require`, no `process`, no `fs` in a page
       sandbox:          true    → the preload itself runs in Chromium's sandbox
       no remote module          → nothing here exposes `require("electron")`

   The page therefore sees exactly ONE frozen object:

     window.__EDUSPHERE_NATIVE__ = {
       isNative, appVersion, platform, deviceId, deviceName, mode,
       getDeviceToken(), setDeviceToken(t), clearDeviceToken(),
       print(options), savePdf(options), openExternal(url)
     }

   WHY `getDeviceToken()` IS SYNCHRONOUS
   `public/js/api.js` reads the token synchronously on every request. The value
   is therefore fetched once from the main process at preload time (a single
   synchronous IPC round-trip, before the page exists) and then kept in this
   closure. Writing goes back over an async IPC channel.

   The token NEVER lives in localStorage: the main process keeps it encrypted
   with Electron `safeStorage` (secret-store.js) and hands the plaintext only to
   this isolated world.
   ========================================================================== */
const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, payload) {
  try {
    const result = ipcRenderer.invoke(channel, payload);
    if (result && typeof result.catch === "function") result.catch(() => {});
    return result;
  } catch (e) {
    return Promise.resolve(null);
  }
}

/* One synchronous handshake: identity + the (already decrypted) device token. */
let hello = {};
try {
  hello = ipcRenderer.sendSync("edusphere:native:hello") || {};
} catch (e) {
  hello = {};
}

let deviceToken = typeof hello.deviceToken === "string" ? hello.deviceToken : "";

const bridge = Object.freeze({
  isNative: true,
  appVersion: String(hello.appVersion || ""),
  /** "windows" | "macos" | "linux" — the value the server records per device. */
  platform: String(hello.platform || "desktop"),
  /** Stable, random per-installation id (never the machine's hardware id). */
  deviceId: String(hello.deviceId || ""),
  deviceName: String(hello.deviceName || "EduSphere Desktop"),
  /** "cloud" | "hub" — the runtime mode this window was opened in. */
  mode: hello.mode === "hub" ? "hub" : "cloud",

  /** Synchronous read of the Bearer device token (encrypted at rest). */
  getDeviceToken() {
    return deviceToken;
  },
  /** Persist a freshly minted `eds_…` token. Resolves to `{ persisted, reason }`. */
  setDeviceToken(token) {
    deviceToken = String(token == null ? "" : token);
    return invoke("edusphere:native:set-device-token", deviceToken);
  },
  /** Forget the token (sign-out, 401, mode switch). */
  clearDeviceToken() {
    deviceToken = "";
    return invoke("edusphere:native:clear-device-token");
  },

  /** Native print dialog for the current page. */
  print(options) {
    return invoke("edusphere:native:print", options || {});
  },
  /** Native "Save as PDF" (report cards, receipts) — works with no internet. */
  savePdf(options) {
    return invoke("edusphere:native:save-pdf", options || {});
  },
  /** Open a web link in the user's browser (http/https/mailto only). */
  openExternal(url) {
    return invoke("edusphere:native:open-external", String(url == null ? "" : url));
  },
});

contextBridge.exposeInMainWorld("__EDUSPHERE_NATIVE__", bridge);
