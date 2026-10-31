"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { initEnv, setup, Client } = require("./helpers");
initEnv();
let ctx; let admin; let teacher;
before(async () => {
  ctx = await setup();
  admin = new Client(ctx.base); await admin.login("admin-a", "Passw0rd!123");
  teacher = new Client(ctx.base); await teacher.login("teacher-a", "Passw0rd!123");
});
after(async () => ctx.close());

async function importCsv(client, fields, csv, filename = "results.csv") {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, String(value)));
  form.append("file", new Blob([csv], { type: "text/csv" }), filename);
  const response = await fetch(ctx.base + "/api/results/import", {
    method: "POST",
    headers: { Cookie: client.cookieHeader(), "X-CSRF-Token": await client.csrf() },
    body: form,
  });
  return { status: response.status, data: await response.json() };
}

function importScratchFiles() {
  const directory = path.join(process.env.UPLOAD_DIR, "result-imports");
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

test("complete lessons persist, are filterable and keep status history", async () => {
  const made = await teacher.api("POST", "/api/academic/lessons", {
    title: "Rules of noon sakinah", class_id: ctx.classA1, subject_id: ctx.subjA1,
    session_id: ctx.sessionA, term_id: ctx.termA1, lesson_date: "2026-09-20", period: "Period 2",
    topic: "Tajweed", objectives: "Identify the four rules", content: "Guided examples", learning_materials: "Mushaf",
    homework_text: "Find five examples", education_track: "islamic", status: "draft",
  });
  assert.equal(made.status, 200);
  const changed = await teacher.api("PATCH", `/api/academic/lessons/${made.data.id}`, { status: "published", content: "Guided examples and recitation" });
  assert.equal(changed.status, 200);
  const list = await teacher.api("GET", "/api/academic/lessons?status=published&q=noon");
  assert.equal(list.status, 200);
  assert.equal(list.data.lessons.length, 1);
  const detail = await teacher.api("GET", `/api/academic/lessons/${made.data.id}`);
  assert.equal(detail.data.lesson.period, "Period 2");
  assert.ok(detail.data.history.length >= 2);
});

test("assignments expose every student's submission state and validate grading", async () => {
  const made = await teacher.api("POST", "/api/academic/assignments", {
    title: "Fiqh worksheet", class_id: ctx.classA1, subject_id: ctx.subjA1,
    session_id: ctx.sessionA, term_id: ctx.termA1, assigned_date: "2026-09-20", due_date: "2026-09-25",
    maximum_score: 20, details: "Answer every question", status: "published",
  });
  assert.equal(made.status, 200);
  const submissions = await teacher.api("GET", `/api/academic/assignments/${made.data.id}/submissions`);
  assert.equal(submissions.status, 200);
  assert.equal(submissions.data.submissions.length, 2);
  assert.ok(submissions.data.submissions.every((row) => row.submission_status === "not_submitted"));
  const bad = await teacher.api("PUT", `/api/academic/assignments/${made.data.id}/submissions/${ctx.studentA1}`, { score: 21 });
  assert.equal(bad.status, 400);
  const graded = await teacher.api("PUT", `/api/academic/assignments/${made.data.id}/submissions/${ctx.studentA1}`, { score: 18, feedback: "Strong work" });
  assert.equal(graded.status, 200);
});

test("examination scheduling rejects class, invigilator and classroom overlaps", async () => {
  const first = await admin.api("POST", "/api/academic/exams", {
    title: "First Term Examination", class_id: ctx.classA1, subject_id: ctx.subjA1,
    session_id: ctx.sessionA, term_id: ctx.termA1, exam_date: "2026-10-10", start_time: "09:00", end_time: "10:00",
    teacher_id: ctx.users.teacherA, classroom: "Hall A", total_marks: 60, status: "scheduled",
  });
  assert.equal(first.status, 200);
  const conflict = await admin.api("POST", "/api/academic/exams", {
    title: "Overlapping Examination", class_id: ctx.classA1, subject_id: ctx.subjA2,
    session_id: ctx.sessionA, term_id: ctx.termA1, exam_date: "2026-10-10", start_time: "09:30", end_time: "10:30",
    classroom: "Hall B", total_marks: 60, status: "scheduled",
  });
  assert.equal(conflict.status, 409);
  const marks = await teacher.api("PUT", `/api/academic/exams/${first.data.id}/marks`, { entries: [{ studentId: ctx.studentA1, score: 55 }] });
  assert.equal(marks.status, 200);
});

test("result moderation rejects scores over configured maxima and publishes approved cards", async () => {
  const invalid = await teacher.api("PUT", "/api/results", { classId: ctx.classA1, termId: ctx.termA1, subjectId: ctx.subjA1, status: "submitted", entries: [{ studentId: ctx.studentA1, ca: 41, exam: 50 }] });
  assert.equal(invalid.status, 400);
  const saved = await teacher.api("PUT", "/api/results", { classId: ctx.classA1, termId: ctx.termA1, subjectId: ctx.subjA1, status: "submitted", entries: [{ studentId: ctx.studentA1, ca: 35, exam: 55 }, { studentId: ctx.studentA2, ca: 30, exam: 50 }] });
  assert.equal(saved.status, 200);
  const teacherApprove = await teacher.api("POST", "/api/results/workflow", { classId: ctx.classA1, termId: ctx.termA1, subjectId: ctx.subjA1, action: "approve" });
  assert.equal(teacherApprove.status, 403);
  const approve = await admin.api("POST", "/api/results/workflow", { classId: ctx.classA1, termId: ctx.termA1, subjectId: ctx.subjA1, action: "approve" });
  assert.equal(approve.status, 200);
  const publish = await admin.api("PUT", "/api/results/summaries/publish", { classId: ctx.classA1, termId: ctx.termA1, publish: true });
  assert.equal(publish.status, 200);
  const card = await admin.req("GET", `/api/results/report-card-data/${ctx.studentA1}/${ctx.termA1}`);
  assert.equal(card.status, 200);
  assert.ok(card.data.subjects.every((subject) => ["approved", "published"].includes(subject.status)));
  assert.ok(card.data.subjects.every((subject) => typeof subject.gradePoint === "number"));
});

test("academic sessions and terms have enforced current states and history", async () => {
  const created = await admin.api("POST", "/api/sessions", { label: "2027/2028", start_date: "2027-09-01", end_date: "2028-07-20", status: "upcoming", create_default_terms: false });
  assert.equal(created.status, 200);
  const term = await admin.api("POST", `/api/sessions/${created.data.id}/terms`, { position: 1, name_en: "Autumn Term", start_date: "2027-09-01", end_date: "2027-12-15", result_submission_deadline: "2027-12-20", status: "active" });
  assert.equal(term.status, 200);
  const sessions = await admin.api("GET", "/api/sessions");
  const saved = sessions.data.sessions.find((row) => row.id === created.data.id);
  assert.equal(saved.terms[0].result_submission_deadline, "2027-12-20");
  assert.equal(Number(saved.terms[0].is_current), 1);
  const history = await admin.api("GET", `/api/terms/${term.data.id}/history`);
  assert.equal(history.status, 200);
  assert.ok(history.data.history.length);
});

test("admission requirements, settings, pipeline and conversion share existing student records", async () => {
  const requirement = await admin.api("POST", "/api/admissions/requirements", { name: "Birth Certificate", description: "Certified copy", is_required: true, document_type: "Birth Certificate", class_id: ctx.classA1, session_id: ctx.sessionA, education_track: "both" });
  assert.equal(requirement.status, 200);
  const settings = await admin.api("PUT", "/api/admissions/settings", { admission_open: true, application_start_date: "2026-01-01", application_closing_date: "2026-12-31", available_session_ids: [ctx.sessionA], available_class_ids: [ctx.classA1], available_programs: ["Tahfiz"], application_number_format: "APP-{YYYY}-{SEQ:5}", admission_number_format: "STU-{YYYY}-{SEQ:4}", email_notifications: true });
  assert.equal(settings.status, 200);
  const applicant = await new Client(ctx.base).req("POST", "/api/public/madaris/testa/apply", { first_name: "New", last_name: "Learner", parent_name: "Guardian", parent_phone: "+2348001234567", class_id: ctx.classA1, desired_session_id: ctx.sessionA, program: "Tahfiz", education_track: "both" });
  assert.equal(applicant.status, 200);
  assert.match(applicant.data.reference, /^APP-\d{4}-\d{5}$/);
  const list = await admin.api("GET", `/api/admissions?q=${applicant.data.reference}`);
  const application = list.data.requests[0];
  await admin.api("POST", `/api/admissions/${application.id}/accept`, { note: "Eligible" });
  const converted = await admin.api("POST", `/api/admissions/${application.id}/convert`, {});
  assert.equal(converted.status, 200);
  assert.equal(converted.data.status, "enrolled");
  assert.match(converted.data.admissionNo, /^STU-\d{4}-\d{4}$/);
  const student = await ctx.db.get("SELECT * FROM students WHERE id=?", [converted.data.studentId]);
  assert.equal(student.first_name, "New");
  assert.equal(student.class_id, ctx.classA1);
  const pipeline = await admin.api("GET", "/api/admissions/pipeline");
  assert.ok(pipeline.data.counts.enrolled >= 1);
});


test("CSV result import validates rows, enforces teacher scope, and removes scratch files", async () => {
  const valid = "admission_no,ca,exam,teacher_remark\nTTA0001,32,52,Good progress\nTTA0002,31,50,Improving\n";
  const imported = await importCsv(admin, { classId: ctx.classA1, termId: ctx.termA1, subjectId: ctx.subjA2, status: "draft" }, valid);
  assert.equal(imported.status, 200);
  assert.equal(imported.data.imported, 2);
  assert.equal(importScratchFiles().length, 0, "successful imports remove the uploaded scratch file");
  const saved = await ctx.db.all("SELECT status,modified_by FROM results WHERE madrasa_id=? AND class_id=? AND term_id=? AND subject_id=? ORDER BY student_id", [ctx.madrasaA, ctx.classA1, ctx.termA1, ctx.subjA2]);
  assert.equal(saved.length, 2);
  assert.ok(saved.every((row) => row.status === "draft" && Number(row.modified_by) > 0));
  const summary = await ctx.db.get("SELECT published_at FROM term_summaries WHERE madrasa_id=? AND class_id=? AND term_id=? LIMIT 1", [ctx.madrasaA, ctx.classA1, ctx.termA1]);
  assert.equal(summary && summary.published_at, null, "editing results withdraws stale published summaries");

  const malformed = await importCsv(admin, { classId: ctx.classA1, termId: ctx.termA1, subjectId: ctx.subjA2 }, "admission_no,ca,exam\nTTA0001,not-a-score,50\n");
  assert.equal(malformed.status, 400);
  assert.match(malformed.data.errors[0], /CA must be between/i);
  assert.equal(importScratchFiles().length, 0, "rejected imports remove the uploaded scratch file");

  const unauthorized = await importCsv(teacher, { classId: ctx.classA1, termId: ctx.termA1, subjectId: ctx.subjA2 }, valid);
  assert.ok([403, 404].includes(unauthorized.status), "unauthorized subject is denied without leaking it");
  assert.equal(importScratchFiles().length, 0, "authorization failures remove the uploaded scratch file");
});

test("Western-track records use the same academic, admissions, and student architecture", async () => {
  const lesson = await admin.api("POST", "/api/academic/lessons", {
    title: "Narrative writing", class_id: ctx.classA1, subject_id: ctx.subjA2,
    session_id: ctx.sessionA, term_id: ctx.termA1, lesson_date: "2026-10-20",
    topic: "English composition", education_track: "western", status: "published",
  });
  assert.equal(lesson.status, 200);
  const lessonRow = await ctx.db.get("SELECT education_track FROM homework WHERE id=? AND madrasa_id=?", [lesson.data.id, ctx.madrasaA]);
  assert.equal(lessonRow.education_track, "western");

  await admin.api("PUT", "/api/admissions/settings", {
    admission_open: true, application_start_date: "2026-01-01", application_closing_date: "2026-12-31",
    available_session_ids: [ctx.sessionA], available_class_ids: [ctx.classA1], available_programs: ["Western Basic"],
  });
  const applicant = await new Client(ctx.base).req("POST", "/api/public/madaris/testa/apply", {
    first_name: "Western", last_name: "Learner", parent_name: "Western Guardian", parent_phone: "+2348007777777",
    class_id: ctx.classA1, desired_session_id: ctx.sessionA, program: "Western Basic", education_track: "western",
  });
  assert.equal(applicant.status, 200);
  const list = await admin.api("GET", `/api/admissions?q=${encodeURIComponent(applicant.data.reference)}&track=western`);
  assert.equal(list.data.requests.length, 1);
  const application = list.data.requests[0];
  const accepted = await admin.api("POST", `/api/admissions/${application.id}/accept`, { note: "Western intake", force: true });
  assert.equal(accepted.status, 200);
  const converted = await admin.api("POST", `/api/admissions/${application.id}/convert`, {});
  assert.equal(converted.status, 200);
  const student = await ctx.db.get("SELECT madrasa_id,education_track,source_request_id FROM students WHERE id=?", [converted.data.studentId]);
  assert.equal(student.madrasa_id, ctx.madrasaA);
  assert.equal(student.education_track, "western");
  assert.equal(student.source_request_id, application.id);
});

test("private student documents survive an app restart and remain tenant-scoped", async () => {
  const bytes = Buffer.from("private school document");
  const form = new FormData();
  form.append("document", new Blob([bytes], { type: "application/pdf" }), "record.pdf");
  const response = await fetch(ctx.base + `/api/students/${ctx.studentA1}/documents`, {
    method: "POST", headers: { Cookie: admin.cookieHeader(), "X-CSRF-Token": await admin.csrf() }, body: form,
  });
  assert.equal(response.status, 200, await response.text());
  const doc = await ctx.db.get("SELECT * FROM student_documents WHERE student_id=? ORDER BY id DESC", [ctx.studentA1]);
  assert.match(doc.storage_path, /^dbmedia:\/uploads\/private-files\//);
  const webPath = doc.storage_path.slice("dbmedia:".length);
  assert.equal((await fetch(ctx.base + webPath)).status, 404);

  await new Promise(resolve => ctx.server.close(resolve));
  await ctx.db.close();
  const app = require("../server/app").createApp();
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const schoolA = new Client(base); await schoolA.login("admin-a", "Passw0rd!123");
    const schoolB = new Client(base); await schoolB.login("admin-b", "Passw0rd!123");
    const download = await schoolA.req("GET", `/api/students/${ctx.studentA1}/documents/${doc.id}`);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.res.arrayBuffer()), bytes);
    const denied = await schoolB.req("GET", `/api/students/${ctx.studentA1}/documents/${doc.id}`);
    assert.equal(denied.status, 404);
    assert.equal((await fetch(base + webPath)).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
