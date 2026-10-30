"use strict";
/* ============================================================================
   EduSphere Desktop — embedded runtime host (main process side)
   ----------------------------------------------------------------------------
   LOCAL STANDALONE / SCHOOL LAN HUB MODE runs the SAME Express + SQLite server
   that the web deployment runs (`server/`), inside the desktop app, with its
   data in `app.getPath("userData")/data`. There is exactly one implementation
   of the platform; the desktop shell only decides where it listens and where
   it keeps its files.

   WHY A FORKED CHILD PROCESS (not the Electron main process)
     • A crash in the server (a bad request, an out-of-memory query, a bug)
       cannot take the window, the tray or the app lifecycle down with it. The
       shell notices the exit, logs it, restarts the hub and tells the user.
     • The server reads its configuration at require() time, so switching mode
       or data directory needs a fresh process — require caches make an
       in-process restart leak state between the two DATABASE files.
     • Graceful shutdown is explicit: an IPC `shutdown` message, then SIGTERM,
       then SIGKILL — the server writes its final backup snapshot and closes the
       SQLite handle before the app quits.

   BIND POLICY (security): only LAN hub mode may listen beyond loopback. Every
   other mode resolves to 127.0.0.1 — see `bindHostForMode()`.
   ========================================================================== */
const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MODES } = require("./settings");

const LOOPBACK_HOST = "127.0.0.1";
const LAN_HOST = "0.0.0.0";
const DEFAULT_READY_TIMEOUT_MS = 90000;
const DEFAULT_STOP_TIMEOUT_MS = 12000;
const MAX_LOG_LINES = 400;

/**
 * The single place that decides the listening interface.
 * Only `hub` may bind 0.0.0.0; cloud mode never exposes anything to the LAN.
 */
function bindHostForMode(mode) {
  return mode === MODES.HUB ? LAN_HOST : LOOPBACK_HOST;
}

function appRootFor({ isPackaged, appPath, dirname }) {
  // Packaged: resources/app (electron-builder copies server/ + public/ there).
  // Development: the repository root, one level above desktop/.
  return isPackaged ? appPath : path.resolve(dirname || __dirname, "..");
}

function dataPathsFor(userDataDir) {
  const dataDir = path.join(userDataDir, "data");
  return {
    dataDir,
    databaseFile: path.join(dataDir, "madrasa_platform.sqlite"),
    backupDir: path.join(dataDir, "backups"),
    uploadDir: path.join(dataDir, "uploads"),
    logsDir: path.join(userDataDir, "logs"),
  };
}

function generateSessionSecret() {
  return crypto.randomBytes(48).toString("hex");
}

/**
 * Build the child environment.
 *
 * Deliberately ALLOW-LISTED: the parent's environment is not copied wholesale,
 * because a stray DATABASE_URL / RENDER / NODE_ENV from a developer shell (or a
 * CI runner) must never redirect the school PC's hub at a remote MySQL server
 * or make the app think it is on Render's ephemeral disk.
 */
function buildChildEnv({ paths, bindHost, sessionSecret, superAdmin, upstream, platform = process.platform }) {
  const env = {};
  const passthrough = ["PATH", "Path", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "windir", "LANG", "LC_ALL", "TZ"];
  for (const key of passthrough) if (process.env[key]) env[key] = process.env[key];
  if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;

  env.NODE_ENV = "production";
  env.TZ = process.env.TZ || "UTC";
  env.DATA_DIR = paths.dataDir;
  env.BACKUP_DIR = paths.backupDir;
  env.UPLOAD_DIR = paths.uploadDir;
  env.DATABASE_DRIVER = "sqlite";
  env.DATABASE_FILE = paths.databaseFile;
  env.PERSISTENT_VOLUME_DIR = paths.dataDir;
  // The user-data folder is a real, persistent per-user directory: tell the
  // server's storage diagnostics so it does not warn about an ephemeral disk.
  env.DATA_PERSISTENT_ACK = "1";
  env.AUTO_RESTORE_ON_EMPTY_DB = "1";
  env.BACKUP_INTERVAL_MINUTES = "180";
  env.BACKUP_KEEP = "12";
  env.SESSION_PRUNE_MINUTES = "60";
  env.SESSION_SECRET = sessionSecret;
  env.API_RATE_LIMIT = process.env.API_RATE_LIMIT || "6000";
  env.PERF_MONITOR = "0";
  env.EDUSPHERE_DESKTOP = "1";
  env.EDUSPHERE_BIND_HOST = bindHost;
  env.EDUSPHERE_LOG_DIR = paths.logsDir;
  if (superAdmin && superAdmin.username) env.SUPER_ADMIN_USERNAME = superAdmin.username;
  if (superAdmin && superAdmin.password) env.SUPER_ADMIN_PASSWORD = superAdmin.password;
  if (upstream && upstream.enabled && upstream.baseUrl) {
    env.EDUSPHERE_UPSTREAM_BASE_URL = upstream.baseUrl;
    env.EDUSPHERE_UPSTREAM_SYNC = "1";
  }
  if (platform === "win32") env.SystemRoot = process.env.SystemRoot || "C:\\Windows";
  return env;
}

