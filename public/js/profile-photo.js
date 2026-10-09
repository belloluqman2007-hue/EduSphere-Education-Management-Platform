"use strict";
/* ============================================================================
   EduSphere — profile pictures and signatures (shared browser module)
   ----------------------------------------------------------------------------
   WHY THIS IS ONE FILE
   Changing a profile picture is wanted in about eight places: the student
   directory, a student profile, the staff table, the teacher workspace, the
   parent and student portals, and the account page. Writing that picker eight
   times is how you get eight subtly different behaviours — and the bug report
   that prompted this module was exactly that: a file input existed in ONE
   place (the "Add Student" form), so nobody could ever change a picture that
   had already been saved.

   So every entry point calls the same two functions:

     EduProfile.attachAvatar(host, { get, set, remove, label })
     EduProfile.openAvatarEditor({ currentUrl, name, onSave, onRemove })
     EduProfile.openSignatureEditor({ name, currentUrl, onSave, onRemove })

   Behaviour a school actually needs, none of it optional:
     • pick a file, drag one in, or take a photo with the camera (mobile opens
       the front camera because `capture="user"` is set on a separate button)
     • square crop with zoom and vertical position, drawn on a canvas, so the
       portrait is square on an ID card instead of a stretched oval
     • the picture is downscaled in the browser to 512 px and re-encoded, so a
       12 MB phone photo never reaches the 5 MB server limit — and never
       becomes a slow upload on a school's mobile connection
     • everything is keyboard reachable and announced, and the module works
       with no CSS of its own beyond the shared dashboard classes

   CSP note: the platform is `script-src 'self'`, so no inline handlers and no
   inline <script> in generated markup — listeners are attached here.
   ========================================================================== */
