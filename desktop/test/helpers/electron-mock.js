"use strict";
/* ============================================================================
   A fake `electron` module for `node --test`.
   ----------------------------------------------------------------------------
   The desktop test suite must run on a headless CI machine with no display, no
   X server and no window manager. So instead of launching Electron, every test
   that exercises main-process code stubs the module: `installElectronMock()`
   patches Node's module loader so `require("electron")` returns this object,
   and the test can then inspect what the shell did (which windows it created,
   with which webPreferences, which navigation guards, …).
   ========================================================================== */
const Module = require("module");
const EventEmitter = require("events");
const path = require("path");
const fs = require("fs");
const os = require("os");

function createMockApp(userDataDir) {
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    getPath(name) {
      if (name === "userData") return userDataDir;
      if (name === "appData") return path.dirname(userDataDir);
      return userDataDir;
    },
    getVersion: () => "1.0.0",
    getName: () => "EduSphere",
    setName() {},
    setAppUserModelId() {},
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock() {},
    setAsDefaultProtocolClient() { return true; },
    removeAsDefaultProtocolClient() { return true; },
    setAboutPanelOptions(options) { app.aboutPanelOptions = options; },
    showAboutPanel() { app.aboutShown = true; },
    whenReady: () => Promise.resolve(),
    quit() { app.quitCalls = (app.quitCalls || 0) + 1; app.emit("before-quit", { preventDefault() {} }); },
    exit(code) { app.exitCode = code; },
    focus() {},
    hide() {},
  });
  return app;
}

