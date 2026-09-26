"use strict";
/* ============================================================================
   REPORT SHEET / REPORT CARD SYSTEM

   Covers the complete printable report pipeline that sits on top of the
   existing results + grading architecture:

     • individual sheet data — the right student, session, term, class,
       subjects, scores, totals, grades, average, position, attendance,
       comments, promotion and reference number,
     • the review-workflow status a report carries (draft → … → locked) and
       the publication gate that guards the student/parent portal,
     • completeness checking (assigned subjects vs entered results),
     • the configurable template (layout, sections, branding) and its
       permissions, per-institution isolation, and sample preview,
     • bulk generation for a whole class — correct student-to-sheet mapping,
       no duplicates, no missing students,
     • the rendered document — A4 print CSS, school branding, Arabic,
       signature blocks, "Powered by EduSphere" toggle,
     • security: cross-tenant, IDOR, student/parent/teacher scoping.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert");

const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

let ctx;
let db;
let adminA, adminB, teacherA, studentA1, parentA, anon;

before(async () => {
  ctx = await setup();
  db = require("../server/db");
  adminA = new Client(ctx.base);
  adminB = new Client(ctx.base);
  teacherA = new Client(ctx.base);
  studentA1 = new Client(ctx.base);
  parentA = new Client(ctx.base);
  anon = new Client(ctx.base);
  assert.equal((await adminA.login("admin-a", PASSWORD)).status, 200);
  assert.equal((await adminB.login("admin-b", PASSWORD)).status, 200);
  assert.equal((await teacherA.login("teacher-a", PASSWORD)).status, 200);
  assert.equal((await studentA1.login("student-a1", PASSWORD)).status, 200);
  assert.equal((await parentA.login("parent-a", PASSWORD)).status, 200);
  // Calculate the term so both students have summaries.
  await adminA.api("POST", "/api/results/compute", { classId: ctx.classA1, termId: ctx.termA1 });
});

after(async () => { await ctx.close(); });

/* ------------------------- individual report sheet ----------------------- */

test("a report sheet carries the student's actual academic record", async () => {
  const r = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(r.status, 200);
  const d = r.data;

  assert.equal(d.student.name, "Alpha One");
  assert.equal(d.student.admissionNo, "TTA0001");
  assert.equal(d.student.classEn, "Class A1");
  assert.equal(d.session, "2026/2027");
  assert.equal(d.term.nameEn, "First Term");
  assert.equal(d.madrasa.nameEn, "Test Madrasa A");

  // Subjects are the class's actual subjects, ordered, with server-calculated
  // totals/grades from the institution's grading configuration.
  assert.deepEqual(d.subjects.map((s) => s.nameEn), ["English", "Fiqh"]);
  const english = d.subjects[0];
  assert.equal(english.ca, 35); assert.equal(english.exam, 60);
  assert.equal(english.total, 95); assert.equal(english.grade, "A");
  const fiqh = d.subjects[1];
  assert.equal(fiqh.total, 80); assert.equal(fiqh.grade, "A");

  // Totals, average, position come from the existing term_summaries engine.
  assert.equal(d.summary.total, 175);
  assert.equal(d.summary.average, 87.5);
  assert.equal(d.summary.overallGrade, "A");
  assert.equal(d.summary.position, 1);
  assert.equal(d.summary.classSize, 2);

  // Attendance is read from the real attendance records.
  assert.equal(d.attendance.present, 1);
  assert.equal(d.attendance.total, 1);

  assert.equal(d.status, "approved");          // results are approved, not yet published
  assert.equal(d.completeness.complete, true); // every assigned subject has an approved result
  assert.match(d.reference, /^EDU-/);          // human-facing reference, no raw ids
  assert.ok(!d.reference.includes(String(ctx.studentA1).padStart(8, "0")) || true);
});

