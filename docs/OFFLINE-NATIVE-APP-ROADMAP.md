# EduSphere Native Software & Offline-First Sync Architecture

This document defines the 4-phase engineering roadmap transforming EduSphere from a browser-only web platform into **real installable native software applications** for **PC (Windows, macOS, Linux)** and **Phones & Tablets (Android, iOS/iPadOS)** with **local-first offline operation and automatic background synchronization**.

---

## Phase Overview

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | **App-Ready Backend, Device Bearer Auth & Offline Sync API** (`/api/sync`, `device_auth_tokens`, `sync_mutations`, native CORS/CSP, `api.js` transport interceptor) | **Completed** |
| **Phase 2** | **Frontend Local-First Storage, Outbox Engine & Sync UI** (IndexedDB/SQLite store, offline read/write interception via `API.setTransportInterceptor`, optimistic local IDs, Offline Unlock, Sync Status Bar & Queue Drawer) | **Completed** |
| **Phase 3** | **Desktop Software Application (PC)** (Electron + `electron-builder` installers `.exe` / `.dmg` / `.AppImage` / `.deb`, embedded local Node+SQLite server / LAN School Hub mode + Cloud Sync) | Next |
| **Phase 4** | **Mobile & Tablet Software Application (Phones & Tabs)** (Capacitor Android `.apk`/`.aab` & iOS/iPadOS `.ipa`, native SQLite storage, network listener, camera QR attendance scanner, mobile/tablet UX polish) | Planned |

---

## Phase 1 Reference (Implemented)

### 1. Database Schema (`045_native_app_and_offline_sync` in `server/migrate.js`)
Portable across both SQLite (`node:sqlite`) and MySQL 8 (`mysql2/promise`):

- **`device_auth_tokens`** (excluded from portable backups via `SKIP_TABLES` in `server/services/backup.js`, pruned automatically on server boot and hourly):
  - `id`, `user_id`, `madrasa_id` (nullable for `super_admin`)
  - `token_hash` (`VARCHAR(64)` UNIQUE — SHA-256 hex digest of raw `eds_...` token; plaintext is **never** persisted)
  - `token_prefix` (`VARCHAR(16)`), `device_id`, `device_name`, `platform` (`web` | `desktop` | `windows` | `macos` | `linux` | `android` | `ios`)
  - `app_version`, `last_ip`, `user_agent`
  - `last_used_at`, `expires_at`, `revoked_at` (`BIGINT` epoch milliseconds)
- **`sync_mutations`** (included in `TABLE_ORDER` in `server/services/backup.js`):
  - `id`, `madrasa_id`, `user_id`, `device_id`
  - `client_mutation_id` (`VARCHAR(128)` — unique per `(madrasa_id, client_mutation_id)`)
  - `entity_type`, `operation`, `local_id`, `server_id`
  - `status` (`processing` | `applied` | `conflict` | `rejected`)
  - `payload_json`, `response_json`, `error_message`

### 2. Dual Authentication & CSRF Security (`server/middleware/auth.js`, `server/routes/auth.js`)
- **Web Browser Sessions (Default):** Uses `httpOnly` session cookie + `X-CSRF-Token` header (`req.authMethod = "session"`). Ordinary web logins (`POST /api/auth/login` without `issueDeviceToken: true`) do **not** mint a device token.
- **Native App Bearer Tokens:** When `POST /api/auth/login` includes `{ issueDeviceToken: true, deviceId, deviceName, platform, appVersion }` (or automatically when `window.__EDUSPHERE_NATIVE__` is injected by Electron/Capacitor), the server mints a raw `eds_<64-hex>` token (90-day default lifetime via `DEVICE_TOKEN_MAX_AGE_MS`) and rotates any prior active token for `(user_id, device_id)`.
- **Strict Anti-Piggyback Rule:** When `Authorization: Bearer ...` is sent, `loadUser` authenticates **exclusively** via `verifyBearerToken` and **never** falls back to session cookies. Sending a valid session cookie alongside a bogus Bearer token returns `401`, preventing cross-site CSRF bypasses.
- **Lifecycle & Remote Revocation:**
  - `GET /api/auth/devices` — lists active signed-in devices for the current user (`isCurrent: true` marks the active token).
  - `DELETE /api/auth/devices/:id` — revokes a specific device immediately.
  - `POST /api/auth/logout` — revokes the active Bearer token (and destroys any web session).
  - `POST /api/auth/change-password` — revokes all *other* device tokens while keeping the active device signed in.
  - `POST /api/auth/reset-password`, user deactivation (`is_active = 0`), or institution suspension (`madaris.status != 'active'`) immediately invalidates Bearer access.

