"use strict";
/* ============================================================================
   SUBSCRIPTION & BILLING — dashboard module
   ----------------------------------------------------------------------------
   Institution side:  My Subscription · Plans & Pricing · Invoices & Payments
   Operator side:     Subscriptions · Payment Requests

   Renders inside the existing dashboard shell and design system, through the
   same contract as the payroll/leave modules: dashboard.js hands over the
   shared helpers (I, esc, toast, openModal…) and this module owns the markup.

   The single most important rule this UI enforces: asking for an upgrade is
   instant, but the plan only CHANGES after the operator confirms payment. The
   screens never paint a plan as active before that.
   ========================================================================== */
(function () {
  const TENANT_ROUTES = new Set(["subscription/overview", "subscription/plans", "subscription/invoices"]);
  const ADMIN_ROUTES = new Set(["platform/subscriptions", "platform/subscription-requests"]);

  function handles(route) {
    return TENANT_ROUTES.has(route) || ADMIN_ROUTES.has(route);
  }

  /* ------------------------------ helpers -------------------------------- */
  let C = null; // helper context injected by dashboard.js

  const money = (n) => `₦${Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const limitText = (n) => (Number(n) < 0 ? "Unlimited" : Number(n).toLocaleString("en-NG"));

  function head(crumb, title, sub, actions) {
    return `<div class="dash-page-head"><div><div class="dash-crumb">${C.esc(crumb)}</div><h2>${C.esc(title)}</h2>${sub ? `<p>${C.esc(sub)}</p>` : ""}</div>${actions ? `<div class="dash-actions">${actions}</div>` : ""}</div>`;
  }

  // Pill classes are the dashboard's own: .dash-pill + ok | warn | danger | info | muted.
  function statusPill(status) {
    const s = String(status || "active");
    const cls = s === "active" ? "ok" : s === "grace" ? "warn" : s === "suspended" ? "danger" : "danger";
    const label = { active: "Active", grace: "Grace period", expired: "Expired", suspended: "Suspended" }[s] || s;
    return `<span class="dash-pill ${cls}">${C.esc(label)}</span>`;
  }

  function invoicePill(status) {
    const s = String(status || "pending");
    const map = {
      pending: "warn", awaiting_approval: "info",
      paid: "ok", rejected: "danger", cancelled: "muted",
    };
    return `<span class="dash-pill ${map[s] || "muted"}">${C.esc(s.replace(/_/g, " "))}</span>`;
  }

  /** Usage bar. Colour follows the same thresholds the server warns on. */
  function usageBar(label, metric, warnPercent) {
    const pct = metric.unlimited ? 0 : Math.min(100, metric.percent);
    const cls = metric.state === "full" ? "sub-bar-full" : metric.state === "warning" ? "sub-bar-warning" : "";
    const caption = metric.unlimited
      ? `${metric.count.toLocaleString("en-NG")} used · unlimited on your plan`
      : `${metric.count.toLocaleString("en-NG")} of ${metric.limit.toLocaleString("en-NG")} used · ${metric.remaining.toLocaleString("en-NG")} left`;
    return `
      <div class="sub-usage">
        <div class="sub-usage-top">
          <span class="sub-usage-label">${C.esc(label)}</span>
          <span class="sub-usage-count">${C.esc(caption)}</span>
        </div>
        <div class="sub-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${C.esc(label)} usage">
          <div class="sub-bar-fill ${cls}" style="width:${metric.unlimited ? 6 : pct}%"></div>
        </div>
        ${!metric.unlimited && metric.state !== "ok"
          ? `<div class="sub-usage-note ${metric.state === "full" ? "is-full" : ""}">
               ${metric.state === "full"
                 ? "Limit reached — upgrading is required to add more."
                 : `You are at ${metric.percent}% of this limit (we warn at ${warnPercent}%).`}
             </div>`
          : ""}
      </div>`;
  }

  function copyButton(text, label) {
    return `<button type="button" class="dash-btn dash-btn-ghost dash-btn-sm" data-sub-copy="${C.esc(text)}">${C.esc(label || "Copy")}</button>`;
  }

  /* ========================================================================
     INSTITUTION — MY SUBSCRIPTION
     ======================================================================== */
  async function pageOverview(content) {
    let data;
    try {
      data = await window.API.get("/subscription");
    } catch (e) {
      content.innerHTML = head("Subscription", "My Subscription") +
        `<div class="dash-card"><div class="dash-card-pad"><p>${C.esc(e.message || "Could not load your subscription.")}</p></div></div>`;
      return;
    }

    const sub = data.subscription || {};
    const plan = data.plan || {};
    const warn = data.warn_percent || 80;
    const banners = [];

    if (sub.status === "expired") {
      banners.push(`<div class="sub-banner is-danger"><strong>Your subscription has expired.</strong> Your data is safe and fully readable — adding new students or teachers is paused until you renew.</div>`);
    } else if (sub.status === "grace") {
      banners.push(`<div class="sub-banner is-warning"><strong>Grace period.</strong> Your plan ended on ${C.esc(sub.expires_at || "—")}. You have until <strong>${C.esc(sub.grace_ends_at || "—")}</strong> to renew before new records are paused.</div>`);
    } else if (sub.status === "suspended") {
      banners.push(`<div class="sub-banner is-danger"><strong>Suspended.</strong> Please contact EduSphere to restore access.</div>`);
    } else if (sub.days_remaining !== null && sub.days_remaining <= 30) {
      banners.push(`<div class="sub-banner is-warning"><strong>Renewal due.</strong> Your plan renews on ${C.esc(sub.expires_at || "—")} — ${sub.days_remaining} day${sub.days_remaining === 1 ? "" : "s"} left.</div>`);
    }

    const openInvoice = (data.invoices || []).find((i) => ["pending", "awaiting_approval"].includes(i.status));
    if (openInvoice) {
      banners.push(`<div class="sub-banner is-info">
        <strong>${openInvoice.status === "awaiting_approval" ? "Payment submitted — awaiting confirmation." : "Upgrade requested."}</strong>
        ${C.esc(openInvoice.invoice_no)} · ${money(openInvoice.amount_ngn)} for the ${C.esc(openInvoice.plan_name || "")} plan.
        ${openInvoice.status === "pending" ? "Complete the transfer, then attach your receipt under Invoices &amp; Payments." : "The EduSphere team confirms payments manually — usually the same day."}
        <button class="dash-btn dash-btn-sm dash-btn-ghost" data-nav-route="subscription/invoices" style="margin-left:8px">View invoice</button>
      </div>`);
    }

    content.innerHTML = `
      ${head("Subscription", "My Subscription", "Your plan, usage and renewal date.",
        `<button class="dash-btn dash-btn-primary" data-nav-route="subscription/plans">${C.I.plus} Upgrade plan</button>`)}
      ${banners.join("")}
      <div class="dash-stats-grid">
        ${C.statCard("money", C.esc(plan.name || "—"), "Current plan", "accent", plan.code ? String(plan.code) : "")}
        ${C.statCard("clock", sub.expires_at ? C.esc(sub.expires_at) : "—", sub.status === "active" ? "Renews / expires" : "Ended", "", sub.days_remaining !== null ? `${sub.days_remaining} day${sub.days_remaining === 1 ? "" : "s"} left` : "")}
        ${C.statCard("users", data.usage.students.count.toLocaleString("en-NG"), "Students", "", data.usage.students.unlimited ? "unlimited" : `of ${limitText(data.usage.students.limit)}`)}
        ${C.statCard("teacher", data.usage.teachers.count.toLocaleString("en-NG"), "Teachers", "", data.usage.teachers.unlimited ? "unlimited" : `of ${limitText(data.usage.teachers.limit)}`)}
      </div>

      <div class="dash-grid-2">
        <div class="dash-card">
          <div class="dash-card-head"><h3>Plan &amp; status</h3>${statusPill(sub.status)}</div>
          <div class="dash-card-pad">
            <dl class="sub-defs">
              <div><dt>Plan</dt><dd>${C.esc(plan.name || "—")}${plan.description ? `<span class="sub-muted"> · ${C.esc(plan.description)}</span>` : ""}</dd></div>
              <div><dt>Billing cycle</dt><dd>${C.esc(sub.billing_cycle === "monthly" ? "Monthly" : "Yearly")}</dd></div>
              <div><dt>Started</dt><dd>${C.esc(sub.starts_at || "—")}</dd></div>
              <div><dt>Renews / expires</dt><dd>${C.esc(sub.expires_at || "—")}</dd></div>
              <div><dt>Student limit</dt><dd>${limitText(data.usage.students.limit)}</dd></div>
              <div><dt>Teacher limit</dt><dd>${limitText(data.usage.teachers.limit)}</dd></div>
            </dl>
            <div class="dash-actions" style="margin-top:16px">
              <button class="dash-btn dash-btn-ghost" data-nav-route="subscription/invoices">${C.I.file} Invoices</button>
              <button class="dash-btn dash-btn-primary" data-nav-route="subscription/plans">Compare plans</button>
            </div>
          </div>
        </div>

        <div class="dash-card">
          <div class="dash-card-head"><h3>Usage</h3><span class="sub-muted">Warns at ${warn}%</span></div>
          <div class="dash-card-pad">
            ${usageBar("Students", data.usage.students, warn)}
            ${usageBar("Teachers", data.usage.teachers, warn)}
            <p class="sub-muted" style="margin:14px 0 0">Reaching a limit pauses <em>new</em> students and teachers only. Everything you already have stays intact and readable.</p>
          </div>
        </div>
      </div>
    `;
    wireCopy(content);
    C.bindRouteButtons(content);
  }

  /* ========================================================================
     INSTITUTION — PLANS & PRICING
     ======================================================================== */
  let plansCycle = "yearly";

  async function pagePlans(content) {
    let data;
    try {
      data = await window.API.get("/subscription/plans");
    } catch (e) {
      content.innerHTML = head("Subscription", "Plans & Pricing") +
        `<div class="dash-card"><div class="dash-card-pad"><p>${C.esc(e.message || "Could not load plans.")}</p></div></div>`;
      return;
    }
    const plans = data.plans || [];
    const billing = data.billing || {};

    content.innerHTML = `
      ${head("Subscription", "Plans & Pricing", "Choose a plan, then pay by bank transfer. Your plan activates once the payment is confirmed.")}
      <div class="sub-cycle-switch">
        <button type="button" class="sub-cycle ${plansCycle === "monthly" ? "is-active" : ""}" data-cycle="monthly">Monthly</button>
        <button type="button" class="sub-cycle ${plansCycle === "yearly" ? "is-active" : ""}" data-cycle="yearly">Yearly <span class="sub-save">save more</span></button>
      </div>
      <div class="sub-plans">
        ${plans.map((p) => {
          const price = plansCycle === "yearly" ? (Number(p.price_yearly_ngn) || Number(p.price_ngn) * 12) : Number(p.price_ngn);
          const isCurrent = Number(p.id) === Number(data.current_plan_id);
          return `
          <div class="sub-plan ${isCurrent ? "is-current" : ""}">
            ${isCurrent ? `<div class="sub-plan-flag">Current plan</div>` : ""}
            <h3>${C.esc(p.name)}</h3>
            ${p.description ? `<p class="sub-plan-desc">${C.esc(p.description)}</p>` : ""}
            <div class="sub-price">${money(price)}<small>/ ${plansCycle === "yearly" ? "year" : "month"}</small></div>
            <ul class="sub-plan-features">
              <li><strong>${limitText(p.student_limit)}</strong> students</li>
              <li><strong>${limitText(p.teacher_limit)}</strong> teachers</li>
              ${Number(p.trial_days) > 0 ? `<li>${p.trial_days}-day trial</li>` : ""}
            </ul>
            ${isCurrent
              ? `<button class="dash-btn dash-btn-ghost" disabled>Current plan</button>`
              : `<button class="dash-btn dash-btn-primary" data-sub-upgrade="${p.id}" data-sub-plan="${C.esc(p.name)}">Choose ${C.esc(p.name)}</button>`}
          </div>`;
        }).join("") || `<div class="dash-card"><div class="dash-card-pad">No plans are published yet. Please contact EduSphere.</div></div>`}
      </div>

      <div class="dash-card" style="margin-top:20px">
        <div class="dash-card-head"><h3>How payment works</h3></div>
        <div class="dash-card-pad">
          <ol class="sub-steps">
            <li><strong>Choose a plan</strong> and a billing cycle above.</li>
            <li><strong>Transfer the amount</strong> to the account shown on your invoice, using the reference we generate for you.</li>
            <li><strong>Attach your receipt</strong> under Invoices &amp; Payments.</li>
            <li><strong>We confirm and activate.</strong> Your plan extends the moment payment is confirmed — usually the same day.</li>
          </ol>
          <p class="sub-muted" style="margin-top:14px">Your data is never deleted while a payment is pending.</p>
        </div>
      </div>
    `;

    content.querySelectorAll("[data-cycle]").forEach((b) => b.addEventListener("click", () => {
      plansCycle = b.getAttribute("data-cycle");
      pagePlans(content);
    }));
    content.querySelectorAll("[data-sub-upgrade]").forEach((b) => b.addEventListener("click", () => {
      openUpgradeModal(Number(b.getAttribute("data-sub-upgrade")), b.getAttribute("data-sub-plan"), plansCycle, content, billing, data.card_enabled);
    }));
    wireCopy(content);
    C.bindRouteButtons(content);
  }

  function openUpgradeModal(planId, planName, cycle, content, billing, cardEnabled) {
    const wrap = C.openModal(`Upgrade to ${planName}`, `
      <form id="subUpgradeForm">
        <div class="dash-form-grid">
          <div class="dash-field">
            <label>Billing cycle</label>
            <select name="billing_cycle">
              <option value="yearly" ${cycle === "yearly" ? "selected" : ""}>Yearly — best value</option>
              <option value="monthly" ${cycle === "monthly" ? "selected" : ""}>Monthly</option>
            </select>
          </div>
          <div class="dash-field">
            <label>Payment method</label>
            <select name="payment_method">
              <option value="bank_transfer">Bank transfer</option>
              ${cardEnabled ? `<option value="card">Card (online)</option>` : ""}
            </select>
          </div>
          <div class="dash-field" style="grid-column:1/-1">
            <label>Note (optional)</label>
            <textarea name="note" placeholder="Anything the EduSphere team should know about this payment"></textarea>
          </div>
        </div>
        <div class="dash-modal-foot" style="margin:18px -22px -20px;border-top:1px solid var(--d-line);">
          <button class="dash-btn dash-btn-ghost" type="button" id="subUpgradeCancel">Cancel</button>
          <button class="dash-btn dash-btn-primary" type="submit">${C.I.check} Request upgrade</button>
        </div>
      </form>`);
    wrap.querySelector("#subUpgradeCancel").addEventListener("click", C.closeModal);
    wrap.querySelector("#subUpgradeForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = "Preparing…";
      try {
        const res = await window.API.post("/subscription/upgrade", {
          plan_id: planId,
          billing_cycle: fd.get("billing_cycle"),
          payment_method: fd.get("payment_method"),
          note: fd.get("note"),
        });
        C.closeModal();
        C.toast(res.already_open ? "You already have an open request — here it is." : "Upgrade request created.", "success");
        await pageInvoices(content);
        C.go("subscription/invoices");
      } catch (err2) {
        C.toast(err2.message || "Could not create the request.", "error");
        btn.disabled = false;
        btn.textContent = "Request upgrade";
      }
    });
  }

  /* ========================================================================
     INSTITUTION — INVOICES & PAYMENTS
     ======================================================================== */
  async function pageInvoices(content) {
    let invoices = [];
    try {
      const d = await window.API.get("/subscription/invoices");
      invoices = d.invoices || [];
    } catch (e) {
      content.innerHTML = head("Subscription", "Invoices & Payments") +
        `<div class="dash-card"><div class="dash-card-pad"><p>${C.esc(e.message || "Could not load invoices.")}</p></div></div>`;
      return;
    }

    content.innerHTML = `
      ${head("Subscription", "Invoices & Payments", "Every subscription payment request and its status.",
        `<button class="dash-btn dash-btn-primary" data-nav-route="subscription/plans">${C.I.plus} New payment</button>`)}
      <div class="dash-card"><div class="dash-table-wrap"><table class="dash-table">
        <thead><tr><th>Invoice</th><th>Plan</th><th>Amount</th><th>Cycle</th><th>Status</th><th>Raised</th><th style="text-align:right"></th></tr></thead>
        <tbody>
          ${invoices.length ? invoices.map((i) => `
            <tr>
              <td><strong>${C.esc(i.invoice_no)}</strong><div class="sub-muted">Ref ${C.esc(i.reference)}</div></td>
              <td>${C.esc(i.plan_name || "—")}</td>
              <td>${money(i.amount_ngn)}</td>
              <td>${C.esc(i.billing_cycle === "monthly" ? "Monthly" : "Yearly")}</td>
              <td>${invoicePill(i.status)}</td>
              <td>${C.esc(String(i.created_at).slice(0, 10))}</td>
              <td style="text-align:right;white-space:nowrap">
                ${["pending", "awaiting_approval", "rejected"].includes(i.status)
                  ? `<button class="dash-btn dash-btn-sm dash-btn-primary" data-sub-proof="${i.id}">${i.proof_path ? "Replace receipt" : "Attach receipt"}</button>`
                  : ""}
                <a class="dash-btn dash-btn-sm dash-btn-ghost" href="${window.API.url("/subscription/invoices/" + i.id + "/receipt")}" target="_blank" rel="noopener">${C.I.file} ${i.status === "paid" ? "Receipt" : "Invoice"}</a>
                ${["pending", "awaiting_approval"].includes(i.status)
                  ? `<button class="dash-btn dash-btn-sm dash-btn-ghost" data-sub-cancel="${i.id}">Cancel</button>`
                  : ""}
              </td>
            </tr>`).join("")
            : `<tr class="dash-empty-row"><td colspan="7">No invoices yet. Choose a plan to raise your first one.</td></tr>`}
        </tbody>
      </table></div></div>
    `;

    content.querySelectorAll("[data-sub-proof]").forEach((b) => b.addEventListener("click", () => openProofModal(Number(b.getAttribute("data-sub-proof")), content)));
    content.querySelectorAll("[data-sub-cancel]").forEach((b) => b.addEventListener("click", async () => {
      if (!window.confirm("Cancel this payment request?")) return;
      try { await window.API.post("/subscription/invoices/" + b.getAttribute("data-sub-cancel") + "/cancel", {}); C.toast("Request cancelled.", "success"); pageInvoices(content); }
      catch (e) { C.toast(e.message || "Could not cancel.", "error"); }
    }));
    C.bindRouteButtons(content);
  }

  function openProofModal(invoiceId, content) {
    const wrap = C.openModal("Attach proof of payment", `
      <form id="subProofForm">
        <div class="dash-form-grid">
          <div class="dash-field" style="grid-column:1/-1">
            <label>Receipt / transfer screenshot <span class="req">*</span></label>
            <input type="file" name="proof" accept="image/*" required>
            <span class="sub-muted">JPG, PNG or WEBP. A clear photo of the transfer confirmation is enough.</span>
          </div>
          <div class="dash-field" style="grid-column:1/-1">
            <label>Note (optional)</label>
            <textarea name="payer_note" placeholder="Account name you paid from, or anything we should know"></textarea>
          </div>
        </div>
        <div class="dash-modal-foot" style="margin:18px -22px -20px;border-top:1px solid var(--d-line);">
          <button class="dash-btn dash-btn-ghost" type="button" id="subProofCancel">Cancel</button>
          <button class="dash-btn dash-btn-primary" type="submit">${C.I.check} Submit for approval</button>
        </div>
      </form>`);
    wrap.querySelector("#subProofCancel").addEventListener("click", C.closeModal);
    wrap.querySelector("#subProofForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = "Uploading…";
      try {
        await window.API.post("/subscription/invoices/" + invoiceId + "/proof", fd);
        C.closeModal();
        C.toast("Receipt submitted. We will confirm the payment shortly.", "success");
        pageInvoices(content);
      } catch (err) {
        C.toast(err.message || "Upload failed.", "error");
        btn.disabled = false; btn.textContent = "Submit for approval";
      }
    });
  }

  function wireCopy(content) {
    content.querySelectorAll("[data-sub-copy]").forEach((b) => b.addEventListener("click", async () => {
      const text = b.getAttribute("data-sub-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
        const old = b.textContent;
        b.textContent = "Copied";
        setTimeout(() => { b.textContent = old; }, 1400);
      } catch (e) { C.toast("Could not copy — please select and copy manually.", "error"); }
    }));
  }

  /* ========================================================================
     OPERATOR — SUBSCRIPTIONS
     ======================================================================== */
  async function pageAdminSubscriptions(content) {
    let data;
    try {
      data = await window.API.get("/platform/subscriptions");
    } catch (e) {
      content.innerHTML = head("Platform", "Subscriptions") +
        `<div class="dash-card"><div class="dash-card-pad"><p>${C.esc(e.message || "Could not load subscriptions.")}</p></div></div>`;
      return;
    }
    const list = data.subscriptions || [];
    const stats = data.stats || {};

    content.innerHTML = `
      ${head("Platform", "Subscriptions", "Every institution's plan, renewal date and usage.",
        `<button class="dash-btn dash-btn-primary" data-nav-route="platform/subscription-requests">${C.I.money} Payment requests${stats.pendingApprovals ? ` (${stats.pendingApprovals})` : ""}</button>`)}
      <div class="dash-stats-grid">
        ${C.statCard("building", stats.institutions || 0, "Institutions")}
        ${C.statCard("check", (stats.byStatus && stats.byStatus.active) || 0, "Active")}
        ${C.statCard("clock", stats.expiringSoon || 0, "Expiring in 30 days", "accent")}
        ${C.statCard("money", money(stats.estimatedMrrNgn || 0), "Estimated MRR", "accent")}
      </div>
      <div class="dash-card"><div class="dash-table-wrap"><table class="dash-table">
        <thead><tr><th>Institution</th><th>Plan</th><th>Status</th><th>Renews</th><th>Students</th><th>Teachers</th><th style="text-align:right"></th></tr></thead>
        <tbody>
          ${list.length ? list.map((r) => `
            <tr class="${r.effective_status === "expired" || r.effective_status === "suspended" ? "sub-row-danger" : r.effective_status === "grace" ? "sub-row-warning" : ""}">
              <td><strong>${C.esc(r.name_en)}</strong><div class="sub-muted">${C.esc(r.slug)}</div></td>
              <td>${C.esc(r.plan_name || "—")}<div class="sub-muted">${C.esc(r.billing_cycle || "")}</div></td>
              <td>${statusPill(r.effective_status)}</td>
              <td>${C.esc(r.plan_expires_at || "—")}${r.days_remaining !== null ? `<div class="sub-muted">${r.days_remaining}d</div>` : ""}</td>
              <td class="${r.student_limit >= 0 && r.students > r.student_limit ? "sub-over" : ""}">${r.students}${r.student_limit >= 0 ? ` / ${r.student_limit}` : ""}</td>
              <td class="${r.teacher_limit >= 0 && r.teachers > r.teacher_limit ? "sub-over" : ""}">${r.teachers}${r.teacher_limit >= 0 ? ` / ${r.teacher_limit}` : ""}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="dash-btn dash-btn-sm dash-btn-ghost" data-sub-manage="${r.id}" data-sub-name="${C.esc(r.name_en)}">Manage</button>
              </td>
            </tr>`).join("")
            : `<tr class="dash-empty-row"><td colspan="7">No institutions yet.</td></tr>`}
        </tbody>
      </table></div></div>
    `;

    content.querySelectorAll("[data-sub-manage]").forEach((b) => b.addEventListener("click", () => {
      openManageModal(Number(b.getAttribute("data-sub-manage")), b.getAttribute("data-sub-name"), content);
    }));
    C.bindRouteButtons(content);
  }

  async function openManageModal(madrasaId, name, content) {
    const [plansData, subData] = await Promise.all([
      window.API.get("/platform/plans").catch(() => ({ plans: [] })),
      window.API.get("/platform/subscriptions/" + madrasaId).catch(() => null),
    ]);
    const plans = plansData.plans || [];
    const current = subData ? subData.subscription : null;
    const wrap = C.openModal(`Subscription — ${name}`, `
      <form id="subManageForm">
        <div class="dash-form-grid">
          <div class="dash-field">
            <label>Plan</label>
            <select name="plan_id">${plans.map((p) => `<option value="${p.id}" ${current && Number(p.id) === Number(current.plan.id) ? "selected" : ""}>${C.esc(p.name)} — ${money(p.price_ngn)}/mo</option>`).join("")}</select>
          </div>
          <div class="dash-field">
            <label>Billing cycle</label>
            <select name="billing_cycle">
              <option value="yearly" ${current && current.subscription.billing_cycle === "yearly" ? "selected" : ""}>Yearly</option>
              <option value="monthly" ${current && current.subscription.billing_cycle === "monthly" ? "selected" : ""}>Monthly</option>
            </select>
          </div>
          <div class="dash-field">
            <label>Extend by (months)</label>
            <input name="months" type="number" min="0" step="1" placeholder="Blank = one full cycle">
          </div>
          <div class="dash-field">
            <label>Status</label>
            <select name="status">
              <option value="active" ${current && current.subscription.status === "active" ? "selected" : ""}>Active</option>
              <option value="grace" ${current && current.subscription.status === "grace" ? "selected" : ""}>Grace period</option>
              <option value="suspended" ${current && current.subscription.status === "suspended" ? "selected" : ""}>Suspended</option>
            </select>
          </div>
          <div class="dash-field" style="grid-column:1/-1">
            <label>Note (internal)</label>
            <input name="note" placeholder="Why this change was made">
          </div>
        </div>
        ${current ? `<p class="sub-muted" style="margin-top:10px">Currently <strong>${C.esc(current.plan.name)}</strong>, ${C.esc(current.subscription.status)}, expires ${C.esc(current.subscription.expires_at || "—")}.</p>` : ""}
        <div class="dash-modal-foot" style="margin:18px -22px -20px;border-top:1px solid var(--d-line);">
          <button class="dash-btn dash-btn-ghost" type="button" id="subManageCancel">Cancel</button>
          <button class="dash-btn dash-btn-primary" type="submit">${C.I.check} Apply</button>
        </div>
      </form>`);
    wrap.querySelector("#subManageCancel").addEventListener("click", C.closeModal);
    wrap.querySelector("#subManageForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = "Applying…";
      try {
        const note = fd.get("note");
        const status = fd.get("status");
        if (status !== (current ? current.subscription.status : "active")) {
          await window.API.post(`/platform/subscriptions/${madrasaId}/status`, { status, note });
        } else {
          await window.API.post(`/platform/subscriptions/${madrasaId}/grant`, {
            plan_id: Number(fd.get("plan_id")),
            billing_cycle: fd.get("billing_cycle"),
            months: fd.get("months") ? Number(fd.get("months")) : 0,
            note,
          });
        }
        C.closeModal();
        C.toast("Subscription updated.", "success");
        pageAdminSubscriptions(content);
      } catch (err) {
        C.toast(err.message || "Could not update.", "error");
        btn.disabled = false; btn.textContent = "Apply";
      }
    });
  }

  /* ========================================================================
     OPERATOR — PAYMENT REQUESTS (approval queue)
     ======================================================================== */
  async function pageAdminRequests(content) {
    let invoices = [];
    try {
      const d = await window.API.get("/platform/subscriptions/invoices");
      invoices = d.invoices || [];
    } catch (e) {
      content.innerHTML = head("Platform", "Payment requests") +
        `<div class="dash-card"><div class="dash-card-pad"><p>${C.esc(e.message || "Could not load requests.")}</p></div></div>`;
      return;
    }

    content.innerHTML = `
      ${head("Platform", "Payment requests", "Confirm transfers and activate subscriptions.",
        `<button class="dash-btn dash-btn-ghost" data-nav-route="platform/subscriptions">${C.I.building} All subscriptions</button>`)}
      <div class="dash-card"><div class="dash-table-wrap"><table class="dash-table">
        <thead><tr><th>Invoice</th><th>Institution</th><th>Plan</th><th>Amount</th><th>Reference</th><th>Proof</th><th>Status</th><th style="text-align:right"></th></tr></thead>
        <tbody>
          ${invoices.length ? invoices.map((i) => `
            <tr>
              <td><strong>${C.esc(i.invoice_no)}</strong><div class="sub-muted">${C.esc(String(i.created_at).slice(0, 10))}</div></td>
              <td>${C.esc(i.madrasa_name || "—")}</td>
              <td>${C.esc(i.plan_name || "—")}<div class="sub-muted">${C.esc(i.billing_cycle || "")}</div></td>
              <td><strong>${money(i.amount_ngn)}</strong></td>
              <td>${copyButton(i.reference, C.esc(i.reference))}</td>
              <td>${i.proof_path
                ? `<a class="dash-btn dash-btn-sm dash-btn-ghost" href="${C.esc(i.proof_path)}" target="_blank" rel="noopener">${C.I.image} View</a>`
                : `<span class="sub-muted">Not attached</span>`}</td>
              <td>${invoicePill(i.status)}</td>
              <td style="text-align:right;white-space:nowrap">
                ${["pending", "awaiting_approval"].includes(i.status) ? `
                  <button class="dash-btn dash-btn-sm dash-btn-primary" data-sub-approve="${i.id}">${C.I.check} Approve</button>
                  <button class="dash-btn dash-btn-sm dash-btn-ghost" data-sub-reject="${i.id}">Reject</button>` : ""}
              </td>
            </tr>`).join("")
            : `<tr class="dash-empty-row"><td colspan="8">Nothing waiting. Every transfer has been confirmed.</td></tr>`}
        </tbody>
      </table></div></div>
    `;

    content.querySelectorAll("[data-sub-approve]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.getAttribute("data-sub-approve");
      if (!window.confirm("Confirm this payment and activate the subscription?")) return;
      b.disabled = true;
      try {
        await window.API.post(`/platform/subscriptions/invoices/${id}/approve`, {});
        C.toast("Payment confirmed — subscription activated.", "success");
        pageAdminRequests(content);
      } catch (e) { C.toast(e.message || "Could not approve.", "error"); b.disabled = false; }
    }));
    content.querySelectorAll("[data-sub-reject]").forEach((b) => b.addEventListener("click", () => {
      const id = b.getAttribute("data-sub-reject");
      const reason = window.prompt("Why could the payment not be confirmed? The institution will see this.");
      if (!reason) return;
      window.API.post(`/platform/subscriptions/invoices/${id}/reject`, { reason })
        .then(() => { C.toast("Rejected.", "success"); pageAdminRequests(content); })
        .catch((e) => C.toast(e.message || "Could not reject.", "error"));
    }));
    wireCopy(content);
    C.bindRouteButtons(content);
  }

  /* ------------------------------ entry ---------------------------------- */
  async function render(ctx, content, route) {
    C = ctx;
    if (route === "subscription/overview") return pageOverview(content);
    if (route === "subscription/plans") return pagePlans(content);
    if (route === "subscription/invoices") return pageInvoices(content);
    if (route === "platform/subscriptions") return pageAdminSubscriptions(content);
    if (route === "platform/subscription-requests") return pageAdminRequests(content);
    return pageOverview(content);
  }

  window.EduSphereSubscription = { handles, render, TENANT_ROUTES, ADMIN_ROUTES };
})();
