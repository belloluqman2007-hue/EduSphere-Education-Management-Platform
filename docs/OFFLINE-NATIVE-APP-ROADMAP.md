# EduSphere Native Software & Offline-First Sync Architecture

This document defines the 4-phase engineering roadmap transforming EduSphere from a browser-only web platform into **real installable native software applications** for **PC (Windows, macOS, Linux)** and **Phones & Tablets (Android, iOS/iPadOS)** with **local-first offline operation and automatic background synchronization**.

---

## Phase Overview

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | **App-Ready Backend, Device Bearer Auth & Offline Sync API** (`/api/sync`, `device_auth_tokens`, `sync_mutations`, native CORS/CSP, `api.js` transport interceptor) | **Completed** |
| **Phase 2** | **Frontend Local-First Storage, Outbox Engine & Sync UI** (IndexedDB/SQLite store, offline read/write interception via `API.setTransportInterceptor`, optimistic local IDs, Offline Unlock, Sync Status Bar & Queue Drawer) | **Completed** |
| **Phase 3** | **Desktop Software Application (PC)** (Electron + `electron-builder` installers `.exe` / `.dmg` / `.AppImage` / `.deb`, embedded local Node+SQLite server / LAN School Hub mode + Cloud Sync) | **Completed** |
| **Phase 4** | **Mobile & Tablet Software Application (Phones & Tabs)** (Capacitor Android `.apk`/`.aab` & iOS/iPadOS `.ipa`, native SQLite storage, network listener, camera QR attendance scanner, mobile/tablet UX polish) | **Completed** |

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

## Phase 3 Reference (Implemented) — Desktop Software Application (PC)

Phase 3 lives entirely in `desktop/` and ships the **same** `server/` Express +
SQLite code and the **same** `public/` bundle (Phase 2 engine included) inside a
native shell. There is no fork of the offline engine and no second offline
implementation: the packaged app serves/preloads the exact files the web
deployment serves.

### 1. `desktop/` workspace (own `package.json`, own lockfile)

`electron` and `electron-builder` are **devDependencies of `desktop/` only** — the
root `npm install` and `npm test` are untouched and stay fast.
`desktop/node_modules/`, `desktop/dist/` and the staged `desktop/server/` +
`desktop/public/` copies are git-ignored build artifacts.

| File | Responsibility |
|---|---|
| `main.js` | app lifecycle, single-instance lock (`second-instance` forwards the deep link), window-state restore validated against the live displays, macOS/Windows behaviours, `app.setAboutPanelOptions`, `uncaughtException` / `unhandledRejection` handlers that log to `logs/main.log` and show a friendly dialog, a real recovery page for a crashed or unreachable renderer, IPC, deep links, orderly shutdown |
| `preload.js` | contextIsolation ON, nodeIntegration OFF, sandbox ON; exposes one **frozen** `window.__EDUSPHERE_NATIVE__ = { isNative, appVersion, platform, deviceId, deviceName, mode, getDeviceToken(), setDeviceToken(), clearDeviceToken(), print(), savePdf(), openExternal() }`. The token is fetched once with a single synchronous IPC handshake and never reaches page storage. |
| `settings.js` | per-user JSON in `app.getPath("userData")/settings.json`, **atomic** writes (temp → fsync → rename → dir fsync), corrupt-file recovery, strict validation of mode/URL/port/bind host/window geometry |
| `secret-store.js` | device token + generated hub `SESSION_SECRET` through Electron `safeStorage` (Keychain / DPAPI / libsecret), atomic 0600 blobs; **with no OS keychain nothing is written at all** — memory-only and reported |
| `server-host.js` | embedded-runtime supervisor: forks `server-entry.js`, allow-listed child env, free-port selection, ready/error/exit plumbing, graceful stop (IPC `shutdown` → SIGTERM → SIGKILL) |
| `server-entry.js` | boots the real `server/` (`config.validate`, `connectWithRetries`, `migrate`, `seedPlans`/`seedSuperAdmin`, AI knowledge seed, media hydration, `createApp().listen`, auto-backup timer, session/device-token prune, final snapshot on shutdown) |
| `tray.js` / `menu.js` | tray + native menu: **Sync now**, **Mode** (radio), **Open data folder**, LAN Hub pairing info, Print / Save as PDF, About, Desktop settings |
| `print.js` | native print dialog, `printToPDF` for report cards/receipts, off-screen batch export carrying the Bearer token — all local, so printing survives an internet outage |
| `deep-link.js` | `edusphere://` parser with an allow-list (`sync`, `settings`, `hub`, `mode/<cloud|hub>`, `about`, `open/<path>`); rejects foreign schemes, `..`, control characters and over-long links |
| `lan-hub.js` | the School LAN Hub window: loopback + every LAN URL, a QR drawn by the platform's own encoder (`server/services/print-documents.qrSvg`), OS-specific firewall guidance, first-sign-in credentials, data folder, optional upstream |
| `wizard.html/.css/.js` + `wizard-preload.js` | first-run wizard **and** Desktop Settings (same window): choose mode, validate the server address / admin password, switch at runtime |
| `scripts/stage.js` | copies `../server` + `../public` into `desktop/` right before packaging |
| `tools/make-icons.js` | dependency-free icon generator → PNG, multi-size `.ico`, `.icns`, Linux hicolor set, tray + macOS template glyphs |
| `electron-builder.yml` + `build/entitlements.mac.plist` | installer targets, artifact naming, hardened-runtime entitlements |

