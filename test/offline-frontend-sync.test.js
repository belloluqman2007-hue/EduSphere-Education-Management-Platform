"use strict";
/* ============================================================================
   PHASE 2 — FRONTEND LOCAL-FIRST STORAGE, OUTBOX ENGINE & SYNC UI
   ----------------------------------------------------------------------------
   The real public/js files (api.js, offline-db.js, sync-engine.js, sync-ui.js)
   run inside jsdom against the REAL Express app, with their fetch bridged to
   the booted server and their IndexedDB supplied by fake-indexeddb. Nothing is
   stubbed at the business layer: the same /api/sync/pull and /api/sync/push the
   product talks to are the ones exercised here.

   Covered end to end:
     1. Online sign-in → initial /api/sync/pull lands in the tenant-scoped
        IndexedDB store.
     2. Going offline → cached module reads (session, students, classes,
        sessions/terms, attendance register, results roster, Hifz, fees,
        announcements, portal, QR card verification, snapshot fallback).
     3. Offline writes → optimistic `local:` records appear immediately and the
        matching mutations sit in the Outbox. The server is untouched.
     4. Reconnecting → automatic batching to /api/sync/push, `idMap`
        reconciliation into real server ids, no duplicate rows, idempotent
        replays.
     5. Conflicts (frozen results, revoked QR card) surface with Retry /
        Accept Server Version, and no duplicate rows are created.
     6. The status pill and Sync & Devices drawer (devices list + revocation).
     7. Tenant isolation when two accounts share one device.
     8. Offline cold start with the unlock verifier (and the right password).
     9. Security: no raw mutating fetch, friendly online-only messages, and a
        service-worker precache manifest that matches the shell exactly.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

let JSDOM = null;
let VirtualConsole = null;
let IDBFactory = null;
let IDBKeyRange = null;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (e) { /* production install */ }
try {
  ({ IDBFactory, IDBKeyRange } = require("fake-indexeddb"));
} catch (e) { /* production install */ }
const skip = !JSDOM || !IDBFactory ? "jsdom / fake-indexeddb devDependency not installed" : false;

const ROOT = path.join(__dirname, "..");
const PUBLIC_JS = path.join(ROOT, "public", "js");
const readScript = (name) => fs.readFileSync(path.join(PUBLIC_JS, name), "utf8");
const SRC = {
  api: readScript("api.js"),
  db: readScript("offline-db.js"),
  engine: readScript("sync-engine.js"),
  ui: readScript("sync-ui.js"),
  scanner: readScript("card-scanner.js"),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 15000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) { /* keep polling */ }
    await sleep(stepMs);
  }
  return null;
}

let ctx;
let adminA;
let adminB;

before(async () => {
  if (skip) return;
  process.env.LOGIN_RATE_LIMIT = "200";
  ctx = await setup();
  adminA = new Client(ctx.base);
  await adminA.login("admin-a", PASSWORD);
  adminB = new Client(ctx.base);
  await adminB.login("admin-b", PASSWORD);
});
after(async () => { if (ctx) await ctx.close(); });

/* --------------------------------------------------------------------------- */
/* A jsdom "browser" running the real public/js modules                         */
/* --------------------------------------------------------------------------- */

const PAGE_HTML = `<!doctype html><html lang="en"><head><title>EduSphere</title></head><body>
  <header class="dash-header">
    <div class="dash-header-title"><h1>Test Madrasa</h1></div>
    <div class="dash-header-spacer"></div>
    <div class="dash-header-user"><span class="dash-header-avatar">A</span></div>
  </header>
  <main id="app"></main>
</body></html>`;

function absorbCookies(client, response) {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const cookie of list) {
    const pair = cookie.split(";")[0];
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) delete client.cookies[key];
    else client.cookies[key] = value;
  }
}

function createPage(options = {}) {
  const opts = options || {};
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(PAGE_HTML, {
    url: `${ctx.base}/admin`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const window = dom.window;
  const factory = opts.factory || new IDBFactory();
  Object.defineProperty(window, "indexedDB", { configurable: true, value: factory });
  Object.defineProperty(window, "IDBKeyRange", { configurable: true, value: IDBKeyRange });
  try {
    Object.defineProperty(window, "crypto", { configurable: true, value: nodeCrypto.webcrypto });
  } catch (e) { /* jsdom's own crypto is enough (falls back to the labelled verifier) */ }

  let online = opts.online !== false;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });

  let client = opts.client;
  for (const [key, value] of Object.entries(opts.storage || {})) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  const calls = [];
  window.fetch = async (url, init) => {
    if (!online) throw new TypeError("Failed to fetch");
    const settings = init || {};
    const target = /^https?:/i.test(String(url)) ? String(url) : ctx.base + String(url);
    const headers = Object.assign({}, settings.headers || {});
    if (client) headers.Cookie = client.cookieHeader();
    calls.push({ url: String(url), method: String(settings.method || "GET").toUpperCase() });
    const response = await fetch(target, {
      method: settings.method || "GET",
      headers,
      body: settings.body,
      redirect: "manual",
    });
    if (client) absorbCookies(client, response);
    return response;
  };

  window.eval(SRC.api);
  window.eval(SRC.db);
  window.eval(SRC.engine);
  window.eval(SRC.ui);
  if (opts.scanner) window.eval(SRC.scanner);

  const page = {
    window,
    document: window.document,
    dom,
    calls,
    factory,
    useClient(next) { client = next; },
    get online() { return online; },
    goOffline() {
      online = false;
      window.dispatchEvent(new window.Event("offline"));
    },
    goOnline() {
      online = true;
      window.dispatchEvent(new window.Event("online"));
    },
    storage() {
      const out = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        out[key] = window.localStorage.getItem(key);
      }
      return out;
    },
    scope() { return window.OfflineDB.activeScope(); },
    close() {
      try { window.SyncUI && window.SyncUI.destroy(); } catch (e) { /* already gone */ }
      try { dom.window.close(); } catch (e) { /* already closed */ }
    },
  };
  return page;
}

