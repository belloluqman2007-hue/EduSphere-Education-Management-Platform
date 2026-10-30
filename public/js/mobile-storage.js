"use strict";
/* ============================================================================
   EduSphere — NATIVE SQLITE STORAGE ADAPTER (Phase 4)
   ----------------------------------------------------------------------------
   IndexedDB is fine in a browser tab. On a phone it is a WebView cache: iOS
   can evict it under storage pressure and Android's "Clear cache" wipes it.
   A gate tablet must not lose the attendance queue because a child freed some
   space, so inside the native shell the SAME offline database moves to real
   SQLite (Android's SQLiteOpenHelper / iOS libsqlite3) through the
   `EduSphereNative` plugin.

   This file is the adapter, not a second offline implementation:

     • `public/js/offline-db.js` keeps owning the tenant-scoped key contract,
       the outbox semantics, `local:` ids, conflict handling. Nothing here
       knows what a mutation is.
     • `window.MobileStorage.openBackend()` returns an object with EXACTLY the
       backend contract `offline-db.js` already uses
       (`put`, `putMany`, `get`, `del`, `all`, `allBy`, `clearScope`, `kind`),
       so `OfflineScope` is byte-identical on both backends.
     • `migrateFromIndexedDB()` copies whatever IndexedDB already holds into
       SQLite exactly once, so an app UPDATE keeps its pending queue, its
       cursors and its cached rows.

   Every statement is ordinary SQLite SQL, so it is testable with Node's own
   `node:sqlite` (see mobile/test/storage.test.js) and identical on the phone.
   ========================================================================== */
