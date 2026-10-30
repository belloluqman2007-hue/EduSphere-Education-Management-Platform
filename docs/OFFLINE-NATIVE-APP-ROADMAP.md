# EduSphere Native Software & Offline-First Sync Architecture

This document defines the 4-phase engineering roadmap transforming EduSphere from a browser-only web platform into **real installable native software applications** for **PC (Windows, macOS, Linux)** and **Phones & Tablets (Android, iOS/iPadOS)** with **local-first offline operation and automatic background synchronization**.

---

## Phase Overview

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | **App-Ready Backend, Device Bearer Auth & Offline Sync API** (`/api/sync`, `device_auth_tokens`, `sync_mutations`, native CORS/CSP, `api.js` transport interceptor) | **Completed** |
| **Phase 2** | **Frontend Local-First Storage, Outbox Engine & Sync UI** (IndexedDB/SQLite store, offline read/write interception via `API.setTransportInterceptor`, optimistic local IDs, Offline Unlock, Sync Status Bar & Queue Drawer) | Next |
| **Phase 3** | **Desktop Software Application (PC)** (Electron + `electron-builder` installers `.exe` / `.dmg` / `.AppImage` / `.deb`, embedded local Node+SQLite server / LAN School Hub mode + Cloud Sync) | Planned |
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

## Phase 2 Specification (Next Session)
1. **`public/js/offline-db.js`** — IndexedDB wrapper (`edusphere_offline_v1`, scoped per `madrasaId + userId`) storing:
   - `meta` (`lastPullCursor`, cached `user`/`madrasa`/`subscription`/`permissions` snapshot, offline PIN/credential verifier for offline app unlock)
   - Synced entity stores matching `/api/sync/pull` collections (`students`, `classes`, `class_arms`, `subjects`, `academic_sessions`, `terms`, `grading_scales`, `attendance`, `staff_attendance`, `results`, `quran_progress`, `fee_items`, `fee_assignments`, `fee_payments`, `announcements`, `homework`, `timetable_entries`, `card_credentials`)
   - `outbox` store (`clientMutationId`, `type`, `localId`, `payload`, `createdAt`, `status`: `pending` | `syncing` | `conflict` | `rejected`, `error`, `serverRecord`)
   - `id_map` store (`localId -> serverId`)
2. **`public/js/sync-engine.js`** — Registers `API.setTransportInterceptor(...)`:
   - Online: passes through to `onlineRequest()`, caches read payloads & pulls deltas periodically, flushes `outbox` automatically via `API.sync.push(...)` and reconciles `idMap`.
   - Offline (network failure or `navigator.onLine === false`): serves `GET` endpoints from `offline-db.js` (computing filtered lists/summaries for dashboard, students, attendance, results, Hifz, fees, announcements, QR card verify, and student portal) and records supported `POST`/`PUT` writes into `outbox` with optimistic `local:<uuid>` records so the UI updates immediately without internet!
3. **Offline Sync UI (`public/js/sync-ui.js` + CSS + `public/index.html` + `public/sw.js`):**
   - Persistent compact connectivity & sync pill in workspace topbar: `Online · Synced`, `Offline · Working Locally`, `Syncing (N)…`, `Attention Needed (N conflicts)`.
   - Clickable **Sync Queue Drawer** showing pending Outbox items, "Sync Now" button, retry/discard controls for conflicts, and "Signed-in Devices" management section (`GET/DELETE /api/auth/devices`).
   - Updated Service Worker (`public/sw.js`) pre-caching all new JS/CSS assets so cold-launching while completely offline boots the full workspace shell reliably.

## Phase 3 Specification (Session 3)
- `desktop/` Electron + `electron-builder` workspace (`main.js`, `preload.js` exposing `window.__EDUSPHERE_NATIVE__`, system tray, native print/export, auto-launch option, Windows NSIS `.exe`, macOS `.dmg`, Linux `.AppImage`/`.deb`, plus GitHub Actions cross-platform release workflow).
- Dual runtime mode selectable in Desktop Settings:
  1. **Cloud-Synced App Mode** (connects to remote EduSphere server with full Phase 2 offline local-first engine + native Bearer token).
  2. **Local Standalone / School LAN Hub Mode** (boots embedded Express + SQLite server locally on the school PC so campus phones/tablets on Wi-Fi/LAN work even when the entire town has zero internet, with optional upstream cloud sync).

## Phase 4 Specification (Session 4)
- `mobile/` Capacitor project (`capacitor.config.ts`, Android Gradle project & iOS Xcode config, build scripts + GitHub Actions Android `.apk`/`.aab` builder).
- Native bridge (`public/js/native-bridge.js`) injecting `window.__EDUSPHERE_NATIVE__`, native network status listener, persistent SQLite/IndexedDB durability, native back-button handling, safe-area insets for notches/tablets, and instant camera QR scanning for offline student/staff gate attendance.
