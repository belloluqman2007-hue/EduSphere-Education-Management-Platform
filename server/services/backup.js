"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — backups (JSON snapshots) & one-click restore
   ----------------------------------------------------------------------------
   WHY THIS EXISTS
   Data that "disappears" is data written to storage the host is allowed to
   throw away (see services/persistence.js). Snapshots are the safety net:

     • the whole database is exported to one portable JSON document — works
       identically on SQLite and MySQL, and can be downloaded to a laptop
     • a snapshot is written before every migration, on a timer, on graceful
       shutdown and on demand from Platform → Backups
     • restoring is explicit (super admin, confirmed) and takes its own
       "before restore" snapshot first, so a restore can always be undone

   Format: { format: "madrasa-platform-backup/1", createdAt, counts, tables }
   ========================================================================== */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const config = require("../config");

const FORMAT = "madrasa-platform-backup/1";

/* Restore order: parents before children (MySQL enforces FKs even in a
   transaction), and the tenant table before anything that references it. */
const TABLE_ORDER = [
  "schema_migrations", "plans", "madaris", "users", "academic_sessions", "terms",
  "classes", "subjects", "class_subjects", "teacher_profiles", "teacher_documents",
  "teacher_status_history", "teacher_assignments", "students",
  "parent_links", "fee_items", "fee_payments", "grading_config", "results",
  "term_summaries", "attendance", "teacher_attendance",
  // Staff leave: the type catalogue must exist before the requests and
  // balances that reference it.
  "leave_types", "leave_requests", "leave_balances",
  "announcements", "settings", "platform_settings",
  "admission_requests", "teacher_applications", "teacher_application_history",
  "teacher_application_documents", "timetable_slots",
  // My Institution: albums before images, because an image may point at the
  // album that owns it (gallery_images.album_id).
  "website_pages", "gallery_albums", "gallery_images",
  // Expense & budget tables
  "expense_categories", "budgets", "expenses", "expense_receipts",
  "user_permissions", "sync_mutations", "activity_log",
];
/* Never part of a snapshot: login state is not data. */
const SKIP_TABLES = new Set(["app_sessions", "device_auth_tokens"]);

function stamp(d = new Date()) {
  // Milliseconds are part of the name on purpose: two snapshots taken in the
  // same second (a manual one right after the pre-migration one, a restore
  // safety copy followed by another) would otherwise overwrite each other and
  // silently lose one of them.
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 23);
}
function fileName(d, reason) {
  return "snapshot-" + stamp(d) + "-" + String(reason || "manual").replace(/[^a-z0-9-]/gi, "") + ".json";
}
async function ensureDir() {
  await fsp.mkdir(config.BACKUP_DIR, { recursive: true });
  return config.BACKUP_DIR;
}

/** All user tables in the live database (dialect-aware discovery). */
async function discoverTables(db) {
  const dialect = await db.dialect();
  let names;
  if (dialect === "sqlite") {
    const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    names = rows.map((r) => r.name);
  } else {
    const rows = await db.all("SHOW TABLES");
    names = rows.map((r) => Object.values(r)[0]);
  }
  const known = names.filter((n) => !SKIP_TABLES.has(n));
  const ordered = TABLE_ORDER.filter((t) => known.includes(t));
  const extra = known.filter((t) => !TABLE_ORDER.includes(t)).sort();
  return ordered.concat(extra);
}

/** Builds the snapshot object (also used for the download endpoint). */
async function buildSnapshot(db, meta = {}) {
  const tables = await discoverTables(db);
  const out = {};
  const counts = {};
  for (const t of tables) {
    const rows = await db.all("SELECT * FROM " + t);
    out[t] = rows;
    counts[t] = rows.length;
  }
  return {
    format: FORMAT,
    createdAt: new Date().toISOString(),
    reason: meta.reason || "manual",
    app: {
      driver: await db.dialect(),
      env: config.NODE_ENV,
      node: process.version,
      host: require("os").hostname(),
    },
    counts,
    tables: out,
  };
}

