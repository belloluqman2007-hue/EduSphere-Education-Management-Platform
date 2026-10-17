"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — analytics service (dashboard aggregates)
   ----------------------------------------------------------------------------
   Read-only aggregate queries behind the dashboards: enrolment trends,
   attendance, fee collection and academic performance.

   TENANT SAFETY
   This module never reads a tenant id from a request. Every tenant query takes
   an explicit madrasaId that the ROUTE layer resolved from the authenticated
   user (see middleware/tenant.js), and every statement below filters by
   madrasa_id. Platform-wide aggregates are deliberately separate
   (platformAnalytics) and are mounted behind requireSuperAdmin only.

   DIALECT NOTES (sqlite dev / mysql production)
     • Month/day bucketing differs per driver, so the SQL expression comes from
       monthExpr()/dayExpr() after db.dialect().
     • MySQL returns DECIMAL columns as strings, so every numeric read goes
       through num().
     • MySQL returns DATE/TIMESTAMP as JS Date objects, so date columns are
       always projected through dayExpr() rather than selected raw.
   ========================================================================== */
const db = require("../db");
const grading = require("./grading");
const { toNum } = require("../util");

/** Statuses that count as "on the roll" (mirrors students.js / fees.js). */
const ACTIVE_STATUSES = "('active','promoted','suspended')";

/* ------------------------------ helpers -------------------------------- */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, dp = 1) {
  const f = 10 ** dp;
  return Math.round(num(v) * f) / f;
}

/** Percent of part/whole, rounded to 1dp; 0 when there is nothing to divide. */
function pct(part, whole) {
  const w = num(whole);
  if (w <= 0) return 0;
  return round((num(part) / w) * 100, 1);
}

/** 'YYYY-MM-DD' (all dates in this app are plain calendar dates). */
function isoDate(d) {
  return (
    d.getFullYear() +
    "-" + String(d.getMonth() + 1).padStart(2, "0") +
    "-" + String(d.getDate()).padStart(2, "0")
  );
}

function daysAgo(n, from = new Date()) {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

/** ['2025-10', …, '2026-09'] — the last `count` month keys, ending this month. */
function monthKeys(count, end = new Date()) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
    out.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
  }
  return out;
}

/** ['2026-09-01', …, '2026-09-09'] — the last `count` day keys, ending today. */
function dayKeys(count, end = new Date()) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(daysAgo(i, end));
  return out;
}

/** SQL expression bucketing a date/timestamp column into 'YYYY-MM'. */
function monthExpr(column, dialect) {
  return dialect === "mysql"
    ? `DATE_FORMAT(${column}, '%Y-%m')`
    : `strftime('%Y-%m', ${column})`;
}

/** SQL expression projecting a date column as a plain 'YYYY-MM-DD' string. */
function dayExpr(column, dialect) {
  return dialect === "mysql"
    ? `DATE_FORMAT(${column}, '%Y-%m-%d')`
    : `CAST(${column} AS TEXT)`;
}

/** Turns a grouped time series into a gap-filled [{label, value}] list. */
function fillSeries(labels, rows, key = "m", pick = (r) => num(r.n)) {
  const map = new Map(rows.map((r) => [String(r[key]).slice(0, 10), r]));
  return labels.map((label) => {
    const r = map.get(label);
    return { label, value: r ? pick(r) : 0 };
  });
}

/**
 * Clamps a query-string integer into [min, max]. Anything absent, blank or
 * non-numeric yields the fallback — an empty `?months=` means "not supplied",
 * which must not be read as zero and silently clamped to the minimum.
 */
