# EduSphere — Education Management Platform

A multi-tenant SaaS platform for managing educational institutions anywhere in
the world — students, teachers, classes, attendance, subjects, academic
sessions & terms, results with printable report cards, admissions, finance,
payroll, library and communication. Every institution also gets its own
independently branded public website, plus student, parent and teacher
portals. The global platform speaks international English; each school may
keep its own Arabic/bilingual identity on its own public website.

> **Independence statement:** this project is a fresh codebase. It contains
> **no** reference to the old single-school result system — no old database,
> credentials, domains, hosting projects, keys, or identities. The old
> production system is untouched and this platform never connects to it.
> See [`docs/ISOLATION-AUDIT.md`](docs/ISOLATION-AUDIT.md) for the full audit
> trail and [`docs/SECURITY.md`](docs/SECURITY.md) for the security audit.

---

## Quick start (development)

Requirements: **Node.js >=22.22.3 and <23** (the Render runtime is pinned to
22.22.3; uses the built-in `node:sqlite` for the dev database — no external DB
server needed).

```bash
npm install
npm run dev        # migrate + serve on http://localhost:3000
```

First run creates the dev SQLite database (`data/madrasa_platform.sqlite`)
and one super-admin account.

**The first boot always prints how to sign in.** If `SUPER_ADMIN_PASSWORD` is
not set (the normal state of a fresh clone), the seed generates a password
rather than skipping account creation, and prints it as a banner:

```
──────────────────────────────────────────────────────────────
  SUPER_ADMIN_PASSWORD was not set, so a development super
  admin was created with a generated password:
      username: admin
      password: Dev-xxxxxxxxxxxx!
  (also written to .dev-credentials.txt — git-ignored)
──────────────────────────────────────────────────────────────
```

Set `SUPER_ADMIN_PASSWORD` in `.env` before the first boot to choose your own.
Usernames are **case-insensitive** (`Admin` and `admin` are the same account).

```bash
npm run seed -- --demo   # optional: add 2 demo madaris with users, classes, results,
                         #            timetables, published results and public-site flags
npm test                 # automated suite (isolated temp database, 597 tests —
                         # includes browser-level checks that drive the public site,
                         # the admin console and the three portals in jsdom)
bash test/smoke.sh       # end-to-end checks against a running dev server (70 checks)
```

### "I type my username and password and nothing happens"

Almost always one of these — the sign-in form now names each one on screen
instead of failing silently:

| What the form says | What it means | Fix |
| ------------------ | ------------- | --- |
| *This platform has no accounts yet…* | The database is empty — the super admin was never created (e.g. `SUPER_ADMIN_PASSWORD` was unset on a host that skipped seeding, or the data directory was wiped). | `npm run reset-admin-password` with `SUPER_ADMIN_PASSWORD` set |
| *Invalid username or password.* | The account exists; the credentials are wrong. | `npm run reset-admin-password` to set a known password |
| *Opening your workspace…* | Correct password for a teacher/student/parent account — the platform is handing the session to that account's own workspace. | Nothing: the browser continues to `/teacher`, `/student` or `/parent` automatically |
| *Too many sign-in attempts…* | Rate limit (`LOGIN_RATE_LIMIT`, default 10 per 15 min). | Wait, or raise the limit |

### Demo logins (after `npm run seed -- --demo`)

Every one of these signs in at the **same** `/login` page and is routed to its
own workspace by the server. The usernames below are exactly what
`server/seed.js --demo` creates — nothing is invented here.

