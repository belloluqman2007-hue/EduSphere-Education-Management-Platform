"use strict";
/* ============================================================================
   EduSphere — ADMIN → MY INSTITUTION
   ----------------------------------------------------------------------------
   The eight screens of the administrator's institution section:

     1 Institution Profile      5 Website Pages
     2 Institution Information  6 Gallery
     3 Public Website           7 Contact Information
     4 Website Appearance       8 Institution Settings

   This module owns ONLY that section. It renders into the same #dashContent
   node as every other dashboard page and borrows the dashboard's own helpers
   (icons, toasts, modals, router) through the context object passed to
   render(), so it inherits the existing admin design system exactly — no new
   colour palette, no second router, no duplicated API client.

   Everything here is backed by /api/madrasa/institution/* (tenant-scoped,
   administrator-only on the server). Nothing is a mock-up.
   ========================================================================== */
(function () {
  /* ----------------------------------------------------------------------
     Section catalogue — also drives the in-section navigation bar.
     ---------------------------------------------------------------------- */
  const SECTIONS = [
    { key: "profile", route: "institution/profile", icon: "building", label: "Profile", full: "Institution Profile" },
    { key: "information", route: "institution/information", icon: "file", label: "Information", full: "Institution Information" },
    { key: "website", route: "institution/website", icon: "globe", label: "Public Website", full: "Public Website" },
    { key: "appearance", route: "institution/appearance", icon: "image", label: "Appearance", full: "Website Appearance" },
    { key: "pages", route: "institution/pages", icon: "book", label: "Pages", full: "Website Pages" },
    { key: "gallery", route: "institution/gallery", icon: "image", label: "Gallery", full: "Gallery" },
    { key: "contact", route: "institution/contact", icon: "mail", label: "Contact", full: "Contact Information" },
    { key: "settings", route: "institution/settings", icon: "settings", label: "Settings", full: "Institution Settings" },
  ];

  const ROUTE_TO_KEY = SECTIONS.reduce((map, s) => { map[s.route] = s.key; return map; }, {});
  /* The older "Website" sidebar group points at the same features. They are
     routed here rather than duplicated, so a school has exactly one place to
     manage each thing. */
  const ALIASES = {
    "website/public": "website",
    "website/appearance": "appearance",
    "website/gallery": "gallery",
    "website/homepage": "pages",
    "website/about": "pages",
    "website/programs": "pages",
    "website/teachers": "pages",
    "website/admissions": "pages",
    "website/news": "pages",
    "website/contact": "contact",
    "settings/institution": "settings",
  };

  let ctx = null;          // dashboard helpers, injected by render()
  const cache = { data: null };

  function handles(route) {
    return Boolean(ROUTE_TO_KEY[route] || ALIASES[route]);
  }
  function sectionFor(route) {
    return ROUTE_TO_KEY[route] || ALIASES[route] || "profile";
  }

  /* ----------------------------------------------------------------------
     Small shared helpers (thin wrappers over the dashboard's own)
     ---------------------------------------------------------------------- */
  const esc = (v) => ctx.esc(v);
  const icon = (name) => ctx.I[name] || "";
  const toast = (message, kind) => ctx.toast(message, kind);
  const api = () => window.API;

  function val(v, fallback) {
    return v === null || v === undefined || v === "" ? (fallback === undefined ? "" : fallback) : v;
  }
  function isOn(v) { return Number(v) === 1 || v === true || v === "1"; }

  /** The institution noun this tenant uses ("institution" | "academy"). */
  function noun() { return ctx.T().institutionNoun; }
  function label() { return ctx.T().institutionLabel; }

  /* ---------------------------------- states ---------------------------- */
  function loadingState(title) {
    return `<div class="dash-mi-loading" role="status" aria-live="polite">
        <div class="dash-mi-skeleton-head"></div>
        <div class="dash-mi-skeleton-grid">${Array.from({ length: 6 }).map(() => `<div class="dash-mi-skeleton-row"></div>`).join("")}</div>
        <span class="dash-mi-loading-text">${esc(title || "Loading…")}</span>
      </div>`;
  }
  function errorState(message, retryId) {
    return `<div class="dash-card"><div class="dash-coming-soon">
        <div class="icon">${icon("close")}</div>
        <h3>We could not load this page</h3>
        <p>${esc(message || "Please check your connection and try again.")}</p>
        <button class="dash-btn dash-btn-primary" id="${esc(retryId || "miRetry")}" style="margin-top:16px;">${icon("refresh")} Try again</button>
      </div></div>`;
  }
  function emptyState(iconName, title, copy, actionHtml) {
    return `<div class="dash-coming-soon">
        <div class="icon">${icon(iconName)}</div>
        <h3>${esc(title)}</h3>
        <p>${esc(copy)}</p>
        ${actionHtml ? `<div class="dash-actions" style="justify-content:center;margin-top:16px;">${actionHtml}</div>` : ""}
      </div>`;
  }

  /* ---------------------------------- chrome ---------------------------- */
  function sectionNav(active) {
    return `<nav class="dash-mi-nav" aria-label="My ${esc(label())} sections">
      ${SECTIONS.map((s) => `
        <button type="button" class="dash-mi-nav-btn${s.key === active ? " is-active" : ""}"
                data-mi-nav="${esc(s.route)}"${s.key === active ? ' aria-current="page"' : ""}>
          ${icon(s.icon)}<span>${esc(s.label)}</span>
        </button>`).join("")}
    </nav>`;
  }

  function pageHead(title, description, actionsHtml) {
    return `<div class="dash-page-head">
      <div>
        <div class="dash-crumb">My ${esc(label())}</div>
        <h2>${esc(title)}</h2>
        <p>${esc(description)}</p>
      </div>
      ${actionsHtml ? `<div class="dash-actions">${actionsHtml}</div>` : ""}
    </div>`;
  }

  /** Tabs inside one screen (Information, Settings). Purely client-side. */
  function tabBar(tabs, activeId) {
    return `<div class="dash-mi-tabs" role="tablist">
      ${tabs.map((t) => `<button type="button" role="tab" class="dash-mi-tab${t.id === activeId ? " is-active" : ""}"
        aria-selected="${t.id === activeId}" data-mi-tab="${esc(t.id)}">${esc(t.label)}</button>`).join("")}
    </div>`;
  }
  function bindTabs(scope) {
    scope.querySelectorAll("[data-mi-tab]").forEach((btn) => btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-mi-tab");
      scope.querySelectorAll("[data-mi-tab]").forEach((b) => {
        const on = b.getAttribute("data-mi-tab") === id;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", String(on));
      });
      scope.querySelectorAll("[data-mi-panel]").forEach((panel) => {
        panel.hidden = panel.getAttribute("data-mi-panel") !== id;
      });
    }));
  }

  /* ---------------------------------- fields ---------------------------- */
  function fieldWrap(inner, opts = {}) {
    const style = opts.full ? ' style="grid-column:1/-1"' : "";
    return `<div class="dash-field"${style}>${inner}</div>`;
  }
  function textField(name, labelText, value, opts = {}) {
    const attrs = [
      `name="${esc(name)}"`,
      `id="mi-${esc(name)}"`,
      opts.type ? `type="${esc(opts.type)}"` : "",
      opts.required ? "required" : "",
      opts.maxlength ? `maxlength="${opts.maxlength}"` : "",
      opts.pattern ? `pattern="${esc(opts.pattern)}"` : "",
      opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : "",
      opts.dir ? `dir="${esc(opts.dir)}"` : "",
      opts.min !== undefined ? `min="${esc(opts.min)}"` : "",
      opts.max !== undefined ? `max="${esc(opts.max)}"` : "",
      opts.autocomplete ? `autocomplete="${esc(opts.autocomplete)}"` : "",
      opts.disabled ? "disabled" : "",
    ].filter(Boolean).join(" ");
    return fieldWrap(
      `<label for="mi-${esc(name)}">${esc(labelText)}${opts.required ? ' <span class="req">*</span>' : ""}</label>
       <input ${attrs} value="${esc(value)}">
       ${opts.hint ? `<span class="dash-field-hint">${esc(opts.hint)}</span>` : ""}
       <span class="dash-mi-error" data-error-for="${esc(name)}" hidden></span>`,
      opts
    );
  }
  function textAreaField(name, labelText, value, opts = {}) {
    return fieldWrap(
      `<label for="mi-${esc(name)}">${esc(labelText)}</label>
       <textarea id="mi-${esc(name)}" name="${esc(name)}" rows="${opts.rows || 4}"
         ${opts.maxlength ? `maxlength="${opts.maxlength}"` : ""}
         ${opts.dir ? `dir="${esc(opts.dir)}"` : ""}
         placeholder="${esc(opts.placeholder || "")}">${esc(value)}</textarea>
       ${opts.hint ? `<span class="dash-field-hint">${esc(opts.hint)}</span>` : ""}
       <span class="dash-mi-error" data-error-for="${esc(name)}" hidden></span>`,
      Object.assign({ full: true }, opts)
    );
  }
  function selectField(name, labelText, value, choices, opts = {}) {
    const options = choices.map((c) => {
      const v = typeof c === "string" ? c : c.value;
      const l = typeof c === "string" ? c : c.label;
      return `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`;
    }).join("");
    return fieldWrap(
      `<label for="mi-${esc(name)}">${esc(labelText)}</label>
       <select id="mi-${esc(name)}" name="${esc(name)}" ${opts.required ? "required" : ""}>
         ${opts.placeholder ? `<option value="">${esc(opts.placeholder)}</option>` : ""}${options}
       </select>
       ${opts.hint ? `<span class="dash-field-hint">${esc(opts.hint)}</span>` : ""}`,
      opts
    );
  }
  function colorField(name, labelText, value, hint) {
    return fieldWrap(
      `<label for="mi-${esc(name)}">${esc(labelText)}</label>
       <div class="dash-mi-color">
         <input id="mi-${esc(name)}" name="${esc(name)}" type="color" value="${esc(value)}" data-mi-color>
         <input class="dash-mi-color-text" type="text" value="${esc(value)}" data-mi-color-text="${esc(name)}"
                maxlength="9" spellcheck="false" aria-label="${esc(labelText)} hex value">
       </div>
       ${hint ? `<span class="dash-field-hint">${esc(hint)}</span>` : ""}`
    );
  }
  function toggleRow(name, labelText, checked, hint) {
    return `<label class="dash-toggle">
      <input type="checkbox" name="${esc(name)}" ${checked ? "checked" : ""}>
      <span>${esc(labelText)}${hint ? `<small class="dash-mi-toggle-hint">${esc(hint)}</small>` : ""}</span>
    </label>`;
  }

  /* --------------------------- form plumbing ---------------------------- */
  /** Reads a form into a plain object, checkboxes as booleans. */
  function readForm(form) {
    const body = {};
    form.querySelectorAll("input, select, textarea").forEach((el) => {
      if (!el.name || el.disabled) return;
      if (el.type === "checkbox") {
        if (el.dataset.multi) {
          body[el.name] = body[el.name] || [];
          if (el.checked) body[el.name].push(el.value);
        } else {
          body[el.name] = el.checked;
        }
      } else if (el.type === "radio") {
        if (el.checked) body[el.name] = el.value;
      } else {
        body[el.name] = el.value;
      }
    });
    return body;
  }

  function showFieldError(form, name, message) {
    const slot = form.querySelector(`[data-error-for="${CSS && CSS.escape ? CSS.escape(name) : name}"]`);
    if (slot) { slot.textContent = message; slot.hidden = !message; }
  }
  function clearErrors(form) {
    form.querySelectorAll(".dash-mi-error").forEach((s) => { s.textContent = ""; s.hidden = true; });
    form.querySelectorAll(".is-invalid").forEach((f) => f.classList.remove("is-invalid"));
  }

  /**
   * Validation shared by every form in this section: native constraints plus
   * the project's own rules (hours, hex colours, 4-digit years, real links).
   */
  function validate(form) {
    clearErrors(form);
    let firstBad = null;
    form.querySelectorAll("input, select, textarea").forEach((el) => {
      if (!el.name || el.disabled || el.type === "checkbox" || el.type === "radio") return;
      const value = String(el.value || "").trim();
      let message = "";
      if (el.required && !value) message = "This field is required.";
      else if (value && el.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) message = "Enter a valid email address.";
      else if (value && el.type === "url" && !/^https?:\/\/.+/i.test(value)) message = "Enter a full link starting with http:// or https://";
      else if (value && el.type === "time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) message = "Use 24-hour time, for example 08:00.";
      else if (value && el.dataset.year && !/^\d{4}$/.test(value)) message = "Enter a 4-digit year, for example 1998.";
      else if (value && el.dataset.hex && !/^#[0-9a-fA-F]{3,8}$/.test(value)) message = "Enter a hex colour like #220b40.";
      else if (value && el.pattern && !new RegExp(`^(?:${el.pattern})$`).test(value)) message = el.dataset.patternMessage || "Please match the requested format.";
      else if (el.maxLength > 0 && value.length > el.maxLength) message = `Keep this under ${el.maxLength} characters.`;
      if (message) {
        el.classList.add("is-invalid");
        showFieldError(form, el.name, message);
        if (!firstBad) firstBad = el;
      }
    });
    if (firstBad && typeof firstBad.focus === "function") {
      try { firstBad.focus(); } catch (e) { /* non-fatal */ }
    }
    return !firstBad;
  }

  /** Wires colour pickers to their hex text twin (both directions). */
  function bindColorInputs(scope, onChange) {
    scope.querySelectorAll("[data-mi-color]").forEach((picker) => {
      const twin = scope.querySelector(`[data-mi-color-text="${picker.name}"]`);
      picker.addEventListener("input", () => {
        if (twin) twin.value = picker.value;
        if (onChange) onChange();
      });
      if (twin) {
        twin.dataset.hex = "1";
        twin.addEventListener("input", () => {
          if (/^#[0-9a-fA-F]{6}$/.test(twin.value.trim())) {
            picker.value = twin.value.trim();
            if (onChange) onChange();
          }
        });
      }
    });
  }

  /** Confirmation dialog in the dashboard's own modal, for destructive acts. */
  function confirmAction(options) {
    return new Promise((resolve) => {
      const modal = ctx.openModal(options.title || "Please confirm", `
        <p class="dash-mi-confirm-copy">${esc(options.message || "")}</p>
        ${options.detail ? `<p class="dash-info-line">${esc(options.detail)}</p>` : ""}
        <div class="dash-actions" style="margin-top:18px;justify-content:flex-end;">
          <button type="button" class="dash-btn dash-btn-ghost" data-mi-cancel>Cancel</button>
          <button type="button" class="dash-btn ${options.danger === false ? "dash-btn-primary" : "dash-btn-danger"}" data-mi-confirm>
            ${esc(options.confirmLabel || "Delete")}
          </button>
        </div>`);
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; ctx.closeModal(); resolve(value); };
      modal.querySelector("[data-mi-cancel]").addEventListener("click", () => finish(false));
      modal.querySelector("[data-mi-confirm]").addEventListener("click", () => finish(true));
      modal.addEventListener("click", (e) => { if (e.target === modal) finish(false); });
      const close = modal.querySelector(".dash-modal-close");
      if (close) close.addEventListener("click", () => finish(false));
    });
  }

  /** Disables a submit button while its request is in flight. */
  async function withBusy(button, task) {
    const original = button ? button.innerHTML : "";
    if (button) { button.disabled = true; button.innerHTML = `${icon("clock")} Saving…`; }
    try { return await task(); }
    finally { if (button) { button.disabled = false; button.innerHTML = original; } }
  }

  /* ----------------------------------------------------------------------
     Data access
     ---------------------------------------------------------------------- */
  async function load(force) {
    if (!force && cache.data) return cache.data;
    const data = await api().get("/madrasa/institution");
    cache.data = data;
    // Keep the shell (sidebar title, header) in step with a renamed institution.
    if (ctx.state.profile && data.madrasa) ctx.state.profile.madrasa = data.madrasa;
    return data;
  }
  function invalidate() { cache.data = null; }

  async function saveSection(section, body, button) {
    return withBusy(button, async () => {
      const payload = Object.assign({ section }, body);
      const result = await api().put("/madrasa/institution", payload);
      cache.data = result;
      if (ctx.state.profile && result.madrasa) ctx.state.profile.madrasa = result.madrasa;
      return result;
    });
  }

  /* ======================================================================
     1 — INSTITUTION PROFILE
     ====================================================================== */
  async function renderProfile(content) {
    const data = await load();
    const m = data.madrasa || {};
    const o = data.options || {};
    const types = (m.category === "western" ? o.westernTypes : o.islamicTypes) || [];

    content.innerHTML = `
      ${pageHead(`${label()} Profile`, `The identity of your ${noun()} — used across the admin workspace, report cards and your public website.`,
        `<button class="dash-btn dash-btn-ghost" id="miPreviewProfile">${icon("external")} Preview profile</button>
         <a class="dash-btn dash-btn-ghost" href="/schools/${esc(m.slug)}" target="_blank" rel="noopener">${icon("globe")} View website</a>`)}
      ${sectionNav("profile")}
      <form id="miProfileForm" novalidate>
        <div class="dash-mi-stack">

          <section class="dash-card">
            <div class="dash-card-head"><h3>Identity</h3><span class="hint">Shown everywhere your ${esc(noun())} is named</span></div>
            <div class="dash-card-pad">
              <div class="dash-form-grid">
                ${textField("name_en", "Institution name (English)", val(m.name_en), { required: true, maxlength: 160 })}
                ${textField("name_ar", "Institution name (Arabic)", val(m.name_ar), { dir: "rtl", maxlength: 160 })}
                ${textField("motto_en", "Motto (English)", val(m.motto_en), { maxlength: 160, placeholder: "Knowledge, character, service" })}
                ${textField("motto_ar", "Motto (Arabic)", val(m.motto_ar), { dir: "rtl", maxlength: 160 })}
                ${textField("tagline", "Tagline", val(m.tagline), { maxlength: 200, hint: "One short line used on the website hero." })}
                ${selectField("institution_type", "Institution type", val(m.institution_type), types, { placeholder: "Select a type" })}
                ${selectField("ownership_type", "Ownership type", val(m.ownership_type), o.ownershipTypes || [], { placeholder: "Select ownership" })}
                ${textField("founded_year", "Founded / established year", val(m.founded_year), { maxlength: 4, placeholder: "1998", pattern: "\\d{4}" })}
                ${textAreaField("short_description", "Short description", val(m.short_description), { rows: 2, maxlength: 400, hint: "Up to 400 characters — used for search results and directory cards." })}
              </div>
            </div>
          </section>

          <section class="dash-card">
            <div class="dash-card-head"><h3>Story &amp; philosophy</h3><span class="hint">What families read on your About page</span></div>
            <div class="dash-card-pad">
              <div class="dash-form-grid">
                ${textAreaField("description_en", "Full description", val(m.description_en), { rows: 5, maxlength: 4000 })}
                ${textAreaField("history", "History", val(m.history), { rows: 5, maxlength: 6000, placeholder: `How your ${noun()} began and how it has grown…` })}
                ${textAreaField("mission", "Mission", val(m.mission), { rows: 3, maxlength: 3000 })}
                ${textAreaField("vision", "Vision", val(m.vision), { rows: 3, maxlength: 3000 })}
                ${textAreaField("core_values", "Core values", val(m.core_values), { rows: 3, maxlength: 3000, hint: "One value per line works well." })}
                ${textAreaField("philosophy", "Educational philosophy", val(m.philosophy), { rows: 3, maxlength: 3000 })}
              </div>
            </div>
          </section>

          <section class="dash-card">
            <div class="dash-card-head"><h3>Leadership &amp; accreditation</h3></div>
            <div class="dash-card-pad">
              <div class="dash-form-grid">
                ${textField("head_name", "Principal / Head / Director", val(m.head_name || m.admin_full_name), { maxlength: 160 })}
                ${textField("head_title", "Title", val(m.head_title || m.admin_position), { maxlength: 80, placeholder: "Principal" })}
                ${textField("registration_no", "Registration number", val(m.registration_no), { maxlength: 80 })}
                ${textField("accreditation_body", "Accreditation body", val(m.accreditation_body), { maxlength: 160, placeholder: "Ogun State Ministry of Education" })}
                ${textAreaField("accreditation_details", "Accreditation details", val(m.accreditation_details), { rows: 3, maxlength: 2000 })}
              </div>
            </div>
          </section>

          <section class="dash-card">
            <div class="dash-card-head"><h3>Logo, emblem &amp; cover image</h3><span class="hint">JPG, PNG or WEBP</span></div>
            <div class="dash-card-pad">
              <div class="dash-mi-media-grid">
                ${imageSlot("logo", "Institution logo", m.logo_path, "Square works best — 512×512 or larger.")}
                ${imageSlot("badge", "Badge / emblem", m.badge_path, "Optional crest shown on documents and the website footer.")}
                ${imageSlot("hero", "Cover / banner image", m.hero_image_path, "Wide image — 1600×900 or larger.", true)}
              </div>
            </div>
          </section>

        </div>
        <div class="dash-mi-actionbar">
          <button class="dash-btn dash-btn-primary" type="submit" id="miProfileSave">${icon("check")} Save changes</button>
          <button class="dash-btn dash-btn-ghost" type="button" id="miProfileReset">${icon("refresh")} Cancel changes</button>
        </div>
      </form>`;

    const form = content.querySelector("#miProfileForm");
    form.querySelector('[name="founded_year"]').dataset.year = "1";
    bindImageSlots(content, () => renderProfile(content));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validate(form)) { toast("Please correct the highlighted fields.", "error"); return; }
      try {
        await saveSection("profile", readForm(form), content.querySelector("#miProfileSave"));
        toast(`${label()} profile saved.`, "success");
        await renderProfile(content);
      } catch (err) { toast(err.message || "Could not save the profile.", "error"); }
    });
    content.querySelector("#miProfileReset").addEventListener("click", async () => {
      const yes = await confirmAction({
        title: "Discard changes?",
        message: "Any edits you have not saved will be lost.",
        confirmLabel: "Discard changes",
      });
      if (yes) { invalidate(); await renderProfile(content); toast("Changes discarded.", ""); }
    });
    content.querySelector("#miPreviewProfile").addEventListener("click", () => openProfilePreview(form, data));
  }

  function imageSlot(kind, labelText, path, hint, wide) {
    return `<div class="dash-mi-media${wide ? " is-wide" : ""}" data-image-slot="${esc(kind)}">
      <div class="dash-mi-media-preview${wide ? " is-wide" : ""}">
        ${path ? `<img src="${esc(path)}" alt="${esc(labelText)} preview" data-image-preview>` : `<span class="dash-mi-media-empty" data-image-preview-empty>${icon("image")}</span>`}
      </div>
      <div class="dash-mi-media-body">
        <strong>${esc(labelText)}</strong>
        <small>${esc(hint || "")}</small>
        <div class="dash-actions">
          <label class="dash-btn dash-btn-ghost dash-btn-sm dash-mi-file">
            ${icon("plus")} ${path ? "Change" : "Upload"}
            <input type="file" accept="image/png,image/jpeg,image/webp" data-image-input="${esc(kind)}" hidden>
          </label>
          ${path ? `<button type="button" class="dash-btn dash-btn-danger dash-btn-sm" data-image-remove="${esc(kind)}">${icon("trash")} Remove</button>` : ""}
        </div>
      </div>
    </div>`;
  }

  function bindImageSlots(scope, refresh) {
    scope.querySelectorAll("[data-image-input]").forEach((input) => {
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const kind = input.getAttribute("data-image-input");
        if (file.size > 5 * 1024 * 1024) { toast("Images must be 5 MB or smaller.", "error"); input.value = ""; return; }
        // Instant local preview so the administrator sees the new image
        // before the upload round-trip completes.
        const slot = input.closest("[data-image-slot]");
        const box = slot && slot.querySelector(".dash-mi-media-preview");
        let objectUrl = null;
        if (box) {
          objectUrl = URL.createObjectURL(file);
          box.innerHTML = `<img src="${objectUrl}" alt="New image preview">`;
        }
        const fd = new FormData();
        fd.append("image", file);
        try {
          await api().post(`/madrasa/institution/image/${encodeURIComponent(kind)}`, fd);
          invalidate();
          toast("Image updated.", "success");
          if (refresh) await refresh();
        } catch (err) {
          toast(err.message || "Upload failed.", "error");
          if (refresh) await refresh();
        } finally {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
      });
    });
    scope.querySelectorAll("[data-image-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const kind = btn.getAttribute("data-image-remove");
        const yes = await confirmAction({
          title: "Remove image?",
          message: "This image will no longer appear in the admin workspace or on your public website.",
          confirmLabel: "Remove image",
        });
        if (!yes) return;
        try {
          await api().del(`/madrasa/institution/image/${encodeURIComponent(kind)}`);
          invalidate();
          toast("Image removed.", "success");
          if (refresh) await refresh();
        } catch (err) { toast(err.message || "Could not remove the image.", "error"); }
      });
    });
  }

  /** Preview of the saved-plus-typed profile, exactly as a visitor reads it. */
  function openProfilePreview(form, data) {
    const m = Object.assign({}, data.madrasa, readForm(form));
    const appearance = data.appearance || {};
    const brand = /^#[0-9a-fA-F]{3,8}$/.test(appearance.brand_color || "") ? appearance.brand_color : "#200A3D";
    const block = (title, body) => body ? `<div class="dash-mi-preview-block"><h4>${esc(title)}</h4><p>${esc(body)}</p></div>` : "";
    ctx.openModal(`${m.name_en || "Institution"} — profile preview`, `
      <div class="dash-mi-preview" style="--mi-brand:${esc(brand)}">
        <div class="dash-mi-preview-hero">
          ${m.hero_image_path ? `<img class="dash-mi-preview-cover" src="${esc(m.hero_image_path)}" alt="">` : ""}
          <div class="dash-mi-preview-hero-body">
            ${m.logo_path ? `<img class="dash-mi-preview-logo" src="${esc(m.logo_path)}" alt="">` : ""}
            <strong>${esc(m.name_en || "Your institution")}</strong>
            ${m.motto_en ? `<em>${esc(m.motto_en)}</em>` : ""}
            ${m.tagline ? `<span>${esc(m.tagline)}</span>` : ""}
          </div>
        </div>
        <div class="dash-mi-preview-meta">
          ${m.institution_type ? `<span class="dash-pill info">${esc(m.institution_type)}</span>` : ""}
          ${m.ownership_type ? `<span class="dash-pill muted">${esc(m.ownership_type)}</span>` : ""}
          ${m.founded_year ? `<span class="dash-pill muted">Established ${esc(m.founded_year)}</span>` : ""}
        </div>
        ${block("About", m.short_description || m.description_en)}
        ${block("History", m.history)}
        ${block("Mission", m.mission)}
        ${block("Vision", m.vision)}
        ${block("Core values", m.core_values)}
        ${block("Educational philosophy", m.philosophy)}
        ${m.head_name ? `<div class="dash-mi-preview-block"><h4>Leadership</h4><p>${esc(m.head_name)}${m.head_title ? ` — ${esc(m.head_title)}` : ""}</p></div>` : ""}
        ${m.accreditation_body || m.registration_no ? `<div class="dash-mi-preview-block"><h4>Registration &amp; accreditation</h4><p>${esc([m.accreditation_body, m.registration_no].filter(Boolean).join(" · "))}</p></div>` : ""}
      </div>
      <p class="dash-field-hint" style="margin-top:14px;">This preview includes unsaved edits. Save the form to publish them.</p>`);
  }

  /* ======================================================================
     2 — INSTITUTION INFORMATION
     ====================================================================== */
  async function renderInformation(content) {
    const data = await load();
    const m = data.madrasa || {};
    const o = data.options || {};
    const days = String(m.school_days || "").split(",").map((d) => d.trim()).filter(Boolean);

    content.innerHTML = `
      ${pageHead(`${label()} Information`, `Contact, location, academic and operational facts about your ${noun()}.`,
        `<button class="dash-btn dash-btn-ghost" data-mi-nav="institution/settings">${icon("settings")} Academic settings</button>`)}
      ${sectionNav("information")}
      <div class="dash-mi-summary">
        ${summaryTile("calendar", "Current session", val(data.currentSession, "Not set"), "academic/sessions")}
        ${summaryTile("clock", "Current term", val(data.currentTerm, "Not set"), "academic/terms")}
        ${summaryTile("classes", "Classes / levels", String(data.stats ? data.stats.classes : 0), "classes/all")}
        ${summaryTile("admissions", "Admissions", isOpenAdmissions(m) ? "Open" : "Closed", "admissions/settings")}
      </div>
      ${tabBar([
        { id: "contactTab", label: "Location & contact" },
        { id: "hoursTab", label: "Hours & calendar" },
        { id: "academicTab", label: "Academic offering" },
        { id: "complianceTab", label: "Capacity & registration" },
      ], "contactTab")}
      <form id="miInfoForm" novalidate>
        <div class="dash-card" data-mi-panel="contactTab">
          <div class="dash-card-pad">
            <div class="dash-form-grid">
              ${textField("name_en", "Institution name", val(m.name_en), { required: true, maxlength: 160 })}
              ${textField("phone", "Phone number", val(m.phone), { maxlength: 60, autocomplete: "tel" })}
              ${textField("alt_phone", "Alternative phone", val(m.alt_phone), { maxlength: 60 })}
              ${textField("email", "Official email", val(m.email), { type: "email", maxlength: 120 })}
              ${textField("admissions_email", "Admissions email", val(m.admissions_email), { type: "email", maxlength: 120 })}
              ${textField("website", "Website URL", val(m.website), { type: "url", maxlength: 160, placeholder: "https://…" })}
              ${textField("address", "Street address", val(m.address), { maxlength: 255, full: true })}
              ${textField("city", "City / town", val(m.city), { maxlength: 80 })}
              ${textField("state_name", "State", val(m.state_name), { maxlength: 80 })}
              ${textField("country", "Country", val(m.country, "Nigeria"), { maxlength: 80 })}
            </div>
          </div>
        </div>

        <div class="dash-card" data-mi-panel="hoursTab" hidden>
          <div class="dash-card-pad">
            <div class="dash-form-grid">
              ${textField("opening_time", "Opening time", val(m.opening_time), { type: "time" })}
              ${textField("closing_time", "Closing time", val(m.closing_time), { type: "time" })}
            </div>
            <div class="dash-field" style="margin-top:16px;">
              <label>School days</label>
              <div class="dash-check-grid">
                ${(o.schoolDays || []).map((d) => `<label><input type="checkbox" name="school_days" value="${esc(d)}" data-multi="1" ${days.includes(d) ? "checked" : ""}> ${esc(d)}</label>`).join("")}
              </div>
              <span class="dash-field-hint">Shown on your public contact page and used for attendance guidance.</span>
            </div>
            <p class="dash-info-line" style="margin-top:16px;">
              Academic sessions and terms are managed in Academic → Academic Sessions, so they are never defined twice.
            </p>
          </div>
        </div>

        <div class="dash-card" data-mi-panel="academicTab" hidden>
          <div class="dash-card-pad">
            <div class="dash-form-grid">
              ${textField("levels_offered", "Classes / levels offered", val(m.levels_offered), { maxlength: 400, full: true, hint: data.classNames && data.classNames.length ? `Live classes: ${data.classNames.slice(0, 8).join(", ")}` : "Add classes under Classes → All Classes to list them publicly." })}
              ${textField("languages_of_instruction", "Languages of instruction", val(m.languages_of_instruction), { maxlength: 200, placeholder: "English, Arabic, Yorùbá" })}
              ${selectField("boarding_status", "Boarding / day school", val(m.boarding_status), o.boardingStatuses || [], { placeholder: "Select" })}
              ${textAreaField("islamic_education_info", "Islamic education", val(m.islamic_education_info), { rows: 4, maxlength: 3000, placeholder: "Qur'an, Tajweed, Hadith, Fiqh, Arabic language…" })}
              ${textAreaField("western_education_info", "Western / general education", val(m.western_education_info), { rows: 4, maxlength: 3000, placeholder: "Mathematics, English, Sciences, Computer Studies…" })}
            </div>
          </div>
        </div>

        <div class="dash-card" data-mi-panel="complianceTab" hidden>
          <div class="dash-card-pad">
            <div class="dash-form-grid">
              ${textField("student_capacity", "Student capacity", m.student_capacity === null || m.student_capacity === undefined ? "" : m.student_capacity, { type: "number", min: 0, max: 1000000 })}
              ${selectField("admission_status", "Admission status", val(m.admission_status, "open"), [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }])}
              ${textField("registration_no", "Registration number", val(m.registration_no), { maxlength: 80 })}
              ${textField("accreditation_body", "Accreditation body", val(m.accreditation_body), { maxlength: 160 })}
              ${textAreaField("accreditation_details", "Accreditation details", val(m.accreditation_details), { rows: 3, maxlength: 2000 })}
            </div>
          </div>
        </div>

        <div class="dash-mi-actionbar">
          <button class="dash-btn dash-btn-primary" type="submit" id="miInfoSave">${icon("check")} Save information</button>
          <button class="dash-btn dash-btn-ghost" type="button" id="miInfoReset">${icon("refresh")} Cancel changes</button>
        </div>
      </form>`;

    bindTabs(content);
    const form = content.querySelector("#miInfoForm");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validate(form)) { toast("Please correct the highlighted fields.", "error"); return; }
      const body = readForm(form);
      body.school_days = Array.isArray(body.school_days) ? body.school_days : [];
      try {
        await saveSection("information", body, content.querySelector("#miInfoSave"));
        toast(`${label()} information saved.`, "success");
        await renderInformation(content);
      } catch (err) { toast(err.message || "Could not save the information.", "error"); }
    });
    content.querySelector("#miInfoReset").addEventListener("click", async () => {
      const yes = await confirmAction({ title: "Discard changes?", message: "Any edits you have not saved will be lost.", confirmLabel: "Discard changes" });
      if (yes) { invalidate(); await renderInformation(content); toast("Changes discarded.", ""); }
    });
  }

  function isOpenAdmissions(m) {
    return String(m.admission_status || "open").toLowerCase() !== "closed";
  }
  function summaryTile(iconName, labelText, value, route) {
    return `<button type="button" class="dash-mi-tile" ${route ? `data-mi-route="${esc(route)}"` : ""}>
      <span class="dash-mi-tile-icon">${icon(iconName)}</span>
      <span class="dash-mi-tile-body"><small>${esc(labelText)}</small><strong>${esc(value)}</strong></span>
    </button>`;
  }

  /* ======================================================================
     3 — PUBLIC WEBSITE
     ====================================================================== */
  async function renderWebsite(content) {
    content.innerHTML = loadingState("Loading your public website…");
    const data = await api().get("/madrasa/institution/website");
    cache.data = Object.assign({}, cache.data || {}, { madrasa: data.madrasa, appearance: data.appearance, options: data.options });
    const m = data.madrasa || {};
    const pages = data.pages || [];
    const counts = data.counts || {};
    const published = Number(m.website_published) !== 0;
    const listed = isOn(m.public_listing);
    const websitePath = (data.urls && data.urls.site) || `/schools/${m.slug}`;
    const websiteHref = (data.urls && data.urls.website) || `${window.location.origin}${websitePath}`;

    const quickLinks = [
      ["home", "Homepage", "book"],
      ["about-us", "About Institution", "building"],
      ["programs", "Programs/Courses", "academic"],
      ["teachers", "Teachers", "teacher"],
      ["admissions", "Admissions", "admissions"],
      ["gallery", "Gallery", "image"],
      ["news", "News & Announcements", "bell"],
      ["contact-us", "Contact Page", "mail"],
    ];

    content.innerHTML = `
      ${pageHead("Public Website", `Everything visitors see about your ${noun()}, and the switches that control it.`,
        `<a class="dash-btn dash-btn-ghost" href="${esc(websitePath)}" target="_blank" rel="noopener">${icon("external")} Open Website</a>
         <button class="dash-btn dash-btn-ghost" id="miCopyWebsite" type="button">${icon("copy")} Copy URL</button>
         <button class="dash-btn dash-btn-ghost" id="miPreviewSite">${icon("image")} Preview Website</button>`)}
      ${sectionNav("website")}

      <div class="dash-website-card" style="margin-bottom:20px;">
        <div class="dash-website-info">
          <div class="label">Live address</div>
          <div class="url" id="miWebsiteUrl">${esc(websiteHref)}</div>
          <div class="desc">This address always opens only ${esc(m.name_en || "this institution")}.</div>
        </div>
        <div class="dash-website-actions">
          <span class="dash-pill ${published && listed ? "ok" : "warn"}" id="miWebsiteStatus">
            ${published && listed ? icon("check") + " Published" : icon("clock") + (published ? " Published, not listed" : " Unpublished")}
          </span>
          <button class="dash-btn ${published ? "dash-btn-ghost" : "dash-btn-accent"}" id="miTogglePublish"
                  style="${published ? "color:#fff;background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.35);" : ""}">
            ${published ? icon("clock") + " Unpublish website" : icon("check") + " Publish website"}
          </button>
        </div>
      </div>

      <div class="dash-stats-grid">
        ${ctx.statCard("book", `${pages.filter((p) => Number(p.is_published) === 1).length}/${pages.length}`, "Published pages")}
        ${ctx.statCard("admissions", counts.pendingApplications || 0, "Pending applications")}
        ${ctx.statCard("bell", counts.publicNotices || 0, "Public notices")}
        ${ctx.statCard("image", counts.publishedMedia || 0, "Published media")}
      </div>

      <div class="dash-grid-2" style="margin-top:18px;">
        <section class="dash-card">
          <div class="dash-card-head"><h3>Website sections</h3><span class="hint">Jump straight to what you want to change</span></div>
          <div class="dash-card-pad">
            <div class="dash-quick-grid">
              ${quickLinks.map(([slug, title, ic]) => {
                const page = pages.find((p) => p.slug === slug);
                const state = page ? (Number(page.is_published) === 1 ? "ok" : "muted") : "muted";
                return `<button type="button" class="dash-quick-btn" data-mi-page="${esc(slug)}">
                  <span class="dash-quick-icon">${icon(ic)}</span>
                  <span>${esc(title)}</span>
                  <span class="dash-pill ${state}">${page ? (Number(page.is_published) === 1 ? "Live" : "Draft") : "Not set up"}</span>
                </button>`;
              }).join("")}
            </div>
          </div>
        </section>

        <div class="dash-mi-stack">
          <section class="dash-card">
            <div class="dash-card-head"><h3>Website navigation</h3><span class="hint">Menu order</span></div>
            <div class="dash-card-pad">
              ${pages.filter((p) => Number(p.in_navigation) === 1 && Number(p.is_published) === 1).length
                ? `<ol class="dash-mi-navlist">${pages.filter((p) => Number(p.in_navigation) === 1 && Number(p.is_published) === 1)
                    .map((p) => `<li><span>${esc(p.title)}</span><small>/${esc(p.slug)}</small></li>`).join("")}</ol>`
                : `<p class="dash-field-hint">No pages are in the menu yet. Open Website Pages to add some.</p>`}
              <button class="dash-btn dash-btn-ghost dash-btn-sm" data-mi-nav="institution/pages" style="margin-top:12px;">${icon("edit")} Manage pages &amp; menu</button>
            </div>
          </section>

          <section class="dash-card">
            <div class="dash-card-head"><h3>Featured content</h3></div>
            <div class="dash-card-pad">
              <p class="dash-field-hint" style="margin-top:0;">Featured albums and media appear first in the public gallery.</p>
              <div class="dash-actions" style="margin-top:10px;">
                <button class="dash-btn dash-btn-ghost dash-btn-sm" data-mi-nav="institution/gallery">${icon("image")} Gallery</button>
                <button class="dash-btn dash-btn-ghost dash-btn-sm" data-mi-route="communication/announcements">${icon("bell")} Announcements</button>
              </div>
            </div>
          </section>
        </div>
      </div>

      <form id="miWebsiteForm" novalidate class="dash-mi-stack" style="margin-top:18px;">
        <section class="dash-card">
          <div class="dash-card-head"><h3>Visibility</h3></div>
          <div class="dash-card-pad">
            ${toggleRow("website_published", "Publish the public website", published, "When off, visitors see an \u201cunpublished\u201d notice instead of your pages.")}
            ${toggleRow("public_listing", "List this institution in the EduSphere directory", listed)}
            ${toggleRow("public_admissions", "Accept online admission applications", isOn(m.public_admissions))}
            ${toggleRow("public_results", "Allow families to check published results online", isOn(m.public_results))}
          </div>
        </section>

        <section class="dash-card">
          <div class="dash-card-head"><h3>SEO settings</h3><span class="hint">How search engines describe you</span></div>
          <div class="dash-card-pad">
            <div class="dash-form-grid">
              ${textField("seo_title", "SEO title", val(m.seo_title), { maxlength: 160, placeholder: val(m.name_en) })}
              ${textField("seo_keywords", "Keywords", val(m.seo_keywords), { maxlength: 255, placeholder: "islamic school, ijebu-ode, tahfiz" })}
              ${textField("custom_domain", "Custom domain (optional)", val(m.custom_domain), { maxlength: 255, placeholder: "www.example.com", hint: "After DNS is configured, visitors can use this domain. The /schools/slug link always remains available." })}
              ${textAreaField("seo_description", "SEO description", val(m.seo_description), { rows: 3, maxlength: 320, hint: "Around 150–160 characters reads best in search results." })}
            </div>
          </div>
        </section>

        <section class="dash-card">
          <div class="dash-card-head"><h3>Social media links</h3></div>
          <div class="dash-card-pad">
            <div class="dash-form-grid">
              ${textField("facebook", "Facebook", val(m.facebook), { type: "url", maxlength: 200, placeholder: "https://facebook.com/…" })}
              ${textField("instagram", "Instagram", val(m.instagram), { type: "url", maxlength: 200 })}
              ${textField("twitter", "X / Twitter", val(m.twitter), { type: "url", maxlength: 200 })}
              ${textField("youtube", "YouTube", val(m.youtube), { type: "url", maxlength: 200 })}
              ${textField("linkedin", "LinkedIn", val(m.linkedin), { type: "url", maxlength: 200 })}
              ${textField("tiktok", "TikTok", val(m.tiktok), { type: "url", maxlength: 200 })}
            </div>
          </div>
        </section>

        <div class="dash-mi-actionbar">
          <button class="dash-btn dash-btn-primary" type="submit" id="miWebsiteSave">${icon("check")} Save website settings</button>
          <button class="dash-btn dash-btn-ghost" type="button" id="miWebsiteReset">${icon("refresh")} Cancel changes</button>
        </div>
      </form>`;

    const copyButton = content.querySelector("#miCopyWebsite");
    if (copyButton) copyButton.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(websiteHref); toast("Website URL copied.", "success"); }
      catch (_) { toast(websiteHref, "info"); }
    });
    const form = content.querySelector("#miWebsiteForm");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validate(form)) { toast("Please correct the highlighted fields.", "error"); return; }
      try {
        await saveSection("website", readForm(form), content.querySelector("#miWebsiteSave"));
        toast("Website settings saved.", "success");
        await renderWebsite(content);
      } catch (err) { toast(err.message || "Could not save the website settings.", "error"); }
    });
    content.querySelector("#miWebsiteReset").addEventListener("click", async () => {
      const yes = await confirmAction({ title: "Discard changes?", message: "Any edits you have not saved will be lost.", confirmLabel: "Discard changes" });
      if (yes) await renderWebsite(content);
    });

    content.querySelector("#miTogglePublish").addEventListener("click", async () => {
      const goingDark = published;
      if (goingDark) {
        const yes = await confirmAction({
          title: "Unpublish the website?",
          message: `Visitors will no longer be able to open your public pages. Your ${noun()} data is not affected and you can publish again at any time.`,
          confirmLabel: "Unpublish website",
        });
        if (!yes) return;
      }
      try {
        await saveSection("website", { website_published: !published }, content.querySelector("#miTogglePublish"));
        toast(goingDark ? "Website unpublished." : "Website published.", "success");
        await renderWebsite(content);
      } catch (err) { toast(err.message || "Could not change the website status.", "error"); }
    });

    content.querySelector("#miPreviewSite").addEventListener("click", () => openSitePreview(data));
    content.querySelectorAll("[data-mi-page]").forEach((btn) => btn.addEventListener("click", () => {
      const slug = btn.getAttribute("data-mi-page");
      const page = pages.find((p) => p.slug === slug);
      if (page) openPageEditor(page, () => ctx.go("institution/pages"));
      else ctx.go("institution/pages");
    }));
  }

  /** A framed, read-only rendering of the live public page. */
  function openSitePreview(data) {
    const m = data.madrasa || {};
    const websitePath = (data.urls && data.urls.site) || `/schools/${m.slug}`;
    const modal = ctx.openModal("Website preview", `
      <div class="dash-mi-frame-bar">
        <div class="dash-actions">
          <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm is-active" data-mi-viewport="desktop">Desktop</button>
          <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-mi-viewport="tablet">Tablet</button>
          <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-mi-viewport="mobile">Mobile</button>
        </div>
        <a class="dash-btn dash-btn-ghost dash-btn-sm" href="${esc(websitePath)}" target="_blank" rel="noopener">${icon("external")} Open in a tab</a>
      </div>
      <div class="dash-mi-frame is-desktop" data-mi-frame>
        <iframe src="${esc(websitePath)}" title="Public website preview" loading="lazy"></iframe>
      </div>`);
    const frame = modal.querySelector("[data-mi-frame]");
    modal.querySelectorAll("[data-mi-viewport]").forEach((btn) => btn.addEventListener("click", () => {
      modal.querySelectorAll("[data-mi-viewport]").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      frame.className = "dash-mi-frame is-" + btn.getAttribute("data-mi-viewport");
    }));
  }

  /* ======================================================================
     4 — WEBSITE APPEARANCE
     ====================================================================== */
  async function renderAppearance(content) {
    const data = await load();
    const m = data.madrasa || {};
    const a = data.appearance || {};
    const o = data.options || {};

    content.innerHTML = `
      ${pageHead("Website Appearance", `Branding, colours and layout for the public website — one identity, with its own accent for each education section.`,
        `<a class="dash-btn dash-btn-ghost" href="/schools/${esc(m.slug)}" target="_blank" rel="noopener">${icon("external")} View live site</a>`)}
      ${sectionNav("appearance")}
      <form id="miAppearanceForm" novalidate>
        <div class="dash-mi-appearance">
          <div class="dash-mi-stack">

            <section class="dash-card">
              <div class="dash-card-head"><h3>Branding</h3></div>
              <div class="dash-card-pad">
                <div class="dash-mi-media-grid">
                  ${imageSlot("logo", "Logo", m.logo_path, "Shown in the site header.")}
                  ${imageSlot("favicon", "Favicon", m.favicon_path, "The small icon in a browser tab.")}
                  ${imageSlot("hero", "Hero / banner image", m.hero_image_path, "The large homepage image.", true)}
                </div>
              </div>
            </section>

            <section class="dash-card">
              <div class="dash-card-head"><h3>Colours</h3><span class="hint">Shared by the whole website</span></div>
              <div class="dash-card-pad">
                <div class="dash-form-grid">
                  ${colorField("brand_color", "Primary colour", a.brand_color)}
                  ${colorField("secondary_color", "Secondary colour", a.secondary_color)}
                  ${colorField("background_color", "Background colour", a.background_color)}
                  ${colorField("text_color", "Text colour", a.text_color)}
                </div>
              </div>
            </section>

            <section class="dash-card dash-mi-dual">
              <div class="dash-card-head">
                <h3>Islamic &amp; Western education accents</h3>
                <span class="hint">Two sections, one institution</span>
              </div>
              <div class="dash-card-pad">
                <p class="dash-info-line" style="margin-bottom:14px;">
                  Each education section gets its own accent colour, while the logo, typography, layout and primary
                  colour above stay shared — so both clearly belong to the same ${esc(noun())}.
                </p>
                <div class="dash-form-grid">
                  ${colorField("islamic_color", "Islamic Education accent", a.islamic_color)}
                  ${colorField("western_color", "Western Education accent", a.western_color)}
                </div>
              </div>
            </section>

            <section class="dash-card">
              <div class="dash-card-head"><h3>Typography &amp; layout</h3></div>
              <div class="dash-card-pad">
                <div class="dash-form-grid">
                  ${selectField("font_family", "Font", a.font_family, o.fonts || [])}
                  ${selectField("website_theme", "Website theme", a.website_theme, o.websiteThemes || [])}
                  ${selectField("header_style", "Header style", a.header_style, o.headerStyles || [])}
                  ${selectField("footer_style", "Footer style", a.footer_style, o.footerStyles || [])}
                  ${selectField("button_style", "Button style", a.button_style, o.buttonStyles || [])}
                  ${selectField("card_style", "Card style", a.card_style, o.cardStyles || [])}
                  ${selectField("homepage_layout", "Homepage layout", a.homepage_layout, o.homepageLayouts || [])}
                </div>
              </div>
            </section>
          </div>

          <aside class="dash-mi-preview-rail">
            <section class="dash-card">
              <div class="dash-card-head">
                <h3>Live preview</h3>
                <div class="dash-mi-preview-switch">
                  <button type="button" class="dash-mi-chip is-active" data-mi-device="desktop">Desktop</button>
                  <button type="button" class="dash-mi-chip" data-mi-device="mobile">Mobile</button>
                </div>
              </div>
              <div class="dash-card-pad">
                <div class="dash-mi-livepreview" id="miLivePreview"></div>
              </div>
            </section>
          </aside>
        </div>

        <div class="dash-mi-actionbar">
          <button class="dash-btn dash-btn-primary" type="submit" id="miAppearanceSave">${icon("check")} Save appearance</button>
          <button class="dash-btn dash-btn-ghost" type="button" id="miAppearanceReset">${icon("refresh")} Reset to default</button>
        </div>
      </form>`;

    const form = content.querySelector("#miAppearanceForm");
    const preview = content.querySelector("#miLivePreview");
    let device = "desktop";

    const paint = () => {
      const current = readForm(form);
      preview.innerHTML = livePreviewMarkup(Object.assign({}, m, current), device);
    };
    paint();

    bindColorInputs(content, paint);
    bindImageSlots(content, () => renderAppearance(content));
    form.querySelectorAll("select").forEach((s) => s.addEventListener("change", paint));
    content.querySelectorAll("[data-mi-device]").forEach((btn) => btn.addEventListener("click", () => {
      device = btn.getAttribute("data-mi-device");
      content.querySelectorAll("[data-mi-device]").forEach((b) => b.classList.toggle("is-active", b === btn));
      paint();
    }));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validate(form)) { toast("Please correct the highlighted colours.", "error"); return; }
      try {
        await saveSection("appearance", readForm(form), content.querySelector("#miAppearanceSave"));
        toast("Appearance saved.", "success");
        await renderAppearance(content);
      } catch (err) { toast(err.message || "Could not save the appearance.", "error"); }
    });
    content.querySelector("#miAppearanceReset").addEventListener("click", async () => {
      const yes = await confirmAction({
        title: "Reset appearance?",
        message: `Colours, fonts and layout return to the default ${data.category === "western" ? "Western Academy" : "Islamic School"} theme. Your logo and images are kept.`,
        confirmLabel: "Reset to default",
      });
      if (!yes) return;
      try {
        const result = await api().post("/madrasa/institution/appearance/reset", {});
        cache.data = result;
        toast("Appearance reset to the default theme.", "success");
        await renderAppearance(content);
      } catch (err) { toast(err.message || "Could not reset the appearance.", "error"); }
    });
  }

  /* Single-quoted family names: these stacks are injected into double-quoted
     style="" attributes, and a double quote would truncate the attribute. */
  const FONT_STACKS = {
    system: "Inter, ui-sans-serif, system-ui, 'Segoe UI', sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'Trebuchet MS', 'Segoe UI', system-ui, sans-serif",
    humanist: "Optima, Candara, 'Segoe UI', system-ui, sans-serif",
  };

  function livePreviewMarkup(v, device) {
    const brand = safeHex(v.brand_color, "#200A3D");
    const secondary = safeHex(v.secondary_color, "#C8952C");
    const bg = safeHex(v.background_color, "#FFFFFF");
    const text = safeHex(v.text_color, "#25202C");
    const islamic = safeHex(v.islamic_color, "#200A3D");
    const western = safeHex(v.western_color, "#0A2342");
    const font = FONT_STACKS[v.font_family] || FONT_STACKS.system;
    const radius = v.button_style === "pill" ? "999px" : (v.button_style === "square" ? "3px" : "10px");
    const cardStyle = v.card_style === "flat"
      ? "border:0;box-shadow:none;background:rgba(0,0,0,.03);"
      : (v.card_style === "outlined" ? "border:1px solid rgba(0,0,0,.16);box-shadow:none;" : "border:0;box-shadow:0 8px 18px rgba(0,0,0,.10);");
    const dark = v.website_theme === "dark";
    const surface = dark ? "#171422" : bg;
    const ink = dark ? "#F4F1FA" : text;
    const headerBg = v.header_style === "transparent" ? "transparent" : brand;
    const headerColor = v.header_style === "transparent" ? ink : "#fff";
    const headerPad = v.header_style === "compact" ? "7px 12px" : "12px 14px";
    const heroSplit = v.homepage_layout === "hero-split";
    const classic = v.homepage_layout === "classic";

    return `<div class="dash-mi-lp ${device === "mobile" ? "is-mobile" : "is-desktop"}"
                 style="font-family:${font};background:${surface};color:${ink};">
      <div class="dash-mi-lp-header" style="background:${headerBg};color:${headerColor};padding:${headerPad};${v.header_style === "transparent" ? "border-bottom:1px solid rgba(0,0,0,.08);" : ""}">
        <span class="dash-mi-lp-brand">
          ${v.logo_path ? `<img src="${esc(v.logo_path)}" alt="">` : `<i style="background:${secondary}"></i>`}
          ${esc(shorten(v.name_en || "Your institution", 22))}
        </span>
        <span class="dash-mi-lp-nav"><i></i><i></i><i></i></span>
      </div>
      <div class="dash-mi-lp-hero ${heroSplit ? "is-split" : ""} ${classic ? "is-classic" : ""}" style="background:${brand};">
        ${v.hero_image_path ? `<img class="dash-mi-lp-hero-img" src="${esc(v.hero_image_path)}" alt="">` : ""}
        <div class="dash-mi-lp-hero-body">
          <strong>${esc(shorten(v.name_en || "Your institution", 34))}</strong>
          <span>${esc(shorten(v.tagline || v.motto_en || "Knowledge, character and service.", 60))}</span>
          <em style="background:${secondary};border-radius:${radius};">Apply now</em>
        </div>
        ${!classic && !heroSplit ? `<div class="dash-mi-lp-stats"><b>Students</b><b>Teachers</b><b>Classes</b></div>` : ""}
      </div>
      <div class="dash-mi-lp-sections">
        <div class="dash-mi-lp-card" style="${cardStyle}border-top:3px solid ${islamic};">
          <strong style="color:${islamic}">Islamic Education</strong>
          <span>Qur'an, Tajweed, Arabic and Islamic studies.</span>
        </div>
        <div class="dash-mi-lp-card" style="${cardStyle}border-top:3px solid ${western};">
          <strong style="color:${western}">Western Education</strong>
          <span>Mathematics, English, Sciences and more.</span>
        </div>
      </div>
      <div class="dash-mi-lp-footer" style="${v.footer_style === "minimal" ? "padding:8px 12px;" : (v.footer_style === "simple" ? "padding:12px;" : "padding:16px 12px;")}background:${dark ? "#0F0C18" : brand};">
        <span>© ${new Date().getFullYear()} ${esc(shorten(v.name_en || "Your institution", 26))}</span>
        ${v.footer_style === "detailed" ? `<span class="dash-mi-lp-footcols"><i></i><i></i><i></i></span>` : ""}
      </div>
    </div>`;
  }
  function safeHex(v, fallback) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(v || "")) ? v : fallback;
  }
  function shorten(v, n) {
    const s = String(v || "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  /* ======================================================================
     5 — WEBSITE PAGES
     ====================================================================== */
  async function renderPages(content) {
    content.innerHTML = loadingState("Loading your website pages…");
    const data = await api().get("/madrasa/institution/pages");
    const pages = data.pages || [];
    const publishedCount = pages.filter((p) => Number(p.is_published) === 1).length;

    content.innerHTML = `
      ${pageHead("Website Pages", "Create, edit and publish the pages of your public website. Nothing goes live until you publish it.",
        `<button class="dash-btn dash-btn-primary" id="miNewPage">${icon("plus")} New page</button>`)}
      ${sectionNav("pages")}
      <div class="dash-stats-grid">
        ${ctx.statCard("book", pages.length, "Total pages")}
        ${ctx.statCard("check", publishedCount, "Published")}
        ${ctx.statCard("clock", pages.length - publishedCount, "Drafts")}
        ${ctx.statCard("globe", pages.filter((p) => Number(p.in_navigation) === 1).length, "In the menu")}
      </div>
      <div class="dash-card" style="margin-top:18px;">
        <div class="dash-card-head">
          <h3>All pages</h3>
          <div class="dash-actions">
            <div class="dash-field" style="margin:0;">
              <input id="miPageSearch" type="search" placeholder="Search pages" aria-label="Search pages">
            </div>
          </div>
        </div>
        <div class="dash-table-wrap">
          <table class="dash-table">
            <thead><tr><th>Page</th><th>Address</th><th>Status</th><th>Menu</th><th>Order</th><th></th></tr></thead>
            <tbody id="miPageRows"></tbody>
          </table>
        </div>
      </div>`;

    const tbody = content.querySelector("#miPageRows");
    const draw = (filter) => {
      const term = String(filter || "").trim().toLowerCase();
      const rows = pages.filter((p) => !term || `${p.title} ${p.slug}`.toLowerCase().includes(term));
      if (!rows.length) {
        tbody.innerHTML = `<tr class="dash-empty-row"><td colspan="6">${term ? "No pages match that search." : "No pages yet — create your first one."}</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map((p, index) => `
        <tr>
          <td>
            <strong>${esc(p.title)}</strong>
            ${Number(p.is_system) === 1 ? `<small>Core page</small>` : (p.summary ? `<small>${esc(shorten(p.summary, 70))}</small>` : "")}
          </td>
          <td><code class="dash-mi-code">/${esc(p.slug)}</code></td>
          <td><span class="dash-pill ${Number(p.is_published) === 1 ? "ok" : "muted"}">${Number(p.is_published) === 1 ? "Published" : "Draft"}</span></td>
          <td><span class="dash-pill ${Number(p.in_navigation) === 1 ? "info" : "muted"}">${Number(p.in_navigation) === 1 ? "Shown" : "Hidden"}</span></td>
          <td class="dash-mi-order">
            <button class="dash-icon-btn dash-mi-move" data-move-up="${p.id}" aria-label="Move ${esc(p.title)} up" ${index === 0 ? "disabled" : ""}>↑</button>
            <button class="dash-icon-btn dash-mi-move" data-move-down="${p.id}" aria-label="Move ${esc(p.title)} down" ${index === rows.length - 1 ? "disabled" : ""}>↓</button>
          </td>
          <td>
            <div class="dash-actions">
              <button class="dash-btn dash-btn-ghost dash-btn-sm" data-edit-page="${p.id}">${icon("edit")} Edit</button>
              <button class="dash-btn dash-btn-ghost dash-btn-sm" data-preview-page="${p.id}">${icon("external")} Preview</button>
              <button class="dash-btn dash-btn-ghost dash-btn-sm" data-toggle-page="${p.id}">${Number(p.is_published) === 1 ? "Unpublish" : "Publish"}</button>
              ${Number(p.is_system) === 1 ? "" : `<button class="dash-btn dash-btn-danger dash-btn-sm" data-delete-page="${p.id}" aria-label="Delete ${esc(p.title)}">${icon("trash")}</button>`}
            </div>
          </td>
        </tr>`).join("");
      bindRows();
    };

    const find = (id) => pages.find((p) => Number(p.id) === Number(id));
    const reload = () => renderPages(content);

    function bindRows() {
      tbody.querySelectorAll("[data-edit-page]").forEach((b) => b.addEventListener("click", () => openPageEditor(find(b.dataset.editPage), reload)));
      tbody.querySelectorAll("[data-preview-page]").forEach((b) => b.addEventListener("click", () => openPagePreview(find(b.dataset.previewPage))));
      tbody.querySelectorAll("[data-toggle-page]").forEach((b) => b.addEventListener("click", async () => {
        const page = find(b.dataset.togglePage);
        try {
          await api().patch(`/madrasa/institution/pages/${page.id}`, { is_published: Number(page.is_published) !== 1 });
          toast(Number(page.is_published) === 1 ? "Page unpublished." : "Page published.", "success");
          await reload();
        } catch (err) { toast(err.message || "Could not change the page status.", "error"); }
      }));
      tbody.querySelectorAll("[data-delete-page]").forEach((b) => b.addEventListener("click", async () => {
        const page = find(b.dataset.deletePage);
        const yes = await confirmAction({
          title: `Delete “${page.title}”?`,
          message: "This page and its content will be permanently removed from your website.",
          detail: "This cannot be undone.",
          confirmLabel: "Delete page",
        });
        if (!yes) return;
        try { await api().del(`/madrasa/institution/pages/${page.id}`); toast("Page deleted.", "success"); await reload(); }
        catch (err) { toast(err.message || "Could not delete the page.", "error"); }
      }));
      tbody.querySelectorAll("[data-move-up],[data-move-down]").forEach((b) => b.addEventListener("click", async () => {
        const up = b.hasAttribute("data-move-up");
        const id = Number(up ? b.dataset.moveUp : b.dataset.moveDown);
        const index = pages.findIndex((p) => Number(p.id) === id);
        const swap = up ? index - 1 : index + 1;
        if (index < 0 || swap < 0 || swap >= pages.length) return;
        const reordered = pages.slice();
        const [moved] = reordered.splice(index, 1);
        reordered.splice(swap, 0, moved);
        try {
          await api().put("/madrasa/institution/pages/reorder", { order: reordered.map((p) => p.id) });
          await reload();
        } catch (err) { toast(err.message || "Could not reorder the pages.", "error"); }
      }));
    }

    draw("");
    content.querySelector("#miPageSearch").addEventListener("input", (e) => draw(e.target.value));
    content.querySelector("#miNewPage").addEventListener("click", () => openPageEditor(null, reload));
  }

  function openPageEditor(page, done) {
    const isNew = !page;
    const p = page || { title: "", slug: "", summary: "", body: "", seo_title: "", seo_description: "", is_published: 0, in_navigation: 0, is_system: 0 };
    const modal = ctx.openModal(isNew ? "New website page" : `Edit “${p.title}”`, `
      <form id="miPageForm" novalidate>
        <div class="dash-form-grid">
          ${textField("title", "Page title", val(p.title), { required: true, maxlength: 160, full: true })}
          ${Number(p.is_system) === 1
            ? fieldWrap(`<label>Page address</label><input value="/${esc(p.slug)}" disabled><span class="dash-field-hint">Core pages keep a fixed address.</span>`, { full: true })
            : textField("slug", "Page address", val(p.slug), { maxlength: 80, full: true, placeholder: "about-us", hint: "Letters, numbers and hyphens. Leave blank to build it from the title." })}
          ${textAreaField("summary", "Short summary", val(p.summary), { rows: 2, maxlength: 400 })}
          ${textAreaField("body", "Page content", val(p.body), { rows: 10, maxlength: 60000, placeholder: "Write clear, family-friendly content…" })}
          ${textField("seo_title", "SEO title", val(p.seo_title), { maxlength: 160, full: true })}
          ${textAreaField("seo_description", "SEO description", val(p.seo_description), { rows: 2, maxlength: 320 })}
        </div>
        ${toggleRow("is_published", "Publish this page on the website", Number(p.is_published) === 1)}
        ${toggleRow("in_navigation", "Show this page in the website menu", Number(p.in_navigation) === 1)}
        <div class="dash-actions" style="margin-top:16px;">
          <button class="dash-btn dash-btn-primary" type="submit">${icon("check")} ${isNew ? "Create page" : "Save page"}</button>
          <button class="dash-btn dash-btn-ghost" type="button" id="miPageCancel">Cancel</button>
        </div>
      </form>`);
    const form = modal.querySelector("#miPageForm");
    modal.querySelector("#miPageCancel").addEventListener("click", () => ctx.closeModal());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validate(form)) return;
      const body = readForm(form);
      try {
        if (isNew) await api().post("/madrasa/institution/pages", body);
        else await api().patch(`/madrasa/institution/pages/${p.id}`, body);
        toast(isNew ? "Page created." : "Page saved.", "success");
        ctx.closeModal();
        if (done) await done();
      } catch (err) { toast(err.message || "Could not save the page.", "error"); }
    });
  }

  function openPagePreview(page) {
    ctx.openModal(`Preview — ${page.title}`, `
      <div class="dash-mi-preview">
        <div class="dash-mi-preview-block">
          <span class="dash-pill ${Number(page.is_published) === 1 ? "ok" : "muted"}">${Number(page.is_published) === 1 ? "Published" : "Draft — not visible to the public"}</span>
          <h4 style="margin-top:12px;">${esc(page.title)}</h4>
          ${page.summary ? `<p><strong>${esc(page.summary)}</strong></p>` : ""}
          <p>${esc(page.body || "This page has no content yet.")}</p>
        </div>
        <div class="dash-mi-preview-block">
          <h4>Search engine listing</h4>
          <p class="dash-mi-serp-title">${esc(page.seo_title || page.title)}</p>
          <p class="dash-mi-serp-url">/${esc(page.slug)}</p>
          <p>${esc(page.seo_description || page.summary || "Add an SEO description so search engines describe this page well.")}</p>
        </div>
      </div>`);
  }

  /* ======================================================================
     6 — GALLERY
     ====================================================================== */
  async function renderGallery(content) {
    content.innerHTML = loadingState("Loading the gallery…");
    const [albumData, mediaData] = await Promise.all([
      api().get("/madrasa/institution/albums"),
      api().get("/madrasa/institution/media"),
    ]);
    const albums = albumData.albums || [];
    const media = mediaData.media || [];
    const categories = mediaData.categories || [];
    const state = { album: "", category: "" };

    content.innerHTML = `
      ${pageHead("Gallery", "Photos and videos shown on your public website. Group them into albums, then publish what you want visitors to see.",
        `<button class="dash-btn dash-btn-ghost" id="miNewAlbum">${icon("plus")} New album</button>
         <button class="dash-btn dash-btn-ghost" id="miAddVideo">${icon("external")} Add video</button>
         <label class="dash-btn dash-btn-primary dash-mi-file">${icon("plus")} Upload images
           <input type="file" id="miUploadMedia" accept="image/png,image/jpeg,image/webp" multiple hidden></label>`)}
      ${sectionNav("gallery")}
      <div class="dash-stats-grid">
        ${ctx.statCard("image", media.filter((x) => x.media_type !== "video").length, "Images")}
        ${ctx.statCard("external", media.filter((x) => x.media_type === "video").length, "Videos")}
        ${ctx.statCard("book", albums.length, "Albums")}
        ${ctx.statCard("check", media.filter((x) => Number(x.is_published) === 1).length, "Published")}
      </div>

      <section class="dash-card" style="margin-top:18px;">
        <div class="dash-card-head"><h3>Albums</h3><span class="hint">${albums.length} album(s)</span></div>
        <div class="dash-card-pad">
          <div id="miAlbumGrid"></div>
        </div>
      </section>

      <section class="dash-card" style="margin-top:18px;">
        <div class="dash-card-head">
          <h3>Media library</h3>
          <div class="dash-actions">
            <div class="dash-field" style="margin:0;min-width:150px;">
              <select id="miFilterAlbum" aria-label="Filter by album">
                <option value="">All albums</option>
                <option value="none">Not in an album</option>
                ${albums.map((a) => `<option value="${a.id}">${esc(a.title)}</option>`).join("")}
              </select>
            </div>
            <div class="dash-field" style="margin:0;min-width:150px;">
              <select id="miFilterCategory" aria-label="Filter by category">
                <option value="">All categories</option>
                ${categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
              </select>
            </div>
          </div>
        </div>
        <div class="dash-card-pad"><div id="miMediaGrid"></div></div>
      </section>`;

    const albumGrid = content.querySelector("#miAlbumGrid");
    const mediaGrid = content.querySelector("#miMediaGrid");
    const reload = () => renderGallery(content);

    function drawAlbums() {
      if (!albums.length) {
        albumGrid.innerHTML = emptyState("book", "No albums yet",
          `Albums group photos by event — a graduation, an anniversary, a sports day.`,
          `<button class="dash-btn dash-btn-primary dash-btn-sm" id="miEmptyNewAlbum">${icon("plus")} Create an album</button>`);
        const b = albumGrid.querySelector("#miEmptyNewAlbum");
        if (b) b.addEventListener("click", () => openAlbumModal(null, media, reload));
        return;
      }
      albumGrid.innerHTML = `<div class="dash-mi-album-grid">${albums.map((a) => `
        <article class="dash-mi-album">
          <div class="dash-mi-album-cover">
            ${a.cover_path ? `<img src="${esc(a.cover_path)}" alt="">` : `<span>${icon("image")}</span>`}
            ${Number(a.is_featured) === 1 ? `<span class="dash-mi-flag">Featured</span>` : ""}
          </div>
          <div class="dash-mi-album-body">
            <strong>${esc(a.title)}</strong>
            <small>${esc(a.category || "Uncategorised")} · ${Number(a.media_count || 0)} item(s)</small>
            ${a.description ? `<p>${esc(shorten(a.description, 90))}</p>` : ""}
            <div class="dash-actions">
              <span class="dash-pill ${Number(a.is_published) === 1 ? "ok" : "muted"}">${Number(a.is_published) === 1 ? "Published" : "Hidden"}</span>
              <button class="dash-btn dash-btn-ghost dash-btn-sm" data-edit-album="${a.id}">${icon("edit")} Edit</button>
              <button class="dash-btn dash-btn-danger dash-btn-sm" data-delete-album="${a.id}" aria-label="Delete ${esc(a.title)}">${icon("trash")}</button>
            </div>
          </div>
        </article>`).join("")}</div>`;

      albumGrid.querySelectorAll("[data-edit-album]").forEach((b) => b.addEventListener("click", () =>
        openAlbumModal(albums.find((a) => Number(a.id) === Number(b.dataset.editAlbum)), media, reload)));
      albumGrid.querySelectorAll("[data-delete-album]").forEach((b) => b.addEventListener("click", async () => {
        const album = albums.find((a) => Number(a.id) === Number(b.dataset.deleteAlbum));
        const yes = await confirmAction({
          title: `Delete album “${album.title}”?`,
          message: "The album is removed from your website.",
          detail: "Photos and videos inside it are kept and simply return to the unfiled media library.",
          confirmLabel: "Delete album",
        });
        if (!yes) return;
        try { await api().del(`/madrasa/institution/albums/${album.id}`); toast("Album deleted.", "success"); await reload(); }
        catch (err) { toast(err.message || "Could not delete the album.", "error"); }
      }));
    }

    function visibleMedia() {
      return media.filter((x) => {
        if (state.album === "none" && x.album_id) return false;
        if (state.album && state.album !== "none" && Number(x.album_id) !== Number(state.album)) return false;
        if (state.category && x.category !== state.category) return false;
        return true;
      });
    }

    function drawMedia() {
      const rows = visibleMedia();
      if (!rows.length) {
        mediaGrid.innerHTML = emptyState("image", media.length ? "Nothing matches these filters" : "No photos or videos yet",
          media.length ? "Try a different album or category." : `Upload images of your ${noun()} — classrooms, events, students at work — or add a video link.`);
        return;
      }
      mediaGrid.innerHTML = `<div class="dash-mi-media-library">${rows.map((x, index) => `
        <figure class="dash-mi-tile-media">
          <div class="dash-mi-tile-thumb">
            ${x.media_type === "video"
              ? (x.image_path ? `<img src="${esc(x.image_path)}" alt="${esc(x.caption || "Video")}">` : `<span class="dash-mi-video-mark">${icon("external")}</span>`)
              : `<img src="${esc(x.image_path)}" alt="${esc(x.caption || "Gallery image")}" loading="lazy">`}
            ${x.media_type === "video" ? `<span class="dash-mi-flag">Video</span>` : ""}
            ${Number(x.is_featured) === 1 ? `<span class="dash-mi-flag is-gold">Featured</span>` : ""}
          </div>
          <figcaption>
            <strong>${esc(x.caption || (x.media_type === "video" ? "Untitled video" : "Untitled photo"))}</strong>
            <small>${esc(x.category || "Uncategorised")}${x.album_id ? ` · ${esc((albums.find((a) => Number(a.id) === Number(x.album_id)) || {}).title || "Album")}` : ""}</small>
            <div class="dash-actions">
              <span class="dash-pill ${Number(x.is_published) === 1 ? "ok" : "muted"}">${Number(x.is_published) === 1 ? "Live" : "Hidden"}</span>
              <button class="dash-btn dash-btn-ghost dash-btn-sm" data-edit-media="${x.id}">${icon("edit")}</button>
              <button class="dash-icon-btn dash-mi-move" data-media-up="${x.id}" aria-label="Move earlier" ${index === 0 ? "disabled" : ""}>↑</button>
              <button class="dash-icon-btn dash-mi-move" data-media-down="${x.id}" aria-label="Move later" ${index === rows.length - 1 ? "disabled" : ""}>↓</button>
              <button class="dash-btn dash-btn-danger dash-btn-sm" data-delete-media="${x.id}" aria-label="Delete">${icon("trash")}</button>
            </div>
          </figcaption>
        </figure>`).join("")}</div>`;

      mediaGrid.querySelectorAll("[data-edit-media]").forEach((b) => b.addEventListener("click", () =>
        openMediaModal(media.find((x) => Number(x.id) === Number(b.dataset.editMedia)), albums, categories, reload)));
      mediaGrid.querySelectorAll("[data-delete-media]").forEach((b) => b.addEventListener("click", async () => {
        const item = media.find((x) => Number(x.id) === Number(b.dataset.deleteMedia));
        const yes = await confirmAction({
          title: "Delete this item?",
          message: `“${item.caption || "This item"}” will be permanently removed from your gallery and website.`,
          detail: "This cannot be undone.",
          confirmLabel: "Delete",
        });
        if (!yes) return;
        try { await api().del(`/madrasa/institution/media/${item.id}`); toast("Item deleted.", "success"); await reload(); }
        catch (err) { toast(err.message || "Could not delete the item.", "error"); }
      }));
      mediaGrid.querySelectorAll("[data-media-up],[data-media-down]").forEach((b) => b.addEventListener("click", async () => {
        const up = b.hasAttribute("data-media-up");
        const id = Number(up ? b.dataset.mediaUp : b.dataset.mediaDown);
        const rowsNow = visibleMedia();
        const index = rowsNow.findIndex((x) => Number(x.id) === id);
        const swap = up ? index - 1 : index + 1;
        if (index < 0 || swap < 0 || swap >= rowsNow.length) return;
        const ordered = rowsNow.slice();
        const [moved] = ordered.splice(index, 1);
        ordered.splice(swap, 0, moved);
        // Reorder within the whole library so the saved order is stable.
        const full = media.slice().sort((a, z) => Number(a.sort_order) - Number(z.sort_order));
        const visibleIds = new Set(ordered.map((x) => x.id));
        let cursor = 0;
        const finalOrder = full.map((x) => (visibleIds.has(x.id) ? ordered[cursor++] : x));
        try {
          await api().put("/madrasa/institution/media/reorder", { order: finalOrder.map((x) => x.id) });
          await reload();
        } catch (err) { toast(err.message || "Could not reorder the media.", "error"); }
      }));
    }

    drawAlbums();
    drawMedia();

    content.querySelector("#miFilterAlbum").addEventListener("change", (e) => { state.album = e.target.value; drawMedia(); });
    content.querySelector("#miFilterCategory").addEventListener("change", (e) => { state.category = e.target.value; drawMedia(); });
    content.querySelector("#miNewAlbum").addEventListener("click", () => openAlbumModal(null, media, reload));
    content.querySelector("#miAddVideo").addEventListener("click", () => openVideoModal(albums, categories, reload));
    content.querySelector("#miUploadMedia").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      mediaGrid.insertAdjacentHTML("afterbegin", `<p class="dash-field-hint" id="miUploadStatus">Uploading ${files.length} file(s)…</p>`);
      let uploaded = 0;
      for (const file of files) {
        if (file.size > 5 * 1024 * 1024) { toast(`${file.name} is larger than 5 MB and was skipped.`, "error"); continue; }
        const fd = new FormData();
        fd.append("image", file);
        if (state.album && state.album !== "none") fd.append("album_id", state.album);
        if (state.category) fd.append("category", state.category);
        try { await api().post("/madrasa/institution/media", fd); uploaded++; }
        catch (err) { toast(err.message || `Could not upload ${file.name}.`, "error"); }
      }
      if (uploaded) toast(`${uploaded} item(s) added to the gallery.`, "success");
      await reload();
    });
  }

  function openAlbumModal(album, media, done) {
    const isNew = !album;
    const a = album || { title: "", description: "", category: "School Activities", is_published: 1, is_featured: 0, cover_image_id: null };
    const categories = (cache.data && cache.data.options && cache.data.options.galleryCategories) || [];
    const albumMedia = media.filter((x) => !album || Number(x.album_id) === Number(album.id));
    const modal = ctx.openModal(isNew ? "New album" : `Edit “${a.title}”`, `
      <form id="miAlbumForm" novalidate>
        <div class="dash-form-grid">
          ${textField("title", "Album title", val(a.title), { required: true, maxlength: 160, full: true })}
          ${selectField("category", "Category", val(a.category), categories)}
          ${albumMedia.length
            ? selectField("cover_image_id", "Cover image", val(a.cover_image_id), albumMedia.filter((x) => x.image_path).map((x) => ({ value: x.id, label: x.caption || `Item #${x.id}` })), { placeholder: "No cover image" })
            : fieldWrap(`<label>Cover image</label><input disabled value="Add photos to this album first"><span class="dash-field-hint">Upload images and file them here, then pick a cover.</span>`)}
          ${textAreaField("description", "Album description", val(a.description), { rows: 3, maxlength: 600 })}
        </div>
        ${toggleRow("is_published", "Show this album on the website", Number(a.is_published) === 1)}
        ${toggleRow("is_featured", "Feature this album", Number(a.is_featured) === 1)}
        <div class="dash-actions" style="margin-top:16px;">
          <button class="dash-btn dash-btn-primary" type="submit">${icon("check")} ${isNew ? "Create album" : "Save album"}</button>
          <button class="dash-btn dash-btn-ghost" type="button" id="miAlbumCancel">Cancel</button>
        </div>
      </form>`);
    modal.querySelector("#miAlbumCancel").addEventListener("click", () => ctx.closeModal());
    const form = modal.querySelector("#miAlbumForm");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validate(form)) return;
      const body = readForm(form);
      try {
        if (isNew) await api().post("/madrasa/institution/albums", body);
        else await api().patch(`/madrasa/institution/albums/${a.id}`, body);
        toast(isNew ? "Album created." : "Album saved.", "success");
        ctx.closeModal();
        if (done) await done();
      } catch (err) { toast(err.message || "Could not save the album.", "error"); }
    });
  }

  function openVideoModal(albums, categories, done) {
    const modal = ctx.openModal("Add a video", `
      <form id="miVideoForm" novalidate>
        <div class="dash-form-grid">
          ${textField("video_url", "Video link", "", { type: "url", required: true, maxlength: 500, full: true, placeholder: "https://www.youtube.com/watch?v=…", hint: "Paste a link from YouTube, Vimeo or your own hosting." })}
          ${textField("caption", "Caption", "", { maxlength: 200, full: true })}
          ${selectField("category", "Category", "School Activities", categories)}
          ${selectField("album_id", "Album", "", albums.map((a) => ({ value: a.id, label: a.title })), { placeholder: "No album" })}
        </div>
        ${toggleRow("is_published", "Show this video on the website", true)}
        ${toggleRow("is_featured", "Feature this video", false)}
        <div class="dash-actions" style="margin-top:16px;">
          <button class="dash-btn dash-btn-primary" type="submit">${icon("check")} Add video</button>
          <button class="dash-btn dash-btn-ghost" type="button" id="miVideoCancel">Cancel</button>
        </div>
      </form>`);
    modal.querySelector("#miVideoCancel").addEventListener("click", () => ctx.closeModal());
    const form = modal.querySelector("#miVideoForm");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validate(form)) return;
      try {
        await api().post("/madrasa/institution/media/video", readForm(form));
        toast("Video added to the gallery.", "success");
        ctx.closeModal();
        if (done) await done();
      } catch (err) { toast(err.message || "Could not add the video.", "error"); }
    });
  }

  function openMediaModal(item, albums, categories, done) {
    const modal = ctx.openModal("Edit gallery item", `
      <div class="dash-mi-edit-media">
        ${item.media_type === "video"
          ? `<div class="dash-mi-edit-thumb">${item.image_path ? `<img src="${esc(item.image_path)}" alt="">` : `<span>${icon("external")}</span>`}</div>`
          : `<div class="dash-mi-edit-thumb"><img src="${esc(item.image_path)}" alt=""></div>`}
        <form id="miMediaForm" novalidate>
          <div class="dash-form-grid">
            ${textField("caption", "Caption", val(item.caption), { maxlength: 200, full: true })}
            ${selectField("category", "Category", val(item.category), categories)}
            ${selectField("album_id", "Album", val(item.album_id), albums.map((a) => ({ value: a.id, label: a.title })), { placeholder: "No album" })}
            ${item.media_type === "video" ? textField("video_url", "Video link", val(item.video_url), { type: "url", maxlength: 500, full: true }) : ""}
          </div>
          ${toggleRow("is_published", "Show on the website", Number(item.is_published) === 1)}
          ${toggleRow("is_featured", "Feature this item", Number(item.is_featured) === 1)}
          <div class="dash-actions" style="margin-top:16px;">
            <button class="dash-btn dash-btn-primary" type="submit">${icon("check")} Save item</button>
            <button class="dash-btn dash-btn-ghost" type="button" id="miMediaCancel">Cancel</button>
          </div>
        </form>
      </div>`);
    modal.querySelector("#miMediaCancel").addEventListener("click", () => ctx.closeModal());
    const form = modal.querySelector("#miMediaForm");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validate(form)) return;
      try {
        await api().patch(`/madrasa/institution/media/${item.id}`, readForm(form));
        toast("Gallery item saved.", "success");
        ctx.closeModal();
        if (done) await done();
      } catch (err) { toast(err.message || "Could not save the item.", "error"); }
    });
  }

  /* ======================================================================
     7 — CONTACT INFORMATION
     ====================================================================== */
  async function renderContact(content) {
    const data = await load();
    const m = data.madrasa || {};
    const o = data.options || {};
    const days = String(m.school_days || "").split(",").map((d) => d.trim()).filter(Boolean);

    content.innerHTML = `
      ${pageHead("Contact Information", "The details families use to reach you — and exactly which of them appear publicly.",
        `<a class="dash-btn dash-btn-ghost" href="/schools/${esc(m.slug)}" target="_blank" rel="noopener">${icon("external")} View contact page</a>`)}
      ${sectionNav("contact")}
      <form id="miContactForm" novalidate>
        <div class="dash-mi-appearance">
          <div class="dash-mi-stack">
            <section class="dash-card">
              <div class="dash-card-head"><h3>Address &amp; location</h3></div>
              <div class="dash-card-pad">
                <div class="dash-form-grid">
                  ${textField("address", "Official address", val(m.address), { maxlength: 255, full: true })}
                  ${textField("city", "City / town", val(m.city), { maxlength: 80 })}
                  ${textField("state_name", "State", val(m.state_name), { maxlength: 80 })}
                  ${textField("country", "Country", val(m.country, "Nigeria"), { maxlength: 80 })}
                  ${textField("maps_link", "Google Maps location", val(m.maps_link), { type: "url", maxlength: 255, full: true, placeholder: "https://maps.google.com/…" })}
                </div>
              </div>
            </section>

            <section class="dash-card">
              <div class="dash-card-head"><h3>Phone, email &amp; messaging</h3></div>
              <div class="dash-card-pad">
                <div class="dash-form-grid">
                  ${textField("phone", "Phone number", val(m.phone), { maxlength: 60, autocomplete: "tel" })}
                  ${textField("alt_phone", "Alternative phone", val(m.alt_phone), { maxlength: 60 })}
                  ${textField("whatsapp", "WhatsApp number", val(m.whatsapp), { maxlength: 60 })}
                  ${textField("email", "Official email", val(m.email), { type: "email", maxlength: 120 })}
                  ${textField("admissions_email", "Admissions email", val(m.admissions_email), { type: "email", maxlength: 120 })}
                  ${textField("website", "Website", val(m.website), { type: "url", maxlength: 160 })}
                  ${textField("emergency_contact", "Emergency contact", val(m.emergency_contact), { maxlength: 160, full: true, placeholder: "Name and number for urgent situations" })}
                </div>
              </div>
            </section>

            <section class="dash-card">
              <div class="dash-card-head"><h3>Opening hours</h3></div>
              <div class="dash-card-pad">
                <div class="dash-form-grid">
                  ${textField("opening_time", "Opening time", val(m.opening_time), { type: "time" })}
                  ${textField("closing_time", "Closing time", val(m.closing_time), { type: "time" })}
                </div>
                <div class="dash-field" style="margin-top:14px;">
                  <label>School days</label>
                  <div class="dash-check-grid">
                    ${(o.schoolDays || []).map((d) => `<label><input type="checkbox" name="school_days" value="${esc(d)}" data-multi="1" ${days.includes(d) ? "checked" : ""}> ${esc(d)}</label>`).join("")}
                  </div>
                </div>
              </div>
            </section>

            <section class="dash-card">
              <div class="dash-card-head"><h3>Administration contact</h3></div>
              <div class="dash-card-pad">
                <div class="dash-form-grid">
                  ${textField("head_name", "Principal / Head", val(m.head_name), { maxlength: 160 })}
                  ${textField("head_title", "Title", val(m.head_title), { maxlength: 80 })}
                </div>
              </div>
            </section>

            <section class="dash-card">
              <div class="dash-card-head"><h3>Social media accounts</h3></div>
              <div class="dash-card-pad">
                <div class="dash-form-grid">
                  ${textField("facebook", "Facebook", val(m.facebook), { type: "url", maxlength: 200 })}
                  ${textField("instagram", "Instagram", val(m.instagram), { type: "url", maxlength: 200 })}
                  ${textField("twitter", "X / Twitter", val(m.twitter), { type: "url", maxlength: 200 })}
                  ${textField("youtube", "YouTube", val(m.youtube), { type: "url", maxlength: 200 })}
                  ${textField("linkedin", "LinkedIn", val(m.linkedin), { type: "url", maxlength: 200 })}
                  ${textField("tiktok", "TikTok", val(m.tiktok), { type: "url", maxlength: 200 })}
                </div>
              </div>
            </section>
          </div>

          <aside class="dash-mi-preview-rail">
            <section class="dash-card">
              <div class="dash-card-head"><h3>Public visibility</h3><span class="hint">What visitors see</span></div>
              <div class="dash-card-pad">
                ${toggleRow("show_address", "Show the address", isOn(m.show_address))}
                ${toggleRow("show_map", "Show the map link", isOn(m.show_map))}
                ${toggleRow("show_phone", "Show the phone number", isOn(m.show_phone))}
                ${toggleRow("show_alt_phone", "Show the alternative phone", isOn(m.show_alt_phone))}
                ${toggleRow("show_whatsapp", "Show WhatsApp", isOn(m.show_whatsapp))}
                ${toggleRow("show_email", "Show the official email", isOn(m.show_email))}
                ${toggleRow("show_admissions_email", "Show the admissions email", isOn(m.show_admissions_email))}
                ${toggleRow("show_hours", "Show opening hours", isOn(m.show_hours))}
                ${toggleRow("show_socials", "Show social media links", isOn(m.show_socials))}
                ${toggleRow("show_head", "Show the principal / head", isOn(m.show_head))}
                ${toggleRow("show_emergency", "Show the emergency contact", isOn(m.show_emergency))}
                <hr class="dash-rule">
                ${toggleRow("contact_form_enabled", "Enable the public contact form", isOn(m.contact_form_enabled))}
                <p class="dash-field-hint">Messages from the contact form arrive as admission enquiries in Admissions → Applications.</p>
              </div>
            </section>
          </aside>
        </div>

        <div class="dash-mi-actionbar">
          <button class="dash-btn dash-btn-primary" type="submit" id="miContactSave">${icon("check")} Save contact information</button>
          <button class="dash-btn dash-btn-ghost" type="button" id="miContactReset">${icon("refresh")} Cancel changes</button>
        </div>
      </form>`;

    const form = content.querySelector("#miContactForm");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validate(form)) { toast("Please correct the highlighted fields.", "error"); return; }
      const body = readForm(form);
      body.school_days = Array.isArray(body.school_days) ? body.school_days : [];
      try {
        await saveSection("contact", body, content.querySelector("#miContactSave"));
        toast("Contact information saved.", "success");
        await renderContact(content);
      } catch (err) { toast(err.message || "Could not save the contact information.", "error"); }
    });
    content.querySelector("#miContactReset").addEventListener("click", async () => {
      const yes = await confirmAction({ title: "Discard changes?", message: "Any edits you have not saved will be lost.", confirmLabel: "Discard changes" });
      if (yes) { invalidate(); await renderContact(content); }
    });
  }

  /* ======================================================================
     8 — INSTITUTION SETTINGS
     ====================================================================== */
  async function renderSettings(content) {
    const data = await load();
    const m = data.madrasa || {};
    const o = data.options || {};
    const types = (m.category === "western" ? o.westernTypes : o.islamicTypes) || [];
    const settings = await api().get("/madrasa/settings").then((r) => r.settings || {}).catch(() => ({}));
    const grading = await api().get("/grading").catch(() => null);

    content.innerHTML = `
      ${pageHead(`${label()} Settings`, `Identity, localisation, academic defaults, communication and privacy for your ${noun()}.`)}
      ${sectionNav("settings")}
      ${tabBar([
        { id: "generalTab", label: "General" },
        { id: "localeTab", label: "Localization" },
        { id: "academicTab", label: "Academic" },
        { id: "commsTab", label: "Communication" },
        { id: "siteTab", label: "Website" },
        { id: "privacyTab", label: "Privacy" },
      ], "generalTab")}

      <form id="miSettingsForm" novalidate>
        <div class="dash-card" data-mi-panel="generalTab">
          <div class="dash-card-pad">
            <div class="dash-form-grid">
              ${textField("name_en", "Institution name", val(m.name_en), { required: true, maxlength: 160 })}
              ${selectField("institution_type", "Institution type", val(m.institution_type), types, { placeholder: "Select a type" })}
              ${textField("school_code", "School code", val(m.school_code), { maxlength: 40, hint: "Your internal short code, e.g. BMA-001." })}
              ${textField("registration_no", "Registration number", val(m.registration_no), { maxlength: 80 })}
            </div>
            <div class="dash-mi-media-grid" style="margin-top:18px;">
              ${imageSlot("logo", "Institution logo", m.logo_path, "Used on report cards, the admin workspace and your website.")}
            </div>
          </div>
        </div>

        <div class="dash-card" data-mi-panel="localeTab" hidden>
          <div class="dash-card-pad">
            <div class="dash-form-grid">
              ${textField("country", "Country", val(m.country, "Nigeria"), { maxlength: 80 })}
              ${textField("state_name", "State", val(m.state_name), { maxlength: 80 })}
              ${selectField("timezone", "Time zone", val(m.timezone, "Africa/Lagos"), o.timezones || [])}
              ${selectField("currency", "Currency", val(m.currency, "NGN"), o.currencies || [])}
              ${selectField("default_language", "Default language", val(m.default_language, "en"), o.languages || [])}
              ${selectField("date_format", "Date format", val(m.date_format, "DD/MM/YYYY"), o.dateFormats || [])}
            </div>
          </div>
        </div>

        <div class="dash-card" data-mi-panel="academicTab" hidden>
          <div class="dash-card-pad">
            <div class="dash-mi-linkgrid">
              ${settingLink("calendar", "Academic year / sessions", data.currentSession ? `Current: ${data.currentSession}` : "No current session set", "academic/sessions")}
              ${settingLink("clock", "Terms / semesters", data.currentTerm ? `Current: ${data.currentTerm}` : "Define terms for each session", "academic/terms")}
              ${settingLink("academic", "Grading system", grading ? `CA ${grading.caMax} · Exam ${grading.examMax} · Pass ${grading.passMark}%` : "Configure CA, exam and grade bands", "academic/examinations")}
              ${settingLink("users", "Attendance", "Daily registers for students and staff", "attendance/students")}
            </div>
            <hr class="dash-rule">
            <div class="dash-form-grid">
              ${textField("admission_prefix", "Admission number prefix", val(settings.admission_prefix), { maxlength: 12, hint: "Used when generating new admission numbers.", pattern: "[A-Za-z0-9-]{0,12}" })}
              ${textField("attendance_required_days", "Expected attendance days per term", val(settings.attendance_required_days), { type: "number", min: 0, max: 200, hint: "Used as the default on report cards." })}
            </div>
            <p class="dash-field-hint" style="margin-top:12px;">
              Sessions, terms, grade bands and registers stay in the Academic section so they are never configured in two places.
            </p>
          </div>
        </div>

        <div class="dash-card" data-mi-panel="commsTab" hidden>
          <div class="dash-card-pad">
            <div class="dash-form-grid">
              ${textField("notification_email", "Notification email", val(settings.notification_email), { type: "email", maxlength: 120 })}
              ${textField("sms_sender_id", "SMS sender ID", val(settings.sms_sender_id), { maxlength: 20, hint: "Shown as the sender when SMS delivery is connected." })}
              ${textField("whatsapp_number", "WhatsApp business number", val(settings.whatsapp_number || m.whatsapp), { maxlength: 60 })}
            </div>
            <hr class="dash-rule">
            ${toggleRow("notify_admissions", "Alert me about new admission applications", settings.notify_admissions === "1")}
            ${toggleRow("notify_results", "Alert me about unpublished results", settings.notify_results === "1")}
            ${toggleRow("notify_email", "Use email for administrator notifications", settings.notify_email === "1")}
            ${toggleRow("notify_sms", "Use SMS for administrator notifications", settings.notify_sms === "1")}
            ${toggleRow("notify_whatsapp", "Use WhatsApp for administrator notifications", settings.notify_whatsapp === "1")}
            <p class="dash-field-hint" style="margin-top:12px;">
              Email, SMS and WhatsApp delivery activate once the platform operator connects a provider. Your preferences are saved now and nothing claims to have been sent.
            </p>
          </div>
        </div>

        <div class="dash-card" data-mi-panel="siteTab" hidden>
          <div class="dash-card-pad">
            ${toggleRow("website_published", "Website is published", Number(m.website_published) !== 0)}
            ${toggleRow("public_listing", "Listed in the EduSphere directory", isOn(m.public_listing))}
            <hr class="dash-rule">
            <div class="dash-form-grid">
              ${textField("seo_title", "Default SEO title", val(m.seo_title), { maxlength: 160 })}
              ${textField("seo_keywords", "Default keywords", val(m.seo_keywords), { maxlength: 255 })}
              ${textAreaField("seo_description", "Default SEO description", val(m.seo_description), { rows: 3, maxlength: 320 })}
            </div>
            <div class="dash-actions" style="margin-top:14px;">
              <button class="dash-btn dash-btn-ghost dash-btn-sm" type="button" data-mi-nav="institution/website">${icon("globe")} Public website</button>
              <button class="dash-btn dash-btn-ghost dash-btn-sm" type="button" data-mi-nav="institution/appearance">${icon("image")} Appearance</button>
            </div>
          </div>
        </div>

        <div class="dash-card" data-mi-panel="privacyTab" hidden>
          <div class="dash-card-pad">
            <p class="dash-info-line" style="margin-bottom:14px;">
              Student and staff records are never public. These switches only control the summary information shown on your public website.
            </p>
            ${toggleRow("public_results", "Allow online result checking for published results", isOn(m.public_results))}
            ${toggleRow("public_admissions", "Accept online admission applications", isOn(m.public_admissions))}
            ${toggleRow("privacy_show_counts", "Show student, teacher and class counts publicly", settings.privacy_show_counts !== "0")}
            ${toggleRow("privacy_show_staff", "Show teacher names on the public website", settings.privacy_show_staff === "1")}
            <div class="dash-actions" style="margin-top:14px;">
              <button class="dash-btn dash-btn-ghost dash-btn-sm" type="button" data-mi-route="settings/roles">${icon("shield")} Roles &amp; permissions</button>
              <button class="dash-btn dash-btn-ghost dash-btn-sm" type="button" data-mi-nav="institution/contact">${icon("mail")} Contact visibility</button>
            </div>
          </div>
        </div>

        <div class="dash-mi-actionbar">
          <button class="dash-btn dash-btn-primary" type="submit" id="miSettingsSave">${icon("check")} Save settings</button>
          <button class="dash-btn dash-btn-ghost" type="button" id="miSettingsReset">${icon("refresh")} Cancel changes</button>
        </div>
      </form>`;

    bindTabs(content);
    bindImageSlots(content, () => renderSettings(content));

    const form = content.querySelector("#miSettingsForm");
    // Keys stored in the per-tenant settings table rather than on the madrasa row.
    const SETTING_KEYS = ["admission_prefix", "attendance_required_days", "notification_email", "sms_sender_id",
      "whatsapp_number", "notify_admissions", "notify_results", "notify_email", "notify_sms", "notify_whatsapp",
      "privacy_show_counts", "privacy_show_staff"];

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validate(form)) { toast("Please correct the highlighted fields.", "error"); return; }
      const all = readForm(form);
      const settingsBody = {};
      const madrasaBody = {};
      Object.entries(all).forEach(([key, value]) => {
        if (SETTING_KEYS.includes(key)) settingsBody[key] = typeof value === "boolean" ? (value ? "1" : "0") : value;
        else madrasaBody[key] = value;
      });
      const button = content.querySelector("#miSettingsSave");
      try {
        await withBusy(button, async () => {
          await api().put("/madrasa/settings", settingsBody);
          const result = await api().put("/madrasa/institution", Object.assign({ section: "settings" }, madrasaBody));
          cache.data = result;
          if (ctx.state.profile && result.madrasa) ctx.state.profile.madrasa = result.madrasa;
        });
        toast(`${label()} settings saved.`, "success");
        await renderSettings(content);
      } catch (err) { toast(err.message || "Could not save the settings.", "error"); }
    });
    content.querySelector("#miSettingsReset").addEventListener("click", async () => {
      const yes = await confirmAction({ title: "Discard changes?", message: "Any edits you have not saved will be lost.", confirmLabel: "Discard changes" });
      if (yes) { invalidate(); await renderSettings(content); }
    });
  }

  function settingLink(iconName, title, subtitle, route) {
    return `<button type="button" class="dash-mi-linkcard" data-mi-route="${esc(route)}">
      <span class="dash-mi-tile-icon">${icon(iconName)}</span>
      <span class="dash-mi-tile-body"><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></span>
      <span class="dash-mi-linkcard-chev">${icon("chev")}</span>
    </button>`;
  }

  /* ======================================================================
     Entry point
     ====================================================================== */
  const RENDERERS = {
    profile: renderProfile,
    information: renderInformation,
    website: renderWebsite,
    appearance: renderAppearance,
    pages: renderPages,
    gallery: renderGallery,
    contact: renderContact,
    settings: renderSettings,
  };

  async function render(dashboardCtx, content, route) {
    ctx = dashboardCtx;
    const key = sectionFor(route);
    const renderer = RENDERERS[key] || renderProfile;
    const section = SECTIONS.find((s) => s.key === key);
    content.innerHTML = loadingState(`Loading ${section ? section.full : "your institution"}…`);
    try {
      await renderer(content);
    } catch (e) {
      content.innerHTML = `${pageHead(section ? section.full : "My " + label(), "")}${sectionNav(key)}${errorState(e && e.message)}`;
      const retry = content.querySelector("#miRetry");
      if (retry) retry.addEventListener("click", () => { invalidate(); render(ctx, content, route); });
      bindNav(content);
      return;
    }
    bindNav(content);
  }

  function bindNav(scope) {
    scope.querySelectorAll("[data-mi-nav]").forEach((el) => el.addEventListener("click", (e) => {
      e.preventDefault();
      ctx.go(el.getAttribute("data-mi-nav"));
    }));
    scope.querySelectorAll("[data-mi-route]").forEach((el) => el.addEventListener("click", (e) => {
      e.preventDefault();
      ctx.go(el.getAttribute("data-mi-route"));
    }));
  }

  window.BelloMyInstitution = { handles, render, sectionFor, invalidate, SECTIONS };
})();
