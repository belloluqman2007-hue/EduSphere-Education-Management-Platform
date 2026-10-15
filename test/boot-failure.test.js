"use strict";
/* ============================================================================
   Boot failure reporting
   ---------------------------------------------------------------------------
   A Render deploy once failed with NOTHING between the storage warnings and
   "==&gt; Exited with status 1": the process could not reach its MySQL database,
   and the buffered console.error line was dropped when the process exited.
   These tests pin the contract that made that diagnosable:

     • an unreachable database still fails the boot (exit 1) — never a silent
       fallback to an empty database
     • the reason is readable THROUGH A PIPE (spawnSync captures pipes, the
       same way a hosting platform's log collector does)
     • the reason includes the raw error AND a human fix-it checklist
     • the boot logs which database it tried, with the password masked
     • the bounded retry gives a waking-up database a second chance
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function bootEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-boot-fail-"));
  return Object.assign({}, process.env, {
    NODE_ENV: "production",
    RENDER: "true",
    DATABASE_DRIVER: "mysql",
    // RFC 5737 TEST-NET-1: nothing can answer there, so the connect behaves
    // like a suspended cloud database (times out), exactly as on Render.
    DATABASE_URL: "mysql://bootuser:bootsecret@192.0.2.1:3306/edusphere",
    MYSQL_CONNECT_TIMEOUT_MS: "1000",
    DB_BOOT_ATTEMPTS: "2",
    DB_BOOT_RETRY_DELAY_MS: "200",
    SESSION_SECRET: "x".repeat(48),
    SUPER_ADMIN_PASSWORD: "A-strong-production-password!",
    DATA_DIR: path.join(dir, "data"),
    BACKUP_INTERVAL_MINUTES: "0",
    AUTO_RESTORE_ON_EMPTY_DB: "0",
  }, overrides);
}

test("an unreachable MySQL fails the boot with a readable, crash-safe error — not a silent exit 1", () => {
  const res = spawnSync(process.execPath, ["server/index.js"], { cwd: ROOT, env: bootEnv(), encoding: "utf8", timeout: 90000 });
  assert.equal(res.status, 1, "the boot must exit 1 when the database is unreachable");
  const out = String(res.stdout) + String(res.stderr);
  assert.match(out, /Storage: /, "the boot reached the storage report");
  assert.match(out, /Failed to connect to the database|Failed to start server/, "the error line must survive the pipe");
  assert.match(out, /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|Connection lost/, "the raw connect error is shown");
  assert.match(out, /DATABASE_URL/, "the fix-it checklist is printed");
  assert.match(out, /refuses to boot without its database/, "the no-fallback policy is explained");
});

test("the boot says which database it tried, with the password masked", () => {
  const res = spawnSync(process.execPath, ["server/index.js"], { cwd: ROOT, env: bootEnv(), encoding: "utf8", timeout: 90000 });
  const out = String(res.stdout) + String(res.stderr);
  assert.match(out, /Database: mysql — mysql:\/\/bootuser:••••@192\.0\.2\.1:3306\/edusphere/, "the masked target is logged");
  assert.doesNotMatch(out, /bootsecret/, "the password never reaches the log");
});

test("the reachability probe retries before giving up, and says so", () => {
  const res = spawnSync(process.execPath, ["server/index.js"], { cwd: ROOT, env: bootEnv(), encoding: "utf8", timeout: 90000 });
  const out = String(res.stdout) + String(res.stderr);
  assert.match(out, /attempt 1\/2.*retrying/, "the first retry is announced");
  assert.equal((out.match(/attempt 1\/2/g) || []).length, 1, "only one retry happens at attempts=2");
});

test("maskDbUrl hides the password but keeps host, port and database", () => {
  const { maskDbUrl } = require("../server/util");
  assert.equal(maskDbUrl("mysql://user:secret@db.example.com:3306/edusphere"), "mysql://user:••••@db.example.com:3306/edusphere");
  assert.equal(maskDbUrl("mysql://user@localhost/edusphere"), "mysql://user@localhost/edusphere", "no password — nothing to mask");
  assert.equal(maskDbUrl("not a url at all"), "not a url at all");
});

test("isDbConnectError recognises reachability failures and ignores app errors", () => {
  const { isDbConnectError } = require("../server/util");
  for (const code of ["ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR"]) {
    assert.equal(isDbConnectError({ code, message: code }), true, code + " is a connect error");
  }
  assert.equal(isDbConnectError({ message: "connect ETIMEDOUT" }), true, "message-only errors count");
  assert.equal(isDbConnectError({ message: "ER_NO_SUCH_TABLE: boom" }), false, "app errors are not connect errors");
  assert.equal(isDbConnectError(null), false);
});