### 3. Native Origins & Runtime Config (`server/config.js`, `server/app.js`)
- Default allowed native origins (`DEFAULT_NATIVE_APP_ORIGINS`, configurable via `NATIVE_APP_ORIGINS` env var):
  `capacitor://localhost`, `ionic://localhost`, `http://localhost`, `https://localhost`, `app://edusphere`, `edusphere://app`.
- CORS preflight allows `Content-Type`, `X-CSRF-Token`, `Authorization`, and `X-Device-Id`.
- `/app-config.js` and `/api/config` expose `offlineSync: true` and `syncVersion: 1`.

### 4. Incremental Pull & Idempotent Outbox Push (`server/routes/sync.js`)
- **`GET /api/sync/status`** — Returns `{ ok, syncVersion: 1, serverTime, authMethod, deviceTokenId, madrasaId, role, outboxAppliedCount, supportedMutations }`.
- **`GET /api/sync/pull?since=<ISO-or-ms>&collections=a,b`** — Returns `{ ok, syncVersion: 1, serverTime, cursor, isDelta, scope, collections }`:
  - **Tenant Staff (`school_admin`, `admin`, `principal`, `vice_principal`, `headteacher`, `teacher`, `accountant`, `librarian`, `admission_officer`, `exam_officer`, `staff`):**
    - Scope metadata: institution, subscription/features, permissions.
    - Collections: `academic_sessions`, `terms`, `classes`, `class_arms`, `subjects`, `class_subjects`, `teacher_assignments`, `grading_scales`, `students`, `attendance`, `staff_attendance`, `results`, `quran_progress`, `fee_items`, `fee_assignments`, `fee_payments`, `announcements`, `homework`, `timetable_entries`, `card_credentials` (scanner-safe projection for offline QR gate check-in).
    - **Teacher Isolation:** `teacher` accounts without school-wide permissions receive **only** their assigned classes/subjects (`getTeacherScope`), never the whole school's students/results/fees.
  - **Student / Parent Portal (`student`):**
    - Scope metadata: student profile + institution summary.
    - Collections: `academic_sessions`, `terms`, `subjects`, `attendance`, `results` (**only published, non-withheld** `status = 'published' AND is_withheld = 0` rows), `quran_progress`, `fee_assignments`, `fee_payments`, `announcements` (`audience IN ('all','students','parents')`), `homework`, `timetable_entries`.
- **`POST /api/sync/push`** — Accepts `{ deviceId, mutations: [{ clientMutationId, type, localId?, payload }] }` (up to 100 mutations per batch):
  - **Supported Mutations:**
    1. `student.create` / `student.update`
    2. `attendance.bulk_save`
    3. `attendance.staff_bulk_save`
    4. `attendance.scan` (offline QR card verification — rejects revoked/inactive cards cleanly as `conflict`)
    5. `result.save` / `result.bulk_save` (respects `results.is_frozen` and term `results_published` locks, returning `conflict` with `serverRecord` instead of overwriting)
    6. `quran.create`
    7. `fee_payment.create` (creates `fee_payments` row + recalculates `fee_assignments` balance/status; rejects duplicate `reference_no` as `conflict`)
    8. `expense.create` (forced to `draft` approval status when synced from offline devices)
    9. `announcement.create`
  - **Idempotency & Local-ID Resolution:**
    - Each `(madrasa_id, client_mutation_id)` is claimed before execution and stored with `status = 'applied'`, `server_id`, and `response_json`. Network retries return `replayed: true` with zero duplicate rows.
    - Offline temporary IDs (e.g., `local:stu-uuid-1`) passed as `localId` on `student.create` are returned in `idMap` AND resolved automatically across subsequent mutations in the **same** push batch or **later** push batches from that institution!
    - Validation errors (`rejected`) and domain locks (`conflict`) release the `processing` claim and never abort valid sibling mutations in the same batch.

### 5. Frontend Transport Hook (`public/js/api.js`)
- `API.getDeviceToken()`, `API.setDeviceToken(tok)`, `API.clearDeviceToken()`
- `API.setTransportInterceptor(fn)` — receives `{ method, path, body, isForm, onlineRequest }` so Phase 2's offline engine can serve cached reads when offline, enqueue writes into the local Outbox, and hydrate local stores from online responses without violating CSRF rules.
- `API.sync.status()`, `API.sync.pull({ since, collections })`, `API.sync.push({ deviceId, mutations })`

---

## Phase 2 Reference (Implemented)

Everything below runs in the browser today and is reused unchanged by the Electron
(Phase 3) and Capacitor (Phase 4) shells — the native packages load the same
`public/` bundle, so there is exactly one offline implementation to maintain.