function clampInt(v, min, max, fallback) {
  if (v === null || v === undefined || String(v).trim() === "") return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* --------------------------- term resolution --------------------------- */

/**
 * The term to report on, in priority order:
 *   1. the term of the CURRENT session that covers today — earliest position
 *      wins, so overlapping (mis-entered) terms still resolve deterministically;
 *   2. otherwise the term that ended most recently (between-terms holiday);
 *   3. otherwise the current session's first term (session not started yet);
 *   4. otherwise the newest session's first term (no session flagged current).
 */
async function currentTerm(madrasaId, today) {
  const base = `SELECT t.id, t.position, t.name_en, t.name_ar, t.session_id, s.label AS session_label
                  FROM terms t
                  JOIN academic_sessions s ON s.id = t.session_id AND s.madrasa_id = t.madrasa_id
                 WHERE t.madrasa_id = ? AND s.is_current = 1`;

  const covering = await db.get(
    base + ` AND (t.start_date IS NULL OR t.start_date <= ?)
                AND (t.end_date IS NULL OR t.end_date >= ?)
            ORDER BY t.position ASC LIMIT 1`,
    [madrasaId, today, today]
  );
  if (covering) return covering;

  const ended = await db.get(
    base + " AND t.end_date < ? ORDER BY t.end_date DESC, t.position DESC LIMIT 1",
    [madrasaId, today]
  );
  if (ended) return ended;

  const firstOfSession = await db.get(base + " ORDER BY t.position ASC LIMIT 1", [madrasaId]);
  if (firstOfSession) return firstOfSession;

  return db.get(
    `SELECT t.id, t.position, t.name_en, t.name_ar, t.session_id, s.label AS session_label
       FROM terms t
       JOIN academic_sessions s ON s.id = t.session_id AND s.madrasa_id = t.madrasa_id
      WHERE t.madrasa_id = ?
      ORDER BY s.is_current DESC, s.id DESC, t.position ASC LIMIT 1`,
    [madrasaId]
  );
}

/* ====================================================================== */
/*  TENANT ANALYTICS — one madrasa                                        */
/* ====================================================================== */

/**
 * @param {number} madrasaId  resolved by the route from the session user
 * @param {object} opts       { months, attendanceDays, termId }
 */
async function tenantAnalytics(madrasaId, opts = {}) {
  const tid = Number(madrasaId);
  if (!Number.isInteger(tid) || tid <= 0) {
    throw new Error("tenantAnalytics requires a positive madrasaId");
  }

  const months = clampInt(opts.months, 3, 36, 12);
  const attendanceDays = clampInt(opts.attendanceDays, 7, 90, 30);
  const dialect = await db.dialect();
  const today = isoDate(new Date());
  const since = daysAgo(attendanceDays - 1);
  const monthStart = today.slice(0, 8) + "01";
  const monthLabels = monthKeys(months);
  const dayLabels = dayKeys(attendanceDays);

  const cfg = await grading.getGradingConfig(tid);

  /* Resolve the reported term. A caller-supplied termId must belong to THIS
     madrasa, otherwise it is ignored (never trust a client-supplied id). */
  let term = null;
  const requested = toNum(opts.termId, 0);
  if (requested) {
    term = await db.get("SELECT id, position, name_en, name_ar, session_id FROM terms WHERE id = ? AND madrasa_id = ?", [requested, tid]);
  }
  if (!term) term = await currentTerm(tid, today);
  const termId = term ? Number(term.id) : 0;

  /* ---------------------------- headline totals ----------------------- */
  const totals = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM students WHERE madrasa_id = ? AND status IN ${ACTIVE_STATUSES}) AS students,
       (SELECT COUNT(*) FROM students WHERE madrasa_id = ? AND status = 'active')            AS active_students,
       (SELECT COUNT(*) FROM students WHERE madrasa_id = ? AND status = 'graduated')         AS graduated,
       (SELECT COUNT(*) FROM students WHERE madrasa_id = ? AND status = 'withdrawn')         AS withdrawn,
       (SELECT COUNT(*) FROM students WHERE madrasa_id = ? AND class_id IS NULL AND status IN ${ACTIVE_STATUSES}) AS unassigned,
       (SELECT COUNT(*) FROM users WHERE madrasa_id = ? AND role = 'teacher' AND is_active = 1) AS teachers,
       (SELECT COUNT(*) FROM users WHERE madrasa_id = ? AND role = 'parent'  AND is_active = 1) AS parents,
       (SELECT COUNT(*) FROM classes  WHERE madrasa_id = ?) AS classes,
       (SELECT COUNT(*) FROM subjects WHERE madrasa_id = ?) AS subjects`,
    [tid, tid, tid, tid, tid, tid, tid, tid, tid]
  );
  const studentCount = num(totals && totals.students);

  /* ---------------------------- enrolment ----------------------------- */
  const [enrolTrendRows, byClassRows, genderRows, births] = await Promise.all([
    db.all(
      `SELECT ${monthExpr("created_at", dialect)} AS m, COUNT(*) AS n
         FROM students WHERE madrasa_id = ?
        GROUP BY ${monthExpr("created_at", dialect)}`,
      [tid]
    ),
    db.all(
      `SELECT c.id, c.name_en, c.name_ar, c.sort_order, COUNT(s.id) AS n
         FROM classes c
         LEFT JOIN students s
           ON s.class_id = c.id AND s.madrasa_id = c.madrasa_id AND s.status IN ${ACTIVE_STATUSES}
        WHERE c.madrasa_id = ?
        GROUP BY c.id, c.name_en, c.name_ar, c.sort_order
        ORDER BY c.sort_order, c.id`,
      [tid]
    ),
    db.all(
      `SELECT gender, COUNT(*) AS n FROM students
        WHERE madrasa_id = ? AND status IN ${ACTIVE_STATUSES}
        GROUP BY gender`,
      [tid]
    ),
    db.all(
      `SELECT date_of_birth AS dob FROM students
        WHERE madrasa_id = ? AND status IN ${ACTIVE_STATUSES} AND date_of_birth IS NOT NULL`,
      [tid]
    ),
  ]);

  const genderMap = new Map();
  for (const g of genderRows) {
    const key = String(g.gender || "").toUpperCase();
    genderMap.set(key === "M" ? "male" : key === "F" ? "female" : "other", num(g.n));
  }
  const byGender = ["male", "female", "other"]
    .map((k) => ({ key: k, value: genderMap.get(k) || 0 }))
    .filter((x) => x.value > 0);

  const ageBands = [
    { key: "u6", min: 0, max: 5, value: 0 },
    { key: "6_8", min: 6, max: 8, value: 0 },
    { key: "9_11", min: 9, max: 11, value: 0 },
    { key: "12_14", min: 12, max: 14, value: 0 },
    { key: "15_17", min: 15, max: 17, value: 0 },
    { key: "18p", min: 18, max: 999, value: 0 },
  ];
  for (const row of births) {
    const raw = row.dob;
    if (!raw) continue;
    const d = raw instanceof Date ? raw : new Date(String(raw).slice(0, 10) + "T00:00:00");
    if (Number.isNaN(d.getTime())) continue;
    let age = new Date().getFullYear() - d.getFullYear();
    const m = new Date().getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && new Date().getDate() < d.getDate())) age -= 1;
    const band = ageBands.find((b) => age >= b.min && age <= b.max);
    if (band) band.value += 1;
  }

  /* ---------------------------- attendance ---------------------------- */
  const [attStatusRows, attDailyRows] = await Promise.all([
    db.all(
      "SELECT status, COUNT(*) AS n FROM attendance WHERE madrasa_id = ? AND day >= ? AND day <= ? GROUP BY status",
      [tid, since, today]
    ),
    db.all(
      `SELECT ${dayExpr("day", dialect)} AS d,
              COUNT(*) AS n,
              SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS attended
         FROM attendance WHERE madrasa_id = ? AND day >= ? AND day <= ?
        GROUP BY ${dayExpr("day", dialect)}`,
      [tid, since, today]
    ),
  ]);

  const attCounts = { present: 0, absent: 0, late: 0, excused: 0 };
  for (const r of attStatusRows) {
    const k = String(r.status || "").toLowerCase();
    if (k in attCounts) attCounts[k] = num(r.n);
  }
  const attMarked = attCounts.present + attCounts.absent + attCounts.late + attCounts.excused;

  const dailyMap = new Map(attDailyRows.map((r) => [String(r.d).slice(0, 10), r]));
  const attendanceDaily = dayLabels.map((label) => {
    const r = dailyMap.get(label);
    const marked = r ? num(r.n) : 0;
    return {
      label,
      marked,
      value: marked > 0 ? pct(r.attended, marked) : null, // null = nothing recorded
    };
  });

  /* ------------------------------- fees -------------------------------- */
  const [feeTotals, feeMonth, feeTrendRows, feeMethodRows, billedRow, paidByStudent, expTotals, expMonth, expTrendRows] = await Promise.all([
    db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount_ngn),0) AS amount FROM fee_payments WHERE madrasa_id = ?", [tid]),
    db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount_ngn),0) AS amount FROM fee_payments WHERE madrasa_id = ? AND payment_date >= ?", [tid, monthStart]),
    db.all(
      `SELECT ${monthExpr("payment_date", dialect)} AS m, COUNT(*) AS n, COALESCE(SUM(amount_ngn),0) AS amount
         FROM fee_payments WHERE madrasa_id = ?
        GROUP BY ${monthExpr("payment_date", dialect)}`,
      [tid]
    ),
    db.all(
      `SELECT method, COUNT(*) AS n, COALESCE(SUM(amount_ngn),0) AS amount
         FROM fee_payments WHERE madrasa_id = ?
        GROUP BY method ORDER BY amount DESC`,
      [tid]
    ),
    db.get("SELECT COALESCE(SUM(amount_ngn),0) AS billed FROM fee_items WHERE madrasa_id = ? AND term_id = ?", [tid, termId]),
    db.all(
      `SELECT fp.student_id, SUM(fp.amount_ngn) AS paid
         FROM fee_payments fp
         JOIN fee_items fi ON fi.id = fp.fee_item_id AND fi.madrasa_id = fp.madrasa_id
        WHERE fp.madrasa_id = ? AND fi.term_id = ?
        GROUP BY fp.student_id`,
      [tid, termId]
    ),
    db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount_ngn),0) AS amount FROM expenses WHERE madrasa_id = ? AND status = 'approved'", [tid]),
    db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_ngn),0) AS amount FROM expenses WHERE madrasa_id = ? AND status = 'approved' AND payment_date >= ?`, [tid, monthStart]),
    db.all(
      `SELECT ${monthExpr("payment_date", dialect)} AS m, COUNT(*) AS n, COALESCE(SUM(amount_ngn),0) AS amount
         FROM expenses WHERE madrasa_id = ? AND status = 'approved'
        GROUP BY ${monthExpr("payment_date", dialect)}`,
      [tid]
    ),
  ]);

  // Billed/outstanding semantics mirror GET /api/fees/balance exactly:
  // the term's fee items are billed to every student on the roll, and only
  // payments allocated to an item in this same term are credited.
  const billedPerStudent = num(billedRow && billedRow.billed);
  const billedTotal = billedPerStudent * studentCount;
  const collected = num(feeTotals && feeTotals.amount);
  const paidMap = new Map(paidByStudent.map((r) => [Number(r.student_id), num(r.paid)]));
  let studentsInDebt = 0;
  let debtTotal = 0;
  if (billedPerStudent > 0) {
    const roll = await db.all(
      `SELECT id FROM students WHERE madrasa_id = ? AND status IN ${ACTIVE_STATUSES}`,
      [tid]
    );
    for (const s of roll) {
      const gap = billedPerStudent - (paidMap.get(Number(s.id)) || 0);
      if (gap > 0) { studentsInDebt += 1; debtTotal += gap; }
    }
  }

  const feesByMethod = feeMethodRows.map((r) => ({
    key: String(r.method || "cash"),
    value: round(num(r.amount), 2),
    payments: num(r.n),
  }));

  /* --------------------------- performance ----------------------------- */
  const [gradeRows, classAvgRows, termAvgRows, summaryTotals] = await Promise.all([
    db.all(
      "SELECT overall_grade AS g, COUNT(*) AS n FROM term_summaries WHERE madrasa_id = ? AND term_id = ? GROUP BY overall_grade",
      [tid, termId]
    ),
    db.all(
      `SELECT c.id, c.name_en, c.name_ar, COUNT(ts.id) AS n, AVG(ts.average) AS avg
         FROM term_summaries ts
         JOIN classes c ON c.id = ts.class_id AND c.madrasa_id = ts.madrasa_id
        WHERE ts.madrasa_id = ? AND ts.term_id = ?
        GROUP BY c.id, c.name_en, c.name_ar
        HAVING COUNT(ts.id) > 0
        ORDER BY avg DESC`,
      [tid, termId]
    ),
    db.all(
      `SELECT t.id, t.position, t.name_en, t.name_ar, s.label AS session_label, s.id AS session_id,
              COUNT(ts.id) AS n, AVG(ts.average) AS avg
         FROM terms t
         JOIN academic_sessions s ON s.id = t.session_id
         LEFT JOIN term_summaries ts ON ts.term_id = t.id AND ts.madrasa_id = t.madrasa_id
        WHERE t.madrasa_id = ?
        GROUP BY t.id, t.position, t.name_en, t.name_ar, s.label, s.id
        ORDER BY s.id, t.position`,
      [tid]
    ),
    db.get(
      `SELECT COUNT(*) AS n,
              AVG(average) AS avg,
              SUM(CASE WHEN average >= ? THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN promotion_status = 'promoted' THEN 1 ELSE 0 END) AS promoted
         FROM term_summaries WHERE madrasa_id = ? AND term_id = ?`,
      [cfg.passMark, tid, termId]
    ),
  ]);

  const gradeOrder = cfg.bands.map((b) => String(b.grade));
  const gradeMap = new Map();
  for (const r of gradeRows) {
    const g = String(r.g || "").trim();
    if (!g) continue;
    gradeMap.set(g, (gradeMap.get(g) || 0) + num(r.n));
  }
  // Always show every configured band so the chart shape is stable; keep any
  // unexpected grade found in the data appended at the end.
  const gradeDistribution = [
    ...gradeOrder.map((g) => ({ grade: g, value: gradeMap.get(g) || 0 })),
    ...Array.from(gradeMap.keys()).filter((g) => !gradeOrder.includes(g)).map((g) => ({ grade: g, value: gradeMap.get(g) })),
  ];

  const classRanking = classAvgRows.map((r) => ({
    id: Number(r.id),
    label: r.name_en,
    labelAr: r.name_ar,
    students: num(r.n),
    value: round(r.avg, 1),
  }));

  const termTrend = termAvgRows.map((r) => ({
    termId: Number(r.id),
    label: `${r.session_label ? r.session_label + " · " : ""}${r.name_en}`,
    labelAr: r.name_ar,
    students: num(r.n),
    value: num(r.n) > 0 ? round(r.avg, 1) : null,
  }));

  const summaryCount = num(summaryTotals && summaryTotals.n);

  /* ----------------------------- watch list ---------------------------- */
  // Students needing attention: below the pass mark, and/or poor attendance in
  // the reporting window. Attendance is only judged when enough days exist.
  const perStudentAtt = await db.all(
    `SELECT student_id, COUNT(*) AS marked,
            SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS attended
       FROM attendance WHERE madrasa_id = ? AND day >= ? AND day <= ?
      GROUP BY student_id`,
    [tid, since, today]
  );
  const attByStudent = new Map(perStudentAtt.map((r) => [Number(r.student_id), { marked: num(r.marked), rate: pct(r.attended, r.marked) }]));

  const rollRows = await db.all(
    `SELECT s.id, s.admission_no, s.first_name, s.last_name, s.name_ar,
            c.name_en AS class_en, c.name_ar AS class_ar,
            ts.average AS average
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN term_summaries ts ON ts.student_id = s.id AND ts.madrasa_id = s.madrasa_id AND ts.term_id = ?
      WHERE s.madrasa_id = ? AND s.status IN ${ACTIVE_STATUSES}`,
    [termId, tid]
  );

  const ATT_FLOOR = 75; // % presence below which attendance is flagged
  const MIN_MARKED_DAYS = 5;
  const watchList = rollRows
    .map((s) => {
      const att = attByStudent.get(Number(s.id)) || { marked: 0, rate: 0 };
      const average = s.average == null ? null : round(s.average, 1);
      const reasons = [];
      if (average != null && average < cfg.passMark) reasons.push("low_grades");
      if (att.marked >= MIN_MARKED_DAYS && att.rate < ATT_FLOOR) reasons.push("low_attendance");
      return {
        id: Number(s.id),
        admissionNo: s.admission_no,
        name: `${s.first_name} ${s.last_name}`.trim(),
        nameAr: s.name_ar || "",
        classEn: s.class_en || "",
        classAr: s.class_ar || "",
        average,
        attendanceRate: att.marked >= MIN_MARKED_DAYS ? att.rate : null,
        reasons,
      };
    })
    .filter((s) => s.reasons.length > 0)
    .sort((a, b) => {
      if (b.reasons.length !== a.reasons.length) return b.reasons.length - a.reasons.length;
      const av = a.average == null ? 999 : a.average;
      const bv = b.average == null ? 999 : b.average;
      return av - bv;
    })
    .slice(0, 10);

  /* ------------------------------ assemble ----------------------------- */
  return {
    generatedAt: new Date().toISOString(),
    window: { months, attendanceDays, since, until: today },
    term: term
      ? {
          id: termId,
          position: num(term.position),
          nameEn: term.name_en,
          nameAr: term.name_ar || "",
          sessionLabel: term.session_label || "",
        }
      : null,
    grading: { passMark: cfg.passMark, caMax: cfg.caMax, examMax: cfg.examMax },
    totals: {
      students: studentCount,
      activeStudents: num(totals && totals.active_students),
      graduated: num(totals && totals.graduated),
      withdrawn: num(totals && totals.withdrawn),
      unassigned: num(totals && totals.unassigned),
      teachers: num(totals && totals.teachers),
      parents: num(totals && totals.parents),
      classes: num(totals && totals.classes),
      subjects: num(totals && totals.subjects),
    },
    enrolment: {
      trend: fillSeries(monthLabels, enrolTrendRows),
      byClass: byClassRows.map((r) => ({
        id: Number(r.id),
        label: r.name_en,
        labelAr: r.name_ar || "",
        value: num(r.n),
      })),
      byGender,
      ageBands: ageBands.map((b) => ({ key: b.key, min: b.min, max: b.max, value: b.value })),
    },
    attendance: {
      marked: attMarked,
      present: attCounts.present,
      late: attCounts.late,
      absent: attCounts.absent,
      excused: attCounts.excused,
      rate: pct(attCounts.present + attCounts.late, attMarked),
      daily: attendanceDaily,
    },
    fees: {
      collected: round(collected, 2),
      payments: num(feeTotals && feeTotals.n),
      thisMonth: round(num(feeMonth && feeMonth.amount), 2),
      thisMonthPayments: num(feeMonth && feeMonth.n),
      billedPerStudent: round(billedPerStudent, 2),
      billedTotal: round(billedTotal, 2),
      outstanding: round(Math.max(0, billedTotal - collected), 2),
      studentsInDebt,
      debtTotal: round(debtTotal, 2),
      collectionRate: billedTotal > 0 ? pct(collected, billedTotal) : 0,
      trend: fillSeries(monthLabels, feeTrendRows, "m", (r) => round(num(r.amount), 2)),
      byMethod: feesByMethod,
    },
    expenses: {
      total: round(num(expTotals && expTotals.amount), 2),
      count: num(expTotals && expTotals.n),
      thisMonth: round(num(expMonth && expMonth.amount), 2),
      trend: fillSeries(monthLabels, expTrendRows, "m", (r) => round(num(r.amount), 2)),
    },
    total_expenses_ngn: round(num(expTotals && expTotals.amount), 2),
    results: {
      termId,
      summaries: summaryCount,
      average: summaryCount > 0 ? round(summaryTotals.avg, 1) : null,
      passRate: summaryCount > 0 ? pct(summaryTotals.passed, summaryCount) : null,
      promoted: num(summaryTotals && summaryTotals.promoted),
      gradeDistribution,
      classRanking,
      termTrend,
    },
    watchList,
  };
}

