"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");

initEnv();
let ctx;
let admin;
let templateId;

test.before(async () => {
  ctx = await setup();
  admin = new Client(ctx.base);
  const login = await admin.login("admin-a", PASSWORD);
  assert.equal(login.status, 200);
});

test.after(async () => { await ctx.close(); });

test("ID card HTML is tenant-scoped and print-optimised", async () => {
  const own = await admin.req("GET", `/api/documents/id-card/${ctx.studentA1}?qr=1`);
  assert.equal(own.status, 200);
  const html = await own.res.text();
  assert.match(html, /@page\{size:85\.6mm 54mm/);
  assert.match(html, /Alpha One/);
  // The card is a durable document, so its QR must not point at a short-lived
  // signed link: it prints a permanent code under /verify/ and the code itself
  // as text, so a card that passes its expiry date still says what it says.
  assert.match(html, /\/verify\/[0-9a-f]{24}/);
  assert.match(html, /class="id-code"/);
  assert.doesNotMatch(html, /student-profile\//);
  // Front and back are both printed, each as its own card-sized page.
  assert.equal((html.match(/class="id-card id-front/g) || []).length, 1);
  assert.equal((html.match(/class="id-card id-back/g) || []).length, 1);
  assert.match(html, /This card remains the property of/);
  // Colours must survive printing (browsers drop backgrounds otherwise).
  assert.match(html, /print-color-adjust:exact/);
  // Institution theme variables are emitted from the category and brand colour.
  assert.match(html, /--brand:#14532d/);
  assert.equal(own.res.headers.get("cache-control"), "no-store");

  const otherTenant = await admin.req("GET", `/api/documents/id-card/${ctx.studentB1}`);
  assert.equal(otherTenant.status, 404);
});

test("bulk ID cards render four-card sheet layout", async () => {
  const response = await admin.req("GET", `/api/documents/id-card/bulk?classId=${ctx.classA1}`);
  assert.equal(response.status, 200);
  const html = await response.res.text();
  assert.match(html, /@page\{size:A4 portrait/);
  assert.equal((html.match(/class="id-card /g) || []).length, 2);
  // Eight cards per A4 sheet (two columns by four rows) with crop marks.
  assert.match(html, /grid-template-columns:repeat\(2,85\.6mm\)/);
  assert.match(html, /grid-template-rows:repeat\(4,54mm\)/);
  assert.equal((html.match(/class="id-sheet"/g) || []).length, 1);

  const backs = await admin.req("GET", `/api/documents/id-card/bulk?classId=${ctx.classA1}&side=back`);
  assert.equal(backs.status, 200);
  const backHtml = await backs.res.text();
  assert.equal((backHtml.match(/class="id-card id-back/g) || []).length, 2);
  assert.doesNotMatch(backHtml, /class="id-card id-front/);
});

test("profile QR codes stay scannable up to the encoder limit", async () => {
  const { qrSvg } = require("../server/routes/documents")._private;
  // Version 9 at error level L holds 230 bytes: a 61-module symbol plus quiet zone.
  assert.match(qrSvg("A".repeat(230)), /viewBox="-4 -4 61 61"/);
  assert.equal(qrSvg("A".repeat(231)), "");
});

test("certificate templates and issued certificates validate, render, and stay tenant-scoped", async () => {
  const bad = await admin.api("POST", "/api/documents/templates", { name: "Bad", type: "not-a-type", html_template: "<p>x</p>" });
  assert.equal(bad.status, 400);

  const created = await admin.api("POST", "/api/documents/templates", {
    name: "Achievement", type: "achievement", html_template: "<h1>{{student_name}}</h1><p>{{class}} · {{session}} · {{date}}</p><strong>{{custom_field_1}}</strong>",
  });
  assert.equal(created.status, 200);
  templateId = created.data.id;

  const issued = await admin.api("POST", "/api/documents/certificates", {
    student_id: ctx.studentA1, template_id: templateId, issued_date: "2026-09-17", custom_fields: { custom_field_1: "Excellent character" },
  });
  assert.equal(issued.status, 200);

  const list = await admin.req("GET", `/api/documents/certificates?studentId=${ctx.studentA1}`);
  assert.equal(list.status, 200);
  assert.equal(list.data.certificates.length, 1);

  const printable = await admin.req("GET", `/api/documents/certificates/${issued.data.id}`);
  assert.equal(printable.status, 200);
  const html = await printable.res.text();
  assert.match(html, /@page\{size:A4 landscape/);
  assert.match(html, /Alpha One/);
  assert.match(html, /Excellent character/);
  assert.doesNotMatch(html, /\{\{student_name\}\}/);
  // Designed frame: reference number, both signature blocks, an official seal.
  assert.match(html, /Certificate No\. CERT-\d{4}-\d{6}/);
  assert.match(html, /Principal/);
  assert.match(html, /Class Teacher/);
  // An issued certificate is a snapshot: it prints its own verify code so the
  // paper can be checked years later, without the template still existing.
  assert.match(html, /\/verify\/certificate\/[0-9a-f]{24}/);
  assert.match(html, /cert-seal/);
  assert.match(html, /\/js\/print\.js/);

  const archived = await admin.api("PATCH", `/api/documents/templates/${templateId}`, { archived: true });
  assert.equal(archived.status, 200);
  const noIssue = await admin.api("POST", "/api/documents/certificates", { student_id: ctx.studentA2, template_id: templateId });
  assert.equal(noIssue.status, 400);
});

test("teachers can print assigned-class cards but cannot manage templates", async () => {
  const teacher = new Client(ctx.base);
  assert.equal((await teacher.login("teacher-a", PASSWORD)).status, 200);
  assert.equal((await teacher.req("GET", `/api/documents/id-card/${ctx.studentA1}`)).status, 200);
  assert.equal((await teacher.req("GET", "/api/documents/templates")).status, 403);
});

test("certificate template preview is sanitised, sample-filled and never scripted", async () => {
  const hostile = "<p>{{student_name}}</p><script>alert(1)</script><img src=x onerror=alert(2)>";
  const preview = await admin.api("POST", "/api/documents/templates/preview", { html_template: hostile });
  assert.equal(preview.status, 200);
  const html = await preview.res.text();
  assert.match(html, /Amina Yusuf/);
  assert.match(html, /class="cert-page/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onerror/i);
  // Preview is shown inside a sandboxed frame, so it has no print bar or print script.
  assert.doesNotMatch(html, /class="print-bar"/);
  assert.doesNotMatch(html, /printPageBtn/);
  assert.doesNotMatch(html, /\/js\/print\.js/);

  const tooLarge = await admin.api("POST", "/api/documents/templates/preview", { html_template: "x".repeat(200001) });
  assert.equal(tooLarge.status, 400);

  const teacher = new Client(ctx.base);
  assert.equal((await teacher.login("teacher-a", PASSWORD)).status, 200);
  const denied = await teacher.api("POST", "/api/documents/templates/preview", { html_template: "<p>x</p>" });
  assert.equal(denied.status, 403);
});
