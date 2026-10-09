"use strict";
/* ============================================================================
   EduSphere — print helper for server-rendered print pages
   ----------------------------------------------------------------------------
   The platform CSP is script-src 'self', so print pages (ID cards, certificates,
   fee receipts, payslips) must NOT use inline scripts or inline onclick
   handlers. This same-origin script opens the browser print dialog once the
   page is actually ready, and wires the visible print button as a fallback.

   "Ready" means every image (school logo, student photo, QR-bearing layouts)
   has loaded or failed, and webfonts are settled. Printing earlier produced
   sheets with missing photos and fallback fonts. A short cap keeps a slow or
   broken image from blocking the dialog forever.
   ========================================================================== */
(function () {
  var READY_CAP_MS = 4000;

  function printNow() {
    try { window.print(); } catch (e) { /* printing unavailable */ }
  }

  function imagesSettled() {
    var pending = Array.prototype.slice.call(document.images).filter(function (img) {
      return !img.complete;
    });
    return Promise.all(pending.map(function (img) {
      return new Promise(function (resolve) {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    }));
  }

  function fontsSettled() {
    return document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  }

  function whenReady() {
    var cap = new Promise(function (resolve) { window.setTimeout(resolve, READY_CAP_MS); });
    return Promise.race([Promise.all([imagesSettled(), fontsSettled()]), cap]);
  }

  function init() {
    var button = document.getElementById("printPageBtn");
    if (button) button.addEventListener("click", printNow);
    // Small delay lets layout settle after images and fonts are ready.
    whenReady().then(function () { window.setTimeout(printNow, 120); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
