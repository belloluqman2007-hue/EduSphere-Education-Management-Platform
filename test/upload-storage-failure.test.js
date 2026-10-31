"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("image upload fails and cleans up when database persistence fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-failure-"));
  process.env.UPLOAD_DIR = dir;
  const express = require("express");
  const store = require("../server/services/media-store");
  const original = store.put;
  store.put = async () => { throw new Error("database unavailable"); };
  const { imageUploader, fileUploader } = require("../server/middleware/upload");
  const app = express();
  app.post("/upload", imageUploader("avatars", "photo"), (req, res) => res.json({ ok: true }));
  app.post("/document", fileUploader("announcement-files", "attachment", { extensions: [".pdf"] }), (req, res) => res.json({ ok: true }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const form = new FormData();
    form.append("photo", new Blob(["image"], { type: "image/png" }), "a.png");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/upload`, { method: "POST", body: form });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /database unavailable/);
    assert.deepEqual(fs.readdirSync(path.join(dir, "avatars")), []);
    const document = new FormData();
    document.append("attachment", new Blob(["pdf"], { type: "application/pdf" }), "test.pdf");
    const failed = await fetch(`http://127.0.0.1:${server.address().port}/document`, { method: "POST", body: document });
    assert.equal(failed.status, 500);
    assert.deepEqual(fs.readdirSync(path.join(dir, "announcement-files")), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.put = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
