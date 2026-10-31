"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — School Expense & Budget Management
   ----------------------------------------------------------------------------
   Tenant-scoped expense tracking and budget allocation module:
     • expense categories with tree nesting (parent_id) and category types
       (operating, capital, salary, other)
     • expense tracking with draft → approved / rejected lifecycle, soft-delete
     • receipt file uploads (stored under uploads/receipts/)
     • per-session category budgeting with budget vs actual calculations
     • filterable reports by category, month, vendor, payment method
     • CSV report generation through services/csv.js
     • tenant isolation enforced by madrasa_id on every statement
   ========================================================================== */
const express = require("express");
const crypto = require("crypto");
const multer = require("multer");

const db = require("../db");
const mediaStore = require("../services/media-store");
const config = require("../config");
const { asyncHandler, ok, err, cleanStr, toNum, validDate, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { effectiveTenantId, loadTenantRow } = require("../middleware/tenant");
const { requireFeature } = require("../middleware/subscription");
const csv = require("../services/csv");
const { requireStaffPermission } = require("../services/permissions");

const router = express.Router();
const budgetRouter = express.Router();

router.use(requireAuth, requireTenant);
budgetRouter.use(requireAuth, requireTenant);
// Expenses, budgets and the financial reports are Premium ("Finance & HR").
router.use(requireFeature("expenses"));
budgetRouter.use(requireFeature("expenses"));

const ADMIN = requireRole("madrasa_admin", "super_admin");
const STAFF = requireRole("madrasa_admin", "teacher", "super_admin");

const CATEGORY_TYPES = new Set(["operating", "capital", "salary", "other"]);
const EXPENSE_STATUSES = new Set(["draft", "approved", "rejected", "cancelled"]);
const PAYMENT_METHODS = new Set(["cash", "bank_transfer", "pos", "cheque", "online", "other"]);

/* ------------------------------ helpers -------------------------------- */

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) {
    res.status(400).json({ error: "Madrasa context required." });
    return null;
  }
  return tid;
}

function n(v) {
  const num = Number(v);
  return Number.isFinite(num) ? num : 0;
}

function round2(v) {
  return Math.round((n(v) + Number.EPSILON) * 100) / 100;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function monthLabel(ym) {
  if (!ym || typeof ym !== "string") return ym || "";
  const parts = ym.split("-");
  if (parts.length < 2) return ym;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mIndex = parseInt(parts[1], 10) - 1;
  const mName = months[mIndex] || parts[1];
  return `${mName} ${parts[0]}`;
}

// Use a bounded in-memory staging buffer; Render's disk is not durable.
// The extension is derived from the allowed MIME, never the client filename.
const RECEIPT_EXT = new Map([
  ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"],
  ["image/gif", ".gif"], ["application/pdf", ".pdf"],
]);
const receiptMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (config.MAX_UPLOAD_MB || 10) * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (RECEIPT_EXT.has(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error("Only JPG, PNG, WEBP, GIF images or PDF files are allowed for receipts."), { status: 400, expose: true }));
  },
}).fields([{ name: "receipt", maxCount: 1 }, { name: "file", maxCount: 1 }]);

function uploadReceiptMiddleware(req, res, next) {
  receiptMulter(req, res, async (uploadErr) => {
    if (uploadErr) {
      if (uploadErr.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "Receipt file too large." });
      return res.status(400).json({ error: uploadErr.expose ? uploadErr.message : "Invalid receipt file upload." });
    }
    req.file = req.files && ((req.files.receipt && req.files.receipt[0]) || (req.files.file && req.files.file[0]));
    if (!req.file) return next();
    const file = req.file;
    file.filename = Date.now() + "-" + crypto.randomBytes(8).toString("hex") + RECEIPT_EXT.get(file.mimetype);
    const webPath = `/uploads/receipts/${file.filename}`;
    try {
      if (!await mediaStore.put(webPath, file.buffer, file.mimetype, req.user ? effectiveTenantId(req) : null)) throw new Error("Could not persist the receipt.");
      delete file.buffer;
      res.once("finish", () => {
        if (res.statusCode >= 400) {
          db.run("DELETE FROM media_files WHERE web_path = ? AND NOT EXISTS (SELECT 1 FROM expense_receipts WHERE file_path = ?)", [webPath, webPath])
            .catch((e) => console.error("Receipt upload cleanup failed:", e.message));
        }
      });
      next();
    } catch (e) { next(e); }
  });
}

/** Resolves all descendant category IDs for a given parent category ID. */
async function getAllCategoryIds(tid, parentId) {
  const all = await db.all("SELECT id, parent_id FROM expense_categories WHERE madrasa_id = ?", [tid]);
  const ids = new Set([Number(parentId)]);
  let added = true;
  while (added) {
    added = false;
    for (const r of all) {
      if (r.parent_id != null && ids.has(Number(r.parent_id)) && !ids.has(Number(r.id))) {
        ids.add(Number(r.id));
        added = true;
      }
    }
  }
  return Array.from(ids);
}

/* ============================================================================
   EXPENSE CATEGORIES (CRUD + Hierarchy)
   ========================================================================== */