/** Writes a snapshot to BACKUP_DIR and prunes old ones. Returns its name. */
async function writeSnapshot(db, { reason = "manual", keep = config.BACKUP_KEEP } = {}) {
  const snapshot = await buildSnapshot(db, { reason });
  const dir = await ensureDir();
  const name = fileName(new Date(), reason);
  const file = path.join(dir, name);
  // Async write: a snapshot is the whole database as one JSON document, and
  // this runs on a timer / before migrations / on shutdown. A synchronous
  // write of tens of MB would freeze every live request for the duration.
  await fsp.writeFile(file, JSON.stringify(snapshot));
  await prune(keep);
  const bytes = (await fsp.stat(file)).size;
  return { name, path: file, bytes, counts: snapshot.counts };
}

/** Keeps the newest `keep` snapshots (never deletes a "pre-restore"/"pre-migration"). */
async function prune(keep = config.BACKUP_KEEP) {
  const dir = await ensureDir();
  const all = await list();
  const prunable = all.filter((f) => !/pre-(restore|migration)/.test(f.name));
  let removed = 0;
  for (const f of prunable.slice(Math.max(0, keep))) {
    try { await fsp.unlink(path.join(dir, f.name)); removed++; } catch (e) { /* ignore */ }
  }
  return removed;
}

function safeName(name) {
  const n = path.basename(String(name || ""));
  if (!/^snapshot-[A-Za-z0-9._-]+\.json$/.test(n)) return null;
  return n;
}

/** Newest first. */
async function list() {
  const dir = await ensureDir();
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch (e) { return []; }
  const out = [];
  for (const name of entries.filter(safeName)) {
    const file = path.join(dir, name);
    try {
      const st = await fsp.stat(file);
      let counts = null;
      let createdAt = st.mtime.toISOString();
      // The writer's key order puts counts BEFORE the (huge) tables blob, so
      // the header of the file is enough for the listing. Reading whole
      // snapshots here would block the event loop on every admin page view
      // once snapshots grow to tens of MB.
      const fh = await fsp.open(file, "r");
      try {
        const head = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await fh.read(head, 0, HEAD_BYTES, 0);
        const text = head.toString("utf8", 0, bytesRead);
        const m = /"createdAt"\s*:\s*"([^"]+)"/.exec(text);
        if (m) createdAt = m[1];
        const c = /"counts"\s*:\s*\{([^{}]*)\}/.exec(text);
        if (c) {
          counts = {};
          for (const pair of c[1].split(",")) {
            const kv = /^\s*"([^"]+)"\s*:\s*(\d+)\s*$/.exec(pair);
            if (kv) counts[kv[1]] = Number(kv[2]);
          }
        }
      } finally {
        await fh.close();
      }
      out.push({ name, bytes: st.size, createdAt, counts, path: file });
    } catch (e) { /* unreadable entry: skip it rather than fail the listing */ }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

const HEAD_BYTES = 256 * 1024;

function readSnapshot(name) {
  const n = safeName(name);
  if (!n) throw Object.assign(new Error("Invalid backup file name."), { status: 400 });
  const file = path.join(config.BACKUP_DIR, n);
  return fsp.access(file)
    .then(() => fsp.readFile(file, "utf8"))
    .then((text) => {
      const parsed = JSON.parse(text);
      if (!parsed || parsed.format !== FORMAT) throw Object.assign(new Error("Unrecognised backup format."), { status: 400 });
      return parsed;
    })
    .catch((e) => {
      if (e && e.status) throw e;
      throw Object.assign(new Error("Backup file not found."), { status: 404 });
    });
}

/**
 * Replaces the whole database with a snapshot.
 * `dryRun` returns what WOULD change. Restoring takes a safety snapshot first.
 */
