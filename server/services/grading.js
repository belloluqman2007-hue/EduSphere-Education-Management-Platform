"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — grading engine
   ----------------------------------------------------------------------------
   Per-madrasa configurable grading, preserving the useful result features of
   the original system (CA + Examination + Total + Average + Grade + Remark +
   Position + Promotion) while making EVERY threshold tenant-configurable.

   Model:
     • Each subject result: CA (default max 40) + Exam (default max 60).
     • total = ca + exam, on a scale of ca_max + exam_max (default 100).
     • Grade bands are percentage-based (0–100) — configured per madrasa.
     • Pass: subject percentage >= pass_mark (default 50%).
     • Average: mean of subject percentages.
     • Position: competition ranking (1,2,2,4) by average within the class+term.
     • Promotion: average >= promotion_min_average AND all subjects passed
       (if promotion_require_pass) — status: promoted / repeating / pending.
   ========================================================================== */
const db = require("../db");

const DEFAULT_BANDS = [
  { min: 75, grade: "A", point: 5, remark: "Excellent", remark_ar: "ممتاز" },
  { min: 65, grade: "B", point: 4, remark: "Very Good", remark_ar: "جيد جداً" },
  { min: 55, grade: "C", point: 3, remark: "Good", remark_ar: "جيد" },
  { min: 45, grade: "D", point: 2, remark: "Fair", remark_ar: "مقبول" },
  { min: 40, grade: "E", point: 1, remark: "Weak", remark_ar: "ضعيف" },
  { min: 0, grade: "F", point: 0, remark: "Fail", remark_ar: "راسب" },
];

async function getGradingConfig(madrasaId) {
  let row = await db.get("SELECT * FROM grading_config WHERE madrasa_id = ?", [madrasaId]);
  if (!row) {
    // Lazily create the default config. This is a check-then-act race: two
    // concurrent requests for a madrasa with no config both see !row and both
    // insert, and the loser hits the UNIQUE key on madrasa_id (ER_DUP_ENTRY on
    // MySQL, SQLITE_CONSTRAINT on SQLite) — observed as a 500 under load.
    // insertIgnore makes the write idempotent, and we re-read the row so the
    // winner's values are used rather than assumed defaults.
    await db.insertIgnore(
      "grading_config",
      "madrasa_id, ca_max, exam_max, pass_mark, promotion_min_average, promotion_require_pass, grade_bands",
      [madrasaId, 40, 60, 50, 50, 1, JSON.stringify(DEFAULT_BANDS)]
    );
    row = await db.get("SELECT * FROM grading_config WHERE madrasa_id = ?", [madrasaId]);
    if (!row) {
      // Should be unreachable; fall back to in-memory defaults rather than
      // throwing, so report rendering degrades gracefully.
      row = {
        id: null,
        madrasa_id: madrasaId,
        ca_max: 40,
        exam_max: 60,
        pass_mark: 50,
        promotion_min_average: 50,
        promotion_require_pass: 1,
        grade_bands: JSON.stringify(DEFAULT_BANDS),
      };
    }
  }
  let bands;
  try { bands = JSON.parse(row.grade_bands || "[]"); } catch (e) { bands = DEFAULT_BANDS; }
  if (!Array.isArray(bands) || !bands.length) bands = DEFAULT_BANDS;
  bands = bands
    .slice()
    .sort((a, b) => Number(b.min) - Number(a.min))
    .map((b, index, all) => ({
      min: Number(b.min) || 0,
      grade: String(b.grade || "F"),
      point: Number.isFinite(Number(b.point)) ? Number(b.point) : Math.max(0, all.length - index - 1),
      remark: b.remark || "",
      remark_ar: b.remark_ar || "",
    }));
  return {
    caMax: Number(row.ca_max) || 40,
    examMax: Number(row.exam_max) || 60,
    passMark: Number(row.pass_mark) || 50, // percent of totalMax
    promotionMinAverage: row.promotion_min_average == null ? null : Number(row.promotion_min_average),
    promotionRequirePass: Number(row.promotion_require_pass) === 1,
    bands,
  };
}

function totalMaxOf(cfg) {
  return cfg.caMax + cfg.examMax;
}

/** Percentage of the scale that a raw total represents. */
function pctOf(cfg, total) {
  const m = totalMaxOf(cfg);
  if (m <= 0) return 0;
  return Math.max(0, Math.min(100, (Number(total) / m) * 100));
}

/** Grade + remark for a percentage, using the madrasa's bands. */
function gradeForPct(cfg, pct) {
  for (const b of cfg.bands) {
    if (pct >= b.min) return { grade: b.grade, point: Number(b.point || 0), remark: b.remark, remarkAr: b.remark_ar };
  }
  const last = cfg.bands[cfg.bands.length - 1];
  return { grade: last.grade, point: Number(last.point || 0), remark: last.remark, remarkAr: last.remark_ar };
}

function gradePointForPct(cfg, pct) {
  return gradeForPct(cfg, pct).point;
}