/* ====================================================================== */
/*  ADVANCED ANALYTICS — the Premium `analytics_advanced` entitlement      */
/* ====================================================================== */
/*
  The standard analytics payload answers "how is the school doing?". This one
  answers the four questions a school asks once it is running well:

    • WHERE is attendance slipping?      → attendanceHeatmap (class × weekday)
    • WHO is carrying the results?       → teacherPerformance
    • WHAT will we collect next quarter? → feeForecast
    • WHICH pattern is behind the dips?  → attendancePatterns

  It is a separate read-only endpoint (`GET /api/madrasa/analytics/advanced`,
  gated on `analytics_advanced`) rather than extra keys on the standard
  payload, so a school on Free or Basic keeps the dashboard it has always had
  and the upgrade offer names exactly what would appear.

  Same tenant rules as everything else here: the madrasa id is passed in by the
  route from the session, and every statement filters by madrasa_id.
*/

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ATT_FLOOR_ADVANCED = 75;   // % presence below which a student is flagged
const MIN_MARKED_DAYS = 5;       // ignore a rate computed from two days of data

/** 0=Sunday … 6=Saturday for a 'YYYY-MM-DD' string (calendar-local, not UTC). */
function weekdayOf(isoDay) {
  const s = String(isoDay || "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(d.getTime()) ? d.getDay() : null;
}

/** Ordinary least-squares slope over a numeric series (per step). */
function slope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((y, x) => { num += (x - meanX) * (y - meanY); den += (x - meanX) ** 2; });
  return den === 0 ? 0 : num / den;
}

