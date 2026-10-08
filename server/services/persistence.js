"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — storage persistence probe
   ----------------------------------------------------------------------------
   WHY THIS EXISTS
   "I added a madrasa and some time later it was just gone" is never the app
   forgetting: it is the HOST forgetting. On Render/Railway/Fly/Docker the
   container filesystem is thrown away on every deploy and on many restarts,
   so a SQLite file (or an uploads folder) that lives outside a mounted volume
   is simply not there any more.

   This module answers three questions reliably:
     1. Is my data directory on a real mounted volume?     (/proc/mounts)
     2. Has this volume survived a restart?                (marker file)
     3. Am I running an external database at all?          (mysql driver)

   The answers are logged at boot, exposed through
   GET /api/platform/diagnostics and shown as a banner in the super-admin UI.
   ========================================================================== */
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../config");
const { findMountFor, durabilityOf, REAL_DEVICE } = require("./mounts");

const MARKER_NAME = ".platform-state.json";
/* The tables "did I lose data?" is really about. An empty one of these with a
   non-empty snapshot on disk is an accident, not a fresh install. */
const COUNTED_TABLES = ["madaris", "users", "students", "results"];

/* Where the Render disk is missing, the storage warnings name the fix. */
function renderDiskHint() {
  return config.IS_RENDER
    ? " On Render: Dashboard → this service → Disks → add a disk with mount path " +
      config.PERSISTENT_VOLUME_DIR + ", then redeploy."
    : "";
}

/**
 * True when `dir` looks like durable storage: a mounted volume whose fs is
 * not a known-throwaway type, or (non-Linux dev hosts) simply an existing
 * writable directory on the developer's own disk.
 */
function describeStorage(dir) {
  const out = {
    dir,
    exists: false,
    writable: false,
    mountPoint: null,
    fsType: null,
    device: null,
    onPersistentVolume: null, // null = unknown (non-Linux)
    checks: [],
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    out.exists = true;
  } catch (e) {
    out.checks.push("directory cannot be created: " + e.message);
  }
  try {
    const probe = path.join(dir, ".write-test-" + process.pid);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    out.writable = true;
  } catch (e) {
    out.checks.push("directory is not writable: " + e.message);
  }
  const mount = findMountFor(path.resolve(dir));
  if (mount) {
    out.mountPoint = mount.mountPoint;
    out.fsType = mount.fstype;
    out.device = mount.device;
    // A real block device is durable even when it is mounted at / — that is a
    // plain VPS, not a throwaway container. Overlay/tmpfs/9p at / is the case
    // that eats people's databases.
    out.onRealDevice = REAL_DEVICE.test(String(mount.device || ""));
    out.onPersistentVolume = durabilityOf(mount);
    if (!out.onPersistentVolume) {
      if (!mount.root) out.checks.push("directory is on the container root filesystem (/) — wiped on every deploy");
      else out.checks.push("mounted filesystem type '" + mount.fstype + "' is ephemeral");
    }
  }
  return out;
}

/** Reads + bumps the state marker inside the data dir (proves the volume survives restarts). */
function touchMarker(info) {
  const file = path.join(config.DATA_DIR, MARKER_NAME);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { prev = null; }
  const next = {
    firstSeenAt: (prev && prev.firstSeenAt) || new Date().toISOString(),
    bootCount: ((prev && Number(prev.bootCount)) || 0) + 1,
    lastBootAt: new Date().toISOString(),
    previousBootAt: (prev && prev.previousBootAt) || null,
    lastBootHost: os.hostname(),
    // The host of the boot BEFORE this one — a container that is replaced gets
    // a new hostname, and that is exactly when data outside a volume is lost.
    previousBootHost: (prev && prev.lastBootHost) || null,
    lastBootPid: process.pid,
    lastBootNode: process.version,
    appVersion: info && info.appVersion ? info.appVersion : "",
    // Written on graceful shutdown so a boot can tell "restart" from "kill -9".
    lastCleanShutdownAt: (prev && prev.lastCleanShutdownAt) || null,
    lastKnownCounts: (prev && prev.lastKnownCounts) || null,
    // Kept across boots: the record of "this boot had to restore a snapshot
    // because the database came up empty" (see autoRecover).
    lastAutoRestore: (prev && prev.lastAutoRestore) || null,
  };
  const volumeSurvivedRestarts = !!prev;
  // Bookkeeping must never break the boot.
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
  } catch (e) { /* ignore */ }
  return { file, marker: next, volumeSurvivedRestarts, previous: prev };
}