/** Waits until the engine has flushed every queued mutation and pulled. */
async function settle(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = page.window.SyncEngine.state();
    if (!state.syncing && !state.pulling && state.pending === 0) return state;
    if (!state.syncing && page.online) {
      try { await page.window.SyncEngine.flushOutbox(); } catch (e) { /* reported in state */ }
    }
    await sleep(30);
  }
  return page.window.SyncEngine.state();
}

/** pullNow() but patient: a background pull kicked off by sign-in may be in flight. */
async function pullWhenIdle(page, options, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.window.SyncEngine.pullNow(options);
    if (result && result.ok) return result;
    if (result && result.skipped && (result.reason === "pulling" || result.reason === "pushing")) {
      await sleep(25);
      continue;
    }
    return result;
  }
  return { ok: false, reason: "timeout" };
}

/** Logs the page in online and waits for the first pull to finish. */
async function signInAndPull(page, username) {
  await page.window.API.login(username || "admin-a", PASSWORD);
  const ready = await waitFor(() => page.window.SyncEngine.state().scope);
  assert.ok(ready, "the sync scope was opened after sign-in");
  const pull = await pullWhenIdle(page, { full: true });
  assert.equal(pull.ok, true, `initial pull failed: ${JSON.stringify(pull)}`);
  return page.scope();
}

async function studentCount() {
  const row = await ctx.db.get("SELECT COUNT(*) AS n FROM students WHERE madrasa_id = ?", [ctx.madrasaA]);
  return Number(row.n);
}

async function mintCard(client, studentId) {
  const page = await client.req("GET", `/api/documents/id-card/${studentId}`);
  assert.equal(page.status, 200, "the ID card renders (which mints its credential)");
  const credential = await client.api("GET", `/api/documents/card/student/${studentId}/credential`);
  assert.equal(credential.status, 200, JSON.stringify(credential.data));
  return credential.data.credential.code;
}

/* =========================================================================== */
/* 1. Online sign-in → the local store is filled by /api/sync/pull             */
/* =========================================================================== */

test("an online sign-in pulls the tenant dataset into the scoped IndexedDB store", { skip }, async () => {
  const page = createPage({ client: adminA });
  try {
    assert.equal(page.window.OfflineDB.isIndexedDBSupported(), true, "IndexedDB is available in this browser");
    const scope = await signInAndPull(page, "admin-a");

    assert.equal(scope.backend === "indexeddb" || scope.kind === "indexeddb", true, "the durable backend is in use");
    assert.equal(scope.scope, `m${ctx.madrasaA}|u${ctx.users.adminA}`, "the scope is keyed by institution AND user");

    const [students, classes, subjects, terms, sessions, cardCredentials] = await Promise.all([
      scope.getCollection("students"),
      scope.getCollection("classes"),
      scope.getCollection("subjects"),
      scope.getCollection("terms"),
      scope.getCollection("academic_sessions"),
      scope.getCollection("card_credentials"),
    ]);
    assert.equal(students.length, 2, "both students of Madrasa A are cached");
    assert.equal(classes.length, 2);
    assert.equal(subjects.length, 2);
    assert.equal(terms.length, 2);
    assert.equal(sessions.length, 1);
    assert.ok(Array.isArray(cardCredentials), "the scanner-safe card projection is part of the pull");

    const meta = await scope.getMetaMap();
    assert.ok(meta.lastPullCursor, "the incremental cursor is stored");
    assert.equal(meta.session.loggedIn, true, "the /auth/me snapshot is stored for offline boot");
    assert.equal(meta.session.madrasaId, ctx.madrasaA);
    assert.ok(meta.institution && meta.institution.name_en, "the institution profile is cached");

    // Tenant isolation at the source: nothing from Madrasa B leaks in.
    assert.equal(students.some((s) => /Charlie/.test(s.first_name)), false, "no Madrasa B student is cached");
  } finally {
    page.close();
  }
});

/* =========================================================================== */
/* 2. Offline reads                                                            */
/* =========================================================================== */