const money = (v) => `₦${Math.round(num(v)).toLocaleString("en-NG")}`;

/**
 * @param {number} madrasaId  resolved by the route from the session user
 * @param {object} opts       { months, attendanceDays, termId }
 */
async function advancedAnalytics(madrasaId, opts = {}) {
  const tid = Number(madrasaId);
  if (!Number.isInteger(tid) || tid <= 0) {
    throw new Error("advancedAnalytics requires a positive madrasaId");
  }
  const months = clampInt(opts.months, 3, 12, 6);
  const attendanceDays = clampInt(opts.attendanceDays, 7, 90, 60);
  const dialect = await db.dialect();
  const today = isoDate(new Date());
  const since = daysAgo(attendanceDays - 1);
  const monthLabels = monthKeys(months);
  const cfg = await grading.getGradingConfig(tid);

  let term = null;
  const requested = toNum(opts.termId, 0);
  if (requested) {
    term = await db.get("SELECT id, position, name_en, name_ar, session_id FROM terms WHERE id = ? AND madrasa_id = ?", [requested, tid]);
  }
  if (!term) term = await currentTerm(tid, today);
  const termId = term ? Number(term.id) : 0;

  /* ------------------------- 1. attendance heatmap ---------------------- */
  // Grouped in SQL (class × day × status) and folded into weekdays here: the
  // weekday expression differs per driver, and this keeps it dialect-free.
  const heatRows = await db.all(
    `SELECT c.id AS class_id, c.name_en AS class_en, c.name_ar AS class_ar, c.sort_order AS sort_order,
            ${dayExpr("a.day", dialect)} AS d, a.status AS status, COUNT(*) AS n
       FROM attendance a
       JOIN classes c ON c.id = a.class_id AND c.madrasa_id = a.madrasa_id
      WHERE a.madrasa_id = ? AND a.day >= ? AND a.day <= ?
      GROUP BY c.id, c.name_en, c.name_ar, c.sort_order, ${dayExpr("a.day", dialect)}, a.status`,
    [tid, since, today]
  );

  const byClass = new Map();
  const byWeekday = new Map();
  let markedTotal = 0;
  let attendedTotal = 0;
  for (const r of heatRows) {
    const wd = weekdayOf(r.d);
    if (wd === null) continue;
    const n = num(r.n);
    const present = ["present", "late"].includes(String(r.status));
    markedTotal += n;
    if (present) attendedTotal += n;

    const cid = Number(r.class_id);
    if (!byClass.has(cid)) {
      byClass.set(cid, {
        id: cid, label: r.class_en, labelAr: r.class_ar || "", sortOrder: num(r.sort_order),
        cells: new Map(), marked: 0, attended: 0,
      });
    }
    const entry = byClass.get(cid);
    const cell = entry.cells.get(wd) || { marked: 0, attended: 0 };
    cell.marked += n; if (present) cell.attended += n;
    entry.cells.set(wd, cell);
    entry.marked += n; if (present) entry.attended += n;

    const w = byWeekday.get(wd) || { marked: 0, attended: 0 };
    w.marked += n; if (present) w.attended += n;
    byWeekday.set(wd, w);
  }

  const schoolWeek = WEEKDAYS.map((_, i) => i).filter((i) => (byWeekday.get(i) || { marked: 0 }).marked > 0);

  const attendanceHeatmap = [...byClass.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || String(a.label).localeCompare(String(b.label)))
    .map((c) => ({
      id: c.id,
      label: c.label,
      labelAr: c.labelAr,
      rate: c.marked ? pct(c.attended, c.marked) : null,
      marked: c.marked,
      cells: schoolWeek.map((wd) => {
        const cell = c.cells.get(wd);
        return {
          weekday: WEEKDAYS[wd],
          weekdayShort: WEEKDAY_SHORT[wd],
          weekdayIndex: wd,
          marked: cell ? cell.marked : 0,
          rate: cell && cell.marked ? pct(cell.attended, cell.marked) : null,
        };
      }),
    }));

  /* ------------------------ 2. attendance patterns ---------------------- */
  const weekdayPattern = schoolWeek.map((wd) => {
    const w = byWeekday.get(wd) || { marked: 0, attended: 0 };
    return { weekday: WEEKDAYS[wd], weekdayShort: WEEKDAY_SHORT[wd], weekdayIndex: wd, marked: w.marked, rate: w.marked ? pct(w.attended, w.marked) : null };
  });
  const rankedDays = weekdayPattern.filter((d) => d.rate !== null).slice().sort((a, b) => a.rate - b.rate);
  const classPattern = attendanceHeatmap
    .filter((c) => c.rate !== null)
    .slice()
    .sort((a, b) => a.rate - b.rate)
    .map((c) => ({ id: c.id, label: c.label, labelAr: c.labelAr, rate: c.rate, marked: c.marked }));

  const perStudent = await db.all(
    `SELECT s.id, s.admission_no, s.first_name, s.last_name, s.name_ar,
            c.name_en AS class_en, c.name_ar AS class_ar,
            COUNT(a.id) AS marked,
            SUM(CASE WHEN a.status IN ('present','late') THEN 1 ELSE 0 END) AS attended
       FROM students s
       JOIN attendance a ON a.student_id = s.id AND a.madrasa_id = s.madrasa_id AND a.day >= ? AND a.day <= ?
       LEFT JOIN classes c ON c.id = s.class_id
      WHERE s.madrasa_id = ? AND s.status IN ${ACTIVE_STATUSES}
      GROUP BY s.id, s.admission_no, s.first_name, s.last_name, s.name_ar, c.name_en, c.name_ar`,
    [since, today, tid]
  );
  const chronicAbsence = perStudent
    .map((r) => {
      const marked = num(r.marked);
      const rate = marked ? pct(r.attended, marked) : null;
      return {
        id: Number(r.id), admissionNo: r.admission_no, name: `${r.first_name} ${r.last_name}`.trim(), nameAr: r.name_ar || "",
        classEn: r.class_en || "", classAr: r.class_ar || "", marked, rate,
      };
    })
    .filter((s) => s.rate !== null && s.marked >= MIN_MARKED_DAYS && s.rate < ATT_FLOOR_ADVANCED)
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 25);

  const attendancePatterns = {
    window: { since, until: today, days: attendanceDays },
    overallRate: markedTotal ? pct(attendedTotal, markedTotal) : null,
    marked: markedTotal,
    schoolWeek: schoolWeek.map((wd) => ({ weekday: WEEKDAYS[wd], weekdayShort: WEEKDAY_SHORT[wd], weekdayIndex: wd })),
    byWeekday: weekdayPattern,
    weakestDay: rankedDays.length ? rankedDays[0] : null,
    strongestDay: rankedDays.length ? rankedDays[rankedDays.length - 1] : null,
    byClass: classPattern,
    weakestClass: classPattern.length ? classPattern[0] : null,
    chronicAbsence,
    chronicAbsenceCount: chronicAbsence.length,
    floor: ATT_FLOOR_ADVANCED,
  };

  /* ------------------------- 3. teacher performance --------------------- */
  const [teachers, assignmentRows, resultRows, attendanceMarked, homeworkRows, examRows] = await Promise.all([
    db.all("SELECT id, full_name, username FROM users WHERE madrasa_id = ? AND role = 'teacher' AND is_active = 1 ORDER BY full_name", [tid]),
    db.all(
      `SELECT ta.user_id, COUNT(*) AS n,
              COUNT(DISTINCT ta.class_id) AS classes,
              COUNT(DISTINCT ta.subject_id) AS subjects
         FROM teacher_assignments ta WHERE ta.madrasa_id = ? GROUP BY ta.user_id`,
      [tid]
    ),
    db.all(
      `SELECT ta.user_id, COUNT(r.id) AS n, AVG(r.total) AS avg
         FROM teacher_assignments ta
         JOIN results r ON r.madrasa_id = ta.madrasa_id
           AND (ta.class_id IS NULL OR r.class_id = ta.class_id)
           AND (ta.subject_id IS NULL OR r.subject_id = ta.subject_id)
        WHERE ta.madrasa_id = ? AND r.term_id = ?
        GROUP BY ta.user_id`,
      [tid, termId]
    ),
    db.all(
      `SELECT recorded_by AS user_id, COUNT(DISTINCT ${dayExpr("day", dialect)}) AS days, COUNT(*) AS entries
         FROM attendance
        WHERE madrasa_id = ? AND recorded_by IS NOT NULL AND day >= ? AND day <= ?
        GROUP BY recorded_by`,
      [tid, since, today]
    ),
    db.all(
      `SELECT COALESCE(teacher_id, created_by) AS user_id, kind, status, COUNT(*) AS n
         FROM homework WHERE madrasa_id = ? AND COALESCE(teacher_id, created_by) IS NOT NULL
        GROUP BY COALESCE(teacher_id, created_by), kind, status`,
      [tid]
    ),
    db.all("SELECT created_by AS user_id, COUNT(*) AS n FROM exams WHERE madrasa_id = ? AND created_by IS NOT NULL GROUP BY created_by", [tid]),
  ]);

  const mapOf = (rows, key = "user_id") => new Map(rows.map((r) => [Number(r[key]), r]));
  const assignMap = mapOf(assignmentRows);
  const resultMap = mapOf(resultRows);
  const attMap = mapOf(attendanceMarked);
  const examMap = mapOf(examRows);
  const homeworkByTeacher = new Map();
  for (const r of homeworkRows) {
    const uid = Number(r.user_id);
    const bucket = homeworkByTeacher.get(uid) || { lessons: 0, assignments: 0, published: 0 };
    if (String(r.kind) === "assignment") bucket.assignments += num(r.n);
    else bucket.lessons += num(r.n);
    if (String(r.status) === "published") bucket.published += num(r.n);
    homeworkByTeacher.set(uid, bucket);
  }

  const teacherPerformance = teachers.map((t) => {
    const a = assignMap.get(Number(t.id)) || {};
    const r = resultMap.get(Number(t.id)) || {};
    const att = attMap.get(Number(t.id)) || {};
    const hw = homeworkByTeacher.get(Number(t.id)) || { lessons: 0, assignments: 0, published: 0 };
    const ex = examMap.get(Number(t.id)) || {};
    const results = num(r.n);
    const average = results ? round(r.avg, 1) : null;
    return {
      id: Number(t.id),
      name: t.full_name || t.username || `Teacher ${t.id}`,
      classes: num(a.classes),
      subjects: num(a.subjects),
      assignments: num(a.n),
      resultsEntered: results,
      resultsAverage: average,
      passRate: null,
      attendanceDaysMarked: num(att.days),
      attendanceEntries: num(att.entries),
      lessons: hw.lessons,
      assignmentsSet: hw.assignments,
      published: hw.published,
      examsCreated: num(ex.n),
      // A single 0-100 "engagement" score so the table can be sorted without
      // pretending the underlying numbers are comparable: results average
      // weighted with the teaching activity actually recorded this window.
      engagement: round(
        Math.min(100,
          (average === null ? 0 : average * 0.5) +
          Math.min(20, num(att.days) * 2) +
          Math.min(15, hw.published * 3) +
          Math.min(15, num(ex.n) * 5)),
        1
      ),
    };
  });

  // Pass rate per teacher's own scope (kept as a second query so a teacher with
  // no results never divides by zero above).
  const passRows = await db.all(
    `SELECT ta.user_id,
            SUM(CASE WHEN ts.average >= ? THEN 1 ELSE 0 END) AS passed,
            COUNT(ts.id) AS n
       FROM teacher_assignments ta
       JOIN term_summaries ts ON ts.madrasa_id = ta.madrasa_id
         AND (ta.class_id IS NULL OR ts.class_id = ta.class_id)
      WHERE ta.madrasa_id = ? AND ts.term_id = ?
      GROUP BY ta.user_id`,
    [cfg.passMark, tid, termId]
  );
  const passMap = mapOf(passRows);
  for (const t of teacherPerformance) {
    const p = passMap.get(t.id);
    t.passRate = p && num(p.n) ? pct(p.passed, p.n) : null;
  }
  teacherPerformance.sort((a, b) => b.engagement - a.engagement || String(a.name).localeCompare(String(b.name)));

  /* ---------------------------- 4. fee forecast ------------------------- */
  const [feeTrendRows, billedRow, collectedRow, paidByStudent, rollRows] = await Promise.all([
    db.all(
      `SELECT ${monthExpr("payment_date", dialect)} AS m, COUNT(*) AS n, COALESCE(SUM(amount_ngn),0) AS amount
         FROM fee_payments WHERE madrasa_id = ?
        GROUP BY ${monthExpr("payment_date", dialect)}`,
      [tid]
    ),
    db.get("SELECT COALESCE(SUM(amount_ngn),0) AS billed FROM fee_items WHERE madrasa_id = ? AND term_id = ?", [tid, termId]),
    db.get("SELECT COALESCE(SUM(amount_ngn),0) AS amount FROM fee_payments WHERE madrasa_id = ?", [tid]),
    db.all(
      `SELECT fp.student_id, SUM(fp.amount_ngn) AS paid
         FROM fee_payments fp
         JOIN fee_items fi ON fi.id = fp.fee_item_id AND fi.madrasa_id = fp.madrasa_id
        WHERE fp.madrasa_id = ? AND fi.term_id = ?
        GROUP BY fp.student_id`,
      [tid, termId]
    ),
    db.all(`SELECT id FROM students WHERE madrasa_id = ? AND status IN ${ACTIVE_STATUSES}`, [tid]),
  ]);

  const trend = fillSeries(monthLabels, feeTrendRows, "m", (r) => round(num(r.amount), 2));
  const values = trend.map((p) => p.value);
  const perMonth = slope(values);
  const lastValue = values.length ? values[values.length - 1] : 0;
  const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  // Outstanding for the reported term, with the SAME semantics the fees module
  // and the standard analytics use: the term's items are billed to every
  // student on the roll, and only payments against those items are credited.
  const billedPerStudent = num(billedRow && billedRow.billed);
  const studentCount = rollRows.length;
  const billedTotal = billedPerStudent * studentCount;
  const paidMap = new Map(paidByStudent.map((r) => [Number(r.student_id), num(r.paid)]));
  let outstanding = 0;
  let debtors = 0;
  if (billedPerStudent > 0) {
    for (const s of rollRows) {
      const gap = billedPerStudent - (paidMap.get(Number(s.id)) || 0);
      if (gap > 0) { outstanding += gap; debtors += 1; }
    }
  }

  const horizon = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + i);
    const projected = Math.max(0, lastValue + perMonth * i);
    horizon.push({
      label: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"),
      projected: round(projected, 2),
      conservative: round(Math.max(0, Math.min(projected, average)), 2),
    });
  }

  const feeForecast = {
    currency: "NGN",
    term: term ? { id: termId, nameEn: term.name_en, nameAr: term.name_ar || "" } : null,
    history: trend,
    averagePerMonth: round(average, 2),
    lastMonth: round(lastValue, 2),
    trendPerMonth: round(perMonth, 2),
    direction: perMonth > average * 0.05 ? "up" : perMonth < -(average * 0.05) ? "down" : "flat",
    collected: round(num(collectedRow && collectedRow.amount), 2),
    billedTotal: round(billedTotal, 2),
    outstanding: round(outstanding, 2),
    debtors,
    students: studentCount,
    projected: horizon,
    projectedNext3Months: round(horizon.reduce((a, b) => a + b.projected, 0), 2),
    // Honest about what a straight-line projection is: a planning number, not
    // a promise. The UI prints this sentence next to the chart.
    basis: `Straight-line projection from the last ${months} month(s) of recorded payments. Term fees are treated as billed to every student on the roll.`,
  };

  /* ------------------------------ 5. insights --------------------------- */
  const insights = [];
  if (attendancePatterns.weakestDay && attendancePatterns.strongestDay &&
      attendancePatterns.strongestDay.rate - attendancePatterns.weakestDay.rate >= 5) {
    insights.push({
      id: "attendance_weekday_gap",
      kind: "attendance",
      severity: "warning",
      title: `Attendance dips on ${attendancePatterns.weakestDay.weekday}s`,
      detail: `${attendancePatterns.weakestDay.rate}% present on ${attendancePatterns.weakestDay.weekday} against ${attendancePatterns.strongestDay.rate}% on ${attendancePatterns.strongestDay.weekday} — worth a register check and a parent reminder the evening before.`,
    });
  }
  if (attendancePatterns.weakestClass && attendancePatterns.overallRate !== null &&
      attendancePatterns.overallRate - attendancePatterns.weakestClass.rate >= 5) {
    insights.push({
      id: "attendance_class_gap",
      kind: "attendance",
      severity: "warning",
      title: `${attendancePatterns.weakestClass.label} is below the school average`,
      detail: `${attendancePatterns.weakestClass.rate}% present against a school average of ${attendancePatterns.overallRate}% over the last ${attendanceDays} days.`,
    });
  }
  if (chronicAbsence.length) {
    insights.push({
      id: "chronic_absence",
      kind: "attendance",
      severity: chronicAbsence.length > 5 ? "danger" : "warning",
      title: `${chronicAbsence.length} student(s) below ${ATT_FLOOR_ADVANCED}% attendance`,
      detail: chronicAbsence.slice(0, 3).map((s) => `${s.name} (${s.rate}%)`).join(", ") +
        (chronicAbsence.length > 3 ? ` and ${chronicAbsence.length - 3} more` : "") + ".",
    });
  }
  if (teacherPerformance.length) {
    const top = teacherPerformance[0];
    const withResults = teacherPerformance.filter((t) => t.resultsAverage !== null);
    if (withResults.length) {
      const best = withResults.slice().sort((a, b) => b.resultsAverage - a.resultsAverage)[0];
      insights.push({
        id: "teacher_top_average",
        kind: "teaching",
        severity: "info",
        title: `${best.name} has the highest class average this term`,
        detail: `${best.resultsAverage}% across ${best.resultsEntered} recorded result(s). ${top.name} is the most active this window (${top.attendanceDaysMarked} register day(s), ${top.published} published item(s)).`,
      });
    }
    const quiet = teacherPerformance.filter((t) => !t.attendanceDaysMarked && !t.published && !t.resultsEntered);
    if (quiet.length) {
      insights.push({
        id: "teacher_no_activity",
        kind: "teaching",
        severity: "warning",
        title: `${quiet.length} teacher(s) recorded nothing in the last ${attendanceDays} days`,
        detail: quiet.slice(0, 4).map((t) => t.name).join(", ") + (quiet.length > 4 ? " and others" : "") + ".",
      });
    }
  }
  if (feeForecast.billedTotal > 0) {
    insights.push({
      id: "fee_outstanding",
      kind: "finance",
      severity: feeForecast.outstanding > feeForecast.billedTotal * 0.3 ? "danger" : "warning",
      title: `${money(feeForecast.outstanding)} outstanding for ${term ? term.name_en : "this term"}`,
      detail: `${feeForecast.debtors} of ${feeForecast.students} student(s) still owe, against ${money(feeForecast.collected)} collected to date.`,
    });
  }
  if (values.length >= 3) {
    insights.push({
      id: "fee_trend",
      kind: "finance",
      severity: feeForecast.direction === "down" ? "warning" : "ok",
      title: `Collections are trending ${feeForecast.direction}`,
      detail: `${money(feeForecast.trendPerMonth)} per month over the last ${months} months; ${money(feeForecast.projectedNext3Months)} projected over the next three.`,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    window: { months, attendanceDays, since, until: today },
    term: term ? { id: termId, position: num(term.position), nameEn: term.name_en, nameAr: term.name_ar || "", sessionLabel: term.session_label || "" } : null,
    grading: { passMark: cfg.passMark },
    attendanceHeatmap,
    attendancePatterns,
    teacherPerformance,
    feeForecast,
    insights,
  };
}

/* ====================================================================== */
/*  PLATFORM ANALYTICS — super admin only (all tenants, no PII)           */
/* ====================================================================== */

async function platformAnalytics(opts = {}) {
  const months = clampInt(opts.months, 3, 36, 12);
  const dialect = await db.dialect();
  const today = isoDate(new Date());
  const since14 = daysAgo(13);
  const since30 = daysAgo(29);
  const monthLabels = monthKeys(months);

  const totals = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM madaris) AS madaris,
       (SELECT COUNT(*) FROM madaris WHERE status = 'active') AS active_madaris,
       (SELECT COUNT(*) FROM madaris WHERE status = 'suspended') AS suspended_madaris,
       (SELECT COUNT(*) FROM students WHERE status IN ${ACTIVE_STATUSES}) AS students,
       (SELECT COUNT(*) FROM users WHERE role = 'teacher' AND is_active = 1) AS teachers,
       (SELECT COUNT(*) FROM users WHERE role = 'parent' AND is_active = 1) AS parents,
       (SELECT COUNT(*) FROM users WHERE role = 'madrasa_admin' AND is_active = 1) AS madrasa_admins,
       (SELECT COUNT(*) FROM users WHERE is_active = 1) AS users,
       (SELECT COALESCE(SUM(amount_ngn),0) FROM fee_payments) AS fees_collected`
  );

  const [madrasaTrendRows, studentTrendRows, topMadaris, planRows, feeTrendRows, activityRows, actionRows, newStudents, recentMadaris] = await Promise.all([
    db.all(
      `SELECT ${monthExpr("created_at", dialect)} AS m, COUNT(*) AS n FROM madaris GROUP BY ${monthExpr("created_at", dialect)}`,
      []
    ),
    db.all(
      `SELECT ${monthExpr("created_at", dialect)} AS m, COUNT(*) AS n FROM students GROUP BY ${monthExpr("created_at", dialect)}`,
      []
    ),
    db.all(
      `SELECT m.id, m.slug, m.name_en, m.name_ar, m.status,
              (SELECT COUNT(*) FROM students s WHERE s.madrasa_id = m.id AND s.status IN ${ACTIVE_STATUSES}) AS students,
              (SELECT COALESCE(SUM(p.amount_ngn),0) FROM fee_payments p WHERE p.madrasa_id = m.id) AS fees
         FROM madaris m
        ORDER BY students DESC, m.id DESC LIMIT 10`
    ),
    db.all(
      `SELECT p.code, p.name, COUNT(m.id) AS madaris,
              (SELECT COUNT(*) FROM students s JOIN madaris mm ON mm.id = s.madrasa_id
                WHERE mm.plan_id = p.id AND s.status IN ${ACTIVE_STATUSES}) AS students
         FROM plans p LEFT JOIN madaris m ON m.plan_id = p.id
        GROUP BY p.code, p.name, p.sort_order
        ORDER BY p.sort_order`
    ),
    db.all(
      `SELECT ${monthExpr("payment_date", dialect)} AS m, COUNT(*) AS n, COALESCE(SUM(amount_ngn),0) AS amount
         FROM fee_payments GROUP BY ${monthExpr("payment_date", dialect)}`
    ),
    db.all(
      `SELECT ${dayExpr("created_at", dialect)} AS d, COUNT(*) AS n
         FROM activity_log WHERE created_at >= ? GROUP BY ${dayExpr("created_at", dialect)}`,
      [since14 + " 00:00:00"]
    ),
    db.all(
      "SELECT action, COUNT(*) AS n FROM activity_log GROUP BY action ORDER BY n DESC LIMIT 8"
    ),
    db.get("SELECT COUNT(*) AS n FROM students WHERE created_at >= ?", [since30 + " 00:00:00"]),
    db.all(
      `SELECT m.id, m.slug, m.name_en, m.name_ar, m.status, m.created_at
         FROM madaris m ORDER BY m.id DESC LIMIT 5`
    ),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    window: { months, since: daysAgo(months * 30), until: today },
    totals: {
      madaris: num(totals && totals.madaris),
      activeMadaris: num(totals && totals.active_madaris),
      suspendedMadaris: num(totals && totals.suspended_madaris),
      students: num(totals && totals.students),
      teachers: num(totals && totals.teachers),
      parents: num(totals && totals.parents),
      madrasaAdmins: num(totals && totals.madrasa_admins),
      users: num(totals && totals.users),
      newStudents30d: num(newStudents && newStudents.n),
      feesCollected: round(num(totals && totals.fees_collected), 2),
    },
    madrasaTrend: fillSeries(monthLabels, madrasaTrendRows),
    studentTrend: fillSeries(monthLabels, studentTrendRows),
    feeTrend: fillSeries(monthLabels, feeTrendRows, "m", (r) => round(num(r.amount), 2)),
    topMadaris: topMadaris.map((m) => ({
      id: Number(m.id),
      slug: m.slug,
      label: m.name_en,
      labelAr: m.name_ar || "",
      status: m.status,
      students: num(m.students),
      fees: round(num(m.fees), 2),
    })),
    byPlan: planRows.map((p) => ({
      code: p.code,
      label: p.name || p.code,
      madaris: num(p.madaris),
      students: num(p.students),
    })),
    activity: {
      daily: fillSeries(dayKeys(14), activityRows, "d"),
      topActions: actionRows.map((a) => ({ action: a.action, value: num(a.n) })),
    },
    recentMadaris: recentMadaris.map((m) => ({
      id: Number(m.id),
      slug: m.slug,
      label: m.name_en,
      labelAr: m.name_ar || "",
      status: m.status,
      createdAt: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at || ""),
    })),
  };
}

module.exports = {
  tenantAnalytics,
  advancedAnalytics,
  platformAnalytics,
  currentTerm,
  // exported for tests
  _internals: { monthKeys, dayKeys, monthExpr, dayExpr, fillSeries, pct, round, isoDate, daysAgo },
};