### 2. Two runtime modes

1. **Cloud-synced app mode** — the packaged app opens the operator's remote
   EduSphere server. It reuses the Phase 2 bundle untouched: `api.js` detects
   `window.__EDUSPHERE_NATIVE__`, mints a Bearer device token at sign-in
   (`issueDeviceToken: true` + real `deviceId`/`deviceName`/`platform`), and
   `SyncEngine` keeps serving cached reads and queueing writes. The token is
   persisted with `safeStorage` and **removed from `localStorage`** so no bearer
   credential ever sits in web storage. No cookies, no CSRF handshake.
2. **Local standalone / School LAN Hub mode** — the app forks the real server as
   a child process with `NODE_ENV=production`, a SQLite database in
   `app.getPath("userData")/data`, `DATA_DIR`/`BACKUP_DIR`/`UPLOAD_DIR` pointing
   into it, a generated 96-char `SESSION_SECRET` kept in the keychain, automatic
   migrations and seeds, and the existing backup subsystem (3-hourly snapshots,
   12 kept, plus a final snapshot on quit). It binds `0.0.0.0` **only in this
   mode**, shows the pairing window (URL + QR + firewall guidance), and can pass
   an optional upstream cloud endpoint for a later phase. A crash in the server
   is restarted (up to three times) without taking the window down.

### 3. Installers (`electron-builder`)

Windows NSIS `.exe` (x64 + arm64), macOS universal `.dmg` (hardened runtime +
entitlements prepared for signing), Linux `.AppImage` and `.deb` (x64 + arm64).
Artifacts are always `EduSphere-<version>-<os>-<arch>.<ext>`. Signing and
notarization are env-driven and optional: unsigned builds work locally, CI signs
when the secrets exist. `docs/ci/desktop-release.yml` (copy it to
`.github/workflows/desktop-release.yml` to activate — see its header) runs the matrix
(`ubuntu-latest` / `macos-latest` / `windows-latest`), caches npm, runs
`npm ci` at the root and in `desktop/`, uploads the installers as artifacts on
every push and attaches them to a GitHub Release on a `v*` tag.

### 4. Guardrails & verification

- `test/sql-compat.test.js`, `test/mysql-runtime.test.js`,
  `test/card-scanner-csrf.test.js`, `test/admin-login.test.js`,
  `test/unified-login-ui.test.js`, `test/offline-frontend-sync.test.js` and the
  rest of the existing suite pass unchanged; the only edit inside `public/` is
  the native-token branch in `api.js` (no raw mutating `fetch` added).
