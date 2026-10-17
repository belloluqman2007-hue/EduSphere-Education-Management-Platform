"use strict";
/* ============================================================================
   EDUSPHERE AI — chat widget + knowledge base manager
   ----------------------------------------------------------------------------
   Two things live here:

   1. THE WIDGET. One floating launcher/panel that adapts to who is looking at
      it. A signed-in administrator talks to the assistant that can see their
      own institution (usage, plan, invoices). Anybody else — a visitor on the
      public website — gets the anonymous assistant, which can answer questions
      about plans and pricing but has access to NO institution data at all.
      The surface is chosen by the SERVER, from the session; the browser only
      ever picks which endpoint to call, never what it is allowed to see.

   2. THE KNOWLEDGE BASE MANAGER (route: platform/ai). Where the EduSphere team
      writes the answers the assistant is allowed to give. Editing this is how
      the assistant learns — no deployment required.

   Embedding elsewhere (a marketing site, a school's public page) is one line:
     <script src="/js/edusphere-ai.js"></script>
     <script>EduSphereAI.mount({ surface: "public" })</script>
   ========================================================================== */
(function () {
  const ICON = {
    spark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>`,
    send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  };

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const SUGGESTIONS = {
    app: ["What plan am I on?", "How much of my student limit have I used?", "How do I upgrade?", "When does my subscription expire?"],
    public: ["How much does EduSphere cost?", "What is the difference between Free, Basic and Premium?", "What can EduSphere do?", "How do I get started?"],
  };

  /* The AI copilot is the Premium offer made usable: four capabilities, each
     behind its own feature key. The widget asks the server what this
     institution may use, renders a chip per capability, and a locked chip opens
     the SAME upsell dialog a gated button anywhere else in the app opens. */
  const COPILOT_ORDER = ["risk_alerts", "report_comments", "questions", "analytics_qa"];

  /* ======================================================================
     WIDGET
     ====================================================================== */
  let widget = null;

  function sessionId() {
    let id = null;
    try { id = window.sessionStorage.getItem("edusphere_ai_session"); } catch (e) { /* private mode */ }
    if (!id) {
      id = "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      try { window.sessionStorage.setItem("edusphere_ai_session", id); } catch (e) { /* ignore */ }
    }
    return id;
  }

  function build(surface, opts) {
    const el = document.createElement("div");
    el.className = "ai-root";
    el.innerHTML = `
      <button class="ai-launcher" type="button" aria-expanded="false" aria-controls="aiPanel">
        ${ICON.spark}<span>Ask EduSphere AI</span>
        <span class="ai-launcher-badge" aria-hidden="true"></span>
      </button>
      <section class="ai-panel" id="aiPanel" hidden role="dialog" aria-label="EduSphere AI assistant" aria-modal="false">
        <header class="ai-panel-head">
          <div class="ai-panel-avatar">${ICON.spark}</div>
          <div>
            <div class="ai-panel-title">EduSphere AI</div>
            <div class="ai-panel-sub">${surface === "app" ? "Knows your institution" : "Ask about EduSphere"}</div>
          </div>
          <button class="ai-panel-refresh" type="button" title="Start a new conversation" aria-label="Start a new conversation">${ICON.refresh}</button>
          <button class="ai-panel-close" type="button" aria-label="Close assistant">${ICON.close}</button>
        </header>
        <div class="ai-messages" role="log" aria-live="polite" aria-atomic="false"></div>
        <div class="ai-suggestions"></div>
        <div class="ai-copilot" hidden></div>
        <form class="ai-form" autocomplete="off">
          <label class="ai-sr" for="aiInput">Message EduSphere AI</label>
          <input class="ai-input" id="aiInput" type="text" placeholder="Ask anything…" maxlength="2000">
          <button class="ai-send" type="submit" aria-label="Send">${ICON.send}</button>
        </form>
        <div class="ai-foot">EduSphere AI can be wrong about details — confirm anything important with our team.</div>
      </section>`;
    document.body.appendChild(el);

    const panel = el.querySelector(".ai-panel");
    const launcher = el.querySelector(".ai-launcher");
    const messages = el.querySelector(".ai-messages");
    const form = el.querySelector(".ai-form");
    const input = el.querySelector(".ai-input");
    const send = el.querySelector(".ai-send");

    function open() { panel.hidden = false; launcher.setAttribute("aria-expanded", "true"); input.focus(); }
    function close() { panel.hidden = true; launcher.setAttribute("aria-expanded", "false"); launcher.focus(); }
    launcher.addEventListener("click", () => (panel.hidden ? open() : close()));
    el.querySelector(".ai-panel-close").addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });

    function bubble(role, text, sources) {
      const d = document.createElement("div");
      d.className = "ai-msg " + (role === "user" ? "ai-msg-user" : "ai-msg-bot");
      d.textContent = text;
      if (sources && sources.length) {
        const s = document.createElement("div");
        s.className = "ai-msg-sources";
        s.innerHTML = `<strong>Answered from</strong><ul>${sources.slice(0, 3).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
        d.appendChild(s);
      }
      messages.appendChild(d);
      messages.scrollTop = messages.scrollHeight;
      return d;
    }

    function typing(on) {
      const t = messages.querySelector(".ai-typing");
      if (on && !t) {
        const d = document.createElement("div");
        d.className = "ai-typing";
        d.innerHTML = "<span></span><span></span><span></span>";
        messages.appendChild(d);
        messages.scrollTop = messages.scrollHeight;
      } else if (!on && t) {
        t.remove();
      }
    }

    function chips(list) {
      const box = el.querySelector(".ai-suggestions");
      box.innerHTML = "";
      list.forEach((text) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ai-chip";
        b.textContent = text;
        b.addEventListener("click", () => { input.value = text; form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true })); });
        box.appendChild(b);
      });
    }

    el.querySelector(".ai-panel-refresh").addEventListener("click", async () => {
      messages.innerHTML = "";
      if (surface === "app") { try { await window.API.post("/ai/reset", {}); } catch (e) { /* non-fatal */ } }
      greet();
    });

    function greet() {
      chips(SUGGESTIONS[surface] || SUGGESTIONS.public);
      bubble("bot", surface === "app"
        ? "Hello! I am EduSphere AI. I can see your plan, usage and invoices — ask me anything about your subscription, or how to do something in the platform."
        : "Hello! I am EduSphere AI. Ask me about EduSphere, our plans and pricing, or how to get your institution set up.");
      if (surface === "app") copilotRow();
    }

    /* --------------------------- AI copilot row -------------------------- */
    let copilotCaps = null;

    async function copilotRow() {
      let data;
      try {
        data = await window.API.get("/ai/copilot");
      } catch (e) {
        return; // no session, or the module is not mounted: chips simply absent
      }
      copilotCaps = data && Array.isArray(data.capabilities) ? data.capabilities : [];
      if (!copilotCaps.length) return;
      const box = el.querySelector(".ai-copilot");
      if (!box) return;
      box.hidden = false;
      box.innerHTML = `<span class="ai-copilot-label">AI copilot</span>` +
        copilotCaps
          .slice()
          .sort((a, b) => COPILOT_ORDER.indexOf(a.capability) - COPILOT_ORDER.indexOf(b.capability))
          .map((cap) => `
            <button type="button" class="ai-chip ai-copilot-chip ${cap.entitled ? "" : "is-locked"}"
                    data-copilot="${esc(cap.capability)}" aria-label="${esc(cap.label)}${cap.entitled ? "" : " (Premium feature)"}"
                    title="${esc(cap.blurb || "")}">
              ${esc(cap.label)}${cap.entitled ? "" : `<span class="ai-lock" aria-hidden="true">🔒</span>`}
            </button>`).join("");
      box.querySelectorAll("[data-copilot]").forEach((b) => b.addEventListener("click", () => runCopilot(b.getAttribute("data-copilot"))));
    }

    function capability(name) {
      return (copilotCaps || []).find((c) => c.capability === name) || null;
    }

    /** A locked capability is a sales moment: hand the gate to the upsell. */
    function upsellFrom(cap) {
      const gate = (cap && cap.gate) || {};
      const detail = Object.assign({ code: "feature_gated", can_upgrade: false }, gate, {
        feature: Object.assign({ key: cap ? cap.feature : "", label: cap ? cap.label : "", blurb: cap ? cap.blurb : "" }, gate.feature || {}),
        required_plan: gate.required_plan || null,
      });
      if (window.EduSphereUpsell && typeof window.EduSphereUpsell.show === "function") return window.EduSphereUpsell.show(detail);
      try { window.dispatchEvent(new CustomEvent("edusphere:feature-gated", { detail })); } catch (e) { /* no listener */ }
      return bubble("bot", (gate && gate.message) || "That capability is not included in your plan.");
    }

    async function runCopilot(name) {
      const cap = capability(name);
      if (cap && !cap.entitled) return upsellFrom(cap);
      if (name === "risk_alerts") return atRisk();
      if (name === "analytics_qa") return insights();
      if (name === "report_comments") return reportCommentsForm();
      if (name === "questions") return questionsForm();
      return undefined;
    }

    async function atRisk() {
      typing(true);
      try {
        const res = await window.API.get("/ai/copilot/at-risk");
        typing(false);
        const list = res.students || [];
        if (!list.length) return bubble("bot", "Nobody is flagged right now — no student is below the pass mark or the attendance floor this term.");
        bubble("bot", `${list.length} student${list.length === 1 ? "" : "s"} need attention${res.term ? ` (${res.term.name})` : ""} — ${res.high} high risk:\n\n` +
          list.slice(0, 6).map((s) => `• ${s.name}${s.class_name ? ` · ${s.class_name}` : ""} — ${s.reasons.join(", ")}${s.average !== null ? ` · ${s.average}%` : ""}${s.attendance_rate !== null ? ` · ${s.attendance_rate}% attendance` : ""}`).join("\n") +
          (list.length > 6 ? `\n… and ${list.length - 6} more.` : ""));
      } catch (e) {
        typing(false);
        if (e && e.data && e.data.code === "feature_gated") return upsellFrom(capability("risk_alerts"));
        bubble("bot", (e && e.message) || "Could not load the at-risk list.");
      }
      return undefined;
    }

    async function insights() {
      typing(true);
      try {
        const res = await window.API.get("/ai/copilot/insights");
        typing(false);
        const extra = Array.isArray(res.sources) && res.sources.length ? `\n\nBased on: ${res.sources.join(", ")}.` : "";
        bubble("bot", (res.answer || "No insights for this window yet.") + extra);
      } catch (e) {
        typing(false);
        if (e && e.data && e.data.code === "feature_gated") return upsellFrom(capability("analytics_qa"));
        bubble("bot", (e && e.message) || "Could not load your insights.");
      }
      return undefined;
    }

    /** A tiny inline picker inside the chat, so a draft needs one click. */
    function formBubble(label, fieldsHtml, submitLabel, onSubmit) {
      const d = document.createElement("div");
      d.className = "ai-msg ai-msg-bot ai-form-bubble";
      d.innerHTML = `<strong>${esc(label)}</strong>${fieldsHtml}
        <div class="ai-form-actions">
          <button type="button" class="ai-chip ai-chip-primary">${esc(submitLabel)}</button>
          <button type="button" class="ai-chip" data-cancel>Cancel</button>
        </div>`;
      messages.appendChild(d);
      messages.scrollTop = messages.scrollHeight;
      d.querySelector("[data-cancel]").addEventListener("click", () => d.remove());
      d.querySelector(".ai-chip-primary").addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try { await onSubmit(d); } finally { btn.disabled = false; }
      });
      return d;
    }

    async function reportCommentsForm() {
      let classes = [];
      try {
        const res = await window.API.get("/classes");
        classes = res.classes || res.rows || [];
      } catch (e) { classes = []; }
      if (!classes.length) return bubble("bot", "Add a class with students first — then I can draft its report comments.");
      formBubble("Draft report comments",
        `<label class="ai-sr" for="aiCopClass">Class</label>
         <select id="aiCopClass" class="ai-select">${classes.map((c) => `<option value="${Number(c.id)}">${esc(c.name_en || c.name || c.id)}</option>`).join("")}</select>
         <span class="ai-form-hint">Drafts only — nothing is written to a report sheet.</span>`,
        "Draft comments", async (node) => {
          const classId = Number(node.querySelector("#aiCopClass").value);
          node.remove();
          typing(true);
          try {
            const res = await window.API.post("/ai/copilot/report-comments", { class_id: classId });
            typing(false);
            bubble("bot", `${res.count} draft comment${res.count === 1 ? "" : "s"} for ${res.class.name}${res.term ? ` · ${res.term.name}` : ""} (${res.mode}). Review, then paste into Results → Report cards.`);
            (res.comments || []).forEach((c) => {
              const card = document.createElement("div");
              card.className = "ai-msg ai-msg-bot ai-draft-card";
              card.innerHTML = `<div class="ai-draft-head"><strong>${esc(c.name)}</strong>
                  <span class="ai-draft-meta">${c.average === null ? "no average" : esc(c.average) + "%"}${c.grade ? ` · ${esc(c.grade)}` : ""}${c.position ? ` · pos ${c.position}` : ""}${c.attendance_rate !== null ? ` · ${esc(c.attendance_rate)}% attendance` : ""}</span>
                </div>
                <p class="ai-draft-text">${esc(c.comment)}</p>
                <button type="button" class="ai-chip" data-copy>Copy comment</button>`;
              card.querySelector("[data-copy]").addEventListener("click", async (ev) => {
                try { await navigator.clipboard.writeText(c.comment); ev.currentTarget.textContent = "Copied"; }
                catch (err2) { ev.currentTarget.textContent = "Select and copy manually"; }
              });
              messages.appendChild(card);
            });
            messages.scrollTop = messages.scrollHeight;
          } catch (e) {
            typing(false);
            if (e && e.data && e.data.code === "feature_gated") return upsellFrom(capability("report_comments"));
            bubble("bot", (e && e.message) || "Could not draft comments.");
          }
          return undefined;
        });
      return undefined;
    }

    async function questionsForm() {
      let subjects = [];
      try {
        const res = await window.API.get("/subjects");
        subjects = res.subjects || res.rows || [];
      } catch (e) { subjects = []; }
      if (!subjects.length) return bubble("bot", "Add a subject first — then I can generate questions for it.");
      formBubble("Generate exam questions",
        `<label class="ai-sr" for="aiCopSubject">Subject</label>
         <select id="aiCopSubject" class="ai-select">${subjects.map((s) => `<option value="${Number(s.id)}">${esc(s.name_en || s.name || s.id)}</option>`).join("")}</select>
         <label class="ai-sr" for="aiCopTopic">Topic</label>
         <input id="aiCopTopic" class="ai-input ai-input-inline" type="text" maxlength="160" placeholder="Topic, e.g. Purification in Fiqh">
         <span class="ai-form-hint">Randomised from your question bank when you have one.</span>`,
        "Generate", async (node) => {
          const subjectId = Number(node.querySelector("#aiCopSubject").value);
          const topic = String(node.querySelector("#aiCopTopic").value || "").trim();
          node.remove();
          typing(true);
          try {
            const res = await window.API.post("/ai/copilot/questions", { subject_id: subjectId, topic: topic || undefined, count: 5 });
            typing(false);
            bubble("bot", `${res.count} question${res.count === 1 ? "" : "s"} for ${res.subject.name} (${res.mode}).${res.mode === "template" ? " These are scaffolds — edit them before publishing." : ""}`);
            (res.questions || []).forEach((q, i) => {
              const card = document.createElement("div");
              card.className = "ai-msg ai-msg-bot ai-draft-card";
              card.innerHTML = `<div class="ai-draft-head"><strong>Q${i + 1}</strong>
                  <span class="ai-draft-meta">${esc(q.question_type.replace(/_/g, " "))} · ${esc(q.difficulty)} · ${esc(q.marks)} marks${q.needs_review ? " · review" : ""}</span>
                </div><p class="ai-draft-text">${esc(q.question_text)}</p>`;
              messages.appendChild(card);
            });
            messages.scrollTop = messages.scrollHeight;
          } catch (e) {
            typing(false);
            if (e && e.data && e.data.code === "feature_gated") return upsellFrom(capability("questions"));
            bubble("bot", (e && e.message) || "Could not generate questions.");
          }
          return undefined;
        });
      return undefined;
    }

    async function sendMessage(text) {
      bubble("user", text);
      input.value = "";
      send.disabled = true;
      typing(true);
      try {
        const body = { message: text };
        if (surface !== "app") body.session_id = sessionId();
        const res = surface === "app"
          ? await window.API.post("/ai/chat", body)
          : await window.API.public.post("/ai/chat", body);
        typing(false);
        bubble("bot", res.reply || "I could not answer that. Please ask the EduSphere team through Chat & Support.", res.sources);
      } catch (e) {
        typing(false);
        bubble("bot", (e && e.message) ? e.message : "Sorry — I could not reach the assistant. Please try again in a moment.");
      } finally {
        send.disabled = false;
        input.focus();
      }
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      sendMessage(text);
    });

    greet();
    if (opts && opts.open) open();
    widget = { el, open, close, sendMessage };
    return widget;
  }

  /**
   * Mount the assistant.
   * @param {{surface?: "app"|"public", open?: boolean}} [options]
   *   Leave `surface` unset to auto-detect: a valid session uses the in-app
   *   assistant, otherwise the anonymous public one.
   */
  async function mount(options) {
    const opts = options || {};
    if (widget) return widget;
    let surface = opts.surface;
    if (!surface) {
      surface = "public";
      try {
        const me = await window.API.me();
        // /api/auth/me answers { loggedIn: false } for an anonymous visitor.
        if (me && me.loggedIn !== false && me.user) surface = "app";
      } catch (e) { /* not signed in → public assistant */ }
    }
    return build(surface, opts);
  }

  function unmount() {
    if (widget && widget.el && widget.el.parentNode) widget.el.parentNode.removeChild(widget.el);
    widget = null;
  }

  /* ======================================================================
     KNOWLEDGE BASE MANAGER  (route: platform/ai)
     ====================================================================== */
  const ADMIN_ROUTES = new Set(["platform/ai"]);
  function handles(route) { return ADMIN_ROUTES.has(route); }

  const SCOPES = ["public", "app", "whatsapp", "all"];

  async function render(ctx, content, route) {
    const { I, esc: e2, toast, openModal, closeModal, bindRouteButtons } = ctx;
    let data;
    try {
      data = await window.API.get("/platform/ai/knowledge");
    } catch (err) {
      content.innerHTML = `<div class="dash-page-head"><div><div class="dash-crumb">Platform</div><h2>AI Assistant</h2></div></div>
        <div class="dash-card"><div class="dash-card-pad"><p>${e2(err.message || "Could not load the knowledge base.")}</p></div></div>`;
      return;
    }
    const entries = data.entries || [];
    const live = data.live;

    content.innerHTML = `
      <div class="dash-page-head">
        <div><div class="dash-crumb">Platform</div><h2>AI Assistant</h2>
          <p>The answers EduSphere AI is allowed to give, on the website, in the dashboard and on WhatsApp.</p></div>
        <div class="dash-actions">
          <button class="dash-btn dash-btn-primary" id="aiAdd">${I.plus} New answer</button>
        </div>
      </div>
      <div class="dash-card" style="margin-bottom:18px"><div class="dash-card-pad">
        <strong>Model status:</strong>
        <span class="dash-pill ${live ? "ok" : "warn"}">${live ? "Live" : "Knowledge base only"}</span>
        ${live ? `<span class="sub-muted"> · ${e2(data.model || "")}</span>`
               : `<span class="sub-muted"> · No AI_API_KEY is set, so the assistant answers straight from the table below. That works — it is just less conversational.</span>`}
      </div></div>
      <div class="dash-card"><div class="dash-table-wrap"><table class="dash-table">
        <thead><tr><th>Scope</th><th>Topic</th><th>Question</th><th>Answer</th><th>Status</th><th style="text-align:right"></th></tr></thead>
        <tbody>
          ${entries.length ? entries.map((k) => `
            <tr>
              <td><span class="dash-pill info">${e2(k.scope)}</span></td>
              <td>${e2(k.topic || "—")}</td>
              <td><strong>${e2(k.question)}</strong></td>
              <td style="max-width:420px"><div style="white-space:pre-wrap">${e2(String(k.answer).slice(0, 220))}${String(k.answer).length > 220 ? "…" : ""}</div></td>
              <td>${k.is_active ? `<span class="dash-pill ok">Active</span>` : `<span class="dash-pill muted">Hidden</span>`}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="dash-btn dash-btn-sm dash-btn-ghost" data-ai-edit="${k.id}">${I.edit} Edit</button>
                <button class="dash-btn dash-btn-sm dash-btn-ghost" data-ai-del="${k.id}">${I.trash} Delete</button>
              </td>
            </tr>`).join("")
            : `<tr class="dash-empty-row"><td colspan="6">No answers yet. Add the questions your team gets asked most.</td></tr>`}
        </tbody>
      </table></div></div>
    `;

    content.querySelector("#aiAdd").addEventListener("click", () => openEntryModal(null, content, ctx));
    content.querySelectorAll("[data-ai-edit]").forEach((b) => b.addEventListener("click", () => {
      const k = entries.find((x) => String(x.id) === b.getAttribute("data-ai-edit"));
      openEntryModal(k, content, ctx);
    }));
    content.querySelectorAll("[data-ai-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("Delete this answer? The assistant will stop using it immediately.")) return;
      try { await window.API.del("/platform/ai/knowledge/" + b.getAttribute("data-ai-del")); toast("Deleted.", "success"); render(ctx, content, route); }
      catch (err) { toast(err.message || "Could not delete.", "error"); }
    }));
    if (bindRouteButtons) bindRouteButtons(content);
  }

  function openEntryModal(entry, content, ctx) {
    const { esc: e2, toast, openModal, closeModal } = ctx;
    const isNew = !entry;
    const wrap = openModal(isNew ? "New answer" : "Edit answer", `
      <form id="aiKbForm">
        <div class="dash-form-grid">
          <div class="dash-field">
            <label>Where it applies</label>
            <select name="scope">${SCOPES.map((s) => `<option value="${s}" ${entry && entry.scope === s ? "selected" : ""}>${e2(s === "all" ? "Everywhere" : s)}</option>`).join("")}</select>
          </div>
          <div class="dash-field"><label>Topic</label><input name="topic" value="${e2(entry ? entry.topic : "")}" placeholder="Pricing, Limits, Setup…"></div>
          <div class="dash-field" style="grid-column:1/-1"><label>Question <span class="req">*</span></label><input name="question" required value="${e2(entry ? entry.question : "")}" placeholder="How much does EduSphere cost?"></div>
          <div class="dash-field" style="grid-column:1/-1"><label>Answer <span class="req">*</span></label><textarea name="answer" rows="6" required placeholder="The exact wording the assistant should use.">${e2(entry ? entry.answer : "")}</textarea></div>
          <div class="dash-field" style="grid-column:1/-1"><label>Keywords</label><input name="keywords" value="${e2(entry ? entry.keywords : "")}" placeholder="price cost how much naira plan"></div>
          <div class="dash-field"><label>Status</label>
            <select name="is_active">
              <option value="1" ${!entry || entry.is_active ? "selected" : ""}>Active</option>
              <option value="0" ${entry && !entry.is_active ? "selected" : ""}>Hidden</option>
            </select>
          </div>
          <div class="dash-field"><label>Sort order</label><input name="sort_order" type="number" value="${entry ? entry.sort_order : 99}"></div>
        </div>
        <div class="dash-modal-foot" style="margin:18px -22px -20px;border-top:1px solid var(--d-line);">
          <button class="dash-btn dash-btn-ghost" type="button" id="aiKbCancel">Cancel</button>
          <button class="dash-btn dash-btn-primary" type="submit">${ICON.check || ""} ${isNew ? "Add answer" : "Save"}</button>
        </div>
      </form>`);
    wrap.querySelector("#aiKbCancel").addEventListener("click", closeModal);
    wrap.querySelector("#aiKbForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const body = {
        scope: fd.get("scope"), topic: fd.get("topic"), question: fd.get("question"),
        answer: fd.get("answer"), keywords: fd.get("keywords"),
        is_active: fd.get("is_active") === "1", sort_order: Number(fd.get("sort_order") || 99),
      };
      try {
        if (isNew) await window.API.post("/platform/ai/knowledge", body);
        else await window.API.patch("/platform/ai/knowledge/" + entry.id, body);
        closeModal();
        toast(isNew ? "Answer added." : "Answer saved.", "success");
        render(ctx, content, "platform/ai");
      } catch (err) { toast(err.message || "Could not save.", "error"); }
    });
  }

  window.EduSphereAI = { mount, unmount, handles, render, ADMIN_ROUTES };
})();
