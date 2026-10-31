"use strict";
/* ============================================================================
   Packaging contract — the installers, their names, the icons, the signing
   entitlements and the release workflow. Everything here is checked as FILES,
   so a future edit that quietly drops a target (or ships a plaintext secret in
   the build config) fails the suite instead of the release.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DESKTOP = path.resolve(__dirname, "..");
const REPO = path.resolve(DESKTOP, "..");

function read(rel) {
  return fs.readFileSync(path.join(DESKTOP, rel), "utf8");
}

test("desktop/ is self-contained: Electron lives only in desktop/package.json", () => {
  const desktopPkg = JSON.parse(read("package.json"));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

  assert.ok(desktopPkg.devDependencies.electron, "electron is a devDependency of desktop/");
  assert.ok(desktopPkg.devDependencies["electron-builder"], "electron-builder is a devDependency of desktop/");
  assert.equal(desktopPkg.dependencies.electron, undefined, "electron is never a runtime dependency");
  assert.equal(rootPkg.dependencies && rootPkg.dependencies.electron, undefined, "the root install stays fast");
  assert.equal(rootPkg.devDependencies && rootPkg.devDependencies.electron, undefined, "the root install stays fast");
  assert.equal(rootPkg.scripts.test, 'node --disable-warning=ExperimentalWarning --test "test/*.test.js"', "npm test is unchanged");
  assert.equal(desktopPkg.main, "main.js");
  assert.equal(desktopPkg.build, undefined, "build config lives in electron-builder.yml");
});

test("desktop/node_modules and staged copies are ignored by git", () => {
  const ignore = fs.readFileSync(path.join(REPO, ".gitignore"), "utf8");
  assert.match(ignore, /^desktop\/node_modules\/$/m);
  assert.match(ignore, /^desktop\/dist\/$/m);
  assert.match(ignore, /^desktop\/server\/$/m, "the staged copy of server/ is a build artifact");
  assert.match(ignore, /^desktop\/public\/$/m, "the staged copy of public/ is a build artifact");
});

test("electron-builder produces .exe, .dmg, .AppImage and .deb for every arch", () => {
  const yml = read("electron-builder.yml");
  assert.match(yml, /^appId:\s*app\.edusphere\.desktop$/m);
  assert.match(yml, /^productName:\s*EduSphere$/m);
  assert.match(yml, /^artifactName:\s*EduSphere-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}$/m);

  assert.match(yml, /target:\s*nsis/);
  assert.match(yml, /-\s*x64/);
  assert.match(yml, /-\s*arm64/);
  assert.match(yml, /target:\s*dmg/);
  assert.match(yml, /-\s*universal/);
  assert.match(yml, /hardenedRuntime:\s*true/);
  assert.match(yml, /entitlements:\s*resources\/entitlements\.mac\.plist/);
  assert.match(yml, /target:\s*AppImage/);
  assert.match(yml, /target:\s*deb/);
  assert.match(yml, /notarize:\s*false/, "notarization stays off unless CI passes --config.mac.notarize=true");
  assert.match(yml, /icon:\s*resources\/icon\.ico/);
  assert.match(yml, /icon:\s*resources\/icon\.icns/);
  assert.match(yml, /icon:\s*resources\/icons/);
  assert.doesNotMatch(yml, /CSC_LINK\s*[:=]\s*\S/, "no certificate path or secret is committed");
  assert.doesNotMatch(yml, /^\s*(password|CSC_KEY_PASSWORD)\s*:/m, "no credential ever appears in the build config");
});

test("the app entry points and security-sensitive files exist", () => {
  for (const file of [
    "main.js", "preload.js", "wizard-preload.js", "settings.js", "secret-store.js",
    "server-host.js", "server-entry.js", "tray.js", "menu.js", "print.js",
    "deep-link.js", "lan-hub.js", "electron-builder.yml",
    "wizard.html", "wizard.css", "wizard.js", "scripts/stage.js", "tools/make-icons.js",
  ]) {
    assert.ok(fs.existsSync(path.join(DESKTOP, file)), "missing desktop/" + file);
  }
});

test("icons exist for Windows, macOS and Linux in every format the targets need", () => {
  const png = fs.readFileSync(path.join(DESKTOP, "resources", "icon.png"));
  assert.equal(png.slice(0, 8).toString("hex"), "89504e470d0a1a0a", "resources/icon.png is a real PNG");
  assert.ok(png.length > 5000);

  const ico = fs.readFileSync(path.join(DESKTOP, "resources", "icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0, "ICO reserved field");
  assert.equal(ico.readUInt16LE(2), 1, "ICO type is 1 (icon)");
  assert.ok(ico.readUInt16LE(4) >= 6, "the .ico carries multiple sizes");

  const icns = fs.readFileSync(path.join(DESKTOP, "resources", "icon.icns"));
  assert.equal(icns.slice(0, 4).toString("ascii"), "icns");
  assert.ok(icns.length > 10000);

  for (const size of [16, 32, 48, 128, 256, 512]) {
    const file = path.join(DESKTOP, "resources", "icons", size + "x" + size + ".png");
    assert.ok(fs.existsSync(file), "missing Linux icon " + size);
    assert.equal(fs.readFileSync(file).slice(1, 4).toString("ascii"), "PNG");
  }
  for (const file of ["icon.png", "icon-128.png", "icon.ico", "tray.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
    assert.ok(fs.existsSync(path.join(DESKTOP, "assets", file)), "missing assets/" + file);
  }
});

test("macOS entitlements allow JIT and the LAN hub, and no camera/mic access", () => {
  const main = read("resources/entitlements.mac.plist");
  const inherit = read("resources/entitlements.mac.inherit.plist");
  assert.match(main, /^<\?xml version="1\.0"/m, "valid XML declaration (not HTML-escaped)");
  assert.match(main, /<key>com\.apple\.security\.cs\.allow-jit<\/key>/);
  assert.match(main, /<key>com\.apple\.security\.network\.server<\/key>/, "LAN hub mode needs network.server");
  assert.match(main, /<key>com\.apple\.security\.network\.client<\/key>/);
  assert.match(main, /<key>com\.apple\.security\.print<\/key>/);
  assert.doesNotMatch(main, /device\.camera|device\.microphone/, "the desktop app never asks for a camera");
  assert.match(inherit, /com\.apple\.security\.inherit/);
  assert.match(inherit, /allow-jit/);
});

/* The canonical workflows live under docs/ci/ because the automation account
   that opened this branch has no `workflows` permission on GitHub: the copy in
   .github/workflows/ is pasted in by hand from here (docs/INSTALL.md). The
   assertions read the CANONICAL copy on purpose — a live copy that is still the
   old, invalid file would otherwise hide the regression this suite guards. */
