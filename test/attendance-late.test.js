"use strict";
/* Attendance status regression: late is a first-class, attended status. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

let ctx, adminA, adminB;
before(async () => {
  ctx = await setup();
  adminA = new Client(ctx.base); await adminA.login("admin-a", PASSWORD);
  adminB = new Client(ctx.base); await adminB.login("admin-b", PASSWORD);
});
after(async () => { if (ctx) await ctx.close(); });

test("student attendance accepts late, reports it separately, and treats it as attended", async () => {
  const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10); // relative: a hardcoded day ages out of the 30-day analytics window
  const saved = await adminA.api("POST", "/api/attendance/mark", {
    classId: ctx.classA1,
    date: day,
    termId: ctx.termA1,
    statuses: { [ctx.studentA1]: "late", [ctx.studentA2]: "present" },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.saved, 2);

  const register = await adminA.api("GET", `/api/attendance?classId=${ctx.classA1}&date=${day}`);
  assert.equal(register.status, 200);
  assert.equal(register.data.students.find((row) => row.id === ctx.studentA1).status, "late");

  const report = await adminA.api("GET", `/api/attendance/report?classId=${ctx.classA1}&from=${day}&to=${day}`);
  assert.equal(report.status, 200);
  const lateLearner = report.data.students.find((row) => row.id === ctx.studentA1);
  assert.deepEqual(
    { present: lateLearner.present, late: lateLearner.late, absent: lateLearner.absent, excused: lateLearner.excused, marked: lateLearner.marked },
    { present: 0, late: 1, absent: 0, excused: 0, marked: 1 },
  );

  const analytics = await adminA.api("GET", "/api/madrasa/analytics");
  assert.equal(analytics.status, 200);
  assert.equal(analytics.data.analytics.attendance.late, 1);
  assert.equal(analytics.data.analytics.attendance.rate, 100, "one late and one present are both counted as attendance");

  const csv = await adminA.req("GET", `/api/exports/attendance.csv?classId=${ctx.classA1}&from=${day}&to=${day}`);
  const lines = (await csv.res.text()).trim().split(/\r?\n/);
  assert.match(lines[0], /Days Present,Days Absent,Late,Excused,Sessions Recorded,Attendance %/);
  const lateLine = lines.find((line) => line.includes("TTA0001"));
  assert.match(lateLine, /,0,0,1,0,1,100\.0$/, "CSV keeps the late count and attended percentage consistent");

  const invalid = await adminA.api("POST", "/api/attendance/mark", {
    classId: ctx.classA1, date: day, statuses: { [ctx.studentA1]: "arrived_eventually" },
  });
  assert.equal(invalid.status, 200, "unknown statuses are ignored rather than persisted");
  assert.equal(invalid.data.saved, 0);
  const isolated = await adminB.api("GET", `/api/attendance?classId=${ctx.classA1}&date=${day}`);
  assert.equal(isolated.status, 404, "another tenant cannot read the register");
});

test("teacher attendance also accepts the late status", async () => {
  const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10); // relative: a hardcoded day ages out of the 30-day analytics window
  const saved = await adminA.api("POST", "/api/attendance/teachers/mark", {
    date: day, statuses: { [ctx.users.teacherA]: "late" },
  });
  assert.equal(saved.status, 200);
  const register = await adminA.api("GET", `/api/attendance/teachers?date=${day}`);
  assert.equal(register.status, 200);
  assert.equal(register.data.teachers[0].status, "late");
});
