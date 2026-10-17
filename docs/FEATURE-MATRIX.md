# BELLO — Feature Matrix (Auth & Delivery Pass, 2026-09-23)

Legend: ✅ present before this pass · 🆕 added in this pass · ♻️ extended in this pass

## Foundation (verified by the existing suite — NOT rebuilt)

| # | User | Feature | Backend | API | Frontend | Permissions | Tests | Status |
|---|------|---------|---------|-----|----------|-------------|-------|--------|
| 1 | All | Auth (login/logout/me/password/CSRF/sessions) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2 | All | 5 core roles + granular permissions + overrides | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3 | All | Tenant isolation on every row | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 4 | All | Audit log | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 5 | Ops | SQLite + MySQL + 35→36 migrations + pooling + load tests | ✅ | — | — | — | ✅ | ✅ |
| 6 | All | Security (CSRF, rate limits, upload hardening, XSS, path traversal) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 7 | Admin | Students lifecycle, classes, subjects, groups, health, ID cards | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 8 | Admin | Teachers lifecycle, applications, profiles | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 9 | Admin | Results lifecycle (draft→…→locked) + report cards | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 10 | Admin | Fees/payments (lifecycle incl. online gateway) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 11 | Admin | Payroll / Leave / Library / Expenses / Documents | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 12 | Admin | Communication (announcements, messages, notifications, delivery log) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 13 | Admin | Public website management + global search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 14 | Super Admin | Platform console (stats, madaris, registrations, plans, analytics, activity, backups, settings) | ✅ | ✅ | ✅ | role | ✅ | ✅ |
| 15 | Parent | PTM booking flow (double-booking prevented server-side) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 16 | Public | Marketing site, school pages, registration, result checking | ✅ | ✅ | ✅ | — | ✅ | ✅ |

## Added or completed in this pass