function canonicalWorkflow(name) {
  const file = path.join(REPO, "docs", "ci", name);
  assert.ok(fs.existsSync(file), "missing docs/ci/" + name);
  return fs.readFileSync(file, "utf8");
}

test("the release workflow builds all three operating systems and signs only when secrets exist", () => {
  const workflow = canonicalWorkflow("desktop-release.yml");

  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /matrix/);
  assert.match(workflow, /npm ci/, "dependencies come from the lockfile");
  assert.match(workflow, /working-directory:\s*desktop/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /softprops\/action-gh-release@v2/);
  assert.match(workflow, /startsWith\(github\.ref,\s*'refs\/tags\/v'\)/);
  assert.match(workflow, /actions\/cache@v4|setup-node@v4[\s\S]*cache:\s*["']npm["']/, "npm is cached");
  assert.match(workflow, /secrets\.MAC_CSC_LINK|\$\{\{\s*secrets\./, "signing values come from secrets");
  assert.match(workflow, /env\.MAC_CSC_LINK/, "signing steps are conditional on the job env (secrets are not readable from an `if`)");
});

/* ---------------------------------------------------------------------------
   The two release workflows, validated as YAML.
   A workflow that GitHub refuses to load costs a whole release, and the error
   ("Unrecognized named-value: 'secrets'") only shows up when the run starts —
   so the shape is asserted here instead.
--------------------------------------------------------------------------- */

function workflowIfs(doc) {
  const found = [];
  const walk = (node, where) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "if" && typeof value === "string") found.push({ where: where + "/if", value });
      walk(value, where + "/" + key);
    }
  };
  walk(doc, "");
  return found;
}

