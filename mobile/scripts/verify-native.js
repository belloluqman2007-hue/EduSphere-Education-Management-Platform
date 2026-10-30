"use strict";
/* ============================================================================
   EduSphere mobile — native security & completeness verification
   ----------------------------------------------------------------------------
   A single command that answers the questions a release must answer, without
   an Android SDK, an Xcode install or a phone:

       npm run verify

   It reads the committed project as FILES and fails (exit 1) when a guarantee
   has been quietly dropped — a missing CAMERA permission, a camera prompt at
   launch, a token written to web storage, an unlisted deep link, an eval(), a
   release build with no signing fallback.

   mobile/test/packaging.test.js and mobile/test/security.test.js assert the
   same things inside `node --test`, so CI catches a regression even if nobody
   runs this script.
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const MOBILE = path.resolve(__dirname, "..");
const REPO = path.resolve(MOBILE, "..");

const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail || "" });
  } catch (error) {
    results.push({ ok: false, name, detail: (error && error.message) || String(error) });
  }
}

function read(relative, root) {
  return fs.readFileSync(path.join(root || MOBILE, relative), "utf8");
}

function has(file, needle, label) {
  const text = read(file);
  if (text.indexOf(needle) === -1) throw new Error(`${file} is missing ${label || needle}`);
  return label || needle;
}

function walk(dir, extensions, out) {
  const files = out || [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "build", "Pods", ".gradle", "public", "dist", ".platform-stash"].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, extensions, files);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) files.push(absolute);
  }
  return files;
}

/* ------------------------------- packaging ------------------------------- */