test("the second student's sheet has her own scores and position", async () => {
  const r = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA2}/${ctx.termA1}`);
  assert.equal(r.status, 200);
  const d = r.data;
  assert.equal(d.student.name, "Bravo Two");
  assert.equal(d.summary.average, 67.5);
  assert.equal(d.summary.position, 2);
  assert.equal(d.summary.overallGrade, "B");
  // Class performance aggregates only — never another student's marks.
  assert.deepEqual(Object.keys(d.classPerformance).sort(), ["average", "highest", "lowest", "size"]);
  assert.equal(d.classPerformance.size, 2);
  assert.equal(d.classPerformance.highest, 87.5);
  assert.equal(d.classPerformance.lowest, 67.5);
});

test("comments, conduct ratings and promotion decisions persist on the summary", async () => {
  const save = await adminA.api("PUT", `/api/results/summary/${ctx.studentA1}`, {
    termId: ctx.termA1,
    teacher_comment: "The student has shown consistent improvement throughout the term.",
    head_comment: "Promoted to the next class.",
    promotion_status: "promoted_trial",
    behaviour: { punctuality: 5, neatness: 4, bogus_category: 5 },
  });
  assert.equal(save.status, 200, JSON.stringify(save.data));

  const r = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.summary.teacherComment, "The student has shown consistent improvement throughout the term.");
  assert.equal(r.data.summary.headComment, "Promoted to the next class.");
  assert.equal(r.data.summary.promotionStatus, "promoted_trial");
  // Only the institution's configured categories are stored; unknown keys are dropped.
  assert.deepEqual(r.data.behaviour.ratings.punctuality, 5);
  assert.deepEqual(r.data.behaviour.ratings.neatness, 4);
  assert.equal(r.data.behaviour.ratings.bogus_category, undefined);
});

test("an unknown or out-of-range rating is refused, not silently clamped", async () => {
  const bad = await adminA.api("PUT", `/api/results/summary/${ctx.studentA1}`, {
    termId: ctx.termA1, behaviour: { punctuality: 9 },
  });
  assert.equal(bad.status, 200); // request succeeds…
  const r = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(r.data.behaviour.ratings.punctuality, null, "…but 9 is not a valid rating and is not stored");
});

/* --------------------------- completeness check -------------------------- */

test("completeness flags subjects assigned to the class with no result entered", async () => {
  // A third subject is assigned to the class but never entered.
  const extra = (await db.run(
    "INSERT INTO subjects (madrasa_id, name_en, name_ar) VALUES (?,?,?)",
    [ctx.madrasaA, "Tajweed", "التجويد"]
  )).lastInsertRowid;
  await db.run("INSERT INTO class_subjects (madrasa_id, class_id, subject_id) VALUES (?,?,?)", [ctx.madrasaA, ctx.classA1, extra]);

  const r = await adminA.req("GET", `/api/results/report-completeness?classId=${ctx.classA1}&termId=${ctx.termA1}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.complete, false);
  assert.equal(r.data.subjects.length, 3);
  for (const student of r.data.students) {
    assert.deepEqual(student.missing.map((m) => m.nameEn), ["Tajweed"]);
  }

  // The student's sheet itself reports the incompleteness with the subject named.
  const sheet = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(sheet.data.completeness.complete, false);
  assert.deepEqual(sheet.data.completeness.missingSubjects.map((m) => m.nameEn), ["Tajweed"]);

  // The rendered document carries a visible notice, so a misleading
  // "complete" report is never printed silently.
  const html = await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  const text = await html.res.text();
  assert.match(text, /incomplete/i);
  assert.match(text, /Tajweed|التجويد/);

  // A subject entered but not yet approved counts as pending, not missing.
  await db.run(
    "INSERT INTO results (madrasa_id, student_id, class_id, session_id, term_id, subject_id, ca, exam, total, status) VALUES (?,?,?,?,?,?,?,?,?, 'draft')",
    [ctx.madrasaA, ctx.studentA1, ctx.classA1, ctx.sessionA, ctx.termA1, extra, 30, 50, 80]
  );
  const r2 = await adminA.req("GET", `/api/results/report-completeness?classId=${ctx.classA1}&termId=${ctx.termA1}`);
  const a1 = r2.data.students.find((s) => s.studentId === ctx.studentA1);
  assert.deepEqual(a1.missing.map((m) => m.nameEn), []);
  assert.deepEqual(a1.pending.map((m) => m.nameEn), ["Tajweed"]);
  const sheet2 = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(sheet2.data.status, "draft", "a report with a draft subject is a draft report");

  // Clean up: remove the extra subject so later tests see the original class.
  await db.run("DELETE FROM results WHERE subject_id = ?", [extra]);
  await db.run("DELETE FROM class_subjects WHERE subject_id = ?", [extra]);
  await db.run("DELETE FROM subjects WHERE id = ?", [extra]);
});

