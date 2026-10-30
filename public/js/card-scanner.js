"use strict";
/* ============================================================================
   EduSphere — camera verification and marking (scan a card, act on it)
   ----------------------------------------------------------------------------
   The printed QR on a card is only useful if a camera can read it and the
   person on the other side can DO something with the answer. Two paths, one
   module:

     1. The camera reads the QR by itself, with no button to press. Chrome,
        Edge and Android use the browser's built-in `BarcodeDetector`. Where it
        is missing (Safari and iPhone, most Linux browsers) the bundled jsQR
        decoder (public/js/vendor/jsqr.js, loaded only when needed) reads the
        same frames in software. Nothing is sent to a remote decoding service:
        a stranger's API must never be handed a photograph of a child's face.
     2. Where no camera is available, or it cannot focus on a scratched card,
        the code printed under the QR is typed in. Both routes end at the same
        answer, so nothing depends on which one you used.

   What a block can do, from its attributes:

     data-scanner                                  the block itself
     data-endpoint="/api/public/card/"             verification lookup (GET)
     data-mark-endpoint="/api/attendance/scan"     verify AND mark (POST)
     data-mark-auto="1"                            mark on every scan (otherwise
                                                   only the action buttons mark)
     data-mark-status="late"                       the status a scan records
     data-scan-date="2026-10-13"                   the register day to mark
     data-sequential="1"                           keep scanning the next card
     data-scanner-result                           where the answer is rendered
     data-scanner-error                            where a message is rendered

   A successful read is checked at once: the holder's photo, name, class and
   whether they were already marked appear in the result, with the actions a
   gate needs (mark late, excused or absent, open the public verification page,
   print the card again). No screen is left without a path.

   The camera is shown inside a small framed viewport that sits under the
   controls, never at the full size of the sensor, so it stays usable on a phone.

   This file is loaded by the public verification page (no session) and by the
   signed-in dashboard, so it touches no app state beyond `window.API` when it
   is there.

   A marking scan is a state-changing call, so it carries the session's CSRF
   token exactly as public/js/api.js does: the token is fetched from
   /api/csrf-token once, reused by every scanner block on the page, and
   refreshed once if the server answers 403. The public verification page has no
   session and only ever issues GETs, so it never asks for a token at all — the
   page a stranger's phone opens still works with nothing but the code.
   ========================================================================== */