/** Records counters at shutdown so a later "empty database" boot can be explained. */
async function recordCounts(db) {
  let counts = {};
  try {
    counts = await tableCounts(db);
    const file = path.join(config.DATA_DIR, MARKER_NAME);
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return; }
    prev.lastKnownCounts = { at: new Date().toISOString(), counts };
    prev.lastCleanShutdownAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(prev, null, 2));
  } catch (e) { /* best effort */ }
  return counts;
}

/** Row counts of the tables a "did I lose data?" question is really about. */
async function tableCounts(db, tables = COUNTED_TABLES) {
  const counts = {};
  for (const table of tables) {
    const row = await db.get("SELECT COUNT(*) AS n FROM " + table);
    counts[table] = Number(row && row.n ? row.n : 0);
  }
  return counts;
}

/**
 * THE SAFETY NET: an empty database plus a snapshot that is not empty.
 *
 * A tenant's rows can come up missing for two reasons: the host threw the
 * storage away, or the app booted on a different SQLite file than the one the
 * data is in (that second one used to be guaranteed whenever NODE_ENV changed).
 * In both cases the next boot faces the same picture — a schema with zero rows —
 * while BACKUP_DIR (often on the mounted volume even when the database is not)
 * still holds a snapshot of everything. Restoring it turns "my madrasa is gone"
 * into "the platform put it back".
 *
 * Guards: SQLite only, the live database must be COMPLETELY empty (nothing can
 * be overwritten), the snapshot must actually contain rows, and `backup.restore`
 * writes a `pre-restore` snapshot first, so the decision is itself undoable.
 * Set AUTO_RESTORE_ON_EMPTY_DB=0 to turn it off.
 */
async function autoRecover(db) {
  if (!config.AUTO_RESTORE_ON_EMPTY_DB) return { skipped: "AUTO_RESTORE_ON_EMPTY_DB=0" };
  if (config.DATABASE_DRIVER !== "sqlite") return { skipped: "not SQLite" };
  let counts;
  try {
    counts = await tableCounts(db);
  } catch (e) {
    return { skipped: "database not readable: " + e.message };
  }
  const empty = COUNTED_TABLES.every((t) => !counts[t]);
  if (!empty) return { skipped: "database already has data", counts };

  const backup = require("./backup");
  let candidate = null;
  try {
    candidate = (await backup.list()).find((b) => b.counts && COUNTED_TABLES.some((t) => Number(b.counts[t] || 0) > 0)) || null;
  } catch (e) {
    return { skipped: "no readable snapshots" };
  }
  if (!candidate) return { skipped: "no snapshot with data to restore", counts };

  try {
    const snapshot = await backup.readSnapshot(candidate.name);
    const result = await backup.restore(db, snapshot);
    const info = {
      restored: true,
      snapshot: candidate.name,
      snapshotCreatedAt: candidate.createdAt,
      tables: result.restored.length,
      counts: snapshot.counts,
      safetySnapshot: result.safetySnapshot,
      at: new Date().toISOString(),
      file: config.DB_CONFIG.file,
      host: os.hostname(),
    };
    noteAutoRestore(info);
    return info;
  } catch (e) {
    // Never block a boot on a recovery attempt — the UI still offers a manual one.
    return { error: e.message, snapshot: candidate.name };
  }
}

