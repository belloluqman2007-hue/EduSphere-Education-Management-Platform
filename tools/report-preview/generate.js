"use strict";
/* ============================================================================
   Report-sheet static preview generator
   ----------------------------------------------------------------------------
   Regenerates the two committed static previews straight from the real report
   engine (server/services/report-sheet.js), so the checked-in HTML always
   matches the shipping renderer:

     • report-sheet-preview.html  — Islamic theme (forest green + gold, RTL,
       12 subjects incl. Qur'an/Islamic studies)
     • report-template-sample.html — Western theme (navy + slate, LTR, 12
       subjects)

   Presentation only: every figure is produced by services/grading.js through
   the shared engine. No database is required.

   Run:  node tools/report-preview/generate.js
   ========================================================================== */
process.env.NODE_ENV = process.env.NODE_ENV || "development";
const fs = require("fs");
const path = require("path");
const reportSheet = require("../../server/services/report-sheet");
const grading = require("../../server/services/grading");

const CFG = { caMax: 40, examMax: 60, passMark: 50, bands: grading.DEFAULT_BANDS.slice() };

/** Build a subject row through the real scorer so totals/%/grade are genuine. */
function subject(id, en, ar, ca, exam) {
  const sc = grading.subjectScore(CFG, ca, exam);
  return { subjectId: id, nameEn: en, nameAr: ar, ca: sc.ca, exam: sc.exam, total: sc.total, pct: sc.pct, grade: sc.grade, gradePoint: sc.gradePoint, remark: sc.remark, remarkAr: sc.remarkAr, status: "published", pass: sc.pass };
}

function summarise(subjects, extra) {
  const total = Math.round(subjects.reduce((a, s) => a + s.total, 0) * 100) / 100;
  const average = Math.round((subjects.reduce((a, s) => a + s.pct, 0) / subjects.length) * 10) / 10;
  const overall = grading.gradeForPct(CFG, average);
  return Object.assign({
    total, subjectCount: subjects.length, average, overallGrade: overall.grade,
    overallRemark: overall.remark, overallRemarkAr: overall.remarkAr,
    position: 3, classSize: 32, publishedAt: "2026-12-18",
  }, extra);
}

const template = reportSheet.normaliseTemplate(null);

/* --------------------------------- Islamic -------------------------------- */
const islamicSubjects = [
  subject(1, "Qur'an & Tajwid", "القرآن والتجويد", 37, 55),
  subject(2, "Hifz (Memorisation)", "الحفظ", 38, 57),
  subject(3, "Arabic Language", "اللغة العربية", 34, 50),
  subject(4, "Islamic Studies", "الدراسات الإسلامية", 33, 52),
  subject(5, "Fiqh", "الفقه", 31, 49),
  subject(6, "Hadith", "الحديث", 30, 47),
  subject(7, "Mathematics", "الرياضيات", 32, 48),
  subject(8, "English Language", "اللغة الإنجليزية", 29, 44),
  subject(9, "Basic Science", "العلوم", 28, 43),
  subject(10, "Social Studies", "الدراسات الاجتماعية", 30, 46),
  subject(11, "Civic Education", "التربية المدنية", 33, 50),
  subject(12, "Computer Studies", "الحاسوب", 31, 47),
];
const islamic = {
  template,
  madrasa: {
    nameEn: "Al-Huda College of Knowledge", nameAr: "كلية الهدى للعلوم", logoPath: "",
    mottoEn: "Knowledge · Faith · Good Character", mottoAr: "العلم · الإيمان · حسن الخلق",
    address: "12 Molipa Road", city: "Ijebu-Ode", stateName: "Ogun",
    phone: "+234 803 000 1122", email: "info@alhuda.edu.ng", website: "www.alhuda.edu.ng",
    category: "islamic", institutionType: "",
  },
  student: {
    id: 0, studentCode: "AHK/2026/041", name: "Aisha Ibrahim", nameAr: "عائشة إبراهيم",
    admissionNo: "AHK/2026/041", photoPath: "", gender: "F", dateOfBirth: "2013-04-09",
    section: "A", program: "General", classId: null, classEn: "JSS 1", classAr: "الأولى إعدادي",
  },
  session: "2026/2027",
  term: { nameEn: "First Term", nameAr: "الفصل الأول", position: 1, startDate: "2026-09-14", endDate: "2026-12-18" },
  subjects: islamicSubjects,
  config: CFG,
  summary: summarise(islamicSubjects, {
    teacherComment: "Aisha is diligent, courteous and consistent in her Qur'an revision. A pleasure to teach.",
    headComment: "An excellent term's work. Promoted to the next class with merit.",
    promotionStatus: "promoted",
  }),
  attendance: { present: 118, absent: 3, late: 2, excused: 1, total: 124, percentage: 95.2 },
  behaviour: {
    categories: template.behaviourCategories,
    ratings: { punctuality: 5, neatness: 4, discipline: 5, participation: 4, cooperation: 5, respect: 5, conduct: 5 },
  },
  classPerformance: { size: 32, average: 68.4, highest: 94, lowest: 41 },
  nextTerm: { nameEn: "Second Term", nameAr: "الفصل الثاني", begins: "2027-01-11", ends: "2027-04-09" },
  completeness: { complete: true, missingSubjects: [], pendingSubjects: [] },
  status: "published",
  reference: "EDU-20262027-JSS1-AHK2026041",
};