(function () {
  const CODE_PATTERN = /(?:https?:\/\/[^\s"']+\/verify\/(?:card\/|certificate\/)?|code[:\s]+)?([a-z0-9][a-z0-9-]{5,63})/i;
  const STATUS_LABELS = { present: "present", late: "late", excused: "excused", absent: "absent" };
  const JSQR_SRC = "/js/vendor/jsqr.js";
  const FRAME_MAX_WIDTH = 720;      // decode at most this wide; enough for a printed QR, cheap on a phone
  const SCAN_INTERVAL_MS = 120;     // time between frames while the camera is looking
  const SAME_CARD_QUIET_MS = 5000;  // a card held in front of the lens is read once, not on every frame
  const RESUME_AFTER_MARK_MS = 1400;
  const RESUME_AFTER_FAILURE_MS = 2000;

  function qrPayloadToCode(text) {
    const match = CODE_PATTERN.exec(String(text || "").trim());
    return match ? match[1].toLowerCase() : "";
  }

  function supportsDetection() {
    return typeof window.BarcodeDetector === "function";
  }

  /** Escape anything that came from the server before it enters the DOM. */
  function esc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** API-relative path → URL, with or without the dashboard's API helper. */
  function apiUrl(path) {
    const clean = String(path || "");
    if (!clean) return "";
    if (window.API && typeof window.API.url === "function") return window.API.url(clean);
    return /^https?:/i.test(clean) ? clean : `/api${clean.startsWith("/") ? "" : "/"}${clean}`;
  }

  /**
   * A block's endpoint is written one of three ways: an absolute URL, the API's
   * own path ("/api/attendance/scan", what the dashboards emit today), or an
   * API-relative path. Resolve all three to the same place apiUrl() would —
   * without ever turning "/api/attendance/scan" into "/api/api/attendance/scan".
   */
  function endpointUrl(path) {
    const clean = String(path || "");
    if (!clean) return "";
    if (/^https?:/i.test(clean) || clean.startsWith("/api/")) return clean;
    return apiUrl(clean);
  }

  /* ------------------------------ CSRF -----------------------------------
     The marking call goes straight to the API with fetch (the scanner has to
     read the server's own status, and window.API is absent on the public
     verification page), so it must present the session's double-submit token
     itself — every POST without it is answered 403 by the server's CSRF guard.
     One token per page load, shared by every scanner block, refreshed once if
     the session's token has moved on (a tab left open, a server restart).
  ------------------------------------------------------------------------- */
  let csrfToken = null;
  let csrfPending = null;

  /** Reads the double-submit token; "" when the caller has no session to prove. */
  function readCsrfToken() {
    if (window.API && typeof window.API.get === "function") {
      return window.API.get("/csrf-token")
        .then((data) => (data && data.csrfToken) || "")
        .catch(() => "");
    }
    return fetch(apiUrl("/csrf-token"), { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => (data && data.csrfToken) || "")
      .catch(() => "");
  }

  function csrfEnsure(force) {
    if (force) { csrfToken = null; csrfPending = null; }
    if (csrfToken) return Promise.resolve(csrfToken);
    if (!csrfPending) {
      csrfPending = readCsrfToken().then((token) => {
        csrfToken = token || "";
        csrfPending = null;
        return csrfToken;
      });
    }
    return csrfPending;
  }

  /* ------------------------------ offline ---------------------------------
     At a gate with no internet, sync-engine.js is the thing that knows the card
     register (it is kept in the scoped local store) and the Outbox that will
     carry the marking to the server later. When the browser reports that it is
     offline we therefore hand the same two calls to window.API, which serves
     them locally, and wrap the answer in a fetch-shaped object so the rest of
     this file — and its message handling — stays exactly as it is.
  ------------------------------------------------------------------------- */
  function offlineMode() {
    if (!window.API) return false;
    /* In the native shell the radio can drop while navigator.onLine still says
       "online"; SyncEngine knows the truth (Phase 4 network listener). */
    try {
      if (window.SyncEngine && typeof window.SyncEngine.isOnline === "function" && window.SyncEngine.isOnline() === false) return true;
    } catch (e) { /* fall through to the browser flag */ }
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  /* --------------------------- native permission -------------------------
     On a phone the camera is an OS permission with three real answers: allow,
     ask again (rationale), and "never" (permanently denied — a second request
     shows nothing at all). mobile-shell.js asks properly and can open the
     system settings; in a browser/desktop shell it is absent and getUserMedia
     prompts by itself.
  ---------------------------------------------------------------------- */
  function cameraGate() {
    const shell = window.MobileShell;
    if (!shell || typeof shell.requestCamera !== "function") return Promise.resolve({ ok: true, state: "unsupported" });
    try {
      return Promise.resolve(shell.requestCamera()).catch(() => ({ ok: true, state: "unknown" }));
    } catch (e) {
      return Promise.resolve({ ok: true, state: "unknown" });
    }
  }

  /** Offers the only action that helps after a permanent refusal — no dead end. */
  function offerSettings(block, errorNode) {
    if (!block || block.querySelector("[data-scanner-settings]")) return;
    const shell = window.MobileShell;
    if (!shell || typeof shell.openAppSettings !== "function") return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dash-btn dash-btn-ghost dash-btn-sm";
    button.setAttribute("data-scanner-settings", "1");
    button.textContent = "Open camera settings";
    button.addEventListener("click", () => { Promise.resolve(shell.openAppSettings()).catch(() => {}); });
    const anchor = errorNode && errorNode.parentNode ? errorNode : block;
    anchor.insertAdjacentElement("afterend", button);
  }

  /** "/api/attendance/scan" or an absolute URL -> "/attendance/scan" for window.API. */
  function apiRelativePath(path) {
    const clean = String(path || "");
    if (!clean) return "";
    if (/^https?:/i.test(clean)) {
      try { return new URL(clean).pathname.replace(/^\/api(?=\/)/, ""); } catch (e) { return clean; }
    }
    return clean.startsWith("/api/") ? clean.slice(4) : clean;
  }

  /** A Response-shaped object for answers that never crossed the network. */
  function jsonResponse(data, status) {
    const body = data === null || data === undefined ? {} : data;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    };
  }

  /**
   * POST a JSON body with the CSRF token attached, retrying the request exactly
   * once with a fresh token when the server says the old one went stale. The
   * caller still sees the response, so the server's own message reaches the
   * operator when the retry does not help either.
   */
  async function postJson(path, body) {
    if (offlineMode() && typeof window.API.post === "function") {
      try {
        return jsonResponse(await window.API.post(apiRelativePath(path), body), 200);
      } catch (error) {
        return jsonResponse({ error: (error && error.message) || "This card could not be checked offline." }, 503);
      }
    }
    const url = endpointUrl(path);
    const attempt = async (token) => {
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      if (token) headers["X-CSRF-Token"] = token;
      return fetch(url, {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
    };
    try {
      const response = await attempt(await csrfEnsure(false));
      if (response.status !== 403) return response;
      // 403 on a request that carried a token means the token is no longer the
      // session's (expired, signed in elsewhere, server restarted). Ask once for
      // the current one and try again; a second 403 is reported as it stands.
      const retryToken = await csrfEnsure(true);
      return retryToken ? attempt(retryToken) : response;
    } catch (networkError) {
      // Wi-Fi that claims to be up but delivers nothing: hand the marking to the
      // offline engine, which writes it locally and syncs it when the link returns.
      if (window.API && typeof window.API.post === "function") {
        try { return jsonResponse(await window.API.post(apiRelativePath(path), body), 200); }
        catch (offlineError) {
          return jsonResponse({ error: (offlineError && offlineError.message) || "The check could not be completed. Check the connection and scan again." }, 503);
        }
      }
      throw networkError;
    }
  }

  /* The software QR reader is fetched the first time a camera needs it, so a
     page that never scans (most of them) never downloads it. */
  let jsQrLoading = null;
  function loadJsQr() {
    if (typeof window.jsQR === "function") return Promise.resolve(window.jsQR);
    if (!jsQrLoading) {
      jsQrLoading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = JSQR_SRC;
        script.async = true;
        script.onload = () => (typeof window.jsQR === "function" ? resolve(window.jsQR) : reject(new Error("jsQR did not load")));
        script.onerror = () => { jsQrLoading = null; script.remove(); reject(new Error("jsQR did not load")); };
        document.head.appendChild(script);
      });
    }
    return jsQrLoading;
  }

  /** Calls that a browser may not implement (media playback in a test DOM) must never break a scan. */
  function quietly(fn) { try { const result = fn(); if (result && typeof result.catch === "function") result.catch(() => {}); } catch (e) { /* ignored */ } }

  /**
   * The error line and the result panel are written beside the controls, not
   * inside the block (the block is only the input and its buttons). Look inside
   * the block first, then at the siblings that follow it, stopping before the
   * next scanner so one block never claims another's panel.
   */
  function companion(block, selector) {
    const inside = block.querySelector(selector);
    if (inside) return inside;
    for (let node = block.nextElementSibling; node; node = node.nextElementSibling) {
      if (node.matches(selector)) return node;
      if (node.matches("[data-scanner]") || node.querySelector("[data-scanner]")) break;
      const found = node.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  /**
   * One scanner instance per [data-scanner] block. Created lazily so the page
   * works with scripting blocked: the input, the Check button and the printed
   * code are plain HTML.
   */
  function enhance(block) {
    const input = block.querySelector("input[name=code]");
    const openButton = block.querySelector("[data-scanner-open]");
    const checkButton = block.querySelector("[data-scanner-check]");
    const errorNode = companion(block, "[data-scanner-error]");
    const resultNode = companion(block, "[data-scanner-result]");
    const endpoint = block.getAttribute("data-endpoint") || "";
    const markEndpoint = block.getAttribute("data-mark-endpoint") || "";
    const markAuto = block.getAttribute("data-mark-auto") === "1";
    const markStatus = String(block.getAttribute("data-mark-status") || "present").toLowerCase();
    const markDate = String(block.getAttribute("data-scan-date") || "").trim();
    const sequential = block.getAttribute("data-sequential") === "1";
    const redirect = block.getAttribute("data-redirect") === "1";
    const idleLabel = openButton ? String(openButton.textContent || "Scan with camera").trim() : "Scan with camera";
    let stream = null;
    let viewport = null;      // the framed camera, inserted under the controls while scanning
    let scanTimer = 0;
    let resumeTimer = 0;
    let reader = null;        // async (video) => raw QR text, or "" when nothing is in frame
    let session = 0;          // bumped by every start and stop, so late async work knows it is stale
    let stopped = true;
    let autoResume = false;   // the operator asked for the camera; keep it going after a read or a miss
    let lastStatus = markStatus;
    let lastCode = "";
    let lastReadAt = 0;

    const say = (message) => {
      if (!errorNode) return;
      errorNode.textContent = message || "";
      errorNode.hidden = !message;
    };

    const setStatus = (text) => {
      const node = viewport && viewport.querySelector(".scan-status");
      if (node) node.textContent = text || "";
    };

    function stop() {
      session += 1;
      stopped = true;
      if (scanTimer) { window.clearTimeout(scanTimer); scanTimer = 0; }
      if (resumeTimer) { window.clearTimeout(resumeTimer); resumeTimer = 0; }
      if (stream) {
        stream.getTracks().forEach((track) => {
          try {
            const caps = typeof track.getCapabilities === "function" ? track.getCapabilities() : null;
            if (caps && caps.torch && typeof track.applyConstraints === "function") {
              const off = track.applyConstraints({ advanced: [{ torch: false }] });
              if (off && typeof off.catch === "function") off.catch(() => {});
            }
          } catch (e) { /* older WebView */ }
          track.stop();
        });
      }
      stream = null;
      if (viewport) {
        const video = viewport.querySelector("video");
        if (video) { quietly(() => video.pause()); video.srcObject = null; }
        viewport.remove();
        viewport = null;
      }
      block.classList.remove("is-scanning");
      if (openButton) { openButton.textContent = idleLabel; delete openButton.dataset.scannerRunning; }
    }

    /** Picks the fastest reader this browser can offer; null when there is none. */
    async function prepareReader() {
      if (supportsDetection()) {
        try {
          const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
          return async (video) => {
            const codes = await detector.detect(video);
            return codes && codes[0] ? codes[0].rawValue : "";
          };
        } catch (e) { /* fall through to the software reader */ }
      }
      try {
        const jsQR = await loadJsQr();
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return null;
        return async (video) => {
          if (!video.videoWidth || !video.videoHeight) return "";
          const scale = Math.min(1, FRAME_MAX_WIDTH / video.videoWidth);
          const width = Math.max(1, Math.round(video.videoWidth * scale));
          const height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.width = width;
          canvas.height = height;
          context.drawImage(video, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height);
          const found = jsQR(pixels.data, width, height, { inversionAttempts: "dontInvert" });
          return found && found.data ? found.data : "";
        };
      } catch (e) {
        return null;
      }
    }

    /** Reads frames until a card code appears, then hands it to finish() at once. */
    async function scanLoop(video, mine) {
      if (stopped || mine !== session) return;
      let raw = "";
      try { raw = await reader(video); } catch (e) { raw = ""; }
      if (stopped || mine !== session) return;
      const code = raw ? qrPayloadToCode(raw) : "";
      const now = Date.now();
      if (code && !(code === lastCode && now - lastReadAt < SAME_CARD_QUIET_MS)) {
        lastCode = code;
        lastReadAt = now;
        stop();
        try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { /* not supported */ }
        if (input) input.value = code;
        finish(code, { fromCamera: true });
        return;
      }
      scanTimer = window.setTimeout(() => scanLoop(video, mine), SCAN_INTERVAL_MS);
    }

    /** Opens the camera. Callers clear any message they own; a resume keeps the last one visible. */
    async function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        say("This browser cannot open a camera. Type the code printed under the QR instead.");
        if (input) input.focus();
        return;
      }
      /* Ask the OS BEFORE touching the camera, so a permanent refusal is
         explained once (with a route to Settings) instead of failing silently
         on every tap. */
      const gate = await cameraGate();
      if (!gate.ok) {
        say(gate.message || "Camera permission is not available. Type the code printed under the QR instead.");
        if (gate.settings) offerSettings(block, errorNode);
        if (input) input.focus();
        return;
      }
      const mine = ++session;
      stopped = false;
      if (openButton) { openButton.textContent = "Starting camera…"; openButton.dataset.scannerRunning = "1"; }
      const readerReady = prepareReader();
      let next;
      try {
        next = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (error) {
        if (mine !== session) return;
        stop();
        const denied = error && (error.name === "NotAllowedError" || error.name === "SecurityError");
        say(denied
          ? "Camera permission was declined. Allow it in your browser, or type the code printed under the QR."
          : "No camera could be opened on this device. Type the code printed under the QR.");
        if (input) input.focus();
        return;
      }
      if (mine !== session) { next.getTracks().forEach((track) => track.stop()); return; }
      stream = next;
      reader = await readerReady;
      if (mine !== session) return;
      if (!reader) {
        say("Automatic QR reading is not available on this device. Type the code printed under the QR.");
      }

      viewport = document.createElement("div");
      viewport.className = "scan-viewport";
      const video = document.createElement("video");
      video.setAttribute("playsinline", "");
      video.setAttribute("muted", "");
      video.autoplay = true;
      video.muted = true;
      const frame = document.createElement("span");
      frame.className = "scan-frame";
      frame.setAttribute("aria-hidden", "true");
      const status = document.createElement("p");
      status.className = "scan-status";
      status.setAttribute("role", "status");
      status.textContent = reader ? "Hold the QR code inside the frame" : "Type the code printed under the QR";
      viewport.append(video, frame, status);
      /* Torch: a dark gate at 7pm is exactly when a card is hardest to read.
         Only offered when the hardware reports the capability. */
      let torchTrack = null;
      try {
        torchTrack = stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
        const caps = torchTrack && typeof torchTrack.getCapabilities === "function" ? torchTrack.getCapabilities() : null;
        if (caps && caps.torch) {
          const torch = document.createElement("button");
          torch.type = "button";
          torch.className = "scan-torch";
          torch.setAttribute("data-scanner-torch", "1");
          torch.setAttribute("aria-pressed", "false");
          torch.textContent = "Torch";
          torch.addEventListener("click", () => {
            const nextTorch = torch.getAttribute("aria-pressed") !== "true";
            Promise.resolve(torchTrack.applyConstraints({ advanced: [{ torch: nextTorch }] }))
              .then(() => {
                torch.setAttribute("aria-pressed", nextTorch ? "true" : "false");
                torch.textContent = nextTorch ? "Torch on" : "Torch";
                setStatus(nextTorch ? "Torch on" : "Torch off");
              })
              .catch(() => { torch.disabled = true; torch.textContent = "Torch unavailable"; });
          });
          viewport.appendChild(torch);
        }
      } catch (e) { /* the camera simply has no torch */ }
      block.insertAdjacentElement("afterend", viewport);
      block.classList.add("is-scanning");
      if (openButton) { openButton.textContent = "Stop camera"; openButton.dataset.scannerRunning = "1"; }

      video.addEventListener("loadedmetadata", () => {
        if (mine !== session) return;
        quietly(() => video.play());
        if (reader) scanLoop(video, mine);
      }, { once: true });
      video.addEventListener("error", () => { if (mine === session) stop(); }, { once: true });
      video.srcObject = stream;
    }

    /** Starts the camera again after a read or a miss, but only if the operator still wants it on. */
    function scheduleResume(delay) {
      if (resumeTimer) window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        resumeTimer = 0;
        if (autoResume && stopped) start();
      }, delay);
    }

    /**
     * Where every path ends. With a marking endpoint the code is sent to the
     * server, which verifies it, marks the register and answers with everything
     * the person at the gate needs to say out loud.
     */
    async function finish(rawCode, options) {
      const opts = options || {};
      say("");
      const value = String(rawCode || (input && input.value) || "").trim().toLowerCase();
      const fail = (message) => {
        say(message);
        // A camera that reads something that is not a card keeps looking.
        if (opts.fromCamera && autoResume) scheduleResume(RESUME_AFTER_FAILURE_MS);
      };
      if (!/^[a-z0-9][a-z0-9-]{5,63}$/.test(value)) {
        fail("That is not a card code. Codes are the 24 characters printed under the QR.");
        if (!opts.fromCamera && input) input.focus();
        return;
      }

      if (markEndpoint) {
        if (checkButton) checkButton.disabled = true;
        if (opts.fromCamera && resultNode) resultNode.innerHTML = '<p class="hint scan-checking">Card read. Checking it now…</p>';
        try {
          const body = { code: value };
          if (lastStatus) body.status = lastStatus;
          if (markDate) body.date = markDate;
          // A block that only checks does not change a register: marking happens
          // when the block asks for it on every scan, or when an action button is
          // pressed.
          if (opts.mark !== true && !markAuto) body.mark = false;
          const response = await postJson(markEndpoint, body);
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            fail((data && data.error) || "That card could not be checked. Try again.");
            return;
          }
          renderResult(resultNode, data, { canMark: true, code: value });
          // Listeners (a gate log, a counter, a sound) can react to every scan
          // without this module knowing anything about them.
          block.dispatchEvent(new CustomEvent("eduscanner:result", { detail: data, bubbles: true }));
          if (sequential && data && data.marked) scheduleResume(RESUME_AFTER_MARK_MS);
        } catch (error) {
          fail("The check could not be completed. Check the connection and scan again.");
        } finally {
          if (checkButton) checkButton.disabled = false;
        }
        return;
      }

      if (redirect) { window.location.href = `/verify/${encodeURIComponent(value)}`; return; }
      if (!endpoint) { window.location.href = `/verify/${encodeURIComponent(value)}`; return; }
      if (checkButton) checkButton.disabled = true;
      try {
        const lookupUrl = endpoint + encodeURIComponent(value);
        let response;
        if (offlineMode() && typeof window.API.get === "function") {
          try { response = jsonResponse(await window.API.get(apiRelativePath(lookupUrl)), 200); }
          catch (offlineError) { response = jsonResponse({ error: (offlineError && offlineError.message) || "This card is not saved on this device." }, 503); }
        } else {
          response = await fetch(lookupUrl, { headers: { Accept: "application/json" }, credentials: "omit" });
        }
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          fail((data && data.error) || "No card matches that code. Check it and try again.");
          return;
        }
        // A check inside an app panel renders the answer inline rather than
        // sending the operator away from the screen they were on.
        if (resultNode) {
          renderResult(resultNode, data, { canMark: false, code: value });
          return;
        }
        window.location.href = `/verify/${encodeURIComponent(value)}`;
      } catch (error) {
        fail("The check could not be completed. Check the connection and try again.");
      } finally {
        if (checkButton) checkButton.disabled = false;
      }
    }

    /** The answer, as a card a gatekeeper can read at arm's length, with the holder's photo. */
    function renderResult(node, data, options) {
      if (!node) return;
      const opts = options || {};
      const card = data && data.card;
      if (!card) { node.innerHTML = ""; return; }
      const tone = card.valid ? "ok" : card.verdict === "revoked" ? "bad" : "warn";
      const marked = Boolean(data.marked);
      const rows = [
        ["Name", card.name],
        [card.holderType === "teacher" ? "Staff ID" : "Admission no.", card.identifier],
        [card.holderType === "teacher" ? "Department" : "Class", (data.holder && data.holder.className) || card.department],
        ["School", card.school && card.school.name],
        ["Card status", card.verdict],
        data.attendance && data.attendance.status ? ["Attendance", STATUS_LABELS[data.attendance.status] || data.attendance.status] : ["", ""],
        data.attendance && data.attendance.checkIn ? ["Checked in", data.attendance.checkIn] : ["", ""],
        data.classToday ? ["Today in class", `${data.classToday.marked} of ${data.classToday.total} marked · ${data.classToday.remaining} to go`] : ["", ""],
      ].filter(([, value]) => value);
      const headline = marked
        ? (data.alreadyMarked ? `Already marked ${STATUS_LABELS[data.attendance && data.attendance.status] || ""}` : `Marked ${STATUS_LABELS[data.attendance && data.attendance.status] || ""}`)
        : (tone === "ok" ? "Card is valid" : tone === "bad" ? "Card cancelled" : "Check the details");
      const symbol = marked ? "✓" : tone === "ok" ? "✓" : tone === "bad" ? "✕" : "!";
      const portrait = window.EduProfile && typeof window.EduProfile.avatarHtml === "function"
        ? window.EduProfile.avatarHtml({ photoPath: card.photoPath, name: card.name }, { size: "sm" })
        : "";
      const actions = [];
      if (opts.canMark && card.valid) {
        for (const status of ["present", "late", "excused", "absent"]) {
          if (marked && data.attendance && data.attendance.status === status) continue;
          actions.push(`<button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-scan-mark="${status}">Mark ${STATUS_LABELS[status]}</button>`);
        }
      }
      actions.push(`<a class="dash-btn dash-btn-ghost dash-btn-sm" href="/verify/${encodeURIComponent(card.code || opts.code || "")}" target="_blank" rel="noopener">Open the public page</a>`);
      if (data.printPath) {
        actions.push(`<a class="dash-btn dash-btn-ghost dash-btn-sm" href="${esc(apiUrl(data.printPath))}" target="_blank" rel="noopener">Print this card</a>`);
      }
      node.innerHTML = `<div class="scan-result scan-result-${marked ? "ok" : tone}">
        <div class="scan-result-head">${portrait}<div class="scan-result-headline">
          <p class="scan-result-title">${symbol} ${esc(headline)}</p>
          ${data.message ? `<p class="hint" style="margin:0">${esc(data.message)}</p>` : ""}
        </div></div>
        <dl>${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
        <div class="dash-actions" style="margin-top:10px">${actions.join("")}</div></div>`;
      node.querySelectorAll("[data-scan-mark]").forEach((button) => {
        button.addEventListener("click", () => {
          lastStatus = String(button.getAttribute("data-scan-mark") || "present").toLowerCase();
          finish(card.code || opts.code, { mark: true });
        });
      });
    }

    if (openButton) openButton.addEventListener("click", () => {
      if (openButton.dataset.scannerRunning === "1") {
        autoResume = false;
        stop();
        return;
      }
      autoResume = true;
      say("");
      start();
    });
    if (checkButton) checkButton.addEventListener("click", () => finish(input ? input.value : ""));
    if (input) input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(input.value); }
    });
    // A pasted QR URL should still work: people copy links out of messages.
    if (input) input.addEventListener("paste", () => setTimeout(() => {
      const code = qrPayloadToCode(input.value);
      if (code) input.value = code;
    }, 0));

    return { stop, mark: (code, status) => { if (status) lastStatus = String(status).toLowerCase(); return finish(code); } };
  }

  function initAll(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-scanner]").forEach((block) => {
      if (block.dataset.scannerReady === "1") return;
      block.dataset.scannerReady = "1";
      enhance(block);
      const input = block.querySelector("input[name=code]");
      if (input) input.removeAttribute("disabled");
    });
  }

  // A page may already carry a code in the URL: /verify/<code> shows that card,
  // and the scanner on it must not steal focus or auto-start the camera
  // (getUserMedia without a gesture is blocked in most browsers anyway).
  function boot() {
    initAll(document);
    const params = new URLSearchParams(window.location.search || "");
    const preset = params.get("check") || params.get("code");
    if (preset) {
      const input = document.querySelector("[data-scanner] input[name=code]");
      if (input && !input.value) { input.value = preset; }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  /* ------------------------------ my own card --------------------------------
     A card you cannot check is a card you cannot trust. This panel is what a
     student or a member of staff sees on their own account screen: the code that
     is printed on their card, whether it still verifies, a printer button, and the
     same camera scanner a gatekeeper would use — so a school can prove a card
     works before it is ever handed to a stranger.
  ---------------------------------------------------------------------------- */
  function attachCardPanel(host, options) {
    const opts = options || {};
    const api = opts.api || window.API;
    if (!host || !api) return null;
    host.innerHTML = `<div class="dash-card my-card">
      <div class="dash-card-head"><h3>My ID card</h3><span class="hint">Print it, then check the QR yourself</span></div>
      <div class="dash-card-pad"><p class="hint">Loading…</p></div>
    </div>`;
    const paint = async () => {
      let credential = null;
      let failure = "";
      try {
        credential = (await api.get("/documents/my-card/credential")).credential;
      } catch (error) { failure = error && error.message || "No card has been issued for your account yet."; }
      if (!credential) {
        host.innerHTML = `<div class="dash-card my-card"><div class="dash-card-head"><h3>My ID card</h3></div>
          <div class="dash-card-pad"><p class="hint">${escapeText(failure)} Ask the school office to print your card once; after that it is yours to re-print.</p></div></div>`;
        return;
      }
      const revoked = credential.status === "revoked";
      host.innerHTML = `<div class="dash-card my-card">
        <div class="dash-card-head"><h3>My ID card</h3>
          <span class="idc-state ${revoked ? "idc-state-warn" : "idc-state-ok"}">${revoked ? "cancelled" : "active"}</span></div>
        <div class="dash-card-pad">
          <div class="my-card-grid">
            <div>
              <p class="hint" style="margin:0 0 4px">Code printed under your QR</p>
              <code class="idc-code">${escapeText(credential.code)}</code>
              <p class="hint" style="margin:10px 0 0">${credential.printCount ? `Printed ${credential.printCount} time(s)` : "Not printed yet"}${credential.printedAt ? ` · last on ${escapeText(String(credential.printedAt).slice(0, 10))}` : ""}</p>
            </div>
            <div class="dash-actions">
              <button type="button" class="dash-btn dash-btn-primary dash-btn-sm" data-my-card-print>Print my card</button>
            </div>
          </div>
          <hr class="dash-hr" style="margin:16px 0">
          <p class="hint">Anyone who scans this QR sees only what is printed on the card — your name, class and whether the card is still live. Nothing else is revealed, and the link never expires.</p>
          <div data-scanner data-endpoint="/api/public/card/">
            <input type="text" name="code" value="${escapeText(credential.code)}" autocomplete="off" spellcheck="false" aria-label="Card code">
            <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-scanner-open>Scan with camera</button>
            <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-scanner-check>Check it</button>
          </div>
          <p class="dash-field-hint" data-scanner-error style="color:#b42318" hidden></p>
          <div data-scanner-result></div>
        </div>
      </div>`;
      host.querySelector("[data-my-card-print]").addEventListener("click", () => {
        window.open(api.url("/documents/my-card"), "_blank", "noopener");
      });
      initAll(host);
    };
    paint();
    return { reload: paint };
  }

  const escapeText = (value) => String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  window.EduScanner = { attachCardPanel, boot, enhance, initAll, qrPayloadToCode, supportsDetection, loadJsQr };
})();
