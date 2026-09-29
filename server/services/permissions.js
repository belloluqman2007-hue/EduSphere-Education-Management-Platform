"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — granular permissions
   ----------------------------------------------------------------------------
   This sits ON TOP of the five existing account roles (super_admin,
   madrasa_admin, teacher, student, parent). It does NOT replace them:

     • the role a user holds still decides their account type and which
       workspace they see,
     • each role has a DEFAULT permission set that reproduces exactly the
       access that role already had before this module existed,
     • an administrator may then GRANT extra permissions or REVOKE default
       ones for an individual member of staff (user_permissions table).

   Because the defaults mirror the previous behaviour, an installation with
   no override rows behaves identically to before.

   Enforcement is always server-side. The frontend receives the resolved
   permission list only so it can hide actions the user cannot perform; it is
   never the authority.
   ========================================================================== */
const db = require("../db");

/* ----------------------------- catalogue -------------------------------- */
/** The full permission catalogue, grouped for the Roles & Permissions UI. */
const CATALOGUE = [
  { key: "dashboard", label: "Dashboard", permissions: [
    ["dashboard.view", "View the admin dashboard"],
  ] },
  { key: "students", label: "Students", permissions: [
    ["students.view", "View students"],
    ["students.create", "Add students"],
    ["students.edit", "Edit students"],
    ["students.delete", "Archive or delete students"],
    ["students.export", "Export student data"],
    ["students.import", "Import students"],
    ["students.promote", "Promote students"],
  ] },
  { key: "teachers", label: "Teachers", permissions: [
    ["teachers.view", "View teachers and staff"],
    ["teachers.create", "Add teachers and staff"],
    ["teachers.edit", "Edit teachers and staff"],
    ["teachers.delete", "Archive teachers and staff"],
  ] },
  { key: "classes", label: "Classes", permissions: [
    ["classes.view", "View classes"],
    ["classes.create", "Create classes"],
    ["classes.edit", "Edit classes"],
    ["classes.delete", "Delete classes"],
  ] },
  { key: "academic", label: "Academic", permissions: [
    ["lessons.view", "View lessons"],
    ["lessons.create", "Create lessons"],
    ["assignments.view", "View assignments"],
    ["assignments.create", "Create and grade assignments"],
    ["exams.view", "View examinations"],
    ["exams.create", "Create examinations"],
    ["questionbank.view", "View the question bank"],
    ["questionbank.manage", "Create and edit question-bank entries"],
    ["results.enter", "Enter results"],
    ["results.edit", "Edit results"],
    ["results.submit", "Submit results for review"],
    ["results.approve", "Review, return and approve results"],
    ["results.publish", "Publish and lock results"],
    ["report_cards.view", "View report cards"],
    ["report_cards.generate", "Generate report cards"],
    ["report_cards.templates", "Configure the report sheet template"],
  ] },
  { key: "finance", label: "Finance", permissions: [
    ["fees.view", "View fee structures"],
    ["fees.create", "Create and edit fee structures"],
    ["payments.view", "View payments"],
    ["payments.create", "Record payments"],
    ["payments.verify", "Verify and reconcile payments"],
    ["expenses.view", "View expenses"],
    ["expenses.create", "Record expenses"],
    ["finance.reports", "View financial reports"],
  ] },
  { key: "payroll", label: "Payroll", permissions: [
    ["payroll.view", "View payroll"],
    ["payroll.create", "Create salary structures and pay periods"],
    ["payroll.process", "Process payroll"],
    ["payroll.approve", "Approve and lock payroll"],
    ["payslips.view", "View payslips"],
  ] },
  { key: "hr", label: "HR & Staff leave", permissions: [
    ["staff_leave.view", "View staff leave"],
    ["staff_leave.create", "Request staff leave"],
    ["staff_leave.approve", "Approve or reject staff leave"],
  ] },
  { key: "library", label: "Library", permissions: [
    ["library.view", "View the library catalogue"],
    ["library.manage", "Manage the library catalogue"],
    ["library.issue", "Issue books"],
    ["library.return", "Accept returns and renewals"],
  ] },
  { key: "communication", label: "Communication", permissions: [
    ["communication.view", "View communication"],
    ["communication.send", "Send messages and announcements"],
    ["communication.templates", "Manage message templates"],
  ] },
  { key: "admissions", label: "Admissions", permissions: [
    ["admissions.view", "View applications"],
    ["admissions.create", "Create applications"],
    ["admissions.approve", "Approve applications"],
    ["admissions.reject", "Reject applications"],
  ] },
  { key: "calendar", label: "Calendar & Events", permissions: [
    ["calendar.view", "View the academic calendar and school events"],
    ["calendar.manage", "Create and edit calendar events"],
  ] },
  { key: "support", label: "Platform Support", permissions: [
    ["support.view", "View this institution's support tickets"],
    ["support.create", "Raise support tickets with the platform"],
    ["support.chat", "Use Chat & Support with the EduSphere team"],
  ] },
  { key: "website", label: "Institution website", permissions: [
    ["website.view", "View website settings"],
    ["website.edit", "Edit the institution website"],
    ["website.publish", "Publish the institution website"],
  ] },
  { key: "documents", label: "Documents", permissions: [
    ["documents.view", "View documents"],
    ["documents.generate", "Generate ID cards, certificates and letters"],
  ] },
  { key: "settings", label: "Settings", permissions: [
    ["institution.settings", "Change institution settings"],
    ["users.manage", "Manage user accounts"],
    ["roles.manage", "Manage roles and permissions"],
  ] },
  { key: "audit", label: "Audit", permissions: [
    ["audit.view", "View the audit log"],
  ] },
];

