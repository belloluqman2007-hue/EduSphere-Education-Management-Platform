"use strict";
/* ============================================================================
   EduSphere — camera verification and marking (scan a card, act on it)
   ----------------------------------------------------------------------------
   The printed QR on a card is only useful if a phone can read it and the person
   on the other side can DO something with the answer. Two paths, one module:

     1. The camera decodes the QR. `BarcodeDetector` is built into Chrome, Edge,
        Android WebView and Safari 17+ — no library, no WASM download, nothing
        to fail on a school's flaky connection. It is also the only browser API
        that decodes video at reasonable speed.
     2. Where it is not available (older browsers, a desktop with no camera, or a
        lens that cannot focus on a scratched card) the code printed under the
        QR is typed in. Both routes end at the same answer, so nothing depends
        on which one you used.

   There is no fallback to a remote decoding service on purpose: a stranger's
   API must never be handed a photograph of a child's face.

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

   The marking answer renders inline — the holder's name, class, whether they
   were already marked, how many learners are still unmarked today — with the
   actions a gate needs: mark late, excused or absent, open the public
   verification page, print the card again. No screen is left without a path.

   This file is loaded by the public verification page (no session) and by the
   signed-in dashboard, so it touches no app state beyond `window.API` when it
   is there.
   ========================================================================== */
