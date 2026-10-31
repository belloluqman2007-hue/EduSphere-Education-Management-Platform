"use strict";
/* ============================================================================
   PACKAGING CONTRACT
   ----------------------------------------------------------------------------
   Everything here is checked as FILES, so an edit that quietly drops a
   permission, a signing fallback, an artifact or the release workflow fails the
   suite instead of the release.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { MOBILE, REPO, read } = require("./helpers");

function exists(relative, root) {
  return fs.existsSync(path.join(root || MOBILE, relative));
}

test("mobile/ is self-contained: Capacitor lives only in mobile/package.json", () => {
  const mobilePkg = JSON.parse(read("package.json"));
  const rootPkg = JSON.parse(read("package.json", REPO));
  const devDeps = mobilePkg.devDependencies || {};

  for (const dependency of ["@capacitor/core", "@capacitor/cli", "@capacitor/android", "@capacitor/ios", "@capacitor/app", "@capacitor/network"]) {
    assert.ok(devDeps[dependency], dependency + " is a devDependency of mobile/");
    assert.equal((mobilePkg.dependencies || {})[dependency], undefined, dependency + " is never a runtime dependency");
  }
  const rootAll = Object.assign({}, rootPkg.dependencies, rootPkg.devDependencies);
  assert.equal(Object.keys(rootAll).some((name) => name.startsWith("@capacitor/")), false, "the root install stays fast");
  assert.equal(rootPkg.scripts.test, 'node --disable-warning=ExperimentalWarning --test "test/*.test.js"', "the root test command is unchanged");
  assert.equal(mobilePkg.private, true);
  assert.ok(fs.existsSync(path.join(MOBILE, "package-lock.json")), "the mobile lockfile is committed (npm ci in CI)");
});

test("the workspace exposes every build/test entry the docs promise", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  for (const name of ["sync-web", "add:android", "add:ios", "sync", "android:debug", "android:release", "ios:build", "verify", "test"]) {
    assert.ok(scripts[name], "npm run " + name + " exists");
  }
  assert.match(scripts.test, /node --test/);
});

test("generated folders are git-ignored", () => {
  const ignore = read(".gitignore", REPO);
  for (const pattern of [
    "mobile/node_modules/",
    "mobile/public/",
    "mobile/dist/",
    "mobile/android/app/build/",
    "mobile/android/app/src/main/assets/public/",
    "mobile/ios/App/App/public/",
    "mobile/ios/App/Pods/",
  ]) {
    assert.ok(ignore.includes(pattern), ".gitignore covers " + pattern);
  }
  /* Everything git would carry: tracked files plus new-but-not-ignored ones
     (the branch is committed before it is merged). */
  const committed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "mobile"], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.ok(committed.length > 20, "the native projects are committed: " + committed.length + " files");
  for (const file of committed) {
    assert.equal(file.startsWith("mobile/node_modules/"), false, "no dependency is committed");
    assert.equal(file.startsWith("mobile/public/"), false, "the staged bundle is not committed");
    assert.equal(/\/build\//.test(file), false, "no gradle build output is committed");
  }
});

