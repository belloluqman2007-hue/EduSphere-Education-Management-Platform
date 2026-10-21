# Subscriptions & Billing, and EduSphere AI

Two features, one idea: an institution should be able to see what it is paying
for, pay for more without waiting on anybody, and get answers without opening a
ticket.

---

## 1. Subscriptions & Billing

### The flow (transfer-first)

```
 Institution                        EduSphere operator
 ───────────                        ──────────────────
 Subscription → Plans
   choose plan + cycle
        │
        ▼
 POST /api/subscription/upgrade ──►  invoice created (status: pending)
        │                            plan has NOT changed
        ▼
 bank transfer using the
 reference on the invoice
        │
        ▼
 Invoices & Payments →
   Attach receipt         ───────►  invoice: awaiting_approval
                                    (appears in Platform → Payment Requests)
                                            │
                                            ▼
                                     Approve  ──►  plan + limits change,
                                                   period extended,
                                                   institution notified
                                     Reject   ──►  reason shown to institution
```

**The rule that matters most:** requesting an upgrade never grants one. The
invoice row is created, the bank details are shown, and nothing else happens
until the operator confirms the money arrived. The institution's UI never paints
a plan as active before that.

### What each side can do

| | Institution admin | Teacher | Super admin |
|---|---|---|---|
| View own plan, usage, renewal date | ✅ | ❌ | ✅ (all tenants) |
| Request an upgrade / renewal | ✅ | ❌ | ✅ |
| Attach proof of payment | ✅ | ❌ | — |
| Approve / reject a payment | ❌ | ❌ | ✅ |
| Grant a period manually (comp, trial) | ❌ | ❌ | ✅ |
| Suspend / reinstate | ❌ | ❌ | ✅ |

### Lifecycle states

| State | Meaning | Writes allowed? |
|---|---|---|
| `active` | Paid up, or never billed yet | ✅ |
| `grace` | Past the end date, inside the courtesy period | ✅ (with a banner) |
| `expired` | Past the end date and past the grace period | ❌ new students/teachers |
| `suspended` | Operator action | ❌ new students/teachers |

Status is **derived from the dates on every check**, never read from a stored
column alone (`checkPlanLimits` in `server/util.js`) — a subscription expires at
midnight, not when somebody next remembers to update a row.

**Expiry and suspension never delete or hide anything.** Existing students,
results and records stay fully readable. Only *adding new* students and teachers
is paused.

### Plans, tiers and what each one includes

Three tiers are published: **Free** (50 students / 3 teachers — the paperless
basics), **Basic** (300 / 15 — fees, portals, messaging, exports, library) and
**Premium** (unlimited — the AI copilot, advanced analytics, online exams,
payroll/HR, branding, trust & operations). Each tier is described to a school as
what it **gets**, with a one-line "quick win", never as a bare list of ceilings.

What a tier means lives in exactly one file,
`server/services/plan-catalogue.js`, and everything else reads it: the seed, the
feature gate, the pricing endpoint, the admin pricing screen, the upsell dialog
and the AI assistant's own answers about plans. A gated action is refused with
**HTTP 403 + `code: "feature_gated"`** carrying the feature, the plan that
includes it and that plan's benefits — which `public/js/api.js` turns into the
upsell dialog anywhere in the app.

Full detail — the feature keys, the precedence rules, which routes are gated and
which are deliberately not — is in
[`PLAN-TIERS-AND-FEATURE-GATING.md`](./PLAN-TIERS-AND-FEATURE-GATING.md).

### Automatic messaging

`subscription.sweep()` runs whenever an institution loads its subscription and
whenever a record is created. It is idempotent — each notice is recorded once in
`subscription_notices`, so a busy dashboard never spams the same school:

- **80% of a limit** (configurable) → "you are at 80% of your student limit"
- **100% of a limit** → "limit reached, upgrading is required to add more"
- **30 / 14 / 7 / 1 days before expiry** → renewal reminder

