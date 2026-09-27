"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — report sheet engine
   ----------------------------------------------------------------------------
   This is the single renderer + assembler behind every printable report
   sheet/report card in the platform (staff workspace, bulk class generation,
   student portal, parent portal and the public result checker).

   It does NOT re-implement result mathematics: every total, percentage, grade,
   grade point, average, position and promotion decision comes from the
   existing trusted engine in services/grading.js (which is also the only
   writer of term_summaries). This module layers the presentation concerns on
   top:

     • per-institution report template (layout, columns, sections, colours,
       behaviour categories, signature blocks, watermark, credit line) stored
       in the EXISTING `settings` table — no parallel settings system,
     • result completeness checking (assigned subjects vs entered results),
     • derived report status (draft → … → locked) for the review workflow,
     • attendance breakdown, class performance aggregates, next term dates,
     • behaviour/conduct ratings persisted on the existing term_summaries row,
     • a deterministic, human-facing report reference number,
     • a professional A4 print/PDF-ready HTML document (classic, modern and
       compact layouts; portrait or landscape; LTR or RTL; Arabic preserved).

   Sections the institution switched off are omitted; missing data degrades to
   an empty state — never to invented values.
   ========================================================================== */
const db = require("../db");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const grading = require("./grading");
const institution = require("./institution");

/* --------------------------- template defaults --------------------------- */

/** Result columns a sheet may show. Keys match the assembler's subject fields. */
const RESULT_COLUMNS = ["ca", "exam", "total", "pct", "grade", "gradePoint", "remark"];

const DEFAULT_COLUMNS = { ca: true, exam: true, total: true, pct: true, grade: true, gradePoint: false, remark: true };

const DEFAULT_BEHAVIOUR_CATEGORIES = [
  { key: "punctuality", label: "Punctuality", labelAr: "الالتزام بالمواعيد" },
  { key: "neatness", label: "Neatness", labelAr: "النظافة" },
  { key: "discipline", label: "Discipline", labelAr: "الانضباط" },
  { key: "participation", label: "Participation", labelAr: "المشاركة" },
  { key: "cooperation", label: "Cooperation", labelAr: "التعاون" },
  { key: "respect", label: "Respect", labelAr: "الاحترام" },
  { key: "conduct", label: "General Conduct", labelAr: "السلوك العام" },
];

const DEFAULT_SIGNATURES = [
  { title: "Class Teacher", titleAr: "مُعلّم الفصل", name: "" },
  { title: "Head of Institution", titleAr: "رئيس المؤسسة", name: "" },
];

const RATING_LABELS = { 5: "Excellent", 4: "Very Good", 3: "Good", 2: "Fair", 1: "Poor" };

const DEFAULT_TEMPLATE = {
  layout: "classic",            // classic | modern | compact
  orientation: "auto",          // auto | portrait | landscape
  brandColor: "",               // "" -> fall back to the institution colour
  columns: DEFAULT_COLUMNS,     // which result columns appear
  caLabel: "CA",
  examLabel: "Exam",
  showPosition: true,
  showAttendance: true,
  showBehaviour: true,
  showComments: true,
  showPromotion: true,
  showClassPerformance: true,   // class size / class average / highest / lowest only
  showStudentDetails: true,     // gender, date of birth, category where present
  showPhoto: true,
  showNextTerm: true,
  showGradeLegend: true,
  showReference: true,
  showWatermark: false,
  watermarkText: "",
  showEdusphereCredit: true,
  behaviourCategories: DEFAULT_BEHAVIOUR_CATEGORIES,
  signatures: DEFAULT_SIGNATURES,
};

const LAYOUTS = ["classic", "modern", "compact"];
const ORIENTATIONS = ["auto", "portrait", "landscape"];

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

function hexColor(value) {
  const s = String(value || "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : "";
}

/** Normalises one signature block from stored/client JSON. */
function normSignature(block) {
  if (!block || typeof block !== "object") return null;
  const title = String(block.title || "").trim().slice(0, 80);
  if (!title) return null;
  return {
    title,
    titleAr: String(block.titleAr || "").trim().slice(0, 80),
    name: String(block.name || "").trim().slice(0, 120),
  };
}

/** Normalises one behaviour category. */
function normCategory(cat) {
  if (!cat || typeof cat !== "object") return null;
  const key = String(cat.key || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
  const label = String(cat.label || "").trim().slice(0, 80);
  if (!key || !label) return null;
  return { key, label, labelAr: String(cat.labelAr || "").trim().slice(0, 80) };
}

/** Merges a stored/partial template onto the defaults (unknown keys dropped). */
function normaliseTemplate(stored) {
  const t = Object.assign({}, DEFAULT_TEMPLATE, parseJson(stored, {}));
  const columns = Object.assign({}, DEFAULT_COLUMNS, t.columns && typeof t.columns === "object" ? t.columns : {});
  const colOut = {};
  for (const key of RESULT_COLUMNS) colOut[key] = columns[key] !== false; // default visible
  const cats = (Array.isArray(t.behaviourCategories) ? t.behaviourCategories : [])
    .map(normCategory).filter(Boolean).slice(0, 15);
  const sigs = (Array.isArray(t.signatures) ? t.signatures : [])
    .map(normSignature).filter(Boolean).slice(0, 4);
  return {
    layout: LAYOUTS.includes(t.layout) ? t.layout : "classic",
    orientation: ORIENTATIONS.includes(t.orientation) ? t.orientation : "auto",
    brandColor: hexColor(t.brandColor),
    columns: colOut,
    caLabel: String(t.caLabel || "CA").trim().slice(0, 24) || "CA",
    examLabel: String(t.examLabel || "Exam").trim().slice(0, 24) || "Exam",
    showPosition: t.showPosition !== false,
    showAttendance: t.showAttendance !== false,
    showBehaviour: t.showBehaviour !== false,
    showComments: t.showComments !== false,
    showPromotion: t.showPromotion !== false,
    showClassPerformance: t.showClassPerformance !== false,
    showStudentDetails: t.showStudentDetails !== false,
    showPhoto: t.showPhoto !== false,
    showNextTerm: t.showNextTerm !== false,
    showGradeLegend: t.showGradeLegend !== false,
    showReference: t.showReference !== false,
    showWatermark: t.showWatermark === true,
    watermarkText: String(t.watermarkText || "").trim().slice(0, 40),
    showEdusphereCredit: t.showEdusphereCredit !== false,
    behaviourCategories: cats.length ? cats : DEFAULT_BEHAVIOUR_CATEGORIES.slice(),
    signatures: sigs.length ? sigs : DEFAULT_SIGNATURES.slice(),
  };
}

/** Reads (and lazily seeds) the institution's report template. */
async function getReportTemplate(madrasaId) {
  const row = await db.get("SELECT value FROM settings WHERE madrasa_id = ? AND key_name = 'report_template'", [madrasaId]);
  return normaliseTemplate(row ? row.value : null);
}

/** Validates and persists a template patch. Returns the stored template. */
async function saveReportTemplate(madrasaId, patch) {
  const current = await getReportTemplate(madrasaId);
  const merged = normaliseTemplate(JSON.stringify(Object.assign({}, current, patch || {})));
  const existing = await db.get("SELECT id FROM settings WHERE madrasa_id = ? AND key_name = 'report_template'", [madrasaId]);
  if (existing) {
    await db.run("UPDATE settings SET value = ? WHERE id = ?", [JSON.stringify(merged), existing.id]);
  } else {
    try {
      await db.run("INSERT INTO settings (madrasa_id, key_name, value) VALUES (?,?,?)", [madrasaId, "report_template", JSON.stringify(merged)]);
    } catch (e) {
      // Two first-time saves racing on the UNIQUE (madrasa_id, key_name):
      // the loser turns its insert into an update of the winner's row.
      if (!/unique|duplicate/i.test(String(e && e.message))) throw e;
      await db.run("UPDATE settings SET value = ? WHERE madrasa_id = ? AND key_name = 'report_template'", [JSON.stringify(merged), madrasaId]);
    }
  }
  return merged;
}

/* ---------------------------- reference numbers -------------------------- */

function refSlug(value, max = 24) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, max);
}

/**
 * Deterministic, human-facing reference (e.g. EDU-2026/2027-JSS1-TTA0001).
 * Built only from values the student already sees on the sheet, so it never
 * leaks an internal database id.
 */
function buildReportReference(sessionLabel, className, admissionNo) {
  const parts = ["EDU", refSlug(sessionLabel, 20), refSlug(className, 16), refSlug(admissionNo, 20)].filter(Boolean);
  return parts.join("-");
}

/* ------------------------------- helpers --------------------------------- */

function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Only same-origin upload paths may become <img src> — never an external URL. */
function asset(value) {
  const s = String(value || "");
  return /^\/uploads\/[A-Za-z0-9_./-]+$/.test(s) ? s : "";
}

/**
 * An upload URL is only emitted when the file it names is actually present
 * in this deployment's upload directory. The #1 cause of "broken logo /
 * broken student photo" on report sheets is a database row whose photo or
 * logo path survived (a backup restore, a host with an ephemeral disk)
 * without the file itself: express.static then falls through to the SPA
 * fallback, the <img> receives a 200 text/html answer, and the browser
 * paints a broken-image icon with the student's name as alt text. Checking
 * existence here means the browser is only ever handed a URL we can serve;
 * anything else degrades to a clean placeholder instead.
 */