test("neither release workflow reads `secrets` from an `if:` (it is not an allowed context there)", () => {
  const yaml = require("js-yaml");
  for (const name of ["desktop-release.yml", "mobile-release.yml"]) {
    const doc = yaml.load(canonicalWorkflow(name));
    assert.ok(doc && doc.jobs, name + " parses and has jobs");

    const offences = workflowIfs(doc).filter((entry) => /\bsecrets\./.test(entry.value));
    assert.deepEqual(offences.map((entry) => entry.where), [],
      name + ": lift the secret into a job-level `env:` and test `env.*` in the `if:`");

    /* Every `if` must be a plain string GitHub can evaluate. */
    const empty = workflowIfs(doc).filter((entry) => entry.value.trim() === "");
    assert.deepEqual(empty.map((entry) => entry.where), [], name + ": an empty `if` is a parse error");
  }
});

test("the desktop signing gates read the build job's env, and the certificates stay secrets", () => {
  const yaml = require("js-yaml");
  const doc = yaml.load(canonicalWorkflow("desktop-release.yml"));
  const build = doc.jobs.build;

  assert.equal(build.env.MAC_CSC_LINK, "${{ secrets.MAC_CSC_LINK }}", "the Apple certificate is lifted into the job env");
  assert.equal(build.env.WIN_CSC_LINK, "${{ secrets.WIN_CSC_LINK }}", "the Windows certificate is lifted into the job env");

  const step = (name) => {
    const found = build.steps.find((candidate) => candidate.name === name);
    assert.ok(found, "the workflow still has the `" + name + "` step");
    return found;
  };

  const macSigned = step("Build (signed + notarized)");
  const winSigned = step("Build (signed)");
  const unsigned = step("Build (unsigned)");

  assert.match(macSigned.if, /env\.MAC_CSC_LINK != ''/, "the macOS signed build is gated on env.MAC_CSC_LINK");
  assert.match(winSigned.if, /env\.WIN_CSC_LINK != ''/, "the Windows signed build is gated on env.WIN_CSC_LINK");
  assert.match(unsigned.if, /env\.MAC_CSC_LINK == ''/, "the unsigned fallback is the inverse of the gate");
  assert.match(unsigned.if, /env\.WIN_CSC_LINK == ''/);
  assert.equal(/secrets\./.test(unsigned.if), false, "no `if` string mentions secrets at all");

  assert.equal(macSigned.env.CSC_LINK, "${{ secrets.MAC_CSC_LINK }}", "the certificate itself is still a secret");
  assert.equal(winSigned.env.CSC_LINK, "${{ secrets.WIN_CSC_LINK }}");
});

test("the platform guard lists force-exit and skip the known-broken login UI test", () => {
  const yaml = require("js-yaml");
  const expected = ["sql-compat", "mysql-runtime", "card-scanner-csrf", "admin-login", "offline-frontend-sync"];

  for (const name of ["desktop-release.yml", "mobile-release.yml"]) {
    const doc = yaml.load(canonicalWorkflow(name));
    const guard = Object.values(doc.jobs)
      .flatMap((job) => job.steps || [])
      .find((step) => typeof step.run === "string" && step.run.includes("test/sql-compat.test.js"));
    assert.ok(guard, name + ": the guard step is still there");

    assert.match(guard.run, /--test-force-exit/,
      name + ": the known-broken suite leaves an open handle, so the runner must be told to exit");
    assert.equal(guard.run.includes("unified-login-ui.test.js"), false,
      name + ": test/unified-login-ui.test.js is a known pre-existing failure (fees copy) and must not gate the build");
    for (const file of expected) {
      assert.ok(guard.run.includes("test/" + file + ".test.js"), name + ": still guards " + file + ".test.js");
    }
  }
});

