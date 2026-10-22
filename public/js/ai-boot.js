"use strict";
/* ============================================================================
   EDUSPHERE AI — boot
   ----------------------------------------------------------------------------
   Mounts the assistant widget once on page load. It is a separate file (rather
   than an inline <script>) because the platform sends a strict
   `script-src 'self'` Content-Security-Policy, which blocks inline scripts.

   The widget decides for itself which surface it is on: a signed-in session
   gets the assistant that can see that institution, a visitor on a school's
   own public website (/schools/<slug>) gets THAT school's confidential
   assistant, and everybody else gets the anonymous public one. It is mounted
   unconditionally so a visitor on the public site, a parent on the portal and
   an administrator in the dashboard all get the same, familiar entry point.

   The SPA changes pages without reloading, so `sync()` runs on every route
   change: leaving a school's website swaps its assistant for the right one —
   a school's assistant never follows a visitor onto another page.
   ========================================================================== */
(function () {
  function boot() {
    if (!window.EduSphereAI || !window.API) return;
    if (window.EduSphereAI.__mounted) return;
    window.EduSphereAI.__mounted = true;
    window.EduSphereAI.mount().catch(function () {
      // Never let a failed assistant block the page it was added to.
    });
  }

  function sync() {
    if (!window.EduSphereAI || !window.EduSphereAI.sync) return;
    window.EduSphereAI.sync().catch(function () {
      // A surface that cannot load (an unpublished school, a dropped
      // connection) simply leaves the page without an assistant.
    });
  }

  // The SPA routes through popstate/hashchange and a custom event; listening
  // to all three keeps the assistant in step on every navigation.
  window.addEventListener("popstate", sync);
  window.addEventListener("hashchange", sync);
  window.addEventListener("edusphere:route", sync);
  // A school page publishes its own surface when its renderer has run.
  window.addEventListener("edusphere:ai-surface", sync);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
