"use strict";
/* ============================================================================
   EduSphere — SYNC STATUS BAR, OUTBOX DRAWER & SIGNED-IN DEVICES
   ----------------------------------------------------------------------------
   A quiet status pill in the workspace header tells the operator where their
   work stands right now:

       Online · Synced          everything is on the server
       Offline · Saving Locally work is being written to this device
       Syncing (3)…             3 queued changes are on their way
       Sync Attention (1)       1 change was refused (frozen result, revoked
                                card, duplicate payment) and needs a decision

   Clicking it opens the Sync & Devices drawer: last-sync time, Sync Now,
   pending Outbox items, conflicts with their server reason plus Retry /
   Accept Server Version, and the list of signed-in devices that can be
   revoked remotely (GET/DELETE /api/auth/devices through window.API).

   Every request goes through window.API — never a raw fetch — so CSRF and the
   device Bearer token keep working exactly as everywhere else.
   ========================================================================== */
(function () {
  if (typeof window === "undefined" || !window.SyncEngine) return;

  const ENGINE = window.SyncEngine;
  const PILL_CLASS = "es-sync-pill";
  const DRAWER_ID = "esSyncDrawer";
  let pill = null;
  let drawer = null;
  let mountedIn = null;
  let lastState = ENGINE.state();
  let observer = null;
  let refreshTimer = null;
  let heartbeatTimer = null;
  let lastFocused = null;
  let destroyed = false;

  /** Is the document still alive? A closed window must never be painted. */
  function live() {
    if (destroyed) return false;
    try { return Boolean(window.document && window.document.body); } catch (e) { return false; }
  }

  /* ------------------------------- helpers -------------------------------- */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.slice(0, 2) === "on" && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function timeAgo(ms) {
    if (!ms) return "never";
    const diff = Date.now() - Number(ms);
    if (!Number.isFinite(diff) || diff < 0) return "just now";
    if (diff < 45000) return "just now";
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return `${days} d ago`;
  }

  function clockTime(ms) {
    if (!ms) return "—";
    try {
      return new Date(Number(ms)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return "—"; }
  }

  function humanType(type) {
    const map = {
      "student.create": "New student",
      "student.update": "Student edit",
      "attendance.mark": "Attendance register",
      "attendance.scan": "QR gate scan",
      "teacher_attendance.mark": "Staff attendance",
      "results.upsert": "Results entry",
      "quran_progress.create": "Qur'an progress",
      "quran_progress.update": "Qur'an progress edit",
      "fee_payment.record": "Fee payment",
      "expense.create": "Expense (draft)",
      "announcement.create": "Announcement",
    };
    return map[type] || type || "Change";
  }

  function describeItem(item) {
    const payload = item.payload || {};
    if (item.type === "student.create") {
      const name = [payload.first_name || payload.firstName, payload.last_name || payload.lastName].filter(Boolean).join(" ");
      return name || "New student record";
    }
    if (item.type === "attendance.mark") return `Class register · ${payload.date || ""}`;
    if (item.type === "attendance.scan") return `Card ${payload.code || ""} · ${payload.date || ""}`;
    if (item.type === "teacher_attendance.mark") return `Staff register · ${payload.date || ""}`;
    if (item.type === "results.upsert") return `${(payload.entries || []).length} result(s)`;
    if (item.type === "fee_payment.record") return `Payment · ${payload.amount_ngn || payload.amount || 0}`;
    if (item.type === "quran_progress.create") return `Surah ${payload.surah || payload.juz || ""}`.trim();
    if (item.type === "announcement.create") return payload.title || "Announcement";
    return humanType(item.type);
  }

  /* ------------------------------ state layer ----------------------------- */

  function applyState(snapshot) {
    if (!live()) return;
    lastState = snapshot || lastState;
    try {
      renderPill();
      if (drawer && !drawer.hidden) renderDrawer();
    } catch (e) { /* a status chip must never break a screen */ }
  }

  function statusIcon(kind) {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "es-sync-icon");
    const path = document.createElementNS(svgNS, "path");
    if (kind === "offline") path.setAttribute("d", "M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a9 9 0 0 1 3-2M12 20h.01");
    else if (kind === "syncing") path.setAttribute("d", "M12 3a9 9 0 1 0 9 9M21 3v6h-6");
    else if (kind === "attention") path.setAttribute("d", "M12 3l9 16H3zM12 9v5M12 17h.01");
    else path.setAttribute("d", "M20 6L9 17l-5-5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function kindFor(snapshot) {
    if (snapshot.syncing) return "syncing";
    if (snapshot.attention > 0) return "attention";
    if (!snapshot.online) return "offline";
    return "synced";
  }

  function renderPill() {
    if (!pill) return;
    const kind = kindFor(lastState);
    clear(pill);
    pill.className = `${PILL_CLASS} ${PILL_CLASS}--${kind}`;
    pill.setAttribute("data-sync-state", kind);
    pill.setAttribute("aria-label", `Sync status: ${lastState.label}. Open the sync and devices panel.`);
    pill.title = lastState.lastSyncedAt
      ? `Last synced ${clockTime(lastState.lastSyncedAt)} (${timeAgo(lastState.lastSyncedAt)})`
      : "Not synced yet on this device";
    pill.appendChild(statusIcon(kind));
    pill.appendChild(el("span", { class: "es-sync-label", text: lastState.label }));
    if (lastState.pending > 0 && !lastState.syncing) {
      pill.appendChild(el("span", { class: "es-sync-badge", text: String(lastState.pending) }));
    }
  }

  /* -------------------------------- mounting ------------------------------ */

  function headerTarget() {
    return document.querySelector(".dash-header") ||
      document.querySelector(".portal-header") ||
      document.querySelector("header");
  }

  function ensurePill() {
    if (!live()) return;
    if (!pill) {
      pill = el("button", {
        type: "button",
        class: `${PILL_CLASS} ${PILL_CLASS}--synced`,
        onclick: () => open(),
      });
      renderPill();
    }
    const target = headerTarget();
    if (!target) {
      // No workspace chrome yet. A signed-in device still gets a floating pill
      // (so offline state is never invisible); a marketing/login page gets
      // nothing, because a sync chip there would only be noise.
      const signedIn = Boolean(ENGINE.state().scope);
      if (!signedIn) {
        if (pill.parentNode) pill.parentNode.removeChild(pill);
        mountedIn = null;
        return;
      }
      if (pill.parentNode !== document.body) {
        pill.classList.add(`${PILL_CLASS}--floating`);
        document.body.appendChild(pill);
        mountedIn = "body";
      }
      return;
    }
    if (pill.parentNode === target && mountedIn === "header") return;
    pill.classList.remove(`${PILL_CLASS}--floating`);
    const user = target.querySelector(".dash-header-user");
    const spacer = target.querySelector(".dash-header-spacer");
    if (user && user.parentNode === target) target.insertBefore(pill, user);
    else if (spacer && spacer.parentNode === target) target.insertBefore(pill, spacer);
    else target.appendChild(pill);
    mountedIn = "header";
  }

  function startObserver() {
    if (observer || typeof MutationObserver === "undefined" || !document.body) return;
    let scheduled = false;
    observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        if (!pill || !pill.isConnected) ensurePill();
      }, 120);
    });
    try { observer.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
  }

  /* -------------------------------- drawer -------------------------------- */

  function buildDrawer() {
    const root = el("div", { class: "es-sync-overlay", id: DRAWER_ID, hidden: "hidden" });
    const panel = el("div", {
      class: "es-sync-drawer",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "esSyncDrawerTitle",
      tabindex: "-1",
    });
    root.addEventListener("click", (event) => {
      if (event.target === root) close();
    });
    root.appendChild(panel);
    document.body.appendChild(root);
    drawer = root;
    return root;
  }

  function ensureDrawer() {
    if (!drawer) buildDrawer();
    return drawer;
  }

  function sectionTitle(text, extra) {
    return el("div", { class: "es-sync-section-head" }, [
      el("h3", { text }),
      extra || null,
    ]);
  }

  function renderDrawer() {
    if (!live() || !drawer) return;
    const panel = drawer.querySelector(".es-sync-drawer");
    if (!panel) return;
    clear(panel);
    const status = lastState;
    const closeBtn = el("button", {
      type: "button",
      class: "es-sync-close",
      "aria-label": "Close sync panel",
      onclick: () => close(),
    }, "×");

    panel.appendChild(el("header", { class: "es-sync-drawer-head" }, [
      el("div", null, [
        el("h2", { id: "esSyncDrawerTitle", text: "Sync & Devices" }),
        el("p", { class: "es-sync-sub", text: status.label }),
      ]),
      closeBtn,
    ]));

    /* ---- sync summary ---- */
    const summary = el("section", { class: "es-sync-section" }, [
      el("div", { class: "es-sync-row" }, [
        el("div", null, [
          el("strong", { text: status.online ? "Connected" : "Working offline" }),
          el("small", { text: status.lastSyncedAt
            ? `Last synced ${clockTime(status.lastSyncedAt)} · ${timeAgo(status.lastSyncedAt)}`
            : "This device has not completed a sync yet." }),
        ]),
        el("button", {
          type: "button",
          class: "es-sync-btn es-sync-btn--primary",
          id: "esSyncNow",
          onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            button.textContent = "Syncing…";
            try {
              await ENGINE.syncNow();
            } finally {
              button.disabled = false;
              button.textContent = "Sync Now";
              refresh();
            }
          },
        }, "Sync Now"),
      ]),
      status.lastError ? el("p", { class: "es-sync-note es-sync-note--warn", text: status.lastError }) : null,
      !status.online ? el("p", {
        class: "es-sync-note",
        text: "You are offline. Everything you do is saved on this device and sent automatically when the connection returns.",
      }) : null,
      status.backend === "memory" ? el("p", {
        class: "es-sync-note es-sync-note--warn",
        text: "This device's browser is not allowing durable storage, so offline work is only kept until the tab closes. Use the desktop or mobile app for full offline durability.",
      }) : null,
    ]);
    panel.appendChild(summary);

    /* ---- pending outbox ---- */
    const pendingSection = el("section", { class: "es-sync-section", "data-sync-section": "pending" }, [
      sectionTitle("Waiting to sync", el("span", { class: "es-sync-count", text: String(status.pending) })),
    ]);
    const pendingList = el("div", { class: "es-sync-list", id: "esSyncPending" });
    pendingList.appendChild(el("p", { class: "es-sync-empty", text: "Loading queued changes…" }));
    pendingSection.appendChild(pendingList);
    panel.appendChild(pendingSection);

    /* ---- conflicts ---- */
    const conflictSection = el("section", { class: "es-sync-section", "data-sync-section": "conflicts" }, [
      sectionTitle("Needs your attention", el("span", {
        class: "es-sync-count" + (status.attention ? " es-sync-count--warn" : ""),
        text: String(status.attention),
      })),
    ]);
    const conflictList = el("div", { class: "es-sync-list", id: "esSyncConflicts" });
    conflictSection.appendChild(conflictList);
    panel.appendChild(conflictSection);

    /* ---- devices ---- */
    const deviceSection = el("section", { class: "es-sync-section", "data-sync-section": "devices" }, [
      sectionTitle("Signed-in devices", null),
    ]);
    const deviceList = el("div", { class: "es-sync-list", id: "esSyncDevices" });
    deviceList.appendChild(el("p", { class: "es-sync-empty", text: "Loading devices…" }));
    deviceSection.appendChild(deviceList);
    panel.appendChild(deviceSection);

    panel.appendChild(el("footer", { class: "es-sync-drawer-foot" }, [
      el("small", {
        text: status.online
          ? "Changes sync automatically every few minutes and whenever you press Sync Now."
          : "Changes will sync as soon as this device is back online.",
      }),
    ]));

    fillOutbox();
    fillDevices();
  }

  async function fillOutbox() {
    if (!live() || !drawer) return;
    const pendingList = drawer.querySelector("#esSyncPending");
    const conflictList = drawer.querySelector("#esSyncConflicts");
    if (!pendingList || !conflictList) return;
    let items = [];
    try { items = await ENGINE.listOutbox(); } catch (e) { items = []; }
    if (!live() || !drawer) return;
    const pending = items.filter((item) => item.status === "pending" || item.status === "syncing");
    const conflicts = items.filter((item) => item.status === "conflict" || item.status === "rejected");

    clear(pendingList);
    if (!pending.length) {
      pendingList.appendChild(el("p", { class: "es-sync-empty", text: "Nothing is waiting — this device is in step with the server." }));
    } else {
      for (const item of pending) {
        pendingList.appendChild(el("div", { class: "es-sync-item", "data-outbox-id": item.clientMutationId }, [
          el("div", { class: "es-sync-item-main" }, [
            el("strong", { text: humanType(item.type) }),
            el("small", { text: `${describeItem(item)} · queued ${timeAgo(item.createdAt)}` }),
          ]),
          el("span", { class: "es-sync-tag", text: item.status === "syncing" ? "Sending" : "Queued" }),
        ]));
      }
    }

    clear(conflictList);
    if (!conflicts.length) {
      conflictList.appendChild(el("p", { class: "es-sync-empty", text: "No conflicts. Nothing was refused by the server." }));
    } else {
      for (const item of conflicts) {
        conflictList.appendChild(el("div", {
          class: "es-sync-item es-sync-item--conflict",
          "data-outbox-id": item.clientMutationId,
        }, [
          el("div", { class: "es-sync-item-main" }, [
            el("strong", { text: humanType(item.type) }),
            el("small", { text: describeItem(item) }),
            el("p", { class: "es-sync-error", text: item.error || "The server refused this change." }),
            item.serverRecord && item.serverRecord.cardCode
              ? el("small", { text: `Card ${item.serverRecord.cardCode} on the server` })
              : null,
            item.serverRecord && item.serverRecord.studentIds
              ? el("small", { text: `${item.serverRecord.studentIds.length} student(s) already published or locked on the server` })
              : null,
            el("div", { class: "es-sync-actions" }, [
              el("button", {
                type: "button",
                class: "es-sync-btn",
                "data-retry": item.clientMutationId,
                onclick: async () => {
                  await ENGINE.resolveConflict(item.clientMutationId, "retry");
                  refresh();
                },
              }, "Retry"),
              el("button", {
                type: "button",
                class: "es-sync-btn es-sync-btn--ghost",
                "data-discard": item.clientMutationId,
                onclick: async () => {
                  await ENGINE.resolveConflict(item.clientMutationId, "discard");
                  refresh();
                },
              }, "Accept Server Version"),
            ]),
          ]),
          el("span", {
            class: "es-sync-tag" + (item.status === "conflict" ? " es-sync-tag--warn" : " es-sync-tag--danger"),
            text: item.status === "conflict" ? "Conflict" : "Refused",
          }),
        ]));
      }
    }
  }

  async function fillDevices() {
    if (!live() || !drawer) return;
    const list = drawer.querySelector("#esSyncDevices");
    if (!list) return;
    let devices = [];
    let error = "";
    try {
      const data = await window.API.get("/auth/devices");
      devices = (data && Array.isArray(data.devices)) ? data.devices : [];
      if (!devices.length && data && data.offline) error = "Showing the device list saved on this device; reconnect to refresh it.";
    } catch (e) {
      error = e && e.message ? e.message : "Could not load the signed-in devices.";
    }
    if (!live() || !drawer) return;
    clear(list);
    if (error) list.appendChild(el("p", { class: "es-sync-note", text: error }));
    if (!devices.length) {
      list.appendChild(el("p", { class: "es-sync-empty", text: "No other app or device sessions are signed in." }));
      return;
    }
    for (const device of devices) {
      list.appendChild(el("div", { class: "es-sync-item", "data-device-id": String(device.id) }, [
        el("div", { class: "es-sync-item-main" }, [
          el("strong", { text: device.deviceName || device.device_name || device.platform || "Device" }),
          el("small", {
            text: [
              device.platform || "",
              device.current || device.isCurrent ? "this device" : "",
              device.lastUsedAt || device.last_used_at ? `last used ${timeAgo(device.lastUsedAt || device.last_used_at)}` : "",
            ].filter(Boolean).join(" · "),
          }),
        ]),
        device.current || device.isCurrent
          ? el("span", { class: "es-sync-tag", text: "Current" })
          : el("button", {
            type: "button",
            class: "es-sync-btn es-sync-btn--ghost",
            "data-revoke": String(device.id),
            onclick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                await window.API.del(`/auth/devices/${device.id}`);
                button.textContent = "Signed out";
                setTimeout(refresh, 400);
              } catch (err) {
                button.disabled = false;
                button.textContent = "Sign out";
                list.appendChild(el("p", { class: "es-sync-note es-sync-note--warn", text: (err && err.message) || "Could not sign that device out." }));
              }
            },
          }, "Sign out"),
      ]));
    }
  }

  function refresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      applyState(ENGINE.state());
      if (drawer && !drawer.hidden) renderDrawer();
    }, 30);
  }

  function open() {
    ensureDrawer();
    lastFocused = document.activeElement;
    drawer.hidden = false;
    document.body.classList.add("es-sync-drawer-open");
    renderDrawer();
    const panel = drawer.querySelector(".es-sync-drawer");
    if (panel && panel.focus) panel.focus();
  }

  function close() {
    if (!drawer) return;
    drawer.hidden = true;
    document.body.classList.remove("es-sync-drawer-open");
    if (lastFocused && lastFocused.focus) {
      try { lastFocused.focus(); } catch (e) { /* ignore */ }
    }
  }

  function init() {
    if (!document.body) return;
    ensurePill();
    startObserver();
    ENGINE.subscribe(applyState);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && drawer && !drawer.hidden) close();
    });
    // A quiet re-mount check keeps the pill in the header across SPA renders
    // even in engines without MutationObserver.
    heartbeatTimer = setInterval(() => { if (live() && pill && !pill.isConnected) ensurePill(); }, 3000);
    try { if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref(); } catch (e) { /* browser timer */ }
  }

  window.SyncUI = {
    init,
    open,
    close,
    /** Removes the UI and stops its timers (used when the shell is torn down). */
    destroy() {
      destroyed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } observer = null; }
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
      if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
      if (drawer && drawer.parentNode) drawer.parentNode.removeChild(drawer);
      pill = null;
      drawer = null;
    },
    render: refresh,
    pill: () => pill,
    drawer: () => drawer,
    isOpen: () => Boolean(drawer && !drawer.hidden),
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