test("with no internet every workspace module still reads from the local store", { skip }, async () => {
  const code = await mintCard(adminA, ctx.studentA1);
  const page = createPage({ client: adminA });
  try {
    const scope = await signInAndPull(page, "admin-a");
    // Warm a screen that has no dedicated offline resolver (snapshot fallback).
    const templates = await page.window.API.get("/documents/templates?type=certificate");
    assert.ok(templates && typeof templates === "object");

    page.goOffline();
    assert.equal(page.window.SyncEngine.state().online, false);

    const me = await page.window.API.get("/auth/me");
    assert.equal(me.loggedIn, true, "the cached session resumes the workspace offline");
    assert.equal(me.offline, true);
    assert.equal(me.madrasaId, ctx.madrasaA);

    const baseline = await studentCount();
    const students = await page.window.API.get("/students?perPage=200");
    assert.equal(students.total, baseline, "the cached student list matches what the server pulled");
    assert.ok(students.students.every((row) => row.class_en), "class names are joined locally");

    const classes = await page.window.API.get("/classes");
    assert.equal(classes.classes.length, 2);
    const sessions = await page.window.API.get("/sessions");
    assert.equal(sessions.sessions.length, 1);
    const terms = await page.window.API.get("/terms");
    assert.equal(terms.terms.length, 2);

    const register = await page.window.API.get(`/attendance?classId=${ctx.classA1}&date=2026-10-21`);
    assert.equal(register.students.length, 2, "the register is rebuilt from cached students");
    assert.equal(register.students[0].status, "");

    const roster = await page.window.API.get(`/results/roster?classId=${ctx.classA1}&termId=${ctx.termA1}&subjectId=${ctx.subjA1}`);
    assert.equal(roster.students.length, 2);
    assert.ok(roster.config.caMax > 0);

    const announcements = await page.window.API.get("/announcements");
    assert.equal(announcements.announcements.length, 1);
    assert.equal(announcements.announcements[0].title, "Ann A");

    const fees = await page.window.API.get("/fees/payments");
    assert.ok(Array.isArray(fees.payments));
    const balances = await page.window.API.get("/fees/balance");
    assert.ok(Array.isArray(balances.students));

    const quran = await page.window.API.get("/quran-progress?limit=50");
    assert.ok(Array.isArray(quran.records));

    const card = await page.window.API.get(`/public/card/${code}`);
    assert.equal(card.card.code, code, "a scanned QR verifies from the synced card credentials");
    assert.equal(card.card.valid, true);
    assert.equal(card.card.name, "Alpha One");
    assert.ok(card.card.school.name, "the school identity comes from the cached profile");

    const cached = await page.window.API.get("/documents/templates?type=certificate");
    assert.equal(cached.cached, true, "a screen cached earlier still opens offline");

    // A screen that was never opened says so, in plain language.
    await assert.rejects(
      () => page.window.API.get("/payroll/pay-slips"),
      (error) => /has not been saved on this device/i.test(error.message)
    );

    assert.ok(scope, "the scope remained open across all of it");
  } finally {
    page.close();
  }
});

/* =========================================================================== */
/* 3. Offline writes: optimistic local: records + Outbox                       */
/* =========================================================================== */

test("offline writes are optimistic, use local: ids and queue in the Outbox", { skip }, async () => {
  const code = await mintCard(adminA, ctx.studentA1);
  const page = createPage({ client: adminA });
  try {
    const scope = await signInAndPull(page, "admin-a");
    const baselineStudents = await studentCount();
    const categoryId = Number((await ctx.db.run(
      "INSERT INTO expense_categories (madrasa_id, name) VALUES (?,?)",
      [ctx.madrasaA, "Offline Fuel"]
    )).lastInsertRowid);

    page.goOffline();

    const created = await page.window.API.post("/students", {
      first_name: "Delta",
      last_name: "Four",
      class_id: ctx.classA1,
      gender: "M",
      parent_name: "Guardian Four",
      parent_phone: "+2348033334444",
    });
    assert.match(created.id, /^local:stu-/, "the new student gets an optimistic local id");
    assert.equal(created.offline, true);

    const afterCreate = await page.window.API.get("/students");
    assert.equal(afterCreate.total, 3, "the list updates immediately");
    const optimisticStudent = afterCreate.students.find((row) => row.id === created.id);
    assert.equal(optimisticStudent._pending, true);
    assert.equal(optimisticStudent.class_en, "Class A1");

    const mark = await page.window.API.post("/attendance/mark", {
      classId: ctx.classA1,
      date: "2026-10-20",
      statuses: {
        [ctx.studentA1]: { status: "present", note: "" },
        [created.id]: { status: "late", note: "Arrived 08:10" },
      },
    });
    assert.equal(mark.saved, 2);

    const register = await page.window.API.get(`/attendance?classId=${ctx.classA1}&date=2026-10-20`);
    assert.equal(register.students.find((s) => String(s.id) === String(ctx.studentA1)).status, "present");
    assert.equal(register.students.find((s) => s.id === created.id).status, "late", "the new local student is in the register");

    const results = await page.window.API.put("/results", {
      classId: ctx.classA1,
      termId: ctx.termA1,
      subjectId: ctx.subjA1,
      entries: [
        { studentId: String(ctx.studentA1), ca: 36, exam: 54 },
        { studentId: created.id, ca: 30, exam: 50 },
      ],
    });
    assert.equal(results.updated, 2);
    const roster = await page.window.API.get(`/results/roster?classId=${ctx.classA1}&termId=${ctx.termA1}&subjectId=${ctx.subjA1}`);
    assert.equal(roster.students.find((s) => String(s.student_id) === String(ctx.studentA1)).ca, 36);

    const quran = await page.window.API.post("/quran-progress", {
      student_id: String(ctx.studentA1),
      surah: "Al-Fatihah",
      ayah_from: 1,
      ayah_to: 7,
      memorization_progress: 90,
      performance_status: "excellent",
      progress_date: "2026-10-20",
    });
    assert.match(quran.id, /^local:qp-/);

    const payment = await page.window.API.post("/fees/payments", {
      student_id: String(ctx.studentA1),
      amount_ngn: 5000,
      payment_date: "2026-10-20",
      method: "cash",
      reference: "OFFLINE-TEST-REF-1",
    });
    assert.match(payment.receipt_number, /^OFFLINE-/);

    const announcement = await page.window.API.post("/announcements", {
      title: "Gate closed early",
      body: "The gate closes at 3pm today.",
      target_type: "all",
      status: "published",
    });
    assert.match(announcement.id, /^local:ann-/);
    const announcementList = await page.window.API.get("/announcements");
    assert.ok(announcementList.announcements.some((row) => row.title === "Gate closed early"), "the announcement shows immediately");

    const expense = await page.window.API.post("/expenses", {
      category_id: categoryId,
      amount_ngn: 1200,
      description: "Generator fuel",
      payment_date: "2026-10-20",
    });
    assert.match(expense.id, /^local:exp-/);

    const scan = await page.window.API.post("/attendance/scan", { code, date: "2026-10-20", status: "present" });
    assert.equal(scan.marked, true, "an offline gate scan reports the marking");
    assert.equal(scan.card.code, code);

    const outbox = await page.window.SyncEngine.listOutbox();
    const types = outbox.map((item) => item.type).sort();
    assert.deepEqual(types, [
      "announcement.create",
      "attendance.mark",
      "attendance.scan",
      "expense.create",
      "fee_payment.record",
      "quran_progress.create",
      "results.upsert",
      "student.create",
    ], "one Outbox entry per offline action");
    assert.ok(outbox.every((item) => item.status === "pending"));
    assert.ok(outbox.every((item) => item.createdAt > 0));

    // Nothing reached the server yet.
    const serverStudents = await studentCount();
    assert.equal(serverStudents, baselineStudents, "offline work does not touch the server");
    const serverPayments = await ctx.db.get("SELECT COUNT(*) AS n FROM fee_payments WHERE madrasa_id = ?", [ctx.madrasaA]);
    assert.equal(Number(serverPayments.n), 0);

    // Keep the ids for the replay assertion in the next test.
    assert.equal(await page.window.SyncEngine.state().pending, outbox.length);
    assert.ok(scope);
  } finally {
    page.close();
  }
});