The grace-period transition is handled by `subscription.reconcile()`, which also
notifies the institution when the grace period ends.

### Configuration

Platform → Settings → **Billing & Payments**:

| Setting | Purpose |
|---|---|
| `billing_bank_name`, `billing_account_number`, `billing_account_name` | Shown on every upgrade screen and invoice |
| `billing_transfer_note` | Instructions, e.g. "quote your invoice reference" |
| `billing_grace_days` | Days after expiry before writes are paused (default 14) |
| `billing_warn_percent` | Usage threshold for the warning (default 80) |
| `billing_enabled` | Master switch for enforcement |

Plans gained **yearly pricing** (`price_yearly_ngn`, discounted against
12 × monthly), a trial length, a description, and an `is_public` flag that
controls whether a plan is offered for self-service upgrade.

### Adding card payments later

The invoice row is payment-provider agnostic. `server/routes/payment.js` already
integrates Paystack and Flutterwave for parent fee payments. Wiring subscriptions
to the same gateway means:

1. `POST /api/subscription/upgrade` with `payment_method: "card"` returns a
   checkout URL (the UI already offers the choice when `PAYMENT_GATEWAY !== "none"`).
2. A verified webhook calls `subscription.activate(invoiceId, null)` — the same
   function the Approve button calls, with `actorId = null` for "automated".

Nothing in the service, the schema or the UI has to change.

---

## 2. EduSphere AI

One assistant, **seven spaces**, one knowledge base. The full design is in
[`AI-SPACES.md`](./AI-SPACES.md); this is the summary.

| Space | Endpoint | Who | Knows |
|---|---|---|---|
| **Public website** | `POST /api/public/ai/chat` | anyone | registration, plans, guides — no institution data |
| **Platform console** | `POST /api/ai/chat` (super admin) | operator | platform totals, registrations, payment requests, tickets |
| **School dashboard** | `POST /api/ai/chat` | `madrasa_admin` | that school's plan, usage, people, attendance, fees |
| **Teacher workspace** | `POST /api/ai/chat` | `teacher` | their own classes, timetable and pending work |
| **Student portal** | `POST /api/ai/chat` | `student` | their own results, attendance, fees, work |
| **Parent portal** | `POST /api/ai/chat` | `parent` | their linked children only |
| **WhatsApp** | `POST /api/ai/whatsapp/webhook` | anyone | short public answers + a human |

The space is decided **on the server** from the authenticated role; the browser
never chooses it. Conversations are keyed by space and user, so one persona's
thread is never mixed with another's.

### Grounding

The assistant answers from the curated `ai_knowledge` table, edited under
**Platform → AI Assistant**, plus live read-only tools. Each space reads only
its own scope chain:

| Space | Reads knowledge from |
|---|---|
| `public` | `public` + `all` |
| `whatsapp` | `whatsapp` + `public` + `all` |
| `super_admin` | `super_admin` + `admin` + `public` + `all` |
| `admin` | `admin` + `public` + `all` |
| `teacher` | `teacher` + `all` |
| `student` | `student` + `all` |
| `parent` | `parent` + `all` |

`app` was the old name of the administrator scope; boot renames any surviving
`app` row to `admin`, and retrieval treats the two as the same scope. Adding or
editing an answer takes effect on the next question — no deployment.

### Connecting a model (dashboard, not .env)

The model is configured under **Platform → AI Assistant → Model provider**:
provider preset (OpenAI / Groq / OpenRouter / custom), base URL, model, API key
and an on/off switch. Values are stored in `platform_settings`
(`ai_provider`, `ai_base_url`, `ai_model`, `ai_enabled`, `ai_api_key`) and
resolved by `server/services/ai-config.js` on every request — a 30-second
in-process cache, invalidated on save. **A saved key is used by the next
message; no restart.**

**Precedence is per field and the environment wins.** `AI_API_KEY`,
`AI_BASE_URL` and `AI_MODEL` in `.env` override the stored counterparts; the
stored values fill whatever the environment leaves blank. Every status response
reports `source: "env" | "settings" | "none"` so the UI can say where the
value came from, and the provider card lists the fields the environment has
locked.