class ServerHost {
  constructor(options = {}) {
    this.appRoot = options.appRoot || appRootFor({ isPackaged: false, appPath: "", dirname: __dirname });
    this.entryPath = options.entryPath || path.join(__dirname, "server-entry.js");
    this.mode = options.mode === MODES.HUB ? MODES.HUB : MODES.CLOUD;
    this.userDataDir = options.userDataDir || process.cwd();
    this.paths = options.paths || dataPathsFor(this.userDataDir);
    this.bindHost = options.bindHost || bindHostForMode(this.mode);
    this.sessionSecret = options.sessionSecret || generateSessionSecret();
    this.superAdmin = options.superAdmin || null;
    this.upstream = options.upstream || null;
    this.preferredPort = Number(options.port) || 0;
    this.logger = options.logger || console;
    this.onLog = typeof options.onLog === "function" ? options.onLog : () => {};
    this.onExit = typeof options.onExit === "function" ? options.onExit : () => {};
    this.readyTimeoutMs = Number(options.readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS;
    this.stopTimeoutMs = Number(options.stopTimeoutMs) || DEFAULT_STOP_TIMEOUT_MS;
    this.nodeBinary = options.nodeBinary || process.execPath;
    this.extraEnv = options.extraEnv || {};
    this._child = null;
    this._logs = [];
    this._info = null;
    this._stopping = false;
  }

  /* -------------------------------- logging ------------------------------- */

  _pushLog(line) {
    const text = String(line == null ? "" : line).replace(/\s+$/, "");
    if (!text) return;
    this._logs.push(text);
    if (this._logs.length > MAX_LOG_LINES) this._logs.splice(0, this._logs.length - MAX_LOG_LINES);
    for (const part of text.split(/\r?\n/)) {
      try { this.onLog(part); } catch (e) { /* a log listener must never break boot */ }
    }
  }

  logs(count = MAX_LOG_LINES) {
    return this._logs.slice(-Math.max(1, Number(count) || MAX_LOG_LINES));
  }

  logTail(count = 25) {
    return this.logs(count).join("\n");
  }

  /* --------------------------------- state -------------------------------- */

  isRunning() {
    return Boolean(this._child && this._info);
  }

  info() {
    if (!this._info) return null;
    return Object.assign({}, this._info, { logs: undefined });
  }

  url() {
    return this._info ? this._info.url : "";
  }

  /* -------------------------------- startup ------------------------------- */

  async start() {
    if (this._child) return this.info();
    const entry = this.entryPath;
    if (!fs.existsSync(entry)) throw new Error("The embedded server entry point is missing: " + entry);
    fs.mkdirSync(this.paths.dataDir, { recursive: true });
    fs.mkdirSync(this.paths.logsDir, { recursive: true });

    const env = Object.assign(
      buildChildEnv({
        paths: this.paths,
        bindHost: this.bindHost,
        sessionSecret: this.sessionSecret,
        superAdmin: this.superAdmin,
        upstream: this.upstream,
      }),
      this.extraEnv,
      {
        EDUSPHERE_APP_ROOT: this.appRoot,
        EDUSPHERE_PREFERRED_PORT: String(this.preferredPort || 0),
      }
    );
    // Forking uses this Electron binary as a plain Node runtime; without this
    // switch Electron would try to open another window for the child script.
    if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";

    this._stopping = false;
    const child = fork(entry, [], {
      cwd: this.paths.dataDir,
      env,
      execPath: this.nodeBinary,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this._child = child;

    const pipe = (stream) => {
      if (!stream) return;
      stream.setEncoding("utf8");
      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) this._pushLog(line);
      });
      stream.on("end", () => { if (buffer) { this._pushLog(buffer); buffer = ""; } });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        finish(reject, new Error(
          "The local EduSphere server did not start within " + Math.round(this.readyTimeoutMs / 1000) + " seconds.\n\n" +
          this.logTail(15)
        ));
      }, this.readyTimeoutMs);
      if (timer.unref) timer.unref();

