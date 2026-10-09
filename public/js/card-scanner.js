"use strict";
/* ============================================================================
   EduSphere — camera verification (scan a card, check a code)
   ----------------------------------------------------------------------------
   The printed QR on an ID card is only useful if a phone can read it. Two
   paths, one module:

     1. The camera decodes the QR. `BarcodeDetector` is built into Chrome, Edge,
        Android WebView and Safari 17+ — no library, no WASM download, nothing
        to fail on a school's flaky connection. It is also the only browser API
        that decodes video at reasonable speed.
     2. Where it is not available (older browsers, a desktop with no camera, or
        a lens that cannot focus on a scratched card) the code printed under the
        QR is typed in. Both routes end at the same verification page, so the
        answer never depends on which one you used.

   There is no fallback to a remote decoding service on purpose: a stranger's
   API must never be handed a photograph of a child's face.

   This file is loaded by the public verification page (no session) and by the
   signed-in dashboard. It therefore touches no app state and assumes only
   `data-scanner` markup plus a JSON endpoint.
   ========================================================================== */
(function () {
  const CODE_PATTERN = /(?:https?:\/\/[^\s"']+\/verify\/(?:card\/|certificate\/)?|code[:\s]+)?([a-z0-9]{6,64})/i;

  function qrPayloadToCode(text) {
    const match = CODE_PATTERN.exec(String(text || "").trim());
    return match ? match[1].toLowerCase() : "";
  }

  function supportsDetection() {
    return typeof window.BarcodeDetector === "function";
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
    const endpoint = block.getAttribute("data-endpoint") || "";
    const redirect = block.getAttribute("data-redirect") === "1";
    let stream = null;
    let raf = 0;
    let detector = null;
    let stopped = false;

    const say = (message) => {
      if (!errorNode) return;
      errorNode.textContent = message || "";
      errorNode.hidden = !message;
    };

    function stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (stream) stream.getTracks().forEach((track) => track.stop());
      stream = null;
      const video = block.querySelector("video");
      if (video) { video.pause(); video.srcObject = null; video.remove(); }
      block.classList.remove("is-scanning");
      if (openButton) openButton.textContent = "Scan with camera";
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
            finish(code);
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
      if (openButton) openButton.textContent = "Stop camera";
      video.addEventListener("loadedmetadata", () => {
        if (detector && supportsDetection()) {
          scanLoop(video);
        } else {
          // Manual mode: let the person read the code from the live preview.
          say("Line the QR up in the frame, then type the code it shows if it will not read automatically.");
        }
      }, { once: true });
      const close = () => stop();
      video.addEventListener("error", close, { once: true });
      if (openButton) openButton.dataset.scannerRunning = "1";
    }

    async function finish(code) {
      say("");
      const value = String(code || (input && input.value) || "").trim().toLowerCase();
      if (!/^[a-z0-9]{6,64}$/.test(value)) {
        say("That is not a card code. Codes are the 24 characters printed under the QR.");
        if (input) input.focus();
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
        if (block.querySelector("[data-scanner-result]")) {
          renderInline(block.querySelector("[data-scanner-result]"), data);
          return;
        }
        window.location.href = `/verify/${encodeURIComponent(value)}`;
      } catch (error) {
        say("The check could not be completed. Check the connection and try again.");
      } finally {
        if (checkButton) checkButton.disabled = false;
      }
    }

    function renderInline(node, data) {
      const card = data && data.card;
      if (!card) { node.innerHTML = ""; return; }
      const tone = card.valid ? "ok" : card.verdict === "revoked" ? "bad" : "warn";
      const rows = [
        ["Name", card.name],
        [card.holderType === "teacher" ? "Staff ID" : "Admission no.", card.identifier],
        [card.holderType === "teacher" ? "Department" : "Class", card.department],
        ["School", card.school && card.school.name],
        ["Card status", card.verdict],
      ].filter(([, value]) => value);
      node.innerHTML = `<div class="scan-result scan-result-${tone}">
        <p class="scan-result-title">${tone === "ok" ? "✓ Card is valid" : tone === "bad" ? "✕ " + (card.verdict === "revoked" ? "Card cancelled" : "Not valid") : "! Check the details"}</p>
        <dl>${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${String(value).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</dd></div>`).join("")}</dl>
        <a class="dash-btn dash-btn-ghost dash-btn-sm" href="/verify/${card.code}" target="_blank" rel="noopener">Open the public page</a></div>`;
    }

    if (openButton) openButton.addEventListener("click", () => {
      if (openButton.dataset.scannerRunning === "1") { stop(); delete openButton.dataset.scannerRunning; } else start();
    });
    if (checkButton) checkButton.addEventListener("click", () => finish());
    if (input) input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(input.value); }
    });
    // A pasted QR URL should still work: people copy links out of messages.
    if (input) input.addEventListener("paste", () => setTimeout(() => {
      const code = qrPayloadToCode(input.value);
      if (code) input.value = code;
    }, 0));

    return { stop };
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
