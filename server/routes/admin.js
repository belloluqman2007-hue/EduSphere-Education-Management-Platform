"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — cross-cutting Admin endpoints
   ----------------------------------------------------------------------------
   Four capabilities that span every existing module and therefore do not
   belong inside any one of them. They add NO new data model: each one reads
   the tables the existing modules already own.

     GET    /api/admin/permissions          resolved permissions for the caller
     GET    /api/admin/permissions/catalogue the permission catalogue + defaults
     GET    /api/admin/permissions/users    per-user overrides in this tenant
     PUT    /api/admin/permissions/users/:id  set one user's overrides
     GET    /api/admin/audit                audit log (search/filter/paginate)
     GET    /api/admin/audit/facets         filter menus for the audit log
     GET    /api/admin/needs-attention      actionable dashboard items
     GET    /api/admin/search               global admin search

   Tenant safety: every query below is scoped by a madrasa id derived from the
   authenticated session (effectiveTenantId), never from the request body.
   ========================================================================== */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum } = require("../util");
const { requireAuth, requireTenant } = require("../middleware/auth");
const { effectiveTenantId } = require("../middleware/tenant");
const permissions = require("../services/permissions");
const audit = require("../services/audit");

const router = express.Router();
router.use(requireAuth, requireTenant);

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) { err(res, 400, "Institution context required."); return null; }
  return tid;
}

/* ========================== PERMISSIONS ================================= */

/** The caller's own resolved permissions. Used by the SPA to hide actions it
 *  knows will be refused — the server remains the authority. */
router.get("/permissions", asyncHandler(async (req, res) => {
  const held = await permissions.loadPermissions(req);
  ok(res, {
    role: req.user.role,
    permissions: Array.from(held).sort(),
    roleDefaults: permissions.roleDefaults(req.user.role),
  });
}));

/** The catalogue and per-role defaults, for the Roles & Permissions screen. */
router.get("/permissions/catalogue", permissions.requirePermission("roles.manage"), asyncHandler(async (req, res) => {
  ok(res, {
    catalogue: permissions.CATALOGUE,
    roleDefaults: permissions.ROLE_DEFAULTS,
    roles: [
      { key: "madrasa_admin", label: "Administrator", description: "Full control of this institution." },
      { key: "teacher", label: "Teacher", description: "Assigned classes and subjects: rosters, attendance, lessons, assignments and result entry." },
      { key: "student", label: "Student", description: "Own records only." },
      { key: "parent", label: "Parent", description: "Linked children only." },
    ],
  });
}));

/** Detects which recommended staff-role template a user's effective
    permission set matches exactly — grants and revokes together. Returns
    null when the profile has been customised or no template applies. */
function matchingTemplate(role, effective) {
  if (role !== "teacher") return null;
  const held = new Set(effective);
  return ROLE_TEMPLATES.find((t) => {
    if (held.size !== t.permissions.length) return false;
    return t.permissions.every((p) => held.has(p));
  }) || null;
}

/** Staff accounts in THIS institution with their effective permissions. */
router.get("/permissions/users", permissions.requirePermission("roles.manage"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const users = await db.all(
    `SELECT id, username, role, full_name, is_active
       FROM users
      WHERE madrasa_id = ? AND role IN ('madrasa_admin','teacher')
      ORDER BY role, full_name`,
    [tid]
  );
  const overrides = await db.all(
    "SELECT user_id, permission, effect FROM user_permissions WHERE madrasa_id = ?",
    [tid]
  );
  const byUser = new Map();
  for (const row of overrides) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push({ permission: row.permission, effect: row.effect });
  }
  ok(res, {
    users: users.map((u) => {
      const own = byUser.get(u.id) || [];
      const set = new Set(permissions.roleDefaults(u.role));
      for (const o of own) { if (o.effect === "revoke") set.delete(o.permission); else set.add(o.permission); }
      const template = matchingTemplate(u.role, set);
      return {
        id: u.id, username: u.username, role: u.role,
        fullName: u.full_name, isActive: Number(u.is_active) === 1,
        overrides: own,
        effective: Array.from(set).sort(),
        template: template ? template.key : null,
        templateLabel: template ? template.label : null,
      };
    }),
  });
}));

