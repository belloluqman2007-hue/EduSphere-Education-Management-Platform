"use strict";
/* ============================================================================
   EduSphere Desktop — Electron main process
   ----------------------------------------------------------------------------
   Responsibilities, in the order the app performs them:

     1. SINGLE INSTANCE. A second launch focuses the existing window and hands
        its `edusphere://` deep link to it (Windows/Linux pass deep links as
        command-line arguments; macOS uses `open-url`).
     2. FIRST RUN. A small wizard asks which of the two runtime modes to use:
          • Cloud-synced app      → open the operator's remote EduSphere server
          • Local school LAN hub  → run the real Express + SQLite server here
        The choice lives in the per-user settings file and is changeable later
        from the menu (EduSphere → Desktop settings).
     3. WINDOW. One BrowserWindow, restored to its previous size/position and
        validated against the current displays. It is created with
        contextIsolation ON, nodeIntegration OFF, sandbox ON, and it may only
        navigate inside its own origin (`will-navigate` + setWindowOpenHandler
        allow-list). Anything else is opened in the user's real browser.
     4. CRASH SAFETY. `uncaughtException` and `unhandledRejection` are caught,
        written to `userData/logs/main.log`, and answered with a friendly
        dialog — never a white window. Renderer crashes and failed loads are
        replaced by a real page with a "Try again" link.
     5. TRAY + MENU. Sync now, Mode, Open data folder, LAN Hub pairing info.
     6. SHUTDOWN. Quitting stops the embedded hub cleanly (final backup +
        SQLite close) before the process exits.

   Nothing in this file weakens the web app's CSP: the pages are served by the
   platform itself (hub mode) or by the operator's server (cloud mode), and the
   shell never injects script into them.
   ========================================================================== */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const electron = require("electron");
const { app, BrowserWindow, Menu, Tray, dialog, shell, ipcMain, safeStorage, session, screen } = electron;

const {
  MODES,
  MODE_LIST,
  MODE_LABELS,
  createSettingsStore,
  normalizeBaseUrl,
  normalizeMode,
} = require("./settings");
const { createSecretStore, secretsDirFor } = require("./secret-store");
const {
  appRootFor,
  bindHostForMode,
  createServerHost,
  dataPathsFor,
  generateSessionSecret,
} = require("./server-host");
const { createTray, destroyTray } = require("./tray");
const { buildMenuTemplate } = require("./menu");
const { createPrintService } = require("./print");
const { DEEP_LINK_SCHEME, resolveDeepLink } = require("./deep-link");
const { hubInfoHtml, primaryLanAddress } = require("./lan-hub");

const APP_NAME = "EduSphere";
const TOKEN_KEY = "deviceToken";
const HUB_ADMIN_PASSWORD_KEY = "hubAdminPassword";
const SESSION_SECRET_KEY = "sessionSecret";
const LOG_FILENAME = "main.log";
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const S = {
  appRoot: "",
  userDataDir: "",
  settings: null,
  secrets: null,
  host: null,
  print: null,
  win: null,
  wizard: null,
  hubWindow: null,
  tray: null,
  mode: MODES.CLOUD,
  baseUrl: "",
  started: false,
  shuttingDown: false,
  shutdownComplete: false,
  hubRestarts: 0,
  lastCrashDialogAt: 0,
  pendingDeepLink: "",
};

/* -------------------------------- logging -------------------------------- */

function logFilePath() {
  const dir = path.join(S.userDataDir || os.tmpdir(), "logs");
  return path.join(dir, LOG_FILENAME);
}

function logToFile(level, message) {
  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_LOG_BYTES) fs.renameSync(file, file + ".1");
    } catch (e) { /* no previous log */ }
    const line = "[" + new Date().toISOString() + "] [" + level + "] " + String(message).replace(/\s+$/, "") + "\n";
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch (e) { /* logging must never throw */ }
}

function log(...args) {
  const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : safeJson(a))).join(" ");
  logToFile("info", text);
  try { console.log("[desktop]", text); } catch (e) { /* ignore */ }
}

function warn(...args) {
  const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : safeJson(a))).join(" ");
  logToFile("warn", text);
  try { console.warn("[desktop]", text); } catch (e) { /* ignore */ }
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}

/* ------------------------------ shell state ------------------------------ */

function platformLabel() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function userDataDir() {
  try {
    return app.getPath("userData");
  } catch (e) {
    return path.join(os.homedir(), ".edusphere");
  }
}

function installStores() {
  S.userDataDir = userDataDir();
  S.settings = createSettingsStore({ userDataDir: S.userDataDir, logger: { warn: (...a) => warn(...a) } });
  S.secrets = createSecretStore({
    dir: secretsDirFor(S.userDataDir),
    safeStorage: safeStorage || null,
    logger: { warn: (...a) => warn(...a) },
  });
  S.settings.load();
  ensureDeviceIdentity();
}

/** A stable random device identity (never derived from the machine's hardware). */
function ensureDeviceIdentity() {
  const settings = S.settings.get();
  if (settings.device && settings.device.id) return settings.device;
  const id = "desk-" + crypto.randomUUID();
  const host = (() => {
    try { return os.hostname() || "EduSphere Desktop"; } catch (e) { return "EduSphere Desktop"; }
  })();
  const device = { id, name: host.slice(0, 64) };
  try {
    S.settings.patch({ device });
  } catch (e) {
    warn("Could not persist the device identity:", e);
  }
  return device;
}

