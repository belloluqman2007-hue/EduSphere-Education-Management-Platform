"use strict";

// Loading routes must not require the upload directory to be writable. A
// regular file used as the root makes any attempt to create a child fail on
// every platform, even when the tests are run as an administrator.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("routes load when the configured upload root cannot contain directories", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-startup-"));
  try {
    const root = path.join(dir, "not-a-directory");
    fs.writeFileSync(root, "not a directory");
    const result = spawnSync(process.execPath, ["-e", "require('./server/app')"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, NODE_ENV: "test", DATABASE_DRIVER: "sqlite", DATA_DIR: dir, UPLOAD_DIR: root },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
