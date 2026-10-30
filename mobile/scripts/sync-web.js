"use strict";
/* ============================================================================
   EduSphere mobile — stage the shared app for the native shells
   ----------------------------------------------------------------------------
   Exactly the job `desktop/scripts/stage.js` does for the PC: the phone must
   ship THE SAME `public/` bundle the web deployment serves, because that is
   what makes "one offline engine, one API client, one offline implementation"
   true across web + desktop + mobile.

       1. ../public                        → mobile/public          (staging)
       2. mobile/public                    → android/app/src/main/assets/public
       3. mobile/public                    → ios/App/App/public

   Step 1 is the single source; 2 and 3 are what Capacitor's WebView actually
   loads, so a plain `./gradlew assembleRelease` works even without `cap sync`.

   The destination folders are git-ignored build artifacts (see .gitignore).
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const MOBILE = path.resolve(__dirname, "..");
const REPO = path.resolve(MOBILE, "..");

const ANDROID_ASSETS = path.join(MOBILE, "android", "app", "src", "main", "assets", "public");
const IOS_PUBLIC = path.join(MOBILE, "ios", "App", "App", "public");
const STAGED = path.join(MOBILE, "public");

const IGNORE = [/^\./, /node_modules$/, /\.test\.js$/, /^test$/, /\.map$/];

/** Files that only make sense when a server renders them. */
const NEVER_COPY = new Set(["app-config.js"]);

/* Capacitor reads this file at runtime; writing it here keeps a build without
   `cap sync` bootable (cap sync rewrites it identically). */
const CAPACITOR_CONFIG = {
  appId: "app.edusphere.mobile",
  appName: "EduSphere",
  webDir: "public",
  backgroundColor: "#220b40",
  android: { allowMixedContent: false, captureInput: true, webContentsDebuggingEnabled: false },
  ios: { contentInset: "always", scheme: "EduSphere" },
  server: { androidScheme: "http", iosScheme: "capacitor", hostname: "localhost", allowNavigation: [] },
};

function copyDir(from, to, options) {
  if (!fs.existsSync(from)) throw new Error("Missing source folder: " + from);
  const opts = options || {};
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  const walk = (srcDir, destDir) => {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (IGNORE.some((re) => re.test(entry.name))) continue;
      if (NEVER_COPY.has(entry.name)) continue;
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        walk(src, dest);
      } else if (entry.isFile()) {
        fs.copyFileSync(src, dest);
        files += 1;
      }
    }
  };
  walk(from, to);
  if (opts.capacitorConfig !== false) {
    fs.writeFileSync(
      path.join(to, "capacitor.config.json"),
      JSON.stringify(CAPACITOR_CONFIG, null, 2) + "\n"
    );
  }
  return files;
}

function main() {
  const staged = copyDir(path.join(REPO, "public"), STAGED, { capacitorConfig: false });
  console.log("staged " + staged + " file(s): public → mobile/public");

  const targets = [
    { to: ANDROID_ASSETS, label: "android/app/src/main/assets/public" },
    { to: IOS_PUBLIC, label: "ios/App/App/public" },
  ];
  for (const target of targets) {
    const files = copyDir(STAGED, target.to);
    console.log("staged " + files + " file(s): mobile/public → " + target.label);
  }
  console.log("Mobile web assets are ready for `npx cap sync` / gradle / xcodebuild.");
  return { staged, targets: targets.length };
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("Staging failed: " + (err && err.message ? err.message : err));
    process.exit(1);
  }
}

module.exports = { copyDir, main, ANDROID_ASSETS, IOS_PUBLIC, STAGED, CAPACITOR_CONFIG, IGNORE };