| Role | Username | Password | Lands on |
| ---- | -------- | -------- | -------- |
| Super Admin | `admin` (or `SUPER_ADMIN_USERNAME`) | `SUPER_ADMIN_PASSWORD`, else the generated one in `.dev-credentials.txt` (local only, git-ignored) | `/admin` |
| Madrasa Admin (Quraniyya) | `demo-quraniyya-admin` | `Demo1234!` | `/admin` |
| Madrasa Admin (Fatihah) | `demo-fatihah-admin` | `Demo1234!` | `/admin` |
| Teacher (Quraniyya) | `demo-quraniyya-ust1` | `Demo1234!` | `/teacher` |
| Teacher (Fatihah) | `demo-fatihah-ust1` | `Demo1234!` | `/teacher` |
| Student (Quraniyya) | `demo-quraniyya-stu1`, `demo-quraniyya-stu2` | `Student1234!` | `/student` |
| Student (Fatihah) | `demo-fatihah-stu1`, `demo-fatihah-stu2` | `Student1234!` | `/student` |
| Parent (Quraniyya) | `demo-quraniyya-parent1`, `demo-quraniyya-parent2` | `Parent1234!` | `/parent` |
| Parent (Fatihah) | `demo-fatihah-parent1`, `demo-fatihah-parent2` | `Parent1234!` | `/parent` |

The seed creates **no** Accountant/HR/Receptionist demo account, because those
are not roles — create a teacher account and apply a permission template (see
*Account creation & login guide* below).

Teachers sign in at **`/teacher`**, students at **`/student`** and parents at
**`/parent`** — or simply use the main sign-in (`/login`), which hands every
account to its own workspace automatically.

(Each demo madrasa seeds two parent and two student logins; each parent is
linked to their own child. The multi-child parent case is supported by the
parent-account API's `student_ids` array — see the account guide below.)

Demo data is generated **relative to the date you run the seed** — the academic
session spans the current September→August year, attendance covers the last 20
weekdays, and fee payments are spread over the last few months. The dashboards
and analytics windows are therefore always populated, whenever you seed.

---

## Roles & permissions (enforced on the backend)

**One unified sign-in** lives at **`/login`** (the `Login` link on every
public page) — for **every account type**. The form asks for an email or
username and a password (plus optional *Remember me*); it never asks which
kind of account is signing in. The **server** authenticates the credentials,
determines the real role and the institution, and the page hands the session
to the right workspace automatically: Super Admin and Institution Admin →
their dashboards, Teacher → `/teacher`, Student → `/student`, Parent →
`/parent`. A role can never be chosen or forged from the browser — it comes
from the database via the server-side session, exactly like the tenant.
The form **always asks for credentials** — a still-valid session never opens
a console on its own; it only adds a *"you are already signed in as …"*
notice with an explicit **Continue** action. **`/admin`** is the admin
section's own address (it falls back to the sign-in page when the visitor is
not authenticated), and Islamic School, Western Academy and platform
administrators all use the same form. If a session ends server-side while a
dashboard is open, the next request bounces the tab back to the sign-in page
instead of painting a console whose every call fails.

**Self-service password recovery**: *Forgot password?* on the sign-in accepts
an email or username and always answers the same way (it never reveals
whether an account exists). A single-use, time-limited reset link
(`PASSWORD_RESET_EXPIRY_MINUTES`, default 60 minutes) is emailed when an
email provider is configured **and** always appears to the institution's
administrators (`Account & Security → Password reset requests`) so a school
without email can hand the link over. Completing a reset invalidates every
existing session of the account, and old tokens die immediately.

| Role | Access |
| ---- | ------ |
| **SUPER ADMIN** | All madaris: create/suspend, plans (FREE / BASIC / PREMIUM with student & teacher limits and feature flags), platform stats **and platform-wide analytics**, activity log, platform settings. |
| **MADRASA ADMIN** | Everything *within their own madrasa*: students, teachers, classes, subjects (Arabic + English names — not hard-coded), sessions, terms, results, attendance, fees, announcements, **analytics dashboards**, school profile/logo/settings, grading config (CA max, exam max, pass mark, grade bands, promotion rules). |
| **TEACHER** | Only classes/subjects assigned to them: view those rosters, enter/save results and attendance for them. |
| **STUDENT** | Own profile, own results (all terms), own printable report card, announcements. |
| **PARENT** | Linked children only: profiles, results, report cards, announcements. |

Tenant isolation is enforced by server-side middleware on every route: each
request is scoped to `req.user.madrasa_id`, and every tenant-owned query
filters by it. A Madrasa A account can never reach Madrasa B data via URL,
ID, query parameter, or forged form fields — verified by automated tests
(see `docs/SECURITY.md`).