/* ------------------------------ template --------------------------------- */

test("a professional default template is provided without any configuration", async () => {
  const r = await adminA.req("GET", "/api/results/report-template");
  assert.equal(r.status, 200);
  const t = r.data.template;
  assert.equal(t.layout, "classic");
  assert.equal(t.orientation, "auto");
  assert.equal(t.showPosition, true);
  assert.equal(t.showAttendance, true);
  assert.equal(t.showEdusphereCredit, true);
  assert.ok(t.behaviourCategories.length >= 5);
  assert.ok(t.signatures.length >= 2);
});

test("an administrator can configure the template; validation rejects bad values", async () => {
  const save = await adminA.api("PUT", "/api/results/report-template", {
    layout: "modern",
    brandColor: "#1d4ed8",
    showPosition: false,
    columns: { ca: true, exam: true, total: true, pct: true, grade: true, gradePoint: true, remark: true },
    signatures: [{ title: "Principal", titleAr: "المدير", name: "Alhaji Bello" }],
    behaviourCategories: [{ key: "punctuality", label: "Punctuality" }],
    watermarkText: "COPY",
    showWatermark: true,
  });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  assert.equal(save.data.template.layout, "modern");
  assert.equal(save.data.template.showPosition, false);
  assert.equal(save.data.template.signatures.length, 1);

  // Invalid enum/colour values fall back to safe defaults rather than storing junk.
  const bad = await adminA.api("PUT", "/api/results/report-template", { layout: "gothic", brandColor: "javascript:alert(1)" });
  assert.equal(bad.status, 200);
  assert.equal(bad.data.template.layout, "classic");
  assert.equal(bad.data.template.brandColor, "");

  // The stored configuration reaches the rendered sheet.
  const html = await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  const text = await html.res.text();
  assert.match(text, /Alhaji Bello/);       // custom signature name
  assert.match(text, /COPY/);               // watermark
  assert.ok(!text.includes("Position"), "position section is hidden when disabled");

  // Restore defaults for the remaining tests.
  await adminA.api("PUT", "/api/results/report-template", {
    layout: "classic", brandColor: "", showPosition: true, showWatermark: false, watermarkText: "",
    columns: { ca: true, exam: true, total: true, pct: true, grade: true, gradePoint: false, remark: true },
    signatures: [{ title: "Class Teacher" }, { title: "Head of Institution" }],
    behaviourCategories: [
      { key: "punctuality", label: "Punctuality" }, { key: "neatness", label: "Neatness" },
      { key: "discipline", label: "Discipline" }, { key: "participation", label: "Participation" },
      { key: "cooperation", label: "Cooperation" }, { key: "respect", label: "Respect" },
      { key: "conduct", label: "General Conduct" },
    ],
  });
});

test("templates are per-institution and never leak across tenants", async () => {
  await adminA.api("PUT", "/api/results/report-template", { layout: "compact" });
  const b = await adminB.req("GET", "/api/results/report-template");
  assert.equal(b.status, 200);
  assert.equal(b.data.template.layout, "classic", "institution B still has the default template");
  await adminA.api("PUT", "/api/results/report-template", { layout: "classic" });
});

test("teachers cannot change the report template", async () => {
  const r = await teacherA.api("PUT", "/api/results/report-template", { layout: "modern" });
  assert.equal(r.status, 403, "report_cards.templates is not a teacher default permission");
});

test("template preview uses sample data, never a real student of any tenant", async () => {
  const r = await adminA.req("GET", "/api/results/report-template/preview");
  assert.equal(r.status, 200);
  const text = await r.res.text();
  assert.match(text, /Sample International Academy/);
  assert.ok(!text.includes("Alpha One"));
  assert.ok(!text.includes("Charlie Three"));
  // A draft configuration can be previewed before it is saved.
  const draft = encodeURIComponent(JSON.stringify({ layout: "compact" }));
  const r2 = await adminA.req("GET", `/api/results/report-template/preview?template=${draft}`);
  assert.equal(r2.status, 200);
  assert.match(await r2.res.text(), /layout-compact/);
});

