"use strict";
/* ============================================================================
   EduSphere — Offline-First Sync Engine (/api/sync)
   ----------------------------------------------------------------------------
   Powers local-first operation across:
     • Native Desktop Apps (Electron — Windows, macOS, Linux)
     • Native Mobile & Tablet Apps (Capacitor — Android & iOS/iPadOS)
     • Offline-capable Web Workspaces

   Endpoints:
     • GET  /api/sync/status  — lightweight heartbeat, server clock & capabilities
     • GET  /api/sync/pull    — tenant-isolated, role-scoped full or incremental
                                (?since=<cursor>) dataset download
     • POST /api/sync/push    — idempotent Outbox batch processor with
                                local-to-server ID mapping and per-item
                                conflict isolation

   Security & Isolation Invariants:
     1. Tenant (`madrasa_id`) ALWAYS comes from the authenticated user context
        (`effectiveTenantId(req)`), never from client payloads.
     2. Role scopes, teacher class/subject assignments, granular staff
        permissions, and plan tier feature gates are enforced identically to
        the live REST routes.
     3. Students & parents receive ONLY their own / linked-child records and
        ONLY published/locked academic results — draft marks never leave staff.
   ========================================================================== */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, clampNum, validDate, validPhone, validEmail, logActivity, checkPlanLimits } = require("../util");
const { requireAuth, requireTenant } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments, teacherCanAccess, teacherCanMarkAttendance } = require("../middleware/tenant");
const permissionService = require("../services/permissions");
const { can } = permissionService;
const subscription = require("../services/subscription");
const { CATEGORY_CONFIG } = require("../services/institution");
const grading = require("../services/grading");
const admission = require("../services/admission");
const cardCreds = require("../services/card-credentials");
const communication = require("../services/communication");
const audit = require("../services/audit");

const router = express.Router();
router.use(requireAuth);

const SYNC_VERSION = 1;
const MAX_PUSH_BATCH = 200;
const CLOCK_SKEW_OVERLAP_MS = 2000;

const SUPPORTED_MUTATIONS = [
  "student.create",
  "student.update",
  "attendance.mark",
  "attendance.scan",
  "teacher_attendance.mark",
  "results.upsert",
  "quran_progress.create",
  "quran_progress.update",
  "fee_payment.record",
  "expense.create",
  "announcement.create",
];

const STUDENT_ATTENDANCE_STATUSES = new Set(["present", "absent", "late", "excused"]);
const TEACHER_ATTENDANCE_STATUSES = new Set(["present", "absent", "late", "on_leave", "excused"]);
const HIFZ_PERFORMANCE_STATUSES = new Set(["excellent", "good", "developing", "needs_support", "needs_revision"]);
const PAYMENT_STATUSES = new Set(["pending", "successful", "failed", "reversed", "refunded"]);
const PAYMENT_METHODS = new Set(["cash", "bank_transfer", "transfer", "card", "online", "pos", "other"]);
const EXPENSE_PAYMENT_METHODS = new Set(["cash", "bank_transfer", "pos", "cheque", "online", "other"]);
const ANNOUNCEMENT_TARGETS = new Set([
  "all", "institution", "islamic_section", "western_section", "students",
  "teachers", "parents", "specific_class", "specific_student_group",
  "specific_teacher_group", "individual_users",
]);
const ANNOUNCEMENT_STATUSES = new Set(["draft", "scheduled", "published", "archived"]);

class SyncMutationError extends Error {
  constructor(statusKind, code, message, extra = {}) {
    super(message);
    this.name = "SyncMutationError";
    this.statusKind = statusKind; // "conflict" | "rejected"
    this.code = code;
    this.extra = extra || {};
  }
}

/* ------------------------------ time & cursors --------------------------- */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toSqlUtc(date = new Date()) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function daysAgoIsoDate(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

/**
 * Parses a client cursor (ISO 8601 or naive UTC "YYYY-MM-DD HH:MM:SS") and
 * subtracts a 2-second safety overlap so rows written in the boundary second
 * of CURRENT_TIMESTAMP are never missed on incremental pulls.
 */
function parseSinceCursor(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let normalized = s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    normalized = s.replace(" ", "T") + "Z";
  }
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return toSqlUtc(new Date(Math.max(0, ms - CLOCK_SKEW_OVERLAP_MS)));
}

function schoolClock(timezone, when) {
  const date = when ? new Date(when) : new Date();
  if (!Number.isFinite(date.getTime())) return new Date().toISOString().slice(11, 16);
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone || "Africa/Lagos",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch (e) {
    return date.toISOString().slice(11, 16);
  }
}

