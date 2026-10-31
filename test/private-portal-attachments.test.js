"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

test("student portal downloads database-backed assignment and submission files", async () => {
  const ctx = await setup();
  try {
    const teacher = new Client(ctx.base), student = new Client(ctx.base), other = new Client(ctx.base);
    assert.equal((await teacher.login("teacher-a", PASSWORD)).status, 200);
    assert.equal((await student.login("student-a1", PASSWORD)).status, 200);
    assert.equal((await other.login("parent-b", PASSWORD)).status, 200);
    const made = await teacher.api("POST", "/api/academic/assignments", {
      title: "Private assignment", class_id: ctx.classA1, subject_id: ctx.subjA1,
      session_id: ctx.sessionA, term_id: ctx.termA1, assigned_date: "2026-09-20",
      due_date: "2026-09-25", maximum_score: 20, details: "Work", status: "published",
    });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    async function upload(client, url, content) {
      const form = new FormData();
      form.append("attachment", new Blob([content], { type: "application/pdf" }), "work.pdf");
      const res = await fetch(ctx.base + url, { method: "POST", headers: { Cookie: client.cookieHeader(), "X-CSRF-Token": await client.csrf() }, body: form });
      return { status: res.status, data: await res.json() };
    }
    const uploaded = await upload(teacher, `/api/academic/assignments/${made.data.id}/attachments`, "assignment bytes");
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    const path = `/api/portal/assignments/${made.data.id}/attachments/${uploaded.data.id}`;
    const download = await student.req("GET", path);
    assert.equal(download.status, 200);
    assert.equal(await download.res.text(), "assignment bytes");
    assert.equal((await other.req("GET", path)).status, 404);
    const submitted = await upload(student, `/api/academic/assignments/${made.data.id}/submissions/me`, "submission bytes");
    assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
    const own = await student.req("GET", `/api/portal/assignments/${made.data.id}/submission/attachment`);
    assert.equal(own.status, 200);
    assert.equal(await own.res.text(), "submission bytes");
    assert.equal((await other.req("GET", `/api/portal/assignments/${made.data.id}/submission/attachment`)).status, 404);
  } finally { await ctx.close(); }
});