| # | User | Feature | Backend | API | Frontend | Permissions | Tests | Status |
|---|------|---------|---------|-----|----------|-------------|-------|--------|
| 17 | Teacher | **Workspace at `/teacher`** — dashboard (today's classes, pending attendance, grading queue, result counters), classes + rosters, timetable, attendance register (bulk mark, duplicate-safe save), lesson plans (draft/published/completed), assignments (publish, deadline, submission tracking, grading), exams + marks, results gradebook + submit-for-review, leave self-service, library self-service, messages, notifications, calendar | ♻️ reuse | 🆕 `/api/teachers/dashboard` | 🆕 `public/js/portal-teacher.js` | ✅ server-enforced scopes | 🆕 portal-ui + portal-experience | ✅ |
| 18 | Student | **Portal at `/student`** — dashboard, timetable, lessons, assignments (view/submit/resubmit until graded, feedback), exam timetable, results + report cards, attendance, fees + receipts, library, Qur'an progress (Islamic only), messages, notifications, account | ♻️ reuse | 🆕 `/api/portal/dashboard`, `/portal/assignments(+/ :id/attachments)`, `/portal/exams`, `/portal/contacts`, `/library/my-loans`, `/quran-progress/me` | 🆕 `public/js/portal-student.js` | ✅ own-record only | 🆕 portal-ui + portal-experience | ✅ |
| 19 | Parent | **Family portal at `/parent`** — dashboard with all children, child switcher (server-validated per request), attendance/results/report cards/assignments/timetable/exams/fees per child, PTM link, Qur'an progress, messages, notifications | ♻️ reuse | 🆕 (same as student, `?studentId=` validated via parent_links) | 🆕 `public/js/portal-parent.js` | ✅ linked children only | 🆕 portal-ui + portal-experience | ✅ |
| 20 | All | Login routing: `/login` hands each account to its own workspace | — | — | ♻️ `dashboard.js` | ✅ | ♻️ admin-login | ✅ |
| 21 | All | Portal shell + notification centre (shared, reuses dash-* design system) | — | ✅ existing | 🆕 `public/js/portal.js`, `public/css/portal.css` | ✅ | 🆕 portal-ui | ✅ |
| 22 | Admin | Academic calendar & school events (audience targeting, per-tenant) | 🆕 `calendar_events` (migration 035) | 🆕 `/api/calendar` CRUD | 🆕 Academic → Calendar & Events + portal widgets | 🆕 `calendar.view/manage` | 🆕 calendar-events | ✅ |
| 23 | Admin | Platform support tickets (institution side) | 🆕 `support_tickets` + notes (migration 035) | 🆕 `/api/support/*` | 🆕 Platform Support section | 🆕 `support.view/create` | 🆕 support-tickets | ✅ |
| 24 | Super Admin | Support ticket queue (status/priority/assignment, public + internal notes) | ♻️ same tables | 🆕 `/api/platform/tickets*` | 🆕 Platform → Support Tickets | super-admin only | 🆕 support-tickets | ✅ |
| 25 | Admin | Question bank | 🆕 `question_bank` (migration 035) | 🆕 `/api/academic/questions*` | 🆕 Academic → Question Bank | 🆕 `questionbank.view/manage` | 🆕 question-bank | ✅ |
| 26 | Admin | Staff role templates (Accountant, Librarian, Admissions Officer, Academic Officer, HR Officer, Receptionist) — permission bundles on STAFF accounts, no new roles | ♻️ user_permissions | 🆕 `/api/admin/permissions/templates` + apply | ♻️ Roles & Permissions "Apply template" | ✅ roles.manage + audited | 🆕 role-templates | ✅ |
| 27 | Family | Messaging restriction: student/parent accounts can only write to staff | ♻️ messages | ♻️ `POST /communication/messages` guard | — | ✅ | 🆕 portal-experience | ✅ |
| 28 | Family | Fee + timetable + attendance + announcement views (existing endpoints verified through the portals) | ✅ | ✅ | 🆕 portal pages | ✅ | 🆕 portal-experience | ✅ |

## Added or completed in the auth & delivery pass (this one)

| # | User | Feature | Backend | API | Frontend | Permissions | Tests | Status |
|---|------|---------|---------|-----|----------|-------------|-------|--------|
| 29 | All | **Unified login, one form for all five account types** — no role chooser; server answers with role+tenant and the page hands the session to the right workspace | ♻️ sessions | ♻️ `/api/auth/login` | ♻️ `dashboard.js` login card (show/hide password, remember me, forgot link, inline errors, a11y, mobile) | ✅ server-determined role | 🆕 unified-login-ui | ✅ |
| 30 | All | **Self-service password reset** — generic request answer (no enumeration), single-use expiring tokens (hashed at rest), reset invalidates all sessions, admin-visible links for schools without email | 🆕 `password_reset_tokens` (migration 036) | 🆕 `/api/auth/forgot-password`, `/reset-password`, `/reset-requests` | 🆕 `/forgot-password`, `/reset-password` pages + admin Account & Security queue | ✅ rate-limited + CSRF | 🆕 password-reset (14) | ✅ |
| 31 | Teacher | **Online examinations — authoring** — draft→published lifecycle, MC/subjective questions, per-question marks, question-bank import, publish gate (needs questions, no timetable conflict), publish notification | 🆕 `online_exams`, `online_exam_questions`, `exam_attempts`, `exam_answers` (migration 037) | 🆕 `/api/academic/online-exams*` (create/update/publish/questions/import/attempts/grade/release) | 🆕 Teacher → Online Exams manager | 🆕 `exams.create` + own class/subject scope | 🆕 online-exams (13) | ✅ |
| 32 | Student | **Online examinations — taking** — takeable list, timed runner (server-issued deadline), navigator, autosave, submit confirm, locked-attempt rules, auto-finalize on expiry, marked-paper review after release | ♻️ same tables | 🆕 `/portal/online-exams*` (list/start/save/submit/review) | 🆕 Student → Online Exams runner | ✅ own attempts only, no answers pre-release | 🆕 online-exams | ✅ |
| 33 | Teacher | **Online examinations — grading** — objective auto-scored, subjective graded with over-award guard, release per exam | ♻️ same tables | 🆕 attempts queue + grade/release endpoints | 🆕 attempts + review views | ✅ attempts.view scope | 🆕 online-exams | ✅ |
| 34 | Parent | **Online exam visibility per child** — attempts and scores appear on each linked child's exam page; parents can never start or save attempts | ♻️ | 🆕 attempts surfaced via `/portal/exams` scope | ♻️ parent exams page | ✅ linked children only | 🆕 online-exams | ✅ |
| 35 | Parent | **Online fee payment** — per-item outstanding, initiate, provider checkout redirect, status polling, receipts; success only via verified webhook/callback | ♻️ existing payments tables | ♻️ `/api/payments/initiate` + gateway callback/webhook (auth-order bug FIXED: 403/404/400 now precede the 503 gateway-not-configured answer) | 🆕 Parent → Fees → Pay online + receipt view | ✅ linked children + tenant-scoped fee items | 🆕 parent-payments (9) | ✅ |
| 36 | All | Exam publish/release notifications | ♻️ notifications | 🆕 `online_exam_published` / `online_exam_released` audiences | ♻️ portal bell | ✅ | 🆕 online-exams | ✅ |

## Added or completed in the account-creation pass (this one)

| # | User | Feature | Backend | API | Frontend | Permissions | Tests | Status |
|---|------|---------|---------|-----|----------|-------------|-------|--------|
| 37 | Admin | **Student portal login — create & reset from the UI** — the "Portal access" tab in the existing student-profile modal shows *No login yet* or the username + active state, and creates or resets the login | ♻️ `users` | ♻️ existing `POST /api/students/:id/portal-account` (no new endpoint) | ♻️ `dashboard.js` — new `data-profile-tab="portal"` entry in the existing tab/render map | ✅ `requireRole("madrasa_admin")` + tenant scope (unchanged) | 🆕 portal-accounts, portal-access-ui | ✅ |
| 38 | Admin | **Parent portal login — create & link from the UI** — same tab lists every linked parent account with its children, and creates a new one (username, password, display name, phone) | ♻️ `users` + `parent_links` | ♻️ existing `POST /api/students/:id/parent-account` (accepts `student_ids` for multi-child) | ♻️ same Portal access tab | ✅ madrasa_admin + tenant scope (unchanged) | 🆕 portal-accounts, portal-access-ui | ✅ |
| 39 | Admin | **Account creation during admission conversion** — the CONVERT TO STUDENT action now offers optional student/parent logins with editable usernames (defaults: admission number, admission number + `-p`) and one shared password; the confirmation names the created usernames | ♻️ unchanged | ♻️ existing `POST /api/admissions/:id/convert` fields `create_student_account`, `create_parent_account`, `student_username`, `parent_username`, `password` | ♻️ `academic-admissions.js` `#convertApplicant` (previously posted `{}`) | ✅ `admissions.approve` (unchanged) | 🆕 portal-accounts | ✅ |
| 40 | Admin | **Portal-account status on the student record** — `GET /api/students/:id` additively reports the student login (username, is_active, created_at) and the linked parent logins with their children | ♻️ reads `users` / `parent_links` only | ♻️ additive fields `portalAccount`, `parentAccounts` — existing fields untouched | ♻️ consumed by the Portal access tab | ✅ existing staff-only rule preserved; never returns password hashes | 🆕 portal-accounts | ✅ |
| 41 | All | **Account creation & login guide** — the complete flow for all five account types, the one-login-page rule, and how Accountant/HR/Receptionist/Librarian staff are TEACHER accounts + permission templates | — | — | 📄 `README.md` | — | 🆕 source-contract tests | ✅ |

## Preservation notes

- The 5 core account roles are unchanged; "staff roles" are **permission bundles** on
  teacher-role accounts (the existing Roles & Permissions system is the source of truth).
- Fee, result, payment, message-delivery and PTM lifecycles are untouched — the portals
  read/write through the existing endpoints.
- Islamic/Western modes: portals theme by the institution category and only offer the
  Qur'an module when the backend reports an Islamic institution (which also 404s the
  endpoint for Western tenants, server-side).