router.get("/categories", STAFF, requireStaffPermission("expenses.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const rows = await db.all(
    `SELECT c.*,
            p.name AS parent_name,
            (SELECT COUNT(*) FROM expenses e
              WHERE e.category_id = c.id AND e.madrasa_id = c.madrasa_id AND e.status = 'approved') AS expense_count,
            (SELECT COALESCE(SUM(e.amount_ngn), 0) FROM expenses e
              WHERE e.category_id = c.id AND e.madrasa_id = c.madrasa_id AND e.status = 'approved') AS total_spent_ngn
       FROM expense_categories c
       LEFT JOIN expense_categories p ON p.id = c.parent_id AND p.madrasa_id = c.madrasa_id
      WHERE c.madrasa_id = ?
      ORDER BY c.parent_id IS NOT NULL, c.name ASC`,
    [tid]
  );

  ok(res, { categories: rows });
}));

router.post("/categories", ADMIN, requireStaffPermission("expenses.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const name = cleanStr(req.body.name, 160);
  if (!name) return err(res, 400, "Category name is required.");

  let type = cleanStr(req.body.type, 20).toLowerCase();
  if (!CATEGORY_TYPES.has(type)) type = "operating";

  let parentId = toNum(req.body.parent_id, null);
  if (parentId === 0) parentId = null;
  if (parentId != null) {
    const parent = await db.get("SELECT id FROM expense_categories WHERE id = ? AND madrasa_id = ?", [parentId, tid]);
    if (!parent) return err(res, 400, "Parent category not found in this institution.");
  }

  const result = await db.run(
    "INSERT INTO expense_categories (madrasa_id, name, parent_id, type) VALUES (?, ?, ?, ?)",
    [tid, name, parentId, type]
  );
  const createdId = result && result.lastID ? result.lastID : (await db.get("SELECT MAX(id) AS id FROM expense_categories WHERE madrasa_id = ?", [tid])).id;
  const category = await db.get("SELECT * FROM expense_categories WHERE id = ? AND madrasa_id = ?", [createdId, tid]);

  logActivity(tid, req.user.id, "create_expense_category", `Created expense category: ${name}`);
  res.status(201).json({ ok: true, id: createdId, category });
}));

router.get("/categories/:id", STAFF, requireStaffPermission("expenses.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const category = await loadTenantRow(req, res, "expense_categories", req.params.id);
  if (!category) return;

  const parent = category.parent_id ? await db.get("SELECT id, name FROM expense_categories WHERE id = ? AND madrasa_id = ?", [category.parent_id, tid]) : null;
  ok(res, { category: Object.assign({}, category, { parent_name: parent ? parent.name : null }) });
}));

const updateCategoryHandler = asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const id = toNum(req.params.id, 0);
  const category = await loadTenantRow(req, res, "expense_categories", id);
  if (!category) return;

  const name = req.body.name !== undefined ? cleanStr(req.body.name, 160) : category.name;
  if (!name) return err(res, 400, "Category name cannot be empty.");

  let type = req.body.type !== undefined ? cleanStr(req.body.type, 20).toLowerCase() : category.type;
  if (!CATEGORY_TYPES.has(type)) type = category.type || "operating";

  let parentId = category.parent_id;
  if (req.body.parent_id !== undefined) {
    parentId = toNum(req.body.parent_id, null);
    if (parentId === 0) parentId = null;
    if (parentId != null) {
      if (parentId === id) return err(res, 400, "Category cannot be its own parent.");
      const parent = await db.get("SELECT id FROM expense_categories WHERE id = ? AND madrasa_id = ?", [parentId, tid]);
      if (!parent) return err(res, 400, "Parent category not found in this institution.");

      // Cycle check
      const descendants = await getAllCategoryIds(tid, id);
      if (descendants.includes(parentId)) {
        return err(res, 400, "Cannot set a child subcategory as parent (circular dependency).");
      }
    }
  }

  await db.run(
    "UPDATE expense_categories SET name = ?, parent_id = ?, type = ? WHERE id = ? AND madrasa_id = ?",
    [name, parentId, type, id, tid]
  );
  const updated = await db.get("SELECT * FROM expense_categories WHERE id = ? AND madrasa_id = ?", [id, tid]);

  logActivity(tid, req.user.id, "update_expense_category", `Updated expense category #${id} (${name})`);
  ok(res, { category: updated });
});

router.patch("/categories/:id", ADMIN, requireStaffPermission("expenses.create"), updateCategoryHandler);
router.put("/categories/:id", ADMIN, requireStaffPermission("expenses.create"), updateCategoryHandler);

router.delete("/categories/:id", ADMIN, requireStaffPermission("expenses.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const id = toNum(req.params.id, 0);
  const category = await loadTenantRow(req, res, "expense_categories", id);
  if (!category) return;

  // Check if active expenses exist in this category
  const expensesCheck = await db.get(
    "SELECT COUNT(*) AS c FROM expenses WHERE category_id = ? AND madrasa_id = ? AND status <> 'cancelled'",
    [id, tid]
  );
  if (expensesCheck && Number(expensesCheck.c) > 0) {
    return err(res, 400, `Cannot delete category "${category.name}" because it has ${expensesCheck.c} recorded expense(s).`);
  }

  // Detach children
  await db.run("UPDATE expense_categories SET parent_id = NULL WHERE parent_id = ? AND madrasa_id = ?", [id, tid]);
  // Remove budgets
  await db.run("DELETE FROM budgets WHERE category_id = ? AND madrasa_id = ?", [id, tid]);
  // Delete category
  await db.run("DELETE FROM expense_categories WHERE id = ? AND madrasa_id = ?", [id, tid]);

  logActivity(tid, req.user.id, "delete_expense_category", `Deleted expense category #${id} (${category.name})`);
  ok(res, { message: "Category deleted." });
}));

