"use strict";
/* ============================================================================
   EDUSPHERE AI — chat widget + knowledge base manager
   ----------------------------------------------------------------------------
   1. THE WIDGET. One floating launcher, but SEVEN different assistants:

        public       the website — registration, plans, guides
        super_admin  the platform console
        admin        a school administrator's dashboard
        teacher      the teacher workspace
        student      the student portal
        parent       the parent portal

      The space is decided by the SERVER from the signed-in role (`/api/ai/status`)
      and never by this file. The browser only chooses between the anonymous
      endpoint and the authenticated one; it cannot claim to be the operator.
      The header, greeting, suggested questions, capabilities and the hand-off
      button all come from the server's own description of that space, so the
      widget can never drift from the prompt behind it.

   2. WHATSAPP. On the public website the panel offers "Chat on WhatsApp", and
      a second green launcher opens the same conversation directly in WhatsApp.
      Both use the number the server reports; if no number is configured the
      buttons are simply not rendered — the site never opens a dead link.

   3. THE KNOWLEDGE BASE MANAGER (route: platform/ai). Where the EduSphere team
      writes what the assistant is allowed to say, per space. The space cards
      and the scope picker come from `/api/platform/ai/spaces`.

   Embedding elsewhere is one line (CSP-safe, no inline script handler):
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
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.2 4.2L19.5 6.5"/></svg>`,
    whatsapp: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.5 14.4c-.3-.2-1.8-.9-2-1-.3-.1-.5-.2-.7.1-.2.3-.7 1-.9 1.2-.2.2-.4.2-.7.1-.3-.1-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.5-.6c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5 0-.2-.7-1.6-.9-2.2-.2-.5-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 1.7 2.7 4.2 3.7 2.5 1 2.5.7 3 .6.5 0 1.4-.6 1.6-1.2.2-.6.2-1.1.1-1.2-.1-.2-.3-.2-.6-.3z"/><path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.1-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2z"/></svg>`,
    external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></svg>`,
    info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/></svg>`,
  };

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* The server is authoritative; these are only the fallbacks used if the
     status endpoint cannot be reached (offline, or a very old deployment). */
  const FALLBACK_SPACE = {
    public: {
      key: "public",
      label: "EduSphere AI",
      subtitle: "Registration, plans & getting started",
      greeting: "Hello! I am EduSphere AI. Ask me about registering your school, our plans and prices, or how the platform works.",
      suggestions: ["How do I register my school?", "How much does EduSphere cost?", "What does EduSphere do?", "What happens after I apply?"],
      capabilities: [],
      handoff: { kind: "whatsapp", label: "Chat on WhatsApp" },
    },
    admin: {
      key: "admin",
      label: "EduSphere AI · Admin",
      subtitle: "Your institution's assistant",
      greeting: "Hello! I am EduSphere AI for your institution. Ask me about your plan, usage, students, attendance, fees — or how to do something in the dashboard.",
      suggestions: ["How is my institution doing this term?", "How much of my student limit have I used?", "How do I upgrade?", "Where do I add a student?"],
      capabilities: [],
      handoff: { kind: "support", label: "Chat & Support" },
    },
  };

  function fallbackSpace(surface) {
    if (FALLBACK_SPACE[surface]) return FALLBACK_SPACE[surface];
    return Object.assign({}, FALLBACK_SPACE.admin, {
      key: surface,
      label: surface === "super_admin" ? "EduSphere AI · Platform" : `EduSphere AI · ${surface}`,
      subtitle: "Ask me how to do something",
    });
  }

  const IS_PUBLIC = (surface) => surface === "public";
  const HAS_COPILOT = (surface) => surface === "admin" || surface === "super_admin";

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

  function roleSurface(role) {
    const r = String(role || "").toLowerCase();
    if (r === "super_admin") return "super_admin";
    if (r === "madrasa_admin" || r === "admin") return "admin";
    if (r === "teacher" || r === "student" || r === "parent") return r;
    return "public";
  }

  function build(opts) {
    const surface = opts.surface;
    const info = opts.info || {};
    const space = info.space || fallbackSpace(surface);
    const wa = info.whatsapp || {};
    const suggestions = (space.suggestions && space.suggestions.length) ? space.suggestions : fallbackSpace(surface).suggestions;
    const links = info.links || {};

    const el = document.createElement("div");
    el.className = `ai-root ai-root--${surface}`;
    el.innerHTML = `
      ${IS_PUBLIC(surface) && wa.available ? `
        <a class="ai-wa-launcher" href="${esc(wa.link)}" target="_blank" rel="noopener"
           aria-label="Chat with EduSphere on WhatsApp" title="Chat with EduSphere on WhatsApp">
          ${ICON.whatsapp}<span>WhatsApp</span>
        </a>` : ""}
      <button class="ai-launcher" type="button" aria-expanded="false" aria-controls="aiPanel">
        ${ICON.spark}<span>${IS_PUBLIC(surface) ? "Ask EduSphere" : "Ask EduSphere AI"}</span>
        <span class="ai-launcher-badge" aria-hidden="true"></span>
      </button>
      <section class="ai-panel" id="aiPanel" hidden role="dialog" aria-label="${esc(space.label)}" aria-modal="false">
        <header class="ai-panel-head">
          <div class="ai-panel-avatar">${ICON.spark}</div>
          <div class="ai-panel-heading">
            <div class="ai-panel-title">${esc(space.label)}</div>
            <div class="ai-panel-sub">${esc(space.subtitle)}</div>
          </div>
          <button class="ai-panel-refresh" type="button" title="Start a new conversation" aria-label="Start a new conversation">${ICON.refresh}</button>
          <button class="ai-panel-close" type="button" aria-label="Close assistant">${ICON.close}</button>
        </header>
        ${IS_PUBLIC(surface) && wa.available ? `
          <a class="ai-wa-cta" href="${esc(wa.link)}" target="_blank" rel="noopener">
            <span class="ai-wa-cta-icon">${ICON.whatsapp}</span>
            <span><strong>Chat on WhatsApp</strong><small>Continue with the same assistant, and a person whenever you ask.</small></span>
            ${ICON.external}
          </a>` : ""}
        <div class="ai-messages" role="log" aria-live="polite" aria-atomic="false"></div>
        <div class="ai-suggestions"></div>
        ${IS_PUBLIC(surface) ? `
          <div class="ai-action-links">
            <a href="${esc(links.register_islamic_school || "/register-madrasa")}" data-route="/register-madrasa">Register an Islamic school</a>
            <a href="${esc(links.register_western_academy || "/register-academy")}" data-route="/register-academy">Register a Western academy</a>
          </div>` : ""}
        <div class="ai-copilot" hidden></div>
        <form class="ai-form" autocomplete="off">
          <label class="ai-sr" for="aiInput">Message EduSphere AI</label>
          <input class="ai-input" id="aiInput" type="text" placeholder="Ask anything…" maxlength="2000">
          <button class="ai-send" type="submit" aria-label="Send">${ICON.send}</button>
        </form>
        <div class="ai-foot">${IS_PUBLIC(surface)
          ? "EduSphere AI answers from our own help content. Confirm anything important with our team."
          : "EduSphere AI can be wrong about details — check the screen or confirm with support before acting on a number."}</div>
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

    /** The knowledge base uses **bold** for the important phrase. The bubble
        is textContent by default, which would print the asterisks — so escape
        first, then promote the bold. Nothing else is interpreted: a URL or a
        path in an answer stays literal, and no HTML from the server or the
        model can ever be executed. */
    function format(text) {
      return esc(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    }

    function bubble(role, text, sources) {
      const d = document.createElement("div");
      d.className = "ai-msg " + (role === "user" ? "ai-msg-user" : "ai-msg-bot");
      if (role === "user") d.textContent = text;
      else d.innerHTML = format(text);
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
      if (!IS_PUBLIC(surface)) { try { await window.API.post("/ai/reset", {}); } catch (e) { /* non-fatal */ } }
      greet();
    });

    function greet() {
      chips(suggestions);
      bubble("bot", space.greeting || fallbackSpace(surface).greeting);
      if (HAS_COPILOT(surface)) copilotRow();
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
      const order = ["risk_alerts", "report_comments", "questions", "analytics_qa"];
      box.hidden = false;
      box.innerHTML = `<span class="ai-copilot-label">AI copilot</span>` +
        copilotCaps
          .slice()
          .sort((a, b) => order.indexOf(a.capability) - order.indexOf(b.capability))
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
        let res;
        if (IS_PUBLIC(surface)) {
          res = await window.API.public.post("/ai/chat", { message: text, session_id: sessionId() });
        } else {
          res = await window.API.post("/ai/chat", { message: text });
        }
        typing(false);
        bubble("bot", res.reply || fallbackReply(), res.sources);
      } catch (e) {
        typing(false);
        bubble("bot", (e && e.message) ? e.message : "Sorry — I could not reach the assistant. Please try again in a moment.");
      } finally {
        send.disabled = false;
        input.focus();
      }
    }

    function fallbackReply() {
      return IS_PUBLIC(surface)
        ? "I could not answer that here. Try asking about registration, plans or how EduSphere works — or use Chat on WhatsApp to reach our team."
        : "I could not answer that. Try rephrasing, or use Chat & Support so the EduSphere team can help.";
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      sendMessage(text);
    });

    greet();
    if (opts.open) open();
    widget = { el, open, close, sendMessage, surface, space };
    return widget;
  }

  /**
   * Mount the assistant.
   * @param {{surface?: string, open?: boolean}} [options]
   *   Leave `surface` unset to let the SERVER decide from the session.
   */
  async function mount(options) {
    const opts = Object.assign({}, options || {});
    if (widget) return widget;

    let me = null;
    try { me = await window.API.me(); } catch (e) { me = null; }
    const loggedIn = Boolean(me && me.loggedIn !== false && me.user);
    let surface = opts.surface || (loggedIn ? roleSurface(me.role || (me.user && me.user.role)) : "public");

    let info = null;
    try {
      info = loggedIn ? await window.API.get("/ai/status") : await window.API.public.get("/ai/info");
    } catch (e) { info = null; }
    // The server's answer wins: it read the role from the session.
    if (info && info.surface) surface = info.surface;

    return build({ surface, info: info || {}, open: opts.open });
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

  const FALLBACK_SPACES = [
    { key: "public", label: "Public website", audience: "Visitors — no account", scopes: ["public", "all"] },
    { key: "super_admin", label: "Platform console", audience: "EduSphere operator", scopes: ["super_admin", "all"] },
    { key: "admin", label: "School dashboard", audience: "Institution administrator", scopes: ["admin", "all"] },
    { key: "teacher", label: "Teacher workspace", audience: "Teachers and staff accounts", scopes: ["teacher", "all"] },
    { key: "student", label: "Student portal", audience: "Students", scopes: ["student", "all"] },
    { key: "parent", label: "Parent portal", audience: "Parents and guardians", scopes: ["parent", "all"] },
    { key: "whatsapp", label: "WhatsApp", audience: "Anyone messaging the line", scopes: ["whatsapp", "all"] },
  ];

  async function render(ctx, content, route) {
    const { I, esc: e2, toast } = ctx;
    let spaceData;
    let knowledge;
    let providerSettings = null;
    try {
      [spaceData, knowledge, providerSettings] = await Promise.all([
        window.API.get("/platform/ai/spaces"),
        window.API.get("/platform/ai/knowledge"),
        // Its own catch: a provider-configuration hiccup must never take the
        // knowledge table down with it.
        window.API.get("/platform/ai/settings").catch(() => null),
      ]);
    } catch (err) {
      content.innerHTML = `<div class="dash-page-head"><div><div class="dash-crumb">Platform</div><h2>AI Assistant</h2></div></div>
        <div class="dash-card"><div class="dash-card-pad"><p>${e2(err.message || "Could not load the knowledge base.")}</p></div></div>`;
      return;
    }
    const spaceList = (spaceData.spaces || []).length ? spaceData.spaces : FALLBACK_SPACES;
    const everywhere = spaceData.everywhere || { scope: "all", label: "Everywhere", answers: 0 };
    const entries = knowledge.entries || [];
    const live = spaceData.live !== undefined ? spaceData.live : knowledge.live;

    /* ---- Platform → AI Assistant: the provider card ----------------------
       The values below come from GET /platform/ai/settings. The API key is
       never part of that payload — only key_set + key_last4 — so nothing here
       can put a secret into the DOM. `resolved` is the server's answer after
       applying the env-over-DB precedence, which is what the status strip
       reports. */
    const prov = providerSettings || null;
    const provStored = (prov && prov.settings) || { provider: "none", base_url: "", model: "", enabled: true };
    const provResolved = (prov && prov.resolved) || {
      enabled: Boolean(live), model: spaceData.model || "", source: live ? "settings" : "none", key_set: false, key_last4: "",
    };
    const provPresets = (prov && prov.presets) || {};
    const provProviderKeys = Object.keys(provPresets).length
      ? Object.keys(provPresets)
      : ["openai", "groq", "openrouter", "custom", "none"];
    const provEnv = (prov && prov.env) || { locked: {} };
    const provMask = (prov && prov.mask) || "••••";
    const waLine = (prov && prov.whatsapp) || spaceData.whatsapp || null;
    const whatsappSettingsHref = "#/app/" + encodeURIComponent("platform/settings");
    const keyPlaceholder = provResolved.key_set
      ? `${provMask}${provResolved.key_last4 || ""}`
      : "Paste the key from your provider";
    const providerStatus = provResolved.enabled
      ? `Live · ${provResolved.model || "model"} · from ${provResolved.source === "env" ? "environment" : "dashboard"}`
      : provResolved.key_set
        ? "Knowledge-base only · model switched off"
        : "Knowledge-base only · no key";
    const notLiveCopy = provResolved.key_set
      ? "A key is stored, but the model is switched off below, so every space answers from the knowledge base plus live data."
      : provResolved.source === "env"
        ? "The server environment sets part of this configuration but not a usable key + base URL, so every space answers from the knowledge base below."
        : "No model is connected, so every space answers from the knowledge base below plus live data. That works — it is just less conversational.";
    const lockedEnv = ["apiKey", "baseUrl", "model"]
      .filter((k) => provEnv.locked && provEnv.locked[k])
      .map((k) => ({ apiKey: "AI_API_KEY", baseUrl: "AI_BASE_URL", model: "AI_MODEL" }[k]));
    const envNote = lockedEnv.length
      ? `<p class="hint" style="margin-top:12px">${I.info} <strong>${lockedEnv.join(", ")}</strong> ` +
        `${lockedEnv.length === 1 ? "is" : "are"} set in the server environment, so ` +
        `${lockedEnv.length === 1 ? "that value overrides" : "those values override"} this form. ` +
        "Remove the variable from .env (or the host dashboard) and restart to take control here.</p>"
      : "";
    const whatsappCopy = waLine && waLine.available
      ? `<strong>${e2(waLine.display || waLine.number)}</strong> · ` +
        (waLine.api_enabled ? "assistant answers automatically" : "link only — add the Meta credentials to answer automatically")
      : `<strong>not configured</strong> — the website hides the WhatsApp button until a number is set`;
    const providerCard = `
      <div class="dash-card" style="margin-bottom:18px"><div class="dash-card-pad">
        <div style="display:flex;gap:12px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap">
          <div>
            <strong>Model provider</strong>
            <div class="sub-muted" style="margin-top:2px">Connect an OpenAI-compatible model from here — no .env edit, no restart.</div>
          </div>
          <span class="dash-pill ${provResolved.enabled ? "ok" : "warn"}" id="aiProviderStatus">${e2(providerStatus)}</span>
          ${provResolved.enabled ? "" : `<div class="sub-muted" style="flex-basis:100%">${e2(notLiveCopy)}</div>`}
        </div>

        <form id="aiProviderForm" style="margin-top:14px" autocomplete="off">
          <div class="dash-form-grid">
            <div class="dash-field"><label for="aiProviderSelect">Provider</label>
              <select name="provider" id="aiProviderSelect">
                ${provProviderKeys.map((key) => `<option value="${e2(key)}" ${key === provStored.provider ? "selected" : ""}>${e2((provPresets[key] && provPresets[key].label) || key)}</option>`).join("")}
              </select>
              <small class="sub-muted">A preset fills the base URL and a default model. Both stay editable.</small>
            </div>
            <div class="dash-field"><label for="aiProviderBase">Base URL</label>
              <input name="base_url" id="aiProviderBase" value="${e2(provStored.base_url)}" placeholder="https://api.openai.com/v1">
            </div>
            <div class="dash-field"><label for="aiProviderModel">Model</label>
              <input name="model" id="aiProviderModel" value="${e2(provStored.model)}" placeholder="gpt-4o-mini">
            </div>
            <div class="dash-field"><label for="aiProviderKey">API key</label>
              <input name="api_key" id="aiProviderKey" type="password" autocomplete="new-password" value="" placeholder="${e2(keyPlaceholder)}">
              <small class="sub-muted">${provResolved.key_set
                ? "A key is saved. Leave this blank to keep it, or paste a new one to replace it."
                : "Stored encrypted on the server and never sent back to this page."}</small>
            </div>
          </div>
          <label class="dash-checkbox-row" style="margin-top:14px"><input type="checkbox" name="enabled" ${provStored.enabled ? "checked" : ""}> Use the model (leave unticked to answer from the knowledge base only)</label>
          <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <button type="button" class="dash-btn dash-btn-ghost" id="aiProviderTest">Test connection</button>
            <button type="submit" class="dash-btn dash-btn-primary" id="aiProviderSave">${I.check} Save &amp; apply</button>
            <span id="aiTestResult" class="sub-muted" role="status"></span>
          </div>
          ${envNote}
        </form>

        <div class="sub-muted" style="margin-top:14px;border-top:1px solid var(--d-line);padding-top:10px">
          WhatsApp line: ${whatsappCopy}
          · <a href="${whatsappSettingsHref}">Platform → Settings → WhatsApp line</a>
        </div>
      </div></div>
    `;

    content.innerHTML = `
      <div class="dash-page-head">
        <div><div class="dash-crumb">Platform</div><h2>AI Assistant</h2>
          <p>One assistant, a different job in every space. Each space reads only its own answers — a student can never be shown the administrator's instructions.</p></div>
        <div class="dash-actions">
          <button class="dash-btn dash-btn-primary" id="aiAdd">${I.plus} New answer</button>
        </div>
      </div>

      ${providerCard}

      <div class="ai-space-grid">
        ${spaceList.map((sp) => `
          <button type="button" class="ai-space-card" data-space="${e2(sp.key)}">
            <span class="ai-space-card-head"><strong>${e2(sp.label)}</strong><span class="dash-pill info">${Number(sp.answers || 0)}</span></span>
            <span class="ai-space-card-sub">${e2(sp.subtitle || "")}</span>
            <span class="ai-space-card-aud">${e2(sp.audience || "")}</span>
          </button>`).join("")}
        <button type="button" class="ai-space-card ai-space-card--all" data-space="all">
          <span class="ai-space-card-head"><strong>${e2(everywhere.label || "Everywhere")}</strong><span class="dash-pill info">${Number(everywhere.answers || 0)}</span></span>
          <span class="ai-space-card-sub">Read by every space</span>
          <span class="ai-space-card-aud">About the platform itself</span>
        </button>
      </div>

      <div class="dash-card" style="margin-top:18px"><div class="dash-card-pad ai-filter-bar">
        <label for="aiScopeFilter">Show</label>
        <select id="aiScopeFilter">
          <option value="">All spaces</option>
          ${spaceList.map((sp) => `<option value="${e2(sp.key)}">${e2(sp.label)}</option>`).join("")}
          <option value="all">Everywhere</option>
        </select>
        <span class="sub-muted">${entries.length} answer${entries.length === 1 ? "" : "s"} in total</span>
      </div></div>

      <div class="dash-card" style="margin-top:14px"><div class="dash-table-wrap"><table class="dash-table">
        <thead><tr><th>Space</th><th>Topic</th><th>Question</th><th>Answer</th><th>Status</th><th style="text-align:right"></th></tr></thead>
        <tbody id="aiKbRows">
          ${entries.length ? entries.map((k) => `
            <tr data-scope="${e2(k.scope)}">
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

    /* ---- interactions for the provider card ------------------------------ */
    const providerForm = content.querySelector("#aiProviderForm");
    if (providerForm) {
      const providerSelect = providerForm.querySelector("select[name=provider]");
      const baseField = providerForm.querySelector("input[name=base_url]");
      const modelField = providerForm.querySelector("input[name=model]");
      const testResult = content.querySelector("#aiTestResult");
      const testBtn = content.querySelector("#aiProviderTest");
      const saveBtn = content.querySelector("#aiProviderSave");

      // Picking a preset fills base URL + a sensible default model; both stay
      // editable, which is what makes "custom" a real option.
      providerSelect.addEventListener("change", () => {
        const preset = provPresets[providerSelect.value];
        if (!preset) return;
        baseField.value = preset.baseUrl || "";
        modelField.value = preset.model || "";
        // "None" is an explicit "answer from the knowledge base only".
        if (providerSelect.value === "none") {
          const toggle = providerForm.querySelector("input[name=enabled]");
          if (toggle) toggle.checked = false;
        }
      });

      const readProviderForm = () => {
        const fd = new FormData(providerForm);
        const body = {
          provider: fd.get("provider"),
          base_url: String(fd.get("base_url") || "").trim(),
          model: String(fd.get("model") || "").trim(),
          enabled: fd.get("enabled") === "on",
        };
        const key = String(fd.get("api_key") || "").trim();
        // Omitted rather than blank: the server keeps the stored key. A blank
        // field must never be read as "delete the key".
        if (key) body.api_key = key;
        return body;
      };

      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true;
        testResult.className = "sub-muted";
        testResult.textContent = "Testing…";
        try {
          const out = await window.API.post("/platform/ai/test", readProviderForm());
          if (out && out.ok) {
            testResult.className = "dash-pill ok";
            testResult.textContent = `Connected · ${out.model} · ${out.latencyMs} ms`;
          } else {
            testResult.className = "dash-pill danger";
            testResult.textContent = `Failed · ${(out && out.error) || "the provider refused the request"}`;
          }
        } catch (err) {
          testResult.className = "dash-pill danger";
          testResult.textContent = err.message || "Could not reach the test endpoint.";
        } finally {
          testBtn.disabled = false;
        }
      });

      providerForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        saveBtn.disabled = true;
        try {
          await window.API.put("/platform/ai/settings", readProviderForm());
          toast("AI settings saved — the next message uses them. No restart needed.", "success");
          render(ctx, content, route);
        } catch (err) {
          toast(err.message || "Could not save the AI settings.", "error");
          saveBtn.disabled = false;
        }
      });
    }

    const scopeFilter = content.querySelector("#aiScopeFilter");
    function applyFilter(scope) {
      content.querySelectorAll("#aiKbRows tr[data-scope]").forEach((tr) => {
        tr.hidden = Boolean(scope) && tr.getAttribute("data-scope") !== scope;
      });
      if (scopeFilter && scopeFilter.value !== scope && scope !== undefined) scopeFilter.value = scope;
    }
    scopeFilter.addEventListener("change", () => applyFilter(scopeFilter.value));

    content.querySelector("#aiAdd").addEventListener("click", () => openEntryModal(null, content, ctx, spaceList));
    content.querySelectorAll("[data-space]").forEach((b) => b.addEventListener("click", () => {
      const scope = b.getAttribute("data-space");
      applyFilter(scope);
      content.querySelector("#aiKbRows").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    content.querySelectorAll("[data-ai-edit]").forEach((b) => b.addEventListener("click", () => {
      const k = entries.find((x) => String(x.id) === b.getAttribute("data-ai-edit"));
      openEntryModal(k, content, ctx, spaceList);
    }));
    content.querySelectorAll("[data-ai-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("Delete this answer? The assistant will stop using it immediately.")) return;
      try { await window.API.del("/platform/ai/knowledge/" + b.getAttribute("data-ai-del")); toast("Deleted.", "success"); render(ctx, content, route); }
      catch (err) { toast(err.message || "Could not delete.", "error"); }
    }));
    if (ctx.bindRouteButtons) ctx.bindRouteButtons(content);
  }

  function openEntryModal(entry, content, ctx, spaceList) {
    const { esc: e2, toast, openModal, closeModal } = ctx;
    const isNew = !entry;
    const list = (spaceList || FALLBACK_SPACES).slice();
    const scopes = list.map((s) => ({ key: s.key, label: s.label })).concat([{ key: "all", label: "Everywhere" }]);
    const wrap = openModal(isNew ? "New answer" : "Edit answer", `
      <form id="aiKbForm">
        <div class="dash-form-grid">
          <div class="dash-field">
            <label>Where it applies</label>
            <select name="scope">${scopes.map((s) => `<option value="${s.key}" ${entry && entry.scope === s.key ? "selected" : (!entry && s.key === "public" ? "selected" : "")}>${e2(s.label)}</option>`).join("")}</select>
            <small class="sub-muted">The assistant only reads answers in the space it is in, plus "Everywhere".</small>
          </div>
          <div class="dash-field"><label>Topic</label><input name="topic" value="${e2(entry ? entry.topic : "")}" placeholder="Pricing, Limits, Setup…"></div>
          <div class="dash-field" style="grid-column:1/-1"><label>Question <span class="req">*</span></label><input name="question" required value="${e2(entry ? entry.question : "")}" placeholder="How do I register my school?"></div>
          <div class="dash-field" style="grid-column:1/-1"><label>Answer <span class="req">*</span></label><textarea name="answer" rows="6" required placeholder="The exact wording the assistant should use.">${e2(entry ? entry.answer : "")}</textarea></div>
          <div class="dash-field" style="grid-column:1/-1"><label>Keywords</label><input name="keywords" value="${e2(entry ? entry.keywords : "")}" placeholder="register signup application form steps"></div>
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
          <button class="dash-btn dash-btn-primary" type="submit">${ICON.check} ${isNew ? "Add answer" : "Save"}</button>
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

  window.EduSphereAI = { mount, unmount, handles, render, ADMIN_ROUTES, roleSurface };
})();