function timeOrBlank(value) {
  const s = cleanStr(value, 5);
  return s === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

/* -------------------------- feature & scope helpers ---------------------- */

async function resolveFeatureFlags(req, tid) {
  const keys = ["fees", "expenses", "portals", "online_exams", "payroll", "library", "certificates", "ai_assistant"];
  if (req.user.role === "super_admin") {
    const all = {};
    for (const k of keys) all[k] = true;
    return all;
  }
  const out = {};
  let settings;
  try { settings = await subscription.getSettings(); } catch (e) { settings = undefined; }
  for (const k of keys) {
    try {
      const gate = await subscription.checkFeature(tid, k, { settings });
      out[k] = Boolean(gate && gate.allowed);
    } catch (e) {
      out[k] = true;
    }
  }
  return out;
}

async function hifzAllowedForTenant(tid, category) {
  const catCfg = CATEGORY_CONFIG[category || "islamic"];
  if (!catCfg || !catCfg.hifzEnabledByDefault) return false;
  const row = await db.get("SELECT value FROM settings WHERE madrasa_id = ? AND key_name = 'hifz_progress_enabled'", [tid]);
  return !row || String(row.value) !== "0";
}

async function accessiblePortalStudents(req, tid) {
  if (req.user.role === "student") {
    if (!req.user.studentId) return [];
    const row = await db.get(
      `SELECT s.*, c.name_en AS class_en, c.name_ar AS class_ar
         FROM students s LEFT JOIN classes c ON c.id = s.class_id
        WHERE s.id = ? AND s.madrasa_id = ?`,
      [req.user.studentId, tid]
    );
    return row ? [row] : [];
  }
  if (req.user.role === "parent") {
    return db.all(
      `SELECT s.*, c.name_en AS class_en, c.name_ar AS class_ar
         FROM students s
         JOIN parent_links pl ON pl.student_id = s.id AND pl.madrasa_id = s.madrasa_id
         LEFT JOIN classes c ON c.id = s.class_id
        WHERE pl.madrasa_id = ? AND pl.user_id = ? AND s.madrasa_id = ?`,
      [tid, req.user.id, tid]
    );
  }
  return [];
}

async function resolveTermContext(tid, day, requestedTerm, requestedSession) {
  let termId = requestedTerm ? toNum(requestedTerm, 0) : 0;
  let sessionId = requestedSession ? toNum(requestedSession, 0) : 0;
  if (termId) {
    const term = await db.get("SELECT id, session_id FROM terms WHERE id = ? AND madrasa_id = ?", [termId, tid]);
    if (!term) return { error: "Term not found." };
    if (sessionId && Number(term.session_id) !== sessionId) {
      return { error: "Term does not belong to the selected session." };
    }
    sessionId = Number(term.session_id);
  } else {
    const term = await db.get(
      `SELECT t.id, t.session_id
         FROM terms t JOIN academic_sessions s ON s.id = t.session_id
        WHERE t.madrasa_id = ?
          AND (t.start_date IS NULL OR t.start_date <= ?)
          AND (t.end_date IS NULL OR t.end_date >= ?)
          ${sessionId ? "AND t.session_id = ?" : ""}
        ORDER BY s.is_current DESC, s.id DESC, t.position LIMIT 1`,
      sessionId ? [tid, day, day, sessionId] : [tid, day, day]
    );
    if (term) {
      termId = Number(term.id);
      sessionId = Number(term.session_id);
    }
  }
  if (sessionId) {
    const s = await db.get("SELECT id FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sessionId, tid]);
    if (!s) return { error: "Academic session not found." };
  }
  return { termId: termId || null, sessionId: sessionId || null };
}

async function notifyAttendanceBestEffort(tid, studentId, status, day, userId) {
  if (status !== "absent" && status !== "late") return;
  try {
    const recipients = await db.all("SELECT user_id FROM parent_links WHERE madrasa_id = ? AND student_id = ?", [tid, studentId]);
    const studentUser = await db.get("SELECT id FROM users WHERE madrasa_id = ? AND student_id = ? AND is_active = 1", [tid, studentId]);
    const recipientIds = [...new Set(recipients.map((r) => Number(r.user_id)).concat(studentUser ? [Number(studentUser.id)] : []))];
    const title = status === "absent" ? "Student absent" : "Student late";
    await communication.createNotifications(tid, recipientIds, {
      type: status === "absent" ? "student_absent" : "student_late",
      title,
      body: `Attendance recorded as ${status} for ${day}.`,
      entity_type: "attendance",
      entity_id: studentId,
    });
  } catch (e) { /* notifications never fail sync */ }
}

/**
 * Resolves either a real positive integer database ID or an offline temporary
 * ID (e.g. "local_stu_1") that was mapped earlier in this batch or in a prior
 * /api/sync/push call for this tenant.
 */
async function resolveEntityId(tid, entity, rawValue, batchIdMap) {
  if (rawValue === null || rawValue === undefined || rawValue === "") return 0;
  const direct = Number(rawValue);
  if (Number.isInteger(direct) && direct > 0) return direct;

  const localKey = String(rawValue).trim();
  if (!localKey) return 0;

  const scopedKey = `${entity}:${localKey}`;
  if (batchIdMap.has(scopedKey)) return Number(batchIdMap.get(scopedKey)) || 0;
  if (batchIdMap.has(localKey)) return Number(batchIdMap.get(localKey)) || 0;

  const mapped = await db.get(
    `SELECT server_id FROM sync_mutations
      WHERE madrasa_id = ? AND entity = ? AND local_id = ? AND status = 'applied' AND server_id <> ''
      ORDER BY id DESC LIMIT 1`,
    [tid, entity, localKey]
  );
  if (mapped && mapped.server_id) {
    const resolved = Number(mapped.server_id) || 0;
    if (resolved > 0) {
      batchIdMap.set(scopedKey, resolved);
      batchIdMap.set(localKey, resolved);
      return resolved;
    }
  }
  return 0;
}

/* ============================================================================
   1. GET /api/sync/status — fast online heartbeat & capabilities check
   ========================================================================== */

router.get("/status", asyncHandler(async (req, res) => {
  const now = new Date();
  ok(res, {
    ok: true,
    syncVersion: SYNC_VERSION,
    serverTime: now.toISOString(),
    serverCursor: toSqlUtc(now),
    authMethod: req.authMethod || "session",
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      madrasaId: req.user.madrasaId,
    },
    supportedMutations: SUPPORTED_MUTATIONS,
  });
}));

/* ============================================================================
   2. GET /api/sync/pull — role-scoped full or incremental dataset pull
   ========================================================================== */

router.get("/pull", requireTenant, asyncHandler(async (req, res) => {
  const now = new Date();
  const serverTime = now.toISOString();
  const serverCursor = toSqlUtc(now);
  const tid = effectiveTenantId(req);

  // Super admin without ?madrasaId= operates platform-wide; return clean shell.
  if (!tid && req.user.role === "super_admin") {
    return ok(res, {
      ok: true,
      syncVersion: SYNC_VERSION,
      mode: "platform_only",
      isIncremental: false,
      since: null,
      serverTime,
      serverCursor,
      profile: {
        role: "super_admin",
        madrasaId: null,
        permissions: permissionService.roleDefaults("super_admin"),
        user: req.user,
      },
      features: await resolveFeatureFlags(req, null),
      collections: {},
      idMap: {},
    });
  }
  if (!tid) return err(res, 400, "Institution context required.");

  const madrasa = await db.get(
    `SELECT id, slug, name_en, name_ar, logo_path, badge_path, motto_en, motto_ar,
            address, city, town, state_name, country, phone, email, category,
            institution_type, verified, brand_color, secondary_color, school_code,
            timezone, currency, default_language, date_format, status, updated_at
       FROM madaris WHERE id = ?`,
    [tid]
  );
  if (!madrasa || madrasa.status !== "active") {
    return err(res, 404, "Active institution not found.");
  }

  const sinceSql = parseSinceCursor(req.query.since);
  const isIncremental = Boolean(sinceSql);
  const category = madrasa.category || "islamic";

  let permissions = [];
  try { permissions = Array.from(await permissionService.effectivePermissions(req.user)).sort(); }
  catch (e) { permissions = permissionService.roleDefaults(req.user.role); }
  const permSet = new Set(permissions);
  const hasPerm = (key) => req.user.role === "super_admin" || req.user.role === "madrasa_admin"
    ? (req.user.role === "super_admin" || permSet.has(key))
    : permSet.has(key);

  const features = await resolveFeatureFlags(req, tid);
  const hifzEnabled = await hifzAllowedForTenant(tid, category);

  // Recent ID mappings created by this user on any device
  const recentMappings = await db.all(
    `SELECT entity, local_id, server_id FROM sync_mutations
      WHERE madrasa_id = ? AND user_id = ? AND status = 'applied' AND local_id <> '' AND server_id <> ''
      ORDER BY id DESC LIMIT 500`,
    [tid, req.user.id]
  );
  const idMap = {};
  for (const m of recentMappings) {
    const key = `${m.entity}:${m.local_id}`;
    if (idMap[key] === undefined) idMap[key] = Number(m.server_id) || m.server_id;
  }

  const collections = {};
  const recentCutoffDate = daysAgoIsoDate(90);

  // Common academic calendar metadata
  collections.academic_sessions = isIncremental
    ? await db.all("SELECT * FROM academic_sessions WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id DESC", [tid, sinceSql])
    : await db.all("SELECT * FROM academic_sessions WHERE madrasa_id = ? ORDER BY id DESC", [tid]);

  collections.terms = isIncremental
    ? await db.all("SELECT * FROM terms WHERE madrasa_id = ? AND updated_at >= ? ORDER BY session_id DESC, position ASC", [tid, sinceSql])
    : await db.all("SELECT * FROM terms WHERE madrasa_id = ? ORDER BY session_id DESC, position ASC", [tid]);

  const currentSessionRow = await db.get(
    "SELECT id FROM academic_sessions WHERE madrasa_id = ? ORDER BY is_current DESC, id DESC LIMIT 1",
    [tid]
  );
  const currentSessionId = currentSessionRow ? Number(currentSessionRow.id) : 0;

  /* -------------------- Student & Parent Portal Scope -------------------- */
  if (req.user.role === "student" || req.user.role === "parent") {
    const audience = req.user.role === "student" ? "students" : "parents";
    collections.announcements = isIncremental
      ? await db.all(
          `SELECT id, madrasa_id, title, body, audience, target_type, category, event_date, event_location, published_at, created_at, updated_at
             FROM announcements
            WHERE madrasa_id = ? AND status = 'published' AND is_active = 1 AND updated_at >= ?
              AND (target_type IN ('all','institution',?) OR audience IN ('all',?))
            ORDER BY id DESC LIMIT 100`,
          [tid, sinceSql, audience, audience]
        )
      : await db.all(
          `SELECT id, madrasa_id, title, body, audience, target_type, category, event_date, event_location, published_at, created_at, updated_at
             FROM announcements
            WHERE madrasa_id = ? AND status = 'published' AND is_active = 1
              AND (target_type IN ('all','institution',?) OR audience IN ('all',?))
            ORDER BY id DESC LIMIT 100`,
          [tid, audience, audience]
        );

    if (!features.portals) {
      return ok(res, {
        ok: true,
        syncVersion: SYNC_VERSION,
        portalLocked: true,
        isIncremental,
        since: sinceSql,
        serverTime,
        serverCursor,
        profile: {
          role: req.user.role,
          madrasaId: tid,
          category,
          hifzEnabled,
          permissions,
          institution: madrasa,
          user: req.user,
        },
        features,
        collections,
        idMap,
      });
    }

    const portalStudents = await accessiblePortalStudents(req, tid);
    const studentIds = portalStudents.map((s) => Number(s.id)).filter(Boolean);
    const classIds = [...new Set(portalStudents.map((s) => Number(s.class_id)).filter(Boolean))];

    collections.students = portalStudents;
    if (classIds.length) {
      const cMarks = classIds.map(() => "?").join(",");
      collections.classes = await db.all(`SELECT * FROM classes WHERE madrasa_id = ? AND id IN (${cMarks})`, [tid].concat(classIds));
      collections.timetable_slots = await db.all(`SELECT * FROM timetable_slots WHERE madrasa_id = ? AND class_id IN (${cMarks})`, [tid].concat(classIds));
    } else {
      collections.classes = [];
      collections.timetable_slots = [];
    }
    collections.subjects = isIncremental
      ? await db.all("SELECT * FROM subjects WHERE madrasa_id = ? AND updated_at >= ?", [tid, sinceSql])
      : await db.all("SELECT * FROM subjects WHERE madrasa_id = ?", [tid]);

    if (studentIds.length) {
      const sMarks = studentIds.map(() => "?").join(",");
      // Strictly PUBLISHED / LOCKED academic records only — never draft marks.
      collections.term_summaries = await db.all(
        `SELECT * FROM term_summaries WHERE madrasa_id = ? AND student_id IN (${sMarks}) AND published_at IS NOT NULL ORDER BY id DESC LIMIT 200`,
        [tid].concat(studentIds)
      );
      collections.results = isIncremental
        ? await db.all(
            `SELECT * FROM results WHERE madrasa_id = ? AND student_id IN (${sMarks}) AND status IN ('published','locked') AND updated_at >= ? ORDER BY id DESC LIMIT 1000`,
            [tid].concat(studentIds, [sinceSql])
          )
        : await db.all(
            `SELECT * FROM results WHERE madrasa_id = ? AND student_id IN (${sMarks}) AND status IN ('published','locked') ORDER BY id DESC LIMIT 1000`,
            [tid].concat(studentIds)
          );
      collections.attendance = isIncremental
        ? await db.all(
            `SELECT * FROM attendance WHERE madrasa_id = ? AND student_id IN (${sMarks}) AND updated_at >= ? ORDER BY day DESC LIMIT 1000`,
            [tid].concat(studentIds, [sinceSql])
          )
        : await db.all(
            `SELECT * FROM attendance WHERE madrasa_id = ? AND student_id IN (${sMarks}) AND day >= ? ORDER BY day DESC LIMIT 1000`,
            [tid].concat(studentIds, [recentCutoffDate])
          );
      collections.fee_assignments = await db.all(
        `SELECT * FROM fee_assignments WHERE madrasa_id = ? AND student_id IN (${sMarks}) ORDER BY id DESC LIMIT 500`,
        [tid].concat(studentIds)
      );
      collections.fee_payments = isIncremental
        ? await db.all(
            `SELECT * FROM fee_payments WHERE madrasa_id = ? AND student_id IN (${sMarks}) AND updated_at >= ? ORDER BY id DESC LIMIT 500`,
            [tid].concat(studentIds, [sinceSql])
          )
        : await db.all(
            `SELECT * FROM fee_payments WHERE madrasa_id = ? AND student_id IN (${sMarks}) ORDER BY id DESC LIMIT 500`,
            [tid].concat(studentIds)
          );
      collections.fee_items = isIncremental
        ? await db.all("SELECT * FROM fee_items WHERE madrasa_id = ? AND updated_at >= ?", [tid, sinceSql])
        : await db.all("SELECT * FROM fee_items WHERE madrasa_id = ? AND status = 'active'", [tid]);
      if (hifzEnabled) {
        collections.quran_progress = isIncremental
          ? await db.all(
              `SELECT * FROM quran_progress WHERE madrasa_id = ? AND student_id IN (${sMarks}) AND updated_at >= ? ORDER BY progress_date DESC, id DESC LIMIT 500`,
              [tid].concat(studentIds, [sinceSql])
            )
          : await db.all(
              `SELECT * FROM quran_progress WHERE madrasa_id = ? AND student_id IN (${sMarks}) ORDER BY progress_date DESC, id DESC LIMIT 500`,
              [tid].concat(studentIds)
            );
      }
    } else {
      collections.term_summaries = [];
      collections.results = [];
      collections.attendance = [];
      collections.fee_assignments = [];
      collections.fee_payments = [];
      collections.fee_items = [];
      if (hifzEnabled) collections.quran_progress = [];
    }

    return ok(res, {
      ok: true,
      syncVersion: SYNC_VERSION,
      isIncremental,
      since: sinceSql,
      serverTime,
      serverCursor,
      profile: {
        role: req.user.role,
        madrasaId: tid,
        category,
        hifzEnabled,
        permissions,
        institution: madrasa,
        user: req.user,
      },
      features,
      collections,
      idMap,
    });
  }

  /* --------------------------- Teacher Scope ----------------------------- */
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    const assignedIds = [...scope.assignedClassIds].map(Number).filter(Boolean);

    collections.subjects = isIncremental
      ? await db.all("SELECT * FROM subjects WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id ASC", [tid, sinceSql])
      : await db.all("SELECT * FROM subjects WHERE madrasa_id = ? ORDER BY id ASC", [tid]);
    collections.class_subjects = await db.all("SELECT * FROM class_subjects WHERE madrasa_id = ?", [tid]);
    collections.grading_config = await db.all("SELECT * FROM grading_config WHERE madrasa_id = ?", [tid]);
    collections.teacher_assignments = await db.all(
      "SELECT * FROM teacher_assignments WHERE madrasa_id = ? AND user_id = ?",
      [tid, req.user.id]
    );

    if (scope.anyClassAnySubject) {
      collections.classes = isIncremental
        ? await db.all("SELECT * FROM classes WHERE madrasa_id = ? AND updated_at >= ? ORDER BY sort_order ASC, id ASC", [tid, sinceSql])
        : await db.all("SELECT * FROM classes WHERE madrasa_id = ? ORDER BY sort_order ASC, id ASC", [tid]);
      collections.students = isIncremental
        ? await db.all("SELECT * FROM students WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id ASC LIMIT 5000", [tid, sinceSql])
        : await db.all("SELECT * FROM students WHERE madrasa_id = ? ORDER BY id ASC LIMIT 5000", [tid]);
    } else if (assignedIds.length) {
      const cMarks = assignedIds.map(() => "?").join(",");
      collections.classes = isIncremental
        ? await db.all(`SELECT * FROM classes WHERE madrasa_id = ? AND id IN (${cMarks}) AND updated_at >= ? ORDER BY sort_order ASC, id ASC`, [tid].concat(assignedIds, [sinceSql]))
        : await db.all(`SELECT * FROM classes WHERE madrasa_id = ? AND id IN (${cMarks}) ORDER BY sort_order ASC, id ASC`, [tid].concat(assignedIds));
      collections.students = isIncremental
        ? await db.all(`SELECT * FROM students WHERE madrasa_id = ? AND class_id IN (${cMarks}) AND updated_at >= ? ORDER BY id ASC LIMIT 5000`, [tid].concat(assignedIds, [sinceSql]))
        : await db.all(`SELECT * FROM students WHERE madrasa_id = ? AND class_id IN (${cMarks}) ORDER BY id ASC LIMIT 5000`, [tid].concat(assignedIds));
    } else {
      collections.classes = [];
      collections.students = [];
    }

    // Active/revoked student card codes for offline gate/classroom QR scanning
    if (scope.anyClassAnySubject || assignedIds.length) {
      if (scope.anyClassAnySubject) {
        collections.card_credentials = isIncremental
          ? await db.all("SELECT id, madrasa_id, holder_type, holder_id, code, status, updated_at FROM card_credentials WHERE madrasa_id = ? AND holder_type = 'student' AND updated_at >= ? LIMIT 5000", [tid, sinceSql])
          : await db.all("SELECT id, madrasa_id, holder_type, holder_id, code, status, updated_at FROM card_credentials WHERE madrasa_id = ? AND holder_type = 'student' LIMIT 5000", [tid]);
      } else {
        const cMarks = assignedIds.map(() => "?").join(",");
        collections.card_credentials = isIncremental
          ? await db.all(
              `SELECT cc.id, cc.madrasa_id, cc.holder_type, cc.holder_id, cc.code, cc.status, cc.updated_at
                 FROM card_credentials cc
                 JOIN students s ON s.id = cc.holder_id AND s.madrasa_id = cc.madrasa_id
                WHERE cc.madrasa_id = ? AND cc.holder_type = 'student' AND s.class_id IN (${cMarks}) AND cc.updated_at >= ?
                LIMIT 5000`,
              [tid].concat(assignedIds, [sinceSql])
            )
          : await db.all(
              `SELECT cc.id, cc.madrasa_id, cc.holder_type, cc.holder_id, cc.code, cc.status, cc.updated_at
                 FROM card_credentials cc
                 JOIN students s ON s.id = cc.holder_id AND s.madrasa_id = cc.madrasa_id
                WHERE cc.madrasa_id = ? AND cc.holder_type = 'student' AND s.class_id IN (${cMarks})
                LIMIT 5000`,
              [tid].concat(assignedIds)
            );
      }
    } else {
      collections.card_credentials = [];
    }

    // Attendance & results scoped to teacher's assigned classes/subjects
    if (scope.anyClassAnySubject || assignedIds.length) {
      const cMarks = assignedIds.map(() => "?").join(",");
      if (scope.anyClassAnySubject) {
        collections.attendance = isIncremental
          ? await db.all("SELECT * FROM attendance WHERE madrasa_id = ? AND updated_at >= ? ORDER BY day DESC LIMIT 5000", [tid, sinceSql])
          : await db.all("SELECT * FROM attendance WHERE madrasa_id = ? AND day >= ? ORDER BY day DESC LIMIT 5000", [tid, recentCutoffDate]);
      } else {
        collections.attendance = isIncremental
          ? await db.all(`SELECT * FROM attendance WHERE madrasa_id = ? AND class_id IN (${cMarks}) AND updated_at >= ? ORDER BY day DESC LIMIT 5000`, [tid].concat(assignedIds, [sinceSql]))
          : await db.all(`SELECT * FROM attendance WHERE madrasa_id = ? AND class_id IN (${cMarks}) AND day >= ? ORDER BY day DESC LIMIT 5000`, [tid].concat(assignedIds, [recentCutoffDate]));
      }

      if (hasPerm("results.enter") || hasPerm("report_cards.view")) {
        let rawResults = [];
        if (scope.anyClassAnySubject) {
          rawResults = isIncremental
            ? await db.all("SELECT * FROM results WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id DESC LIMIT 5000", [tid, sinceSql])
            : await db.all(
                currentSessionId
                  ? "SELECT * FROM results WHERE madrasa_id = ? AND session_id = ? ORDER BY id DESC LIMIT 5000"
                  : "SELECT * FROM results WHERE madrasa_id = ? ORDER BY id DESC LIMIT 5000",
                currentSessionId ? [tid, currentSessionId] : [tid]
              );
        } else {
          rawResults = isIncremental
            ? await db.all(`SELECT * FROM results WHERE madrasa_id = ? AND class_id IN (${cMarks}) AND updated_at >= ? ORDER BY id DESC LIMIT 5000`, [tid].concat(assignedIds, [sinceSql]))
            : await db.all(
                currentSessionId
                  ? `SELECT * FROM results WHERE madrasa_id = ? AND session_id = ? AND class_id IN (${cMarks}) ORDER BY id DESC LIMIT 5000`
                  : `SELECT * FROM results WHERE madrasa_id = ? AND class_id IN (${cMarks}) ORDER BY id DESC LIMIT 5000`,
                currentSessionId ? [tid, currentSessionId].concat(assignedIds) : [tid].concat(assignedIds)
              );
        }
        collections.results = rawResults.filter((r) => teacherCanAccess(scope, r.class_id, r.subject_id));
      } else {
        collections.results = [];
      }

      if (hifzEnabled) {
        if (scope.anyClassAnySubject) {
          collections.quran_progress = isIncremental
            ? await db.all("SELECT * FROM quran_progress WHERE madrasa_id = ? AND updated_at >= ? ORDER BY progress_date DESC, id DESC LIMIT 1000", [tid, sinceSql])
            : await db.all("SELECT * FROM quran_progress WHERE madrasa_id = ? ORDER BY progress_date DESC, id DESC LIMIT 1000", [tid]);
        } else {
          collections.quran_progress = isIncremental
            ? await db.all(
                `SELECT qp.* FROM quran_progress qp
                   JOIN students s ON s.id = qp.student_id AND s.madrasa_id = qp.madrasa_id
                  WHERE qp.madrasa_id = ? AND s.class_id IN (${cMarks}) AND qp.updated_at >= ?
                  ORDER BY qp.progress_date DESC, qp.id DESC LIMIT 1000`,
                [tid].concat(assignedIds, [sinceSql])
              )
            : await db.all(
                `SELECT qp.* FROM quran_progress qp
                   JOIN students s ON s.id = qp.student_id AND s.madrasa_id = qp.madrasa_id
                  WHERE qp.madrasa_id = ? AND s.class_id IN (${cMarks})
                  ORDER BY qp.progress_date DESC, qp.id DESC LIMIT 1000`,
                [tid].concat(assignedIds)
              );
        }
      }
    } else {
      collections.attendance = [];
      collections.results = [];
      if (hifzEnabled) collections.quran_progress = [];
    }

    collections.timetable_slots = assignedIds.length
      ? await db.all(
          `SELECT * FROM timetable_slots WHERE madrasa_id = ? AND (teacher_id = ? OR class_id IN (${assignedIds.map(() => "?").join(",")}))`,
          [tid, req.user.id].concat(assignedIds)
        )
      : await db.all("SELECT * FROM timetable_slots WHERE madrasa_id = ? AND teacher_id = ?", [tid, req.user.id]);

    collections.announcements = isIncremental
      ? await db.all(
          `SELECT * FROM announcements
            WHERE madrasa_id = ? AND status = 'published' AND is_active = 1 AND updated_at >= ?
              AND (target_type IN ('all','institution','teachers') OR audience IN ('all','teachers'))
            ORDER BY id DESC LIMIT 100`,
          [tid, sinceSql]
        )
      : await db.all(
          `SELECT * FROM announcements
            WHERE madrasa_id = ? AND status = 'published' AND is_active = 1
              AND (target_type IN ('all','institution','teachers') OR audience IN ('all','teachers'))
            ORDER BY id DESC LIMIT 100`,
          [tid]
        );

    return ok(res, {
      ok: true,
      syncVersion: SYNC_VERSION,
      isIncremental,
      since: sinceSql,
      serverTime,
      serverCursor,
      profile: {
        role: req.user.role,
        madrasaId: tid,
        category,
        hifzEnabled,
        permissions,
        institution: madrasa,
        user: req.user,
      },
      features,
      collections,
      idMap,
    });
  }

  /* ------------------ Institution Admin / Super Admin -------------------- */
  collections.classes = isIncremental
    ? await db.all("SELECT * FROM classes WHERE madrasa_id = ? AND updated_at >= ? ORDER BY sort_order ASC, id ASC", [tid, sinceSql])
    : await db.all("SELECT * FROM classes WHERE madrasa_id = ? ORDER BY sort_order ASC, id ASC", [tid]);
  collections.subjects = isIncremental
    ? await db.all("SELECT * FROM subjects WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id ASC", [tid, sinceSql])
    : await db.all("SELECT * FROM subjects WHERE madrasa_id = ? ORDER BY id ASC", [tid]);
  collections.class_subjects = await db.all("SELECT * FROM class_subjects WHERE madrasa_id = ?", [tid]);
  collections.grading_config = await db.all("SELECT * FROM grading_config WHERE madrasa_id = ?", [tid]);
  collections.timetable_slots = await db.all("SELECT * FROM timetable_slots WHERE madrasa_id = ?", [tid]);

  if (hasPerm("teachers.view")) {
    collections.teachers = await db.all(
      `SELECT u.id, u.madrasa_id, u.username, u.role, u.full_name, u.full_name_ar, u.email, u.phone, u.is_active,
              p.staff_id, p.position, p.department, p.employment_type, p.status AS profile_status, p.photo_path, p.updated_at
         FROM users u
         LEFT JOIN teacher_profiles p ON p.user_id = u.id AND p.madrasa_id = u.madrasa_id
        WHERE u.madrasa_id = ? AND u.role = 'teacher'
        ORDER BY u.id ASC`,
      [tid]
    );
    collections.teacher_assignments = await db.all("SELECT * FROM teacher_assignments WHERE madrasa_id = ?", [tid]);
  }

  if (hasPerm("students.view")) {
    collections.students = isIncremental
      ? await db.all("SELECT * FROM students WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id ASC LIMIT 5000", [tid, sinceSql])
      : await db.all("SELECT * FROM students WHERE madrasa_id = ? ORDER BY id ASC LIMIT 5000", [tid]);
  }

  collections.card_credentials = isIncremental
    ? await db.all("SELECT id, madrasa_id, holder_type, holder_id, code, status, updated_at FROM card_credentials WHERE madrasa_id = ? AND updated_at >= ? LIMIT 5000", [tid, sinceSql])
    : await db.all("SELECT id, madrasa_id, holder_type, holder_id, code, status, updated_at FROM card_credentials WHERE madrasa_id = ? LIMIT 5000", [tid]);

  collections.attendance = isIncremental
    ? await db.all("SELECT * FROM attendance WHERE madrasa_id = ? AND updated_at >= ? ORDER BY day DESC LIMIT 5000", [tid, sinceSql])
    : await db.all("SELECT * FROM attendance WHERE madrasa_id = ? AND day >= ? ORDER BY day DESC LIMIT 5000", [tid, recentCutoffDate]);

  collections.teacher_attendance = isIncremental
    ? await db.all("SELECT * FROM teacher_attendance WHERE madrasa_id = ? AND updated_at >= ? ORDER BY day DESC LIMIT 2000", [tid, sinceSql])
    : await db.all("SELECT * FROM teacher_attendance WHERE madrasa_id = ? AND day >= ? ORDER BY day DESC LIMIT 2000", [tid, recentCutoffDate]);

  if (hasPerm("results.enter") || hasPerm("report_cards.view")) {
    collections.results = isIncremental
      ? await db.all("SELECT * FROM results WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id DESC LIMIT 5000", [tid, sinceSql])
      : await db.all(
          currentSessionId
            ? "SELECT * FROM results WHERE madrasa_id = ? AND session_id = ? ORDER BY id DESC LIMIT 5000"
            : "SELECT * FROM results WHERE madrasa_id = ? ORDER BY id DESC LIMIT 5000",
          currentSessionId ? [tid, currentSessionId] : [tid]
        );
    collections.term_summaries = currentSessionId
      ? await db.all("SELECT * FROM term_summaries WHERE madrasa_id = ? AND session_id = ? ORDER BY id DESC LIMIT 2000", [tid, currentSessionId])
      : await db.all("SELECT * FROM term_summaries WHERE madrasa_id = ? ORDER BY id DESC LIMIT 2000", [tid]);
  }

  if (hifzEnabled) {
    collections.quran_progress = isIncremental
      ? await db.all("SELECT * FROM quran_progress WHERE madrasa_id = ? AND updated_at >= ? ORDER BY progress_date DESC, id DESC LIMIT 2000", [tid, sinceSql])
      : await db.all("SELECT * FROM quran_progress WHERE madrasa_id = ? ORDER BY progress_date DESC, id DESC LIMIT 2000", [tid]);
  }

  if (hasPerm("fees.view")) {
    collections.fee_items = isIncremental
      ? await db.all("SELECT * FROM fee_items WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id DESC", [tid, sinceSql])
      : await db.all("SELECT * FROM fee_items WHERE madrasa_id = ? ORDER BY id DESC", [tid]);
    collections.fee_assignments = isIncremental
      ? await db.all("SELECT * FROM fee_assignments WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id DESC LIMIT 5000", [tid, sinceSql])
      : await db.all("SELECT * FROM fee_assignments WHERE madrasa_id = ? ORDER BY id DESC LIMIT 5000", [tid]);
  }

  if (hasPerm("payments.view")) {
    collections.fee_payments = isIncremental
      ? await db.all("SELECT * FROM fee_payments WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id DESC LIMIT 2000", [tid, sinceSql])
      : await db.all("SELECT * FROM fee_payments WHERE madrasa_id = ? ORDER BY id DESC LIMIT 2000", [tid]);
  }

  if (hasPerm("expenses.view")) {
    collections.expense_categories = await db.all("SELECT * FROM expense_categories WHERE madrasa_id = ? ORDER BY id ASC", [tid]);
    collections.expenses = isIncremental
      ? await db.all("SELECT * FROM expenses WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id DESC LIMIT 2000", [tid, sinceSql])
      : await db.all("SELECT * FROM expenses WHERE madrasa_id = ? ORDER BY id DESC LIMIT 2000", [tid]);
  }

  if (hasPerm("communication.view")) {
    collections.announcements = isIncremental
      ? await db.all("SELECT * FROM announcements WHERE madrasa_id = ? AND updated_at >= ? ORDER BY id DESC LIMIT 200", [tid, sinceSql])
      : await db.all("SELECT * FROM announcements WHERE madrasa_id = ? ORDER BY id DESC LIMIT 200", [tid]);
  }

  return ok(res, {
    ok: true,
    syncVersion: SYNC_VERSION,
    isIncremental,
    since: sinceSql,
    serverTime,
    serverCursor,
    profile: {
      role: req.user.role,
      madrasaId: tid,
      category,
      hifzEnabled,
      permissions,
      institution: madrasa,
      user: req.user,
    },
    features,
    collections,
    idMap,
  });
}));

