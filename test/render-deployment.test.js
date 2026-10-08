"use strict";
/* ============================================================================
   Render deployment contract
   ---------------------------------------------------------------------------
   This is deliberately a source-level test: a skipped disk, a SQLite fallback,
   or an unsupported Blueprint key is a data-loss bug, not merely a docs typo.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const { findMountFor, durabilityOf, pickDefaultDataDir } = require("../server/services/mounts");
const { splitUrlSslMode } = require("../server/services/mysql-url");

const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const envVars = (service) => Object.fromEntries(service.envVars.map((entry) => [entry.key, entry]));

function productionEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-render-config-"));
  return {
    env: Object.assign({}, process.env, {
      NODE_ENV: "production",
      DATABASE_DRIVER: "mysql",
      DATABASE_URL: "mysql://user:password@db.example.test:3306/madrasa",
      SESSION_SECRET: "x".repeat(48),
      SUPER_ADMIN_PASSWORD: "A-strong-production-password!",
      DATA_DIR: path.join(dir, "data"),
      DATABASE_FILE: path.join(dir, "data", "madrasa_platform.sqlite"),
      PERSISTENT_VOLUME_DIR: path.join(dir, "data"),
      UPLOAD_DIR: path.join(dir, "data", "uploads"),
      BACKUP_DIR: path.join(dir, "data", "backups"),
      BACKUP_INTERVAL_MINUTES: "0",
    }, overrides),
    dir,
  };
}

function runConfig(script, overrides) {
  const { env, dir } = productionEnv(overrides);
  try {
    return spawnSync(process.execPath, ["-e", script], { cwd: ROOT, env, encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the Render Blueprint requests durable storage and an explicit MySQL database", () => {
  const doc = yaml.load(read("render.yaml"));
  assert.ok(Array.isArray(doc.services) && doc.services.length === 1, "one explicit production service");
  const service = doc.services[0];
  assert.equal(service.type, "web");
  assert.equal(service.runtime, "node");
  assert.equal(service.plan, "starter", "persistent disks need a paid Render service");
  assert.equal(service.numInstances, 1, "a Render disk cannot be shared by scaled instances");
  assert.deepEqual(service.disk, { name: "bello-data", mountPath: "/var/data", sizeGB: 1 });
  assert.equal(service.nodeVersion, undefined, "nodeVersion is not a valid Render Blueprint field");

  const vars = envVars(service);
  assert.equal(vars.NODE_VERSION.value, "22.22.3");
  assert.equal(vars.NODE_ENV.value, "production");
  assert.equal(vars.DATABASE_DRIVER.value, "mysql", "production must not fall back to SQLite");
  assert.equal(vars.DATABASE_URL.sync, false, "Render must request a real database URL at deploy time");
  assert.equal(vars.DATA_DIR.value, "/var/data");
  assert.equal(vars.UPLOAD_DIR.value, "/var/data/uploads");
  assert.equal(vars.BACKUP_DIR.value, "/var/data/backups");
  assert.equal(vars.PERSISTENT_VOLUME_DIR.value, "/var/data");
});

test("Node is pinned with Render-supported settings rather than an invalid Blueprint field", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(read(".node-version").trim(), "22.22.3");
  assert.equal(pkg.engines.node, ">=22.22.3 <23.0.0");
});

test("production rejects SQLite when the configured data mount is actually ephemeral", () => {
  // Override the storage probe in a subprocess. This isolates the test from
  // the CI machine's own mount layout while exercising config.validate(), the
  // exact guard that runs before migrations and seed data at server boot.
  const result = runConfig(`
    const config = require("./server/config");
    require("./server/services/persistence").describeStorage = () => ({
      onPersistentVolume: false, mountPoint: "/", fsType: "overlay"
    });
    config.validate();
  `, { RENDER: "true", DATABASE_DRIVER: "sqlite", DATABASE_URL: "" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Refusing to start production/i);
  assert.match(result.stderr, /Render disk|persistent disk/i);
});

test("production accepts the explicit MySQL DATABASE_URL without a local SQLite fallback", () => {
  const result = runConfig(`require("./server/config").validate();`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /SQLite database/i);
});

/* ---------------------------------------------------------------------------
   Storage and TLS details that only matter on Render.
   A test cannot mount a disk, so the mount table is read from fixtures here;
   the real config and db modules run in subprocesses, as the checks above do.
--------------------------------------------------------------------------- */

