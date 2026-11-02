"use strict";
/* ============================================================================
   Staff role workspaces — the modules each role template actually unlocks.

   The original complaint: "the HR officer, accountant, and other user roles'
   roles & permissions are not displaying for them… some things display but
   don't work." Those accounts are teacher-role users carrying a role template
   (hr_officer, accountant, librarian, admissions_officer) through
   user_permissions overrides, and every module they were promised used to be
   behind a server-level role gate (or a missing portal page) before these
   fixes. This file drives the real API the way each templated account would,
   so every regression is pinned:

     - the Roles & Permissions screen reports each account's template label;
     - an HR officer runs the payroll ledger and approves staff leave;
     - an accountant runs fees, payments and expenses;
     - a librarian manages the catalogue, lending desk and fine payments;
     - an admissions officer works the application pipeline;
     - plain teachers keep their boundaries (no payroll ledger, no approvals).

   One way in each direction: templated staff can do their job, everyone else
   stays locked out.
   ========================================================================== */
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { initEnv, setup, Client, PASSWORD } = require("./helpers");

initEnv();

let ctx;
let admin, hr, accountant, librarian, admissions, plain;
let hrId, accountantId, librarianId, admissionsId;

test.before(async () => {
  ctx = await setup();
  admin = new Client(ctx.base);
  await admin.login("admin-a", PASSWORD);

  const mkStaff = (username, fullName) => ctx.db.run(
    "INSERT INTO users (madrasa_id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)",
    [ctx.madrasaA, username, bcrypt.hashSync(PASSWORD, 10), "teacher", fullName]
  ).then((r) => r.lastInsertRowid);

  hrId = await mkStaff("staff-hr", "Hadi Officer");
  accountantId = await mkStaff("staff-acc", "Amina Accountant");
  librarianId = await mkStaff("staff-lib", "Lila Librarian");
  admissionsId = await mkStaff("staff-adm", "Adam Admissions");

  for (const [id, template] of [[hrId, "hr_officer"], [accountantId, "accountant"], [librarianId, "librarian"], [admissionsId, "admissions_officer"]]) {
    const r = await admin.api("POST", `/api/admin/permissions/users/${id}/template`, { template });
    assert.equal(r.status, 200, `template ${template}: ${JSON.stringify(r.data)}`);
  }

  hr = new Client(ctx.base); await hr.login("staff-hr", PASSWORD);
  accountant = new Client(ctx.base); await accountant.login("staff-acc", PASSWORD);
  librarian = new Client(ctx.base); await librarian.login("staff-lib", PASSWORD);
  admissions = new Client(ctx.base); await admissions.login("staff-adm", PASSWORD);
  plain = new Client(ctx.base); await plain.login("teacher-a", PASSWORD);
});

test.after(async () => { await ctx.close(); });

/* ----------------------- roles & permissions display ---------------------- */

test("the Roles & Permissions screen names each staff account's template", async () => {
  const r = await admin.api("GET", "/api/admin/permissions/users");
  assert.equal(r.status, 200);
  const byId = (id) => (r.data.users || []).find((u) => Number(u.id) === Number(id));
  assert.equal(byId(hrId).template, "hr_officer");
  assert.equal(byId(hrId).templateLabel, "HR Officer");
  assert.equal(byId(accountantId).template, "accountant");
  assert.equal(byId(accountantId).templateLabel, "Accountant");
  assert.equal(byId(librarianId).template, "librarian");
  assert.equal(byId(librarianId).templateLabel, "Librarian");
  assert.equal(byId(admissionsId).template, "admissions_officer");
  assert.equal(byId(admissionsId).templateLabel, "Admissions Officer");
  // an untuned plain teacher carries no template
  assert.equal(byId(ctx.users.teacherA).template, null);
});

/* ------------------------------ HR officer ------------------------------- */

