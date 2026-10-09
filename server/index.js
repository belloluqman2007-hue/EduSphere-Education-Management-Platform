"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — server entry point
   ========================================================================== */
const config = require("./config");
const { migrate } = require("./migrate");
const { createApp } = require("./app");
const { seedPlans, seedSuperAdmin } = require("./seed");
const db = require("./db");
const DBSessionStore = require("./session-store");
const sessionStore = new DBSessionStore(); // stateless store; shared prune helper
const backup = require("./services/backup");
const persistence = require("./services/persistence");

(async () => {
  try {
    config.validate();
    // Bookkeeping: counts boots in the (persistent) data directory so we can
    // tell a restart from a wiped volume, and warns out loud when storage will
    // not survive the next deploy. See services/persistence.js.
    const marker = persistence.touchMarker({ appVersion: "1.0.0" });
    // Print the mount verdict on every boot, not only inside the authenticated
    // diagnostics screen. This makes a missed Render disk or an ephemeral
    // uploads/backups directory visible before the first institution is added.
    const storage = await persistence.report(null);
    const dataMount = storage.dataDir && storage.dataDir.mountPoint ? storage.dataDir.mountPoint : "unknown";
    console.log("Storage: " + storage.level + " — data=" + config.DATA_DIR + " (mount " + dataMount + ")");
    for (const warning of storage.warnings) console.warn("⚠ [" + warning.code + "] " + warning.message);
    // Which database file this process opened, and why that one. Saying it out
    // loud on every boot is what turns "the madrasa disappeared" into a
    // one-glance diagnosis: two *.sqlite files in one directory means only one
    // of them is ever read, and the data in the other looks deleted.
    if (config.DATABASE_DRIVER === "sqlite") {
      console.log("Database file: " + config.DB_CONFIG.file + " [" + config.SQLITE_DB.reason + "]");
    }
    for (const w of config.persistenceWarnings()) console.warn("⚠ " + w);
    // Always ensure the (new) database schema is up to date (snapshots itself
    // first, so a migration can always be rolled back to the previous data).
    await migrate();
    if (!marker.volumeSurvivedRestarts && config.IS_PRODUCTION) {
      console.warn("⚠ No previous state marker in " + config.DATA_DIR + ". If this service has run before, its data " +
        "directory is not persistent — attach a disk (render.yaml: disk.mountPath) or point DATABASE_URL at MySQL.");
    }
    // A brand-new, completely empty database is almost never what the operator
    // wanted. If BACKUP_DIR holds a snapshot with rows in it, put the data back
    // before anyone has to notice it is missing (AUTO_RESTORE_ON_EMPTY_DB=0
    // turns this off). The restore writes a pre-restore snapshot of its own.
    const recovered = await persistence.autoRecover(db);
    if (recovered && recovered.restored) {
      console.warn("⚠ The database was EMPTY, so snapshot " + recovered.snapshot + " was restored (" +
        Number((recovered.counts || {}).madaris || 0) + " madrasa(s), " +
        Number((recovered.counts || {}).users || 0) + " user(s)). Previous state kept as " + recovered.safetySnapshot +
        ". Check Platform → Backups & storage for why it was empty.");
    } else if (recovered && recovered.error) {
      console.error("⚠ Automatic restore failed (" + recovered.error + "). The database is still empty — restore manually from Platform → Backups.");
    } else if (recovered && recovered.skipped === "AUTO_RESTORE_ON_EMPTY_DB=0") {
      console.warn("⚠ Automatic restore of an empty database is disabled (AUTO_RESTORE_ON_EMPTY_DB=0).");
    }
    // Bootstrap a fresh database on every boot: default plans + the single
    // super admin. Both are idempotent (only created if absent), so an
    // existing database — and a password the admin later changed via the
    // app — is never overwritten. See docs/DEPLOYMENT.md → "Resetting the
    // super-admin password".
    await seedPlans();
    await seedSuperAdmin();
    // Pictures live in the database as well as on disk (migration 041). On
    // the first boot after upgrading, copy whatever files are still on disk
    // into media_files so the NEXT deploy cannot lose them either.
    try {
      const mediaStore = require("./services/media-store");
      const hydrated = await mediaStore.hydrateFromDisk();
      if (hydrated.copied) {
        console.log(`Media store: copied ${hydrated.copied} existing upload(s) into the database (${hydrated.skipped} already present).`);
      }
    } catch (e) {
      console.warn("⚠ Media hydration failed (" + (e.message || e) + "). New uploads are still stored in the database.");
    }
    // Safety net: a JSON snapshot of the whole database on a timer, so a lost
    // container can always be restored from Platform -> Backups.
    backup.startAutoBackup(db);
    const app = createApp();
    // Sweep expired session rows on a timer. app_sessions is the one table
    // that grows on every login; without this sweep a long-lived deployment
    // accumulates dead sessions forever. Best-effort: a failed prune logs and
    // tries again on the next tick, it never takes the app down.
    if (config.SESSION_PRUNE_MINUTES > 0) {
      const pruneSessions = async (why) => {
        try {
          const r = await sessionStore.prune();
          if (r && r.changes) console.log(`Session prune (${why}): removed ${r.changes} expired session(s).`);
        } catch (e) { console.error("Session prune failed:", e.message); }
      };
      await pruneSessions("boot");
      const pruneTimer = setInterval(() => { pruneSessions("timer"); }, config.SESSION_PRUNE_MINUTES * 60 * 1000);
      if (pruneTimer.unref) pruneTimer.unref();
    }
    // The listen backlog shields the accept queue when many clients connect
    // at once (a load spike, a deploy rolling, or a login rush). Node's
    // default of 511 drops SYNs under exactly those bursts; a deeper queue
    // lets the kernel hold them until the event loop can accept.
    const server = app.listen(config.PORT, "0.0.0.0", config.LISTEN_BACKLOG, () => {
      console.log("==============================================");
      console.log("  EduSphere — Education Management Platform");
      console.log(`  env:    ${config.NODE_ENV}`);
      console.log(`  driver: ${config.DATABASE_DRIVER}${config.DATABASE_DRIVER === "sqlite" ? " (" + config.DB_CONFIG.file + ")" : ""}`);
      console.log(`  port:   ${config.PORT}`);
      console.log("==============================================");
    });

    const shutdown = async (signal) => {
      console.log(`${signal} received — shutting down.`);
      backup.stopAutoBackup();
      server.close(async () => {
        // Final snapshot + "we shut down cleanly" marker BEFORE the database
        // handle closes; both are best-effort and never block the exit.
        try {
          await persistence.recordCounts(db);
          await backup.writeSnapshot(db, { reason: "shutdown" });
        } catch (e) { console.error("Final snapshot skipped:", e.message); }
        try { await db.close(); } catch (e) { /* ignore */ }
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
})();
