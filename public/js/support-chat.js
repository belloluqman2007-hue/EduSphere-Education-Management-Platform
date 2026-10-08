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
     /api/support/chat/*            (tenant-scoped, server-enforced)
     /api/platform/conversations/*  (Super Admin only, server-enforced)
   Nothing is mocked and no conversation is invented in the browser.

   HOW THE SCREEN BEHAVES (the part that used to break on a phone)
   • The chat claims the viewport height left under the sticky header, so the
     MESSAGE LIST is the only thing that scrolls. On a phone that means the
     composer is always on screen — never below the fold, never behind the
     keyboard — and one pane fills the display at a time (list ⇄ thread).
   • Overlays are state-gated in CSS AND carry `hidden`, because an author
     `display` rule beats the user-agent `[hidden] { display: none }`. A
     backdrop that declares `display: block` inside `@media (max-width: …)`
     covers the viewport and eats every tap on every phone while looking
     perfectly fine on a desktop. See support-chat.css.
   • Repaints never steal the draft, the caret or the scroll position: a
     background poll that finds nothing new repaints nothing at all.
   ========================================================================== */
(function () {
  const USER_ROUTE = "support/chat";
  const ADMIN_ROUTE = "platform/conversations";

  /** Messages this close together from the same side read as one thought. */
  const GROUP_MS = 5 * 60 * 1000;
  /** Mirrors the server's 8000-character message limit. */
  const MAX_LEN = 8000;
  /** Within this many pixels of the end counts as "reading the latest". */
  const NEAR_BOTTOM_PX = 90;
  /** How often new replies are fetched while the page is open and visible. */
  const POLL_MS = 20000;

  let ctx = null;         // dashboard helpers, injected by render()
  let poll = null;        // background refresh timer
  let keyboard = null;    // visualViewport listeners, so they can be removed
  let previewUrl = null;  // blob URL of the pending image attachment
  let lastFocus = null;   // where to return focus when the details sheet closes

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
    threadError: "",
    filters: { q: "", status: "", priority: "", category: "", madrasaId: "" },
    mobileView: "list",   // "list" | "thread"
    detailsOpen: false,   // details drawer on small screens
    pendingFile: null,
    atBottom: true,       // is the reader at the latest message?
    pendingNew: 0,        // messages that arrived while they were scrolled up
    scrollTo: "",         // one-shot intent: "end" | "" (otherwise preserve)
  };

  function handles(route) {
    return route === USER_ROUTE || route === ADMIN_ROUTE;
  }

  /* ------------------------------- helpers ----------------------------- */
  const esc = (v) => (ctx ? ctx.esc(v) : String(v == null ? "" : v));
  const I = () => (ctx ? ctx.I : {});

  /* Icons the dashboard set does not carry. Same 24px grid, same stroke
     weight, same `fill: none; stroke: currentColor` contract, so they sit
     beside the existing ones without looking imported. */
  const IC = {
    send: `<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    clip: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 11.6 12 20a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg>`,
    tick: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19.5 6.5"/></svg>`,
    ticks: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m1.8 12.6 3.9 3.9L15.2 7"/><path d="m10.4 15.6 1.4 1.4L21.4 7.4"/></svg>`,
    down: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v13"/><path d="m6.5 12.5 5.5 5.5 5.5-5.5"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>`,
  };
  /** Dashboard icon when it has one, local one otherwise. */
  function icon(name) {
    return I()[name] || IC[name] || "";
  }

  function apiBase() {
    return state.admin ? "/platform/conversations" : "/support/chat/conversations";
  }
  function conversationUrl(id, suffix) {
    return `${apiBase()}/${id}${suffix || ""}`;
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
  /** Divider label between two days of the same conversation. */
  function fmtDay(d) {
    if (!d) return "";
    const now = new Date();
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(now) - startOf(d)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days > 1 && days < 7) return d.toLocaleDateString("en-GB", { weekday: "long" });
    return d.toLocaleDateString("en-GB", {
      day: "numeric", month: "short",
      year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
  }
  function fmtSize(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
  function mimeIcon(mime) {
    const t = String(mime || "").toLowerCase();
    if (t.startsWith("image/")) return icon("image");
    return icon("file");
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
      paintStats();
      paintAdminFilters();
    }
  }

  async function openConversation(id, options = {}) {
    const same = Number(id) === Number(state.selectedId);
    // A different conversation: its pending attachment is not this one's.
    if (!same) setPendingFile(null);
    state.selectedId = Number(id);
    state.mobileView = "thread";
    // An explicit open always lands on the latest message; a background poll
    // only follows the reader down when they were already there.
    if (!options.silent || options.reset) {
      state.scrollTo = "end"; state.pendingNew = 0; state.atBottom = true;
    }
    // Re-opening the thread that is already on screen must not flash a
    // skeleton over it — the reader is looking at that very conversation.
    if (!options.silent && !same) { state.loadingThread = true; paintThread(); paintDetails(); }
    const seenBefore = state.messages.map((m) => m.id);
    try {
      const data = await window.API.get(conversationUrl(state.selectedId));
      state.conversation = data.conversation;
      state.messages = data.messages || [];
      state.attachments = data.attachments || [];
      state.hasMore = Boolean(data.hasMore);
      state.threadError = "";
      if (options.silent && same && seenBefore.length) {
        const fresh = state.messages.filter((m) => !seenBefore.includes(m.id)).length;
        if (fresh > 0) {
          if (state.atBottom) state.scrollTo = "end";
          else state.pendingNew += fresh;
        }
      }
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
      `<button class="dash-btn dash-btn-primary" id="scNewBtn">${icon("plus")} New Conversation</button>`;
    return `<div class="dash-page-head">
      <div><div class="dash-crumb">${esc(crumb)}</div><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>
      ${action ? `<div class="dash-actions">${action}</div>` : ""}
    </div>`;
  }

  function statCards(c) {
    const card = ctx.statCard;
    return `
      ${card("chat", c.open || 0, "Open", c.open ? "accent" : "")}
      ${card("clock", c.pending || 0, "Pending")}
      ${card("mail", c.replied || 0, "Replied")}
      ${card("check", (c.resolved || 0) + (c.closed || 0), "Resolved / closed")}`;
  }
  function adminStats() {
    if (!state.admin) return "";
    return `<div class="dash-stats-grid" id="scStats">${statCards(state.counts || {})}</div>`;
  }
  /** The counts ride in on the list response, so the cards have to be repainted
      with it — otherwise the operator's queue totals stay at zero all session. */
  function paintStats() {
    if (!state.admin) return;
    const el = q("#scStats");
    if (!el) return;
    const c = state.counts || {};
    const sig = [c.open, c.pending, c.replied, c.resolved, c.closed].join(",");
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML = statCards(c);
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
          <span class="sc-search-icon" aria-hidden="true">${icon("search")}</span>
          <input id="scSearch" type="search" placeholder="Search conversations..." value="${esc(state.filters.q)}" autocomplete="off" enterkeyhint="search">
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
    /* `.sc-page` owns the height the chat is allowed to use and mirrors the
       pane the phone is looking at, so the page head can step aside while a
       thread is open and the drawer backdrop has a parent to be gated by. */
    return `<div class="sc-page" id="scPage" data-view="${state.mobileView}">
      ${pageHead()}
      ${adminStats()}
      <div class="sc-layout" id="scLayout" data-view="${state.mobileView}">
        <section class="dash-card sc-list-pane" aria-label="Conversations">
          <div class="sc-list-head">${filterBar()}<p class="sc-list-count" id="scListCount" hidden></p></div>
          <div class="sc-list" id="scList"></div>
        </section>
        <section class="dash-card sc-thread-pane" id="scThreadPane" aria-label="Conversation"></section>
        <aside class="dash-card sc-details-pane" id="scDetails" aria-label="Conversation details"></aside>
      </div>
      <div class="sc-drawer-backdrop" id="scDrawerBackdrop" hidden aria-hidden="true"></div>
    </div>`;
  }

  /* ------------------------------ painting ----------------------------- */
  let root = null;

  function q(sel) { return root ? root.querySelector(sel) : null; }

  function skeletonRows(n) {
    let out = "";
    for (let i = 0; i < n; i++) out += `<div class="sc-skeleton-row"><span class="sc-skeleton sc-skeleton-avatar"></span><span class="sc-skeleton-lines"><span class="sc-skeleton"></span><span class="sc-skeleton short"></span></span></div>`;
    return out;
  }

  /** Everything the queue paints, as one comparable string. */
  function listSignature() {
    if (state.loadingList) return "loading";
    if (state.listError) return "error:" + state.listError;
    if (!state.conversations.length) return "empty:" + JSON.stringify(state.filters) + (state.admin ? ":admin" : ":user");
    return state.selectedId + "|" + state.conversations.map((c) => [
      c.id, c.conversation_code, c.subject, c.status, c.priority, c.unread_count,
      c.last_message_at, c.last_message_preview, c.institution_name, c.created_by_name,
    ].join("~")).join("|");
  }

  function paintList(force) {
    const el = q("#scList");
    if (!el) return;
    const sig = listSignature();
    /* Unchanged queue → untouched DOM: nobody loses their place in the list,
       their hover, or the keyboard focus on the item they were about to open. */
    if (!force && el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    const keepTop = el.scrollTop;   // a poll must not throw the reader back up
    if (state.loadingList) { el.innerHTML = skeletonRows(5); return; }
    if (state.listError) {
      el.innerHTML = `<div class="sc-empty" role="alert"><h3>Conversations unavailable</h3><p>${esc(state.listError)}</p>
        <button class="dash-btn dash-btn-ghost dash-btn-sm" id="scRetry">Try again</button></div>`;
      const retry = el.querySelector("#scRetry");
      if (retry) retry.addEventListener("click", () => loadList());
      paintListCount();
      return;
    }
    if (!state.conversations.length) {
      const filtering = state.filters.q || state.filters.status || state.filters.priority || state.filters.category || state.filters.madrasaId;
      el.innerHTML = filtering
        ? `<div class="sc-empty"><span class="dash-empty-state-icon">${icon("search")}</span>
             <h3>No conversations found</h3><p>Try another search or filter.</p>
             <button class="dash-btn dash-btn-ghost dash-btn-sm" id="scClearFilters">Clear filters</button></div>`
        : (state.admin
          ? `<div class="sc-empty"><span class="dash-empty-state-icon">${icon("chat")}</span>
               <h3>No conversations yet</h3><p>Support enquiries raised by institutions will appear here.</p></div>`
          : `<div class="sc-empty"><span class="dash-empty-state-icon">${icon("chat")}</span>
               <h3>No conversations yet</h3><p>Need help with EduSphere?<br>Start a conversation with EduSphere Support.</p>
               <button class="dash-btn dash-btn-primary dash-btn-sm" id="scEmptyNew">${icon("plus")} New Conversation</button></div>`);
      const btn = el.querySelector("#scEmptyNew");
      if (btn) btn.addEventListener("click", newConversationModal);
      const clear = el.querySelector("#scClearFilters");
      if (clear) clear.addEventListener("click", () => {
        state.filters = { q: "", status: "", priority: "", category: "", madrasaId: "" };
        const head = q(".sc-list-head");
        if (head) head.innerHTML = filterBar() + `<p class="sc-list-count" id="scListCount" hidden></p>`;
        bindFilters();
        loadList();
      });
      paintListCount();
      return;
    }
    /* `<button>`s, not `role="listitem"` on a button: that role replaced the
       button semantics, so a screen reader announced an inert list item
       instead of something it could activate. */
    el.innerHTML = state.conversations.map((c) => {
      const unread = Number(c.unread_count || 0);
      const active = c.id === state.selectedId;
      return `<button type="button" class="sc-item${active ? " is-active" : ""}${unread ? " is-unread" : ""}"
          data-conversation="${c.id}"${active ? ` aria-current="true"` : ""}>
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
    el.scrollTop = keepTop;
    paintListCount();
  }

  function paintListCount() {
    const el = q("#scListCount");
    if (!el) return;
    const n = state.conversations.length;
    const unread = state.conversations.reduce((sum, c) => sum + Number(c.unread_count || 0), 0);
    if (!n || state.loadingList || state.listError) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = `${n} conversation${n === 1 ? "" : "s"}${unread ? ` · ${unread} unread` : ""}`;
  }

  /**
   * Groups the flat message list the way a messaging app reads: a day divider
   * where the date changes, and consecutive messages from the same side within
   * a few minutes collapsed into one run (name once, avatar on the last one).
   */
  function decorate(messages) {
    const rows = [];
    let lastDay = null;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const d = parseDate(m.created_at);
      const dayKey = d ? d.toDateString() : null;
      const showDay = Boolean(dayKey) && dayKey !== lastDay;
      if (dayKey) lastDay = dayKey;
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const pd = prev ? parseDate(prev.created_at) : null;
      const nd = next ? parseDate(next.created_at) : null;
      const near = (a, b) => a && b && Math.abs(b - a) <= GROUP_MS;
      rows.push({
        m,
        day: showDay ? fmtDay(d) : "",
        grouped: Boolean(prev) && !showDay && prev.sender_side === m.sender_side && near(pd, d),
        tail: !(Boolean(next) && next.sender_side === m.sender_side && near(d, nd)),
      });
    }
    // A run always ends at a day boundary, even one only minutes away.
    for (let i = 0; i < rows.length; i++) {
      if (rows[i + 1] && rows[i + 1].day) rows[i].tail = true;
    }
    return rows;
  }

  function messageHtml(row, isNew) {
    const m = row.m;
    const mine = state.admin ? m.sender_side === "platform" : m.sender_side === "institution";
    const who = m.sender_side === "platform" ? (m.sender_name || "EduSphere Support") : (m.sender_name || "Institution user");
    const roleLabel = m.sender_side === "platform" ? "EduSphere Support" : String(m.sender_role || "user").replace(/_/g, " ");
    const cls = ["sc-msg"];
    if (mine) cls.push("is-mine");
    if (row.grouped) cls.push("is-grouped");
    if (isNew) cls.push("is-new");
    const attachments = (m.attachments || []).map((a) => `
      <a class="sc-attachment" href="${esc(window.API.url(conversationUrl(state.selectedId, `/attachments/${a.id}`)))}"
         download rel="noopener" title="Download ${esc(a.file_name)}">
        <span class="sc-attachment-icon" aria-hidden="true">${mimeIcon(a.mime_type)}</span>
        <span class="sc-attachment-name">${esc(a.file_name)}</span>
        <span class="sc-attachment-size">${esc(fmtSize(a.file_size))}</span>
        <span class="sc-attachment-download" aria-hidden="true">${icon("download")}</span>
      </a>`).join("");
    /* Delivery state in words, with a tick to reinforce it. */
    const delivered = mine
      ? `<span class="sc-ticks${m.read_at ? " is-read" : ""}" title="${m.read_at ? "Read by EduSphere Support" : "Sent"}">
           ${m.read_at ? IC.ticks : IC.tick}<span>${m.read_at ? "Read" : "Sent"}</span></span>`
      : "";
    return `${row.day ? `<div class="sc-day"><span>${esc(row.day)}</span></div>` : ""}
    <article class="${cls.join(" ")}" data-message="${m.id}">
      <span class="sc-msg-avatar" aria-hidden="true">${row.tail ? esc(initials(who)) : ""}</span>
      <div class="sc-msg-bubble">
        ${row.grouped ? "" : `<header class="sc-msg-head"><strong>${esc(who)}</strong><span class="sc-msg-role">${esc(roleLabel)}</span></header>`}
        ${m.body ? `<p class="sc-msg-body">${esc(m.body)}</p>` : ""}
        ${attachments}
        <footer class="sc-msg-foot">
          <time datetime="${esc(m.created_at)}">${esc(fmtFull(m.created_at))}</time>
          ${delivered}
        </footer>
      </div>
    </article>`;
  }

  /** Everything below the message log: pending file, composer, keyboard hint. */
  function composerHtml() {
    const c = state.conversation;
    const closed = c && c.status === "closed";
    const types = esc(((state.meta && state.meta.attachmentTypes) || []).join(", "));
    if (closed && !state.admin) {
      return `<div class="sc-composer-wrap"><div class="sc-composer sc-composer-closed">
        <p class="hint">This conversation is closed. Start a new conversation if you still need help.</p>
      </div></div>`;
    }
    return `
      <div class="sc-composer-wrap">
        <div class="sc-file-chip" id="scFileChip" hidden></div>
        <form class="sc-composer" id="scComposer">
          <div class="sc-composer-box">
            <label class="sr-only" for="scMessage">Type your message</label>
            <button type="button" class="sc-icon-btn" id="scAttachBtn" aria-label="Attach a file"
                    title="Attach a file (${types})">${icon("clip") || icon("file")}</button>
            <input type="file" id="scFile" class="sr-only" accept=".jpg,.jpeg,.png,.pdf,.doc,.docx" tabindex="-1">
            <textarea id="scMessage" rows="1" placeholder="Type your message..." maxlength="${MAX_LEN}"
                      enterkeyhint="send" autocomplete="off"></textarea>
          </div>
          <div class="sc-composer-side">
            <span class="sc-count" id="scCount" hidden aria-live="off"></span>
            <button type="submit" class="dash-btn dash-btn-primary sc-send is-idle" id="scSend"
                    aria-label="Send message" title="Send (Enter)">
              ${IC.send}<span class="sc-send-label">Send</span>
            </button>
          </div>
        </form>
        <p class="sc-composer-hint" id="scComposerHint">Enter sends · Shift + Enter starts a new line · attachments up to ${esc(String((state.meta && state.meta.maxAttachmentMb) || 5))} MB</p>
      </div>`;
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

  /** Everything that can change in the thread, as one comparable string. */
  function threadSignature() {
    if (state.loadingThread) return `loading:${state.selectedId || 0}`;
    const c = state.conversation;
    if (!c) return `none:${state.threadError || ""}`;
    return [
      c.id, c.status, c.priority, c.subject, c.category,
      state.messages.map((m) => `${m.id}${m.read_at ? "r" : ""}`).join(","),
      state.attachments.length, state.hasMore ? 1 : 0,
    ].join("|");
  }

  /* ------------------------------- drafts -------------------------------
     A half-typed message lives in module state, NOT in the DOM. It has to
     survive a skeleton, a background poll and every repaint, and it belongs
     to the conversation it was typed in — so switching threads and coming
     back finds it exactly where it was left. (Losing a long question to a
     20-second refresh is the single worst thing a chat screen can do.)     */
  const draft = { id: null, text: "", caret: -1, height: "" };

  function saveDraft() {
    const ta = q("#scMessage");
    if (!ta) return;
    draft.id = state.selectedId;
    draft.text = ta.value;
    draft.caret = typeof ta.selectionStart === "number" ? ta.selectionStart : -1;
    draft.height = ta.style.height || "";
  }
  function applyDraft(pane) {
    const ta = pane && pane.querySelector("#scMessage");
    if (!ta) return;
    if (draft.id !== state.selectedId || !draft.text) return;
    ta.value = draft.text;
    if (draft.height) ta.style.height = draft.height; else autosize(ta);
    if (draft.caret >= 0) { try { ta.setSelectionRange(draft.caret, draft.caret); } catch (e) { /* not yet focusable */ } }
  }
  function clearDraft() { draft.id = null; draft.text = ""; draft.caret = -1; draft.height = ""; }

  /**
   * Scrolls without animating. The log opts into `scroll-behavior: smooth`,
   * which is right for a reader pressing "Latest" and wrong for a programmatic
   * restore — that one must land exactly where it aims, instantly, or opening a
   * long thread visibly flies through the whole history.
   */
  function setScroll(box, value, smooth) {
    if (!box) return;
    if (smooth) { box.scrollTop = value; return; }
    const previous = box.style.scrollBehavior;
    box.style.scrollBehavior = "auto";
    box.scrollTop = value;
    box.style.scrollBehavior = previous;
  }

  function captureScroll(pane) {
    const box = pane.querySelector("#scMessages");
    return box ? { top: box.scrollTop, height: box.scrollHeight } : null;
  }

  /** Puts the reader back on the message they were looking at, even though the
      log above it may have grown. */
  function restoreScroll(pane, kept, sameThread) {
    const box = pane.querySelector("#scMessages");
    if (!box) return;
    if (state.scrollTo === "end") scrollThreadToEnd();
    else if (sameThread && kept) setScroll(box, Math.max(0, kept.top + (box.scrollHeight - kept.height)), false);
    state.scrollTo = "";
    updateJump();
  }

  function paintThread(force) {
    const pane = q("#scThreadPane");
    if (!pane) return;
    const sig = threadSignature();
    /* Nothing changed → touch nothing. This is what keeps a background poll
       from rebuilding the screen somebody is reading, typing into, or holding
       a button on. Repainting is the expensive, destructive option; skipping
       it is the whole point of the signature. */
    if (!force && pane.dataset.sig === sig) {
      if (state.scrollTo === "end") { scrollThreadToEnd(); state.scrollTo = ""; }
      updateJump();
      return;
    }
    const kept = pane.dataset.sig ? captureScroll(pane) : null;
    if (state.loadingThread) {
      pane.innerHTML = `<div class="sc-thread-loading">${skeletonRows(4)}</div>`;
      pane.dataset.sig = sig;
      return;
    }
    if (!state.conversation) {
      pane.innerHTML = state.threadError
        ? `<div class="sc-empty" role="alert"><span class="dash-empty-state-icon">${icon("close")}</span>
             <h3>Conversation unavailable</h3><p>${esc(state.threadError)}</p>
             <button class="dash-btn dash-btn-ghost dash-btn-sm" id="scThreadBack">Back to conversations</button></div>`
        : `<div class="sc-empty"><span class="dash-empty-state-icon">${icon("chat")}</span>
             <h3>Select a conversation</h3><p>Choose a conversation on the left to read the messages${state.admin ? " and reply" : ""}.</p></div>`;
      pane.dataset.sig = sig;
      pane.removeAttribute("data-thread");
      const back = pane.querySelector("#scThreadBack");
      if (back) back.addEventListener("click", () => { state.mobileView = "list"; paintShellMode(); });
      return;
    }
    const c = state.conversation;
    /* Only messages that arrived since the last paint of THIS thread animate
       in — never the whole history when a conversation is first opened. */
    const previousMax = Number(pane.dataset.maxId || 0);
    const sameThread = pane.dataset.thread === String(c.id);
    let maxId = 0;
    const rows = decorate(state.messages);
    const body = rows.map((row) => {
      const id = Number(row.m.id || 0);
      if (id > maxId) maxId = id;
      return messageHtml(row, sameThread && previousMax > 0 && id > previousMax);
    }).join("");
    pane.innerHTML = `
      <header class="sc-thread-head">
        <button type="button" class="sc-back" id="scBack" aria-label="Back to conversations">${icon("chev")}<span>Back</span></button>
        <span class="sc-thread-avatar" aria-hidden="true">${esc(initials(state.admin ? (c.institution_name || c.subject) : "EduSphere Support"))}</span>
        <div class="sc-thread-title">
          <h3>${esc(c.subject)}</h3>
          <p>#${esc(c.conversation_code)}${state.admin && c.institution_name ? " · " + esc(c.institution_name) : ""}</p>
        </div>
        <div class="sc-thread-pills">${statusPill(c.status)}${priorityPill(c.priority)}</div>
        <button type="button" class="sc-icon-btn sc-details-toggle" id="scDetailsToggle"
                aria-label="Conversation details" aria-expanded="${state.detailsOpen ? "true" : "false"}"
                aria-controls="scDetails">${icon("shield")}</button>
      </header>
      <div class="sc-thread-meta">
        <span><b>Category</b> ${esc(categoryLabel(c.category))}</span>
        <span><b>Priority</b> ${esc(priorityLabel(c.priority))}</span>
        <span><b>Created</b> ${esc(fmtFull(c.created_at))}</span>
      </div>
      ${adminControls()}${userControls()}
      <div class="sc-thread-body">
        <div class="sc-messages" id="scMessages" tabindex="0" role="log" aria-live="polite"
             aria-relevant="additions" aria-label="Messages">
          ${state.hasMore ? `<button type="button" class="dash-btn dash-btn-ghost dash-btn-sm sc-load-more" id="scLoadMore">Load earlier messages</button>` : ""}
          ${body}
        </div>
        <button type="button" class="sc-jump" id="scJump" hidden>
          ${IC.down}<span>Latest</span><span class="sc-jump-count" id="scJumpCount" hidden></span>
        </button>
      </div>
      ${composerHtml()}`;
    pane.dataset.sig = sig;
    pane.dataset.maxId = String(maxId);
    pane.dataset.thread = String(c.id);
    bindThread(pane);
    applyDraft(pane);
    paintSendState(pane);
    restoreScroll(pane, kept, sameThread);
  }

  function paintDetails() {
    const pane = q("#scDetails");
    if (!pane) return;
    const c = state.conversation;
    if (!c) { pane.innerHTML = `<div class="sc-details-empty hint">Conversation details appear here once a conversation is open.</div>`; return; }
    const row = (label, value) => `<div class="sc-detail"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    pane.innerHTML = `
      <div class="dash-card-head"><h3>Conversation Details</h3>
        <button type="button" class="sc-icon-btn sc-details-close" id="scDetailsClose" aria-label="Close details">${icon("close")}</button>
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
                ${icon("file")}<span>${esc(a.file_name)}</span><small>${esc(fmtSize(a.file_size))}</small></a></li>`).join("")}</ul>`
          : `<p class="hint">No attachments on this conversation.</p>`}
      </div>`;
    const close = pane.querySelector("#scDetailsClose");
    if (close) close.addEventListener("click", closeDetails);
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
    const page = q("#scPage");
    if (layout) {
      layout.setAttribute("data-view", state.mobileView);
      layout.classList.toggle("details-open", state.detailsOpen);
    }
    if (page) {
      page.setAttribute("data-view", state.mobileView);
      page.classList.toggle("details-open", state.detailsOpen);
    }
    const backdrop = q("#scDrawerBackdrop");
    if (backdrop) {
      backdrop.hidden = !state.detailsOpen;
      backdrop.setAttribute("aria-hidden", state.detailsOpen ? "false" : "true");
    }
    const toggle = q("#scDetailsToggle");
    if (toggle) toggle.setAttribute("aria-expanded", state.detailsOpen ? "true" : "false");
  }

  /* ------------------------- details sheet (a11y) ----------------------- */
  /**
   * Opens the details sheet and moves focus into it. The control that opened it
   * is remembered EXPLICITLY rather than read back from `document.activeElement`
   * — on a touch screen nothing was ever focused, so there would be nowhere to
   * return to and focus would be dropped on the closed sheet.
   */
  function openDetails(opener) {
    state.detailsOpen = true;
    lastFocus = opener && document.contains(opener) ? opener : null;
    paintShellMode();
    const close = q("#scDetailsClose");
    if (close) close.focus();
  }
  function closeDetails() {
    if (!state.detailsOpen) return;
    state.detailsOpen = false;
    paintShellMode();
    const back = lastFocus && document.contains(lastFocus) ? lastFocus : q("#scDetailsToggle");
    lastFocus = null;
    if (back) { try { back.focus(); } catch (e) { /* gone */ } }
  }

  /* ------------------------------ scrolling ----------------------------- */
  function scrollThreadToEnd(smooth) {
    const box = q("#scMessages");
    if (!box) return;
    setScroll(box, box.scrollHeight, Boolean(smooth));
    state.atBottom = true;
    state.pendingNew = 0;
    updateJump();
  }

  function updateJump() {
    const btn = q("#scJump");
    if (!btn) return;
    const show = !state.atBottom || state.pendingNew > 0;
    btn.hidden = !show;
    btn.setAttribute("aria-label", state.pendingNew > 0
      ? `Jump to latest (${state.pendingNew} new message${state.pendingNew === 1 ? "" : "s"})`
      : "Jump to latest message");
    const count = btn.querySelector("#scJumpCount");
    if (count) {
      count.hidden = !(state.pendingNew > 0);
      count.textContent = state.pendingNew > 99 ? "99+" : String(state.pendingNew);
    }
  }

  function bindScroll(pane) {
    const box = pane.querySelector("#scMessages");
    if (!box) return;
    box.addEventListener("scroll", () => {
      state.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_BOTTOM_PX;
      if (state.atBottom) state.pendingNew = 0;
      updateJump();
    }, { passive: true });
    const jump = pane.querySelector("#scJump");
    // The one scroll a reader triggers deliberately — let it glide.
    if (jump) jump.addEventListener("click", () => scrollThreadToEnd(true));
  }

  /* ------------------------------- actions ----------------------------- */
  function bindThread(pane) {
    const back = pane.querySelector("#scBack");
    if (back) back.addEventListener("click", () => { state.mobileView = "list"; paintShellMode(); });

    const toggle = pane.querySelector("#scDetailsToggle");
    if (toggle) toggle.addEventListener("click", () => (state.detailsOpen ? closeDetails() : openDetails(toggle)));

    const more = pane.querySelector("#scLoadMore");
    if (more) more.addEventListener("click", loadEarlier);

    bindScroll(pane);

    const form = pane.querySelector("#scComposer");
    if (form) {
      const textarea = form.querySelector("#scMessage");
      const fileInput = form.querySelector("#scFile");
      const attach = form.querySelector("#scAttachBtn");
      if (attach && fileInput) attach.addEventListener("click", () => fileInput.click());
      if (fileInput) fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        const maxMb = (state.meta && state.meta.maxAttachmentMb) || 5;
        if (file && file.size > maxMb * 1024 * 1024) {
          ctx.toast(`The attachment is too large. The maximum size is ${maxMb} MB.`, "error");
          fileInput.value = "";
          setPendingFile(null);
        } else {
          setPendingFile(file || null);
        }
        paintFileChip(pane);
        paintSendState(pane);
      });
      textarea.addEventListener("input", () => {
        autosize(textarea);
        saveDraft();
        paintSendState(pane);
      });
      textarea.addEventListener("keydown", (e) => {
        // Enter sends, Shift+Enter makes a new line. On a phone the soft
        // keyboard's own "send"/"go" key reports Enter too — honour it.
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
      });
      form.addEventListener("submit", (e) => { e.preventDefault(); sendMessage(pane); });
      paintFileChip(pane);
      paintSendState(pane);
      autosize(textarea);
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

  function autosize(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px";
  }

  /** The send button is muted while there is nothing to send, and spins while
      a message is on its way. It is never `disabled` for being empty: that
      would also swallow Enter-to-send and read as a broken control. */
  function paintSendState(pane) {
    const scope = pane || root;
    if (!scope) return;
    const btn = scope.querySelector("#scSend");
    const ta = scope.querySelector("#scMessage");
    if (!btn || !ta) return;
    const empty = !(ta.value || "").trim() && !state.pendingFile;
    btn.classList.toggle("is-idle", empty && !state.sending);

    // The server caps a message at MAX_LEN. Say so only as the writer gets
    // near the cap — a counter counting down from 8000 is noise.
    const count = scope.querySelector("#scCount");
    if (count) {
      const left = MAX_LEN - (ta.value || "").length;
      const near = left <= Math.round(MAX_LEN * 0.15);
      count.hidden = !near;
      count.textContent = near ? `${left} character${left === 1 ? "" : "s"} left` : "";
      count.classList.toggle("is-near", near && left > 0);
      count.classList.toggle("is-over", left <= 0);
    }
  }

  /* --------------------------- pending attachment ----------------------- */
  function setPendingFile(file) {
    releasePreview();
    state.pendingFile = file || null;
    // A thumbnail of an image the reader has just picked on their own device
    // is local (blob:) and costs nothing. Server attachments are never pulled
    // inline: the API deliberately sends them as downloads.
    if (state.pendingFile && /^image\//i.test(state.pendingFile.type || "") && window.URL && URL.createObjectURL) {
      try { previewUrl = URL.createObjectURL(state.pendingFile); } catch (e) { previewUrl = null; }
    }
  }
  function releasePreview() {
    if (previewUrl && window.URL && URL.revokeObjectURL) {
      try { URL.revokeObjectURL(previewUrl); } catch (e) { /* already gone */ }
    }
    previewUrl = null;
  }

  function paintFileChip(pane) {
    const chip = pane.querySelector("#scFileChip");
    if (!chip) return;
    if (!state.pendingFile) { chip.hidden = true; chip.innerHTML = ""; return; }
    chip.hidden = false;
    chip.innerHTML = `
      ${previewUrl ? `<img class="sc-file-thumb" src="${esc(previewUrl)}" alt="">` : icon("file")}
      <span class="sc-file-meta">
        <strong>${esc(state.pendingFile.name)}</strong>
        <span>Attachment · ${esc(fmtSize(state.pendingFile.size))}</span>
      </span>
      <button type="button" class="sc-chip-remove" id="scChipRemove" aria-label="Remove attachment">${icon("close")}</button>`;
    chip.querySelector("#scChipRemove").addEventListener("click", () => {
      setPendingFile(null);
      const input = pane.querySelector("#scFile");
      if (input) input.value = "";
      paintFileChip(pane);
      paintSendState(pane);
    });
  }

  async function sendMessage(pane) {
    if (state.sending) return;
    const textarea = pane.querySelector("#scMessage");
    const sendBtn = pane.querySelector("#scSend");
    const body = (textarea.value || "").trim();
    if (!body && !state.pendingFile) { textarea.focus(); return; }
    state.sending = true;
    state.scrollTo = "end";
    sendBtn.disabled = true;
    sendBtn.classList.add("is-busy");
    sendBtn.setAttribute("aria-busy", "true");
    const sending = state.pendingFile;
    try {
      const form = new FormData();
      form.append("message", body);
      if (sending) form.append("attachment", sending);
      await window.API.post(conversationUrl(state.selectedId, "/messages"), form);
      textarea.value = "";
      textarea.style.height = "auto";
      clearDraft();
      setPendingFile(null);
      await openConversation(state.selectedId, { silent: true, reset: true });
      await loadList({ silent: true });
    } catch (e) {
      state.scrollTo = "";
      ctx.toast(friendly(e, "Unable to send your message. Please try again."), "error");
    } finally {
      state.sending = false;
      const btn = q("#scSend");
      if (btn) { btn.disabled = false; btn.classList.remove("is-busy"); btn.removeAttribute("aria-busy"); }
      const ta = q("#scMessage");
      if (ta) { paintSendState(q("#scThreadPane")); ta.focus(); }
      scrollThreadToEnd();
    }
  }

  async function loadEarlier() {
    if (!state.messages.length) return;
    const btn = q("#scLoadMore");
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    const oldest = state.messages[0].id;
    try {
      const data = await window.API.get(conversationUrl(state.selectedId) + `?before=${oldest}`);
      state.messages = (data.messages || []).concat(state.messages);
      state.hasMore = Boolean(data.hasMore);
      // restoreScroll() holds the reader on the message they were looking at
      // instead of dropping them at the top of the older page.
      state.scrollTo = "";
      paintThread(true);
    } catch (e) {
      ctx.toast(friendly(e, "Could not load earlier messages."), "error");
      paintThread(true);
    }
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
          <button class="dash-btn dash-btn-primary" type="submit" id="scnSubmit">${icon("mail")} Send Message</button>
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
        state.messages = [];           // a different thread: never animate the old one in
        await loadList({ silent: true });
        await openConversation(created.id);
      } catch (err) {
        submit.disabled = false;
        submit.removeAttribute("aria-busy");
        fail(friendly(err, "Unable to start the conversation. Please try again."), null);
      }
    });
  }

  /* ------------------------- on-screen keyboard ------------------------- */
  /*
     iOS Safari does NOT shrink the layout viewport when the soft keyboard
     opens, so a bottom-pinned composer stays exactly where it was — under the
     keyboard. `visualViewport` reports the space that is really visible; the
     difference is fed to the CSS custom property the chat height is built
     from, so the composer lifts above the keyboard instead of hiding behind
     it. On Android the layout viewport already shrinks and this is a no-op.
  */
  function watchKeyboard() {
    unwatchKeyboard();
    const vv = window.visualViewport;
    if (!vv || !window.matchMedia) return;
    const small = window.matchMedia("(max-width: 820px)");
    const apply = () => {
      const page = q("#scPage");
      if (!page) return;
      let inset = 0;
      if (small.matches) {
        const gap = Math.round(window.innerHeight - vv.height - vv.offsetTop);
        if (gap > window.innerHeight * 0.12) inset = Math.min(gap, Math.round(window.innerHeight * 0.6));
      }
      page.style.setProperty("--sc-keyboard", inset + "px");
      if (inset > 0 && state.atBottom) scrollThreadToEnd();
    };
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    keyboard = { vv, apply };
    apply();
  }
  function unwatchKeyboard() {
    if (!keyboard) return;
    try {
      keyboard.vv.removeEventListener("resize", keyboard.apply);
      keyboard.vv.removeEventListener("scroll", keyboard.apply);
    } catch (e) { /* non-fatal */ }
    keyboard = null;
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
      /* #dashContent outlives every page, so "is my root still in the
         document?" is the wrong question — the right one is "is the chat still
         what that root is showing?". Navigating to any other screen must stop
         this timer, not leave it polling for a page nobody is looking at. */
      if (!root || !document.body.contains(root) || !root.querySelector("#scPage")) { teardown(); return; }
      if (document.hidden || state.sending) return;
      await loadList({ silent: true });
      if (state.selectedId) await openConversation(state.selectedId, { silent: true });
    }, POLL_MS);
  }
  function stopPolling() {
    if (poll) { window.clearInterval(poll); poll = null; }
  }
  /** Everything this module attaches to the page, released together. */
  function teardown() {
    stopPolling();
    unwatchKeyboard();
    releasePreview();
    state.detailsOpen = false;
    lastFocus = null;
  }

  /* ------------------------------- render ------------------------------ */
  async function render(dashboardCtx, content, route) {
    ctx = dashboardCtx;
    const admin = route === ADMIN_ROUTE;
    // A route change away from the chat must not leave listeners or a timer
    // behind: the previous root is about to be replaced wholesale.
    if (root && root !== content) teardown();
    if (admin !== state.admin) {
      // Switching sides resets the view entirely (never show one side's data
      // inside the other's screen).
      Object.assign(state, {
        admin, meta: null, conversations: [], selectedId: null, conversation: null,
        messages: [], attachments: [], filters: { q: "", status: "", priority: "", category: "", madrasaId: "" },
        mobileView: "list", detailsOpen: false, pendingFile: null, atBottom: true, pendingNew: 0, scrollTo: "",
      });
      releasePreview();
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
    if (head) head.innerHTML = filterBar() + `<p class="sc-list-count" id="scListCount" hidden></p>`;
    bindShell();
    paintDetails();
    paintThread(true);
    await loadList();
    watchKeyboard();
    startPolling();
  }

  /** Search + filter controls. Bound again whenever the filter bar is
      re-rendered (after the vocabulary arrives, or after "Clear filters"). */
  function bindFilters() {
    const search = q("#scSearch");
    if (search) {
      let timer = null;
      search.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.filters.q = search.value.trim(); loadList(); }, 300);
      });
      search.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && search.value) {
          e.stopPropagation();
          search.value = ""; state.filters.q = ""; loadList();
        }
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
  }

  function bindShell() {
    const newBtn = q("#scNewBtn");
    if (newBtn) newBtn.addEventListener("click", newConversationModal);
    bindFilters();

    const backdrop = q("#scDrawerBackdrop");
    if (backdrop) backdrop.addEventListener("click", closeDetails);

    // Escape closes the details sheet. Bound to this page's own root so the
    // listener disappears with the DOM it belongs to — nothing to leak.
    if (root) root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.detailsOpen) { e.preventDefault(); closeDetails(); }
    });
  }

  window.EduSphereSupportChat = { handles, render, stopPolling: teardown, USER_ROUTE, ADMIN_ROUTE };
})();