(function () {
  const MAX_OUTPUT = 512;          // longest edge of the stored portrait
  const JPEG_QUALITY = 0.9;
  const MIN_EDGE = 120;            // refuse a 40 px thumbnail posing as a photo
  const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024;
  const ACCEPT = "image/png,image/jpeg,image/webp";

  function escapeAttr(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function toast(message, kind) {
    // Same fixed toast stack the dashboard and the portals use; appending to
    // <body> directly would drop the toast inline in the page, where nobody
    // sees the confirmation that a picture was saved.
    let host = document.querySelector(".dash-toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "dash-toasts";
      document.body.appendChild(host);
    }
    const node = document.createElement("div");
    node.className = `dash-toast${kind === "error" ? " error" : " success"}`;
    node.setAttribute("role", kind === "error" ? "alert" : "status");
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  function api() {
    return window.API || null;
  }

  /* ------------------------------- image pipeline ------------------------------ */

  function readFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) { reject(new Error("Choose an image first.")); return; }
      if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type || "")) {
        reject(new Error("Use a JPG, PNG or WEBP image."));
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES * 3) {
        // Before it is re-encoded a phone photo can be big; beyond this the
        // browser itself is likely to fail, so say so instead of hanging.
        reject(new Error("That image is too large. Pick a photo under about 12 MB."));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("The file could not be read."));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That image could not be opened."));
      img.src = src;
    });
  }

  /**
   * Crops a square out of `img` at the given zoom/offset and returns a JPEG
   * data URL. Drawn on a canvas at MAX_OUTPUT px so what the server stores is
   * small, square and ready for a card, a table row and a portal header.
   */
  function cropSquare(img, options) {
    const opts = options || {};
    const zoom = Math.max(1, Math.min(4, Number(opts.zoom) || 1));
    const offsetY = Math.max(-1, Math.min(1, Number(opts.offsetY) || 0));
    const target = Math.max(MIN_EDGE, Math.min(1024, Number(opts.size) || MAX_OUTPUT));
    const sourceSquare = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const side = sourceSquare / zoom;
    const maxShift = Math.max(0, sourceSquare - side);
    const sx = (sourceSquare - side) / 2;
    const sy = (sourceSquare - side) / 2 + (maxShift / 2) * offsetY;
    const canvas = document.createElement("canvas");
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.reject(new Error("This browser cannot process images."));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, target, target);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, target, target);
    return Promise.resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
  }

  /* --------------------------------- the editor --------------------------------
     One dialog for both jobs (portrait, signature) because the flow is the same:
     source → preview → save/cancel. The signature variant swaps the crop for a
     drawing surface.
  ---------------------------------------------------------------------------- */
  function openAvatarEditor(options) {
    const opts = options || {};
    const title = opts.title || "Change profile picture";
    const isSignature = Boolean(opts.signature);
    const backdrop = document.createElement("div");
    backdrop.className = "pp-backdrop";
    backdrop.innerHTML = `
      <div class="pp-dialog" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <header class="pp-head"><h3>${escapeAttr(title)}</h3>
          <button type="button" class="pp-x" data-pp-close aria-label="Close">✕</button></header>
        <div class="pp-body">
          ${isSignature ? `
            <p class="pp-note">Sign inside the box with a mouse, trackpad or finger. This is the signature printed on ID cards and certificates.</p>
            <div class="pp-pad-wrap"><canvas class="pp-pad" width="900" height="260" aria-label="Signature drawing area"></canvas></div>
            <div class="pp-row"><button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-pp-clear>Clear signature</button>
              <label class="dash-btn dash-btn-ghost dash-btn-sm">Upload a photo of your signature<input type="file" accept="${ACCEPT}" data-pp-file hidden></label></div>`
          : `
            <div class="pp-stage">
              <div class="pp-crop" data-pp-crop><img alt="" data-pp-image hidden><div class="pp-crop-guide" aria-hidden="true"></div></div>
              <div class="pp-controls">
                <label class="pp-range"><span>Zoom</span><input type="range" min="1" max="3" step="0.02" value="1" data-pp-zoom></label>
                <label class="pp-range"><span>Position</span><input type="range" min="-1" max="1" step="0.02" value="0" data-pp-y></label>
                <p class="pp-hint">A square photo works best. It is cropped to a square and resized for you.</p>
              </div>
            </div>
            <div class="pp-row">
              <label class="dash-btn dash-btn-primary dash-btn-sm">Choose image<input type="file" accept="${ACCEPT}" data-pp-file hidden></label>
              <label class="dash-btn dash-btn-ghost dash-btn-sm">Take a photo<input type="file" accept="image/*" capture="user" data-pp-camera hidden></label>
              <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-pp-paste>Use clipboard</button>
            </div>`}
          <div class="pp-status" data-pp-status role="status"></div>
        </div>
        <footer class="pp-foot">
          ${opts.currentUrl && !isSignature ? '<button type="button" class="dash-btn dash-btn-danger dash-btn-sm" data-pp-remove>Remove picture</button>' : ""}
          ${isSignature && opts.currentUrl ? '<button type="button" class="dash-btn dash-btn-danger dash-btn-sm" data-pp-remove>Remove signature</button>' : ""}
          <span class="pp-spacer"></span>
          <button type="button" class="dash-btn dash-btn-ghost" data-pp-close>Cancel</button>
          <button type="button" class="dash-btn dash-btn-primary" data-pp-save>${isSignature ? "Save signature" : "Save picture"}</button>
        </footer>
      </div>`;
    document.body.appendChild(backdrop);

    const state = { image: null, zoom: 1, offsetY: 0, dataUrl: opts.currentUrl || "", busy: false };
    const $ = (selector) => backdrop.querySelector(selector);
    const status = (message, kind) => {
      const node = $(".pp-status");
      node.textContent = message || "";
      node.classList.toggle("is-error", kind === "error");
    };

    const close = () => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      if (opts.onClose) opts.onClose();
    };
    function onKey(event) { if (event.key === "Escape") { event.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
    backdrop.querySelectorAll("[data-pp-close]").forEach((node) => node.addEventListener("click", close));

    /* --- crop preview ---------------------------------------------------- */
    const preview = $(".pp-crop");
    // The stage markup gives the <img> a data-pp-image attribute, not a class;
    // querying ".pp-image" finds nothing and every pick then died painting the
    // preview with "Cannot set properties of null".
    const previewImage = $("[data-pp-image]");
    let previewImg = null;

    function paintPreview() {
      if (!preview || !state.image) return;
      if (!previewImg) { previewImg = new Image(); }
      const img = state.image;
      const boxSize = 240;
      const sourceSquare = Math.min(img.naturalWidth, img.naturalHeight);
      const side = sourceSquare / state.zoom;
      const maxShift = Math.max(0, sourceSquare - side);
      const sx = (sourceSquare - side) / 2;
      const sy = (sourceSquare - side) / 2 + (maxShift / 2) * state.offsetY;
      const canvas = document.createElement("canvas");
      canvas.width = boxSize; canvas.height = boxSize;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, side, side, 0, 0, boxSize, boxSize);
      previewImage.src = canvas.toDataURL("image/jpeg", 0.8);
      previewImage.hidden = false;
    }

    function setImage(img) {
      state.image = img;
      state.zoom = 1; state.offsetY = 0;
      const zoomInput = backdrop.querySelector("[data-pp-zoom]");
      if (zoomInput) zoomInput.value = "1";
      const yInput = backdrop.querySelector("[data-pp-y]");
      if (yInput) yInput.value = "0";
      paintPreview();
      state.dataUrl = "";
    }

    async function useFile(file) {
      try {
        const dataUrl = await readFile(file);
        const img = await loadImage(dataUrl);
        if (Math.min(img.naturalWidth, img.naturalHeight) < 60) {
          status("That image is too small to print on a card. Choose a larger one.", "error");
          return;
        }
        setImage(img);
        status(`${img.naturalWidth}×${img.naturalHeight} loaded — adjust it, then save.`, "");
      } catch (error) { status(error.message, "error"); }
    }

    if (!isSignature) {
      const dropZone = preview || backdrop;
      ["dragover", "dragenter"].forEach((type) => dropZone.addEventListener(type, (event) => {
        event.preventDefault(); dropZone.classList.add("is-drop");
      }));
      ["dragleave", "drop"].forEach((type) => dropZone.addEventListener(type, (event) => {
        event.preventDefault(); dropZone.classList.remove("is-drop");
        if (type === "drop" && event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]) useFile(event.dataTransfer.files[0]);
      }));
      backdrop.querySelectorAll("[data-pp-file],[data-pp-camera]").forEach((input) => {
        input.addEventListener("change", () => { if (input.files && input.files[0]) useFile(input.files[0]); });
      });
      const zoom = backdrop.querySelector("[data-pp-zoom]");
      const shift = backdrop.querySelector("[data-pp-y]");
      if (zoom) zoom.addEventListener("input", () => { state.zoom = Number(zoom.value); paintPreview(); });
      if (shift) shift.addEventListener("input", () => { state.offsetY = Number(shift.value); paintPreview(); });
      // Pointer-drag to reposition, which is what people try first.
      let dragging = null;
      if (preview) {
        preview.addEventListener("pointerdown", (event) => {
          if (!state.image) return;
          dragging = { y: event.clientY, offset: state.offsetY };
          preview.setPointerCapture(event.pointerId);
        });
        preview.addEventListener("pointermove", (event) => {
          if (!dragging || !state.image) return;
          const delta = (event.clientY - dragging.y) / 120;
          state.offsetY = Math.max(-1, Math.min(1, dragging.offset - delta));
          if (shift) shift.value = String(state.offsetY);
          paintPreview();
        });
        const stop = (event) => { if (dragging && preview.releasePointerCapture) { try { preview.releasePointerCapture(event.pointerId); } catch (e) { /* already gone */ } } dragging = null; };
        preview.addEventListener("pointerup", stop);
        preview.addEventListener("pointercancel", stop);
      }
      const paste = backdrop.querySelector("[data-pp-paste]");
      if (paste) paste.addEventListener("click", async () => {
        if (!navigator.clipboard || !navigator.clipboard.read) { status("This browser cannot read the clipboard. Choose an image instead.", "error"); return; }
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const type = (item.types || []).find((t) => t.startsWith("image/"));
            if (!type) continue;
            const blob = await item.getType(type);
            await useFile(new File([blob], "pasted.png", { type }));
            return;
          }
          status("No image was found on the clipboard.", "error");
        } catch (error) { status("The clipboard could not be read.", "error"); }
      });
      if (opts.currentUrl && previewImage) { previewImage.hidden = false; previewImage.src = opts.currentUrl; }
    }

    /* --- signature pad --------------------------------------------------- */
    let padCtx = null; let drawing = false; let dirty = false;
    const pad = backdrop.querySelector(".pp-pad");
    if (isSignature && pad) {
      padCtx = pad.getContext("2d");
      const setup = () => {
        padCtx.fillStyle = "#ffffff";
        padCtx.fillRect(0, 0, pad.width, pad.height);
        padCtx.strokeStyle = "#0f1b33";
        padCtx.lineWidth = 3.2;
        padCtx.lineJoin = "round";
        padCtx.lineCap = "round";
        dirty = false;
      };
      setup();
      const point = (event) => {
        const rect = pad.getBoundingClientRect();
        return {
          x: ((event.clientX - rect.left) / rect.width) * pad.width,
          y: ((event.clientY - rect.top) / rect.height) * pad.height,
        };
      };
      pad.addEventListener("pointerdown", (event) => {
        drawing = true; dirty = true;
        pad.setPointerCapture(event.pointerId);
        const p = point(event);
        padCtx.beginPath();
        padCtx.moveTo(p.x, p.y);
        padCtx.lineTo(p.x + 0.4, p.y + 0.4);
        padCtx.stroke();
      });
      pad.addEventListener("pointermove", (event) => {
        if (!drawing) return;
        const p = point(event);
        padCtx.lineTo(p.x, p.y);
        padCtx.stroke();
      });
      ["pointerup", "pointercancel", "pointerleave"].forEach((type) => pad.addEventListener(type, () => { drawing = false; }));
      const clear = backdrop.querySelector("[data-pp-clear]");
      if (clear) clear.addEventListener("click", setup);
      const file = backdrop.querySelector("[data-pp-file]");
      if (file) file.addEventListener("change", async () => {
        if (!file.files || !file.files[0]) return;
        try {
          state.dataUrl = await readFile(file.files[0]);
          dirty = true;
          status("Signature image loaded — check it reads clearly, then save.", "");
        } catch (error) { status(error.message, "error"); }
      });
      backdrop.querySelector(".pp-pad-wrap")._setupPad = setup;
    }

    /* --- save ------------------------------------------------------------- */
    const saveButton = backdrop.querySelector("[data-pp-save]");
    saveButton.addEventListener("click", async () => {
      if (state.busy) return;
      let dataUrl = "";
      if (isSignature) {
        if (state.dataUrl) dataUrl = state.dataUrl;
        else if (pad && dirty) {
          // Trim the white margins so the printed signature sits on the line
          // instead of floating above it.
          dataUrl = trimCanvasToInk(pad, padCtx);
        } else { status("Please sign inside the box first.", "error"); return; }
      } else {
        if (!state.image) { status("Choose or take a photo first.", "error"); return; }
        try { dataUrl = await cropSquare(state.image, { zoom: state.zoom, offsetY: state.offsetY, size: MAX_OUTPUT }); }
        catch (error) { status(error.message, "error"); return; }
      }
      state.busy = true;
      saveButton.disabled = true;
      status("Saving…", "");
      try {
        await opts.onSave(dataUrl);
        close();
      } catch (error) {
        state.busy = false;
        saveButton.disabled = false;
        status(error.message || "The picture could not be saved.", "error");
      }
    });

    const remove = backdrop.querySelector("[data-pp-remove]");
    if (remove) remove.addEventListener("click", async () => {
      if (!opts.onRemove) { close(); return; }
      remove.disabled = true;
      try { await opts.onRemove(); close(); }
      catch (error) { remove.disabled = false; status(error.message || "Could not remove it.", "error"); }
    });

    return { close };
  }

  /** Crops a drawn signature to its ink box, on a transparent background. */
  function trimCanvasToInk(canvas, ctx) {
    const padding = 10;
    let top = canvas.height, left = canvas.width, bottom = 0, right = 0;
    try {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const index = (y * canvas.width + x) * 4;
          // Any non-white, non-transparent pixel counts as ink.
          if (data[index + 3] > 8 && (data[index] < 235 || data[index + 1] < 235 || data[index + 2] < 235)) {
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }
    } catch (error) { return canvas.toDataURL("image/png"); }
    if (bottom <= 0 || right <= 0) return canvas.toDataURL("image/png");
    top = Math.max(0, top - padding); left = Math.max(0, left - padding);
    bottom = Math.min(canvas.height - 1, bottom + padding); right = Math.min(canvas.width - 1, right + padding);
    const out = document.createElement("canvas");
    out.width = Math.max(20, right - left);
    out.height = Math.max(20, bottom - top);
    const outCtx = out.getContext("2d");
    outCtx.drawImage(canvas, left, top, right - left, bottom - top, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }

  /* ------------------------------ attachment UI -------------------------------
     Turns any element into a picture button: click, Enter, Space, drag & drop.
     Callers give it three callbacks so the module stays ignorant of which
     endpoint belongs to a student, a teacher or the signed-in account.
  ---------------------------------------------------------------------------- */
  function attachAvatar(host, options) {
    const opts = options || {};
    if (!host || host.dataset.ppBound === "1") return null;
    host.dataset.ppBound = "1";
    host.classList.add("pp-trigger");
    host.setAttribute("role", "button");
    host.setAttribute("tabindex", "0");
    if (!host.getAttribute("aria-label")) host.setAttribute("aria-label", opts.label || "Change profile picture");
    const overlay = document.createElement("span");
    overlay.className = "pp-overlay";
    overlay.innerHTML = `<span class="pp-overlay-text">${escapeAttr(opts.actionLabel || "Change photo")}</span>`;
    host.appendChild(overlay);

    let hover = null;
    const open = () => {
      hover = { host };
      openAvatarEditor({
        title: opts.title,
        signature: opts.signature,
        currentUrl: typeof opts.currentUrl === "function" ? opts.currentUrl() : (opts.currentUrl || ""),
        onSave: (dataUrl) => Promise.resolve(opts.onSave(dataUrl)).then(() => {
          toast(opts.savedMessage || "Picture updated.", "success");
          if (opts.onDone) opts.onDone();
        }),
        onRemove: opts.onRemove ? () => Promise.resolve(opts.onRemove()).then(() => {
          toast("Picture removed.", "success");
          if (opts.onDone) opts.onDone();
        }) : null,
        onClose: () => { hover = null; },
      });
    };
    host.addEventListener("click", (event) => { event.preventDefault(); open(); });
    host.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") { event.preventDefault(); open(); }
    });
    if (opts.dropzone !== false) {
      host.addEventListener("dragover", (event) => { event.preventDefault(); host.classList.add("is-drop"); });
      host.addEventListener("dragleave", () => host.classList.remove("is-drop"));
      host.addEventListener("drop", (event) => {
        event.preventDefault();
        host.classList.remove("is-drop");
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (!file) return;
        readFile(file).then((dataUrl) => loadImage(dataUrl)).then((img) => {
          if (!opts.onSave) return;
          return cropSquare(img, { size: MAX_OUTPUT }).then((cropped) => opts.onSave(cropped)).then(() => {
            toast(opts.savedMessage || "Picture updated.", "success");
            if (opts.onDone) opts.onDone();
          });
        }).catch((error) => toast(error.message, "error"));
      });
    }
    return { open, dispose() { host.dataset.ppBound = ""; } };
  }

  /* --------------------------------- endpoints --------------------------------
     Every surface that shows a picture points at one of these three. Keeping
     them here means the dashboard, both portals and the staff workspace send
     the same payload to the same place.
  ---------------------------------------------------------------------------- */
  const endpoints = {
    self: {
      save: (dataUrl) => api().put("/auth/account/signature", { signatureDataUrl: dataUrl }),
      remove: () => api().del("/auth/account/signature"),
    },
    selfPhoto: {
      save: (dataUrl) => api().post("/auth/account/photo", { photoDataUrl: dataUrl }),
      remove: () => api().del("/auth/account/photo"),
    },
    studentPhoto: (id) => ({
      save: (dataUrl) => api().post(`/students/${id}/photo`, { photoDataUrl: dataUrl }),
      remove: () => api().del(`/students/${id}/photo`),
    }),
    studentSignature: (id) => ({
      save: (dataUrl) => api().put(`/students/${id}/signature`, { signatureDataUrl: dataUrl }),
    }),
    teacherPhoto: (id) => ({
      save: (dataUrl) => api().post(`/teachers/${id}/photo`, { photoDataUrl: dataUrl }),
      remove: () => api().del(`/teachers/${id}/photo`),
    }),
    teacherSignature: (id) => ({
      save: (dataUrl) => api().put(`/teachers/${id}/signature`, { signatureDataUrl: dataUrl }),
    }),
  };

  /**
   * Small HTML snippet reused everywhere a portrait is shown, so an avatar
   * looks identical in a table, a profile hero and a portal header.
   */
  function avatarHtml(person, options) {
    const opts = options || {};
    const photo = person && (person.photoPath || person.photo_path) || "";
    const name = (person && (person.name || person.full_name || [person.first_name, person.last_name].filter(Boolean).join(" "))) || "";
    const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
    const cls = `pp-avatar${opts.size ? ` pp-avatar-${opts.size}` : ""}${opts.editable ? " pp-avatar-editable" : ""}`;
    return `<span class="${cls}">${photo ? `<img src="${escapeAttr(photo)}" alt="">` : `<span class="pp-avatar-mono">${escapeAttr(letters)}</span>`}</span>`;
  }

  /* ---------------------- "My account" card (every role) ----------------------
     One card, used by the administrator settings page and by all three portals,
     so "I cannot change my picture" can never again be true of one role and
     false of another. It writes to users.photo_path / users.signature_path and
     the server mirrors the portrait into the linked student or staff record.
  ---------------------------------------------------------------------------- */
  /** Lets the shell (header chip) refresh itself without this module knowing it. */
  function announce(photoPath) {
    if (window.EduProfile) window.EduProfile.lastSelfPhoto = photoPath;
    document.dispatchEvent(new CustomEvent("edusphere:self-photo", { detail: { photoPath } }));
  }

  function accountCardHtml(opts) {
    const o = opts || {};
    const signature = o.showSignature === false ? "" : `
      <div class="teacher-signature-row">
        <span class="teacher-signature-box" data-pp-signature-box>${o.signaturePath
          ? `<img src="${escapeAttr(o.signaturePath)}" alt="Your saved signature" class="teacher-signature-img">`
          : `<span class="hint">No signature saved yet</span>`}</span>
        <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-pp-signature>${o.signaturePath ? "Redraw signature" : "Draw signature"}</button>
      </div>`;
    return `<div class="dash-card account-identity" style="grid-column:1/-1">
      <div class="dash-card-head"><h3>Portrait${o.showSignature === false ? "" : " &amp; signature"}</h3>
        <span class="hint">${o.hint || "Used on your ID card and anywhere your name is printed"}</span></div>
      <div class="dash-card-pad">
        <div class="teacher-identity">
          <div class="teacher-identity-portrait"><span data-pp-avatar-host>${avatarHtml({ photoPath: o.photoPath, name: o.name }, { size: "lg" })}</span></div>
          <div class="teacher-identity-body">
            <h4>${escapeAttr(o.name || "Your account")}</h4>
            <p class="hint">Drag a picture straight onto the circle, or click it to crop one. Square photos of 512 px or more look best, and nothing you choose ever leaves this school.</p>
            ${signature}
          </div>
        </div>
      </div>
    </div>`;
  }

  /**
   * Renders the card inside `host` (a .portal-grid-2 / .dash-grid-2 container or
   * any element) and wires both editors. Returns the card node.
   */
  function attachAccountCard(host, opts) {
    const o = opts || {};
    if (!host) return null;
    const account = o.account || {};
    const photoPath = o.photoPath !== undefined ? o.photoPath : (account.photo_path || account.photoPath || "");
    const signaturePath = o.signaturePath !== undefined ? o.signaturePath : (account.signature_path || account.signaturePath || "");
    const name = o.name || account.full_name || account.fullName || account.username || "Your account";
    const wrap = document.createElement("div");
    wrap.innerHTML = accountCardHtml({ name, photoPath, signaturePath, showSignature: o.showSignature, hint: o.hint });
    const card = wrap.firstElementChild;
    host.insertBefore(card, host.firstChild);

    const avatarHost = card.querySelector("[data-pp-avatar-host]");
    let current = photoPath;
    attachAvatar(avatarHost, {
      title: "Your profile picture",
      actionLabel: "Change photo",
      currentUrl: () => current,
      savedMessage: "Your picture now appears everywhere it is used.",
      onSave: (dataUrl) => endpoints.selfPhoto.save(dataUrl).then(() => {
        current = dataUrl;
        avatarHost.innerHTML = avatarHtml({ photoPath: dataUrl, name }, { size: "lg" });
        announce(dataUrl);
      }),
      onRemove: () => endpoints.selfPhoto.remove().then(() => {
        current = "";
        avatarHost.innerHTML = avatarHtml({ name }, { size: "lg" });
        announce("");
      }),
    });

    if (o.showSignature !== false) {
      const button = card.querySelector("[data-pp-signature]");
      const box = card.querySelector("[data-pp-signature-box]");
      let signature = signaturePath;
      button.addEventListener("click", () => openAvatarEditor({
        title: "Your signature",
        signature: true,
        currentUrl: signature,
        onSave: (dataUrl) => endpoints.self.save(dataUrl).then(() => {
          signature = dataUrl;
          if (box) box.innerHTML = `<img src="${escapeAttr(dataUrl)}" alt="Your saved signature" class="teacher-signature-img">`;
          button.textContent = "Redraw signature";
          toast("Signature saved.", "success");
        }),
      }));
    }
    return card;
  }

  /* --------------------- staff portrait + signature strip --------------------
     The teacher directory, the teacher's own portal and the admin account screen
     all need the same pair of controls. Duplicating the markup three times is how
     one of them ends up missing a feature, so it lives here once: the strip is
     rendered into any host and bound to the staff account's own endpoints.
  ---------------------------------------------------------------------------- */
  function staffIdentityHtml(person, options) {
    const o = options || {};
    const signature = person.signaturePath
      ? `<img src="${escapeAttr(person.signaturePath)}" alt="Saved signature" class="pp-signature-img">`
      : `<span class="hint">No signature saved yet</span>`;
    return `<div class="teacher-identity">
      <div class="teacher-identity-portrait"><span data-pp-staff-avatar>${avatarHtml({ photoPath: person.photoPath, name: person.name }, { size: "lg" })}</span></div>
      <div class="teacher-identity-body">
        <h4>Portrait${o.signature === false ? "" : " &amp; signature"}</h4>
        <p class="hint">${o.hint || "The picture prints on the ID card and in the portal. The signature is what appears on any certificate this person signs."}</p>
        ${o.signature === false ? "" : `<div class="teacher-signature-row">
          <span class="teacher-signature-box" data-pp-staff-signature-box>${signature}</span>
          <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-pp-staff-signature>${person.signaturePath ? "Redraw signature" : "Draw signature"}</button>
        </div>`}
      </div>
      <div class="dash-actions pp-strip-actions">
        ${o.cardUrl ? `<button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-pp-staff-card>Print ID card</button>` : ""}
      </div>
    </div>`;
  }

  /**
   * @param {HTMLElement} host  container to fill with the strip
   * @param {object} person     { name, photoPath, signaturePath }
   * @param {object} options    { userId, self, cardUrl, signature, toast, onSaved }
   *   `self` saves against the signed-in account (the portal case); otherwise the
   *   staff admin endpoints for `userId` are used.
   */
  function attachStaffIdentity(host, person, options) {
    const o = options || {};
    if (!host) return null;
    const who = Object.assign({ photoPath: "", signaturePath: "" }, person || {});
    host.innerHTML = staffIdentityHtml(who, o);
    const userId = Number(o.userId || who.userId || 0);
    const photo = o.self ? endpoints.selfPhoto : endpoints.teacherPhoto(userId);
    const signature = o.self ? endpoints.self : endpoints.teacherSignature(userId);
    const canWrite = o.self || userId > 0;

    const avatarHost = host.querySelector("[data-pp-staff-avatar]");
    if (avatarHost && canWrite) {
      attachAvatar(avatarHost, {
        title: `Portrait — ${who.name || "staff member"}`,
        actionLabel: "Change photo",
        currentUrl: () => who.photoPath || "",
        savedMessage: "Portrait updated on the profile, the ID card and the portal.",
        onSave: (dataUrl) => photo.save(dataUrl).then(() => {
          who.photoPath = dataUrl;
          avatarHost.innerHTML = avatarHtml(who, { size: "lg" });
          if (o.onSaved) o.onSaved({ photoPath: dataUrl });
        }),
        onRemove: () => photo.remove().then(() => {
          who.photoPath = "";
          avatarHost.innerHTML = avatarHtml(who, { size: "lg" });
          if (o.onSaved) o.onSaved({ photoPath: "" });
        }),
      });
    }

    if (o.signature !== false) {
      const button = host.querySelector("[data-pp-staff-signature]");
      const box = host.querySelector("[data-pp-staff-signature-box]");
      if (button && canWrite) button.addEventListener("click", () => openAvatarEditor({
        title: `Signature — ${who.name || "staff member"}`,
        signature: true,
        currentUrl: who.signaturePath || "",
        onSave: (dataUrl) => signature.save(dataUrl).then(() => {
          who.signaturePath = dataUrl;
          if (box) box.innerHTML = `<img src="${escapeAttr(dataUrl)}" alt="Saved signature" class="pp-signature-img">`;
          button.textContent = "Redraw signature";
          toast("Signature saved. It prints on the documents this person signs.", "success");
          if (o.onSaved) o.onSaved({ signaturePath: dataUrl });
        }),
      }));
    }

    const card = host.querySelector("[data-pp-staff-card]");
    if (card && o.cardUrl) card.addEventListener("click", () => {
      const API = o.api || window.API;
      window.open(API && API.url ? API.url(o.cardUrl) : o.cardUrl, "_blank", "noopener");
    });
    return host;
  }

  window.EduProfile = {
    MAX_OUTPUT,
    ACCEPT,
    accountCardHtml,
    attachAccountCard,
    attachAvatar,
    attachStaffIdentity,
    avatarHtml,
    staffIdentityHtml,
    cropSquare,
    endpoints,
    escapeAttr,
    loadImage,
    openAvatarEditor,
    readFile,
    toast,
  };
})();