- No duplicate modules: the portals share one shell (`portal.js`) and the admin's design
  system (`dashboard.css`); the PTM booking flow remains the single implementation.
- The account-creation pass added **no** new endpoint, module, modal system or login page.
  The student/parent/admission-conversion APIs already existed and are unchanged; the work
  was the missing UI plus one additive, read-only extension of `GET /api/students/:id`.
- Authorization was **not** relaxed to make the feature work: `POST
  /students/:id/portal-account` and `/parent-account` keep `requireRole("madrasa_admin")`,
  the same rule every other student write endpoint in that router uses. Teachers, students
  and parents get 403; a cross-tenant student id gets 404.

## Added or completed in the report-sheet pass (2026-09-25)

| # | User | Feature | Backend | API | Frontend | Permissions | Tests | Status |
|---|------|---------|---------|-----|----------|-------------|-------|--------|
| 42 | Admin/Teacher | **Professional A4 report sheet engine** — one renderer (classic/modern/compact, auto landscape for wide tables, RTL + Arabic preserved, school branding, watermark, grading legend, next-term dates, signature blocks, "Powered by EduSphere" toggle) used by the staff workspace, bulk generation, both portals and the public result checker | 🆕 `services/report-sheet.js` wrapping the existing grading engine (no duplicate calculations) | ♻️ `GET /results/report-card/:studentId/:termId`, 🆕 `GET /results/report-sheet/:studentId/:termId` | ♻️ Report Cards page ("Report sheet" action) | ♻️ `report_cards.view` + teacher class scope | 🆕 report-sheet | ✅ |
| 43 | Admin | **Configurable report template** — layout, orientation, brand colour, result columns, CA/Exam labels, section visibility (position, attendance, behaviour, comments, promotion, class stats, photo, next term, legend, reference, watermark, credit line), behaviour categories, signature blocks; professional defaults so a new institution needs no setup; sample-data preview before saving | ♻️ `settings` key `report_template` (no new table) | 🆕 `GET/PUT /results/report-template`, 🆕 `GET /results/report-template/preview` | 🆕 Report Cards → Report template modal (edit + preview) | 🆕 `report_cards.templates` (admin-only by default, audited) | 🆕 report-sheet | ✅ |
| 44 | Admin/Teacher | **Result completeness check** — subjects assigned to a class vs results actually entered; per student and per class; missing vs awaiting-approval distinguished; visible warning in the UI and **on the printed sheet** so an incomplete report is never presented as final | 🆕 `classCompleteness` (reads existing `class_subjects`/`results`) | 🆕 `GET /results/report-completeness` | 🆕 completeness column + class-wide banner on the Report Cards page | ♻️ `report_cards.view` | 🆕 report-sheet | ✅ |
| 45 | Admin/Teacher | **Behaviour/conduct ratings** — configurable categories, 1–5 ratings stored on the existing `term_summaries` row (migration 038 adds `behaviour_ratings`), rendered with a rating legend; unrated categories show an honest empty state | ♻️ `term_summaries` + 2 columns | ♻️ `PUT /results/summary/:studentId` accepts `behaviour` | ♻️ Comments modal gains a ratings grid | ♻️ `results.edit` | 🆕 report-sheet | ✅ |
| 46 | Admin/Teacher | **Bulk class generation** — every student with results in one document, one page each, correct student-to-sheet mapping, ordered by position; batched queries (shared preload + grouped results/attendance) so a class never becomes per-student N+1 lookups | ♻️ same builder, batched | ♻️ `GET /results/report-cards/bulk` (+ `/report-sheets/bulk` alias), audited | 🆕 "All report sheets" action | ♻️ `report_cards.generate` + teacher class scope | 🆕 report-sheet | ✅ |
| 47 | Admin | **Extended promotion decisions** — the engine's four computed statuses are unchanged; an administrator may additionally record promoted-on-trial / withdrawn / completed on the same summary row | ♻️ `term_summaries` | ♻️ `PUT /results/summary/:studentId` | ♻️ Comments modal decision list | ♻️ `results.edit` | 🆕 report-sheet | ✅ |
| 48 | Student/Parent | **Published-only portal reports** — the student/parent report endpoints now enforce `published_at` server-side (previously an unpublished summary rendered in the portal); portal result listings show published terms only and subject detail excludes non-approved rows | ♻️ unchanged tables | ♻️ `GET /portal/report-card`, `/portal/results`, `/portal/results/:termId` | ♻️ portals (label now "Report sheet") | ✅ publication gate | 🆕 report-sheet | ✅ |
| 49 | All | **Report reference number** — deterministic, human-facing `EDU-<session>-<class>-<admission>` reference persisted on the summary (migration 038) and printed on the sheet/footer; internal database ids are never exposed | 🆕 `term_summaries.report_reference` | included in sheet payload | printed on the sheet | — | 🆕 report-sheet | ✅ |
| 50 | All | **Report workflow status + audit** — a report's stage (draft → submitted → under review → approved → published → locked) is derived from its subject results *and* pending entries, shown in the staff preview; report view/print/bulk/template/portal actions are written to the existing activity log | ♻️ existing lifecycle | 🆕 in `report-sheet` payload | 🆕 status pill on the print toolbar | ♻️ existing | 🆕 report-sheet | ✅ |
| 51 | All | **IDOR fix on the results workspace** — an authenticated STUDENT could read any classmate's full report data through staff endpoints (`/api/results/report-card-data/...` returned 200) because `requireStaffPermission` deliberately passes portal roles through; the results router now refuses student/parent roles outright (they keep their own `/api/portal/*` endpoints) | ♻️ | 🆕 router-level staff gate | — | ✅ | 🆕 report-sheet | ✅ |

