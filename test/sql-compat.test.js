"use strict";
/* ============================================================================
   STATIC SQL DIALECT-COMPATIBILITY TEST (SQLite ⇄ MySQL)
   ----------------------------------------------------------------------------
   The platform runs SQLite in development and MySQL 8 in production (see
   docs/DATABASE.md). This test statically scans every server-side SQL string
   for constructs that are valid in only ONE dialect, so a dialect-unsafe
   query cannot silently reach production.

   What it checks:
     • SQLite-only syntax used without a MySQL counterpart in the same
       statement/expression: ON CONFLICT, INSERT OR IGNORE / OR REPLACE,
       AUTOINCREMENT, strftime/julianday, sqlite_master, PRAGMA
     • MySQL-only syntax used without a SQLite counterpart in the same
       statement/expression: ON DUPLICATE KEY UPDATE, INSERT IGNORE,
       DATE_FORMAT, ENGINE=InnoDB, backtick identifiers, SHOW TABLES
     • Dynamic ORDER BY / LIMIT built by template interpolation (must go
       through an allowlist — the known allowlisted sites are listed below)
     • Double-quoted identifiers inside SQL (a string in MySQL, an identifier
       in SQLite — never used intentionally by this codebase)

   The dialect helpers in server/migrate.js (D.*) and the backup restore
   quoter branch explicitly on dialect; the sites below are the audited,
   known-correct branches. Anything NEW must either branch on dialect the
   same way or be added here with a justification.
   ========================================================================== */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/* Sites where a dialect-specific construct appears next to its dialect twin
   (a ternary on dialect, an if/else on dialect, or the migrate.js D helpers).
   Each entry: "<relative path>:<1-based line>" — kept as exact line refs. */
const AUDITED_DIALECT_BRANCHES = new Set([
  // session-store.js — upsert, branched via db.dialect()
  "server/session-store.js:50",
  "server/session-store.js:52",
  // db.js — insertIgnore helper branches on d.dialect
  "server/db.js:154",
  // db.js — sqlite connect-time PRAGMAs (synchronous=NORMAL, busy_timeout);
  // they sit inside connectSqlite — the sqlite branch of the dialect fork —
  // but the explanatory comment pushes them past the twin-detection window
  "server/db.js:40",
  "server/db.js:43",
  // fees.js — fee upsert, dialect ternary on the same statement pair
  "server/routes/fees.js:98",
  "server/routes/fees.js:100",
  // madrasa.js / platform.js / quran-progress.js — settings upserts
  "server/routes/madrasa.js:352",
  "server/routes/madrasa.js:354",
  "server/routes/platform.js:580",
  "server/routes/platform.js:585",
  "server/routes/quran-progress.js:133",
  "server/routes/quran-progress.js:135",
  // classes.js / teachers.js / timetable.js — INSERT (OR) IGNORE ternaries
  "server/routes/classes.js:53",
  "server/routes/teachers.js:157",
  "server/routes/timetable.js:123",
  // analytics.js — DATE_FORMAT vs strftime / CAST expressions
  "server/services/analytics.js:85",
  "server/services/analytics.js:92",
]);

/* Dynamic ORDER BY/LIMIT sites verified to run on strict allowlists:
   `${sort}` comes from a hardcoded sortMap object (unknown keys fall back to
   a safe default) and `${direction}` is normalised to the literal ASC/DESC —
   the exact pattern required for dynamic sorting. */
const AUDITED_SORT_ALLOWLISTS = new Set([
  "server/routes/classes.js:195",
]);

/* Audited dynamic-sort shapes, matched by file and query text rather than by
   line number: a numbered entry silently passes the moment an unrelated edit
   shifts the line, and silently fails the moment it does not. `sort` and
   `direction` in the staff directory come from a literal sortMap lookup and a
   ternary — both constants, never request text — so the exact SQL is what a
   reviewer needs to see here. */
const AUDITED_SORT_SHAPES = [
  { file: "server/routes/teachers.js", sql: /ORDER BY \$\{sort\} \$\{direction\}, u\.id DESC LIMIT \? OFFSET \?/ },
];

/* Statements where a table or column list is interpolated from a hardcoded,
   non-user-controlled constant array (verified: values come from literal
   arrays in the same function, never from req.query / req.body). */
const AUDITED_CONSTANT_INTERPOLATIONS = [
  /server\/routes\/students\.js:\d+/, // table from a literal [key, table] array
  /server\/routes\/admissions\.js:\d+/, // table from literal maps
  /server\/routes\/fees\.js:\d+/, // `${fm}`/`${cm}` placeholder lists (only ? marks)
  /server\/routes\/communication\.js:\d+/, // `${cm}` placeholder list
  /server\/services\/communication\.js:\d+/, // `${cm}` / `${values}` placeholder lists
  /server\/routes\/madrasa\.js:\d+/, // `${sm}` placeholder list
  /server\/services\/backup\.js:\d+/, // restore quoter branches on dialect
  /server\/migrate\.js:\d+/, // D.* helpers + `${dialect === ...}` branches
  /server\/routes\/admin\.js:\d+/, // `${clause}` built from ? placeholders
  /server\/services\/audit\.js:\d+/, // `${clause}` built from ? placeholders
  /server\/routes\/attendance\.js:\d+/, // `${where.join}` built from ? placeholders
];