---

## Account creation & login guide (all five account types)

### There is ONE login page

Everybody — platform operator, institution administrator, teacher, student and
parent — signs in at **`/login`**.

- There is **no role-selection screen**. The form only asks for a username (or
  email) and a password.
- The **server** authenticates the credentials, reads the real role from the
  database, and the page routes the visitor automatically:

| Role | Lands on |
| ---- | -------- |
| `SUPER_ADMIN` | `/admin` (platform console) |
| `MADRASA_ADMIN` | `/admin` (institution dashboard) |
| `TEACHER` | `/teacher` |
| `STUDENT` | `/student` |
| `PARENT` | `/parent` |

A role can never be chosen, typed or forged from the browser. `/teacher`,
`/student` and `/parent` are simply the workspaces' own addresses; they fall
back to the same sign-in form when the visitor has no session.

### 1. SUPER_ADMIN — seeded automatically

Created on the **first boot of an empty database** by `server/seed.js` (also
run by `npm run seed`). It is the only account the platform creates for you.

| Environment variable | Meaning | Default |
| -------------------- | ------- | ------- |
| `SUPER_ADMIN_USERNAME` | The super admin's username (lower-cased; sign-in is case-insensitive) | `admin` |
| `SUPER_ADMIN_PASSWORD` | Its password. **Required in production** — the boot refuses to start without it rather than come up unreachable. | none |

Outside production, if `SUPER_ADMIN_PASSWORD` is unset the seed **generates**
a password, prints it as a banner and writes it to `.dev-credentials.txt`
(git-ignored). Existing super admins are never overwritten; use
`npm run reset-admin-password` to set a new password on an existing database.

### 2. MADRASA_ADMIN — created by the SUPER_ADMIN

Signed in as the super admin: **Platform Console → Madaris / Registrations**.
Approving a school registration (or creating a madrasa directly) creates the
institution together with its administrator account
(`server/routes/platform.js`). There is no second institution-admin flow.

### 3. TEACHER — created by the institution admin

**Admin Dashboard → Teachers → Add Teacher** (`POST /api/teachers`).

- Supply a username; the temporary password is optional — if you leave it out
  the API generates one and returns it once as `tempPassword`. Hand it to the
  teacher and ask them to change it from their account page.
- A teacher can also be created by approving a **teacher application**
  (Teachers → Teacher Applications → *Approve & create teacher*).

### 4. STUDENT — created by the institution admin

**Admin → Students → open a student profile → "Portal access" tab.**

- The tab shows the current state: *No login yet*, or the existing username
  with its active/inactive status.
- Fill in a **username** (lower-case letters, digits, `.`, `-` or `_`, at
  least 3 characters) and a **password** (at least 8 characters), then press
  *Create student login* — or *Reset student login* if one already exists, which
  replaces the username/password on the **same** account rather than making a
  second one.
- Alternatively, tick **Create student login** while converting an admission
  applicant (see below).

The tab is only offered to the institution's administrator, and the endpoint
behind it (`POST /api/students/:id/portal-account`) enforces the same rule
server-side, scoped to the administrator's own institution.

### 5. PARENT — created by the institution admin

Same place: **Student profile → "Portal access" tab → Create a parent login**.

- Fields: username, password, display name and phone (the last two fall back
  to the guardian details already on the student record).
- The new account is linked to the child immediately, and the tab lists every
  parent login attached to the student together with **all** of that parent's
  linked children.
- One parent account can cover **several children** — the API accepts a
  `student_ids` array (`POST /api/students/:id/parent-account`).
- A parent login can also be created during admission conversion.

### Creating accounts during admission conversion

**Admin → Admissions → Applications → open an accepted application → CONVERT
TO STUDENT.** The conversion dialog offers:

- ☐ **Create student login** — username defaults to the admission number
- ☐ **Create parent login** — username defaults to the admission number + `-p`
- one shared **password** (minimum 8 characters) used for whichever boxes are ticked