/* ============================================================================
   3. POST /api/sync/push — idempotent Outbox mutation processor
   ========================================================================== */

function normalizeMutationType(item) {
  if (item && typeof item.type === "string" && item.type.includes(".")) {
    const [e, a] = item.type.trim().toLowerCase().split(".", 2);
    return { entity: cleanStr(e, 60), action: cleanStr(a, 60) };
  }
  return {
    entity: cleanStr(item && item.entity, 60).toLowerCase(),
    action: cleanStr(item && item.action, 60).toLowerCase(),
  };
}

/* ------------------------ individual mutation handlers -------------------- */

async function handleStudentCreate(ctx, payload) {
  const { req, tid } = ctx;
  if (!(await can(req, "students.create"))) {
    throw new SyncMutationError("rejected", "PERMISSION_DENIED", "You do not have permission to add students.");
  }
  const limitCheck = await checkPlanLimits(db, tid, "student");
  if (!limitCheck.allowed) {
    throw new SyncMutationError("rejected", "PLAN_LIMIT_REACHED", limitCheck.message, { limit: limitCheck.limit, count: limitCheck.count });
  }

  const b = payload || {};
  const firstName = cleanStr(b.first_name || b.firstName, 100);
  const lastName = cleanStr(b.last_name || b.lastName, 100);
  if (!firstName) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "First name is required.");

  const classId = b.class_id || b.classId ? toNum(b.class_id || b.classId, 0) : null;
  if (classId && !(await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]))) {
    throw new SyncMutationError("rejected", "UNKNOWN_CLASS", "Unknown class.");
  }
  const sessionId = b.session_id || b.sessionId ? toNum(b.session_id || b.sessionId, 0) : null;
  if (sessionId && !(await db.get("SELECT id FROM academic_sessions WHERE id = ? AND madrasa_id = ?", [sessionId, tid]))) {
    throw new SyncMutationError("rejected", "UNKNOWN_SESSION", "Unknown academic session.");
  }
  const islamicClassId = b.islamic_class_id ? toNum(b.islamic_class_id, 0) : null;
  const westernClassId = b.western_class_id ? toNum(b.western_class_id, 0) : null;
  for (const cid of [islamicClassId, westernClassId].filter(Boolean)) {
    if (!(await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [cid, tid]))) {
      throw new SyncMutationError("rejected", "UNKNOWN_CLASS", "Unknown education-track class.");
    }
  }

  const dob = b.date_of_birth ? validDate(b.date_of_birth) : null;
  if (b.date_of_birth && !dob) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Invalid date of birth (use YYYY-MM-DD).");
  const admissionDate = validDate(b.admission_date) || new Date().toISOString().slice(0, 10);
  if (b.admission_date && !validDate(b.admission_date)) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Invalid admission date.");

  if (!validPhone(b.parent_phone) || !validPhone(b.alternative_phone)) {
    throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Invalid guardian phone number.");
  }
  if (!validEmail(b.parent_email)) {
    throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Invalid guardian email.");
  }

  const requestedAdmission = cleanStr(b.admission_no, 60).toUpperCase();
  const { admissionNo: generatedAdmission } = await admission.nextAdmissionNo(tid);
  const admissionNo = requestedAdmission || generatedAdmission;
  const studentCode = cleanStr(b.student_code, 60).toUpperCase() || admissionNo;

  if (await db.get("SELECT id FROM students WHERE madrasa_id = ? AND admission_no = ?", [tid, admissionNo])) {
    throw new SyncMutationError("conflict", "DUPLICATE_ADMISSION_NO", `Admission number ${admissionNo} is already in use.`);
  }
  if (await db.get("SELECT id FROM students WHERE madrasa_id = ? AND student_code = ?", [tid, studentCode])) {
    throw new SyncMutationError("conflict", "DUPLICATE_STUDENT_CODE", `Student ID ${studentCode} is already in use.`);
  }

  const track = cleanStr(b.education_track, 20);
  const r = await db.run(
    `INSERT INTO students (
      madrasa_id, admission_no, student_code, first_name, middle_name, last_name, preferred_name, name_ar,
      gender, date_of_birth, nationality, state_of_origin, lga, religion, admission_date, class_id, section,
      islamic_class_id, western_class_id, islamic_program, western_program, session_id, program, education_track, student_type, previous_school, previous_class, status,
      parent_name, father_name, mother_name, guardian_name, guardian_relationship, parent_phone, alternative_phone,
      parent_email, address, residential_address, emergency_contact, emergency_info, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tid, admissionNo, studentCode, firstName, cleanStr(b.middle_name, 100), lastName, cleanStr(b.preferred_name, 100), cleanStr(b.name_ar, 160),
      cleanStr(b.gender, 10), dob, cleanStr(b.nationality, 80), cleanStr(b.state_of_origin, 80), cleanStr(b.lga, 80), cleanStr(b.religion, 60), admissionDate, classId, cleanStr(b.section, 80),
      islamicClassId, westernClassId, cleanStr(b.islamic_program, 120), cleanStr(b.western_program, 120), sessionId, cleanStr(b.program, 120), ["islamic", "western", "both"].includes(track) ? track : "both", cleanStr(b.student_type, 20) || "new", cleanStr(b.previous_school, 200), cleanStr(b.previous_class, 120), "active",
      cleanStr(b.parent_name, 160), cleanStr(b.father_name, 160), cleanStr(b.mother_name, 160), cleanStr(b.guardian_name, 160), cleanStr(b.guardian_relationship, 80), cleanStr(b.parent_phone, 60), cleanStr(b.alternative_phone, 60),
      cleanStr(b.parent_email, 120), cleanStr(b.address, 255), cleanStr(b.residential_address, 255), cleanStr(b.emergency_contact, 160), cleanStr(b.emergency_info, 2000), cleanStr(b.notes, 2000),
    ]
  );
  const newId = Number(r.lastInsertRowid);
  if (classId || sessionId) {
    await db.run(
      "INSERT INTO student_class_history (madrasa_id, student_id, from_class_id, to_class_id, from_session_id, to_session_id, action, changed_by) VALUES (?,?,?,?,?,?,?,?)",
      [tid, newId, null, classId, null, sessionId, "enrollment", req.user.id]
    );
  }
  await audit.record(req, {
    action: "student.create",
    module: "students",
    entity: "student",
    entityId: newId,
    after: { admission_no: admissionNo, student_code: studentCode, first_name: firstName, last_name: lastName, class_id: classId },
    meta: { via: "offline_sync" },
  });
  return { serverId: newId, data: { id: newId, admissionNo, studentCode } };
}

async function handleStudentUpdate(ctx, payload) {
  const { req, tid, batchIdMap } = ctx;
  if (!(await can(req, "students.edit"))) {
    throw new SyncMutationError("rejected", "PERMISSION_DENIED", "You do not have permission to edit students.");
  }
  const b = payload || {};
  const studentId = await resolveEntityId(tid, "student", b.id || b.student_id || b.studentId, batchIdMap);
  if (!studentId) throw new SyncMutationError("rejected", "UNKNOWN_STUDENT", "Student ID could not be resolved.");
  const existing = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [studentId, tid]);
  if (!existing) throw new SyncMutationError("rejected", "UNKNOWN_STUDENT", "Student not found in this institution.");

  const sets = [];
  const vals = [];
  const fieldMap = {
    first_name: 100, middle_name: 100, last_name: 100, name_ar: 160, preferred_name: 100, gender: 10,
    nationality: 80, state_of_origin: 80, lga: 80, religion: 60, section: 80, program: 120, islamic_program: 120, western_program: 120,
    education_track: 20, student_type: 20, previous_school: 200, previous_class: 120,
    parent_name: 160, father_name: 160, mother_name: 160, guardian_name: 160, guardian_relationship: 80,
    address: 255, residential_address: 255, emergency_contact: 160, emergency_info: 2000, notes: 2000,
  };
  for (const [f, max] of Object.entries(fieldMap)) {
    if (b[f] !== undefined) {
      if (f === "first_name" && !cleanStr(b[f], max)) {
        throw new SyncMutationError("rejected", "VALIDATION_ERROR", "First name cannot be empty.");
      }
      sets.push(`${f} = ?`);
      vals.push(cleanStr(b[f], max));
    }
  }
  if (b.date_of_birth !== undefined) {
    const d = b.date_of_birth ? validDate(b.date_of_birth) : null;
    if (b.date_of_birth && !d) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Invalid date of birth.");
    sets.push("date_of_birth = ?");
    vals.push(d);
  }
  if (b.parent_phone !== undefined) {
    if (!validPhone(b.parent_phone)) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Invalid parent phone.");
    sets.push("parent_phone = ?");
    vals.push(cleanStr(b.parent_phone, 60));
  }
  if (b.alternative_phone !== undefined) {
    if (!validPhone(b.alternative_phone)) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Invalid alternative phone.");
    sets.push("alternative_phone = ?");
    vals.push(cleanStr(b.alternative_phone, 60));
  }
  if (b.parent_email !== undefined) {
    if (!validEmail(b.parent_email)) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Invalid parent email.");
    sets.push("parent_email = ?");
    vals.push(cleanStr(b.parent_email, 120));
  }
  if (b.class_id !== undefined) {
    const cid = b.class_id ? toNum(b.class_id, 0) : null;
    if (cid && !(await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [cid, tid]))) {
      throw new SyncMutationError("rejected", "UNKNOWN_CLASS", "Unknown class.");
    }
    sets.push("class_id = ?");
    vals.push(cid);
  }
  if (!sets.length) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Nothing to update.");
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(studentId, tid);
  await db.run(`UPDATE students SET ${sets.join(", ")} WHERE id = ? AND madrasa_id = ?`, vals);
  await audit.record(req, { action: "student.update", module: "students", entity: "student", entityId: studentId, meta: { via: "offline_sync" } });
  return { serverId: studentId, data: { id: studentId } };
}

async function handleAttendanceMark(ctx, payload) {
  const { req, tid, batchIdMap } = ctx;
  const b = payload || {};
  const classId = toNum(b.classId || b.class_id, 0);
  const day = validDate(b.date || b.day);
  if (!classId || !day) {
    throw new SyncMutationError("rejected", "VALIDATION_ERROR", "classId and date (YYYY-MM-DD) are required.");
  }
  const cls = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!cls) throw new SyncMutationError("rejected", "UNKNOWN_CLASS", "Class not found.");
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!teacherCanMarkAttendance(scope, classId)) {
      throw new SyncMutationError("rejected", "PERMISSION_DENIED", "You are not assigned to mark attendance for this class.");
    }
  }
  const termCtx = await resolveTermContext(tid, day, b.termId || b.term_id, b.sessionId || b.session_id);
  if (termCtx.error) throw new SyncMutationError("rejected", "VALIDATION_ERROR", termCtx.error);

  // Normalize single-student `{ studentId, status, note }` or register `{ statuses: { id: ... }, notes: { ... } }`
  let entriesMap = {};
  const notesMap = b.notes && typeof b.notes === "object" ? b.notes : {};
  if (b.statuses && typeof b.statuses === "object") {
    entriesMap = b.statuses;
  } else if (b.studentId !== undefined || b.student_id !== undefined) {
    const key = String(b.studentId !== undefined ? b.studentId : b.student_id);
    entriesMap[key] = { status: b.status, note: b.note || b.attendance_note || "" };
  }

  const rawKeys = Object.keys(entriesMap);
  if (!rawKeys.length || rawKeys.length > 500) {
    throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Provide between 1 and 500 attendance entries.");
  }

  let saved = 0;
  for (const rawKey of rawKeys) {
    const studentId = await resolveEntityId(tid, "student", rawKey, batchIdMap);
    if (!studentId) continue;
    const rawVal = entriesMap[rawKey];
    const status = typeof rawVal === "object" && rawVal !== null
      ? cleanStr(rawVal.status, 20).toLowerCase()
      : cleanStr(rawVal, 20).toLowerCase();
    const note = typeof rawVal === "object" && rawVal !== null
      ? cleanStr(rawVal.note || rawVal.notes || notesMap[rawKey], 2000)
      : cleanStr(notesMap[rawKey], 2000);
    if (!STUDENT_ATTENDANCE_STATUSES.has(status)) continue;

    const student = await db.get("SELECT id FROM students WHERE id = ? AND madrasa_id = ? AND class_id = ?", [studentId, tid, classId]);
    if (!student) continue;

    const existing = await db.get("SELECT id FROM attendance WHERE madrasa_id = ? AND student_id = ? AND day = ?", [tid, studentId, day]);
    if (existing) {
      await db.run(
        "UPDATE attendance SET status = ?, class_id = ?, term_id = ?, session_id = ?, attendance_note = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
        [status, classId, termCtx.termId, termCtx.sessionId, note, req.user.id, existing.id, tid]
      );
    } else {
      await db.run(
        "INSERT INTO attendance (madrasa_id, student_id, class_id, term_id, session_id, day, status, attendance_note, recorded_by) VALUES (?,?,?,?,?,?,?,?,?)",
        [tid, studentId, classId, termCtx.termId, termCtx.sessionId, day, status, note, req.user.id]
      );
    }
    await notifyAttendanceBestEffort(tid, studentId, status, day, req.user.id);
    saved += 1;
  }

  await logActivity(db, {
    madrasaId: tid,
    userId: req.user.id,
    action: "attendance.mark",
    entity: "class",
    entityId: String(classId),
    meta: { date: day, saved, via: "offline_sync" },
    ip: req.ip,
  });
  return { serverId: `${classId}:${day}`, data: { saved, classId, date: day } };
}

async function handleAttendanceScan(ctx, payload, clientTimestamp) {
  const { req, tid, madrasa } = ctx;
  const b = payload || {};
  const code = cardCreds.normaliseCode(b.code || b.card_code || b.card);
  if (!code) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Card code is required.");
  const day = validDate(b.date) || (clientTimestamp ? validDate(String(clientTimestamp).slice(0, 10)) : null) || new Date().toISOString().slice(0, 10);

  const credential = await db.get("SELECT * FROM card_credentials WHERE madrasa_id = ? AND code = ?", [tid, code]);
  if (!credential) {
    throw new SyncMutationError("rejected", "CARD_NOT_FOUND", "Card code does not belong to this institution.");
  }
  const resolved = await cardCreds.lookupCard(code);
  if (!resolved) {
    throw new SyncMutationError("rejected", "HOLDER_NOT_FOUND", "Card holder is no longer on this institution's register.");
  }

  const card = cardCreds.cardVerificationView(resolved);
  const holder = resolved.holder;
  if (!card.valid) {
    throw new SyncMutationError(
      "conflict",
      credential.status === "revoked" ? "CARD_REVOKED" : "CARD_INACTIVE",
      credential.status === "revoked"
        ? "This card was cancelled before sync completed — attendance was not marked."
        : "Card holder is not active — attendance was not marked.",
      { verdict: card.verdict, cardCode: card.code }
    );
  }

  const termCtx = await resolveTermContext(tid, day, b.termId || b.term_id, b.sessionId || b.session_id);
  if (termCtx.error) throw new SyncMutationError("rejected", "VALIDATION_ERROR", termCtx.error);

  if (card.holderType === "teacher") {
    if (!["madrasa_admin", "super_admin"].includes(req.user.role)) {
      throw new SyncMutationError("rejected", "PERMISSION_DENIED", "Staff attendance cards can only be recorded by an administrator.");
    }
    const status = TEACHER_ATTENDANCE_STATUSES.has(String(b.status || "").toLowerCase()) ? String(b.status).toLowerCase() : "present";
    const checkIn = (b.checkIn || b.check_in) ? timeOrBlank(b.checkIn || b.check_in) : schoolClock(madrasa.timezone, clientTimestamp);
    if (checkIn === null) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Check-in must use HH:MM.");
    const existing = await db.get("SELECT id FROM teacher_attendance WHERE madrasa_id = ? AND user_id = ? AND day = ?", [tid, holder.id, day]);
    if (existing) {
      await db.run(
        "UPDATE teacher_attendance SET status = ?, term_id = ?, session_id = ?, check_in = ?, notes = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
        [status, termCtx.termId, termCtx.sessionId, checkIn, cleanStr(b.note || b.notes, 2000), req.user.id, existing.id, tid]
      );
    } else {
      await db.run(
        "INSERT INTO teacher_attendance (madrasa_id, user_id, day, term_id, session_id, status, check_in, check_out, notes, recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [tid, holder.id, day, termCtx.termId, termCtx.sessionId, status, checkIn, cleanStr(b.check_out, 5), cleanStr(b.note || b.notes, 2000), req.user.id]
      );
    }
    return { serverId: Number(holder.id), data: { holderType: "teacher", holderId: Number(holder.id), day, status, checkIn } };
  }

  const classId = Number(holder.class_id || 0);
  if (!classId) {
    throw new SyncMutationError("conflict", "STUDENT_NO_CLASS", "Student is not assigned to a class.");
  }
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!teacherCanMarkAttendance(scope, classId)) {
      throw new SyncMutationError("rejected", "PERMISSION_DENIED", "You are not assigned to this student's class.");
    }
  }
  const status = STUDENT_ATTENDANCE_STATUSES.has(String(b.status || "").toLowerCase()) ? String(b.status).toLowerCase() : "present";
  const existing = await db.get("SELECT id, attendance_note FROM attendance WHERE madrasa_id = ? AND student_id = ? AND day = ?", [tid, holder.id, day]);
  const note = cleanStr(b.note || b.notes, 2000) || (existing && existing.attendance_note) || "Marked from offline ID card scan";
  if (existing) {
    await db.run(
      "UPDATE attendance SET status = ?, class_id = ?, term_id = ?, session_id = ?, attendance_note = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
      [status, classId, termCtx.termId, termCtx.sessionId, note, req.user.id, existing.id, tid]
    );
  } else {
    await db.run(
      "INSERT INTO attendance (madrasa_id, student_id, class_id, term_id, session_id, day, status, attendance_note, recorded_by) VALUES (?,?,?,?,?,?,?,?,?)",
      [tid, holder.id, classId, termCtx.termId, termCtx.sessionId, day, status, note, req.user.id]
    );
  }
  await notifyAttendanceBestEffort(tid, Number(holder.id), status, day, req.user.id);
  return { serverId: Number(holder.id), data: { holderType: "student", holderId: Number(holder.id), classId, day, status } };
}

async function handleTeacherAttendanceMark(ctx, payload) {
  const { req, tid } = ctx;
  if (!["madrasa_admin", "super_admin"].includes(req.user.role)) {
    throw new SyncMutationError("rejected", "PERMISSION_DENIED", "Only administrators can record staff attendance.");
  }
  const b = payload || {};
  const day = validDate(b.date || b.day);
  if (!day) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Valid date (YYYY-MM-DD) is required.");
  const termCtx = await resolveTermContext(tid, day, b.termId || b.term_id, b.sessionId || b.session_id);
  if (termCtx.error) throw new SyncMutationError("rejected", "VALIDATION_ERROR", termCtx.error);

  const list = Array.isArray(b.entries)
    ? b.entries
    : [{ userId: b.userId || b.user_id, status: b.status, checkIn: b.checkIn || b.check_in, checkOut: b.checkOut || b.check_out, notes: b.notes || b.note }];
  if (!list.length || list.length > 200) {
    throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Provide between 1 and 200 staff attendance entries.");
  }

  let saved = 0;
  for (const item of list) {
    const uid = toNum(item && (item.userId || item.user_id), 0);
    const status = cleanStr(item && item.status, 20).toLowerCase();
    if (!uid || !TEACHER_ATTENDANCE_STATUSES.has(status)) continue;
    const staff = await db.get("SELECT id FROM users WHERE id = ? AND madrasa_id = ? AND role = 'teacher'", [uid, tid]);
    if (!staff) continue;
    const checkIn = timeOrBlank(item.checkIn || item.check_in);
    const checkOut = timeOrBlank(item.checkOut || item.check_out);
    if (checkIn === null || checkOut === null) {
      throw new SyncMutationError("rejected", "VALIDATION_ERROR", "checkIn/checkOut must use HH:MM.");
    }
    const existing = await db.get("SELECT id FROM teacher_attendance WHERE madrasa_id = ? AND user_id = ? AND day = ?", [tid, uid, day]);
    if (existing) {
      await db.run(
        "UPDATE teacher_attendance SET status = ?, term_id = ?, session_id = ?, check_in = ?, check_out = ?, notes = ?, recorded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?",
        [status, termCtx.termId, termCtx.sessionId, checkIn, checkOut, cleanStr(item.notes || item.note, 2000), req.user.id, existing.id, tid]
      );
    } else {
      await db.run(
        "INSERT INTO teacher_attendance (madrasa_id, user_id, day, term_id, session_id, status, check_in, check_out, notes, recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [tid, uid, day, termCtx.termId, termCtx.sessionId, status, checkIn, checkOut, cleanStr(item.notes || item.note, 2000), req.user.id]
      );
    }
    saved += 1;
  }
  return { serverId: day, data: { saved, date: day } };
}

async function handleResultsUpsert(ctx, payload) {
  const { req, tid, batchIdMap } = ctx;
  if (!(await can(req, "results.enter"))) {
    throw new SyncMutationError("rejected", "PERMISSION_DENIED", "You do not have permission to enter results.");
  }
  const b = payload || {};
  const classId = toNum(b.classId || b.class_id, 0);
  const termId = toNum(b.termId || b.term_id, 0);
  const subjectId = toNum(b.subjectId || b.subject_id, 0);
  const rawEntries = Array.isArray(b.entries)
    ? b.entries
    : (b.studentId !== undefined || b.student_id !== undefined ? [b] : []);
  if (!classId || !termId || !subjectId || !rawEntries.length) {
    throw new SyncMutationError("rejected", "VALIDATION_ERROR", "classId, termId, subjectId and at least one score entry are required.");
  }
  if (rawEntries.length > 500) {
    throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Too many result entries in one mutation (max 500).");
  }

  const cls = await db.get("SELECT id FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!cls) throw new SyncMutationError("rejected", "UNKNOWN_CLASS", "Class not found.");
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!teacherCanAccess(scope, classId, subjectId)) {
      throw new SyncMutationError("rejected", "PERMISSION_DENIED", "You are not assigned to enter results for this class and subject.");
    }
  }
  const term = await db.get("SELECT id, session_id FROM terms WHERE id = ? AND madrasa_id = ?", [termId, tid]);
  if (!term) throw new SyncMutationError("rejected", "UNKNOWN_TERM", "Term not found.");
  const subj = await db.get("SELECT id FROM subjects WHERE id = ? AND madrasa_id = ?", [subjectId, tid]);
  if (!subj) throw new SyncMutationError("rejected", "UNKNOWN_SUBJECT", "Subject not found.");

  const cfg = await grading.getGradingConfig(tid);
  const classStudents = new Set(
    (await db.all("SELECT id FROM students WHERE madrasa_id = ? AND class_id = ? AND status IN ('active','promoted','suspended')", [tid, classId]))
      .map((r) => Number(r.id))
  );

  const requestedStatus = ["draft", "submitted"].includes(String(b.status || "draft").toLowerCase())
    ? String(b.status || "draft").toLowerCase()
    : "draft";
  if (requestedStatus === "submitted" && !(await can(req, "results.submit"))) {
    throw new SyncMutationError("rejected", "PERMISSION_DENIED", "You do not have permission to submit results.");
  }

  const prepared = [];
  for (const entry of rawEntries) {
    const studentId = await resolveEntityId(tid, "student", entry.studentId !== undefined ? entry.studentId : entry.student_id, batchIdMap);
    if (!studentId || !classStudents.has(studentId)) {
      throw new SyncMutationError("rejected", "STUDENT_NOT_IN_CLASS", `Student ${entry.studentId || entry.student_id} is not active in this class.`);
    }
    const ca = Number(entry.ca === "" || entry.ca === null || entry.ca === undefined ? 0 : entry.ca);
    const exam = Number(entry.exam === "" || entry.exam === null || entry.exam === undefined ? 0 : entry.exam);
    if (!Number.isFinite(ca) || ca < 0 || ca > cfg.caMax) {
      throw new SyncMutationError("rejected", "VALIDATION_ERROR", `CA for student ${studentId} must be between 0 and ${cfg.caMax}.`);
    }
    if (!Number.isFinite(exam) || exam < 0 || exam > cfg.examMax) {
      throw new SyncMutationError("rejected", "VALIDATION_ERROR", `Exam score for student ${studentId} must be between 0 and ${cfg.examMax}.`);
    }
    const total = Math.round((ca + exam) * 100) / 100;
    const pct = grading.pctOf(cfg, total);
    const grade = grading.gradeForPct(cfg, pct);
    prepared.push({
      studentId,
      ca,
      exam,
      total,
      grade: grade.grade,
      point: grade.point,
      remark: String(entry.teacherRemark || entry.teacher_remark || "").slice(0, 5000),
    });
  }

  // Cell-level conflict guard: refuse overwriting published or locked marks.
  const frozen = await db.all(
    "SELECT student_id, status FROM results WHERE madrasa_id = ? AND class_id = ? AND term_id = ? AND subject_id = ? AND status IN ('published','locked')",
    [tid, classId, termId, subjectId]
  );
  const frozenSet = new Set(frozen.map((r) => Number(r.student_id)));
  const blocked = prepared.filter((p) => frozenSet.has(p.studentId));
  if (blocked.length) {
    throw new SyncMutationError(
      "conflict",
      "RESULTS_FROZEN",
      `${blocked.length} result(s) for this subject are already published or locked on the server.`,
      { studentIds: blocked.map((x) => x.studentId) }
    );
  }

  const submittedAt = requestedStatus === "submitted" ? toSqlUtc(new Date()) : null;
  await db.transaction(async (tx) => {
    for (const entry of prepared) {
      const existing = await tx.get(
        "SELECT id FROM results WHERE madrasa_id = ? AND student_id = ? AND term_id = ? AND subject_id = ?",
        [tid, entry.studentId, termId, subjectId]
      );
      if (existing) {
        await tx.run(
          `UPDATE results SET ca = ?, exam = ?, total = ?, grade = ?, grade_point = ?, teacher_remark = ?, status = ?,
             entered_by = COALESCE(entered_by, ?), modified_by = ?, submitted_at = ?,
             approved_by = NULL, approved_at = NULL, published_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [entry.ca, entry.exam, entry.total, entry.grade, entry.point, entry.remark, requestedStatus, req.user.id, req.user.id, submittedAt, existing.id]
        );
      } else {
        await tx.run(
          `INSERT INTO results (madrasa_id, student_id, class_id, session_id, term_id, subject_id, ca, exam, total, status, grade, grade_point, teacher_remark, entered_by, modified_by, submitted_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [tid, entry.studentId, classId, term.session_id, termId, subjectId, entry.ca, entry.exam, entry.total, requestedStatus, entry.grade, entry.point, entry.remark, req.user.id, req.user.id, submittedAt]
        );
      }
    }
  });

  await db.run("UPDATE term_summaries SET published_at = NULL WHERE madrasa_id = ? AND class_id = ? AND term_id = ?", [tid, classId, termId]);
  await audit.record(req, {
    action: requestedStatus === "submitted" ? "results.submit" : "results.entry",
    module: "academic",
    entity: "results",
    entityId: `${classId}:${termId}:${subjectId}`,
    after: { status: requestedStatus },
    meta: { class_id: classId, term_id: termId, subject_id: subjectId, updated: prepared.length, via: "offline_sync" },
  });
  return { serverId: `${classId}:${termId}:${subjectId}`, data: { updated: prepared.length, status: requestedStatus } };
}

function parseHifzFields(b, partial) {
  const data = {};
  const has = (k, alt) => b[k] !== undefined || (alt && b[alt] !== undefined);
  const val = (k, alt) => (b[k] !== undefined ? b[k] : b[alt]);

  if (has("progress_date", "date")) {
    const d = validDate(val("progress_date", "date"));
    if (!d) return { error: "A valid progress date (YYYY-MM-DD) is required." };
    data.progress_date = d;
  } else if (!partial) {
    data.progress_date = new Date().toISOString().slice(0, 10);
  }
  if (has("surah")) data.surah = cleanStr(b.surah, 80);
  if (has("juz")) data.juz = cleanStr(b.juz, 20);
  if (has("ayah_from", "ayahFrom")) {
    const n = toNum(val("ayah_from", "ayahFrom"), 0);
    if (n < 0 || n > 286) return { error: "Ayah start must be between 0 and 286." };
    data.ayah_from = n || null;
  }
  if (has("ayah_to", "ayahTo")) {
    const n = toNum(val("ayah_to", "ayahTo"), 0);
    if (n < 0 || n > 286) return { error: "Ayah end must be between 0 and 286." };
    data.ayah_to = n || null;
  }
  if (data.ayah_from && data.ayah_to && data.ayah_to < data.ayah_from) {
    return { error: "Ayah end must not come before ayah start." };
  }
  if (has("memorization_progress", "memorizationProgress")) {
    data.memorization_progress = clampNum(val("memorization_progress", "memorizationProgress"), 0, 100, 0);
  }
  if (has("revision_progress", "revisionProgress")) {
    data.revision_progress = clampNum(val("revision_progress", "revisionProgress"), 0, 100, 0);
  }
  for (const [k, alt, label] of [["recitation_assessment", "recitationAssessment", "Recitation"], ["tajweed_assessment", "tajweedAssessment", "Tajweed"]]) {
    if (has(k, alt)) {
      const raw = val(k, alt);
      if (raw === null || raw === undefined || String(raw).trim() === "") data[k] = null;
      else {
        const s = Number(raw);
        if (!Number.isFinite(s) || s < 1 || s > 5) return { error: `${label} assessment must be between 1 and 5.` };
        data[k] = Math.round(s);
      }
    }
  }
  if (has("teacher_comments", "teacherComments")) {
    data.teacher_comments = cleanStr(val("teacher_comments", "teacherComments"), 3000);
  }
  if (has("performance_status", "performanceStatus")) {
    const st = cleanStr(val("performance_status", "performanceStatus"), 30).toLowerCase();
    if (st && !HIFZ_PERFORMANCE_STATUSES.has(st)) return { error: "Invalid performance status." };
    data.performance_status = st || "developing";
  }
  if (!partial && !data.surah && !data.juz) return { error: "Provide at least a Surah or Juz." };
  return { data };
}

async function handleQuranProgressCreate(ctx, payload) {
  const { req, tid, madrasa, batchIdMap } = ctx;
  if (!(await hifzAllowedForTenant(tid, madrasa.category))) {
    throw new SyncMutationError("rejected", "HIFZ_DISABLED", "Qur'an progress is not enabled for this institution.");
  }
  const b = payload || {};
  const studentId = await resolveEntityId(tid, "student", b.student_id !== undefined ? b.student_id : b.studentId, batchIdMap);
  if (!studentId) throw new SyncMutationError("rejected", "UNKNOWN_STUDENT", "student_id is required.");
  const student = await db.get("SELECT id, class_id FROM students WHERE id = ? AND madrasa_id = ?", [studentId, tid]);
  if (!student) throw new SyncMutationError("rejected", "UNKNOWN_STUDENT", "Student not found.");
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!student.class_id || !teacherCanMarkAttendance(scope, Number(student.class_id))) {
      throw new SyncMutationError("rejected", "PERMISSION_DENIED", "Student is not in an assigned class.");
    }
  }
  const parsed = parseHifzFields(b, false);
  if (parsed.error) throw new SyncMutationError("rejected", "VALIDATION_ERROR", parsed.error);
  const d = parsed.data;
  const r = await db.run(
    `INSERT INTO quran_progress
       (madrasa_id, student_id, surah, juz, ayah_from, ayah_to, memorization_progress, revision_progress,
        recitation_assessment, tajweed_assessment, teacher_comments, progress_date, performance_status, recorded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tid, studentId, d.surah || "", d.juz || "", d.ayah_from || null, d.ayah_to || null,
      d.memorization_progress || 0, d.revision_progress || 0, d.recitation_assessment || null,
      d.tajweed_assessment || null, d.teacher_comments || "", d.progress_date,
      d.performance_status || "developing", req.user.id,
    ]
  );
  const newId = Number(r.lastInsertRowid);
  return { serverId: newId, data: { id: newId, studentId } };
}