### Report-sheet pass preservation notes

- **No duplicate modules**: one report engine (`services/report-sheet.js`) behind every
  printable report; `routes/results.js` keeps its historical exports as thin delegates.
  All totals/grades/averages/positions/promotions still come **only** from
  `services/grading.js`.
- **No second settings system**: the template lives in the existing per-institution
  `settings` store (same pattern as the admissions settings).
- **No second promotion system**: the four computed lifecycle statuses are untouched;
  the extra values are manual annotations on the same summary row.
- **PDF pipeline unchanged**: the platform's documents (ID cards, certificates) render
  HTML and produce PDFs through the browser's print dialog — the report sheet uses the
  same pipeline, which is what preserves Arabic shaping, branding and page breaks.
- **Two pre-existing tests were updated, not weakened**: the portal report-card test now
  asserts an *unpublished* report is refused (403) before asserting the published one
  renders, and the public-checker title regex accepts the new document title in either
  language. Both changes encode the stronger behaviour this pass implements.

---

## Plan tiers & feature gating pass (2026-10-17)

Legend: ✅ present before this pass · 🆕 added in this pass · ♻️ extended in this pass

| # | User | Feature | Backend | API | Frontend | Permissions | Tests | Status |
|---|------|---------|---------|-----|----------|-------------|-------|--------|
| 52 | All | **One tier catalogue** — `services/plan-catalogue.js` defines 37 feature keys (label, blurb, group, lowest tier), the Free ⊂ Basic ⊂ Premium contents, and each tier's offer copy (tagline, promise, badge, quick win, benefit groups, headline, limits-as-capacity). Seed, gate, pricing endpoint, upsell and AI answers all read it, so copy and enforcement cannot drift | 🆕 module | ♻️ carried in every payload below | ♻️ rendered, never hard-coded | — | 🆕 subscription-features | ✅ |
| 53 | Ops | **Plans seeded + gap-filled** — `seedPlans()` writes the three tiers on an empty table; `syncPlanOffers()` runs on boot and fills missing feature keys, a blank tagline and a missing yearly price/trial **without** reversing an operator edit or touching limits | ♻️ `plans` (no schema change) | — | — | super admin | 🆕 subscription-features | ✅ |
| 54 | All | **Feature gate** — `checkFeature()` + `requireFeature()` middleware: tenant from the session only, super_admin exempt, precedence suspended → expired → enforcement switch → unknown key (fail open) → feature, so a lapsed Premium school is told to renew rather than sold an upgrade | 🆕 `middleware/subscription.js` | 🆕 403 `code:"feature_gated"` with feature, required plan, benefits, hint, `can_upgrade` | ♻️ `api.js` dispatches `edusphere:feature-gated` | ✅ alongside existing role + granular permissions | 🆕 subscription-features | ✅ |
| 55 | All | **Gating applied to 20+ surfaces** — portals, online exams, question bank, fee **writes** (reads stay open), messaging/SMS/WhatsApp per channel, exports (+ bulk), payroll, leave, library, health, expenses, ID cards, certificates, custom report templates, admissions pipeline, branding & custom domain, urgent support, advanced analytics, the four copilot capabilities | ♻️ routers | ♻️ 403 on the gated route only | ♻️ upsell on every gated click | ✅ | 🆕 subscription-features | ✅ |
| 56 | Public | **Anonymous pricing endpoint** — `GET /api/public/plans` returns the three offers with benefit groups, quick wins, limits as capacity, price + yearly saving, trial, a feature-by-feature comparison matrix and how payment works. No institution data, no internal ids | — | 🆕 `/api/public/plans` (rate-limited) | 🆕 marketing-ready payload | anonymous | 🆕 subscription-features | ✅ |
| 57 | Admin | **Pricing screen that sells** — Subscription → Plans: billing-cycle switch, three offer cards (current / recommended flags, promise, capacity, quick win, grouped benefits, one CTA), "everything included" dialog, "compare every feature" matrix, how-payment-works, plus included / next-tier cards on the overview | — | ♻️ `/subscription/plans` now carries `offer`, `current_plan_code`, `entitlements` | ♻️ `subscription.js` + `subscription.css` | ✅ existing | 🆕 subscription-ui (jsdom) | ✅ |
| 58 | All | **Upsell dialog anywhere** — `Upsell` listens for `edusphere:feature-gated` on `window` and enriches itself from the anonymous endpoint, so a gated click in the admin console, the teacher workspace or a parent portal all explain the tier and (for an administrator) open the upgrade form; other roles get the explanation without a button they cannot press | — | ♻️ same 403 | 🆕 `window.EduSphereUpsell` | ✅ role-aware CTA | 🆕 subscription-ui | ✅ |
| 59 | Admin | **Premium analytics** — `analytics.advancedAnalytics()` behind `analytics_advanced`: attendance heatmap by class × weekday, weekday/class patterns, chronic-absence list, teacher performance (results average, pass rate, engagement), fee forecast from the actual collection trend, and plain-language insights | 🆕 service function | 🆕 `GET /api/madrasa/analytics/advanced` | — (consumed by the copilot) | ✅ admin/support + gate | 🆕 subscription-features | ✅ |
| 60 | Admin/Teacher | **AI copilot** — `GET /api/ai/copilot` (capability list with `entitled` + gate, never gated itself) and four working endpoints: report-comment drafts from real marks/attendance, at-risk students with reasons + draft parent message, question generation from the school's own bank, analytics Q&A. Every one computes from tenant data without an API key instead of inventing numbers | ♻️ `services/analytics.js`, `services/ai.js` | 🆕 `/api/ai/copilot*` (4) | 🆕 copilot chips in the assistant widget (padlock → upsell) | ✅ per-capability feature keys | 🆕 subscription-features | ✅ |
| 61 | All | **AI answers about the tiers** — `tierKnowledge()` generates "what is included in the X plan", the tier comparison and an app-scope "a feature says it is not included" answer straight from the catalogue; `seedKnowledge()` is now idempotent per `scope::question` so an upgraded deployment gains them without duplicating or overwriting an operator's edit | ♻️ `ai_knowledge` | ♻️ existing chat routes | ♻️ assistant replies | — | 🆕 subscription-features | ✅ |
| 62 | Super admin | **Plan editor as switches** — Platform → Subscription Plans edits features as grouped toggles with one-click tier presets instead of a raw JSON box, shows each tier's offer/price/features-on count, and the write endpoints validate the map (catalogue keys coerced to booleans) | ♻️ `routes/platform.js` | ♻️ `GET/POST/PATCH /platform/plans` (+ `feature_catalogue`) | ♻️ `dashboard.js` | super admin | — | ✅ |