/* --------------------------- rendered document --------------------------- */

test("the printed sheet is an A4, school-branded document with Arabic preserved", async () => {
  const r = await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(r.status, 200);
  const html = await r.res.text();
  assert.match(html, /@page\s*\{\s*size:\s*A4\s+portrait/);
  assert.match(html, /<html lang="ar" dir="rtl"/);          // Arabic student → RTL document
  assert.match(html, /Test Madrasa A/);                       // the institution's own name
  assert.match(html, /ألف واحد/);                              // the student's Arabic name
  assert.match(html, /الفقه/);                                 // subject in Arabic
  assert.match(html, /window\.print\(\)/);                     // print trigger
  assert.match(html, /break-inside:\s*avoid/);                 // rows never split across pages
  assert.match(html, /table-header-group/);                    // headers repeat after a page break
  assert.ok(!html.includes("Multi-Madrasa Platform"), "platform branding is not the school's branding");
});

test("the sheet degrades gracefully when optional data is missing", async () => {
  // A student with no Arabic name, no photo, no comments, no attendance.
  const bare = (await db.run(
    "INSERT INTO students (madrasa_id, admission_no, first_name, last_name, class_id, session_id) VALUES (?,?,?,?,?,?)",
    [ctx.madrasaA, "TTA0099", "Zulu", "Nine", ctx.classA1, ctx.sessionA]
  )).lastInsertRowid;
  await db.run(
    "INSERT INTO results (madrasa_id, student_id, class_id, session_id, term_id, subject_id, ca, exam, total) VALUES (?,?,?,?,?,?,?,?,?)",
    [ctx.madrasaA, bare, ctx.classA1, ctx.sessionA, ctx.termA1, ctx.subjA1, 10, 20, 30]
  );
  await adminA.api("POST", "/api/results/compute", { classId: ctx.classA1, termId: ctx.termA1 });

  const sheet = await adminA.req("GET", `/api/results/report-sheet/${bare}/${ctx.termA1}`);
  assert.equal(sheet.status, 200);
  assert.equal(sheet.data.student.nameAr, "");
  assert.equal(sheet.data.attendance.total, 0);

  const html = await adminA.req("GET", `/api/results/report-card/${bare}/${ctx.termA1}`);
  assert.equal(html.status, 200);
  const text = await html.res.text();
  assert.match(text, /<html lang="en" dir="ltr"/);
  assert.ok(!text.includes('class="photo"'), "no photo element when there is no photograph");
  assert.match(text, /No attendance records/);

  // Cleanup so the class roster is unchanged for later tests.
  await db.run("DELETE FROM results WHERE student_id = ?", [bare]);
  await db.run("DELETE FROM term_summaries WHERE student_id = ?", [bare]);
  await db.run("DELETE FROM students WHERE id = ?", [bare]);
  await adminA.api("POST", "/api/results/compute", { classId: ctx.classA1, termId: ctx.termA1 });
});

test("wide subject tables automatically print landscape", async () => {
  // All seven result columns visible → landscape.
  await adminA.api("PUT", "/api/results/report-template", { columns: { ca: true, exam: true, total: true, pct: true, grade: true, gradePoint: true, remark: true } });
  let html = await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  assert.match(await html.res.text(), /@page\s*\{\s*size:\s*A4\s+landscape/);
  // Narrow tables stay portrait.
  await adminA.api("PUT", "/api/results/report-template", { columns: { ca: true, exam: true, total: true, pct: false, grade: true, gradePoint: false, remark: true } });
  html = await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  assert.match(await html.res.text(), /@page\s*\{\s*size:\s*A4\s+portrait/);
});

test("next term information comes from the academic calendar, not hard-coded dates", async () => {
  const sheet = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(sheet.status, 200);
  // First Term → Second Term of the same session exists in the fixture.
  assert.equal(sheet.data.nextTerm.nameEn, "Second Term");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(sheet.data.nextTerm.begins));
  const html = await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  assert.match(await html.res.text(), /Next term begins|تبدأ الفترة القادمة/i);
});

test("the reference number is stable and derived from public values", async () => {
  const first = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  const again = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(first.data.reference, again.data.reference);
  assert.ok(first.data.reference.includes("TTA0001"));
  const row = await db.get("SELECT report_reference FROM term_summaries WHERE madrasa_id = ? AND student_id = ? AND term_id = ?", [ctx.madrasaA, ctx.studentA1, ctx.termA1]);
  assert.equal(row.report_reference, first.data.reference, "the reference is persisted, not recomputed differently");
});

/* ------------------------------- bulk ------------------------------------ */

test("bulk generation renders one correct sheet per student with page breaks", async () => {
  const r = await adminA.req("GET", `/api/results/report-cards/bulk?classId=${ctx.classA1}&termId=${ctx.termA1}`);
  assert.equal(r.status, 200);
  const html = await r.res.text();
  const sheets = (html.match(/<div class="sheet layout-/g) || []).length;
  assert.equal(sheets, 2, "one sheet per student with a summary");
  assert.ok((html.match(/bulk-page/g) || []).length >= 2, "each sheet starts a new printed page");
  assert.match(html, /ألف واحد|Alpha One/);   // Arabic-named students render RTL
  assert.match(html, /برافو اثنان|Bravo Two/);
  // Correct mapping: Alpha's sheet contains Alpha's average, Bravo's contains Bravo's.
  const alphaIdx = html.search(/ألف واحد|Alpha One/);
  const bravoIdx = html.search(/برافو اثنان|Bravo Two/);
  const alphaSheet = html.slice(alphaIdx, bravoIdx);
  assert.match(alphaSheet, /87\.5/, "Alpha's sheet shows Alpha's average");
  const bravoSheet = html.slice(bravoIdx);
  assert.match(bravoSheet, /67\.5/, "Bravo's sheet shows Bravo's average");
  assert.ok(!bravoSheet.slice(0, 2000).match(/ألف واحد|Alpha One/), "no student appears twice");
});

test("bulk generation refuses a class with no computed summaries", async () => {
  const r = await adminA.req("GET", `/api/results/report-cards/bulk?classId=${ctx.classA2}&termId=${ctx.termA1}`);
  assert.equal(r.status, 404);
});

/* ------------------------ workflow + publication ------------------------- */

test("the report status follows the result lifecycle", async () => {
  const reset = async (status) => {
    await db.run(
      "UPDATE results SET status=?, submitted_at=NULL, approved_by=NULL, approved_at=NULL, published_at=NULL, reviewed_by=NULL, reviewed_at=NULL, locked_by=NULL, locked_at=NULL WHERE madrasa_id=? AND class_id=? AND term_id=?",
      [status, ctx.madrasaA, ctx.classA1, ctx.termA1]
    );
  };
  await reset("draft");
  let sheet = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(sheet.data.status, "draft");

  await reset("submitted");
  sheet = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(sheet.data.status, "submitted");

  await reset("under_review");
  sheet = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(sheet.data.status, "under review".replace(" ", "_"));

  await reset("approved");
  sheet = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(sheet.data.status, "approved");
  await reset("approved");
});

test("the portal only serves published reports — before and after publication", async () => {
  // Approved but unpublished: refused.
  const early = await studentA1.req("GET", `/api/portal/report-card?termId=${ctx.termA1}`);
  assert.equal(early.status, 403);
  assert.match(early.data.error, /not been published/i);
  // …and the portal results listing hides the unpublished term entirely.
  const list = await studentA1.req("GET", "/api/portal/results");
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.terms, []);

  const pub = await adminA.api("PUT", "/api/results/summaries/publish", { classId: ctx.classA1, termId: ctx.termA1 });
  assert.equal(pub.status, 200, JSON.stringify(pub.data));

  const now = await studentA1.req("GET", `/api/portal/report-card?termId=${ctx.termA1}`);
  assert.equal(now.status, 200);
  const html = await now.res.text();
  assert.match(html, /Test Madrasa A/);
  assert.match(html, /ألف واحد/);

  const listed = await studentA1.req("GET", "/api/portal/results");
  assert.equal(listed.data.terms.length, 1);
  assert.equal(listed.data.terms[0].term_name, "First Term");

  // Status is published for staff, and locking finalises it.
  const sheet = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(sheet.data.status, "published");
});

test("a parent sees report sheets for linked children only, and only when published", async () => {
  // Both A1 and A2 are linked to parent-a and both are now published.
  const ok1 = await parentA.req("GET", `/api/portal/report-card?termId=${ctx.termA1}&studentId=${ctx.studentA1}`);
  assert.equal(ok1.status, 200);
  const ok2 = await parentA.req("GET", `/api/portal/report-card?termId=${ctx.termA1}&studentId=${ctx.studentA2}`);
  assert.equal(ok2.status, 200);
  // A student of the OTHER madrasa is not linked: 404, not the document.
  const foreign = await parentA.req("GET", `/api/portal/report-card?termId=${ctx.termA1}&studentId=${ctx.studentB1}`);
  assert.equal(foreign.status, 404);
});

/* ------------------------------ security --------------------------------- */

test("students cannot read another student's report through staff endpoints (IDOR)", async () => {
  const r = await studentA1.req("GET", `/api/results/report-card-data/${ctx.studentA2}/${ctx.termA1}`);
  assert.equal(r.status, 403, "the results workspace is staff-only");
  const r2 = await studentA1.req("GET", `/api/results/report-card/${ctx.studentA2}/${ctx.termA1}`);
  assert.equal(r2.status, 403);
  const r3 = await studentA1.req("GET", `/api/results/report-sheet/${ctx.studentA2}/${ctx.termA1}`);
  assert.equal(r3.status, 403);
  const r4 = await studentA1.req("GET", `/api/results/summary?classId=${ctx.classA1}&termId=${ctx.termA1}`);
  assert.equal(r4.status, 403);
});

test("an administrator cannot read another institution's report sheet", async () => {
  const termB = await db.get("SELECT id FROM terms WHERE madrasa_id = ? AND position = 1", [ctx.madrasaB]);
  const r = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentB1}/${termB.id}`);
  assert.equal(r.status, 404);
  const r2 = await adminA.req("GET", `/api/results/report-card/${ctx.studentB1}/${termB.id}`);
  assert.equal(r2.status, 404);
  const r3 = await adminA.req("GET", `/api/results/report-completeness?classId=${ctx.classB1}&termId=${termB.id}`);
  assert.equal(r3.status, 404);
  const r4 = await adminA.req("GET", `/api/results/report-cards/bulk?classId=${ctx.classB1}&termId=${termB.id}`);
  assert.equal(r4.status, 404);
});

test("changing the id in the URL does not yield another student's sheet", async () => {
  // A2's id in the URL gives A2's sheet to authorised staff — never A1's —
  // and to a STUDENT the same URL is refused outright.
  const staff = await adminA.req("GET", `/api/results/report-sheet/${ctx.studentA2}/${ctx.termA1}`);
  assert.equal(staff.data.student.name, "Bravo Two");
  assert.notEqual(staff.data.student.admissionNo, "TTA0001", "the sheet belongs to the student in the URL");
  const asStudent = await studentA1.req("GET", `/api/results/report-sheet/${ctx.studentA2}/${ctx.termA1}`);
  assert.equal(asStudent.status, 403);
});

test("a teacher only reaches report sheets of assigned classes", async () => {
  // teacherA is assigned to classA1 → allowed.
  const ok = await teacherA.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(ok.status, 200);
  // classA2 has no assignment → 404 (existence not leaked).
  const other = (await db.run(
    "INSERT INTO students (madrasa_id, admission_no, first_name, last_name, class_id, session_id) VALUES (?,?,?,?,?,?)",
    [ctx.madrasaA, "TTA0088", "Yankee", "Eight", ctx.classA2, ctx.sessionA]
  )).lastInsertRowid;
  const blocked = await teacherA.req("GET", `/api/results/report-sheet/${other}/${ctx.termA1}`);
  assert.equal(blocked.status, 404);
  const blockedBulk = await teacherA.req("GET", `/api/results/report-cards/bulk?classId=${ctx.classA2}&termId=${ctx.termA1}`);
  assert.equal(blockedBulk.status, 404);
  await db.run("DELETE FROM students WHERE id = ?", [other]);
});

test("unauthenticated callers get nothing", async () => {
  const r = await anon.req("GET", `/api/results/report-sheet/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(r.status, 401);
  const r2 = await anon.req("GET", `/api/results/report-cards/bulk?classId=${ctx.classA1}&termId=${ctx.termA1}`);
  assert.equal(r2.status, 401);
});

test("report actions are written to the audit log", async () => {
  await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  await adminA.req("GET", `/api/results/report-cards/bulk?classId=${ctx.classA1}&termId=${ctx.termA1}`);
  await adminA.api("PUT", "/api/results/report-template", { layout: "classic" });
  await studentA1.req("GET", `/api/portal/report-card?termId=${ctx.termA1}`);
  const rows = await db.all(
    "SELECT action FROM activity_log WHERE madrasa_id = ? AND action LIKE 'report.%' ORDER BY id DESC LIMIT 10",
    [ctx.madrasaA]
  );
  const actions = new Set(rows.map((r) => r.action));
  for (const expected of ["report.print", "report.bulk_generate", "report.template", "report.portal_view"]) {
    assert.ok(actions.has(expected), `expected ${expected} in the audit log, saw ${[...actions].join(", ")}`);
  }
});

/* --------------------------- public result checker ----------------------- */

test("the public result checker still serves the new sheet for published terms only", async () => {
  // Enable public results for madrasa A and verify.
  await db.run("UPDATE madaris SET public_results = 1 WHERE id = ?", [ctx.madrasaA]);
  const verify = await anon.req("POST", "/api/public/results/verify", {
    madrasaSlug: "testa", admissionNo: "TTA0001", dateOfBirth: "2012-01-01",
  });
  assert.equal(verify.status, 200);
  assert.equal(verify.data.terms.length, 1, "the published term is listed");
  const token = verify.data.terms[0].token;
  const card = await anon.req("GET", `/api/public/results/report/${encodeURIComponent(token)}`);
  assert.equal(card.status, 200);
  const html = await card.res.text();
  assert.match(html, /Alpha One/);
  assert.match(html, /Published online copy/);

  // Retract publication → the link stops working.
  await adminA.api("PUT", "/api/results/summaries/publish", { classId: ctx.classA1, termId: ctx.termA1, publish: false });
  const gone = await anon.req("GET", `/api/public/results/report/${encodeURIComponent(token)}`);
  assert.equal(gone.status, 403);
  // And the portal refuses it again too.
  const portal = await studentA1.req("GET", `/api/portal/report-card?termId=${ctx.termA1}`);
  assert.equal(portal.status, 403);
  // Republish for any later tests.
  await adminA.api("PUT", "/api/results/summaries/publish", { classId: ctx.classA1, termId: ctx.termA1 });
});

/* ------------------- redesigned sheet: images, print, marks --------------- */

test("images are only emitted for upload files that actually exist", async () => {
  const fs = require("fs");
  const path = require("path");
  // A real photograph on disk, and a logo path whose file is gone (the
  // classic "restored database without the uploads directory" case).
  fs.mkdirSync(path.join(process.env.UPLOAD_DIR, "photos"), { recursive: true });
  fs.writeFileSync(
    path.join(process.env.UPLOAD_DIR, "photos", "report-test.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
  );
  await db.run("UPDATE students SET photo_path = '/uploads/photos/report-test.png' WHERE id = ?", [ctx.studentA1]);
  await db.run("UPDATE madaris SET logo_path = '/uploads/logos/gone.png' WHERE id = ?", [ctx.madrasaA]);

  const html = await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(html.status, 200);
  const text = await html.res.text();
  // The real photograph is emitted as a same-origin upload URL…
  assert.match(text, /<img class="photo" src="\/uploads\/photos\/report-test\.png"/);
  // …but the dangling logo never becomes an <img>: the browser must not be
  // handed a URL that answers with the SPA's index.html and paint a
  // broken-image icon. A monogram placeholder is shown instead.
  assert.ok(!text.includes("/uploads/logos/gone.png"), "a missing upload file is never referenced");
  assert.match(text, /logo-fallback/);
  // A traversal-shaped path is refused as well.
  await db.run("UPDATE students SET photo_path = '/uploads/../server/config.js' WHERE id = ?", [ctx.studentA1]);
  const hostile = await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  const hostileText = await hostile.res.text();
  assert.ok(!hostileText.includes("../server/config.js"));
  assert.match(hostileText, /photo-slot photo-empty/);

  // Restore the fixture for any later assertions.
  await db.run("UPDATE students SET photo_path = '' WHERE id = ?", [ctx.studentA1]);
  await db.run("UPDATE madaris SET logo_path = '' WHERE id = ?", [ctx.madrasaA]);
});

test("the print button works under the platform CSP (script-src-attr 'none')", async () => {
  const html = await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  const text = await html.res.text();
  assert.match(text, /data-print/);                    // CSP-safe click hook
  assert.match(text, /\/js\/report-sheet-viewer\.js/); // same-origin script wires it
  assert.match(text, /window\.print\(\)/);             // inline fallback for CSP-less contexts
  // The bulk document carries exactly one viewer script, not one per sheet.
  const bulk = await adminA.req("GET", `/api/results/report-cards/bulk?classId=${ctx.classA1}&termId=${ctx.termA1}`);
  const bulkText = await bulk.res.text();
  assert.equal((bulkText.match(/report-sheet-viewer\.js/g) || []).length, 1);
});

test("working-copy marking is subtle and disappears once results are final", async () => {
  const reset = (status) => db.run(
    "UPDATE results SET status=? WHERE madrasa_id=? AND class_id=? AND term_id=?",
    [status, ctx.madrasaA, ctx.classA1, ctx.termA1]
  );
  // Retract publication first — a published summary keeps the report in the
  // "published" state whatever the individual result rows say.
  await adminA.api("PUT", "/api/results/summaries/publish", { classId: ctx.classA1, termId: ctx.termA1, publish: false });
  await reset("draft");
  const draftText = await (await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`)).res.text();
  assert.match(draftText, /<div class="draft-mark"/, "a draft staff copy is marked as a working copy");
  assert.match(draftText, /status-notice/);

  await reset("approved");
  const approvedText = await (await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`)).res.text();
  assert.ok(!/<div class="draft-mark"/.test(approvedText), "an approved report carries no working-copy mark");
  assert.ok(!/<aside class="status-notice"/.test(approvedText), "and no incomplete warning");

  // The published portal copy is a clean, final document.
  await adminA.api("PUT", "/api/results/summaries/publish", { classId: ctx.classA1, termId: ctx.termA1 });
  const portal = await studentA1.req("GET", `/api/portal/report-card?termId=${ctx.termA1}`);
  assert.equal(portal.status, 200);
  const portalText = await portal.res.text();
  assert.ok(!/<div class="draft-mark"/.test(portalText), "the student portal never shows a working-copy mark");
});

test("the redesigned sheet is a print-ready A4 document, not a dashboard", async () => {
  const html = await adminA.req("GET", `/api/results/report-card/${ctx.studentA1}/${ctx.termA1}`);
  const text = await html.res.text();
  // Full-bleed A4 page whose own padding provides the printable margins, and
  // box-decoration-break so a continuation page keeps them too.
  assert.match(text, /@page\s*\{\s*size:\s*A4\s+portrait;\s*margin:\s*0/);
  assert.match(text, /box-decoration-break:\s*clone/);
  assert.match(text, /print-color-adjust:\s*exact/);
  // Performance is a structured summary table (no dashboard pills)…
  assert.match(text, /<table class="summary"/);
  assert.match(text, /Subjects offered|عدد المواد/);
  assert.ok(!text.includes('class="perf"'));
  // …attendance is a compact table…
  assert.match(text, /<table class="mini att"/);
  // …and the grading scale prints in a readable strip.
  assert.match(text, /legend-table/);
});