async function handleQuranProgressUpdate(ctx, payload) {
  const { req, tid, madrasa, batchIdMap } = ctx;
  if (!(await hifzAllowedForTenant(tid, madrasa.category))) {
    throw new SyncMutationError("rejected", "HIFZ_DISABLED", "Qur'an progress is not enabled for this institution.");
  }
  const b = payload || {};
  const recordId = await resolveEntityId(tid, "quran_progress", b.id || b.record_id || b.recordId, batchIdMap);
  if (!recordId) throw new SyncMutationError("rejected", "NOT_FOUND", "Qur'an progress record ID could not be resolved.");
  const record = await db.get("SELECT * FROM quran_progress WHERE id = ? AND madrasa_id = ?", [recordId, tid]);
  if (!record) throw new SyncMutationError("rejected", "NOT_FOUND", "Qur'an progress record not found.");
  if (req.user.role === "teacher" && Number(record.recorded_by) !== Number(req.user.id)) {
    throw new SyncMutationError("rejected", "PERMISSION_DENIED", "Teachers may only edit their own Qur'an progress entries.");
  }
  const parsed = parseHifzFields(b, true);
  if (parsed.error) throw new SyncMutationError("rejected", "VALIDATION_ERROR", parsed.error);
  const entries = Object.entries(parsed.data);
  if (!entries.length) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Nothing to update.");
  const finalFrom = Object.prototype.hasOwnProperty.call(parsed.data, "ayah_from") ? parsed.data.ayah_from : record.ayah_from;
  const finalTo = Object.prototype.hasOwnProperty.call(parsed.data, "ayah_to") ? parsed.data.ayah_to : record.ayah_to;
  if (finalFrom && finalTo && Number(finalTo) < Number(finalFrom)) {
    throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Ayah end must not come before ayah start.");
  }
  const sets = entries.map(([k]) => `${k} = ?`);
  const vals = entries.map(([, v]) => v);
  vals.push(recordId, tid);
  await db.run(`UPDATE quran_progress SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?`, vals);
  return { serverId: recordId, data: { id: recordId } };
}

