"use strict";
/* ============================================================================
   Main process — boot, first-run wizard, secure window, token IPC, deep links
   and orderly shutdown. Electron itself is mocked (helpers/electron-mock.js),
   so this runs headless inside `node --test`.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createElectronMock, installElectronMock } = require("./helpers/electron-mock");

const mock = createElectronMock();
installElectronMock(mock);

const main = require("../main");

const state = mock.__state;
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function ipcHandler(channel) {
  const handler = state.ipcHandlers.get(channel);
  assert.ok(handler, "missing ipc handler " + channel);
  return handler;
}

function callSyncHello() {
  const listener = state.ipcListeners.get("edusphere:native:hello");
  assert.ok(listener, "preload's synchronous hello channel is registered");
  const event = {};
  listener(event);
  return event.returnValue;
}

test("first launch opens the mode wizard in a locked-down window", async () => {
  await wait(150);
  const wizard = state.windows[0];
  assert.ok(wizard, "a window was created");
  assert.match(wizard.loadedFile, /wizard\.html$/);
  assert.equal(wizard.options.webPreferences.contextIsolation, true, "contextIsolation is ON");
  assert.equal(wizard.options.webPreferences.nodeIntegration, false, "nodeIntegration is OFF");
  assert.equal(wizard.options.webPreferences.sandbox, true, "the renderer is sandboxed");
  assert.equal(wizard.options.webPreferences.webSecurity, true);
  assert.equal(wizard.options.webPreferences.webviewTag, false);
  assert.equal(wizard.options.webPreferences.enableRemoteModule, undefined, "the remote module is never enabled");
  assert.deepEqual(fs.readdirSync(mock.app.getPath("userData")).filter((n) => n === "settings.json").length, 1,
    "the per-user settings file is created on first launch");
});

test("the shell tells preload who this device is and stores tokens encrypted", async () => {
  const hello = callSyncHello();
  assert.equal(hello.platform, process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux");
  assert.match(hello.deviceId, /^desk-[a-f0-9-]{8,}$/i, "a stable random device id is generated");
  assert.ok(hello.deviceName.length > 0);
  assert.equal(hello.deviceToken, "", "a fresh install starts signed out");
  assert.equal(hello.mode, "cloud");
  assert.equal(hello.appRoot, undefined, "internal paths are not exposed to the page");

  const setResult = await ipcHandler("edusphere:native:set-device-token")({}, "eds_test_token_abcdef123456");
  assert.deepEqual(setResult, { persisted: true, reason: "" });

  const secretsDir = path.join(mock.app.getPath("userData"), "secrets");
  const blobs = fs.readdirSync(secretsDir);
  assert.equal(blobs.length, 1);
  const raw = fs.readFileSync(path.join(secretsDir, blobs[0]));
  assert.equal(raw.toString("utf8").includes("eds_test_token_abcdef123456"), false,
    "the token is never written to disk in plaintext");

  const helloAgain = callSyncHello();
  assert.equal(helloAgain.deviceToken, "eds_test_token_abcdef123456", "the shell decrypts it for the preload");

  const cleared = await ipcHandler("edusphere:native:clear-device-token")({});
  assert.deepEqual(cleared, { ok: true });
  assert.equal(callSyncHello().deviceToken, "");
});

test("the wizard validates, then saves the choice and opens the workspace", async () => {
  const submit = ipcHandler("edusphere:wizard:submit");

  const missing = await submit({}, { mode: "cloud", baseUrl: "" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /address/i);

  const badPassword = await submit({}, { mode: "hub", adminPassword: "short" });
  assert.equal(badPassword.ok, false);
  assert.match(badPassword.error, /8 characters/);

  const ok = await submit({}, { mode: "cloud", baseUrl: "https://school.edusphere.app/" });
  assert.equal(ok.ok, true);
  await wait(80);

  const workspace = state.windows[state.windows.length - 1];
  assert.equal(workspace.loadedURL, "https://school.edusphere.app", "the packaged app opens the operator's server");
  assert.equal(workspace.options.webPreferences.contextIsolation, true);
  assert.equal(workspace.options.webPreferences.nodeIntegration, false);
  assert.equal(workspace.options.webPreferences.sandbox, true);
  assert.equal(workspace.options.webPreferences.preload, path.join(__dirname, "..", "preload.js"));

  const saved = JSON.parse(fs.readFileSync(path.join(mock.app.getPath("userData"), "settings.json"), "utf8"));
  assert.equal(saved.mode, "cloud");
  assert.equal(saved.cloud.baseUrl, "https://school.edusphere.app");
  assert.equal(saved.firstRunComplete, true);
});

test("the workspace window may only navigate inside its own origin", async () => {
  const workspace = state.windows[state.windows.length - 1];
  const contents = workspace.webContents;

  assert.equal(typeof contents.windowOpenHandler, "function", "setWindowOpenHandler is installed");

  // A new window request is always denied; allowed links are re-used, external
  // ones go to the real browser.
  const external = contents.windowOpenHandler({ url: "https://example.com/help" });
  assert.deepEqual(external, { action: "deny" });
  assert.deepEqual(state.openedExternal.slice(-1), ["https://example.com/help"]);

  const unsafe = contents.windowOpenHandler({ url: "javascript:alert(1)" });
  assert.deepEqual(unsafe, { action: "deny" });
  assert.equal(state.openedExternal.includes("javascript:alert(1)"), false, "javascript: URLs are never opened");

  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } };
  contents.emit("will-navigate", event, "https://evil.example.com/phish");
  assert.equal(prevented, 1, "cross-origin navigation is blocked");
  contents.emit("will-navigate", event, "https://school.edusphere.app/admin");
  assert.equal(prevented, 1, "same-origin navigation is allowed");

  assert.equal(main.isAllowedNavigation("https://school.edusphere.app/x", "https://school.edusphere.app"), true);
  assert.equal(main.isAllowedNavigation("http://school.edusphere.app/x", "https://school.edusphere.app"), false, "protocol downgrade is refused");
  assert.equal(main.isAllowedNavigation("file:///etc/passwd", "https://school.edusphere.app"), false);
  assert.equal(main.isAllowedNavigation("", "https://school.edusphere.app"), false);
});

test("deep links: sync, navigation, and rejection of anything unknown", async () => {
  const workspace = state.windows[state.windows.length - 1];

  assert.equal(await main.handleDeepLink("edusphere://sync"), true);
  assert.match(workspace.webContents.lastScript, /SyncEngine\.syncNow/, "Sync now drives the Phase 2 engine");

  assert.equal(await main.handleDeepLink("edusphere://open/admin/students"), true);
  assert.equal(workspace.loadedURL, "https://school.edusphere.app/admin/students");

  assert.equal(await main.handleDeepLink("https://evil.example.com"), false, "a foreign scheme is ignored");
  assert.equal(await main.handleDeepLink("edusphere://open/../../etc/passwd"), false);
  assert.equal(await main.handleDeepLink("edusphere://rm-rf"), false);

  assert.equal(main.deepLinkFromArgv(["electron", ".", "edusphere://settings"]), "edusphere://settings");
  assert.equal(main.deepLinkFromArgv(["electron", "."]), "");
});

test("single-instance, about panel, crash handlers and clean shutdown are wired", async () => {
  assert.equal(typeof mock.app.aboutPanelOptions, "object", "setAboutPanelOptions was called");
  assert.equal(mock.app.aboutPanelOptions.applicationName, "EduSphere");
  assert.deepEqual(mock.app.aboutPanelOptions.applicationVersion, "1.0.0");
  assert.ok(mock.app.aboutPanelOptions.copyright.includes("EduSphere"));

  const listeners = {
    secondInstance: mock.app.listenerCount("second-instance"),
    windowAllClosed: mock.app.listenerCount("window-all-closed"),
    activate: mock.app.listenerCount("activate"),
    beforeQuit: mock.app.listenerCount("before-quit"),
    openUrl: mock.app.listenerCount("open-url"),
  };
  for (const [name, count] of Object.entries(listeners)) {
    assert.ok(count >= 1, "missing app event: " + name);
  }

  const uncaught = process.listenerCount("uncaughtException");
  const unhandled = process.listenerCount("unhandledRejection");
  assert.ok(uncaught >= 1, "uncaughtException is handled so the app never dies silently");
  assert.ok(unhandled >= 1, "unhandledRejection is handled too");

  // A crash shows a friendly dialog instead of a white window (the same
  // function the process handlers call — emitting on `process` would trip the
  // test runner's own uncaught-exception handling).
  const before = state.dialogs.length;
  main.handleFatalError("uncaughtException", new Error("simulated shell crash"));
  main.handleFatalError("unhandledRejection", Promise.reject(new Error("silent promise")).catch((e) => e));
  await wait(20);
  assert.ok(state.dialogs.length > before, "the user is told what happened");
  assert.match(state.dialogs[state.dialogs.length - 1].message, /EduSphere/);

  const logFile = path.join(mock.app.getPath("userData"), "logs", "main.log");
  assert.ok(fs.existsSync(logFile), "crashes are written to the log file");
  assert.match(fs.readFileSync(logFile, "utf8"), /simulated shell crash/);

  // Quitting stops everything and exits 0.
  await main.shutdownAndExit();
  assert.equal(main.S.shutdownComplete, true);
  assert.equal(mock.app.exitCode, 0, "the app closes cleanly");
});

test("platform label matches the server's device platforms", () => {
  const label = main.platformLabel();
  assert.ok(["windows", "macos", "linux"].includes(label));
});
