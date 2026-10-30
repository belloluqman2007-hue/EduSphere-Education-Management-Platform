"use strict";
/* ============================================================================
   EduSphere Desktop — embedded runtime (child process)
   ----------------------------------------------------------------------------
   Boots the REAL platform: `server/config.js`, `server/migrate.js`,
   `server/app.js` (the same Express app the web deployment serves) and
   `server/seed.js`, on a free local port, with a SQLite database inside the
   app's user-data folder. Nothing here re-implements a route, a query or a
   migration — this file is only the process wrapper the desktop app supervises.

   Started by server-host.js with:
     EDUSPHERE_APP_ROOT     repo root (dev) or resources/app (packaged)
     EDUSPHERE_BIND_HOST    0.0.0.0 only in LAN hub mode, else 127.0.0.1
     EDUSPHERE_PREFERRED_PORT  optional; 0 = any free port
     NODE_ENV=production, DATA_DIR, DATABASE_FILE, SESSION_SECRET, …

   Protocol (IPC to the parent):
     { type: "log", line }                     → forwarded to the desktop log
     { type: "listening", port, bindHost }     → the hub is ready
     { type: "error", message }                → boot failed, see logs
   Incoming: { type: "shutdown" } → write a final backup, close, exit 0.
   ========================================================================== */
const path = require("path");
const os = require("os");

const APP_ROOT = process.env.EDUSPHERE_APP_ROOT || path.join(__dirname, "..");
const SERVER_DIR = path.join(APP_ROOT, "server");
const BIND_HOST = process.env.EDUSPHERE_BIND_HOST || "127.0.0.1";
const PREFERRED_PORT = Number(process.env.EDUSPHERE_PREFERRED_PORT || 0) || 0;

function send(message) {
  try {
    if (typeof process.send === "function" && process.connected) process.send(message);
  } catch (e) { /* the parent may already be gone */ }
}

/** Every line goes both to the parent (desktop log view) and to stdout. */
function forward(level) {
  return (...args) => {
    const line = args
      .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    send({ type: "log", level, line: "[" + level + "] " + line });
    try {
      if (level === "error") console.error(line);
      else console.log(line);
    } catch (e) { /* stdout may be closed */ }
  };
}

const log = forward("log");
const warn = forward("warn");
const error = forward("error");

function fail(err) {
  const message = err && err.stack ? err.stack : String(err);
  error(message);
  send({ type: "error", message: err && err.message ? err.message : String(err) });
  // Give the IPC message a tick to flush before the process disappears.
  setTimeout(() => process.exit(1), 50);
}

let shuttingDown = false;
let server = null;
let dbHandle = null;
let backupService = null;
let pruneTimer = null;