test("an HR officer runs the payroll ledger end to end", async () => {
  assert.equal((await hr.req("GET", "/api/payroll/periods")).status, 200);
  assert.equal((await hr.req("GET", "/api/payroll/payslips")).status, 200);
  assert.equal((await hr.req("GET", "/api/payroll/structures")).status, 200);
  assert.equal((await hr.req("GET", "/api/payroll/advances")).status, 200);

  const structure = await hr.api("POST", "/api/payroll/structures", {
    user_id: ctx.users.teacherA, base_ngn: 100000, allowances: { housing: 10000 }, deductions: { tax: 5000 },
  });
  assert.equal(structure.status, 200, JSON.stringify(structure.data));

  const period = await hr.api("POST", "/api/payroll/periods", { session_id: ctx.sessionA, month: 9, year: 2026 });
  assert.equal(period.status, 200, JSON.stringify(period.data));
  const processed = await hr.api("POST", `/api/payroll/periods/${period.data.id}/process`);
  assert.equal(processed.status, 200, JSON.stringify(processed.data));

  const slips = await hr.req("GET", "/api/payroll/payslips");
  assert.equal(slips.status, 200);
  assert.ok((slips.data.payslips || []).length >= 1, "the ledger shows the generated payslip");

  const paid = await hr.api("POST", `/api/payroll/periods/${period.data.id}/pay`, {});
  assert.equal(paid.status, 200);
});

test("an HR officer reviews staff leave, files on behalf of staff and manages the catalogue", async () => {
  const types = await hr.req("GET", "/api/leave/types");
  assert.equal(types.status, 200);
  const annual = (types.data.types || []).find((t) => t.code === "annual") || types.data.types[0];
  assert.ok(annual, "the leave catalogue is readable");

  // plain teacher files for themselves (the route the old UI hit: it used to 404/403)
  const filed = await plain.api("POST", "/api/leave", {
    type_id: annual.id, start_date: "2026-12-01", end_date: "2026-12-02", reason: "Family matter",
  });
  assert.equal(filed.status, 200, JSON.stringify(filed.data));

  // the reviewer sees requests across the staff (not just their own)…
  const list = await hr.req("GET", "/api/leave?status=pending");
  assert.equal(list.status, 200);
  assert.ok((list.data.requests || []).some((q) => Number(q.id) === Number(filed.data.id)),
    "the HR officer sees leave filed by other staff");

  // …and decides them
  const approve = await hr.api("PATCH", `/api/leave/${filed.data.id}/approve`, { note: "Cover arranged." });
  assert.equal(approve.status, 200, JSON.stringify(approve.data));

  // filing on behalf of another staff member records the requester
  const behalf = await hr.api("POST", "/api/leave", {
    user_id: ctx.users.teacherA, type_id: annual.id, start_date: "2026-12-07", end_date: "2026-12-08",
  });
  assert.equal(behalf.status, 200, JSON.stringify(behalf.data));
  const detail = await hr.req("GET", `/api/leave/${behalf.data.id}`);
  assert.equal(detail.status, 200);
  assert.equal(Number(detail.data.request.user_id), Number(ctx.users.teacherA));

  // and manages the leave catalogue
  const created = await hr.api("POST", "/api/leave/types", { name: "Compassionate Leave", days_per_year: 5 });
  assert.equal(created.status, 200, JSON.stringify(created.data));
});

/* ------------------------------ accountant ------------------------------- */

test("an accountant runs fees, payments and expenses", async () => {
  const items = await accountant.req("GET", "/api/fees/items");
  assert.equal(items.status, 200);

  const fee = await accountant.api("POST", "/api/fees/items", {
    name_en: "Tuition", amount_ngn: 50000, due_date: "2026-12-31", assign_now: true,
  });
  assert.equal(fee.status, 200, JSON.stringify(fee.data));

  const payment = await accountant.api("POST", "/api/fees/payments", {
    student_id: ctx.studentA1, amount_ngn: 20000, payment_date: "2026-11-01", method: "cash",
  });
  assert.equal(payment.status, 200, JSON.stringify(payment.data));
  const verified = await accountant.api("POST", `/api/fees/payments/${payment.data.id}/verify`, { verification_status: "verified" });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));

  assert.equal((await accountant.req("GET", "/api/fees/payments")).status, 200);
  assert.equal((await accountant.req("GET", "/api/fees/outstanding")).status, 200);
  const reports = await accountant.req("GET", "/api/fees/reports");
  assert.equal(reports.status, 200);
  assert.ok(reports.data.summary, "the report summary is populated");

  // expenses: the admin owns the category taxonomy, the accountant records spend
  const category = await admin.api("POST", "/api/expenses/categories", { name: "Utilities" });
  assert.equal(category.status, 201, JSON.stringify(category.data));
  const expense = await accountant.api("POST", "/api/expenses", {
    category_id: category.data.id, amount_ngn: 15000, payment_date: "2026-11-01", description: "Light bill",
  });
  assert.equal(expense.status, 201, JSON.stringify(expense.data));
  const listed = await accountant.req("GET", "/api/expenses");
  assert.equal(listed.status, 200);
  assert.ok((listed.data.expenses || []).length >= 1);

  // boundary: approving spend stays with the administration (documented split)
  assert.equal((await accountant.api("PATCH", `/api/expenses/${expense.data.id}/approve`, {})).status, 403);
  assert.equal((await accountant.api("POST", "/api/expenses/categories", { name: "Nope" })).status, 403);
});