/* ============================================================================
   REPORTS (Must be declared before /:id routes)
   ========================================================================== */

router.get("/report", STAFF, requireStaffPermission("expenses.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const where = ["e.madrasa_id = ?"];
  const params = [tid];

  if (req.query.from) {
    where.push("e.payment_date >= ?");
    params.push(validDate(req.query.from) || "");
  }
  if (req.query.to) {
    where.push("e.payment_date <= ?");
    params.push(validDate(req.query.to) || "");
  }
  if (req.query.sessionId || req.query.session_id) {
    where.push("e.session_id = ?");
    params.push(toNum(req.query.sessionId || req.query.session_id, 0));
  }
  if (req.query.termId || req.query.term_id) {
    where.push("e.term_id = ?");
    params.push(toNum(req.query.termId || req.query.term_id, 0));
  }
  if (req.query.categoryId || req.query.category_id) {
    const catId = toNum(req.query.categoryId || req.query.category_id, 0);
    const catIds = await getAllCategoryIds(tid, catId);
    const ph = catIds.map(() => "?").join(",");
    where.push(`e.category_id IN (${ph})`);
    catIds.forEach((cid) => params.push(cid));
  }
  if (req.query.vendor) {
    where.push("LOWER(e.vendor) LIKE ?");
    params.push("%" + cleanStr(req.query.vendor, 180).toLowerCase() + "%");
  }
  if (req.query.method || req.query.payment_method) {
    where.push("e.payment_method = ?");
    params.push(cleanStr(req.query.method || req.query.payment_method, 40));
  }
  if (req.query.status) {
    const s = cleanStr(req.query.status, 20).toLowerCase();
    if (s !== "all") {
      where.push("e.status = ?");
      params.push(s);
    }
  } else {
    // Default to approved expenses for reports
    where.push("e.status = 'approved'");
  }

  const rows = await db.all(
    `SELECT e.*,
            c.name AS category_name,
            c.type AS category_type,
            s.label AS session_label,
            t.name_en AS term_name,
            u_a.full_name AS approved_by_name
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id AND c.madrasa_id = e.madrasa_id
       LEFT JOIN academic_sessions s ON s.id = e.session_id AND s.madrasa_id = e.madrasa_id
       LEFT JOIN terms t ON t.id = e.term_id AND t.madrasa_id = e.madrasa_id
       LEFT JOIN users u_a ON u_a.id = e.approved_by
      WHERE ${where.join(" AND ")}
      ORDER BY e.payment_date ASC, e.id ASC`,
    params
  );

  const totalSpent = rows.reduce((sum, r) => sum + n(r.amount_ngn), 0);
  const count = rows.length;

  // Group by category
  const catMap = {};
  rows.forEach((r) => {
    const cid = r.category_id || 0;
    const name = r.category_name || "Uncategorized";
    const type = r.category_type || "other";
    if (!catMap[cid]) catMap[cid] = { category_id: cid, category_name: name, type, amount: 0, count: 0 };
    catMap[cid].amount += n(r.amount_ngn);
    catMap[cid].count += 1;
  });
  const byCategory = Object.values(catMap).map((c) => ({
    category_id: c.category_id,
    category_name: c.category_name,
    type: c.type,
    amount: round2(c.amount),
    count: c.count,
    percent: totalSpent > 0 ? round2((c.amount / totalSpent) * 100) : 0,
  })).sort((a, b) => b.amount - a.amount);

  // Group by month
  const monthMap = {};
  rows.forEach((r) => {
    const m = (String(r.payment_date || "").slice(0, 7)) || "Unknown";
    if (!monthMap[m]) monthMap[m] = { month: m, label: monthLabel(m), amount: 0, count: 0 };
    monthMap[m].amount += n(r.amount_ngn);
    monthMap[m].count += 1;
  });
  const byMonth = Object.values(monthMap).map((m) => ({
    month: m.month,
    label: m.label,
    amount: round2(m.amount),
    count: m.count,
  })).sort((a, b) => a.month.localeCompare(b.month));

  // Group by vendor
  const vendorMap = {};
  rows.forEach((r) => {
    const v = cleanStr(r.vendor, 180) || "General / Unspecified";
    if (!vendorMap[v]) vendorMap[v] = { vendor: v, amount: 0, count: 0 };
    vendorMap[v].amount += n(r.amount_ngn);
    vendorMap[v].count += 1;
  });
  const byVendor = Object.values(vendorMap).map((v) => ({
    vendor: v.vendor,
    amount: round2(v.amount),
    count: v.count,
    percent: totalSpent > 0 ? round2((v.amount / totalSpent) * 100) : 0,
  })).sort((a, b) => b.amount - a.amount);

  // Group by payment method
  const methodMap = {};
  rows.forEach((r) => {
    const m = r.payment_method || "cash";
    if (!methodMap[m]) methodMap[m] = { method: m, amount: 0, count: 0 };
    methodMap[m].amount += n(r.amount_ngn);
    methodMap[m].count += 1;
  });
  const byPaymentMethod = Object.values(methodMap).map((m) => ({
    method: m.method,
    amount: round2(m.amount),
    count: m.count,
  }));

  // Group by status
  const statusMap = {};
  rows.forEach((r) => {
    const s = r.status || "draft";
    if (!statusMap[s]) statusMap[s] = { status: s, amount: 0, count: 0 };
    statusMap[s].amount += n(r.amount_ngn);
    statusMap[s].count += 1;
  });
  const byStatus = Object.values(statusMap).map((s) => ({
    status: s.status,
    amount: round2(s.amount),
    count: s.count,
  }));

  ok(res, {
    summary: {
      total_spent: round2(totalSpent),
      totalSpent: round2(totalSpent),
      expense_count: count,
      expenseCount: count,
      average_expense: count > 0 ? round2(totalSpent / count) : 0,
    },
    byCategory,
    byMonth,
    byVendor,
    byPaymentMethod,
    byStatus,
    expenses: rows,
  });
}));

