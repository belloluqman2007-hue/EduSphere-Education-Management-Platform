"use strict";
/* ============================================================================
   Device-token storage — the token must NEVER be written in plaintext.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSecretStore, secretsDirFor } = require("../secret-store");

const TOKEN = "eds_" + "a1b2c3d4".repeat(8);

/** A reversible stand-in for Electron safeStorage (test only). */
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(text) {
      const body = Buffer.from(String(text), "utf8");
      for (let i = 0; i < body.length; i++) body[i] ^= 0x5a;
      return Buffer.concat([Buffer.from("ENC1"), body]);
    },
    decryptString(buffer) {
      const raw = Buffer.from(buffer);
      assert.equal(raw.slice(0, 4).toString("ascii"), "ENC1");
      const body = Buffer.from(raw.slice(4));
      for (let i = 0; i < body.length; i++) body[i] ^= 0x5a;
      return body.toString("utf8");
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "edusphere-secrets-"));
}

test("the device token round-trips through safeStorage and is encrypted on disk", () => {
  const dir = tempDir();
  const store = createSecretStore({ dir, safeStorage: fakeSafeStorage() });

  const result = store.set("deviceToken", TOKEN);
  assert.deepEqual(result, { persisted: true, reason: "" });

  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ["devicetoken.bin"]);
  const blob = fs.readFileSync(path.join(dir, "devicetoken.bin"));

  assert.ok(!blob.toString("utf8").includes(TOKEN), "the raw token must not appear anywhere in the file");
  assert.ok(!blob.toString("latin1").includes(TOKEN), "not even as latin1");
  assert.ok(!blob.toString("utf8").includes(TOKEN.slice(4, 20)), "no recognisable fragment of the token is stored");

  assert.equal(store.get("deviceToken"), TOKEN);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, "devicetoken.bin")).mode & 0o777, 0o600, "0600 permissions");
  }

  store.clear("deviceToken");
  assert.equal(store.get("deviceToken"), "");
  assert.deepEqual(fs.readdirSync(dir), [], "clearing removes the encrypted blob");
});

test("with no OS keychain the token is kept in memory only — never written in plaintext", () => {
  const dir = tempDir();
  const warnings = [];
  const store = createSecretStore({
    dir,
    safeStorage: fakeSafeStorage({ available: false }),
    logger: { warn: (m) => warnings.push(m) },
  });

  const result = store.set("deviceToken", TOKEN);
  assert.equal(result.persisted, false);
  assert.equal(result.reason, "encryption-unavailable");
  assert.equal(store.get("deviceToken"), TOKEN, "the session still works in memory");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".bin")), [], "nothing is written to disk");
  assert.equal(store.describe().memoryOnly.includes("devicetoken"), true);
  assert.ok(warnings.some((w) => /NOT written to disk/.test(w)));
});

test("a corrupted or foreign blob is treated as 'signed out', not as a crash", () => {
  const dir = tempDir();
  const store = createSecretStore({ dir, safeStorage: fakeSafeStorage() });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "devicetoken.bin"), Buffer.from("garbage-not-ours"));
  assert.equal(store.get("deviceToken"), "");
  assert.equal(store.has("deviceToken"), false);
});

test("getOrCreate generates once and then returns the stored value", () => {
  const dir = tempDir();
  const store = createSecretStore({ dir, safeStorage: fakeSafeStorage() });
  let generated = 0;
  const first = store.getOrCreate("sessionSecret", () => { generated += 1; return "s3cret-" + generated; });
  const second = store.getOrCreate("sessionSecret", () => { generated += 1; return "s3cret-" + generated; });
  assert.equal(first, "s3cret-1");
  assert.equal(second, "s3cret-1");
  assert.equal(generated, 1);

  // A fresh store (i.e. the next app launch) decrypts the same secret.
  const reopened = createSecretStore({ dir, safeStorage: fakeSafeStorage() });
  assert.equal(reopened.get("sessionSecret"), "s3cret-1");
});

test("secret keys are validated and the directory lives under userData", () => {
  const dir = tempDir();
  const store = createSecretStore({ dir, safeStorage: fakeSafeStorage() });
  assert.throws(() => store.set("../../etc/passwd", "x"), /Invalid secret key/);
  assert.throws(() => store.get("Device Token"), /Invalid secret key/);
  assert.equal(secretsDirFor("/tmp/example"), path.join("/tmp/example", "secrets"));
});