function subjectScore(cfg, ca, exam) {
  const caN = Math.max(0, Math.min(cfg.caMax, Number(ca) || 0));
  const examN = Math.max(0, Math.min(cfg.examMax, Number(exam) || 0));
  const total = Math.round((caN + examN) * 100) / 100;
  const pct = pctOf(cfg, total);
  const g = gradeForPct(cfg, pct);
  return { ca: caN, exam: examN, total, pct: Math.round(pct * 10) / 10, grade: g.grade, gradePoint: g.point, remark: g.remark, remarkAr: g.remarkAr, pass: pct >= cfg.passMark };
}

/**
 * Computes (and persists) term summaries for every student with results in a
 * class + term. Idempotent: safe to run repeatedly; existing rows are
 * refreshed, positions are assigned after all students are scored.
 */
async function computeClassTerm(madrasaId, classId, termId, userId = null) {
  const cfg = await getGradingConfig(madrasaId);
  const term = await db.get("SELECT * FROM terms WHERE id = ? AND madrasa_id = ?", [termId, madrasaId]);
  if (!term) throw new Error("Term not found");
  const session = await db.get("SELECT * FROM academic_sessions WHERE id = ?", [term.session_id]);

  const rows = await db.all(
    `SELECT s.id AS student_id, s.admission_no, s.first_name, s.last_name, s.name_ar,
            r.subject_id, r.ca, r.exam
     FROM results r
     JOIN students s ON s.id = r.student_id
     WHERE r.madrasa_id = ? AND r.term_id = ? AND r.class_id = ?
       AND r.status IN ('approved','published')`,
    [madrasaId, termId, classId]
  );

  // Group by student
  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, { admission_no: r.admission_no, first_name: r.first_name, last_name: r.last_name, name_ar: r.name_ar, subjects: [] });
    byStudent.get(r.student_id).subjects.push({ subject_id: Number(r.subject_id), ca: r.ca, exam: r.exam });
  }

  const scores = [];
  for (const [studentId, data] of byStudent) {
    let total = 0;
    let pctSum = 0;
    let allPass = true;
    const subjects = data.subjects.map((s) => {
      const sc = subjectScore(cfg, s.ca, s.exam);
      total += sc.total;
      pctSum += sc.pct;
      if (!sc.pass) allPass = false;
      return Object.assign({ subjectId: s.subject_id }, sc);
    });
    const count = subjects.length || 1;
    const average = Math.round((pctSum / count) * 10) / 10;
    const overall = gradeForPct(cfg, average);

    // Attendance for this term
    const att = await db.get(
      `SELECT COUNT(*) AS total_days,
              SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_days,
              SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late_days
         FROM attendance WHERE madrasa_id = ? AND student_id = ? AND term_id = ?`,
      [madrasaId, studentId, termId]
    );
    const attendanceTotal = Number(att ? att.total_days : 0);
    const attendanceDays = Number(att ? att.present_days : 0) + Number(att ? att.late_days : 0);
    const attendancePercentage = attendanceTotal ? Math.round((Number(att.present_days || 0) / attendanceTotal) * 10000) / 100 : 0;

    // Promotion
    let promotionStatus = "promoted";
    if (cfg.promotionRequirePass && !allPass) promotionStatus = "repeating";
    if (cfg.promotionMinAverage != null && average < Number(cfg.promotionMinAverage)) promotionStatus = "repeating";

    scores.push({
      studentId: Number(studentId),
      admissionNo: data.admission_no,
      total: Math.round(total * 100) / 100,
      average,
      overallGrade: overall.grade,
      overallRemark: overall.remark,
      overallRemarkAr: overall.remark_ar,
      subjectCount: subjects.length,
      attendanceDays,
      attendanceTotal,
      attendancePercentage,
      promotionStatus,
      subjects,
    });
  }

  // Positions (competition ranking) by average desc
  const ordered = scores.slice().sort((a, b) => b.average - a.average || b.total - a.total);
  let rank = 0;
  let prevAvg = null;
  ordered.forEach((s, i) => {
    if (prevAvg !== null && s.average === prevAvg) s.position = rank;
    else { rank = i + 1; s.position = rank; }
    prevAvg = s.average;
  });

  // Persist summaries (upsert)
  const byId = new Map(scores.map((s) => [s.studentId, s]));
  for (const s of ordered) {
    const existing = await db.get(
      "SELECT id, teacher_comment, head_comment, published_at FROM term_summaries WHERE madrasa_id = ? AND student_id = ? AND term_id = ?",
      [madrasaId, s.studentId, termId]
    );
    if (existing) {
      await db.run(
        `UPDATE term_summaries
         SET class_id = ?, session_id = ?, subject_count = ?, total = ?, average = ?, overall_grade = ?,
             position = ?, attendance_days = ?, attendance_total = ?, attendance_percentage = ?, promotion_status = ?
         WHERE id = ?`,
        [classId, term.session_id, s.subjectCount, s.total, s.average, s.overallGrade, s.position, s.attendanceDays, s.attendanceTotal, s.attendancePercentage, s.promotionStatus, existing.id]
      );
    } else {
      await db.run(
        `INSERT INTO term_summaries (madrasa_id, student_id, class_id, session_id, term_id, subject_count, total, average, overall_grade, position, attendance_days, attendance_total, attendance_percentage, promotion_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [madrasaId, s.studentId, classId, term.session_id, termId, s.subjectCount, s.total, s.average, s.overallGrade, s.position, s.attendanceDays, s.attendanceTotal, s.attendancePercentage, s.promotionStatus]
      );
    }
  }

  return {
    term: { id: term.id, name_en: term.name_en, name_ar: term.name_ar, position: term.position },
    session: session ? session.label : "",
    classId,
    config: { caMax: cfg.caMax, examMax: cfg.examMax, passMark: cfg.passMark },
    students: ordered,
  };
}

/** Full report-card dataset for one student + term. */
async function reportCardData(madrasaId, studentId, termId) {
  const cfg = await getGradingConfig(madrasaId);
  const student = await db.get("SELECT * FROM students WHERE id = ? AND madrasa_id = ?", [studentId, madrasaId]);
  if (!student) return null;
  const term = await db.get("SELECT * FROM terms WHERE id = ? AND madrasa_id = ?", [termId, madrasaId]);
  if (!term) return null;
  const session = await db.get("SELECT * FROM academic_sessions WHERE id = ?", [term.session_id]);
  const madrasa = await db.get("SELECT * FROM madaris WHERE id = ?", [madrasaId]);
  const classRow = student.class_id ? await db.get("SELECT * FROM classes WHERE id = ? AND madrasa_id = ?", [student.class_id, madrasaId]) : null;
  const summary = await db.get("SELECT * FROM term_summaries WHERE madrasa_id = ? AND student_id = ? AND term_id = ?", [madrasaId, studentId, termId]);
  const results = await db.all(
    `SELECT r.subject_id, r.ca, r.exam, r.total, r.grade, r.grade_point, r.teacher_remark, r.status,
            su.name_en, su.name_ar
     FROM results r JOIN subjects su ON su.id = r.subject_id
     WHERE r.madrasa_id = ? AND r.student_id = ? AND r.term_id = ?
       AND r.status IN ('approved','published')
     ORDER BY su.name_en`,
    [madrasaId, studentId, termId]
  );

  const subjects = results.map((r) => {
    const sc = subjectScore(cfg, r.ca, r.exam);
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

  return {
    madrasa: {
      nameEn: madrasa.name_en,
      nameAr: madrasa.name_ar,
      logoPath: madrasa.logo_path,
      mottoEn: madrasa.motto_en,
      mottoAr: madrasa.motto_ar,
      address: madrasa.address,
      city: madrasa.city,
      stateName: madrasa.state_name,
      phone: madrasa.phone,
      // Presentation only: lets the report renderer pick the institution's
      // existing category theme. No calculation reads these.
      brandColor: madrasa.brand_color || "",
      category: madrasa.category || "",
      institutionType: madrasa.institution_type || "",
    },
    student: {
      id: Number(student.id),
      studentCode: student.student_code || student.admission_no,
      name: `${student.first_name} ${student.last_name}`.trim(),
      nameAr: student.name_ar,
      admissionNo: student.admission_no,
      photoPath: student.photo_path || "",
      gender: student.gender,
      classId: student.class_id ? Number(student.class_id) : null,
      classEn: classRow ? classRow.name_en : "",
      classAr: classRow ? classRow.name_ar : "",
    },
    session: session ? session.label : "",
    term: { nameEn: term.name_en, nameAr: term.name_ar, position: term.position, startDate: term.start_date, endDate: term.end_date },
    subjects,
    config: { caMax: cfg.caMax, examMax: cfg.examMax, passMark: cfg.passMark },
    summary: summary
      ? {
          total: Number(summary.total),
          average: Number(summary.average),
          overallGrade: summary.overall_grade,
          position: summary.position,
          attendanceDays: Number(summary.attendance_days),
          attendanceTotal: Number(summary.attendance_total || 0),
          attendancePercentage: Number(summary.attendance_percentage || 0),
          teacherComment: summary.teacher_comment,
          headComment: summary.head_comment,
          promotionStatus: summary.promotion_status,
          publishedAt: summary.published_at,
        }
      : { total: 0, average: 0, overallGrade: "", position: null, attendanceDays: 0, attendanceTotal: 0, attendancePercentage: 0, teacherComment: "", headComment: "", promotionStatus: "pending" },
  };
}

module.exports = {
  DEFAULT_BANDS,
  getGradingConfig,
  totalMaxOf,
  pctOf,
  gradeForPct,
  gradePointForPct,
  subjectScore,
  computeClassTerm,
  reportCardData,
};
