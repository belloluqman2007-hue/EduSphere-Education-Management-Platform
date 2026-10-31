"use strict";
// Upgrade private disk-only attachments while their old files still exist.
// This cannot recover files that the host has already deleted.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const db = require("../db");
const config = require("../config");
const store = require("./media-store");

const TABLES = [
  ["student_documents", "storage_path", "files"],
  ["admission_documents", "storage_path", "files"],
  ["teacher_documents", "storage_path", "teacher-files"],
  ["teacher_application_documents", "storage_path", "teacher-application-files"],
  ["academic_attachments", "storage_path", "files"],
  ["assignment_submissions", "attachment_path", "submissions"],
  ["support_chat_attachments", "storage_name", "support-chat"],
];
const EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv"]);

async function hydratePrivateDocuments() {
  const root = path.resolve(config.DATA_DIR) + path.sep;
  const converted = new Map();
  let copied = 0, missing = 0, failed = 0;
  for (const [table, column, context] of TABLES) {
    const rows = await db.all(`SELECT id, ${column} AS stored_path, mime_type, madrasa_id FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`);
    for (const row of rows) {
      const old = String(row.stored_path || "");
      if (old.startsWith("dbmedia:")) continue;
      const full = table === "support_chat_attachments" ? path.join(config.DATA_DIR, "support-chat", path.basename(old)) : path.resolve(old);
      if (!path.resolve(full).startsWith(root)) { missing++; continue; }
      const ext = path.extname(full).toLowerCase();
      if (!EXTENSIONS.has(ext)) { missing++; continue; }
      const key = `${context}:${full}`;
      try {
        let replacement = converted.get(key);
        if (!replacement) {
          const bytes = await fs.readFile(full);
          const name = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
          const webPath = `/uploads/private-${context}/${name}`;
          if (!await store.put(webPath, bytes, row.mime_type, row.madrasa_id)) throw new Error("Media store refused the file.");
          replacement = `dbmedia:${webPath}`;
          converted.set(key, replacement);
          copied++;
        }
        await db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} = ?`, [replacement, row.id, old]);
      } catch (e) {
        if (e.code === "ENOENT" || e.code === "ENOTDIR") missing++;
        else { failed++; console.warn(`Private media migration failed for ${table} #${row.id}: ${e.message}`); }
      }
    }
  }
  return { copied, missing, failed };
}

module.exports = { hydratePrivateDocuments };