/* =========================================================================== */
/* 3b. The real gate scanner, working with no network at all                    */
/* =========================================================================== */

test("the camera/keyboard gate scanner marks attendance offline and syncs later", { skip }, async () => {
  const code = await mintCard(adminA, ctx.studentA2);
  const page = createPage({ client: adminA, scanner: true });
  try {
    await signInAndPull(page, "admin-a");
    const day = "2026-10-26";
    page.goOffline();

    page.document.body.insertAdjacentHTML("beforeend", `
      <div data-scanner data-endpoint="/api/public/card/" data-mark-endpoint="/api/attendance/scan"
           data-mark-auto="1" data-mark-status="late" data-scan-date="${day}">
        <input type="text" name="code" autocomplete="off">
        <button type="button" data-scanner-check>Check</button>
      </div>
      <p data-scanner-error hidden></p>
      <div data-scanner-result></div>`);
    page.window.EduScanner.initAll(page.document);

    const input = page.document.querySelector("input[name=code]");
    input.value = code;
    page.document.querySelector("[data-scanner-check]").click();

    const result = await waitFor(() => page.document.querySelector("[data-scanner-result] .scan-result"), 15000);
    assert.ok(result, `the scanner rendered the offline verdict (error: ${page.document.querySelector("[data-scanner-error]").textContent})`);
    assert.match(result.textContent, /Bravo Two/, "the holder is named from the cached register");
    assert.equal(page.document.querySelector("[data-scanner-error]").hidden, true);

    const queued = await page.window.SyncEngine.listOutbox();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].type, "attendance.scan");
    assert.equal(queued[0].payload.code, code);

    const register = await page.window.API.get(`/attendance?classId=${ctx.classA1}&date=${day}`);
    assert.equal(register.students.find((s) => String(s.id) === String(ctx.studentA2)).status, "late");

    // A "check only" block never queues a marking.
    const checkOnly = page.document.createElement("div");
    checkOnly.setAttribute("data-scanner", "");
    checkOnly.setAttribute("data-endpoint", "/api/public/card/");
    checkOnly.innerHTML = `<input type="text" name="code"><button type="button" data-scanner-check>Check</button>
      <div data-scanner-result></div>`;
    page.document.body.appendChild(checkOnly);
    page.window.EduScanner.initAll(page.document);
    checkOnly.querySelector("input[name=code]").value = code;
    checkOnly.querySelector("[data-scanner-check]").click();
    await waitFor(() => checkOnly.querySelector(".scan-result"));
    assert.equal((await page.window.SyncEngine.listOutbox()).length, 1, "a verification-only scan queues nothing");

    page.goOnline();
    const settled = await settle(page);
    assert.equal(settled.pending, 0);
    const row = await ctx.db.get(
      "SELECT status FROM attendance WHERE madrasa_id = ? AND student_id = ? AND day = ?",
      [ctx.madrasaA, ctx.studentA2, day]
    );
    assert.ok(row, "the offline gate scan reached the register after reconnecting");
    assert.equal(row.status, "late");
  } finally {
    page.close();
  }
});

/* =========================================================================== */
/* 4. Back online: push, id map, zero duplicates, idempotent replay            */
/* =========================================================================== */

