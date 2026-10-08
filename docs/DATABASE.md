# Database

This platform uses a **brand-new database**. It does not open, reference, or
migrate the old production database (the old database identity is
inventoried and delisted in `ISOLATION-AUDIT.md`). The old database is never
contacted by this codebase.

## Two drivers, one code path

`server/db.js` exposes a single query API over two interchangeable drivers:

| Driver | When | Connection source |
| ------ | ---- | ----------------- |
| `sqlite` (Node built-in `node:sqlite`) | development | file path `DATABASE_FILE` (default `DATA_DIR/madrasa_platform.sqlite`, the **same for every `NODE_ENV`**) |
| `mysql` (`mysql2`) | production | `DATABASE_URL` or `DB_HOST/DB_USER/DB_PASSWORD/DB_NAME` |

The driver is selected by `DATABASE_DRIVER`. The app **only ever opens the
database configured here**. There is no code path that reaches the old
database.

## Choosing a NEW production database

1. **Create a new, empty MySQL/MariaDB database** with a name that is
   *not* the old one (e.g. `madrasa_platform_prod`), and a **new** dedicated
   user with a strong password.
2. Point the app at it:

   ```
   DATABASE_DRIVER=mysql
   DATABASE_URL=mysql://NEW_USER:NEW_PASSWORD@NEW_HOST:3306/NEW_DB_NAME
   ```

   Do **not** reuse any host, user, password, or database name from the old
   system.

## Migrations

Migrations live in `server/migrate.js` and are **idempotent** — they run on
every boot (`server/index.js` calls them before serving) and only create what
is missing. They are written to be safe on both SQLite and MySQL (dialect is
branched where the two differ, e.g. `ON CONFLICT` vs `ON DUPLICATE KEY`).

Current schema (tenant = `madrasa_id` on every madrasa-owned row):

- `plans`, `madaris`, `madrasa_subscriptions`
- `users`, `parent_links`
- `academic_sessions`, `terms`
- `classes`, `subjects`, `class_subjects`, `teacher_assignments`
- `students`, `results`
- `attendance`, `fee_items`, `fee_payments`
- `salary_structures`, `pay_periods`, `pay_slips`, `salary_advances` (payroll)
- `leave_types`, `leave_requests`, `leave_balances` (staff leave — approved
  leave is also written into `teacher_attendance` as `on_leave`, and
  `leave_balances` is a maintained summary recomputed from the requests)
- `announcements`, `grading_config`, `settings`, `platform_settings`
- `student_health`, `health_visits`, `vaccinations` (student health & medical
  module — one medical profile per student, soft-deleted sick-bay visit log,
  vaccination records with next-due dates)
- `ptm_sessions`, `ptm_teacher_slots`, `ptm_bookings` (parent-teacher meeting
  booking — one meeting day per `ptm_sessions` row, one participation/opt-out
  row per teacher, one row per confirmed booking. The **slot grid is derived**
  at read time from `session_start` / `session_end` / `slot_duration_mins` and
  is deliberately not stored, so editing the times can never orphan a slot
  row; `slot_number` + `slot_time` on a booking are the stored coordinates and
  `slot_time` is rewritten when the window moves. On SQLite two partial unique
  indexes (`WHERE status <> 'cancelled'`) enforce "one booking per teacher per
  slot" and "one booking per parent per slot"; on MySQL the same two rules are
  enforced by the guarded transaction in `server/routes/ptm.js`, because MySQL
  has no partial indexes.)
- `activity_log`

Every madrasa-owned record carries `madrasa_id`; all tenant-scoped queries
filter on it, and the tenant middleware (see `SECURITY.md`) guarantees the
`madrasa_id` used is the caller's own.

## Development database

Zero-config: `npm run dev` creates the SQLite file automatically. To reset a
clean dev database, delete the file and re-run (the server re-migrates and
re-seeds the super-admin on boot):

