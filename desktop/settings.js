"use strict";
/* ============================================================================
   EduSphere Desktop — per-user settings
   ----------------------------------------------------------------------------
   ONE JSON file inside Electron's per-user data directory
   (`app.getPath("userData")/settings.json`) holds everything the shell needs
   between launches: the chosen runtime mode, the remote server address, the
   LAN-hub preferences and the last window geometry.

   Why the details below matter:
     • ATOMIC WRITES. The file is written to a temp file, fsync'd, then renamed
       over the real one. A power cut or a crash mid-write can therefore never
       leave a half-written settings.json (which used to be the classic way a
       desktop app "forgets" its mode and re-runs the first-run wizard).
     • SELF-HEALING. A corrupt/truncated file is copied aside as
       `settings.corrupt-<timestamp>.json` and defaults are used, so the app
       always starts instead of crashing on its own config.
     • NO SECRETS. Device tokens and the generated SESSION_SECRET live in
       secret-store.js behind Electron's safeStorage. This file is plain JSON
       and must stay free of anything sensitive.
     • VALIDATION AT THE BOUNDARY. Every value that reaches a URL, a port or a
       bind address is normalised here, so no other module has to re-check it.
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const SETTINGS_FILENAME = "settings.json";
const SETTINGS_VERSION = 1;

/** The only two runtime modes the desktop app supports. */
const MODES = Object.freeze({ CLOUD: "cloud", HUB: "hub" });
const MODE_LIST = Object.freeze([MODES.CLOUD, MODES.HUB]);

/** Human labels shared by the menu, the tray and the first-run wizard. */
const MODE_LABELS = Object.freeze({
  [MODES.CLOUD]: "Cloud-synced app",
  [MODES.HUB]: "Local school LAN hub",
});

function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    firstRunComplete: false,
    mode: MODES.CLOUD,
    cloud: {
      // The operator's own EduSphere address, e.g. https://school.edusphere.app
      baseUrl: "",
    },
    hub: {
      // 0 = pick a free port on every boot (shown in the LAN Hub window).
      port: 0,
      // A LAN hub is the ONLY mode allowed to listen beyond loopback.
      bindHost: "0.0.0.0",
      adminUsername: "admin",
      // Optional upstream cloud for a later phase; off by default.
      upstream: { enabled: false, baseUrl: "" },
    },
    window: {
      width: 1280,
      height: 840,
      x: null,
      y: null,
      maximized: false,
    },
    tray: {
      closeToTray: true,
      showTray: true,
    },
    print: {
      pageSize: "A4",
    },
    device: {
      // Stable random per-installation identity (never the hardware id).
      id: "",
      name: "",
    },
    updatedAt: null,
  };
}

/* ------------------------------- validation ------------------------------- */

/** `"HUB"`, `" hub "`, junk → a canonical mode, never undefined. */
function normalizeMode(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  return MODE_LIST.includes(raw) ? raw : MODES.CLOUD;
}

/**
 * Accept only absolute http(s) URLs without credentials. Returns "" for
 * anything else — a stored `javascript:` or `file:` address must never reach
 * `loadURL()`.
 */
function normalizeBaseUrl(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  if (url.username || url.password) return "";
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function normalizePort(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return 0;
  return Math.floor(n);
}

/** Only loopback or the LAN wildcard may be bound; anything else → hub default. */
function normalizeBindHost(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  if (raw === "0.0.0.0" || raw === "127.0.0.1" || raw === "::" || raw === "::1") return raw;
  return "0.0.0.0";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.round(n);
}

/**
 * Merge an arbitrary JSON blob over the defaults, keeping ONLY known keys and
 * coercing every value to a safe shape. Unknown keys are dropped on purpose so
 * a hand-edited file (or one written by a future version) can never inject a
 * property the shell later trusts.
 */
function sanitizeSettings(input, base) {
  const source = isPlainObject(input) ? input : {};
  const out = JSON.parse(JSON.stringify(base || defaultSettings()));

  out.version = SETTINGS_VERSION;
  out.mode = normalizeMode(source.mode);
  out.firstRunComplete = source.firstRunComplete === true;
  out.updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : null;

  if (isPlainObject(source.cloud)) {
    out.cloud.baseUrl = normalizeBaseUrl(source.cloud.baseUrl);
  }

  if (isPlainObject(source.hub)) {
    const hub = source.hub;
    out.hub.port = normalizePort(hub.port);
    out.hub.bindHost = normalizeBindHost(hub.bindHost);
    const username = String(hub.adminUsername == null ? "" : hub.adminUsername).trim().toLowerCase();
    out.hub.adminUsername = /^[a-z0-9._-]{3,32}$/.test(username) ? username : "admin";
    if (isPlainObject(hub.upstream)) {
      out.hub.upstream.enabled = hub.upstream.enabled === true;
      out.hub.upstream.baseUrl = normalizeBaseUrl(hub.upstream.baseUrl);
    }
  }

  if (isPlainObject(source.window)) {
    const w = source.window;
    out.window.width = numberInRange(w.width, out.window.width, 900, 10000);
    out.window.height = numberInRange(w.height, out.window.height, 600, 10000);
    out.window.x = Number.isFinite(Number(w.x)) && w.x !== null ? Math.round(Number(w.x)) : null;
    out.window.y = Number.isFinite(Number(w.y)) && w.y !== null ? Math.round(Number(w.y)) : null;
    out.window.maximized = w.maximized === true;
  }

  if (isPlainObject(source.tray)) {
    out.tray.closeToTray = source.tray.closeToTray !== false;
    out.tray.showTray = source.tray.showTray !== false;
  }

  if (isPlainObject(source.print)) {
    const size = String(source.print.pageSize || "").trim();
    out.print.pageSize = /^(A4|A5|Letter|Legal)$/i.test(size) ? size : "A4";
  }

  if (isPlainObject(source.device)) {
    const id = String(source.device.id || "").trim();
    out.device.id = /^desk-[a-f0-9-]{8,64}$/i.test(id) ? id : "";
    const name = String(source.device.name || "").trim().slice(0, 64);
    out.device.name = name;
  }

  // A mode must be chosen before the app is considered set up.
  if (!MODE_LIST.includes(out.mode)) out.mode = MODES.CLOUD;
  if (out.firstRunComplete && out.mode === MODES.CLOUD && !out.cloud.baseUrl) {
    // No usable address: send the user back through the wizard instead of
    // opening an empty window.
    out.firstRunComplete = false;
  }

  return out;
}

/* ----------------------------- atomic writing ----------------------------- */

/**
 * Write a file so that a crash can never leave a partially written target:
 * write `.tmp` → fsync → rename over the target → fsync the directory.
 * The temp file is removed on any failure.
 */
function writeFileAtomic(file, data, options = {}) {
  const fsImpl = options.fs || fs;
  const dir = path.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp");
  let fd = null;
  try {
    fd = fsImpl.openSync(tmp, "w", options.mode || 0o600);
    fsImpl.writeFileSync(fd, data, "utf8");
    try { fsImpl.fsyncSync(fd); } catch (e) { /* not every fs supports it */ }
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(tmp, file);
    try {
      const dirFd = fsImpl.openSync(dir, "r");
      try { fsImpl.fsyncSync(dirFd); } catch (e) { /* directory fsync is best effort */ }
      fsImpl.closeSync(dirFd);
    } catch (e) { /* Windows cannot open a directory for fsync */ }
    return true;
  } catch (err) {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch (e) { /* ignore */ } }
    try { fsImpl.unlinkSync(tmp); } catch (e) { /* ignore */ }
    throw err;
  }
}

