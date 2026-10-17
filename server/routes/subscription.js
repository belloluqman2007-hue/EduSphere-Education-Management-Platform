"use strict";
/* ============================================================================
   SUBSCRIPTIONS & BILLING — routes
   ----------------------------------------------------------------------------
   Two halves behind one data model:

     • /api/subscription/*              the institution's OWN subscription
                                        (view, request an upgrade, upload proof)
     • /api/platform/subscriptions/*    the platform operator's queue
                                        (approve / reject / grant / suspend)

   The institution side can request and pay; it can NEVER grant itself
   entitlement. Only `activate` (an operator, or later a verified payment
   webhook) extends a paid period.
   ========================================================================== */
const express = require("express");
const db = require("../db");
const config = require("../config");
const subscription = require("../services/subscription");
const { requireAuth, requireRole, requireTenant, requireSuperAdmin } = require("../middleware/auth");
const { effectiveTenantId } = require("../middleware/tenant");
const { imageUploader } = require("../middleware/upload");
const { asyncHandler, err, ok, cleanStr, toNum, logActivity } = require("../util");

const tenantRouter = express.Router();
const platformRouter = express.Router();

/* ============================================================================
   INSTITUTION SIDE
   ========================================================================== */
tenantRouter.use(requireAuth, requireTenant, requireRole("madrasa_admin"));

const proofUpload = imageUploader("subscription-proofs", "proof");

tenantRouter.get("/", asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "No institution on this session.");
  // Both are cheap, idempotent and self-healing: an institution that has
  // drifted past its end date is corrected the first time anybody looks.
  await subscription.reconcile();
  const data = await subscription.summary(tid);
  if (!data) return err(res, 404, "Institution not found.");
  await subscription.sweep(tid).catch(() => null);
  const invoices = await subscription.listInvoices(tid, 12);
  const notices = await db.all(
    "SELECT notice_key, created_at FROM subscription_notices WHERE madrasa_id = ? ORDER BY id DESC LIMIT 5", [tid]
  );
  ok(res, Object.assign({}, data, { invoices, recent_notices: notices }));
}));

tenantRouter.get("/plans", asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  const [plans, settings, current] = await Promise.all([
    subscription.plansForUpgrade(),
    subscription.getSettings(),
    tid ? subscription.summary(tid) : Promise.resolve(null),
  ]);
  ok(res, {
    plans,
    current_plan_id: current ? current.plan.id : null,
    current_plan_code: current ? current.plan.code : "",
    // What the school has today, and what the next tier would unlock — the
    // pricing page leads with this rather than making anybody diff two cards.
    entitlements: current ? current.entitlements : null,
    billing: {
      bank_name: settings.billing_bank_name,
      account_number: settings.billing_account_number,
      account_name: settings.billing_account_name,
      transfer_note: settings.billing_transfer_note,
      contact_email: settings.billing_contact_email,
      contact_phone: settings.billing_contact_phone,
      currency: settings.billing_currency,
    },
    // The card route is only offered once a gateway is actually configured.
    card_enabled: config.PAYMENT_GATEWAY !== "none",
    gateway: config.PAYMENT_GATEWAY,
  });
}));

tenantRouter.post("/upgrade", asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "No institution on this session.");
  const b = req.body || {};
  const planId = toNum(b.plan_id, 0);
  if (!planId) return err(res, 400, "Choose a plan.");
  const cycle = ["monthly", "yearly"].includes(String(b.billing_cycle)) ? String(b.billing_cycle) : "yearly";
  const method = config.PAYMENT_GATEWAY !== "none" && b.payment_method === "card" ? "card" : "bank_transfer";

  const out = await subscription.requestUpgrade(tid, {
    planId, cycle, method, note: b.note, userId: req.user ? req.user.id : null,
  });
  const settings = out.settings;
  ok(res, {
    invoice: out.invoice,
    already_open: out.already_open,
    // The "how do I pay" panel the UI paints next to the invoice.
    pay_to: {
      bank_name: settings.billing_bank_name,
      account_number: settings.billing_account_number,
      account_name: settings.billing_account_name,
      transfer_note: settings.billing_transfer_note,
      contact_email: settings.billing_contact_email,
      contact_phone: settings.billing_contact_phone,
      currency: settings.billing_currency,
    },
    card_enabled: config.PAYMENT_GATEWAY !== "none",
  });
}));

tenantRouter.get("/invoices", asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "No institution on this session.");
  ok(res, { invoices: await subscription.listInvoices(tid, 100) });
}));

