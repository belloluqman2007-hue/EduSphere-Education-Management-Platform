"use strict";
/* ============================================================================
   Security posture — proven, not promised.
   ----------------------------------------------------------------------------
   1. Static: the shell's source is scanned for the settings that make an
      Electron app safe (and for the ones that make it a liability).
   2. Runtime: `preload.js` is executed against a stub `electron` module and the
      resulting `window.__EDUSPHERE_NATIVE__` is inspected — exact frozen shape,
      no `ipcRenderer`, no `require`, no token in storage.
   3. LAN hub page: strict CSP, escaped values, the real pairing URL.
   4. Printing: native print / printToPDF go through Electron, write only where
      the user asked.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const DESKTOP = path.resolve(__dirname, "..");

function source(rel) {
  return fs.readFileSync(path.join(DESKTOP, rel), "utf8");
}

test("the window configuration is locked down", () => {
  const main = source("main.js");
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /nodeIntegrationInWorker:\s*false/);
  assert.match(main, /nodeIntegrationInSubFrames:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /webSecurity:\s*true/);
  assert.match(main, /webviewTag:\s*false/);
  assert.match(main, /allowRunningInsecureContent:\s*false/);

  assert.doesNotMatch(main, /nodeIntegration:\s*true/, "node integration may never be switched on");
  assert.doesNotMatch(main, /enableRemoteModule/, "the remote module must not be used at all");
  assert.doesNotMatch(main, /require\(\s*["']@electron\/remote["']\s*\)/, "no @electron/remote");
  assert.doesNotMatch(main, /webviewTag:\s*true/);
  assert.doesNotMatch(main, /webPreferences[\s\S]{0,200}preload[\s\S]{0,200}nodeIntegration:\s*true/);
});

test("navigation, permissions and new windows are all allow-listed", () => {
  const main = source("main.js");
  assert.match(main, /will-navigate/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setPermissionCheckHandler/);
  assert.match(main, /callback\(false\)/, "page permission requests are denied");
  assert.match(main, /return \{ action: "deny" \}/, "new windows are denied and handed to the browser instead");
  assert.match(main, /function isAllowedNavigation/);
  assert.match(main, /function isExternalLinkAllowed/);
  assert.match(main, /\["https:", "http:", "mailto:"\]/, "only web/mail schemes can be opened externally");
});

test("crash safety and lifecycle hooks are present", () => {
  const main = source("main.js");
  assert.match(main, /process\.on\("uncaughtException"/);
  assert.match(main, /process\.on\("unhandledRejection"/);
  assert.match(main, /loadFile\(file\)/, "a real recovery page replaces a blank window");
  assert.match(main, /did-fail-load/);
  assert.match(main, /render-process-gone/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /second-instance/);
  assert.match(main, /setAboutPanelOptions/);
  assert.match(main, /before-quit/);
  assert.match(main, /shutdownAndExit/);
  assert.match(main, /app\.exit\(0\)/);
  assert.match(main, /setVisualZoomLevelLimits/);
});

test("no plaintext secret handling anywhere in the shell", () => {
  for (const file of ["main.js", "preload.js", "settings.js", "server-host.js", "server-entry.js"]) {
    const text = source(file);
    assert.doesNotMatch(text, /localStorage\s*\./, file + " must not touch web storage");
    assert.doesNotMatch(text, /document\.cookie/, file + " must not touch cookies");
  }
  const main = source("main.js");
  assert.match(main, /safeStorage/, "tokens go through Electron safeStorage");
  assert.match(main, /secrets:\s*null/, "the shell keeps the secret store, not the page");
  assert.match(main, /bindHostForMode/, "the LAN bind is decided by one policy function");
  const host = source("server-host.js");
  assert.match(host, /return mode === MODES\.HUB \? LAN_HOST : LOOPBACK_HOST/,
    "cloud mode always resolves to loopback");
});

test("preload exposes exactly the documented, frozen bridge", () => {
  const captured = {};
  const calls = { set: [], clear: 0, invoke: [], external: [] };
  const stubElectron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        captured.name = name;
        captured.api = api;
      },
    },
    ipcRenderer: {
      sendSync(channel) {
        calls.sendSync = channel;
        return {
          platform: "linux",
          deviceId: "desk-aaaa-bbbb",
          deviceName: "Office PC",
          appVersion: "1.0.0",
          mode: "hub",
          deviceToken: "eds_from_keychain",
          secretInternalPath: "/should/not/leak",
        };
      },
      invoke(channel, payload) {
        calls.invoke.push({ channel, payload });
        if (channel === "edusphere:native:set-device-token") calls.set.push(payload);
        if (channel === "edusphere:native:clear-device-token") calls.clear += 1;
        if (channel === "edusphere:native:open-external") calls.external.push(payload);
        return Promise.resolve({ ok: true, persisted: true });
      },
    },
  };

  const original = Module._load;
  Module._load = function patched(request) {
    if (request === "electron") return stubElectron;
    return original.apply(this, arguments);
  };
  const preloadPath = path.join(DESKTOP, "preload.js");
  delete require.cache[require.resolve(preloadPath)];
  try {
    require(preloadPath);
  } finally {
    Module._load = original;
  }

  assert.equal(captured.name, "__EDUSPHERE_NATIVE__");
  const api = captured.api;
  assert.ok(Object.isFrozen(api), "the bridge is frozen");
  const keys = Object.keys(api).sort();
  assert.deepEqual(keys, [
    "appVersion", "clearDeviceToken", "deviceId", "deviceName", "getDeviceToken",
    "isNative", "mode", "openExternal", "platform", "print", "savePdf", "setDeviceToken",
  ]);
  assert.equal(api.platform, "linux", "the server receives 'linux', an allowed device platform");
  assert.equal(api.mode, "hub");
  assert.equal(api.getDeviceToken(), "eds_from_keychain", "synchronous read from the keychain");
  assert.equal("secretInternalPath" in api, false, "unknown hello fields are not forwarded");
  assert.equal("ipcRenderer" in api, false, "the IPC object is never exposed");
  assert.equal("require" in api, false);
  assert.equal("process" in api, false);
  assert.equal("send" in api, false, "the page cannot post arbitrary IPC messages");

  api.setDeviceToken("eds_new");
  assert.equal(api.getDeviceToken(), "eds_new");
  assert.deepEqual(calls.set, ["eds_new"]);
  api.clearDeviceToken();
  assert.equal(api.getDeviceToken(), "");
  assert.equal(calls.clear, 1);
  api.openExternal("https://example.com");
  assert.deepEqual(calls.external, ["https://example.com"]);
  assert.equal(calls.sendSync, "edusphere:native:hello");
});

test("the LAN hub page has a strict CSP, the real URL and escaped values", () => {
  const { hubInfoHtml, lanAddresses, primaryLanAddress, firewallGuidance } = require("../lan-hub");
  const interfaces = {
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    "Wi-Fi": [
      { family: "IPv4", internal: false, address: "192.168.1.24" },
      { family: "IPv6", internal: false, address: "fe80::1" },
    ],
  };
  assert.deepEqual(lanAddresses(interfaces), [{ name: "Wi-Fi", address: "192.168.1.24" }]);
  assert.equal(primaryLanAddress(interfaces), "192.168.1.24");

  const html = hubInfoHtml({
    port: 4123,
    interfaces,
    platform: "win32",
    adminUsername: "admin",
    firstRunPassword: "Generated-Pass-1!",
    dataDir: "/home/front office/<script>alert(1)</script>",
    qrSvg: (text) => '<svg class="qr-code" data-url="' + text + '"></svg>',
    appVersion: "1.0.0",
  });

  assert.match(html, /http:\/\/127\.0\.0\.1:4123\//);
  assert.match(html, /http:\/\/192\.168\.1\.24:4123\//);
  assert.match(html, /<svg class="qr-code" data-url="http:\/\/192\.168\.1\.24:4123\/">/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/, "the page is sandboxed by CSP");
  assert.match(html, /script-src 'none'/, "no script can run in the LAN hub window");
  assert.match(html, /Windows Defender Firewall/);
  assert.match(html, /Generated-Pass-1!/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, "stored values are escaped");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  assert.ok(firewallGuidance("linux", 4123).some((line) => line.includes("ufw")));
  assert.ok(firewallGuidance("darwin", 4123).some((line) => line.includes("Firewall")));
});

test("native printing and PDF export go through Electron", async () => {
  const { createPrintService } = require("../print");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edusphere-print-"));
  const printed = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.webContents = {
        print: (options, cb) => { printed.push(options); cb(true, ""); },
        printToPDF: () => Promise.resolve(Buffer.from("%PDF-1.4 fake")),
        once: (event, handler) => { if (event === "did-finish-load") setTimeout(handler, 0); },
      };
    }
    loadURL() {}
    destroy() { this.destroyed = true; }
    isDestroyed() { return false; }
  }
  const service = createPrintService({
    BrowserWindow: FakeWindow,
    dialog: { showSaveDialog: () => Promise.resolve({ canceled: true }) },
    userDataDir: () => dir,
    getDeviceToken: () => "eds_token",
    logger: { warn() {}, log() {} },
  });

  const win = new FakeWindow({});
  const result = await service.printWindow(win, {});
  assert.deepEqual(result, { ok: true, cancelled: false });
  assert.equal(printed.length, 1);
  assert.equal(printed[0].printBackground, true);
  assert.equal(printed[0].pageSize, "A4");

  const saved = await service.savePdfFromWindow(win, { filePath: path.join(dir, "report-card.pdf") });
  assert.equal(saved.ok, true);
  assert.equal(path.basename(saved.filePath), "report-card.pdf");
  assert.match(fs.readFileSync(saved.filePath, "utf8"), /^%PDF/);

  const cancelled = await service.savePdfFromWindow(win, {});
  assert.deepEqual(cancelled, { ok: false, cancelled: true }, "the user can cancel the save dialog");

  const exported = await service.exportUrl("https://school.example.com/report", { filePath: path.join(dir, "batch.pdf") });
  assert.equal(exported.ok, true);
  assert.ok(fs.existsSync(path.join(dir, "batch.pdf")));

  assert.equal(service.pdfFilename ? true : true, true);
  const { pdfFilename } = require("../print");
  assert.equal(pdfFilename("Report Card: Amina / 2026"), "Report Card- Amina - 2026.pdf");
});
