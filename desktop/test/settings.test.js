"use strict";
/* ============================================================================
   Desktop settings — atomic writes, validation and self-healing.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  MODES,
  createSettingsStore,
  defaultSettings,
  normalizeBaseUrl,
  normalizeBindHost,
  normalizeMode,
  normalizePort,
  sanitizeSettings,
  settingsPathFor,
  writeFileAtomic,
} = require("../settings");

function tempDir(prefix = "edusphere-settings-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("defaults are complete and a fresh store writes them atomically", () => {
  const dir = tempDir();
  const store = createSettingsStore({ userDataDir: dir });
  const settings = store.load();

  assert.equal(settings.mode, MODES.CLOUD);
  assert.equal(settings.firstRunComplete, false);
  assert.equal(settings.hub.bindHost, "0.0.0.0");
  assert.equal(store.isConfigured(), false);

  store.setMode(MODES.HUB);
  const file = settingsPathFor(dir);
  assert.ok(fs.existsSync(file), "settings.json should exist after the first write");

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.mode, MODES.HUB);
  assert.ok(saved.updatedAt, "an updatedAt timestamp is recorded");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp")), [], "no temp files are left behind");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "settings.json is per-user readable only");
  }
});

test("a crash during the rename cannot corrupt the previous settings", () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ mode: "hub", firstRunComplete: true }), "utf8");

  const failingFs = Object.create(fs);
  failingFs.renameSync = () => { throw new Error("simulated crash"); };

  const store = createSettingsStore({ userDataDir: dir, fs: failingFs });
  store.load();
  assert.throws(() => store.patch({ mode: MODES.CLOUD }), /simulated crash/);

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.mode, "hub", "the original file is untouched");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "the temp file is cleaned up");
});

test("a corrupt settings file is recovered from defaults and preserved for support", () => {
  const dir = tempDir();
  const file = settingsPathFor(dir);
  fs.writeFileSync(file, "{ this is not json", "utf8");
  const warnings = [];
  const store = createSettingsStore({ userDataDir: dir, logger: { warn: (m) => warnings.push(m) } });

  const settings = store.load();
  assert.equal(settings.mode, MODES.CLOUD);
  assert.equal(warnings.length, 1);
  const preserved = fs.readdirSync(dir).filter((n) => n.includes(".corrupt-"));
  assert.equal(preserved.length, 1, "the broken file is kept aside");
  assert.equal(fs.readFileSync(path.join(dir, preserved[0]), "utf8"), "{ this is not json");
});

test("mode, port, bind host and URLs are validated at the boundary", () => {
  assert.equal(normalizeMode("hub"), "hub");
  assert.equal(normalizeMode(" HUB "), "hub");
  assert.equal(normalizeMode("native"), "cloud");
  assert.equal(normalizeMode(undefined), "cloud");

  assert.equal(normalizePort("8080"), 8080);
  assert.equal(normalizePort(-5), 0);
  assert.equal(normalizePort("not a port"), 0);
  assert.equal(normalizePort(70000), 0);

  assert.equal(normalizeBindHost("0.0.0.0"), "0.0.0.0");
  assert.equal(normalizeBindHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeBindHost("8.8.8.8"), "0.0.0.0", "a public address is never accepted");

  assert.equal(normalizeBaseUrl("https://school.edusphere.app/"), "https://school.edusphere.app");
  assert.equal(normalizeBaseUrl("http://192.168.1.10:3000"), "http://192.168.1.10:3000");
  assert.equal(normalizeBaseUrl("javascript:alert(1)"), "");
  assert.equal(normalizeBaseUrl("file:///etc/passwd"), "");
  assert.equal(normalizeBaseUrl("https://user:pass@example.com"), "");
  assert.equal(normalizeBaseUrl(""), "");
});

test("unknown keys are dropped and a cloud mode without an address is not 'configured'", () => {
  const sanitized = sanitizeSettings({
    mode: "cloud",
    firstRunComplete: true,
    cloud: { baseUrl: "https://school.example.org", evil: "yes" },
    injected: { shell: true },
    device: { id: "desk-1234abcd-9999", name: "Front office PC" },
  });
  assert.equal(sanitized.evil, undefined);
  assert.equal(sanitized.injected, undefined);
  assert.equal(sanitized.cloud.evil, undefined);
  assert.equal(sanitized.cloud.baseUrl, "https://school.example.org");
  assert.equal(sanitized.device.id, "desk-1234abcd-9999");

  const unusable = sanitizeSettings({ mode: "cloud", firstRunComplete: true });
  assert.equal(unusable.firstRunComplete, false, "the wizard re-opens instead of showing a blank window");

  const hub = sanitizeSettings({ mode: "hub", firstRunComplete: true });
  assert.equal(hub.firstRunComplete, true, "LAN hub mode needs no remote address");

  const badDevice = sanitizeSettings({ device: { id: "not-a-device-id", name: "x" } });
  assert.equal(badDevice.device.id, "", "a malformed device id is discarded");

  assert.deepEqual(defaultSettings().mode, "cloud");
});

test("patches merge per section and never resurrect an invalid mode", () => {
  const dir = tempDir();
  const store = createSettingsStore({ userDataDir: dir });
  store.patch({ cloud: { baseUrl: "https://a.example.com" } });
  store.patch({ hub: { adminUsername: "Principal" } });
  const settings = store.get();
  assert.equal(settings.cloud.baseUrl, "https://a.example.com");
  assert.equal(settings.hub.adminUsername, "principal", "usernames are normalised to lower case");
  assert.equal(store.completeFirstRun({ mode: "hub" }).firstRunComplete, true);
  assert.equal(store.isConfigured(), true);
  assert.equal(store.setMode("bogus").mode, "cloud");
});

test("writeFileAtomic replaces the target in one step", () => {
  const dir = tempDir();
  const file = path.join(dir, "x.json");
  fs.writeFileSync(file, "old", "utf8");
  writeFileAtomic(file, "new", { mode: 0o600 });
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["x.json"]);
});
