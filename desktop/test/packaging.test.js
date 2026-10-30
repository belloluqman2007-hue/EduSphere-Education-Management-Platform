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

test("the release workflow builds all three operating systems and signs only when secrets exist", () => {
  // The canonical copy lives under docs/ci/ because the automation account that
  // opened this branch has no `workflows` permission on GitHub. Once the file is
  // copied into .github/workflows/ (see its header), that live copy wins.
  const candidates = [
    path.join(REPO, ".github", "workflows", "desktop-release.yml"),
    path.join(REPO, "docs", "ci", "desktop-release.yml"),
  ];
  const workflowPath = candidates.find((file) => fs.existsSync(file));
  assert.ok(workflowPath, "missing docs/ci/desktop-release.yml (and no live .github/workflows copy)");
  const workflow = fs.readFileSync(workflowPath, "utf8");

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
  assert.match(workflow, /if:\s*.*secrets\./, "signing steps are conditional on the secrets being present");
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
