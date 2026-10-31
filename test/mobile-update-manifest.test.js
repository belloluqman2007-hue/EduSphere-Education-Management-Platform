"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildManifest } = require("../server/services/mobile-update-manifest");

test("mobile update manifest signs asset hashes and excludes server-only config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edusphere-update-"));
  try {
    fs.mkdirSync(path.join(root, "js"));
    fs.writeFileSync(path.join(root, "index.html"), "hello");
    fs.writeFileSync(path.join(root, "app-config.js"), "secret");
    fs.writeFileSync(path.join(root, "js", "app.js"), "first");
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signingKey = privateKey.export({ type: "pkcs8", format: "pem" });
    const signed = buildManifest(root, signingKey);
    const bytes = Buffer.from(signed.payload, "base64");
    assert.equal(crypto.verify("RSA-SHA256", bytes, publicKey, Buffer.from(signed.signature, "base64")), true);
    const payload = JSON.parse(bytes);
    assert.deepEqual(payload.files.map((file) => file.path), ["index.html", "js/app.js"]);
    assert.equal(payload.files[1].sha256, crypto.createHash("sha256").update("first").digest("hex"));
    fs.writeFileSync(path.join(root, "js", "app.js"), "second");
    const changed = buildManifest(root, signingKey);
    assert.notEqual(changed.payload, signed.payload);
    assert.equal(crypto.verify("RSA-SHA256", Buffer.from(changed.payload, "base64"), publicKey, Buffer.from(signed.signature, "base64")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("mobile update manifest rejects unsafe assets and weak signing keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edusphere-update-"));
  try {
    fs.writeFileSync(path.join(root, "index.html"), "hello");
    const weak = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" });
    assert.throws(() => buildManifest(root, weak), /2048/);
    const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
    fs.symlinkSync("index.html", path.join(root, "link"));
    assert.throws(() => buildManifest(root, key), /Unsupported mobile asset/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
