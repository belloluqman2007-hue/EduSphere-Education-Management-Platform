"use strict";
/* ============================================================================
   EduSphere mobile — build the Android app locally
   ----------------------------------------------------------------------------
       npm run android:debug     → app-debug.apk   (installs on any phone)
       npm run android:release   → app-release.apk + app-release.aab
                                   (Play upload when the keystore secrets exist,
                                    debug-signed otherwise — see the report)

   Needs JDK 21 and the Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT). Nothing
   else: the shared web assets are staged by scripts/sync-web.js first.

   Which Gradle?  The committed project uses the standard wrapper layout, but
   the wrapper JAR is a binary that only `npx cap add android` (or `gradle
   wrapper`) can write, and committing binaries is against this repository's
   rules. So this script prefers ./gradlew when present and falls back to a
   system `gradle` — CI installs one with gradle/actions/setup-gradle.
   ========================================================================== */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MOBILE = path.resolve(__dirname, "..");
const ANDROID = path.join(MOBILE, "android");
const APK_DEBUG = path.join(ANDROID, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const APK_RELEASE = path.join(ANDROID, "app", "build", "outputs", "apk", "release", "app-release.apk");
const AAB_RELEASE = path.join(ANDROID, "app", "build", "outputs", "bundle", "release", "app-release.aab");

function gradleCommand() {
  const wrapper = path.join(ANDROID, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  const wrapperJar = path.join(ANDROID, "gradle", "wrapper", "gradle-wrapper.jar");
  if (fs.existsSync(wrapper) && fs.existsSync(wrapperJar)) {
    return { command: wrapper, args: [] };
  }
  return { command: process.platform === "win32" ? "gradle.bat" : "gradle", args: [] };
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd: cwd || MOBILE, stdio: "inherit" });
}

function build(mode) {
  run(process.execPath, [path.join(__dirname, "sync-web.js")]);
  try {
    run("npx", ["cap", "sync", "android"]);
  } catch (error) {
    console.warn("cap sync android was skipped (" + (error && error.message ? error.message : error) + "); the staged assets are already in place.");
  }
  const { command, args } = gradleCommand();
  const tasks = mode === "release" ? ["assembleRelease", "bundleRelease"] : ["assembleDebug"];
  run(command, args.concat(tasks, ["--no-daemon", "--stacktrace"]), ANDROID);

  const artifacts = (mode === "release" ? [APK_RELEASE, AAB_RELEASE] : [APK_DEBUG])
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, size: fs.statSync(file).size, name: path.basename(file) }));
  if (!artifacts.length) throw new Error("Gradle finished but no artifact was produced");
  for (const artifact of artifacts) {
    console.log("built " + artifact.name + " (" + Math.round(artifact.size / 1024) + " KB)");
  }
  return artifacts;
}

if (require.main === module) {
  const mode = (process.argv[2] || "debug").toLowerCase() === "release" ? "release" : "debug";
  try {
    build(mode);
  } catch (error) {
    console.error("Android build failed: " + (error && error.message ? error.message : error));
    process.exit(1);
  }
}

module.exports = { build, gradleCommand, APK_DEBUG, APK_RELEASE, AAB_RELEASE };
