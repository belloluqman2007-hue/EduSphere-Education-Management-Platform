"use strict";
/* ============================================================================
   SCAN A CARD — VERIFY *AND* MARK

   The QR code on a printed card used to verify and then stop. This file covers
   the other half: one scan of a student card marks the register for the
   school's own calendar day, one scan of a staff card checks a member of staff
   in, a cancelled card marks nothing, and a code from another institution is
   never resolved.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");
initEnv();

let ctx, adminA, adminB, teacherA, studentA1, parentA;

before(async () => {
  ctx = await setup();
  adminA = new Client(ctx.base); await adminA.login("admin-a", PASSWORD);
  adminB = new Client(ctx.base); await adminB.login("admin-b", PASSWORD);
  teacherA = new Client(ctx.base); await teacherA.login("teacher-a", PASSWORD);
  studentA1 = new Client(ctx.base); await studentA1.login("student-a1", PASSWORD);
  parentA = new Client(ctx.base); await parentA.login("parent-a", PASSWORD);
});
after(async () => { if (ctx) await ctx.close(); });

/** Rendering a card mints its credential; the registry reads the code back. */
async function cardCode(client, holderType, holderId) {
  const path = holderType === "teacher" ? `/api/documents/staff-id-card/${holderId}` : `/api/documents/id-card/${holderId}`;
  const page = await client.req("GET", path);
  assert.equal(page.status, 200, `card render failed: ${page.status}`);
  const credential = await client.api("GET", `/api/documents/card/${holderType}/${holderId}/credential`);
  assert.equal(credential.status, 200, JSON.stringify(credential.data));
  return credential.data.credential.code;
}

test("a scanned student card verifies and marks the register in one action", async () => {
  const code = await cardCode(adminA, "student", ctx.studentA1);
  const day = "2026-09-16";

  const scan = await adminA.api("POST", "/api/attendance/scan", { code, date: day });
  assert.equal(scan.status, 200, JSON.stringify(scan.data));
  assert.equal(scan.data.card.valid, true, "the card itself is verified");
  assert.equal(scan.data.card.name, "Alpha One");
  assert.equal(scan.data.marked, true);
  assert.equal(scan.data.alreadyMarked, false);
  assert.equal(scan.data.attendance.status, "present");
  assert.equal(scan.data.holder.classId, Number(ctx.classA1));
  // A gate needs to know how much of the class is still missing.
  assert.equal(scan.data.classToday.total, 2);
  assert.equal(scan.data.classToday.marked, 1);
  assert.equal(scan.data.classToday.remaining, 1);
  assert.match(scan.data.printPath, new RegExp(`/documents/id-card/${ctx.studentA1}$`));

  const register = await adminA.api("GET", `/api/attendance?classId=${ctx.classA1}&date=${day}`);
  assert.equal(register.status, 200);
  const alpha = register.data.students.find((row) => row.id === ctx.studentA1);
  const bravo = register.data.students.find((row) => row.id === ctx.studentA2);
  assert.equal(alpha.status, "present");
  assert.ok(!bravo.status, "only the scanned learner is marked");
});

test("scanning the same card twice marks once and says so", async () => {
  const code = await cardCode(adminA, "student", ctx.studentA2);
  const day = "2026-09-17";

  const first = await adminA.api("POST", "/api/attendance/scan", { code, date: day });
  assert.equal(first.data.marked, true);
  assert.equal(first.data.alreadyMarked, false);

  const second = await adminA.api("POST", "/api/attendance/scan", { code, date: day });
  assert.equal(second.status, 200);
  assert.equal(second.data.marked, true);
  assert.equal(second.data.alreadyMarked, true, "a duplicate scan is reported, not repeated");
  assert.match(second.data.message, /already marked/i);

  const history = await adminA.api("GET", `/api/attendance/history?classId=${ctx.classA1}&from=${day}&to=${day}`);
  assert.equal(history.status, 200);
  const rows = (history.data.records || []).filter((row) => Number(row.student_id) === Number(ctx.studentA2));
  assert.equal(rows.length, 1, "one learner, one day, one record");
});

test("the status travels with the scan (late stays late)", async () => {
  const code = await cardCode(adminA, "student", ctx.studentA1);
  const day = "2026-09-18";
  const scan = await adminA.api("POST", "/api/attendance/scan", { code, date: day, status: "late" });
  assert.equal(scan.status, 200);
  assert.equal(scan.data.marked, true);
  assert.equal(scan.data.attendance.status, "late");

  const report = await adminA.api("GET", `/api/attendance/report?classId=${ctx.classA1}&from=${day}&to=${day}`);
  const learner = report.data.students.find((row) => row.id === ctx.studentA1);
  assert.equal(learner.late, 1);
  assert.equal(learner.present, 0);
});

