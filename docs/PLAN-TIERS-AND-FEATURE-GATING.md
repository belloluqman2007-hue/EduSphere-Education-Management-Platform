# Plan tiers & feature gating

> Free / Basic / Premium: what each tier **gives** a school, where that is
> written down, and how a gated action is refused.
>
> Everything here is enforced on the server. The UI only renders it.

---

## 1. The three offers

Copy below is what a school sees — on the anonymous pricing endpoint, on
Subscription → Plans in the admin console, in the AI assistant's answers, and in
the upsell dialog that appears when a gated action is attempted.

| | **Free** | **Basic** | **Premium** |
|---|---|---|---|
| Tagline | Start running your school digitally | Everything a growing school needs | A modern, AI-powered school |
| Students | 50 | 300 | Unlimited |
| Teachers | 3 | 15 | Unlimited |
| Price | ₦0 forever | ₦8,000 / month · ₦80,000 / year | ₦20,000 / month · ₦200,000 / year |
| Trial | — | 14 days | 14 days |
| Quick win | Replace paper registers and manual report cards | Collect fees online and keep parents informed automatically | Save teacher hours, boost parent satisfaction, and grow enrollment |

**Free — what you get:** attendance tracking that replaces the paper register;
basic student & teacher records; printable report cards with CA + exam grading
and positions; announcements for staff, students and parents; community support
and the EduSphere AI how-to assistant.

**Basic — everything in Free, plus:** fees & payments (invoices, receipts,
online payments); two-way messaging with a delivery log; student & parent
portals (results, attendance, fees); attendance analytics & exports; standard
report templates; basic analytics (class/subject averages, pass rates); the
library module; email support.

**Premium — everything in Basic, plus:**

- **AI copilot** — auto report comments from real marks and attendance, at-risk
  student alerts with suggested next steps, exam question generation into the
  question bank, analytics Q&A.
- **Advanced analytics** — attendance heatmaps by class and weekday, teacher
  performance, fee forecasting from the actual collection trend, attendance
  patterns and the at-risk watch list.
- **Online exams** — question randomisation, auto-grading, instant results, exam
  analytics.
- **Parent experience** — online fee payment and payment plans, WhatsApp / SMS
  alerts, PTM booking.
- **Finance & HR** — payroll and payslips, expenses, budgets and financial
  reports, leave management.
- **Branding & growth** — custom domain, theme builder, admissions portal,
  alumni, multi-campus.
- **Academics** — custom report templates, bulk report sheets, behaviour
  ratings, ID cards, health records, certificates.
- **Trust & operations** — audit exports, 2FA / SSO, automated backups &
  restore, API access, priority support + onboarding.

Limits behave exactly as they did before tiers existed: a ceiling pauses **new**
students/teachers, expiry and suspension still refuse new records while keeping
existing data readable, and nothing is ever deleted because a payment is late.

---

## 2. One source of truth

`server/services/plan-catalogue.js` is the only place that knows what a tier
means. It exports:

| Export | Purpose |
|---|---|
| `FEATURE_GROUPS` | The capability groups the UI shows ("Money", "Family", "AI copilot", …). |
| `FEATURES` / `FEATURE_KEYS` | Every switchable key with its label, blurb, group and lowest tier. |
| `TIERS` / `TIER_ORDER` | Per-tier copy: tagline, promise, badge, quick win, benefit groups, headline, limits copy. |
| `tierFeatureKeys(code)` | Which keys that tier carries. |
| `featuresForTier(code)` | A complete boolean map — what a fresh plan row should contain. |
| `normalizeFeatures(raw, code)` | Stored map + tier defaults for keys the row predates. Never turns an explicit `false` into `true`. |
| `offerFor(plan)` | A raw `plans` row turned into the offer the UI renders (prices, savings, benefit groups, included/locked lists). |
| `entitlements(features, code)` | What is included, what is locked, and what the next tier would add. |
| `gatePayload(key, code, name)` | The 403 body: message, hint, feature, required plan. |

Consumers: `server/seed.js` (writes plans), `server/services/subscription.js`
(`checkFeature`, `entitlements`, `plansForUpgrade`),
`server/middleware/subscription.js` (the gate), `server/routes/public.js`
(pricing page), `server/routes/ai.js` (the `list_plans` tool + copilot),
`server/services/ai.js` (knowledge-base answers about tiers),
`public/js/subscription.js` (cards, matrix, upsell).