test("reconnecting flushes the Outbox, reconciles local ids and creates no duplicates", { skip }, async () => {
  const code = await mintCard(adminA, ctx.studentA2);
  const page = createPage({ client: adminA });
  try {
    await signInAndPull(page, "admin-a");
    const before = await studentCount();
    page.goOffline();

    const created = await page.window.API.post("/students", {
      first_name: "Echo",
      last_name: "Five",
      class_id: ctx.classA1,
      gender: "F",
      parent_phone: "+2348044445555",
    });
    await page.window.API.post("/attendance/mark", {
      classId: ctx.classA1,
      date: "2026-10-22",
      statuses: { [created.id]: { status: "present" } },
    });
    await page.window.API.put("/results", {
      classId: ctx.classA1,
      termId: ctx.termA1,
      subjectId: ctx.subjA2,
      entries: [{ studentId: created.id, ca: 25, exam: 45 }],
    });
    await page.window.API.post("/attendance/scan", { code, date: "2026-10-22" });

    const queued = await page.window.SyncEngine.listOutbox();
    const createItem = queued.find((item) => item.type === "student.create");
    assert.ok(createItem, "the student creation is queued");

    page.goOnline();
    const settled = await settle(page);
    assert.equal(settled.pending, 0, `the Outbox drained (state: ${JSON.stringify(settled)})`);
    assert.equal(settled.attention, 0, "no conflict was raised");

    // The server received exactly one student.
    const rows = await ctx.db.all("SELECT id, first_name, admission_no FROM students WHERE madrasa_id = ? ORDER BY id", [ctx.madrasaA]);
    assert.equal(rows.length, before + 1, "exactly one new student row");
    const echo = rows.find((row) => row.first_name === "Echo");
    assert.ok(echo, "the offline student exists on the server");

    // Attendance + results + scan landed.
    const attendance = await ctx.db.all(
      "SELECT student_id, status FROM attendance WHERE madrasa_id = ? AND day = '2026-10-22'",
      [ctx.madrasaA]
    );
    assert.equal(attendance.length, 2, "one row per student, the scan updated rather than duplicated");
    assert.equal(attendance.find((row) => Number(row.student_id) === Number(echo.id)).status, "present");

    const result = await ctx.db.get(
      "SELECT * FROM results WHERE madrasa_id = ? AND student_id = ? AND subject_id = ? AND term_id = ?",
      [ctx.madrasaA, echo.id, ctx.subjA2, ctx.termA1]
    );
    assert.ok(result, "the offline result was written for the new student");
    assert.equal(Number(result.ca), 25);

    // id_map reconciliation + the local copy agreeing with the server.
    const scope = page.scope();
    const mapped = await scope.getIdMap(created.id);
    assert.equal(Number(mapped), Number(echo.id), "local:<uuid> now maps to the server id");

    const localStudents = await scope.getCollection("students");
    assert.equal(localStudents.length, before + 1, "no optimistic duplicate survives the reconciliation");
    const synced = localStudents.find((row) => row.first_name === "Echo");
    assert.equal(Number(synced.id), Number(echo.id), "the cached row carries the server id");
    assert.notEqual(synced._pending, true, "and is no longer pending");

    const localAttendance = await scope.getCollection("attendance");
    assert.equal(localAttendance.filter((row) => String(row.day) === "2026-10-22").length, 2, "no duplicate attendance rows offline either");
    assert.ok(localAttendance.filter((row) => String(row.day) === "2026-10-22").every((row) => !String(row.id).startsWith("local:")), "optimistic rows were cleaned up");

    // Flushing again changes nothing.
    const second = await page.window.SyncEngine.flushOutbox();
    assert.equal(second.pushed, 0, "an empty Outbox pushes nothing");
    assert.equal(await studentCount(), before + 1);

    // A network replay of an already-applied mutation is answered as duplicate.
    const replay = await page.window.API.sync.push([{
      clientMutationId: createItem.clientMutationId,
      type: createItem.type,
      localId: createItem.localId,
      payload: createItem.payload,
    }], "test-replay");
    assert.equal(replay.results[0].status, "duplicate", "the idempotency ledger answers a replay");
    assert.equal(await studentCount(), before + 1, "a replay never duplicates a row");
  } finally {
    page.close();
  }
});

/* =========================================================================== */
/* 5. Conflicts: frozen results & revoked cards                                */
/* =========================================================================== */