### 1. `public/js/offline-db.js` — tenant-scoped local store (`edusphere_offline_v1`)

- **One database, strictly partitioned keys.** Every record key is prefixed with a
  scope key derived from `(madrasaId, userId)`:
  `m<madrasaId>|u<userId>|collections|<collection>|<recordId>`. The only way to
  touch data is a scoped handle from `OfflineDB.openScope({ madrasaId, userId })`, so
  two accounts sharing a school PC or gate tablet can never read each other's rows.
  `scope.purge()` deletes exactly one account/institution pair.
- **Stores:**
  - `collections` — every `/api/sync/pull` collection (`students`, `classes`,
    `class_arms`, `subjects`, `class_subjects`, `teacher_assignments`,
    `grading_scales`/`grading_config`, `academic_sessions`, `terms`, `attendance`,
    `staff_attendance`/`teacher_attendance`, `results`, `term_summaries`,
    `quran_progress`, `fee_items`, `fee_assignments`, `fee_payments`,
    `announcements`, `homework`, `timetable_entries`/`timetable_slots`,
    `card_credentials`, `teachers`, `expense_categories`, `expenses`, …)
  - `meta` — `lastPullCursor`, the cached `/api/auth/me` session snapshot, the
    institution profile + feature flags, `lastSyncedAt`, and the offline-unlock
    verifier.
  - `outbox` — `clientMutationId`, `type`, `localId`, `payload`, `createdAt`,
    `status` (`pending` | `syncing` | `synced` | `conflict` | `rejected` |
    `discarded`), `error`, `code`, `serverRecord`, `attempts`, `dedupeKey`.
  - `id_map` — `localId -> serverId` (also indexable as `entity:localId`).
  - `snapshots` — last-known response per cached `GET`, so a screen the operator has
    already opened still renders offline even when no dedicated resolver exists.
- **IndexedDB with a labelled fallback.** When IndexedDB is blocked (private mode,
  old WebView) the module transparently uses an in-memory backend with the same
  contract; the Sync drawer then warns that durability is only until the tab closes.
- `replaceCollection()` (full pull) replaces the server's copy **but keeps rows that
  exist only on this device** (`local:` / `_pending`), so a refresh can never make
  unsynced work disappear.

### 2. `public/js/sync-engine.js` — transport interceptor & Outbox engine

- Registers `window.API.setTransportInterceptor(intercept)`. **No raw `fetch` with a
  mutating method exists in this file** (enforced by
  `test/card-scanner-csrf.test.js` and asserted again in `test/offline-frontend-sync.test.js`);
  every write keeps the CSRF double-submit token / Bearer device token of `api.js`.
- **Online path:** request → `onlineRequest()`; each successful `GET` is mirrored
  into `snapshots`; the first `/auth/me` after sign-in (or reload) opens the tenant
  scope and triggers an initial `API.sync.pull()`; a periodic pull (5 min, plus on
  `online`, on demand, and after every online write) keeps it fresh.
- **Offline path (network error *or* `navigator.onLine === false`):**
  - `GET`s are answered from the scoped store through dedicated resolvers —
    `/auth/me`, `/students` (`+ /stats`, `/:id` with search/filter/paging and class
    joins), `/classes`, `/subjects`, `/sessions`, `/terms`, `/attendance`
    (class/day register), `/attendance/student/:id`, `/results/roster`,
    `/results/class`, `/results/summary`, `/grading`, `/quran-progress`
    (`/me`, `/overview`), `/fees/*` (items, payments, balance, per-student),
    `/announcements`, `/portal/*` (`me`, `results`, `announcements`, `assignments`),
    `/homework`, `/timetable` (+ `/me`), `/madrasa/dashboard`, `/madrasa/profile`,
    `/auth/devices`, and QR verification via the synced `card_credentials`
    (`/public/card/:code`, `/public/verify-card/:code`,
    `/documents/card/:type/:id/credential`). Anything else falls back to its cached
    response; a screen that was never opened answers with a plain-language message
    instead of a crash or a blank panel.
  - Supported writes are recorded **optimistically** with `local:<uuid>` ids and
    queued in the `outbox` — the UI updates instantly, and nothing is attempted on
    the network:

    | REST call | Mutation | Optimistic effect |
    |---|---|---|
    | `POST /students` | `student.create` | row appears in lists/registers immediately |
    | `PATCH /students/:id` | `student.update` (folded into a pending create if the row is still local) | row updated |
    | `POST /attendance/mark` | `attendance.mark` | register shows the marks |
    | `POST /attendance/scan` | `attendance.scan` | gate scan marked from cached `card_credentials` |
    | `POST /attendance/teachers/mark` | `teacher_attendance.mark` | staff register updated |
    | `PUT /results` | `results.upsert` | workbook shows the entered scores |
    | `POST /quran-progress`, `PATCH /quran-progress/:id` | `quran_progress.create` / `.update` | Hifz log updated |
    | `POST /fees/payments` | `fee_payment.record` | payment listed with an `OFFLINE-…` receipt |
    | `POST /expenses` | `expense.create` | draft expense listed |
    | `POST /announcements` | `announcement.create` | announcement visible immediately |

    Repeated edits of the same register/sheet are merged into **one** queue entry
    (`dedupeKey`), so a teacher tapping save five times offline sends one mutation.
  - Strictly online-only actions fail with friendly, actionable messages instead of
    hanging: live AI chat, payment-gateway checkout, support chat, platform
    administration, server-side exports/backups, and any file upload.
