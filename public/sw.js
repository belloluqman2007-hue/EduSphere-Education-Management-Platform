"use strict";
/* ============================================================================
   EduSphere — APP SHELL SERVICE WORKER
   ----------------------------------------------------------------------------
   Cold-launching the installed app with no internet must still paint the whole
   workspace: the HTML shell, every stylesheet and every script. This worker
   precaches that shell on install and serves it cache-first afterwards, so the
   very first frame does not depend on the network.

   Deliberate limits:
     • /api/* is NEVER cached here. Tenant data lives in the scoped
       IndexedDB store (offline-db.js) keyed by (madrasaId, userId) — a shared
       service-worker cache would leak one account's rows to the next person
       who signs in on the same school PC. The sync engine is the only thing
       that touches application data.
     • /uploads/* is user content served by the server; not precached.
     • Navigation requests fall back to the cached shell so a phone that opens
       the installed app in a tunnel still boots.

   When you add a JS or CSS file to the shell, add it here too and bump
   SHELL_VERSION — the activate handler deletes the previous cache.
   ========================================================================== */

const SHELL_VERSION = "edusphere-shell-v6";
const SHELL_CACHE = `${SHELL_VERSION}-static`;
const RUNTIME_CACHE = `${SHELL_VERSION}-runtime`;

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/app-config.js",
  "/assets/edusphere-logo.png",
  "/assets/edusphere-logo-lockup.png",
  "/assets/edusphere-app-icon.png",
  "/assets/edusphere-app-icon-192.png",

  /* stylesheets (must match public/index.html) */
  "/css/app.css",
  "/css/school-site.css",
  "/css/dashboard.css",
  "/css/student-management.css",
  "/css/admin-teacher-classes.css",
  "/css/academic-admissions.css",
  "/css/leave.css",
  "/css/library.css",
  "/css/ptm.css",
  "/css/portal.css",
  "/css/profile-documents.css",
  "/css/support-chat.css",
  "/css/subscription.css",
  "/css/print.css",
  "/css/offline-sync.css",
  "/css/mobile-native.css",

  /* scripts (must match public/index.html) */
  "/js/native-boot.js",
  "/js/mobile-updates.js",
  "/js/native-bridge.js",
  "/js/mobile-storage.js",
  "/js/api.js",
  "/js/offline-db.js",
  "/js/sync-engine.js",
  "/js/sync-ui.js",
  "/js/mobile-shell.js",
  "/js/print-page.js",
  "/js/register.js",
  "/js/register-academy.js",
  "/js/my-institution.js",
  "/js/admin-teacher-classes.js",
  "/js/academic-admissions.js",
  "/js/payroll.js",
  "/js/leave.js",
  "/js/library.js",
  "/js/health.js",
  "/js/ptm.js",
  "/js/parent-ptm.js",
  "/js/expenses.js",
  "/js/profile-photo.js",
  "/js/card-scanner.js",
  "/js/certificate-designer.js",
  "/js/portal.js",
  "/js/portal-teacher.js",
  "/js/portal-student.js",
  "/js/portal-parent.js",
  "/js/support-chat.js",
  "/js/subscription.js",
  "/js/edusphere-ai.js",
  "/js/dashboard.js",
  "/js/app.js",
  "/js/ai-boot.js",
  "/js/charts.js",
  "/js/i18n.js",
  "/js/print.js",
  "/js/public.js",
  "/js/report-sheet-viewer.js",
  "/js/theme.js",
  "/js/vendor/jsqr.js",
];

/** API and uploaded/user content must never be served from this cache. */
function isPassthrough(url) {
  return url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/uploads/") ||
    url.pathname === "/sw.js" ||
    url.pathname.startsWith("/verify/");
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individual adds: one renamed asset must not fail the whole install.
    await Promise.all(SHELL_ASSETS.map((asset) => cache.add(new Request(asset, { cache: "reload" })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.indexOf("edusphere-shell-") === 0 && key.indexOf(SHELL_VERSION) !== 0)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  if (data.type === "CLEAR_SHELL") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (isPassthrough(url)) return;

  // A full page load (address bar, installed-app launch, reload).
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put("/index.html", response.clone()).catch(() => {});
        return response;
      } catch (e) {
        const cached = await caches.match("/index.html", { cacheName: SHELL_CACHE });
        if (cached) return cached;
        const root = await caches.match("/", { cacheName: SHELL_CACHE });
        if (root) return root;
        return new Response(
          "<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>EduSphere</title>" +
          "<body style=\"font-family:system-ui;padding:32px;text-align:center\"><h1>EduSphere</h1>" +
          "<p>This device has not finished saving the app shell yet. Reconnect once and reopen.</p>",
          { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 200 }
        );
      }
    })());
    return;
  }

  // Static shell assets: cache first, refresh quietly in the background.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) {
      if (!cached.headers.get("x-es-stale")) {
        fetch(request).then((response) => {
          if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
        }).catch(() => {});
      }
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response && response.ok && (url.pathname.startsWith("/css/") || url.pathname.startsWith("/js/") || url.pathname.startsWith("/assets/"))) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (e) {
      const fallback = await caches.match(request);
      if (fallback) return fallback;
      return new Response("", { status: 504, statusText: "Offline" });
    }
  })());
});