/**
 * Replaces one user's permission overrides.
 * Body: { granted: ["students.export"], revoked: ["students.delete"] }
 *
 * Guards:
 *   • the target user must belong to the caller's institution,
 *   • only staff roles can hold admin permissions,
 *   • an administrator cannot edit their own permissions (no self-escalation
 *     and, just as importantly, no locking yourself out),
 *   • every change is audited with before/after snapshots.
 */
router.put("/permissions/users/:id", permissions.requirePermission("roles.manage"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const userId = toNum(req.params.id, 0);
  const target = await db.get("SELECT id, username, role, full_name FROM users WHERE id = ? AND madrasa_id = ?", [userId, tid]);
  if (!target) return err(res, 404, "Not found.");
  if (!["madrasa_admin", "teacher"].includes(target.role)) {
    return err(res, 400, "Only administrator and teacher accounts can hold admin permissions.");
  }
  if (Number(userId) === Number(req.user.id)) {
    return err(res, 400, "You cannot change your own permissions. Ask another administrator.");
  }

  const body = req.body || {};
  const granted = (Array.isArray(body.granted) ? body.granted : []).filter(permissions.isPermission);
  const revoked = (Array.isArray(body.revoked) ? body.revoked : []).filter(permissions.isPermission);
  // A permission cannot be granted and revoked at once; revoke wins.
  const grantSet = new Set(granted.filter((p) => !revoked.includes(p)));

  const before = await db.all(
    "SELECT permission, effect FROM user_permissions WHERE madrasa_id = ? AND user_id = ?",
    [tid, userId]
  );

  // Replacing the whole override set is a multi-step write: do it in one
  // transaction so a failure can never leave a half-applied policy.
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM user_permissions WHERE madrasa_id = ? AND user_id = ?", [tid, userId]);
    for (const p of grantSet) {
      await tx.run(
        "INSERT INTO user_permissions (madrasa_id, user_id, permission, effect, granted_by) VALUES (?,?,?,'grant',?)",
        [tid, userId, p, req.user.id]
      );
    }
    for (const p of revoked) {
      await tx.run(
        "INSERT INTO user_permissions (madrasa_id, user_id, permission, effect, granted_by) VALUES (?,?,?,'revoke',?)",
        [tid, userId, p, req.user.id]
      );
    }
  });

  await audit.record(req, {
    action: "permissions.update", module: "settings", entity: "user", entityId: userId,
    before: { overrides: before },
    after: { overrides: [...grantSet].map((p) => ({ permission: p, effect: "grant" }))
      .concat(revoked.map((p) => ({ permission: p, effect: "revoke" }))) },
    meta: { targetUser: target.username, targetRole: target.role },
  });

  ok(res, { ok: true, granted: Array.from(grantSet), revoked });
}));

/* ============================ ROLE TEMPLATES ============================= */
/*
 * Recommended staff-role templates. A staff ACCOUNT keeps its teacher role
 * (the account type the platform already understands); applying a template
 * replaces its permission overrides so the account behaves as, say, a
 * librarian — with exactly the permissions that role needs and none of the
 * teacher defaults that it does not. Administrators can then fine-tune the
 * result in the same Roles & Permissions screen.
 */