function deviceIdentity() {
  const settings = S.settings ? S.settings.get() : { device: {} };
  return settings.device && settings.device.id
    ? settings.device
    : { id: "desk-unknown", name: "EduSphere Desktop" };
}

/* --------------------------- window state helpers ------------------------- */

function defaultWindowState() {
  return { width: 1280, height: 840, x: null, y: null, maximized: false };
}

/** Keep the restored bounds on a display that actually exists right now. */
function visibleBounds(saved) {
  const state = Object.assign(defaultWindowState(), saved || {});
  const bounds = {
    width: Math.max(900, Math.round(state.width || 1280)),
    height: Math.max(600, Math.round(state.height || 840)),
  };
  if (typeof state.x !== "number" || typeof state.y !== "number") return bounds;
  try {
    const displays = (typeof screen !== "undefined" && screen && typeof screen.getAllDisplays === "function")
      ? screen.getAllDisplays()
      : [];
    const visible = displays.some((d) => {
      const area = d.workArea || d.bounds;
      if (!area) return false;
      const overlapX = Math.min(bounds.width + state.x, area.x + area.width) - Math.max(state.x, area.x);
      const overlapY = Math.min(bounds.height + state.y, area.y + area.height) - Math.max(state.y, area.y);
      return overlapX > 120 && overlapY > 80;
    });
    if (visible || !displays.length) return Object.assign({ x: state.x, y: state.y }, bounds);
  } catch (e) {
    return bounds;
  }
  return bounds; // a monitor was unplugged — centre on the primary display
}

function saveWindowState() {
  if (!S.win || !S.settings) return;
  try {
    if (S.win.isDestroyed && S.win.isDestroyed()) return;
    const maximized = Boolean(S.win.isMaximized && S.win.isMaximized());
    const bounds = (S.win.getNormalBounds && S.win.getNormalBounds()) || (S.win.getBounds && S.win.getBounds());
    if (!bounds) return;
    S.settings.patch({ window: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized } });
  } catch (e) {
    warn("Window state was not saved:", e);
  }
}

/* --------------------------- navigation allow-list ------------------------ */

/** Same-origin http(s) only. Everything else is blocked. */
function isAllowedNavigation(targetUrl, allowedBase) {
  let target;
  try {
    target = new URL(String(targetUrl || ""));
  } catch (e) {
    return false;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return false;
  let base;
  try {
    base = new URL(String(allowedBase || ""));
  } catch (e) {
    return false;
  }
  return target.origin === base.origin;
}

function isExternalLinkAllowed(url) {
  const text = String(url == null ? "" : url).trim();
  if (!text) return false;
  let parsed;
  try {
    parsed = new URL(text);
  } catch (e) {
    return false;
  }
  return ["https:", "http:", "mailto:"].includes(parsed.protocol);
}

function openExternalSafely(url) {
  if (!isExternalLinkAllowed(url)) {
    warn("Refused to open an external link:", url);
    return false;
  }
  try {
    shell.openExternal(String(url));
    return true;
  } catch (e) {
    warn("Could not open the external link:", e);
    return false;
  }
}

/**
 * Attach the navigation guards to a window. This is the single place where a
 * page is allowed to move: inside the app's own origin (same protocol, host
 * and port). New windows never open inside Electron.
 */
function applyNavigationGuards(win, allowedBase) {
  if (!win || !win.webContents) return;
  const contents = win.webContents;

  if (typeof contents.on === "function") {
    contents.on("will-navigate", (event, targetUrl) => {
      if (isAllowedNavigation(targetUrl, allowedBase)) return;
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (isExternalLinkAllowed(targetUrl)) openExternalSafely(targetUrl);
    });
    contents.on("will-attach-webview", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
    });
    contents.on("render-process-gone", (event, details) => {
      warn("The page stopped unexpectedly:", safeJson(details));
      showRecoverableError("The EduSphere window stopped responding", "Your work is saved. Reloading usually fixes this.");
    });
  }

  if (typeof contents.setWindowOpenHandler === "function") {
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedNavigation(url, allowedBase)) {
        // Same app, new tab request → show it in the same window instead of
        // handing control to Chromium.
        if (S.win && S.win.webContents && S.win.webContents.loadURL) S.win.webContents.loadURL(url);
      } else if (isExternalLinkAllowed(url)) {
        openExternalSafely(url);
      }
      return { action: "deny" };
    });
  }

  if (typeof contents.setVisualZoomLevelLimits === "function") {
    try { contents.setVisualZoomLevelLimits(1, 3); } catch (e) { /* ignore */ }
  }
}

/** Permission requests (camera, notifications, geolocation…) are denied. */
function applySessionHardening() {
  try {
    if (!session || typeof session.defaultSession !== "object" || !session.defaultSession) return;
    const ses = session.defaultSession;
    if (typeof ses.setPermissionRequestHandler === "function") {
      ses.setPermissionRequestHandler((_wc, permission, callback) => {
        try { callback(false); } catch (e) { /* ignore */ }
        if (permission && !["fullscreen", "clipboard-sanitized-write"].includes(permission)) {
          warn("Denied a page permission request:", permission);
        }
      });
    }
    if (typeof ses.setPermissionCheckHandler === "function") {
      ses.setPermissionCheckHandler(() => false);
    }
  } catch (e) {
    warn("Session hardening skipped:", e);
  }
}