**Adding or moving a feature** = edit the catalogue, then run the seed sync. No
route, screen or answer needs to change.

---

## 3. Enforcement

```js
const { requireFeature } = require("../middleware/subscription");

router.use(requireFeature("payroll"));                        // whole router
router.post("/x", requireFeature("ai_comments"), handler);    // one route
router.post("/send", requireFeature((req) =>                  // per request
  req.body.channel === "whatsapp" ? "whatsapp" : null), handler);
```

The tenant comes from the **authenticated session** (`effectiveTenantId(req)`),
never from a body or query parameter, so no school can borrow another school's
plan. `super_admin` is never gated, and a request with no tenant is left to the
route's own tenant guard.

`checkFeature(madrasaId, key)` answers in this order — the precedence is
deliberate, because a Premium school with a lapsed payment must be told to
renew, not sold an upgrade:

1. `suspended` → refused ("settle the outstanding subscription").
2. `expired` (past grace) → refused ("renew from Subscription → Plans").
3. `billing_enabled = 0` in platform settings → allowed (`enforcement_disabled`).
   An operator can stop gating platform-wide without editing plans.
4. key not in the catalogue → allowed (`unknown_feature`). A typo must never
   lock a school out of its own data.
5. `features[key]` → allowed (`ok`) or refused (`feature`).

### The refusal (HTTP 403)

```jsonc
{
  "error": "Payroll is included in the Premium plan — upgrade to unlock it.",
  "code": "feature_gated",
  "feature": { "key": "payroll", "label": "Payroll", "blurb": "…", "group": "finance_hr",
               "required_plan": "premium" },
  "current_plan": { "code": "free", "name": "Free" },
  "required_plan": { "code": "premium", "name": "Premium", "tagline": "…",
                     "quick_win": "…", "headline": ["AI copilot", "…"],
                     "benefit_groups": [{ "title": "…", "items": ["…"] }] },
  "hint": "Upgrade to Premium to unlock Payroll: …",
  "can_upgrade": true,
  "upgrade": { "required_plan_code": "premium", "route": "subscription/plans",
               "api": "/api/subscription/plans", "benefit_groups": ["…"] }
}
```

`code: "feature_gated"` is the contract with the frontend. `can_upgrade` is true
only for a `madrasa_admin`, so a teacher or parent is given the explanation
without a button they are not allowed to press.

### What is gated where

| Feature key | Surface |
|---|---|
| `portals` | `/api/portal/**` (student, parent & teacher portal data) |
| `online_exams` | `/api/portal/online-exams*`, `/api/academic/exams*` |
| `question_bank` | `/api/academic/questions*` |
| `fees` | **writes** on `/api/fees/**` — reads stay open so a downgraded school can still see what parents paid |
| `messaging`, `sms`, `whatsapp` | `/api/communication/**` messages, delivery log, and the channel of a broadcast |
| `analytics_advanced` | `GET /api/madrasa/analytics/advanced` |
| `exports` / `exports_bulk` | `/api/exports/**`, bulk report sheets |
| `payroll`, `leave`, `library`, `health`, `expenses` | those routers |
| `id_cards`, `certificates` | the document generators that issue them |
| `custom_report_templates` | report template save + preview |
| `admissions_portal` | admissions pipeline, requirements, settings (received applications stay processable on any tier) |
| `branding_custom`, `custom_domain` | institution appearance/domain updates |
| `priority_support` | raising an *urgent* support ticket |
| `ai_comments`, `ai_risk_alerts`, `ai_questions` | the copilot endpoints |
| `multi_campus`, `api_access`, `sso`, `backups_restore` | catalogue + entitlement keys only — there is no tenant surface for them yet, so nothing is gated on them |

Ungated on purpose: announcements and notifications (Free includes
announcements), the public document-verification endpoint
(`/api/documents/verify-card/:code`), and every read path that shows a school
its own historical data.

---