Both are optional; the student *record* is always created. After a successful
conversion the confirmation names the accounts that were created, e.g.
*"Student account created: adm-2026-0007 · Parent account created:
adm-2026-0007-p"*. Passwords are never echoed back, logged or stored in plain
text.

### Staff accounts: Accountant, HR Officer, Receptionist, Librarian, …

**These are not separate login roles.** The platform has exactly five account
roles. An Accountant, HR Officer, Librarian, Receptionist, Admissions Officer
or Academic Officer is a **TEACHER account with a permission template
applied**:

1. **Admin → Teachers → Add Teacher** — create the staff member's account as
   normal.
2. **Admin → Settings → Roles & Permissions** — find the account.
3. **Apply the matching permission template** (Accountant, Librarian,
   Admissions Officer, Academic Officer, HR Officer, Receptionist). The
   template grants exactly that role's permissions and revokes the teacher
   defaults it does not include, so e.g. a Librarian cannot grade or export
   students. You can fine-tune individual permissions afterwards on the same
   screen.
4. The person signs in at **`/login`** like everyone else, with a **TEACHER**
   account, and lands on the teacher workspace.
5. **Their permissions decide what they see** — an Accountant sees fees,
   payments and expenses; a Receptionist sees the front-desk and admissions
   intake screens; and so on.

Applying a template requires the `roles.manage` permission, only works on
teacher-role accounts, and is written to the audit log.

## Project structure

```
server/            Express API (Node 22, no framework magic)
  config.js        env parsing + production validation (fails fast on bad config)
  db.js            node:sqlite (dev) / mysql2 (production) — same query API
  migrate.js       idempotent migrations (run automatically on boot)
  seed.js          super-admin bootstrap + --demo data
  middleware/      auth (sessions), tenant scoping, uploads, rate limiting
  routes/          auth, platform, madrasa, students, teachers, classes/
                   subjects/sessions/grading, results, attendance, fees,
                   announcements, portal, public (logged-out site),
                   admissions, timetable, payroll, leave (staff leave),
                   ptm (parent-teacher meeting booking), exports, backups
  services/        grading engine (configurable per madrasa), admissions,
                   analytics (dashboard aggregates, tenant- and platform-wide),
                   persistence (storage probe), backup (snapshot/restore),
                   csv (Excel-safe exports), tokens (short-lived public links)
  backup.js        `npm run backup` — snapshot / --list / --restore / --import
public/            static mobile-first SPA (hash routing, EN/AR, RTL,
                   light/dark theme, public site rendered without a session)
test/              npm test suite + smoke.sh end-to-end
docs/              isolation audit, database, deployment, security docs
render.yaml        NEW Render service definition (production)
```

## Key features (as delivered)

- **Results engine, fully configurable per madrasa** — CA structure & max,
  exam max, pass mark, grade boundaries, remarks, competition positions,
  promotion rules (minimum average and/or required pass). Term results,
  class-wide computation, per-student summaries.
- **Professional printable report cards** — madrasa logo/name/motto/address,
  student photo/name/admission number/class/session/term, per-subject scores,
  totals, average, grade, remarks, position, attendance, teacher & admin
  comments, promotion status. Arabic + RTL when Arabic names are present.
- **Teacher workspace (`/teacher`)** — today's classes from the timetable,
  pending attendance and grading queues, result workflow counters, assigned
  classes with rosters, lesson plans, assignments with submissions and
  grading, examinations with marks entry, **online examinations with their
  question manager, attempt queue, subjective-answer grading and results
  release**, the results gradebook (draft → submit for review), leave
  self-service, library self-service, messages, notifications and the shared
  calendar — all scoped server-side to the teacher's own assignments.
- **Student portal (`/student`)** — dashboard (timetable today, attendance,
  pending assignments, upcoming exams, fee balance), weekly timetable,
  lessons, assignments with submission AND resubmission (until graded),
  feedback and scores, exam timetable, **online examinations: the list of
  takeable/finished papers, a timed runner with question navigator, autosave,
  submit-with-confirmation, and the marked-paper review once results are
  released**, results with printable report cards,
  attendance history, fee statement with receipts, library loans, Qur'an
  progress (Islamic institutions only), messages with teachers/admins,
  notification centre, announcements and account self-service.