test("frozen results and revoked cards come back as conflicts with a clear decision", { skip }, async () => {
  const code = await mintCard(adminA, ctx.studentA1);
  const page = createPage({ client: adminA });
  try {
    await signInAndPull(page, "admin-a");

    // The office publishes the subject and cancels a card while the tablet is
    // out of signal — the exact race the conflict UI exists for.
    await ctx.db.run(
      "UPDATE results SET status = 'published' WHERE madrasa_id = ? AND class_id = ? AND term_id = ? AND subject_id = ?",
      [ctx.madrasaA, ctx.classA1, ctx.termA1, ctx.subjA1]
    );
    await ctx.db.run("UPDATE card_credentials SET status = 'revoked' WHERE code = ?", [code]);

    page.goOffline();
    const saved = await page.window.API.put("/results", {
      classId: ctx.classA1,
      termId: ctx.termA1,
      subjectId: ctx.subjA1,
      entries: [{ studentId: String(ctx.studentA1), ca: 39, exam: 59 }],
    });
    assert.equal(saved.offline, true, "the tablet believed it saved the marks");
    const scan = await page.window.API.post("/attendance/scan", { code, date: "2026-10-23" });
    assert.equal(scan.marked, true, "and that the card was fine at scan time");

    const countBefore = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM results WHERE madrasa_id = ? AND class_id = ? AND term_id = ? AND subject_id = ?",
      [ctx.madrasaA, ctx.classA1, ctx.termA1, ctx.subjA1]
    );

    page.goOnline();
    const settled = await settle(page);
    assert.equal(settled.pending, 0);
    assert.equal(settled.attention, 2, `both refused changes are held for a decision (state: ${JSON.stringify(settled)})`);

    const conflicts = await page.window.SyncEngine.conflicts();
    assert.equal(conflicts.length, 2);
    const frozen = conflicts.find((c) => c.type === "results.upsert");
    const revoked = conflicts.find((c) => c.type === "attendance.scan");
    assert.ok(frozen, "the results conflict is recorded");
    assert.match(frozen.error, /published or locked/i);
    assert.equal(frozen.status, "conflict");
    assert.ok(Array.isArray(frozen.serverRecord.studentIds) && frozen.serverRecord.studentIds.length, "the server names the locked students");
    assert.ok(revoked, "the revoked card is recorded");
    assert.match(revoked.error, /cancelled|revoked/i);
    assert.equal(revoked.status, "conflict");

    // The conflict never overwrote the published marks.
    const published = await ctx.db.get(
      "SELECT ca, status FROM results WHERE madrasa_id = ? AND student_id = ? AND term_id = ? AND subject_id = ?",
      [ctx.madrasaA, ctx.studentA1, ctx.termA1, ctx.subjA1]
    );
    assert.equal(published.status, "published");
    assert.notEqual(Number(published.ca), 39, "the frozen mark was not overwritten");
    const countAfter = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM results WHERE madrasa_id = ? AND class_id = ? AND term_id = ? AND subject_id = ?",
      [ctx.madrasaA, ctx.classA1, ctx.termA1, ctx.subjA1]
    );
    assert.equal(Number(countAfter.n), Number(countBefore.n), "no duplicate result row was created by the conflict");

    // The drawer shows both, with the two decisions.
    page.window.SyncUI.open();
    const drawer = page.window.SyncUI.drawer();
    assert.ok(drawer && !drawer.hidden);
    const conflictText = await waitFor(() => {
      const text = drawer.querySelector("#esSyncConflicts").textContent;
      return /published or locked/i.test(text) ? text : null;
    });
    assert.ok(conflictText, "the drawer explains why the results were refused");
    assert.match(conflictText, /Accept Server Version/);
    assert.match(conflictText, /Retry/);

    // "Accept Server Version" discards the local attempt.
    const discardButton = drawer.querySelector(`[data-discard="${frozen.clientMutationId}"]`);
    assert.ok(discardButton, "the discard action is rendered");
    discardButton.click();
    const afterDiscard = await waitFor(async () => {
      const list = await page.window.SyncEngine.listOutbox();
      const item = list.find((row) => row.clientMutationId === frozen.clientMutationId);
      return item && item.status === "discarded" ? item : null;
    });
    assert.ok(afterDiscard, "the frozen local edit was discarded");
    assert.equal((await page.window.SyncEngine.conflicts()).length, 1);

    // "Retry" re-sends the revoked scan, which is refused again (still a conflict).
    const retryButton = drawer.querySelector(`[data-retry="${revoked.clientMutationId}"]`);
    assert.ok(retryButton, "the retry action is rendered");
    retryButton.click();
    // The click requeues the item and the engine re-sends it immediately, so the
    // observable outcome is either "pending" (caught mid-flight) or a fresh
    // conflict carrying a second attempt.
    const reSent = await waitFor(async () => {
      const list = await page.window.SyncEngine.listOutbox();
      const item = list.find((row) => row.clientMutationId === revoked.clientMutationId);
      if (!item) return null;
      if (item.status === "pending") return item;
      if (item.status === "conflict" && item.attempts >= 2) return item;
      return null;
    }, 20000);
    assert.ok(reSent, "Retry puts the change back through the server");
    const reverted = reSent.status === "conflict" ? reSent : await waitFor(async () => {
      const list = await page.window.SyncEngine.listOutbox();
      const item = list.find((row) => row.clientMutationId === revoked.clientMutationId);
      if (item && item.status === "pending") await page.window.SyncEngine.flushOutbox();
      return item && item.status === "conflict" && item.attempts >= 2 ? item : null;
    }, 20000);
    assert.ok(reverted, "the refused scan stays a conflict rather than silently disappearing");
    assert.equal(reverted.attempts >= 2, true, "the retry was actually attempted");

    // And the gate scan really did not mark a revoked card.
    const scanRow = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM attendance WHERE madrasa_id = ? AND student_id = ? AND day = '2026-10-23'",
      [ctx.madrasaA, ctx.studentA1]
    );
    assert.equal(Number(scanRow.n), 0, "a revoked card never marks a register");
  } finally {
    page.close();
  }
});

/* =========================================================================== */
/* 6. Status pill + Sync & Devices drawer                                      */
/* =========================================================================== */

