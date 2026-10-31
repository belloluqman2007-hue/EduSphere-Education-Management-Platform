"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("images use temporary staging when the configured upload root is unusable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-no-root-"));
  const badRoot = path.join(root, "file");
  fs.writeFileSync(badRoot, "not a directory");
  process.env.UPLOAD_DIR = badRoot;
  const store = require("../server/services/media-store");
  const original = store.put;
  const saved = [];
  store.put = async (webPath, bytes) => { saved.push({ webPath, bytes }); return true; };
  const { imageUploader } = require("../server/middleware/upload");
  const profile = require("../server/services/profile-media");
  const express = require("express");
  const app = express();
  let stagingFile;
  app.post("/upload", imageUploader("avatars", "photo"), (req, res) => {
    stagingFile = req.file.path;
    res.json({ ok: true });
  });
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const form = new FormData();
    form.append("photo", new Blob([png], { type: "image/png" }), "portrait.png");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/upload`, { method: "POST", body: form });
    assert.equal(response.status, 200);
    assert.equal(saved.length, 1);
    assert.match(saved[0].webPath, /^\/uploads\/avatars\//);
    assert.deepEqual(saved[0].bytes, png);
    // Response cleanup is asynchronous; wait for it without depending on timing.
    for (let i = 0; i < 50 && fs.existsSync(stagingFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(stagingFile), false);
    const webPath = await profile.writeImage(png, "signatures");
    assert.match(webPath, /^\/uploads\/signatures\//);
    assert.equal(saved.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.put = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