### Plan-tier pass preservation notes

- **No new tables, no schema change.** Tiers live in the existing `plans.features`
  JSON column; the catalogue module is the only new file plus one middleware.
- **Limits, expiry, suspension and grace behaviour are untouched** — the feature
  gate is a *separate* check that runs after them, and `checkPlanLimits` in
  `server/util.js` still owns ceilings.
- **Reads are never gated by a tier flag.** A school that downgrades keeps seeing
  its own fee ledger, receipts, exports of existing data and announcements; only
  creating new records in a capability it no longer has stops.
- **Fail-open on the unknown.** A key the catalogue does not know is allowed, so a
  typo in a route can never lock a school out of its own data.
- **No invented modules.** `multi_campus`, `api_access`, `sso` and
  `backups_restore` are catalogue/entitlement keys only — there is no tenant
  surface for them yet, so nothing is gated on them.
- **Two fixture/test adjustments encode the stronger behaviour:**
  `test/helpers.js` now gives the fixture plan every feature key (so module tests
  test their module, not the tier matrix), and `test/subscription.test.js` inserts
  Basic/Premium with their real feature maps (so an upgrade in a test unlocks what
  production unlocks). The fixture plan keeps its `free` code and its 50/3 limits.
- **Frontend is additive.** `api.js` gained one branch (a `feature_gated` 403 is
  dispatched, never CSRF-retried — that retry loop was also a latent infinite
  loop and is now bounded); `subscription.js` gained the plans screen and the
  `Upsell` dialog; no existing screen lost behaviour.