(function () {
  const CODE_PATTERN = /(?:https?:\/\/[^\s"']+\/verify\/(?:card\/|certificate\/)?|code[:\s]+)?([a-z0-9][a-z0-9-]{5,63})/i;
  const STATUS_LABELS = { present: "present", late: "late", excused: "excused", absent: "absent" };

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
   * One scanner instance per [data-scanner] block. Created lazily so the page
   * works with scripting blocked: the input, the Check button and the printed
   * code are plain HTML.
   */
  function enhance(block) {
    const input = block.querySelector("input[name=code]");
    const openButton = block.querySelector("[data-scanner-open]");
    const checkButton = block.querySelector("[data-scanner-check]");
    const errorNode = block.querySelector("[data-scanner-error]");
    const resultNode = block.querySelector("[data-scanner-result]");
    const endpoint = block.getAttribute("data-endpoint") || "";
    const markEndpoint = block.getAttribute("data-mark-endpoint") || "";
    const markAuto = block.getAttribute("data-mark-auto") === "1";
    const markStatus = String(block.getAttribute("data-mark-status") || "present").toLowerCase();
    const markDate = String(block.getAttribute("data-scan-date") || "").trim();
    const sequential = block.getAttribute("data-sequential") === "1";
    const redirect = block.getAttribute("data-redirect") === "1";
    const idleLabel = openButton ? String(openButton.textContent || "Scan with camera").trim() : "Scan with camera";
    let stream = null;
    let raf = 0;
    let detector = null;
    let stopped = false;
    let lastStatus = markStatus;
    let resumeTimer = 0;

    const say = (message) => {
      if (!errorNode) return;
      errorNode.textContent = message || "";
      errorNode.hidden = !message;
    };

    function stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (resumeTimer) { window.clearTimeout(resumeTimer); resumeTimer = 0; }
      if (stream) stream.getTracks().forEach((track) => track.stop());
      stream = null;
      const video = block.querySelector("video");
      if (video) { video.pause(); video.srcObject = null; video.remove(); }
      block.classList.remove("is-scanning");
      if (openButton) { openButton.textContent = idleLabel; delete openButton.dataset.scannerRunning; }
    }

    async function scanLoop(video) {
      if (stopped) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) {
          const code = qrPayloadToCode(codes[0].rawValue);
          if (code) {
            stop();
            if (input) input.value = code;
            finish(code, { fromCamera: true });
            return;
          }
        }
      } catch (e) { /* a dropped frame is not an error worth showing */ }
      raf = requestAnimationFrame(() => scanLoop(video));
    }

    async function start() {
      say("");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        say("This browser cannot open a camera. Type the code printed under the QR instead.");
        if (input) input.focus();
        return;
      }
      if (!supportsDetection()) {
        // The camera can still be shown so the person can read the code off the
        // screen and type it; that is honest and useful, unlike a silent failure.
        say("Automatic QR reading is not available here, so the camera preview helps you read the code printed under the QR.");
      }
      if (typeof window.BarcodeDetector === "function") {
        try {
          detector = await new window.BarcodeDetector({ formats: ["qr_code"] });
        } catch (e) {
          detector = null;
          say("The camera QR reader could not start. Type the code instead.");
        }
      }
      let next;
      try {
        next = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (error) {
        const denied = error && (error.name === "NotAllowedError" || error.name === "SecurityError");
        say(denied
          ? "Camera permission was declined. Allow it in your browser, or type the code printed under the QR."
          : "No camera could be opened on this device. Type the code printed under the QR.");
        if (input) input.focus();
        return;
      }
      stream = next;
      stopped = false;
      const video = document.createElement("video");
      video.setAttribute("playsinline", "");
      video.setAttribute("muted", "");
      video.autoplay = true;
      video.muted = true;
      video.srcObject = stream;
      block.appendChild(video);
      block.classList.add("is-scanning");
      if (openButton) { openButton.textContent = "Stop camera"; openButton.dataset.scannerRunning = "1"; }
      video.addEventListener("loadedmetadata", () => {
        if (detector && supportsDetection()) {
          scanLoop(video);
        } else {
          // Manual mode: let the person read the code from the live preview.
          say("Line the QR up in the frame, then type the code it shows if it will not read automatically.");
        }
      }, { once: true });
      video.addEventListener("error", () => stop(), { once: true });
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
      if (!/^[a-z0-9][a-z0-9-]{5,63}$/.test(value)) {
        say("That is not a card code. Codes are the 24 characters printed under the QR.");
        if (input) input.focus();
        return;
      }

      if (markEndpoint) {
        if (checkButton) checkButton.disabled = true;
        try {
          const body = { code: value };
          if (lastStatus) body.status = lastStatus;
          if (markDate) body.date = markDate;
          // A block that only checks does not change a register: marking happens
          // when the block asks for it on every scan, or when an action button is
          // pressed.
          if (opts.mark !== true && !markAuto) body.mark = false;
          const response = await fetch(markEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(body),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            say((data && data.error) || "That card could not be checked. Try again.");
            return;
          }
          renderResult(resultNode, data, { canMark: true, code: value });
          // Listeners (a gate log, a counter, a sound) can react to every scan
          // without this module knowing anything about them.
          block.dispatchEvent(new CustomEvent("eduscanner:result", { detail: data, bubbles: true }));
          if (sequential && data && data.marked) {
            resumeTimer = window.setTimeout(() => { resumeTimer = 0; start(); }, 1400);
          }
        } catch (error) {
          say("The check could not be completed. Check the connection and scan again.");
        } finally {
          if (checkButton) checkButton.disabled = false;
        }
        return;
      }

      if (redirect) { window.location.href = `/verify/${encodeURIComponent(value)}`; return; }
      if (!endpoint) { window.location.href = `/verify/${encodeURIComponent(value)}`; return; }
      if (checkButton) checkButton.disabled = true;
      try {
        const response = await fetch(endpoint + encodeURIComponent(value), { headers: { Accept: "application/json" }, credentials: "omit" });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          say((data && data.error) || "No card matches that code. Check it and try again.");
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
        say("The check could not be completed. Check the connection and try again.");
      } finally {
        if (checkButton) checkButton.disabled = false;
      }
    }

    /** The answer, as a card a gatekeeper can read at arm's length. */
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
        <p class="scan-result-title">${symbol} ${esc(headline)}</p>
        ${data.message ? `<p class="hint" style="margin:0 0 8px">${esc(data.message)}</p>` : ""}
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
      if (openButton.dataset.scannerRunning === "1") stop();
      else start();
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
          <div class="row" data-scanner data-endpoint="/api/public/card/">
            <input type="text" name="code" value="${escapeText(credential.code)}" autocomplete="off" spellcheck="false" aria-label="Card code" style="flex:1;min-width:140px;padding:9px 11px;border:1px solid #cfd9e8;border-radius:10px;font:600 14px/1.2 ui-monospace,Menlo,Consolas,monospace">
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

  window.EduScanner = { attachCardPanel, boot, enhance, initAll, qrPayloadToCode, supportsDetection };
})();
