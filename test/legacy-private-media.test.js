"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { initEnv, setup } = require("./helpers");
initEnv();

test("legacy private documents are copied only when their original files exist", async () => {
  const ctx = await setup();
  try {
    const dir = path.join(process.env.DATA_DIR, "private-student-documents", "files");
    fs.mkdirSync(dir, { recursive: true });
    const legacy = path.join(dir, "old-document.pdf");
    fs.writeFileSync(legacy, "%PDF original");
    const write = (storedPath) => ctx.db.run("INSERT INTO student_documents (madrasa_id, student_id, document_name, storage_path, original_name, mime_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?,?,?)", [ctx.madrasaA, ctx.studentA1, "document", storedPath, "old.pdf", "application/pdf", 13, ctx.users.adminA]);
    const first = await write(legacy);
    const missing = await write(path.join(dir, "missing.pdf"));
    const result = await require("../server/services/private-media-hydration").hydratePrivateDocuments();
    assert.equal(result.copied, 1);
    assert.equal(result.missing, 1);
    const row = await ctx.db.get("SELECT storage_path FROM student_documents WHERE id = ?", [first.lastInsertRowid]);
    assert.match(row.storage_path, /^dbmedia:\/uploads\/private-files\//);
    const saved = await require("../server/services/media-store").get(row.storage_path.slice("dbmedia:".length));
    assert.equal(saved.data.toString(), "%PDF original");
    const unavailable = await ctx.db.get("SELECT storage_path FROM student_documents WHERE id = ?", [missing.lastInsertRowid]);
    assert.equal(unavailable.storage_path, path.join(dir, "missing.pdf"));
    const again = await require("../server/services/private-media-hydration").hydratePrivateDocuments();
    assert.equal(again.copied, 0);
  } finally { await ctx.close(); }
});

test("deleting one copied document does not remove bytes still referenced elsewhere", async () => {
  const ctx = await setup();
  try {
    const web = "/uploads/private-files/123456789-0123456789abcdef.pdf";
    const ref = "dbmedia:" + web;
    const store = require("../server/services/media-store");
    const helper = require("../server/services/private-media");
    await store.put(web, Buffer.from("data"), "application/pdf", ctx.madrasaA);
    const values = [ctx.madrasaA, ctx.studentA1, "doc", ref, "doc.pdf", "application/pdf", 4, ctx.users.adminA];
    const one = await ctx.db.run("INSERT INTO student_documents (madrasa_id,student_id,document_name,storage_path,original_name,mime_type,file_size,uploaded_by) VALUES (?,?,?,?,?,?,?,?)", values);
    const two = await ctx.db.run("INSERT INTO student_documents (madrasa_id,student_id,document_name,storage_path,original_name,mime_type,file_size,uploaded_by) VALUES (?,?,?,?,?,?,?,?)", values);
    await ctx.db.run("DELETE FROM student_documents WHERE id = ?", [one.lastInsertRowid]);
    await helper.removeIfUnused(ref);
    assert.ok(await store.get(web));
    await ctx.db.run("DELETE FROM student_documents WHERE id = ?", [two.lastInsertRowid]);
    await helper.removeIfUnused(ref);
    assert.equal(await store.get(web), null);
  } finally { await ctx.close(); }
});