async function restore(db, source, { dryRun = false } = {}) {
  const snapshot = typeof source === "string" ? await readSnapshot(source) : source;
  if (!snapshot || snapshot.format !== FORMAT) throw Object.assign(new Error("Unrecognised backup format."), { status: 400 });
  const liveTables = await discoverTables(db);
  const wanted = Object.keys(snapshot.tables || {});
  const plan = {
    wouldReplace: wanted.filter((t) => (snapshot.tables[t] || []).length),
    wouldClear: liveTables.filter((t) => !(t in (snapshot.tables || {}))),
    unknown: wanted.filter((t) => !liveTables.includes(t)),
    counts: snapshot.counts || {},
  };
  if (dryRun) return Object.assign({ ok: true, dryRun: true }, plan);

  if (plan.unknown.length) {
    // A backup from a newer app version may contain tables this build does not
    // know about; refuse rather than silently dropping that data.
    throw Object.assign(new Error("Backup contains tables this version does not know: " + plan.unknown.join(", ")), { status: 409 });
  }

  const safety = await writeSnapshot(db, { reason: "pre-restore", keep: 50 });

  // Order: delete children first, insert parents first.
  const deleteOrder = liveTables.slice().reverse();
  const insertOrder = TABLE_ORDER.filter((t) => wanted.includes(t)).concat(wanted.filter((t) => !TABLE_ORDER.includes(t)).sort());
  const dialect = await db.dialect();

  // Table order keeps referential integrity satisfied without disabling FK
  // checks: children are cleared before parents, parents refilled first.
  await db.transaction(async (tx) => {
    for (const t of deleteOrder) await tx.run("DELETE FROM " + t);
    for (const t of insertOrder) {
      const rows = snapshot.tables[t] || [];
      for (const row of rows) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        const vals = cols.map((c) => (row[c] && typeof row[c] === "object" && !(row[c] instanceof Date) ? JSON.stringify(row[c]) : row[c] instanceof Date ? row[c].toISOString().slice(0, 19).replace("T", " ") : row[c]));
        const ph = cols.map(() => "?").join(",");
        const quoted = dialect === "mysql" ? cols.map((c) => "`" + c + "`") : cols.map((c) => '"' + c + '"');
        await tx.run(`INSERT INTO ${t} (${quoted.join(",")}) VALUES (${ph})`, vals);
      }
    }
  });

  return { ok: true, restored: plan.wouldReplace, cleared: plan.wouldClear, safetySnapshot: safety.name, counts: snapshot.counts };
}

/** Imports a snapshot document from disk/JSON text without touching the DB. */
function parseJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw Object.assign(new Error("That file is not valid JSON."), { status: 400 }); }
  if (!parsed || parsed.format !== FORMAT) {
    throw Object.assign(new Error("Not a platform backup (expected format " + FORMAT + ")."), { status: 400 });
  }
  return parsed;
}

/* ------------------------------- timers --------------------------------- */
let timer = null;

/** Starts the periodic snapshot + snapshot-on-shutdown behaviour. */
function startAutoBackup(db) {
  const minutes = Number(config.BACKUP_INTERVAL_MINUTES || 0);
  if (minutes > 0 && !timer) {
    timer = setInterval(() => {
      writeSnapshot(db, { reason: "scheduled" })
        .then((r) => console.log("Backup written: " + r.name + " (" + r.bytes + " bytes)"))
        .catch((e) => console.error("Scheduled backup failed:", e.message));
    }, minutes * 60 * 1000);
    if (timer.unref) timer.unref();
  }
  return () => stopAutoBackup();
}

function stopAutoBackup() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Snapshot taken before migrations (and whenever we are about to mutate data). */
async function snapshotBefore(db, reason) {
  try {
    // Nothing worth saving in a database that has no tables yet.
    const tables = await discoverTables(db).catch(() => []);
    if (!tables.length) return null;
    return await writeSnapshot(db, { reason, keep: 20 });
  } catch (e) {
    console.error("Snapshot (" + reason + ") failed:", e.message);
    return null;
  }
}

module.exports = {
  FORMAT,
  TABLE_ORDER,
  buildSnapshot,
  writeSnapshot,
  snapshotBefore,
  list,
  readSnapshot,
  restore,
  parseJson,
  prune,
  discoverTables,
  startAutoBackup,
  stopAutoBackup,
};
