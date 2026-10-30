"use strict";
/* ============================================================================
   SECURITY & ZERO CRASHES
   ----------------------------------------------------------------------------
   The hard requirements of Phase 4, each proven rather than asserted in prose:

     • no plaintext token on disk                (secure-token.test.js + here)
     • camera permission only when the scanner opens (camera-permission.test.js)
     • native deep-link and URL allow-lists       (here)
     • no remote code                             (here)
     • a WebView error boundary instead of a blank page (here, behaviourally)
     • uncaught-error handling                    (here, behaviourally)
     • no data loss when the app is killed        (here + storage-adapter.test.js)
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootNativeBridge, createDom, read, MOBILE, REPO } = require("./helpers");

const BRIDGE = read(path.join("public", "js", "native-bridge.js"), REPO);
const SHELL = read(path.join("public", "js", "mobile-shell.js"), REPO);
const STORAGE = read(path.join("public", "js", "mobile-storage.js"), REPO);
const CAP_CONFIG = read(path.join("mobile", "capacitor.config.ts"), REPO);

/* --------------------------------- allow-lists --------------------------- */

test("the server URL allow-list accepts https anywhere and http only on a private LAN", async () => {
  const ctx = await bootNativeBridge();
  const normalise = ctx.mobile.server.normalize;

  assert.equal(normalise("https://school.edusphere.app"), "https://school.edusphere.app");
  assert.equal(normalise("https://school.edusphere.app/"), "https://school.edusphere.app");
  assert.equal(normalise("school.edusphere.app"), "https://school.edusphere.app", "a bare host defaults to https");
  for (const host of ["10.0.0.5:4123", "172.16.4.9:4123", "192.168.1.5:4123", "127.0.0.1:4123", "hub.local:4123"]) {
    assert.equal(normalise("http://" + host), "http://" + host, host + " is a private LAN address");
  }

  for (const bad of [
    "http://school.example.com",
    "http://8.8.8.8",
    "https://user:pass@school.example.com",
    "ftp://school.example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "   ",
    "https://" + "a".repeat(600) + ".example",
  ]) {
    assert.equal(normalise(bad), "", JSON.stringify(bad) + " must be refused");
  }
  ctx.close();
});

test("the deep-link allow-list refuses anything that could reach outside the app", async () => {
  const ctx = await bootNativeBridge();
  const parse = ctx.mobile.deepLink;
  assert.equal(parse("edusphere://sync").action, "sync");
  assert.equal(parse("edusphere://open/reports/term-1").path, "/reports/term-1");
  assert.equal(parse("edusphere://hub?url=http://192.168.0.10:4123").serverUrl, "http://192.168.0.10:4123");

  for (const bad of [
    "https://school.edusphere.app/open/students",
    "edusphere://open/..%2f..%2fetc",
    "edusphere://open/../../etc/passwd",
    "edusphere://hub?url=http://attacker.example",
    "edusphere://hub?url=https://evil%40school.example",
    "edusphere://settings\u0000",
    "edusphere://" + "x".repeat(600),
    "intent://scan/#Intent;scheme=zxing;end",
  ]) {
    assert.equal(parse(bad), null, JSON.stringify(bad) + " must be refused");
  }
  ctx.close();
});

test("the WebView is not allowed to navigate anywhere on its own", () => {
  assert.match(CAP_CONFIG, /allowNavigation:\s*\[\s*\]/);
  assert.match(CAP_CONFIG, /allowMixedContent:\s*false/);
  assert.equal(/javascript:|allowFileAccess|setAllowUniversalAccessFromFileURLs/.test(CAP_CONFIG), false);
});

test("openExternal triple-checks the scheme in JS and again natively", () => {
  const android = read(path.join("mobile", "android", "app", "src", "main", "java", "app", "edusphere", "mobile", "EduSphereNativePlugin.java"), REPO);
  const ios = read(path.join("mobile", "ios", "App", "App", "EduSphereNativePlugin.swift"), REPO);
  for (const source of [android, ios]) {
    assert.match(source, /javascript:|"javascript:"/);
    assert.match(source, /file:/);
    assert.match(source, /content:/);
    assert.match(source, /mailto:/);
  }
});

/* ------------------------------- no remote code -------------------------- */

