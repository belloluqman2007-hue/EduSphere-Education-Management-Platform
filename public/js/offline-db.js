"use strict";
/* ============================================================================
   EduSphere — LOCAL-FIRST STORE (IndexedDB, zero dependencies)
   ----------------------------------------------------------------------------
   The browser/desktop/mobile shell keeps a complete, tenant-scoped working copy
   of the school on the device so the application keeps running with no
   internet at all:

     collections   every /api/sync/pull collection (students, attendance,
                   results, fees, Hifz, timetable, card credentials, …)
     meta          lastPullCursor, the cached /api/auth/me session snapshot,
                   the offline-unlock verifier, institution profile/features
     outbox        queued mutations waiting for connectivity
     id_map        local:<uuid> -> server id, so optimistic rows can be
                   reconciled after a successful push
     snapshots     last-known response for every cached GET (so a screen the
                   user has already opened renders offline even when we have no
                   dedicated resolver for it)

   TENANT ISOLATION ON A SHARED SCHOOL PC / TABLET
   -----------------------------------------------
   Every key is prefixed with a scope key derived from (madrasaId, userId):
       m<madrasaId>|u<userId>|collections|<collection>|<recordId>
   A scoped handle (`OpenScope`) is the ONLY way to touch data, and every read
   and every write goes through that handle's prefix. Two accounts sharing one
   browser therefore never see each other's cached rows — and `purge()` removes
   exactly one scope's data on sign-out.

   The module degrades gracefully to an in-memory backend when IndexedDB is not
   available (older WebViews, private-mode browsers, test environments). The
   memory backend implements the same contract, so callers never branch.
   ========================================================================== */