(function () {
  if (typeof window === "undefined") return;

  const STORE_NAMES = ["collections", "meta", "outbox", "id_map", "snapshots"];
  const PRIMARY_KEYS = {
    collections: "k",
    meta: "k",
    outbox: "clientMutationId",
    id_map: "k",
    snapshots: "k",
  };
  const MIGRATION_FLAG = "migrated_from_indexeddb";

  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS collections (
       k TEXT PRIMARY KEY,
       s TEXT NOT NULL,
       c TEXT NOT NULL,
       id TEXT NOT NULL,
       row TEXT NOT NULL,
       updatedAt INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS collections_scope ON collections (s)`,
    `CREATE INDEX IF NOT EXISTS collections_scope_collection ON collections (s, c)`,
    `CREATE TABLE IF NOT EXISTS meta (
       k TEXT PRIMARY KEY,
       s TEXT NOT NULL,
       key TEXT NOT NULL,
       value TEXT,
       updatedAt INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS meta_scope ON meta (s)`,
    `CREATE TABLE IF NOT EXISTS outbox (
       clientMutationId TEXT PRIMARY KEY,
       s TEXT NOT NULL,
       scopeKey TEXT,
       status TEXT NOT NULL,
       createdAt INTEGER NOT NULL,
       attempts INTEGER NOT NULL DEFAULT 0,
       row TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS outbox_scope ON outbox (s)`,
    `CREATE INDEX IF NOT EXISTS outbox_scope_status ON outbox (s, status)`,
    `CREATE TABLE IF NOT EXISTS id_map (
       k TEXT PRIMARY KEY,
       s TEXT NOT NULL,
       localId TEXT,
       serverId TEXT,
       entity TEXT,
       row TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS id_map_scope ON id_map (s)`,
    `CREATE TABLE IF NOT EXISTS snapshots (
       k TEXT PRIMARY KEY,
       s TEXT NOT NULL,
       key TEXT NOT NULL,
       data TEXT,
       updatedAt INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS snapshots_scope ON snapshots (s)`,
    `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`,
  ];

  /** How each `allBy` index maps to SQL. Unknown indexes answer `[]`. */
  const INDEX_QUERIES = {
    "meta:by_scope": { store: "meta", sql: "SELECT * FROM meta WHERE s = ?", params: (key) => [key] },
    "collections:by_scope": { store: "collections", sql: "SELECT * FROM collections WHERE s = ?", params: (key) => [key] },
    "collections:by_scope_collection": {
      store: "collections",
      sql: "SELECT * FROM collections WHERE s = ? AND c = ?",
      params: (key) => [Array.isArray(key) ? key[0] : key, Array.isArray(key) ? key[1] : ""],
    },
    "outbox:by_scope": { store: "outbox", sql: "SELECT * FROM outbox WHERE s = ? ORDER BY createdAt ASC", params: (key) => [key] },
    "outbox:by_scope_status": {
      store: "outbox",
      sql: "SELECT * FROM outbox WHERE s = ? AND status = ? ORDER BY createdAt ASC",
      params: (key) => [Array.isArray(key) ? key[0] : key, Array.isArray(key) ? key[1] : ""],
    },
    "id_map:by_scope": { store: "id_map", sql: "SELECT * FROM id_map WHERE s = ?", params: (key) => [key] },
    "snapshots:by_scope": { store: "snapshots", sql: "SELECT * FROM snapshots WHERE s = ?", params: (key) => [key] },
  };

  function nowMs() {
    return Date.now();
  }

  function json(value) {
    try {
      const text = JSON.stringify(value === undefined ? null : value);
      return text === undefined ? "null" : text;
    } catch (e) {
      return "null";
    }
  }

  function parse(text, fallback) {
    if (text === null || text === undefined) return fallback === undefined ? null : fallback;
    if (typeof text === "object") return text;
    try { return JSON.parse(text); } catch (e) { return fallback === undefined ? null : fallback; }
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  /* --------------------------- row <-> params ---------------------------- */

  function encode(storeName, value) {
    const row = value && typeof value === "object" ? value : {};
    if (storeName === "collections") {
      return {
        columns: ["k", "s", "c", "id", "row", "updatedAt"],
        values: [
          String(row.k || ""),
          String(row.s || ""),
          String(row.c || ""),
          String(row.id === undefined ? "" : row.id),
          json(row.row),
          num(row.updatedAt, nowMs()),
        ],
      };
    }
    if (storeName === "meta") {
      return {
        columns: ["k", "s", "key", "value", "updatedAt"],
        values: [
          String(row.k || ""),
          String(row.s || ""),
          String(row.key === undefined ? "" : row.key),
          json(row.value),
          num(row.updatedAt, nowMs()),
        ],
      };
    }
    if (storeName === "outbox") {
      return {
        columns: ["clientMutationId", "s", "scopeKey", "status", "createdAt", "attempts", "row"],
        values: [
          String(row.clientMutationId || ""),
          String(row.s || row.scopeKey || ""),
          String(row.scopeKey || row.s || ""),
          String(row.status || "pending"),
          num(row.createdAt, nowMs()),
          num(row.attempts, 0),
          json(row),
        ],
      };
    }
    if (storeName === "id_map") {
      return {
        columns: ["k", "s", "localId", "serverId", "entity", "row"],
        values: [
          String(row.k || ""),
          String(row.s || ""),
          String(row.localId === undefined ? "" : row.localId),
          String(row.serverId === undefined ? "" : row.serverId),
          String(row.entity || ""),
          json(row),
        ],
      };
    }
    return {
      columns: ["k", "s", "key", "data", "updatedAt"],
      values: [
        String(row.k || ""),
        String(row.s || ""),
        String(row.key === undefined ? "" : row.key),
        json(row.data),
        num(row.updatedAt, nowMs()),
      ],
    };
  }

  function decode(storeName, row) {
    if (!row) return null;
    if (storeName === "collections") {
      return { k: row.k, s: row.s, c: row.c, id: row.id, row: parse(row.row, null), updatedAt: num(row.updatedAt) };
    }
    if (storeName === "meta") {
      return { k: row.k, s: row.s, key: row.key, value: parse(row.value, null), updatedAt: num(row.updatedAt) };
    }
    if (storeName === "outbox") {
      /* The whole mutation is the JSON row; the columns exist for indexes and
         ordering only. Canonical column values win so a hand-edited row can
         never desynchronise the queue. */
      const parsed = parse(row.row, {}) || {};
      return Object.assign({}, parsed, {
        clientMutationId: row.clientMutationId,
        s: row.s,
        scopeKey: row.scopeKey || row.s,
        status: row.status || parsed.status || "pending",
        createdAt: num(row.createdAt, num(parsed.createdAt)),
        attempts: num(row.attempts, num(parsed.attempts)),
      });
    }
    if (storeName === "id_map") {
      return parse(row.row, { k: row.k, s: row.s, localId: row.localId, serverId: row.serverId, entity: row.entity });
    }
    return { k: row.k, s: row.s, key: row.key, data: parse(row.data, null), updatedAt: num(row.updatedAt) };
  }

  function insertSql(storeName, columns) {
    const placeholders = columns.map(() => "?").join(", ");
    return `INSERT OR REPLACE INTO ${storeName} (${columns.join(", ")}) VALUES (${placeholders})`;
  }

  /* ------------------------------ the backend ---------------------------- */

  /**
   * @param driver `{ execute(sql, params), query(sql, params) }` — provided by
   *   the `EduSphereNative` Capacitor plugin on the phone; in tests it is a
   *   `node:sqlite` wrapper, so the SQL itself is exercised for real.
   */
  function SqliteBackend(driver) {
    this.kind = "sqlite";
    this.driver = driver;
    /* A probe first: if the native driver cannot even answer SELECT 1 (plugin
       missing, disk full, database locked) the caller must fall back to
       IndexedDB instead of carrying a store that silently drops writes. */
    this.ready = Promise.resolve()
      .then(() => driver.query("SELECT 1 AS ok", []))
      .then(() => SCHEMA.reduce(
        (chain, statement) => chain.then(() => driver.execute(statement, []).catch(() => null)),
        Promise.resolve()
      ));
  }

  SqliteBackend.prototype.ready_ = function () {
    return this.ready || Promise.resolve(null);
  };

  SqliteBackend.prototype.put = function (storeName, value) {
    const self = this;
    const { columns, values } = encode(storeName, value);
    return self.ready_()
      .then(() => self.driver.execute(insertSql(storeName, columns), values))
      .then(() => value);
  };

  SqliteBackend.prototype.putMany = function (storeName, values) {
    if (!Array.isArray(values) || !values.length) return Promise.resolve(0);
    const self = this;
    return self.ready_().then(async () => {
      for (const value of values) {
        const { columns, values: params } = encode(storeName, value);
        await self.driver.execute(insertSql(storeName, columns), params);
      }
      return values.length;
    });
  };

  SqliteBackend.prototype.get = function (storeName, key) {
    const self = this;
    const pk = PRIMARY_KEYS[storeName] || "k";
    return self.ready_()
      .then(() => self.driver.query(`SELECT * FROM ${storeName} WHERE ${pk} = ?`, [String(key)]))
      .then((result) => {
        const rows = (result && result.rows) || [];
        return rows.length ? decode(storeName, rows[0]) : null;
      });
  };

  SqliteBackend.prototype.del = function (storeName, key) {
    const self = this;
    const pk = PRIMARY_KEYS[storeName] || "k";
    return self.ready_()
      .then(() => self.driver.execute(`DELETE FROM ${storeName} WHERE ${pk} = ?`, [String(key)]))
      .then(() => true);
  };

  SqliteBackend.prototype.all = function (storeName) {
    const self = this;
    return self.ready_()
      .then(() => self.driver.query(`SELECT * FROM ${storeName}`, []))
      .then((result) => ((result && result.rows) || []).map((row) => decode(storeName, row)).filter(Boolean));
  };

  SqliteBackend.prototype.allBy = function (storeName, indexName, key) {
    const self = this;
    const plan = INDEX_QUERIES[`${storeName}:${indexName}`];
    if (!plan) return Promise.resolve([]);
    return self.ready_()
      .then(() => self.driver.query(plan.sql, plan.params(key)))
      .then((result) => ((result && result.rows) || []).map((row) => decode(storeName, row)).filter(Boolean));
  };

  SqliteBackend.prototype.clearScope = function (scopeKey) {
    const self = this;
    return self.ready_().then(async () => {
      for (const storeName of STORE_NAMES) {
        await self.driver.execute(`DELETE FROM ${storeName} WHERE s = ?`, [String(scopeKey)]);
      }
      return true;
    });
  };

  /* ------------------------- IndexedDB → SQLite move ---------------------
     Runs exactly once per installation. `INSERT OR REPLACE` makes a re-run
     harmless, and rows that only exist locally (an optimistic student who was
     never pushed) are copied like any other, so an UPDATE of the app cannot
     lose the outbox.
  --------------------------------------------------------------------- */
  function openLegacyIndexedDb() {
    return new Promise((resolve) => {
      let factory = null;
      try { factory = window.indexedDB || null; } catch (e) { factory = null; }
      if (!factory) return resolve(null);
      let request;
      try { request = factory.open("edusphere_offline_v1"); } catch (e) { return resolve(null); }
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
      /* Never let a broken legacy database hold the app hostage. */
      setTimeout(() => resolve(null), 3000);
    });
  }

  function readLegacyStore(db, storeName) {
    return new Promise((resolve) => {
      if (!db || !db.objectStoreNames || !db.objectStoreNames.contains(storeName)) return resolve([]);
      let tx;
      try { tx = db.transaction(storeName, "readonly"); } catch (e) { return resolve([]); }
      let request;
      try { request = tx.objectStore(storeName).getAll(); } catch (e) { return resolve([]); }
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => resolve([]);
    });
  }

  async function migrateFromIndexedDB(backend) {
    if (!backend || typeof backend.driver !== "object") return { migrated: false, reason: "no-backend" };
    const driver = backend.driver;
    try { await backend.ready; } catch (e) { return { migrated: false, reason: "backend-unavailable" }; }
    let flag = null;
    try {
      const result = await driver.query("SELECT v FROM kv WHERE k = ?", [MIGRATION_FLAG]);
      const rows = (result && result.rows) || [];
      flag = rows.length ? rows[0].v : null;
    } catch (e) { flag = null; }
    if (flag) return { migrated: false, reason: "already-migrated", at: Number(flag) || 0 };

    const db = await openLegacyIndexedDb();
    const counts = {};
    try {
      for (const storeName of STORE_NAMES) {
        const rows = db ? await readLegacyStore(db, storeName) : [];
        counts[storeName] = 0;
        for (const row of rows) {
          const { columns, values } = encode(storeName, row);
          if (!values[0]) continue;
          await driver.execute(insertSql(storeName, columns), values);
          counts[storeName] += 1;
        }
      }
    } finally {
      try { if (db && typeof db.close === "function") db.close(); } catch (e) { /* ignore */ }
    }
    try { await driver.execute("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", [MIGRATION_FLAG, String(nowMs())]); } catch (e) { /* ignore */ }
    return { migrated: true, counts };
  }

  function driverFromMobile(mobile) {
    if (!mobile || !mobile.sqlite || typeof mobile.sqlite.available !== "function") return null;
    try {
      if (!mobile.sqlite.available()) return null;
    } catch (e) {
      return null;
    }
    return {
      execute: (sql, params) => mobile.sqlite.execute(sql, params),
      query: (sql, params) => mobile.sqlite.query(sql, params),
    };
  }

  const active = { backend: null, promise: null };

  window.MobileStorage = Object.freeze({
    STORE_NAMES,
    SCHEMA,
    INDEX_QUERIES,
    MIGRATION_FLAG,
    /** True only inside the native shell with the SQLite plugin present. */
    available() {
      return Boolean(driverFromMobile(window.__EDUSPHERE_MOBILE__));
    },
    backendKind() {
      return active.backend ? active.backend.kind : "none";
    },
    SqliteBackend,
    encode,
    decode,
    migrateFromIndexedDB,
    /**
     * Opens (once) the SQLite-backed store used by `offline-db.js`. Resolves to
     * an object that implements the exact `IdbBackend` contract.
     */
    openBackend(options) {
      if (active.backend) return Promise.resolve(active.backend);
      if (active.promise) return active.promise;
      const mobile = (options && options.mobile) || window.__EDUSPHERE_MOBILE__;
      const driver = (options && options.driver) || driverFromMobile(mobile);
      if (!driver) return Promise.reject(new Error("Native SQLite is not available"));
      const backend = new SqliteBackend(driver);
      active.promise = backend.ready_()
        .then(() => migrateFromIndexedDB(backend).catch(() => ({ migrated: false, reason: "failed" })))
        .then(() => {
          active.backend = backend;
          active.promise = null;
          return backend;
        })
        .catch((error) => {
          active.promise = null;
          throw error;
        });
      return active.promise;
    },
    /** Test/diagnostics hook: forget the open connection. */
    _reset() {
      active.backend = null;
      active.promise = null;
    },
  });
})();