router.get("/report.csv", STAFF, requireStaffPermission("expenses.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const where = ["e.madrasa_id = ?"];
  const params = [tid];

  if (req.query.from) {
    where.push("e.payment_date >= ?");
    params.push(validDate(req.query.from) || "");
  }
  if (req.query.to) {
    where.push("e.payment_date <= ?");
    params.push(validDate(req.query.to) || "");
  }
  if (req.query.sessionId || req.query.session_id) {
    where.push("e.session_id = ?");
    params.push(toNum(req.query.sessionId || req.query.session_id, 0));
  }
  if (req.query.termId || req.query.term_id) {
    where.push("e.term_id = ?");
    params.push(toNum(req.query.termId || req.query.term_id, 0));
  }
  if (req.query.categoryId || req.query.category_id) {
    const catId = toNum(req.query.categoryId || req.query.category_id, 0);
    const catIds = await getAllCategoryIds(tid, catId);
    const ph = catIds.map(() => "?").join(",");
    where.push(`e.category_id IN (${ph})`);
    catIds.forEach((cid) => params.push(cid));
  }
  if (req.query.vendor) {
    where.push("LOWER(e.vendor) LIKE ?");
    params.push("%" + cleanStr(req.query.vendor, 180).toLowerCase() + "%");
  }
  if (req.query.status) {
    const s = cleanStr(req.query.status, 20).toLowerCase();
    if (s !== "all") {
      where.push("e.status = ?");
      params.push(s);
    }
  } else {
    where.push("e.status = 'approved'");
  }

  const rows = await db.all(
    `SELECT e.*,
            c.name AS category_name,
            c.type AS category_type,
            s.label AS session_label,
            t.name_en AS term_name,
            u_a.full_name AS approved_by_name
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id AND c.madrasa_id = e.madrasa_id
       LEFT JOIN academic_sessions s ON s.id = e.session_id AND s.madrasa_id = e.madrasa_id
       LEFT JOIN terms t ON t.id = e.term_id AND t.madrasa_id = e.madrasa_id
       LEFT JOIN users u_a ON u_a.id = e.approved_by
      WHERE ${where.join(" AND ")}
      ORDER BY e.payment_date ASC, e.id ASC`,
    params
  );

  const filename = `expense-report-${today()}.csv`;
  const text = csv.toCsv(rows, [
    { label: "Date", key: "payment_date" },
    { label: "Session", value: (r) => r.session_label || "" },
    { label: "Term", value: (r) => r.term_name || "" },
    { label: "Category", value: (r) => r.category_name || "" },
    { label: "Category Type", value: (r) => r.category_type || "" },
    { label: "Vendor", key: "vendor" },
    { label: "Description", key: "description" },
    { label: "Payment Method", key: "payment_method" },
    { label: "Amount (NGN)", value: (r) => csv.num(r.amount_ngn, 2) },
    { label: "Status", key: "status" },
    { label: "Approved By", value: (r) => r.approved_by_name || "" },
    { label: "Receipt Path", key: "receipt_path" },
  ]);

  csv.sendCsv(res, filename, text);
}));

/* ============================================================================
   EXPENSES (Draft, List, Detail, Approve, Reject, Receipt, Delete)
   ========================================================================== */

