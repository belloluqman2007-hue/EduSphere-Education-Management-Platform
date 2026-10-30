"use strict";
/* ============================================================================
   EduSphere — OFFLINE TRANSPORT INTERCEPTOR & OUTBOX SYNC ENGINE
   ----------------------------------------------------------------------------
   This is the layer that makes the product work when the internet does not.

   ONLINE
     • every request is handed to `onlineRequest()` from api.js (so the CSRF
       double-submit token, the device Bearer token and the retry logic all keep
       working exactly as before);
     • successful GETs are mirrored into the tenant-scoped IndexedDB store;
     • after sign-in (and every few minutes) an incremental `/api/sync/pull`
       refreshes the local copy;
     • queued Outbox mutations are flushed through `/api/sync/push` and their
       `local:<uuid>` ids are reconciled into real server ids everywhere they
       are referenced.

   OFFLINE
     • GETs are answered from the local store (cached responses plus live
       recomputations over the cached collections, so work done offline shows up
       immediately);
     • supported writes are recorded optimistically against `local:<uuid>` ids
       and queued in the Outbox — no request is attempted, no CSRF token is
       needed, and nothing is lost when the tab closes;
     • strictly online-only actions (AI chat, payment-gateway checkout, file
       uploads) refuse with a friendly, actionable message.

   SECURITY NOTES
     • No raw network call with a mutating method lives in this file: every write
       goes through window.API (see test/card-scanner-csrf.test.js).
     • Cached data is partitioned by (madrasaId, userId). Signing in as another
       account on a shared school PC opens a different scope; the previous
       tenant's rows stay behind their own key prefix.
     • A cold start with no internet needs an offline-unlock verifier that was
       minted at a real online sign-in: only a PBKDF2 digest and a random salt
       are stored, never the password.
   ========================================================================== */