/** Flat set of every valid permission key. */
const ALL_PERMISSIONS = CATALOGUE.flatMap((g) => g.permissions.map(([key]) => key));
const ALL_SET = new Set(ALL_PERMISSIONS);

function isPermission(value) {
  return ALL_SET.has(String(value || ""));
}

/* --------------------------- role defaults ------------------------------ */
/*
   These reproduce today's behaviour exactly:
     • madrasa_admin already had full control of their institution,
     • teacher already had assigned classes/subjects, attendance and result
       entry (but never approval/publishing),
     • student and parent have no admin-area permissions at all.
*/
const TEACHER_DEFAULTS = [
  "dashboard.view",
  "students.view",
  // A teacher could already download the student roster, pull bulk report
  // cards for their own classes, read the institution's website screens and
  // record a school expense before granular permissions existed. They are
  // listed explicitly so wiring the enforcement below withdraws nothing that
  // a teacher has today — an administrator can now revoke them per user,
  // which was not possible before.
  "students.export",
  "report_cards.generate",
  // Printing ID cards for an assigned class was always available to a class
  // teacher through the old STAFF guard (managing certificate templates was
  // not, and still is not — that stays administrator-only).
  "documents.generate",
  "website.view",
  "expenses.view", "expenses.create",
  // The teachers/staff directory and the fee ledger were already readable by
  // a teacher through the old "STAFF" role guard (madrasa_admin + teacher).
  // They are listed here so that introducing granular permissions does not
  // quietly withdraw access a teacher has today. An administrator who
  // considers these too broad can now revoke them per user — which was not
  // possible before.
  "teachers.view",
  "fees.view", "payments.view", "finance.reports",
  "documents.view",
  "classes.view",
  "lessons.view", "lessons.create",
  "assignments.view", "assignments.create",
  "exams.view",
  // Teachers read the shared calendar (their dashboard shows upcoming events)
  // and consult the question bank; managing either stays administrator-only.
  "calendar.view", "questionbank.view",
  "results.enter", "results.edit", "results.submit",
  "report_cards.view",
  "library.view", "library.issue", "library.return",
  "communication.view",
  // Chat & Support is the institution's channel to the EduSphere team. A
  // teacher may hold a conversation of their own there; the older ticket
  // permissions (support.view / support.create) stay administrator-only.
  "support.chat",
  "staff_leave.view", "staff_leave.create",
  "payslips.view",
];

const ROLE_DEFAULTS = {
  // super_admin bypasses the check entirely (see effectivePermissions), but a
  // concrete list is kept so the UI can display it.
  super_admin: ALL_PERMISSIONS.slice(),
  madrasa_admin: ALL_PERMISSIONS.slice(),
  teacher: TEACHER_DEFAULTS.slice(),
  student: [],
  parent: [],
};