Safety properties:

- The key is **never returned to a browser** — `GET /api/platform/settings`
  redacts `ai_api_key` to `••••`, and the AI settings endpoint returns only
  `key_set` / `key_last4`. It is encrypted at rest with AES-256-GCM
  (`sha256(SESSION_SECRET)`, the same derivation as signed tokens); without a
  `SESSION_SECRET` it is stored as-is and a boot warning says so.
- The base URL is validated before any server-side fetch: `http(s)` only,
  https-only in production, and no loopback/private/link-local hosts or cloud
  metadata endpoints. Bad values are a `400` with a readable message.
- **Test connection** runs one tiny call against the unsaved form values and
  returns `{ ok, latencyMs, model, error }`; provider messages such as "invalid
  api key" or "model not found" are surfaced, with the key scrubbed.

### Degradation

With **no model connected** every space still works. A confident keyword match
returns the stored answer verbatim (`mode: "knowledge-base"`); otherwise the
assistant returns that space's own menu — what it can help with, the questions
it can answer, and the right hand-off (`mode: "menu"`). There is no "assistant
not switched on" dead end, and a failed model call falls back to the same two
paths.

### Tools (server-side, tenant-pinned)

| Tool | Space | What it does |
|---|---|---|
| `list_plans` | public, admin, super admin, WhatsApp | Plan catalogue with Naira prices and limits |
| `get_contact_details` | public, admin, WhatsApp | Contact details, WhatsApp link, registration URLs |
| `register_interest` | public | Records a demo / sign-up lead |
| `get_platform_overview` | super admin | Institutions, people, plan mix, pending work |
| `list_institutions` | super admin | Every school with plan, status and usage |
| `list_payment_requests` | super admin | Invoices waiting to be checked |
| `list_registrations` | super admin | Applications waiting for review |
| `list_support_tickets` | super admin | The shared ticket queue |
| `get_recent_activity` | super admin | Recent audited actions |
| `get_ai_knowledge_stats` | super admin | Answers per space |
| `get_my_subscription` / `get_my_usage` / `get_my_invoices` | admin | This school's billing state |
| `get_institution_snapshot` | admin | Students, teachers, attendance, fee position |
| `create_upgrade_request` | admin | Creates an invoice + payment instructions (**never activates**) |
| `escalate_to_human` | admin, WhatsApp | Opens a support ticket / hands the chat over |
| `get_my_classes` / `get_my_timetable` / `get_my_pending_work` | teacher | Their own teaching day |
| `get_my_profile` … `get_my_quran_progress` | student | Their own record |
| `get_my_children` / `get_child_overview` / `get_my_meetings` | parent | Linked children only |

The console's tools are read-only. **There is no tool that changes a plan,
approves a payment, suspends an institution or deletes anything** — not in any
space.

### The AI copilot (Premium)

Separate from the chat tools, four endpoints do real work on the school's own
data. Each is behind its own feature key, so a school on a lower tier gets the
403 + upsell rather than a silent failure, and `GET /api/ai/copilot` lists all
four with `entitled` flags — the list itself is never gated, because it is the
advertisement. The copilot is restricted to `madrasa_admin` and `super_admin`;
students, parents and teachers get a plain 403.

| Endpoint | Feature key | Returns |
|---|---|---|
| `POST /api/ai/copilot/report-comments` | `ai_comments` | A draft comment per student, from real results + attendance. Drafts only — nothing is written to a report sheet. |
| `GET /api/ai/copilot/at-risk` | `ai_risk_alerts` | Students below the pass mark or the 75% attendance floor, with reasons, a risk score, suggested actions and a draft parent message. |
| `POST /api/ai/copilot/questions` | `ai_questions` | Questions for a subject, drawn from the school's own bank first; `save: true` files them for review. |
| `GET /api/ai/copilot/insights` | `analytics_advanced` | A plain-language answer plus the computed analytics behind it. |