const MOUNTS_ROOT_ONLY = "overlay / overlay rw,relatime 0 0\nproc /proc proc rw,nosuid 0 0\n";
const MOUNTS_WITH_DISK = MOUNTS_ROOT_ONLY + "/dev/vdb /var/data ext4 rw,relatime 0 0\n";

function atLeast(version, floor) {
  const a = String(version).split(".").map(Number);
  const b = String(floor).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

/** Runs server/db.js against a closed port: the driver must be configured, not connected. */
function runDbProbe(overrides) {
  const { env, dir } = productionEnv(Object.assign({ NODE_ENV: "development", DATABASE_DRIVER: "mysql" }, overrides));
  try {
    return spawnSync(process.execPath, ["-e", `
      const db = require(${JSON.stringify(path.join(ROOT, "server", "db.js"))});
      db.get("SELECT 1 AS ok").then(
        () => { console.log("RESULT connected"); process.exit(0); },
        (e) => { console.log("RESULT failed " + (e.code || e.message)); process.exit(0); },
      );
    `], { cwd: ROOT, env, encoding: "utf8", timeout: 60000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the lockfile resolves the multer and proxy-addr releases that fix the production advisories", () => {
  // `npm audit --omit=dev` (the set Render installs) reported multer 2.3.0 and
  // proxy-addr 2.0.7. The fixes are multer 2.4.0 and proxy-addr 2.0.8.
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(pkg.dependencies.multer, "^2.4.0", "the declared range cannot resolve below the fix");
  assert.ok(atLeast(lock.packages["node_modules/multer"].version, "2.4.0"), "multer is locked at or above 2.4.0");
  assert.ok(atLeast(lock.packages["node_modules/proxy-addr"].version, "2.0.8"), "proxy-addr is locked at or above 2.0.8");
});

test("the DATABASE_URL ssl-mode is removed before mysql2 sees it, and the boot says what it means", () => {
  const result = runDbProbe({ DATABASE_URL: "mysql://user:password@127.0.0.1:1/madrasa?ssl-mode=REQUIRED" });
  assert.doesNotMatch(result.stderr, /Ignoring invalid configuration option/, result.stderr);
  assert.match(result.stdout, /asks for ssl-mode=REQUIRED/, result.stdout);
  assert.match(result.stdout, /NOT encrypted/, "the operator is told the connection is still plaintext");
  assert.match(result.stdout, /RESULT failed/, "port 1 is closed: the probe fails, but never connects");
});

test("no TLS notice without ssl-mode or with DISABLED, and DB_SSL is the switch that turns TLS on", () => {
  for (const url of [
    "mysql://user:password@127.0.0.1:1/madrasa",
    "mysql://user:password@127.0.0.1:1/madrasa?ssl-mode=DISABLED&charset=utf8mb4",
  ]) {
    const quiet = runDbProbe({ DATABASE_URL: url });
    assert.doesNotMatch(quiet.stdout, /NOT encrypted/, url);
    assert.doesNotMatch(quiet.stderr, /Ignoring invalid configuration option/, url);
  }
  const tls = runDbProbe({ DATABASE_URL: "mysql://user:password@127.0.0.1:1/madrasa?ssl-mode=REQUIRED", DB_SSL: "true" });
  assert.doesNotMatch(tls.stdout, /NOT encrypted/, "with DB_SSL on there is nothing to report");
  assert.doesNotMatch(tls.stderr, /Ignoring invalid configuration option/);
});

test("the URL split removes only ssl-mode and normalises the mode it asked for", () => {
  assert.deepEqual(splitUrlSslMode("mysql://u:p@h:3306/db?ssl-mode=REQUIRED"),
    { url: "mysql://u:p@h:3306/db", sslMode: "REQUIRED" });
  assert.deepEqual(splitUrlSslMode("mysql://u:p@h/db?charset=utf8mb4&ssl-mode=verify-ca&timezone=Z"),
    { url: "mysql://u:p@h/db?charset=utf8mb4&timezone=Z", sslMode: "VERIFY_CA" }, "other parameters keep their order");
  assert.deepEqual(splitUrlSslMode("mysql://u:p@h/db?sslmode=require"),
    { url: "mysql://u:p@h/db", sslMode: "REQUIRE" }, "the PostgreSQL spelling is handled too");
  assert.deepEqual(splitUrlSslMode("mysql://u:p@h/db?SSL-MODE=VERIFY%5FIDENTITY"),
    { url: "mysql://u:p@h/db", sslMode: "VERIFY_IDENTITY" });
  assert.deepEqual(splitUrlSslMode("mysql://u:p@h/db?charset=utf8mb4"),
    { url: "mysql://u:p@h/db?charset=utf8mb4", sslMode: null }, "without ssl-mode the URL is untouched");
  assert.deepEqual(splitUrlSslMode("mysql://u:p@h/db"), { url: "mysql://u:p@h/db", sslMode: null });
  assert.deepEqual(splitUrlSslMode(""), { url: "", sslMode: null });
});

test("a directory is durable only on a dedicated mount, and only the Render disk moves DATA_DIR", () => {
  assert.equal(durabilityOf(findMountFor("/var/data/uploads", MOUNTS_WITH_DISK)), true, "the attached disk");
  assert.equal(durabilityOf(findMountFor("/var/data/uploads", MOUNTS_ROOT_ONLY)), false, "the container root");
  assert.equal(durabilityOf(findMountFor("/var/data", MOUNTS_ROOT_ONLY + "tmpfs /var/data tmpfs rw 0 0\n")), false,
    "a tmpfs is never durable");
  assert.equal(durabilityOf(findMountFor("/srv/app", "/dev/sda1 / ext4 rw 0 0\n")), true,
    "a VPS root on a real block device is durable");
  assert.equal(durabilityOf(findMountFor("/var/data", null)), null, "no mount table means no opinion");
  // The longest covering mount is the one that counts.
  const nested = "/dev/sda1 /var ext4 rw 0 0\n/dev/vdb /var/data xfs rw 0 0\n";
  assert.equal(findMountFor("/var/data/backups", nested).mountPoint, "/var/data");

  const pick = (isRender, mountsText) => pickDefaultDataDir({ isRender, persistentVolumeDir: "/var/data", mountsText });
  assert.equal(pick(true, MOUNTS_WITH_DISK), "/var/data", "Render with the disk mounted: the disk");
  assert.equal(pick(true, MOUNTS_ROOT_ONLY), "./data", "Render without the disk: unchanged");
  assert.equal(pick(false, MOUNTS_WITH_DISK), "./data", "off Render the default never moves");
  assert.equal(pick(true, "/dev/sda1 / ext4 rw 0 0\n"), "./data", "a root filesystem is not a dedicated disk");
  assert.equal(pick(true, null), "./data", "an unreadable mount table keeps the old default");
});

test("config takes DATA_DIR from the disk only when DATA_DIR is unset and the disk is really mounted", () => {
  const load = (extra) => {
    const env = Object.assign({}, process.env, { NODE_ENV: "development", DATABASE_DRIVER: "sqlite", RENDER: "true" }, extra);
    for (const key of ["DATA_DIR", "UPLOAD_DIR", "BACKUP_DIR", "PERSISTENT_VOLUME_DIR"]) {
      if (!(key in extra)) delete env[key];
    }
    // Run from the OS temp directory so nothing can be written into the repository.
    const out = spawnSync(process.execPath, ["-e", `
      const c = require(${JSON.stringify(path.join(ROOT, "server", "config.js"))});
      console.log("RESULT" + JSON.stringify({ DATA_DIR: c.DATA_DIR, BACKUP_DIR: c.BACKUP_DIR, UPLOAD_DIR: c.UPLOAD_DIR }));
    `], { cwd: os.tmpdir(), env, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout.trim().split("\n").pop().slice("RESULT".length));
  };
  // The child reports the resolved working directory, so compare against the real path.
  const tmp = fs.realpathSync(os.tmpdir());
  const defaulted = pickDefaultDataDir({ isRender: true, persistentVolumeDir: "/var/data" });
  const onRender = load({});
  assert.equal(onRender.DATA_DIR, path.resolve(tmp, defaulted), "Render, nothing set: the same choice the probe makes");
  assert.equal(onRender.BACKUP_DIR, path.join(onRender.DATA_DIR, "backups"));
  assert.equal(onRender.UPLOAD_DIR, path.join(onRender.DATA_DIR, "uploads"));

  const explicit = load({ DATA_DIR: "/srv/explicit-data" });
  assert.equal(explicit.DATA_DIR, "/srv/explicit-data", "an explicit DATA_DIR always wins");
  assert.equal(explicit.UPLOAD_DIR, "/srv/explicit-data/uploads");

  const notRender = load({ RENDER: "" });
  assert.equal(notRender.DATA_DIR, path.resolve(tmp, "data"), "outside Render the default is still ./data");
});