test("capacitor.config.ts pins the app id, the scheme and the WebView policy", () => {
  const config = read("capacitor.config.ts");
  assert.match(config, /appId:\s*["']app\.edusphere\.mobile["']/);
  assert.match(config, /appName:\s*["']EduSphere["']/);
  assert.match(config, /webDir:\s*["']public["']/);
  assert.match(config, /scheme:\s*["']EduSphere["']/, "the iOS URL scheme is the deep-link scheme");
  assert.match(config, /allowNavigation:\s*\[\s*\]/, "the WebView may not navigate anywhere");
  assert.match(config, /allowMixedContent:\s*false/);
  assert.match(config, /androidScheme:\s*["']http["']/, "http://localhost is a secure context and avoids a mixed-content wall on a LAN hub");
});

test("scripts/sync-web.js copies the repo public/ bundle exactly like desktop/scripts/stage.js", () => {
  const source = read("scripts/sync-web.js");
  assert.match(source, /module\.exports = \{ copyDir/, "copyDir is exported (and testable)");
  assert.match(source, /path\.join\(REPO, "public"\)/, "the source is the repository's public/");
  assert.match(source, /android", "app", "src", "main", "assets", "public"/, "Android assets target");
  assert.match(source, /ios", "App", "App", "public"/, "iOS public target");
  assert.match(source, /NEVER_COPY = new Set\(\["app-config\.js"\]\)/, "the server-rendered config is never shipped");
  assert.match(source, /capacitor\.config\.json/, "a buildable config is written for a build without cap sync");

  const desktopStage = fs.readFileSync(path.join(REPO, "desktop", "scripts", "stage.js"), "utf8");
  for (const pattern of [/rmSync\(to, \{ recursive: true, force: true \}\)/, /IGNORE = \[/, /copyFileSync\(src, dest\)/]) {
    assert.match(source, pattern, "shares the staging approach with the desktop script");
    assert.match(desktopStage, pattern, "…which is still what desktop/scripts/stage.js does");
  }
});

test("sync-web really stages the bundle into the platform web dirs", () => {
  execFileSync(process.execPath, [path.join(MOBILE, "scripts", "sync-web.js")], { cwd: MOBILE, encoding: "utf8" });

  for (const target of [
    path.join(MOBILE, "public"),
    path.join(MOBILE, "android", "app", "src", "main", "assets", "public"),
    path.join(MOBILE, "ios", "App", "App", "public"),
  ]) {
    assert.ok(fs.existsSync(path.join(target, "index.html")), "index.html is staged in " + path.relative(MOBILE, target));
    assert.ok(fs.existsSync(path.join(target, "js", "native-bridge.js")), "the bridge is staged in " + path.relative(MOBILE, target));
    assert.ok(fs.existsSync(path.join(target, "js", "mobile-shell.js")), "the mobile shell is staged");
    assert.ok(fs.existsSync(path.join(target, "css", "mobile-native.css")), "the mobile stylesheet is staged");
    assert.equal(fs.existsSync(path.join(target, "app-config.js")), false, "the server-rendered config is NOT staged");
  }
  const config = JSON.parse(fs.readFileSync(
    path.join(MOBILE, "android", "app", "src", "main", "assets", "public", "capacitor.config.json"), "utf8"));
  assert.equal(config.appId, "app.edusphere.mobile");
});

test("the Android Gradle project is committed and complete", () => {
  for (const file of [
    "android/settings.gradle",
    "android/build.gradle",
    "android/variables.gradle",
    "android/gradle.properties",
    "android/gradle/wrapper/gradle-wrapper.properties",
    "android/capacitor.settings.gradle",
    "android/app/build.gradle",
    "android/app/proguard-rules.pro",
    "android/app/src/main/AndroidManifest.xml",
    "android/app/src/main/java/app/edusphere/mobile/MainActivity.java",
    "android/app/src/main/java/app/edusphere/mobile/EduSphereNativePlugin.java",
    "android/app/src/main/java/app/edusphere/mobile/SecureTokenStore.java",
    "android/app/src/main/java/app/edusphere/mobile/SqliteStore.java",
    "android/app/src/main/res/xml/network_security_config.xml",
    "android/app/src/main/res/values/strings.xml",
    "android/app/src/main/res/values/styles.xml",
    "android/app/src/main/res/drawable/splash.xml",
    "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png",
  ]) {
    assert.ok(exists(file), "committed: " + file);
  }
  assert.match(read("android/settings.gradle"), /apply from: 'capacitor\.settings\.gradle'/, "plugin modules are included");
  assert.match(read("android/capacitor.settings.gradle"), /@capacitor\/android\/capacitor/);
  assert.match(read("android/app/build.gradle"), /applicationId "app\.edusphere\.mobile"/);
  assert.match(read("android/app/build.gradle"), /compileSdk rootProject\.ext\.compileSdkVersion/);
  assert.match(read("android/gradle/wrapper/gradle-wrapper.properties"), /gradle-8\.11\.1-all\.zip/, "the wrapper pins a Gradle version");
});

test("Android release signing is env-driven with a debug fallback (no secrets needed)", () => {
  const gradle = read("android/app/build.gradle");
  assert.match(gradle, /def hasReleaseKeystore = System\.getenv\("EDUSPHERE_KEYSTORE_PATH"\)/, "the keystore comes from the environment");
  assert.match(gradle, /signingConfig hasReleaseKeystore \? signingConfigs\.release : signingConfigs\.debug/, "a missing keystore still yields an installable build");
  assert.equal(/storePassword\s+"[^"]+"/.test(gradle), false, "no password is committed");
  assert.equal(/keyPassword\s+"[^"]+"/.test(gradle), false);
});

/* The regex assertions below cannot see a malformed document: they pass on a
   manifest whose `<application` tag is never closed, which is exactly what
   AGP's manifest merger rejects with
   `SAXParseException: Element type "application" must be followed by either
   attribute specifications, ">" or "/>"` — the Android job died there, not in
   the test suite. So every committed XML file is PARSED as XML first. */
function parseXml(relative) {
  const { JSDOM } = require("jsdom");
  const source = read(relative);
  const dom = new JSDOM(source, { contentType: "application/xml" });
  return { source, document: dom.window.document };
}

test("every committed Android/iOS XML file is well-formed XML", () => {
  const files = execFileSync("git", ["ls-files", "android/app/src/main", "../mobile/ios"], { cwd: MOBILE, encoding: "utf8" })
    .split("\n")
    .filter((file) => file.endsWith(".xml") || file.endsWith(".plist"))
    .filter(Boolean);
  assert.ok(files.length >= 6, "the native XML is committed: " + files.length + " files");

  for (const file of files) {
    const relative = file.startsWith("../") ? path.join("..", file.slice(3)) : file;
    assert.doesNotThrow(() => parseXml(relative), file + " must parse as XML (AGP/Gradle reject the whole build otherwise)");
  }
});

test("the Android manifest is a complete document, not just regex-shaped", () => {
  const { document, source } = parseXml("android/app/src/main/AndroidManifest.xml");

  assert.equal(document.documentElement.tagName, "manifest");
  const application = document.querySelector("application");
  assert.ok(application, "exactly one <application> element is closed");
  assert.equal(document.querySelectorAll("application").length, 1);
  /* A missing `>` on the opening tag swallows the activity into the attribute
     list; the parsed tree is what proves the tag was closed. */
  assert.equal(application.children.length, 1, "the activity still lives inside <application>");
  assert.equal(application.children[0].tagName, "activity");
  assert.equal(document.querySelectorAll("activity").length, 1, "no stray activity element outside it");
  assert.equal(document.querySelectorAll("activity intent-filter").length, 2, "launcher + edusphere:// deep links");
  assert.match(source, /android:hardwareAccelerated="true">/, "the opening <application …> tag ends with >");

  /* Resource references must resolve to files that actually exist, or aapt
     fails at link time instead of here. */
  const referenced = [
    ["@style/AppTheme", "android/app/src/main/res/values/styles.xml", /name="AppTheme"/],
    ["@style/AppTheme.NoActionBarLaunch", "android/app/src/main/res/values/styles.xml", /name="AppTheme\.NoActionBarLaunch"/],
    ["@string/app_name", "android/app/src/main/res/values/strings.xml", /name="app_name"/],
    ["@string/title_activity_main", "android/app/src/main/res/values/strings.xml", /name="title_activity_main"/],
    ["@drawable/splash", "android/app/src/main/res/drawable/splash.xml", null],
    ["@xml/network_security_config", "android/app/src/main/res/xml/network_security_config.xml", null],
    ["@mipmap/ic_launcher", "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png", null],
    ["@mipmap/ic_launcher_round", "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png", null],
  ];
  /* Everything the manifest and the styles can point at, concatenated: a
     drawable is referenced from styles.xml, a string from the manifest. */
  const haystack = [
    read("android/app/src/main/AndroidManifest.xml"),
    read("android/app/src/main/res/values/styles.xml"),
    read("android/app/src/main/res/values/strings.xml"),
  ].join("\n");

  for (const [reference, file, marker] of referenced) {
    assert.ok(exists(file), reference + " resolves to a committed " + path.basename(file));
    assert.ok(haystack.includes(reference), reference + " is still referenced by the manifest or the theme");
    if (marker) assert.match(read(file), marker, reference + " is defined in " + path.basename(file));
  }
});

test("the Android manifest is least-privilege and deep-link aware", () => {
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  const permissions = Array.from(manifest.matchAll(/<uses-permission android:name="android\.permission\.([A-Z_]+)"/g))
    .map((match) => match[1]);
  assert.deepEqual(permissions.sort(), ["ACCESS_NETWORK_STATE", "CAMERA", "INTERNET"], "no other permission is requested");
  assert.match(manifest, /android:scheme="edusphere"/);
  assert.match(manifest, /android:launchMode="singleTask"/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/, "the keyboard resizes instead of covering the form");
  assert.match(manifest, /android:configChanges="[^"]*orientation/, "rotation does not restart the app (and does not lose the queue)");
});

test("the iOS project carries EduSphere's sources and privacy strings", () => {
  for (const file of [
    "ios/App/Podfile",
    "ios/App/App/Info.plist",
    "ios/App/App/AppDelegate.swift",
    "ios/App/App/EduSphereNativePlugin.swift",
    "ios/App/App/SecureTokenStore.swift",
    "ios/App/App/SqliteStore.swift",
  ]) {
    assert.ok(exists(file), "committed: " + file);
  }
  const plist = read("ios/App/App/Info.plist");
  assert.match(plist, /NSCameraUsageDescription/);
  assert.match(plist, /NSLocalNetworkUsageDescription/);
  assert.match(plist, /<string>edusphere<\/string>/);
  assert.match(plist, /NSAllowsLocalNetworking/);
  assert.match(read("ios/App/Podfile"), /@capacitor\/app/, "the App plugin pod is declared");
  assert.match(read("ios/App/Podfile"), /@capacitor\/network/, "the Network plugin pod is declared");
  assert.match(read("ios/App/App/AppDelegate.swift"), /registerPluginInstance\(EduSphereNativePlugin\(\)\)/);
});

test("the release workflow builds an .apk and an .aab, and a secret-gated .ipa", () => {
  const live = path.join(REPO, ".github", "workflows", "mobile-release.yml");
  const canonical = path.join(REPO, "docs", "ci", "mobile-release.yml");
  const file = fs.existsSync(live) ? live : canonical;
  assert.ok(fs.existsSync(file), "the workflow exists (live or docs/ci)");
  const workflow = fs.readFileSync(file, "utf8");

  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /gradle assembleDebug/, "a signed debug .apk");
  assert.match(workflow, /gradle assembleRelease bundleRelease/, "a release .apk and a Play .aab");
  assert.match(workflow, /EduSphere-\$\{VERSION\}-android-debug\.apk/, "a predictable artifact name");
  assert.match(workflow, /EduSphere-\$\{VERSION\}-android-release\.aab/);
  assert.match(workflow, /debug-signed/i, "the no-secrets fallback is documented in the job");
  assert.match(workflow, /gradle\/actions\/setup-gradle/, "Gradle is cached");
  assert.match(workflow, /cache: "npm"/, "npm is cached");
  assert.match(workflow, /ubuntu-latest[\s\S]*macos-latest/, "Android and macOS runners are both present");
  assert.match(workflow, /xcodebuild/, "iOS uses xcodebuild");
  assert.match(workflow, /-exportArchive/, "the .ipa is exported from the archive");
  assert.match(workflow, /secrets\.APPLE_TEAM_ID/, "iOS signing is secret-gated");
  assert.match(workflow, /vars\.EDUSPHERE_IOS_BUILD/, "the macOS job is skipped unless enabled");
  assert.match(workflow, /upload-artifact@v4/);
  assert.match(workflow, /softprops\/action-gh-release/, "artifacts attach to a GitHub Release on a v* tag");
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

test("the workflow parses as GitHub Actions YAML (no `secrets` inside an `if`)", () => {
  /* `secrets` is not an allowed context in `jobs.<id>.steps[*].if`: a single
     occurrence makes the whole workflow invalid, and GitHub only reports it
     when the run starts. Lift secrets into a job-level `env` and test that. */
  const yaml = require("js-yaml");
  const live = path.join(REPO, ".github", "workflows", "mobile-release.yml");
  const canonical = path.join(REPO, "docs", "ci", "mobile-release.yml");
  const file = fs.existsSync(live) ? live : canonical;
  const doc = yaml.load(fs.readFileSync(file, "utf8"));

  assert.ok(doc && doc.jobs, "the workflow has jobs");
  for (const name of ["test", "android", "ios", "release"]) assert.ok(doc.jobs[name], "job " + name + " exists");

  const offences = [];
  const walk = (node, where) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "if" && typeof value === "string" && value.includes("secrets.")) offences.push(where + "/if");
      walk(value, where + "/" + key);
    }
  };
  walk(doc, "");
  assert.deepEqual(offences, [], "every gate reads the env context, never secrets");

  const ios = doc.jobs.ios;
  assert.equal(ios["runs-on"], "macos-latest");
  assert.ok(ios.env && ios.env.APPLE_TEAM_ID, "the Apple secrets are lifted into the job env");
  const steps = ios.steps.map((step) => step.name || "");
  assert.ok(steps.indexOf("Archive (xcodebuild archive)") >= 0, "the archive step is a real xcodebuild call");
  assert.ok(steps.indexOf("Export the .ipa (xcodebuild -exportArchive)") > steps.indexOf("Archive (xcodebuild archive)"), "export happens after the archive");
  const archive = ios.steps.find((step) => step.name === "Archive (xcodebuild archive)");
  assert.match(archive.run, /xcodebuild -workspace[\s\S]*-archivePath[\s\S]*archive/);
  const exportStep = ios.steps.find((step) => step.name === "Export the .ipa (xcodebuild -exportArchive)");
  assert.match(exportStep.run, /xcodebuild -exportArchive[\s\S]*-exportPath/);

  const android = doc.jobs.android;
  assert.equal(android["runs-on"], "ubuntu-latest");
  assert.ok(android.env && android.env.EDUSPHERE_KEYSTORE_BASE64, "the keystore secret is lifted into the job env");
  assert.ok(doc.jobs.release.needs.includes("android") && doc.jobs.release.needs.includes("ios"));
});

test("the native verification script passes", () => {
  const output = execFileSync(process.execPath, [path.join(MOBILE, "scripts", "verify-native.js")], {
    cwd: MOBILE,
    encoding: "utf8",
  });
  assert.match(output, /native checks passed/);
  assert.equal(/FAIL/.test(output), false, output);
});

test("the docs exist and name the artifacts", () => {
  const docs = path.join(REPO, "docs", "MOBILE-APP.md");
  assert.ok(fs.existsSync(docs), "docs/MOBILE-APP.md exists");
  const markdown = fs.readFileSync(docs, "utf8");
  for (const topic of [".apk", ".aab", ".ipa", "TestFlight", "Play Console", "Keychain", "Keystore", "LAN hub", "camera"]) {
    assert.ok(markdown.toLowerCase().includes(topic.toLowerCase()), "docs/MOBILE-APP.md covers " + topic);
  }
});

/* ---------------------- the native payload stays off the web ------------- */

test("a browser never downloads the native modules (native-boot.js guards them)", () => {
  const index = read(path.join("public", "index.html"), REPO);
  const boot = read(path.join("public", "js", "native-boot.js"), REPO);

  assert.match(index, /<script src="\/js\/native-boot\.js"><\/script>/, "index.html loads the guard");
  for (const name of ["native-bridge.js", "mobile-storage.js", "mobile-shell.js"]) {
    assert.equal(index.includes(`<script src="/js/${name}"`), false,
      name + " is not a tag in index.html: a browser must not fetch it");
    assert.ok(boot.includes(`"/js/${name}"`), name + " is written by the guard");
  }
  /* The guard must run before api.js: the token contract has to exist first. */
  assert.ok(index.indexOf("/js/native-boot.js") < index.indexOf("/js/api.js"), "the guard is before api.js");

  const sw = read(path.join("public", "sw.js"), REPO);
  for (const name of ["native-boot.js", "native-bridge.js", "mobile-storage.js", "mobile-shell.js"]) {
    assert.ok(sw.includes(`"/js/${name}"`), "the service worker precaches " + name);
  }
});

test("the guard writes the three native scripts, in order, only inside the shell", () => {
  const { createDom } = require("./helpers");

  const browser = createDom({ capacitor: { isNativePlatform: () => false, getPlatform: () => "web", Plugins: {} } });
  const browserWrites = [];
  browser.window.document.write = (html) => browserWrites.push(html);
  browser.evalFile("native-boot.js");
  assert.deepEqual(browserWrites, [], "a browser writes nothing at all");
  assert.equal(browser.window.__EDUSPHERE_NATIVE_BOOT__, undefined, "no marker outside the shell");
  browser.close();

  const native = createDom({ capacitor: { isNativePlatform: () => true, getPlatform: () => "android", Plugins: {} } });
  const nativeWrites = [];
  native.window.document.write = (html) => nativeWrites.push(html);
  native.evalFile("native-boot.js");
  assert.equal(nativeWrites.length, 3, "three scripts are written");
  assert.match(nativeWrites[0], /native-bridge\.js/);
  assert.match(nativeWrites[1], /mobile-storage\.js/);
  assert.match(nativeWrites[2], /mobile-shell\.js/);
  assert.equal(nativeWrites.every((html) => /^<script src="\/js\/[a-z-]+\.js"><\/script>$/.test(html)), true,
    "every write is a same-origin script tag (the CSP is script-src 'self')");
  assert.deepEqual(native.window.__EDUSPHERE_NATIVE_BOOT__.scripts.length, 3);
  native.close();
});

test("the guard also recognises a platform string when isNativePlatform is absent", () => {
  const { createDom } = require("./helpers");
  for (const platform of ["android", "ios"]) {
    const ctx = createDom({ capacitor: { platform, Plugins: {} } });
    const writes = [];
    ctx.window.document.write = (html) => writes.push(html);
    ctx.evalFile("native-boot.js");
    assert.equal(writes.length, 3, platform + " is recognised");
    ctx.close();
  }
  const web = createDom({ capacitor: { platform: "web", Plugins: {} } });
  const webWrites = [];
  web.window.document.write = (html) => webWrites.push(html);
  web.evalFile("native-boot.js");
  assert.equal(webWrites.length, 0, "a browser platform writes nothing");
  web.close();
});
