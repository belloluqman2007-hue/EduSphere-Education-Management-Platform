"use strict";
/* ============================================================================
   EDUSPHERE AI — boot
   ----------------------------------------------------------------------------
   Mounts the assistant widget once on page load. It is a separate file (rather
   than an inline <script>) because the platform sends a strict
   `script-src 'self'` Content-Security-Policy, which blocks inline scripts.

   The widget decides for itself which surface it is on: a signed-in session
   gets the assistant that can see that institution, everybody else gets the
   anonymous public one. It is mounted unconditionally so a visitor on the
   public site, a parent on the portal and an administrator in the dashboard
   all get the same, familiar entry point.
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
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
