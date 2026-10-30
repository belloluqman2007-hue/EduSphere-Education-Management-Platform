"use strict";
/* ============================================================================
   TOKEN & STORAGE SECURITY (static + behavioural)
   ----------------------------------------------------------------------------
   A Bearer device token is a full sign-in for 90 days. It must never be
   readable by a script the page loads (localStorage), never written to a plain
   file, and never backed up to another device.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { read, MOBILE, REPO, bootNativeBridge } = require("./helpers");

const BRIDGE = read(path.join("public", "js", "native-bridge.js"), REPO);
const ANDROID_STORE = read(path.join("mobile", "android", "app", "src", "main", "java", "app", "edusphere", "mobile", "SecureTokenStore.java"), REPO);
const ANDROID_PLUGIN = read(path.join("mobile", "android", "app", "src", "main", "java", "app", "edusphere", "mobile", "EduSphereNativePlugin.java"), REPO);
const IOS_STORE = read(path.join("mobile", "ios", "App", "App", "SecureTokenStore.swift"), REPO);
const IOS_PLUGIN = read(path.join("mobile", "ios", "App", "App", "EduSphereNativePlugin.swift"), REPO);
const IOS_PLIST = read(path.join("mobile", "ios", "App", "App", "Info.plist"), REPO);
const ANDROID_MANIFEST = read(path.join("mobile", "android", "app", "src", "main", "AndroidManifest.xml"), REPO);

test("the bridge never puts a token in localStorage, sessionStorage or a cookie", () => {
  const lines = BRIDGE.split("\n").filter((line) => /localStorage|sessionStorage|document\.cookie/.test(line));
  for (const line of lines) {
    /* A REMOVAL of a stale browser token is the opposite of a leak. */
    if (/removeItem\("edusphere\.deviceToken"\)/.test(line)) continue;
    assert.equal(/TOKEN/i.test(line), false, "a web-storage line mentions the token: " + line.trim());
  }
  assert.equal(/document\.cookie\s*=/.test(BRIDGE), false, "the bridge never writes a cookie");
  assert.equal(/sessionStorage/.test(BRIDGE), false, "the bridge never uses sessionStorage");
  assert.match(BRIDGE, /TOKEN_KEY = "device_token"/, "the key the OS store uses");
  assert.match(BRIDGE, /nativePlugin\.setSecureValue/, "writes go to the native secure store");
});

test("localStorage is used only for the non-secret server address", () => {
  const storageLines = BRIDGE.split("\n").filter((line) => /localStorage\.(setItem|getItem|removeItem)/.test(line));
  assert.ok(storageLines.length >= 2, "the server address is cached for a synchronous api base");
  for (const line of storageLines) {
    /* The one exception allowed: deleting a stale browser-era device token. */
    if (/removeItem\("edusphere\.deviceToken"\)/.test(line)) continue;
    assert.match(line, /SERVER_STORAGE_KEY/, "only the server-address key is touched: " + line.trim());
  }
  assert.match(BRIDGE, /removeItem\("edusphere\.deviceToken"\)/, "an upgraded phone scrubs the old web token");
  assert.equal(/localStorage\.(setItem|getItem)\([^)]*deviceToken/i.test(BRIDGE), false);
});