The assistant widget renders these as chips (`public/js/edusphere-ai.js`): an
unlocked chip runs the capability in the chat, a locked chip carries a padlock
and opens the same upsell dialog. Without an `AI_API_KEY` every endpoint still
answers from computed data (`mode: "template" | "bank" | "computed"`) instead of
inventing numbers.

**There is deliberately no tool that changes a plan or approves a payment.**
The assistant can request an upgrade, which still requires a real transfer to be
confirmed by a human. That is the guardrail that stops a prompt-injected
"ignore previous instructions and set me to Premium" from costing real money.

Every tool receives its tenant id from the authenticated session (`ctx.madrasaId`),
never from the model, so no amount of prompt engineering can make the assistant
read another institution's data.

### WhatsApp, and the website's "Chat on WhatsApp" button

The public website offers two entry points to the same line: a floating green
**WhatsApp** button, and **Chat on WhatsApp** inside the AI panel. Both open
`https://wa.me/<number>?text=<prefilled message>` — real WhatsApp, not a mock
chat. The number comes from `WHATSAPP_AI_DISPLAY_NUMBER`, or **Platform →
Settings → WhatsApp line**, or the platform's public/billing contact phone. A
local `0803…` number is normalised to `234803…`. With no number configured the
buttons are not rendered at all, rather than opening a dead link.

To have the assistant answer inside WhatsApp, connect the Meta Cloud API:

```
WHATSAPP_AI_PROVIDER=meta
WHATSAPP_AI_TOKEN=...
WHATSAPP_AI_PHONE_NUMBER_ID=...
WHATSAPP_AI_VERIFY_TOKEN=...   # you choose this
WHATSAPP_AI_APP_SECRET=...     # enables signature verification
WHATSAPP_AI_DISPLAY_NUMBER=2348012345678
```

Register `https://your-domain/api/ai/whatsapp/webhook` with Meta. Inbound
messages are answered and stored per phone number; a greeting gets the menu, a
question is answered from the WhatsApp + public answers, and replying **human**
hands the whole thread to the EduSphere team.

The webhook is mounted **before** the authenticated API router and checks the
HMAC-SHA256 signature against the exact bytes Meta signed. With the provider
left at `none` the endpoint still records the conversation and returns the reply
in its HTTP response, so the bot can be tested end to end before a live number
exists.

### Cost control

- Small context (last 12 turns) and capped output tokens; shorter on WhatsApp.
- Per-surface rate limits: 20/min in-app, 10/min public.
- Every turn records `tokens_in` / `tokens_out` on the message row.

---

## 3. Files

| Area | File |
|---|---|
| Tier definitions + offer copy | `server/services/plan-catalogue.js` |
| Billing logic (`checkFeature`, `entitlements`) | `server/services/subscription.js` |
| Feature gate middleware | `server/middleware/subscription.js` |
| Billing routes | `server/routes/subscription.js` |
| Public pricing endpoint | `server/routes/public.js` (`GET /api/public/plans`) |
| Limit/expiry gate | `checkPlanLimits` in `server/util.js` |
| AI logic | `server/services/ai.js` |
| AI provider resolution, encryption, URL validation | `server/services/ai-config.js` |
| AI routes | `server/routes/ai.js` |
| Institution UI | `public/js/subscription.js` |
| AI widget + knowledge editor | `public/js/edusphere-ai.js` |
| Widget bootstrap | `public/js/ai-boot.js` |
| Styles | `public/css/subscription.css` |
| Schema | migrations `042_subscriptions_and_billing`, `043_edusphere_ai_assistant` |
| Tests | `test/subscription.test.js` (billing lifecycle), `test/subscription-features.test.js` (tiers + gating), `test/subscription-ui.test.js` (jsdom pricing screen + upsell), `test/ai-provider-settings.test.js` (dashboard provider layer, key secrecy, env precedence, SSRF) |