/** Institution attaches its proof of transfer. Moves pending → awaiting_approval. */
tenantRouter.post("/invoices/:id/proof", proofUpload, asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "No institution on this session.");
  const id = toNum(req.params.id, 0);
  const inv = await db.get("SELECT * FROM subscription_invoices WHERE id = ? AND madrasa_id = ?", [id, tid]);
  if (!inv) return err(res, 404, "Invoice not found.");
  if (!["pending", "awaiting_approval", "rejected"].includes(inv.status)) {
    return err(res, 409, `This invoice is ${inv.status} and can no longer be updated.`);
  }
  if (!req.file) return err(res, 400, "Please attach an image of your payment receipt.");

  const payerNote = cleanStr(req.body && req.body.payer_note, 2000);
  await db.run(
    `UPDATE subscription_invoices
        SET proof_path = ?, status = 'awaiting_approval', payer_note = COALESCE(?, payer_note),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND madrasa_id = ?`,
    [`/uploads/subscription-proofs/${req.file.filename}`, payerNote || null, id, tid]
  );
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "subscription.proof", entity: "subscription_invoice", entityId: String(id) });
  ok(res, { invoice: await subscription.getInvoice(id) });
}));

tenantRouter.post("/invoices/:id/cancel", asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  const id = toNum(req.params.id, 0);
  const inv = await db.get("SELECT * FROM subscription_invoices WHERE id = ? AND madrasa_id = ?", [id, tid]);
  if (!inv) return err(res, 404, "Invoice not found.");
  if (!["pending", "awaiting_approval"].includes(inv.status)) return err(res, 409, "Only open requests can be cancelled.");
  await db.run("UPDATE subscription_invoices SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?", [id, tid]);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "subscription.cancel_request", entity: "subscription_invoice", entityId: String(id) });
  ok(res, { ok: true });
}));

/** Printable receipt / pro-forma invoice. */
tenantRouter.get("/invoices/:id/receipt", asyncHandler(async (req, res) => {
  const tid = effectiveTenantId(req);
  const id = toNum(req.params.id, 0);
  const inv = await db.get("SELECT * FROM subscription_invoices WHERE id = ? AND madrasa_id = ?", [id, tid]);
  if (!inv) return res.status(404).send("Invoice not found.");
  const m = await db.get("SELECT name_en, slug, email, phone, address, city, state_name FROM madaris WHERE id = ?", [tid]);
  const plan = await db.get("SELECT name, code FROM plans WHERE id = ?", [inv.plan_id]);
  const settings = await subscription.getSettings();
  const paid = inv.status === "paid";
  const money = (n) => `₦${Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(inv.invoice_no)} — EduSphere</title>
<style>
  body{font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#16202c;margin:0;padding:32px;background:#fff}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:20px;margin:0 0 2px}
  .sub{color:#667; font-size:13px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:2px solid #16202c;padding-bottom:16px}
  .pill{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
  .paid{background:#dcfce7;color:#166534} .open{background:#fef3c7;color:#92400e} .bad{background:#fee2e2;color:#991b1b}
  table{width:100%;border-collapse:collapse;margin:22px 0}
  th,td{text-align:left;padding:9px 0;border-bottom:1px solid #e5e7eb;font-size:13px}
  th{color:#667;font-weight:600}
  td.r,th.r{text-align:right}
  .total{font-size:16px;font-weight:700}
  .box{background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:18px 0}
  .box h3{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#667}
  .foot{margin-top:28px;color:#889;font-size:12px;border-top:1px solid #e5e7eb;padding-top:12px}
  @media print{body{padding:0}}
</style></head><body><div class="wrap">
  <div class="head">
    <div>
      <h1>${paid ? "Receipt" : "Pro-forma Invoice"} ${esc(inv.invoice_no)}</h1>
      <div class="sub">EduSphere — Education Management Platform</div>
    </div>
    <div style="text-align:right">
      <span class="pill ${paid ? "paid" : inv.status === "rejected" || inv.status === "cancelled" ? "bad" : "open"}">${esc(inv.status.replace(/_/g, " "))}</span>
      <div class="sub" style="margin-top:8px">Issued ${esc(String(inv.created_at).slice(0, 10))}</div>
    </div>
  </div>
  <div class="box">
    <h3>Billed to</h3>
    <div><strong>${esc(m ? m.name_en : "")}</strong></div>
    ${m && m.address ? `<div>${esc(m.address)}${m.city ? ", " + esc(m.city) : ""}${m.state_name ? ", " + esc(m.state_name) : ""}</div>` : ""}
    ${m && m.email ? `<div>${esc(m.email)}</div>` : ""}${m && m.phone ? `<div>${esc(m.phone)}</div>` : ""}
  </div>
  <table>
    <thead><tr><th>Description</th><th>Period</th><th class="r">Amount</th></tr></thead>
    <tbody>
      <tr>
        <td>EduSphere ${esc(plan ? plan.name : "")} plan — ${esc(inv.billing_cycle)} subscription</td>
        <td>${esc(inv.period_start || "")} → ${esc(inv.period_end || "")}</td>
        <td class="r">${money(inv.amount_ngn)}</td>
      </tr>
      <tr><td colspan="2" class="r total">Total</td><td class="r total">${money(inv.amount_ngn)}</td></tr>
    </tbody>
  </table>
  ${paid ? `<div class="box"><h3>Paid</h3><div>Thank you. Subscription active until <strong>${esc(inv.period_end)}</strong>.</div></div>`
    : `<div class="box"><h3>How to pay</h3>
        <div><strong>Bank:</strong> ${esc(settings.billing_bank_name) || "—"}</div>
        <div><strong>Account name:</strong> ${esc(settings.billing_account_name) || "—"}</div>
        <div><strong>Account number:</strong> ${esc(settings.billing_account_number) || "—"}</div>
        <div><strong>Reference:</strong> ${esc(inv.reference)}</div>
        ${settings.billing_transfer_note ? `<div style="margin-top:8px;color:#556">${esc(settings.billing_transfer_note)}</div>` : ""}
      </div>`}
  ${inv.admin_note ? `<div class="box"><h3>Note from EduSphere</h3><div>${esc(inv.admin_note)}</div></div>` : ""}
  <div class="foot">Generated by EduSphere · ${esc(new Date().toISOString().slice(0, 10))}</div>
</div></body></html>`);
}));