/* ------------------------------ error pages ------------------------------ */

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function errorPagePath(title, message, retryUrl, detail) {
  const safeTitle = escapeHtml(title || "Something went wrong");
  const safeMessage = escapeHtml(message || "");
  const safeDetail = escapeHtml(detail || "");
  const link = retryUrl ? '<p><a href="' + escapeHtml(retryUrl) + '">Try again</a></p>' : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
html,body{height:100%}
body{margin:0;display:grid;place-items:center;background:#f6f4fb;color:#241733;font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:620px;padding:36px}
.card{background:#fff;border:1px solid #e3dcf0;border-radius:16px;padding:28px 30px;box-shadow:0 2px 10px rgba(36,23,51,.07)}
h1{margin:0 0 10px;font-size:20px}
p{margin:0 0 14px}
a{display:inline-block;padding:10px 16px;border-radius:9px;background:#3b1d63;color:#fff;text-decoration:none;font-weight:600}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:#6b5f7d;background:#f6f4fb;border-radius:8px;padding:10px;margin:0}
</style></head>
<body><main><div class="card">
<h1>${safeTitle}</h1>
<p>${safeMessage}</p>
${link}
${safeDetail ? "<pre>" + safeDetail + "</pre>" : ""}
</div></main></body></html>`;
  const dir = path.join(S.userDataDir || os.tmpdir(), "fallback");
  const file = path.join(dir, "error.html");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, html, { mode: 0o600 });
    return file;
  } catch (e) {
    return "";
  }
}

function showRecoverableError(title, message, detail) {
  if (!S.win || (S.win.isDestroyed && S.win.isDestroyed())) return;
  const file = errorPagePath(title, message, S.baseUrl, detail);
  try {
    if (file) S.win.loadFile(file);
    else if (S.baseUrl) S.win.loadURL(S.baseUrl);
  } catch (e) {
    warn("Could not show the recovery page:", e);
  }
}

function showCrashDialog(title, detail) {
  const now = Date.now();
  // Never stack dialogs: one friendly message per minute is enough.
  if (now - S.lastCrashDialogAt < 60000) return;
  S.lastCrashDialogAt = now;
  const logPath = logFilePath();
  const body = "EduSphere hit an unexpected problem, but it kept running and your data is safe.\n\n" +
    "What happened:\n" + String(detail || "").slice(0, 1200) +
    "\n\nDetails were written to:\n" + logPath;
  try {
    if (dialog && typeof dialog.showMessageBox === "function") {
      dialog.showMessageBox({
        type: "warning",
        title,
        message: title,
        detail: body,
        buttons: ["Continue", "Open log folder"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }).then((result) => {
        if (result && result.response === 1) openDataFolder(path.dirname(logPath));
      }).catch(() => {});
    } else if (dialog && typeof dialog.showErrorBox === "function") {
      dialog.showErrorBox(title, body);
    }
  } catch (e) {
    warn("Could not show a crash dialog:", e);
  }
}

/* ------------------------------- startup -------------------------------- */

function createMainWindow(url) {
  const settings = S.settings.get();
  const bounds = visibleBounds(settings.window);
  const win = new BrowserWindow(Object.assign({
    show: false,
    backgroundColor: "#f6f4fb",
    title: APP_NAME,
    autoHideMenuBar: process.platform !== "darwin",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: true,
      webviewTag: false,
    },
  }, bounds));

  S.win = win;
  applyNavigationGuards(win, url);

  win.once("ready-to-show", () => {
    if (settings.window && settings.window.maximized && typeof win.maximize === "function") win.maximize();
    if (typeof win.show === "function") win.show();
  });

  win.on("close", (event) => {
    saveWindowState();
    const current = S.settings ? S.settings.get() : null;
    const keepInTray = Boolean(current && current.tray && current.tray.closeToTray && S.tray);
    if (keepInTray && !S.shuttingDown) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (typeof win.hide === "function") win.hide();
    }
  });

  win.on("closed", () => {
    S.win = null;
  });

  if (win.webContents && typeof win.webContents.on === "function") {
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      if (errorCode === -3) return; // aborted (a redirect or a user navigation)
      warn("Page failed to load:", errorCode, errorDescription, validatedURL);
      showRecoverableError(
        "EduSphere could not open the workspace",
        S.mode === MODES.HUB
          ? "The local school server is not answering yet. Give it a few seconds and try again."
          : "The EduSphere server could not be reached. Check this computer's internet connection, then try again.",
        errorDescription ? errorCode + " " + errorDescription + "\n" + String(validatedURL || "") : ""
      );
    });
    win.webContents.on("did-finish-load", () => {
      if (S.pendingDeepLink) {
        const link = S.pendingDeepLink;
        S.pendingDeepLink = "";
        handleDeepLink(link);
      }
    });
  }

  if (url) win.loadURL(url);
  return win;
}

function windowIconPath() {
  return path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");
}

function openSettingsWindow() {
  if (S.wizard && !S.wizard.isDestroyed?.()) {
    if (typeof S.wizard.focus === "function") S.wizard.focus();
    return S.wizard;
  }
  const win = new BrowserWindow({
    width: 760,
    height: 720,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "EduSphere — Desktop settings",
    backgroundColor: "#f6f4fb",
    icon: windowIconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "wizard-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  S.wizard = win;
  applyNavigationGuards(win, "");
  win.once("ready-to-show", () => { if (typeof win.show === "function") win.show(); });
  win.on("closed", () => { S.wizard = null; });
  win.loadFile(path.join(__dirname, "wizard.html"));
  return win;
}

/* ---------------------------- mode management ---------------------------- */

function hubSuperAdmin() {
  const settings = S.settings.get();
  const username = (settings.hub && settings.hub.adminUsername) || "admin";
  let password = "";
  try {
    password = S.secrets.get(HUB_ADMIN_PASSWORD_KEY);
  } catch (e) { /* safeStorage unavailable */ }
  let firstRun = false;
  let persisted = true;
  if (!password) {
    password = crypto.randomBytes(18).toString("base64url") + "!";
    firstRun = true;
    try {
      const stored = S.secrets.set(HUB_ADMIN_PASSWORD_KEY, password);
      persisted = Boolean(stored && stored.persisted);
    } catch (e) {
      warn("Could not store the hub admin password:", e);
      persisted = false;
    }
    if (!persisted) {
      warn("No OS keychain: the hub administrator password for this run is not stored and cannot be shown again.");
    }
  }
  // `showPassword` is the only gate for putting the password on screen.
  return { username, password, firstRun, persisted, showPassword: firstRun && persisted };
}

function sessionSecret() {
  try {
    return S.secrets.getOrCreate(SESSION_SECRET_KEY, () => generateSessionSecret());
  } catch (e) {
    warn("Using a per-run session secret:", e);
    return generateSessionSecret();
  }
}

async function startHub() {
  const settings = S.settings.get();
  const paths = dataPathsFor(S.userDataDir);
  const identity = deviceIdentity();
  const admin = hubSuperAdmin();
  const host = createServerHost({
    appRoot: S.appRoot,
    userDataDir: S.userDataDir,
    paths,
    mode: MODES.HUB,
    // Only LAN mode may bind 0.0.0.0 — this is the policy guard.
    bindHost: bindHostForMode(MODES.HUB),
    port: settings.hub && settings.hub.port ? settings.hub.port : 0,
    sessionSecret: sessionSecret(),
    superAdmin: admin,
    upstream: (settings.hub && settings.hub.upstream) || null,
    logger: { log: (...a) => log(...a), warn: (...a) => warn(...a), error: (...a) => warn(...a) },
    onLog: (line) => logToFile("server", line),
    onExit: ({ code, signal, expected, wasReady }) => {
      if (expected || S.shuttingDown) return;
      warn("The embedded server stopped (code " + code + ", signal " + signal + ").");
      if (!wasReady) return;
      S.hubRestarts += 1;
      if (S.hubRestarts <= 3 && S.started) {
        showCrashDialog("The school LAN hub stopped", "EduSphere restarted the local server automatically. Phones may need a moment to reconnect.");
        setTimeout(() => { restartHub().catch((err) => warn("Hub restart failed:", err)); }, 1500);
      } else {
        showCrashDialog("The school LAN hub stopped", "The local server could not be restarted. Open EduSphere → Desktop settings and switch mode, or restart the app.");
      }
    },
  });
  S.host = host;
  const info = await host.start();
  S.mode = MODES.HUB;
  S.baseUrl = info.url;
  log("LAN hub listening on port " + info.port + " (bind " + info.bindHost + "), data in " + paths.dataDir);
  return { info, admin, paths, identity };
}

async function restartHub() {
  if (!S.host) return null;
  const info = await S.host.restart();
  S.baseUrl = info.url;
  if (S.win && S.win.webContents && S.win.webContents.loadURL) S.win.webContents.loadURL(S.baseUrl);
  if (S.tray) refreshTray();
  return info;
}

function resolveCloudBaseUrl() {
  const settings = S.settings.get();
  return normalizeBaseUrl(settings.cloud && settings.cloud.baseUrl);
}

/** Bring up whichever runtime the settings ask for, then load the window. */
async function startRuntime() {
  const settings = S.settings.get();
  S.mode = normalizeMode(settings.mode);

  if (S.mode === MODES.HUB) {
    const { info, admin, paths, identity } = await startHub();
    const win = createMainWindow(info.url);
    setupTrayAndMenu();
    // Hub mode always shows the pairing window (address, QR, firewall
    // guidance). It contains the first-run credentials ONLY while they have
    // just been created and stored — never on a later launch.
    openHubWindow({ port: info.port, dataDir: paths.dataDir, admin, deviceName: identity.name });
    return win;
  }

  const baseUrl = resolveCloudBaseUrl();
  if (!baseUrl) {
    openSettingsWindow();
    return null;
  }
  S.baseUrl = baseUrl;
  const win = createMainWindow(baseUrl);
  setupTrayAndMenu();
  return win;
}

async function stopRuntime() {
  if (S.host) {
    try {
      await S.host.stop();
    } catch (e) {
      warn("The embedded server did not stop cleanly:", e);
    }
  }
}

/** Switch modes at runtime (menu, tray, deep link, settings window). */
async function switchMode(mode, { reload = true } = {}) {
  const target = normalizeMode(mode);
  log("Switching runtime mode to", target);
  if (S.win && !(S.win.isDestroyed && S.win.isDestroyed())) {
    // destroy() (not close()) bypasses "close to tray" on purpose: the page it
    // shows belongs to the runtime that is about to stop.
    try { S.win.destroy(); } catch (e) { warn("Old window could not be closed:", e); }
  }
  S.win = null;
  await stopRuntime();
  S.host = null;
  S.settings.patch({ mode: target });
  const win = await startRuntime();
  if (win) {
    if (!reload) return win;
  }
  return win || S.win;
}

/* ------------------------------ tray + menu ------------------------------ */

function syncNowScript() {
  return "(function(){try{if(window.SyncEngine&&typeof window.SyncEngine.syncNow==='function'){window.SyncEngine.syncNow();return true;}}catch(e){}return false;})()";
}

function requestSyncNow() {
  if (!S.win || (S.win.isDestroyed && S.win.isDestroyed())) return false;
  try {
    const script = syncNowScript();
    const result = S.win.webContents.executeJavaScript(script, true);
    if (result && typeof result.catch === "function") result.catch(() => {});
    return true;
  } catch (e) {
    warn("Sync now could not be triggered:", e);
    return false;
  }
}

function openDataFolder(explicit) {
  const target = explicit || dataPathsFor(S.userDataDir).dataDir;
  try {
    fs.mkdirSync(target, { recursive: true });
    shell.openPath(target);
  } catch (e) {
    warn("Could not open the data folder:", e);
    showCrashDialog("Could not open the data folder", String(target) + "\n" + (e && e.message ? e.message : ""));
  }
  return target;
}

function qrEncoder() {
  try {
    // The platform's own QR encoder — the one printed on student cards.
    const doc = require(path.join(S.appRoot, "server", "services", "print-documents"));
    return typeof doc.qrSvg === "function" ? doc.qrSvg : null;
  } catch (e) {
    warn("QR encoder unavailable:", e);
    return null;
  }
}

function openHubWindow(options = {}) {
  const info = S.host && S.host.info ? S.host.info() : null;
  const port = options.port || (info && info.port) || 0;
  if (!port) {
    showCrashDialog("The school LAN hub is not running", "Switch to Local school LAN hub mode and try again.");
    return null;
  }
  const admin = options.admin || hubSuperAdmin();
  const settings = S.settings.get();
  const html = hubInfoHtml({
    port,
    host: primaryLanAddress(),
    adminUsername: settings.hub.adminUsername,
    firstRunPassword: options.admin && admin.showPassword ? admin.password : "",
    dataDir: options.dataDir || dataPathsFor(S.userDataDir).dataDir,
    platform: process.platform,
    appVersion: appVersion(),
    qrSvg: qrEncoder(),
    upstreamEnabled: Boolean(settings.hub.upstream && settings.hub.upstream.enabled),
    upstreamBaseUrl: settings.hub.upstream ? settings.hub.upstream.baseUrl : "",
  });
  const file = path.join(S.userDataDir, "fallback", "lan-hub.html");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html, { mode: 0o600 });
  } catch (e) {
    warn("Could not write the LAN hub page:", e);
    return null;
  }
  if (S.hubWindow && !(S.hubWindow.isDestroyed && S.hubWindow.isDestroyed())) {
    try { S.hubWindow.close(); } catch (e) { /* ignore */ }
  }
  const win = new BrowserWindow({
    width: 820,
    height: 780,
    title: "EduSphere — School LAN Hub",
    backgroundColor: "#f6f4fb",
    icon: windowIconPath(),
    show: false,
    webPreferences: {
      // No preload, no node, no scripts in this document at all.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  S.hubWindow = win;
  applyNavigationGuards(win, "");
  win.once("ready-to-show", () => { if (typeof win.show === "function") win.show(); });
  win.on("closed", () => { S.hubWindow = null; });
  win.loadFile(file);
  return win;
}

function appVersion() {
  try { return app.getVersion(); } catch (e) { return "1.0.0"; }
}

function menuActions() {
  return {
    about: showAboutPanel,
    settings: openSettingsWindow,
    switchMode: (mode) => { switchMode(mode).catch((err) => warn("Mode switch failed:", err)); },
    syncNow: requestSyncNow,
    openDataFolder: () => openDataFolder(),
    openHubInfo: () => openHubWindow(),
    reload: () => { if (S.win && S.win.webContents && S.win.webContents.reload) S.win.webContents.reload(); },
    print: () => printCurrent(),
    savePdf: () => exportCurrentPdf(),
    openExternal: (url) => openExternalSafely(url),
    quit: () => quitApp(),
  };
}

function buildMenu() {
  const settings = S.settings ? S.settings.get() : { mode: MODES.CLOUD };
  return buildMenuTemplate({
    appName: APP_NAME,
    isMac: process.platform === "darwin",
    mode: settings.mode,
    modes: MODE_LIST.map((mode) => ({ id: mode, label: MODE_LABELS[mode] })),
    actions: menuActions(),
  });
}

function setupTrayAndMenu() {
  try {
    if (typeof Menu !== "undefined" && Menu && typeof Menu.setApplicationMenu === "function") {
      Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenu()));
    }
  } catch (e) {
    warn("Application menu could not be built:", e);
  }
  const settings = S.settings.get();
  if (!settings.tray || !settings.tray.showTray) return;
  if (S.tray) { refreshTray(); return; }
  try {
    S.tray = createTray({
      Tray,
      Menu,
      iconPath: path.join(__dirname, "assets", process.platform === "darwin" ? "trayTemplate.png" : "tray.png"),
      appName: APP_NAME,
      mode: S.mode,
      actions: menuActions(),
    });
    if (S.tray && typeof S.tray.on === "function") {
      S.tray.on("click", () => showMainWindow());
    }
  } catch (e) {
    warn("System tray is not available on this desktop:", e);
    S.tray = null;
  }
}

function refreshTray() {
  try {
    if (!S.tray) return;
    const settings = S.settings.get();
    if (typeof S.tray.setToolTip === "function") {
      const info = S.host && S.host.info ? S.host.info() : null;
      S.tray.setToolTip(APP_NAME + " · " + (MODE_LABELS[settings.mode] || "") + (info ? " · port " + info.port : ""));
    }
    if (typeof S.tray.setContextMenu === "function" && Menu && typeof Menu.buildFromTemplate === "function") {
      S.tray.setContextMenu(Menu.buildFromTemplate(buildMenu()));
    }
  } catch (e) {
    warn("Tray could not be refreshed:", e);
  }
}

function showMainWindow() {
  if (!S.win) {
    startRuntime().catch((err) => warn("Could not reopen the window:", err));
    return;
  }
  try {
    if (typeof S.win.show === "function") S.win.show();
    if (typeof S.win.focus === "function") S.win.focus();
  } catch (e) { /* ignore */ }
}

/* -------------------------------- printing ------------------------------- */

function printService() {
  if (S.print) return S.print;
  S.print = createPrintService({
    BrowserWindow,
    dialog,
    app,
    getBaseUrl: () => S.baseUrl,
    getDeviceToken: () => (S.secrets ? S.secrets.get(TOKEN_KEY) : ""),
    getMainWindow: () => S.win,
    logger: { log: (...a) => log(...a), warn: (...a) => warn(...a) },
    userDataDir: () => S.userDataDir,
  });
  return S.print;
}

function printCurrent() {
  try {
    return printService().printWindow(S.win);
  } catch (e) {
    warn("Printing failed:", e);
    return Promise.resolve({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

function exportCurrentPdf(options) {
  try {
    return printService().savePdfFromWindow(S.win, options);
  } catch (e) {
    warn("PDF export failed:", e);
    return Promise.resolve({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

/* ------------------------------ about panel ----------------------------- */

function showAboutPanel() {
  try {
    if (process.platform === "darwin" && app.showAboutPanel) {
      app.showAboutPanel();
      return true;
    }
  } catch (e) { /* fall through to the dialog */ }
  try {
    if (dialog && typeof dialog.showMessageBox === "function") {
      dialog.showMessageBox({
        type: "info",
        title: "About EduSphere",
        message: APP_NAME + " " + appVersion(),
        detail: "Education management for madaris and academies.\n\n" +
          "Mode: " + (MODE_LABELS[S.mode] || "") + "\n" +
          "Electron " + (process.versions && process.versions.electron ? process.versions.electron : "") +
          " · " + platformLabel() + "\n" +
          "Data folder: " + dataPathsFor(S.userDataDir).dataDir,
        buttons: ["OK"],
        noLink: true,
      }).catch(() => {});
    }
  } catch (e) {
    warn("About dialog failed:", e);
  }
  return true;
}

/* ------------------------------- deep links ------------------------------ */

function baseUrlForDeepLink() {
  if (S.baseUrl) return S.baseUrl;
  if (S.mode === MODES.HUB) {
    const info = S.host && S.host.info ? S.host.info() : null;
    return info ? info.url : "";
  }
  return resolveCloudBaseUrl();
}

async function handleDeepLink(raw) {
  const base = baseUrlForDeepLink();
  const resolved = resolveDeepLink(raw, base);
  if (!resolved.ok) {
    warn("Ignored an invalid deep link (" + resolved.error + "):", String(raw).slice(0, 120));
    return false;
  }
  log("Deep link:", resolved.kind, resolved.mode || resolved.path || "");
  switch (resolved.kind) {
    case "sync":
      return requestSyncNow();
    case "settings":
      openSettingsWindow();
      return true;
    case "hub":
      openHubWindow();
      return true;
    case "about":
      return showAboutPanel();
    case "mode":
      await switchMode(resolved.mode);
      return true;
    case "open":
      if (S.win && resolved.url) {
        S.win.loadURL(resolved.url);
        return true;
      }
      S.pendingDeepLink = raw;
      return false;
    default:
      return false;
  }
}

function deepLinkFromArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  return args.find((arg) => typeof arg === "string" && arg.toLowerCase().startsWith(DEEP_LINK_SCHEME + "://")) || "";
}

function registerProtocolClient() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    }
  } catch (e) {
    warn("Could not register the edusphere:// protocol:", e);
  }
}

/* ---------------------------------- IPC ---------------------------------- */

function registerIpc() {
  if (!ipcMain) return;

  // Synchronous handshake used once by preload.js.
  ipcMain.on("edusphere:native:hello", (event) => {
    const identity = deviceIdentity();
    let token = "";
    try { token = S.secrets ? S.secrets.get(TOKEN_KEY) : ""; } catch (e) { token = ""; }
    const payload = {
      platform: platformLabel(),
      deviceId: identity.id,
      deviceName: identity.name,
      mode: S.mode,
      appVersion: appVersion(),
      deviceToken: token,
      appRoot: undefined,
    };
    try {
      // eslint-disable-next-line no-param-reassign
      event.returnValue = payload;
    } catch (e) { /* ignore */ }
  });

  ipcMain.handle("edusphere:native:set-device-token", (_event, token) => {
    const value = String(token == null ? "" : token);
    if (!value) {
      try { S.secrets.clear(TOKEN_KEY); } catch (e) { /* ignore */ }
      return { persisted: false, reason: "cleared" };
    }
    try {
      return S.secrets.set(TOKEN_KEY, value);
    } catch (e) {
      warn("The device token could not be stored:", e);
      return { persisted: false, reason: "write-failed" };
    }
  });

  ipcMain.handle("edusphere:native:clear-device-token", () => {
    try {
      S.secrets.clear(TOKEN_KEY);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("edusphere:native:open-external", (_event, url) => {
    return { ok: openExternalSafely(url) };
  });

  ipcMain.handle("edusphere:native:print", (event, options) => {
    try {
      const target = (event && event.sender && BrowserWindow && typeof BrowserWindow.fromWebContents === "function")
        ? BrowserWindow.fromWebContents(event.sender)
        : S.win;
      return printService().printWindow(target, options || {});
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("edusphere:native:save-pdf", async (event, options) => {
    try {
      const target = (event && event.sender && BrowserWindow && typeof BrowserWindow.fromWebContents === "function")
        ? BrowserWindow.fromWebContents(event.sender)
        : S.win;
      return await printService().savePdfFromWindow(target, options || {});
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  /* ---- first-run / settings window ---- */
  ipcMain.handle("edusphere:wizard:get-state", () => {
    const settings = S.settings.get();
    return {
      ok: true,
      mode: settings.mode,
      cloudBaseUrl: settings.cloud.baseUrl,
      adminUsername: settings.hub.adminUsername,
      firstRun: !settings.firstRunComplete,
      platform: platformLabel(),
      appVersion: appVersion(),
      encryptionAvailable: S.secrets.encryptionAvailable(),
    };
  });

  ipcMain.handle("edusphere:wizard:submit", async (_event, payload) => {
    try {
      const data = payload || {};
      const mode = normalizeMode(data.mode);
      const baseUrl = normalizeBaseUrl(data.baseUrl);
      if (mode === MODES.CLOUD && !baseUrl) {
        return { ok: false, error: "Enter the address of your EduSphere server (it starts with https://)." };
      }
      const adminUsername = String(data.adminUsername || "admin").trim().toLowerCase();
      const adminPassword = String(data.adminPassword || "");
      if (adminPassword && adminPassword.length < 8) {
        return { ok: false, error: "Use at least 8 characters for the administrator password." };
      }
      const patch = { mode, firstRunComplete: true };
      if (baseUrl) patch.cloud = { baseUrl };
      if (/^[a-z0-9._-]{3,32}$/.test(adminUsername)) patch.hub = { adminUsername };
      S.settings.patch(patch);
      if (adminPassword) {
        const stored = S.secrets.set(HUB_ADMIN_PASSWORD_KEY, adminPassword);
        if (!stored.persisted) {
          warn("The administrator password could not be stored securely; it will be used for this run only.");
        }
      }
      if (S.wizard) {
        try { S.wizard.close(); } catch (e) { /* ignore */ }
      }
      if (S.started) {
        await switchMode(mode);
      } else {
        await startRuntime();
        S.started = true;
      }
      return { ok: true, mode };
    } catch (e) {
      warn("Desktop settings could not be saved:", e);
      return { ok: false, error: "Could not save these settings: " + (e && e.message ? e.message : String(e)) };
    }
  });

  ipcMain.handle("edusphere:wizard:cancel", () => {
    if (S.wizard) {
      try { S.wizard.close(); } catch (e) { /* ignore */ }
    }
    if (!S.started) {
      // Never leave the app running with no window: fall back to the last
      // working mode, or quit if nothing has ever been chosen.
      const settings = S.settings.get();
      if (settings.firstRunComplete || settings.cloud.baseUrl || settings.mode === MODES.HUB) {
        startRuntime().then(() => { S.started = true; }).catch(() => quitApp());
      } else {
        quitApp();
      }
    }
    return { ok: true };
  });
}

/* ------------------------------- app events ------------------------------ */

/**
 * One handler for both fatal signals: log the real error, then tell the user
 * in plain language instead of leaving a white window behind. Exported so the
 * test suite can exercise it without killing its own process.
 */
function handleFatalError(kind, error) {
  const label = kind === "unhandledRejection" ? "Unhandled promise rejection" : "Uncaught exception";
  warn(label + ":", error);
  showCrashDialog("EduSphere recovered from a problem", (error && error.stack) || String(error));
  return true;
}

function installCrashHandlers() {
  process.on("uncaughtException", (err) => handleFatalError("uncaughtException", err));
  process.on("unhandledRejection", (reason) => handleFatalError("unhandledRejection", reason));
  try {
    if (app && typeof app.on === "function") {
      app.on("render-process-gone", (_event, contents, details) => {
        warn("Renderer process gone:", safeJson(details));
        showRecoverableError("The EduSphere window stopped responding", "Your work is saved. Reloading fixes this.");
      });
      app.on("child-process-gone", (_event, details) => {
        warn("Child process gone:", safeJson(details));
      });
      app.on("web-contents-created", (_event, contents) => {
        if (contents && typeof contents.on === "function") {
          contents.on("will-navigate", (event, url) => {
            if (!isAllowedNavigation(url, S.baseUrl)) {
              if (event && typeof event.preventDefault === "function") event.preventDefault();
              if (isExternalLinkAllowed(url)) openExternalSafely(url);
            }
          });
        }
      });
    }
  } catch (e) {
    warn("Crash handlers could not be installed:", e);
  }
}

function quitApp() {
  try {
    if (app && typeof app.quit === "function") app.quit();
  } catch (e) {
    process.exit(0);
  }
}

/** Orderly shutdown: stop the hub (final backup + DB close), then exit. */
async function shutdownAndExit() {
  if (S.shutdownComplete) return;
  S.shuttingDown = true;
  saveWindowState();
  try {
    if (S.host) await S.host.stop();
  } catch (e) {
    warn("The embedded server did not stop cleanly:", e);
  }
  try { destroyTray(S.tray); } catch (e) { /* ignore */ }
  S.tray = null;
  S.shutdownComplete = true;
  log("EduSphere desktop closed.");
  try {
    if (app && typeof app.exit === "function") app.exit(0);
  } catch (e) {
    process.exit(0);
  }
}

function installLifecycle() {
  if (app && typeof app.on === "function") {
    app.on("before-quit", (event) => {
      if (S.shutdownComplete) return;
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      shutdownAndExit().catch((err) => {
        warn("Shutdown failed:", err);
        process.exit(0);
      });
    });

    app.on("window-all-closed", () => {
      const settings = S.settings ? S.settings.get() : null;
      const keepInTray = Boolean(settings && settings.tray && settings.tray.closeToTray && S.tray);
      if (process.platform !== "darwin" && !keepInTray) quitApp();
    });

    app.on("activate", () => {
      if (!S.win) showMainWindow();
    });

    app.on("second-instance", (_event, argv) => {
      const link = deepLinkFromArgv(argv);
      if (link) handleDeepLink(link).catch((err) => warn("Deep link failed:", err));
      showMainWindow();
    });

    app.on("open-url", (event, url) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      handleDeepLink(url).catch((err) => warn("Deep link failed:", err));
    });
  }

  try {
    if (app && typeof app.setAboutPanelOptions === "function") {
      app.setAboutPanelOptions({
        applicationName: APP_NAME,
        applicationVersion: appVersion(),
        version: process.versions && process.versions.electron ? "Electron " + process.versions.electron : "",
        copyright: "© " + new Date().getFullYear() + " EduSphere",
        credits: "Education management for madaris and academies",
      });
    }
  } catch (e) {
    warn("About panel options unavailable:", e);
  }
}

async function bootstrap() {
  installStores();
  installCrashHandlers();
  installLifecycle();
  registerIpc();
  registerProtocolClient();

  try {
    app.setName && app.setName(APP_NAME);
    if (process.platform === "win32" && app.setAppUserModelId) app.setAppUserModelId("app.edusphere.desktop");
  } catch (e) { /* cosmetic */ }

  try { await app.whenReady(); } catch (e) { warn("app.whenReady failed:", e); }
  applySessionHardening();

  const settings = S.settings.get();
  const pendingLink = deepLinkFromArgv(process.argv);
  if (pendingLink) S.pendingDeepLink = pendingLink;

  if (!S.settings.isConfigured()) {
    openSettingsWindow();
    return;
  }
  try {
    await startRuntime();
    S.started = true;
  } catch (err) {
    warn("EduSphere could not start:", err);
    const win = createMainWindow("");
    const file = errorPagePath(
      "EduSphere could not start",
      S.mode === MODES.HUB
        ? "The local school server did not start. Check that this computer has free disk space, then try again."
        : "The EduSphere server address could not be opened.",
      S.baseUrl,
      (err && err.message ? err.message : String(err)).slice(0, 2000)
    );
    if (file) win.loadFile(file);
    openSettingsWindow();
  }
}

/* ------------------------------ entry point ----------------------------- */

let lockAcquired = true;
try {
  lockAcquired = typeof app.requestSingleInstanceLock === "function" ? app.requestSingleInstanceLock() : true;
} catch (e) {
  lockAcquired = true;
}
if (!lockAcquired) {
  // Another EduSphere window is already open: focus it (that instance gets a
  // `second-instance` event) and exit without touching the settings file.
  try { app.quit(); } catch (e) { process.exit(0); }
} else {
  bootstrap().catch((err) => {
    warn("Fatal boot failure:", err);
    showCrashDialog("EduSphere could not start", (err && err.stack) || String(err));
  });
}

/* Exported for the desktop test suite (plain `node --test`, no display). */
module.exports = {
  S,
  applyNavigationGuards,
  bootstrap,
  buildMenu,
  createMainWindow,
  deepLinkFromArgv,
  handleDeepLink,
  handleFatalError,
  isAllowedNavigation,
  isExternalLinkAllowed,
  logFilePath,
  openDataFolder,
  openHubWindow,
  openSettingsWindow,
  platformLabel,
  requestSyncNow,
  shutdownAndExit,
  startRuntime,
  switchMode,
  visibleBounds,
};