const ROLE_TEMPLATES = [
  {
    key: "accountant", label: "Accountant",
    description: "Fees, payments, receipts, expenses, budgets and financial reports.",
    permissions: ["dashboard.view", "students.view", "fees.view", "fees.create", "payments.view", "payments.create", "payments.verify", "expenses.view", "expenses.create", "finance.reports"],
  },
  {
    key: "librarian", label: "Librarian",
    description: "Library catalogue, copies, borrowing, returns and library reports.",
    permissions: ["dashboard.view", "students.view", "teachers.view", "library.view", "library.manage", "library.issue", "library.return"],
  },
  {
    key: "admissions_officer", label: "Admissions Officer",
    description: "Admissions, applications, applicant communication and student registration.",
    permissions: ["dashboard.view", "students.view", "students.create", "admissions.view", "admissions.create", "communication.view", "communication.send"],
  },
  {
    key: "academic_officer", label: "Academic Officer",
    description: "Classes, subjects, exams, results, report cards and the academic calendar.",
    permissions: ["dashboard.view", "students.view", "teachers.view", "classes.view", "classes.create", "classes.edit", "lessons.view", "assignments.view", "exams.view", "exams.create", "questionbank.view", "questionbank.manage", "results.enter", "results.approve", "results.publish", "report_cards.view", "report_cards.generate", "calendar.view", "calendar.manage"],
  },
  {
    key: "hr_officer", label: "HR Officer",
    description: "Staff records, leave, payroll and payslips.",
    permissions: ["dashboard.view", "teachers.view", "teachers.create", "teachers.edit", "staff_leave.view", "staff_leave.approve", "payroll.view", "payroll.create", "payroll.process", "payroll.approve", "payslips.view"],
  },
  {
    key: "receptionist", label: "Receptionist",
    description: "Student and parent lookup, admissions intake and front-desk communication.",
    permissions: ["dashboard.view", "students.view", "admissions.view", "admissions.create", "communication.view", "communication.send"],
  },
];

router.get("/permissions/templates", permissions.requirePermission("roles.manage"), asyncHandler(async (req, res) => {
  ok(res, { templates: ROLE_TEMPLATES });
}));

/** Applies a template to a TEACHER (staff) account in this institution. */
router.post("/permissions/users/:id/template", permissions.requirePermission("roles.manage"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const userId = toNum(req.params.id, 0);
  const target = await db.get("SELECT id, username, role, full_name FROM users WHERE id = ? AND madrasa_id = ?", [userId, tid]);
  if (!target) return err(res, 404, "Not found.");
  // Templates shape STAFF accounts. A madrasa_admin already holds everything;
  // the only sensible operation on one is a manual override.
  if (target.role !== "teacher") {
    return err(res, 400, "Role templates apply to staff accounts (teachers). Adjust administrators manually.");
  }
  if (Number(userId) === Number(req.user.id)) {
    return err(res, 400, "You cannot change your own permissions. Ask another administrator.");
  }
  const templateKey = cleanStr(req.body && req.body.template, 60);
  const template = ROLE_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) return err(res, 400, "Unknown role template.");

  // granted: exactly the template's permissions.
  // revoked: every TEACHER default the template does not include, so e.g. a
  // librarian cannot still export students or grade assignments.
  const grantSet = new Set(template.permissions);
  const teacherDefaults = permissions.roleDefaults("teacher");
  const revoked = teacherDefaults.filter((p) => !grantSet.has(p));

  const before = await db.all("SELECT permission, effect FROM user_permissions WHERE madrasa_id = ? AND user_id = ?", [tid, userId]);
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM user_permissions WHERE madrasa_id = ? AND user_id = ?", [tid, userId]);
    for (const p of grantSet) {
      await tx.run("INSERT INTO user_permissions (madrasa_id, user_id, permission, effect, granted_by) VALUES (?,?,?,'grant',?)", [tid, userId, p, req.user.id]);
    }
    for (const p of revoked) {
      await tx.run("INSERT INTO user_permissions (madrasa_id, user_id, permission, effect, granted_by) VALUES (?,?,?,'revoke',?)", [tid, userId, p, req.user.id]);
    }
  });
  await audit.record(req, {
    action: "permissions.template", module: "settings", entity: "user", entityId: userId,
    before: { overrides: before },
    after: { template: template.key, granted: [...grantSet], revoked },
    meta: { targetUser: target.username },
  });
  ok(res, { ok: true, template: template.key, granted: [...grantSet], revoked });
}));