router.post("/", STAFF, requireStaffPermission("expenses.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const categoryId = toNum(req.body.category_id || req.body.categoryId, 0);
  if (!categoryId) return err(res, 400, "Category is required.");

  const category = await db.get("SELECT id, name FROM expense_categories WHERE id = ? AND madrasa_id = ?", [categoryId, tid]);
  if (!category) return err(res, 400, "Category not found in this institution.");

  const amountNgn = round2(req.body.amount_ngn || req.body.amount);
  if (amountNgn <= 0) return err(res, 400, "Expense amount must be greater than zero.");

  const paymentDate = validDate(req.body.payment_date || req.body.paymentDate) || today();
  let paymentMethod = cleanStr(req.body.payment_method || req.body.paymentMethod, 40).toLowerCase();
  if (!PAYMENT_METHODS.has(paymentMethod)) paymentMethod = "cash";

  const vendor = cleanStr(req.body.vendor, 180) || "";
  const description = cleanStr(req.body.description, 2000) || "";
  const receiptPath = cleanStr(req.body.receipt_path || req.body.receiptPath, 255) || "";

  let sessionId = toNum(req.body.session_id || req.body.sessionId, 0);
  if (!sessionId) {
    const curSession = await db.get("SELECT id FROM academic_sessions WHERE madrasa_id = ? AND is_current = 1 LIMIT 1", [tid]);
    sessionId = curSession ? curSession.id : null;
  }

  let termId = toNum(req.body.term_id || req.body.termId, 0);
  if (!termId && sessionId) {
    const curTerm = await db.get("SELECT id FROM terms WHERE madrasa_id = ? AND session_id = ? ORDER BY position ASC LIMIT 1", [tid, sessionId]);
    termId = curTerm ? curTerm.id : null;
  }

  // Expenses are created as draft by default
  const status = "draft";
  const createdBy = req.user.id;

  const result = await db.run(
    `INSERT INTO expenses (
       madrasa_id, category_id, session_id, term_id, amount_ngn, vendor,
       description, receipt_path, payment_date, payment_method, approved_by,
       status, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [tid, categoryId, sessionId, termId, amountNgn, vendor, description, receiptPath, paymentDate, paymentMethod, status, createdBy]
  );

  const createdId = result && result.lastID ? result.lastID : (await db.get("SELECT MAX(id) AS id FROM expenses WHERE madrasa_id = ?", [tid])).id;
  const expense = await db.get(
    `SELECT e.*, c.name AS category_name, c.type AS category_type
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id
      WHERE e.id = ? AND e.madrasa_id = ?`,
    [createdId, tid]
  );

  logActivity(tid, req.user.id, "create_expense", `Created draft expense #${createdId} of ₦${amountNgn.toLocaleString()}`);
  res.status(201).json({ ok: true, id: createdId, expense });
}));

router.get("/", STAFF, requireStaffPermission("expenses.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const where = ["e.madrasa_id = ?"];
  const params = [tid];

  if (req.query.sessionId || req.query.session_id) {
    where.push("e.session_id = ?");
    params.push(toNum(req.query.sessionId || req.query.session_id, 0));
  }
  if (req.query.termId || req.query.term_id) {
    where.push("e.term_id = ?");
    params.push(toNum(req.query.termId || req.query.term_id, 0));
  }
  if (req.query.categoryId || req.query.category_id) {
    const catId = toNum(req.query.categoryId || req.query.category_id, 0);
    const catIds = await getAllCategoryIds(tid, catId);
    const ph = catIds.map(() => "?").join(",");
    where.push(`e.category_id IN (${ph})`);
    catIds.forEach((cid) => params.push(cid));
  }
  if (req.query.status) {
    const s = cleanStr(req.query.status, 20).toLowerCase();
    if (s !== "all") {
      where.push("e.status = ?");
      params.push(s);
    }
  } else {
    // Default excludes cancelled
    where.push("e.status <> 'cancelled'");
  }
  if (req.query.from || req.query.startDate || req.query.dateFrom) {
    where.push("e.payment_date >= ?");
    params.push(validDate(req.query.from || req.query.startDate || req.query.dateFrom) || "");
  }
  if (req.query.to || req.query.endDate || req.query.dateTo) {
    where.push("e.payment_date <= ?");
    params.push(validDate(req.query.to || req.query.endDate || req.query.dateTo) || "");
  }
  if (req.query.vendor) {
    where.push("LOWER(e.vendor) LIKE ?");
    params.push("%" + cleanStr(req.query.vendor, 180).toLowerCase() + "%");
  }
  if (req.query.method || req.query.payment_method) {
    where.push("e.payment_method = ?");
    params.push(cleanStr(req.query.method || req.query.payment_method, 40));
  }
  if (req.query.search) {
    const search = "%" + cleanStr(req.query.search, 100).toLowerCase() + "%";
    where.push("(LOWER(e.vendor) LIKE ? OR LOWER(e.description) LIKE ? OR LOWER(c.name) LIKE ?)");
    params.push(search, search, search);
  }

  const rows = await db.all(
    `SELECT e.*,
            c.name AS category_name,
            c.type AS category_type,
            s.label AS session_label,
            t.name_en AS term_name,
            u_c.full_name AS created_by_name,
            u_a.full_name AS approved_by_name,
            (SELECT COUNT(*) FROM expense_receipts er WHERE er.expense_id = e.id) AS receipt_count
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id AND c.madrasa_id = e.madrasa_id
       LEFT JOIN academic_sessions s ON s.id = e.session_id AND s.madrasa_id = e.madrasa_id
       LEFT JOIN terms t ON t.id = e.term_id AND t.madrasa_id = e.madrasa_id
       LEFT JOIN users u_c ON u_c.id = e.created_by
       LEFT JOIN users u_a ON u_a.id = e.approved_by
      WHERE ${where.join(" AND ")}
      ORDER BY e.payment_date DESC, e.id DESC`,
    params
  );

  const totalAmount = rows.reduce((acc, r) => acc + n(r.amount_ngn), 0);
  const approvedAmount = rows.filter((r) => r.status === "approved").reduce((acc, r) => acc + n(r.amount_ngn), 0);
  const draftAmount = rows.filter((r) => r.status === "draft").reduce((acc, r) => acc + n(r.amount_ngn), 0);
  const rejectedAmount = rows.filter((r) => r.status === "rejected").reduce((acc, r) => acc + n(r.amount_ngn), 0);

  ok(res, {
    expenses: rows,
    total: rows.length,
    summary: {
      total_amount: round2(totalAmount),
      approved_amount: round2(approvedAmount),
      draft_amount: round2(draftAmount),
      rejected_amount: round2(rejectedAmount),
      count: rows.length,
    },
  });
}));