/** Default permission list for a role (never mutated by callers). */
function roleDefaults(role) {
  return (ROLE_DEFAULTS[String(role || "")] || []).slice();
}

/* --------------------------- resolution --------------------------------- */

/**
 * Resolves the effective permission set for a user:
 *   role defaults  +  granted overrides  −  revoked overrides
 *
 * Overrides are tenant-scoped: an override row only counts when it belongs to
 * the same madrasa as the user, so one institution can never widen another
 * institution's staff access.
 */
async function effectivePermissions(user) {
  if (!user) return new Set();
  if (user.role === "super_admin") return new Set(ALL_PERMISSIONS);
  const set = new Set(roleDefaults(user.role));
  if (!user.madrasaId) return set;
  let rows = [];
  try {
    rows = await db.all(
      "SELECT permission, effect FROM user_permissions WHERE madrasa_id = ? AND user_id = ?",
      [user.madrasaId, user.id]
    );
  } catch (e) {
    // Table missing (migration not yet applied): fall back to role defaults
    // rather than locking every administrator out.
    return set;
  }
  for (const row of rows) {
    if (!isPermission(row.permission)) continue;
    if (String(row.effect) === "revoke") set.delete(row.permission);
    else set.add(row.permission);
  }
  return set;
}

/**
 * Attaches req.permissions (a Set) once per request and memoises it.
 * Safe to call repeatedly.
 */
async function loadPermissions(req) {
  if (req._permissions) return req._permissions;
  req._permissions = await effectivePermissions(req.user);
  return req._permissions;
}

/**
 * Express middleware factory. Requires EVERY listed permission.
 *
 *   router.post("/", requirePermission("students.create"), handler)
 *
 * Returns 401 when unauthenticated and 403 when the permission is missing —
 * the message never reveals which other users or institutions exist.
 */
function requirePermission(...permissions) {
  const needed = permissions.filter(isPermission);
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Authentication required." });
      const held = await loadPermissions(req);
      const missing = needed.filter((p) => !held.has(p));
      if (missing.length) {
        return res.status(403).json({
          error: "You do not have permission to perform this action.",
          requiredPermission: missing[0],
        });
      }
      next();
    } catch (e) { next(e); }
  };
}

/** Express middleware factory requiring ANY ONE of the listed permissions. */
function requireAnyPermission(...permissions) {
  const needed = permissions.filter(isPermission);
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Authentication required." });
      const held = await loadPermissions(req);
      if (!needed.some((p) => held.has(p))) {
        return res.status(403).json({
          error: "You do not have permission to perform this action.",
          requiredPermission: needed[0],
        });
      }
      next();
    } catch (e) { next(e); }
  };
}

/**
 * Like requirePermission, but ONLY for the staff roles that the admin
 * permission catalogue describes (madrasa_admin, teacher, super_admin).
 *
 * Several routers are shared with the student/parent portals, which read the
 * same tenant data through their own, separate record-level guards (own
 * profile, linked children). Those roles hold no admin permissions at all by
 * design, so applying the catalogue to them would withdraw portal access that
 * has always existed. This factory therefore enforces the permission for
 * staff and leaves every other role to the route's existing guard.
 */
const STAFF_ROLES = new Set(["madrasa_admin", "teacher", "super_admin"]);

function requireStaffPermission(...permissions) {
  const gate = requirePermission(...permissions);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required." });
    if (!STAFF_ROLES.has(req.user.role)) return next();
    return gate(req, res, next);
  };
}

/** requireAnyPermission restricted to staff roles (see requireStaffPermission). */
function requireAnyStaffPermission(...permissions) {
  const gate = requireAnyPermission(...permissions);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required." });
    if (!STAFF_ROLES.has(req.user.role)) return next();
    return gate(req, res, next);
  };
}

/** Imperative check for use inside a handler that has already loaded req.user. */
async function can(req, permission) {
  const held = await loadPermissions(req);
  return held.has(permission);
}

module.exports = {
  CATALOGUE,
  ALL_PERMISSIONS,
  ROLE_DEFAULTS,
  isPermission,
  roleDefaults,
  effectivePermissions,
  loadPermissions,
  requirePermission,
  requireAnyPermission,
  requireStaffPermission,
  requireAnyStaffPermission,
  can,
};
