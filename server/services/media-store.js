"use strict";
/* ============================================================================
   EduSphere — media store (database-backed image persistence)
   ----------------------------------------------------------------------------
   WHY THIS EXISTS
   Uploads (portraits, signatures, logos) used to live only in the uploads/
   directory. That works on a server with a persistent volume and silently
   fails everywhere else: hosts that rebuild the container on every deploy
   (Render without an attached disk, Railway, Fly.io, a fresh VM) throw the
   files away while the database — students, fees, results — survives. The
   report is always the same: "I deploy and the pictures are gone."

   Every image is therefore stored TWICE:
     1. on disk in uploads/<context>/ (the fast path, served statically), and
     2. in the media_files table as base64 — so a redeploy can lose every file
        and the /uploads route still answers from the database.

   Base64 rather than a BLOB on purpose: the JSON backup snapshot
   (services/backup.js) round-trips plain strings correctly, so pictures are
   included in backups and restorations without any special handling.

   The web path (/uploads/<context>/<name>) is the only key callers ever see;
   photo_path columns across the schema keep storing that short string.
   ========================================================================== */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const db = require("../db");
const config = require("../config");

/** Only paths this platform generated are ever served or deleted. */
const WEB_PATH = /^\/uploads\/([a-z0-9-]+)\/([0-9]+-[a-f0-9]{16}\.(?:png|jpe?g|webp|bin))$/;

function parseWebPath(webPath) {
  const match = WEB_PATH.exec(String(webPath || ""));
  if (!match) return null;
  return { context: match[1], name: match[2] };
}

/**
 * Stores (or replaces) the bytes for a web path. The row is keyed by web_path
 * so a re-upload of the same name overwrites rather than duplicating.
 */
async function put(webPath, buffer, mime) {
  const parsed = parseWebPath(webPath);
  if (!parsed) return false;
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  const base64 = buffer.toString("base64");
  await db.run("DELETE FROM media_files WHERE web_path = ?", [webPath]);
  await db.run(
    "INSERT INTO media_files (web_path, context, mime, data, bytes) VALUES (?,?,?,?,?)",
    [webPath, parsed.context, String(mime || "application/octet-stream"), base64, buffer.length]
  );
  return true;
}

/** Returns { mime, data } (Buffer) or null. */
async function get(webPath) {
  const parsed = parseWebPath(webPath);
  if (!parsed) return null;
  const row = await db.get("SELECT mime, data, bytes FROM media_files WHERE web_path = ?", [webPath]);
  if (!row || !row.data) return null;
  return { mime: row.mime || "application/octet-stream", data: Buffer.from(String(row.data), "base64") };
}

async function remove(webPath) {
  const parsed = parseWebPath(webPath);
  if (!parsed) return false;
  await db.run("DELETE FROM media_files WHERE web_path = ?", [webPath]);
  return true;
}

/**
 * One-time safety net for installs that already have files on disk: copy every
 * stored-looking upload into the database at boot, so the NEXT deploy cannot
 * lose them either. Best-effort and idempotent — rows that exist are skipped.
 */
async function hydrateFromDisk() {
  const root = path.resolve(config.UPLOAD_DIR);
  if (!fs.existsSync(root)) return { copied: 0, skipped: 0 };
  let copied = 0;
  let skipped = 0;
  const contexts = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of contexts) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const files = await fsp.readdir(dir).catch(() => []);
    for (const name of files) {
      const webPath = `/uploads/${entry.name}/${name}`;
      if (!parseWebPath(webPath)) continue;
      try {
        const exists = await db.get("SELECT web_path FROM media_files WHERE web_path = ?", [webPath]);
        if (exists) { skipped += 1; continue; }
        const buffer = await fsp.readFile(path.join(dir, name));
        const ext = path.extname(name).toLowerCase();
        const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".bin" ? "application/octet-stream" : "image/jpeg";
        await put(webPath, buffer, mime);
        copied += 1;
      } catch (e) { /* one bad file must not stop the rest */ }
    }
  }
  return { copied, skipped };
}

module.exports = { put, get, remove, hydrateFromDisk, parseWebPath };
