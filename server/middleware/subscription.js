"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — subscription feature middleware
   ----------------------------------------------------------------------------
   The bridge between `services/subscription.checkFeature()` and the routes
   that sell a capability. One rule, applied everywhere:

     A route never decides for itself whether a plan includes something. It
     names the feature key it needs and this middleware answers — with the
     tenant taken from the AUTHENTICATED SESSION (never from the request body
     or a query string), so no school can borrow another school's plan.

   Shape of a refusal (HTTP 403):

     {
       "error":  "Payroll is included in the Premium plan — …",
       "code":   "feature_gated",
       "feature": { "key": "payroll", "label": "Payroll", … },
       "required_plan": { "code": "premium", "name": "Premium", … },
       "upgrade": { …benefits, CTA route… },
       "hint":   "Upgrade to Premium to unlock Payroll: …"
     }

   `code: "feature_gated"` is the contract the frontend listens for: public/js
   /api.js turns any such 403 into the upsell dialog, so a gated button never
   ends in a dead-end toast.

   WHO IS NOT GATED
   • super_admin — the platform operator supports and demos every tenant, and
     is already behind requireSuperAdmin on every route that matters.
   • a request with no tenant context — the route's own tenant guard answers
     that (400/403/404); guessing here would only produce a second, wrong
     error.
   ========================================================================== */
const subscription = require("../services/subscription");
const { effectiveTenantId } = require("./tenant");

/** Resolves the tenant this request should be billed/checked against. */
function tenantFor(req) {
  try {
    const tid = effectiveTenantId(req);
    return tid ? Number(tid) : null;
  } catch (e) {
    return req.user && req.user.madrasaId ? Number(req.user.madrasaId) : null;
  }
}

/** Sends the 403 the frontend's upsell dialog understands. */
function refuse(res, gate) {
  const payload = Object.assign({ error: gate.message || "This feature is not included in your plan." }, gate);
  delete payload.allowed;
  return res.status(403).json(payload);
}

/**
 * Middleware factory: `router.use(requireFeature("payroll"))` or
 * `router.post("/x", requireFeature("ai_comments"), handler)`.
 *
 * `key` may also be a function `(req) => key | null` for routes whose feature
 * depends on the request (e.g. the delivery channel of a broadcast). Returning
 * null skips the gate — the route still runs its own checks.
 */
function requireFeature(key) {
  const resolve = typeof key === "function" ? key : () => key;
  return async function featureGate(req, res, next) {
    if (!req.user) return next();                       // auth middleware answers 401
    if (req.user.role === "super_admin") return next(); // operator: never gated
    const featureKey = resolve(req);
    if (!featureKey) return next();
    const tid = tenantFor(req);
    if (!tid) return next();                            // no tenant: route's own guard answers

    // One settings read per request, however many gates it passes through.
    try {
      if (req.subscriptionSettings === undefined) {
        req.subscriptionSettings = await subscription.getSettings();
      }
      const gate = await subscription.checkFeature(tid, featureKey, { settings: req.subscriptionSettings });
      req.subscriptionFeature = gate;
      if (gate.allowed) return next();
      gate.can_upgrade = req.user.role === "madrasa_admin";
      return refuse(res, gate);
    } catch (e) {
      // An infrastructure failure must not become a permanent "you have not
      // paid" message. Log it, let the request through, and let the route's own
      // database error handling answer if the database really is down.
      console.error(`Feature gate "${featureKey}" could not be evaluated:`, e.message);
      return next();
    }
  };
}

/**
 * Inline gate for handlers that resolve their own tenant (many routes do, to
 * keep 404s tenant-safe). Returns the gate result; `null` means refused and the
 * response has already been written.
 *
 *   const gate = await gateFeature(req, res, tid, "certificates");
 *   if (!gate) return;
 */
async function gateFeature(req, res, madrasaId, key) {
  if (req.user && req.user.role === "super_admin") return { allowed: true, reason: "operator", key };
  const gate = await subscription.checkFeature(madrasaId, key);
  if (gate.allowed) return gate;
  gate.can_upgrade = Boolean(req.user && req.user.role === "madrasa_admin");
  refuse(res, gate);
  return null;
}

/** True when this request's tenant is entitled to `key` (no response written). */
async function hasFeature(req, key) {
  if (req.user && req.user.role === "super_admin") return true;
  const tid = tenantFor(req);
  if (!tid) return true;
  const gate = await subscription.checkFeature(tid, key);
  return Boolean(gate.allowed);
}

/** Gate that passes when the tenant has ANY of the listed keys. */
function requireAnyFeature(...keys) {
  return async function anyFeatureGate(req, res, next) {
    if (!req.user || req.user.role === "super_admin") return next();
    const tid = tenantFor(req);
    if (!tid) return next();
    let last = null;
    for (const key of keys) {
      const gate = await subscription.checkFeature(tid, key);
      if (gate.allowed) { req.subscriptionFeature = gate; return next(); }
      // A suspension/expiry outranks "your tier does not include this".
      if (gate.reason === "suspended" || gate.reason === "expired") return refuse(res, gate);
      last = gate;
    }
    if (!last) return next();
    last.can_upgrade = req.user.role === "madrasa_admin";
    return refuse(res, last);
  };
}

module.exports = { requireFeature, requireAnyFeature, gateFeature, hasFeature, tenantFor };