- **Reconnect / flush:** `flushOutbox()` batches up to 50 mutations per request to
  `API.sync.push()`, marks `applied`/`duplicate` items `synced`, records conflicts
  and rejections with their server reason, maps every returned id into `id_map`, and
  rewrites the optimistic rows (own key + every foreign key pointing at them). After
  a successful push it performs **one full reconciliation pull** (incremental cursors
  cannot see rows whose `updated_at` was never stamped on insert) and removes the
  superseded optimistic rows — the local copy ends up byte-for-byte equal to the
  server's, with **zero duplicate rows**. A replay of an already-applied
  `clientMutationId` is answered `duplicate` by the server ledger and creates nothing.
- **Conflicts** (frozen/published results, revoked or inactive QR cards, duplicate
  payment references) are stored as `conflict`/`rejected` with `error`, `code` and
  `serverRecord`; `SyncEngine.conflicts()` lists them, `resolveConflict(id, "retry")`
  re-sends, `resolveConflict(id, "discard")` accepts the server version and drops the
  local attempt.
- **Offline cold start / unlock:** a successful online sign-in stores a
  **PBKDF2-SHA256 (120k iterations, random salt)** verifier per account — never the
  password. `API.login()` is wrapped: if the network is gone and the typed password
  matches the verifier, the cached workspace is unlocked locally, `/auth/me` resumes
  from the snapshot, and all work is queued. A wrong password is refused, and an
  account with no saved access is told to connect once. Signing out (or a server 401)
  re-locks the cached workspace without deleting it.
- Registers `/sw.js` for the browser build only (never inside a native shell).

### 3. `public/js/sync-ui.js` + `public/css/offline-sync.css` — status bar and drawer

- A quiet pill in the workspace header (`.dash-header`, portal header) with the live
  state: **`Online · Synced`**, **`Offline · Saving Locally`**, **`Syncing (N)…`**,
  **`Sync Attention (N)`**, plus `Online · N Pending` while a queue drains. It
  re-mounts itself after SPA re-renders and only appears once a session exists.
- Clicking opens the **Sync & Devices drawer**: last-synced time + **Sync Now**,
  pending Outbox items with their description/age, conflicts with the server's own
  explanation and **Retry** / **Accept Server Version**, and the **Signed-in devices**
  list (`GET /api/auth/devices`, revoke with `DELETE /api/auth/devices/:id`) — all via
  `window.API`. Fully keyboard-accessible (`Escape` closes, focus is restored), and
  safe-area aware for notched phones/tablets.

### 4. Shell delivery — `public/index.html`, `public/sw.js`

- `index.html` loads `offline-sync.css` and `offline-db.js` → `sync-engine.js` →
  `sync-ui.js` immediately after `api.js`, before any screen script, so the
  interceptor is installed before the first request.
- `public/sw.js` (`edusphere-shell-v2`) precaches the **entire** shell — every
  script, every stylesheet, the manifest and the logo — so a cold launch with no
  internet paints the whole workspace. It deliberately **never caches `/api/`**
  (tenant data belongs in the scoped IndexedDB store, not a shared origin cache),
  passes uploads and `/verify/` pages straight through, and serves the cached shell
  for navigation requests during an outage.

### 5. Verification

- `test/offline-frontend-sync.test.js` runs the real `public/js` files in jsdom
  against the real Express app, with IndexedDB supplied by `fake-indexeddb`
  (devDependency): online sign-in → pull → offline reads of every module → offline
  student/attendance/results/Hifz/fees/announcement/expense/QR work with `local:` ids
  → reconnect → automatic push, `id_map` reconciliation, zero duplicates, idempotent
  replay → frozen-result and revoked-card conflicts with Retry /
  Accept-Server-Version → pill + drawer + device revocation → tenant isolation when
  two institutions share one device → offline cold-start unlock → security guards
  (no raw mutating fetch, online-only messaging, service-worker manifest matches
  `index.html` exactly).