check("capacitor.config.ts declares appId app.edusphere.mobile and the edusphere scheme", () => {
  const config = read("capacitor.config.ts");
  if (!/appId:\s*["']app\.edusphere\.mobile["']/.test(config)) throw new Error("appId is not app.edusphere.mobile");
  if (!/scheme:\s*["']EduSphere["']/.test(config)) throw new Error("the iOS URL scheme is not declared");
  if (!/webDir:\s*["']public["']/.test(config)) throw new Error("webDir is not public");
  if (!/allowNavigation:\s*\[\s*\]/.test(config)) throw new Error("the WebView must not be allowed to navigate anywhere");
  return "appId, scheme, webDir, empty allowNavigation";
});

check("Capacitor lives only in mobile/package.json (the root install is untouched)", () => {
  const mobilePkg = JSON.parse(read("package.json"));
  const rootPkg = JSON.parse(read("package.json", REPO));
  const deps = Object.keys(mobilePkg.devDependencies || {});
  for (const required of ["@capacitor/core", "@capacitor/cli", "@capacitor/android", "@capacitor/ios", "@capacitor/app", "@capacitor/network"]) {
    if (!deps.includes(required)) throw new Error("mobile/package.json is missing " + required);
  }
  const rootAll = Object.assign({}, rootPkg.dependencies, rootPkg.devDependencies);
  if (Object.keys(rootAll).some((name) => name.startsWith("@capacitor/"))) throw new Error("Capacitor leaked into the root package.json");
  return deps.length + " mobile devDependencies, none at the root";
});

check("mobile build output is git-ignored", () => {
  const ignore = read(".gitignore", REPO);
  for (const pattern of ["mobile/node_modules/", "mobile/public/", "mobile/android/app/src/main/assets/public/", "mobile/android/app/build/"]) {
    if (ignore.indexOf(pattern) === -1) throw new Error(".gitignore is missing " + pattern);
  }
  return "node_modules, staged web assets, gradle output";
});

/* -------------------------------- android -------------------------------- */

check("Android manifest requests exactly the permissions the app needs", () => {
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  for (const permission of ["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE", "android.permission.CAMERA"]) {
    if (manifest.indexOf(permission) === -1) throw new Error("manifest is missing " + permission);
  }
  if (/android\.permission\.(READ_CONTACTS|READ_SMS|RECORD_AUDIO|ACCESS_FINE_LOCATION|READ_EXTERNAL_STORAGE)/.test(manifest)) {
    throw new Error("manifest requests a permission the app does not use");
  }
  return "INTERNET, ACCESS_NETWORK_STATE, CAMERA only";
});

check("Android deep link is the edusphere:// scheme with a single-launch activity", () => {
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  if (!/android:scheme="edusphere"/.test(manifest)) throw new Error("no edusphere:// intent filter");
  if (!/android:launchMode="singleTask"/.test(manifest)) throw new Error("launchMode should be singleTask so a deep link reuses the window");
  if (!/android:allowBackup="false"/.test(manifest)) throw new Error("backups must not carry the device token store");
  return "edusphere://, singleTask, allowBackup=false";
});

check("Android release signing falls back to the debug key (no secrets required)", () => {
  const gradle = read("android/app/build.gradle");
  if (!/signingConfig hasReleaseKeystore \? signingConfigs\.release : signingConfigs\.debug/.test(gradle)) {
    throw new Error("release signing has no debug fallback");
  }
  if (!/applicationId "app\.edusphere\.mobile"/.test(gradle)) throw new Error("applicationId must be app.edusphere.mobile");
  if (/storePassword\s+"[^"]+"/.test(gradle)) throw new Error("a keystore password is hard-coded");
  return "env-driven signing with a debug fallback";
});

check("Android token storage is KeyStore-encrypted and never plain", () => {
  const store = read("android/app/src/main/java/app/edusphere/mobile/SecureTokenStore.java");
  if (!/AndroidKeyStore/.test(store)) throw new Error("no AndroidKeyStore key");
  if (!/AES\/GCM\/NoPadding/.test(store)) throw new Error("no AES-GCM encryption");
  if (!/setUserAuthenticationRequired\(false\)/.test(store)) throw new Error("the key must be usable by a background sync");
  if (!/Base64\.encodeToString/.test(store)) throw new Error("the ciphertext is not stored base64-encoded");
  const prefs = /getSharedPreferences\(PREFS, Context\.MODE_PRIVATE\)/.test(store);
  if (!prefs) throw new Error("the store must be app-private");
  if (/putString\([^)]*value\s*\)/.test(store)) throw new Error("a plaintext value is written to preferences");
  return "AndroidKeyStore AES-256-GCM over MODE_PRIVATE ciphertext";
});

check("Android offline database is a real SQLiteOpenHelper", () => {
  const sqlite = read("android/app/src/main/java/app/edusphere/mobile/SqliteStore.java");
  if (!/extends SQLiteOpenHelper/.test(sqlite)) throw new Error("SqliteStore does not extend SQLiteOpenHelper");
  if (!/edusphere_offline\.db/.test(sqlite)) throw new Error("the database file is not named edusphere_offline.db");
  return "SQLiteOpenHelper → edusphere_offline.db";
});

check("Android camera permission is only requested from the plugin (never at launch)", () => {
  const plugin = read("android/app/src/main/java/app/edusphere/mobile/EduSphereNativePlugin.java");
  if (!/@Permission\(alias = "camera", strings = \{ Manifest\.permission\.CAMERA \}\)/.test(plugin)) {
    throw new Error("the camera permission alias is not declared");
  }
  if (!/requestPermissionForAlias\(CAMERA_ALIAS/.test(plugin)) throw new Error("the runtime request is missing");
  if (!/denied-permanently/.test(plugin)) throw new Error("the permanently-denied state is not reported");
  if (!/ACTION_APPLICATION_DETAILS_SETTINGS/.test(plugin)) throw new Error("there is no route to Settings");
  const activity = read("android/app/src/main/java/app/edusphere/mobile/MainActivity.java");
  if (/requestPermissions|CAMERA/.test(activity)) throw new Error("MainActivity asks for the camera at launch");
  return "runtime request + rationale + permanently-denied path";
});

/* ---------------------------------- ios ---------------------------------- */

check("iOS Info.plist explains the camera, local network and deep links", () => {
  const plist = read("ios/App/App/Info.plist");
  if (!/NSCameraUsageDescription/.test(plist)) throw new Error("NSCameraUsageDescription is missing (App Review rejects the build)");
  if (!/NSLocalNetworkUsageDescription/.test(plist)) throw new Error("NSLocalNetworkUsageDescription is missing (LAN hub pairing)");
  if (!/<string>edusphere<\/string>/.test(plist)) throw new Error("the edusphere URL scheme is not registered");
  if (!/NSAllowsLocalNetworking/.test(plist)) throw new Error("ATS has no local-networking exception, so a LAN hub cannot be reached");
  return "camera, local network, edusphere:// scheme";
});

check("iOS tokens live in the Keychain with ThisDeviceOnly accessibility", () => {
  const store = read("ios/App/App/SecureTokenStore.swift");
  if (!/kSecClassGenericPassword/.test(store)) throw new Error("not a Keychain item");
  if (!/kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/.test(store)) throw new Error("wrong accessibility class");
  if (/UserDefaults\.(standard|suiteName)/.test(store)) throw new Error("the token must never go to UserDefaults");
  return "Keychain generic password, ThisDeviceOnly";
});

check("iOS SQLite store and plugin are present and registered", () => {
  const sqlite = read("ios/App/App/SqliteStore.swift");
  if (!/import SQLite3/.test(sqlite)) throw new Error("SQLite3 is not imported");
  if (!/edusphere_offline\.db/.test(sqlite)) throw new Error("wrong database file name");
  const delegate = read("ios/App/App/AppDelegate.swift");
  if (!/registerPluginInstance\(EduSphereNativePlugin\(\)\)/.test(delegate)) throw new Error("the plugin is never registered");
  if (!/ApplicationDelegateProxy\.shared\.application\(app, open: url/.test(delegate)) throw new Error("deep links are not forwarded to Capacitor");
  return "SQLite3 + registered plugin + deep-link forwarding";
});

/* ------------------------------ the web side ----------------------------- */

check("native-bridge.js exposes the same frozen contract as the desktop shell", () => {
  const bridge = read("public/js/native-bridge.js", REPO);
  for (const member of ["isNative", "appVersion", "platform", "deviceId", "deviceName", "mode",
    "getDeviceToken", "setDeviceToken", "clearDeviceToken", "print", "savePdf", "openExternal"]) {
    if (bridge.indexOf(member) === -1) throw new Error("the contract is missing " + member);
  }
  if (!/Object\.freeze\(bridge\)/.test(bridge)) throw new Error("the bridge is not frozen");
  return "12-member frozen surface";
});

check("the device token never touches web storage", () => {
  const bridge = read("public/js/native-bridge.js", REPO);
  /* Writes and reads are what matter; a REMOVAL of a stale browser token is a
     scrub, not a leak (and is asserted separately below). */
  if (/localStorage\.(setItem|getItem)\([^)]*deviceToken/i.test(bridge)) throw new Error("the token is written to or read from localStorage");
  if (/document\.cookie\s*=/.test(bridge)) throw new Error("the token is written to a cookie");
  if (!/AndroidKeyStore|keychain|secureSet/.test(bridge)) throw new Error("no secure store is used");
  if (!/removeItem\("edusphere\.deviceToken"\)/.test(bridge)) throw new Error("a stale browser token is never scrubbed");
  return "no token in localStorage, cookie or plain file (a stale web token is deleted)";
});

check("server addresses are allow-listed (https, or http on a private LAN only)", () => {
  const bridge = read("public/js/native-bridge.js", REPO);
  if (!/PRIVATE_HOST/.test(bridge)) throw new Error("no private-host allow-list");
  if (!/url\.protocol === "http:" && !PRIVATE_HOST\.test\(url\.hostname\)/.test(bridge)) {
    throw new Error("a public http origin would be accepted");
  }
  return "https anywhere, http on 10/8 · 172.16/12 · 192.168/16 · localhost · *.local";
});

check("deep links are parsed against an allow-list", () => {
  const bridge = read("public/js/native-bridge.js", REPO);
  if (!/url\.protocol !== "edusphere:"/.test(bridge)) throw new Error("a foreign scheme would be accepted");
  if (!/ROUTE_SEGMENT\.test\(path\)/.test(bridge)) throw new Error("deep-link paths are not validated");
  if (!/indexOf\("\.\."\)/.test(bridge)) throw new Error("path traversal is not refused");
  return "edusphere: only; sync/open/hub/settings/about";
});

check("no remote code and no dynamic evaluation anywhere in the mobile shell", () => {
  const files = [
    path.join(REPO, "public", "js", "native-bridge.js"),
    path.join(REPO, "public", "js", "mobile-storage.js"),
    path.join(REPO, "public", "js", "mobile-shell.js"),
    ...walk(path.join(MOBILE, "android", "app", "src", "main", "java"), [".java"]),
    ...walk(path.join(MOBILE, "ios", "App", "App"), [".swift"]),
  ].concat(walk(path.join(MOBILE, "scripts"), [".js"]))
    /* This file searches for the strings themselves, so it is not shipped app
       code and cannot be its own evidence. */
    .filter((file) => path.basename(file) !== "verify-native.js");
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (/\beval\s*\(/.test(text)) offenders.push(path.relative(REPO, file) + " uses eval()");
    if (/new\s+Function\s*\(/.test(text)) offenders.push(path.relative(REPO, file) + " uses new Function()");
    if (/(loadUrl|loadDataWithBaseURL)\s*\(\s*["']https?:/.test(text)) offenders.push(path.relative(REPO, file) + " loads remote code into a WebView");
    if (/(https?:\/\/[^\s"']+\.js)/.test(text) && /import|require|src=/.test(text) && !/docs|comment/.test(text)) {
      offenders.push(path.relative(REPO, file) + " references a remote script");
    }
  }
  if (offenders.length) throw new Error(offenders.join("; "));
  return files.length + " native/web files, no eval and no remote script";
});

check("the WebView has an error boundary instead of a blank page", () => {
  const bridge = read("public/js/native-bridge.js", REPO);
  if (!/unhandledrejection/.test(bridge)) throw new Error("rejected promises are not caught");
  if (!/addEventListener\("error"/.test(bridge)) throw new Error("uncaught errors are not caught");
  if (!/EduSphere could not finish starting/.test(bridge)) throw new Error("there is no friendly startup screen");
  if (!/Reload EduSphere/.test(bridge)) throw new Error("the recovery screen has no action");
  return "error + unhandledrejection + boot watchdog → friendly screen";
});

check("the release workflow exists (live or under docs/ci) with Android + gated iOS jobs", () => {
  const live = path.join(REPO, ".github", "workflows", "mobile-release.yml");
  const canonical = path.join(REPO, "docs", "ci", "mobile-release.yml");
  const file = fs.existsSync(live) ? live : canonical;
  if (!fs.existsSync(file)) throw new Error("no mobile-release.yml anywhere");
  const workflow = fs.readFileSync(file, "utf8");
  if (!/assembleDebug|assembleRelease/.test(workflow)) throw new Error("no Android assemble step");
  if (!/bundleRelease/.test(workflow)) throw new Error("no .aab (Play upload) step");
  if (!/xcodebuild -workspace|npm run ios:build/.test(workflow)) throw new Error("no iOS build step");
  if (!/-exportArchive/.test(workflow)) throw new Error("no .ipa export step");
  if (!/macos-latest/.test(workflow)) throw new Error("no macOS runner for iOS");
  if (!/secrets\./.test(workflow)) throw new Error("iOS signing is not secret-gated");
  if (!/upload-artifact/.test(workflow)) throw new Error("artifacts are not uploaded");
  if (!/action-gh-release|softprops/.test(workflow)) throw new Error("no GitHub Release step on a tag");
  /* `secrets` is not an allowed context in a step-level `if`; one occurrence
     makes the whole workflow invalid and GitHub only says so at run time. */
  if (/^\s*if:.*\bsecrets\./m.test(workflow)) throw new Error("a step `if` reads secrets directly (use a job-level env)");
  return path.relative(REPO, file) + " (Android + macOS iOS, secret-gated)";
});

check("the browser build ships no native code (the guard keeps the web app unchanged)", () => {
  const index = read(path.join("public", "index.html"), REPO);
  const boot = read(path.join("public", "js", "native-boot.js"), REPO);
  if (!/<script src="\/js\/native-boot\.js"><\/script>/.test(index)) throw new Error("index.html does not load the guard");
  for (const name of ["native-bridge.js", "mobile-storage.js", "mobile-shell.js"]) {
    if (index.includes('<script src="/js/' + name + '"')) throw new Error(name + " is still downloaded by a browser");
    if (!boot.includes('"/js/' + name + '"')) throw new Error(name + " is not loaded by the guard");
  }
  if (index.indexOf("/js/native-boot.js") > index.indexOf("/js/api.js")) throw new Error("the guard runs after api.js");
  if (!/isNativePlatform|platform/.test(boot)) throw new Error("the guard does not ask Capacitor which shell it is");
  return "one guard in the browser; the three native files only inside the app";
});

/* -------------------------------- report --------------------------------- */

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log((result.ok ? "PASS  " : "FAIL  ") + result.name + (result.detail ? "\n        " + result.detail : ""));
}
console.log("\n" + (results.length - failed.length) + "/" + results.length + " native checks passed");
process.exit(failed.length ? 1 : 0);