router.get("/:id", STAFF, requireStaffPermission("expenses.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const id = toNum(req.params.id, 0);
  const expense = await loadTenantRow(req, res, "expenses", id);
  if (!expense) return;

  const [detailed, receipts] = await Promise.all([
    db.get(
      `SELECT e.*,
              c.name AS category_name,
              c.type AS category_type,
              s.label AS session_label,
              t.name_en AS term_name,
              u_c.full_name AS created_by_name,
              u_a.full_name AS approved_by_name
         FROM expenses e
         LEFT JOIN expense_categories c ON c.id = e.category_id AND c.madrasa_id = e.madrasa_id
         LEFT JOIN academic_sessions s ON s.id = e.session_id AND s.madrasa_id = e.madrasa_id
         LEFT JOIN terms t ON t.id = e.term_id AND t.madrasa_id = e.madrasa_id
         LEFT JOIN users u_c ON u_c.id = e.created_by
         LEFT JOIN users u_a ON u_a.id = e.approved_by
        WHERE e.id = ? AND e.madrasa_id = ?`,
      [id, tid]
    ),
    db.all("SELECT * FROM expense_receipts WHERE expense_id = ? ORDER BY id DESC", [id]),
  ]);

  ok(res, { expense: detailed, receipts });
}));

const updateExpenseHandler = asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const id = toNum(req.params.id, 0);
  const expense = await loadTenantRow(req, res, "expenses", id);
  if (!expense) return;

  if (expense.status === "cancelled") {
    return err(res, 400, "Cannot edit a cancelled expense.");
  }

  let categoryId = expense.category_id;
  if (req.body.category_id || req.body.categoryId) {
    categoryId = toNum(req.body.category_id || req.body.categoryId, 0);
    const cat = await db.get("SELECT id FROM expense_categories WHERE id = ? AND madrasa_id = ?", [categoryId, tid]);
    if (!cat) return err(res, 400, "Category not found.");
  }

  const amountNgn = (req.body.amount_ngn !== undefined || req.body.amount !== undefined)
    ? round2(req.body.amount_ngn !== undefined ? req.body.amount_ngn : req.body.amount)
    : Number(expense.amount_ngn);
  if (amountNgn <= 0) return err(res, 400, "Amount must be greater than zero.");

  const vendor = req.body.vendor !== undefined ? cleanStr(req.body.vendor, 180) : expense.vendor;
  const description = req.body.description !== undefined ? cleanStr(req.body.description, 2000) : expense.description;
  const paymentDate = req.body.payment_date ? validDate(req.body.payment_date) || expense.payment_date : expense.payment_date;

  let paymentMethod = expense.payment_method;
  if (req.body.payment_method || req.body.paymentMethod) {
    const pm = cleanStr(req.body.payment_method || req.body.paymentMethod, 40).toLowerCase();
    if (PAYMENT_METHODS.has(pm)) paymentMethod = pm;
  }

  const sessionId = req.body.session_id !== undefined ? toNum(req.body.session_id, null) : expense.session_id;
  const termId = req.body.term_id !== undefined ? toNum(req.body.term_id, null) : expense.term_id;
  const receiptPath = req.body.receipt_path !== undefined ? cleanStr(req.body.receipt_path, 255) : expense.receipt_path;

  await db.run(
    `UPDATE expenses SET
       category_id = ?, session_id = ?, term_id = ?, amount_ngn = ?,
       vendor = ?, description = ?, payment_date = ?, payment_method = ?,
       receipt_path = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND madrasa_id = ?`,
    [categoryId, sessionId, termId, amountNgn, vendor, description, paymentDate, paymentMethod, receiptPath, id, tid]
  );

  const updated = await db.get("SELECT * FROM expenses WHERE id = ? AND madrasa_id = ?", [id, tid]);
  logActivity(tid, req.user.id, "update_expense", `Updated expense #${id}`);
  ok(res, { expense: updated });
});

router.patch("/:id", ADMIN, requireStaffPermission("expenses.create"), updateExpenseHandler);
router.put("/:id", ADMIN, requireStaffPermission("expenses.create"), updateExpenseHandler);

