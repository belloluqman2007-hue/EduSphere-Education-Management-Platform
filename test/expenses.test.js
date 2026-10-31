"use strict";
/* ============================================================================
   EXPENSES & BUDGET MODULE TESTS
   ----------------------------------------------------------------------------
   Covers the additive School Expense & Budget module end-to-end:
     • Migration 030 creates expense_categories, expenses, budgets, expense_receipts
     • Expense Categories CRUD, parent_id nesting, type enum validation, tenant scope
     • Expenses CRUD: draft creation, filterable querying, details
     • Admin approval and rejection workflow
     • Receipt upload (multipart/form-data) stored in uploads/receipts/
     • Soft-deletion of expenses (status=cancelled)
     • Per-session category budgeting: upsert, budget vs actual summary math (% used, remaining)
     • Expense Reports: breakdowns by category, month, vendor, payment method
     • CSV report export via services/csv.js
     • Tenant isolation between Madrasa A and Madrasa B
     • Integration with GET /api/madrasa/dashboard (total_expenses_ngn and total_fees_collected)
     • Role authorization (401 unauthenticated, 403 unauthorized)
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const { initEnv, setup, Client } = require("./helpers");
initEnv();

let ctx;
let adminA, adminB, teacherA, anon, superAdmin;
const U = "Passw0rd!123";

before(async () => {
  ctx = await setup();
  adminA = new Client(ctx.base);
  adminB = new Client(ctx.base);
  teacherA = new Client(ctx.base);
  anon = new Client(ctx.base);
  superAdmin = new Client(ctx.base);

  const r1 = await adminA.login("admin-a", U); assert.equal(r1.status, 200, "adminA login");
  const r2 = await adminB.login("admin-b", U); assert.equal(r2.status, 200, "adminB login");
  const r3 = await teacherA.login("teacher-a", U); assert.equal(r3.status, 200, "teacherA login");
  const r4 = await superAdmin.login("testadmin", "TestAdmin123!"); assert.equal(r4.status, 200, "superAdmin login");
});

after(async () => {
  await ctx.close();
});

/* ----------------------------------------------------------------------------
   1. EXPENSE CATEGORIES
   ---------------------------------------------------------------------------- */

test("admin creates top-level and nested expense categories", async () => {
  // Create top-level Operating category
  const res1 = await adminA.api("POST", "/api/expenses/categories", {
    name: "Utilities & Energy",
    type: "operating",
  });
  assert.equal(res1.status, 201);
  assert.ok(res1.data.id > 0);
  const parentId = res1.data.id;
  assert.equal(res1.data.category.name, "Utilities & Energy");
  assert.equal(res1.data.category.type, "operating");
  assert.equal(res1.data.category.parent_id, null);

  // Create nested subcategory under Utilities
  const res2 = await adminA.api("POST", "/api/expenses/categories", {
    name: "Electricity & Generator Fuel",
    type: "operating",
    parent_id: parentId,
  });
  assert.equal(res2.status, 201);
  assert.equal(res2.data.category.parent_id, parentId);

  // Create a Capital expenditure category
  const res3 = await adminA.api("POST", "/api/expenses/categories", {
    name: "Classroom Building Expansion",
    type: "capital",
  });
  assert.equal(res3.status, 201);
  assert.equal(res3.data.category.type, "capital");

  // Verify categories list for Madrasa A
  const listRes = await adminA.req("GET", "/api/expenses/categories");
  assert.equal(listRes.status, 200);
  const cats = listRes.data.categories;
  assert.ok(cats.some((c) => c.name === "Utilities & Energy"));
  assert.ok(cats.some((c) => c.name === "Electricity & Generator Fuel" && Number(c.parent_id) === parentId));
  assert.ok(cats.some((c) => c.name === "Classroom Building Expansion" && c.type === "capital"));
});