async function boot() {
  const config = require(path.join(SERVER_DIR, "config"));
  const util = require(path.join(SERVER_DIR, "util"));
  const db = require(path.join(SERVER_DIR, "db"));
  dbHandle = db;
  const { migrate } = require(path.join(SERVER_DIR, "migrate"));
  const { createApp } = require(path.join(SERVER_DIR, "app"));
  const { seedPlans, syncPlanOffers, seedSuperAdmin } = require(path.join(SERVER_DIR, "seed"));
  backupService = require(path.join(SERVER_DIR, "services", "backup"));

  config.validate();
  log("Starting EduSphere local server on " + BIND_HOST + " (data: " + config.DATA_DIR + ")");
  if (config.DATABASE_DRIVER === "sqlite") log("Database file: " + config.DB_CONFIG.file);

  try {
    await util.connectWithRetries(db, {
      attempts: config.DB_BOOT_ATTEMPTS,
      delayMs: config.DB_BOOT_RETRY_DELAY_MS,
      log: (m) => warn(m),
    });
  } catch (err) {
    const lines = ["Failed to connect to the database: " + (err && err.stack ? err.stack : err)];
    if (util.isDbConnectError(err)) lines.push(...util.dbConnectFailureHints(err));
    for (const line of lines) error(line);
    throw err;
  }

  await migrate();
  await seedPlans();
  try {
    const synced = await syncPlanOffers();
    if (synced) log("Subscription plans refreshed: " + synced + " plan(s).");
  } catch (e) {
    warn("Subscription plan offers not refreshed: " + (e && e.message));
  }
  await seedSuperAdmin();
  try {
    const n = await require(path.join(SERVER_DIR, "services", "ai")).seedKnowledge();
    if (n) log("EduSphere AI: seeded " + n + " knowledge-base entries.");
  } catch (e) {
    warn("EduSphere AI knowledge seed skipped: " + (e && e.message));
  }
  try {
    const mediaStore = require(path.join(SERVER_DIR, "services", "media-store"));
    const hydrated = await mediaStore.hydrateFromDisk();
    if (hydrated && hydrated.copied) log("Media store: copied " + hydrated.copied + " upload(s) into the database.");
  } catch (e) {
    warn("Media hydration failed: " + (e && e.message));
  }

  const app = createApp();

  // Port selection: honour the preferred port when the operator pinned one,
  // otherwise (and on EADDRINUSE) let the OS choose and report it back.
  const listen = (port) => new Promise((resolve, reject) => {
    const s = app.listen(port, BIND_HOST, config.LISTEN_BACKLOG);
    const onError = (err) => {
      s.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      s.removeListener("error", onError);
      resolve(s);
    };
    s.once("error", onError);
    s.once("listening", onListening);
  });

  let listening = null;
  if (PREFERRED_PORT) {
    try {
      listening = await listen(PREFERRED_PORT);
    } catch (e) {
      warn("Preferred port " + PREFERRED_PORT + " is unavailable (" + (e && e.code) + "); picking a free port instead.");
    }
  }
  if (!listening) listening = await listen(0);
  server = listening;

  const port = server.address().port;
  const lanAddress = (() => {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const entry of nets[name] || []) {
        const family = typeof entry.family === "number" ? "IPv" + entry.family : entry.family;
        if (family === "IPv4" && !entry.internal) return entry.address;
      }
    }
    return "";
  })();

  log("EduSphere local server listening on " + BIND_HOST + ":" + port +
    (BIND_HOST === "0.0.0.0" && lanAddress ? " — school network: http://" + lanAddress + ":" + port + "/" : ""));
  send({ type: "listening", port, bindHost: BIND_HOST, lanAddress, mode: BIND_HOST === "0.0.0.0" ? "hub" : "cloud" });

  // Automatic JSON snapshots + session/device-token pruning, exactly as the
  // web deployment does on boot.
  try { backupService.startAutoBackup(db); } catch (e) { warn("Auto-backup timer not started: " + (e && e.message)); }
  if (config.SESSION_PRUNE_MINUTES > 0) {
    const DBSessionStore = require(path.join(SERVER_DIR, "session-store"));
    const deviceTokens = require(path.join(SERVER_DIR, "services", "device-tokens"));
    const prune = async (why) => {
      try {
        const store = new DBSessionStore();
        const r = await store.prune();
        if (r && r.changes) log("Session prune (" + why + "): removed " + r.changes + " expired session(s).");
        const dt = await deviceTokens.pruneExpiredTokens();
        if (dt && dt.changes) log("Device token prune (" + why + "): removed " + dt.changes + " expired token(s).");
      } catch (e) { warn("Session prune failed: " + (e && e.message)); }
    };
    await prune("boot");
    pruneTimer = setInterval(() => { prune("timer"); }, config.SESSION_PRUNE_MINUTES * 60 * 1000);
    if (pruneTimer.unref) pruneTimer.unref();
  }
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("Shutting down the local server (" + reason + ").");
  if (pruneTimer) { try { clearInterval(pruneTimer); } catch (e) { /* ignore */ } }
  try { if (backupService) backupService.stopAutoBackup(); } catch (e) { /* ignore */ }

  const closeServer = new Promise((resolve) => {
    if (!server) return resolve();
    try {
      server.close(() => resolve());
    } catch (e) { resolve(); }
    setTimeout(resolve, 6000).unref();
  });
  await closeServer;

  // A final snapshot + close, both best-effort: never keep the school PC
  // waiting because a snapshot write failed.
  try {
    if (dbHandle && backupService) await backupService.writeSnapshot(dbHandle, { reason: "shutdown" });
  } catch (e) { warn("Final snapshot skipped: " + (e && e.message)); }
  try { if (dbHandle && typeof dbHandle.close === "function") await dbHandle.close(); } catch (e) { /* ignore */ }

  send({ type: "stopped" });
  process.exit(0);
}

process.on("message", (msg) => {
  if (msg && msg.type === "shutdown") shutdown("ipc");
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  error("Uncaught exception in the local server: " + (err && err.stack ? err.stack : err));
  shutdown("uncaughtException").then(() => process.exit(1)).catch(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  warn("Unhandled promise rejection in the local server: " + (reason && reason.stack ? reason.stack : reason));
});

boot().catch((err) => fail(err));
