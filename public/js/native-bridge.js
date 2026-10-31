"use strict";
/* ============================================================================
   EduSphere — NATIVE BRIDGE (Capacitor: Android phones/tablets, iPhone/iPad)
   ----------------------------------------------------------------------------
   Phase 4's job is to make the SAME web bundle that runs in a browser behave
   like native software on a phone. Electron (Phase 3) could inject the bridge
   from a preload script; a Capacitor WebView cannot, so this file builds it
   from `window.Capacitor` before `api.js` runs.

   The page therefore sees exactly ONE frozen object, byte-for-byte the same
   contract the desktop shell exposes:

     window.__EDUSPHERE_NATIVE__ = {
       isNative, appVersion, platform, deviceId, deviceName, mode,
       getDeviceToken(), setDeviceToken(t), clearDeviceToken(),
       print(options), savePdf(options), openExternal(url)
     }

   That is the whole point: `public/js/api.js` already prefers this object, so
   the mobile app mints the same Phase 1 Bearer device tokens, reuses the same
   Phase 2 offline engine, and never grows a second implementation.

   WHAT IS DELIBERATE HERE
     1. TOKENS LIVE IN THE OS KEYCHAIN / ANDROID KEYSTORE, never in
        localStorage, never in a plain file, never in a cookie. The native
        plugin (`EduSphereNative`) encrypts with an AndroidKeyStore AES-GCM key
        / iOS Keychain item. `@capacitor/preferences` is only a fallback when
        the native plugin is missing, and plain localStorage is never used.
     2. `getDeviceToken()` is SYNCHRONOUS because `api.js` calls it on every
        request. The value is primed once at boot and held in this closure;
        writes go straight back to the OS store. A 401 that arrives BEFORE the
        prime finished is deferred, so a cold start can never delete a healthy
        token.
     3. SERVER ADDRESS is public configuration, not a secret. It is kept in
        localStorage so `api.js` can compute its base URL synchronously, and it
        is validated against an allow-list: https anywhere, http only on a
        private LAN address (that is how a phone pairs with a school's LAN hub).
     4. NO REMOTE CODE, NO EVAL. Nothing here loads a script from anywhere.
     5. ZERO BLANK SCREENS. Uncaught errors, unhandled rejections and a boot
        that paints nothing all end on a friendly recovery screen instead of a
        white WebView.
   ========================================================================== */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  /* The Electron shell (Phase 3) has already exposed the contract. Nothing to
     do — and critically, nothing to overwrite. */
  if (window.__EDUSPHERE_NATIVE__) return;

  const cap = window.Capacitor;
  let isNative = false;
  try {
    isNative = Boolean(cap && (typeof cap.isNativePlatform === "function" ? cap.isNativePlatform() : cap.isNative));
  } catch (e) {
    isNative = false;
  }
  /* A browser (and the jsdom test harness when it does not opt in) keeps the
     Phase 2 behaviour exactly as it is today. */
  if (!isNative) return;

  const VERSION = "1.0.0";
  const TOKEN_KEY = "device_token";
  const DEVICE_ID_KEY = "device_id";
  const DEVICE_NAME_KEY = "device_name";
  /* Public configuration only — never a credential. */
  const SERVER_STORAGE_KEY = "edusphere.mobile.server";
  const SERVER_STORAGE_KEY_LEGACY = "edusphere.server";
  const CRASH_SCREEN_ID = "edusphere-native-crash";

  const platform = (function () {
    try {
      const value = typeof cap.getPlatform === "function" ? cap.getPlatform() : cap.platform;
      if (value === "ios") return "ios";
      return "android";
    } catch (e) {
      return "android";
    }
  })();

  const Plugins = (cap && cap.Plugins) || {};
  const nativePlugin = Plugins.EduSphereNative || null;
  const appPlugin = Plugins.App || null;
  const networkPlugin = Plugins.Network || null;
  const preferencesPlugin = Plugins.Preferences || null;

  /* ------------------------------ utilities ------------------------------- */

  function str(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  /** Calls a plugin method without ever letting a missing/broken plugin throw. */
  function call(plugin, method, payload) {
    if (!plugin || typeof plugin[method] !== "function") return Promise.resolve(null);
    try {
      const result = plugin[method](payload === undefined ? {} : payload);
      if (result && typeof result.then === "function") return result.catch(() => null);
      return Promise.resolve(result === undefined ? null : result);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    } catch (e) { /* fall through */ }
    const bytes = new Uint8Array(16);
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === "function") window.crypto.getRandomValues(bytes);
      else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    } catch (e) {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.prototype.map.call(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function deviceNameFor(value) {
    const raw = str(value);
    if (raw) return raw;
    return platform === "ios" ? "iPhone or iPad" : "Android phone or tablet";
  }

  /* --------------------------- secure token store -------------------------
     Provider order:
       EduSphereNative  → AndroidKeyStore AES-GCM / iOS Keychain (the real one)
       Preferences      → only if a build shipped without the native plugin
       memory           → nothing durable, reported so the UI can say so

     localStorage is NEVER in this chain: a bearer credential kept in web
     storage is readable by any script the page loads and survives a sign-out
     the OS did not perform.
  ------------------------------------------------------------------------- */
  const store = { provider: "memory", durable: false };

  function secureGet(key) {
    if (nativePlugin && typeof nativePlugin.getSecureValue === "function") {
      return call(nativePlugin, "getSecureValue", { key }).then((res) => str(res && res.value));
    }
    if (preferencesPlugin && typeof preferencesPlugin.get === "function") {
      return call(preferencesPlugin, "get", { key: "edusphere." + key }).then((res) => str(res && res.value));
    }
    return Promise.resolve("");
  }

  function secureSet(key, value) {
    if (nativePlugin && typeof nativePlugin.setSecureValue === "function") {
      /* A write failure must be visible to the caller (and to the UI): "signed
         in, but the token could not be saved" is a different situation from
         "saved". */
      try {
        return Promise.resolve(nativePlugin.setSecureValue({ key, value: str(value) }))
          .then((res) => ({ persisted: !res || res.persisted !== false }))
          .catch(() => ({ persisted: false, reason: "plugin-error" }));
      } catch (e) {
        return Promise.resolve({ persisted: false, reason: "plugin-error" });
      }
    }
    if (preferencesPlugin && typeof preferencesPlugin.set === "function") {
      return call(preferencesPlugin, "set", { key: "edusphere." + key, value: str(value) }).then(() => ({ persisted: true }));
    }
    return Promise.resolve({ persisted: false, reason: "no-secure-store" });
  }

  function secureRemove(key) {
    if (nativePlugin && typeof nativePlugin.removeSecureValue === "function") {
      return call(nativePlugin, "removeSecureValue", { key }).then(() => ({ persisted: true }));
    }
    if (preferencesPlugin && typeof preferencesPlugin.remove === "function") {
      return call(preferencesPlugin, "remove", { key: "edusphere." + key }).then(() => ({ persisted: true }));
    }
    return Promise.resolve({ persisted: false, reason: "no-secure-store" });
  }

  function detectSecureProvider() {
    if (nativePlugin && typeof nativePlugin.getSecureValue === "function" && typeof nativePlugin.setSecureValue === "function") {
      store.provider = platform === "ios" ? "ios-keychain" : "android-keystore";
      store.durable = true;
    } else if (preferencesPlugin && typeof preferencesPlugin.get === "function") {
      store.provider = "capacitor-preferences";
      store.durable = true;
    } else {
      store.provider = "memory";
      store.durable = false;
      try {
        if (console && console.warn) console.warn("[native-bridge] No secure storage plugin: the sign-in lasts for this session only.");
      } catch (e) { /* console optional */ }
    }
  }

  /* ------------------------------ server URL ------------------------------
     A school LAN hub is reached at http://192.168.x.x:port (the desktop hub
     serves plain HTTP on the LAN). Everything else must be https. That is the
     URL allow-list the app enforces before it will talk to a host.
  ------------------------------------------------------------------------- */
  const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9][a-z0-9-]*\.local)$/i;

  function normalizeServerUrl(raw) {
    const text = str(raw).trim();
    if (!text || text.length > 512) return "";
    if (/[\u0000-\u0020]/.test(text)) return "";
    let url;
    try {
      url = new URL(text);
    } catch (e) {
      /* A bare host ("school.edusphere.app" or "192.168.1.5:4123") is what a
         person types; assume https unless it is a private LAN host. */
      try { url = new URL("https://" + text); } catch (err) { return ""; }
    }
    if (url.username || url.password) return "";
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.protocol === "http:" && !PRIVATE_HOST.test(url.hostname)) return "";
    if (url.port === "0") return "";
    const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
    if (/\.\./.test(path)) return "";
    return url.protocol + "//" + url.host + path;
  }

  function readStoredServer() {
    try {
      const direct = window.localStorage.getItem(SERVER_STORAGE_KEY);
      if (direct) return normalizeServerUrl(direct);
      const legacy = window.localStorage.getItem(SERVER_STORAGE_KEY_LEGACY);
      if (legacy) return normalizeServerUrl(legacy);
    } catch (e) { /* storage unavailable */ }
    return "";
  }

  function setServerUrl(raw) {
    const clean = normalizeServerUrl(raw);
    if (!clean) return "";
    try { window.localStorage.setItem(SERVER_STORAGE_KEY, clean); } catch (e) { /* storage unavailable */ }
    serverUrl = clean;
    normalizeUploadedImageUrls();
    /* Keep the runtime config in step so a live switch (a pairing deep link)
       points `api.js` at the new server without waiting for a reload. */
    try {
      const config = window.__APP_CONFIG__ || {};
      config.apiBase = clean + "/api";
      config.requiresPairing = false;
      config.nativeApp = true;
      config.nativePlatform = platform;
      window.__APP_CONFIG__ = config;
    } catch (e) { /* a read-only config must not break pairing */ }
    return clean;
  }

  function clearServerUrl() {
    try {
      window.localStorage.removeItem(SERVER_STORAGE_KEY);
      window.localStorage.removeItem(SERVER_STORAGE_KEY_LEGACY);
    } catch (e) { /* storage unavailable */ }
    serverUrl = "";
    try {
      const config = window.__APP_CONFIG__ || {};
      config.requiresPairing = true;
      window.__APP_CONFIG__ = config;
    } catch (e) { /* non-fatal */ }
    return "";
  }

  function apiBaseFor(base) {
    const clean = normalizeServerUrl(base || serverUrl);
    return clean ? clean + "/api" : "/api";
  }

  /* The native UI is hosted at capacitor://localhost / http://localhost, while
     uploaded media belongs to the paired school server. Without this rewrite,
     an <img src="/uploads/..."> is requested from the app bundle's localhost
     and fails even though the same photo works in a browser. */
  const mediaObjectUrls = new WeakMap();
  const activeMediaUrls = new Set();
  function releaseMediaUrl(image) {
    const old = mediaObjectUrls.get(image);
    if (old && window.URL && typeof window.URL.revokeObjectURL === "function") {
      window.URL.revokeObjectURL(old);
      activeMediaUrls.delete(old);
      mediaObjectUrls.delete(image);
    }
  }

  function normalizeUploadedImageUrls(root) {
    if (!serverUrl || typeof document === "undefined") return;
    const scope = root && root.querySelectorAll ? root : document;
    const images = [];
    if (scope.matches && scope.matches("img[src]")) images.push(scope);
    if (scope.querySelectorAll) images.push.apply(images, scope.querySelectorAll("img[src]"));
    images.forEach((image) => {
      const src = image.getAttribute("src") || "";
      if (/^\/uploads\//i.test(src)) {
        const remote = serverUrl + src;
        releaseMediaUrl(image);
        image.src = remote;
        // Native sessions use a bearer token rather than a browser cookie.
        // An <img> cannot send that header, so fetch authenticated media and
        // display a blob URL without ever putting the token in a URL.
        ready.then(() => {
          if (!token || typeof window.fetch !== "function" || !window.URL || typeof window.URL.createObjectURL !== "function") return;
          return window.fetch(remote, { headers: { Authorization: "Bearer " + token } }).then((response) => {
            if (!response.ok) return null;
            return response.blob();
          }).then((blob) => {
            if (!blob || image.src !== remote) return;
            const objectUrl = window.URL.createObjectURL(blob);
            mediaObjectUrls.set(image, objectUrl);
            activeMediaUrls.add(objectUrl);
            image.src = objectUrl;
          }).catch(() => {});
        });
      }
    });
  }

  function installUploadedImageUrlFix() {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    normalizeUploadedImageUrls(document);
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === "attributes") normalizeUploadedImageUrls(record.target.parentNode || document);
        else {
          record.addedNodes.forEach((node) => {
            if (node.nodeType === 1) normalizeUploadedImageUrls(node);
          });
          record.removedNodes.forEach((node) => {
            if (node.nodeType !== 1 || node.isConnected) return;
            if (node.matches && node.matches("img")) releaseMediaUrl(node);
            if (node.querySelectorAll) node.querySelectorAll("img").forEach(releaseMediaUrl);
          });
        }
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    window.addEventListener("pagehide", (event) => {
      if (event.persisted) return;
      if (window.URL && typeof window.URL.revokeObjectURL === "function") {
        activeMediaUrls.forEach((url) => window.URL.revokeObjectURL(url));
        activeMediaUrls.clear();
      }
    });
  }

  /* ------------------------------ boot state ------------------------------ */

  let token = "";
  let primed = false;
  let pendingClear = false;
  let deviceId = uuid();          // usable immediately; adopted from the store below
  let deviceName = "";
  let appVersion = "";
  let serverUrl = readStoredServer();

  /* Before api.js is evaluated (this file is loaded first), give the app its
     absolute API base so Bearer requests reach the school's server instead of
     the WebView's own asset host. */
  (function configureApp() {
    try {
      const existing = window.__APP_CONFIG__ || {};
      const config = Object.assign({}, existing);
      config.apiBase = serverUrl ? serverUrl + "/api" : str(existing.apiBase) || "/api";
      config.nativeApp = true;
      config.nativePlatform = platform;
      if (!serverUrl) config.requiresPairing = true;
      if (config.offlineSync === undefined) config.offlineSync = true;
      if (config.syncVersion === undefined) config.syncVersion = 1;
      window.__APP_CONFIG__ = config;
    } catch (e) { /* a read-only config must not break the app */ }
  })();

  detectSecureProvider();

  const ready = (async () => {
    try {
      const values = await Promise.all([
        secureGet(TOKEN_KEY),
        secureGet(DEVICE_ID_KEY),
        secureGet(DEVICE_NAME_KEY),
      ]);
      const [storedToken, storedDeviceId, storedName] = values;
      if (storedToken) token = storedToken;
      if (storedDeviceId) deviceId = storedDeviceId;
      else secureSet(DEVICE_ID_KEY, deviceId).catch(() => {});
      deviceName = deviceNameFor(storedName);
      if (!storedName) secureSet(DEVICE_NAME_KEY, deviceName).catch(() => {});
      primed = true;

      /* A token left in web storage by an older browser session is a live
         credential any script on the page could read. On a native install it
         is always stale: the OS store is the only truth. */
      try {
        const webStore = window.localStorage;
        if (webStore && typeof webStore.removeItem === "function") {
          webStore.removeItem("edusphere.deviceToken");
        }
      } catch (e) { /* storage unavailable */ }

      /* A 401 that landed during the cold start must not outlive the prime:
         the operator really was signed out, so honour it now. */
      if (pendingClear) {
        pendingClear = false;
        token = "";
        await secureRemove(TOKEN_KEY);
      }

      if (appPlugin && typeof appPlugin.getInfo === "function") {
        const info = await call(appPlugin, "getInfo", {});
        if (info && info.version) appVersion = str(info.version);
      }
      if (nativePlugin && typeof nativePlugin.getDeviceModel === "function") {
        const model = await call(nativePlugin, "getDeviceModel", {});
        const label = str(model && model.model);
        if (label) {
          deviceName = label;
          await secureSet(DEVICE_NAME_KEY, deviceName);
        }
      }
      try {
        window.dispatchEvent(new CustomEvent("edusphere:native-ready", {
          detail: { platform, provider: store.provider, hasToken: Boolean(token) },
        }));
      } catch (e) { /* CustomEvent optional */ }
      return true;
    } catch (e) {
      primed = true;
      return false;
    }
  })();

  /* ------------------------------ the contract ---------------------------- */

  function setDeviceToken(value) {
    const clean = str(value).trim();
    token = clean;
    if (!clean) {
      pendingClear = false;
      return secureRemove(TOKEN_KEY);
    }
    pendingClear = false;
    return secureSet(TOKEN_KEY, clean);
  }

  function clearDeviceToken() {
    token = "";
    /* Still priming: remember the intent instead of racing the read. A write
       that beat the read would delete a perfectly good token on every cold
       start. */
    if (!primed) {
      pendingClear = true;
      return Promise.resolve({ cleared: false, deferred: true });
    }
    return secureRemove(TOKEN_KEY);
  }

  function openExternal(url) {
    const target = str(url).trim();
    if (!target || target.length > 2048 || /[\u0000-\u0020]/.test(target)) {
      return Promise.resolve({ ok: false, reason: "blocked" });
    }
    const allowed = /^(https?:|mailto:|tel:)/i.test(target);
    const denied = /^(javascript|data|file|content|intent|vbscript|blob|about):/i.test(target);
    if (!allowed || denied) return Promise.resolve({ ok: false, reason: "blocked" });
    return call(nativePlugin, "openExternal", { url: target }).then((result) => {
      if (result && result.opened === false) return { ok: false, reason: "failed" };
      if (nativePlugin && typeof nativePlugin.openExternal === "function") return { ok: true };
      try {
        window.open(target, "_blank", "noopener,noreferrer");
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: "failed" };
      }
    });
  }

  const bridge = {};
  Object.defineProperties(bridge, {
    isNative: { value: true, enumerable: true },
    appVersion: { get() { return appVersion; }, enumerable: true },
    platform: { value: platform, enumerable: true },
    deviceId: { get() { return deviceId; }, enumerable: true },
    deviceName: { get() { return deviceName; }, enumerable: true },
    mode: { value: "cloud", enumerable: true },
    getDeviceToken: { value: function getDeviceToken() { return token; }, enumerable: true },
    setDeviceToken: { value: function (value) { return setDeviceToken(value); }, enumerable: true },
    clearDeviceToken: { value: function () { return clearDeviceToken(); }, enumerable: true },
    print: {
      value: function (options) {
        if (nativePlugin && typeof nativePlugin.print === "function") {
          return call(nativePlugin, "print", options || {}).then((result) => (result || { ok: true }));
        }
        try {
          if (typeof window.print === "function") {
            window.print();
            return Promise.resolve({ ok: true, method: "webview" });
          }
        } catch (e) { /* printing is optional */ }
        return Promise.resolve({ ok: false, reason: "unavailable" });
      },
      enumerable: true,
    },
    savePdf: {
      value: function (options) {
        if (nativePlugin && typeof nativePlugin.savePdf === "function") {
          return call(nativePlugin, "savePdf", options || {}).then((result) => (result || { ok: true }));
        }
        /* No silent failure: the caller can offer the share/print sheet. */
        return Promise.resolve({ ok: false, reason: "unavailable", hint: "Use Print, then choose Save as PDF." });
      },
      enumerable: true,
    },
    openExternal: { value: function (url) { return openExternal(url); }, enumerable: true },
  });
  Object.freeze(bridge);
  window.__EDUSPHERE_NATIVE__ = bridge;

  /* ------------------------------ deep links ------------------------------ */
  const ROUTE_SEGMENT = /^[a-z0-9][a-z0-9\-/]{0,120}$/i;

  /**
   * `edusphere://sync`, `edusphere://open/students`, `edusphere://hub?url=…`
   * Anything else — a foreign scheme, a traversal, a control character, a
   * public http host — is refused and returns null.
   */
  function parseDeepLink(raw) {
    const text = str(raw).trim();
    if (!text || text.length > 512) return null;
    if (/[\u0000-\u001f]/.test(text)) return null;
    /* The URL parser silently resolves "a/../b"; refuse the attempt outright. */
    if (/(^|\/)\.\.(\/|$)/.test(text.replace(/^[a-z]+:\/\//i, ""))) return null;
    let url;
    try { url = new URL(text); } catch (e) { return null; }
    if (url.protocol !== "edusphere:") return null;
    const host = str(url.hostname).toLowerCase();
    const path = decodeURIComponent(str(url.pathname).replace(/^\/+/, ""));
    if (host === "sync") return { action: "sync" };
    if (host === "open") {
      if (!path || !ROUTE_SEGMENT.test(path) || path.indexOf("..") !== -1) return null;
      return { action: "open", path: "/" + path };
    }
    if (host === "hub" || host === "pair") {
      const server = normalizeServerUrl(url.searchParams.get("url"));
      if (!server) return null;
      return { action: "hub", serverUrl: server };
    }
    if (host === "settings") return { action: "settings" };
    if (host === "about") return { action: "about" };
    return null;
  }

  function handleDeepLink(raw) {
    const action = parseDeepLink(raw);
    if (!action) return Promise.resolve({ ok: false, reason: "blocked" });
    if (action.action === "hub") {
      const saved = setServerUrl(action.serverUrl);
      if (!saved) return Promise.resolve({ ok: false, reason: "blocked" });
      try { window.location.reload(); } catch (e) { /* non-fatal */ }
      return Promise.resolve({ ok: true, action: "hub", serverUrl: saved });
    }
    if (action.action === "sync") {
      try {
        if (window.SyncEngine && typeof window.SyncEngine.syncNow === "function") {
          window.SyncEngine.syncNow().catch(() => {});
        }
      } catch (e) { /* non-fatal */ }
      return Promise.resolve({ ok: true, action: "sync" });
    }
    if (action.action === "open") {
      try {
        if (window.BelloRouter && typeof window.BelloRouter.navigate === "function") {
          window.BelloRouter.navigate(action.path);
        } else if (window.history && typeof window.history.pushState === "function") {
          window.history.pushState(null, "", action.path);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
      } catch (e) { /* non-fatal */ }
      return Promise.resolve({ ok: true, action: "open", path: action.path });
    }
    try {
      window.dispatchEvent(new CustomEvent("edusphere:deep-link", { detail: action }));
    } catch (e) { /* CustomEvent optional */ }
    return Promise.resolve({ ok: true, action: action.action });
  }

  function installDeepLinks() {
    if (!appPlugin || typeof appPlugin.addListener !== "function") return false;
    try {
      appPlugin.addListener("appUrlOpen", (event) => {
        if (event && event.url) handleDeepLink(event.url);
      });
      if (typeof appPlugin.getLaunchUrl === "function") {
        call(appPlugin, "getLaunchUrl", {}).then((result) => {
          if (result && result.url) handleDeepLink(result.url);
        });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------------------- error boundary ----------------------------
     A WebView that shows a white rectangle is indistinguishable from a broken
     product. Every unexpected failure lands on a screen that names what
     happened in plain language and offers the one action that helps.
  ------------------------------------------------------------------------- */
  let crashShown = false;

  function showFriendlyScreen(kind, detail) {
    try {
      if (typeof document === "undefined" || !document.body) return null;
      crashShown = true;
      let host = document.getElementById(CRASH_SCREEN_ID);
      if (!host) {
        host = document.createElement("div");
        host.id = CRASH_SCREEN_ID;
        host.setAttribute("role", "alertdialog");
        host.setAttribute("aria-live", "assertive");
        host.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;" +
          "align-items:center;justify-content:center;gap:14px;padding:28px;text-align:center;" +
          "background:#220b40;color:#fff;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;";
        const title = document.createElement("h1");
        title.style.cssText = "font-size:1.25rem;margin:0;font-weight:700;";
        title.textContent = kind === "startup"
          ? "EduSphere could not finish starting"
          : "Something went wrong on this screen";
        const message = document.createElement("p");
        message.style.cssText = "margin:0;max-width:34rem;line-height:1.55;opacity:.9;font-size:.95rem;";
        message.textContent = kind === "startup"
          ? "Your saved school data is still on this device. Nothing was lost. Reopen the app; if this repeats, sign in again."
          : "Your work is saved on this device and will sync when the app is back. Reopen the screen to continue.";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Reload EduSphere";
        button.style.cssText = "min-height:48px;padding:0 24px;border-radius:999px;border:0;background:#f4c542;" +
          "color:#220b40;font-weight:700;font-size:1rem;cursor:pointer;";
        button.addEventListener("click", () => {
          try { window.location.reload(); } catch (e) { /* non-fatal */ }
        });
        const details = document.createElement("p");
        details.style.cssText = "margin:0;max-width:34rem;font-size:.75rem;opacity:.55;word-break:break-word;";
        details.textContent = str(detail).slice(0, 240);
        host.appendChild(title);
        host.appendChild(message);
        host.appendChild(button);
        if (str(detail)) host.appendChild(details);
        document.body.appendChild(host);
      }
      return host;
    } catch (e) {
      return null;
    }
  }

  function installErrorBoundary() {
    if (installErrorBoundary.installed) return false;
    installErrorBoundary.installed = true;
    try {
      window.addEventListener("error", (event) => {
        showFriendlyScreen("runtime", event && event.message);
      });
      window.addEventListener("unhandledrejection", (event) => {
        const reason = event && event.reason;
        showFriendlyScreen("runtime", reason && (reason.message || reason));
      });
      /* The boot watchdog: if the shell painted nothing at all, say so
         instead of leaving the operator on a dark rectangle. */
      setTimeout(() => {
        try {
          const root = document.getElementById("app");
          if (crashShown) return;
          if (root && root.childElementCount === 0) showFriendlyScreen("startup", "The app shell did not render.");
        } catch (e) { /* non-fatal */ }
      }, 12000);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------- camera -------------------------------- */
  const CAMERA_STATES = ["granted", "denied", "prompt", "prompt-with-rationale", "denied-permanently", "unknown"];

  function normalizeCameraState(value) {
    const state = str(value).toLowerCase();
    return CAMERA_STATES.includes(state) ? state : "unknown";
  }

  function cameraPermissionState() {
    return call(nativePlugin, "getCameraPermission", {}).then((result) => ({
      state: normalizeCameraState(result && result.state),
      native: Boolean(nativePlugin && typeof nativePlugin.getCameraPermission === "function"),
    }));
  }

  function requestCameraPermission() {
    /* Already granted or permanently refused: asking again would either be a
       no-op or a lie ("Allow" opens nothing). Let the caller branch. */
    return cameraPermissionState().then((current) => {
      if (current.state === "granted" || current.state === "denied-permanently") return current;
      return call(nativePlugin, "requestCameraPermission", {}).then((result) => ({
        state: normalizeCameraState(result && result.state) === "unknown" ? "prompt" : normalizeCameraState(result && result.state),
        native: Boolean(nativePlugin && typeof nativePlugin.requestCameraPermission === "function"),
      }));
    });
  }

  function openAppSettings() {
    return call(nativePlugin, "openAppSettings", {}).then(() => ({ ok: true }));
  }

  /* ------------------------------- sqlite -------------------------------- */
  function sqliteAvailable() {
    return Boolean(nativePlugin &&
      typeof nativePlugin.sqliteQuery === "function" &&
      typeof nativePlugin.sqliteExec === "function");
  }

  function sqliteQuery(sql, params) {
    if (!sqliteAvailable()) return Promise.reject(new Error("Native SQLite is not available"));
    return call(nativePlugin, "sqliteQuery", { sql: str(sql), params: Array.isArray(params) ? params : [] })
      .then((result) => ({ rows: (result && Array.isArray(result.rows)) ? result.rows : [] }));
  }

  function sqliteExec(sql, params) {
    if (!sqliteAvailable()) return Promise.reject(new Error("Native SQLite is not available"));
    return call(nativePlugin, "sqliteExec", { sql: str(sql), params: Array.isArray(params) ? params : [] })
      .then((result) => ({ rowsAffected: (result && result.rowsAffected) || 0 }));
  }

  /* --------------------------- public surfaces --------------------------- */
  const mobile = {
    ready,
    version: VERSION,
    platform,
    plugins: Object.freeze({
      native: nativePlugin,
      app: appPlugin,
      network: networkPlugin,
      preferences: preferencesPlugin,
    }),
    secure: Object.freeze({
      provider: () => store.provider,
      durable: () => store.durable,
      get: secureGet,
      set: secureSet,
      remove: secureRemove,
    }),
    server: Object.freeze({
      get: () => serverUrl,
      set: setServerUrl,
      clear: clearServerUrl,
      normalize: normalizeServerUrl,
      apiBase: apiBaseFor,
      requiresPairing: () => !serverUrl,
    }),
    sqlite: Object.freeze({ available: sqliteAvailable, query: sqliteQuery, execute: sqliteExec }),
    camera: Object.freeze({
      state: cameraPermissionState,
      request: requestCameraPermission,
      openSettings: openAppSettings,
    }),
    device: Object.freeze({
      id: () => deviceId,
      name: () => deviceName,
      isPrimed: () => primed,
    }),
    deepLink: parseDeepLink,
    handleDeepLink,
    installDeepLinks,
    showFriendlyScreen,
    installErrorBoundary,
    normalizeServerUrl,
  };
  Object.freeze(mobile);
  window.__EDUSPHERE_MOBILE__ = mobile;

  /* Native look: the stylesheet keys off these classes for safe areas, touch
     targets and the tablet layout. */
  try {
    const root = document.documentElement;
    if (root && root.classList) {
      root.classList.add("is-native");
      root.classList.add("platform-" + platform);
    }
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) meta.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1");
  } catch (e) { /* non-fatal */ }

  installErrorBoundary();
  installDeepLinks();
  installUploadedImageUrlFix();
})();
