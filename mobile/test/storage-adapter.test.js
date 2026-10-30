"use strict";
/* ============================================================================
   NATIVE SQLITE STORAGE ADAPTER — SAME CONTRACT, SAME SEMANTICS
   ----------------------------------------------------------------------------
   The phone's offline database must never become a second implementation. This
   file runs the REAL `public/js/offline-db.js` (the Phase 2 engine) twice:

     • against IndexedDB (the browser/desktop backend), and
     • against SQLite through `public/js/mobile-storage.js` and a driver built on
       Node's own `node:sqlite` — the same `execute`/`query` shape the
       EduSphereNative plugin exposes on Android and iOS.

   Then it asserts both produce identical observable results: same tenant-scoped
   keys, same outbox ordering and statuses, same purge isolation. The SQL is
   therefore exercised for real, not mocked.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDom, memorySqliteDriver } = require("./helpers");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");

const SCOPE = { madrasaId: 7, userId: 42 };
const OTHER_SCOPE = { madrasaId: 8, userId: 43 };

function bootIndexedDb() {
  const ctx = createDom({
    beforeEval: (window) => {
      window.indexedDB = new IDBFactory();
      window.IDBKeyRange = IDBKeyRange;
    },
  });
  ctx.evalFile("offline-db.js");
  return ctx;
}

function bootSqlite(driver) {
  const sqlDriver = driver || memorySqliteDriver();
  const ctx = createDom({
    beforeEval: (window) => {
      window.__EDUSPHERE_MOBILE__ = {
        sqlite: {
          available: () => true,
          execute: (sql, params) => Promise.resolve(sqlDriver.execute(sql, params)),
          query: (sql, params) => Promise.resolve(sqlDriver.query(sql, params)),
        },
      };
    },
  });
  ctx.evalFile("mobile-storage.js");
  ctx.evalFile("offline-db.js");
  return Object.assign(ctx, { driver: sqlDriver });
}

/** The exact workload both backends must agree on. */
async function exercise(OfflineDB) {
  const scope = await OfflineDB.openScope(SCOPE);
  const other = await OfflineDB.openScope(OTHER_SCOPE);

  await scope.putRecords("students", [
    { id: 1, first_name: "Amina", class_id: 3 },
    { id: 2, first_name: "Yusuf", class_id: 3 },
  ]);
  await scope.replaceCollection("students", [
    { id: 1, first_name: "Amina", class_id: 3 },
    { id: 3, first_name: "Bilal", class_id: 4 },
  ]);
  await scope.putRecord("students", { id: "local:stu-1", first_name: "Optimistic", _pending: true });

  await scope.setMeta("lastPullCursor", "2026-10-30T10:00:00.000Z");
  await scope.putSnapshot("/students?classId=3", { students: [{ id: 1 }] });

  await scope.enqueueOutbox({ clientMutationId: "cm-1", type: "attendance.scan", payload: { code: "abc" }, createdAt: 1000 });
  await scope.enqueueOutbox({ clientMutationId: "cm-2", type: "student.create", localId: "local:stu-1", payload: { first_name: "Optimistic" }, createdAt: 1001 });
  await scope.enqueueOutbox({ clientMutationId: "cm-3", type: "result.save", payload: {}, createdAt: 1002 });
  await scope.updateOutbox("cm-3", { status: "conflict", error: "frozen result" });
  await scope.setIdMap("local:stu-1", 501, "student");

  /* The other tenant must stay invisible. */
  await other.putRecords("students", [{ id: 99, first_name: "Other school" }]);
  await other.enqueueOutbox({ clientMutationId: "cm-other", type: "student.update", payload: {}, createdAt: 900 });

  const students = await scope.getCollection("students");
  const outbox = await scope.listOutbox();
  return {
    students: students.map((row) => ({ id: row.id, name: row.first_name })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    outboxIds: outbox.map((row) => row.clientMutationId),
    pending: outbox.filter((row) => row.status === "pending").map((row) => row.clientMutationId),
    conflicts: outbox.filter((row) => row.status === "conflict").map((row) => row.clientMutationId),
    cursor: await scope.getMeta("lastPullCursor"),
    snapshot: await scope.getSnapshot("/students?classId=3"),
    idMap: await scope.resolveId("local:stu-1", "student"),
    otherStudents: (await other.getCollection("students")).map((row) => row.id),
    otherOutbox: await other.countOutbox(),
    pendingCount: await scope.countOutbox(),
  };
}

test("SQLite is selected automatically inside the native shell", async () => {
  const ctx = bootSqlite();
  const scope = await ctx.window.OfflineDB.openScope(SCOPE);
  assert.equal(scope.kind, "sqlite");
  assert.equal(await ctx.window.OfflineDB.backendKind(), "sqlite");
  assert.equal(scope.scopeKey(), "m7|u42", "the tenant-scoped key contract is unchanged");
  ctx.close();
});

test("the browser build keeps using IndexedDB", async () => {
  const ctx = bootIndexedDb();
  await ctx.window.OfflineDB.openScope(SCOPE);
  assert.equal(await ctx.window.OfflineDB.backendKind(), "indexeddb");
  ctx.close();
});

test("SQLite and IndexedDB produce identical results for the same workload", async () => {
  const indexed = bootIndexedDb();
  const sqlite = bootSqlite();

  const viaIndexed = await exercise(indexed.window.OfflineDB);
  const viaSqlite = await exercise(sqlite.window.OfflineDB);

  /* JSON, not deepEqual: the two realms create distinct prototypes for the
     nested snapshot objects, which is not a behavioural difference. */
  assert.equal(JSON.stringify(viaSqlite), JSON.stringify(viaIndexed), "the two backends are interchangeable");

  /* And the expectations themselves are pinned, so both drifting together fails. */
  assert.deepEqual(viaSqlite.students, [
    { id: 1, name: "Amina" },
    { id: 3, name: "Bilal" },
    { id: "local:stu-1", name: "Optimistic" },
  ]);
  assert.deepEqual(viaSqlite.outboxIds, ["cm-1", "cm-2", "cm-3"], "outbox is ordered by createdAt");
  assert.deepEqual(viaSqlite.pending, ["cm-1", "cm-2"]);
  assert.deepEqual(viaSqlite.conflicts, ["cm-3"]);
  assert.equal(viaSqlite.cursor, "2026-10-30T10:00:00.000Z", "the pull cursor survives a restart");
  assert.equal(viaSqlite.idMap, 501, "local ids resolve to server ids");
  assert.deepEqual(viaSqlite.otherStudents, [99], "the other tenant sees only its own row");
  assert.equal(viaSqlite.otherOutbox, 1);
  assert.equal(viaSqlite.pendingCount, 3);
  indexed.close();
  sqlite.close();
});

test("purge removes exactly one tenant from the phone", async () => {
  const ctx = bootSqlite();
  const OfflineDB = ctx.window.OfflineDB;
  await exercise(OfflineDB);

  await OfflineDB.purgeScope(SCOPE);

  const fresh = await OfflineDB.openScope(SCOPE);
  const other = await OfflineDB.openScope(OTHER_SCOPE);
  assert.equal(await fresh.countOutbox(), 0, "this account's queue is gone");
  assert.deepEqual(await fresh.getCollection("students"), []);
  assert.equal(await other.countOutbox(), 1, "the other school's queue is untouched");
  assert.deepEqual((await other.getCollection("students")).map((row) => row.id), [99]);
  ctx.close();
});

test("an app UPDATE migrates IndexedDB into SQLite and keeps the pending queue", async () => {
  const sqlDriver = memorySqliteDriver();
  const ctx = bootSqlite(sqlDriver);
  const window = ctx.window;

  /* 1. Simulate the pre-update install: data lives in IndexedDB only. */
  const legacy = new IDBFactory();
  window.indexedDB = legacy;
  window.IDBKeyRange = IDBKeyRange;
  const seeded = await new Promise((resolve, reject) => {
    const request = legacy.open("edusphere_offline_v1", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("collections", { keyPath: "k" }).createIndex("by_scope_collection", ["s", "c"]);
      db.createObjectStore("meta", { keyPath: "k" }).createIndex("by_scope", "s");
      db.createObjectStore("outbox", { keyPath: "clientMutationId" }).createIndex("by_scope", "s");
      db.createObjectStore("id_map", { keyPath: "k" }).createIndex("by_scope", "s");
      db.createObjectStore("snapshots", { keyPath: "k" }).createIndex("by_scope", "s");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const write = (storeName, rows) => new Promise((resolve, reject) => {
    const tx = seeded.transaction(storeName, "readwrite");
    for (const row of rows) tx.objectStore(storeName).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await write("collections", [
    { k: "m7|u42|collections|students|1", s: "m7|u42", c: "students", id: "1", row: { id: 1, first_name: "Amina" }, updatedAt: 1 },
  ]);
  await write("outbox", [
    { clientMutationId: "cm-offline-1", s: "m7|u42", status: "pending", type: "attendance.scan", payload: { code: "abc" }, createdAt: 111 },
    { clientMutationId: "cm-offline-2", s: "m7|u42", status: "syncing", type: "student.create", payload: {}, createdAt: 222 },
  ]);
  await write("meta", [
    { k: "m7|u42|lastPullCursor", s: "m7|u42", key: "lastPullCursor", value: "2026-10-01T00:00:00.000Z", updatedAt: 1 },
  ]);
  seeded.close();

  /* 2. The update boots with the SQLite backend; the first open migrates. */
  window.MobileStorage._reset();
  window.OfflineDB._reset();
  const scope = await window.OfflineDB.openScope(SCOPE);

  assert.equal(scope.kind, "sqlite", "the native backend took over");
  const outbox = await scope.listOutbox();
  assert.deepEqual(outbox.map((row) => row.clientMutationId), ["cm-offline-1", "cm-offline-2"], "the pending queue survived the update");
  assert.equal(outbox[0].type, "attendance.scan", "the mutation payload is intact");
  assert.deepEqual((await scope.getCollection("students")).map((row) => row.id), [1]);
  assert.equal(await scope.getMeta("lastPullCursor"), "2026-10-01T00:00:00.000Z", "the cursor survived");

  /* 3. Migrating twice is harmless and never resurrects deleted rows. */
  const again = await window.MobileStorage.migrateFromIndexedDB(await window.MobileStorage.openBackend());
  assert.equal(again.migrated, false);
  assert.equal(again.reason, "already-migrated");

  /* 4. A row written after the update is NOT overwritten by a later migration. */
  await scope.removeOutbox("cm-offline-1");
  await window.MobileStorage.migrateFromIndexedDB(await window.MobileStorage.openBackend());
  assert.equal(await scope.getOutboxItem("cm-offline-1"), null, "a re-run does not bring back a synced row");
  ctx.close();
  sqlDriver.close();
});

test("the SQLite schema is real SQL (created by node:sqlite, not mocked)", async () => {
  const driver = memorySqliteDriver();
  const ctx = bootSqlite(driver);
  await ctx.window.OfflineDB.openScope(SCOPE);
  const tables = driver.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", []).rows.map((row) => row.name);
  for (const table of ["collections", "meta", "outbox", "id_map", "snapshots", "kv"]) {
    assert.ok(tables.includes(table), "table " + table + " exists");
  }
  const indexes = driver.query("SELECT name FROM sqlite_master WHERE type = 'index'", []).rows.map((row) => row.name);
  assert.ok(indexes.includes("outbox_scope_status"), "the outbox status index exists (a gate needs it fast)");
  assert.ok(indexes.includes("collections_scope_collection"), "the collection index exists");
  ctx.close();
  driver.close();
});

test("if native SQLite fails the app degrades to IndexedDB instead of dying", async () => {
  const ctx = createDom({
    beforeEval: (window) => {
      window.indexedDB = new IDBFactory();
      window.IDBKeyRange = IDBKeyRange;
      window.__EDUSPHERE_MOBILE__ = {
        sqlite: {
          available: () => true,
          execute: () => Promise.reject(new Error("disk full")),
          query: () => Promise.reject(new Error("disk full")),
        },
      };
    },
  });
  ctx.evalFile("mobile-storage.js");
  ctx.evalFile("offline-db.js");
  const scope = await ctx.window.OfflineDB.openScope(SCOPE);
  assert.ok(["indexeddb", "memory"].includes(scope.kind), "the app still has a working store: " + scope.kind);
  await scope.putRecords("students", [{ id: 1 }]);
  assert.equal((await scope.getCollection("students")).length, 1);
  ctx.close();
});
