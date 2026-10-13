"use strict";
/* ============================================================================
   EduSphere — EduPrint: print the screen you are looking at, or one part of it
   ----------------------------------------------------------------------------
   Every print button in the app used to call `window.print()` directly. What
   came out of the printer was the whole application: the dark sidebar, the
   header, the search filters, the pagination, the "Create" buttons and any
   toast that happened to be on screen. Two further faults came with it:

     • The browser prints `document.title` in its own header/footer and offers
       it as the PDF file name, so a saved student list was called
       "EduSphere — Education Management Platform".
     • Printing from an open dialog was worse than useless: the fixed backdrop
       and the 88vh-capped modal body clipped anything that did not fit on the
       first page.

   This helper fixes all three. It is deliberately tiny and has no dependency
   on the dashboard internals — it reads the school name from the header that
   is already on screen.

   Scopes
     page     the current route (default) — chrome hidden, everything else prints
     modal    the open dialog, printed as the whole document
     element  one node, cloned into #printStage (e.g. a generated report table)

   The visual rules live in public/css/print.css.
   ========================================================================== */
(function () {
  var STAGE_ID = "printStage";
  var CLEANUP_TIMEOUT_MS = 60000;

  function escape(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** The institution name, taken from the header the user can already see. */
  function schoolName() {
    var node = document.querySelector(".dash-header-title h1, .dash-header-title strong, .site-header .school-name, #dashHeaderTitle");
    return node ? String(node.textContent || "").trim().slice(0, 120) : "";
  }

  /** "13 October 2026" — used in the printed header, never in the UI. */
  function stamp(date) {
    var value = date ? new Date(date) : new Date();
    if (isNaN(value.getTime())) return "";
    try {
      return value.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    } catch (error) {
      return value.toISOString().slice(0, 10);
    }
  }

  function stage() {
    var node = document.getElementById(STAGE_ID);
    if (node) return node;
    node = document.createElement("div");
    node.id = STAGE_ID;
    node.setAttribute("aria-hidden", "true");
    document.body.appendChild(node);
    return node;
  }

  function head(title, meta) {
    var school = schoolName();
    var wrap = document.createElement("div");
    wrap.className = "print-doc-head";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = (school ? '<p class="print-doc-school">' + escape(school) + "</p>" : "")
      + '<h1 class="print-doc-title">' + escape(title) + "</h1>"
      + '<p class="print-doc-meta">' + escape(meta) + "</p>";
    return wrap;
  }

  /** A dialog that is actually open, or null. */
  function openModalBody() {
    return document.querySelector(".dash-modal-body") || document.querySelector(".dash-modal");
  }

  /**
   * Where the printed header belongs and whether the scope is usable at all.
   * A scope that cannot be honoured quietly falls back to printing the page,
   * which is far better than printing nothing.
   */
  function resolve(options) {
    var wanted = String(options.scope || "page").toLowerCase();
    if (wanted === "modal") {
      var body = openModalBody();
      if (body) return { scope: "modal", host: body };
      return { scope: "page", host: pageHost() };
    }
    if (wanted === "element") {
      var target = typeof options.target === "string" ? document.querySelector(options.target) : options.target;
      if (target && String(target.textContent || "").trim()) {
        var holder = stage();
        holder.innerHTML = "";
        var copy = target.cloneNode(true);
        Array.prototype.forEach.call(copy.querySelectorAll("[data-no-print], .noprint, .dash-actions, .dash-btn, button"), function (node) {
          if (node.parentNode) node.parentNode.removeChild(node);
        });
        holder.appendChild(copy);
        return { scope: "element", host: holder };
      }
      return { scope: "page", host: pageHost() };
    }
    return { scope: "page", host: pageHost() };
  }

  function pageHost() {
    return document.querySelector(".dash-content-inner")
      || document.querySelector(".dash-content")
      || document.querySelector("main")
      || document.body;
  }

  function print(options) {
    var opts = options || {};
    var title = String(opts.title || document.title || "EduSphere").slice(0, 160);
    var meta = String(opts.meta || ("Printed " + stamp() + (opts.subtitle ? " · " + opts.subtitle : ""))).slice(0, 200);
    var resolved = resolve(opts);
    var host = resolved.host;
    var header = head(title, meta);
    var previousTitle = document.title;
    var cleaned = false;

    host.insertBefore(header, host.firstChild);
    document.body.dataset.printScope = resolved.scope;
    // The browser prints the page title in its header/footer and offers it as
    // the PDF file name; a named document is the difference between a folder of
    // "EduSphere — Education Management Platform (7).pdf" and a readable file.
    try { document.title = title; } catch (error) { /* title is cosmetic */ }

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", cleanup);
      document.removeEventListener("visibilitychange", onVisibility);
      if (header.parentNode) header.parentNode.removeChild(header);
      if (resolved.scope === "element") {
        var holder = document.getElementById(STAGE_ID);
        if (holder) holder.innerHTML = "";
      }
      delete document.body.dataset.printScope;
      try { document.title = previousTitle; } catch (error) { /* cosmetic */ }
    }

    function onVisibility() { if (!document.hidden) window.setTimeout(cleanup, 400); }

    var timer = window.setTimeout(cleanup, CLEANUP_TIMEOUT_MS);
    window.addEventListener("afterprint", cleanup, { once: true });
    document.addEventListener("visibilitychange", onVisibility);

    try {
      window.print();
    } catch (error) {
      cleanup();
      return false;
    }
    return true;
  }

  /** Convenience: print one element (a generated report, a receipt, a table). */
  function area(target, options) {
    return print(Object.assign({}, options || {}, { scope: "element", target: target }));
  }

  window.EduPrint = { area: area, print: print, schoolName: schoolName, stamp: stamp };
})();
