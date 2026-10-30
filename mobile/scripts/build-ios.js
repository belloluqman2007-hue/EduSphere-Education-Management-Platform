"use strict";
/* ============================================================================
   EduSphere mobile — build the iOS/iPadOS app (.ipa) locally or in CI
   ----------------------------------------------------------------------------
   Requires macOS with Xcode 15+, CocoaPods and an Apple Developer team for a
   signed .ipa. With no signing secrets it still produces an UNSIGNED archive
   (and says so), which is useful for verifying that the project compiles.

       npm run ios:build

   Environment (all optional):
       EDUSPHERE_IOS_TEAM_ID        Apple Developer Team ID
       EDUSPHERE_IOS_METHOD         app-store | ad-hoc | development | enterprise
                                    (default: app-store)
       EDUSPHERE_IOS_EXPORT_OPTIONS path to a custom ExportOptions.plist
       EDUSPHERE_IOS_PROVISIONING   "manual" to use manual signing (needs a profile)

   CI (.github/workflows/mobile-release.yml) runs exactly this script on a
   macos-latest runner, gated on the Apple secrets existing.
   ========================================================================== */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MOBILE = path.resolve(__dirname, "..");
const IOS = path.join(MOBILE, "ios");
const APP = path.join(IOS, "App");
const WORKSPACE = path.join(APP, "App.xcworkspace");
const PROJECT = path.join(APP, "App.xcodeproj");
const ARCHIVE = path.join(MOBILE, "dist", "ios", "EduSphere.xcarchive");
const EXPORT_DIR = path.join(MOBILE, "dist", "ios", "ipa");

function run(command, args, cwd) {
  execFileSync(command, args, { cwd: cwd || MOBILE, stdio: "inherit" });
}

function writeExportOptions() {
  const custom = process.env.EDUSPHERE_IOS_EXPORT_OPTIONS;
  if (custom && fs.existsSync(custom)) return custom;
  const options = {
    method: process.env.EDUSPHERE_IOS_METHOD || "app-store",
    signingStyle: process.env.EDUSPHERE_IOS_PROVISIONING === "manual" ? "manual" : "automatic",
    stripSwiftSymbols: true,
    compileBitcode: false,
    uploadSymbols: true,
  };
  if (process.env.EDUSPHERE_IOS_TEAM_ID) options.teamID = process.env.EDUSPHERE_IOS_TEAM_ID;
  const target = path.join(MOBILE, "dist", "ios", "ExportOptions.plist");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const entries = Object.entries(options)
    .map(([key, value]) => `  <key>${key}</key>\n  ${typeof value === "boolean" ? `<${value}/>` : `<string>${value}</string>`}`)
    .join("\n");
  fs.writeFileSync(target, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${entries}\n</dict>\n</plist>\n`);
  return target;
}

function build() {
  if (process.platform !== "darwin") {
    throw new Error("iOS builds need macOS with Xcode. Generate the project with `npm run add:ios`, then build it on a Mac or in CI.");
  }
  if (!fs.existsSync(PROJECT)) {
    throw new Error("ios/App/App.xcodeproj is missing — run `npm run add:ios` first (it generates the Xcode project and restores EduSphere's sources).");
  }
  run(process.execPath, [path.join(__dirname, "sync-web.js")]);
  run("npx", ["cap", "sync", "ios"]);

  if (!fs.existsSync(WORKSPACE)) {
    run("pod", ["install"], APP);
  }

  fs.mkdirSync(path.dirname(ARCHIVE), { recursive: true });
  const signed = Boolean(process.env.EDUSPHERE_IOS_TEAM_ID || process.env.EDUSPHERE_IOS_SIGN_IDENTITY);
  const archiveArgs = [
    "-workspace", WORKSPACE,
    "-scheme", "App",
    "-configuration", "Release",
    "-destination", "generic/platform=iOS",
    "-archivePath", ARCHIVE,
    "archive",
  ];
  if (signed) {
    archiveArgs.push("CODE_SIGN_STYLE=Automatic");
    if (process.env.EDUSPHERE_IOS_TEAM_ID) archiveArgs.push("DEVELOPMENT_TEAM=" + process.env.EDUSPHERE_IOS_TEAM_ID);
  } else {
    archiveArgs.push("CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO");
  }
  run("xcodebuild", archiveArgs);

  if (!signed) {
    console.log("archived WITHOUT signing (no Apple secrets configured). A signed .ipa needs a Developer team: see docs/MOBILE-APP.md.");
    return { archive: ARCHIVE, ipa: null, signed: false };
  }

  const options = writeExportOptions();
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  run("xcodebuild", ["-exportArchive", "-archivePath", ARCHIVE, "-exportPath", EXPORT_DIR, "-exportOptionsPlist", options]);
  const ipa = fs.existsSync(EXPORT_DIR)
    ? fs.readdirSync(EXPORT_DIR).filter((name) => name.endsWith(".ipa")).map((name) => path.join(EXPORT_DIR, name))[0]
    : null;
  if (ipa) console.log("built " + path.basename(ipa));
  return { archive: ARCHIVE, ipa: ipa || null, signed: true };
}

if (require.main === module) {
  try {
    build();
  } catch (error) {
    console.error("iOS build failed: " + (error && error.message ? error.message : error));
    process.exit(1);
  }
}

module.exports = { build, writeExportOptions, ARCHIVE, EXPORT_DIR };