      child.on("message", (msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "log") {
          this._pushLog(msg.line);
          return;
        }
        if (msg.type === "listening") {
          const port = Number(msg.port);
          if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            return finish(reject, new Error("The local server reported an invalid port."));
          }
          const host = msg.bindHost || this.bindHost;
          // The desktop window always talks to the hub over loopback, even in
          // LAN mode (the wildcard bind is only for other devices).
          const url = "http://127.0.0.1:" + port + "/";
          this._info = {
            port,
            bindHost: host,
            url,
            lanUrl: host === LAN_HOST ? "http://" + (msg.lanAddress || "") + ":" + port + "/" : "",
            pid: child.pid,
            startedAt: Date.now(),
            mode: msg.mode || this.mode,
            dataDir: this.paths.dataDir,
          };
          finish(resolve, this.info());
          return;
        }
        if (msg.type === "error") {
          finish(reject, new Error(String(msg.message || "The local server failed to start.")));
        }
      });

      child.once("error", (err) => {
        finish(reject, err instanceof Error ? err : new Error(String(err)));
      });

      child.once("exit", (code, signal) => {
        const expected = this._stopping;
        this._child = null;
        const wasReady = Boolean(this._info);
        this._info = null;
        if (!settled) {
          finish(reject, new Error(
            "The local EduSphere server stopped during start-up (code " + code + (signal ? ", signal " + signal : "") + ").\n\n" +
            this.logTail(15)
          ));
        }
        try {
          this.onExit({ code, signal, expected, wasReady, logs: this.logTail(25) });
        } catch (e) { /* listener errors are the listener's problem */ }
      });
    });

    try {
      return await ready;
    } catch (err) {
      // Never leave a half-started child behind.
      await this.stop({ force: true }).catch(() => {});
      throw err;
    }
  }

  /* -------------------------------- shutdown ------------------------------ */

  async stop({ force = false, timeoutMs } = {}) {
    const child = this._child;
    this._stopping = true;
    if (!child) {
      this._info = null;
      return { stopped: true, forced: false };
    }
    const waitMs = Number(timeoutMs) || this.stopTimeoutMs;
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve(true);
      child.once("exit", () => resolve(true));
    });

    try {
      if (!force && child.connected) child.send({ type: "shutdown" });
      else child.kill("SIGTERM");
    } catch (e) {
      try { child.kill("SIGTERM"); } catch (err) { /* already gone */ }
    }

    let forced = false;
    const finished = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), waitMs)),
    ]);
    if (!finished) {
      forced = true;
      try { child.kill("SIGTERM"); } catch (e) { /* ignore */ }
      const soft = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      if (!soft) {
        try { child.kill("SIGKILL"); } catch (e) { /* ignore */ }
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      }
    }
    this._child = null;
    this._info = null;
    return { stopped: true, forced };
  }

  async restart() {
    await this.stop();
    return this.start();
  }
}

function createServerHost(options = {}) {
  return new ServerHost(options);
}

module.exports = {
  LAN_HOST,
  LOOPBACK_HOST,
  MAX_LOG_LINES,
  ServerHost,
  appRootFor,
  bindHostForMode,
  buildChildEnv,
  createServerHost,
  dataPathsFor,
  generateSessionSecret,
};