- **Parent portal (`/parent`)** — family dashboard with every linked child,
  a child switcher on every child-scoped page (attendance, results, report
  cards, assignments, timetable, exams — including each child's online
  examination attempts and scores — fees, Qur'an progress), **online fee
  payment** (`Fees → Pay online`: outstanding per fee item, provider
  checkout, live status and receipts — a payment is only recorded as
  successful when the provider's webhook/callback verifies it, never because
  the page says so), the complete Parent-Teacher Meeting booking flow
  (`/parent/meetings`, double-booking prevented server-side), messages with
  the children's teachers, and notifications. Child relationships are
  validated by the server on every request — a child id from the browser is
  never trusted.
- **Academic calendar & school events** — holidays, exam weeks, PTM dates,
  admission deadlines and activities with audience targeting (everyone, staff,
  students & parents, parents only, or specific classes), shown on every
  portal dashboard and manageable from `Academic → Calendar & Events`.
- **Platform support tickets** — institutions raise tickets with the platform
  team (`Platform Support` in the admin sidebar); the super admin works a
  platform-wide queue with status/priority/assignment, public replies and
  internal notes the institution can never see. Every action audited.
- **Question bank** — reusable questions per subject, class level, type,
  difficulty and marks, complementing the examinations module.
- **Staff role templates** — Accountant, Librarian, Admissions Officer,
  Academic Officer, HR Officer and Receptionist bundles applied to STAFF
  accounts through the existing granular permission system (no new roles);
  fine-tune afterwards in Roles & Permissions.
- **Admission numbers** — per-madrasa prefix (from settings or slug),
  sequential 4-digit suffix.
- **Photos & logo uploads** — validated file types/size, stored under
  `uploads/` (outside the API surface).
- **Arabic + English everywhere** — UI language toggle, per-record Arabic
  names, RTL layout for Arabic.
- **Public site, before login** — a landing page with live totals, a searchable
  madrasa directory, and per-school public pages (profile, notices, result
  checking, online admission form) at `#/madrasa`, `#/madrasa/<slug>`,
  `#/results-check`, `#/apply/<slug>`. Every section is switched on by the
  school itself (`public_listing` / `public_results` / `public_admissions`) and
  a platform-wide kill switch; results only ever come from *published* term
  summaries, printable cards use a 15-minute signed link, applications are
  rate-limited, honeypotted and de-duplicated. No session is created for
  anonymous visitors.
- **Timetables** — weekly grid per class (Mon–Sat × periods, subject/teacher/
  room), replace-all save inside a transaction, copy one class's week onto
  others, a standalone printable sheet, and a `My week` view for students,
  parents and teachers.
- **Admission queue** — public applications arrive in `Admissions` for review
  (approve / hold / reject, with a note); approving creates the student record
  with the next admission number and, optionally, the pupil's and guardian's
  portal accounts. Applicants track their own request with a reference number
  plus the phone they gave.
- **ID cards, certificates and a real printer output** — every card carries a
  durable `/verify/<code>` QR that any phone camera reads (decoded by an
  independent QR decoder in the test suite), prints the same code in text under
  it, and can be revoked in one step. `Attendance → Scan & Mark` turns a scan
  into a register entry: one read at the gate verifies the learner AND marks
  them present (or late/excused/absent) in the school's own calendar day, staff
  cards check a member of staff in at the school's clock, and a cancelled card
  marks nothing. Print buttons across the dashboard print the document, not the
  application: `public/css/print.css` + `public/js/print-page.js` hide the
  sidebar, header and filters, print a real heading (school, title, date), name
  the PDF and can print a generated report or an open dialog on its own. Every
  server-rendered print page (cards, certificates, report sheets, payslips,
  fee receipts, timetables) loads `/js/print.js` instead of an inline script,
  which the platform CSP would silently drop. See
  [`docs/ID-CARDS-AND-CERTIFICATES.md`](docs/ID-CARDS-AND-CERTIFICATES.md).
- **CSV exports** — students, results, term summary, attendance, fees and the
  admission queue, as UTF-8 BOM + CRLF files Excel opens correctly, with
  formula-injection guards on every cell.
- **Backups, snapshots and storage diagnostics** — the platform writes a JSON
  snapshot of every table before each migration, on shutdown and on a timer,
  and tells the operator in plain words when the host's filesystem is
  throwaway (the reason records used to disappear). `Platform → Backups &
  storage`, `npm run backup`, [`docs/PERSISTENCE.md`](docs/PERSISTENCE.md).
- **Dark mode** — light/dark themes from CSS custom properties, chosen
  automatically from the operating system and remembered per browser.
- **Analytics dashboards** — enrolment trends, students per class, gender and
  age distribution, daily attendance rate, fee collection trends and method
  mix, grade distribution, per-class and per-term averages, and a "needs
  attention" watch list (below pass mark and/or low attendance). Selectable
  6/12/24-month and 14/30/60/90-day windows. Charts are hand-built inline SVG
  in `public/js/charts.js` — no chart library, because the app's
  `script-src 'self'` CSP forbids one. Aggregates are read-only over the
  existing schema (no new tables, no migration) and every query is filtered by
  `madrasa_id`. A separate platform-wide view for the super admin covers tenant
  growth, plan mix, largest madaris and activity volume.

- **Per-school share links** — every registered madrasa gets its own link
  (`/s/<slug>`, with `/school/<slug>` and `/m/<slug>` aliases) that opens
  that school's own public page directly instead of the platform landing.
  The link is shown with a copy button on the school's public page and in
  `School Settings`, and on the super-admin's madrasa detail screen.
- **Complete administrator workspaces** — every tenant-admin sidebar item
  opens a working, tenant-scoped screen rather than a placeholder: institution
  profile/contact/appearance/page copy/gallery, student profiles/groups/portal
  accounts, teacher recruitment and teaching assignments, class rosters and
  timetables, staff and student attendance, lessons and assignments, grade
  bands, score entry, calculated/published report cards, sessions and terms,
  admission review/settings, announcements/messages/parent communication,
  fee items/payments/balances/reports, account security and saved notification
  preferences. Every counter and chart comes from current tenant data.
- **Parent-teacher meetings** — the administrator schedules a meeting day
  (`Communication → PTM Sessions`) with a start time, an end time and a slot
  length; the time-slot grid is generated from those three numbers and every
  active teacher is enrolled as available, each free to opt out until someone
  books them. A parent signs in at `/parent/meetings`, picks a child, picks one
  of *that child's* teachers, picks a free slot and gets an immediate
  confirmation with the date, time and location — while both they and the
  teacher receive an in-app notification (and email/SMS where the recipient's
  delivery preferences and a provider are configured). Double-booking is
  refused three ways: a teacher cannot be in two places at once, a parent
  cannot be in two places at once, and the same parent/teacher/child meeting
  cannot be made twice. The administrator sees the whole day as a grid
  (teachers as columns, slots as rows, booked cells naming the parent and the
  student), can cancel from it, print it, or export it as CSV. Identical for
  an Islamic school and a Western academy — only the wording differs.
- **Live institution share pages** — `/s/<slug>` renders each institution’s
  real public profile, public announcements, subject/classes information,
  admission form and status checker, and published-result verification. Public
  page copy saved by the administrator is allow-listed before it is exposed;
  operational settings are never sent to visitors.

## Future SaaS roadmap (designed for, NOT built)

Subscriptions, provider-backed SMS/WhatsApp/email delivery, certificates,
ID cards and a native mobile app. (Timetables, online admissions,
assignments, public result checking, payroll, staff leave, parent-teacher
meeting booking, **online examinations** and **parent online fee payment**
are now built.) The schema and routes are shaped so the rest can be added
without re-architecture — the payment gateway (Paystack or Flutterwave) is
configured through the environment and is optional per deployment.