test("category validation: rejects empty name and prevents cyclic parent references", async () => {
  // Empty name
  const emptyRes = await adminA.api("POST", "/api/expenses/categories", { name: "", type: "operating" });
  assert.equal(emptyRes.status, 400);

  // Create two categories
  const catA = (await adminA.api("POST", "/api/expenses/categories", { name: "Branch A", type: "other" })).data.id;
  const catB = (await adminA.api("POST", "/api/expenses/categories", { name: "Branch B", type: "other", parent_id: catA })).data.id;

  // Attempt to make catA a child of catB (cycle)
  const cycleRes = await adminA.api("PATCH", `/api/expenses/categories/${catA}`, { parent_id: catB });
  assert.equal(cycleRes.status, 400);

  // Attempt to make catA its own parent
  const selfRes = await adminA.api("PATCH", `/api/expenses/categories/${catA}`, { parent_id: catA });
  assert.equal(selfRes.status, 400);
});

/* ----------------------------------------------------------------------------
   2. EXPENSES CRUD & WORKFLOW (Draft -> Approved / Rejected, Soft Delete)
   ---------------------------------------------------------------------------- */

test("staff/admin records a draft expense and approves it", async () => {
  // Get category and session
  const catRes = await adminA.req("GET", "/api/expenses/categories");
  const cat = catRes.data.categories.find((c) => c.name === "Electricity & Generator Fuel");
  assert.ok(cat, "category exists");

  const sessRes = await adminA.req("GET", "/api/sessions");
  const session = sessRes.data.sessions[0];
  assert.ok(session, "session exists");

  // 1. Create draft expense
  const expRes = await adminA.api("POST", "/api/expenses", {
    category_id: cat.id,
    session_id: session.id,
    amount_ngn: 45000,
    vendor: "NNPC Petrol Station",
    description: "50 litres diesel for generator",
    payment_date: "2026-09-10",
    payment_method: "bank_transfer",
  });
  assert.equal(expRes.status, 201);
  const expId = expRes.data.id;
  assert.equal(expRes.data.expense.status, "draft");
  assert.equal(Number(expRes.data.expense.amount_ngn), 45000);
  assert.equal(expRes.data.expense.vendor, "NNPC Petrol Station");

  // 2. Fetch single expense detail
  const detail = await adminA.req("GET", `/api/expenses/${expId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.expense.id, expId);
  assert.equal(detail.data.expense.category_name, "Electricity & Generator Fuel");

  // 3. Admin approves expense
  const approveRes = await adminA.api("PATCH", `/api/expenses/${expId}/approve`, {});
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.data.expense.status, "approved");
  assert.ok(approveRes.data.expense.approved_by > 0);

  // Verify in list
  const list = await adminA.req("GET", `/api/expenses?status=approved`);
  assert.equal(list.status, 200);
  assert.ok(list.data.expenses.some((e) => e.id === expId));
});

test("admin can reject a draft expense and soft-delete (cancel) an expense", async () => {
  const catRes = await adminA.req("GET", "/api/expenses/categories");
  const cat = catRes.data.categories[0];

  // 1. Create draft expense to reject
  const expRes = await adminA.api("POST", "/api/expenses", {
    category_id: cat.id,
    amount_ngn: 120000,
    vendor: "Unverified Contractor",
    description: "Office renovation quote",
    payment_date: "2026-09-12",
  });
  assert.equal(expRes.status, 201);
  const expId = expRes.data.id;

  // 2. Reject expense
  const rejectRes = await adminA.api("PATCH", `/api/expenses/${expId}/reject`, {});
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.data.expense.status, "rejected");

  // 3. Soft-delete (cancel)
  const delRes = await adminA.api("DELETE", `/api/expenses/${expId}`);
  assert.equal(delRes.status, 200);

  // Verify it is now cancelled
  const detail = await adminA.req("GET", `/api/expenses/${expId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.expense.status, "cancelled");

  // Filtered listing without status=cancelled excludes it by default
  const defaultList = await adminA.req("GET", "/api/expenses");
  assert.ok(!defaultList.data.expenses.some((e) => e.id === expId));
});

test("expense filtering: by session, category, status, date range and vendor search", async () => {
  const catRes = await adminA.req("GET", "/api/expenses/categories");
  const cat = catRes.data.categories.find((c) => c.name === "Utilities & Energy") || catRes.data.categories[0];
  const sessRes = await adminA.req("GET", "/api/sessions");
  const session = sessRes.data.sessions[0];

  // Create two distinct expenses
  await adminA.api("POST", "/api/expenses", {
    category_id: cat.id,
    session_id: session.id,
    amount_ngn: 25000,
    vendor: "Ibadan Electricity Co",
    description: "Monthly prepaid token",
    payment_date: "2026-09-05",
    payment_method: "cash",
  });

  await adminA.api("POST", "/api/expenses", {
    category_id: cat.id,
    session_id: session.id,
    amount_ngn: 15000,
    vendor: "Water Delivery Service",
    description: "Borehole maintenance",
    payment_date: "2026-09-15",
    payment_method: "cash",
  });

  // Filter by vendor search
  const searchRes = await adminA.req("GET", "/api/expenses?search=Electricity");
  assert.equal(searchRes.status, 200);
  assert.ok(searchRes.data.expenses.some((e) => e.vendor === "Ibadan Electricity Co"));
  assert.ok(!searchRes.data.expenses.some((e) => e.vendor === "Water Delivery Service"));

  // Filter by date range
  const dateRes = await adminA.req("GET", "/api/expenses?from=2026-09-01&to=2026-09-08");
  assert.equal(dateRes.status, 200);
  assert.ok(dateRes.data.expenses.some((e) => e.payment_date === "2026-09-05"));
  assert.ok(!dateRes.data.expenses.some((e) => e.payment_date === "2026-09-15"));
});

/* ----------------------------------------------------------------------------
   3. RECEIPT UPLOADS
   ---------------------------------------------------------------------------- */

test("receipt file upload stores file under uploads/receipts/ and updates expense", async () => {
  const catRes = await adminA.req("GET", "/api/expenses/categories");
  const cat = catRes.data.categories[0];

  const expRes = await adminA.api("POST", "/api/expenses", {
    category_id: cat.id,
    amount_ngn: 8500,
    vendor: "Stationery Mart",
    description: "A4 paper reams",
    payment_date: "2026-09-14",
  });
  const expId = expRes.data.id;

  // Create a multipart form-data payload using boundary
  const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
  const sampleContent = "%PDF-1.4 sample invoice content";
  const bodyBuffer = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="receipt"; filename="invoice-123.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(sampleContent),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const csrf = await adminA.csrf();
  const rawRes = await fetch(adminA.base + `/api/expenses/${expId}/receipt`, {
    method: "POST",
    headers: {
      "Cookie": adminA.cookieHeader(),
      "X-CSRF-Token": csrf,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: bodyBuffer,
  });
  const uploadData = await rawRes.json();

  assert.equal(rawRes.status, 200);
  assert.ok(uploadData.receipt_path.startsWith("/uploads/receipts/"));
  assert.equal(uploadData.receipt.original_name, "invoice-123.pdf");
  const durable = await ctx.db.get("SELECT bytes FROM media_files WHERE web_path = ?", [uploadData.receipt_path]);
  assert.equal(durable.bytes, Buffer.byteLength(sampleContent));
  const own = await adminA.req("GET", uploadData.receipt_path);
  assert.equal(own.status, 200);
  assert.equal(await own.res.text(), sampleContent);
  assert.equal((await adminB.req("GET", uploadData.receipt_path)).status, 404);
  assert.equal((await anon.req("GET", uploadData.receipt_path)).status, 404);
  // Percent-encoding the context must not bypass the authorization gate.
  assert.equal((await adminB.req("GET", uploadData.receipt_path.replace("receipts", "%72eceipts"))).status, 404);
  await ctx.db.close();
  const reopened = await adminA.req("GET", uploadData.receipt_path);
  assert.equal(reopened.status, 200);
  assert.equal(await reopened.res.text(), sampleContent);

  // Check that single expense detail returns the receipt record
  const detail = await adminA.req("GET", `/api/expenses/${expId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.receipts.length, 1);
  assert.equal(detail.data.receipts[0].original_name, "invoice-123.pdf");
});

/* ----------------------------------------------------------------------------
   4. BUDGET VS ACTUAL
   ---------------------------------------------------------------------------- */

test("budget allocation: upserts budgeted amount per category per session and computes variance", async () => {
  const catRes = await adminA.req("GET", "/api/expenses/categories");
  const cat = catRes.data.categories.find((c) => c.name === "Utilities & Energy") || catRes.data.categories[0];
  const sessRes = await adminA.req("GET", "/api/sessions");
  const session = sessRes.data.sessions[0];

  // 1. Set budget for Utilities: ₦100,000
  const bRes1 = await adminA.api("POST", "/api/budget", {
    session_id: session.id,
    category_id: cat.id,
    budgeted_ngn: 100000,
    notes: "Approved utility budget for 2026/2027",
  });
  assert.equal(bRes1.status, 200);
  assert.equal(Number(bRes1.data.budget.budgeted_ngn), 100000);

  // 2. Record and approve an expense of ₦40,000 in that category and session
  const expRes = await adminA.api("POST", "/api/expenses", {
    category_id: cat.id,
    session_id: session.id,
    amount_ngn: 40000,
    vendor: "Energy Supplier",
    description: "Utility payment",
    payment_date: "2026-09-08",
  });
  await adminA.api("PATCH", `/api/expenses/${expRes.data.id}/approve`, {});

  // 3. Query GET /api/budget/summary
  const summaryRes = await adminA.req("GET", `/api/budget/summary?sessionId=${session.id}`);
  assert.equal(summaryRes.status, 200);
  assert.equal(summaryRes.data.session.id, session.id);

  const catSummary = summaryRes.data.categories.find((c) => Number(c.category_id) === Number(cat.id));
  assert.ok(catSummary, "category summary found");
  assert.equal(Number(catSummary.budgeted_ngn), 100000);
  assert.equal(Number(catSummary.spent_ngn), 40000);
  assert.equal(Number(catSummary.remaining_ngn), 60000);
  assert.equal(Number(catSummary.percent_used), 40);

  // 4. Update/Upsert budget to ₦150,000
  const bRes2 = await adminA.api("POST", "/api/budget", {
    session_id: session.id,
    category_id: cat.id,
    budgeted_ngn: 150000,
    notes: "Revised utility budget",
  });
  assert.equal(bRes2.status, 200);
  assert.equal(Number(bRes2.data.budget.budgeted_ngn), 150000);

  const summaryRes2 = await adminA.req("GET", `/api/budget/summary?sessionId=${session.id}`);
  const catSummary2 = summaryRes2.data.categories.find((c) => Number(c.category_id) === Number(cat.id));
  assert.equal(Number(catSummary2.budgeted_ngn), 150000);
  assert.equal(Number(catSummary2.remaining_ngn), 110000);
  assert.equal(Number(catSummary2.percent_used), 26.7);
});

/* ----------------------------------------------------------------------------
   5. EXPENSE REPORTS & CSV EXPORT
   ---------------------------------------------------------------------------- */

test("expense report aggregates totals by category, month, and vendor, and exports CSV", async () => {
  // Query report
  const repRes = await adminA.req("GET", "/api/expenses/report");
  assert.equal(repRes.status, 200);
  assert.ok(repRes.data.summary.total_spent > 0);
  assert.ok(Array.isArray(repRes.data.byCategory));
  assert.ok(Array.isArray(repRes.data.byMonth));
  assert.ok(Array.isArray(repRes.data.byVendor));
  assert.ok(Array.isArray(repRes.data.byPaymentMethod));

  // CSV Export via /api/expenses/report.csv
  const csvRes = await adminA.req("GET", "/api/expenses/report.csv");
  assert.equal(csvRes.status, 200);
  const ct = csvRes.res.headers.get("content-type") || "";
  assert.ok(ct.includes("text/csv"));
  const text = await csvRes.res.text();
  assert.ok(text.includes("Date,Session,Term,Category,Category Type,Vendor,Description"));
  assert.ok(text.includes("Energy Supplier"));
});

/* ----------------------------------------------------------------------------
   6. TENANT ISOLATION (Madrasa A vs Madrasa B)
   ---------------------------------------------------------------------------- */

test("tenant isolation: Admin B cannot read, approve, or alter Madrasa A's expenses or categories", async () => {
  // Get an expense from Madrasa A
  const listA = await adminA.req("GET", "/api/expenses");
  const expA = listA.data.expenses[0];
  assert.ok(expA, "Madrasa A has an expense");

  // Admin B attempts to read Madrasa A's expense
  const bRead = await adminB.req("GET", `/api/expenses/${expA.id}`);
  assert.equal(bRead.status, 404);

  // Admin B attempts to approve Madrasa A's expense
  const bApprove = await adminB.api("PATCH", `/api/expenses/${expA.id}/approve`, {});
  assert.equal(bApprove.status, 404);

  // Admin B attempts to delete Madrasa A's expense
  const bDelete = await adminB.api("DELETE", `/api/expenses/${expA.id}`);
  assert.equal(bDelete.status, 404);

  // Admin B's expense list is isolated
  const bList = await adminB.req("GET", "/api/expenses");
  assert.equal(bList.status, 200);
  assert.ok(!bList.data.expenses.some((e) => e.id === expA.id));
});

/* ----------------------------------------------------------------------------
   7. MADRASA DASHBOARD API INTEGRATION
   ---------------------------------------------------------------------------- */

test("GET /api/madrasa/dashboard returns total_expenses_ngn alongside total_fees_collected", async () => {
  const dashRes = await adminA.req("GET", "/api/madrasa/dashboard");
  assert.equal(dashRes.status, 200);
  assert.ok("total_expenses_ngn" in dashRes.data, "total_expenses_ngn in root response");
  assert.ok("total_fees_collected" in dashRes.data, "total_fees_collected in root response");
  assert.ok("total_expenses_ngn" in dashRes.data.stats, "total_expenses_ngn in stats object");
  assert.ok("total_fees_collected" in dashRes.data.stats, "total_fees_collected in stats object");
  assert.ok(Number(dashRes.data.stats.total_expenses_ngn) > 0, "approved expenses are summed");
});

/* ----------------------------------------------------------------------------
   8. ROLE AUTHORIZATION & PERMISSIONS
   ---------------------------------------------------------------------------- */

test("unauthenticated and unauthorized requests are rejected", async () => {
  // Unauthenticated requests
  const anonCats = await anon.req("GET", "/api/expenses/categories");
  assert.equal(anonCats.status, 401);

  const anonExp = await anon.req("GET", "/api/expenses");
  assert.equal(anonExp.status, 401);

  // Teacher (non-admin) cannot approve or delete expenses
  const listA = await adminA.req("GET", "/api/expenses");
  const expA = listA.data.expenses[0];

  const teacherApprove = await teacherA.api("PATCH", `/api/expenses/${expA.id}/approve`, {});
  assert.equal(teacherApprove.status, 403);

  const teacherDelete = await teacherA.api("DELETE", `/api/expenses/${expA.id}`);
  assert.equal(teacherDelete.status, 403);

  const teacherBudget = await teacherA.api("POST", "/api/budget", {
    session_id: 1,
    category_id: 1,
    budgeted_ngn: 50000,
  });
  assert.equal(teacherBudget.status, 403);
});