async function handleFeePaymentRecord(ctx, payload) {
  const { req, tid, features, batchIdMap } = ctx;
  if (!features.fees) {
    throw new SyncMutationError("rejected", "feature_gated", "Fees & payments require an upgraded subscription plan.");
  }
  if (!(await can(req, "payments.create"))) {
    throw new SyncMutationError("rejected", "PERMISSION_DENIED", "You do not have permission to record fee payments.");
  }
  const b = payload || {};
  const studentId = await resolveEntityId(tid, "student", b.student_id !== undefined ? b.student_id : b.studentId, batchIdMap);
  const student = studentId ? await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [studentId, tid]) : null;
  if (!student) throw new SyncMutationError("rejected", "UNKNOWN_STUDENT", "Student not found.");

  const amount = clampNum(b.amount_ngn !== undefined ? b.amount_ngn : b.amount, 0, 999999999, 0);
  if (amount <= 0) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "A positive payment amount is required.");
  const day = validDate(b.payment_date || b.paymentDate) || new Date().toISOString().slice(0, 10);
  const status = PAYMENT_STATUSES.has(cleanStr(b.status, 20)) ? cleanStr(b.status, 20) : "successful";
  const method = PAYMENT_METHODS.has(cleanStr(b.method, 40)) ? cleanStr(b.method, 40) : "cash";
  const reference = cleanStr(b.transaction_number || b.reference, 160);

  if (reference) {
    const duplicate = await db.get(
      "SELECT id, receipt_number FROM fee_payments WHERE madrasa_id = ? AND (reference = ? OR transaction_number = ?)",
      [tid, reference, reference]
    );
    if (duplicate) {
      throw new SyncMutationError(
        "conflict",
        "DUPLICATE_PAYMENT_REFERENCE",
        `A payment with reference "${reference}" already exists (${duplicate.receipt_number || "#" + duplicate.id}).`,
        { existingPaymentId: Number(duplicate.id), receiptNumber: duplicate.receipt_number }
      );
    }
  }

  const feeItemId = b.fee_item_id ? toNum(b.fee_item_id, 0) : null;
  let fee = null;
  if (feeItemId) {
    fee = await db.get("SELECT * FROM fee_items WHERE id = ? AND madrasa_id = ?", [feeItemId, tid]);
    if (!fee) throw new SyncMutationError("rejected", "UNKNOWN_FEE_ITEM", "Unknown fee structure.");
  }
  const parent = await db.get("SELECT user_id FROM parent_links WHERE madrasa_id = ? AND student_id = ? ORDER BY id LIMIT 1", [tid, studentId]);
  const sessionId = b.session_id ? toNum(b.session_id, 0) : (fee && fee.session_id) || null;
  const termId = b.term_id ? toNum(b.term_id, 0) : (fee && fee.term_id) || null;

  const r = await db.run(
    `INSERT INTO fee_payments
       (madrasa_id, student_id, parent_user_id, fee_item_id, fee_assignment_id, amount_ngn, payment_date,
        session_id, term_id, method, reference, transaction_number, recorded_by, status, notes, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    [
      tid, studentId, (parent && parent.user_id) || null, feeItemId,
      b.fee_assignment_id ? toNum(b.fee_assignment_id, 0) : null,
      amount, day, sessionId, termId, method, reference, reference,
      req.user.id, status, cleanStr(b.notes, 2000),
    ]
  );
  const id = Number(r.lastInsertRowid);
  const receipt = `REC-${tid}-${String(id).padStart(6, "0")}`;
  await db.run("UPDATE fee_payments SET receipt_number = ? WHERE id = ? AND madrasa_id = ?", [receipt, id, tid]);
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "fee_payment.record", entity: "fee_payment", entityId: String(id), meta: { amount, status, via: "offline_sync" }, ip: req.ip });
  return { serverId: id, data: { id, receipt_number: receipt, status, amount_ngn: amount } };
}

async function handleExpenseCreate(ctx, payload) {
  const { req, tid, features } = ctx;
  if (!features.expenses) {
    throw new SyncMutationError("rejected", "feature_gated", "Expenses & budgeting require an upgraded subscription plan.");
  }
  if (!(await can(req, "expenses.create"))) {
    throw new SyncMutationError("rejected", "PERMISSION_DENIED", "You do not have permission to record expenses.");
  }
  const b = payload || {};
  const categoryId = toNum(b.category_id || b.categoryId, 0);
  if (!categoryId) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Expense category is required.");
  const category = await db.get("SELECT id FROM expense_categories WHERE id = ? AND madrasa_id = ?", [categoryId, tid]);
  if (!category) throw new SyncMutationError("rejected", "UNKNOWN_CATEGORY", "Expense category not found.");

  const rawAmt = Number(b.amount_ngn !== undefined ? b.amount_ngn : b.amount);
  const amountNgn = Number.isFinite(rawAmt) ? Math.round((rawAmt + Number.EPSILON) * 100) / 100 : 0;
  if (amountNgn <= 0) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Expense amount must be greater than zero.");

  const paymentDate = validDate(b.payment_date || b.paymentDate) || new Date().toISOString().slice(0, 10);
  const rawMethod = cleanStr(b.payment_method || b.paymentMethod, 40).toLowerCase();
  const paymentMethod = EXPENSE_PAYMENT_METHODS.has(rawMethod) ? rawMethod : "cash";

  let sessionId = toNum(b.session_id || b.sessionId, 0);
  if (!sessionId) {
    const curSession = await db.get("SELECT id FROM academic_sessions WHERE madrasa_id = ? AND is_current = 1 LIMIT 1", [tid]);
    sessionId = curSession ? Number(curSession.id) : null;
  }
  let termId = toNum(b.term_id || b.termId, 0);
  if (!termId && sessionId) {
    const curTerm = await db.get("SELECT id FROM terms WHERE madrasa_id = ? AND session_id = ? ORDER BY position ASC LIMIT 1", [tid, sessionId]);
    termId = curTerm ? Number(curTerm.id) : null;
  }

  // Offline expenses always land as 'draft' so an administrator approves them.
  const r = await db.run(
    `INSERT INTO expenses (
       madrasa_id, category_id, session_id, term_id, amount_ngn, vendor,
       description, receipt_path, payment_date, payment_method, approved_by,
       status, created_by, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'draft',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      tid, categoryId, sessionId, termId, amountNgn,
      cleanStr(b.vendor, 180), cleanStr(b.description, 2000),
      "", paymentDate, paymentMethod, req.user.id,
    ]
  );
  const newId = Number(r.lastInsertRowid);
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "expense.create", entity: "expense", entityId: String(newId), meta: { amountNgn, via: "offline_sync" }, ip: req.ip });
  return { serverId: newId, data: { id: newId, status: "draft", amount_ngn: amountNgn } };
}

