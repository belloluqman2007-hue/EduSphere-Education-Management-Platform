"use strict";
/* Database-backed uploads. Paths remain stable across restarts; the local
   filesystem is only an optional cache or staging area. Base64 keeps existing
   JSON database backups compatible, at the cost of roughly 33% extra space. */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const db = require("../db");
const config = require("../config");

/** Only paths this platform generated are ever served or deleted. */
const WEB_PATH = /^\/uploads\/([a-z0-9-]+)\/([0-9]+-[a-f0-9]{16}\.(?:png|jpe?g|webp|gif|bin|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv))$/;

function parseWebPath(webPath) {
  const match = WEB_PATH.exec(String(webPath || ""));
  if (!match) return null;
  return { context: match[1], name: match[2] };
}

/**
 * Stores (or replaces) the bytes for a web path. The row is keyed by web_path
 * so a re-upload of the same name overwrites rather than duplicating.
 */
async function put(webPath, buffer, mime, madrasaId = null) {
  const parsed = parseWebPath(webPath);
  if (!parsed) return false;
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  const base64 = buffer.toString("base64");
  // One atomic statement: a failed replacement must not erase the old copy.
  const dialect = await db.dialect();
  const upsert = dialect === "mysql"
    ? " ON DUPLICATE KEY UPDATE context = VALUES(context), mime = VALUES(mime), data = VALUES(data), bytes = VALUES(bytes), madrasa_id = COALESCE(VALUES(madrasa_id), madrasa_id)"
    : " ON CONFLICT(web_path) DO UPDATE SET context = excluded.context, mime = excluded.mime, data = excluded.data, bytes = excluded.bytes, madrasa_id = COALESCE(excluded.madrasa_id, media_files.madrasa_id)";
  await db.run(
    "INSERT INTO media_files (web_path, context, mime, data, bytes, madrasa_id) VALUES (?,?,?,?,?,?)" + upsert,
    [webPath, parsed.context, String(mime || "application/octet-stream"), base64, buffer.length, madrasaId || null]
  );
  return true;
}

/** Returns { mime, data } (Buffer) or null. */
async function get(webPath) {
  const parsed = parseWebPath(webPath);
  if (!parsed) return null;
  const row = await db.get("SELECT mime, data, bytes FROM media_files WHERE web_path = ?", [webPath]);
  if (!row) return null;
  if (!row.data) throw new Error("Stored media data is missing.");
  const encoded = String(row.data);
  const data = Buffer.from(encoded, "base64");
  if (!data.length || data.length !== Number(row.bytes) || data.toString("base64") !== encoded) {
    throw new Error("Stored media data is corrupt.");
  }
  return { mime: row.mime || "application/octet-stream", data };
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
        const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : [".jpg", ".jpeg"].includes(ext) ? "image/jpeg" : "application/octet-stream";
        await put(webPath, buffer, mime);
        copied += 1;
      } catch (e) { /* one bad file must not stop the rest */ }
    }
  }
  return { copied, skipped };
}

module.exports = { put, get, remove, hydrateFromDisk, parseWebPath };
