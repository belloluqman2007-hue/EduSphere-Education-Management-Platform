"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — API client
   ----------------------------------------------------------------------------
   Same-origin fetch with CSRF double-submit token on the web, plus revocable
   Bearer device-token auth and offline transport-interceptor hooks for native
   Desktop (Electron) and Mobile/Tablet (Capacitor Android/iOS) applications.
   The base URL comes from runtime config (window.__APP_CONFIG__.apiBase, via
   /app-config.js) and falls back to same-origin "/api".
   ========================================================================== */
(function () {
  const BASE =
    (window.__APP_CONFIG__ && window.__APP_CONFIG__.apiBase) || "/api";
  const DEVICE_TOKEN_KEY = "edusphere.deviceToken";
  let csrfToken = null;
  let memoryDeviceToken = "";
  let transportInterceptor = null;

  /* The native shell (Electron desktop → Phase 3, Capacitor mobile → Phase 4)
     injects `window.__EDUSPHERE_NATIVE__` before this script runs. When it is
     present the device token lives in the OPERATING SYSTEM's encrypted store
     (Electron safeStorage / iOS Keychain / Android Keystore) behind that
     bridge, so this file must never keep a copy in localStorage: a bearer
     token in web storage is readable by any script on the page and survives a
     sign-out the OS did not perform. */
  function nativeBridge() {
    if (typeof window === "undefined") return null;
    const bridge = window.__EDUSPHERE_NATIVE__;
    return bridge && typeof bridge.getDeviceToken === "function" ? bridge : null;
  }

  /* The Android Keystore/iOS Keychain read is asynchronous. Wait for the
     native bridge to finish priming before the first authenticated request;
     otherwise a cold app launch can send /auth/me without its saved bearer
     token and incorrectly show the sign-in form. */
  function waitForNativeReady() {
    try {
      const mobile = typeof window !== "undefined" && window.__EDUSPHERE_MOBILE__;
      if (mobile && mobile.ready && typeof mobile.ready.then === "function") {
        return Promise.resolve(mobile.ready).catch(() => {});
      }
    } catch (e) { /* browser or native bootstrap failure */ }
    return Promise.resolve();
  }

  /** Remove a token left behind by an older/browser session (native only). */
  function dropLegacyWebToken() {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem(DEVICE_TOKEN_KEY);
      }
    } catch (e) { /* storage unavailable */ }
  }

  function readStoredDeviceToken() {
    const bridge = nativeBridge();
    if (bridge) {
      try {
        const token = bridge.getDeviceToken();
        return typeof token === "string" ? token : "";
      } catch (e) {
        return "";
      }
    }
    if (memoryDeviceToken) return memoryDeviceToken;
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const stored = window.localStorage.getItem(DEVICE_TOKEN_KEY) || "";
        if (stored) memoryDeviceToken = stored;
        return stored;
      }
    } catch (e) { /* storage unavailable */ }
    return "";
  }

  function setDeviceToken(token) {
    const clean = String(token || "").trim();
    memoryDeviceToken = clean;
    const bridge = nativeBridge();
    if (bridge) {
      let pending;
      try {
        if (clean && typeof bridge.setDeviceToken === "function") {
          pending = bridge.setDeviceToken(clean);
        } else if (!clean && typeof bridge.clearDeviceToken === "function") {
          pending = bridge.clearDeviceToken();
        } else {
          pending = { persisted: false, reason: "secure-store-unavailable" };
        }
      } catch (e) {
        pending = Promise.reject(e);
      }
      dropLegacyWebToken();
      return Promise.resolve(pending)
        .then((result) => ({ persisted: !result || result.persisted !== false, reason: result && result.reason }))
        .catch(() => ({ persisted: false, reason: "secure-store-error" }));
    }
    let persisted = true;
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        if (clean) window.localStorage.setItem(DEVICE_TOKEN_KEY, clean);
        else window.localStorage.removeItem(DEVICE_TOKEN_KEY);
      }
    } catch (e) { persisted = false; }
    return Promise.resolve({ persisted });
  }

  function clearDeviceToken() {
    return setDeviceToken("");
  }

  function isCrossOriginBase() {
    return /^https?:\/\//i.test(BASE);
  }

  async function ensureCsrf() {
    if (csrfToken) return csrfToken;
    const r = await fetch(BASE + "/csrf-token", { credentials: isCrossOriginBase() ? "include" : "same-origin" });
    if (!r.ok) throw new Error("Could not obtain CSRF token");
    const d = await r.json();
    csrfToken = d.csrfToken;
    return csrfToken;
  }

  /* A plain JSON GET. `fetch` is the normal path; the XMLHttpRequest branch
     keeps the public location cascade working on engines without fetch. */
  function getJson(path) {
    const url = BASE + path;
    const bearer = readStoredDeviceToken();
    if (typeof fetch === "function") {
      const headers = { Accept: "application/json" };
      if (bearer) headers.Authorization = "Bearer " + bearer;
      return fetch(url, { headers, credentials: isCrossOriginBase() ? "include" : "same-origin" })
        .then((r) => (r.ok ? r.json().catch(() => ({})) : {}))
        .catch(() => ({}));
    }
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url);
        if (bearer) xhr.setRequestHeader("Authorization", "Bearer " + bearer);
        xhr.onload = () => {
          try {
            resolve(xhr.status >= 200 && xhr.status < 300 ? JSON.parse(xhr.responseText) : {});
          } catch (e) { resolve({}); }
        };
        xhr.onerror = () => resolve({});
        xhr.send();
      } catch (e) { resolve({}); }
    });
  }

  async function onlineRequest(method, path, body, opts = {}) {
    await waitForNativeReady();
    const headers = { Accept: "application/json" };
    const bearer = readStoredDeviceToken();
    if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (bearer) {
      headers.Authorization = "Bearer " + bearer;
    } else if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers["X-CSRF-Token"] = await ensureCsrf();
    }
    const res = await fetch(BASE + path, {
      method,
      headers,
      credentials: isCrossOriginBase() ? "include" : "same-origin",
      body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined),
    });
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) data = await res.json().catch(() => null);

    // A 403 is either an expired CSRF token (retry once) or a real refusal.
    // The body is read FIRST so a plan-gated action is never mistaken for a
    // stale token and silently retried into the same wall.
    const featureGated = Boolean(data && data.code === "feature_gated");
    if (res.status === 403 && headers["X-CSRF-Token"] && !featureGated && !opts.retried) {
      csrfToken = null;
      return onlineRequest(method, path, body, Object.assign({ retried: true }, opts));
    }
    if (!res.ok) {
      /* A plan-gated action is a SALES moment, not a dead end: the server sends
         the feature, the tier that carries it and what that tier includes, and
         the subscription module turns it into the upsell dialog. Any surface
         (admin console, teacher workspace, portal) can listen for this. */
      if (featureGated && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        try {
          window.dispatchEvent(new CustomEvent("edusphere:feature-gated", {
            detail: Object.assign({ path, method }, data),
          }));
        } catch (e) { /* non-fatal */ }
      }
      // A 401 on an authenticated call means the session or device token ended
      // server-side (logged out elsewhere, expired, deactivated).
      if (res.status === 401) {
        if (bearer) await clearDeviceToken();
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
          try { window.dispatchEvent(new CustomEvent("bello:unauthorized", { detail: { path } })); } catch (e) { /* non-fatal */ }
        }
      }
      const e = new Error((data && data.error) || `Request failed (${res.status})`);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  async function request(method, path, body, opts = {}) {
    await waitForNativeReady();
    if (typeof transportInterceptor === "function" && !opts.bypassOfflineInterceptor) {
      return transportInterceptor({
        method,
        path,
        body,
        opts,
        onlineRequest: () => onlineRequest(method, path, body, Object.assign({}, opts, { bypassOfflineInterceptor: true })),
      });
    }
    return onlineRequest(method, path, body, opts);
  }

  window.API = {
    /** Absolute URL for a download/print link (respects API_BASE_URL). */
    url: (p) => BASE + p,
    getDeviceToken: readStoredDeviceToken,
    setDeviceToken,
    clearDeviceToken,
    /** Hook used by sync-engine.js to serve cached reads & queue offline writes. */
    setTransportInterceptor(fn) {
      transportInterceptor = typeof fn === "function" ? fn : null;
    },
    /** Offline-first sync transport helpers (/api/sync/*). */
    sync: {
      status: () => onlineRequest("GET", "/sync/status", undefined, { bypassOfflineInterceptor: true }),
      pull: (since) => onlineRequest(
        "GET",
        "/sync/pull" + (since ? "?since=" + encodeURIComponent(since) : ""),
        undefined,
        { bypassOfflineInterceptor: true }
      ),
      push: (mutations, deviceId) => onlineRequest(
        "POST",
        "/sync/push",
        { mutations: Array.isArray(mutations) ? mutations : [], deviceId: deviceId || "" },
        { bypassOfflineInterceptor: true }
      ),
    },
    /** Public (logged-out) endpoints — no session, no CSRF needed for GET. */
    public: {
      get: (p) => request("GET", "/public" + p),
      /* The State → City → Town index behind the registration forms. */
      locations: (p) => getJson("/public/locations" + (p || "")),
      post: (p, b) => fetch(BASE + "/public" + p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: isCrossOriginBase() ? "include" : "same-origin",
        body: JSON.stringify(b || {}),
      }).then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) { const e = new Error((d && d.error) || "Request failed"); e.status = r.status; e.data = d; throw e; }
        return d;
      }),
    },
    get: (p, opts) => request("GET", p, undefined, opts),
    post: (p, b, opts) => request("POST", p, b, opts),
    put: (p, b, opts) => request("PUT", p, b, opts),
    patch: (p, b, opts) => request("PATCH", p, b, opts),
    del: (p, opts) => request("DELETE", p, undefined, opts),
    async login(username, password, remember, deviceOpts) {
      await waitForNativeReady();
      const nativeInfo = (typeof window !== "undefined" && window.__EDUSPHERE_NATIVE__) || null;
      const opts = deviceOpts || (nativeInfo ? {
        issueDeviceToken: true,
        deviceId: nativeInfo.deviceId || "",
        deviceName: nativeInfo.deviceName || "",
        platform: nativeInfo.platform || "native",
      } : null);
      const loginBody = { username, password, remember: Boolean(remember) };
      if (opts && opts.issueDeviceToken) {
        loginBody.issueDeviceToken = true;
        if (opts.deviceId) loginBody.deviceId = String(opts.deviceId);
        if (opts.deviceName) loginBody.deviceName = String(opts.deviceName);
        if (opts.platform) loginBody.platform = String(opts.platform);
      }
      let r;
      try {
        r = await fetch(BASE + "/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: isCrossOriginBase() ? "include" : "same-origin",
          body: JSON.stringify(loginBody),
        });
      } catch (networkError) {
        // DNS failure, offline, server down, TLS error… fetch rejects and the
        // caller previously saw nothing at all. Give it a real message.
        const e = new Error("Could not reach the server. Check your connection and try again.");
        e.status = 0;
        e.cause = networkError;
        throw e;
      }
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        // A proxy/host error page is not JSON, so there is no d.error to show:
        // fall back to something that names the actual problem by status.
        let message = (d && d.error) || "";
        if (!message) {
          if (r.status === 429) message = "Too many sign-in attempts. Please wait a few minutes and try again.";
          else if (r.status >= 500) message = `The server could not complete the sign-in (error ${r.status}). Please try again shortly.`;
          else message = `Sign-in failed (error ${r.status}).`;
        }
        const e = new Error(message);
        e.status = r.status;
        e.data = d;
        throw e;
      }
      if (d && d.deviceToken) {
        const saved = await setDeviceToken(d.deviceToken);
        if (nativeInfo && saved && !saved.persisted) {
          const e = new Error("You signed in, but this phone could not securely save your session. Please try again.");
          e.code = "DEVICE_TOKEN_SAVE_ERROR";
          throw e;
        }
      }
      return d;
    },
    async me() {
      await waitForNativeReady();
      if (typeof transportInterceptor === "function") {
        return transportInterceptor({
          method: "GET",
          path: "/auth/me",
          body: undefined,
          opts: {},
          onlineRequest: async () => {
            const bearer = readStoredDeviceToken();
            const headers = bearer ? { Authorization: "Bearer " + bearer } : {};
            const r = await fetch(BASE + "/auth/me", { headers, credentials: isCrossOriginBase() ? "include" : "same-origin" });
            return r.json();
          },
        });
      }
      const bearer = readStoredDeviceToken();
      const headers = bearer ? { Authorization: "Bearer " + bearer } : {};
      const r = await fetch(BASE + "/auth/me", { headers, credentials: isCrossOriginBase() ? "include" : "same-origin" });
      return r.json();
    },
    async logout() {
      try {
        return await request("POST", "/auth/logout", {});
      } finally {
        csrfToken = null;
        await clearDeviceToken();
      }
    },
    reportCardUrl: (studentId, termId) => `${BASE}/results/report-card/${studentId}/${termId}`,
    bulkReportSheetsUrl: (classId, termId) => `${BASE}/results/report-cards/bulk?classId=${classId}&termId=${termId}`,
    reportTemplatePreviewUrl: (templateJson) =>
      `${BASE}/results/report-template/preview${templateJson ? `?template=${encodeURIComponent(templateJson)}` : ""}`,
    portalReportUrl: (termId, studentId) =>
      studentId ? `${BASE}/portal/report-card?termId=${termId}&studentId=${studentId}`
                : `${BASE}/portal/report-card?termId=${termId}`,
  };
})();