(function () {
  if (typeof window === "undefined" || !window.API || !window.OfflineDB) return;

  const API = window.API;
  const DB = window.OfflineDB;

  const STATE_EVENT = "edusphere:sync-state";
  const DEVICE_ID_KEY = "edusphere.deviceId";
  const LAST_SCOPE_KEY = "edusphere.lastScope";
  const OFFLINE_ACCOUNTS_KEY = "edusphere.offlineAccounts";
  const SESSION_FLAG_KEY = "edusphere.offlineSession";
  const DEFAULT_PULL_INTERVAL_MS = 5 * 60 * 1000;
  const PUSH_BATCH_SIZE = 50;

  /* ------------------------------- state --------------------------------- */

  const state = {
    online: onlineNow(),
    scope: null,
    syncing: false,
    pulling: false,
    inFlight: 0,
    pending: 0,
    attention: 0,
    lastSyncedAt: null,
    lastError: "",
    unlocked: false,
    booted: false,
    pullIntervalMs: DEFAULT_PULL_INTERVAL_MS,
    lastPullCursor: "",
    account: null,
  };

  const listeners = new Set();
  let pullTimer = null;
  let pendingCleanup = [];

  /* ------------------------------ utilities ------------------------------ */

  /* A native shell knows better than `navigator.onLine`, which a WebView keeps
     stale when the radio drops. mobile-shell.js installs a probe backed by the
     real @capacitor/network listener; the browser keeps the old behaviour.
     (`var`, not `let`: `state.online` below is initialised during this same
     pass, before a `let` here would be initialised.) */
  var connectivityProbe = null;

  function onlineNow() {
    if (typeof connectivityProbe === "function") {
      try {
        const answer = connectivityProbe();
        if (answer !== null && answer !== undefined) return answer !== false;
      } catch (e) { /* a broken probe falls back to the browser answer */ }
    }
    try { return navigator.onLine !== false; } catch (e) { return true; }
  }

  function emit() {
    const snapshot = publicState();
    for (const fn of Array.from(listeners)) {
      try { fn(snapshot); } catch (e) { /* a listener must never break sync */ }
    }
    try {
      window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: snapshot }));
    } catch (e) { /* CustomEvent is optional */ }
  }

  function labelFor(snap) {
    // Only say "Syncing" while something is actually on the wire: a batch that
    // came back with conflicts must show the attention count, not "Syncing (0)".
    if (snap.syncing && snap.pending + snap.inFlight > 0) {
      return `Syncing (${snap.pending + snap.inFlight})…`;
    }
    if (snap.attention > 0) return `Sync Attention (${snap.attention})`;
    if (!snap.online) return "Offline · Saving Locally";
    if (snap.pending > 0) return `Online · ${snap.pending} Pending`;
    return "Online · Synced";
  }

  function publicState() {
    const snap = {
      online: state.online,
      syncing: state.syncing,
      pulling: state.pulling,
      inFlight: state.inFlight,
      pending: state.pending,
      attention: state.attention,
      lastSyncedAt: state.lastSyncedAt,
      lastError: state.lastError,
      unlocked: state.unlocked,
      backend: state.scope ? state.scope.kind : null,
      scope: state.scope ? state.scope.scope : "",
      madrasaId: state.scope ? state.scope.madrasaId : null,
      userId: state.scope ? state.scope.userId : null,
    };
    snap.label = labelFor(snap);
    return snap;
  }

  function parsePath(path) {
    const raw = String(path || "");
    const idx = raw.indexOf("?");
    const pathname = idx === -1 ? raw : raw.slice(0, idx);
    const query = {};
    if (idx !== -1) {
      const params = raw.slice(idx + 1).split("&");
      for (const pair of params) {
        if (!pair) continue;
        const eq = pair.indexOf("=");
        const key = eq === -1 ? pair : pair.slice(0, eq);
        const value = eq === -1 ? "" : pair.slice(eq + 1);
        try { query[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " ")); }
        catch (e) { query[key] = value; }
      }
    }
    return { pathname, query, full: raw };
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  function str(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function sameId(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return String(a) === String(b);
  }

  function isNetworkError(error) {
    if (!error) return false;
    if (error.offline) return false;
    // api.js.login() re-wraps a failed fetch with status 0; every other transport
    // failure arrives without a status at all. Both mean "the network is gone".
    if (error.status !== undefined && error.status !== null && Number(error.status) !== 0) return false;
    if (error.cause && Number(error.status) === 0) return true;
    const message = String(error.message || "");
    return error.name === "TypeError" || error.name === "AbortError" ||
      /failed to fetch|networkerror|network error|load failed|err_internet|offline|connection/i.test(message);
  }

  function OfflineError(message, code, extra) {
    const error = new Error(message);
    error.status = 0;
    error.offline = true;
    error.code = code || "OFFLINE";
    if (extra) Object.assign(error, extra);
    return error;
  }

  function readJsonStorage(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function writeJsonStorage(key, value) {
    try {
      if (value === null || value === undefined) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage may be disabled */ }
  }

  function deviceId() {
    /* The native bridge owns the stable per-installation id (Android/iOS ship
       it from the encrypted store), so sync records name the same device that
       `api.js` signed in with. Web builds keep the localStorage id. */
    try {
      const native = window.__EDUSPHERE_NATIVE__;
      if (native && typeof native.deviceId === "string" && native.deviceId) return native.deviceId;
    } catch (e) { /* non-native */ }
    const existing = (function () {
      try { return window.localStorage.getItem(DEVICE_ID_KEY) || ""; } catch (e) { return ""; }
    })();
    if (existing) return existing;
    const id = `web-${DB.uuid()}`;
    try { window.localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) { /* ignore */ }
    return id;
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function todayIso() {
    return isoNow().slice(0, 10);
  }

  /* --------------------------- password verifier -------------------------- */

  function bytesOf(text) {
    const s = String(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  function hexOf(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  function randomHex(byteLength) {
    const bytes = new Uint8Array(byteLength || 16);
    try {
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    } catch (e) {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return hexOf(bytes);
  }

  /**
   * PBKDF2-SHA256 via WebCrypto when the engine has it (every real browser,
   * Electron and Capacitor WebView does). A deliberately cheap — and clearly
   * labelled — fallback keeps very old WebViews able to use offline unlock.
   */
  function hashSecret(password, salt) {
    const subtle = window.crypto && window.crypto.subtle;
    if (subtle && typeof subtle.importKey === "function") {
      return subtle.importKey("raw", bytesOf(password), { name: "PBKDF2" }, false, ["deriveBits"])
        .then((key) => subtle.deriveBits(
          { name: "PBKDF2", salt: bytesOf(salt), iterations: 120000, hash: "SHA-256" },
          key,
          256
        ))
        .then((bits) => `pbkdf2$120000$${hexOf(bits)}`)
        .catch(() => `fnv1$${fnvIterated(password, salt)}`);
    }
    return Promise.resolve(`fnv1$${fnvIterated(password, salt)}`);
  }

  function fnvIterated(password, salt) {
    let h = 0x811c9dc5;
    const seed = `${salt}|${password}|${salt}`;
    for (let round = 0; round < 20000; round++) {
      const ch = seed.charCodeAt(round % seed.length) + (round & 0xff);
      h ^= ch;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0") + (seed.length * 2654435761 >>> 0).toString(16);
  }

  /* ------------------------------ scope boot ------------------------------ */

  function rememberScopeDescriptor(scope, extra) {
    writeJsonStorage(LAST_SCOPE_KEY, Object.assign({
      scope: scope.scope,
      madrasaId: scope.madrasaId,
      userId: scope.userId,
      savedAt: Date.now(),
    }, extra || {}));
  }

  function lastScopeDescriptor() {
    return readJsonStorage(LAST_SCOPE_KEY, null);
  }

  function registerOfflineAccount(scope, username) {
    const accounts = readJsonStorage(OFFLINE_ACCOUNTS_KEY, []);
    // Only the account identifiers live in localStorage; the verifier itself is
    // stored inside the scoped IndexedDB record.
    const clean = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.scope !== scope.scope);
    clean.push({
      scope: scope.scope,
      madrasaId: scope.madrasaId,
      userId: scope.userId,
      username: String(username || "").toLowerCase(),
      savedAt: Date.now(),
    });
    writeJsonStorage(OFFLINE_ACCOUNTS_KEY, clean.slice(-10));
  }

  function markSessionUnlocked(value) {
    state.unlocked = Boolean(value);
    try {
      if (value) window.sessionStorage.setItem(SESSION_FLAG_KEY, "1");
      else window.sessionStorage.removeItem(SESSION_FLAG_KEY);
    } catch (e) { /* private mode */ }
  }

  function isSessionUnlocked() {
    if (state.unlocked) return true;
    try { return window.sessionStorage.getItem(SESSION_FLAG_KEY) === "1"; } catch (e) { return false; }
  }

  /** Narrows an /auth/me payload into the cached session snapshot. */
  function sessionSnapshotFromMe(me) {
    if (!me || !me.loggedIn) return null;
    return {
      loggedIn: true,
      role: me.role || (me.user && me.user.role) || "",
      permissions: Array.isArray(me.permissions) ? me.permissions : [],
      madrasaId: me.madrasaId || null,
      category: me.category || null,
      institutionName: me.institutionName || "",
      institutionSlug: me.institutionSlug || "",
      verified: Boolean(me.verified),
      user: me.user || null,
      cachedAt: isoNow(),
    };
  }

  /** Opens the tenant+user scope for a signed-in session and syncs it. */
  async function connectSession(me, options) {
    if (!me || !me.loggedIn) return null;
    const userId = me.user && me.user.id;
    if (!userId) return null;
    const madrasaId = num(me.madrasaId, 0);
    if (state.scope && state.scope.madrasaId === madrasaId && state.scope.userId === num(userId, 0)) {
      return state.scope;
    }
    const scope = await DB.openScope({ madrasaId, userId });
    DB.setActiveScope(scope);
    state.scope = scope;
    state.account = me.user || null;
    if (me.loggedIn) markSessionUnlocked(true);
    const snapshot = sessionSnapshotFromMe(me);
    if (snapshot) {
      await scope.setMeta("session", snapshot);
      await scope.setMeta("sessionCachedAt", snapshot.cachedAt);
    }
    if (me.user && me.user.username) registerOfflineAccount(scope, me.user.username);
    rememberScopeDescriptor(scope, { username: (me.user && me.user.username) || "" });
    await refreshCounts();
    emit();
    if (!options || options.sync !== false) {
      // Fill the local store in the background; the UI never waits on it.
      setTimeout(() => { pullNow().catch(() => {}); }, 0);
    }
    return scope;
  }

  /** Restores the last used scope handle on boot (data stays locked until unlock). */
  async function restoreLastScope() {
    const descriptor = lastScopeDescriptor();
    if (!descriptor || !descriptor.scope) return null;
    try {
      const scope = await DB.openScope({ madrasaId: descriptor.madrasaId, userId: descriptor.userId });
      DB.setActiveScope(scope);
      state.scope = scope;
      await refreshCounts();
      return scope;
    } catch (e) {
      return null;
    }
  }

  async function refreshCounts() {
    if (!state.scope) {
      state.pending = 0;
      state.attention = 0;
      return;
    }
    try {
      const rows = await state.scope.listOutbox();
      state.pending = rows.filter((r) => r.status === "pending" || r.status === "syncing").length;
      state.attention = rows.filter((r) => r.status === "conflict" || r.status === "rejected").length;
    } catch (e) {
      state.pending = 0;
      state.attention = 0;
    }
  }

  function setOnline(value) {
    const online = Boolean(value);
    if (state.online === online) {
      emit();
      return;
    }
    state.online = online;
    if (!online) state.lastError = "";
    emit();
    if (online) {
      setTimeout(() => {
        flushOutbox().catch(() => {});
        pullNow().catch(() => {});
      }, 0);
    }
  }

  /* -------------------------------- pulling ------------------------------ */

  const COLLECTION_ALIASES = {
    teacher_attendance: ["staff_attendance"],
    timetable_slots: ["timetable_entries"],
    grading_config: ["grading_scales"],
  };

  function normaliseCollections(collections) {
    const out = [];
    if (!collections || typeof collections !== "object") return out;
    for (const [name, rows] of Object.entries(collections)) {
      if (!Array.isArray(rows)) continue;
      out.push([name, rows]);
      for (const alias of COLLECTION_ALIASES[name] || []) out.push([alias, rows]);
    }
    return out;
  }

  async function applyPull(scope, data, full) {
    if (!data || data.ok === false) return;
    const collections = normaliseCollections(data.collections);
    for (const [name, rows] of collections) {
      if (full) await scope.replaceCollection(name, rows);
      else await scope.putRecords(name, rows);
    }
    const cursor = str(data.serverCursor || data.serverTime || "");
    if (cursor) {
      state.lastPullCursor = cursor;
      await scope.setMeta("lastPullCursor", cursor);
    }
    const profile = data.profile || null;
    if (profile) {
      await scope.setMeta("profile", profile);
      await scope.setMeta("features", data.features || {});
      if (profile.institution) await scope.setMeta("institution", profile.institution);
      const session = {
        loggedIn: true,
        role: profile.role || "",
        permissions: Array.isArray(profile.permissions) ? profile.permissions : [],
        madrasaId: profile.madrasaId || null,
        category: profile.category || null,
        hifzEnabled: Boolean(profile.hifzEnabled),
        institutionName: (profile.institution && profile.institution.name_en) || "",
        institutionSlug: (profile.institution && profile.institution.slug) || "",
        user: profile.user || null,
        fromPull: true,
        cachedAt: isoNow(),
      };
      await scope.setMeta("session", session);
    }
    if (data.idMap && typeof data.idMap === "object") {
      for (const [key, serverId] of Object.entries(data.idMap)) {
        const idx = key.indexOf(":");
        const entity = idx === -1 ? "" : key.slice(0, idx);
        const localId = idx === -1 ? key : key.slice(idx + 1);
        if (localId) await scope.setIdMap(localId, serverId, entity);
      }
    }
    await scope.setMeta("lastPullAt", isoNow());
  }

  async function pullNow(options) {
    const opts = options || {};
    if (!state.scope) return { skipped: true, reason: "no-scope" };
    if (state.syncing && !opts.force) return { skipped: true, reason: "pushing" };
    if (state.pulling && !opts.force) return { skipped: true, reason: "pulling" };
    if (!onlineNow()) {
      setOnline(false);
      return { skipped: true, reason: "offline" };
    }
    state.pulling = true;
    emit();
    try {
      let since = opts.since;
      if (since === undefined) since = opts.full ? "" : str(await state.scope.getMeta("lastPullCursor", "") || state.lastPullCursor);
      const data = await API.sync.pull(since || undefined);
      await applyPull(state.scope, data, !since);
      state.online = true;
      state.lastSyncedAt = Date.now();
      state.lastError = "";
      await state.scope.setMeta("lastSyncedAt", state.lastSyncedAt);
      await runPendingCleanup();
      await refreshCounts();
      emit();
      return { ok: true, collections: Object.keys((data && data.collections) || {}), isIncremental: Boolean(since) };
    } catch (error) {
      if (isNetworkError(error)) {
        state.online = false;
        state.lastError = "Offline — showing the copy saved on this device.";
      } else {
        state.lastError = (error && error.message) || "Sync failed.";
      }
      emit();
      return { ok: false, error: state.lastError };
    } finally {
      state.pulling = false;
      emit();
    }
  }

  /* --------------------------------- push -------------------------------- */

  function mutationWire(item) {
    return {
      clientMutationId: item.clientMutationId,
      type: item.type,
      localId: item.localId || "",
      payload: item.payload || {},
      clientTimestamp: item.clientTimestamp || new Date(item.createdAt || Date.now()).toISOString(),
    };
  }

  const ENTITY_COLLECTIONS = {
    student: ["students", "attendance", "results", "quran_progress", "fee_payments", "fee_assignments", "term_summaries"],
    quran_progress: ["quran_progress"],
    fee_payment: ["fee_payments"],
    expense: ["expenses"],
    announcement: ["announcements"],
    attendance: ["attendance"],
    results: ["results"],
  };

  const FK_FIELDS = ["student_id", "holder_id", "recorded_by", "user_id"];

  /**
   * Rewrites every local reference to a freshly created server row: the row's
   * own key, any foreign key pointing at it, and the id_map itself. This is what
   * keeps the offline view and the server in agreement after a push.
   */
  async function applyServerId(scope, entity, localId, serverId) {
    if (!localId || serverId === undefined || serverId === null || serverId === "") return 0;
    const collections = ENTITY_COLLECTIONS[entity] || [];
    let touched = 0;
    for (const collection of collections) {
      const entries = await scope.getCollectionEntries(collection);
      for (const entry of entries) {
        const row = entry.row;
        if (!row) continue;
        let changed = false;
        const next = Object.assign({}, row);
        if (sameId(row.id, localId)) {
          next.id = serverId;
          next._pending = false;
          next._localId = localId;
          next._syncedAt = isoNow();
          changed = true;
          await scope.deleteRecord(collection, entry.id);
        } else if (row._localId && sameId(row._localId, localId) && sameId(row.id, localId)) {
          next.id = serverId;
          next._pending = false;
          changed = true;
          await scope.deleteRecord(collection, entry.id);
        }
        for (const field of FK_FIELDS) {
          if (sameId(row[field], localId)) {
            next[field] = serverId;
            changed = true;
          }
        }
        if (changed) {
          await scope.putRecord(collection, next);
          touched += 1;
        }
      }
    }
    await scope.setIdMap(localId, serverId, entity);
    return touched;
  }

  /** Defers removal of optimistic rows until after the refresh pull. */
  function scheduleCleanup(scope, item, result) {
    if (!item) return;
    pendingCleanup.push({ scope, item, result, at: Date.now() });
  }

  async function runPendingCleanup() {
    if (!pendingCleanup.length) return 0;
    const jobs = pendingCleanup;
    pendingCleanup = [];
    let removed = 0;
    for (const job of jobs) {
      try {
        const payload = job.item.payload || {};
        if (job.item.type === "attendance.mark" || job.item.type === "attendance.scan") {
          const day = str(payload.date || payload.day || "");
          const entries = await job.scope.getCollectionEntries("attendance");
          // The refresh pull has just delivered the server's own rows for this
          // day, so any optimistic row left over is a duplicate by definition
          // (its id may already have been rewritten to the server id, which is
          // exactly why matching on ids alone was not enough).
          for (const entry of entries) {
            const row = entry.row;
            if (!row || !DB.isLocalId(row.id)) continue;
            if (day && str(row.day) !== day) continue;
            await job.scope.deleteRecord("attendance", entry.id);
            removed += 1;
          }
        } else if (job.item.type === "teacher_attendance.mark") {
          const day = str(payload.date || "");
          const entries = await job.scope.getCollectionEntries("staff_attendance");
          for (const entry of entries) {
            const row = entry.row;
            if (!row || !DB.isLocalId(row.id)) continue;
            if (day && str(row.day) !== day) continue;
            await job.scope.deleteRecord("staff_attendance", entry.id);
            removed += 1;
          }
        } else if (job.item.type === "expense.create" && job.item.localId) {
          const existing = await job.scope.getRecord("expenses", job.item.localId);
          if (existing) {
            await job.scope.deleteRecord("expenses", job.item.localId);
            removed += 1;
          }
        } else if (job.item.type === "announcement.create" && job.item.localId) {
          const existing = await job.scope.getRecord("announcements", job.item.localId);
          if (existing) {
            await job.scope.deleteRecord("announcements", job.item.localId);
            removed += 1;
          }
        } else if (job.item.type === "results.upsert") {
          const entries = await job.scope.getCollectionEntries("results");
          for (const entry of entries) {
            const row = entry.row;
            if (!row || !DB.isLocalId(row.id)) continue;
            if (!sameId(row.term_id, payload.termId) || !sameId(row.subject_id, payload.subjectId)) continue;
            await job.scope.deleteRecord("results", entry.id);
            removed += 1;
          }
        } else if (job.item.type === "quran_progress.create") {
          const localId = job.item.localId;
          if (localId) {
            const existing = await job.scope.getRecord("quran_progress", localId);
            if (existing) {
              await job.scope.deleteRecord("quran_progress", localId);
              removed += 1;
            }
          }
        } else if (job.item.type === "fee_payment.record" && job.item.localId) {
          const existing = await job.scope.getRecord("fee_payments", job.item.localId);
          if (existing) {
            await job.scope.deleteRecord("fee_payments", job.item.localId);
            removed += 1;
          }
        }
      } catch (e) { /* cleanup is best effort; a stale local row is not data loss */ }
    }
    return removed;
  }

  async function handlePushResponse(scope, batch, response) {
    const results = (response && Array.isArray(response.results)) ? response.results : [];
    const byId = new Map(batch.map((item) => [item.clientMutationId, item]));
    const appliedItems = [];

    // Server-reported id map first (covers replays of earlier batches too).
    if (response && response.idMap && typeof response.idMap === "object") {
      for (const [key, serverId] of Object.entries(response.idMap)) {
        const idx = key.indexOf(":");
        const entity = idx === -1 ? "" : key.slice(0, idx);
        const localId = idx === -1 ? key : key.slice(idx + 1);
        if (localId) await scope.setIdMap(localId, serverId, entity);
      }
    }

    for (const result of results) {
      const item = byId.get(result.clientMutationId);
      if (!item) continue;
      const status = str(result.status || "rejected");
      if (status === "applied" || status === "duplicate") {
        if (result.serverId !== undefined && result.serverId !== null && item.localId) {
          await applyServerId(scope, item.entity || "", item.localId, result.serverId);
        }
        await scope.updateOutbox(item.clientMutationId, {
          status: "synced",
          syncedAt: Date.now(),
          error: "",
          serverRecord: result.data || null,
          attempts: num(item.attempts) + 1,
        });
        scheduleCleanup(scope, item, result.data || {});
        appliedItems.push(item);
      } else if (status === "conflict" || status === "rejected") {
        await scope.updateOutbox(item.clientMutationId, {
          status: status,
          error: str(result.error || "The server could not apply this change."),
          code: str(result.code || ""),
          serverRecord: result.data || (result.cardCode ? { cardCode: result.cardCode } : null) ||
            (result.studentIds ? { studentIds: result.studentIds } : null),
          attempts: num(item.attempts) + 1,
          resolvedAt: null,
        });
        // A rejected mutation will never succeed: drop its optimistic row so the
        // screen stops showing work the server refused.
        if (status === "rejected") await dropOptimistic(scope, item);
      }
    }

    // Anything the server did not answer (should not happen) stays pending.
    for (const item of batch) {
      if (results.some((r) => r.clientMutationId === item.clientMutationId)) continue;
      await scope.updateOutbox(item.clientMutationId, {
        status: "pending",
        error: "The server did not acknowledge this change; it will retry.",
        attempts: num(item.attempts) + 1,
      });
    }
    return appliedItems;
  }

  async function dropOptimistic(scope, item) {
    const payload = item.payload || {};
    if (item.type === "student.create" && item.localId) {
      await scope.deleteRecord("students", item.localId);
    } else if (item.type === "student.update") return;
    else if (item.type === "attendance.mark" || item.type === "attendance.scan") {
      const entries = await scope.getCollectionEntries("attendance");
      const day = str(payload.date || payload.day || "");
      for (const entry of entries) {
        if (entry.row && DB.isLocalId(entry.row.id) && (!day || str(entry.row.day) === day)) {
          await scope.deleteRecord("attendance", entry.id);
        }
      }
    } else if (item.type === "results.upsert") {
      const entries = await scope.getCollectionEntries("results");
      for (const entry of entries) {
        if (entry.row && DB.isLocalId(entry.row.id)) await scope.deleteRecord("results", entry.id);
      }
    } else if (item.type === "quran_progress.create" && item.localId) {
      await scope.deleteRecord("quran_progress", item.localId);
    } else if (item.type === "fee_payment.record" && item.localId) {
      await scope.deleteRecord("fee_payments", item.localId);
    } else if (item.type === "expense.create" && item.localId) {
      await scope.deleteRecord("expenses", item.localId);
    } else if (item.type === "announcement.create" && item.localId) {
      await scope.deleteRecord("announcements", item.localId);
    }
  }

  async function flushOutbox(options) {
    const opts = options || {};
    const scope = state.scope;
    if (!scope) return { ok: false, skipped: true, reason: "no-scope" };
    if (!onlineNow()) {
      setOnline(false);
      return { ok: false, skipped: true, reason: "offline" };
    }
    if (state.syncing) return { ok: false, skipped: true, reason: "busy" };
    state.syncing = true;
    state.lastError = "";
    emit();
    let pushed = 0;
    let conflicts = 0;
    try {
      for (let round = 0; round < 20; round++) {
        const all = await scope.listOutbox();
        const pending = all.filter((item) => item.status === "pending" || item.status === "syncing");
        if (!pending.length) break;
        const batch = pending.slice(0, PUSH_BATCH_SIZE);
        for (const item of batch) await scope.updateOutbox(item.clientMutationId, { status: "syncing" });
        state.inFlight = batch.length;
        await refreshCounts();
        emit();
        let response;
        try {
          response = await API.sync.push(batch.map(mutationWire), deviceId());
        } catch (error) {
          for (const item of batch) {
            await scope.updateOutbox(item.clientMutationId, {
              status: "pending",
              error: (error && error.message) || "Could not reach the server.",
              attempts: num(item.attempts) + 1,
            });
          }
          if (isNetworkError(error)) {
            state.online = false;
            state.lastError = "Offline — your changes are saved on this device.";
          } else {
            state.lastError = (error && error.message) || "Sync failed.";
          }
          break;
        }
        await handlePushResponse(scope, batch, response);
        state.inFlight = 0;
        pushed += batch.length;
        const summary = (response && response.summary) || {};
        conflicts += num(summary.conflict) + num(summary.rejected);
        await refreshCounts();
        emit();
        if (batch.length < PUSH_BATCH_SIZE) break;
      }
      if (pushed) {
        // Pull the server's version of what we just changed so the local copy
        // matches exactly and optimistic duplicates disappear. A FULL pull is
        // deliberate: several tables (attendance, staff attendance, Hifz rows)
        // do not stamp updated_at on insert, so an incremental cursor would
        // never return the row the server just created.
        await reconcileAfterPush(scope);
      }
      state.lastSyncedAt = Date.now();
      await scope.setMeta("lastPushAt", state.lastSyncedAt);
      await scope.pruneOutbox(7 * 86400000);
      await refreshCounts();
      return { ok: true, pushed, conflicts, pending: state.pending, attention: state.attention };
    } finally {
      state.syncing = false;
      state.inFlight = 0;
      await refreshCounts();
      emit();
    }
  }

  async function reconcileAfterPush(scope) {
    try {
      const data = await API.sync.pull(undefined);
      await applyPull(scope, data, true);
      await runPendingCleanup();
    } catch (e) {
      // The periodic pull retries; the Outbox already holds the truth.
      state.lastError = "Your changes were sent, but refreshing the saved copy failed. It will retry.";
    }
  }

  /* ---------------------------- conflict actions ------------------------- */

  async function listOutboxItems(filter) {
    if (!state.scope) return [];
    return state.scope.listOutbox(filter);
  }

  async function retryOutboxItem(clientMutationId) {
    if (!state.scope) return null;
    await state.scope.updateOutbox(clientMutationId, { status: "pending", error: "", code: "", resolvedAt: null });
    await refreshCounts();
    emit();
    if (onlineNow()) setTimeout(() => { flushOutbox().catch(() => {}); }, 0);
    return state.scope.getOutboxItem(clientMutationId);
  }

  /** "Accept server version": forget the local attempt and keep the server row. */
  async function discardOutboxItem(clientMutationId) {
    if (!state.scope) return null;
    const item = await state.scope.getOutboxItem(clientMutationId);
    if (!item) return null;
    await dropOptimistic(state.scope, item);
    await state.scope.updateOutbox(clientMutationId, { status: "discarded", resolvedAt: Date.now(), error: "" });
    await refreshCounts();
    emit();
    return item;
  }

  async function resolveConflict(clientMutationId, action) {
    if (action === "retry") return retryOutboxItem(clientMutationId);
    return discardOutboxItem(clientMutationId);
  }

  /* --------------------------- offline writes ---------------------------- */

  const ONLINE_ONLY = [
    { test: (p) => /^\/ai(\/|$)/.test(p), message: "EduSphere AI needs an internet connection. Everything else keeps working offline." },
    { test: (p) => /^\/payment(\/|$)/.test(p), message: "Card and bank checkout runs online only. You can still record a cash or transfer payment offline." },
    { test: (p) => /^\/fees\/payment(\/|$)/.test(p), message: "The payment gateway needs internet. Record the payment manually and it will sync later." },
    { test: (p) => /^\/support-chat(\/|$)/.test(p), message: "Live support chat needs an internet connection." },
    { test: (p) => /^\/platform(\/|$)/.test(p), message: "Platform administration needs an internet connection." },
    { test: (p) => /^\/backups(\/|$)/.test(p), message: "Backups run on the server and need an internet connection." },
    { test: (p) => /^\/exports(\/|$)/.test(p), message: "File exports are generated on the server and need an internet connection." },
    { test: (p) => /^\/public(\/|$)/.test(p), message: "This public form needs an internet connection to submit." },
  ];

  function onlineOnlyMessage(pathname) {
    for (const rule of ONLINE_ONLY) if (rule.test(pathname)) return rule.message;
    return "This action needs an internet connection. Your other work is saved on this device.";
  }

  function localIdFor(prefix) {
    return DB.newLocalId(prefix);
  }

  async function findPendingCreate(scope, type, localId) {
    const items = await scope.listOutbox();
    return items.find((item) => item.type === type && item.localId === localId && item.status === "pending") || null;
  }

  function planStudentCreate(body) {
    const payload = Object.assign({}, body || {});
    const localId = localIdFor("stu");
    const admissionNo = str(payload.admission_no || payload.admissionNo) || `OFF-${localId.slice(-6).toUpperCase()}`;
    const row = Object.assign({}, payload, {
      id: localId,
      admission_no: admissionNo,
      student_code: str(payload.student_code) || admissionNo,
      status: payload.status || "active",
      admission_date: payload.admission_date || todayIso(),
      class_id: payload.class_id !== undefined ? payload.class_id : (payload.classId !== undefined ? payload.classId : null),
      session_id: payload.session_id !== undefined ? payload.session_id : (payload.sessionId !== undefined ? payload.sessionId : null),
      created_at: isoNow(),
      _pending: true,
      _localId: localId,
      _offlineCreatedAt: isoNow(),
    });
    return {
      type: "student.create",
      entity: "student",
      localId,
      payload,
      optimistic: [{ collection: "students", row }],
      response: { ok: true, id: localId, admissionNo, studentCode: row.student_code, student: row, offline: true, queued: true },
    };
  }

  async function planStudentUpdate(scope, studentId, body) {
    const payload = Object.assign({}, body || {});
    const existing = await scope.getRecord("students", studentId);
    if (DB.isLocalId(studentId)) {
      const created = await findPendingCreate(scope, "student.create", studentId);
      if (created) {
        // Editing something that has never reached the server must not queue a
        // second mutation: fold it into the pending create.
        const merged = Object.assign({}, created.payload, payload);
        return {
          type: "student.create",
          entity: "student",
          localId: studentId,
          payload: merged,
          mergeInto: created.clientMutationId,
          optimistic: [{ collection: "students", row: Object.assign({}, existing, payload, { _pending: true }) }],
          response: { ok: true, id: studentId, student: Object.assign({}, existing, payload), offline: true, queued: true },
        };
      }
    }
    return {
      type: "student.update",
      entity: "student",
      localId: "",
      payload: Object.assign({ id: studentId }, payload),
      optimistic: existing ? [{ collection: "students", row: Object.assign({}, existing, payload, { _pending: true }) }] : [],
      response: { ok: true, id: studentId, student: Object.assign({}, existing || {}, payload), offline: true, queued: true },
    };
  }

  async function planAttendanceMark(scope, body) {
    const b = body || {};
    const classId = b.classId !== undefined ? b.classId : b.class_id;
    const date = str(b.date || b.day).slice(0, 10);
    const statuses = b.statuses && typeof b.statuses === "object" ? b.statuses : {};
    const notes = b.notes && typeof b.notes === "object" ? b.notes : {};
    const payload = {
      classId: classId,
      date,
      statuses,
      notes,
      termId: b.termId || b.term_id || null,
      sessionId: b.sessionId || b.session_id || null,
    };
    const optimistic = [];
    for (const [studentId, raw] of Object.entries(statuses)) {
      // The register sends either "present" or { status, note } per student.
      const value = raw && typeof raw === "object" ? raw : { status: raw };
      const status = str(value.status || "").toLowerCase();
      if (!status) continue;
      const id = `local:att-${date}-${studentId}`;
      optimistic.push({
        collection: "attendance",
        row: {
          id,
          student_id: studentId,
          class_id: classId,
          term_id: payload.termId,
          session_id: payload.sessionId,
          day: date,
          status,
          attendance_note: str(value.note || value.notes || notes[studentId] || ""),
          _pending: true,
          _localId: id,
          updated_at: isoNow(),
        },
      });
    }
    return {
      type: "attendance.mark",
      entity: "attendance",
      localId: "",
      payload,
      dedupeKey: `attendance.mark:${classId}:${date}`,
      optimistic,
      response: { ok: true, saved: Object.keys(statuses).length, classId, date, offline: true, queued: true },
    };
  }

  async function planAttendanceScan(scope, body) {
    const b = body || {};
    const code = str(b.code || b.card_code || b.card).trim().toLowerCase();
    const date = str(b.date || b.day || todayIso()).slice(0, 10);
    if (!code) throw OfflineError("Scan or type the card code to mark attendance.", "CARD_REQUIRED");
    const credentials = await scope.getCollection("card_credentials");
    const credential = credentials.find((row) => str(row.code).toLowerCase() === code);
    if (!credential) {
      throw OfflineError(
        "This card is not stored on this device. It may belong to another institution, or the card register has not been synced yet.",
        "CARD_NOT_CACHED",
        { status: 404 }
      );
    }
    const holderType = str(credential.holder_type) || "student";
    const holderId = credential.holder_id;
    const students = await scope.getCollection("students");
    const student = holderType === "student" ? students.find((row) => sameId(row.id, holderId)) : null;
    const status = str(b.status || "present").toLowerCase();
    const revoked = str(credential.status) !== "active";
    const view = {
      code,
      verdict: revoked ? "revoked" : (student && !["active", "promoted"].includes(str(student.status)) ? "inactive" : "valid"),
      valid: !revoked,
      holderType,
      name: student ? [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ") : "",
      identifier: student ? str(student.admission_no || student.student_code) : "",
      holderStatus: student ? str(student.status) : "",
      offline: true,
    };
    const optimistic = student ? [{
      collection: "attendance",
      row: {
        id: `local:att-${date}-${holderId}`,
        student_id: holderId,
        class_id: student.class_id,
        day: date,
        status,
        attendance_note: "Marked from offline ID card scan",
        _pending: true,
        _localId: `local:att-${date}-${holderId}`,
        updated_at: isoNow(),
      },
    }] : [];
    if (b.mark === false) {
      // A "check only" scanner block must never change a register.
      return { readOnly: true, response: { ok: true, marked: false, card: view, offline: true } };
    }
    return {
      type: "attendance.scan",
      entity: "attendance",
      localId: "",
      payload: { code, date, status, termId: b.termId || null, sessionId: b.sessionId || null },
      dedupeKey: `attendance.scan:${code}:${date}`,
      optimistic,
      response: {
        ok: true,
        marked: true,
        card: view,
        attendance: { status, day: date, classId: student ? student.class_id : null, className: "" },
        offline: true,
        queued: true,
      },
    };
  }

  async function planTeacherAttendanceMark(scope, body) {
    const b = body || {};
    const date = str(b.date || b.day || todayIso()).slice(0, 10);
    let entries;
    if (Array.isArray(b.entries)) entries = b.entries;
    else if (b.statuses && typeof b.statuses === "object") {
      // The staff register posts { statuses: { userId: { status, check_in… } } }.
      entries = Object.entries(b.statuses).map(([userId, value]) => Object.assign({ userId }, value && typeof value === "object" ? value : { status: value }));
    } else {
      entries = [{
        userId: b.userId || b.user_id,
        status: b.status,
        checkIn: b.checkIn || b.check_in,
        checkOut: b.checkOut || b.check_out,
        notes: b.notes || b.note,
      }];
    }
    const payload = { date, entries, termId: b.termId || null, sessionId: b.sessionId || null };
    const teacherNames = await scope.getCollection("teachers");
    const optimistic = entries.filter((e) => e && (e.userId || e.user_id)).map((entry) => {
      const uid = entry.userId || entry.user_id;
      const teacher = teacherNames.find((row) => sameId(row.id, uid)) || {};
      return {
        collection: "staff_attendance",
        row: {
          id: `local:tatt-${date}-${uid}`,
          user_id: uid,
          day: date,
          status: str(entry.status || "present").toLowerCase(),
          check_in: entry.checkIn || entry.check_in || "",
          check_out: entry.checkOut || entry.check_out || "",
          notes: entry.notes || entry.note || "",
          full_name: teacher.full_name || "",
          _pending: true,
          _localId: `local:tatt-${date}-${uid}`,
        },
      };
    });
    return {
      type: "teacher_attendance.mark",
      entity: "attendance",
      localId: "",
      payload,
      dedupeKey: `teacher_attendance.mark:${date}`,
      optimistic,
      response: { ok: true, saved: optimistic.length, date, offline: true, queued: true },
    };
  }

  async function planResultsUpsert(scope, body) {
    const b = body || {};
    const classId = b.classId !== undefined ? b.classId : b.class_id;
    const termId = b.termId !== undefined ? b.termId : b.term_id;
    const subjectId = b.subjectId !== undefined ? b.subjectId : b.subject_id;
    const entries = Array.isArray(b.entries) ? b.entries : (b.studentId !== undefined ? [b] : []);
    if (!classId || !termId || !subjectId || !entries.length) {
      throw OfflineError("Choose a class, term and subject before saving results.", "RESULTS_INCOMPLETE", { status: 400 });
    }
    const payload = {
      classId, termId, subjectId, entries,
      status: ["draft", "submitted"].includes(str(b.status)) ? str(b.status) : "draft",
    };
    const existing = await scope.getCollection("results");
    const optimistic = entries.map((entry) => {
      const studentId = entry.studentId !== undefined ? entry.studentId : entry.student_id;
      const ca = Number(entry.ca === "" || entry.ca == null ? 0 : entry.ca);
      const exam = Number(entry.exam === "" || entry.exam == null ? 0 : entry.exam);
      const match = existing.find((row) =>
        sameId(row.student_id, studentId) && sameId(row.term_id, termId) && sameId(row.subject_id, subjectId));
      const id = match ? match.id : `local:res-${termId}-${subjectId}-${studentId}`;
      return {
        collection: "results",
        row: Object.assign({}, match || {}, {
          id,
          student_id: studentId,
          class_id: classId,
          term_id: termId,
          subject_id: subjectId,
          ca,
          exam,
          total: Math.round((ca + exam) * 100) / 100,
          status: payload.status,
          _pending: true,
          _localId: DB.isLocalId(id) ? id : undefined,
          updated_at: isoNow(),
        }),
      };
    });
    return {
      type: "results.upsert",
      entity: "results",
      localId: "",
      payload,
      dedupeKey: `results.upsert:${classId}:${termId}:${subjectId}`,
      optimistic,
      response: { ok: true, updated: entries.length, status: payload.status, offline: true, queued: true },
    };
  }

  async function planQuranCreate(scope, body) {
    const b = body || {};
    const studentId = b.student_id !== undefined ? b.student_id : b.studentId;
    if (!studentId) throw OfflineError("Choose a student before saving Qur'an progress.", "QURAN_STUDENT_REQUIRED", { status: 400 });
    const localId = localIdFor("qp");
    const row = Object.assign({}, b, {
      id: localId,
      student_id: studentId,
      progress_date: str(b.progress_date || b.date || todayIso()).slice(0, 10),
      performance_status: b.performance_status || b.performanceStatus || "developing",
      _pending: true,
      _localId: localId,
      updated_at: isoNow(),
    });
    const students = await scope.getCollection("students");
    const student = students.find((s) => sameId(s.id, studentId));
    if (student) {
      row.first_name = student.first_name;
      row.last_name = student.last_name;
      row.admission_no = student.admission_no;
    }
    return {
      type: "quran_progress.create",
      entity: "quran_progress",
      localId,
      payload: Object.assign({}, b, { student_id: studentId }),
      optimistic: [{ collection: "quran_progress", row }],
      response: { ok: true, id: localId, record: row, offline: true, queued: true },
    };
  }

  async function planQuranUpdate(scope, recordId, body) {
    const existing = await scope.getRecord("quran_progress", recordId);
    if (DB.isLocalId(recordId)) {
      const created = await findPendingCreate(scope, "quran_progress.create", recordId);
      if (created) {
        return {
          type: "quran_progress.create",
          entity: "quran_progress",
          localId: recordId,
          payload: Object.assign({}, created.payload, body || {}),
          mergeInto: created.clientMutationId,
          optimistic: [{ collection: "quran_progress", row: Object.assign({}, existing, body, { _pending: true }) }],
          response: { ok: true, id: recordId, offline: true, queued: true },
        };
      }
    }
    return {
      type: "quran_progress.update",
      entity: "quran_progress",
      localId: "",
      payload: Object.assign({ id: recordId }, body || {}),
      optimistic: existing ? [{ collection: "quran_progress", row: Object.assign({}, existing, body, { _pending: true }) }] : [],
      response: { ok: true, id: recordId, offline: true, queued: true },
    };
  }

  async function planFeePayment(scope, body) {
    const b = body || {};
    const studentId = b.student_id !== undefined ? b.student_id : b.studentId;
    const amount = Number(b.amount_ngn !== undefined ? b.amount_ngn : b.amount);
    if (!studentId) throw OfflineError("Choose a student before recording a payment.", "PAYMENT_STUDENT_REQUIRED", { status: 400 });
    if (!Number.isFinite(amount) || amount <= 0) throw OfflineError("Enter a payment amount greater than zero.", "PAYMENT_AMOUNT_REQUIRED", { status: 400 });
    const localId = localIdFor("pay");
    const receipt = `OFFLINE-${Date.now().toString(36).toUpperCase()}`;
    const students = await scope.getCollection("students");
    const student = students.find((row) => sameId(row.id, studentId)) || {};
    const row = Object.assign({}, b, {
      id: localId,
      student_id: studentId,
      amount_ngn: amount,
      payment_date: str(b.payment_date || b.paymentDate || todayIso()).slice(0, 10),
      method: b.method || "cash",
      status: b.status || "successful",
      receipt_number: receipt,
      reference: b.reference || b.transaction_number || "",
      transaction_number: b.transaction_number || b.reference || "",
      admission_no: student.admission_no || "",
      first_name: student.first_name || "",
      last_name: student.last_name || "",
      _pending: true,
      _localId: localId,
      updated_at: isoNow(),
    });
    return {
      type: "fee_payment.record",
      entity: "fee_payment",
      localId,
      payload: Object.assign({}, b, { student_id: studentId, amount_ngn: amount }),
      optimistic: [{ collection: "fee_payments", row }],
      response: { ok: true, id: localId, receipt_number: receipt, status: row.status, amount_ngn: amount, offline: true, queued: true },
    };
  }

  async function planExpenseCreate(scope, body) {
    const b = body || {};
    const localId = localIdFor("exp");
    const row = Object.assign({}, b, {
      id: localId,
      amount_ngn: Number(b.amount_ngn !== undefined ? b.amount_ngn : b.amount) || 0,
      payment_date: str(b.payment_date || todayIso()).slice(0, 10),
      payment_method: b.payment_method || "cash",
      status: "draft",
      _pending: true,
      _localId: localId,
      created_at: isoNow(),
    });
    return {
      type: "expense.create",
      entity: "expense",
      localId,
      payload: b,
      optimistic: [{ collection: "expenses", row }],
      response: { ok: true, id: localId, status: "draft", offline: true, queued: true },
    };
  }

  async function planAnnouncementCreate(scope, body) {
    const b = body || {};
    const localId = localIdFor("ann");
    const row = Object.assign({}, b, {
      id: localId,
      title: b.title || "",
      body: b.body !== undefined ? b.body : (b.content || ""),
      audience: b.audience || "all",
      target_type: b.target_type || b.audience || "all",
      status: b.status || "published",
      is_active: 1,
      published_at: isoNow(),
      created_at: isoNow(),
      _pending: true,
      _localId: localId,
    });
    return {
      type: "announcement.create",
      entity: "announcement",
      localId,
      payload: b,
      optimistic: [{ collection: "announcements", row }],
      response: { ok: true, id: localId, announcement: row, offline: true, queued: true },
    };
  }

  /** Maps a REST call to a supported Outbox mutation, or null when unsupported. */
  async function planMutation(scope, method, path, body) {
    const { pathname } = parsePath(path);
    const methodUpper = String(method || "GET").toUpperCase();
    const b = body || {};
    if (body && typeof FormData !== "undefined" && body instanceof FormData) return null;

    if (methodUpper === "POST" && pathname === "/students") return planStudentCreate(b);
    if ((methodUpper === "PATCH" || methodUpper === "PUT") && /^\/students\/[^/]+$/.test(pathname)) {
      return planStudentUpdate(scope, decodeURIComponent(pathname.split("/")[2]), b);
    }
    if (methodUpper === "POST" && pathname === "/attendance/mark") return planAttendanceMark(scope, b);
    if (methodUpper === "POST" && pathname === "/attendance/scan") return planAttendanceScan(scope, b);
    if (methodUpper === "POST" && pathname === "/attendance/teachers/mark") return planTeacherAttendanceMark(scope, b);
    if ((methodUpper === "PUT" || methodUpper === "POST") && (pathname === "/results" || pathname === "/results/bulk")) {
      return planResultsUpsert(scope, b);
    }
    if (methodUpper === "POST" && pathname === "/quran-progress") return planQuranCreate(scope, b);
    if ((methodUpper === "PATCH" || methodUpper === "PUT") && /^\/quran-progress\/[^/]+$/.test(pathname)) {
      return planQuranUpdate(scope, decodeURIComponent(pathname.split("/")[2]), b);
    }
    if (methodUpper === "POST" && pathname === "/fees/payments") return planFeePayment(scope, b);
    if (methodUpper === "POST" && pathname === "/expenses") return planExpenseCreate(scope, b);
    if (methodUpper === "POST" && pathname === "/announcements") return planAnnouncementCreate(scope, b);
    return null;
  }

  /** Writes the optimistic rows and queues the mutation. */
  async function queueMutation(scope, plan) {
    // Fold repeated edits of the same thing into one queue entry.
    if (plan.dedupeKey) {
      const existing = (await scope.listOutbox()).find((item) =>
        item.dedupeKey === plan.dedupeKey && item.status === "pending");
      if (existing) {
        const mergedPayload = mergePayloads(existing.type, existing.payload, plan.payload);
        await scope.updateOutbox(existing.clientMutationId, { payload: mergedPayload, createdAt: existing.createdAt });
        await applyOptimistic(scope, plan);
        await refreshCounts();
        emit();
        return Object.assign({}, plan.response, { clientMutationId: existing.clientMutationId, merged: true });
      }
    }
    let clientMutationId = null;
    if (plan.mergeInto) {
      const target = await scope.getOutboxItem(plan.mergeInto);
      if (target) {
        clientMutationId = target.clientMutationId;
        await scope.updateOutbox(clientMutationId, { payload: plan.payload });
      }
    }
    if (!clientMutationId) {
      const item = await scope.enqueueOutbox({
        clientMutationId: `cm-${DB.uuid()}`,
        type: plan.type,
        localId: plan.localId || "",
        payload: plan.payload || {},
        createdAt: Date.now(),
        status: "pending",
        error: "",
        serverRecord: null,
        dedupeKey: plan.dedupeKey || "",
        entity: plan.entity || "",
        collection: plan.collection || "",
        clientTimestamp: isoNow(),
      });
      clientMutationId = item.clientMutationId;
    }
    await applyOptimistic(scope, plan);
    await refreshCounts();
    emit();
    return Object.assign({}, plan.response, { clientMutationId });
  }

  function mergePayloads(type, current, incoming) {
    const base = Object.assign({}, current || {});
    const next = Object.assign({}, incoming || {});
    if (type === "attendance.mark") {
      base.statuses = Object.assign({}, base.statuses || {}, next.statuses || {});
      base.notes = Object.assign({}, base.notes || {}, next.notes || {});
      return base;
    }
    if (type === "results.upsert") {
      const byStudent = new Map();
      for (const entry of (base.entries || [])) byStudent.set(String(entry.studentId !== undefined ? entry.studentId : entry.student_id), entry);
      for (const entry of (next.entries || [])) byStudent.set(String(entry.studentId !== undefined ? entry.studentId : entry.student_id), entry);
      base.entries = Array.from(byStudent.values());
      base.status = next.status || base.status;
      return base;
    }
    if (type === "teacher_attendance.mark") {
      const byUser = new Map();
      for (const entry of (base.entries || [])) byUser.set(String(entry.userId || entry.user_id), entry);
      for (const entry of (next.entries || [])) byUser.set(String(entry.userId || entry.user_id), entry);
      base.entries = Array.from(byUser.values());
      return base;
    }
    return Object.assign(base, next);
  }

  /* Which cached GET responses an offline write makes stale. Anything else
     keeps its snapshot so complex screens still open offline. */
  const SNAPSHOT_PREFIXES = {
    "student.create": ["GET /students"],
    "student.update": ["GET /students"],
    "attendance.mark": ["GET /attendance", "GET /madrasa/dashboard", "GET /portal/dashboard", "GET /students/"],
    "attendance.scan": ["GET /attendance", "GET /madrasa/dashboard", "GET /portal/dashboard", "GET /students/"],
    "teacher_attendance.mark": ["GET /attendance/teachers", "GET /madrasa/dashboard"],
    "results.upsert": ["GET /results", "GET /portal/results", "GET /students/"],
    "quran_progress.create": ["GET /quran-progress", "GET /students/"],
    "quran_progress.update": ["GET /quran-progress", "GET /students/"],
    "fee_payment.record": ["GET /fees", "GET /madrasa/dashboard", "GET /students/", "GET /portal/"],
    "expense.create": ["GET /expenses"],
    "announcement.create": ["GET /announcements", "GET /portal/announcements"],
  };

  async function applyOptimistic(scope, plan) {
    for (const change of plan.optimistic || []) {
      try {
        await scope.putRecord(change.collection, change.row);
      } catch (e) { /* the outbox remains the source of truth */ }
    }
    // Only the screens this change can affect need re-computing.
    for (const prefix of SNAPSHOT_PREFIXES[plan.type] || []) {
      try { await scope.dropSnapshots(prefix); } catch (e) { /* snapshots are optional */ }
    }
  }

  /* --------------------------- offline responses ------------------------- */

  async function respondOfflineWrite(scope, method, path, body) {
    const { pathname } = parsePath(path);
    let plan = null;
    try {
      plan = await planMutation(scope, method, path, body);
    } catch (error) {
      if (error && error.offline) throw error;
      plan = null;
    }
    if (!plan) {
      if (/^\/auth\/login/.test(pathname)) throw OfflineError("Sign-in needs an internet connection the first time.", "OFFLINE_LOGIN");
      throw OfflineError(onlineOnlyMessage(pathname), "OFFLINE_ONLY");
    }
    if (plan.readOnly) return plan.response;
    return queueMutation(scope, plan);
  }

  /* ------------------------------ reads ---------------------------------- */

  async function joinStudents(scope, rows) {
    const [classes, sessions] = await Promise.all([scope.getCollection("classes"), scope.getCollection("academic_sessions")]);
    const classById = new Map(classes.map((c) => [String(c.id), c]));
    const sessionById = new Map(sessions.map((s) => [String(s.id), s]));
    return rows.map((row) => {
      const cls = row.class_id ? classById.get(String(row.class_id)) : null;
      const session = row.session_id ? sessionById.get(String(row.session_id)) : null;
      return Object.assign({}, row, {
        class_en: cls ? cls.name_en : (row.class_en || ""),
        class_ar: cls ? cls.name_ar : (row.class_ar || ""),
        session_label: session ? session.label : (row.session_label || ""),
      });
    });
  }

  function matchesSearch(row, search, fields) {
    if (!search) return true;
    const needle = search.toLowerCase();
    return fields.some((field) => str(row[field]).toLowerCase().includes(needle));
  }

  async function offlineStudents(scope, query) {
    let rows = await joinStudents(scope, await scope.getCollection("students"));
    if (query.classId) rows = rows.filter((row) => sameId(row.class_id, query.classId));
    if (query.sessionId) rows = rows.filter((row) => sameId(row.session_id, query.sessionId));
    for (const field of ["status", "gender", "section", "program", "education_track"]) {
      if (query[field]) rows = rows.filter((row) => str(row[field]) === str(query[field]));
    }
    const search = str(query.search || query.q);
    if (search) rows = rows.filter((row) => matchesSearch(row, search, ["first_name", "last_name", "preferred_name", "admission_no", "student_code", "name_ar", "parent_name"]));
    rows.sort((a, b) => str(a.admission_no).localeCompare(str(b.admission_no)) || num(a.id) - num(b.id));
    const total = rows.length;
    const page = Math.max(1, num(query.page, 1));
    const perPage = Math.min(200, Math.max(1, num(query.perPage, 50)));
    const start = (page - 1) * perPage;
    return {
      students: rows.slice(start, start + perPage),
      total,
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      offline: true,
    };
  }

  async function offlineStudentStats(scope) {
    const students = await scope.getCollection("students");
    const count = (fn) => students.filter(fn).length;
    const statuses = {};
    for (const row of students) statuses[str(row.status) || "unknown"] = (statuses[str(row.status) || "unknown"] || 0) + 1;
    return {
      total: students.length,
      active: count((r) => ["active", "promoted"].includes(str(r.status))),
      newStudents: count((r) => str(r.admission_date) >= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)),
      graduated: count((r) => str(r.status) === "graduated"),
      withdrawn: count((r) => str(r.status) === "withdrawn"),
      statuses: Object.entries(statuses).map(([status, n]) => ({ status, count: n })),
      offline: true,
    };
  }

  async function offlineAttendanceRegister(scope, query) {
    const classId = query.classId;
    const day = str(query.date);
    if (!classId || !day) throw OfflineError("Choose a class and a date to open the register offline.", "ATTENDANCE_PARAMS", { status: 400 });
    const classes = await scope.getCollection("classes");
    const cls = classes.find((row) => sameId(row.id, classId)) || null;
    const students = (await scope.getCollection("students"))
      .filter((row) => sameId(row.class_id, classId) && ["active", "promoted", "suspended"].includes(str(row.status) || "active"))
      .sort((a, b) => str(a.admission_no).localeCompare(str(b.admission_no)));
    const marks = (await scope.getCollection("attendance")).filter((row) => sameId(row.class_id, classId) && str(row.day) === day);
    const byStudent = new Map(marks.map((m) => [String(m.student_id), m]));
    return {
      date: day,
      class: cls,
      termId: query.termId ? num(query.termId) : null,
      sessionId: query.sessionId ? num(query.sessionId) : null,
      students: students.map((student) => {
        const mark = byStudent.get(String(student.id));
        return Object.assign({}, student, mark
          ? { status: str(mark.status), attendance_note: str(mark.attendance_note), _pending: Boolean(mark._pending) }
          : { status: "", attendance_note: "" });
      }),
      offline: true,
    };
  }

  async function offlineResultsRoster(scope, query) {
    const classId = query.classId;
    const termId = query.termId;
    const subjectId = query.subjectId;
    if (!classId || !termId || !subjectId) {
      throw OfflineError("Choose a class, term and subject to open the results sheet offline.", "RESULTS_PARAMS", { status: 400 });
    }
    const [classes, subjects, students, results, grading] = await Promise.all([
      scope.getCollection("classes"),
      scope.getCollection("subjects"),
      scope.getCollection("students"),
      scope.getCollection("results"),
      scope.getCollection("grading_config"),
    ]);
    const cfg = grading[0] || {};
    const rows = students
      .filter((s) => sameId(s.class_id, classId) && ["active", "promoted", "suspended"].includes(str(s.status) || "active"))
      .sort((a, b) => str(a.admission_no).localeCompare(str(b.admission_no)))
      .map((student) => {
        const result = results.find((r) => sameId(r.student_id, student.id) && sameId(r.term_id, termId) && sameId(r.subject_id, subjectId));
        return {
          student_id: student.id,
          student_code: student.student_code || "",
          admission_no: student.admission_no,
          first_name: student.first_name,
          last_name: student.last_name,
          name_ar: student.name_ar,
          result_id: result ? result.id : null,
          ca: result ? (result.ca === null || result.ca === undefined ? "" : Number(result.ca)) : "",
          exam: result ? (result.exam === null || result.exam === undefined ? "" : Number(result.exam)) : "",
          total: result ? (result.total === null || result.total === undefined ? "" : Number(result.total)) : "",
          status: result ? (result.status || "draft") : "not_entered",
          grade: result ? result.grade || "" : "",
          _pending: Boolean(result && result._pending),
        };
      });
    return {
      class: classes.find((c) => sameId(c.id, classId)) || null,
      subject: subjects.find((s) => sameId(s.id, subjectId)) || null,
      students: rows,
      config: {
        caMax: num(cfg.ca_max, 40) || 40,
        examMax: num(cfg.exam_max, 60) || 60,
        passMark: num(cfg.pass_mark, 40) || 40,
        bands: cfg.bands || cfg.bands_json || [],
      },
      offline: true,
    };
  }

  async function offlineCardLookup(scope, code) {
    const clean = str(code).trim().toLowerCase();
    const credentials = await scope.getCollection("card_credentials");
    const credential = credentials.find((row) => str(row.code).toLowerCase() === clean);
    if (!credential) {
      const error = OfflineError("No card matches this code on this device.", "CARD_UNKNOWN", { status: 404 });
      error.verdict = "unknown";
      error.valid = false;
      throw error;
    }
    const isTeacher = str(credential.holder_type) === "teacher";
    const holders = isTeacher ? await scope.getCollection("teachers") : await scope.getCollection("students");
    const holder = holders.find((row) => sameId(row.id, credential.holder_id)) || null;
    const institution = (await scope.getMeta("institution", null)) || {};
    const classes = isTeacher ? [] : await scope.getCollection("classes");
    const cls = holder && holder.class_id ? classes.find((c) => sameId(c.id, holder.class_id)) : null;
    const revoked = str(credential.status) !== "active";
    const teacherStatus = str(holder && (holder.status || holder.profile_status));
    const holderActive = isTeacher
      ? Boolean(holder) && (teacherStatus === "active" || teacherStatus === "" || num(holder.is_active, 1) === 1)
      : Boolean(holder) && (str(holder.status) === "active" || str(holder.status) === "promoted");
    const verdict = revoked ? "revoked" : (!holder || !holderActive ? "inactive" : "valid");
    return {
      card: {
        code: str(credential.code),
        verdict,
        valid: verdict === "valid",
        holderType: isTeacher ? "teacher" : "student",
        name: holder ? [holder.first_name, holder.middle_name, holder.last_name].filter(Boolean).join(" ") || str(holder.full_name) : "",
        photoPath: (holder && holder.photo_path) || "",
        identifier: isTeacher ? str(holder && (holder.staff_id || holder.username)) : str(holder && (holder.admission_no || holder.student_code)),
        role: isTeacher ? str(holder && holder.position) || "Staff" : "Student",
        department: isTeacher ? str(holder && holder.department) : str(cls && cls.name_en),
        className: str(cls && cls.name_en),
        holderStatus: str(holder && holder.status),
        school: {
          name: str(institution.name_en),
          nameAr: str(institution.name_ar),
          logo: str(institution.logo_path),
          motto: str(institution.motto_en),
          city: str(institution.city),
          state: str(institution.state_name),
          phone: str(institution.phone),
        },
        offline: true,
      },
    };
  }

  async function offlineAnnouncements(scope, query) {
    let rows = await scope.getCollection("announcements");
    const audience = str(query.audience);
    if (audience) {
      rows = rows.filter((row) => ["all", "institution", audience].includes(str(row.audience)) ||
        ["all", "institution", audience].includes(str(row.target_type)));
    }
    if (str(query.status)) rows = rows.filter((row) => str(row.status) === str(query.status));
    const search = str(query.search);
    if (search) rows = rows.filter((row) => matchesSearch(row, search, ["title", "body"]));
    const limit = Math.min(200, Math.max(1, num(query.limit, 100)));
    rows.sort((a, b) => str(b.published_at || b.created_at).localeCompare(str(a.published_at || a.created_at)) || num(b.id) - num(a.id));
    return { announcements: rows.slice(0, limit), offline: true };
  }

  async function offlineFees(scope, pathname, query) {
    const payments = await scope.getCollection("fee_payments");
    const assignments = await scope.getCollection("fee_assignments");
    const items = await scope.getCollection("fee_items");
    const students = await scope.getCollection("students");
    if (pathname === "/fees/items") return { items, offline: true };
    if (pathname === "/fees/payments") {
      let rows = payments.slice();
      if (query.studentId) rows = rows.filter((row) => sameId(row.student_id, query.studentId));
      if (query.status) rows = rows.filter((row) => str(row.status) === str(query.status));
      if (query.from) rows = rows.filter((row) => str(row.payment_date) >= str(query.from));
      if (query.to) rows = rows.filter((row) => str(row.payment_date) <= str(query.to));
      rows.sort((a, b) => str(b.payment_date).localeCompare(str(a.payment_date)) || num(b.id) - num(a.id));
      return { payments: rows, offline: true };
    }
    if (pathname === "/fees/balance" || pathname === "/fees/outstanding") {
      const rows = students.map((student) => {
        const assigned = assignments.filter((a) => sameId(a.student_id, student.id));
        const totalFees = assigned.reduce((sum, a) => sum + num(a.amount_due), 0);
        const paid = payments
          .filter((p) => sameId(p.student_id, student.id) && str(p.status || "successful") === "successful")
          .reduce((sum, p) => sum + num(p.amount_ngn), 0);
        const outstanding = Math.max(0, totalFees - paid);
        return {
          student_id: student.id,
          admission_no: student.admission_no,
          first_name: student.first_name,
          last_name: student.last_name,
          class_name: "",
          total_fees: totalFees,
          amount_paid: paid,
          outstanding_balance: outstanding,
          status: outstanding > 0 ? "Outstanding" : "Cleared",
        };
      });
      const filtered = query.studentId ? rows.filter((row) => sameId(row.student_id, query.studentId)) : rows;
      return {
        students: filtered,
        outstanding: filtered.filter((row) => row.outstanding_balance > 0),
        billed: filtered.reduce((sum, row) => sum + row.total_fees, 0),
        billedTotal: filtered.reduce((sum, row) => sum + row.total_fees, 0),
        totalOutstanding: filtered.reduce((sum, row) => sum + row.outstanding_balance, 0),
        offline: true,
      };
    }
    const match = pathname.match(/^\/fees\/student\/([^/]+)$/);
    if (match) {
      const student = students.find((row) => sameId(row.id, match[1]));
      if (!student) throw OfflineError("That student is not stored on this device.", "STUDENT_NOT_CACHED", { status: 404 });
      const studentPayments = payments.filter((row) => sameId(row.student_id, student.id));
      const assigned = assignments.filter((row) => sameId(row.student_id, student.id));
      const totalFees = assigned.reduce((sum, a) => sum + num(a.amount_due), 0);
      const paid = studentPayments.filter((p) => str(p.status || "successful") === "successful").reduce((sum, p) => sum + num(p.amount_ngn), 0);
      return {
        student,
        assignedFees: assigned,
        payments: studentPayments,
        receipts: studentPayments.map((p) => p.receipt_number).filter(Boolean),
        totalFees,
        amountPaid: paid,
        outstandingBalance: Math.max(0, totalFees - paid),
        offline: true,
      };
    }
    return null;
  }

  async function offlineQuran(scope, pathname, query) {
    const records = await scope.getCollection("quran_progress");
    const students = await scope.getCollection("students");
    const byId = new Map(students.map((s) => [String(s.id), s]));
    const withNames = records.map((row) => {
      const student = byId.get(String(row.student_id)) || {};
      return Object.assign({}, row, {
        first_name: row.first_name || student.first_name || "",
        last_name: row.last_name || student.last_name || "",
        admission_no: row.admission_no || student.admission_no || "",
      });
    });
    withNames.sort((a, b) => str(b.progress_date).localeCompare(str(a.progress_date)) || num(b.id) - num(a.id));
    if (pathname === "/quran-progress/me") {
      const session = await scope.getMeta("session", {}) || {};
      const own = withNames.filter((row) => sameId(row.student_id, session.studentId) || sameId(row.student_id, query.studentId));
      return { records: own, offline: true };
    }
    if (pathname === "/quran-progress/overview") {
      return {
        total: withNames.length,
        students: new Set(withNames.map((row) => String(row.student_id))).size,
        recent: withNames.slice(0, 20),
        offline: true,
      };
    }
    let rows = withNames;
    if (query.studentId) rows = rows.filter((row) => sameId(row.student_id, query.studentId));
    if (query.status) rows = rows.filter((row) => str(row.performance_status) === str(query.status));
    const limit = Math.min(250, Math.max(1, num(query.limit, 100)));
    return { records: rows.slice(0, limit), offline: true };
  }

  async function offlineMadrasaDashboard(scope) {
    const [students, attendance, payments, results, announcements, institution] = await Promise.all([
      scope.getCollection("students"),
      scope.getCollection("attendance"),
      scope.getCollection("fee_payments"),
      scope.getCollection("results"),
      scope.getCollection("announcements"),
      scope.getMeta("institution", null),
    ]);
    const active = students.filter((row) => ["active", "promoted"].includes(str(row.status) || "active"));
    const today = todayIso();
    const todays = attendance.filter((row) => str(row.day) === today);
    const present = todays.filter((row) => str(row.status) === "present").length;
    const collected = payments
      .filter((row) => str(row.status || "successful") === "successful")
      .reduce((sum, row) => sum + num(row.amount_ngn), 0);
    return {
      institution: institution || null,
      students: { total: students.length, active: active.length },
      attendance: {
        today,
        marked: todays.length,
        present,
        rate: todays.length ? Math.round((present / todays.length) * 100) : 0,
      },
      finance: { collected, payments: payments.length },
      results: { records: results.length },
      announcements: { count: announcements.length },
      offline: true,
      body: "Saved copy of your institution — reconnect to refresh these figures.",
    };
  }

  async function offlinePortalMe(scope) {
    const session = await scope.getMeta("session", {}) || {};
    const profile = await scope.getMeta("profile", {}) || {};
    const children = await joinStudents(scope, await scope.getCollection("students"));
    const institution = profile.institution || null;
    const out = {
      role: (session.user && session.user.role) || profile.role || "",
      user: session.user || null,
      madrasa: institution ? {
        name_en: institution.name_en,
        name_ar: institution.name_ar,
        logo_path: institution.logo_path,
        motto_en: institution.motto_en,
        motto_ar: institution.motto_ar,
      } : null,
      children: children.map((child) => Object.assign({}, child, {
        classEn: child.class_en,
        classAr: child.class_ar,
      })),
      offline: true,
    };
    if (out.role === "student" && out.children.length) out.self = out.children[0];
    return out;
  }

  async function offlinePortalResults(scope, query) {
    const summaries = await scope.getCollection("term_summaries");
    const students = await scope.getCollection("students");
    const targetId = query.studentId ? query.studentId : (students[0] && students[0].id);
    const target = students.find((row) => sameId(row.id, targetId)) || students[0] || null;
    if (!target) throw OfflineError("No student record is stored on this device.", "PORTAL_NO_STUDENT", { status: 404 });
    const rows = summaries.filter((row) => sameId(row.student_id, target.id));
    return {
      student: {
        id: target.id,
        admissionNo: target.admission_no,
        name: `${str(target.first_name)} ${str(target.last_name)}`.trim(),
        nameAr: target.name_ar,
        classEn: target.class_en || "",
        classAr: target.class_ar || "",
      },
      terms: rows,
      offline: true,
    };
  }

  async function offlineTimetable(scope, pathname, query) {
    const slots = await scope.getCollection("timetable_entries");
    const classes = await scope.getCollection("classes");
    const subjects = await scope.getCollection("subjects");
    const classById = new Map(classes.map((c) => [String(c.id), c]));
    const subjectById = new Map(subjects.map((s) => [String(s.id), s]));
    const decorate = (row) => {
      const cls = classById.get(String(row.class_id)) || {};
      const subject = subjectById.get(String(row.subject_id)) || {};
      return Object.assign({}, row, {
        class_name: cls.name_en || "",
        subject_name: subject.name_en || "",
      });
    };
    let rows = slots.map(decorate);
    if (pathname === "/timetable/me") {
      const session = await scope.getMeta("session", {}) || {};
      const me = session.user && session.user.id;
      rows = rows.filter((row) => sameId(row.teacher_id, me));
    }
    if (query.classId) rows = rows.filter((row) => sameId(row.class_id, query.classId));
    if (query.day) rows = rows.filter((row) => str(row.day) === str(query.day));
    return { slots: rows, entries: rows, offline: true };
  }

  async function offlineHomework(scope, query) {
    let rows = await scope.getCollection("homework");
    if (query.classId) rows = rows.filter((row) => sameId(row.class_id, query.classId));
    if (query.subjectId) rows = rows.filter((row) => sameId(row.subject_id, query.subjectId));
    rows.sort((a, b) => str(b.due_date || b.created_at).localeCompare(str(a.due_date || a.created_at)));
    return { homework: rows, assignments: rows, items: rows, offline: true };
  }

  /**
   * The offline GET router. Returns a payload, or null to fall back to the
   * last cached response. Throws an OfflineError only when the answer is
   * genuinely required and unavailable.
   */
  async function resolveOfflineGet(scope, path) {
    const { pathname, query, full } = parsePath(path);
    const cached = async () => scope.getSnapshot(`GET ${full}`);

    if (pathname === "/auth/me") {
      const session = (await scope.getMeta("session", null)) || (await cached()) || null;
      if (!session || !session.loggedIn || !isSessionUnlocked()) {
        return { loggedIn: false, offline: true };
      }
      return Object.assign({}, session, { loggedIn: true, offline: true });
    }
    if (pathname === "/sync/status") {
      return {
        ok: true,
        syncVersion: 1,
        offline: true,
        pending: state.pending,
        attention: state.attention,
        lastSyncedAt: state.lastSyncedAt,
      };
    }
    if (pathname === "/auth/devices") {
      const snapshot = await cached();
      return Object.assign({ ok: true, devices: [] }, snapshot || {}, { offline: true });
    }
    if (pathname === "/students") return offlineStudents(scope, query);
    if (pathname === "/students/stats") return offlineStudentStats(scope);
    if (/^\/students\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split("/")[2]);
      const rows = await joinStudents(scope, await scope.getCollection("students"));
      const student = rows.find((row) => sameId(row.id, id));
      if (!student) return cached();
      const [results, attendance, payments, homework, summaries] = await Promise.all([
        scope.getCollection("results"),
        scope.getCollection("attendance"),
        scope.getCollection("fee_payments"),
        scope.getCollection("homework"),
        scope.getCollection("term_summaries"),
      ]);
      const base = (await cached()) || {};
      const paid = payments.filter((p) => sameId(p.student_id, student.id) && str(p.status || "successful") === "successful")
        .reduce((sum, p) => sum + num(p.amount_ngn), 0);
      return Object.assign({}, base, {
        student,
        results: results.filter((row) => sameId(row.student_id, student.id)),
        attendance: attendance.filter((row) => sameId(row.student_id, student.id)),
        payments: payments.filter((row) => sameId(row.student_id, student.id)),
        homework: homework.filter((row) => sameId(row.class_id, student.class_id)),
        terms: summaries.filter((row) => sameId(row.student_id, student.id)),
        finance: Object.assign({}, base.finance || {}, { paid }),
        offline: true,
      });
    }
    if (pathname === "/classes") {
      const rows = (await scope.getCollection("classes")).filter((row) => str(row.status) !== "archived");
      return { classes: rows, total: rows.length, page: 1, perPage: 50, totalPages: 1, offline: true };
    }
    if (pathname === "/subjects") return { subjects: await scope.getCollection("subjects"), offline: true };
    if (pathname === "/sessions") return { sessions: await scope.getCollection("academic_sessions"), offline: true };
    if (pathname === "/terms") return { terms: await scope.getCollection("terms"), offline: true };
    if (pathname === "/attendance") return offlineAttendanceRegister(scope, query);
    if (/^\/attendance\/student\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split("/")[3]);
      const attendance = (await scope.getCollection("attendance")).filter((row) => sameId(row.student_id, id));
      return { attendance, records: attendance, offline: true };
    }
    if (pathname === "/attendance/teachers") {
      return { attendance: await scope.getCollection("staff_attendance"), offline: true };
    }
    if (pathname === "/results/roster") return offlineResultsRoster(scope, query);
    if (pathname === "/results/class" || pathname === "/results/summary") {
      let rows = await scope.getCollection("results");
      if (query.classId) rows = rows.filter((row) => sameId(row.class_id, query.classId));
      if (query.termId) rows = rows.filter((row) => sameId(row.term_id, query.termId));
      if (query.subjectId) rows = rows.filter((row) => sameId(row.subject_id, query.subjectId));
      if (pathname === "/results/summary") {
        return { summaries: await scope.getCollection("term_summaries"), offline: true };
      }
      return { students: rows, results: rows, offline: true };
    }
    if (pathname === "/grading") return { config: (await scope.getCollection("grading_config"))[0] || null, offline: true };
    if (pathname === "/quran-progress" || pathname === "/quran-progress/me" || pathname === "/quran-progress/overview") {
      return offlineQuran(scope, pathname, query);
    }
    if (pathname === "/announcements" || pathname === "/portal/announcements") return offlineAnnouncements(scope, query);
    if (pathname.indexOf("/fees/") === 0) {
      const fees = await offlineFees(scope, pathname, query);
      if (fees) return fees;
      return cached();
    }
    if (pathname === "/portal/me") return offlinePortalMe(scope);
    if (pathname === "/portal/results") return offlinePortalResults(scope, query);
    if (/^\/portal\/results\/[^/]+$/.test(pathname)) {
      const termId = decodeURIComponent(pathname.split("/")[3]);
      let rows = (await scope.getCollection("results")).filter((row) => sameId(row.term_id, termId));
      if (query.studentId) rows = rows.filter((row) => sameId(row.student_id, query.studentId));
      return { results: rows, offline: true };
    }
    if (pathname === "/portal/assignments" || pathname === "/homework") return offlineHomework(scope, query);
    if (pathname === "/timetable" || pathname === "/timetable/me") return offlineTimetable(scope, pathname, query);
    if (pathname === "/madrasa/dashboard") {
      const computed = await offlineMadrasaDashboard(scope);
      const snapshot = await cached();
      return snapshot ? Object.assign({}, snapshot, computed, { offline: true, cachedAt: snapshot.cachedAt }) : computed;
    }
    if (/^\/public\/(verify-)?card\/[^/]+$/.test(pathname) || /^\/public\/card\/[^/]+$/.test(pathname)) {
      const code = decodeURIComponent(pathname.split("/").pop());
      return offlineCardLookup(scope, code);
    }
    if (/^\/documents\/card\/[^/]+\/[^/]+\/credential$/.test(pathname)) {
      const parts = pathname.split("/");
      const holderType = parts[3];
      const holderId = parts[4];
      const credentials = await scope.getCollection("card_credentials");
      const credential = credentials.find((row) => str(row.holder_type) === holderType && sameId(row.holder_id, holderId));
      return { ok: true, credential: credential || null, offline: true };
    }
    if (pathname === "/madrasa/profile") {
      const institution = await scope.getMeta("institution", null);
      return institution ? Object.assign({}, institution, { institution, profile: institution, offline: true }) : null;
    }
    // No dedicated resolver: the caller falls back to the last cached response.
    return null;
  }

  /* ---------------------------- the interceptor -------------------------- */

  const ONLINE_ONLY_GET = [
    /^\/exports(\/|$)/,
    /^\/ai(\/|$)/,
    /^\/backups(\/|$)/,
    /^\/platform(\/|$)/,
  ];

  async function cacheResponse(scope, path, data) {
    if (!data || typeof data !== "object") return;
    const { pathname, full } = parsePath(path);
    if (shouldSkipCache(path)) return;
    if (ONLINE_ONLY_GET.some((rule) => rule.test(pathname))) return;
    try {
      await scope.putSnapshot(`GET ${full}`, data);
      await scope.setMeta("lastCacheAt", isoNow());
    } catch (e) { /* caching is an optimisation, never a failure */ }
  }

  /* Which cached responses a successful ONLINE write invalidates. */
  const WRITE_INVALIDATION = [
    [/^\/students/, ["GET /students", "GET /madrasa/dashboard", "GET /portal/"]],
    [/^\/attendance/, ["GET /attendance", "GET /madrasa/dashboard", "GET /portal/", "GET /students/"]],
    [/^\/results/, ["GET /results", "GET /portal/results", "GET /students/"]],
    [/^\/quran-progress/, ["GET /quran-progress", "GET /students/"]],
    [/^\/fees|^\/expenses|^\/payroll/, ["GET /fees", "GET /expenses", "GET /madrasa/dashboard", "GET /students/", "GET /portal/"]],
    [/^\/announcements/, ["GET /announcements", "GET /portal/announcements"]],
    [/^\/timetable/, ["GET /timetable"]],
    [/^\/classes|^\/subjects|^\/sessions|^\/terms/, ["GET /classes", "GET /subjects", "GET /sessions", "GET /terms", "GET /students"]],
    [/^\/documents/, ["GET /documents"]],
    [/^\/madrasa/, ["GET /madrasa"]],
  ];

  async function invalidateWrittenPath(scope, pathname) {
    const prefixes = new Set();
    for (const [pattern, paths] of WRITE_INVALIDATION) {
      if (pattern.test(pathname)) for (const prefix of paths) prefixes.add(prefix);
    }
    if (!prefixes.size) prefixes.add("GET ");
    for (const prefix of prefixes) {
      try { await scope.dropSnapshots(prefix); } catch (e) { /* snapshots are optional */ }
    }
  }

  function shouldSkipCache(path) {
    const { pathname } = parsePath(path);
    if (/^\/auth\/(logout|change-password|reset-password|forgot-password)/.test(pathname)) return true;
    return false;
  }

  async function handleGetOnline(scope, path, onlineRequest) {
    const data = await onlineRequest();
    state.online = true;
    if (scope) await cacheResponse(scope, path, data);
    const { pathname } = parsePath(path);
    if (pathname === "/auth/me") {
      if (data && data.loggedIn) {
        markSessionUnlocked(true);
        // Connecting the scope is what starts the first pull.
        if (!state.scope || !sameId(state.scope.userId, data.user && data.user.id)) {
          connectSession(data, { sync: true }).catch(() => {});
        } else {
          state.scope.setMeta("session", sessionSnapshotFromMe(data)).catch(() => {});
        }
      } else if (state.scope) {
        markSessionUnlocked(false);
      }
    }
    if (pathname === "/auth/devices" && state.scope) {
      state.scope.putSnapshot("GET /auth/devices", data).catch(() => {});
    }
    return data;
  }

  async function handleGetOffline(scope, path) {
    if (!scope) {
      const { pathname } = parsePath(path);
      if (pathname === "/auth/me") return { loggedIn: false, offline: true };
      throw OfflineError("Sign in once while connected so this device can keep working offline.", "OFFLINE_NO_CACHE");
    }
    const data = await resolveOfflineGet(scope, path);
    if (data !== null && data !== undefined) return data;
    const { pathname, full } = parsePath(path);
    const snapshot = await scope.getSnapshot(`GET ${full}`);
    if (snapshot !== null && snapshot !== undefined) {
      return typeof snapshot === "object" && !Array.isArray(snapshot)
        ? Object.assign({}, snapshot, { offline: true, cached: true })
        : snapshot;
    }
    throw OfflineError(`“${pathname}” has not been saved on this device yet. Open it once while connected, then it works offline.`, "OFFLINE_CACHE_MISS");
  }

  /**
   * The single entry point registered with window.API. Everything the app does
   * — reads and writes — passes through here.
   */
  async function intercept(request) {
    const { method, path, body, onlineRequest } = request || {};
    const methodUpper = String(method || "GET").toUpperCase();
    const isWrite = methodUpper !== "GET" && methodUpper !== "HEAD";
    let scope = state.scope;
    const { pathname } = parsePath(path);

    if (!onlineNow()) setOnline(false);

    if (!state.online) {
      if (!isWrite) {
        return handleGetOffline(scope, path);
      }
      if (/^\/auth\/login/.test(pathname)) {
        throw OfflineError("Sign-in needs an internet connection the first time on this device.", "OFFLINE_LOGIN");
      }
      if (!scope) {
        throw OfflineError("Sign in once while connected so this device can save work offline.", "OFFLINE_NO_SCOPE");
      }
      return respondOfflineWrite(scope, methodUpper, path, body);
    }

    try {
      if (!isWrite) return await handleGetOnline(scope, path, onlineRequest);
      const data = await onlineRequest();
      state.online = true;
      if (scope) {
        // The screens this save touches are now stale; leave every other cached
        // screen alone so it still opens offline.
        await invalidateWrittenPath(scope, pathname);
        if (onlineNow()) setTimeout(() => { pullNow().catch(() => {}); }, 800);
      }
      return data;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      setOnline(false);
      if (!isWrite) return handleGetOffline(scope, path);
      if (!scope) throw OfflineError("Sign in once while connected so this device can save work offline.", "OFFLINE_NO_SCOPE");
      return respondOfflineWrite(scope, methodUpper, path, body);
    }
  }

  /* ---------------------------- offline unlock --------------------------- */

  async function rememberUnlockVerifier(scope, username, password) {
    if (!scope || !username || !password) return;
    const salt = randomHex(16);
    const hash = await hashSecret(password, salt);
    await scope.setMeta("offlineUnlock", {
      username: String(username).toLowerCase(),
      salt,
      hash,
      createdAt: isoNow(),
    });
    registerOfflineAccount(scope, username);
  }

  async function verifyOfflineUnlock(username, password) {
    const wanted = str(username).trim().toLowerCase();
    if (!wanted || !password) return null;
    const accounts = readJsonStorage(OFFLINE_ACCOUNTS_KEY, []);
    const candidates = (Array.isArray(accounts) ? accounts : []).filter((a) => a && str(a.username).toLowerCase() === wanted);
    const last = lastScopeDescriptor();
    if (last && last.username && str(last.username).toLowerCase() === wanted && !candidates.some((c) => c.scope === last.scope)) {
      candidates.push(last);
    }
    for (const candidate of candidates) {
      try {
        const scope = await DB.openScope({ madrasaId: candidate.madrasaId, userId: candidate.userId });
        const verifier = await scope.getMeta("offlineUnlock", null);
        if (!verifier || !verifier.hash) continue;
        const hash = await hashSecret(password, verifier.salt);
        if (hash !== verifier.hash) continue;
        const session = await scope.getMeta("session", null);
        if (!session || !session.loggedIn) continue;
        DB.setActiveScope(scope);
        state.scope = scope;
        state.account = session.user || null;
        markSessionUnlocked(true);
        rememberScopeDescriptor(scope, { username: wanted });
        await refreshCounts();
        emit();
        return {
          ok: true,
          offline: true,
          role: session.role || (session.user && session.user.role) || "",
          madrasaId: scope.madrasaId,
          category: session.category || null,
          institutionName: session.institutionName || "",
          permissions: session.permissions || [],
          user: session.user || { id: scope.userId, username: wanted },
        };
      } catch (e) { /* try the next saved account */ }
    }
    return null;
  }

  /* ------------------------------- boot ---------------------------------- */

  function registerServiceWorker() {
    // Native shells (Electron/Capacitor) serve their own assets; a service
    // worker is only meaningful for the browser build.
    if (window.__EDUSPHERE_NATIVE__) return;
    const nav = window.navigator;
    if (!nav || !("serviceWorker" in nav)) return;
    if (window.location && window.location.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname || "")) return;
    try {
      nav.serviceWorker.register("/sw.js").catch(() => { /* offline shell is optional */ });
    } catch (e) { /* registration must never break the app */ }
  }

  function startTimer() {
    if (pullTimer) return;
    pullTimer = setInterval(() => {
      if (!state.online || !state.scope || state.syncing || state.pulling) return;
      flushOutbox().catch(() => {}).then(() => pullNow().catch(() => {}));
    }, state.pullIntervalMs);
    try { if (pullTimer && typeof pullTimer.unref === "function") pullTimer.unref(); } catch (e) { /* browser timer */ }
  }

  async function boot(options) {
    if (state.booted && !(options && options.force)) return publicState();
    state.booted = true;
    /* Native: the Bearer token lives in the OS keychain and is read
       asynchronously at boot. Waiting for that prime means the very first
       `/auth/me` already carries it instead of racing a 401. */
    try {
      const mobile = window.__EDUSPHERE_MOBILE__;
      if (mobile && mobile.ready && typeof mobile.ready.then === "function") await mobile.ready;
    } catch (e) { /* the browser has no prime to wait for */ }
    state.online = onlineNow();
    await restoreLastScope().catch(() => {});
    try {
      window.addEventListener("online", () => setOnline(true));
      window.addEventListener("offline", () => setOnline(false));
    } catch (e) { /* non-browser environment */ }
    registerServiceWorker();
    startTimer();
    await refreshCounts();
    emit();
    return publicState();
  }

  // api.js is loaded before this file, so the wrapper below is the first and
  // only interception of the sign-in call.
  /* Signing out (or a server-side 401) must re-lock the cached workspace: the
     data stays on the device for the next offline unlock, but it is no longer
     readable without the password. */
  function lockSession(reason) {
    markSessionUnlocked(false);
    state.lastError = reason || state.lastError;
    emit();
  }

  const rawLogout = API.logout ? API.logout.bind(API) : null;
  if (rawLogout) {
    API.logout = async function wrappedLogout() {
      try {
        return await rawLogout();
      } finally {
        lockSession("");
      }
    };
  }

  const rawLogin = API.login.bind(API);
  API.login = async function wrappedLogin(username, password, remember, deviceOpts) {
    try {
      const result = await rawLogin(username, password, remember, deviceOpts);
      try {
        const me = await API.get("/auth/me");
        if (me && me.loggedIn) {
          const scope = await connectSession(me, { sync: true });
          if (scope) await rememberUnlockVerifier(scope, username, password);
        }
      } catch (e) { /* the pull retries on the next tick */ }
      return result;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      const unlocked = await verifyOfflineUnlock(username, password);
      if (unlocked) return unlocked;
      const saved = readJsonStorage(OFFLINE_ACCOUNTS_KEY, []);
      if (Array.isArray(saved) && saved.length) {
        throw OfflineError("You are offline. That password does not match the saved offline access on this device.", "OFFLINE_UNLOCK_FAILED");
      }
      throw OfflineError("You are offline and this device has no saved access yet. Connect to the internet and sign in once to enable offline mode.", "OFFLINE_FIRST_LOGIN");
    }
  };

  API.setTransportInterceptor(intercept);

  window.SyncEngine = {
    boot,
    state: publicState,
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      try { fn(publicState()); } catch (e) { /* ignore */ }
      return () => listeners.delete(fn);
    },
    isOnline: () => state.online,
    setOnline,
    /** mobile-shell.js points this at the real network listener. */
    setConnectivityProbe(fn) {
      connectivityProbe = typeof fn === "function" ? fn : null;
      return connectivityProbe !== null;
    },
    pullNow,
    flushOutbox,
    syncNow: async function () {
      if (!onlineNow()) {
        setOnline(false);
        return { ok: false, offline: true };
      }
      const flushed = await flushOutbox();
      const pulled = await pullNow({ force: true });
      return { ok: true, flushed, pulled };
    },
    listOutbox: listOutboxItems,
    conflicts: async function () {
      const rows = await listOutboxItems();
      return rows.filter((row) => row.status === "conflict" || row.status === "rejected");
    },
    resolveConflict,
    retryOutboxItem,
    discardOutboxItem,
    refreshCounts,
    /** Opens the tenant scope for a known session (used by tests/tools). */
    connectSession,
    /** Cold-start unlock used by the login form when the network is down. */
    verifyOfflineUnlock,
    offlineAccounts() { return readJsonStorage(OFFLINE_ACCOUNTS_KEY, []); },
    lastSyncedAt: () => state.lastSyncedAt,
    deviceId,
    /** Registers the interceptor again (after a test/teardown replaced it). */
    _reinstall() { API.setTransportInterceptor(intercept); },
    _config: state,
  };

  // Boot immediately: dashboard.js and app.js expect the interceptor to be in
  // place before they issue their first request.
  boot().catch(() => {});
})();
