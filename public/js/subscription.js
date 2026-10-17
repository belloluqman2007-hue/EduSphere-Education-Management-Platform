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

  /** "What your plan includes" — benefits, not ceilings. */
  function includedCardHTML(data) {
    const ent = data.entitlements || null;
    const offer = (data.plan && data.plan.offer) || null;
    const groups = (ent && ent.enabled) || [];
    const count = (ent && ent.enabled_keys || []).length;
    return `
      <div class="dash-card" style="margin-top:20px">
        <div class="dash-card-head">
          <h3>What your ${C.esc((data.plan && data.plan.name) || "plan")} includes</h3>
          <span class="sub-muted">${count} capability${count === 1 ? "" : "s"}</span>
        </div>
        <div class="dash-card-pad">
          ${offer && offer.quick_win ? `<div class="sub-quickwin"><span class="sub-quickwin-label">Quick win</span><p>${C.esc(offer.quick_win)}</p>${offer.quick_win_detail ? `<p class="sub-muted">${C.esc(offer.quick_win_detail)}</p>` : ""}</div>` : ""}
          ${groups.length ? `<div class="sub-benefits">${groups.map((g) => `
            <div class="sub-benefit-group">
              <h4>${C.esc(g.title)}</h4>
              <ul>${g.items.map((i) => `<li title="${C.esc(i.blurb || "")}">${C.esc(i.label)}</li>`).join("")}</ul>
            </div>`).join("")}</div>`
            : `<p class="sub-muted">Nothing is switched on for this plan yet.</p>`}
          <div class="dash-actions" style="margin-top:16px">
            <button class="dash-btn dash-btn-ghost" data-nav-route="subscription/plans">Compare plans &amp; pricing</button>
          </div>
        </div>
      </div>`;
  }

  /** The next tier, in the words that tier uses to sell itself. */
  function nextTierCardHTML(data) {
    const next = data.entitlements && data.entitlements.next_tier;
    if (!next) {
      return `
        <div class="dash-card" style="margin-top:20px">
          <div class="dash-card-pad">
            <strong>You are on the highest tier.</strong>
            <span class="sub-muted"> Every capability EduSphere has is switched on for your institution.</span>
          </div>
        </div>`;
    }
    const newFeatures = (next.new_features || []).slice(0, 6);
    return `
      <div class="dash-card sub-next-tier" style="margin-top:20px">
        <div class="dash-card-head">
          <h3>Unlock ${C.esc(next.name)} — “${C.esc(next.tagline || "")}”</h3>
          <span class="dash-pill info">${newFeatures.length}+ new capabilities</span>
        </div>
        <div class="dash-card-pad">
          ${next.quick_win ? `<div class="sub-quickwin"><span class="sub-quickwin-label">Quick win</span><p>${C.esc(next.quick_win)}</p></div>` : ""}
          ${(next.headline || []).length ? `<ul class="sub-plan-features">${next.headline.map((h) => `<li>${C.esc(h)}</li>`).join("")}</ul>` : ""}
          ${newFeatures.length ? `<p class="sub-muted" style="margin-top:10px">Adds: ${C.esc(newFeatures.map((f) => f.label).join(", "))}${(next.new_features || []).length > newFeatures.length ? " and more" : ""}.</p>` : ""}
          <div class="dash-actions" style="margin-top:14px">
            <button class="dash-btn dash-btn-primary" data-nav-route="subscription/plans">See what ${C.esc(next.name)} includes</button>
          </div>
        </div>
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

      ${includedCardHTML(data)}
      ${nextTierCardHTML(data)}
    `;
    wireCopy(content);
    C.bindRouteButtons(content);
  }

  /* ========================================================================
     INSTITUTION — PLANS & PRICING
     ------------------------------------------------------------------------
     This screen sells. Every tier states what the school GETS (benefit groups,
     the quick win, the limits) — never a bare list of ceilings — and every card
     ends in one obvious action. All copy comes from the server's plan
     catalogue, so what is promised here is exactly what the feature gates
     enforce.
     ======================================================================== */
  let plansCycle = "yearly";

  const TIER_ORDER = ["free", "basic", "premium"];
  const tierIndex = (code) => { const i = TIER_ORDER.indexOf(String(code || "").toLowerCase()); return i < 0 ? 0 : i; };

  function priceFor(offer, cycle) {
    const monthly = Number((offer.price && offer.price.monthly_ngn) || 0);
    const yearly = Number((offer.price && offer.price.yearly_ngn) || 0) || monthly * 12;
    return cycle === "yearly" ? yearly : monthly;
  }

  function ctaLabel(offer, isCurrent, currentCode) {
    if (isCurrent) return "Your current plan";
    const target = tierIndex(offer.code);
    const current = tierIndex(currentCode);
    if (target > current) return `Upgrade to ${offer.name}`;
    return `Switch to ${offer.name}`;
  }

  function benefitGroupsHTML(offer, limit) {
    const groups = (offer.benefit_groups || []).slice(0, limit || (offer.benefit_groups || []).length);
    return groups.map((g) => `
      <div class="sub-benefit-group">
        <h4>${C.esc(g.title)}</h4>
        <ul>${(g.items || []).map((item) => `<li>${C.esc(item)}</li>`).join("")}</ul>
      </div>`).join("");
  }

  function planCardHTML(offer, data, cycle) {
    const isCurrent = Number(offer.id) === Number(data.current_plan_id);
    const currentCode = (data.current_plan || data.current_plan_code || "");
    const price = priceFor(offer, cycle);
    const monthly = Number((offer.price && offer.price.monthly_ngn) || 0);
    const saves = Number((offer.price && offer.price.yearly_saves_ngn) || 0);
    const isUpgrade = tierIndex(offer.code) > tierIndex(currentCode);
    const recommended = !isCurrent && (
      (tierIndex(currentCode) === 0 && offer.code === "basic") ||
      (tierIndex(currentCode) >= 1 && offer.code === "premium")
    );
    const flags = [];
    if (isCurrent) flags.push(`<span class="sub-plan-flag">Current plan</span>`);
    if (offer.badge && !isCurrent) flags.push(`<span class="sub-plan-flag sub-plan-flag-badge">${C.esc(offer.badge)}</span>`);
    if (recommended) flags.push(`<span class="sub-plan-flag sub-plan-flag-recommended">Recommended for you</span>`);

    return `
      <article class="sub-plan sub-plan-${C.esc(offer.code)} ${isCurrent ? "is-current" : ""} ${recommended ? "is-recommended" : ""}">
        <div class="sub-plan-flags">${flags.join("")}</div>
        <header class="sub-plan-head">
          <h3>${C.esc(offer.name)}</h3>
          <p class="sub-plan-tagline">“${C.esc(offer.tagline || offer.description || "")}”</p>
        </header>

        <div class="sub-price">
          ${price > 0 ? money(price) : "Free"}
          <small>${price > 0 ? `/ ${cycle === "yearly" ? "year" : "month"}` : "· no card needed"}</small>
        </div>
        <div class="sub-price-note">
          ${price > 0 && cycle === "yearly" && monthly > 0 ? `${money(monthly)} per month` : ""}
          ${cycle === "yearly" && saves > 0 ? ` · <strong>save ${money(saves)}</strong>` : ""}
          ${Number(offer.trial_days) > 0 ? ` · ${offer.trial_days}-day trial` : ""}
        </div>

        <ul class="sub-plan-limits">
          <li><strong>${C.esc((offer.limits && offer.limits.students_copy) || limitText(offer.student_limit))}</strong></li>
          <li><strong>${C.esc((offer.limits && offer.limits.teachers_copy) || limitText(offer.teacher_limit))}</strong></li>
        </ul>

        ${offer.quick_win ? `
          <div class="sub-quickwin">
            <span class="sub-quickwin-label">Quick win</span>
            <p>${C.esc(offer.quick_win)}</p>
            ${offer.quick_win_detail ? `<p class="sub-muted">${C.esc(offer.quick_win_detail)}</p>` : ""}
          </div>` : ""}

        <div class="sub-benefits">${benefitGroupsHTML(offer, 4)}</div>

        <div class="sub-plan-actions">
          ${isCurrent
            ? `<button class="dash-btn dash-btn-ghost" disabled>Your current plan</button>`
            : `<button class="dash-btn ${isUpgrade ? "dash-btn-primary" : "dash-btn-ghost"}" data-sub-upgrade="${offer.id}" data-sub-plan="${C.esc(offer.name)}" data-sub-code="${C.esc(offer.code)}">${C.esc(ctaLabel(offer, isCurrent, currentCode))}</button>`}
          <button class="dash-btn dash-btn-ghost dash-btn-sm" data-sub-details="${offer.id}">
            Everything included (${(offer.feature_keys || []).length})
          </button>
        </div>
      </article>`;
  }

  /** Feature-by-feature matrix: the "compare everything" answer. */
  function comparisonHTML(plans) {
    if (!plans.length) return "";
    const tiers = plans.slice().sort((a, b) => tierIndex(a.code) - tierIndex(b.code));
    const groups = [];
    for (const plan of tiers) {
      for (const benefit of plan.offer_benefits || plan.benefits || []) {
        const group = groups.find((g) => g.key === benefit.group) || { key: benefit.group, title: benefit.group_title || benefit.group, rows: [] };
        if (!groups.includes(group)) groups.push(group);
        const row = group.rows.find((r) => r.key === benefit.key) || { key: benefit.key, label: benefit.label, blurb: benefit.blurb, tiers: {} };
        if (!group.rows.includes(row)) group.rows.push(row);
        row.tiers[plan.code] = true;
      }
      for (const locked of plan.offer_locked || plan.locked || []) {
        const group = groups.find((g) => g.key === locked.group) || { key: locked.group, title: locked.group_title || locked.group, rows: [] };
        if (!groups.includes(group)) groups.push(group);
        const row = group.rows.find((r) => r.key === locked.key) || { key: locked.key, label: locked.label, blurb: locked.blurb, tiers: {} };
        if (!group.rows.includes(row)) group.rows.push(row);
        row.tiers[plan.code] = false;
      }
    }
    const yes = `<span class="sub-yes" title="Included">✓</span>`;
    const no = `<span class="sub-no" title="Not included">—</span>`;
    return `
      <div class="dash-card" style="margin-top:20px">
        <div class="dash-card-head"><h3>Compare every feature</h3><span class="sub-muted">${groups.reduce((a, g) => a + g.rows.length, 0)} capabilities</span></div>
        <div class="dash-table-wrap"><table class="dash-table sub-compare">
          <thead><tr>
            <th>What the school gets</th>
            ${tiers.map((p) => `<th class="sub-compare-tier">${C.esc(p.name)}<div class="sub-muted">${C.esc((p.offer && p.offer.limits && p.offer.limits.students_copy) || limitText(p.student_limit))}</div></th>`).join("")}
          </tr></thead>
          <tbody>
            ${groups.map((g) => `
              <tr class="sub-compare-group"><td colspan="${tiers.length + 1}">${C.esc(g.title || g.key)}</td></tr>
              ${g.rows.map((r) => `
                <tr>
                  <td><strong>${C.esc(r.label)}</strong><div class="sub-muted">${C.esc(r.blurb || "")}</div></td>
                  ${tiers.map((p) => `<td class="sub-compare-cell">${r.tiers[p.code] ? yes : no}</td>`).join("")}
                </tr>`).join("")}
            `).join("")}
          </tbody>
        </table></div>
      </div>`;
  }

  async function pagePlans(content) {
    let data;
    try {
      data = await window.API.get("/subscription/plans");
    } catch (e) {
      content.innerHTML = head("Subscription", "Plans & Pricing") +
        `<div class="dash-card"><div class="dash-card-pad"><p>${C.esc(e.message || "Could not load plans.")}</p></div></div>`;
      return;
    }
    const plans = (data.plans || []).slice().sort((a, b) => tierIndex(a.code) - tierIndex(b.code));
    const billing = data.billing || {};
    const currentCode = data.current_plan_code || "";
    const current = plans.find((p) => Number(p.id) === Number(data.current_plan_id)) || null;
    const nextTier = plans.find((p) => tierIndex(p.code) === tierIndex(currentCode) + 1) || null;

    content.innerHTML = `
      ${head("Subscription", "Plans & Pricing",
        "Three tiers, one platform. Pick what your school needs to do next — your plan changes the moment your payment is confirmed.",
        `<button class="dash-btn dash-btn-ghost" data-nav-route="subscription/overview">${C.I.clock} My subscription</button>`)}

      ${nextTier ? `
        <div class="sub-banner is-info sub-upsell-banner">
          <div>
            <strong>You are on ${C.esc(current ? current.name : currentCode || "a plan")}.</strong>
            ${C.esc(nextTier.name)} — “${C.esc((nextTier.offer && nextTier.offer.tagline) || "")}” — adds
            ${C.esc(((nextTier.offer && nextTier.offer.headline) || []).slice(0, 3).join(", "))}.
            ${(nextTier.offer && nextTier.offer.quick_win) ? `<div class="sub-muted">Quick win: ${C.esc(nextTier.offer.quick_win)}</div>` : ""}
          </div>
          <button class="dash-btn dash-btn-primary dash-btn-sm" data-sub-upgrade="${nextTier.id}" data-sub-plan="${C.esc(nextTier.name)}" data-sub-code="${C.esc(nextTier.code)}">Upgrade to ${C.esc(nextTier.name)}</button>
        </div>` : ""}

      <div class="sub-cycle-switch" role="group" aria-label="Billing cycle">
        <button type="button" class="sub-cycle ${plansCycle === "monthly" ? "is-active" : ""}" data-cycle="monthly" aria-pressed="${plansCycle === "monthly"}">Monthly</button>
        <button type="button" class="sub-cycle ${plansCycle === "yearly" ? "is-active" : ""}" data-cycle="yearly" aria-pressed="${plansCycle === "yearly"}">Yearly <span class="sub-save">2 months free</span></button>
      </div>

      <div class="sub-plans">
        ${plans.map((p) => planCardHTML(p.offer || p, Object.assign({}, data, { current_plan: currentCode }), plansCycle)).join("")
          || `<div class="dash-card"><div class="dash-card-pad">No plans are published yet. Please contact EduSphere.</div></div>`}
      </div>

      ${comparisonHTML(plans.map((p) => Object.assign({}, p, {
        offer_benefits: (p.offer && p.offer.benefits) || [],
        offer_locked: (p.offer && p.offer.locked) || [],
      })))}

      <div class="dash-card" style="margin-top:20px">
        <div class="dash-card-head"><h3>How payment works</h3></div>
        <div class="dash-card-pad">
          <ol class="sub-steps">
            <li><strong>Choose a plan</strong> and a billing cycle above.</li>
            <li><strong>Transfer the amount</strong> to the account shown on your invoice, using the reference we generate for you.</li>
            <li><strong>Attach your receipt</strong> under Invoices &amp; Payments.</li>
            <li><strong>We confirm and activate.</strong> Your plan extends the moment payment is confirmed — usually the same day.</li>
          </ol>
          <p class="sub-muted" style="margin-top:14px">
            Your data is never deleted while a payment is pending, and downgrading never removes records you already have —
            a limit only pauses <em>new</em> students and teachers.
          </p>
          ${billing.bank_name ? `<p class="sub-muted">Transfers go to <strong>${C.esc(billing.bank_name)}</strong> · ${C.esc(billing.account_name || "")} · ${C.esc(billing.account_number || "")}.</p>` : ""}
        </div>
      </div>
    `;

    content.querySelectorAll("[data-cycle]").forEach((b) => b.addEventListener("click", () => {
      plansCycle = b.getAttribute("data-cycle");
      pagePlans(content);
    }));
    content.querySelectorAll("[data-sub-upgrade]").forEach((b) => b.addEventListener("click", () => {
      openUpgradeModal(Number(b.getAttribute("data-sub-upgrade")), b.getAttribute("data-sub-plan"), plansCycle, content, billing, data.card_enabled, b.getAttribute("data-sub-code"));
    }));
    content.querySelectorAll("[data-sub-details]").forEach((b) => b.addEventListener("click", () => {
      const plan = plans.find((p) => Number(p.id) === Number(b.getAttribute("data-sub-details")));
      if (plan) openPlanDetailsModal(plan, data.current_plan_id, billing, data.card_enabled, content);
    }));
    wireCopy(content);
    C.bindRouteButtons(content);
  }

  /** The full entitlement list for one tier: what is in, and what is above it. */
  function openPlanDetailsModal(plan, currentPlanId, billing, cardEnabled, content) {
    const offer = plan.offer || plan;
    const included = offer.benefits || [];
    const locked = offer.locked || [];
    const groups = [];
    for (const item of included) {
      const g = groups.find((x) => x.key === item.group) || { key: item.group, title: item.group, items: [] };
      if (!groups.includes(g)) groups.push(g);
      g.items.push(item);
    }
    const wrap = C.openModal(`${offer.name} — “${offer.tagline || ""}”`, `
      <div class="sub-details">
        <p class="sub-plan-tagline">${C.esc(offer.promise || offer.description || "")}</p>
        <div class="sub-price">${priceFor(offer, plansCycle) > 0 ? money(priceFor(offer, plansCycle)) : "Free"}<small> / ${plansCycle === "yearly" ? "year" : "month"}</small></div>
        <ul class="sub-plan-limits">
          <li><strong>${C.esc((offer.limits && offer.limits.students_copy) || "")}</strong></li>
          <li><strong>${C.esc((offer.limits && offer.limits.teachers_copy) || "")}</strong></li>
        </ul>
        ${offer.quick_win ? `<div class="sub-quickwin"><span class="sub-quickwin-label">Quick win</span><p>${C.esc(offer.quick_win)}</p></div>` : ""}
        <h4 class="sub-details-h">Everything included (${included.length})</h4>
        <div class="sub-benefits">${groups.map((g) => `
          <div class="sub-benefit-group"><h4>${C.esc(g.title.replace(/_/g, " "))}</h4>
            <ul>${g.items.map((i) => `<li title="${C.esc(i.blurb || "")}">${C.esc(i.label)}</li>`).join("")}</ul>
          </div>`).join("")}</div>
        ${locked.length ? `
          <h4 class="sub-details-h">Not in this plan (${locked.length})</h4>
          <ul class="sub-plan-features sub-locked">
            ${locked.map((l) => `<li>${C.esc(l.label)} <span class="sub-muted">· ${C.esc(l.required_plan_name || l.required_plan)}</span></li>`).join("")}
          </ul>` : ""}
        <div class="dash-modal-foot" style="margin:18px -22px -20px;border-top:1px solid var(--d-line);">
          <button class="dash-btn dash-btn-ghost" type="button" id="subDetailsCancel">Close</button>
          ${Number(plan.id) === Number(currentPlanId)
            ? `<button class="dash-btn dash-btn-primary" disabled>Your current plan</button>`
            : `<button class="dash-btn dash-btn-primary" type="button" id="subDetailsUpgrade">Upgrade to ${C.esc(offer.name)}</button>`}
        </div>
      </div>`);
    wrap.querySelector("#subDetailsCancel").addEventListener("click", C.closeModal);
    const up = wrap.querySelector("#subDetailsUpgrade");
    if (up) up.addEventListener("click", () => {
      C.closeModal();
      openUpgradeModal(Number(plan.id), offer.name, plansCycle, content, billing, cardEnabled, offer.code);
    });
  }

  /**
   * The upgrade request dialog. Also used by the upsell overlay, so it works
   * without a rendered page behind it (`content` may be null).
   */
  function openUpgradeModal(planId, planName, cycle, content, billing, cardEnabled, planCode, offer) {
    const o = offer || null;
    const wrap = C.openModal(`Upgrade to ${planName}`, `
      <form id="subUpgradeForm">
        ${o && o.quick_win ? `<div class="sub-quickwin" style="margin-bottom:14px"><span class="sub-quickwin-label">Quick win</span><p>${C.esc(o.quick_win)}</p></div>` : ""}
        ${o && (o.headline || []).length ? `<ul class="sub-plan-features" style="margin-bottom:14px">${o.headline.map((h) => `<li>${C.esc(h)}</li>`).join("")}</ul>` : ""}
        <div class="dash-form-grid">
          <div class="dash-field">
            <label>Billing cycle</label>
            <select name="billing_cycle">
              <option value="yearly" ${cycle === "yearly" ? "selected" : ""}>Yearly — best value (2 months free)</option>
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
        ${billing && billing.bank_name ? `
          <p class="sub-muted" style="margin-top:10px">
            You will transfer to <strong>${C.esc(billing.bank_name)}</strong>
            ${billing.account_name ? `· ${C.esc(billing.account_name)}` : ""}
            ${billing.account_number ? `· ${C.esc(billing.account_number)}` : ""}.
          </p>` : ""}
        <p class="sub-muted" style="margin-top:6px">Nothing changes until the EduSphere team confirms your payment. Your data is never deleted while a request is open.</p>
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
        C.toast(res.already_open ? "You already have an open request — here it is." : `Upgrade request created for ${planName}.`, "success");
        if (content) await pageInvoices(content);
        if (typeof C.go === "function") C.go("subscription/invoices");
      } catch (err2) {
        C.toast(err2.message || "Could not create the request.", "error");
        btn.disabled = false;
        btn.textContent = "Request upgrade";
      }
    });
    if (planCode) wrap.setAttribute("data-sub-plan-code", planCode);
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

  /* ========================================================================
     UPSELL — what a school sees when it hits a plan gate
     ------------------------------------------------------------------------
     Any surface (admin console, teacher workspace, student or parent portal)
     that gets a 403 with `code: "feature_gated"` lands here: public/js/api.js
     re-broadcasts the refusal as `edusphere:feature-gated` and this overlay
     explains WHAT the school is missing, WHICH tier carries it, WHAT ELSE that
     tier brings, and — for an institution administrator — starts the upgrade
     without leaving the screen.

     It is deliberately independent of the dashboard context: the overlay builds
     its own DOM and CSS, so a teacher in the workspace and a parent in the
     portal get the same honest explanation (without a button they may not
     press). The tier copy is read from the anonymous /api/public/plans offer
     endpoint, which is the same catalogue the server enforces.
     ======================================================================== */
  const Upsell = (function () {
    let overlay = null;
    let offers = null;
    let pending = null;

    const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const money = (n) => `₦${Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

    /** The published tier offers (anonymous endpoint — safe for any role). */
    function loadOffers() {
      if (offers) return Promise.resolve(offers);
      if (pending) return pending;
      pending = window.API.public.get("/plans")
        .then((d) => { offers = d; pending = null; return d; })
        .catch(() => { pending = null; return null; });
      return pending;
    }

    function close() {
      if (!overlay) return;
      overlay.remove();
      overlay = null;
      document.removeEventListener("keydown", onKeydown);
    }

    function onKeydown(e) { if (e.key === "Escape") close(); }

    function goToPlans() {
      close();
      if (C && typeof C.go === "function") return C.go("subscription/plans");
      if (window.BelloDashboard && typeof window.BelloDashboard.go === "function") return window.BelloDashboard.go("subscription/plans");
      // Anywhere else (a portal, a print view): the admin console hash route.
      window.location.hash = "#/app/subscription/plans";
      return undefined;
    }

    function benefitsHTML(offer) {
      const groups = ((offer && offer.benefit_groups) || []).slice(0, 4);
      if (!groups.length) return "";
      return `<div class="sub-benefits">${groups.map((g) => `
        <div class="sub-benefit-group">
          <h4>${esc(g.title)}</h4>
          <ul>${(g.items || []).slice(0, 6).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
        </div>`).join("")}</div>`;
    }

    /** Opens the upgrade request flow for an administrator, in-place. */
    async function startUpgrade(planCode, planName) {
      let data = null;
      try {
        data = await window.API.get("/subscription/plans");
      } catch (e) {
        data = null; // a teacher/parent, or an expired session: show the tiers instead
      }
      const plans = (data && data.plans) || [];
      const plan = plans.find((p) => String(p.code || "").toLowerCase() === String(planCode || "").toLowerCase());
      if (!plan) return goToPlans();
      close();
      if (C && typeof C.openModal === "function") {
        return openUpgradeModal(Number(plan.id), plan.name, "yearly", null,
          (data && data.billing) || {}, Boolean(data && data.card_enabled), plan.code, plan.offer);
      }
      return goToPlans();
    }

    async function show(detail) {
      const d = detail || {};
      const feature = d.feature || {};
      const required = d.required_plan || null;
      const current = d.current_plan || {};
      const canUpgrade = d.can_upgrade === true;
      const published = await loadOffers();
      const offer = published
        ? (published.plans || []).find((p) => String(p.code) === String((required && required.code) || feature.required_plan || ""))
        : null;
      const name = (offer && offer.name) || (required && required.name) || "the plan that includes this";
      const tagline = (offer && offer.tagline) || (required && required.tagline) || "";
      const headline = (offer && offer.headline) || (required && required.headline) || [];
      const quickWin = (offer && offer.quick_win) || (required && required.quick_win) || "";
      const limits = offer && offer.limits;
      const price = offer && offer.price;

      close();
      overlay = document.createElement("div");
      overlay.className = "sub-upsell-backdrop";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-labelledby", "subUpsellTitle");
      overlay.innerHTML = `
        <div class="sub-upsell" role="document">
          <button type="button" class="sub-upsell-close" aria-label="Close">&times;</button>
          <div class="sub-upsell-eyebrow">${esc(feature.group_title || "Plan feature")}</div>
          <h3 id="subUpsellTitle">${esc(feature.label || "This feature")} is included in ${esc(name)}</h3>
          ${tagline ? `<p class="sub-upsell-tagline">“${esc(tagline)}”</p>` : ""}
          ${feature.blurb ? `<p class="sub-upsell-blurb">${esc(feature.blurb)}</p>` : ""}
          ${d.message ? `<p class="sub-upsell-message">${esc(d.message)}</p>` : ""}

          ${quickWin ? `<div class="sub-quickwin"><span class="sub-quickwin-label">Quick win</span><p>${esc(quickWin)}</p></div>` : ""}
          ${headline.length ? `<ul class="sub-plan-features">${headline.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
          ${benefitsHTML(offer || required)}

          <div class="sub-upsell-facts">
            ${limits ? `<span><strong>${esc(limits.students_copy)}</strong></span><span><strong>${esc(limits.teachers_copy)}</strong></span>` : ""}
            ${price && Number(price.yearly_ngn) > 0 ? `<span><strong>${esc(money(price.yearly_ngn))}</strong> / year</span>` : ""}
            ${price && Number(price.monthly_ngn) > 0 ? `<span>${esc(money(price.monthly_ngn))} / month</span>` : ""}
            ${price && Number(price.yearly_saves_ngn) > 0 ? `<span class="sub-save">save ${esc(money(price.yearly_saves_ngn))} yearly</span>` : ""}
            ${current.name ? `<span class="sub-muted">You are on ${esc(current.name)}</span>` : ""}
          </div>

          ${canUpgrade ? `
            <div class="sub-upsell-actions">
              <button type="button" class="dash-btn dash-btn-primary" data-upsell-upgrade>Upgrade to ${esc(name)}</button>
              <button type="button" class="dash-btn dash-btn-ghost" data-upsell-plans>Compare all plans</button>
              <button type="button" class="dash-btn dash-btn-ghost" data-upsell-close>Not now</button>
            </div>
            <p class="sub-muted sub-upsell-note">Nothing changes until your payment is confirmed — and nothing you already have is ever removed.</p>`
            : `
            <div class="sub-upsell-actions">
              <button type="button" class="dash-btn dash-btn-ghost" data-upsell-close>Close</button>
            </div>
            <p class="sub-muted sub-upsell-note">Ask your school administrator to upgrade from <strong>Subscription → Plans</strong>. Everything you have already recorded stays exactly as it is.</p>`}
        </div>`;
      document.body.appendChild(overlay);
      document.addEventListener("keydown", onKeydown);

      overlay.querySelector(".sub-upsell-close").addEventListener("click", close);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      const closeBtn = overlay.querySelector("[data-upsell-close]");
      if (closeBtn) closeBtn.addEventListener("click", close);
      const plansBtn = overlay.querySelector("[data-upsell-plans]");
      if (plansBtn) plansBtn.addEventListener("click", goToPlans);
      const upBtn = overlay.querySelector("[data-upsell-upgrade]");
      if (upBtn) upBtn.addEventListener("click", () => {
        upBtn.disabled = true;
        upBtn.textContent = "Opening…";
        startUpgrade((required && required.code) || feature.required_plan, name);
      });
      return overlay;
    }

    // One listener for the whole app: every gated action ends up here.
    if (typeof window.addEventListener === "function") {
      window.addEventListener("edusphere:feature-gated", (e) => { show((e && e.detail) || {}); });
    }

    return { show, close, loadOffers, goToPlans };
  })();

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

  window.EduSphereSubscription = { handles, render, TENANT_ROUTES, ADMIN_ROUTES, showUpsell: Upsell.show, upsell: Upsell };
  // Available on its own too: the portals and the teacher workspace load this
  // file without the dashboard, and still need the upsell dialog.
  window.EduSphereUpsell = Upsell;
})();