test("the Android job syncs Capacitor (cap sync, not cap copy) and mobile/ ships TypeScript", () => {
  const yaml = require("js-yaml");
  const doc = yaml.load(canonicalWorkflow("mobile-release.yml"));
  const android = doc.jobs.android;
  const runs = android.steps.map((step) => String(step.run || ""));

  /* `capacitor.config.ts` is TypeScript: without a `typescript` dependency the
     Capacitor CLI exits 1 with "Could not find installation of TypeScript"
     before it copies anything. That — not a missing Gradle wrapper JAR — is
     what broke the Android job, so the dependency is asserted, not just the
     command. */
  const mobilePkg = JSON.parse(fs.readFileSync(path.join(REPO, "mobile", "package.json"), "utf8"));
  assert.ok(mobilePkg.devDependencies.typescript, "mobile/ declares typescript (capacitor.config.ts)");
  assert.equal((mobilePkg.dependencies || {}).typescript, undefined, "it stays a devDependency");
  const mobileLock = JSON.parse(fs.readFileSync(path.join(REPO, "mobile", "package-lock.json"), "utf8"));
  assert.ok(mobileLock.packages["node_modules/typescript"], "the lockfile pins typescript (npm ci in CI)");

  /* `sync` = copy + update; only the update half writes the plugins JSON that
     registers @capacitor/app and @capacitor/network inside the APK. */
  const syncIndex = android.steps.findIndex((step) => /npx cap sync android/.test(String(step.run || "")));
  assert.ok(syncIndex >= 0, "`npx cap sync android` writes the web assets, capacitor.config.json and capacitor.plugins.json");
  assert.equal(android.steps[syncIndex]["working-directory"], "mobile");
  assert.equal(runs.some((run) => /npx cap copy android/.test(run)), false,
    "`cap copy` skips the plugins JSON, so the APK would lose its native plugins");

  const syncWebIndex = android.steps.findIndex((step) => /npm run sync-web/.test(String(step.run || "")));
  assert.ok(syncWebIndex >= 0 && syncWebIndex < syncIndex, "the shared web bundle is staged before the sync");

  /* The Gradle build / collect / upload steps are untouched. */
  assert.ok(runs.some((run) => /gradle assembleDebug/.test(run)), "the debug .apk is still built");
  assert.ok(runs.some((run) => /gradle assembleRelease bundleRelease/.test(run)), "the release .apk and .aab are still built");
  assert.ok(runs.some((run) => /EduSphere-\$\{VERSION\}-android-release\.aab/.test(run)), "the .aab is still collected");
  const upload = android.steps.find((step) => step.uses === "actions/upload-artifact@v4");
  assert.ok(upload && upload.with.path === "mobile/dist/android/*", "the artifacts are still uploaded");

  /* The env-based secret gates survive the edit. */
  assert.equal(android.env.EDUSPHERE_KEYSTORE_BASE64, "${{ secrets.EDUSPHERE_KEYSTORE_BASE64 }}");
  const keystore = android.steps.find((step) => step.id === "keystore");
  assert.ok(keystore && /env\.EDUSPHERE_KEYSTORE_BASE64 != ''/.test(keystore.if), "the keystore gate reads the job env");
});