/* ------------------------------- librarian ------------------------------- */

test("a librarian manages the catalogue, lending desk and fine payments", async () => {
  const book = await librarian.api("POST", "/api/library/books", {
    title: "Sahih al-Bukhari", author: "Imam Bukhari", total_copies: 2,
  });
  assert.equal(book.status, 200, JSON.stringify(book.data));

  const catalogue = await librarian.req("GET", "/api/library/books");
  assert.equal(catalogue.status, 200);
  assert.ok((catalogue.data.books || []).some((b) => b.title === "Sahih al-Bukhari"));

  // fine rates come from the settings table (set here without admin UI ceremony)
  await ctx.db.run("INSERT INTO settings (madrasa_id, key_name, value) VALUES (?,?,?)",
    [ctx.madrasaA, "library_fine_per_day_ngn", "100"]);
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const loan = await librarian.api("POST", "/api/library/loans", {
    book_id: book.data.id, borrower_user_id: ctx.users.teacherA, borrower_type: "teacher",
    issue_date: daysAgo(10), due_date: daysAgo(1),
  });
  assert.equal(loan.status, 200, JSON.stringify(loan.data));

  const returned = await librarian.api("POST", `/api/library/loans/${loan.data.id}/return`, {});
  assert.equal(returned.status, 200, JSON.stringify(returned.data));
  assert.ok(Number(returned.data.fineNgn) > 0, "the overdue return raised a fine");

  const fines = await librarian.req("GET", "/api/library/fines");
  assert.equal(fines.status, 200);
  const fine = (fines.data.fines || []).find((f) => Number(f.loan_id) === Number(loan.data.id));
  assert.ok(fine, "the fine is on the fines list");

  // paying a fine used to be an admin-only route; the librarian manages their desk
  const paid = await librarian.api("POST", `/api/library/fines/${fine.id}/pay`, {});
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
});

/* ---------------------------- admissions officer -------------------------- */

test("an admissions officer works the pipeline without holding approval", async () => {
  const appId = (await ctx.db.run(
    "INSERT INTO admission_requests (madrasa_id, reference, first_name, last_name, parent_name, parent_phone) VALUES (?,?,?,?,?,?)",
    [ctx.madrasaA, "APP-TEST-0001", "New", "Applicant", "Parent N", "+2348099999999"]
  )).lastInsertRowid;

  const listed = await admissions.req("GET", "/api/admissions");
  assert.equal(listed.status, 200);
  assert.ok((listed.data.requests || []).some((r) => Number(r.id) === appId));

  const reviewed = await admissions.api("POST", `/api/admissions/${appId}/under-review`, {});
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  assert.equal(reviewed.data.status, "under_review");

  const detail = await admissions.req("GET", `/api/admissions/${appId}`);
  assert.equal(detail.status, 200);

  // the template trains the officer to prepare applications, not decide them
  assert.equal((await admissions.api("POST", `/api/admissions/${appId}/accept`, {})).status, 403);
  assert.equal((await admissions.api("POST", `/api/admissions/${appId}/reject`, {})).status, 403);
  // and a plain teacher still cannot open the module at all
  assert.equal((await plain.req("GET", "/api/admissions")).status, 403);
});

/* ------------------------------ boundaries ------------------------------- */

test("the payroll ledger stays closed to plain teachers, who read their own slips", async () => {
  assert.equal((await plain.req("GET", "/api/payroll/payslips")).status, 403);
  const mine = await plain.req("GET", "/api/payroll/my-payslips");
  assert.equal(mine.status, 200);
  assert.ok((mine.data.payslips || []).every((s) => Number(s.user_id) === Number(ctx.users.teacherA)),
    "my-payslips only ever returns the caller's own slips");
});