/* ============================================================================
   PLATFORM / OPERATOR SIDE
   ========================================================================== */
platformRouter.use(requireSuperAdmin);

platformRouter.get("/", asyncHandler(async (req, res) => {
  await subscription.reconcile();
  const [list, stats] = await Promise.all([subscription.platformList(), subscription.platformStats()]);
  ok(res, { subscriptions: list, stats });
}));

platformRouter.get("/invoices", asyncHandler(async (req, res) => {
  const status = cleanStr(req.query.status, 20);
  if (status && !subscription.INVOICE_STATUSES.has(status)) return err(res, 400, "Unknown invoice status.");
  const rows = status
    ? await db.all(
        `SELECT i.*, p.name AS plan_name, p.code AS plan_code, m.name_en AS madrasa_name, m.slug, u.full_name AS requested_by_name
           FROM subscription_invoices i LEFT JOIN plans p ON p.id = i.plan_id LEFT JOIN madaris m ON m.id = i.madrasa_id
           LEFT JOIN users u ON u.id = i.requested_by
          WHERE i.status = ? ORDER BY i.id DESC LIMIT 200`, [status])
    : await subscription.platformPending();
  ok(res, { invoices: rows });
}));

platformRouter.post("/invoices/:id/approve", asyncHandler(async (req, res) => {
  const id = toNum(req.params.id, 0);
  const note = cleanStr(req.body && req.body.admin_note, 2000);
  const out = await subscription.activate(id, req.user.id, note);
  ok(res, { ok: true, invoice: out.invoice, expires_at: out.expires_at });
}));

platformRouter.post("/invoices/:id/reject", asyncHandler(async (req, res) => {
  const id = toNum(req.params.id, 0);
  const reason = cleanStr(req.body && req.body.reason, 2000);
  if (!reason) return err(res, 400, "Tell the institution why the payment was not confirmed.");
  const invoice = await subscription.rejectInvoice(id, req.user.id, reason);
  ok(res, { ok: true, invoice });
}));

platformRouter.post("/:madrasaId/grant", asyncHandler(async (req, res) => {
  const madrasaId = toNum(req.params.madrasaId, 0);
  const b = req.body || {};
  const data = await subscription.grant(madrasaId, {
    planId: toNum(b.plan_id, 0),
    cycle: b.billing_cycle,
    months: b.months ? toNum(b.months, 0) : 0,
    note: b.note,
    actorId: req.user.id,
  });
  ok(res, { ok: true, subscription: data });
}));

platformRouter.post("/:madrasaId/status", asyncHandler(async (req, res) => {
  const madrasaId = toNum(req.params.madrasaId, 0);
  const status = cleanStr(req.body && req.body.status, 20);
  if (!subscription.STATUSES.has(status)) return err(res, 400, "Unknown subscription status.");
  const data = await subscription.setStatus(madrasaId, status, req.user.id, req.body && req.body.note);
  ok(res, { ok: true, subscription: data });
}));

platformRouter.get("/:madrasaId", asyncHandler(async (req, res) => {
  const madrasaId = toNum(req.params.madrasaId, 0);
  const data = await subscription.summary(madrasaId);
  if (!data) return err(res, 404, "Institution not found.");
  const invoices = await subscription.listInvoices(madrasaId, 50);
  ok(res, Object.assign({}, data, { invoices }));
}));

module.exports = { router: tenantRouter, platformRouter };
