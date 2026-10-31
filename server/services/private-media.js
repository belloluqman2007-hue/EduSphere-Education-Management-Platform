"use strict";
// Call only after the route has checked the owning record and permissions.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const db = require("../db");
const config = require("../config");
const mediaStore = require("./media-store");

async function download(res, storedPath, filename) {
  if (String(storedPath || "").startsWith("dbmedia:")) {
    const webPath = String(storedPath).slice("dbmedia:".length);
    if (!/^\/uploads\/private-[a-z0-9-]+\//.test(webPath)) return false;
    const file = await mediaStore.get(webPath);
    if (!file) return false;
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.attachment(filename || "document");
    res.type("application/octet-stream");
    res.send(file.data);
    return true;
  }
  // Existing installations may still have old private documents on disk.
  if (!storedPath || !fs.existsSync(storedPath)) return false;
  res.download(storedPath, filename || "document");
  return true;
}

// A document can be copied from an application into a student/teacher record.
// Remove bytes only after the final database reference has been removed.
async function removeIfUnused(storedPath) {
  if (!storedPath) return;
  const refs = [
    ["student_documents", "storage_path"], ["admission_documents", "storage_path"],
    ["teacher_documents", "storage_path"], ["teacher_application_documents", "storage_path"],
    ["academic_attachments", "storage_path"], ["assignment_submissions", "attachment_path"],
    ["support_chat_attachments", "storage_name"],
  ];
  if (String(storedPath).startsWith("dbmedia:")) {
    const webPath = storedPath.slice("dbmedia:".length);
    if (!/^\/uploads\/private-[a-z0-9-]+\//.test(webPath)) return;
    const clauses = refs.map(([table, column]) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE ${column} = ?)`);
    await db.run(`DELETE FROM media_files WHERE web_path = ? AND ${clauses.join(" AND ")}`, [webPath, ...refs.map(() => storedPath)]);
    return;
  }
  for (const [table, column] of refs) if (await db.get(`SELECT 1 AS found FROM ${table} WHERE ${column} = ? LIMIT 1`, [storedPath])) return;
  const root = path.resolve(config.DATA_DIR) + path.sep;
  const target = path.resolve(storedPath);
  if (!target.startsWith(root)) return;
  try { await fsp.unlink(target); } catch (e) { if (e.code !== "ENOENT") throw e; }
}

module.exports = { download, removeIfUnused };