## 4. Endpoints

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /api/public/plans` | none | The published offers (tagline, promise, quick win, benefit groups, limits as capacity, price + yearly saving, trial), the feature groups, a full comparison matrix (`free`/`basic`/`premium` booleans per capability) and how payment works. No institution data, no internal ids. |
| `GET /api/subscription/plans` | institution | The same offers **plus** `current_plan_id`, `current_plan_code`, `entitlements` (included / locked / next tier with the features it would add), `billing` bank details and `card_enabled`. |
| `GET /api/ai/copilot` | institution | One entry per copilot capability with `entitled`, and `gate` (the 403 payload) when it is not. Never gated itself — the list is the advertisement. |
| `POST /api/ai/copilot/report-comments` | `ai_comments` | Draft comments per student from real results + attendance. Drafts only: nothing is written to a report sheet. |
| `GET /api/ai/copilot/at-risk` | `ai_risk_alerts` | Students below the pass mark or the attendance floor, with reasons, a risk score, suggested actions and a draft parent message. |
| `POST /api/ai/copilot/questions` | `ai_questions` | Questions for a subject, drawn from the school's own bank first; `save: true` files them for review. |
| `GET /api/ai/copilot/insights` | `analytics_advanced` | Plain-language answer plus the computed advanced analytics behind it. |
| `GET /api/madrasa/analytics/advanced` | `analytics_advanced` | Heatmaps, weekday/class patterns, chronic absence, teacher performance, fee forecast, insights. |
| `GET /api/platform/plans` | super admin | Plan rows with the normalised feature map, their rendered `offer`, and the `feature_catalogue` the editor needs. |

Every copilot answer degrades honestly: with no `AI_API_KEY` the endpoints
compute from the school's own data (`mode: "template"`, `"bank"` or
`"computed"`) rather than inventing numbers.

---

## 5. Frontend

- `public/js/api.js` — a 403 whose body carries `code: "feature_gated"` is
  dispatched on `window` as `edusphere:feature-gated` (detail = the gate payload
  plus `path`/`method`) and is **never** retried as a CSRF failure.
- `public/js/subscription.js` — the plans screen (cycle switch, offer cards,
  "compare every feature" matrix, an everything-included dialog, the upgrade
  form), the overview screen's "what's included / what's next" cards, and the
  `Upsell` dialog. `window.EduSphereUpsell.show(detail)` is exported, and the
  module listens for `edusphere:feature-gated` itself, so a gated action in the
  teacher workspace or a parent portal is answered too — `subscription.js` is
  loaded on every SPA page.
- The dialog enriches itself from the anonymous `/api/public/plans`, so it shows
  the tier's real price, saving and benefits even to a role that cannot read
  `/api/subscription/plans`.
- `public/css/subscription.css` — `.sub-plan*`, `.sub-benefit*`, `.sub-compare*`,
  `.sub-upsell*`, `.ai-copilot*`, `.ai-draft-*`.
- Super admin → Subscription Plans edits features as **switches grouped by
  capability** (with one-click tier presets) instead of a raw JSON box, and
  `POST/PATCH /api/platform/plans` validates the map on the way in.

---

## 6. Seeding & upgrades in place

- `seedPlans()` inserts the three tiers on an empty `plans` table.
- `syncPlanOffers()` runs on every boot and **gap-fills only**: missing feature
  keys, a blank tagline, and a missing yearly price/trial on a paid tier. It
  never reverses an operator's edit — a key deliberately switched off stays off,
  and limits/prices are untouched.
- `seedKnowledge()` writes the tier answers into `ai_knowledge` the same way:
  one insert per missing `scope::question`, so an upgraded deployment learns the
  new answers without duplicating or overwriting an edited one. The assistant
  therefore cannot contradict a gate.

---

## 7. Tests

| File | Covers |
|---|---|
| `test/subscription-features.test.js` | Catalogue invariants (Free ⊂ Basic ⊂ Premium, every key labelled, tier copy present), `offerFor`/`entitlements`, the anonymous pricing endpoint (including that no tenant data leaks), `checkFeature` precedence and fail-open, the 403 contract on nine gated routes, Free keeping what Free promises, reads never gated, a customised mid-tier plan honoured exactly, enforcement switch, upgrade + tenant isolation, copilot tenancy, seed sync semantics, knowledge-base idempotence. |
| `test/subscription-ui.test.js` | jsdom: the plans screen's three offer cards, verbatim tier copy, benefits/quick wins/capacity, current + recommended flags, the billing-cycle switch re-pricing, the comparison matrix, both dialogs, and a gated call from inside the page opening the upsell and handing over to the upgrade form — plus the teacher variant with no upgrade button. |
| `test/subscription.test.js` | Billing lifecycle (request → confirm → activate), invoices, limits, expiry/suspension. |

`test/helpers.js` gives the fixture plan **every** feature key so module tests
exercise their module rather than the tier matrix; the two files above put the
plan back on the real Free tier before asserting.
