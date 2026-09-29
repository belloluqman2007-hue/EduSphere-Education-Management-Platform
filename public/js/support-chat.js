"use strict";
/* ============================================================================
   EduSphere — CHAT & SUPPORT
   ----------------------------------------------------------------------------
   One module, two audiences, ONE design system:

     • route "support/chat"          → an authenticated institution user talking
                                       privately to EduSphere Support,
     • route "platform/conversations"→ the Super Admin working every
                                       institution's conversations.

   It renders into the same #dashContent node as every other dashboard page and
   borrows the dashboard's own helpers (icons, toasts, modals, router, escaping)
   through the context object passed to render(), exactly like
   my-institution.js — no second router, no second API client, no new palette.

   Everything here is backed by the real API:
     /api/support/chat/*        (tenant-scoped, server-enforced)
     /api/platform/conversations/*  (Super Admin only, server-enforced)
   Nothing is mocked and no conversation is invented in the browser.
   ========================================================================== */
(function () {
  const USER_ROUTE = "support/chat";
  const ADMIN_ROUTE = "platform/conversations";

  let ctx = null;         // dashboard helpers, injected by render()
  let poll = null;        // background refresh timer

  /* ------------------------------ module state ------------------------- */
  const state = {
    admin: false,
    meta: null,
    conversations: [],
    total: 0,
    counts: {},
    institutions: [],
    selectedId: null,
    conversation: null,
    messages: [],
    attachments: [],
    hasMore: false,
    loadingList: true,
    loadingThread: false,
    sending: false,
    listError: "",
    filters: { q: "", status: "", priority: "", category: "", madrasaId: "" },
    mobileView: "list",   // "list" | "thread"
    detailsOpen: false,   // details drawer on small screens
    pendingFile: null,
  };

  function handles(route) {
    return route === USER_ROUTE || route === ADMIN_ROUTE;
  }

  /* ------------------------------- helpers ----------------------------- */
  const esc = (v) => (ctx ? ctx.esc(v) : String(v == null ? "" : v));
  const I = () => (ctx ? ctx.I : {});

  function apiBase() {
    return state.admin ? "/platform/conversations" : "/support/chat/conversations";
  }
  function conversationUrl(id, suffix) {
    return `${apiBase()}${state.admin ? "/" : "/"}${id}${suffix || ""}`;
  }

  function labelFor(list, value) {
    const row = (list || []).find((x) => x.value === value);
    return row ? row.label : String(value || "—").replace(/_/g, " ");
  }
  const categoryLabel = (v) => labelFor(state.meta && state.meta.categories, v);
  const priorityLabel = (v) => labelFor(state.meta && state.meta.priorities, v);
  const statusLabel = (v) => labelFor(state.meta && state.meta.statuses, v);

  /* Status and priority are communicated by TEXT first; colour only
     reinforces it (never the sole carrier of meaning). */
  function statusTone(status) {
    switch (String(status || "").toLowerCase()) {
      case "open": return "info";
      case "pending": return "warn";
      case "replied": return "ok";
      case "resolved": return "ok";
      case "closed": return "muted";
      default: return "muted";
    }
  }
  function priorityTone(priority) {
    switch (String(priority || "").toLowerCase()) {
      case "urgent": return "danger";
      case "high": return "warn";
      default: return "muted";
    }
  }
  function statusPill(status) {
    return `<span class="dash-pill ${statusTone(status)}">${esc(statusLabel(status))}</span>`;
  }
  function priorityPill(priority) {
    return `<span class="dash-pill ${priorityTone(priority)}">${esc(priorityLabel(priority))} priority</span>`;
  }

  function initials(name) {
    return String(name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
  }

  function parseDate(value) {
    if (!value) return null;
    // Both drivers hand back "YYYY-MM-DD HH:MM:SS" in UTC.
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value))
      ? String(value).replace(" ", "T") + "Z"
      : String(value);
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function fmtWhen(value) {
    const d = parseDate(value);
    if (!d) return "—";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return time;
    if (yesterday) return "Yesterday";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  function fmtFull(value) {
    const d = parseDate(value);
    if (!d) return "—";
    return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function fmtSize(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  /** Friendly message for any failed call — never a stack trace or SQL. */
  function friendly(e, fallback) {
    if (e && e.status === 401) return "Your session has ended. Please sign in again.";
    if (e && e.status === 403) return "You do not have permission to use Chat & Support.";
    if (e && e.status === 404) return "This conversation is no longer available.";
    return (e && e.message) || fallback || "Something went wrong. Please try again.";
  }

  /* ---------------------------- unread badge --------------------------- */
  /* The sidebar badge is fed by the backend-computed count; the dashboard
     shell listens for this event and repaints the nav item. */
  function publishUnread(count) {
    try {
      window.dispatchEvent(new CustomEvent("edusphere:support-unread", {
        detail: { scope: state.admin ? "platform" : "institution", count: Number(count) || 0 },
      }));
    } catch (e) { /* non-fatal */ }
  }

  /* ------------------------------- data -------------------------------- */
  async function loadMeta() {
    if (state.meta) return state.meta;
    const path = state.admin ? "/platform/conversations/meta" : "/support/chat/meta";
    state.meta = await window.API.get(path);
    return state.meta;
  }

  function listQuery() {
    const f = state.filters;
    const params = new URLSearchParams();
    if (f.q) params.set("q", f.q);
    if (f.status) params.set("status", f.status);
    if (state.admin) {
      if (f.priority) params.set("priority", f.priority);
      if (f.category) params.set("category", f.category);
      if (f.madrasaId) params.set("madrasaId", f.madrasaId);
    }
    params.set("limit", "50");
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  async function loadList(options = {}) {
    if (!options.silent) { state.loadingList = true; state.listError = ""; paintList(); }
    try {
      const data = await window.API.get(apiBase() + listQuery());
      state.conversations = data.conversations || [];
      state.total = Number(data.total || 0);
      state.counts = data.counts || {};
      if (data.institutions) state.institutions = data.institutions;
      publishUnread(data.unread);
      state.listError = "";
    } catch (e) {
      state.listError = friendly(e, "Unable to load your conversations.");
    } finally {
      state.loadingList = false;
      paintList();
      paintAdminFilters();
    }
  }

  async function openConversation(id, options = {}) {
    state.selectedId = Number(id);
    state.mobileView = "thread";
    if (!options.silent) { state.loadingThread = true; paintThread(); paintDetails(); }
    try {
      const data = await window.API.get(conversationUrl(state.selectedId));
      state.conversation = data.conversation;
      state.messages = data.messages || [];
      state.attachments = data.attachments || [];
      state.hasMore = Boolean(data.hasMore);
      // Opening a conversation marks THAT conversation's incoming messages
      // read — the server decides which ones, per message.
      try {
        const read = await window.API.patch(conversationUrl(state.selectedId, "/read"), {});
        if (read && read.marked) {
          publishUnread(read.unread);
          const row = state.conversations.find((c) => c.id === state.selectedId);
          if (row) row.unread_count = 0;
          paintList();
        }
      } catch (e) { /* reading is best-effort; the thread is already shown */ }
    } catch (e) {
      state.conversation = null;
      state.messages = [];
      state.threadError = friendly(e, "Unable to open this conversation.");
    } finally {
      state.loadingThread = false;
      paintThread();
      paintDetails();
      paintShellMode();
      scrollThreadToEnd();
    }
  }

  /* ------------------------------- shell ------------------------------- */
  function pageHead() {
    const title = state.admin ? "All Conversations" : "Support & Messages";
    const sub = state.admin
      ? "Monitor and respond to support enquiries across all institutions."
      : "Contact EduSphere Support for assistance, questions, or technical issues.";
    const crumb = state.admin ? "Platform" : "Chat & Support";
    const action = state.admin ? "" :
      `<button class="dash-btn dash-btn-primary" id="scNewBtn">${I().plus || ""} New Conversation</button>`;
    return `<div class="dash-page-head">
      <div><div class="dash-crumb">${esc(crumb)}</div><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>
      ${action ? `<div class="dash-actions">${action}</div>` : ""}
    </div>`;
  }

  function adminStats() {
    if (!state.admin) return "";
    const c = state.counts || {};
    const card = ctx.statCard;
    return `<div class="dash-stats-grid" id="scStats">
      ${card("chat", c.open || 0, "Open", c.open ? "accent" : "")}
      ${card("clock", c.pending || 0, "Pending")}
      ${card("mail", c.replied || 0, "Replied")}
      ${card("check", (c.resolved || 0) + (c.closed || 0), "Resolved / closed")}
    </div>`;
  }

  function filterBar() {
    const statuses = (state.meta && state.meta.statuses) || [];
    const priorities = (state.meta && state.meta.priorities) || [];
    const categories = (state.meta && state.meta.categories) || [];
    const opt = (rows, selected, allLabel) =>
      `<option value="">${esc(allLabel)}</option>` +
      rows.map((r) => `<option value="${esc(r.value)}"${r.value === selected ? " selected" : ""}>${esc(r.label)}</option>`).join("");
    return `
      <div class="sc-filters">
        <div class="sc-search">
          <label class="sr-only" for="scSearch">Search conversations</label>
          <span class="sc-search-icon" aria-hidden="true">${I().search || ""}</span>
          <input id="scSearch" type="search" placeholder="Search conversations..." value="${esc(state.filters.q)}" autocomplete="off">
        </div>
        <div class="sc-filter-row">
          <label class="sr-only" for="scStatus">Filter by status</label>
          <select id="scStatus">${opt(statuses, state.filters.status, "All statuses")}</select>
          ${state.admin ? `
            <label class="sr-only" for="scPriority">Filter by priority</label>
            <select id="scPriority">${opt(priorities, state.filters.priority, "All priorities")}</select>
            <label class="sr-only" for="scCategory">Filter by category</label>
            <select id="scCategory">${opt(categories, state.filters.category, "All categories")}</select>
            <label class="sr-only" for="scInstitution">Filter by institution</label>
            <select id="scInstitution"><option value="">All institutions</option>${
              state.institutions.map((m) => `<option value="${m.id}"${String(m.id) === String(state.filters.madrasaId) ? " selected" : ""}>${esc(m.name)}</option>`).join("")
            }</select>` : ""}
        </div>
      </div>`;
  }

  function shellHtml() {
    return `
      ${pageHead()}
      ${adminStats()}
      <div class="sc-layout" id="scLayout" data-view="${state.mobileView}">
        <section class="dash-card sc-list-pane" aria-label="Conversations">
          <div class="sc-list-head">${filterBar()}</div>
          <div class="sc-list" id="scList" role="list"></div>
        </section>
        <section class="dash-card sc-thread-pane" id="scThreadPane" aria-label="Conversation"></section>
        <aside class="dash-card sc-details-pane" id="scDetails" aria-label="Conversation details"></aside>
      </div>
      <div class="sc-drawer-backdrop" id="scDrawerBackdrop" hidden></div>`;
  }

  /* ------------------------------ painting ----------------------------- */
  let root = null;

  function q(sel) { return root ? root.querySelector(sel) : null; }

  function skeletonRows(n) {
    let out = "";
    for (let i = 0; i < n; i++) out += `<div class="sc-skeleton-row"><span class="sc-skeleton sc-skeleton-avatar"></span><span class="sc-skeleton-lines"><span class="sc-skeleton"></span><span class="sc-skeleton short"></span></span></div>`;
    return out;
  }

  function paintList() {
    const el = q("#scList");
    if (!el) return;
    if (state.loadingList) { el.innerHTML = skeletonRows(5); return; }
    if (state.listError) {
      el.innerHTML = `<div class="sc-empty" role="alert"><h3>Conversations unavailable</h3><p>${esc(state.listError)}</p>
        <button class="dash-btn dash-btn-ghost dash-btn-sm" id="scRetry">Try again</button></div>`;
      const retry = el.querySelector("#scRetry");
      if (retry) retry.addEventListener("click", () => loadList());
      return;
    }
    if (!state.conversations.length) {
      const filtering = state.filters.q || state.filters.status || state.filters.priority || state.filters.category || state.filters.madrasaId;
      el.innerHTML = filtering
        ? `<div class="sc-empty"><span class="dash-empty-state-icon">${I().search || ""}</span>
             <h3>No conversations found</h3><p>Try another search or filter.</p></div>`
        : (state.admin
          ? `<div class="sc-empty"><span class="dash-empty-state-icon">${I().chat || ""}</span>
               <h3>No conversations yet</h3><p>Support enquiries raised by institutions will appear here.</p></div>`
          : `<div class="sc-empty"><span class="dash-empty-state-icon">${I().chat || ""}</span>
               <h3>No conversations yet</h3><p>Need help with EduSphere?<br>Start a conversation with EduSphere Support.</p>
               <button class="dash-btn dash-btn-primary dash-btn-sm" id="scEmptyNew">${I().plus || ""} New Conversation</button></div>`);
      const btn = el.querySelector("#scEmptyNew");
      if (btn) btn.addEventListener("click", newConversationModal);
      return;
    }
    el.innerHTML = state.conversations.map((c) => {
      const unread = Number(c.unread_count || 0);
      const active = c.id === state.selectedId;
      return `<button type="button" class="sc-item${active ? " is-active" : ""}${unread ? " is-unread" : ""}"
          role="listitem" data-conversation="${c.id}" aria-current="${active ? "true" : "false"}">
        <span class="sc-item-avatar" aria-hidden="true">${esc(initials(state.admin ? c.institution_name : c.subject))}</span>
        <span class="sc-item-body">
          <span class="sc-item-top">
            <span class="sc-code">#${esc(c.conversation_code)}</span>
            <span class="sc-when">${esc(fmtWhen(c.last_message_at))}</span>
          </span>
          <span class="sc-item-subject">${esc(c.subject)}</span>
          ${state.admin ? `<span class="sc-item-inst">${esc(c.institution_name || "")}${c.created_by_name ? " · " + esc(c.created_by_name) : ""}</span>` : ""}
          <span class="sc-item-preview">${esc(c.last_message_preview || "No messages yet")}</span>
          <span class="sc-item-foot">
            ${statusPill(c.status)}
            ${c.priority && c.priority !== "normal" ? priorityPill(c.priority) : ""}
            ${unread ? `<span class="sc-unread" aria-label="${unread} unread message${unread === 1 ? "" : "s"}">${unread}</span>` : ""}
          </span>
        </span>
      </button>`;
    }).join("");
    el.querySelectorAll("[data-conversation]").forEach((btn) => {
      btn.addEventListener("click", () => openConversation(btn.getAttribute("data-conversation")));
    });
  }

  function messageHtml(m) {
    const mine = state.admin ? m.sender_side === "platform" : m.sender_side === "institution";
    const who = m.sender_side === "platform" ? (m.sender_name || "EduSphere Support") : (m.sender_name || "Institution user");
    const roleLabel = m.sender_side === "platform" ? "EduSphere Support" : String(m.sender_role || "user").replace(/_/g, " ");
    const attachments = (m.attachments || []).map((a) => `
      <a class="sc-attachment" href="${esc(window.API.url(conversationUrl(state.selectedId, `/attachments/${a.id}`)))}"
         download rel="noopener">
        ${I().file || ""}<span class="sc-attachment-name">${esc(a.file_name)}</span>
        <span class="sc-attachment-size">${esc(fmtSize(a.file_size))}</span>
      </a>`).join("");
    return `<article class="sc-msg${mine ? " is-mine" : ""}">
      <span class="sc-msg-avatar" aria-hidden="true">${esc(initials(who))}</span>
      <div class="sc-msg-bubble">
        <header class="sc-msg-head"><strong>${esc(who)}</strong><span class="sc-msg-role">${esc(roleLabel)}</span></header>
        ${m.body ? `<p class="sc-msg-body">${esc(m.body)}</p>` : ""}
        ${attachments}
        <footer class="sc-msg-foot">
          <time datetime="${esc(m.created_at)}">${esc(fmtFull(m.created_at))}</time>
          ${mine ? `<span class="sc-msg-state">${m.read_at ? "Read" : "Sent"}</span>` : ""}
        </footer>
      </div>
    </article>`;
  }

  function composerHtml() {
    const c = state.conversation;
    const closed = c && c.status === "closed";
    if (closed && !state.admin) {
      return `<div class="sc-composer sc-composer-closed"><p class="hint">This conversation is closed. Start a new conversation if you still need help.</p></div>`;
    }
    return `
      <form class="sc-composer" id="scComposer">
        <label class="sr-only" for="scMessage">Type your message</label>
        <button type="button" class="sc-icon-btn" id="scAttachBtn" aria-label="Attach a file"
                title="Attach a file (${esc(((state.meta && state.meta.attachmentTypes) || []).join(", "))})">${I().file || "+"}</button>
        <input type="file" id="scFile" class="sr-only" accept=".jpg,.jpeg,.png,.pdf,.doc,.docx">
        <textarea id="scMessage" rows="1" placeholder="Type your message..." maxlength="8000"></textarea>
        <button type="submit" class="dash-btn dash-btn-primary sc-send" id="scSend">${I().mail || ""} Send</button>
      </form>
      <div class="sc-file-chip" id="scFileChip" hidden></div>`;
  }

  function adminControls() {
    if (!state.admin || !state.conversation) return "";
    const c = state.conversation;
    const statuses = (state.meta && state.meta.statuses) || [];
    const priorities = (state.meta && state.meta.priorities) || [];
    return `<div class="sc-admin-controls">
      <label class="sr-only" for="scSetStatus">Change status</label>
      <select id="scSetStatus">${statuses.map((s) => `<option value="${esc(s.value)}"${s.value === c.status ? " selected" : ""}>${esc(s.label)}</option>`).join("")}</select>
      <label class="sr-only" for="scSetPriority">Change priority</label>
      <select id="scSetPriority">${priorities.map((p) => `<option value="${esc(p.value)}"${p.value === c.priority ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select>
    </div>`;
  }

  function userControls() {
    if (state.admin || !state.conversation) return "";
    const c = state.conversation;
    if (c.status === "closed") return "";
    return `<div class="sc-admin-controls">
      ${c.status === "resolved"
        ? `<button class="dash-btn dash-btn-ghost dash-btn-sm" data-user-status="open">Reopen</button>`
        : `<button class="dash-btn dash-btn-ghost dash-btn-sm" data-user-status="resolved">Mark resolved</button>`}
      <button class="dash-btn dash-btn-ghost dash-btn-sm" data-user-status="closed">Close</button>
    </div>`;
  }

  function paintThread() {
    const pane = q("#scThreadPane");
    if (!pane) return;
    if (state.loadingThread) {
      pane.innerHTML = `<div class="sc-thread-loading">${skeletonRows(4)}</div>`;
      return;
    }
    if (!state.conversation) {
      pane.innerHTML = state.threadError
        ? `<div class="sc-empty" role="alert"><h3>Conversation unavailable</h3><p>${esc(state.threadError)}</p></div>`
        : `<div class="sc-empty"><span class="dash-empty-state-icon">${I().chat || ""}</span>
             <h3>Select a conversation</h3><p>Choose a conversation on the left to read the messages${state.admin ? " and reply" : ""}.</p></div>`;
      return;
    }
    const c = state.conversation;
    pane.innerHTML = `
      <header class="sc-thread-head">
        <button type="button" class="sc-back" id="scBack">${I().chev || ""} Back</button>
        <div class="sc-thread-title">
          <h3>${esc(c.subject)}</h3>
          <p>#${esc(c.conversation_code)}${state.admin && c.institution_name ? " · " + esc(c.institution_name) : ""}</p>
        </div>
        <div class="sc-thread-pills">${statusPill(c.status)}${priorityPill(c.priority)}</div>
        <button type="button" class="sc-icon-btn sc-details-toggle" id="scDetailsToggle" aria-label="Conversation details">${I().shield || "i"}</button>
      </header>
      <div class="sc-thread-meta">
        <span><b>Category</b> ${esc(categoryLabel(c.category))}</span>
        <span><b>Priority</b> ${esc(priorityLabel(c.priority))}</span>
        <span><b>Created</b> ${esc(fmtFull(c.created_at))}</span>
      </div>
      ${adminControls()}${userControls()}
      <div class="sc-messages" id="scMessages" tabindex="0" role="log" aria-live="polite" aria-label="Messages">
        ${state.hasMore ? `<button type="button" class="dash-btn dash-btn-ghost dash-btn-sm sc-load-more" id="scLoadMore">Load earlier messages</button>` : ""}
        ${state.messages.map(messageHtml).join("")}
      </div>
      ${composerHtml()}`;
    bindThread(pane);
  }

  function paintDetails() {
    const pane = q("#scDetails");
    if (!pane) return;
    const c = state.conversation;
    if (!c) { pane.innerHTML = `<div class="sc-details-empty hint">Conversation details appear here once a conversation is open.</div>`; return; }
    const row = (label, value) => `<div class="sc-detail"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    pane.innerHTML = `
      <div class="dash-card-head"><h3>Conversation Details</h3>
        <button type="button" class="sc-icon-btn sc-details-close" id="scDetailsClose" aria-label="Close details">${I().close || "×"}</button>
      </div>
      <div class="dash-card-pad">
        <dl class="sc-details-list">
          ${row("ID", `#${esc(c.conversation_code)}`)}
          ${row("Subject", esc(c.subject))}
          ${row("Institution", esc(c.institution_name || "—"))}
          ${row("User", esc(c.created_by_name || "—"))}
          ${row("Category", esc(categoryLabel(c.category)))}
          ${row("Priority", priorityPill(c.priority))}
          ${row("Status", statusPill(c.status))}
          ${row("Created", esc(fmtFull(c.created_at)))}
          ${row("Last Updated", esc(fmtFull(c.last_message_at || c.updated_at)))}
          ${row("Participants", `${esc(c.created_by_name || "Institution user")}<br>EduSphere Support`)}
        </dl>
        <h4 class="sc-details-sub">Attachments</h4>
        ${state.attachments.length
          ? `<ul class="sc-details-attachments">${state.attachments.map((a) => `
              <li><a href="${esc(window.API.url(conversationUrl(c.id, `/attachments/${a.id}`)))}" download rel="noopener">
                ${I().file || ""}<span>${esc(a.file_name)}</span><small>${esc(fmtSize(a.file_size))}</small></a></li>`).join("")}</ul>`
          : `<p class="hint">No attachments on this conversation.</p>`}
      </div>`;
    const close = pane.querySelector("#scDetailsClose");
    if (close) close.addEventListener("click", () => { state.detailsOpen = false; paintShellMode(); });
  }

  function paintAdminFilters() {
    // The institution filter options arrive with the list; re-render the bar
    // only when its option set actually changed.
    const select = q("#scInstitution");
    if (!select || !state.admin) return;
    const wanted = state.institutions.map((m) => String(m.id)).join(",");
    if (select.dataset.options === wanted) return;
    select.dataset.options = wanted;
    const current = state.filters.madrasaId;
    select.innerHTML = `<option value="">All institutions</option>` +
      state.institutions.map((m) => `<option value="${m.id}"${String(m.id) === String(current) ? " selected" : ""}>${esc(m.name)}</option>`).join("");
  }

  function paintShellMode() {
    const layout = q("#scLayout");
    if (!layout) return;
    layout.setAttribute("data-view", state.mobileView);
    layout.classList.toggle("details-open", state.detailsOpen);
    const backdrop = q("#scDrawerBackdrop");
    if (backdrop) backdrop.hidden = !state.detailsOpen;
  }

  function scrollThreadToEnd() {
    const box = q("#scMessages");
    if (box) box.scrollTop = box.scrollHeight;
  }

  /* ------------------------------- actions ----------------------------- */
  function bindThread(pane) {
    const back = pane.querySelector("#scBack");
    if (back) back.addEventListener("click", () => { state.mobileView = "list"; paintShellMode(); });

    const toggle = pane.querySelector("#scDetailsToggle");
    if (toggle) toggle.addEventListener("click", () => { state.detailsOpen = !state.detailsOpen; paintShellMode(); });

    const more = pane.querySelector("#scLoadMore");
    if (more) more.addEventListener("click", loadEarlier);

    const form = pane.querySelector("#scComposer");
    if (form) {
      const textarea = form.querySelector("#scMessage");
      const fileInput = form.querySelector("#scFile");
      form.querySelector("#scAttachBtn").addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        const maxMb = (state.meta && state.meta.maxAttachmentMb) || 5;
        if (file && file.size > maxMb * 1024 * 1024) {
          ctx.toast(`The attachment is too large. The maximum size is ${maxMb} MB.`, "error");
          fileInput.value = ""; state.pendingFile = null;
        } else {
          state.pendingFile = file || null;
        }
        paintFileChip(pane);
      });
      textarea.addEventListener("input", () => {
        textarea.style.height = "auto";
        textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px";
      });
      textarea.addEventListener("keydown", (e) => {
        // Enter sends, Shift+Enter makes a new line.
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
      });
      form.addEventListener("submit", (e) => { e.preventDefault(); sendMessage(pane); });
      paintFileChip(pane);
    }

    const setStatus = pane.querySelector("#scSetStatus");
    if (setStatus) setStatus.addEventListener("change", async () => {
      try {
        await window.API.patch(conversationUrl(state.selectedId, "/status"), { status: setStatus.value });
        ctx.toast("Status updated.", "success");
        await openConversation(state.selectedId, { silent: true });
        await loadList({ silent: true });
      } catch (e) { ctx.toast(friendly(e, "Could not change the status."), "error"); }
    });
    const setPriority = pane.querySelector("#scSetPriority");
    if (setPriority) setPriority.addEventListener("change", async () => {
      try {
        await window.API.patch(conversationUrl(state.selectedId, "/priority"), { priority: setPriority.value });
        ctx.toast("Priority updated.", "success");
        await openConversation(state.selectedId, { silent: true });
        await loadList({ silent: true });
      } catch (e) { ctx.toast(friendly(e, "Could not change the priority."), "error"); }
    });
    pane.querySelectorAll("[data-user-status]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const status = btn.getAttribute("data-user-status");
        try {
          await window.API.patch(conversationUrl(state.selectedId), { status });
          ctx.toast("Conversation updated.", "success");
          await openConversation(state.selectedId, { silent: true });
          await loadList({ silent: true });
        } catch (e) { ctx.toast(friendly(e, "Could not update the conversation."), "error"); }
      });
    });
  }

  function paintFileChip(pane) {
    const chip = pane.querySelector("#scFileChip");
    if (!chip) return;
    if (!state.pendingFile) { chip.hidden = true; chip.innerHTML = ""; return; }
    chip.hidden = false;
    chip.innerHTML = `${I().file || ""}<span>${esc(state.pendingFile.name)}</span>
      <button type="button" class="sc-chip-remove" id="scChipRemove" aria-label="Remove attachment">${I().close || "×"}</button>`;
    chip.querySelector("#scChipRemove").addEventListener("click", () => {
      state.pendingFile = null;
      const input = pane.querySelector("#scFile");
      if (input) input.value = "";
      paintFileChip(pane);
    });
  }

  async function sendMessage(pane) {
    if (state.sending) return;
    const textarea = pane.querySelector("#scMessage");
    const sendBtn = pane.querySelector("#scSend");
    const body = (textarea.value || "").trim();
    if (!body && !state.pendingFile) { textarea.focus(); return; }
    state.sending = true;
    sendBtn.disabled = true;
    sendBtn.setAttribute("aria-busy", "true");
    try {
      const form = new FormData();
      form.append("message", body);
      if (state.pendingFile) form.append("attachment", state.pendingFile);
      await window.API.post(conversationUrl(state.selectedId, "/messages"), form);
      textarea.value = "";
      textarea.style.height = "auto";
      state.pendingFile = null;
      await openConversation(state.selectedId, { silent: true });
      await loadList({ silent: true });
      scrollThreadToEnd();
    } catch (e) {
      ctx.toast(friendly(e, "Unable to send your message. Please try again."), "error");
    } finally {
      state.sending = false;
      const btn = q("#scSend");
      if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); }
      const ta = q("#scMessage");
      if (ta) ta.focus();
    }
  }

  async function loadEarlier() {
    if (!state.messages.length) return;
    const oldest = state.messages[0].id;
    try {
      const data = await window.API.get(conversationUrl(state.selectedId) + `?before=${oldest}`);
      state.messages = (data.messages || []).concat(state.messages);
      state.hasMore = Boolean(data.hasMore);
      paintThread();
    } catch (e) { ctx.toast(friendly(e, "Could not load earlier messages."), "error"); }
  }

  /* -------------------------- new conversation ------------------------- */
  function newConversationModal() {
    const categories = (state.meta && state.meta.categories) || [];
    const priorities = (state.meta && state.meta.priorities) || [];
    const types = ((state.meta && state.meta.attachmentTypes) || []).join(", ");
    const maxMb = (state.meta && state.meta.maxAttachmentMb) || 5;
    const modal = ctx.openModal("New Conversation", `
      <form id="scNewForm" novalidate>
        <div class="dash-form-grid">
          <div class="dash-field" style="grid-column:1/-1">
            <label for="scnSubject">Subject <span class="req">*</span></label>
            <input id="scnSubject" name="subject" maxlength="200" required placeholder="Enter a short subject...">
          </div>
          <div class="dash-field">
            <label for="scnCategory">Category <span class="req">*</span></label>
            <select id="scnCategory" name="category" required>${categories.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join("")}</select>
          </div>
          <div class="dash-field">
            <label for="scnPriority">Priority</label>
            <select id="scnPriority" name="priority">${priorities.map((p) => `<option value="${esc(p.value)}"${p.value === "normal" ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select>
          </div>
          <div class="dash-field" style="grid-column:1/-1">
            <label for="scnMessage">Message <span class="req">*</span></label>
            <textarea id="scnMessage" name="message" rows="6" required placeholder="Describe your question or issue..."></textarea>
          </div>
          <div class="dash-field" style="grid-column:1/-1">
            <label for="scnFile">Attachment (optional)</label>
            <input id="scnFile" name="attachment" type="file" accept=".jpg,.jpeg,.png,.pdf,.doc,.docx">
            <small class="hint">Allowed: ${esc(types)} — maximum ${maxMb} MB.</small>
          </div>
        </div>
        <p class="sc-form-error" id="scnError" role="alert" hidden></p>
        <div class="dash-actions" style="margin-top:14px">
          <button class="dash-btn dash-btn-primary" type="submit" id="scnSubmit">${I().mail || ""} Send Message</button>
        </div>
      </form>`);
    const form = modal.querySelector("#scNewForm");
    const errorBox = modal.querySelector("#scnError");
    const fail = (message, field) => {
      errorBox.hidden = false;
      errorBox.textContent = message;
      if (field) { field.setAttribute("aria-invalid", "true"); field.focus(); }
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorBox.hidden = true;
      const subject = form.querySelector("#scnSubject");
      const message = form.querySelector("#scnMessage");
      const file = form.querySelector("#scnFile").files[0] || null;
      if (!subject.value.trim()) return fail("Please give the conversation a subject.", subject);
      if (!message.value.trim()) return fail("Please write your message.", message);
      if (file && file.size > maxMb * 1024 * 1024) return fail(`The attachment is too large. The maximum size is ${maxMb} MB.`, null);
      const submit = form.querySelector("#scnSubmit");
      submit.disabled = true;
      submit.setAttribute("aria-busy", "true");
      try {
        const fd = new FormData();
        fd.append("subject", subject.value.trim());
        fd.append("category", form.querySelector("#scnCategory").value);
        fd.append("priority", form.querySelector("#scnPriority").value);
        fd.append("message", message.value.trim());
        if (file) fd.append("attachment", file);
        const created = await window.API.post(apiBase(), fd);
        ctx.closeModal();
        ctx.toast("Conversation started — EduSphere Support has been notified.", "success");
        await loadList({ silent: true });
        await openConversation(created.id);
      } catch (err) {
        submit.disabled = false;
        submit.removeAttribute("aria-busy");
        fail(friendly(err, "Unable to start the conversation. Please try again."), null);
      }
    });
  }

  /* ------------------------------ polling ------------------------------ */
  /*
     EduSphere has no WebSocket/SSE layer (a single Express process serving a
     hash-routed SPA), so new replies arrive through disciplined polling
     instead of a new infrastructure dependency: every 20 seconds, only while
     the tab is visible and this page is still mounted, and the timer is torn
     down as soon as the route changes.
  */
  function startPolling() {
    stopPolling();
    poll = window.setInterval(async () => {
      if (!root || !document.body.contains(root)) { stopPolling(); return; }
      if (document.hidden || state.sending) return;
      await loadList({ silent: true });
      if (state.selectedId) {
        const before = state.messages.length;
        await openConversation(state.selectedId, { silent: true });
        if (state.messages.length > before) scrollThreadToEnd();
      }
    }, 20000);
  }
  function stopPolling() {
    if (poll) { window.clearInterval(poll); poll = null; }
  }

  /* ------------------------------- render ------------------------------ */
  async function render(dashboardCtx, content, route) {
    ctx = dashboardCtx;
    const admin = route === ADMIN_ROUTE;
    if (admin !== state.admin) {
      // Switching sides resets the view entirely (never show one side's data
      // inside the other's screen).
      Object.assign(state, {
        admin, meta: null, conversations: [], selectedId: null, conversation: null,
        messages: [], attachments: [], filters: { q: "", status: "", priority: "", category: "", madrasaId: "" },
        mobileView: "list", detailsOpen: false, pendingFile: null,
      });
    }
    state.admin = admin;
    state.threadError = "";
    root = content;
    content.innerHTML = shellHtml();

    try {
      await loadMeta();
    } catch (e) {
      content.innerHTML = pageHead() + `<div class="dash-card"><div class="dash-card-pad" role="alert">${esc(friendly(e, "Chat & Support is unavailable right now."))}</div></div>`;
      return;
    }
    // Re-paint the filter bar now that the vocabulary is known.
    const head = q(".sc-list-head");
    if (head) head.innerHTML = filterBar();
    bindShell();
    paintDetails();
    paintThread();
    await loadList();
    startPolling();
  }

  function bindShell() {
    const newBtn = q("#scNewBtn");
    if (newBtn) newBtn.addEventListener("click", newConversationModal);

    const search = q("#scSearch");
    if (search) {
      let timer = null;
      search.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.filters.q = search.value.trim(); loadList(); }, 300);
      });
    }
    const bind = (sel, key) => {
      const el = q(sel);
      if (el) el.addEventListener("change", () => { state.filters[key] = el.value; loadList(); });
    };
    bind("#scStatus", "status");
    bind("#scPriority", "priority");
    bind("#scCategory", "category");
    bind("#scInstitution", "madrasaId");

    const backdrop = q("#scDrawerBackdrop");
    if (backdrop) backdrop.addEventListener("click", () => { state.detailsOpen = false; paintShellMode(); });
  }

  window.EduSphereSupportChat = { handles, render, stopPolling, USER_ROUTE, ADMIN_ROUTE };
})();
