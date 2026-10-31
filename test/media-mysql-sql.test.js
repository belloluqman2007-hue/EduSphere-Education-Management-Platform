"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("MySQL media writes use a single upsert and preserve tenant ownership", async () => {
  const db = require("../server/db");
  const store = require("../server/services/media-store");
  const oldDialect = db.dialect, oldRun = db.run;
  let calls = [];
  db.dialect = async () => "mysql";
  db.run = async (sql, params) => { calls.push({ sql, params }); return { changes: 1 }; };
  try {
    assert.equal(await store.put("/uploads/photos/123456789-0123456789abcdef.png", Buffer.from("abc"), "image/png", 42), true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE/);
    assert.doesNotMatch(calls[0].sql, /DELETE/i);
    assert.equal(calls[0].params[5], 42);
    assert.equal(calls[0].params[3], "YWJj");
  } finally { db.dialect = oldDialect; db.run = oldRun; }
});

test("MySQL migration widens media storage and SQLite remains unchanged", async () => {
  const migration = require("../server/migrate").MIGRATIONS.find(m => m.id === "046_media_files_longtext");
  assert.ok(migration);
  const statements = [];
  const api = { run: async (sql) => { statements.push(sql); } };
  await migration.up(api, "mysql");
  assert.deepEqual(statements, ["ALTER TABLE media_files MODIFY COLUMN data LONGTEXT"]);
  statements.length = 0;
  await migration.up(api, "sqlite");
  assert.deepEqual(statements, []);
});
