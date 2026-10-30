"use strict";
/* ============================================================================
   EduSphere — Portal core (Teacher · Student · Parent)
   ----------------------------------------------------------------------------
   One shared shell for the three non-admin workspaces. It reuses the admin
   dashboard's design system (dashboard.css, dash-* classes) so the whole
   platform feels like one product, and talks ONLY to the existing
   tenant-scoped API with the shared window.API client — the session, CSRF
   and madrasa isolation rules are the ones already enforced by the server.

   Real, reloadable addresses: /teacher, /student, /parent (+ #/<role>/<page>
   sections). Each role registers a module:

     window.BelloPortal.registerRole("teacher", {
       schema(), render(content, route), pageTitle(route)
     });
   ========================================================================== */
(function () {
  const ROLES = {
    teacher: { path: "/teacher", label: "Teacher Workspace", icon: "teacher" },
    student: { path: "/student", label: "Student Portal", icon: "academic" },
    parent: { path: "/parent", label: "Parent Portal", icon: "users" },
  };

  const I = {
    dashboard: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`,
    teacher: `<svg viewBox="0 0 24 24"><path d="M4 5h12v10H4zM8 19h4M10 15v4M19 8v7M17 15h4"/><circle cx="19" cy="5" r="2"/></svg>`,
    users: `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3.5 20v-2.1A4.9 4.9 0 0 1 8.4 13h1.2a4.9 4.9 0 0 1 4.9 4.9V20M16 5.5a3 3 0 0 1 0 5.8M18.3 13.4a4.7 4.7 0 0 1 2.2 4V20"/></svg>`,
    classes: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M8 4v14"/></svg>`,
    book: `<svg viewBox="0 0 24 24"><path d="M4 5.7A3.7 3.7 0 0 1 7.7 2H12v18H7.7A3.7 3.7 0 0 0 4 23V5.7ZM20 5.7A3.7 3.7 0 0 0 16.3 2H12v18h4.3A3.7 3.7 0 0 1 20 23V5.7Z"/></svg>`,
    calendar: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></svg>`,
    academic: `<svg viewBox="0 0 24 24"><path d="m3 9 9-5 9 5-9 5-9-5Z"/><path d="M7 11.3v4.4c2.6 2.2 7.4 2.2 10 0v-4.4M21 9v5"/></svg>`,
    chat: `<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
    money: `<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 6v0M18 18v0"/></svg>`,
    leave: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/><path d="m9 15.5 2 2 4-4"/></svg>`,
    settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z"/></svg>`,
    bell: `<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`,
    logout: `<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>`,
    menu: `<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
    close: `<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19.5 6.5"/></svg>`,
    clock: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    plus: `<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    edit: `<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    download: `<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>`,
    file: `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    building: `<svg viewBox="0 0 24 24"><path d="M4 21V5l8-2v18M20 21V9l-8-2M8 7h1M8 11h1M8 15h1M14 11h1M18 11h1M14 15h1M18 15h1M2 21h20"/></svg>`,
    shield: `<svg viewBox="0 0 24 24"><path d="M12 3 19 6v5.4c0 4.2-2.8 7.8-7 9.6-4.2-1.8-7-5.4-7-9.6V6l7-3Z"/><path d="m8.5 12 2.2 2.2 4.7-4.7"/></svg>`,
    health: `<svg viewBox="0 0 24 24"><path d="M12 20.4 4.9 13.2a5 5 0 0 1 7.1-7.1 5 5 0 0 1 7.1 7.1Z"/><path d="M4.5 12h3l1.5-2.5 2.5 5 1.5-2.5h4.5"/></svg>`,
  };

  const state = {
    role: null,          // 'teacher' | 'student' | 'parent'
    me: null,            // /api/auth/me payload
    institution: null,   // { nameEn, nameAr, logoPath, category }
    route: "dashboard",
    sidebarOpen: false,
    unread: 0,
    bootInFlight: null,
    selectedChildId: null, // parent child switcher
    module: null,        // the registered role module
  };
  const modules = {};

  /* ------------------------------ helpers ------------------------------- */

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtDate(v) {
    if (!v) return "—";
    try { return new Date(String(v).slice(0, 10)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
    catch (e) { return String(v); }
  }
  function fmtDateTime(v) {
    if (!v) return "—";
    try { return new Date(String(v).replace(" ", "T")).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return String(v); }
  }
  function fmtMoney(n) {
    const v = Number(n || 0);
    return "₦" + v.toLocaleString("en-NG", { maximumFractionDigits: 2 });
  }
  function todayIso() { return new Date().toISOString().slice(0, 10); }

  function toast(msg, kind) {
    let wrap = document.querySelector(".dash-toasts");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "dash-toasts";
      document.body.appendChild(wrap);
    }
    const el = document.createElement("div");
    el.className = "dash-toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function openModal(title, bodyHtml, opts = {}) {
    closeModal();
    const backdrop = document.createElement("div");
    backdrop.className = "dash-modal-backdrop is-open";
    backdrop.id = "portalModal";
    backdrop.innerHTML = `
      <div class="dash-modal${opts.wide ? " dash-modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="dash-modal-head"><h3>${esc(title)}</h3>
          <button type="button" class="dash-icon-btn" data-close-modal aria-label="Close">${I.close}</button></div>
        <div class="dash-modal-body">${bodyHtml}</div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
    backdrop.querySelector("[data-close-modal]").addEventListener("click", closeModal);
    return backdrop;
  }
  function closeModal() {
    const existing = document.getElementById("portalModal");
    if (existing) existing.remove();
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  function statCard(icon, value, label, accent, sub) {
    return `<div class="dash-stat-card"><div class="dash-stat-icon${accent ? " accent" : ""}">${I[icon] || ""}</div>` +
      `<div class="dash-stat-value">${esc(value)}${sub ? `<small class="dash-stat-sub">${esc(sub)}</small>` : ""}</div>` +
      `<div class="dash-stat-label">${esc(label)}</div></div>`;
  }
  function pill(status) {
    const map = {
      present: "ok", submitted: "ok", graded: "ok", published: "ok", approved: "ok", active: "ok", successful: "ok", returned: "warn",
      draft: "info", scheduled: "info", open: "info", pending: "info", late: "warn", absent: "danger", overdue: "danger", excused: "info",
    };
    const cls = map[String(status || "").toLowerCase()] || "info";
    return `<span class="dash-pill ${cls}">${esc(String(status || "—").replace(/_/g, " "))}</span>`;
  }
  function options(rows, selected, label) {
    return (rows || []).map((r) => {
      const value = r.id !== undefined ? r.id : r;
      const text = label ? label(r) : (r.name_en || r.name || r.label || r.title || String(r.id !== undefined ? r.id : r));
      return `<option value="${esc(value)}"${String(selected) === String(value) ? " selected" : ""}>${esc(text)}</option>`;
    }).join("");
  }
  function emptyRow(cols, message) {
    return `<tr><td colspan="${cols}" style="text-align:center;padding:26px;color:var(--d-muted)">${esc(message)}</td></tr>`;
  }
  function pageHead(crumb, title, sub, actionsHtml) {
    return `<div class="dash-page-head"><div><div class="dash-crumb">${esc(crumb)}</div><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ""}</div>${actionsHtml ? `<div class="dash-actions">${actionsHtml}</div>` : ""}</div>`;
  }
  function loading() {
    return `<div class="dash-coming-soon"><div class="icon">${I.clock}</div><h3>Loading…</h3></div>`;
  }
  function errorState(message) {
    return `<div class="dash-coming-soon"><div class="icon">${I.close}</div><h3>Something went wrong</h3><p>${esc(message || "Please try again.")}</p></div>`;
  }
  function emptyState(icon, title, body) {
    return `<div class="dash-empty-state"><div class="dash-empty-state-icon">${I[icon] || ""}</div><h3>${esc(title)}</h3><p>${esc(body)}</p></div>`;
  }

  /** Marks overflowing table wrappers as keyboard-scrollable (a11y, mobile). */
  function enhanceTables(scope) {
    (scope || document).querySelectorAll(".dash-table-wrap").forEach((wrap) => {
      if (wrap.dataset.a11yBound === "1") return;
      wrap.dataset.a11yBound = "1";
      const check = () => {
        const scrolls = wrap.scrollWidth > wrap.clientWidth + 1;
        if (scrolls) {
          wrap.setAttribute("tabindex", "0");
          wrap.setAttribute("role", "region");
          if (!wrap.hasAttribute("aria-label")) wrap.setAttribute("aria-label", "Scrollable table");
        } else {
          wrap.removeAttribute("tabindex");
          wrap.removeAttribute("role");
        }
      };
      check();
      if (typeof window.ResizeObserver === "function") {
        try { new window.ResizeObserver(check).observe(wrap); } catch (e) { /* non-fatal */ }
      }
    });
  }

  /* ------------------------------- router -------------------------------- */

  function roleFromLocation() {
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/teacher" || path.startsWith("/teacher/")) return "teacher";
    if (path === "/student" || path.startsWith("/student/")) return "student";
    if (path === "/parent" || (path.startsWith("/parent/") && path !== "/parent/meetings")) return "parent";
    const hash = window.location.hash || "";
    const m = hash.match(/^#\/(teacher|student|parent)(\/.*)?$/);
    return m ? m[1] : null;
  }
  function currentRoute() {
    const hash = window.location.hash || "";
    const m = hash.match(/^#\/(?:teacher|student|parent)\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : "dashboard";
  }
  function go(route) {
    window.location.hash = `#/${state.role}/${encodeURIComponent(route)}`;
  }

  /* -------------------------------- boot --------------------------------- */

  function resetState() {
    state.me = null;
    state.unread = 0;
    state.selectedChildId = null;
    state.institution = null;
  }

  async function mount(role) {
    if (!ROLES[role]) return;
    state.role = role;
    state.module = modules[role] || null;
    document.title = `${ROLES[role].label} — EduSphere`;
    await boot();
  }

  async function boot() {
    if (state.bootInFlight) return state.bootInFlight;
    state.bootInFlight = (async () => {
      try { await bootOnce(); } finally { state.bootInFlight = null; }
    })();
    return state.bootInFlight;
  }

  async function bootOnce() {
    const root = document.getElementById("app");
    if (!root) return;
    let me = null;
    try { me = await window.API.me(); } catch (e) { me = null; }
    if (!me || !me.loggedIn) {
      resetState();
      return renderLogin(root, null, null);
    }
    if (me.role !== state.role) {
      // A real account of the wrong kind: send it to its own workspace rather
      // than dumping it on a dead form.
      const home = me.role === "super_admin" || me.role === "madrasa_admin" ? "/admin"
        : me.role === "teacher" ? "/teacher"
        : me.role === "student" ? "/student"
        : me.role === "parent" ? "/parent" : "/";
      const label = me.role === "super_admin" ? "a platform administrator account"
        : me.role === "madrasa_admin" ? "an administrator account"
        : `a ${me.role} account`;
      resetState();
      return renderLogin(root,
        `You are signed in with ${label}. This page is the ${ROLES[state.role].label}.`, me, home);
    }
    state.me = me;
    // Institution identity for the shell header.
    state.institution = {
      nameEn: me.institutionName || "EduSphere",
      category: me.category === "western" ? "western" : "islamic",
    };
    if (me.madrasaId) {
      try {
        const profile = await window.API.get("/madrasa/profile");
        if (profile && profile.madrasa) {
          state.institution.nameEn = profile.madrasa.name_en || state.institution.nameEn;
          state.institution.nameAr = profile.madrasa.name_ar || "";
          state.institution.logoPath = profile.madrasa.logo_path || "";
        }
      } catch (e) { /* header falls back to the platform name */ }
    }
    refreshUnread();
    state.route = currentRoute();
    renderShell(root);
  }

  async function refreshUnread() {
    try {
      const data = await window.API.get("/communication/notifications?limit=1");
      state.unread = Number(data.unread || 0);
      const badge = document.getElementById("portalUnreadBadge");
      if (badge) {
        badge.textContent = state.unread > 99 ? "99+" : String(state.unread);
        badge.hidden = state.unread === 0;
      }
      const bell = document.getElementById("portalBell");
      if (bell) bell.setAttribute("aria-label", state.unread ? state.unread + " unread notifications" : "Notifications");
    } catch (e) { /* non-fatal */ }
  }

  /* ------------------------------- login ---------------------------------- */

  function renderLogin(root, message, session, homePath, username) {
    document.body.classList.remove("dash-islamic", "dash-western", "dash-super");
    const roleCfg = ROLES[state.role];
    const notice = (session && session.loggedIn && session.user) ? `
      <div class="dash-login-session">
        <div class="dash-login-session-copy">
          <strong>You are already signed in as ${esc(session.user.fullName || session.user.username)}.</strong>
          <small>${esc(homePath === "/admin" ? "Administrator" : ROLES[session.role] ? ROLES[session.role].label : session.role)}${session.institutionName ? " — " + esc(session.institutionName) : ""}</small>
        </div>
        <div class="dash-login-session-actions">
          ${homePath ? `<button type="button" id="portalGoHome">Continue to your workspace</button>` : ""}
          <button type="button" id="portalSignOut">Sign out</button>
        </div>
      </div>` : "";
    root.innerHTML = `
      <div class="dash-login-page">
        <div class="dash-login-card">
          <div class="brand-row">
            <img src="/assets/edusphere-logo.png" alt="EduSphere">
            <div><strong style="font-weight:800;font-size:1.05rem;">EduSphere</strong><div style="font-size:.72rem;color:#726d7b;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">${esc(roleCfg.label)}</div></div>
          </div>
          <h1>Sign in to your ${esc(state.role)} portal</h1>
          <p class="sub">Use the ${esc(state.role)} account your institution gave you — or any EduSphere account, and you will be handed to the right workspace.</p>
          ${notice}
          ${message ? `<div class="dash-login-error" role="alert" aria-live="assertive">${esc(message)}</div>` : ""}
          <form id="portalLoginForm" novalidate>
            <div class="dash-login-field"><label for="plUser">Email or username</label><input id="plUser" name="username" autocomplete="username" value="${esc(username || "")}" required></div>
            <div class="dash-login-field"><label for="plPass">Password</label>
              <div class="dash-login-password">
                <input id="plPass" name="password" type="password" autocomplete="current-password" required>
                <button type="button" class="dash-password-toggle" id="plPassToggle" aria-label="Show password" aria-pressed="false">Show</button>
              </div>
            </div>
            <div class="dash-login-row">
              <label class="dash-login-remember"><input type="checkbox" id="plRemember" name="remember"> Remember me</label>
              <a class="dash-login-forgot" href="/forgot-password">Forgot password?</a>
            </div>
            <button class="dash-login-submit" type="submit">Sign In</button>
          </form>
          <div class="dash-login-foot">Not a ${esc(state.role)}? <a href="/login" style="font-weight:700;color:#38146a;">Sign in on the main page</a>.</div>
        </div>
      </div>`;
    const passToggle = root.querySelector("#plPassToggle");
    if (passToggle) passToggle.addEventListener("click", () => {
      const input = root.querySelector("#plPass");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      passToggle.textContent = show ? "Hide" : "Show";
      passToggle.setAttribute("aria-pressed", show ? "true" : "false");
      passToggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });

    const goHome = root.querySelector("#portalGoHome");
    if (goHome) goHome.addEventListener("click", () => { window.location.replace(homePath || "/"); });
    const signOut = root.querySelector("#portalSignOut");
    if (signOut) signOut.addEventListener("click", async () => {
      try { await window.API.logout(); } catch (e) { /* best effort */ }
      resetState();
      renderLogin(root, "You have been signed out. Sign in below.", null);
    });

    const form = root.querySelector("#portalLoginForm");
    const submitBtn = form.querySelector("button[type=submit]");
    const submitLabel = submitBtn.textContent;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (submitBtn.disabled) return;
      const username = (form.elements.username.value || "").trim();
      const password = form.elements.password.value || "";
      const remember = Boolean(root.querySelector("#plRemember") && root.querySelector("#plRemember").checked);
      if (!username || !password) return renderLogin(root, "Enter both your username and your password.", null, null, username);
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing in…";
      let result;
      try {
        result = await window.API.login(username, password, remember);
      } catch (err) {
        renderLogin(root, err && err.message ? err.message : "Could not sign in. Please try again.", null, null, username);
        return;
      } finally {
        if (submitBtn && submitBtn.isConnected) { submitBtn.disabled = false; submitBtn.textContent = submitLabel; }
      }
      const target = result.role === "teacher" ? "/teacher" : result.role === "student" ? "/student" : result.role === "parent" ? "/parent" : "/admin";
      if (result.role !== state.role) {
        try { await window.API.logout(); } catch (e2) { /* best effort */ }
        return renderLogin(root, `That is a ${result.role === "madrasa_admin" || result.role === "super_admin" ? "administrator" : result.role} account — this page is the ${ROLES[state.role].label}. Use the main sign-in page.`, null);
      }
      // Land on the portal's own address so a reload never bounces back.
      const path = window.location.pathname.replace(/\/+$/, "") || "/";
      if (path !== target) { try { window.history.replaceState(null, "", target); } catch (err) { /* ignore */ } }
      window.location.hash = `#/${state.role}/dashboard`;
      await boot();
    });
    const focusTarget = root.querySelector("#plUser");
    if (focusTarget && typeof focusTarget.focus === "function") { try { focusTarget.focus(); } catch (e) { /* non-fatal */ } }
  }

  /* -------------------------------- shell --------------------------------- */

  function applyTheme() {
    document.body.classList.remove("dash-islamic", "dash-western", "dash-super");
    document.body.classList.add(state.institution && state.institution.category === "western" ? "dash-western" : "dash-islamic");
  }

  function navSchema() {
    return state.module ? state.module.schema() : [];
  }

  function renderNav() {
    const schema = navSchema();
    return schema.map((item) => item.items
      ? `<div class="dash-nav-group"><div class="dash-nav-group-label">${esc(item.label)}</div>` +
        item.items.map(([label, route]) => {
          const active = state.route === route;
          return `<a href="#/${state.role}/${encodeURIComponent(route)}" class="dash-nav-link${active ? " top-active" : ""}"${active ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
        }).join("") + `</div>`
      : `<div class="dash-nav-group"><a href="#/${state.role}/${encodeURIComponent(item.route)}" class="dash-nav-link${state.route === item.route ? " top-active" : ""}"${state.route === item.route ? ' aria-current="page"' : ""}>${I[item.icon] || ""}<span>${esc(item.label)}</span>${item.badge ? `<span class="dash-nav-badge">${esc(item.badge)}</span>` : ""}</a></div>`
    ).join("");
  }

  function renderShell(root) {
    applyTheme();
    const me = state.me || {};
    const initials = (me.user && (me.user.fullName || me.user.username) || "P").trim().split(/\s+/).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
    const roleCfg = ROLES[state.role];
    root.innerHTML = `
      <div class="dash-root" id="portalRoot" data-portal-role="${esc(state.role)}">
        <div class="dash-overlay" id="portalOverlay"></div>
        <div class="dash-shell">
          <aside class="dash-sidebar" id="portalSidebar">
            <div class="dash-brand">
              <span class="dash-brand-logo"><img src="${esc((state.institution && state.institution.logoPath) || "/assets/edusphere-logo.png")}" alt="${esc((state.institution && state.institution.nameEn) || "EduSphere")} logo"></span>
              <span class="dash-brand-words">
                <strong>${esc(state.institution ? state.institution.nameEn : "EduSphere")}</strong>
                <small>${esc(roleCfg.label)}</small>
              </span>
            </div>
            <nav class="dash-nav" id="portalNav" aria-label="${esc(roleCfg.label)} navigation">${renderNav()}</nav>
            <div class="dash-sidebar-foot">
              <button class="dash-logout-btn" id="portalLogoutBtn">${I.logout} Log Out</button>
            </div>
          </aside>
          <div class="dash-main">
            <header class="dash-header">
              <button class="dash-burger" id="portalBurger" aria-label="Open menu">${I.menu}</button>
              <div class="dash-header-title">
                <h1 id="portalPageTitle">${esc(pageTitle())}</h1>
                <div class="sub">Welcome, ${esc(me.user ? (me.user.fullName || me.user.username) : "")}</div>
              </div>
              <div class="dash-header-spacer"></div>
              <button type="button" class="dash-btn dash-btn-ghost dash-btn-sm portal-bell" id="portalBell" aria-label="${state.unread ? state.unread + " unread notifications" : "Notifications"}">
                ${I.bell}<span class="portal-bell-badge" id="portalUnreadBadge" ${state.unread ? "" : "hidden"}>${state.unread > 99 ? "99+" : state.unread}</span>
              </button>
              <div class="dash-header-user">
                <span class="dash-header-avatar">${esc(initials)}</span>
                <span class="who"><strong>${esc(me.user ? (me.user.fullName || me.user.username) : "")}</strong><small>${esc(state.institution ? state.institution.nameEn : "")}</small></span>
              </div>
            </header>
            <main class="dash-content"><div class="dash-content-inner" id="portalContent">${loading()}</div></main>
          </div>
        </div>
      </div>`;

    root.querySelector("#portalLogoutBtn").addEventListener("click", async () => {
      resetState();
      try { await window.API.logout(); } catch (e) { /* ignore */ }
      window.location.replace("/");
    });
    root.querySelector("#portalBurger").addEventListener("click", () => setSidebar(true));
    root.querySelector("#portalOverlay").addEventListener("click", () => setSidebar(false));
    root.querySelector("#portalBell").addEventListener("click", () => go("notifications"));
    renderRoute();
  }

  function setSidebar(open) {
    const sidebar = document.getElementById("portalSidebar");
    const overlay = document.getElementById("portalOverlay");
    if (sidebar) sidebar.classList.toggle("is-open", open);
    if (overlay) overlay.classList.toggle("is-open", open);
  }

  function pageTitle() {
    if (state.module && typeof state.module.pageTitle === "function") {
      const title = state.module.pageTitle(state.route);
      if (title) return title;
    }
    const last = state.route.split("/").pop();
    return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  async function renderRoute() {
    const content = document.getElementById("portalContent");
    if (!content) return;
    const titleEl = document.getElementById("portalPageTitle");
    if (titleEl) titleEl.textContent = pageTitle();
    const nav = document.getElementById("portalNav");
    if (nav) nav.innerHTML = renderNav();
    content.innerHTML = loading();
    try {
      if (!state.module) throw new Error("This portal is not available.");
      await state.module.render(content, state.route, ctx());
    } catch (e) {
      content.innerHTML = errorState(e.message);
    } finally {
      enhanceTables(content);
    }
  }

  /** The context handed to role modules — every shared helper in one object. */
  function ctx() {
    return {
      I, esc, fmtDate, fmtDateTime, fmtMoney, todayIso, toast, openModal, closeModal,
      statCard, pill, options, emptyRow, pageHead, loading, errorState, emptyState,
      enhanceTables, go, state, refreshUnread,
      api: window.API,
    };
  }

  /* ----------------------------- notifications ---------------------------- */

  /** Shared notification-center page for every portal role. */
  function renderNotifications(c, content) {
    content.innerHTML = pageHead("Notifications", "Notification centre", "Everything the institution has sent you.", `
      <button class="dash-btn dash-btn-ghost" id="notifRefresh">${I.check} Refresh</button>
      <button class="dash-btn dash-btn-primary" id="notifReadAll">Mark all read</button>`);
    const wrap = document.createElement("div");
    wrap.className = "dash-card";
    content.appendChild(wrap);
    const load = async () => {
      wrap.innerHTML = `<div class="dash-card-pad">${loading()}</div>`;
      try {
        const data = await window.API.get("/communication/notifications?limit=100");
        const rows = data.notifications || [];
        wrap.innerHTML = `<div class="dash-card-pad portal-notif-list">` + (rows.length
          ? rows.map((n) => `
            <div class="portal-notif${n.read_at ? "" : " is-unread"}">
              <div class="portal-notif-body">
                <strong>${c.esc(n.title)}</strong>
                <p>${c.esc(n.body || "")}</p>
                <small>${c.fmtDateTime(n.created_at)}</small>
              </div>
              ${n.read_at ? "" : `<button class="dash-btn dash-btn-ghost dash-btn-sm" data-notif-read="${n.id}">Mark read</button>`}
            </div>`).join("")
          : `<div class="dash-empty-state"><div class="dash-empty-state-icon">${I.bell}</div><h3>No notifications yet</h3><p>Announcements, results, fees and meeting updates will appear here.</p></div>`)
          + `</div>`;
        wrap.querySelectorAll("[data-notif-read]").forEach((btn) => btn.addEventListener("click", async () => {
          try { await window.API.patch(`/communication/notifications/${btn.dataset.notifRead}/read`, {}); } catch (e) { /* best effort */ }
          refreshUnread(); load();
        }));
      } catch (e) {
        wrap.innerHTML = `<div class="dash-card-pad">${errorState(e.message)}</div>`;
      }
    };
    content.querySelector("#notifRefresh").addEventListener("click", load);
    content.querySelector("#notifReadAll").addEventListener("click", async () => {
      try { await window.API.post("/communication/notifications/read-all", {}); } catch (e) { c.toast(e.message, "error"); return; }
      c.refreshUnread(); load();
    });
    load();
  }

  /* ------------------------------ lifecycle ------------------------------- */

  function onHashChange() {
    if (!roleFromLocation()) return;
    // On a phone the drawer covers the page it just navigated to. Close it on
    // every route change, whatever opened it (a nav link, a dashboard button,
    // the back gesture).
    setSidebar(false);
    if (!state.me) { boot(); return; }
    state.route = currentRoute();
    const root = document.getElementById("app");
    if (root && !document.getElementById("portalRoot")) { boot(); return; }
    renderRoute();
  }
  window.addEventListener("hashchange", onHashChange);

  window.addEventListener("bello:unauthorized", () => {
    if (!state.me) return;
    resetState();
    const root = document.getElementById("app");
    if (root) renderLogin(root, "Your session has ended. Please sign in again.", null);
  });

  window.BelloPortal = {
    registerRole(role, module) { modules[role] = module; },
    mount,
    go,
    renderNotifications,
    ctx,
    ROLES,
    /** The signed-in user's institution category: 'islamic' | 'western'. */
    category() { return state.institution ? state.institution.category : "islamic"; },
  };
})();