test("the header pill reports live state and the drawer manages signed-in devices", { skip }, async () => {
  const page = createPage({ client: adminA });
  try {
    await signInAndPull(page, "admin-a");
    await settle(page);
    const pill = await waitFor(() => page.window.SyncUI.pill());
    assert.ok(pill, "the status pill is mounted");
    assert.equal(pill.closest(".dash-header") !== null, true, "and lives in the workspace header");
    assert.equal(page.window.SyncEngine.state().label, "Online · Synced");
    assert.match(pill.textContent, /Online · Synced/);

    page.goOffline();
    await waitFor(() => page.window.SyncEngine.state().label === "Offline · Saving Locally");
    assert.match(pill.textContent, /Offline · Saving Locally/);

    await page.window.API.post("/students", { first_name: "Foxtrot", last_name: "Six", class_id: ctx.classA1, parent_phone: "+2348055556666" });
    assert.equal(page.window.SyncEngine.state().pending, 1);
    assert.ok(pill.querySelector(".es-sync-badge"), "the queued count is badged on the pill");

    // Watch every label the UI is told about while the connection returns.
    const seen = [];
    page.window.SyncEngine.subscribe((snapshot) => seen.push(snapshot.label));
    page.goOnline();
    await waitFor(async () => (await page.window.SyncEngine.listOutbox()).every((row) => row.status === "synced"));
    await sleep(120);
    assert.ok(seen.some((label) => /^Syncing \(/.test(label)), `a syncing label was emitted: ${JSON.stringify(seen.slice(0, 12))}`);
    assert.equal(page.window.SyncEngine.state().label, "Online · Synced");

    // A revoked offline card forces the attention state.
    const code = await mintCard(adminA, ctx.studentA2);
    await ctx.db.run("UPDATE card_credentials SET status = 'revoked' WHERE code = ?", [code]);
    page.goOffline();
    await page.window.API.post("/attendance/scan", { code, date: "2026-10-24" });
    page.goOnline();
    const attention = await waitFor(() => {
      const state = page.window.SyncEngine.state();
      return state.attention > 0 && !state.syncing ? state : null;
    });
    assert.ok(attention);
    assert.equal(attention.label, "Sync Attention (1)");
    assert.match(pill.textContent, /Sync Attention/);

    // The drawer: Sync Now, the conflict, and the signed-in devices.
    const device = await fetch(ctx.base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin-a",
        password: PASSWORD,
        issueDeviceToken: true,
        deviceId: "tablet-gate-9",
        deviceName: "Gate Tablet 9",
        platform: "android",
      }),
    }).then((r) => r.json());
    assert.ok(device.deviceToken, "a native device token was minted for the device list");

    page.window.SyncUI.open();
    const drawer = page.window.SyncUI.drawer();
    assert.equal(page.window.SyncUI.isOpen(), true);
    assert.ok(drawer.querySelector("#esSyncNow"), "there is a Sync Now action");
    const devicesText = await waitFor(() => {
      const text = drawer.querySelector("#esSyncDevices").textContent;
      return /Gate Tablet 9/.test(text) ? text : null;
    });
    assert.ok(devicesText, "the signed-in device is listed");

    const revoke = await waitFor(() => drawer.querySelector(`[data-revoke="${device.deviceTokenId}"]`));
    assert.ok(revoke, "a device can be signed out from the drawer");
    revoke.click();
    const revoked = await waitFor(async () => {
      const row = await ctx.db.get("SELECT revoked_at FROM device_auth_tokens WHERE id = ?", [device.deviceTokenId]);
      return row && row.revoked_at ? row : null;
    });
    assert.ok(revoked, "the device was revoked through DELETE /api/auth/devices/:id");

    page.window.SyncUI.close();
    assert.equal(page.window.SyncUI.isOpen(), false);
  } finally {
    page.close();
  }
});

/* =========================================================================== */
/* 7. Shared school device: switching accounts never leaks cached tenant data  */
/* =========================================================================== */

test("two institutions sharing one device never see each other's cached rows", { skip }, async () => {
  const page = createPage({ client: adminA });
  try {
    await signInAndPull(page, "admin-a");
    const scopeA = page.window.OfflineDB.activeScope();
    assert.equal(scopeA.scope, `m${ctx.madrasaA}|u${ctx.users.adminA}`);

    const baseline = await studentCount();
    page.goOffline();
    const aStudents = await page.window.API.get("/students?perPage=200");
    assert.equal(aStudents.total, baseline);
    page.goOnline();

    // The next teacher signs in at the same PC.
    page.useClient(adminB);
    await page.window.API.login("admin-b", PASSWORD);
    await waitFor(() => page.window.SyncEngine.state().scope === `m${ctx.madrasaB}|u${ctx.users.adminB}`);
    const pulled = await pullWhenIdle(page, { full: true });
    assert.equal(pulled.ok, true);
    assert.equal(page.window.OfflineDB.activeScope().scope, `m${ctx.madrasaB}|u${ctx.users.adminB}`);

    page.goOffline();
    const bStudents = await page.window.API.get("/students?perPage=200");
    assert.equal(bStudents.total, 1, "only Madrasa B's student is visible");
    assert.equal(bStudents.students[0].first_name, "Charlie");
    const bClasses = await page.window.API.get("/classes");
    assert.equal(bClasses.classes.length, 1);
    assert.equal(bClasses.classes[0].name_en, "Class B1");
    const bAnnouncements = await page.window.API.get("/announcements");
    assert.deepEqual(bAnnouncements.announcements.map((row) => row.title), ["Ann B"]);

    // Signing out of B removes B's copy and leaves A's untouched.
    await page.window.OfflineDB.purgeScope({ madrasaId: ctx.madrasaB, userId: ctx.users.adminB });
    const reopenedB = await page.window.OfflineDB.openScope({ madrasaId: ctx.madrasaB, userId: ctx.users.adminB });
    assert.equal((await reopenedB.getCollection("students")).length, 0, "B's cached rows are gone");

    const reopenedA = await page.window.OfflineDB.openScope({ madrasaId: ctx.madrasaA, userId: ctx.users.adminA });
    assert.equal((await reopenedA.getCollection("students")).length, baseline, "A's cached rows are untouched");
    assert.equal((await reopenedA.getMeta("session")).madrasaId, ctx.madrasaA);
  } finally {
    page.close();
  }
});

/* =========================================================================== */
/* 8. Offline cold start / unlock                                              */
/* =========================================================================== */

