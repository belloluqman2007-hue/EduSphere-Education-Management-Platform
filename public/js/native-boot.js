"use strict";
/* ============================================================================
   EduSphere — NATIVE BOOTSTRAP
   ----------------------------------------------------------------------------
   A browser has no business downloading 70 KB of native shell, and the phone
   has no business booting without it. This file is the one-line decision:

     • Inside the Capacitor shell (`window.Capacitor` says android/ios) it
       writes the three native scripts into the document, synchronously and in
       order, so they are parsed before `api.js` and before the app boots.
     • In a browser it writes nothing at all, so the web app is byte-for-byte
       the app it was before Phase 4 — same scripts, same speed.

   `document.write` during parsing (this file is a classic, parser-blocking
   script) is what keeps the order synchronous; the platform CSP is
   `script-src 'self'`, which allows it because every URL is our own origin.

   Nothing here touches the offline engine or the API: the native modules are
   the same files the web app used to load unconditionally.
   ========================================================================== */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  function isNativeShell() {
    try {
      const cap = window.Capacitor;
      if (!cap) return false;
      if (typeof cap.isNativePlatform === "function") return cap.isNativePlatform() !== false;
      const platform = String(cap.platform || cap.getPlatform && cap.getPlatform() || "web");
      return platform === "android" || platform === "ios";
    } catch (e) {
      return false;
    }
  }

  if (!isNativeShell()) return;

  const scripts = ["/js/native-bridge.js", "/js/mobile-storage.js", "/js/mobile-shell.js"];
  for (let i = 0; i < scripts.length; i++) {
    document.write('<script src="' + scripts[i] + '"><\/script>');
  }
  window.__EDUSPHERE_NATIVE_BOOT__ = { scripts: scripts.slice(), native: true };
})();
