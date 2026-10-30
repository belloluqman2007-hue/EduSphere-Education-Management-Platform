"use strict";
/* ============================================================================
   Embedded runtime — boots the REAL Express + SQLite server on a free port and
   serves the packaged `public/` assets (this is local standalone / LAN hub
   mode). Runs with plain `node --test`: no Electron, no display.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  LAN_HOST,
  LOOPBACK_HOST,
  buildChildEnv,
  bindHostForMode,
  createServerHost,
  dataPathsFor,
  generateSessionSecret,
} = require("../server-host");
const settingsModule = require("../settings");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HAS_SERVER = fs.existsSync(path.join(REPO_ROOT, "server", "app.js"));

function tempDir(prefix = "edusphere-hub-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("bind policy: only LAN hub mode may listen beyond loopback", () => {
  assert.equal(bindHostForMode(settingsModule.MODES.HUB), LAN_HOST);
  assert.equal(bindHostForMode(settingsModule.MODES.CLOUD), LOOPBACK_HOST);
  assert.equal(bindHostForMode(undefined), LOOPBACK_HOST);
});

test("data paths live inside the per-user data folder", () => {
  const paths = dataPathsFor("/tmp/edusphere-user");
  assert.equal(paths.dataDir, path.join("/tmp/edusphere-user", "data"));
  assert.equal(paths.databaseFile, path.join("/tmp/edusphere-user", "data", "madrasa_platform.sqlite"));
  assert.equal(paths.backupDir, path.join("/tmp/edusphere-user", "data", "backups"));
  assert.equal(paths.uploadDir, path.join("/tmp/edusphere-user", "data", "uploads"));
});

test("the child environment is generated, not inherited", () => {
  process.env.DATABASE_URL = "mysql://should-not-leak";
  process.env.RENDER = "true";
  const env = buildChildEnv({
    paths: dataPathsFor("/tmp/edusphere-user"),
    bindHost: LAN_HOST,
    sessionSecret: "s".repeat(64),
    superAdmin: { username: "admin", password: "Generated-Password-123" },
    upstream: { enabled: false, baseUrl: "" },
  });
  delete process.env.DATABASE_URL;
  delete process.env.RENDER;

  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.DATABASE_DRIVER, "sqlite");
  assert.equal(env.DATABASE_URL, undefined, "a developer's MySQL URL must not redirect the school PC");
  assert.equal(env.RENDER, undefined, "Render's ephemeral-disk guard must not fire on a school PC");
  assert.equal(env.DATA_DIR, path.join("/tmp/edusphere-user", "data"));
  assert.equal(env.EDUSPHERE_BIND_HOST, LAN_HOST);
  assert.equal(env.SESSION_SECRET.length, 64);
  assert.equal(env.SUPER_ADMIN_USERNAME, "admin");
  assert.ok(generateSessionSecret().length >= 64);
});

test("host rejects a missing server entry instead of crashing silently", async () => {
  const host = createServerHost({ userDataDir: tempDir(), entryPath: "/nonexistent/server-entry.js" });
  await assert.rejects(() => host.start(), /missing/);
});

test("the embedded server boots on an ephemeral port and serves /login and /sw.js", { timeout: 240000, skip: !HAS_SERVER }, async (t) => {
  const userDataDir = tempDir();
  const host = createServerHost({
    appRoot: REPO_ROOT,
    userDataDir,
    mode: settingsModule.MODES.HUB,
    port: 0,
    superAdmin: { username: "admin", password: "Hub-Boot-Test-Password-1!" },
    readyTimeoutMs: 180000,
  });
  t.after(async () => { await host.stop({ force: true }); });

  const info = await host.start();
  assert.ok(info, "start() resolves with the listening info");
  assert.equal(info.bindHost, LAN_HOST, "hub mode listens on the LAN wildcard");
  assert.ok(info.port > 0, "a real ephemeral port is reported");
  assert.equal(info.url, "http://127.0.0.1:" + info.port + "/");
  assert.ok(fs.existsSync(path.join(dataPathsFor(userDataDir).dataDir, "madrasa_platform.sqlite")),
    "the SQLite database is created inside userData/data");
  assert.ok(info.pid > 0, "the server runs in its own process");

  const login = await fetch(info.url + "login", { headers: { accept: "text/html" } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("content-type") || "", /text\/html/, "/login answers with the app shell");
  assert.equal(login.headers.get("x-powered-by"), null, "the Express signature is still disabled");
  assert.match(login.headers.get("content-security-policy") || "", /default-src 'self'/, "the platform's CSP is served untouched");
  const loginHtml = await login.text();
  assert.match(loginHtml, /<div id="app">/, "the packaged public/index.html is the SPA shell that renders the sign-in form");
  assert.match(loginHtml, /\/js\/offline-db\.js/, "the Phase 2 offline bundle is shipped in the desktop app");
  assert.match(loginHtml, /\/css\/offline-sync\.css/, "the Phase 2 stylesheet is shipped too");

  // The very same scripts the browser build serves — proving the desktop app
  // reuses the Phase 2 bundle instead of a fork.
  const apiJs = await fetch(info.url + "js/api.js");
  assert.equal(apiJs.status, 200);
  const apiSource = await apiJs.text();
  assert.match(apiSource, /__EDUSPHERE_NATIVE__/, "api.js still knows about the native bridge");
  assert.match(apiSource, /\/auth\/login/, "the sign-in request is the same one the web build makes");

  const sw = await fetch(info.url + "sw.js");
  assert.equal(sw.status, 200, "the Phase 2 service worker asset is shipped in the packaged app");
  assert.match(sw.headers.get("content-type") || "", /javascript/, "sw.js is served as JavaScript");
  const swSource = await sw.text();
  assert.match(swSource, /edusphere-shell/, "public/sw.js is the real Phase 2 worker");

  const health = await fetch(info.url + "api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "multi-madrasa-platform" });

  const config = await fetch(info.url + "app-config.js");
  assert.equal(config.status, 200);
  assert.match(await config.text(), /"syncVersion":1/, "offline sync config is exposed to the shell");

  const logs = host.logTail(50);
  assert.match(logs, /listening/i, "the boot is logged for the desktop log view");

  const stopped = await host.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(host.isRunning(), false);
  const after = await fetch(info.url + "api/health").then(() => "up").catch(() => "down");
  assert.equal(after, "down", "quitting the app really closes the port");
});

test("a second host on the same data folder starts too (no locked-file crash)", { timeout: 240000, skip: !HAS_SERVER }, async (t) => {
  const userDataDir = tempDir();
  const make = () => createServerHost({
    appRoot: REPO_ROOT,
    userDataDir,
    mode: settingsModule.MODES.HUB,
    port: 0,
    superAdmin: { username: "admin", password: "Hub-Boot-Test-Password-2!" },
    readyTimeoutMs: 180000,
  });
  const first = make();
  const second = make();
  t.after(async () => { await first.stop({ force: true }); await second.stop({ force: true }); });

  const a = await first.start();
  const b = await second.start();
  assert.notEqual(a.port, b.port, "each launch picks its own free port");
  const health = await fetch(b.url + "api/health");
  assert.equal(health.status, 200);
});
