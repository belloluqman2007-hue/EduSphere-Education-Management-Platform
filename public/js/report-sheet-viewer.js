"use strict";
/* ============================================================================
   EduSphere — report sheet viewer helper
   ----------------------------------------------------------------------------
   Loaded by the server-rendered report sheet / report card documents (staff
   preview, bulk class generation, student/parent portal and the public result
   checker). It does two jobs the document itself cannot do inline:

   1. The print button. The platform CSP is `script-src 'self'` with
      `script-src-attr 'none'`, which silently blocks inline event handlers
      such as onclick="window.print()". This same-origin script wires every
      [data-print] button instead (the inline onclick on the button remains
      only as a fallback for contexts without the CSP header, e.g. a saved
      HTML copy opened from disk).

   2. Image resilience. The server only emits <img> tags for upload files it
      has verified exist, and every image carries data-fallback attributes.
      If a file still disappears between render and request (ephemeral disk,
      failed mount), the browser would show a broken-image icon with the
      student's name as alt text — so this script swaps in the same clean
      placeholder the server uses, and no broken image is ever displayed.
   ========================================================================== */
(function () {
  var PHOTO_FALLBACK_SVG =
    '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';

  function swapToPlaceholder(img) {
    if (!img || img.getAttribute("data-swapped")) return;
    img.setAttribute("data-swapped", "1");
    var kind = img.getAttribute("data-fallback");
    if (kind === "logo") {
      var monogram = document.createElement("div");
      monogram.className = "logo logo-fallback";
      monogram.setAttribute("aria-hidden", "true");
      monogram.textContent = img.getAttribute("data-initial") || "";
      if (img.parentNode) img.parentNode.replaceChild(monogram, img);
      return;
    }
    // Student photograph: reuse the existing photo frame when present.
    var slot = img.parentNode;
    if (slot && slot.classList && slot.classList.contains("photo-slot")) {
      slot.classList.add("photo-empty");
      slot.setAttribute("aria-hidden", "true");
      slot.innerHTML = PHOTO_FALLBACK_SVG;
    } else {
      var box = document.createElement("div");
      box.className = "photo-slot photo-empty";
      box.setAttribute("aria-hidden", "true");
      box.innerHTML = PHOTO_FALLBACK_SVG;
      if (img.parentNode) img.parentNode.replaceChild(box, img);
    }
  }

  function init() {
    // Print / Save as PDF — works under the platform CSP.
    document.addEventListener("click", function (event) {
      var target = event.target;
      var button = target && target.closest ? target.closest("[data-print]") : null;
      if (!button) return;
      event.preventDefault();
      try { window.print(); } catch (e) { /* printing unavailable */ }
    });

    // Never display a broken-image icon or raw alt text.
    var images = document.querySelectorAll("img[data-fallback]");
    Array.prototype.forEach.call(images, function (img) {
      img.addEventListener("error", function () { swapToPlaceholder(img); });
      // The image may already have failed before this listener attached.
      if (img.complete && img.naturalWidth === 0) swapToPlaceholder(img);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
