"use strict";

// Update manifests are signed independently of the HTTPS connection. The
// corresponding public key must be embedded in the Android binary, not
// downloaded from the update server along with the manifest.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const IGNORED = [/^\./, /node_modules$/, /\.test\.js$/, /^test$/, /\.map$/];
const NEVER_COPY = new Set(["app-config.js"]);
const MAX_FILES = 5000;
// The existing mobile bundle includes promotional videos up to 52 MiB.
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function buildManifest(root, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
    throw new Error("Mobile update signing requires an RSA private key of at least 2048 bits");
  }
  const files = [];
  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (IGNORED.some((pattern) => pattern.test(entry.name)) || NEVER_COPY.has(entry.name)) continue;
      if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) throw new Error("Unsupported mobile asset filename: " + entry.name);
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) {
        const data = fs.readFileSync(full);
        if (data.length > MAX_FILE_BYTES) throw new Error("Mobile asset exceeds size limit: " + relative);
        files.push({ path: relative, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
        if (files.length > MAX_FILES) throw new Error("Too many mobile assets");
      } else throw new Error("Unsupported mobile asset: " + relative);
    }
  }
  walk(root, "");
  if (!files.some((file) => file.path === "index.html")) throw new Error("Mobile update has no index.html");
  const content = JSON.stringify({ format: 1, applicationId: "app.edusphere.mobile", nativeApi: 1, files });
  const payload = Buffer.from(content, "utf8");
  const signature = crypto.sign("RSA-SHA256", payload, key);
  return { payload: payload.toString("base64"), signature: signature.toString("base64") };
}

module.exports = { buildManifest };