function assetServed(value) {
  const url = asset(value);
  if (!url || url.includes("..")) return "";
  try {
    return fs.statSync(path.join(config.UPLOAD_DIR, url.replace(/^\/uploads\//, ""))).isFile() ? url : "";
  } catch (e) {
    return "";
  }
}

function fmtDate(value) {
  const s = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

/** Human display date (dd/mm/yyyy) for dates already validated by fmtDate. */
function fmtDateHuman(value) {
  const s = fmtDate(value);
  if (!s) return String(value || "");
  const [y, m, d] = s.split("-");
  return `${d}/${m}/${y}`;
}

function ordinal(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return String(n || "");
  const s = ["th", "st", "nd", "rd"];
  const v100 = v % 100;
  return v + (s[(v100 - 20) % 10] || s[v100] || s[0]);
}

/** Attendance totals for one student in one term, from the attendance table. */
async function attendanceBreakdown(madrasaId, studentId, termId) {
  const rows = await db.all(
    `SELECT status, COUNT(*) AS n FROM attendance
      WHERE madrasa_id = ? AND student_id = ? AND term_id = ?
      GROUP BY status`,
    [madrasaId, studentId, termId]
  );
  const out = { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
  for (const row of rows) {
    const n = Number(row.n || 0);
    out.total += n;
    if (["present", "absent", "late", "excused"].includes(row.status)) out[row.status] = n;
  }
  out.percentage = out.total ? Math.round((out.present / out.total) * 1000) / 10 : null;
  return out;
}

/** Batched attendance totals for a whole class in one grouped query. */
async function attendanceBreakdownMap(madrasaId, studentIds, termId) {
  const out = new Map();
  if (!studentIds.length) return out;
  const marks = studentIds.map(() => "?").join(",");
  const rows = await db.all(
    `SELECT student_id, status, COUNT(*) AS n FROM attendance
      WHERE madrasa_id = ? AND term_id = ? AND student_id IN (${marks})
      GROUP BY student_id, status`,
    [madrasaId, termId].concat(studentIds)
  );
  for (const row of rows) {
    const id = Number(row.student_id);
    if (!out.has(id)) out.set(id, { present: 0, absent: 0, late: 0, excused: 0, total: 0 });
    const entry = out.get(id);
    const n = Number(row.n || 0);
    entry.total += n;
    if (["present", "absent", "late", "excused"].includes(row.status)) entry[row.status] = n;
  }
  for (const entry of out.values()) {
    entry.percentage = entry.total ? Math.round((entry.present / entry.total) * 1000) / 10 : null;
  }
  return out;
}

/**
 * Class-level aggregates for the sheet: size, average, best and weakest
 * average. Individual classmates' scores are never included — only these
 * aggregates, so no other student's private marks are revealed.
 */
function classPerformanceFrom(summaries) {
  const rows = summaries.filter((s) => s && s.average !== null && s.average !== undefined);
  if (!rows.length) return null;
  const averages = rows.map((s) => Number(s.average)).filter((n) => Number.isFinite(n));
  if (!averages.length) return null;
  const sum = averages.reduce((a, b) => a + b, 0);
  return {
    size: rows.length,
    average: Math.round((sum / averages.length) * 10) / 10,
    highest: Math.max(...averages),
    lowest: Math.min(...averages),
  };
}

/**
 * The term that follows this one (same session, next position), else the
 * first term of the next session — used for the "next term begins" line.
 */
async function nextTermInfo(madrasaId, term) {
  if (!term) return null;
  if (term.start_date) {
    const inSession = await db.get(
      "SELECT id, name_en, name_ar, start_date, end_date FROM terms WHERE madrasa_id = ? AND session_id = ? AND position = ?",
      [madrasaId, term.session_id, Number(term.position) + 1]
    );
    if (inSession && inSession.start_date) {
      return { nameEn: inSession.name_en, nameAr: inSession.name_ar, begins: fmtDate(inSession.start_date), ends: fmtDate(inSession.end_date) };
    }
  }
  const nextSession = await db.get(
    "SELECT id FROM academic_sessions WHERE madrasa_id = ? AND id > ? ORDER BY id LIMIT 1",
    [madrasaId, term.session_id]
  );
  if (nextSession) {
    const firstTerm = await db.get(
      "SELECT name_en, name_ar, start_date, end_date FROM terms WHERE madrasa_id = ? AND session_id = ? ORDER BY position LIMIT 1",
      [madrasaId, nextSession.id]
    );
    if (firstTerm && firstTerm.start_date) {
      return { nameEn: firstTerm.name_en, nameAr: firstTerm.name_ar, begins: fmtDate(firstTerm.start_date), ends: fmtDate(firstTerm.end_date) };
    }
  }
  return null;
}

/** Subject lifecycle stages for status derivation (mirrors results.js). */
const STAGE_ORDER = ["draft", "returned", "submitted", "under_review", "approved", "published", "locked"];

/**
 * Derives the report's position in the review workflow from its subject
 * results and the summary publication stamp. The weakest stage wins: a report
 * is only as final as its least final subject result.
 */
function deriveReportStatus(subjectStatuses, publishedAt, missingCount) {
  if (!subjectStatuses.length) return "draft";
  let lowest = "locked";
  for (const status of subjectStatuses) {
    const idx = STAGE_ORDER.indexOf(status);
    const cur = idx === -1 ? 0 : idx;
    const low = STAGE_ORDER.indexOf(lowest);
    if (cur < low) lowest = STAGE_ORDER[cur];
  }
  if (publishedAt) {
    // A published summary whose results were later locked stays "locked";
    // anything retracted below approved keeps its computed stage.
    if (lowest === "locked") return "locked";
    return "published";
  }
  if (missingCount > 0 && lowest === "locked") return "approved"; // incomplete cannot be fully final
  return lowest;
}

/* --------------------------- completeness check --------------------------- */

/**
 * Compares the subjects assigned to a class (class_subjects) with the results
 * actually entered for a term, for the whole class at once.
 *
 * Returns { subjects, byStudent: Map<studentId, {missing, pending}> } where
 *   missing  = assigned subjects with NO result row for that student,
 *   pending  = subjects whose result row exists but is not yet approved.
 * Students with no results at all appear with every subject missing.
 */
async function classCompleteness(madrasaId, classId, termId) {
  const subjects = await db.all(
    `SELECT su.id, su.name_en, su.name_ar FROM class_subjects cs
      JOIN subjects su ON su.id = cs.subject_id AND su.madrasa_id = cs.madrasa_id AND su.is_active = 1
     WHERE cs.madrasa_id = ? AND cs.class_id = ?
     ORDER BY su.name_en`,
    [madrasaId, classId]
  );
  const students = await db.all(
    "SELECT id FROM students WHERE madrasa_id = ? AND class_id = ? AND status IN ('active','promoted','suspended') ORDER BY admission_no",
    [madrasaId, classId]
  );
  const results = await db.all(
    "SELECT student_id, subject_id, status FROM results WHERE madrasa_id = ? AND class_id = ? AND term_id = ?",
    [madrasaId, classId, termId]
  );
  const entered = new Map(); // studentId -> Map(subjectId -> status)
  for (const r of results) {
    const sid = Number(r.student_id);
    if (!entered.has(sid)) entered.set(sid, new Map());
    entered.get(sid).set(Number(r.subject_id), r.status || "approved");
  }
  const subjectIds = subjects.map((s) => Number(s.id));
  const byStudent = new Map();
  for (const student of students) {
    const sid = Number(student.id);
    const mine = entered.get(sid) || new Map();
    const missing = [];
    const pending = [];
    for (let i = 0; i < subjects.length; i++) {
      const subjectId = subjectIds[i];
      if (!mine.has(subjectId)) missing.push({ subjectId, nameEn: subjects[i].name_en, nameAr: subjects[i].name_ar });
      else if (!["approved", "published", "locked"].includes(mine.get(subjectId))) {
        pending.push({ subjectId, nameEn: subjects[i].name_en, nameAr: subjects[i].name_ar, status: mine.get(subjectId) });
      }
    }
    byStudent.set(sid, { missing, pending, complete: missing.length === 0 && pending.length === 0 });
  }
  return { subjects, byStudent, studentCount: students.length };
}

/* ------------------------------- assembly -------------------------------- */

/** Parses the behaviour ratings JSON stored on a term_summaries row. */
function parseBehaviour(text, categories) {
  const raw = parseJson(text, {});
  const out = {};
  for (const cat of categories) {
    const v = Number(raw[cat.key]);
    out[cat.key] = Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
  }
  return out;
}

/**
 * Assembles the full printable dataset for one student from preloaded rows.
 * All arithmetic goes through grading.subjectScore / grading.gradeForPct so
 * there is exactly one calculation path in the platform.
 */
function assembleReport(preload, student, summary, resultRows) {
  const cfg = preload.config;
  const subjects = resultRows.map((r) => {
    const sc = grading.subjectScore(cfg, r.ca, r.exam);
    return {
      subjectId: Number(r.subject_id),
      nameEn: r.name_en,
      nameAr: r.name_ar,
      ca: sc.ca,
      exam: sc.exam,
      total: sc.total,
      pct: sc.pct,
      grade: r.grade || sc.grade,
      gradePoint: r.grade_point === null || r.grade_point === undefined ? sc.gradePoint : Number(r.grade_point),
      remark: r.teacher_remark || sc.remark,
      remarkAr: sc.remarkAr,
      status: r.status,
      pass: sc.pass,
    };
  });

  const summaryTotal = summary ? Number(summary.total) : 0;
  const summaryAverage = summary ? Number(summary.average) : 0;
  const overall = grading.gradeForPct(cfg, summaryAverage);
  const completeness = preload.completeness.byStudent.get(Number(student.id)) || { missing: [], pending: [], complete: false };
  const attendance = preload.attendance.get(Number(student.id)) ||
    { present: 0, absent: 0, late: 0, excused: 0, total: 0, percentage: null };

  // When the class term has not been computed yet there is no term_summaries
  // row. Rather than printing misleading zeros, the sheet aggregates the very
  // results it is displaying (position needs the whole class, so it stays
  // blank until the term is computed).
  let aggTotal = summaryTotal;
  let aggAverage = summaryAverage;
  let aggGrade = summary ? summary.overall_grade : overall.grade;
  if (!summary && subjects.length) {
    let sum = 0; let pctSum = 0;
    for (const s of subjects) { sum += s.total; pctSum += s.pct; }
    aggTotal = Math.round(sum * 100) / 100;
    aggAverage = Math.round((pctSum / subjects.length) * 10) / 10;
    aggGrade = grading.gradeForPct(cfg, aggAverage).grade;
  }

  // The workflow stage reflects EVERY subject result of the term, including
  // rows still in draft/returned/review — not only the approved ones shown in
  // the table — so a half-entered report is never presented as final.
  const allStatuses = resultRows.map((r) => r.status || "approved")
    .concat(completeness.pending.map((p) => p.status));

  const position = summary ? Number(summary.position) || null : null;
  const reference = String((summary && summary.report_reference) || "") ||
    buildReportReference(preload.sessionLabel, preload.classRow ? preload.classRow.name_en : "", student.admission_no);

  return {
    template: preload.template,
    madrasa: preload.madrasaInfo,
    student: {
      id: Number(student.id),
      studentCode: student.student_code || student.admission_no,
      name: `${student.first_name} ${student.last_name}`.trim(),
      nameAr: student.name_ar,
      admissionNo: student.admission_no,
      photoPath: student.photo_path || "",
      gender: student.gender || "",
      dateOfBirth: fmtDate(student.date_of_birth),
      section: student.section || "",
      program: student.program || "",
      classId: student.class_id ? Number(student.class_id) : null,
      classEn: preload.classRow ? preload.classRow.name_en : "",
      classAr: preload.classRow ? preload.classRow.name_ar : "",
    },
    session: preload.sessionLabel,
    term: {
      nameEn: preload.term.name_en,
      nameAr: preload.term.name_ar,
      position: preload.term.position,
      startDate: fmtDate(preload.term.start_date),
      endDate: fmtDate(preload.term.end_date),
    },
    subjects,
    config: {
      caMax: cfg.caMax,
      examMax: cfg.examMax,
      passMark: cfg.passMark,
      bands: cfg.bands,
    },
    summary: {
      total: aggTotal,
      subjectCount: summary ? Number(summary.subject_count) : subjects.length,
      average: aggAverage,
      overallGrade: aggGrade,
      overallRemark: overall.remark,
      overallRemarkAr: overall.remarkAr,
      position,
      classSize: preload.performance ? preload.performance.size : null,
      teacherComment: summary ? summary.teacher_comment : "",
      headComment: summary ? summary.head_comment : "",
      promotionStatus: summary ? summary.promotion_status : "pending",
      publishedAt: summary ? summary.published_at : null,
    },
    attendance,
    behaviour: {
      categories: preload.template.behaviourCategories,
      ratings: parseBehaviour(summary ? summary.behaviour_ratings : null, preload.template.behaviourCategories),
    },
    classPerformance: preload.performance,
    nextTerm: preload.nextTerm,
    completeness: {
      complete: completeness.complete,
      missingSubjects: completeness.missing,
      pendingSubjects: completeness.pending,
    },
    status: deriveReportStatus(
      allStatuses,
      summary ? summary.published_at : null,
      completeness.missing.length
    ),
    reference,
  };
}

/**
 * Loads everything a class term's report sheets share (one query each), so
 * building a whole class never degenerates into per-student template/config/
 * class-level lookups.
 */
async function preloadClassTerm(madrasaId, classId, termId) {
  const term = await db.get("SELECT * FROM terms WHERE id = ? AND madrasa_id = ?", [termId, madrasaId]);
  if (!term) return null;
  const classRow = classId ? await db.get("SELECT * FROM classes WHERE id = ? AND madrasa_id = ?", [classId, madrasaId]) : null;
  if (classId && !classRow) return null;
  const session = await db.get("SELECT * FROM academic_sessions WHERE id = ?", [term.session_id]);
  const [madrasa, config, template] = await Promise.all([
    db.get("SELECT * FROM madaris WHERE id = ?", [madrasaId]),
    grading.getGradingConfig(madrasaId),
    getReportTemplate(madrasaId),
  ]);
  const summaries = classId
    ? await db.all("SELECT * FROM term_summaries WHERE madrasa_id = ? AND class_id = ? AND term_id = ?", [madrasaId, classId, termId])
    : await db.all("SELECT * FROM term_summaries WHERE madrasa_id = ? AND term_id = ?", [madrasaId, termId]);
  const completeness = classId
    ? await classCompleteness(madrasaId, classId, termId)
    : { subjects: [], byStudent: new Map(), studentCount: 0 };
  const summaryStudentIds = summaries.map((s) => Number(s.student_id));
  const attendance = await attendanceBreakdownMap(madrasaId, summaryStudentIds, termId);
  return {
    term,
    classRow,
    sessionLabel: session ? session.label : "",
    madrasaInfo: {
      nameEn: madrasa.name_en,
      nameAr: madrasa.name_ar,
      logoPath: madrasa.logo_path,
      mottoEn: madrasa.motto_en,
      mottoAr: madrasa.motto_ar,
      address: madrasa.address,
      city: madrasa.city,
      stateName: madrasa.state_name,
      phone: madrasa.phone,
      email: madrasa.email,
      website: madrasa.website,
      brandColor: madrasa.brand_color || "",
      // Drives the report theme (Islamic / Western). Reuses the institution
      // category that already exists on the tenant — no second system.
      category: madrasa.category || "",
      institutionType: madrasa.institution_type || "",
    },
    config,
    template,
    summaries,
    summariesByStudent: new Map(summaries.map((s) => [Number(s.student_id), s])),
    attendance,
    performance: classPerformanceFrom(summaries),
    nextTerm: await nextTermInfo(madrasaId, term),
    completeness,
  };
}

/** Full printable dataset for ONE student + term. */
async function buildReportSheet(madrasaId, studentId, termId) {
  const student = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [studentId, madrasaId]);
  if (!student) return null;
  const preload = await preloadClassTerm(madrasaId, student.class_id, termId);
  if (!preload) return null;
  const resultRows = await db.all(
    `SELECT r.subject_id, r.ca, r.exam, r.total, r.grade, r.grade_point, r.teacher_remark, r.status,
            su.name_en, su.name_ar
     FROM results r JOIN subjects su ON su.id = r.subject_id
     WHERE r.madrasa_id = ? AND r.student_id = ? AND r.term_id = ?
       AND r.status IN ('approved','published','locked')
     ORDER BY su.name_en`,
    [madrasaId, studentId, termId]
  );
  const data = assembleReport(preload, student, preload.summariesByStudent.get(Number(studentId)) || null, resultRows);
  // The batched attendance map only covers students that already have a
  // term summary. For a preview generated before the class term is computed,
  // fall back to the single-student breakdown (same table, same arithmetic)
  // so an existing attendance record is never silently shown as absent.
  if (!preload.attendance.has(Number(studentId))) {
    data.attendance = await attendanceBreakdown(madrasaId, studentId, termId);
  }
  await backfillReference(madrasaId, studentId, termId, data.reference);
  return data;
}

/** Persists the reference number on first use (idempotent, best-effort). */
async function backfillReference(madrasaId, studentId, termId, reference) {
  if (!reference) return;
  try {
    await db.run(
      "UPDATE term_summaries SET report_reference = ? WHERE madrasa_id = ? AND student_id = ? AND term_id = ? AND (report_reference IS NULL OR report_reference = '')",
      [reference, madrasaId, studentId, termId]
    );
  } catch (e) { /* cosmetic field — never fail a report over it */ }
}

/**
 * Datasets for every student in a class with a term summary, in position
 * order. Batched: shared lookups run once, per-student data comes from three
 * grouped queries, and each student's section is assembled in memory.
 */
async function buildClassReportSheets(madrasaId, classId, termId) {
  const preload = await preloadClassTerm(madrasaId, classId, termId);
  if (!preload) return null;
  const ordered = preload.summaries.slice().sort((a, b) => (Number(a.position) || 1e9) - (Number(b.position) || 1e9) || Number(a.student_id) - Number(b.student_id));
  if (!ordered.length) return [];
  const studentIds = ordered.map((s) => Number(s.student_id));
  const marks = studentIds.map(() => "?").join(",");
  const students = await db.all(
    `SELECT * FROM students WHERE madrasa_id = ? AND id IN (${marks})`,
    [madrasaId].concat(studentIds)
  );
  const studentsById = new Map(students.map((s) => [Number(s.id), s]));
  const resultRows = await db.all(
    `SELECT r.student_id, r.subject_id, r.ca, r.exam, r.total, r.grade, r.grade_point, r.teacher_remark, r.status,
            su.name_en, su.name_ar
     FROM results r JOIN subjects su ON su.id = r.subject_id
     WHERE r.madrasa_id = ? AND r.class_id = ? AND r.term_id = ?
       AND r.status IN ('approved','published','locked')
     ORDER BY r.student_id, su.name_en`,
    [madrasaId, classId, termId]
  );
  const resultsByStudent = new Map();
  for (const r of resultRows) {
    const sid = Number(r.student_id);
    if (!resultsByStudent.has(sid)) resultsByStudent.set(sid, []);
    resultsByStudent.get(sid).push(r);
  }
  const out = [];
  for (const summary of ordered) {
    const student = studentsById.get(Number(summary.student_id));
    if (!student) continue;
    const rows = resultsByStudent.get(Number(summary.student_id)) || [];
    if (!rows.length) continue;
    const data = assembleReport(preload, student, summary, rows);
    await backfillReference(madrasaId, summary.student_id, termId, data.reference);
    out.push(data);
  }
  return out;
}

/* -------------------------------- rendering ------------------------------- */

/** How many result columns the sheet will actually show. */
function visibleColumnCount(template) {
  return RESULT_COLUMNS.filter((key) => template.columns[key]).length;
}

/**
 * Auto orientation. A long subject list is NOT a reason to rotate the page:
 * the density planner below fits 12–15 subjects on A4 portrait. Only a very
 * wide table (every optional column switched on) turns the sheet landscape.
 */
function resolveOrientation(template) {
  if (template.orientation !== "auto") return template.orientation;
  return visibleColumnCount(template) >= 7 ? "landscape" : "portrait";
}

/** Colour helpers so banded headers stay readable on any brand colour. */
function shade(hex, amount) {
  const m = /^#([0-9a-fA-F]{6})$/.test(hex) ? hex : "#14532d";
  const num = parseInt(m.slice(1), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amount));
  const b = Math.min(255, Math.max(0, (num & 0xff) + amount));
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Mixes a colour toward white (ratio 0 = original, 1 = white). */
function tint(hex, ratio) {
  const m = /^#([0-9a-fA-F]{6})$/.test(hex) ? hex : "#14532d";
  const num = parseInt(m.slice(1), 16);
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  const mix = (v) => Math.round(v + (255 - v) * r);
  return "#" + [mix(num >> 16), mix((num >> 8) & 0xff), mix(num & 0xff)]
    .map((v) => v.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------ page geometry ----------------------------- */

/**
 * A4 geometry. `@page` keeps a zero margin and the printable margin lives on
 * the sheet itself, so the on-screen preview and the printed page are exactly
 * the same box and a continuation page keeps its margins through
 * `box-decoration-break: clone`.
 */
const PAGE_SIZES = { portrait: { w: 210, h: 297 }, landscape: { w: 297, h: 210 } };
const PAGE_MARGIN_MM = 9;              // house style: 8–10 mm
// Safety reserve kept free on every page. The budget below is an analytical
// model of the CSS, not a browser layout pass, so a tier is only accepted
// when it fits with a few millimetres to spare — that absorbs font-metric
// differences between print engines instead of spilling one row onto page 2.
const FIT_RESERVE_MM = 5;
const MM_PER_PX = 0.2645833;
const mmOf = (px) => Math.round(px * MM_PER_PX * 1000) / 1000;
const round1 = (n) => Math.round(n * 10) / 10;
const clampMm = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Baseline mm widths of the numeric result columns. */
const RESULT_COL_MM = { ca: 14, exam: 16, total: 14, pct: 13, grade: 13, gradePoint: 12, remark: 34 };
/** Reference font used when apportioning column widths (see planColumns). */
const NOMINAL_TABLE_FONT = 9.6;

/**
 * Apportions the two text columns — subject and remark — across whatever the
 * numeric columns leave over, aiming to keep the longest value in each on no
 * more than two lines. A roster of short subject names hands its surplus to
 * the remark column (and vice versa) instead of leaving one column padded
 * with empty space while the other wraps three times and pushes the report
 * onto a second page.
 */
function planColumns(template, subjects, rtl, printableW) {
  const charMm = NOMINAL_TABLE_FONT * 0.52 * MM_PER_PX;
  const widest = (pick) => subjects.reduce((max, s) => Math.max(max, String(pick(s) || "").length), 0);
  const subjChars = Math.max(10, widest((s) => (rtl ? (s.nameAr || s.nameEn) : (s.nameEn || s.nameAr))));
  const remChars = template.columns.remark
    ? Math.max(6, widest((s) => (rtl ? (s.remarkAr || s.remark) : (s.remark || s.remarkAr))))
    : 0;

  const cols = {};
  let fixed = 0;
  for (const key of RESULT_COLUMNS) {
    if (!template.columns[key] || key === "remark") continue;
    cols[key] = RESULT_COL_MM[key];
    fixed += RESULT_COL_MM[key];
  }
  const available = Math.max(60, printableW - fixed);

  // Width that puts the longest entry on two lines, plus cell padding.
  const twoLines = (chars, pad) => (Math.ceil(chars / 2) + 2) * charMm + pad;
  let subj = clampMm(twoLines(subjChars, 9), 44, available);
  let rem = remChars ? clampMm(twoLines(remChars, 3), 26, 56) : 0;
  if (subj + rem > available) {
    // Shrink both toward their floors in proportion to what they asked for.
    const over = subj + rem - available;
    const subjRoom = subj - 44;
    const remRoom = rem ? rem - 26 : 0;
    const room = subjRoom + remRoom || 1;
    subj -= over * (subjRoom / room);
    rem -= over * (remRoom / room);
  } else {
    subj = available - rem;                 // any surplus widens the subject
  }
  if (rem) cols.remark = round1(rem);
  return { cols, subjectMm: round1(Math.max(30, subj)) };
}

/**
 * Density tiers. The planner picks the loosest tier whose measured height
 * still fits one printable page, so a 6-subject report breathes while a 12-
 * or 15-subject report is tightened — never shrunk to unreadable text (the
 * results table never prints below 9 px).
 */
const DENSITY_TIERS = [
  {
    key: "regular",
    tableFont: 10.2, headFont: 8.6, rowH: 6.0, rowPad: 1.35,
    logo: 18, nameMax: 20, gap: 2.6, headingH: 4.8, titleH: 10.4,
    photoW: 31, photoH: 37, infoRowH: 9.2, statusH: 7.4,
    commentMin: 13, sigSpace: 12,
  },
  {
    key: "dense",
    tableFont: 9.6, headFont: 8.2, rowH: 5.2, rowPad: 1.05,
    logo: 17, nameMax: 18, gap: 2.2, headingH: 4.5, titleH: 9.8,
    photoW: 30, photoH: 35.5, infoRowH: 8.4, statusH: 7.0,
    commentMin: 11, sigSpace: 10,
  },
  {
    key: "tight",
    tableFont: 9.0, headFont: 7.7, rowH: 4.6, rowPad: 0.8,
    logo: 15.5, nameMax: 16, gap: 1.8, headingH: 4.2, titleH: 9.2,
    // The photograph keeps its 30 × 35 mm passport frame even here — the
    // millimetres come out of the comment and signature reserves instead,
    // which grow again the moment the page has slack.
    photoW: 30, photoH: 35, infoRowH: 7.6, statusH: 6.4,
    commentMin: 8, sigSpace: 7.5,
  },
];

/* --------------------------------- theming -------------------------------- */

/**
 * Two genuinely different visual identities, selected by the tenant's
 * EXISTING category (`madaris.category` / `institution_type`, normalised by
 * services/institution.js) — no new school-type system, and never a
 * hard-coded school name:
 *
 *   islamic  — deep academic green with a restrained gold accent, serif
 *              academic typography, framed title carrying a faint 8-point
 *              star hairline, diamond section markers, double rules.
 *   western  — modern navy academic design: reversed solid title bar,
 *              left-aligned masthead with the contact block on the right,
 *              modern sans typography, square accent markers, single rules,
 *              no Islamic ornament and no decorative Arabic.
 *
 * A school's own configured brand colour always wins over the category
 * default, so tenant branding is preserved in both themes.
 */
const THEME_DEFAULTS = {
  islamic: {
    brand: "#14532d",
    accent: "#a87f2b",
    zebra: 0.94,
    headingFont: 'Georgia, "Times New Roman", "Noto Naskh Arabic", serif',
    titleText: ["Term Report Sheet", "التقرير الفصلي"],
  },
  western: {
    brand: "#0a2342",
    accent: "#3f6fa6",
    zebra: 0.955,
    headingFont: '"Segoe UI Semibold", "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif',
    titleText: ["Term Report", "التقرير الفصلي"],
  },
};

/** Resolves the report theme for a tenant from the existing category field. */
function reportTheme(data) {
  const key = institution.normalizeCategory(
    data.madrasa ? data.madrasa.category : "",
    data.madrasa ? data.madrasa.institutionType : ""
  );
  const base = THEME_DEFAULTS[key] || THEME_DEFAULTS.islamic;
  const brand = hexColor(data.template && data.template.brandColor)
    || hexColor(data.madrasa && data.madrasa.brandColor)
    || base.brand;
  return {
    key,
    brand,
    brandDark: shade(brand, -26),
    brandSoft: tint(brand, 0.88),
    brandTint: tint(brand, base.zebra),
    brandLine: tint(brand, 0.55),
    accent: base.accent,
    accentSoft: tint(base.accent, 0.72),
    headingFont: base.headingFont,
    titleText: base.titleText,
    islamic: key === "islamic",
  };
}

/** Faint geometric hairline (two crossed squares = 8-point star) — Islamic only. */
function geometricPattern(color) {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'>"
    + `<g fill='none' stroke='${color}' stroke-width='1.1' opacity='0.45'>`
    + "<rect x='12' y='12' width='24' height='24'/>"
    + "<rect x='12' y='12' width='24' height='24' transform='rotate(45 24 24)'/>"
    + "</g></svg>";
  return `url("data:image/svg+xml,${svg.replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E")}")`;
}

/**
 * Only the active theme's rules are emitted. A Western school's report
 * therefore contains no Islamic ornament, pattern or selector at all — not
 * merely unused ones — and an Islamic report carries no dead Western rules.
 * (A bulk document reuses the first sheet's stylesheet; every sheet in a
 * batch belongs to the same institution, so the theme is the same.)
 */
function themeCss(theme) {
  if (theme.islamic) {
    return `
  /* =======================================================================
     THEME — ISLAMIC: deep academic green, restrained gold, serif academic
     typography, framed title carrying a faint geometric hairline.
     ======================================================================= */
  .theme-islamic .masthead-id { text-align: center; }
  .theme-islamic .masthead-crest { width: var(--logo); flex: none; display: flex; align-items: center; justify-content: center; }
  .theme-islamic .crest { width: calc(var(--logo) * .5); height: calc(var(--logo) * .5); border: .4mm solid var(--accent); transform: rotate(45deg); position: relative; }
  .theme-islamic .crest::after { content: ""; position: absolute; inset: 1.1mm; border: .3mm solid var(--brand-line); }
  .theme-islamic .masthead-rule { height: 1.5mm; border-top: .9mm solid var(--brand); border-bottom: .3mm solid var(--accent); }
  .theme-islamic .doc-title { text-align: center; padding: 1.4mm 0 1.2mm; border-top: .25mm solid var(--brand-line); border-bottom: .25mm solid var(--brand-line); background-image: ${geometricPattern(theme.accent)}; background-size: 12mm 12mm; background-position: center; }
  .theme-islamic .doc-title .en { font-size: 14px; letter-spacing: .3em; color: var(--brand-dark); }
  .theme-islamic .doc-title .en::before, .theme-islamic .doc-title .en::after { content: "◆"; color: var(--accent); font-size: .5em; vertical-align: .24em; margin: 0 2.6mm; letter-spacing: 0; }
  .theme-islamic .doc-title .meta { margin-top: .9mm; color: #46525f; }
  .theme-islamic .doc-title .meta b { color: var(--brand-dark); }
  .theme-islamic .block h2::before { content: ""; width: 1.8mm; height: 1.8mm; flex: none; background: var(--accent); transform: rotate(45deg); }
  .theme-islamic .block h2::after { content: ""; flex: 1; border-top: .3mm solid var(--brand-line); }
  .theme-islamic table.results th { border-bottom: .5mm solid var(--accent); }
  .theme-islamic .promo-badge { border: .4mm double var(--brand-dark); color: var(--brand-dark); background: var(--brand-soft); font-family: var(--heading-font); }
  .theme-islamic .foot { box-shadow: 0 .55mm 0 var(--accent-soft); }`;
  }
  return `  /* =======================================================================
     THEME — WESTERN: modern navy academic design, reversed title bar,
     left-aligned masthead, square accent markers, no Islamic ornament.
     ======================================================================= */
  .theme-western .masthead { gap: 3.6mm; }
  .theme-western .logo-fallback { background: var(--brand); color: #fff; border: 0; }
  .theme-western .masthead-id { display: flex; flex-direction: column; justify-content: center; text-align: start; border-inline-start: .8mm solid var(--brand); padding-inline-start: 3mm; }
  .theme-western .school-name { letter-spacing: .01em; }
  .theme-western .motto { letter-spacing: .1em; text-transform: none; font-size: 9.2px; }
  .theme-western .masthead-contact { flex: none; max-width: 60mm; text-align: end; }
  .theme-western .masthead-contact p { margin: 0 0 .7mm; font-size: 8.4px; color: var(--muted); line-height: 1.32; }
  .theme-western .masthead-contact p:last-child { margin-bottom: 0; }
  .theme-western .masthead-rule { height: .7mm; background: var(--brand); }
  .theme-western .doc-title { display: flex; align-items: baseline; justify-content: space-between; gap: 4mm; background: var(--brand); color: #fff; padding: 1.5mm 3mm; }
  .theme-western .doc-title .en { font-size: 12.5px; letter-spacing: .18em; color: #fff; }
  .theme-western .doc-title .meta { color: rgba(255,255,255,.86); letter-spacing: .08em; }
  .theme-western .doc-title .meta b { color: #fff; }
  .theme-western .student-band { border: 0; border-top: .25mm solid var(--line); border-bottom: .25mm solid var(--line); background: #f5f7fa; }
  .theme-western .block h2 { letter-spacing: .1em; }
  .theme-western .block h2::before { content: ""; width: 1.4mm; height: 3.2mm; flex: none; background: var(--accent); }
  .theme-western .block h2::after { content: ""; flex: 1; border-top: .25mm solid #d5dbe3; }
  .theme-western table.results th { border-color: var(--brand); }
  .theme-western table.results tbody tr:nth-child(even) td { background: #f4f7fb; }
  .theme-western .promo-badge { background: var(--brand); color: #fff; }
  .theme-western .promo-strip { border-inline-start: 1.4mm solid var(--brand); }`;
}

/* ------------------------------- page planner ----------------------------- */

/** Estimated wrapped line count for `text` in a column `widthMm` wide. */
function textLines(text, widthMm, fontPx, weight = 0.52) {
  const chars = String(text === null || text === undefined ? "" : text).length;
  if (!chars) return 1;
  const charMm = Math.max(0.6, fontPx * weight * MM_PER_PX);
  const perLine = Math.max(6, Math.floor(widthMm / charMm));
  return Math.max(1, Math.ceil(chars / perLine));
}

/**
 * Measures the whole document in millimetres for one density tier.
 *
 * This is the mechanism behind the "12 subjects on one A4 page" guarantee.
 * Every block is rendered at exactly the height budgeted here — the CSS is
 * driven by the same numbers through custom properties — so the planner knows
 * before any HTML exists whether the report fits a page, and tightens the
 * density instead of spilling three rows onto a second sheet.
 */
function measureSheet(m, tier) {
  const t = m.data.template;
  const w = m.printableW;
  const parts = {};

  /* masthead --------------------------------------------------------------- */
  const nameSize = m.nameSizeFor(tier.nameMax);
  const nameWidth = m.theme.islamic ? w - tier.logo * 2 - 12 : w - tier.logo - 66;
  const nameLines = textLines(m.data.madrasa.nameEn, nameWidth, nameSize, 0.6);
  const identityH = nameLines * mmOf(nameSize * 1.16)
    + (m.motto ? mmOf(11.2) : 0)
    + (m.theme.islamic ? m.contactLines.length * mmOf(10.2) : 0);
  const contactStackH = m.theme.islamic ? 0 : m.contactLines.length * mmOf(10.8);
  parts.masthead = Math.max(tier.logo, identityH, contactStackH) + 1.3;
  parts.rule = 1.5 + 2.2;

  /* title band -------------------------------------------------------------- */
  parts.title = tier.titleH + tier.gap;

  /* student information + photograph ---------------------------------------- */
  const infoRows = Math.ceil(m.infoFields.length / 2);
  const statusH = m.statusKind === "final"
    ? tier.statusH
    : 3.2 + m.statusLines * mmOf(9.2 * 1.35) + 2.4;
  const infoH = infoRows * tier.infoRowH + 1.2 + statusH;
  parts.student = Math.max(m.showPhoto ? tier.photoH : 0, infoH) + 3.4;

  /* academic performance table ---------------------------------------------- */
  const subjectColMm = m.columns.subjectMm;
  const lineMm = mmOf(tier.tableFont * 1.28);
  let extraLines = 0;
  for (const s of m.data.subjects) {
    const nameL = textLines(m.rtl ? (s.nameAr || s.nameEn) : (s.nameEn || s.nameAr), subjectColMm - 9, tier.tableFont);
    const remarkL = t.columns.remark
      ? textLines(m.rtl ? (s.remarkAr || s.remark) : (s.remark || s.remarkAr), m.columns.cols.remark - 3, tier.tableFont)
      : 1;
    extraLines += Math.max(nameL, remarkL) - 1;
  }
  const bodyRows = Math.max(1, m.data.subjects.length);
  parts.table = tier.gap + tier.headingH + (tier.rowH + 0.8) + bodyRows * tier.rowH + extraLines * lineMm;

  /* performance summary + grading scale -------------------------------------- */
  parts.summary = m.perf.length ? tier.gap + tier.headingH + 4.8 + 6.8 : 0;
  parts.legend = m.legendRows ? (m.perf.length ? 1.5 : tier.gap) + m.legendRows * 5.2 : 0;

  /* attendance + behaviour (side by side) ------------------------------------ */
  const attendanceH = m.showAttendance ? (m.data.attendance.total ? 9.8 + 5.6 : 5.0) : 0;
  const behaviourH = m.showBehaviour ? (m.ratedCategories.length ? Math.ceil(m.ratedCategories.length / 2) * 4.6 : 5.0) : 0;
  parts.record = (m.showAttendance || m.showBehaviour)
    ? tier.gap + tier.headingH + Math.max(attendanceH, behaviourH)
    : 0;

  /* comments ----------------------------------------------------------------- */
  parts.comments = m.showComments ? tier.gap + tier.headingH + 5.0 + tier.commentMin : 0;

  /* promotion ---------------------------------------------------------------- */
  parts.promotion = m.showPromotion ? tier.gap + 8.4 : 0;

  /* signatures + minimal footer ----------------------------------------------- */
  parts.signatures = m.signatures.length
    ? 3.4 + tier.sigSpace + 0.4 + 3.6 + (m.signatureNames ? 3.2 : 0) + 3.0
    : 0;
  parts.footer = 1.2 + m.footerLines * 3.4 + 1.4;

  let total = 0;
  for (const key of Object.keys(parts)) total += parts[key];
  return { parts, total: round1(total) };
}

/**
 * Chooses the density that fits and distributes any leftover millimetres.
 * Left-over space goes where it is actually useful on a school report — the
 * comment boxes and the signature area — instead of leaving a dead band above
 * the footer.
 */
function planSheet(m) {
  const budget = m.printableH - FIT_RESERVE_MM;
  let chosen = null;
  for (const tier of DENSITY_TIERS) {
    if (m.forceDense && tier.key === "regular") continue;
    const measured = measureSheet(m, tier);
    if (measured.total <= budget) { chosen = { tier, measured }; break; }
  }
  // Nothing fits comfortably: keep the tightest readable density (never
  // smaller than 9 px) and let the document flow onto a second page. The
  // table header repeats there and no row is split, so a 20+ subject report
  // stays legible instead of being crushed.
  if (!chosen) {
    const tier = DENSITY_TIERS[DENSITY_TIERS.length - 1];
    chosen = { tier, measured: measureSheet(m, tier) };
  }
  const total = chosen.measured.total;
  const slack = Math.max(0, budget - total);   // never spend the reserve
  return {
    tier: chosen.tier,
    density: chosen.tier.key,
    orientation: m.orientation,
    subjects: m.data.subjects.length,
    printableHeightMm: m.printableH,
    reserveMm: FIT_RESERVE_MM,
    heightMm: total,
    parts: chosen.measured.parts,
    slackMm: round1(slack),
    pages: Math.max(1, Math.ceil(total / m.printableH)),
    fitsOnePage: total <= m.printableH,
    commentMin: round1(chosen.tier.commentMin + clampMm(slack * 0.42, 0, 20)),
    sigSpace: round1(chosen.tier.sigSpace + clampMm(slack * 0.2, 0, 9)),
  };
}

/* ------------------------------ shared pieces ----------------------------- */

/** Neutral person silhouette used when a student has no photograph. */
const PHOTO_PLACEHOLDER_SVG = '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';

/** Human labels for the review-workflow statuses shown in the toolbar. */
const STATUS_LABELS = {
  draft: "Draft",
  returned: "Returned",
  submitted: "Submitted",
  under_review: "Awaiting review",
  approved: "Approved",
  published: "Published",
  locked: "Locked",
};

const PROMOTION_TEXT = {
  promoted: { en: "Promoted", ar: "نُقل إلى الصف الأعلى" },
  repeating: { en: "Repeating", ar: "يعيد السنة" },
  graduated: { en: "Graduated", ar: "تخرّج" },
  pending: { en: "Pending", ar: "قيد القرار" },
  promoted_trial: { en: "Promoted on Trial", ar: "نُقل تحت التجربة" },
  withdrawn: { en: "Withdrawn", ar: "منسحب" },
  completed: { en: "Completed", ar: "أكمل البرنامج" },
};

/**
 * Fills any field the assembler normally provides so the renderer also
 * accepts a plain grading.reportCardData payload (back-compat callers) and
 * degrades gracefully instead of crashing on missing optional data.
 */
function normalizeRenderInput(data) {
  const template = data.template || normaliseTemplate(null);
  const summary = data.summary || {};
  const d = Object.assign({}, data);
  d.template = template;
  d.madrasa = Object.assign({ nameEn: "", nameAr: "", logoPath: "", mottoEn: "", mottoAr: "", address: "", city: "", stateName: "", phone: "", email: "", website: "", brandColor: "", category: "", institutionType: "" }, data.madrasa || {});
  d.student = Object.assign({ photoPath: "", nameAr: "", gender: "", dateOfBirth: "", section: "", program: "", studentCode: "", classEn: "", classAr: "", admissionNo: "", name: "" }, data.student || {});
  d.term = Object.assign({ nameEn: "", nameAr: "" }, data.term || {});
  d.subjects = Array.isArray(data.subjects) ? data.subjects : [];
  d.config = Object.assign({ caMax: 40, examMax: 60, passMark: 50, bands: grading.DEFAULT_BANDS.slice() }, data.config || {});
  d.summary = Object.assign({
    total: 0, subjectCount: d.subjects.length, average: 0, overallGrade: "", overallRemark: "",
    overallRemarkAr: "", position: null, classSize: null, teacherComment: "", headComment: "",
    promotionStatus: "pending", publishedAt: null,
  }, summary);
  d.attendance = data.attendance || {
    present: Number(summary.attendanceDays || 0),
    absent: 0, late: 0, excused: 0,
    total: Number(summary.attendanceTotal || 0),
    percentage: summary.attendancePercentage === undefined || summary.attendancePercentage === null ? null : Number(summary.attendancePercentage),
  };
  d.behaviour = data.behaviour || { categories: template.behaviourCategories, ratings: {} };
  d.classPerformance = data.classPerformance || null;
  d.nextTerm = data.nextTerm || null;
  d.completeness = data.completeness || { complete: true, missingSubjects: [], pendingSubjects: [] };
  d.status = data.status || deriveReportStatus(d.subjects.map((s) => s.status || "approved"), d.summary.publishedAt, 0);
  d.reference = data.reference || "";
  d.session = data.session || "";
  return d;
}

/* ------------------------------ report model ------------------------------ */

/**
 * Everything the document shows, derived once from the assembled data: which
 * sections are on, the (de-duplicated) student identity fields, the result
 * status, the summary figures, the grading bands, the conduct ratings and the
 * measured page plan. The renderer below only turns this into markup and the
 * planner only measures it — one source of truth for both.
 *
 * Information is deliberately shown ONCE:
 *   • academic session + term live in the title band only,
 *   • the student block carries name, student ID, class and gender only
 *     (date of birth and admission number are intentionally not printed —
 *     they remain in the database and in every other screen and export),
 *   • the report reference appears once, small, in the minimal footer.
 */
function reportModel(data, opts = {}) {
  data = normalizeRenderInput(data);
  const t = data.template;
  const rtl = String(data.student.nameAr || "").length > 0;
  const L = (en, arabic) => (rtl && arabic ? arabic : en);
  const theme = reportTheme(data);
  const orientation = resolveOrientation(t);
  const page = PAGE_SIZES[orientation] || PAGE_SIZES.portrait;
  const printableW = page.w - PAGE_MARGIN_MM * 2;
  const printableH = page.h - PAGE_MARGIN_MM * 2;

  const incomplete = !data.completeness.complete;
  const nonFinal = ["draft", "returned", "submitted", "under_review"].includes(data.status);
  const workingCopy = !opts.portal && !opts.publicCopy && nonFinal;

  /* school identity ---------------------------------------------------------- */
  const motto = rtl && data.madrasa.mottoAr ? data.madrasa.mottoAr : (data.madrasa.mottoEn || data.madrasa.mottoAr);
  const addressLine = [data.madrasa.address, data.madrasa.city, data.madrasa.stateName]
    .filter((x) => x && String(x).trim()).join(", ");
  const contactBits = [
    data.madrasa.phone ? `${L("Tel", "هاتف")}: ${data.madrasa.phone}` : "",
    data.madrasa.email,
    data.madrasa.website,
  ].filter((x) => x && String(x).trim());
  // Islamic: address + contacts centred under the name. Western: the same
  // facts stacked at the right of the masthead. Either way they appear once.
  const contactLines = theme.islamic
    ? [addressLine, contactBits.join("  ·  ")].filter(Boolean)
    : [addressLine].concat(contactBits).filter(Boolean);

  /* student identity --------------------------------------------------------- */
  const infoFields = [];
  const addInfo = (label, value) => {
    if (value === null || value === undefined || String(value).trim() === "") return;
    infoFields.push([label, String(value)]);
  };
  addInfo(L("Student name", "اسم الطالب"), rtl ? (data.student.nameAr || data.student.name) : data.student.name);
  addInfo(L("Student ID", "الرقم التعريفي"), data.student.studentCode || data.student.admissionNo);
  addInfo(L("Class", "الفصل"), rtl ? (data.student.classAr || data.student.classEn) : (data.student.classEn || data.student.classAr));
  if (t.showStudentDetails && data.student.gender) {
    addInfo(L("Gender", "الجنس"), data.student.gender === "M" ? L("Male", "ذكر")
      : data.student.gender === "F" ? L("Female", "أنثى") : data.student.gender);
  }

  /* result status ------------------------------------------------------------ */
  const missing = data.completeness.missingSubjects || [];
  const pending = data.completeness.pendingSubjects || [];
  const subjList = (list) => list.map((s) => (rtl && s.nameAr ? s.nameAr : s.nameEn)).join(", ");
  const statusDetail = [
    missing.length ? `${L("Missing", "مفقود")}: ${subjList(missing)}` : "",
    pending.length ? `${L("Awaiting approval", "بانتظار الاعتماد")}: ${subjList(pending)}` : "",
  ].filter(Boolean).join("  ·  ");
  const statusKind = incomplete ? "incomplete" : workingCopy ? "working" : "final";
  const statusLabel = incomplete
    ? L("Incomplete", "غير مكتملة")
    : workingCopy
      ? L("Working copy", "نسخة عمل")
      : L(STATUS_LABELS[data.status] || data.status, "معتمدة");
  const statusBody = statusKind === "incomplete"
    ? (statusDetail || L("Some required results are missing or not yet approved.", "بعض النتائج مفقودة أو لم تُعتمد بعد."))
    : L("These results have not completed the approval workflow; this sheet is not a final report.",
      "لم تكتمل دورة الاعتماد لهذه النتائج؛ هذه النسخة ليست تقريرًا نهائيًا.");

  /* performance summary ------------------------------------------------------- */
  const perf = [];
  if (data.summary.subjectCount) {
    perf.push([L("Subjects offered", "عدد المواد"), data.summary.subjectCount]);
    if (t.columns.total) perf.push([L("Total marks", "مجموع الدرجات"), data.summary.total]);
    perf.push([L("Average score", "المعدل"), `${data.summary.average}%`]);
    perf.push([L("Overall grade", "الدرجة العامة"), data.summary.overallGrade || "—"]);
  }
  if (t.showPosition && data.summary.position && data.classPerformance && data.classPerformance.size) {
    perf.push([L("Position", "الترتيب"), `${ordinal(data.summary.position)} ${L("of", "من")} ${data.classPerformance.size}`]);
  }
  if (t.showClassPerformance && data.classPerformance) {
    perf.push([L("Class size", "عدد الطلاب"), data.classPerformance.size]);
    perf.push([L("Class average", "معدل الفصل"), `${data.classPerformance.average}%`]);
  }

  /* grading scale, conduct, footer -------------------------------------------- */
  const bands = t.showGradeLegend && data.config.bands.length
    ? data.config.bands.slice().sort((a, b) => Number(b.min) - Number(a.min))
    : [];
  const ratedCategories = t.showBehaviour
    ? data.behaviour.categories.filter((c) => data.behaviour.ratings[c.key] !== null && data.behaviour.ratings[c.key] !== undefined)
    : [];
  const verifiedLine = opts.publicCopy
    ? `Published online copy — verified ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "";
  const footerBits = [
    t.showEdusphereCredit ? "Powered by EduSphere" : "",
    t.showReference && data.reference ? `${L("Ref", "المرجع")}: ${data.reference}` : "",
  ].filter(Boolean);

  const nameLen = String(data.madrasa.nameEn || "").length;
  const columns = planColumns(t, data.subjects, rtl, printableW);
  const model = {
    columns,
    data, t, opts, rtl, L, theme, orientation, page, printableW, printableH,
    incomplete, nonFinal, workingCopy,
    motto, addressLine, contactBits, contactLines,
    infoFields, statusKind, statusLabel, statusDetail, statusBody,
    statusLines: statusKind === "final" ? 1 : Math.min(3, 1 + Math.ceil(Math.max(statusBody.length, 1) / 95)),
    perf, bands,
    legendRows: bands.length ? Math.ceil(bands.length / 7) : 0,
    ratedCategories,
    showPhoto: t.showPhoto,
    showAttendance: t.showAttendance,
    showBehaviour: t.showBehaviour && t.behaviourCategories.length > 0,
    showComments: t.showComments,
    showPromotion: t.showPromotion,
    signatures: t.signatures,
    signatureNames: t.signatures.some((s) => s.name),
    verifiedLine,
    footerBits,
    footerLines: Math.max(1, (footerBits.length ? 1 : 0) + (verifiedLine ? 1 : 0)),
    forceDense: t.layout === "compact",
    // A long school name steps down instead of wrapping the masthead — but
    // never below 11px, which is still comfortably legible in print.
    nameSizeFor: (max) => Math.max(11, nameLen <= 30 ? max : nameLen <= 46 ? max - 3 : nameLen <= 64 ? max - 5 : max - 6.5),
  };
  model.plan = planSheet(model);
  return model;
}

/**
 * The measured A4 plan for a report (density tier, millimetre budget, page
 * count). Exported so the layout contract — "at least 12 subjects on one A4
 * portrait page" — is verifiable rather than merely asserted in a comment.
 */
function planReportSheet(data, opts = {}) {
  return reportModel(data, opts).plan;
}

/* --------------------------------- renderer -------------------------------- */

/**
 * Renders the official A4 report sheet.
 *
 * Presentation only: every figure on the page (CA, exam, total, percentage,
 * grade, average, position, class average, attendance, promotion) comes from
 * services/grading.js and the existing term_summaries engine and is merely
 * laid out here.
 *
 * Design contract:
 *   • one A4 portrait page carries at least 12 subjects with ≥9 px table text
 *     — planSheet() measures the document in millimetres and picks the
 *     loosest density that still fits, so nothing is uniformly shrunk,
 *   • nothing is printed twice: session/term in the title band, identity in
 *     the student block, one short footer line,
 *   • the theme (Islamic / Western) comes from the tenant's existing
 *     category, while the data, sections and calculations stay shared,
 *   • logo and photograph <img> tags are only emitted for files that actually
 *     exist in this deployment's upload directory (assetServed), so a
 *     dangling path degrades to a designed placeholder instead of a browser
 *     broken-image icon,
 *   • the print button and image fallbacks are wired by the same-origin
 *     /js/report-sheet-viewer.js because the platform CSP blocks inline
 *     handlers (the inline onclick stays as a CSP-less fallback).
 *
 * opts.portal        render inside the student/parent portal (published only)
 * opts.publicCopy    render for the public result checker (adds verified line)
 * opts.statusNote    extra line for the non-printing toolbar
 */
function renderReportSheetHTML(data, opts = {}) {
  const m = reportModel(data, opts);
  const { t, rtl, L, theme, plan } = m;
  const d = m.data;
  const tier = plan.tier;
  const cols = t.columns;
  const colCount = visibleColumnCount(t);
  const nameSize = m.nameSizeFor(tier.nameMax);

  /* ---------------- masthead ---------------------------------------------- */
  const logoUrl = assetServed(d.madrasa.logoPath);
  const logoInitial = String((d.madrasa.nameEn || "?").trim().charAt(0) || "?").toUpperCase();
  const logo = logoUrl
    ? `<img class="logo" src="${esc(logoUrl)}" alt="${esc(d.madrasa.nameEn)}" data-fallback="logo" data-initial="${esc(logoInitial)}">`
    : `<div class="logo logo-fallback" aria-hidden="true">${esc(logoInitial)}</div>`;

  const mastheadId = `<div class="masthead-id">
        <h1 class="school-name">${esc(d.madrasa.nameEn)}${d.madrasa.nameAr ? ` <span class="ar" dir="rtl">· ${esc(d.madrasa.nameAr)}</span>` : ""}</h1>
        ${m.motto ? `<p class="motto">${esc(m.motto)}</p>` : ""}
        ${theme.islamic ? m.contactLines.map((line) => `<p class="contact">${esc(line)}</p>`).join("") : ""}
      </div>`;
  const masthead = theme.islamic
    ? `<header class="masthead">
      ${logo}
      ${mastheadId}
      <div class="masthead-crest" aria-hidden="true"><span class="crest"></span></div>
    </header>`
    : `<header class="masthead">
      ${logo}
      ${mastheadId}
      ${m.contactLines.length ? `<div class="masthead-contact">${m.contactLines.map((line) => `<p>${esc(line)}</p>`).join("")}</div>` : ""}
    </header>`;

  /* ---------------- title band --------------------------------------------- */
  const termName = rtl ? (d.term.nameAr || d.term.nameEn) : (d.term.nameEn || d.term.nameAr);
  const docTitle = `<div class="doc-title">
      <p class="en">${esc(L(theme.titleText[0], theme.titleText[1]))}</p>
      <p class="meta"><span>${esc(L("Academic session", "العام الدراسي"))}: <b>${esc(d.session || "—")}</b></span><span class="sep" aria-hidden="true"></span><span>${esc(L("Term", "الفترة"))}: <b>${esc(termName || "—")}</b></span></p>
    </div>`;

  /* ---------------- student information ------------------------------------ */
  const photoUrl = t.showPhoto ? assetServed(d.student.photoPath) : "";
  const photoSlot = !t.showPhoto ? "" : (photoUrl
    ? `<div class="photo-slot"><img class="photo" src="${esc(photoUrl)}" alt="${esc(d.student.name)}" data-fallback="photo"></div>`
    : `<div class="photo-slot photo-empty" aria-hidden="true">${PHOTO_PLACEHOLDER_SVG}</div>`);

  const infoCells = m.infoFields
    .map(([label, value]) => `<div class="cell"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`)
    .join("");

  const statusStrip = m.statusKind === "final"
    ? `<p class="status-line"><span class="k">${esc(L("Result status", "حالة النتيجة"))}</span><span class="v">${esc(m.statusLabel)}</span></p>`
    : `<aside class="status-notice notice-${esc(m.statusKind)}" role="note">
          <p class="notice-title">${esc(L("Result status", "حالة النتيجة"))} — ${esc(m.statusLabel)}</p>
          <p class="notice-body">${esc(m.statusBody)}</p>
        </aside>`;

  const studentBand = `<section class="student-band${photoSlot ? "" : " no-photo"}" aria-label="${esc(L("Student information", "بيانات الطالب"))}">
      <div class="student-main">
        <dl class="student-grid">${infoCells}</dl>
        ${statusStrip}
      </div>
      ${photoSlot}
    </section>`;

  /* ---------------- academic performance ----------------------------------- */
  const colTags = RESULT_COLUMNS.filter((key) => cols[key])
    .map((key) => `<col style="width:${m.columns.cols[key]}mm">`).join("");
  const colgroup = `<colgroup><col style="width:${m.columns.subjectMm}mm">${colTags}</colgroup>`;

  const subjectRows = d.subjects.map((s, i) => {
    const name = rtl ? (s.nameAr || s.nameEn) : (s.nameEn || s.nameAr);
    const remark = rtl ? (s.remarkAr || s.remark) : (s.remark || s.remarkAr);
    const cells = [];
    if (cols.ca) cells.push(`<td class="num">${esc(s.ca)}</td>`);
    if (cols.exam) cells.push(`<td class="num">${esc(s.exam)}</td>`);
    if (cols.total) cells.push(`<td class="num total">${esc(s.total)}</td>`);
    if (cols.pct) cells.push(`<td class="num">${esc(s.pct)}%</td>`);
    if (cols.grade) cells.push(`<td class="grade">${esc(s.grade)}</td>`);
    if (cols.gradePoint) cells.push(`<td class="num">${esc(s.gradePoint)}</td>`);
    if (cols.remark) cells.push(`<td class="remark">${esc(remark || "—")}</td>`);
    return `<tr><td class="subj"><span class="sn">${i + 1}</span>${esc(name)}</td>${cells.join("")}</tr>`;
  }).join("");

  const subjectHeader = (() => {
    const heads = [];
    if (cols.ca) heads.push(`<th scope="col">${esc(L(`${t.caLabel} (${d.config.caMax})`, `${t.caLabel}`))}</th>`);
    if (cols.exam) heads.push(`<th scope="col">${esc(L(`${t.examLabel} (${d.config.examMax})`, `${t.examLabel}`))}</th>`);
    if (cols.total) heads.push(`<th scope="col">${esc(L("Total", "المجموع"))}</th>`);
    if (cols.pct) heads.push(`<th scope="col">%</th>`);
    if (cols.grade) heads.push(`<th scope="col">${esc(L("Grade", "الدرجة"))}</th>`);
    if (cols.gradePoint) heads.push(`<th scope="col">${esc(L("Point", "النقاط"))}</th>`);
    if (cols.remark) heads.push(`<th scope="col">${esc(L("Remark", "ملاحظة"))}</th>`);
    return `<tr><th class="subj" scope="col">${esc(L("Subject", "المادة"))}</th>${heads.join("")}</tr>`;
  })();

  const academicSection = `<section class="block">
      <h2>${esc(L("Academic performance", "الأداء الأكاديمي"))}</h2>
      <table class="results">${colgroup}
        <thead>${subjectHeader}</thead>
        <tbody>${subjectRows || `<tr><td class="subj" colspan="${colCount + 1}">${esc(L("No approved subject results for this term yet.", "لا توجد نتائج معتمدة لهذه الفترة بعد."))}</td></tr>`}</tbody>
      </table>
    </section>`;

  /* ---------------- performance summary + grading scale --------------------- */
  // The scale is a single compact strip. A long scale wraps onto a second
  // row of equal cells rather than squeezing ten unreadable columns.
  const legend = (() => {
    if (!m.bands.length) return "";
    const rowCount = m.legendRows;
    const perRow = Math.ceil(m.bands.length / rowCount);
    const cell = (b) => `<td><b>${esc(b.grade)}</b>${Number(b.min)}+${b.remark ? ` · ${esc(rtl && b.remark_ar ? b.remark_ar : b.remark)}` : ""}</td>`;
    const rows = [];
    for (let r = 0; r < rowCount; r++) {
      const slice = m.bands.slice(r * perRow, (r + 1) * perRow);
      const pad = "<td></td>".repeat(perRow - slice.length);
      const head = r === 0
        ? `<th class="legend-head"${rowCount > 1 ? ` rowspan="${rowCount}"` : ""} scope="row">${esc(L("Grading scale", "سلم الدرجات"))}</th>`
        : "";
      rows.push(`<tr>${head}${slice.map(cell).join("")}${pad}</tr>`);
    }
    return `<table class="legend-table"><tbody>${rows.join("")}</tbody></table>`;
  })();

  const summarySection = m.perf.length
    ? `<section class="block">
        <h2>${esc(L("Performance summary", "ملخص الأداء"))}</h2>
        <table class="summary">
          <thead><tr>${m.perf.map(([k]) => `<th scope="col">${esc(k)}</th>`).join("")}</tr></thead>
          <tbody><tr>${m.perf.map(([, v]) => `<td>${esc(v)}</td>`).join("")}</tr></tbody>
        </table>
        ${legend ? `<div class="legend-wrap">${legend}</div>` : ""}
      </section>`
    : (legend ? `<section class="block"><div class="legend-wrap">${legend}</div></section>` : "");

  /* ---------------- attendance + conduct ------------------------------------ */
  const att = d.attendance;
  const attendanceBlock = m.showAttendance
    ? `<section class="block">
        <h2>${esc(L("Attendance", "الحضور"))}</h2>
        ${att.total ? `<table class="mini att"><thead><tr>${[
      ["Days recorded", "أيام مسجلة"], ["Present", "حاضر"], ["Absent", "غائب"], ["Late", "متأخر"], ["Attendance %", "نسبة الحضور"],
    ].map(([en, ar2]) => `<th scope="col">${esc(L(en, ar2))}</th>`).join("")}</tr></thead><tbody><tr><td>${esc(att.total)}</td><td>${esc(att.present)}</td><td>${esc(att.absent)}</td><td>${esc(att.late)}</td><td>${att.percentage === null ? "—" : `${esc(att.percentage)}%`}</td></tr></tbody></table>`
      : `<p class="empty">${esc(L("No attendance records for this term.", "لا توجد سجلات حضور لهذه الفترة."))}</p>`}
      </section>`
    : "";

  const behaviourBlock = m.showBehaviour
    ? `<section class="block">
        <h2>${esc(L("Behaviour / Conduct", "السلوك والمواظبة"))}</h2>
        ${m.ratedCategories.length ? `<div class="behaviour">${m.ratedCategories.map((c) => {
      const rating = d.behaviour.ratings[c.key];
      return `<span class="beh-cell"><span class="k">${esc(rtl && c.labelAr ? c.labelAr : c.label)}</span><span class="v">${esc(rating)}/5 <i>${esc(RATING_LABELS[rating] || "")}</i></span></span>`;
    }).join("")}</div>`
      : `<p class="empty">${esc(L("No conduct ratings recorded for this term.", "لا توجد تقييمات سلوك لهذه الفترة."))}</p>`}
      </section>`
    : "";

  const recordRow = attendanceBlock || behaviourBlock
    ? `<div class="pair${attendanceBlock && behaviourBlock ? "" : " single"}">${attendanceBlock}${behaviourBlock}</div>`
    : "";

  /* ---------------- comments ------------------------------------------------ */
  const commentsSection = m.showComments
    ? `<section class="block">
        <h2>${esc(L("Comments", "الملاحظات"))}</h2>
        <div class="comments-grid">
          <div class="comment-box"><p class="comment-label">${esc(L("Class teacher's comment", "تعليق معلم الفصل"))}</p><p class="comment-text">${esc(d.summary.teacherComment || "")}</p></div>
          <div class="comment-box"><p class="comment-label">${esc(L("Head of institution's comment", "تعليق رئيس المؤسسة"))}</p><p class="comment-text">${esc(d.summary.headComment || "")}</p></div>
        </div>
      </section>`
    : "";

  /* ---------------- promotion ----------------------------------------------- */
  const promo = PROMOTION_TEXT[d.summary.promotionStatus] || { en: d.summary.promotionStatus, ar: "" };
  const nextTermLine = t.showNextTerm && d.nextTerm && d.nextTerm.begins
    ? `<span class="next-term">${esc(L("Next term begins", "تبدأ الفترة القادمة"))}: <b>${esc(fmtDateHuman(d.nextTerm.begins))}</b>${d.nextTerm.ends ? ` — ${esc(L("ends", "تنتهي"))} <b>${esc(fmtDateHuman(d.nextTerm.ends))}</b>` : ""}</span>`
    : "";
  const promoSection = m.showPromotion
    ? `<div class="promo-strip">
        <span class="promo-k">${esc(L("Promotion status", "قرار الترقية"))}</span>
        <span class="promo-badge">${esc(L(promo.en, promo.ar || promo.en))}</span>
        ${nextTermLine}
      </div>`
    : "";

  /* ---------------- signatures ---------------------------------------------- */
  const signatures = m.signatures.map((sig) => {
    const title = rtl && sig.titleAr ? sig.titleAr : sig.title;
    return `<div class="sig">
        <div class="sig-space"></div>
        <div class="sig-rule"></div>
        <p class="sig-who">${esc(title)}</p>
        ${sig.name ? `<p class="sig-name">${esc(sig.name)}</p>` : ""}
        <p class="sig-date">${esc(L("Date", "التاريخ"))}: ____________________</p>
      </div>`;
  }).join("");

  /* ---------------- watermarks ---------------------------------------------- */
  // Subtle, horizontal, behind the content. Only a staff working copy is ever
  // marked: an approved, published or locked report — and every portal or
  // public copy — carries no draft marking.
  const watermark = t.showWatermark && t.watermarkText
    ? `<div class="watermark" aria-hidden="true"><span>${esc(t.watermarkText)}</span></div>`
    : "";
  const draftMark = m.workingCopy
    ? `<div class="draft-mark" aria-hidden="true"><span>${esc(L("Working copy — not final", "نسخة عمل — غير نهائية"))}</span></div>`
    : "";

  /* ---------------- non-printing toolbar ------------------------------------ */
  const printLabel = esc(L("🖨 Print / Save as PDF", "🖨 طباعة / حفظ PDF"));
  const toolbar = opts.portal || opts.publicCopy
    ? `<div class="noprint toolbar"><div class="tb-left"></div><button type="button" class="print-btn" data-print onclick="window.print()">${printLabel}</button></div>`
    : `<div class="noprint toolbar">
        <div class="tb-left">
          <span class="status-pill status-${esc(d.status)}">${esc(L(STATUS_LABELS[d.status] || d.status.replace("_", " "), d.status.replace("_", " ")))}</span>
          ${m.incomplete ? `<span class="status-pill status-incomplete">${esc(L("Incomplete", "غير مكتمل"))}</span>` : ""}
          ${opts.statusNote ? `<span class="note">${esc(opts.statusNote)}</span>` : ""}
        </div>
        <button type="button" class="print-btn" data-print onclick="window.print()">${printLabel}</button>
      </div>`;

  /* ---------------- per-sheet geometry (inline custom properties) ----------- */
  // Kept on the element (not in the stylesheet) so a bulk document can share
  // one stylesheet while every sheet keeps its own measured density.
  const sheetVars = [
    `--pad:${PAGE_MARGIN_MM}mm`,
    `--sheet-w:${m.page.w}mm`,
    `--sheet-h:${m.page.h}mm`,
    `--inner-h:${m.printableH}mm`,
    `--gap:${tier.gap}mm`,
    `--heading-h:${tier.headingH}mm`,
    `--logo:${tier.logo}mm`,
    `--name-size:${nameSize}px`,
    `--photo-w:${tier.photoW}mm`,
    `--photo-h:${tier.photoH}mm`,
    `--info-row-h:${tier.infoRowH}mm`,
    `--row-h:${tier.rowH}mm`,
    `--row-pad:${tier.rowPad}mm`,
    `--tbl-font:${tier.tableFont}px`,
    `--tbl-head:${tier.headFont}px`,
    `--comment-min:${plan.commentMin}mm`,
    `--sig-space:${plan.sigSpace}mm`,
  ].join(";");

  return `<!DOCTYPE html>
<html lang="${rtl ? "ar" : "en"}" dir="${rtl ? "rtl" : "ltr"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(L("Report Sheet", "بطاقة النتائج"))} — ${esc(d.student.name)}</title>
<style>
  @page { size: A4 ${m.orientation}; margin: 0; }
  :root {
    --brand: ${theme.brand};
    --brand-dark: ${theme.brandDark};
    --brand-soft: ${theme.brandSoft};
    --brand-tint: ${theme.brandTint};
    --brand-line: ${theme.brandLine};
    --accent: ${theme.accent};
    --accent-soft: ${theme.accentSoft};
    --ink: #1a2230;
    --muted: #5b6672;
    --line: #c6cfd6;
    --heading-font: ${theme.headingFont};
    --body-font: "Segoe UI", -apple-system, "Helvetica Neue", Arial, "Noto Naskh Arabic", Tahoma, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e7ebef; }
  body { font-family: var(--body-font); color: var(--ink); padding: 16px 0 30px; }

  /* ---------- screen-only toolbar ---------- */
  .noprint { position: sticky; top: 0; z-index: 50; background: #0f172a; color: #e2e8f0; padding: 10px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; justify-content: space-between; }
  .noprint .tb-left { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0; }
  .noprint .note { font-size: 12px; color: #cbd5e1; }
  .noprint .print-btn { background: var(--brand); color: #fff; border: 0; padding: 8px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .noprint .print-btn:hover { background: var(--brand-dark); }
  .status-pill { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; padding: 3px 10px; border-radius: 999px; background: #475569; color: #fff; }
  .status-published, .status-approved, .status-locked { background: #15803d; }
  .status-draft, .status-returned { background: #b45309; }
  .status-submitted, .status-under_review { background: #1d4ed8; }
  .status-incomplete { background: #b91c1c; }

  /* ---------- the A4 page ---------- */
  .sheet {
    position: relative; background: #fff; margin: 0 auto 16px;
    width: var(--sheet-w); min-height: var(--sheet-h); padding: var(--pad);
    box-shadow: 0 1px 3px rgba(15,23,42,.15), 0 14px 34px rgba(15,23,42,.08);
    /* With @page margin 0 the sheet itself carries the printable margins.
       When a long report flows onto a second page, clone the box padding so
       the continuation page keeps its top/bottom margins too. */
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  .inner {
    position: relative; z-index: 1;
    /* Exactly one printable page; the trailing reserve keeps in-flow content
       clear of the pinned footer (see .foot below). */
    min-height: var(--inner-h);
    padding-bottom: 11mm;
  }

  /* ---------- watermarks (subtle, behind the content) ---------- */
  .watermark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 0; pointer-events: none; }
  .watermark span { font-family: var(--heading-font); font-weight: 700; font-size: 34px; letter-spacing: .3em; text-transform: uppercase; color: var(--brand); opacity: .06; text-align: center; max-width: 86%; line-height: 1.6; }
  .draft-mark { position: absolute; top: 42%; inset-inline: 0; display: flex; justify-content: center; z-index: 0; pointer-events: none; }
  .draft-mark span { font-size: 11px; font-weight: 700; letter-spacing: .42em; text-transform: uppercase; color: #b91c1c; opacity: .34; }

  /* ---------- school header ---------- */
  .masthead { display: flex; align-items: center; gap: 4.5mm; }
  .masthead .logo { width: var(--logo); height: var(--logo); object-fit: contain; flex: none; }
  .logo-fallback { display: flex; align-items: center; justify-content: center; background: var(--brand-soft); color: var(--brand-dark); border: .4mm solid var(--brand-line); font-family: var(--heading-font); font-size: calc(var(--logo) * .5); font-weight: 700; }
  .masthead-id { flex: 1; min-width: 0; }
  .school-name { margin: 0; font-family: var(--heading-font); font-size: var(--name-size); font-weight: 700; color: var(--brand-dark); line-height: 1.16; letter-spacing: .02em; text-transform: uppercase; text-wrap: balance; }
  .school-name .ar { font-size: .8em; letter-spacing: 0; }
  .motto { margin: .8mm 0 0; font-size: 9px; color: var(--muted); letter-spacing: .14em; text-transform: uppercase; line-height: 1.3; }
  .contact { margin: .6mm 0 0; font-size: 8.4px; color: var(--muted); line-height: 1.35; }
  .masthead-rule { margin: 1.3mm 0 2.2mm; }

  /* ---------- report title ---------- */
  .doc-title { margin: 0 0 var(--gap); }
  .doc-title .en { margin: 0; font-family: var(--heading-font); font-weight: 700; text-transform: uppercase; line-height: 1.2; }
  .doc-title .meta { margin: 0; font-size: 9.2px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; line-height: 1.3; }
  .doc-title .meta .sep { display: inline-block; width: 4mm; }

  /* ---------- student information ---------- */
  .student-band { display: grid; grid-template-columns: 1fr auto; gap: 0 4mm; border: .3mm solid var(--brand-line); background: var(--brand-tint); padding: 1.7mm 2.6mm; }
  .student-band.no-photo { grid-template-columns: 1fr; }
  .student-main { min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1.2mm; }
  .student-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 6mm; margin: 0; }
  .student-grid .cell { display: flex; align-items: baseline; gap: 2mm; min-height: var(--info-row-h); border-bottom: .2mm dotted #b9c3cd; padding-top: 1mm; }
  .student-grid dt { min-width: 24mm; flex: none; color: var(--muted); font-size: 8.4px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
  .student-grid dd { margin: 0; flex: 1; min-width: 0; font-size: 10.6px; font-weight: 700; color: var(--ink); overflow-wrap: anywhere; }
  .photo-slot { width: var(--photo-w); height: var(--photo-h); border: .3mm solid #b7c2cc; background: #fff; overflow: hidden; align-self: center; }
  .photo-slot .photo { display: block; width: 100%; height: 100%; object-fit: cover; }
  .photo-slot.photo-empty { display: flex; align-items: center; justify-content: center; background: #f2f5f7; }
  .photo-slot.photo-empty svg { width: 12mm; height: 12mm; fill: #b6c2cd; }

  /* ---------- result status ---------- */
  .status-line { margin: 0; display: flex; align-items: center; gap: 2mm; font-size: 9px; }
  .status-line .k { color: var(--muted); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
  .status-line .v { font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--brand-dark); border: .3mm solid var(--brand-line); background: #fff; padding: .5mm 2.4mm; }
  .status-notice { border: .3mm solid #d9a441; border-inline-start: 1.4mm solid #b45309; background: #fffaf0; padding: 1.2mm 2.4mm; break-inside: avoid; }
  .status-notice .notice-title { margin: 0; font-size: 8.6px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: #92400e; }
  .status-notice .notice-body { margin: .5mm 0 0; font-size: 9.2px; color: #7c4a12; line-height: 1.35; }

  /* ---------- sections ---------- */
  .block { margin-top: var(--gap); }
  .block h2 { margin: 0 0 1.2mm; height: calc(var(--heading-h) - 1.2mm); font-family: var(--heading-font); font-size: 9.6px; font-weight: 700; text-transform: uppercase; letter-spacing: .14em; color: var(--brand-dark); display: flex; align-items: center; gap: 2mm; break-after: avoid; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0 4mm; margin-top: var(--gap); align-items: start; }
  .pair.single { grid-template-columns: 1fr; }
  .pair .block { margin-top: 0; }

  /* ---------- academic performance table ---------- */
  table.results { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: var(--tbl-font); }
  table.results th, table.results td { border: .25mm solid var(--line); padding: var(--row-pad) 1.4mm; text-align: center; line-height: 1.28; }
  table.results tbody td { height: var(--row-h); }
  table.results th { background: var(--brand); color: #fff; font-size: var(--tbl-head); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 1mm .8mm; }
  table.results td.subj, table.results th.subj { text-align: start; padding-inline-start: 2mm; overflow-wrap: anywhere; }
  table.results td.subj .sn { display: inline-block; min-width: 4.4mm; color: var(--muted); font-size: .84em; font-variant-numeric: tabular-nums; }
  table.results td.num { font-variant-numeric: tabular-nums; }
  table.results td.total { font-weight: 700; }
  table.results td.grade { font-weight: 700; color: var(--brand-dark); }
  table.results td.remark { text-align: start; color: #374151; }
  table.results tbody tr:nth-child(even) td { background: var(--brand-tint); }
  table.results thead { display: table-header-group; }
  table.results tr { break-inside: avoid; page-break-inside: avoid; }

  /* ---------- performance summary ---------- */
  table.summary { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.summary th { background: var(--brand-soft); color: var(--brand-dark); border: .25mm solid var(--line); padding: .9mm 1mm; font-size: 7.9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; line-height: 1.2; }
  table.summary td { border: .25mm solid var(--line); padding: 1.1mm 1mm; text-align: center; font-size: 11px; font-weight: 700; color: var(--brand-dark); font-variant-numeric: tabular-nums; }

  /* ---------- grading scale ---------- */
  .legend-wrap { margin-top: 1.5mm; }
  table.legend-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.legend-table th.legend-head { background: var(--brand-soft); color: var(--brand-dark); border: .25mm solid var(--line); padding: .8mm 1.4mm; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; text-align: start; white-space: nowrap; width: 26mm; }
  table.legend-table td { border: .25mm solid var(--line); padding: .8mm 1mm; text-align: center; font-size: 8.2px; color: #374151; background: #fff; overflow-wrap: anywhere; }
  table.legend-table b { color: var(--brand-dark); font-size: 9.2px; margin-inline-end: .7mm; }

  /* ---------- attendance ---------- */
  table.mini { width: 100%; border-collapse: collapse; font-size: 9.6px; }
  table.mini th { background: var(--brand-soft); color: var(--brand-dark); font-size: 7.9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; border: .25mm solid var(--line); padding: .8mm 1mm; line-height: 1.2; }
  table.mini td { border: .25mm solid var(--line); padding: 1mm; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }

  /* ---------- behaviour / conduct ---------- */
  .behaviour { display: grid; grid-template-columns: 1fr 1fr; gap: 0 4mm; }
  .behaviour .beh-cell { display: flex; justify-content: space-between; gap: 2mm; align-items: baseline; font-size: 9.2px; border-bottom: .2mm dotted #b9c3cd; padding: .9mm 0; min-height: 4.6mm; }
  .behaviour .k { color: #374151; min-width: 0; }
  .behaviour .v { font-weight: 700; color: var(--ink); white-space: nowrap; }
  .behaviour .v i { font-style: normal; font-weight: 600; color: var(--muted); font-size: .92em; }

  /* ---------- comments ---------- */
  .comments-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; }
  .comment-box { border: .25mm solid var(--line); min-width: 0; break-inside: avoid; }
  .comment-label { margin: 0; background: var(--brand-soft); color: var(--brand-dark); font-size: 8.2px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; padding: 1mm 2mm; border-bottom: .25mm solid var(--line); }
  .comment-text { margin: 0; padding: 1.6mm 2mm; font-size: 10px; color: var(--ink); min-height: var(--comment-min); line-height: 1.42; overflow-wrap: anywhere; }

  /* ---------- promotion ---------- */
  .promo-strip { margin-top: var(--gap); display: flex; align-items: center; gap: 3mm; flex-wrap: wrap; border: .25mm solid var(--line); padding: 1.2mm 2.6mm; min-height: 8.4mm; }
  .promo-k { font-size: 8.6px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); }
  .promo-badge { font-weight: 700; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; padding: .9mm 3.4mm; }
  .next-term { margin-inline-start: auto; font-size: 9px; color: #374151; }
  .next-term b { color: var(--ink); }

  /* ---------- signatures ---------- */
  .signatures { display: flex; justify-content: space-between; gap: 6mm; margin-top: 3.4mm; break-inside: avoid; }
  .sig { flex: 1; max-width: 72mm; text-align: center; }
  .sig-space { height: var(--sig-space); }
  .sig-rule { border-top: .3mm solid #4b5563; }
  .sig-who { margin: 1mm 0 0; font-size: 9.2px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--ink); }
  .sig-name { margin: .4mm 0 0; font-size: 8.8px; color: var(--muted); }
  .sig-date { margin: .7mm 0 0; font-size: 8.2px; color: var(--muted); letter-spacing: .05em; }

  /* ---------- minimal footer (pinned to the foot of the page) ---------- */
  .foot { position: absolute; bottom: 0; left: 0; right: 0; display: flex; align-items: baseline; justify-content: space-between; gap: 4mm; flex-wrap: wrap; border-top: .5mm solid var(--brand); padding-top: 1.2mm; font-size: 8px; color: #8c96a1; letter-spacing: .08em; line-height: 1.35; }
  .foot .credit { text-transform: uppercase; }
  .foot .ref { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .foot .verified { width: 100%; text-align: center; letter-spacing: 0; color: var(--muted); }

  .empty { font-size: 9.4px; color: var(--muted); margin: 0; font-style: italic; }
${themeCss(theme)}

  /* ---------- layout variants (template option, theme-independent) ---------- */
  .layout-modern .masthead { background: var(--brand-soft); margin: calc(-1 * var(--pad)) calc(-1 * var(--pad)) 0; padding: var(--pad) var(--pad) 2.4mm; }
  .layout-modern .masthead-rule { display: none; }

  /* ---------- printing ---------- */
  @media print {
    html, body { background: #fff; padding: 0; }
    .noprint { display: none !important; }
    .sheet { width: auto; min-height: auto; margin: 0; box-shadow: none; }
    .sheet, .sheet * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    p, td, dd { orphans: 2; widows: 2; }
  }

  /* ---------- small screens: keep the document A4, allow panning ---------- */
  @media screen and (max-width: 840px) {
    body { padding: 0; overflow-x: auto; }
    .sheet { margin: 0; box-shadow: none; }
    .noprint { padding: 8px 10px; }
  }
</style>
</head>
<body>
${toolbar}
<div class="sheet layout-${esc(t.layout)} theme-${esc(theme.key)} d-${esc(plan.density)}" style="${sheetVars}">
  ${watermark}
  ${draftMark}
  <div class="inner">
    ${masthead}
    <div class="masthead-rule" aria-hidden="true"></div>
    ${docTitle}
    ${studentBand}
    ${academicSection}
    ${summarySection}
    ${recordRow}
    ${commentsSection}
    ${promoSection}
    ${signatures ? `<div class="signatures">${signatures}</div>` : ""}
    <footer class="foot">
      ${m.footerBits.length ? `<span class="credit">${esc(m.footerBits[0])}</span>` : ""}
      ${m.footerBits.length > 1 ? `<span class="ref">${esc(m.footerBits[1])}</span>` : ""}
      ${m.verifiedLine ? `<span class="verified">${esc(m.verifiedLine)}</span>` : ""}
    </footer>
  </div>
</div>
<script src="/js/report-sheet-viewer.js" defer></script>
</body>
</html>`;
}

/** One document containing every sheet, one per printed page. */
function renderBulkReportSheets(sheets, opts = {}) {
  if (!sheets.length) return "";
  const documents = sheets.map((sheet) => renderReportSheetHTML(sheet, Object.assign({}, opts, { statusNote: undefined })));
  const style = (documents[0].match(/<style>[\s\S]*?<\/style>/) || ["<style></style>"])[0]
    .replace("</style>", "\n  .bulk-page { break-after: page; page-break-after: always; }\n  .bulk-page:last-child { break-after: auto; page-break-after: auto; }\n</style>");
  // Each sheet keeps its own direction: an Arabic-named student's sheet is
  // extracted with dir="rtl" so the combined document lays out correctly.
  // Per-sheet geometry travels with the sheet element's inline custom
  // properties, so one shared stylesheet serves every page. The per-document
  // viewer <script> is stripped (one copy is added below).
  const bodies = sheets.map((sheet, i) => {
    const doc = documents[i];
    const start = doc.indexOf('<div class="sheet');
    const end = doc.lastIndexOf("</body>");
    const dir = String(sheet.student && sheet.student.nameAr || "") ? "rtl" : "ltr";
    return `<section class="bulk-page" dir="${dir}">${doc.slice(start, end).replace(/<script[\s\S]*?<\/script>/g, "")}</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Report sheets — batch</title>${style}</head>
<body><div class="noprint toolbar"><div class="tb-left"><span class="note">${sheets.length} report sheet(s)</span></div><button type="button" class="print-btn" data-print onclick="window.print()">🖨 Print / Save all as PDF</button></div>
${bodies}
<script src="/js/report-sheet-viewer.js" defer></script>
</body></html>`;
}
/* --------------------------- template preview ---------------------------- */

/**
 * A realistic sample sheet so an administrator can see a template before
 * saving it. No institution's real student data is used, so a preview can
 * never leak another tenant's records.
 *
 * `category` is optional and presentation-only: passing the viewing tenant's
 * existing institution category makes the preview show the theme (Islamic or
 * Western) that this school's real report sheets will use. The sample
 * subjects stay neutral in both themes.
 */
function sampleReportSheet(template, config, category) {
  const cfg = config || {
    caMax: 40, examMax: 60, passMark: 50,
    bands: grading.DEFAULT_BANDS.slice(),
  };
  const t = normaliseTemplate(JSON.stringify(template));
  const cat = institution.normalizeCategory(category, "");
  // Sample subjects follow the institution category so a Western preview
  // never shows Islamic terminology (and vice versa).
  const subjNames = [
    ["Mathematics", "الرياضيات"], ["English Language", "اللغة الإنجليزية"], ["Basic Science", "العلوم"],
    ["Social Studies", "الدراسات الاجتماعية"],
  ].concat(cat === "western"
    ? [["Computer Studies", "الحاسوب"], ["Physical Education", "التربية البدنية"]]
    : [["Islamic Studies", "الدراسات الإسلامية"], ["Arabic", "اللغة العربية"]]);
  const subjects = subjNames.map(([en, ar], i) => {
    const sc = grading.subjectScore(cfg, 30 + i, 45 + (i % 3) * 4);
    return { subjectId: i + 1, nameEn: en, nameAr: ar, ca: sc.ca, exam: sc.exam, total: sc.total, pct: sc.pct, grade: sc.grade, gradePoint: sc.gradePoint, remark: sc.remark, remarkAr: sc.remarkAr, status: "approved", pass: sc.pass };
  });
  const average = Math.round((subjects.reduce((sum, s) => sum + s.pct, 0) / subjects.length) * 10) / 10;
  const overall = grading.gradeForPct(cfg, average);
  const ratings = {};
  for (const cat of t.behaviourCategories) ratings[cat.key] = 5 - (Object.keys(ratings).length % 3);
  return {
    template: t,
    madrasa: {
      nameEn: "Sample International Academy", nameAr: "أكاديمية النموذج الدولية", logoPath: "",
      mottoEn: "Knowledge · Character · Service", mottoAr: "العلم · الخلق · الخدمة",
      address: "1 Sample Avenue", city: "Ijebu-Ode", stateName: "Ogun", phone: "+234 800 000 0000",
      email: "info@example.edu", website: "www.example.edu",
      category: cat, institutionType: "",
    },
    student: {
      id: 0, studentCode: "SAMPLE-0001", name: "Aisha Adebayo Example", nameAr: "عائشة أديبايو — نموذج",
      admissionNo: "SAMPLE-0001", photoPath: "", gender: "F", dateOfBirth: "2013-06-15",
      section: "A", program: "General", classId: null, classEn: "Primary 5", classAr: "الابتدائية ٥",
    },
    session: "2026/2027",
    term: { nameEn: "First Term", nameAr: "الفترة الأولى", position: 1, startDate: "2026-09-01", endDate: "2026-12-18" },
    subjects,
    config: cfg,
    summary: {
      total: subjects.reduce((sum, s) => sum + s.total, 0), subjectCount: subjects.length,
      average, overallGrade: overall.grade, overallRemark: overall.remark, overallRemarkAr: overall.remarkAr,
      position: 3, classSize: 28, teacherComment: "A consistently hard-working and courteous learner. Keep it up.",
      headComment: "An excellent term's work. Promoted with merit.",
      promotionStatus: "promoted", publishedAt: new Date().toISOString().slice(0, 10),
    },
    attendance: { present: 92, absent: 3, late: 2, excused: 1, total: 98, percentage: 94 },
    behaviour: { categories: t.behaviourCategories, ratings },
    classPerformance: { size: 28, average: 71.4, highest: 96, lowest: 42 },
    nextTerm: { nameEn: "Second Term", nameAr: "الفترة الثانية", begins: "2027-01-08", ends: "2027-04-02" },
    completeness: { complete: true, missingSubjects: [], pendingSubjects: [] },
    status: "published",
    reference: "EDU-2026/2027-PRIMARY5-SAMPLE0001",
  };
}

module.exports = {
  DEFAULT_TEMPLATE,
  RESULT_COLUMNS,
  getReportTemplate,
  saveReportTemplate,
  normaliseTemplate,
  buildReportReference,
  buildReportSheet,
  buildClassReportSheets,
  classCompleteness,
  classPerformanceFrom,
  attendanceBreakdown,
  nextTermInfo,
  deriveReportStatus,
  renderReportSheetHTML,
  renderBulkReportSheets,
  planReportSheet,
  sampleReportSheet,
};