/* ============================== AUDIT LOG =============================== */

router.get("/audit", permissions.requirePermission("audit.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const result = await audit.search(tid, {
    search: cleanStr(req.query.search, 100),
    module: cleanStr(req.query.module, 40),
    action: cleanStr(req.query.action, 100),
    entity: cleanStr(req.query.entity, 60),
    userId: toNum(req.query.userId, 0) || null,
    from: cleanStr(req.query.from, 10),
    to: cleanStr(req.query.to, 10),
    page: toNum(req.query.page, 1),
    limit: toNum(req.query.limit, 50),
  });
  ok(res, result);
}));

router.get("/audit/facets", permissions.requirePermission("audit.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  ok(res, await audit.facets(tid));
}));

/* ========================== NEEDS ATTENTION ============================= */
/*
   Each item is derived from a real count in this institution's own data. An
   item is omitted entirely when its count is zero — the dashboard therefore
   shows an empty state rather than a row of reassuring zeroes, and nothing
   here is ever a fabricated statistic.
*/
router.get("/needs-attention", permissions.requirePermission("dashboard.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const held = await permissions.loadPermissions(req);
  const today = new Date().toISOString().slice(0, 10);

  /** Runs a count query, returning 0 if the table is absent in this install. */
  const count = async (sql, params) => {
    try {
      const row = await db.get(sql, params);
      return Number((row && (row.n !== undefined ? row.n : row.total)) || 0);
    } catch (e) { return 0; }
  };

  const [
    pendingAdmissions, outstandingStudents, failedPayments, unverifiedPayments,
    resultsAwaitingApproval, assignmentsAwaitingGrading, staffOnLeave,
    pendingLeave, overdueBooks, failedNotifications, unmarkedAttendance,
  ] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM admission_requests WHERE madrasa_id = ? AND status = 'pending'", [tid]),
    count(
      `SELECT COUNT(DISTINCT fa.student_id) AS n
         FROM fee_assignments fa
        WHERE fa.madrasa_id = ?
          AND fa.amount_due > COALESCE((
            SELECT SUM(p.amount_ngn) FROM fee_payments p
             WHERE p.madrasa_id = fa.madrasa_id AND p.student_id = fa.student_id
               AND p.fee_item_id = fa.fee_item_id AND p.status = 'successful'), 0)`,
      [tid]
    ),
    count("SELECT COUNT(*) AS n FROM fee_payments WHERE madrasa_id = ? AND status = 'failed'", [tid]),
    count("SELECT COUNT(*) AS n FROM fee_payments WHERE madrasa_id = ? AND status = 'successful' AND verification_status = 'unverified' AND method NOT IN ('cash')", [tid]),
    count("SELECT COUNT(*) AS n FROM results WHERE madrasa_id = ? AND status IN ('submitted','under_review')", [tid]),
    count(
      `SELECT COUNT(*) AS n FROM assignment_submissions s
        WHERE s.madrasa_id = ? AND s.status = 'submitted' AND s.score IS NULL`,
      [tid]
    ),
    count("SELECT COUNT(*) AS n FROM leave_requests WHERE madrasa_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?", [tid, today, today]),
    count("SELECT COUNT(*) AS n FROM leave_requests WHERE madrasa_id = ? AND status = 'pending'", [tid]),
    count("SELECT COUNT(*) AS n FROM library_loans WHERE madrasa_id = ? AND status = 'active' AND due_date < ?", [tid, today]),
    count("SELECT COUNT(*) AS n FROM communication_history WHERE madrasa_id = ? AND delivery_status = 'failed'", [tid]),
    count(
      `SELECT COUNT(*) AS n FROM classes c
        WHERE c.madrasa_id = ? AND c.is_active = 1
          AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.madrasa_id = c.madrasa_id AND a.class_id = c.id AND a.day = ?)`,
      [tid, today]
    ),
  ]);

  const candidates = [
    { key: "pending_admissions", label: "Pending admission applications", count: pendingAdmissions, tone: "info", route: "admissions/applications", permission: "admissions.view" },
    { key: "outstanding_fees", label: "Students with outstanding fees", count: outstandingStudents, tone: "warn", route: "finance/outstanding", permission: "fees.view" },
    { key: "failed_payments", label: "Failed payments", count: failedPayments, tone: "danger", route: "finance/payments", permission: "payments.view" },
    { key: "unverified_payments", label: "Payments awaiting verification", count: unverifiedPayments, tone: "warn", route: "finance/payments", permission: "payments.verify" },
    { key: "results_awaiting_approval", label: "Results awaiting review or approval", count: resultsAwaitingApproval, tone: "info", route: "academic/results", permission: "results.approve" },
    { key: "assignments_awaiting_grading", label: "Assignment submissions awaiting grading", count: assignmentsAwaitingGrading, tone: "info", route: "academic/assignments", permission: "assignments.view" },
    { key: "pending_leave", label: "Staff leave requests awaiting approval", count: pendingLeave, tone: "warn", route: "hr/requests", permission: "staff_leave.approve" },
    { key: "staff_on_leave", label: "Staff on leave today", count: staffOnLeave, tone: "info", route: "hr/calendar", permission: "staff_leave.view" },
    { key: "overdue_books", label: "Overdue library books", count: overdueBooks, tone: "warn", route: "library/overdue", permission: "library.view" },
    { key: "failed_notifications", label: "Failed message deliveries", count: failedNotifications, tone: "danger", route: "communication/notifications", permission: "communication.view" },
    { key: "unmarked_attendance", label: "Classes without attendance today", count: unmarkedAttendance, tone: "warn", route: "attendance/students", permission: "dashboard.view" },
  ];

  // Only surface what the caller is actually allowed to act on, and only what
  // genuinely needs attention.
  const items = candidates
    .filter((i) => i.count > 0 && held.has(i.permission))
    .map(({ permission, ...rest }) => rest)
    .sort((a, b) => b.count - a.count);

  ok(res, { items, total: items.reduce((a, i) => a + i.count, 0), checkedAt: new Date().toISOString() });
}));