```bash
rm -f data/madrasa_platform.sqlite*   # and any *_dev/_prod leftovers, see PERSISTENCE.md §1.1
npm run dev
```

Seed the demo madaris (2 madaris, users, classes, results):

```bash
npm run seed -- --demo
```

## Connection pool sizing (MySQL)

Thousands of HTTP users are served by a **small pool of reusable connections**:
one Node process must never open one MySQL connection per user. The pool knobs
(all optional, defaults in parentheses):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MYSQL_POOL_SIZE` | 10 | Max connections this process may hold. |
| `MYSQL_QUEUE_LIMIT` | 0 | Requests waiting for a free connection. `0` = wait forever (requests slow down under pressure instead of failing); a positive value fails excess requests fast with a clear error. |
| `MYSQL_CONNECT_TIMEOUT_MS` | 10000 | Giving up on establishing a *new* connection. |
| `MYSQL_MAX_IDLE` | = `MYSQL_POOL_SIZE` | Idle connections are closed and re-opened on demand, so quiet periods do not pin MySQL threads. |
| `MYSQL_IDLE_TIMEOUT_MS` | 60000 | How long an idle connection is kept before closing. |

**Sizing rule:** keep the total across all Node processes ≤ 70–80 % of MySQL's
`max_connections`, leaving headroom for ops tooling and burst traffic. One
process with the default 10 easily serves hundreds of concurrent users because
queries are short (single-digit milliseconds); the pool — not the database — is
the multiplier that decides how many instances you can run.

Current pool utilisation is visible at `/api/perf` (super admin, with
`PERF_MONITOR=1`): `configuredLimit`, `activeConnections`, `idleConnections`
and `queuedRequests` tell you whether the pool is the bottleneck.

## TLS (encrypting the MySQL connection)

The app encrypts the connection to MySQL only when `DB_SSL=true` is set.
The `ssl-mode` parameter in `DATABASE_URL` does not turn TLS on:

* mysql2 has no `ssl-mode` option. Earlier releases passed the parameter to the
  driver, which printed `Ignoring invalid configuration option … ssl-mode` at
  every boot. The app now removes `ssl-mode` (and `sslmode`) from the URL before
  the driver sees it.
* The requested mode is reported, not applied, so the connection behaves exactly
  as before. When the URL asks for a mode other than `DISABLED` and `DB_SSL` is
  off, boot prints `Database: DATABASE_URL asks for ssl-mode=…` and says that the
  connection is `NOT encrypted`.

To encrypt the connection, set `DB_SSL=true` and redeploy. TLS is then used
without certificate verification, which gives the same guarantee as MySQL's
`REQUIRED` mode. It is not switched on by default, because a server that does
not offer TLS would refuse the app at boot. Confirm that your server accepts TLS
before you turn it on.

## Safety rules

- **Never** copy the old `.env` or old connection string into this project.
- **Never** run a migration or DDL against the old database.
- The dev SQLite file and any real `.env` are git-ignored and never committed.

## Where the file lives (and why that matters)

The SQLite path is `DB_CONFIG.file`: `DATABASE_FILE` when you set it, otherwise
`DATA_DIR/madrasa_platform.sqlite` — one name for every environment, so no boot can
silently invent a second, empty database. `DATA_DIR` is the single knob for a
host with a mounted volume:

```bash
DATA_DIR=/var/data            # database + uploads + backups all follow it
PERSISTENT_VOLUME_DIR=/var/data   # what the boot probe checks
```

A snapshot of every table is written to `BACKUP_DIR` before each migration, on a
graceful shutdown, and every `BACKUP_INTERVAL_MINUTES`. `npm run backup --
--list` shows them; `--restore <name> --dry-run` prints what a restore would
replace without touching anything. Restore order is `TABLE_ORDER` (parents
first, children cleared first), so foreign keys hold without disabling them.
Full details, host-by-host setup and the loss-detection warnings:
[`PERSISTENCE.md`](PERSISTENCE.md).