/* Approve */
const approveExpenseHandler = asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const id = toNum(req.params.id, 0);
  const expense = await loadTenantRow(req, res, "expenses", id);
  if (!expense) return;

  if (expense.status === "cancelled") {
    return err(res, 400, "Cannot approve a cancelled expense.");
  }

  await db.run(
    "UPDATE expenses SET status = 'approved', approved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
    [req.user.id, id, tid]
  );

  const updated = await db.get(
    `SELECT e.*, c.name AS category_name, u_a.full_name AS approved_by_name
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id
       LEFT JOIN users u_a ON u_a.id = e.approved_by
      WHERE e.id = ? AND e.madrasa_id = ?`,
    [id, tid]
  );

  logActivity(tid, req.user.id, "approve_expense", `Approved expense #${id} of ₦${Number(expense.amount_ngn).toLocaleString()}`);
  ok(res, { expense: updated });
});

router.patch("/:id/approve", ADMIN, requireStaffPermission("expenses.create"), approveExpenseHandler);
router.post("/:id/approve", ADMIN, requireStaffPermission("expenses.create"), approveExpenseHandler);

/* Reject */
const rejectExpenseHandler = asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const id = toNum(req.params.id, 0);
  const expense = await loadTenantRow(req, res, "expenses", id);
  if (!expense) return;

  if (expense.status === "cancelled") {
    return err(res, 400, "Cannot reject a cancelled expense.");
  }

  await db.run(
    "UPDATE expenses SET status = 'rejected', approved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
    [req.user.id, id, tid]
  );

  const updated = await db.get(
    `SELECT e.*, c.name AS category_name, u_a.full_name AS approved_by_name
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id
       LEFT JOIN users u_a ON u_a.id = e.approved_by
      WHERE e.id = ? AND e.madrasa_id = ?`,
    [id, tid]
  );

  logActivity(tid, req.user.id, "reject_expense", `Rejected expense #${id}`);
  ok(res, { expense: updated });
});

router.patch("/:id/reject", ADMIN, requireStaffPermission("expenses.create"), rejectExpenseHandler);
router.post("/:id/reject", ADMIN, requireStaffPermission("expenses.create"), rejectExpenseHandler);

/* Receipt Upload */
router.post("/:id/receipt", STAFF, uploadReceiptMiddleware, requireStaffPermission("expenses.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const id = toNum(req.params.id, 0);
  const expense = await loadTenantRow(req, res, "expenses", id);
  if (!expense) return;

  if (!req.file) {
    return err(res, 400, "No receipt file was uploaded.");
  }

  const filePath = `/uploads/receipts/${req.file.filename}`;
  const originalName = cleanStr(req.file.originalname, 255) || "receipt";

  const result = await db.run(
    "INSERT INTO expense_receipts (expense_id, file_path, original_name) VALUES (?, ?, ?)",
    [id, filePath, originalName]
  );
  const receiptId = result && result.lastID ? result.lastID : (await db.get("SELECT MAX(id) AS id FROM expense_receipts WHERE expense_id = ?", [id])).id;

  // Update primary receipt path on expense if not already set or updating to latest
  await db.run(
    "UPDATE expenses SET receipt_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
    [filePath, id, tid]
  );

  const receipt = await db.get("SELECT * FROM expense_receipts WHERE id = ?", [receiptId]);
  logActivity(tid, req.user.id, "upload_expense_receipt", `Uploaded receipt for expense #${id}`);

  ok(res, { receipt, receipt_path: filePath, file_path: filePath });
}));

/* Soft-delete / Cancel */
router.delete("/:id", ADMIN, requireStaffPermission("expenses.create"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const id = toNum(req.params.id, 0);
  const expense = await loadTenantRow(req, res, "expenses", id);
  if (!expense) return;

  await db.run(
    "UPDATE expenses SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
    [id, tid]
  );

  logActivity(tid, req.user.id, "cancel_expense", `Cancelled expense #${id}`);
  ok(res, { message: "Expense cancelled." });
}));

/* ============================================================================
   BUDGET (Per Session & Category Upsert + Summary)
   ========================================================================== */

const setBudgetHandler = asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  const sessionId = toNum(req.body.session_id || req.body.sessionId, 0);
  if (!sessionId) return err(res, 400, "Session is required for budget allocation.");

  const session = await db.get("SELECT id, label FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sessionId, tid]);
  if (!session) return err(res, 400, "Academic session not found in this institution.");

  const categoryId = toNum(req.body.category_id || req.body.categoryId, 0);
  if (!categoryId) return err(res, 400, "Category is required for budget allocation.");

  const category = await db.get("SELECT id, name FROM expense_categories WHERE id = ? AND madrasa_id = ?", [categoryId, tid]);
  if (!category) return err(res, 400, "Expense category not found in this institution.");

  const budgetedNgn = round2(req.body.budgeted_ngn !== undefined ? req.body.budgeted_ngn : req.body.amount !== undefined ? req.body.amount : req.body.budgeted);
  if (budgetedNgn < 0) return err(res, 400, "Budgeted amount cannot be negative.");

  const notes = cleanStr(req.body.notes, 1000) || "";

  const existing = await db.get(
    "SELECT id FROM budgets WHERE madrasa_id = ? AND session_id = ? AND category_id = ?",
    [tid, sessionId, categoryId]
  );

  let budgetId;
  if (existing) {
    await db.run(
      "UPDATE budgets SET budgeted_ngn = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
      [budgetedNgn, notes, existing.id, tid]
    );
    budgetId = existing.id;
  } else {
    const result = await db.run(
      "INSERT INTO budgets (madrasa_id, session_id, category_id, budgeted_ngn, notes) VALUES (?, ?, ?, ?, ?)",
      [tid, sessionId, categoryId, budgetedNgn, notes]
    );
    budgetId = result && result.lastID ? result.lastID : (await db.get("SELECT MAX(id) AS id FROM budgets WHERE madrasa_id = ?", [tid])).id;
  }

  const budget = await db.get(
    `SELECT b.*, c.name AS category_name, c.type AS category_type, s.label AS session_label
       FROM budgets b
       JOIN expense_categories c ON c.id = b.category_id
       JOIN academic_sessions s ON s.id = b.session_id
      WHERE b.id = ? AND b.madrasa_id = ?`,
    [budgetId, tid]
  );

  logActivity(tid, req.user.id, "set_budget", `Set budget of ₦${budgetedNgn.toLocaleString()} for ${category.name} (${session.label})`);
  ok(res, { budget });
});

