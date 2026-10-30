"use strict";
/* ============================================================================
   EduSphere Desktop — encrypted secret storage (device tokens, hub secrets)
   ----------------------------------------------------------------------------
   The native app authenticates with `Authorization: Bearer eds_…` device
   tokens (Phase 1). Those tokens are bearer credentials: anyone who can read
   the file can impersonate the signed-in teacher, so they are NEVER written in
   plaintext and never kept in the renderer's localStorage.

   HOW IT WORKS
     • Electron's `safeStorage` encrypts with the OS keychain:
         - macOS  → Keychain (AES-GCM key in the login keychain)
         - Windows → DPAPI (tied to the Windows user account)
         - Linux  → libsecret / kwallet (GNOME Keyring, KWallet)
       The ciphertext is written as an opaque binary blob inside
       `app.getPath("userData")/secrets/` with 0600 permissions.
     • If the OS offers NO encryption backend (`safeStorage.isEncryptionAvailable()
       === false`, e.g. a Linux box with no keyring running), we refuse to write
       anything at all: the token is held in memory for the current run only and
       every caller is told it was not persisted. Storing it "encrypted" with a
       key that is stored next to it would be a lie, and writing it in plaintext
       is exactly what this module exists to prevent.
     • Writes are atomic (temp file → fsync → rename), so a crash during a token
       rotation cannot leave a corrupt blob that logs the user out.

   NOTE: preload.js asks the MAIN process for the token (one synchronous IPC at
   preload time, then async updates). Nothing here is reachable from page
   JavaScript — the renderer only ever sees a string.
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SECRETS_DIRNAME = "secrets";
const KEY_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;

function assertKey(key) {
  const clean = String(key || "").trim().toLowerCase();
  if (!KEY_PATTERN.test(clean)) throw new Error("Invalid secret key: " + key);
  return clean;
}

function secretsDirFor(userDataDir) {
  return path.join(String(userDataDir), SECRETS_DIRNAME);
}

/**
 * @param {object} options
 * @param {string} options.dir            absolute secrets directory
 * @param {object} options.safeStorage    Electron safeStorage (or a test double)
 * @param {object} [options.fs]           fs implementation (tests)
 * @param {object} [options.logger]
 */
function createSecretStore(options = {}) {
  const dir = options.dir || secretsDirFor(options.userDataDir || process.cwd());
  const safeStorage = options.safeStorage || null;
  const fsImpl = options.fs || fs;
  const logger = options.logger || console;
  /** In-memory copy — the only place a usable token ever lives in the shell. */
  const memory = new Map();
  /** Keys the caller tried to persist but we could not (encryption unavailable). */
  const unpersisted = new Set();

  function fileFor(key) {
    return path.join(dir, assertKey(key) + ".bin");
  }

  function encryptionAvailable() {
    try {
      return Boolean(safeStorage && typeof safeStorage.encryptString === "function" && safeStorage.isEncryptionAvailable());
    } catch (e) {
      return false;
    }
  }

  function ensureDir() {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fsImpl.chmodSync(dir, 0o700); } catch (e) { /* Windows ignores POSIX modes */ }
  }

  /** Read + decrypt a stored secret, or "" when absent/corrupt/undecryptable. */
  function get(key) {
    const clean = assertKey(key);
    if (memory.has(clean)) return memory.get(clean);
    const file = fileFor(clean);
    let blob = null;
    try {
      blob = fsImpl.readFileSync(file);
    } catch (err) {
      return "";
    }
    if (!blob || !blob.length) return "";
    if (!encryptionAvailable()) {
      // The keychain went away (e.g. libsecret removed). Keep the blob for a
      // later run rather than destroying the user's session, and behave as if
      // there is no token now.
      return "";
    }
    try {
      const value = safeStorage.decryptString(Buffer.from(blob));
      memory.set(clean, value);
      return value;
    } catch (err) {
      if (logger && logger.warn) logger.warn("Stored credential '" + clean + "' could not be decrypted; treating it as absent.");
      return "";
    }
  }

  /**
   * Store a secret. Returns `{ persisted, reason }` — `persisted:false` means
   * the value is only in memory for this run (no plaintext fallback, ever).
   */
  function set(key, value) {
    const clean = assertKey(key);
    const text = String(value == null ? "" : value);
    if (!text) return clear(clean);
    memory.set(clean, text);
    if (!encryptionAvailable()) {
      unpersisted.add(clean);
      if (logger && logger.warn) {
        logger.warn(
          "No OS encryption backend is available, so the " + clean +
          " was NOT written to disk. It stays valid for this run only."
        );
      }
      return { persisted: false, reason: "encryption-unavailable" };
    }
    const file = fileFor(clean);
    ensureDir();
    const encrypted = safeStorage.encryptString(text);
    const buffer = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
    writeBufferAtomic(file, buffer, fsImpl);
    unpersisted.delete(clean);
    return { persisted: true, reason: "" };
  }

  function clear(key) {
    const clean = assertKey(key);
    memory.delete(clean);
    unpersisted.delete(clean);
    try { fsImpl.unlinkSync(fileFor(clean)); } catch (e) { /* already gone */ }
    return { persisted: true, reason: "cleared" };
  }

  function has(key) {
    return Boolean(get(key));
  }

  /** Generate-and-store helper used for the hub SESSION_SECRET. */
  function getOrCreate(key, generator) {
    const existing = get(key);
    if (existing) return existing;
    const value = typeof generator === "function" ? String(generator()) : crypto.randomBytes(32).toString("hex");
    set(key, value);
    return value;
  }

  /** Diagnostics for the About / LAN Hub screens — never returns secret values. */
  function describe() {
    let files = 0;
    try { files = fsImpl.readdirSync(dir).filter((n) => n.endsWith(".bin")).length; } catch (e) { files = 0; }
    return {
      dir,
      encryptionAvailable: encryptionAvailable(),
      storedSecrets: files,
      memoryOnly: Array.from(unpersisted),
    };
  }

  return {
    dir,
    encryptionAvailable,
    get,
    set,
    clear,
    has,
    getOrCreate,
    describe,
  };
}

/** Atomic binary write (temp file → fsync → rename), 0600. */
function writeBufferAtomic(file, buffer, fsImpl = fs) {
  const dir = path.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp");
  let fd = null;
  try {
    fd = fsImpl.openSync(tmp, "w", 0o600);
    fsImpl.writeFileSync(fd, buffer);
    try { fsImpl.fsyncSync(fd); } catch (e) { /* ignore */ }
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(tmp, file);
    try { fsImpl.chmodSync(file, 0o600); } catch (e) { /* Windows */ }
    return true;
  } catch (err) {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch (e) { /* ignore */ } }
    try { fsImpl.unlinkSync(tmp); } catch (e) { /* ignore */ }
    throw err;
  }
}

module.exports = {
  SECRETS_DIRNAME,
  createSecretStore,
  secretsDirFor,
  writeBufferAtomic,
};
