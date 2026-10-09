"use strict";
/* ============================================================================
   EduSphere — certificate designer (choose a design, fill a form)
   ----------------------------------------------------------------------------
   Replaces the old template editor, which was a textarea of raw HTML plus
   {{placeholders}}. That asked a school administrator to write markup, and the
   only feedback they got was a preview that broke when a tag was lost.

   The flow here is the one people expect from any modern document tool:
     1. pick a design from a gallery of real previews,
     2. type the wording into labelled boxes, ticking which facts to print,
     3. choose who signs and whether their stored signature is printed,
     4. watch the preview update while you type.

   The gallery previews are NOT hand-drawn mock-ups: each thumbnail is the
   server's own renderer on sample data, scaled into the card, so what a school
   approves at 200 px is the page that comes out of the printer at 297 mm.
   ========================================================================== */
(function () {
  const esc = (value) => String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const TYPE_LABELS = {
    graduation: "Graduation", achievement: "Achievement", completion: "Course completion",
    participation: "Participation", merit: "Merit / award", appreciation: "Appreciation", custom: "Something else",
  };

  const FIELD_HELP = {
    title: "The big line — e.g. Certificate of Achievement.",
    kicker: "The short sentence above the name.",
    body: "Plain sentences. Use the chips to insert a name, class or date; they are filled in for each student automatically.",
    award: "Optional award or honour line, shown in the highlighted badge.",
    closing: "Optional final sentence under the details.",
    footerNote: "Small print beside the certificate number.",
    watermark: "Faint word behind the certificate, e.g. Duplicate.",
  };

  function state1() { return { designs: [], tokens: [], facts: [], types: [], typeDefaults: {}, defaultBodies: {}, loaded: false }; }

  const shared = state1();

  async function loadCatalogue(API) {
    if (shared.loaded) return shared;
    const data = await API.get("/documents/certificate-designs");
    shared.designs = data.designs || [];
    shared.tokens = data.tokens || [];
    shared.facts = data.facts || [];
    shared.types = data.types || Object.keys(TYPE_LABELS);
    shared.typeDefaults = data.typeDefaults || {};
    shared.defaultBodies = data.defaultBodies || {};
    shared.loaded = true;
    return shared;
  }

  /* ------------------------------ the preview frame ---------------------------
     The server renders the exact printable page; this only scales A4 landscape
     (1123 × 794 CSS px) down into whatever box it is given.
  ---------------------------------------------------------------------------- */
  function fitPreview(stage, frame) {
    if (!stage || !frame) return;
    const width = stage.clientWidth || 620;
    const scale = width / 1123;
    frame.style.transform = `scale(${scale})`;
    stage.style.height = `${Math.round(794 * scale)}px`;
  }

  async function renderPreview(API, payload, frame, stage) {
    const csrf = await API.get("/csrf-token").then((d) => d.csrfToken).catch(() => "");
    const response = await fetch(API.url("/documents/templates/preview"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return false;
    const html = await response.text();
    frame.srcdoc = html;
    fitPreview(stage, frame);
    return true;
  }

  /* --------------------------------- gallery ---------------------------------
     Real previews in a chooseable grid. Cards are radio-like buttons so the
     keyboard and a screen reader see a selection, not a pile of pictures.
  ---------------------------------------------------------------------------- */
  function galleryHtml(designs, selectedKey) {
    return `<div class="cd-gallery" role="radiogroup" aria-label="Certificate design">
      ${designs.map((design) => `<button type="button" class="cd-card${design.key === selectedKey ? " is-selected" : ""}"
          role="radio" aria-checked="${design.key === selectedKey ? "true" : "false"}" data-design="${esc(design.key)}">
        <span class="cd-thumb" style="background:${esc(design.swatch)}">
          <iframe class="cd-thumb-frame" title="${esc(design.name)} sample" sandbox="" loading="lazy" data-preview-design="${esc(design.key)}"></iframe>
        </span>
        <span class="cd-meta">
          <strong>${esc(design.name)}</strong>
          <span class="cd-tag">${esc(design.mood)}</span>
          <small>${esc(design.tagline)}</small>
          <span class="cd-suits">${(design.suits || []).map((s) => `<em>${esc(TYPE_LABELS[s] || s)}</em>`).join("")}</span>
        </span>
        <span class="cd-tick" aria-hidden="true">✓</span>
      </button>`).join("")}
    </div>`;
  }

  async function paintGallery(API, scope, selectedKey) {
    const frames = scope.querySelectorAll("[data-preview-design]");
    // One request per visible design, issued together: the renderer is cheap
    // and the alternative (a server-side thumbnail pipeline) would need image
    // tooling the platform deliberately does not carry.
    await Promise.all(Array.prototype.slice.call(frames).map(async (frame) => {
      const key = frame.getAttribute("data-preview-design");
      try {
        const csrf = await API.get("/csrf-token").then((d) => d.csrfToken).catch(() => "");
        const response = await fetch(API.url("/documents/templates/preview"), {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify({ designKey: key, type: selectedKey === key ? "achievement" : "achievement", config: { designKey: key, type: "achievement", title: "Certificate of Achievement", body: "This recognises the outstanding effort of {{holder_name}} of {{class}} during the {{session}} academic session." } }),
        });
        if (!response.ok) return;
        frame.srcdoc = await response.text();
      } catch (e) { /* a failed thumbnail must not block the form */ }
    }));
  }

  /* -------------------------------- the editor --------------------------------
     One form. No markup box anywhere; the only free text is what a person wants
     printed on the certificate.
  ---------------------------------------------------------------------------- */
  function openDesigner(context) {
    const { API, template, onSaved, toast, openModal, closeModal } = context;
    const isNew = !template;
    const config = template && template.config ? template.config : {};
    const initialType = (config.type || (template && template.type) || "achievement");
    const initialDesign = config.designKey || (template && template.designKey) || "heritage";

    const body = `
      <div class="cd-wrap">
        <div class="cd-col cd-col-form">
          <div class="cd-section">
            <h4>1 · Choose a design</h4>
            <p class="hint">Pick the look you want. Each one is a real preview, printed exactly as shown.</p>
            <div class="cd-gallery-host" data-cd-gallery>${galleryHtml(shared.designs, initialDesign)}</div>
          </div>
          <div class="cd-section">
            <h4>2 · Say what it is for</h4>
            <div class="dash-form-grid">
              <div class="dash-field"><label>Template name <span class="req">*</span></label>
                <input data-cd="name" maxlength="160" value="${esc(template && template.name)}" placeholder="e.g. Graduation ${new Date().getFullYear()}"></div>
              <div class="dash-field"><label>Certificate kind</label>
                <select data-cd="type">${shared.types.map((type) => `<option value="${esc(type)}"${type === initialType ? " selected" : ""}>${esc(TYPE_LABELS[type] || type)}</option>`).join("")}</select>
                <small class="dash-field-hint">Chooses the default wording — you can change every word below.</small></div>
              <div class="dash-field" style="grid-column:1/-1"><label>Certificate title</label>
                <input data-cd="title" maxlength="160" value="${esc(config.title)}" placeholder="Certificate of Achievement">
                <small class="dash-field-hint">${esc(FIELD_HELP.title)}</small></div>
              <div class="dash-field" style="grid-column:1/-1"><label>Line above the name</label>
                <input data-cd="kicker" maxlength="200" value="${esc(config.kicker)}" placeholder="This is proudly presented to">
                <small class="dash-field-hint">${esc(FIELD_HELP.kicker)}</small></div>
              <div class="dash-field" style="grid-column:1/-1"><label>Main wording</label>
                <textarea data-cd="body" rows="4" maxlength="900">${esc(config.body)}</textarea>
                <div class="cd-chips" data-cd-chips>${shared.tokens.map((token) => `<button type="button" class="cd-chip" data-token="${esc(token.token)}" title="${esc(token.label)}">{{${esc(token.token)}}}</button>`).join("")}</div>
                <small class="dash-field-hint">${esc(FIELD_HELP.body)}</small>
                <small class="dash-field-hint cd-token-warning" data-cd-tokens hidden></small></div>
              <div class="dash-field"><label>Award line</label><input data-cd="award" maxlength="200" value="${esc(config.award)}"></div>
              <div class="dash-field"><label>Closing sentence</label><input data-cd="closing" maxlength="240" value="${esc(config.closing)}"></div>
            </div>
          </div>
          <div class="cd-section">
            <h4>3 · What else goes on the page</h4>
            <div class="cd-checks" data-cd-facts>
              ${shared.facts.map((fact) => `<label class="cd-check${(config.facts || []).indexOf(fact.key) >= 0 ? " is-on" : ""}">
                <input type="checkbox" value="${esc(fact.key)}"${(config.facts || []).indexOf(fact.key) >= 0 ? " checked" : ""}><span>${esc(fact.label)}</span></label>`).join("")}
            </div>
            <div class="cd-checks cd-checks-style">
              ${[["showPhoto", "Print the student's photo"], ["showQr", "Print a QR that verifies the certificate"], ["showSeal", "Print the official seal"], ["showAward", "Print the award badge"], ["showArabic", "Print the school's Arabic name"], ["showMotto", "Print the school motto"]].map(([key, label]) => `
                <label class="cd-check${config[key] !== false ? " is-on" : ""}"><input type="checkbox" data-cd-flag="${key}"${config[key] === false ? "" : " checked"}><span>${esc(label)}</span></label>`).join("")}
            </div>
            <div class="dash-form-grid" style="margin-top:12px">
              <div class="dash-field"><label>Accent colour</label>
                <span class="cd-colour"><input type="color" data-cd="accentColor" value="${esc(config.accentColor || "#14532d")}"><span>Leave as-is to use the school's own colours</span></span></div>
              <div class="dash-field"><label>Watermark (optional)</label><input data-cd="watermark" maxlength="40" value="${esc(config.watermark)}" placeholder="e.g. Duplicate"><small class="dash-field-hint">${esc(FIELD_HELP.watermark)}</small></div>
              <div class="dash-field" style="grid-column:1/-1"><label>Small print</label><input data-cd="footerNote" maxlength="200" value="${esc(config.footerNote)}" placeholder="e.g. Issued under the authority of the principal."><small class="dash-field-hint">${esc(FIELD_HELP.footerNote)}</small></div>
            </div>
          </div>
          <div class="cd-section">
            <h4>4 · Who signs it</h4>
            <p class="hint">Choose a signatory and their saved signature is printed on the line. Nobody has signed yet? Ask them to draw one under <strong>Account → My signature</strong>.</p>
            <div data-cd-signatories>${signatoryRowsHtml(config.signatories || [])}</div>
            <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-cd-add-signatory style="margin-top:10px">+ Add a signatory</button>
          </div>
        </div>
        <div class="cd-col cd-col-preview">
          <div class="cd-preview-head"><h4>Live preview</h4><span class="hint">Sample student · exactly what prints</span></div>
          <div class="cd-stage" data-cd-stage><iframe class="cd-frame" data-cd-frame title="Certificate preview" sandbox="" referrerpolicy="no-referer"></iframe></div>
          <p class="hint">A4 landscape, school colours, logo and signature included.</p>
        </div>
      </div>
      <div class="dash-actions" style="margin-top:16px">
        <button type="button" class="dash-btn dash-btn-ghost" data-cd-cancel>Cancel</button>
        ${!isNew && !(template && template.archived_at) ? '<button type="button" class="dash-btn dash-btn-danger" data-cd-archive>Archive template</button>' : ""}
        <span style="flex:1"></span>
        <button type="button" class="dash-btn dash-btn-primary" data-cd-save>${isNew ? "Save template" : "Save changes"}</button>
      </div>`;

    const modal = openModal(isNew ? "New certificate template" : "Edit certificate template", body);
    const root = modal.querySelector(".dash-modal");
    root.classList.add("cd-modal");
    const stage = modal.querySelector("[data-cd-stage]");
    const frame = modal.querySelector("[data-cd-frame]");
    const selected = { designKey: initialDesign };

    const readConfig = () => {
      const value = (key) => {
        const node = modal.querySelector(`[data-cd="${key}"]`);
        return node ? node.value.trim() : "";
      };
      const facts = Array.prototype.slice.call(modal.querySelectorAll("[data-cd-facts] input:checked")).map((input) => input.value);
      const flags = {};
      modal.querySelectorAll("[data-cd-flag]").forEach((input) => { flags[input.getAttribute("data-cd-flag")] = input.checked; });
      const signatories = Array.prototype.slice.call(modal.querySelectorAll("[data-cd-signatory]")).map((row) => ({
        label: row.querySelector("[data-sig-label]").value.trim() || "Signatory",
        name: row.querySelector("[data-sig-name]").value.trim(),
        title: row.querySelector("[data-sig-title]").value.trim(),
        userId: Number(row.querySelector("[data-sig-user]").value || 0),
        showSignature: row.querySelector("[data-sig-show]").checked,
        showDate: true,
      }));
      return Object.assign({
        designKey: selected.designKey,
        type: value("type"),
        title: value("title"),
        kicker: value("kicker"),
        body: value("body"),
        award: value("award"),
        closing: value("closing"),
        footerNote: value("footerNote"),
        watermark: value("watermark"),
        accentColor: value("accentColor"),
        facts,
        signatories,
      }, flags);
    };

    let timer = null;
    let sequence = 0;
    const schedulePreview = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++sequence;
        const ok = await renderPreview(API, { designKey: selected.designKey, type: readConfig().type, config: readConfig() }, frame, stage);
        if (!ok && mine === sequence) { /* keep the last good preview on screen */ }
      }, 380);
    };

    /* A token the renderer does not know expands to nothing, which on paper is a
       sentence with a hole in it. Warn while there is still time to fix it, and
       say which chip to use instead. */
    const ALIASES = {
      issued_date: "date", date_of_issue: "date", graduation_date: "date",
      admission_number: "identifier", student_id: "identifier", staff_id: "identifier",
      certificate_number: "reference", certificate_no: "reference", cert_no: "reference",
      student_name: "holder_name", full_name: "holder_name", name: "holder_name",
      class_name: "class", department: "class", programme: "program", course: "program",
      academic_session: "session", year: "session", grade: "result",
      school_name: "school", madrasa: "school", madrasa_name: "school",
    };
    // The catalogue is loaded once per session; before it arrives there is
    // nothing to check against, so say nothing rather than cry wolf.
    const knownTokens = new Set(shared.tokens.map((token) => token.token));
    if (!knownTokens.size) knownTokens.add("*");
    const tokenWarning = modal.querySelector("[data-cd-tokens]");
    const validateTokens = () => {
      const unknown = new Set();
      modal.querySelectorAll("[data-cd]").forEach((field) => {
        const text = String(field.value || "");
        const matches = text.match(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi) || [];
        matches.forEach((raw) => {
          const key = raw.replace(/[^a-z0-9_]/gi, "").toLowerCase();
          if (!key) return;
          // Synonyms the renderer resolves for you are not mistakes.
          const resolved = ALIASES[key] || key;
          if (knownTokens.has(resolved)) return;
          unknown.add(key);
        });
      });
      const list = Array.from(unknown);
      if (!tokenWarning) return;
      if (!list.length) { tokenWarning.hidden = true; tokenWarning.textContent = ""; return; }
      tokenWarning.hidden = false;
      tokenWarning.innerHTML = `<strong>Not filled in when printing:</strong> ${list.map((key) => `{{${esc(key)}}}`).join(", ")}. Choose one of the fields above instead.`;
    };
    validateTokens();

    modal.addEventListener("input", (event) => {
      const chipHost = event.target.closest && event.target.closest("[data-cd]");
      if (chipHost) { schedulePreview(); validateTokens(); }
      const flag = event.target.closest && event.target.closest(".cd-check");
      if (flag) flag.classList.toggle("is-on", !!flag.querySelector("input").checked);
    });
    modal.addEventListener("change", () => schedulePreview());

    // Gallery selection.
    modal.addEventListener("click", (event) => {
      const card = event.target.closest && event.target.closest("[data-design]");
      if (card) {
        selected.designKey = card.getAttribute("data-design");
        modal.querySelectorAll("[data-design]").forEach((node) => {
          const on = node === card;
          node.classList.toggle("is-selected", on);
          node.setAttribute("aria-checked", on ? "true" : "false");
        });
        schedulePreview();
        return;
      }
      const chip = event.target.closest && event.target.closest("[data-token]");
      if (chip) {
        const box = modal.querySelector("[data-cd=body]");
        const token = `{{${chip.getAttribute("data-token")}}}`;
        const start = box.selectionStart || box.value.length;
        box.value = `${box.value.slice(0, start)}${token}${box.value.slice(box.selectionEnd || start)}`;
        box.focus();
        box.selectionStart = box.selectionEnd = start + token.length;
        schedulePreview();
        return;
      }
      if (event.target.closest && event.target.closest("[data-cd-cancel]")) { closeModal(); return; }
      if (event.target.closest && event.target.closest("[data-cd-add-signatory]")) {
        modal.querySelector("[data-cd-signatories]").insertAdjacentHTML("beforeend", signatoryRowsHtml([{}], context.people));
        wireSignatoryRows(modal, context.people);
        schedulePreview();
        return;
      }
      if (event.target.closest && event.target.closest("[data-cd-remove-signatory]")) {
        const rows = modal.querySelectorAll("[data-cd-signatory]");
        if (rows.length > 1) {
          event.target.closest("[data-cd-signatory]").remove();
          schedulePreview();
        } else toast("A certificate needs at least one signatory.", "error");
        return;
      }
      if (event.target.closest && event.target.closest("[data-cd-archive]")) {
        const archive = async () => {
          if (!window.confirm("Archive this template? Certificates already issued stay printable.")) return;
          try {
            await API.patch(`/documents/templates/${template.id}`, { archived: true });
            closeModal(); toast("Certificate template archived.", "success"); onSaved();
          } catch (error) { toast(error.message || "Could not archive the template.", "error"); }
        };
        archive();
        return;
      }
      if (event.target.closest && event.target.closest("[data-cd-save]")) {
        save();
      }
    });

    window.addEventListener("resize", () => fitPreview(stage, frame));

    async function save() {
      const config = readConfig();
      if (!modal.querySelector('[data-cd="name"]').value.trim()) { toast("Give the template a name so you can find it later.", "error"); return; }
      if (!config.title) { toast("Add a title, e.g. “Certificate of Achievement”.", "error"); return; }
      if (!config.body) { toast("Write what the certificate says, then choose who signs it.", "error"); return; }
      const payload = { name: modal.querySelector('[data-cd="name"]').value.trim(), type: config.type, designKey: config.designKey, config };
      try {
        if (isNew) await API.post("/documents/templates", payload);
        else await API.patch(`/documents/templates/${template.id}`, payload);
        closeModal();
        toast(isNew ? "Certificate template saved." : "Certificate template updated.", "success");
        onSaved();
      } catch (error) { toast(error.message || "The template could not be saved.", "error"); }
    }

    function signatoryRowsHtml(rows) { return signatoryRowsMarkup(rows, context.people || []); }
    function wireSignatoryRows() { /* options are re-rendered by helper */ }

    paintThumbnails();
    schedulePreview();

    async function paintThumbnails() {
      await paintGallery(API, modal, selected.designKey);
    }
  }

  function signatoryRowsMarkup(rows, people) {
    const list = (rows && rows.length ? rows : [{ label: "Principal" }, { label: "Class Teacher" }]);
    return list.map((row, index) => signatoryRowHtml(row, people, index)).join("");
  }

  function signatoryRowHtml(row, people, index) {
    const defaults = index === 0 ? "Principal" : index === 1 ? "Class Teacher" : "Signatory";
    const options = [`<option value="0">No account — print the name only</option>`]
      .concat((people || []).map((person) => `<option value="${Number(person.id)}"${Number(row.userId) === Number(person.id) ? " selected" : ""}>${esc(person.name)}${person.hasSignature ? " · signature saved" : " · no signature yet"}</option>`));
    return `<div class="cd-signatory" data-cd-signatory>
      <div class="cd-signatory-row">
        <label class="dash-field"><label>Role on the line</label><input data-sig-label maxlength="60" value="${esc(row.label || defaults)}"></label>
        <label class="dash-field"><label>Name printed</label><input data-sig-name maxlength="120" value="${esc(row.name || "")}"></label>
        <label class="dash-field"><label>Title / designation</label><input data-sig-title maxlength="80" value="${esc(row.title || "")}"></label>
      </div>
      <div class="cd-signatory-row cd-signatory-row-2">
        <label class="dash-field"><label>Whose saved signature to print</label><select data-sig-user>${options.join("")}</select></label>
        <label class="cd-check${row.showSignature !== false ? " is-on" : ""}"><input type="checkbox" data-sig-show${row.showSignature === false ? "" : " checked"}><span>Print the signature image</span></label>
        <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-cd-remove-signatory>Remove</button>
      </div>
    </div>`;
  }

  /* ------------------------------ the issue screen ----------------------------
     Issuing used to be a multi-select list, which is fine for 3 students and
     awful for 120. The picker here filters by class and toggles the whole class,
     and per-certificate facts (term, result) live beside it.
  ---------------------------------------------------------------------------- */
  function openIssueWizard(context) {
    const { API, templates, students, classes, onDone, toast } = context;
    const active = (templates || []).filter((template) => !template.archived_at);
    if (!active.length) { toast("Create a certificate template first.", "error"); return; }
    // "Issue" from a template card arrives preselected, so nobody has to
    // remember which of six designs they meant.
    const wanted = Number(context.selectedTemplate || 0);
    const defaultTemplate = active.some((template) => Number(template.id) === wanted) ? wanted : Number(active[0].id);
    const body = `
      <div class="cd-issue">
        <div class="cd-issue-head">
          <div class="dash-field"><label>Template</label><select data-issue-template>${active.map((template) => `<option value="${Number(template.id)}"${Number(template.id) === defaultTemplate ? " selected" : ""}>${esc(template.name)} · ${esc(template.designName || TYPE_LABELS[template.type] || template.type)}</option>`).join("")}</select></div>
          <div class="dash-field"><label>Issue date</label><input type="date" data-issue-date value="${new Date().toISOString().slice(0, 10)}"></div>
        </div>
        <div class="cd-issue-pick">
          <div class="cd-issue-filter">
            <label class="dash-field"><label>Class</label><select data-issue-class><option value="">All classes</option>${(classes || []).map((klass) => `<option value="${Number(klass.id)}">${esc(klass.name_en)}</option>`).join("")}</select></label>
            <div class="cd-issue-search"><input type="search" data-issue-search placeholder="Search a name or admission number" aria-label="Search students"></div>
          </div>
          <div class="cd-issue-actions">
            <span class="hint" data-issue-count>0 selected</span>
            <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-issue-all>Select all shown</button>
            <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-issue-none>Clear</button>
          </div>
          <div class="cd-students" data-issue-students role="group" aria-label="Students to certify">
            ${(students || []).map((student) => `<label class="cd-student" data-student-row data-class="${esc(student.class_id || "")}" data-name="${esc([student.first_name, student.last_name, student.admission_no].filter(Boolean).join(" ").toLowerCase())}">
              <input type="checkbox" value="${Number(student.id)}" data-issue-student>
              <span class="cd-student-name">${esc([student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "))}</span>
              <span class="cd-student-id">${esc(student.admission_no || "")}</span>
              <span class="cd-student-class">${esc(student.class_en || student.class_name || "Unassigned")}</span>
            </label>`).join("") || '<p class="hint">No active students found.</p>'}
          </div>
        </div>
        <div class="dash-form-grid" style="margin-top:14px">
          <div class="dash-field"><label>Term (optional)</label><input data-issue-term maxlength="80" placeholder="e.g. Second Term"></div>
          <div class="dash-field"><label>Result / grade (optional)</label><input data-issue-result maxlength="80" placeholder="e.g. Distinction (82%)"></div>
          <div class="dash-field" style="grid-column:1/-1"><label>Custom line 1 (optional)</label><input data-issue-custom1 maxlength="500" placeholder="Any extra fact the wording can use as {{custom_field_1}}"></div>
        </div>
        <div class="dash-actions" style="margin-top:16px">
          <button type="button" class="dash-btn dash-btn-ghost" data-issue-cancel>Cancel</button>
          <span style="flex:1"></span>
          <button type="button" class="dash-btn dash-btn-primary" data-issue-go>Generate certificates</button>
        </div>
      </div>`;
    const modal = context.openModal("Issue certificates", body);
    const updateCount = () => {
      const picked = modal.querySelectorAll("[data-issue-student]:checked").length;
      modal.querySelector("[data-issue-count]").textContent = `${picked} selected`;
    };
    const filter = () => {
      const classId = modal.querySelector("[data-issue-class]").value;
      const query = modal.querySelector("[data-issue-search]").value.trim().toLowerCase();
      modal.querySelectorAll("[data-student-row]").forEach((row) => {
        const matchesClass = !classId || row.getAttribute("data-class") === classId;
        const matchesQuery = !query || row.getAttribute("data-name").indexOf(query) >= 0;
        row.hidden = !(matchesClass && matchesQuery);
      });
    };
    modal.addEventListener("change", (event) => {
      if (event.target.matches("[data-issue-class]")) filter();
      if (event.target.matches("[data-issue-student]")) updateCount();
    });
    modal.addEventListener("input", (event) => { if (event.target.matches("[data-issue-search]")) filter(); });
    modal.addEventListener("click", async (event) => {
      if (event.target.closest("[data-issue-cancel]")) { context.closeModal(); return; }
      if (event.target.closest("[data-issue-all]")) {
        modal.querySelectorAll("[data-student-row]:not([hidden]) [data-issue-student]").forEach((input) => { input.checked = true; });
        updateCount(); return;
      }
      if (event.target.closest("[data-issue-none]")) {
        modal.querySelectorAll("[data-issue-student]").forEach((input) => { input.checked = false; });
        updateCount(); return;
      }
      if (event.target.closest("[data-issue-go]")) {
        const ids = Array.prototype.slice.call(modal.querySelectorAll("[data-issue-student]:checked")).map((input) => Number(input.value));
        if (!ids.length) { toast("Tick at least one student.", "error"); return; }
        const button = event.target.closest("[data-issue-go]");
        button.disabled = true;
        try {
          const result = await API.post("/documents/certificates", {
            student_ids: ids,
            template_id: Number(modal.querySelector("[data-issue-template]").value),
            issued_date: modal.querySelector("[data-issue-date]").value,
            term: modal.querySelector("[data-issue-term]").value.trim(),
            result: modal.querySelector("[data-issue-result]").value.trim(),
            custom_fields: { custom_field_1: modal.querySelector("[data-issue-custom1]").value.trim() },
          });
          context.closeModal();
          toast(`${ids.length} certificate${ids.length === 1 ? "" : "s"} ready to print.`, "success");
          if (onDone) onDone(result);
        } catch (error) {
          button.disabled = false;
          toast(error.message || "The certificates could not be issued.", "error");
        }
      }
    });
    filter();
    updateCount();
  }

  window.EduCertificates = {
    FIELD_HELP,
    TYPE_LABELS,
    fitPreview,
    galleryHtml,
    loadCatalogue,
    openDesigner,
    openIssueWizard,
    renderPreview,
    signatoryRowsMarkup,
    state: shared,
  };
})();