test("a previously signed-in user can unlock the cached workspace with zero internet", { skip }, async () => {
  const pageOne = createPage({ client: adminA });
  let pageTwo = null;
  try {
    await signInAndPull(pageOne, "admin-a");
    const baseline = await studentCount();
    const storage = pageOne.storage();
    const factory = pageOne.factory;
    pageOne.close();

    // Cold launch: new process, no session cookie, no network.
    pageTwo = createPage({ factory, storage, online: false, client: null });
    const booted = await waitFor(() => pageTwo.window.SyncEngine.state().backend);
    assert.ok(booted, "the engine boots from the saved scope with no network");

    const lockedMe = await pageTwo.window.API.get("/auth/me");
    assert.equal(lockedMe.loggedIn, false, "the cached workspace stays locked until someone unlocks it");

    await assert.rejects(
      () => pageTwo.window.API.login("admin-a", "definitely-the-wrong-password"),
      (error) => /does not match the saved offline access/i.test(error.message),
      "the verifier refuses a wrong password"
    );

    const unlocked = await pageTwo.window.API.login("admin-a", PASSWORD);
    assert.equal(unlocked.ok, true);
    assert.equal(unlocked.offline, true, "the sign-in was answered locally");
    assert.equal(unlocked.role, "madrasa_admin");
    assert.equal(unlocked.madrasaId, ctx.madrasaA);

    const me = await pageTwo.window.API.get("/auth/me");
    assert.equal(me.loggedIn, true, "the cached workspace is unlocked");
    const students = await pageTwo.window.API.get("/students");
    assert.equal(students.total, baseline, "and the saved data is there");
    assert.equal(pageTwo.window.SyncEngine.state().label, "Offline · Saving Locally");

    // Work done in this cold start is queued, not lost.
    const created = await pageTwo.window.API.post("/students", {
      first_name: "Golf", last_name: "Seven", class_id: ctx.classA1, parent_phone: "+2348066667777",
    });
    assert.match(created.id, /^local:stu-/);
    assert.equal(pageTwo.window.SyncEngine.state().pending, 1);
  } finally {
    try { pageOne.close(); } catch (e) { /* already closed */ }
    if (pageTwo) pageTwo.close();
  }
});

/* =========================================================================== */
/* 9. Security & shell integrity                                               */
/* =========================================================================== */

test("the offline layer never bypasses window.API and online-only actions say so", { skip }, async () => {
  const RAW_REQUEST = /(?:^|[^\w.$])(?:await\s+|return\s+|=)?\s*(?:window\.|self\.|globalThis\.)?fetch\s*\(/m;
  for (const name of ["offline-db.js", "sync-engine.js", "sync-ui.js"]) {
    const source = fs.readFileSync(path.join(PUBLIC_JS, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
      .replace(/^\s*\/\/.*$/gm, "");       // line comments
    assert.equal(RAW_REQUEST.test(source), false, `${name} must not call fetch directly — every request goes through window.API`);
    assert.equal(/method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(source), false, `${name} must not build a mutating HTTP request`);
  }
  assert.match(SRC.engine, /API\.setTransportInterceptor\(intercept\)/, "the engine registers the interceptor");

  const page = createPage({ client: adminA });
  try {
    await signInAndPull(page, "admin-a");
    page.goOffline();

    await assert.rejects(
      () => page.window.API.post("/ai/chat", { message: "hello" }),
      (error) => {
        assert.equal(error.code, "OFFLINE_ONLY");
        assert.match(error.message, /internet connection/i);
        return true;
      },
      "live AI is clearly reported as online-only"
    );

    await assert.rejects(
      () => page.window.API.post("/payment/checkout", { amount: 100 }),
      (error) => {
        assert.equal(error.code, "OFFLINE_ONLY");
        assert.match(error.message, /checkout|payment/i);
        return true;
      }
    );

    const upload = new page.window.FormData();
    upload.append("file", "x");
    await assert.rejects(
      () => page.window.API.post("/students/import", upload),
      (error) => /internet connection/i.test(error.message),
      "file uploads are reported instead of silently failing"
    );

    // None of that queued anything.
    assert.equal((await page.window.SyncEngine.listOutbox()).length, 0);
  } finally {
    page.close();
  }
});

test("the service worker precaches the whole shell and never caches the API", { skip }, async () => {
  const sw = fs.readFileSync(path.join(ROOT, "public", "sw.js"), "utf8");
  const index = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

  assert.match(sw, /edusphere-shell-v\d+/, "the precache is versioned");

  const refs = new Set();
  for (const match of index.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"]+)"/g)) refs.add(match[1]);
  assert.ok(refs.size > 20, "the shell references the full asset set");
  for (const ref of refs) {
    const diskPath = path.join(ROOT, "public", ref.replace(/^\//, ""));
    assert.equal(fs.existsSync(diskPath), true, `index.html references a real file: ${ref}`);
    assert.ok(sw.includes(`"${ref}"`), `sw.js precaches ${ref}`);
  }
  for (const asset of ["/js/offline-db.js", "/js/sync-engine.js", "/js/sync-ui.js", "/css/offline-sync.css"]) {
    assert.ok(sw.includes(`"${asset}"`), `the Phase 2 asset is precached: ${asset}`);
  }

  // Application data is never put in the shared (per-origin) HTTP cache.
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/, "the worker passes /api/ through untouched");
  assert.match(sw, /request\.method !== "GET"/, "only GETs are considered");
  assert.equal(/cache\.put\(request[^)]*api/i.test(sw), false);

  // And the server actually serves it.
  const response = await fetch(`${ctx.base}/sw.js`);
  assert.equal(response.status, 200, "the worker is served from the web root");
  assert.match(response.headers.get("content-type") || "", /javascript/i);
});

test("the login and admin entry points keep their normal online behaviour", { skip }, async () => {
  // Offline support must never turn /login or /admin into a passwordless bypass.
  const page = createPage({ client: null, online: true });
  try {
    const anon = new Client(ctx.base);
    page.useClient(anon);
    const me = await page.window.API.get("/auth/me");
    assert.equal(me.loggedIn, false, "an anonymous visitor is not signed in");
    const form = await anon.req("GET", "/login");
    assert.equal(form.status, 200);
    assert.match(await form.res.text(), /id="app"/i, "the SPA shell (and its sign-in form) is still served");

    await assert.rejects(
      () => page.window.API.login("admin-a", "wrong-password-entirely"),
      (error) => error.status === 401,
      "a wrong password is refused by the server, not answered from the cache"
    );
    assert.equal(page.window.SyncEngine.state().scope, "", "a failed sign-in opens no scope");
  } finally {
    page.close();
  }
});