/* --------------------------------- Western -------------------------------- */
const westernSubjects = [
  subject(1, "Mathematics", "", 36, 54),
  subject(2, "English Language", "", 34, 51),
  subject(3, "Combined Science", "", 33, 49),
  subject(4, "Social Studies", "", 31, 47),
  subject(5, "Computer Science", "", 35, 53),
  subject(6, "Geography", "", 30, 45),
  subject(7, "History", "", 29, 44),
  subject(8, "French", "", 28, 43),
  subject(9, "Physical Education", "", 34, 50),
  subject(10, "Visual Arts", "", 32, 48),
  subject(11, "Music", "", 31, 46),
  subject(12, "Business Studies", "", 33, 49),
];
const western = {
  template,
  madrasa: {
    nameEn: "Riverside International Academy", nameAr: "", logoPath: "",
    mottoEn: "Learn · Grow · Succeed", mottoAr: "",
    address: "5 Lakeview Avenue", city: "Lekki", stateName: "Lagos",
    phone: "+234 809 445 6677", email: "admin@riverside.edu.ng", website: "www.riverside.edu.ng",
    category: "western", institutionType: "Academy",
  },
  student: {
    id: 0, studentCode: "RIA-1042", name: "Jordan Adeyemi", nameAr: "",
    admissionNo: "RIA-1042", photoPath: "", gender: "M", dateOfBirth: "2013-07-22",
    section: "Blue", program: "General", classId: null, classEn: "Year 7", classAr: "",
  },
  session: "2026/2027",
  term: { nameEn: "Autumn Term", nameAr: "", position: 1, startDate: "2026-09-07", endDate: "2026-12-11" },
  subjects: westernSubjects,
  config: CFG,
  summary: summarise(westernSubjects, {
    teacherComment: "Jordan has settled in well and contributes thoughtfully in class. A strong, well-rounded term.",
    headComment: "A very good start to the year. Promoted to the next year group.",
    promotionStatus: "promoted",
  }),
  attendance: { present: 121, absent: 2, late: 1, excused: 0, total: 124, percentage: 97.6 },
  behaviour: {
    categories: template.behaviourCategories,
    ratings: { punctuality: 5, neatness: 5, discipline: 4, participation: 5, cooperation: 4, respect: 5, conduct: 5 },
  },
  classPerformance: { size: 30, average: 71.8, highest: 96, lowest: 48 },
  nextTerm: { nameEn: "Spring Term", nameAr: "", begins: "2027-01-06", ends: "2027-03-27" },
  completeness: { complete: true, missingSubjects: [], pendingSubjects: [] },
  status: "published",
  reference: "EDU-20262027-YEAR7-RIA1042",
};

const outIslamic = path.join(__dirname, "..", "..", "report-sheet-preview.html");
const outWestern = path.join(__dirname, "..", "..", "report-template-sample.html");
fs.writeFileSync(outIslamic, reportSheet.renderReportSheetHTML(islamic, { portal: true }));
fs.writeFileSync(outWestern, reportSheet.renderReportSheetHTML(western, { portal: true }));

const planI = reportSheet.planReportSheet(islamic);
const planW = reportSheet.planReportSheet(western);
console.log(`Islamic  → ${path.basename(outIslamic)}  (${islamic.subjects.length} subjects, ${planI.density}, ${planI.heightMm}mm of ${planI.printableHeightMm}mm, ${planI.pages} page${planI.pages > 1 ? "s" : ""})`);
console.log(`Western  → ${path.basename(outWestern)}  (${western.subjects.length} subjects, ${planW.density}, ${planW.heightMm}mm of ${planW.printableHeightMm}mm, ${planW.pages} page${planW.pages > 1 ? "s" : ""})`);
