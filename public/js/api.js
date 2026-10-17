"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — API client
   ----------------------------------------------------------------------------
   Same-origin fetch with CSRF double-submit token. All requests go to the
   NEW platform API. The base URL comes from the runtime config served by
   this deployment (window.__APP_CONFIG__.apiBase, via /app-config.js) and
   falls back to same-origin "/api". No hard-coded/old production URLs.
   ========================================================================== */
(function () {
  const BASE =
    (window.__APP_CONFIG__ && window.__APP_CONFIG__.apiBase) || "/api";
  let csrfToken = null;

  async function ensureCsrf() {
    if (csrfToken) return csrfToken;
    const r = await fetch(BASE + "/csrf-token", { credentials: "same-origin" });
    if (!r.ok) throw new Error("Could not obtain CSRF token");
    const d = await r.json();
    csrfToken = d.csrfToken;
    return csrfToken;
  }

  async function request(method, path, body, opts = {}) {
    const headers = { Accept: "application/json" };
    if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers["X-CSRF-Token"] = await ensureCsrf();
    }
    const res = await fetch(BASE + path, {
      method,
      headers,
      credentials: "same-origin",
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
      return request(method, path, body, Object.assign({ retried: true }, opts));
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
      // A 401 on an authenticated call means the session ended server-side
      // (logged out elsewhere, expired, deactivated). Tell the dashboard so
      // it can fall back to the sign-in screen instead of painting a shell
      // whose every request now fails. (The login endpoint itself uses raw
      // fetch and never reaches this branch.)
      if (res.status === 401 && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        try { window.dispatchEvent(new CustomEvent("bello:unauthorized", { detail: { path } })); } catch (e) { /* non-fatal */ }
      }
      const e = new Error((data && data.error) || `Request failed (${res.status})`);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  window.API = {
    /** Absolute URL for a download/print link (respects API_BASE_URL). */
    url: (p) => BASE + p,
    /** Public (logged-out) endpoints — no session, no CSRF needed for GET. */
    public: {
      get: (p) => request("GET", "/public" + p),
      post: (p, b) => fetch(BASE + "/public" + p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(b || {}),
      }).then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) { const e = new Error((d && d.error) || "Request failed"); e.status = r.status; e.data = d; throw e; }
        return d;
      }),
    },
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    put: (p, b) => request("PUT", p, b),
    patch: (p, b) => request("PATCH", p, b),
    del: (p) => request("DELETE", p),
    async login(username, password, remember) {
      let r;
      try {
        r = await fetch(BASE + "/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ username, password, remember: Boolean(remember) }),
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
      return d;
    },
    async me() {
      const r = await fetch(BASE + "/auth/me", { credentials: "same-origin" });
      return r.json();
    },
    logout: () => request("POST", "/auth/logout", {}),
    reportCardUrl: (studentId, termId) => `${BASE}/results/report-card/${studentId}/${termId}`,
    bulkReportSheetsUrl: (classId, termId) => `${BASE}/results/report-cards/bulk?classId=${classId}&termId=${termId}`,
    reportTemplatePreviewUrl: (templateJson) =>
      `${BASE}/results/report-template/preview${templateJson ? `?template=${encodeURIComponent(templateJson)}` : ""}`,
    portalReportUrl: (termId, studentId) =>
      studentId ? `${BASE}/portal/report-card?termId=${termId}&studentId=${studentId}`
                : `${BASE}/portal/report-card?termId=${termId}`,
  };
})();