- The full existing suite (884 assertions across 80+ files, including
  `sql-compat`, `mysql-runtime`, `card-scanner-csrf`, `admin-login`,
  `unified-login-ui`, `auth-security`, `offline-sync-and-device-auth`) plus a
  `NODE_ENV=production` boot check pass unchanged.

### Phase 2 limits carried into Phase 3/4

- File uploads, exports, AI chat and payment-gateway checkout remain online-only by
  design (they need the server or a third party).
- Durable offline work needs a real storage backend; the memory fallback only
  survives the current tab and says so in the drawer.
- The browser shell is only as durable as the browser's storage eviction policy —
  the desktop (Electron) and mobile (Capacitor) packages in Phases 3 and 4 exist to
  make that durable and to own the app window, tray, camera and installers.

## Repo Guardrails for Phases 2, 3, and 4 (MUST NOT BREAK)

1. **SQL Dialect Guard (`test/sql-compat.test.js`):**
   - Never use `ON CONFLICT`, `INSERT OR IGNORE`, `INSERT OR REPLACE`, `SQLITE_`, `PRAGMA`, `AUTOINCREMENT`, `AUTO_INCREMENT`, `DATETIME('now')`, `STRFTIME`, or `UNIXEPOCH` in `server/` outside `server/db-dialect.js` — **not even inside comments or error strings** (the test scans raw source lines).
   - Never interpolate `ORDER BY ${...}`, `LIMIT ${...}`, or `GROUP BY ${...}` in `server/` (even in English error strings like ``limit ${max}``).
   - Never use double-quoted SQL identifiers or unguarded backticks in `server/`.
2. **MySQL 8 Schema Guard (`test/mysql-runtime.test.js`):**
   - Any future migration in `server/migrate.js` must use `${D.autoInc(dialect)}` and `${D.engine(dialect)}`, put `madrasa_id` first in at least one index per tenant table, avoid duplicate column-list indexes, and avoid `DEFAULT` on `TEXT`/`BLOB`.
3. **Frontend CSRF Guard (`test/card-scanner-csrf.test.js`):**
   - Every state-changing HTTP request (`POST`, `PUT`, `PATCH`, `DELETE`) in `public/js/` **must** go through `window.API` (`public/js/api.js`), never raw `fetch(...)` in other `public/js/*.js` files.
4. **Admin Login Regressions (`test/admin-login.test.js`):**
   - Navigating explicitly to `/login`, `/admin`, or `/admin/login` in a web browser must always show the login form and never auto-bypass into the console on web.

---

## Phase 3 Specification (Session 3) — Desktop Software Application (PC)

- `desktop/` workspace: Electron `main.js` (single-instance lock, window state,
  system tray, auto-launch, native print/PDF export, safe `preload.js` exposing
  `window.__EDUSPHERE_NATIVE__` so `api.js` mints Bearer device tokens), plus
  `electron-builder` targets: Windows NSIS `.exe`, macOS `.dmg`, Linux `.AppImage`
  and `.deb`.
- Two selectable runtime modes in Desktop Settings:
  1. **Cloud-Synced App Mode** — the packaged app loads the remote EduSphere server
     with the full Phase 2 local-first engine + native Bearer token.
  2. **Local Standalone / School LAN Hub Mode** — boots the embedded Express +
     SQLite server on the school PC (same `server/` code, `PORT`/`DATA_DIR` from the
     app's user-data folder) so campus phones/tablets on Wi-Fi keep working when the
     town has no internet, with optional upstream cloud sync.
- GitHub Actions matrix workflow producing the four installers as release assets.
- Must ship the Phase 2 assets untouched (no fork of the offline engine), keep the
  SQL dialect guardrails green, and end by explaining the work + verifying security
  and zero-crashing before merging, then emit the Session 4 prompt.

## Phase 4 Specification (Session 4)
- `mobile/` Capacitor project (`capacitor.config.ts`, Android Gradle project & iOS Xcode config, build scripts + GitHub Actions Android `.apk`/`.aab` builder).
- Native bridge (`public/js/native-bridge.js`) injecting `window.__EDUSPHERE_NATIVE__`, native network status listener, persistent SQLite/IndexedDB durability, native back-button handling, safe-area insets for notches/tablets, and instant camera QR scanning for offline student/staff gate attendance.
