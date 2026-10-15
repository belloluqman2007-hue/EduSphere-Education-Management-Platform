"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const db = require("../server/db");
const { MIGRATIONS, migrate, pendingMigrations } = require("../server/migrate");
const migration = MIGRATIONS.find((m) => m.id === "043_edusphere_ai_assistant");
const definitions = [
  ["ai_conversations", "idx_ai_conv_tenant", ["madrasa_id", "surface", "id"]],
  ["ai_conversations", "idx_ai_conv_external", ["surface", "external_id"]],
  ["ai_messages", "idx_ai_msg_conv", ["conversation_id", "id"]],
  ["ai_knowledge", "idx_ai_kb_scope", ["scope", "is_active", "sort_order"]],
];

// Model MySQL's persistent DDL and SHOW INDEX metadata, including the failure
// raised by its old literal TEXT default. No network/production DB is used.
function mysqlFixture() {
  const indexes = new Map();
  const tables = new Set();
  const applied = MIGRATIONS.filter((m) => m !== migration).map((m) => ({ id: m.id }));
  const writes = [];
  let failAt = null;
  const api = {
    dialect: async () => "mysql",
    all: async (sql, params = []) => {
      if (sql === "SELECT id FROM schema_migrations") return applied.slice();
      const match = sql.match(/^SHOW INDEX FROM `([^`]+)` WHERE Key_name = \?$/);
      assert.ok(match, `Unexpected query: ${sql}`);
      assert.ok(tables.has(match[1]), "inspect the actual table after ensuring it exists");
      return (indexes.get(`${match[1]}.${params[0]}`) || []).map((r) => ({ ...r }));
    },
    run: async (sql, params = []) => {
      writes.push(sql);
      if (failAt && sql.includes(failAt)) throw new Error("injected DDL failure");
      assert.doesNotMatch(sql, /keywords TEXT NOT NULL DEFAULT ''/, "MySQL requires an expression TEXT default");
      const table = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      if (table) { tables.add(table[1]); return; }
      const index = sql.match(/^CREATE INDEX (\w+) ON (\w+) \(([^)]+)\)$/);
      if (index) {
        const [, name, owner, cols] = index;
        const key = `${owner}.${name}`;
        if (indexes.has(key)) throw Object.assign(new Error(`Duplicate key name '${name}'`), { code: "ER_DUP_KEYNAME" });
        indexes.set(key, cols.split(", ").map((column, i) => ({
          Table: owner, Key_name: name, Column_name: column, Seq_in_index: i + 1,
          Non_unique: 1, Sub_part: null, Collation: "A", Index_type: "BTREE", Visible: "YES",
        })));
        return;
      }
      assert.equal(sql, "INSERT INTO schema_migrations (id) VALUES (?)");
      assert.equal(indexes.size, 4, "only record completion after all four indexes exist");
      applied.push({ id: params[0] });
    },
  };
  return { api, indexes, tables, applied, writes, failOn: (s) => { failAt = s; } };
}

function useRunner(t, api) {
  for (const method of ["dialect", "all", "run"]) t.mock.method(db, method, api[method]);
}

test("043 MySQL: fresh creation and a fully applied-but-unrecorded rerun preserve all indexes", async (t) => {
  const fixture = mysqlFixture();
  await migration.up(fixture.api, "mysql");
  const before = structuredClone([...fixture.indexes]);
  fixture.writes.length = 0;
  useRunner(t, fixture.api);
  await migrate({ snapshot: false });
  assert.deepEqual([...fixture.indexes], before);
  assert.ok(!fixture.writes.some((sql) => /^CREATE INDEX/.test(sql)));
  assert.deepEqual(await pendingMigrations(), []);
  const writeCount = fixture.writes.length;
  await migrate({ snapshot: false });
  assert.equal(fixture.writes.length, writeCount + 1, "completed migration is not rerun");
});

for (const failure of ["idx_ai_conv_external", "CREATE TABLE IF NOT EXISTS ai_messages", "idx_ai_msg_conv", "CREATE TABLE IF NOT EXISTS ai_knowledge", "idx_ai_kb_scope", "INSERT INTO schema_migrations"]) {
  test(`043 MySQL: resume after failure at ${failure}, without premature tracking`, async (t) => {
    const fixture = mysqlFixture();
    useRunner(t, fixture.api);
    fixture.failOn(failure);
    await assert.rejects(migrate({ snapshot: false }), /injected DDL failure/);
    assert.deepEqual((await pendingMigrations()).map((m) => m.id), [migration.id]);
    const before = structuredClone([...fixture.indexes]);
    fixture.failOn(null);
    await migrate({ snapshot: false });
    for (const [key, rows] of before) assert.deepEqual(fixture.indexes.get(key), rows);
    assert.equal(fixture.indexes.size, 4);
    assert.equal(fixture.applied.filter((m) => m.id === migration.id).length, 1);
  });
}

for (const [field, value] of [["Column_name", "user_id"], ["Table", "other_table"], ["Seq_in_index", 2], ["Non_unique", 0], ["Sub_part", 10], ["Collation", "D"], ["Index_type", "HASH"], ["Visible", "NO"]]) {
  test(`043 MySQL: reject incompatible existing index (${field}) without modifying it or tracking success`, async (t) => {
    const fixture = mysqlFixture();
    await migration.up(fixture.api, "mysql");
    fixture.indexes.get("ai_conversations.idx_ai_conv_tenant")[0][field] = value;
    const before = structuredClone([...fixture.indexes]);
    fixture.writes.length = 0;
    useRunner(t, fixture.api);
    await assert.rejects(migrate({ snapshot: false }), /index idx_ai_conv_tenant on ai_conversations.*schema differs/);
    assert.deepEqual([...fixture.indexes], before);
    assert.deepEqual((await pendingMigrations()).map((m) => m.id), [migration.id]);
    assert.ok(fixture.writes.every((sql) => /CREATE TABLE IF NOT EXISTS/.test(sql)));
  });
}

test("043 MySQL: metadata failures and duplicate errors during creation are not ignored", async () => {
  const fixture = mysqlFixture();
  await assert.rejects(migration.up({ ...fixture.api, all: async () => { throw new Error("metadata access denied"); } }, "mysql"), /metadata access denied/);
  const error = Object.assign(new Error("unexpected duplicate"), { code: "ER_DUP_KEYNAME" });
  await assert.rejects(migration.up({ ...fixture.api, run: async (sql) => {
    if (/^CREATE INDEX/.test(sql)) throw error;
    return fixture.api.run(sql);
  } }, "mysql"), (err) => err === error);
});

function sqliteFixture(t) {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  return {
    raw,
    api: {
      run: async (sql, params = []) => raw.prepare(sql).run(...params),
      all: async (sql, params = []) => raw.prepare(sql).all(...params),
      get: async (sql, params = []) => raw.prepare(sql).get(...params),
    },
  };
}

test("043 SQLite: retry after partial completion preserves schema, tenant rows, messages and defaults", async (t) => {
  const { raw, api } = sqliteFixture(t);
  await assert.rejects(migration.up({ ...api, run: async (sql, params) => {
    if (sql.includes("CREATE TABLE IF NOT EXISTS ai_messages")) throw new Error("interrupted");
    return api.run(sql, params);
  } }, "sqlite"), /interrupted/);
  raw.exec("INSERT INTO ai_conversations (madrasa_id, title) VALUES (11, 'School A'), (22, 'School B')");
  await migration.up(api, "sqlite");
  raw.exec("INSERT INTO ai_messages (conversation_id, role, content) VALUES (1, 'user', 'Keep this message')");
  raw.exec("INSERT INTO ai_knowledge (answer) VALUES ('Keep this answer')");
  const snapshot = () => JSON.stringify([
    raw.prepare("SELECT * FROM sqlite_master ORDER BY name").all(),
    ...["ai_conversations", "ai_messages", "ai_knowledge"].map((table) => raw.prepare(`SELECT * FROM ${table} ORDER BY id`).all()),
  ]);
  const before = snapshot();
  await migration.up(api, "sqlite");
  assert.equal(snapshot(), before);
  assert.equal(raw.prepare("SELECT keywords FROM ai_knowledge").get().keywords, "");
  for (const [, name, cols] of definitions) {
    assert.deepEqual(raw.prepare(`PRAGMA index_info(${name})`).all().map((r) => r.name), cols);
  }
});

for (const ddl of [
  "CREATE INDEX idx_ai_conv_tenant ON ai_conversations (surface, madrasa_id, id)",
  "CREATE UNIQUE INDEX idx_ai_conv_tenant ON ai_conversations (madrasa_id, surface, id)",
  "CREATE INDEX idx_ai_conv_tenant ON ai_conversations (madrasa_id, surface, id) WHERE madrasa_id = 11",
  "CREATE INDEX idx_ai_conv_tenant ON unrelated (madrasa_id, surface, id)",
]) {
  test(`043 SQLite: reject conflicting schema: ${ddl}`, async (t) => {
    const { raw, api } = sqliteFixture(t);
    // These are disposable in-memory test tables, never application data.
    raw.exec("CREATE TABLE ai_conversations (id INTEGER, madrasa_id INTEGER, surface TEXT)");
    raw.exec("CREATE TABLE unrelated (id INTEGER, madrasa_id INTEGER, surface TEXT)");
    raw.exec(ddl);
    const before = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_ai_conv_tenant'").get().sql;
    await assert.rejects(migration.up(api, "sqlite"), /schema differs/);
    assert.equal(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_ai_conv_tenant'").get().sql, before);
  });
}
