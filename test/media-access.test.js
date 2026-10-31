"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

test("a published reference cannot disclose another school's private media", async () => {
  const ctx = await setup();
  try {
    const a = new Client(ctx.base), b = new Client(ctx.base);
    await a.login("admin-a", PASSWORD); await b.login("admin-b", PASSWORD);
    const image = "/uploads/announcement-images/123456789-0123456789abcdef.png";
    await require("../server/services/media-store").put(image, Buffer.from("123456789"), "image/png", ctx.madrasaA);
    await ctx.db.run("UPDATE madaris SET status='active', public_listing=1, website_published=1 WHERE id IN (?,?)", [ctx.madrasaA, ctx.madrasaB]);
    const other = await ctx.db.run("INSERT INTO announcements (madrasa_id,title,body,audience,is_active,publish_public) VALUES (?,?,?,?,?,?)", [ctx.madrasaB, "B", "B", "all", 1, 1]);
    await ctx.db.run("UPDATE announcements SET image_path = ? WHERE id = ?", [image, other.lastInsertRowid]);
    assert.equal((await fetch(ctx.base + image)).status, 404);
    assert.equal((await b.req("GET", image)).status, 404);
    assert.equal((await a.req("GET", image)).status, 200);
    await ctx.db.run("DELETE FROM announcements WHERE id = ?", [other.lastInsertRowid]);
    const own = await ctx.db.run("INSERT INTO announcements (madrasa_id,title,body,audience,is_active,publish_public) VALUES (?,?,?,?,?,?)", [ctx.madrasaA, "A", "A", "all", 1, 1]);
    await ctx.db.run("UPDATE announcements SET image_path = ? WHERE id = ?", [image, own.lastInsertRowid]);
    assert.equal((await fetch(ctx.base + image)).status, 200, "the actual owner can deliberately publish it");
  } finally { await ctx.close(); }
});