/* ------------------------------- the store -------------------------------- */

function settingsPathFor(userDataDir) {
  return path.join(String(userDataDir), SETTINGS_FILENAME);
}

/**
 * Create a settings store. Deliberately Electron-free so it can be unit tested
 * with plain `node --test` (the shell passes `app.getPath("userData")` in).
 */
function createSettingsStore(options = {}) {
  const file = options.file || settingsPathFor(options.userDataDir || process.cwd());
  const logger = options.logger || console;
  const fsImpl = options.fs || fs;
  let cached = null;

  function readRaw() {
    let text;
    try {
      text = fsImpl.readFileSync(file, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      // Keep the broken file for support, then start from defaults.
      const aside = file.replace(/\.json$/i, "") + ".corrupt-" + Date.now() + ".json";
      try { fsImpl.renameSync(file, aside); } catch (e) { /* ignore */ }
      if (logger && logger.warn) logger.warn("Settings file was not valid JSON — recovered from defaults (" + aside + ").");
      return null;
    }
  }

  function load() {
    if (cached) return cached;
    let raw = null;
    try {
      raw = readRaw();
    } catch (err) {
      if (logger && logger.warn) logger.warn("Settings file could not be read: " + (err && err.message ? err.message : err));
      raw = null;
    }
    cached = sanitizeSettings(raw || {}, defaultSettings());
    return cached;
  }

  function persist() {
    const snapshot = Object.assign({}, cached, { updatedAt: new Date().toISOString() });
    writeFileAtomic(file, JSON.stringify(snapshot, null, 2) + "\n", { fs: fsImpl, mode: 0o600 });
    cached = snapshot;
    return cached;
  }

  function get() {
    return load();
  }

  /** Shallow-per-section patch: `{ mode }`, `{ cloud: { baseUrl } }`, … */
  function patch(partial) {
    const current = load();
    const merged = {};
    for (const key of Object.keys(current)) {
      if (!isPlainObject(partial) || !(key in partial)) continue;
      merged[key] = isPlainObject(current[key]) && isPlainObject(partial[key])
        ? Object.assign({}, current[key], partial[key])
        : partial[key];
    }
    cached = sanitizeSettings(Object.assign({}, current, merged), defaultSettings());
    return persist();
  }

  function setMode(mode) {
    return patch({ mode: normalizeMode(mode) });
  }

  function completeFirstRun(partial) {
    return patch(Object.assign({}, partial || {}, { firstRunComplete: true }));
  }

  function reset() {
    cached = defaultSettings();
    return persist();
  }

  return {
    file,
    load,
    get,
    patch,
    setMode,
    completeFirstRun,
    reset,
    /** `true` when the user has already picked a mode. */
    isConfigured() {
      const s = load();
      return Boolean(s.firstRunComplete && (s.mode === MODES.HUB || s.cloud.baseUrl));
    },
  };
}

module.exports = {
  MODES,
  MODE_LIST,
  MODE_LABELS,
  SETTINGS_FILENAME,
  SETTINGS_VERSION,
  createSettingsStore,
  defaultSettings,
  isPlainObject,
  normalizeBaseUrl,
  normalizeBindHost,
  normalizeMode,
  normalizePort,
  sanitizeSettings,
  settingsPathFor,
  writeFileAtomic,
};
