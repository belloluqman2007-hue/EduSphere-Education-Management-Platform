"use strict";
/* ============================================================================
   EduSphere desktop — stage the shared app for packaging
   ----------------------------------------------------------------------------
   The desktop shell must ship the SAME `server/` and `public/` folders the web
   deployment serves (that is what makes "one offline implementation, one
   Express app" true). electron-builder can only package files inside the app
   directory, so this script copies them into `desktop/` right before a build:

       desktop/server/   ←  ../server
       desktop/public/   ←  ../public

   Both destinations are git-ignored build artifacts. In development nothing is
   copied at all: the shell resolves the repository root directly.
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const DESKTOP = path.resolve(__dirname, "..");
const REPO = path.resolve(DESKTOP, "..");

const COPY = [
  { from: path.join(REPO, "server"), to: path.join(DESKTOP, "server") },
  { from: path.join(REPO, "public"), to: path.join(DESKTOP, "public") },
];

const IGNORE = [/^\./, /node_modules$/, /\.test\.js$/, /^test$/, /\.map$/];

function copyDir(from, to) {
  if (!fs.existsSync(from)) throw new Error("Missing source folder: " + from);
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  const walk = (srcDir, destDir) => {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (IGNORE.some((re) => re.test(entry.name))) continue;
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
  return files;
}

function main() {
  for (const { from, to } of COPY) {
    const files = copyDir(from, to);
    console.log("staged " + files + " file(s): " + path.relative(REPO, from) + " → " + path.relative(REPO, to));
  }
  console.log("Desktop app is ready for electron-builder.");
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("Staging failed: " + (err && err.message ? err.message : err));
    process.exit(1);
  }
}

module.exports = { copyDir };