(function () {
  if (typeof window === "undefined") return;

  const DB_NAME = "edusphere_offline_v1";
  const DB_VERSION = 1;

  /* Collections written by /api/sync/pull (plus the ones the endpoints add on
     top of the documented contract: teachers, teacher_attendance,
     term_summaries, timetable_slots, grading_config, expenses…). */
  const COLLECTIONS = [
    "academic_sessions",
    "terms",
    "classes",
    "class_arms",
    "subjects",
    "class_subjects",
    "teacher_assignments",
    "grading_scales",
    "grading_config",
    "teachers",
    "students",
    "attendance",
    "staff_attendance",
    "teacher_attendance",
    "results",
    "term_summaries",
    "quran_progress",
    "fee_items",
    "fee_assignments",
    "fee_payments",
    "announcements",
    "homework",
    "timetable_entries",
    "timetable_slots",
    "card_credentials",
    "expense_categories",
    "expenses",
    "parent_links",
  ];

  const STORES = {
    collections: { key: "k", indexes: { by_scope: "s", by_scope_collection: ["s", "c"] } },
    meta: { key: "k", indexes: { by_scope: "s" } },
    outbox: { key: "clientMutationId", indexes: { by_scope: "s", by_scope_status: ["s", "status"] } },
    id_map: { key: "k", indexes: { by_scope: "s" } },
    snapshots: { key: "k", indexes: { by_scope: "s" } },
  };

  const STORE_NAMES = Object.keys(STORES);

  /* ------------------------------ small helpers -------------------------- */

  function nowMs() {
    return Date.now();
  }

  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    } catch (e) { /* fall through */ }
    const bytes = new Uint8Array(16);
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === "function") window.crypto.getRandomValues(bytes);
      else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    } catch (e) {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.prototype.map.call(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function isLocalId(value) {
    return typeof value === "string" && /^local:/.test(value);
  }

  function newLocalId(prefix) {
    return `local:${prefix ? prefix + "-" : ""}${uuid().slice(0, 18)}`;
  }

  /** Stable natural key for rows that carry no `id` (composite join tables). */
  function recordKey(row) {
    if (row === null || row === undefined) return "";
    if (row.id !== undefined && row.id !== null && row.id !== "") return String(row.id);
    const parts = [];
    for (const f of ["student_id", "class_id", "subject_id", "term_id", "day", "holder_type", "holder_id", "fee_item_id", "entry_date"]) {
      if (row[f] !== undefined && row[f] !== null && row[f] !== "") parts.push(`${f}=${row[f]}`);
    }
    if (parts.length) return `n:${parts.join("|")}`;
    let json = "";
    try { json = JSON.stringify(row); } catch (e) { json = String(row); }
    let h = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) {
      h ^= json.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return `h:${h.toString(16)}`;
  }

  function scopeKeyFor(madrasaId, userId) {
    const m = Number(madrasaId) || 0;
    const u = Number(userId) || 0;
    return `m${m}|u${u}`;
  }

  /* --------------------------- storage backends -------------------------- */

  function idbDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }

  function idbResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  /**
   * The real IndexedDB backend. Every method is promise-based and touches a
   * single store per transaction, which keeps the code portable across the
   * Chromium/WebKit/Gecko engines and the Electron/Capacitor WebViews.
   */
  function IdbBackend(db) {
    this.kind = "indexeddb";
    this.db = db;
  }
  IdbBackend.prototype.put = function (storeName, value) {
    const db = this.db;
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(storeName, "readwrite"); } catch (e) { return reject(e); }
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted"));
      try { tx.objectStore(storeName).put(value); } catch (e) { reject(e); }
    });
  };
  IdbBackend.prototype.putMany = function (storeName, values) {
    if (!values.length) return Promise.resolve(0);
    const db = this.db;
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(storeName, "readwrite"); } catch (e) { return reject(e); }
      tx.oncomplete = () => resolve(values.length);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB bulk write failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB bulk write aborted"));
      try {
        const os = tx.objectStore(storeName);
        for (const value of values) os.put(value);
      } catch (e) { reject(e); }
    });
  };
  IdbBackend.prototype.get = function (storeName, key) {
    let tx;
    try { tx = this.db.transaction(storeName, "readonly"); } catch (e) { return Promise.reject(e); }
    return idbResult(tx.objectStore(storeName).get(key)).then((v) => (v === undefined ? null : v));
  };
  IdbBackend.prototype.del = function (storeName, key) {
    const db = this.db;
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(storeName, "readwrite"); } catch (e) { return reject(e); }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB delete failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB delete aborted"));
      try { tx.objectStore(storeName).delete(key); } catch (e) { reject(e); }
    });
  };
  IdbBackend.prototype.all = function (storeName) {
    let tx;
    try { tx = this.db.transaction(storeName, "readonly"); } catch (e) { return Promise.reject(e); }
    return idbResult(tx.objectStore(storeName).getAll()).then((rows) => rows || []);
  };
  IdbBackend.prototype.allBy = function (storeName, indexName, key) {
    let tx;
    try { tx = this.db.transaction(storeName, "readonly"); } catch (e) { return Promise.reject(e); }
    const os = tx.objectStore(storeName);
    const index = os.index(indexName);
    const range = typeof window !== "undefined" && window.IDBKeyRange ? window.IDBKeyRange.only(key) : key;
    return idbResult(index.getAll(range)).then((rows) => rows || []);
  };
  IdbBackend.prototype.clearScope = function (scopeKey) {
    const db = this.db;
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE_NAMES, "readwrite"); } catch (e) { return reject(e); }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB purge failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB purge aborted"));
      const KeyRange = window.IDBKeyRange;
      for (const name of STORE_NAMES) {
        try {
          const index = tx.objectStore(name).index("by_scope");
          const cursorReq = index.openKeyCursor(KeyRange.only(scopeKey));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            tx.objectStore(name).delete(cursor.primaryKey);
            cursor.continue();
          };
        } catch (e) { /* a store without the index simply has nothing to clear */ }
      }
    });
  };

  /**
   * In-memory backend with the same contract — used when IndexedDB is blocked
   * (old WebView, private mode) or unavailable (jsdom). Data simply does not
   * survive a reload, which is exactly what "not supported" means here.
   */
  function MemoryBackend() {
    this.kind = "memory";
    this.tables = {};
    for (const name of STORE_NAMES) this.tables[name] = new Map();
  }
  MemoryBackend.prototype._table = function (name) {
    if (!this.tables[name]) this.tables[name] = new Map();
    return this.tables[name];
  };
  MemoryBackend.prototype.put = function (storeName, value) {
    this._table(storeName).set(value[STORES[storeName].key], value);
    return Promise.resolve(value);
  };
  MemoryBackend.prototype.putMany = function (storeName, values) {
    const table = this._table(storeName);
    for (const value of values) table.set(value[STORES[storeName].key], value);
    return Promise.resolve(values.length);
  };
  MemoryBackend.prototype.get = function (storeName, key) {
    const row = this._table(storeName).get(key);
    return Promise.resolve(row === undefined ? null : row);
  };
  MemoryBackend.prototype.del = function (storeName, key) {
    this._table(storeName).delete(key);
    return Promise.resolve(true);
  };
  MemoryBackend.prototype.all = function (storeName) {
    return Promise.resolve(Array.from(this._table(storeName).values()));
  };
  MemoryBackend.prototype.allBy = function (storeName, indexName, key) {
    const def = STORES[storeName].indexes[indexName];
    if (!def) return Promise.resolve([]);
    const wanted = Array.isArray(key) ? key : [key];
    const wantedJson = JSON.stringify(wanted);
    const rows = Array.from(this._table(storeName).values()).filter((row) => {
      const actual = Array.isArray(def) ? def.map((field) => row[field]) : [row[def]];
      return JSON.stringify(actual) === wantedJson;
    });
    return Promise.resolve(rows);
  };
  MemoryBackend.prototype.clearScope = function (scopeKey) {
    for (const name of STORE_NAMES) {
      const table = this._table(name);
      for (const [key, row] of Array.from(table.entries())) {
        if (row && row.s === scopeKey) table.delete(key);
      }
    }
    return Promise.resolve(true);
  };

  /** Opens (and on first run upgrades) the IndexedDB database. */
  function openDatabase() {
    return new Promise((resolve, reject) => {
      let factory = null;
      try { factory = window.indexedDB || null; } catch (e) { factory = null; }
      if (!factory) {
        const err = new Error("IndexedDB is not available");
        err.code = "IDB_UNAVAILABLE";
        return reject(err);
      }
      let request;
      try { request = factory.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORE_NAMES) {
          const def = STORES[name];
          let os;
          if (!db.objectStoreNames.contains(name)) os = db.createObjectStore(name, { keyPath: def.key });
          else os = request.transaction.objectStore(name);
          for (const [indexName, indexDef] of Object.entries(def.indexes || {})) {
            if (os.indexNames.contains(indexName)) continue;
            os.createIndex(indexName, indexDef, { unique: false });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open the offline database"));
      request.onblocked = () => reject(new Error("The offline database is blocked by another tab"));
    });
  }

  let backendPromise = null;
  function backend() {
    if (backendPromise) return backendPromise;
    backendPromise = openDatabase()
      .then((db) => new IdbBackend(db))
      .catch((error) => {
        // Degraded mode is still an offline-capable application for this
        // session; only durability across restarts is lost.
        try {
          if (typeof console !== "undefined" && console.warn) console.warn("[offline-db] IndexedDB unavailable, using memory store:", error && error.message);
        } catch (e) { /* console is optional */ }
        return new MemoryBackend();
      });
    return backendPromise;
  }

  /* --------------------------- the scoped handle ------------------------- */

  /**
   * A handle bound to exactly one (madrasaId, userId) pair. Callers get one via
   * `OfflineDB.openScope({ madrasaId, userId })`; nothing else can name a key.
   */
  function OfflineScope(store, madrasaId, userId) {
    this.scope = scopeKeyFor(madrasaId, userId);
    this.madrasaId = Number(madrasaId) || 0;
    this.userId = Number(userId) || 0;
    this.kind = store.kind;
    this._store = store;
    this._metaCache = null;
  }

  OfflineScope.prototype.scopeKey = function () { return this.scope; };

  /* ------------------------------- meta ---------------------------------- */

  OfflineScope.prototype.setMeta = function (key, value) {
    return this._store.put("meta", { k: `${this.scope}|${key}`, s: this.scope, key: String(key), value, updatedAt: nowMs() })
      .then(() => { this._metaCache = null; return value; });
  };
  OfflineScope.prototype.getMeta = function (key, fallback) {
    return this._store.get("meta", `${this.scope}|${key}`)
      .then((row) => (row && Object.prototype.hasOwnProperty.call(row, "value") ? row.value : (fallback === undefined ? null : fallback)));
  };
  OfflineScope.prototype.getMetaMap = function () {
    return this._store.allBy("meta", "by_scope", this.scope).then((rows) => {
      const out = {};
      for (const row of rows) out[row.key] = row.value;
      return out;
    });
  };

  /* ---------------------------- collections ------------------------------ */

  OfflineScope.prototype.putRecord = function (collection, row) {
    const record = Object.assign({}, row);
    return this._store.put("collections", {
      k: `${this.scope}|${collection}|${recordKey(record)}`,
      s: this.scope,
      c: collection,
      id: recordKey(record),
      row: record,
      updatedAt: nowMs(),
    }).then(() => record);
  };

  OfflineScope.prototype.putRecords = function (collection, rows) {
    if (!Array.isArray(rows) || !rows.length) return Promise.resolve(0);
    const values = rows
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        k: `${this.scope}|${collection}|${recordKey(row)}`,
        s: this.scope,
        c: collection,
        id: recordKey(row),
        row: Object.assign({}, row),
        updatedAt: nowMs(),
      }));
    return this._store.putMany("collections", values);
  };

  OfflineScope.prototype.getCollectionEntries = function (collection) {
    return this._store.allBy("collections", "by_scope_collection", [this.scope, collection]);
  };
  OfflineScope.prototype.getCollection = function (collection) {
    return this.getCollectionEntries(collection).then((entries) => entries.map((e) => e.row).filter(Boolean));
  };
  OfflineScope.prototype.getRecord = function (collection, id) {
    return this._store.get("collections", `${this.scope}|${collection}|${String(id)}`).then((entry) => (entry ? entry.row : null));
  };
  OfflineScope.prototype.deleteRecord = function (collection, id) {
    return this._store.del("collections", `${this.scope}|${collection}|${String(id)}`);
  };

  /**
   * Replaces a whole collection with the server's snapshot while KEEPING rows
   * that exist only on this device (optimistic `local:` records not yet pushed),
   * so a refresh can never make unsynced work disappear from the screen.
   */
  OfflineScope.prototype.replaceCollection = function (collection, rows) {
    const self = this;
    return this.getCollectionEntries(collection).then((entries) => {
      const keep = new Set();
      const incoming = new Set();
      for (const row of rows || []) incoming.add(recordKey(row));
      const pendingDeletes = entries
        .filter((entry) => !incoming.has(entry.id) && !(entry.row && (entry.row._pending || isLocalId(entry.row.id))))
        .map((entry) => {
          keep.add(entry.id);
          return self._store.del("collections", entry.k);
        });
      return Promise.all(pendingDeletes)
        .then(() => self.putRecords(collection, rows || []))
        .then(() => keep.size);
    });
  };

  /* ------------------------------- outbox -------------------------------- */

  OfflineScope.prototype.enqueueOutbox = function (item) {
    const record = Object.assign({}, item, {
      s: this.scope,
      scopeKey: this.scope,
      status: item && item.status ? item.status : "pending",
      createdAt: (item && item.createdAt) || nowMs(),
      attempts: (item && item.attempts) || 0,
    });
    if (!record.clientMutationId) record.clientMutationId = `cm-${uuid()}`;
    return this._store.put("outbox", record).then(() => record);
  };
  OfflineScope.prototype.getOutboxItem = function (clientMutationId) {
    return this._store.get("outbox", String(clientMutationId));
  };
  OfflineScope.prototype.listOutbox = function (filter) {
    return this._store.allBy("outbox", "by_scope", this.scope).then((rows) => {
      let list = rows.slice();
      if (filter && filter.status) {
        const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
        list = list.filter((row) => wanted.includes(row.status));
      }
      list.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      return list;
    });
  };
  OfflineScope.prototype.updateOutbox = function (clientMutationId, patch) {
    const self = this;
    return this.getOutboxItem(clientMutationId).then((row) => {
      if (!row) return null;
      const next = Object.assign({}, row, patch, { s: self.scope });
      return self._store.put("outbox", next).then(() => next);
    });
  };
  OfflineScope.prototype.removeOutbox = function (clientMutationId) {
    return this._store.del("outbox", String(clientMutationId));
  };
  OfflineScope.prototype.countOutbox = function () {
    return this.listOutbox().then((rows) => rows.length);
  };
  /** Removes applied items older than `maxAgeMs` so the store cannot grow forever. */
  OfflineScope.prototype.pruneOutbox = function (maxAgeMs) {
    const cutoff = nowMs() - (Number(maxAgeMs) || 7 * 86400000);
    const self = this;
    return this.listOutbox().then((rows) => {
      const old = rows.filter((row) => ["synced", "discarded"].includes(row.status) && Number(row.createdAt || 0) < cutoff);
      return Promise.all(old.map((row) => self._store.del("outbox", row.clientMutationId))).then(() => old.length);
    });
  };

  /* ------------------------------- id_map -------------------------------- */

  OfflineScope.prototype.setIdMap = function (localId, serverId, entity) {
    if (!localId || serverId === undefined || serverId === null || serverId === "") return Promise.resolve(null);
    const record = {
      k: `${this.scope}|${String(localId)}`,
      s: this.scope,
      localId: String(localId),
      serverId,
      entity: entity || "",
      updatedAt: nowMs(),
    };
    return this._store.put("id_map", record).then(() => record);
  };
  OfflineScope.prototype.getIdMap = function (localId) {
    return this._store.get("id_map", `${this.scope}|${String(localId)}`).then((row) => (row ? row.serverId : null));
  };
  OfflineScope.prototype.getIdMapEntries = function () {
    return this._store.allBy("id_map", "by_scope", this.scope);
  };
  OfflineScope.prototype.getIdMapObject = function () {
    return this.getIdMapEntries().then((rows) => {
      const out = {};
      for (const row of rows) {
        out[row.localId] = row.serverId;
        if (row.entity) out[`${row.entity}:${row.localId}`] = row.serverId;
      }
      return out;
    });
  };
  /** Resolves `local:` ids (and `entity:local:` keys) to real server ids. */
  OfflineScope.prototype.resolveId = function (value, entity) {
    if (!isLocalId(value)) return Promise.resolve(value);
    const direct = entity ? this.getIdMap(`${entity}:${value}`) : Promise.resolve(null);
    return direct.then((hit) => (hit !== null ? hit : this.getIdMap(value)));
  };

  /* ------------------------------ snapshots ------------------------------ */

  OfflineScope.prototype.putSnapshot = function (cacheKey, data) {
    return this._store.put("snapshots", {
      k: `${this.scope}|${cacheKey}`,
      s: this.scope,
      key: cacheKey,
      data,
      updatedAt: nowMs(),
    }).then(() => data);
  };
  OfflineScope.prototype.getSnapshot = function (cacheKey) {
    return this._store.get("snapshots", `${this.scope}|${cacheKey}`).then((row) => (row ? row.data : null));
  };
  OfflineScope.prototype.dropSnapshots = function (prefix) {
    const self = this;
    return this._store.allBy("snapshots", "by_scope", this.scope).then((rows) => {
      const doomed = prefix ? rows.filter((row) => String(row.key || "").indexOf(prefix) === 0) : rows;
      return Promise.all(doomed.map((row) => self._store.del("snapshots", row.k))).then(() => doomed.length);
    });
  };

  /* ------------------------------- lifecycle ----------------------------- */

  OfflineScope.prototype.describe = function () {
    return {
      scope: this.scope,
      madrasaId: this.madrasaId,
      userId: this.userId,
      backend: this.kind,
    };
  };

  /** Deletes EVERY row that belongs to this account/institution pair. */
  OfflineScope.prototype.purge = function () {
    this._metaCache = null;
    return this._store.clearScope(this.scope).then(() => true);
  };

  /* ------------------------------ public API ----------------------------- */

  const activeScopes = {};

  window.OfflineDB = {
    DB_NAME,
    DB_VERSION,
    COLLECTIONS,
    STORES,
    /** True when a durable database is actually available on this device. */
    isIndexedDBSupported() {
      try { return Boolean(window.indexedDB); } catch (e) { return false; }
    },
    backendKind() { return backendPromise ? backendPromise.then((b) => b.kind) : Promise.resolve("unknown"); },
    scopeKeyFor,
    recordKey,
    isLocalId,
    newLocalId,
    uuid,
    nowMs,
    /**
     * Opens (or reuses) the scoped handle for one signed-in account. Switching
     * accounts simply opens a different handle — the previous tenant's rows stay
     * behind their own prefix and are invisible to the new handle.
     */
    openScope(options) {
      const madrasaId = Number(options && options.madrasaId) || 0;
      const userId = Number(options && options.userId) || 0;
      const cacheKey = scopeKeyFor(madrasaId, userId);
      if (activeScopes[cacheKey]) return Promise.resolve(activeScopes[cacheKey]);
      return backend().then((store) => {
        if (!activeScopes[cacheKey]) {
          activeScopes[cacheKey] = new OfflineScope(store, madrasaId, userId);
        }
        return activeScopes[cacheKey];
      });
    },
    /** The last scope used in this session (set by sync-engine.js). */
    setActiveScope(scope) { window.OfflineDB._active = scope || null; return scope || null; },
    activeScope() { return window.OfflineDB._active || null; },
    clearActiveScope() { window.OfflineDB._active = null; return null; },
    /** Drops one scope completely (sign-out on a shared device). */
    purgeScope(options) {
      return window.OfflineDB.openScope(options).then((scope) => scope.purge().then(() => {
        delete activeScopes[scopeKeyFor(options && options.madrasaId, options && options.userId)];
        return true;
      }));
    },
    /** Test/diagnostics hook: forget open handles and the backend connection. */
    _reset() {
      for (const key of Object.keys(activeScopes)) delete activeScopes[key];
      backendPromise = null;
      window.OfflineDB._active = null;
    },
  };
})();