- `desktop/test/*.test.js` (plain `node --test`, mocked Electron, no display):
  settings atomicity + self-healing, `safeStorage` token storage never writing
  plaintext, mode selection, a real Express + SQLite boot on an ephemeral port
  serving `/login`, `/sw.js`, `/api/health`, two hosts on one data folder, the
  jsdom proof that `api.js` prefers the native bridge, deep-link allow-list,
  menu/tray actions, the packaging contract, and static + runtime security
  assertions (contextIsolation, no remote module, navigation allow-list, loopback
  in cloud mode).
- Production boot smoke check with a fresh database: `NODE_ENV=production` +
  generated secrets + an empty `DATA_DIR` boots, migrates, seeds and serves.

## Phase 4 Specification (Session 4) — Mobile & Tablet Software Application

**Goal:** the same platform as a real installable app on Android phones/tablets
and iPhone/iPad, with durable offline storage, a real network listener and a
camera QR attendance scanner.

1. **`mobile/` Capacitor project** — `capacitor.config.ts`, `android/` Gradle
   project, `ios/` Xcode project, its own `package.json`
   (`@capacitor/core|android|ios|cli` as devDependencies of `mobile/` only — the
   root install stays unchanged), `mobile/node_modules` git-ignored, and a
   `scripts/sync-web.js` that copies `public/` into the platform bundles exactly
   as `desktop/scripts/stage.js` does for the PC.
2. **Native bridge (`public/js/native-bridge.js`)** — injects the same frozen
   `window.__EDUSPHERE_NATIVE__` contract the desktop app exposes (platform,
   deviceId, deviceName, `getDeviceToken`/`setDeviceToken`/`clearDeviceToken`,
   `openExternal`, `mode`) so `public/js/api.js` mints Bearer device tokens
   exactly as it already does on the desktop. Tokens go to the iOS Keychain /
   Android Keystore-backed storage — never `localStorage`.
3. **Native storage durability** — a SQLite-backed adapter behind
   `public/js/offline-db.js` (same scoped-key contract, same outbox semantics),
   selected automatically inside the native shell, migrating whatever IndexedDB
   already holds so an updated install keeps its queue.
4. **Real network listener** — `@capacitor/network` drives
   `SyncEngine.setOnline()` so the pill, the outbox flush and the pull timer react
   to the radio instead of polling `navigator.onLine`; app foreground/background
   transitions trigger a sync on resume.
5. **Camera QR attendance scanner** — camera permission handling for Android
   (runtime permission + rationale) and iOS (`NSCameraUsageDescription`),
   continuous scanning with `jsQR`, a torch toggle, and a manual-code fallback
   for denied permissions or a broken camera, reusing the Phase 1
   `attendance.scan` mutation so scans queue offline and verify against cached
   `card_credentials`.
6. **Mobile/tablet UX polish** — safe-area insets for notches and rounded
   corners, 44px minimum touch targets, Android hardware back button routed into
   the SPA history, no rubber-band scrolling behind modals, and a tablet
   two-column layout for registers.
7. **GitHub Actions** — `.github/workflows/mobile-release.yml`: an Android job
   (`ubuntu-latest`) producing a signed `.apk` (debug-signed fallback when no
   keystore secrets exist) and an `.aab` for Play upload via
   `bundleRelease`, plus documented, gated iOS build steps for a `macos-latest`
   runner (`.ipa` via `xcodebuild archive`/`exportArchive`, signing only when
   Apple secrets are present). Artifacts uploaded on every push, attached to a
   GitHub Release on a `v*` tag.
8. **Tests & guardrails** — `mobile/test/*.test.js` with plain `node --test`
   (bridge contract, network listener wiring, storage adapter parity with
   IndexedDB, camera-permission fallbacks), the whole existing suite plus the
   desktop suite still green, and no raw mutating `fetch` added to `public/js/`.
9. **Security & zero crashes** — camera permission only when the scanner opens,
   deep-link/URL allow-lists on the native side, no plaintext token on disk, no
   remote code, and an uncaught-exception/error boundary that shows a friendly
   screen instead of a blank WebView.