const getBudgetSummaryHandler = asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res);
  if (tid == null) return;

  let sessionId = toNum(req.query.sessionId || req.query.session_id, 0);
  let session = null;
  if (sessionId) {
    session = await db.get("SELECT id, label, is_current FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sessionId, tid]);
  }
  if (!session) {
    session = await db.get(
      "SELECT id, label, is_current FROM academic_sessions WHERE madrasa_id = ? ORDER BY is_current DESC, id DESC LIMIT 1",
      [tid]
    );
  }

  sessionId = session ? Number(session.id) : 0;

  const categories = await db.all(
    `SELECT c.id AS category_id,
            c.id,
            c.name AS category_name,
            c.name,
            c.type,
            c.parent_id,
            p.name AS parent_name,
            COALESCE(b.budgeted_ngn, 0) AS budgeted_ngn,
            b.notes,
            b.id AS budget_id
       FROM expense_categories c
       LEFT JOIN expense_categories p ON p.id = c.parent_id AND p.madrasa_id = c.madrasa_id
       LEFT JOIN budgets b ON b.category_id = c.id AND b.session_id = ? AND b.madrasa_id = c.madrasa_id
      WHERE c.madrasa_id = ?
      ORDER BY c.parent_id IS NOT NULL, c.name ASC`,
    [sessionId, tid]
  );

  const spentRows = sessionId ? await db.all(
    `SELECT category_id, COALESCE(SUM(amount_ngn), 0) AS spent_ngn
       FROM expenses
      WHERE madrasa_id = ? AND session_id = ? AND status = 'approved'
      GROUP BY category_id`,
    [tid, sessionId]
  ) : [];

  const spentMap = new Map();
  spentRows.forEach((r) => { spentMap.set(Number(r.category_id), n(r.spent_ngn)); });

  const computedCategories = categories.map((cat) => {
    const budgeted = round2(cat.budgeted_ngn);
    const spent = round2(spentMap.get(Number(cat.category_id)) || 0);
    const remaining = round2(budgeted - spent);
    const percentUsed = budgeted > 0 ? Math.round((spent / budgeted) * 1000) / 10 : 0;

    return {
      category_id: Number(cat.category_id),
      id: Number(cat.id),
      category_name: cat.category_name,
      name: cat.name,
      type: cat.type || "operating",
      parent_id: cat.parent_id ? Number(cat.parent_id) : null,
      parent_name: cat.parent_name || null,
      budgeted_ngn: budgeted,
      spent_ngn: spent,
      remaining_ngn: remaining,
      percent_used: percentUsed,
      notes: cat.notes || "",
      budget_id: cat.budget_id || null,
    };
  });

  const totalBudgeted = round2(computedCategories.reduce((acc, c) => acc + c.budgeted_ngn, 0));
  const totalSpent = round2(computedCategories.reduce((acc, c) => acc + c.spent_ngn, 0));
  const totalRemaining = round2(totalBudgeted - totalSpent);
  const totalPercentUsed = totalBudgeted > 0 ? Math.round((totalSpent / totalBudgeted) * 1000) / 10 : 0;

  ok(res, {
    session: session ? { id: session.id, label: session.label, is_current: session.is_current } : null,
    categories: computedCategories,
    totals: {
      budgeted_ngn: totalBudgeted,
      spent_ngn: totalSpent,
      remaining_ngn: totalRemaining,
      percent_used: totalPercentUsed,
    },
  });
});

// Mount budget handlers on both router (/api/expenses/budget) and budgetRouter (/api/budget)
budgetRouter.post("/", ADMIN, requireStaffPermission("expenses.create"), setBudgetHandler);
budgetRouter.get("/summary", STAFF, requireStaffPermission("expenses.view"), getBudgetSummaryHandler);
budgetRouter.get("/", STAFF, requireStaffPermission("expenses.view"), getBudgetSummaryHandler);

router.post("/budget", ADMIN, requireStaffPermission("expenses.create"), setBudgetHandler);
router.get("/budget/summary", STAFF, requireStaffPermission("expenses.view"), getBudgetSummaryHandler);
router.get("/budget", STAFF, requireStaffPermission("expenses.view"), getBudgetSummaryHandler);

module.exports = {
  router,
  budgetRouter,
};