/** Records what autoRecover did, so diagnostics can explain it after the fact. */
function noteAutoRestore(info) {
  const file = path.join(config.DATA_DIR, MARKER_NAME);
  try {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { prev = {}; }
    prev.lastAutoRestore = info;
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(prev, null, 2));
  } catch (e) { /* bookkeeping only */ }
}

/**
 * Full verdict, safe to expose to the super admin. `dbCounts` (optional) lets
 * the caller explain "empty database after a restart" — the classic symptom.
 */
async function report(db) {
  const externalDb = config.DATABASE_DRIVER === "mysql";
  // An operator who has checked their own storage can silence the verdict —
  // DATA_PERSISTENT_ACK=1 means "I know, this disk is mine and it survives".
  const acknowledged = config.DATA_PERSISTENT_ACK;
  const data = describeStorage(config.DATA_DIR);
  const uploads = describeStorage(config.UPLOAD_DIR);
  const backups = describeStorage(config.BACKUP_DIR);
  const marker = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, MARKER_NAME), "utf8")); } catch (e) { return null; }
  })();

  let counts = null;
  if (db) {
    try { counts = await tableCounts(db); } catch (e) { counts = null; }
  }

  const warnings = [];
  let level = "ok"; // ok | warn | critical

  // Only judge the host when it claims to be production: a developer's own
  // disk is perfectly durable even though it is just the root filesystem.
  if (config.IS_PRODUCTION && !acknowledged) {
    // The SQLite database itself is catastrophic on an ephemeral filesystem.
    // (config.validate() now refuses this exact production configuration before
    // migrations create an empty file, but keep this diagnostic for visibility.)
    if (!externalDb && data.onPersistentVolume === false) {
      level = "critical";
      warnings.push({
        code: "EPHEMERAL_DATA_DIR",
        message:
          "The database file lives on the container's temporary disk (mount '" + (data.mountPoint || "/") +
          "', type '" + (data.fsType || "overlay") + "'). Everything you create — madaris included — is deleted when the " +
          "service redeploys or restarts. Mount a persistent disk at " + config.DATA_DIR +
          " (render.yaml: `disk:`) or use DATABASE_URL with MySQL. See docs/PERSISTENCE.md.",
      });
    } else if (!externalDb && data.onPersistentVolume === null) {
      if (level === "ok") level = "warn";
      warnings.push({ code: "UNKNOWN_MOUNT", message: "Could not inspect the filesystem — confirm " + config.DATA_DIR + " survives a restart." });
    }
    // MySQL protects database rows, but it does not protect uploaded logos,
    // photos or the snapshots used for disaster recovery. Report those two
    // separately even with DATABASE_URL configured.
    if (uploads.onPersistentVolume === false) {
      if (level === "ok") level = "warn";
      warnings.push({ code: "EPHEMERAL_UPLOADS", message: "Uploads (" + config.UPLOAD_DIR + ") are on an ephemeral filesystem — logos and student photos vanish on redeploy. Keep UPLOAD_DIR inside the persistent volume." + renderDiskHint() });
    }
    if (backups.onPersistentVolume === false) {
      if (level === "ok") level = "warn";
      warnings.push({ code: "EPHEMERAL_BACKUPS", message: "Backup directory (" + config.BACKUP_DIR + ") is on an ephemeral filesystem — download every backup you care about; use Platform → Backups." + renderDiskHint() });
    }
  }

  // Restart wiped the volume: the marker is gone although we previously knew
  // this deployment had booted (and had rows in the database).
  if (!marker && config.IS_PRODUCTION && !externalDb && !acknowledged) {
    warnings.push({ code: "NO_STATE_MARKER", message: "No state marker in " + config.DATA_DIR + " — on a fresh container this means the data directory did not survive the previous restart." });
    if (level === "ok") level = "warn";
  }
  if (counts && counts.madaris === 0 && marker && marker.lastKnownCounts && Number(marker.lastKnownCounts.counts.madaris) > 0) {
    level = "critical";
    warnings.push({
      code: "DATA_LOSS_DETECTED",
      message:
        "The database was " + marker.lastKnownCounts.counts.madaris + " madrasa(s) on " + marker.lastKnownCounts.at +
        " and is EMPTY now — the storage was wiped. Restore the newest backup from Platform → Backups.",
    });
  }
  if (marker && marker.lastBootHost && marker.previousBootHost && marker.previousBootHost !== marker.lastBootHost) {
    warnings.push({ code: "HOST_CHANGED", message: "This boot is on a different container (" + marker.previousBootHost + " → " + marker.lastBootHost + "); only mounted volumes survive that switch, so check that " + config.DATA_DIR + " is one." });
  }

  // Two database files in one directory: the classic way to "lose" a tenant
  // while it is perfectly safe on disk.
  // Only judge files that live where the app's own database lives: an operator
  // who pinned DATABASE_FILE to another directory is not "split", they chose it.
  const dbInDataDir = !externalDb && path.dirname(config.DB_CONFIG.file) === config.DATA_DIR;
  if (dbInDataDir && config.SQLITE_DB.otherFiles && config.SQLITE_DB.otherFiles.length) {
    if (level === "ok") level = "warn";
    warnings.push({
      code: "SPLIT_DATABASE_FILES",
      message:
        "This app reads " + (config.SQLITE_DB.file || "?") + ", but " + config.SQLITE_DB.otherFiles.length +
        " other SQLite file(s) sit in the same directory (" +
        config.SQLITE_DB.otherFiles.map((f) => f.name).join(", ") +
        "). Data written while the app used one of those is invisible here. Keep exactly one file " +
        "(set DATABASE_FILE, or rename the one with your data to " + config.SQLITE_FILE_BASENAME + ").",
    });
  }
  // If a boot had to restore a snapshot, say so — silently coming back with
  // data is a good outcome but the admin must know it happened.
  if (marker && marker.lastAutoRestore && marker.lastAutoRestore.restored) {
    warnings.push({
      code: "AUTO_RESTORED",
      message:
        "On " + marker.lastAutoRestore.at + " the database was empty and snapshot " + marker.lastAutoRestore.snapshot +
        " (" + Number((marker.lastAutoRestore.counts || {}).madaris || 0) +
        " madrasa(s)) was restored automatically. The state from before that restore is kept as " +
        marker.lastAutoRestore.safetySnapshot + ".",
    });
  }

  if (acknowledged && !externalDb && config.IS_PRODUCTION) {
    warnings.push({ code: "ACKNOWLEDGED", message: "Storage checks were silenced with DATA_PERSISTENT_ACK=1 — backups are still your safety net (Platform → Backups)." });
  }

  return {
    level,
    acknowledged: !!acknowledged,
    driver: config.DATABASE_DRIVER,
    externalDatabase: externalDb,
    databaseFile: externalDb ? null : config.DB_CONFIG.file,
    // WHICH file, and why that one: the whole "my data is gone" conversation
    // starts here, because two SQLite files in one directory means only one of
    // them is ever read.
    databaseFileReason: externalDb ? null : (config.SQLITE_DB.reason || ""),
    otherDatabaseFiles: externalDb ? [] : (config.SQLITE_DB.otherFiles || []),
    dataDir: data,
    uploadsDir: uploads,
    backupDir: backups,
    persistentVolumeDir: config.PERSISTENT_VOLUME_DIR,
    marker,
    counts,
    warnings,
    configWarnings: config.persistenceWarnings(),
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  report,
  touchMarker,
  recordCounts,
  tableCounts,
  autoRecover,
  describeStorage,
  findMountFor,
  COUNTED_TABLES,
  MARKER_NAME,
};