10. **Close the roadmap** — explain the work in plain language, prove the
    verification (test counts, build output, artifact names), wait for explicit
    confirmation before merging, then mark Phase 4 (and the 4-phase project)
    completed in this document.

---

## Phase 4 Reference (Implemented) — Mobile & Tablet Application (Android/iOS)

The phone/tablet app is the **same `public/` bundle** as the web and desktop
builds, wrapped by Capacitor. No screen, no offline rule and no API path is
reimplemented: everything below is a *shell* around Phase 1–3.

### 1. `mobile/` — a self-contained Capacitor workspace

| Path | What it is |
|---|---|
| `mobile/package.json` | `@capacitor/core|cli|android|ios|app|network` as **devDependencies of `mobile/`**; the root install and root `npm test` are untouched |
| `mobile/capacitor.config.ts` | appId `app.edusphere.mobile`, androidScheme `http`, iosScheme `capacitor`, hostname `localhost`, `allowNavigation: []`, `allowMixedContent: false` |
| `mobile/scripts/sync-web.js` | mirrors `desktop/scripts/stage.js`: copies `public/` into `android/app/src/main/assets/public` and `ios/App/App/public` |
| `mobile/scripts/{add-platforms,build-android,build-ios}.js` | one-command platform build; signing comes from `EDUSPHERE_KEYSTORE_*` env vars, with a documented debug-key fallback |
| `mobile/scripts/verify-native.js` | 20 static native checks (`npm run verify`), used by CI and by `mobile/test` |
| `mobile/android/` | committed Gradle 8.11.1 / AGP 8.7.2 project (Java 21, minSdk 23, target 35) with the Kotlin-free plugin, `SqliteStore.java`, `SecureTokenStore.java`, `MainActivity.java` |
| `mobile/ios/App/` | committed Xcode project sources (`Info.plist`, `AppDelegate.swift`, `SecureTokenStore.swift`, `SqliteStore.swift`, `EduSphereNativePlugin.swift`) |

`mobile/node_modules`, staged `public/` copies, Gradle `build/`, `Pods/` and any
keystore/profile are git-ignored; no Gradle wrapper JAR and no `.pbxproj` are
committed (both are generated, and both are `mobile/test` assertions).

### 2. The same frozen native contract

`public/js/native-bridge.js` publishes the **identical** surface the Electron
preload does:

```js
isNative, appVersion, platform, deviceId, deviceName, mode,
getDeviceToken(), setDeviceToken(t), clearDeviceToken(),
print(options), savePdf(options), openExternal(url)
```

The object is `Object.freeze`d and the descriptor set is frozen by
`mobile/test/bridge-contract.test.js`, so a future edit that would silently
break `api.js` fails both shells at once. `api.js` therefore needed **zero**
mobile-specific code: the Bearer token, `issueDeviceToken`, the `401 → clear the
OS token` behaviour and the "no CSRF handshake on native" rule are the Phase 1
paths, verified through the real `api.js` in `mobile/test/api-native.test.js`.

**`public/js/native-boot.js`** decides which shell is running. In a browser it
writes nothing (the web app downloads not one byte of native code); inside
Capacitor it writes `native-bridge.js`, `mobile-storage.js` and `mobile-shell.js`
synchronously, in order, before `api.js` — so the contract exists before the
first API call and the CSP (`script-src 'self'`) is respected.

### 3. Native storage durability

`public/js/mobile-storage.js` implements the Phase 2 backend contract over
`node:sqlite`-equivalent native SQLite (`SQLiteOpenHelper` on Android,
`sqlite3` in Application Support on iOS, WAL + `synchronous=NORMAL`), with the
tables `collections, meta, outbox, id_map, snapshots, kv` and the same
`m<madrasaId>|u<userId>` scope key. `offline-db.js` picks it automatically
(`window.MobileStorage.available()`), falls back to IndexedDB on any driver
failure, and migrates an existing IndexedDB queue **once**
(`migrateFromIndexedDB`, `{migrated:false, reason:"already-migrated"}` on a
re-run). Because the store is app-private and every statement commits, the
pending queue survives a kill, a restart, a reboot and a cache clear — proven in
`mobile/test/storage-adapter.test.js` against **real SQLite** (`node:sqlite`),
not a mock.