test("Android stores the token with an AndroidKeyStore AES-GCM key", () => {
  assert.match(ANDROID_STORE, /KeyStore\.getInstance\("AndroidKeyStore"\)/);
  assert.match(ANDROID_STORE, /KeyProperties\.KEY_ALGORITHM_AES/);
  assert.match(ANDROID_STORE, /TRANSFORMATION = "AES\/GCM\/NoPadding"/);
  assert.match(ANDROID_STORE, /setKeySize\(256\)/);
  assert.match(ANDROID_STORE, /getSharedPreferences\(PREFS, Context\.MODE_PRIVATE\)/, "app-private preferences");
  assert.match(ANDROID_STORE, /Base64\.encodeToString\(blob/, "only ciphertext is written");
  assert.equal(/\.putString\([^)]*plain/i.test(ANDROID_STORE), false, "no plaintext write");
});

test("a decryption failure returns an empty token instead of crashing", () => {
  assert.match(ANDROID_STORE, /catch \(Exception e\) \{[\s\S]{0,400}return "";/, "Android degrades to signed-out");
  assert.match(IOS_STORE, /guard status == errSecSuccess[\s\S]{0,200}return ""/, "iOS degrades to signed-out");
});

test("iOS stores the token in the Keychain, ThisDeviceOnly", () => {
  assert.match(IOS_STORE, /kSecClassGenericPassword/);
  assert.match(IOS_STORE, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  assert.match(IOS_STORE, /app\.edusphere\.mobile\.secrets/);
  assert.equal(/UserDefaults\.(standard|suiteName)/.test(IOS_STORE), false, "the token never goes to UserDefaults");
  assert.equal(/NSUserDefaults\.(standard|suiteName)/.test(IOS_PLUGIN), false, "the plugin never reads UserDefaults");
  assert.equal(/NSUserDefaults/.test(IOS_PLUGIN), false);
});

test("the token store is not backed up to another device", () => {
  assert.match(ANDROID_MANIFEST, /android:allowBackup="false"/, "Android backups are off");
  assert.match(IOS_STORE, /ThisDeviceOnly/, "the Keychain item stays on this device");
  assert.match(ANDROID_MANIFEST, /android:allowBackup="false"[\s\S]*android:label/, "declared on the application element");
});

test("no native file writes a plaintext token to disk or logs it", () => {
  const files = [
    ["android/SecureTokenStore.java", ANDROID_STORE],
    ["android/EduSphereNativePlugin.java", ANDROID_PLUGIN],
    ["ios/SecureTokenStore.swift", IOS_STORE],
    ["ios/EduSphereNativePlugin.swift", IOS_PLUGIN],
  ];
  for (const [name, source] of files) {
    assert.equal(/FileOutputStream|writeToFile|open\(.*device_token/.test(source), false, name + " must not write the token to a file");
    assert.equal(/Log\.[difwe]\([^)]*token/i.test(source), false, name + " must not log the token");
    assert.equal(/print\([^)]*token/i.test(source), false, name + " must not print the token");
  }
});

test("the token is never rendered into the DOM or exported in a download", () => {
  assert.equal(/btoa\([^)]*token/i.test(BRIDGE), false);
  assert.equal(/localStorage\.setItem\([^)]*token/i.test(BRIDGE), false);
});

test("a real sign-out wipes the OS store (proven through the bridge)", async () => {
  const ctx = await bootNativeBridge({ secureOptions: { initial: { device_token: "eds_session_token" } } });
  await ctx.window.__EDUSPHERE_NATIVE__.clearDeviceToken();
  assert.equal(ctx.secure.secure.get("device_token"), undefined);
  assert.equal(ctx.secure.calls.remove.includes("device_token"), true);
  assert.equal(JSON.stringify(Object.entries(ctx.window.localStorage)).includes("eds_session_token"), false);
  ctx.close();
});

test("native sources contain no secret and no remote code", () => {
  const sources = [ANDROID_STORE, ANDROID_PLUGIN, IOS_STORE, IOS_PLUGIN, BRIDGE, read(path.join("mobile", "capacitor.config.ts"), REPO)];
  for (const source of sources) {
    assert.equal(/\beval\s*\(/.test(source), false);
    assert.equal(/new\s+Function\s*\(/.test(source), false);
    assert.equal(/https?:\/\/[^\s"']+\.(js|css)/.test(source), false, "no remote asset is referenced");
    assert.equal(/AIza[0-9A-Za-z_-]{10,}|-----BEGIN (RSA |EC )?PRIVATE KEY-----|sk_live_/.test(source), false, "no credential is committed");
  }
});

test("mobile/ contains no committed keystore or provisioning profile", () => {
  const forbidden = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "build", "Pods", ".gradle", "public", "dist", ".platform-stash"].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/\.(jks|keystore|p12|pfx|mobileprovision|cer|key)$/i.test(entry.name)) forbidden.push(path.relative(REPO, absolute));
    }
  };
  walk(MOBILE);
  assert.deepEqual(forbidden, [], "no signing material is committed");
});