const SQLITE_ONLY = [
  /\bON\s+CONFLICT\b/i,
  /\bINSERT\s+OR\s+(IGNORE|REPLACE)\b/i,
  /\bAUTOINCREMENT\b/i,
  /\bstrftime\s*\(/i,
  /\bjulianday\s*\(/i,
  /datetime\s*\(\s*['"]now/i,
  /\bsqlite_master\b/i,
  /\bPRAGMA\b/i,
];
const MYSQL_ONLY = [
  /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i,
  /\bINSERT\s+IGNORE\b/i,
  /\bDATE_FORMAT\s*\(/i,
  /\bENGINE\s*=\s*InnoDB\b/i,
  /\bSHOW\s+TABLES\b/i,
];

/** True when the line (or its immediate neighbours) also holds the other
 *  dialect's counterpart — i.e. an explicit branch. */
function hasDialectTwin(lines, idx, otherDialectRegexes) {
  const window = lines.slice(Math.max(0, idx - 8), idx + 4).join("\n");
  return otherDialectRegexes.some((r) => r.test(window))
    || /dialect\s*===?\s*["'](mysql|sqlite)["']/.test(window)
    || /connectSqlite|connectMysql/.test(window);
}

test("every dialect-specific SQL construct sits behind an explicit dialect branch", () => {
  const files = walk(SERVER).filter((f) => !f.includes("node_modules"));
  const violations = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const ref = `${rel}:${i + 1}`;
      for (const rx of SQLITE_ONLY) {
        if (rx.test(line) && !AUDITED_DIALECT_BRANCHES.has(ref) && !hasDialectTwin(lines, i, MYSQL_ONLY)) {
          violations.push(`${ref}  SQLite-only ${rx} without a MySQL twin`);
        }
      }
      for (const rx of MYSQL_ONLY) {
        if (rx.test(line) && !AUDITED_DIALECT_BRANCHES.has(ref) && !hasDialectTwin(lines, i, SQLITE_ONLY)) {
          violations.push(`${ref}  MySQL-only ${rx} without a SQLite twin`);
        }
      }
    });
  }
  assert.deepEqual(violations, [], "Dialect-unsafe SQL found (add an explicit dialect branch, then list the audited site):\n" + violations.join("\n"));
});

test("ORDER BY / LIMIT / column names are never interpolated straight from user input", () => {
  const files = walk(SERVER).filter((f) => !f.includes("node_modules"));
  const violations = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Interpolated ORDER BY / LIMIT fragments
      if (/ORDER BY \$\{|LIMIT \$\{|GROUP BY \$\{/i.test(line)) {
        const ref = `${rel}:${i + 1}`;
        // monthExpr/dayExpr are the audited dialect-expression helpers in
        // services/analytics.js — they interpolate a per-dialect CONSTANT
        // (DATE_FORMAT vs strftime), never user input.
        const dialectHelper = /\$\{(monthExpr|dayExpr)\(/.test(line);
        const byShape = AUDITED_SORT_SHAPES.some((audited) => audited.file === rel && audited.sql.test(line));
        const known = dialectHelper || byShape
          || AUDITED_CONSTANT_INTERPOLATIONS.some((r) => r.test(ref)) || AUDITED_SORT_ALLOWLISTS.has(ref);
        if (!known) violations.push(`${ref}  dynamic ORDER BY/LIMIT: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(violations, [], "Dynamic ORDER BY/LIMIT must come from a strict allowlist map (see routes/classes.js sortMap for the pattern):\n" + violations.join("\n"));
});

test("no double-quoted identifiers and no string-concatenated SQL values in query text", () => {
  const files = walk(SERVER).filter((f) => !f.includes("node_modules"));
  const violations = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // "..." used as an identifier inside SQL (MySQL would read it as a string)
      if (/(SELECT|FROM|WHERE|JOIN|ORDER BY|GROUP BY|SET|VALUES|INTO|UPDATE|DELETE)\s+"[a-z_]+"(\s|,|\)|$)/i.test(line)) {
        violations.push(`${rel}:${i + 1}  double-quoted identifier: ${line.trim().slice(0, 100)}`);
      }
      // raw concatenation of request data into SQL
      if (/(\+\s*(req\.(query|body|params))|(req\.(query|body|params)\.[a-zA-Z_]+\s*\+))/.test(line) && /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(line)) {
        violations.push(`${rel}:${i + 1}  request value concatenated into SQL: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});
