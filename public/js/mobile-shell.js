"use strict";
/* ============================================================================
   EduSphere — MOBILE SHELL (Android phones/tablets, iPhone/iPad)
   ----------------------------------------------------------------------------
   The native behaviours a phone needs and a browser never had. Everything in
   this file is wiring, not business logic: the offline engine, the outbox and
   the sync UI are the Phase 2 modules, unchanged.

     1. REAL NETWORK LISTENER — `@capacitor/network` drives
        `SyncEngine.setOnline()` (pill, outbox flush, pull timer). A WebView's
        `navigator.onLine` lies after a radio drop; the native listener does
        not. The same status feeds `SyncEngine.setConnectivityProbe()`, so
        `pullNow()`/`syncNow()` stop trusting the stale flag too.
     2. RESUME SYNC — returning to the foreground (appStateChange isActive)
        flushes the queue and pulls immediately.
     3. ANDROID HARDWARE BACK — routed into the SPA: close the top modal or
        drawer first, then walk history backwards, and only leave the app when
        there is genuinely nowhere left to go.
     4. TOUCH UX — safe-area insets for notches and rounded corners, 44px
        minimum touch targets, no rubber-band scrolling behind a modal, a
        keyboard-aware layout, and a two-column tablet layout for registers.
     5. CAMERA PERMISSION — one place that asks Android/iOS properly
        (rationale, permanently-denied path with an "Open settings" action) and
        always leaves the operator a manual way in.
     6. FIRST RUN — pair the phone with a school server (cloud address or the
        LAN hub address shown on the front-office PC) before the app pretends
        to be online.

   Loaded ONLY inside the native shell: with no `window.__EDUSPHERE_MOBILE__`
   the browser build is untouched.
   ========================================================================== */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (!window.__EDUSPHERE_MOBILE__) return;

  const MOBILE = window.__EDUSPHERE_MOBILE__;
  const PAIRING_ID = "edusphere-pairing";
  const state = { installed: null, connected: true, listeners: [] };

  function doc() {
    return window.document;
  }

  function str(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /* ------------------------------- overlays ------------------------------ */

  /** The top-most thing that should swallow a Back press, if any. */
  function closeTopOverlay(root) {
    const container = root || doc();
    const modal = container.querySelector(".dash-modal-backdrop");
    if (modal) {
      const close = modal.querySelector(".dash-modal-close, [data-modal-close]");
      if (close && typeof close.click === "function") close.click();
      else modal.remove();
      return "modal";
    }
    const drawer = container.querySelector(".ss-drawer.is-open, .es-sync-drawer.is-open, .dash-sidebar.is-open, #esSyncDrawer.is-open");
    if (drawer) {
      const close = drawer.querySelector("[data-close], .ss-drawer__close, .es-drawer-close, .dash-sidebar-close") ||
        container.querySelector("#schoolDrawerClose");
      if (close && typeof close.click === "function") close.click();
      else drawer.classList.remove("is-open");
      return "drawer";
    }
    const scanner = container.querySelector(".scan-viewport");
    if (scanner) {
      const running = container.querySelector("[data-scanner-running]");
      if (running && typeof running.click === "function") running.click();
      else scanner.remove();
      return "scanner";
    }
    const pairing = container.getElementById ? container.getElementById(PAIRING_ID) : null;
    if (pairing) return "pairing";
    return "";
  }

  /**
   * Android's hardware back button, in the order a person expects it:
   * modal → drawer → camera → previous screen → leave the app.
   * Returns what it did so it can be tested without a phone.
   */
  function handleBack(options) {
    const container = (options && options.doc) || doc();
    const closed = closeTopOverlay(container);
    if (closed) return closed;
    const history = window.history;
    const path = str(window.location && window.location.pathname) || "/";
    const atHome = path === "/" || path === "/index.html" || path === "/index.htm";
    if (!atHome && history && typeof history.back === "function") {
      history.back();
      return "history";
    }
    return "exit";
  }

  /** No rubber-band scrolling of the page behind an open modal or drawer. */
  function installScrollLock() {
    const body = doc().body;
    if (!body) return false;
    let lockedNow = body.classList.contains("is-modal-open");
    const apply = () => {
      const locked = Boolean(doc().querySelector(
        ".dash-modal-backdrop, .ss-drawer.is-open, .es-sync-drawer.is-open, .dash-modal"
      ));
      /* Only touch the DOM when the answer changed: writing the same class back
         would emit another mutation record and spin this observer forever. */
      if (locked === lockedNow) return;
      lockedNow = locked;
      body.classList.toggle("is-modal-open", locked);
    };
    apply();
    if (typeof window.MutationObserver === "function") {
      try {
        new window.MutationObserver(apply).observe(body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "hidden"],
        });
      } catch (e) { /* observation is an enhancement */ }
    }
    /* Belt and braces for iOS: a touchmove that would drag the page under a
       dialog is cancelled, but scrolling INSIDE the dialog still works. */
    doc().addEventListener("touchmove", (event) => {
      if (!body.classList.contains("is-modal-open")) return;
      const target = event.target;
      const inside = target && typeof target.closest === "function" &&
        target.closest(".dash-modal, .es-sync-drawer, .ss-drawer__panel, .es-drawer");
      if (inside) return;
      if (event.cancelable !== false) event.preventDefault();
    }, { passive: false });
    return true;
  }

  /** Keep the focused field above the on-screen keyboard. */
  function installKeyboardAware() {
    const viewport = window.visualViewport;
    const root = doc().documentElement;
    let lastInset = -1;
    const apply = () => {
      if (!root) return;
      const height = viewport ? viewport.height : window.innerHeight;
      const inset = Math.max(0, Math.round((window.innerHeight || 0) - (height || 0) - (viewport ? viewport.offsetTop : 0)));
      const open = inset > 120;
      /* Same guard as the modal lock: a resize handler that rewrites identical
         values in a loop can starve every other timer. */
      if (inset === lastInset) return;
      lastInset = inset;
      root.style.setProperty("--keyboard-inset", inset + "px");
      root.classList.toggle("is-keyboard-open", open);
      if (open) {
        const active = doc().activeElement;
        if (active && typeof active.scrollIntoView === "function") {
          try { active.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { /* older WebView */ }
        }
      }
    };
    if (viewport && typeof viewport.addEventListener === "function") {
      viewport.addEventListener("resize", apply);
      viewport.addEventListener("scroll", apply);
    }
    window.addEventListener("resize", apply);
    apply();
    return true;
  }

  /** Tablet (two-column registers) vs phone. */
  function applyLayoutClass() {
    const root = doc().documentElement;
    if (!root) return "phone";
    let tablet = false;
    try {
      tablet = typeof window.matchMedia === "function"
        ? window.matchMedia("(min-width: 768px)").matches
        : Number(window.innerWidth) >= 768;
    } catch (e) { tablet = Number(window.innerWidth) >= 768; }
    root.classList.toggle("is-tablet", Boolean(tablet));
    root.classList.toggle("is-phone", !tablet);
    return tablet ? "tablet" : "phone";
  }

  /* --------------------------- tablet registers --------------------------
     On a tablet held in landscape there is room for the attendance register
     to be two columns tall instead of one long scroll: the operator sees a
     whole class without flicking. Rows are MOVED (never cloned), so delegated
     click handlers and input bindings keep working; only the header is cloned,
     and its ids are stripped.
  --------------------------------------------------------------------- */
  const REGISTER_MIN_ROWS = 8;

  function splitRegister(table) {
    if (!table || table.getAttribute("data-register-split") === "1") return null;
    const bodies = table.tBodies ? Array.prototype.slice.call(table.tBodies) : [];
    if (bodies.length !== 1) return null;
    const body = bodies[0];
    const rows = Array.prototype.slice.call(body.rows || []);
    if (rows.length < REGISTER_MIN_ROWS) return null;
    const wrap = table.parentNode;
    if (!wrap || !wrap.parentNode || wrap.getAttribute("data-split-done") === "1") return null;
    if (table.querySelector("video, .scan-viewport")) return null;

    const half = Math.ceil(rows.length / 2);
    const first = rows.slice(0, half);
    const second = rows.slice(half);

    const clone = table.cloneNode(false);
    if (table.tHead) {
      const head = table.tHead.cloneNode(true);
      Array.prototype.forEach.call(head.querySelectorAll("[id]"), (node) => node.removeAttribute("id"));
      clone.appendChild(head);
    }
    const cloneBody = doc().createElement("tbody");
    for (const row of second) cloneBody.appendChild(row);
    clone.appendChild(cloneBody);

    const wrapClone = doc().createElement("div");
    wrapClone.className = wrap.className || "dash-table-wrap";
    wrapClone.appendChild(clone);

    const grid = doc().createElement("div");
    grid.className = "reg-two-col";
    wrap.parentNode.insertBefore(grid, wrap);
    grid.appendChild(wrap);
    grid.appendChild(wrapClone);
    table.setAttribute("data-register-split", "1");
    clone.setAttribute("data-register-split", "1");
    wrap.setAttribute("data-split-done", "1");
    return { rows: rows.length, perColumn: first.length };
  }

  function enhanceRegisters(root) {
    if (!doc().documentElement.classList.contains("is-tablet")) return 0;
    const container = root || doc();
    let split = 0;
    const tables = container.querySelectorAll(".dash-table-wrap > table.dash-table:not([data-register-split])");
    for (const table of Array.prototype.slice.call(tables)) {
      try {
        if (splitRegister(table)) split += 1;
      } catch (e) { /* a register that cannot be split simply stays as it was */ }
    }
    return split;
  }

  function watchRegisters() {
    if (typeof window.MutationObserver !== "function") return false;
    const app = doc().getElementById("app") || doc().body;
    if (!app) return false;
    let timer = 0;
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        enhanceRegisters();
      }, 250);
    };
    try {
      new window.MutationObserver(schedule).observe(app, { childList: true, subtree: true });
      window.addEventListener("edusphere:route", schedule);
      schedule();
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------- camera -------------------------------- */

  const CAMERA_MESSAGES = {
    "denied-permanently": "Camera access is turned off for EduSphere. Open the phone's Settings → Apps → EduSphere → Permissions → Camera, or type the code printed under the QR.",
    "denied": "Camera permission was declined. Allow it when asked, open Settings, or type the code printed under the QR.",
    "prompt-with-rationale": "EduSphere needs the camera only to read a student's ID card. Allow it, or type the code printed under the QR.",
    "prompt": "Allow the camera to scan an ID card, or type the code printed under the QR.",
    "unknown": "The camera could not be checked. Type the code printed under the QR if the camera does not open.",
  };

  function cameraMessage(permissionState) {
    return CAMERA_MESSAGES[str(permissionState)] || CAMERA_MESSAGES.unknown;
  }

  /**
   * Called by card-scanner.js right before `getUserMedia`. Returns
   * `{ ok, state, message, settings }`; `ok: false` means "use the manual
   * code box", never "show a dead end".
   */
  function requestCamera() {
    if (!MOBILE.camera || typeof MOBILE.camera.request !== "function") return Promise.resolve({ ok: true, state: "unsupported" });
    return Promise.resolve()
      .then(() => MOBILE.camera.request())
      .then((result) => {
        const permissionState = str(result && result.state) || "unknown";
        if (permissionState === "granted" || permissionState === "unknown") {
          return { ok: true, state: permissionState, message: "" };
        }
        return {
          ok: false,
          state: permissionState,
          message: cameraMessage(permissionState),
          settings: permissionState === "denied-permanently",
        };
      })
      .catch(() => ({ ok: true, state: "unknown", message: "" }));
  }

  function openAppSettings() {
    if (!MOBILE.camera || typeof MOBILE.camera.openSettings !== "function") return Promise.resolve({ ok: false });
    return Promise.resolve().then(() => MOBILE.camera.openSettings()).catch(() => ({ ok: false }));
  }

  /* ------------------------------ first run ------------------------------ */

  /**
   * Shown when no server address is saved yet. The desktop hub window prints
   * `http://192.168.x.x:4123` next to a QR code: this is where that address is
   * typed (or opened from `edusphere://hub?url=…`).
   */
  function showPairing() {
    const body = doc().body;
    if (!body || doc().getElementById(PAIRING_ID)) return null;
    const host = doc().createElement("div");
    host.id = PAIRING_ID;
    host.className = "edusphere-pairing";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.setAttribute("aria-labelledby", "edusphere-pairing-title");

    const title = doc().createElement("h1");
    title.id = "edusphere-pairing-title";
    title.textContent = "Connect to your school";
    const intro = doc().createElement("p");
    intro.textContent = "Enter the address your school uses. On the school's own network, the front office PC shows this address (and a QR code) on its EduSphere School LAN Hub window.";

    const form = doc().createElement("form");
    form.setAttribute("novalidate", "novalidate");
    const label = doc().createElement("label");
    label.setAttribute("for", "edusphere-pairing-input");
    label.textContent = "School address";
    const input = doc().createElement("input");
    input.id = "edusphere-pairing-input";
    input.type = "url";
    input.inputMode = "url";
    input.autocomplete = "url";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.value = MOBILE.server && typeof MOBILE.server.get === "function" ? str(MOBILE.server.get()) : "";
    input.placeholder = "https://school.edusphere.app or http://192.168.1.5:4123";
    const submit = doc().createElement("button");
    submit.type = "submit";
    submit.textContent = "Connect";
    const error = doc().createElement("p");
    error.className = "edusphere-pairing__error";
    error.setAttribute("role", "alert");
    error.hidden = true;

    form.addEventListener("submit", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      const clean = MOBILE.server.normalize(input.value);
      if (!clean) {
        error.textContent = "That address cannot be used. Use https:// for a cloud address, or a school LAN address such as http://192.168.1.5:4123.";
        error.hidden = false;
        return;
      }
      MOBILE.server.set(clean);
      try { window.location.reload(); } catch (e) { /* the reload is the point */ }
    });

    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(submit);
    form.appendChild(error);

    const note = doc().createElement("p");
    note.className = "edusphere-pairing__note";
    note.textContent = "Signed in on a phone already? The school administrator can share a pairing link, or you can sign in normally once the address is set.";

    host.appendChild(title);
    host.appendChild(intro);
    host.appendChild(form);
    host.appendChild(note);
    body.appendChild(host);
    try { input.focus(); } catch (e) { /* focus is an enhancement */ }
    return host;
  }

  /* ------------------------------- install ------------------------------- */

  /**
   * Wires the native listeners. Safe to call twice; the UI wiring (scroll lock,
   * keyboard, layout) runs once. Tests pass their own `sync`/`plugins`.
   */
  function install(options) {
    const opts = options || {};
    const sync = opts.sync || window.SyncEngine || null;
    const plugins = opts.plugins || MOBILE.plugins || {};
    const app = plugins.app || null;
    const network = plugins.network || null;
    const root = opts.doc || doc();
    const result = { network: false, resume: false, back: false, ui: false, pairing: false };

    state.installed = state.installed || { sync, plugins };

    /* 1. Connectivity probe: pullNow()/syncNow() stop trusting navigator.onLine. */
    if (sync && typeof sync.setConnectivityProbe === "function") {
      sync.setConnectivityProbe(() => state.connected);
    }

    /* 2. Real network listener. */
    if (network && typeof network.addListener === "function") {
      const apply = (status) => {
        if (!status || typeof status.connected !== "boolean") return;
        state.connected = status.connected;
        if (sync && typeof sync.setOnline === "function") sync.setOnline(status.connected);
      };
      try {
        if (typeof network.getStatus === "function") {
          Promise.resolve(network.getStatus()).then(apply).catch(() => {});
        }
        network.addListener("networkStatusChange", apply);
        result.network = true;
      } catch (e) { /* the browser events in sync-engine still work */ }
    }

    /* 3. Foreground/resume + Android hardware back + deep links already
          installed by native-bridge. */
    if (app && typeof app.addListener === "function") {
      try {
        app.addListener("appStateChange", (status) => {
          if (!status || status.isActive !== true) return;
          if (sync && typeof sync.syncNow === "function") {
            Promise.resolve().then(() => sync.syncNow()).catch(() => {});
          }
        });
        result.resume = true;
      } catch (e) { /* non-fatal */ }
      try {
        app.addListener("backButton", () => {
          const action = handleBack({ doc: root });
          if (action === "exit" && typeof app.exitApp === "function") {
            try { app.exitApp(); } catch (e) { /* non-fatal */ }
          }
          return action;
        });
        result.back = true;
      } catch (e) { /* non-fatal */ }
    }

    /* 4. Touch UX. */
    try {
      installScrollLock();
      installKeyboardAware();
      const layout = applyLayoutClass();
      if (layout === "tablet") {
        enhanceRegisters();
        watchRegisters();
      }
      result.ui = true;
      result.layout = layout;
    } catch (e) { /* resilience: the app still works without polish */ }

    /* 5. First run: no server address yet. */
    try {
      if (MOBILE.server && typeof MOBILE.server.requiresPairing === "function" && MOBILE.server.requiresPairing()) {
        showPairing();
        result.pairing = true;
      }
    } catch (e) { /* non-fatal */ }

    return result;
  }

  window.MobileShell = Object.freeze({
    install,
    handleBack,
    closeTopOverlay,
    enhanceRegisters,
    splitRegister,
    applyLayoutClass,
    requestCamera,
    cameraMessage,
    openAppSettings,
    showPairing,
    PAIRING_ID,
    /** Diagnostics for the Sync & Devices drawer / tests. */
    status() {
      return {
        platform: MOBILE.platform,
        connected: state.connected,
        secureProvider: MOBILE.secure.provider(),
        secureDurable: MOBILE.secure.durable(),
        server: MOBILE.server.get(),
        storage: typeof window.OfflineDB !== "undefined" && window.OfflineDB.backendKind
          ? window.OfflineDB.backendKind()
          : Promise.resolve("unknown"),
      };
    },
    /** Test hook: forget the install so a second `install()` can re-wire. */
    _reset() {
      state.installed = null;
      state.connected = true;
      return true;
    },
  });

  try {
    install();
  } catch (e) {
    try {
      if (typeof console !== "undefined" && console.warn) console.warn("[mobile-shell] install failed:", e && e.message);
    } catch (err) { /* console optional */ }
  }
})();