### 4. Real network listener and resume

`@capacitor/network` → `MobileShell` → `SyncEngine.setOnline()` **and**
`SyncEngine.setConnectivityProbe()`, so the pill, the outbox flush and the pull
timer stop trusting a stale `navigator.onLine`. `appStateChange` (active)
triggers `syncNow()`; the browser keeps its Phase 2 `online`/`offline` events.

### 5. Camera QR attendance

`MobileShell.requestCamera()` is the single gate: permission is requested **when
the scanner opens** (rationale first), `granted` → viewfinder + torch
(`aria-pressed`, `getCapabilities().torch`), `denied-permanently` → never calls
`getUserMedia` again, offers *Open settings* and focuses the manual code box;
`prompt` → explain + manual entry. The scan itself reuses the Phase 1
`attendance.scan` mutation, so it queues offline like every other write.
`MainActivity` never requests CAMERA at launch, the manifest declares
`CAMERA` + `uses-feature camera required="false"`, and `Info.plist` carries
`NSCameraUsageDescription`; the `jsQR` decoder is vendored and served from the
app bundle (no remote code).

### 6. Mobile/tablet UX

Safe-area insets, 44/48 px touch targets, hardware back → modal/drawer/scanner →
history → exit, no rubber-band scrolling behind an overlay, keyboard-aware
layout, and a two-column tablet register that **moves** rows (never clones them)
so delegated handlers keep working. `public/css/mobile-native.css` holds the
styling; `mobile/test/network-listener.test.js` drives the DOM behaviour.

### 7. Release workflow

`docs/ci/mobile-release.yml` (also installed at
`.github/workflows/mobile-release.yml` where the token has `workflows`
permission): `test` → `android` (`EduSphere-<version>-android-debug.apk`, plus
`-android-release.apk` and `-android-release.aab` when a keystore is present) →
`ios` on `macos-latest` (`xcodebuild archive` + `-exportArchive` →
`EduSphere-<version>-ios.ipa`, secret-gated by `EDUSPHERE_IOS_BUILD` /
`APPLE_TEAM_ID`, unsigned archive otherwise) → `release` attaching every
artifact on a `v*` tag. Artifacts upload on every push to `main`.

### 8. Verification (this branch)

| Suite | Result |
|---|---|
| `cd mobile && npm test` | **94 tests, 94 pass** (bridge contract 14, storage adapter 7, network listener 13, camera 11, api-native 8, packaging 17, secure token 11, security 13) |
| `cd mobile && npm run verify` | **20/20 native checks** |
| root `npm test` | 885 tests, 883 pass — both remaining failures reproduce on the untouched `e0a2e8e` worktree (`unified-login-ui` fee-payment copy; one jsdom timing race), so Phase 4 adds no root failure |
| `test/card-scanner-csrf.test.js` | still green: every mutating call still goes through `window.API` |
| `test/registration-administrator-page.test.js` | 12/12 (the native payload is no longer fetched by browsers) |

### 9. Security posture (asserted, not promised)

No plaintext token (Keystore/Keychain only, `ThisDeviceOnly`,
`allowBackup="false"`); a stale browser-era token is deleted; camera only from
the scanner; https or private-LAN-http server allow-list; `edusphere:` deep-link
allow-list; `openExternal` scheme allow-list; no `eval`, `new Function` or
remote asset; and a WebView error boundary (uncaught error, rejected promise, or
a shell that never paints) that shows a friendly recovery screen instead of a
white rectangle.

### 10. What an operator sees

Install from **Play Console** (Android) or **TestFlight** (iOS), scan or type the
school address (cloud URL or the **LAN hub** address on the school Wi-Fi), sign
in once, then work with or without a connection. `docs/MOBILE-APP.md` is the
plain-language manual for that journey.
