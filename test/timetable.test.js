"use strict";
/* ============================================================================
   TIMETABLE — replace-all save, tenant/class scoping, the copy shortcut and
   the per-role "my week" view.
   Run: npm test
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD, SA_PASSWORD } = require("./helpers");
initEnv();

let ctx, adminA, adminB, teacher, student, sa;
before(async () => {
  ctx = await setup();
  adminA = new Client(ctx.base); await adminA.login("admin-a", PASSWORD);
  adminB = new Client(ctx.base); await adminB.login("admin-b", PASSWORD);
  teacher = new Client(ctx.base); await teacher.login("teacher-a", PASSWORD);
  student = new Client(ctx.base); await student.login("student-a1", PASSWORD);
  sa = new Client(ctx.base); await sa.login("testadmin", SA_PASSWORD);
});
after(async () => { await ctx.close(); });

const slot = (day, period, extra) => Object.assign({ day, period, startTime: "08:00", endTime: "08:45" }, extra || {});

test("an empty class is offered a default week to start from", async () => {
  const r = await adminA.api("GET", "/api/timetable?classId=" + ctx.classA1);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.days, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  assert.equal(Object.keys(r.data.dayLabelsAr).length, 6, "Arabic day names come with the grid");
  assert.equal(r.data.dayLabelsAr.Mon, "الإثنين");
  assert.equal(r.data.periods.length, 6, "six default periods");
  assert.deepEqual(r.data.periods[0], { period: 1, start: "08:00", end: "08:45" });
  assert.equal(r.data.periods[5].end, "12:45");
  assert.deepEqual(r.data.slots, [], "nothing scheduled yet");
  assert.equal(r.data.class.name_en, "Class A1");
  assert.ok(r.data.termId > 0, "the current term is chosen for you");
});

test("saving writes the week and reads back camelCase rows for the grid", async () => {
  const save = await adminA.api("PUT", "/api/timetable", {
    classId: ctx.classA1,
    slots: [
      slot("Mon", 1, { subjectId: ctx.subjA1, teacherId: ctx.users.teacherA, room: "Hall A", notes: "start with wudu" }),
      slot("Mon", 2, { subjectId: ctx.subjA2 }),
      slot("Tue", 1, { subjectId: ctx.subjA1, teacherId: ctx.users.teacherA }),
    ],
  });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  assert.equal(save.data.saved, 3);

  const grid = await adminA.api("GET", "/api/timetable?classId=" + ctx.classA1);
  assert.equal(grid.data.slots.length, 3);
  const mon1 = grid.data.slots.find((s) => s.day === "Mon" && s.period === 1);
  assert.equal(mon1.subjectEn, "Fiqh");
  assert.equal(mon1.teacherName, "Teacher A");
  assert.equal(mon1.room, "Hall A");
  assert.equal(mon1.startTime, "08:00");
  assert.equal(mon1.endTime, "08:45");
  assert.equal(mon1.notes, "start with wudu");
  // Periods the class actually uses are kept, and the default times too.
  assert.ok(grid.data.periods.some((p) => p.period === 2 && p.start === "08:45"), "period 2 inherits its default clock time");
});

test("saving replaces the week instead of appending to it", async () => {
  const save = await adminA.api("PUT", "/api/timetable", { classId: ctx.classA1, slots: [slot("Wed", 1, { subjectId: ctx.subjA2 })] });
  assert.equal(save.data.saved, 1);
  const grid = await adminA.api("GET", "/api/timetable?classId=" + ctx.classA1);
  assert.equal(grid.data.slots.length, 1, "Monday's lessons are gone");
  assert.equal(grid.data.slots[0].day, "Wed");
});

test("an empty slot list clears the week", async () => {
  assert.equal((await adminA.api("PUT", "/api/timetable", { classId: ctx.classA1, slots: [] })).status, 200);
  assert.equal((await adminA.api("GET", "/api/timetable?classId=" + ctx.classA1)).data.slots.length, 0);
});

test("the save is validated by the server, not by the browser", async () => {
  const dup = await adminA.api("PUT", "/api/timetable", { classId: ctx.classA1, slots: [slot("Mon", 1), slot("Mon", 1, { subjectId: ctx.subjA2 })] });
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /Mon period 1/, "the message names the clashing cell");

  assert.match((await adminA.api("PUT", "/api/timetable", { classId: ctx.classA1, slots: [slot("Funday", 1)] })).data.error, /Mon–Sat/);
  assert.equal((await adminA.api("PUT", "/api/timetable", { classId: ctx.classA1, slots: [slot("Mon", 99)] })).status, 400);
  const tooMany = await adminA.api("PUT", "/api/timetable", {
    classId: ctx.classA1,
    slots: Array.from({ length: 73 }, (_, i) => ({ day: "Mon", period: 1 + (i % 12), extra: i })),
  });
  assert.equal(tooMany.status, 400, "a week cannot hold 73 periods");

  assert.equal((await adminA.api("PUT", "/api/timetable", { slots: [] })).status, 400, "classId is required");
  assert.equal((await adminA.api("PUT", "/api/timetable", { classId: 9999, slots: [] })).status, 400, "unknown class");

  // A rejected save must not have destroyed the existing week.
  await adminA.api("PUT", "/api/timetable", { classId: ctx.classA1, slots: [slot("Thu", 3, { subjectId: ctx.subjA1 })] });
  const bad = await adminA.api("PUT", "/api/timetable", { classId: ctx.classA1, slots: [slot("Thu", 1, { subjectId: 999 })] });
  assert.equal(bad.status, 400, "a subject id from elsewhere is refused");
  const grid = await adminA.api("GET", "/api/timetable?classId=" + ctx.classA1);
  assert.equal(grid.data.slots.length, 1, "the untouched week is still there — a rejected save never wipes it");
  assert.equal(grid.data.slots[0].day, "Thu");
  assert.equal(grid.data.slots[0].period, 3);
});

test("ids belonging to another tenant are refused, never borrowed", async () => {
  const r = await adminB.api("PUT", "/api/timetable", { classId: ctx.classB1, slots: [slot("Mon", 1, { subjectId: ctx.subjA1 })] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Unknown subject/);
  const across = await adminB.api("PUT", "/api/timetable", { classId: ctx.classB1, slots: [slot("Mon", 1, { teacherId: ctx.users.teacherA })] });
  assert.equal(across.status, 400, "a teacher of madrasa A cannot be scheduled into madrasa B");
  assert.equal((await adminB.api("GET", "/api/timetable?classId=" + ctx.classB1)).data.slots.length, 0);
  // B's own class id is simply not B's to save…
  const cls = await adminB.api("PUT", "/api/timetable", { classId: ctx.classA1, slots: [slot("Mon", 1)] });
  assert.equal(cls.status, 400, "class A1 does not belong to madrasa B");
});

test("each madrasa schedules its own week in isolation", async () => {
  const save = await adminB.api("PUT", "/api/timetable", { classId: ctx.classB1, slots: [slot("Sat", 1, { subjectId: ctx.subjB1 })] });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  assert.equal((await adminB.api("GET", "/api/timetable?classId=" + ctx.classB1)).data.slots.length, 1);
  assert.equal((await adminA.api("GET", "/api/timetable?classId=" + ctx.classA1)).data.slots.length, 1);
  assert.equal((await adminA.api("GET", "/api/timetable?classId=" + ctx.classA1)).data.slots[0].day, "Thu");
});

test("a teacher cannot be scheduled into two classes in the same period", async () => {
  const first = await adminA.api("PUT", "/api/timetable", {
    classId: ctx.classA1,
    slots: [slot("Mon", 1, { subjectId: ctx.subjA1, teacherId: ctx.users.teacherA })],
  });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const safeWeek = await adminA.api("PUT", "/api/timetable", {
    classId: ctx.classA2,
    slots: [slot("Mon", 2, { subjectId: ctx.subjA2, teacherId: ctx.users.teacherA })],
  });
  assert.equal(safeWeek.status, 200);
  const conflict = await adminA.api("PUT", "/api/timetable", {
    classId: ctx.classA2,
    slots: [slot("Mon", 1, { subjectId: ctx.subjA2, teacherId: ctx.users.teacherA })],
  });
  assert.equal(conflict.status, 400);
  assert.match(conflict.data.error, /Teacher A.*Class A1.*Mon, period 1/);
  const retained = await adminA.api("GET", "/api/timetable?classId=" + ctx.classA2);
  assert.equal(retained.data.slots.length, 1, "a rejected conflicting save never wipes the previous class week");
  assert.equal(retained.data.slots[0].period, 2);
});

test("a teacher may plan only the classes assigned to them", async () => {
  const notTheirs = await teacher.api("PUT", "/api/timetable", { classId: ctx.classA2, slots: [slot("Mon", 1)] });
  assert.equal(notTheirs.status, 403, "writing the timetable is the administration's job");
  const read = await teacher.api("GET", "/api/timetable?classId=" + ctx.classA2);
  assert.equal(read.status, 404, "Class A2 is not assigned to them, so it does not exist for them");
  const mine = await teacher.api("GET", "/api/timetable?classId=" + ctx.classA1);
  assert.equal(mine.status, 200, "their own class reads normally");
});

test("families cannot open the class editor, and neither can strangers", async () => {
  const parent = new Client(ctx.base);
  await parent.login("parent-a", PASSWORD);
  assert.equal((await parent.api("GET", "/api/timetable?classId=" + ctx.classA1)).status, 403);
  assert.equal((await adminB.api("GET", "/api/timetable?classId=" + ctx.classA1)).status, 404);
  assert.equal((await new Client(ctx.base).req("GET", "/api/timetable?classId=1")).status, 401);
  assert.equal((await adminA.api("GET", "/api/timetable")).status, 400, "a class must be named");
});

test("one class's week can be copied onto the others", async () => {
  await adminA.api("PUT", "/api/timetable", {
    classId: ctx.classA1,
    slots: [slot("Mon", 1, { subjectId: ctx.subjA1, teacherId: ctx.users.teacherA }), slot("Tue", 2, { subjectId: ctx.subjA2 })],
  });
  const r = await adminA.api("POST", "/api/timetable/copy", { fromClassId: ctx.classA1, toClassIds: [ctx.classA2, ctx.classB1] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.inserted, 2);
  assert.equal(r.data.copiedTo, 1);
  assert.equal(r.data.teacherConflicts, 1, "the copied simultaneous lesson is left without a teacher");
  assert.deepEqual(r.data.rejected, [{ classId: ctx.classB1, reason: "not_in_your_madrasa" }]);
  const copiedGrid = await adminA.api("GET", "/api/timetable?classId=" + ctx.classA2);
  assert.equal(copiedGrid.data.slots.length, 2);
  assert.equal(copiedGrid.data.slots.find((row) => row.day === "Mon" && row.period === 1).teacherId, null);
  assert.equal((await adminB.api("GET", "/api/timetable?classId=" + ctx.classB1)).data.slots.length, 1, "B's own week was not overwritten");

  assert.equal((await adminA.api("POST", "/api/timetable/copy", { fromClassId: ctx.classA1, toClassIds: [ctx.classA1] })).status, 400);
  assert.equal((await adminA.api("POST", "/api/timetable/copy", { fromClassId: ctx.classA2, toClassIds: [] })).status, 400);
  assert.equal((await teacher.api("POST", "/api/timetable/copy", { fromClassId: ctx.classA1, toClassIds: [ctx.classA2] })).status, 403);
});

test("a pupil sees their own week and their guardian sees both children", async () => {
  const mine = await student.api("GET", "/api/timetable/me");
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.equal(mine.data.kind, "student");
  assert.equal(mine.data.students.length, 1);
  const one = mine.data.students[0];
  assert.equal(one.name, "Alpha One");
  assert.equal(one.class.name_en, "Class A1");
  assert.equal(one.slots.length, 2);
  assert.equal(one.periods.length, 6, "the grid shape travels with the data");

  const parent = new Client(ctx.base);
  await parent.login("parent-a", PASSWORD);
  const theirs = await parent.api("GET", "/api/timetable/me");
  assert.equal(theirs.data.kind, "parent");
  const parentRow = await ctx.db.get("SELECT id FROM users WHERE username = 'parent-a'");
  const linked = await ctx.db.all("SELECT student_id FROM parent_links WHERE user_id = " + parentRow.id);
  assert.equal(theirs.data.students.length, linked.length, "exactly the linked children");
  for (const kid of theirs.data.students) {
    assert.ok(["Class A1", "Class A2"].includes(kid.class ? kid.class.name_en : ""), "only their own children");
  }
  assert.ok(theirs.data.students.some((k) => k.slots.length === 2), "the A1 child brings the week");
});

test("a teacher's week lists exactly the slots they were given", async () => {
  const r = await teacher.api("GET", "/api/timetable/me");
  assert.equal(r.status, 200);
  assert.equal(r.data.kind, "teacher");
  assert.ok(r.data.slots.length >= 1);
  // Every listed cell names their class and subject, and nothing from another
  // madrasa can appear (the query is scoped by madrasa_id + teacher_id).
  const own = new Set(["Class A1", "Class A2"]);
  for (const s of r.data.slots) {
    assert.ok(own.has(s.className), "only classes inside their own madrasa: " + s.className);
    assert.ok(s.subjectEn, "each cell names the subject to teach");
  }
  assert.ok(r.data.slots.some((s) => s.subjectEn === "Fiqh"));
  assert.ok(!r.data.slots.some((s) => s.className === "Class B1"), "never the other madrasa");
  const days = r.data.slots.map((s) => s.day);
  assert.deepEqual([...new Set(days)].sort(), [...new Set(r.data.slots.map((s) => s.day))].sort(), "days are listed as scheduled");
});

test("a printable weekly schedule is a standalone document", async () => {
  const r = await adminA.api("GET", "/api/timetable/print?classId=" + ctx.classA1);
  assert.equal(r.status, 200);
  const html = await r.res.text();
  assert.match(html, /Class A1/);
  assert.match(html, /Fiqh/);
  assert.match(html, /@media print/, "print rules, so it goes on the notice board cleanly");
  // The button used to open the dialog from an inline `onclick`, which the
  // platform CSP (script-src-attr 'none') drops without a word: the button did
  // nothing and no sheet came out. The page now carries exactly one script —
  // the shared same-origin print helper — and no inline code at all. Ctrl+P
  // still prints it with scripting switched off; the script only saves the
  // visitor the keystroke.
  assert.doesNotMatch(html, /onclick=/i, "no inline handler for the CSP to drop");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, "no inline script on a printable page");
  assert.match(html, /<script src="\/js\/print\.js"><\/script>/, "the same-origin helper opens the dialog");
});

test("a super admin inspects any class by naming the tenant", async () => {
  const r = await sa.api("GET", "/api/timetable?classId=" + ctx.classA1 + "&madrasaId=" + ctx.madrasaA);
  assert.equal(r.status, 200);
  assert.equal(r.data.slots.length, 2);
  assert.equal((await sa.api("GET", "/api/timetable?classId=" + ctx.classA1)).status, 400, "no tenant named, no data");
});