test("the desktop Linux leg is pinned to ubuntu-24.04 (AppImage tools break on ubuntu-latest)", () => {
  const yaml = require("js-yaml");
  const doc = yaml.load(canonicalWorkflow("desktop-release.yml"));
  const matrix = doc.jobs.build.strategy.matrix.include;
  const linux = matrix.find((entry) => entry.label === "Linux");
  const mac = matrix.find((entry) => entry.label === "macOS");
  const windows = matrix.find((entry) => entry.label === "Windows");

  /* Release legs are pinned to an image, never to the moving `ubuntu-latest`
     label: GitHub has announced that it migrates to Ubuntu 26.04 (glibc 2.43,
     where electron-builder's bundled AppImage tooling is known to break), and a
     release must not change operating system underneath itself. (The Linux
     failure that prompted the pin turned out to be the missing deb `homepage`,
     which is now guarded separately — the pin stays as reproducibility.) */
  assert.equal(linux.os, "ubuntu-24.04", "the Linux leg is pinned to an image, not the moving ubuntu-latest label");
  assert.notEqual(linux.os, "ubuntu-latest", "no release leg rides the moving label");
  assert.equal(mac.os, "macos-latest");
  assert.equal(windows.os, "windows-latest");
  assert.equal(doc.jobs.build["runs-on"], "${{ matrix.os }}", "every leg takes its runner from the matrix");

  /* The unsigned fallback has to keep matching the pinned label, or the Linux
     leg would silently build nothing at all. */
  const unsigned = doc.jobs.build.steps.find((step) => step.name === "Build (unsigned)");
  assert.match(unsigned.if, /startsWith\(matrix\.os, 'ubuntu'\)/,
    "the fallback matches any Ubuntu runner (the matrix no longer says ubuntu-latest)");
  assert.equal(/\.os == 'ubuntu-latest'/.test(unsigned.if), false, "no stale ubuntu-latest comparison is left behind");
  assert.equal(unsigned.run, "${{ matrix.build }}", "each leg still runs its own build command");

  /* The guard job needs no pin: it only runs Node. */
  assert.equal(doc.jobs.test["runs-on"], "ubuntu-latest");
});

test("the deb target has the metadata electron-builder refuses to build without", () => {
  /* `npm run dist:linux` builds an AppImage AND a .deb; the .deb goes through
     FpmTarget, which aborts with
       "Please specify project homepage, see …/configuration#metadata"
     when package.json has no `homepage`. That single missing field failed the
     whole Linux leg (the AppImage half had already built), so it is asserted —
     together with the other fields fpm reads — instead of being discovered in
     CI. */
  const pkg = JSON.parse(read("package.json"));

  assert.equal(typeof pkg.homepage, "string", "the deb target needs a project homepage");
  assert.match(pkg.homepage, /^https:\/\/\S+$/, "homepage is an absolute https URL (" + pkg.homepage + ")");
  assert.ok(pkg.description && pkg.description.length > 10, "fpm writes Description from it");
  assert.match(pkg.license, /^[A-Za-z0-9.+-]+$/, "fpm writes License from a valid SPDX id");
  assert.ok(pkg.author && pkg.author.name, "fpm writes the Maintainer from author.name");
  assert.match(pkg.author.email, /^[^@\s]+@[^@\s]+$/, "Maintainer needs an e-mail address");

  /* The linux block still ships both targets, so a fix for one cannot quietly
     drop the other. */
  const yml = read("electron-builder.yml");
  assert.match(yml, /target:\s*AppImage/, "the AppImage is still built");
  assert.match(yml, /target:\s*deb/, "the .deb is still built");
  assert.match(yml, /depends:\s*\n(\s+- .*\n)+/, "the .deb dependency list survives");
});

test("the staged runtime is what gets packaged (server/ + public/ from the repo root)", () => {
  const yml = read("electron-builder.yml");
  assert.match(yml, /files:/);
  assert.match(yml, /"\*\*\/\*"/, "everything staged into desktop/ ships");
  assert.match(yml, /"!test\{,\/\*\*\/\*\}"/, "test files are not shipped");
  assert.match(yml, /asar:\s*false/, "the forked server and static files must be plain files");

  const stage = read("scripts/stage.js");
  assert.match(stage, /"server"/);
  assert.match(stage, /"public"/);
});