test("a cancelled card verifies as cancelled and marks nothing", async () => {
  const code = await cardCode(adminA, "student", ctx.studentA2);
  const revoked = await adminA.api("POST", `/api/documents/card/student/${ctx.studentA2}/status`, { status: "revoked" });
  assert.equal(revoked.status, 200);
  const day = "2026-09-19";

  const scan = await adminA.api("POST", "/api/attendance/scan", { code, date: day });
  assert.equal(scan.status, 200);
  assert.equal(scan.data.card.valid, false);
  assert.equal(scan.data.card.verdict, "revoked");
  assert.equal(scan.data.marked, false);
  assert.equal(scan.data.reason, "revoked");

  const register = await adminA.api("GET", `/api/attendance?classId=${ctx.classA1}&date=${day}`);
  assert.ok(!register.data.students.find((row) => row.id === ctx.studentA2).status, "a cancelled card marks nothing");
});

test("a card code from another institution is not resolvable here", async () => {
  const foreign = await cardCode(adminB, "student", ctx.studentB1);
  const scan = await adminA.api("POST", "/api/attendance/scan", { code: foreign, date: "2026-09-20" });
  assert.equal(scan.status, 404);
  assert.match(scan.data.error, /this school/i);
});

test("a staff card checks a member of staff in at the school's clock", async () => {
  const code = await cardCode(adminA, "teacher", ctx.users.teacherA);
  const day = "2026-09-21";
  const scan = await adminA.api("POST", "/api/attendance/scan", { code, date: day });
  assert.equal(scan.status, 200, JSON.stringify(scan.data));
  assert.equal(scan.data.card.holderType, "teacher");
  assert.equal(scan.data.marked, true);
  assert.equal(scan.data.attendance.status, "present");
  assert.match(String(scan.data.attendance.checkIn || ""), /^\d{2}:\d{2}$/, "a check-in time is recorded");
  assert.match(scan.data.printPath, /\/documents\/staff-id-card\//);

  const teachers = await adminA.api("GET", `/api/attendance/teachers?date=${day}`);
  const row = teachers.data.teachers.find((t) => Number(t.id) === Number(ctx.users.teacherA));
  assert.equal(row.status, "present");
  assert.equal(row.check_in, scan.data.attendance.checkIn);
});

test("a teacher cannot mark a class they are not assigned to, and cannot mark staff", async () => {
  // A learner in class A2 — a class teacher A has no assignment for.
  const created = await adminA.api("POST", "/api/students", {
    first_name: "Delta", last_name: "Four", class_id: ctx.classA2, session_id: ctx.sessionA,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const studentA3 = created.data.id;
  const studentCard = await cardCode(adminA, "student", studentA3);
  const day = "2026-09-22";

  const forbidden = await teacherA.api("POST", "/api/attendance/scan", { code: studentCard, date: day });
  assert.equal(forbidden.status, 404, "the register is not reachable for an unassigned class");
  const untouched = await adminA.api("GET", `/api/attendance?classId=${ctx.classA2}&date=${day}`);
  assert.ok(!untouched.data.students.find((row) => row.id === studentA3).status);

  // A teacher may scan a colleague's card, but staff attendance stays with an
  // administrator — the card is verified, nothing is marked.
  const staffCard = await cardCode(adminA, "teacher", ctx.users.teacherA);
  const staffScan = await teacherA.api("POST", "/api/attendance/scan", { code: staffCard, date: day });
  assert.equal(staffScan.status, 200);
  assert.equal(staffScan.data.card.valid, true);
  assert.equal(staffScan.data.marked, false);
  assert.equal(staffScan.data.reason, "staff_admin_only");
});

test("a learner or a parent cannot mark attendance by scanning", async () => {
  // The register is the school's record of who was where. If the person being
  // marked could do the marking, no register would be worth keeping — and a
  // parent's account is a read-only window on their own children.
  const code = await cardCode(adminA, "student", ctx.studentA1);
  const day = "2026-09-24";

  const asStudent = await studentA1.api("POST", "/api/attendance/scan", { code, date: day });
  assert.equal(asStudent.status, 403, "a learner cannot mark themselves present");
  const asParent = await parentA.api("POST", "/api/attendance/scan", { code, date: day });
  assert.equal(asParent.status, 403, "nor can a parent mark their child");

  const register = await adminA.api("GET", `/api/attendance?classId=${ctx.classA1}&date=${day}`);
  assert.ok(!register.data.students.find((row) => row.id === ctx.studentA1).status, "nothing was marked");

  // The same rule on the hand-typed register, so the two doors match.
  const typed = await studentA1.api("POST", "/api/attendance/mark", { classId: ctx.classA1, date: day, statuses: { [ctx.studentA1]: "present" } });
  assert.equal(typed.status, 403, "the register endpoint is staff-only too");

  // Verification without an account stays open — the card is the capability.
  const publicView = await adminA.req("GET", `/api/public/card/${code}`);
  assert.equal(publicView.status, 200);
  assert.equal(publicView.data.card.valid, true);
});

test("a scan without a code is refused, and an unknown card is a 404", async () => {
  const missing = await adminA.api("POST", "/api/attendance/scan", {});
  assert.equal(missing.status, 400);
  const unknown = await adminA.api("POST", "/api/attendance/scan", { code: "deadbeefdeadbeefdeadbeef" });
  assert.equal(unknown.status, 404);
});

/* ============================================================================
   WHAT COMES OUT OF THE PRINTER
   ========================================================================== */

test("a fee receipt is a real printable document for staff and for the family", async () => {
  const payment = await adminA.api("POST", "/api/fees/payments", {
    student_id: ctx.studentA1, amount_ngn: 25000, payment_date: "2026-09-23", method: "cash", reference: "RCPT-TEST-1",
  });
  assert.equal(payment.status, 200, JSON.stringify(payment.data));
  const paymentId = payment.data.id || payment.data.paymentId || (payment.data.payment && payment.data.payment.id);
  assert.ok(paymentId, "a payment id came back");

  const receipt = await adminA.req("GET", `/api/fees/payments/${paymentId}/receipt`);
  assert.equal(receipt.status, 200);
  const html = await receipt.res.text();
  // The old receipt relied on an inline <script>window.print()</script>, which
  // the platform CSP (script-src 'self', script-src-attr 'none') silently drops.
  assert.doesNotMatch(html, /<script>\s*window\.print\(\)/i, "no CSP-blocked inline print script");
  assert.match(html, /\/js\/print\.js/, "the shared print helper opens the dialog");
  assert.match(html, /id="printPageBtn"/, "and there is a button to press");
  assert.match(html, /Test Madrasa A/, "the school is on the receipt");
  assert.match(html, /Amount in words/i, "the amount is written out");
  assert.match(html, /twenty-five thousand naira/i);
  assert.match(html, /RCPT-TEST-1/, "the reference is printed");

  // The parent and student portals link straight at this route, so a family
  // opening their own receipt must not be answered with a 403.
  const parentView = await parentA.req("GET", `/api/fees/payments/${paymentId}/receipt`);
  assert.equal(parentView.status, 200);
  const studentView = await studentA1.req("GET", `/api/fees/payments/${paymentId}/receipt`);
  assert.equal(studentView.status, 200);

  // Another family's receipt is not their business.
  const other = new Client(ctx.base); await other.login("parent-b", PASSWORD);
  const forbidden = await other.req("GET", `/api/fees/payments/${paymentId}/receipt`);
  assert.ok([403, 404].includes(forbidden.status), `unrelated family must not read it (saw ${forbidden.status})`);
});

test("the printable timetable survives the platform CSP", async () => {
  const page = await adminA.req("GET", `/api/timetable/print?classId=${ctx.classA1}`);
  assert.equal(page.status, 200);
  const html = await page.res.text();
  assert.doesNotMatch(html, /onclick=/i, "inline handlers are blocked by the CSP and must not be used");
  assert.match(html, /id="printPageBtn"/);
  assert.match(html, /\/js\/print\.js/);
});

test("every in-app print button goes through the print helper", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const dashboard = fs.readFileSync(path.join(root, "public", "js", "dashboard.js"), "utf8");
  const teachers = fs.readFileSync(path.join(root, "public", "js", "admin-teacher-classes.js"), "utf8");

  // A bare window.print() inside a click handler prints the whole application —
  // the sidebar, the header, the filters and the pagination buttons. Each of
  // those call sites now names the document it is printing.
  assert.doesNotMatch(dashboard, /=>\s*window\.print\(\)/, "no unnamed print call left in the dashboard");
  assert.doesNotMatch(teachers, /=>\s*window\.print\(\)/, "no unnamed print call left in the teachers/classes module");

  const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(index, /<link rel="stylesheet" href="\/css\/print\.css">/, "the print stylesheet is loaded");
  assert.match(index, /<script src="\/js\/print-page\.js"><\/script>/, "the print helper is loaded");

  const helper = fs.readFileSync(path.join(root, "public", "js", "print-page.js"), "utf8");
  assert.match(helper, /window\.EduPrint\s*=/, "window.EduPrint is exported");

  const css = fs.readFileSync(path.join(root, "public", "css", "print.css"), "utf8");
  assert.match(css, /@media print/, "the print rules are print-only");
  assert.match(css, /\.dash-sidebar/, "the sidebar is hidden on paper");
  assert.match(css, /print-doc-head/, "a printed heading exists");
  assert.match(css, /data-print-scope="modal"/, "an open dialog can print as the document");
});

test("the dashboard offers scan-and-mark where attendance is marked", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dashboard = fs.readFileSync(path.join(__dirname, "..", "public", "js", "dashboard.js"), "utf8");
  assert.match(dashboard, /\["Scan & Mark", "attendance\/scan"\]/, "the menu reaches the scanner");
  assert.match(dashboard, /data-mark-endpoint="\/api\/attendance\/scan"/, "the scanner posts to the marking endpoint");
  assert.match(dashboard, /data-mark-auto="1"/, "a gate scan marks on the first read");
  assert.match(dashboard, /eduscanner:result/, "each scan is added to the shift log");
});