/* ============================ GLOBAL SEARCH ============================= */
/*
   Searches only the caller's own institution, and only the entity types the
   caller has permission to view. A result is never returned for a tenant the
   user does not belong to: every query below carries madrasa_id = tid.
*/
router.get("/search", asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const raw = cleanStr(req.query.q, 100);
  if (raw.length < 2) return ok(res, { query: raw, groups: [], total: 0 });
  const held = await permissions.loadPermissions(req);
  const q = `%${raw.toLowerCase()}%`;
  const perGroup = Math.min(10, toNum(req.query.limit, 5));
  const groups = [];

  const safe = async (fn) => { try { return await fn(); } catch (e) { return []; } };

  if (held.has("students.view")) {
    const rows = await safe(() => db.all(
      `SELECT s.id, s.first_name, s.last_name, s.admission_no, s.status, c.name_en AS class_name
         FROM students s LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id
        WHERE s.madrasa_id = ?
          AND (LOWER(s.first_name) LIKE ? OR LOWER(s.last_name) LIKE ?
               OR LOWER(s.admission_no) LIKE ? OR LOWER(COALESCE(s.student_code,'')) LIKE ?)
        ORDER BY s.last_name, s.first_name LIMIT ?`,
      [tid, q, q, q, q, perGroup]
    ));
    if (rows.length) groups.push({ key: "students", label: "Students", items: rows.map((r) => ({
      id: r.id, title: `${r.first_name} ${r.last_name}`.trim(),
      subtitle: [r.admission_no, r.class_name, r.status].filter(Boolean).join(" · "),
      route: `students/all?student=${r.id}`,
    })) });
  }

  if (held.has("teachers.view")) {
    const rows = await safe(() => db.all(
      `SELECT id, full_name, username, role FROM users
        WHERE madrasa_id = ? AND role IN ('teacher','madrasa_admin')
          AND (LOWER(COALESCE(full_name,'')) LIKE ? OR LOWER(username) LIKE ? OR LOWER(COALESCE(email,'')) LIKE ?)
        ORDER BY full_name LIMIT ?`,
      [tid, q, q, q, perGroup]
    ));
    if (rows.length) groups.push({ key: "staff", label: "Teachers & staff", items: rows.map((r) => ({
      id: r.id, title: r.full_name || r.username,
      subtitle: r.role === "madrasa_admin" ? "Administrator" : "Teacher",
      route: r.role === "teacher" ? "teachers/all" : "settings/staff",
    })) });
  }

  if (held.has("classes.view")) {
    const rows = await safe(() => db.all(
      `SELECT id, name_en, name_ar FROM classes
        WHERE madrasa_id = ? AND (LOWER(name_en) LIKE ? OR LOWER(COALESCE(name_ar,'')) LIKE ?)
        ORDER BY name_en LIMIT ?`,
      [tid, q, q, perGroup]
    ));
    if (rows.length) groups.push({ key: "classes", label: "Classes", items: rows.map((r) => ({
      id: r.id, title: r.name_en, subtitle: r.name_ar || "", route: "classes/all",
    })) });
  }

  if (held.has("admissions.view")) {
    const rows = await safe(() => db.all(
      `SELECT id, reference, first_name, last_name, status FROM admission_requests
        WHERE madrasa_id = ?
          AND (LOWER(reference) LIKE ? OR LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ?)
        ORDER BY id DESC LIMIT ?`,
      [tid, q, q, q, perGroup]
    ));
    if (rows.length) groups.push({ key: "admissions", label: "Admissions", items: rows.map((r) => ({
      id: r.id, title: `${r.first_name} ${r.last_name}`.trim(),
      subtitle: `${r.reference} · ${r.status}`, route: "admissions/applications",
    })) });
  }

  if (held.has("payments.view")) {
    const rows = await safe(() => db.all(
      `SELECT p.id, p.receipt_number, p.reference, p.amount_ngn, p.payment_date, p.status,
              s.first_name, s.last_name
         FROM fee_payments p JOIN students s ON s.id = p.student_id AND s.madrasa_id = p.madrasa_id
        WHERE p.madrasa_id = ?
          AND (LOWER(COALESCE(p.receipt_number,'')) LIKE ? OR LOWER(COALESCE(p.reference,'')) LIKE ?
               OR LOWER(COALESCE(p.transaction_number,'')) LIKE ?)
        ORDER BY p.id DESC LIMIT ?`,
      [tid, q, q, q, perGroup]
    ));
    if (rows.length) groups.push({ key: "payments", label: "Payments", items: rows.map((r) => ({
      id: r.id, title: r.receipt_number || r.reference || `Payment #${r.id}`,
      subtitle: `${r.first_name} ${r.last_name} · ${r.payment_date} · ${r.status}`,
      route: "finance/payments",
    })) });
  }

  if (held.has("library.view")) {
    const rows = await safe(() => db.all(
      `SELECT id, title, author, isbn FROM library_books
        WHERE madrasa_id = ? AND is_archived = 0
          AND (LOWER(title) LIKE ? OR LOWER(author) LIKE ? OR LOWER(isbn) LIKE ?)
        ORDER BY title LIMIT ?`,
      [tid, q, q, q, perGroup]
    ));
    if (rows.length) groups.push({ key: "library", label: "Library", items: rows.map((r) => ({
      id: r.id, title: r.title, subtitle: [r.author, r.isbn].filter(Boolean).join(" · "),
      route: "library/catalogue",
    })) });
  }

  ok(res, {
    query: raw,
    groups,
    total: groups.reduce((a, g) => a + g.items.length, 0),
  });
}));

module.exports = router;