function createMockBrowserWindowClass(state) {
  class BrowserWindow extends EventEmitter {
    constructor(options = {}) {
      super();
      this.options = options;
      this.id = ++state.windowId;
      this.destroyed = false;
      this.visible = false;
      this.loadedURL = "";
      this.loadedFile = "";
      this.webContents = new EventEmitter();
      const contents = this.webContents;
      contents.id = this.id;
      contents.loadURL = (url) => { this.loadedURL = url; return Promise.resolve(); };
      contents.reload = () => { contents.reloadedAt = Date.now(); };
      contents.executeJavaScript = (script) => { contents.lastScript = script; return Promise.resolve(true); };
      contents.print = (_options, callback) => { contents.printed = true; if (callback) callback(true, ""); };
      contents.printToPDF = () => Promise.resolve(Buffer.from("%PDF-1.4 mock"));
      contents.setWindowOpenHandler = (handler) => { contents.windowOpenHandler = handler; };
      contents.setVisualZoomLevelLimits = () => {};
      contents.send = () => {};
      contents.setWindowOpenHandler = contents.setWindowOpenHandler.bind(contents);
      state.windows.push(this);
    }

    loadURL(url) { this.loadedURL = url; if (this.webContents) this.webContents.emit("did-finish-load"); return Promise.resolve(); }
    loadFile(file) { this.loadedFile = file; if (this.webContents) this.webContents.emit("did-finish-load"); return Promise.resolve(); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    maximize() { this.maximized = true; }
    isMaximized() { return Boolean(this.maximized); }
    getBounds() { return { x: 40, y: 40, width: 1280, height: 840 }; }
    getNormalBounds() { return this.getBounds(); }
    setBounds() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    close() { this.closeCalls = (this.closeCalls || 0) + 1; this.emit("close", { preventDefault() {} }); }
    once(event, handler) { return super.once(event, handler); }

    static fromWebContents(contents) {
      return state.windows.find((w) => w.webContents === contents) || null;
    }
    static getAllWindows() { return state.windows.filter((w) => !w.destroyed); }
  }
  return BrowserWindow;
}

function createMockTrayClass(state) {
  class Tray extends EventEmitter {
    constructor(image) {
      super();
      this.image = image;
      this.destroyed = false;
      state.trays.push(this);
    }
    setContextMenu(menu) { this.menu = menu; }
    setToolTip(text) { this.tooltip = text; }
    destroy() { this.destroyed = true; }
  }
  return Tray;
}

function createElectronMock(options = {}) {
  const userDataDir = options.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "edusphere-desktop-"));
  const state = {
    userDataDir,
    windows: [],
    trays: [],
    menus: [],
    openedExternal: [],
    openedPaths: [],
    ipcHandlers: new Map(),
    ipcListeners: new Map(),
    dialogs: [],
    saveDialogs: [],
    permissionDenied: [],
    windowId: 0,
  };

  const app = createMockApp(userDataDir);
  const BrowserWindow = createMockBrowserWindowClass(state);
  const Tray = createMockTrayClass(state);

  const dialog = {
    showMessageBox(arg) {
      state.dialogs.push(arg);
      return Promise.resolve({ response: options.dialogResponse || 0 });
    },
    showErrorBox(title, detail) { state.dialogs.push({ title, detail, errorBox: true }); },
    showSaveDialog(arg) {
      state.saveDialogs.push(arg);
      return Promise.resolve({ canceled: true, filePath: "" });
    },
  };

  const Menu = {
    buildFromTemplate(template) { return { template }; },
    setApplicationMenu(menu) { state.menus.push(menu); },
    getApplicationMenu() { return state.menus[state.menus.length - 1] || null; },
  };

  const shell = {
    openExternal(url) { state.openedExternal.push(url); return Promise.resolve(); },
    openPath(target) { state.openedPaths.push(target); return Promise.resolve(""); },
    showItemInFolder() {},
  };

  const nativeImage = {
    createFromPath(file) {
      return { file, isEmpty: () => !fs.existsSync(file), getSize: () => ({ width: 32, height: 32 }) };
    },
    createEmpty: () => ({ isEmpty: () => true }),
  };

  const safeStorage = {
    isEncryptionAvailable: () => (typeof options.encryptionAvailable === "boolean" ? options.encryptionAvailable : true),
    encryptString: (text) => {
      const buffer = Buffer.from(String(text), "utf8");
      for (let i = 0; i < buffer.length; i++) buffer[i] ^= 0x5a; // reversible test-only cipher
      return Buffer.concat([Buffer.from("MOCK1", "ascii"), buffer]);
    },
    decryptString: (buffer) => {
      const raw = Buffer.from(buffer);
      if (raw.slice(0, 5).toString("ascii") !== "MOCK1") throw new Error("not a mock payload");
      const body = Buffer.from(raw.slice(5));
      for (let i = 0; i < body.length; i++) body[i] ^= 0x5a;
      return body.toString("utf8");
    },
  };

  const session = {
    defaultSession: {
      setPermissionRequestHandler(handler) { state.permissionHandler = handler; },
      setPermissionCheckHandler(handler) { state.permissionCheckHandler = handler; },
      webRequest: { onBeforeSendHeaders() {} },
    },
    fromPartition() {
      return { webRequest: { onBeforeSendHeaders() {} } };
    },
  };

  const ipcMain = {
    on(channel, handler) { state.ipcListeners.set(channel, handler); },
    once(channel, handler) { state.ipcListeners.set(channel, handler); },
    removeListener(channel) { state.ipcListeners.delete(channel); },
    handle(channel, handler) { state.ipcHandlers.set(channel, handler); },
    removeHandler(channel) { state.ipcHandlers.delete(channel); },
  };

  const screen = {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  };

  const electron = {
    app,
    BrowserWindow,
    Tray,
    Menu,
    dialog,
    shell,
    nativeImage,
    safeStorage,
    session,
    ipcMain,
    screen,
    nativeTheme: { shouldUseDarkColors: false, on() {} },
    powerMonitor: { on() {} },
    crashReporter: { start() {} },
    __state: state,
  };

  return electron;
}

/**
 * Route `require("electron")` to the mock for the rest of this process.
 * Also drops cached desktop modules so a second install starts clean.
 */
function installElectronMock(mock) {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return mock;
    return original.apply(this, arguments);
  };
  if (!installElectronMock.restore) installElectronMock.restore = original;
  return mock;
}

function uninstallElectronMock() {
  if (installElectronMock.restore) Module._load = installElectronMock.restore;
}

module.exports = { createElectronMock, installElectronMock, uninstallElectronMock };