async function handleAnnouncementCreate(ctx, payload) {
  const { req, tid } = ctx;
  if (!["madrasa_admin", "super_admin"].includes(req.user.role) || !(await can(req, "communication.send"))) {
    throw new SyncMutationError("rejected", "PERMISSION_DENIED", "Only administrators with communication permission can publish announcements.");
  }
  const b = payload || {};
  const title = cleanStr(b.title, 200);
  const body = cleanStr(b.body !== undefined ? b.body : b.content, 10000);
  if (!title || !body) throw new SyncMutationError("rejected", "VALIDATION_ERROR", "Announcement title and body are required.");

  const rawTarget = cleanStr(b.target_type || b.audience, 40).toLowerCase();
  const target = ANNOUNCEMENT_TARGETS.has(rawTarget) ? rawTarget : "all";
  const rawStatus = cleanStr(b.status, 20).toLowerCase();
  const status = ANNOUNCEMENT_STATUSES.has(rawStatus) ? rawStatus : "published";
  const scheduledAt = b.scheduled_at ? validDate(b.scheduled_at) : null;
  if (status === "scheduled" && !scheduledAt) {
    throw new SyncMutationError("rejected", "VALIDATION_ERROR", "scheduled_at (YYYY-MM-DD) is required for scheduled announcements.");
  }
  const publishedAt = status === "published" ? toSqlUtc(new Date()) : null;
  const audience = ["all", "students", "parents"].includes(target) ? target : (target === "institution" ? "all" : target);
  const ids = Array.isArray(b.target_ids) ? b.target_ids.map((x) => toNum(x, 0)).filter(Boolean) : [];

  const r = await db.run(
    `INSERT INTO announcements
       (madrasa_id, title, body, audience, is_active, created_by, publish_public, publish_until,
        status, scheduled_at, published_at, image_path, attachment_path, attachment_name, attachment_mime,
        target_type, target_ids, category, event_date, event_location, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    [
      tid, title, body, audience, status === "published" ? 1 : 0, req.user.id,
      b.publish_public ? 1 : 0, validDate(b.publish_until),
      status, scheduledAt, publishedAt, "", "", "", "",
      target, JSON.stringify(ids), cleanStr(b.category, 60) || "Announcement",
      validDate(b.event_date), cleanStr(b.event_location, 255),
    ]
  );
  const id = Number(r.lastInsertRowid);
  if (status === "published") {
    try {
      await communication.notifyAudience(tid, { target_type: target, target_ids: ids }, {
        type: "announcement", title, body, entity_type: "announcement", entity_id: id,
      });
    } catch (e) { /* non-fatal */ }
  }
  await logActivity(db, { madrasaId: tid, userId: req.user.id, action: "announcement.create", entity: "announcement", entityId: String(id), meta: { via: "offline_sync" }, ip: req.ip });
  return { serverId: id, data: { id, status } };
}

const MUTATION_DISPATCH = {
  "student.create": handleStudentCreate,
  "student.update": handleStudentUpdate,
  "attendance.mark": handleAttendanceMark,
  "attendance.scan": handleAttendanceScan,
  "teacher_attendance.mark": handleTeacherAttendanceMark,
  "results.upsert": handleResultsUpsert,
  "quran_progress.create": handleQuranProgressCreate,
  "quran_progress.update": handleQuranProgressUpdate,
  "fee_payment.record": handleFeePaymentRecord,
  "expense.create": handleExpenseCreate,
  "announcement.create": handleAnnouncementCreate,
};

/* ----------------------------- push endpoint ------------------------------ */

router.post("/push", requireTenant, asyncHandler(async (req, res) => {
  if (!["madrasa_admin", "teacher", "super_admin"].includes(req.user.role)) {
    return err(res, 403, "Offline Outbox push is restricted to institution staff.");
  }
  const tid = effectiveTenantId(req);
  if (!tid) return err(res, 400, "Institution context required.");

  const madrasa = await db.get("SELECT id, category, timezone, status FROM madaris WHERE id = ?", [tid]);
  if (!madrasa || madrasa.status !== "active") {
    return err(res, 404, "Active institution not found.");
  }

  const mutations = req.body && Array.isArray(req.body.mutations) ? req.body.mutations : null;
  if (!mutations) {
    return err(res, 400, "mutations[] array is required.");
  }
  if (mutations.length > MAX_PUSH_BATCH) {
    return err(res, 400, `Too many mutations in one push request (max ${MAX_PUSH_BATCH}). Split the Outbox into smaller batches.`);
  }

  const features = await resolveFeatureFlags(req, tid);
  const batchIdMap = new Map();
  const responseIdMap = {};
  const results = [];
  const summary = { total: mutations.length, applied: 0, duplicate: 0, conflict: 0, rejected: 0 };

  const ctx = { req, tid, madrasa, features, batchIdMap };

  for (const rawItem of mutations) {
    const clientMutationId = cleanStr(rawItem && (rawItem.clientMutationId || rawItem.client_mutation_id || rawItem.id), 120);
    const { entity, action } = normalizeMutationType(rawItem || {});
    const opKey = `${entity}.${action}`;
    const localId = cleanStr(rawItem && (rawItem.localId || rawItem.local_id), 120);
    const clientTimestamp = cleanStr(rawItem && (rawItem.clientTimestamp || rawItem.client_timestamp), 40);
    const payload = (rawItem && typeof rawItem.payload === "object" && rawItem.payload !== null) ? rawItem.payload : {};

    if (!clientMutationId) {
      summary.rejected += 1;
      results.push({
        clientMutationId: "",
        type: opKey,
        localId,
        status: "rejected",
        code: "MISSING_MUTATION_ID",
        error: "Each mutation must include a unique clientMutationId.",
      });
      continue;
    }

    const handler = MUTATION_DISPATCH[opKey];
    if (!handler) {
      summary.rejected += 1;
      results.push({
        clientMutationId,
        type: opKey,
        localId,
        status: "rejected",
        code: "UNSUPPORTED_MUTATION",
        error: `Unsupported offline mutation "${opKey}".`,
      });
      continue;
    }

    // 1. Check idempotency ledger first
    const prior = await db.get(
      "SELECT * FROM sync_mutations WHERE madrasa_id = ? AND client_mutation_id = ?",
      [tid, clientMutationId]
    );
    if (prior && prior.status === "applied") {
      if (prior.local_id && prior.server_id) {
        const numericOrStr = Number(prior.server_id) || prior.server_id;
        batchIdMap.set(`${prior.entity}:${prior.local_id}`, numericOrStr);
        batchIdMap.set(prior.local_id, numericOrStr);
        responseIdMap[`${prior.entity}:${prior.local_id}`] = numericOrStr;
      }
      let cachedData = null;
      try { cachedData = prior.response_json ? JSON.parse(prior.response_json) : null; } catch (e) { cachedData = null; }
      summary.duplicate += 1;
      results.push({
        clientMutationId,
        type: opKey,
        localId: prior.local_id || localId,
        serverId: Number(prior.server_id) || prior.server_id || null,
        status: "duplicate",
        alreadyApplied: true,
        data: cachedData,
      });
      continue;
    }

    // 2. Atomically claim the clientMutationId so two parallel network retries
    //    can never execute the same mutation concurrently.
    let claimRowId = 0;
    try {
      const claim = await db.run(
        `INSERT INTO sync_mutations (madrasa_id, user_id, client_mutation_id, entity, action, local_id, server_id, status, response_json)
         VALUES (?,?,?,?,?,?,'','processing',NULL)`,
        [tid, req.user.id, clientMutationId, entity, action, localId]
      );
      claimRowId = Number(claim.lastInsertRowid);
    } catch (claimErr) {
      const raced = await db.get(
        "SELECT * FROM sync_mutations WHERE madrasa_id = ? AND client_mutation_id = ?",
        [tid, clientMutationId]
      );
      if (raced && raced.status === "applied") {
        let cachedData = null;
        try { cachedData = raced.response_json ? JSON.parse(raced.response_json) : null; } catch (e) { cachedData = null; }
        summary.duplicate += 1;
        results.push({
          clientMutationId,
          type: opKey,
          localId: raced.local_id || localId,
          serverId: Number(raced.server_id) || raced.server_id || null,
          status: "duplicate",
          alreadyApplied: true,
          data: cachedData,
        });
      } else {
        summary.conflict += 1;
        results.push({
          clientMutationId,
          type: opKey,
          localId,
          status: "conflict",
          code: "MUTATION_IN_FLIGHT",
          error: "This offline change is already being processed by another request.",
        });
      }
      continue;
    }

    // 3. Execute handler; finalize when applied, release claim on failure/rejection
    try {
      const outcome = await handler(ctx, payload, clientTimestamp);
      const serverIdStr = outcome.serverId !== undefined && outcome.serverId !== null ? String(outcome.serverId) : "";
      const responseJson = JSON.stringify(outcome.data || {});
      await db.run(
        "UPDATE sync_mutations SET status = 'applied', server_id = ?, response_json = ? WHERE id = ?",
        [serverIdStr, responseJson, claimRowId]
      );
      if (localId && serverIdStr) {
        const numericOrStr = Number(serverIdStr) || serverIdStr;
        batchIdMap.set(`${entity}:${localId}`, numericOrStr);
        batchIdMap.set(localId, numericOrStr);
        responseIdMap[`${entity}:${localId}`] = numericOrStr;
      }
      summary.applied += 1;
      results.push({
        clientMutationId,
        type: opKey,
        localId,
        serverId: outcome.serverId !== undefined ? outcome.serverId : null,
        status: "applied",
        data: outcome.data || {},
      });
    } catch (mutErr) {
      await db.run("DELETE FROM sync_mutations WHERE id = ? AND status = 'processing'", [claimRowId]).catch(() => {});
      if (mutErr instanceof SyncMutationError) {
        if (mutErr.statusKind === "conflict") summary.conflict += 1;
        else summary.rejected += 1;
        results.push(Object.assign({}, mutErr.extra, {
          clientMutationId,
          type: opKey,
          localId,
          status: mutErr.statusKind,
          code: mutErr.code,
          error: mutErr.message,
        }));
      } else {
        console.error(`Offline sync mutation failed (${opKey}):`, mutErr);
        summary.rejected += 1;
        results.push({
          clientMutationId,
          type: opKey,
          localId,
          status: "rejected",
          code: "INTERNAL_ERROR",
          error: "Server could not apply this offline change.",
        });
      }
    }
  }

  const now = new Date();
  return ok(res, {
    ok: true,
    syncVersion: SYNC_VERSION,
    serverTime: now.toISOString(),
    serverCursor: toSqlUtc(now),
    summary,
    idMap: responseIdMap,
    results,
  });
}));

module.exports = { router, SUPPORTED_MUTATIONS, parseSinceCursor, toSqlUtc };