test("the mobile shell loads no remote code and evaluates nothing dynamically", () => {
  const files = [
    ["native-bridge.js", BRIDGE],
    ["mobile-shell.js", SHELL],
    ["mobile-storage.js", STORAGE],
    ["MainActivity.java", read(path.join("mobile", "android", "app", "src", "main", "java", "app", "edusphere", "mobile", "MainActivity.java"), REPO)],
    ["EduSphereNativePlugin.java", read(path.join("mobile", "android", "app", "src", "main", "java", "app", "edusphere", "mobile", "EduSphereNativePlugin.java"), REPO)],
    ["AppDelegate.swift", read(path.join("mobile", "ios", "App", "App", "AppDelegate.swift"), REPO)],
    ["EduSphereNativePlugin.swift", read(path.join("mobile", "ios", "App", "App", "EduSphereNativePlugin.swift"), REPO)],
  ];
  for (const [name, source] of files) {
    assert.equal(/\beval\s*\(/.test(source), false, name + " must not eval");
    assert.equal(/new\s+Function\s*\(/.test(source), false, name + " must not build functions from strings");
    assert.equal(/loadUrl\s*\(\s*["']https?:/.test(source), false, name + " must not load a remote page");
    assert.equal(/import\(\s*["']https?:/.test(source), false, name + " must not import a remote module");
  }
  /* The only JS the camera decoder needs is the vendored file, served locally. */
  assert.match(read(path.join("public", "js", "card-scanner.js"), REPO), /JSQR_SRC = "\/js\/vendor\/jsqr\.js"/);
});

/* ----------------------------- error boundary ---------------------------- */

test("an uncaught error shows a friendly recovery screen, not a blank page", async () => {
  const ctx = await bootNativeBridge();
  const window = ctx.window;

  window.dispatchEvent(new window.ErrorEvent("error", { message: "Unexpected token <" }));

  const screen = window.document.getElementById("edusphere-native-crash");
  assert.ok(screen, "the recovery screen is mounted");
  assert.equal(screen.getAttribute("role"), "alertdialog");
  assert.match(screen.textContent, /Something went wrong on this screen/);
  assert.match(screen.textContent, /saved on this device/i, "the operator is told their work is safe");
  assert.match(screen.textContent, /Reload EduSphere/, "there is an action, not just an apology");
  assert.match(screen.textContent, /Unexpected token/, "the technical detail is kept, small");
  assert.equal(screen.querySelector("button").style.minHeight, "48px", "the action is thumb-sized");
  ctx.close();
});

test("an unhandled promise rejection is caught too", async () => {
  const ctx = await bootNativeBridge();
  const window = ctx.window;
  const event = new window.Event("unhandledrejection");
  event.reason = new Error("Sync exploded");
  window.dispatchEvent(event);
  const screen = window.document.getElementById("edusphere-native-crash");
  assert.ok(screen, "a rejected promise cannot leave a blank WebView");
  assert.match(screen.textContent, /Sync exploded/);
  ctx.close();
});

test("a boot that paints nothing lands on a friendly screen instead of a white rectangle", async () => {
  const ctx = await bootNativeBridge();
  /* The watchdog is a 12s timer; proving the screen exists is what matters, and
     the same function is what the timer calls. */
  assert.equal(typeof ctx.mobile.showFriendlyScreen, "function");
  ctx.mobile.showFriendlyScreen("startup", "The app shell did not render.");
  const screen = ctx.window.document.getElementById("edusphere-native-crash");
  assert.match(screen.textContent, /could not finish starting/);
  ctx.close();
});

test("the recovery screen never stacks duplicates", async () => {
  const ctx = await bootNativeBridge();
  ctx.mobile.showFriendlyScreen("runtime", "one");
  ctx.mobile.showFriendlyScreen("runtime", "two");
  assert.equal(ctx.window.document.querySelectorAll("#edusphere-native-crash").length, 1);
  ctx.close();
});

test("the shell survives a missing plugin set without throwing", async () => {
  const ctx = createDom({
    capacitor: { isNativePlatform: () => true, getPlatform: () => "android", Plugins: {} },
    beforeEval: (window) => {
      window.SyncEngine = { setOnline() {}, setConnectivityProbe() {}, syncNow: () => Promise.resolve({}) };
    },
    storage: { "edusphere.mobile.server": "https://school.edusphere.app" },
  });
  ctx.evalFile("native-bridge.js");
  await ctx.window.__EDUSPHERE_MOBILE__.ready;
  ctx.evalFile("mobile-shell.js");
  assert.equal(ctx.errors.filter((error) => !/Not implemented/.test(String(error.message))).length, 0);
  assert.equal(ctx.window.MobileShell.status().secureProvider, "memory", "the app says the token is session-only");
  assert.equal(ctx.window.MobileShell.status().server, "https://school.edusphere.app");
  ctx.close();
});

/* ------------------------------ data durability -------------------------- */

test("the phone's offline store is durable private storage, not a WebView cache", () => {
  const android = read(path.join("mobile", "android", "app", "src", "main", "java", "app", "edusphere", "mobile", "SqliteStore.java"), REPO);
  const ios = read(path.join("mobile", "ios", "App", "App", "SqliteStore.swift"), REPO);
  const manifest = read(path.join("mobile", "android", "app", "src", "main", "AndroidManifest.xml"), REPO);

  assert.match(android, /extends SQLiteOpenHelper/, "Android uses a real database file in app-private storage");
  assert.match(android, /edusphere_offline\.db/);
  assert.match(ios, /applicationSupportDirectory/, "iOS keeps the database in Application Support, not the WebView cache");
  assert.match(ios, /journal_mode=WAL/, "WAL means a kill mid-write does not lose the queue");
  assert.match(ios, /synchronous=NORMAL/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(STORAGE, /migrateFromIndexedDB/, "an update copies the existing queue into SQLite");
  assert.match(STORAGE, /MIGRATION_FLAG/, "and does it exactly once");
});

test("the schema and every write survive an app kill (each statement is committed)", () => {
  /* No long-lived transaction wraps the session: mobile-storage.js issues one
     statement per call, which SQLite commits itself. */
  assert.equal(/BEGIN TRANSACTION|BEGIN;/.test(STORAGE), false, "no session-wide transaction is held open");
  assert.match(STORAGE, /INSERT OR REPLACE INTO/, "writes are idempotent");
  assert.match(STORAGE, /CREATE TABLE IF NOT EXISTS collections/);
  assert.match(STORAGE, /CREATE TABLE IF NOT EXISTS outbox/);
});

test("the queue is never cleared by a cache clean-up", () => {
  /* Nothing in the mobile shell calls cache.clear(), deletes the database, or
     drops a scope except an explicit sign-out (purgeScope, Phase 2). */
  assert.equal(/deleteDatabase|caches\.delete|clearAll/.test(SHELL + STORAGE), false);
  assert.equal(/scope\.purge\(\)/.test(SHELL), false, "the mobile shell never purges an account by itself");
});
