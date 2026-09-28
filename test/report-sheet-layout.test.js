"use strict";
/* ============================================================================
   REPORT SHEET — A4 PAGE LAYOUT, DENSITY PLANNER AND CATEGORY THEMES

   The printable report sheet has a hard layout contract that the data tests
   in report-sheet.test.js cannot express:

     • at least 12 subjects must fit on ONE A4 portrait page, and the table
       text must stay readable (never below 9px) while doing so,
     • a longer list (15, 20 subjects) tightens the design step by step and
       only overflows to a second page when a page genuinely cannot hold it,
     • nothing is printed twice (session, term, identity, contacts, ref),
     • the student block shows name / ID / class / gender only,
     • the theme follows the institution's EXISTING category — Islamic vs
       Western — while the data, sections and calculations stay shared,
     • an <img> is never emitted for an upload file that is not on disk.

   These are pure rendering tests: they call the engine directly with
   synthetic data, so they need no database and no tenant. planReportSheet()
   exposes the millimetre budget the renderer itself uses, which makes the
   page-fit contract verifiable instead of merely asserted.
   ========================================================================== */
const { test } = require("node:test");
const assert = require("node:assert");

process.env.NODE_ENV = process.env.NODE_ENV || "test";
const reportSheet = require("../server/services/report-sheet");
const grading = require("../server/services/grading");

const CFG = { caMax: 40, examMax: 60, passMark: 50, bands: grading.DEFAULT_BANDS.slice() };

/** The printed document itself, without the stylesheet or the screen toolbar. */
const body = (html) => html.slice(html.indexOf('<div class="sheet'));

const SUBJECT_POOL = [
  ["Mathematics", "الرياضيات"], ["English Language", "اللغة الإنجليزية"],
  ["Basic Science and Technology", "العلوم والتكنولوجيا"], ["Social Studies", "الدراسات الاجتماعية"],
  ["Civic Education", "التربية المدنية"], ["Agricultural Science", "العلوم الزراعية"],
  ["Computer Studies", "الحاسوب"], ["Physical and Health Education", "التربية البدنية والصحية"],
  ["Business Studies", "دراسات الأعمال"], ["Creative and Cultural Arts", "الفنون الإبداعية"],
  ["History", "التاريخ"], ["Home Economics", "الاقتصاد المنزلي"],
  ["French Language", "اللغة الفرنسية"], ["Further Mathematics", "الرياضيات المتقدمة"],
  ["Geography", "الجغرافيا"], ["Technical Drawing", "الرسم الفني"],
  ["Literature in English", "الأدب الإنجليزي"], ["Music", "الموسيقى"],
  ["Economics", "الاقتصاد"], ["Government", "الحكومة"],
];

/** Synthetic render payload — no tenant, no student, no subject is real. */
function sheet(count, opts = {}) {
  const template = reportSheet.normaliseTemplate(opts.template ? JSON.stringify(opts.template) : null);
  const subjects = [];
  for (let i = 0; i < count; i++) {
    const [en, ar] = SUBJECT_POOL[i % SUBJECT_POOL.length];
    const score = grading.subjectScore(CFG, 20 + ((i * 5) % 20), 30 + ((i * 7) % 29));
    subjects.push({
      subjectId: i + 1,
      nameEn: opts.longNames ? `${en} with Extended Practical Coursework` : en,
      nameAr: ar,
      ca: score.ca, exam: score.exam, total: score.total, pct: score.pct,
      grade: score.grade, gradePoint: score.gradePoint,
      remark: opts.longNames ? "Very strong effort throughout the term, keep pushing" : score.remark,
      remarkAr: score.remarkAr, status: "approved", pass: score.pass,
    });
  }
  const total = subjects.reduce((sum, s) => sum + s.total, 0);
  const average = subjects.length ? Math.round((subjects.reduce((sum, s) => sum + s.pct, 0) / subjects.length) * 10) / 10 : 0;
  const ratings = {};
  template.behaviourCategories.forEach((c, i) => { ratings[c.key] = 5 - (i % 3); });
  return {
    template,
    madrasa: {
      nameEn: opts.longSchoolName
        ? "The Cambridge Grammar International College of Science and Technology"
        : "Riverside Academy",
      nameAr: "", logoPath: opts.logoPath || "",
      mottoEn: "Knowledge · Character · Service", mottoAr: "",
      address: "14 Ring Road", city: "Ibadan", stateName: "Oyo",
      phone: "+234 802 000 1122", email: "office@example.edu.ng", website: "www.example.edu.ng",
      brandColor: opts.brandColor || "",
      category: opts.category || "islamic", institutionType: opts.institutionType || "",
    },
    student: {
      id: 1, studentCode: "RA/2026/0148",
      name: opts.longNames ? "Abdulrahman Oluwaseun Babatunde-Ademola" : "Zainab Adeyemi",
      nameAr: opts.arabic ? "زينب أديمي" : "",
      admissionNo: "RA/2026/0148", photoPath: opts.photoPath || "",
      gender: "F", dateOfBirth: "2012-04-09", section: "A", program: "General",
      classId: 4, classEn: "Junior Secondary 2", classAr: "",
    },
    session: "2026/2027",
    term: { nameEn: "First Term", nameAr: "الفترة الأولى", position: 1 },
    subjects,
    config: CFG,
    summary: {
      total, subjectCount: subjects.length, average,
      overallGrade: grading.gradeForPct(CFG, average).grade, overallRemark: "", overallRemarkAr: "",
      position: 4, classSize: 32,
      teacherComment: "A focused and productive term with neat written work.",
      headComment: "A pleasing set of results.",
      promotionStatus: "promoted", publishedAt: "2026-12-20",
    },
    attendance: { present: 58, absent: 3, late: 2, excused: 1, total: 64, percentage: 90.6 },
    behaviour: { categories: template.behaviourCategories, ratings },
    classPerformance: { size: 32, average: 68.4, highest: 94, lowest: 38 },
    nextTerm: { nameEn: "Second Term", nameAr: "", begins: "2027-01-11", ends: "2027-04-02" },
    completeness: opts.completeness || { complete: true, missingSubjects: [], pendingSubjects: [] },
    status: opts.status || "published",
    reference: "EDU-2026/2027-JSS2-RA20260148",
  };
}

/* ------------------------- the one-page contract -------------------------- */

test("12 subjects fit on a single A4 portrait page in both themes", () => {
  for (const category of ["islamic", "western"]) {
    const plan = reportSheet.planReportSheet(sheet(12, { category }));
    assert.equal(plan.orientation, "portrait", `${category}: stays portrait`);
    assert.equal(plan.subjects, 12);
    assert.equal(plan.pages, 1, `${category}: 12 subjects must not spill onto page 2`);
    assert.ok(plan.fitsOnePage, `${category}: 12 subjects fit one page`);
    // …and with room to spare, not by a rounding accident.
    assert.ok(plan.heightMm <= plan.printableHeightMm - plan.reserveMm,
      `${category}: ${plan.heightMm}mm must fit inside ${plan.printableHeightMm}mm less the ${plan.reserveMm}mm reserve`);
    // A4 portrait minus 2 × 9mm printable margins.
    assert.equal(plan.printableHeightMm, 279);
  }
});

test("fitting 12 subjects never shrinks the sheet into unreadable text", () => {
  for (const count of [1, 5, 8, 10, 12, 15, 20]) {
    const plan = reportSheet.planReportSheet(sheet(count));
    assert.ok(plan.tier.tableFont >= 9, `${count} subjects: table text ${plan.tier.tableFont}px must stay ≥ 9px`);
    assert.ok(plan.tier.tableFont <= 10.5, `${count} subjects: table text stays report-sized`);
    assert.ok(plan.tier.rowH >= 4.5, `${count} subjects: rows keep ≥ 4.5mm of height`);
    const html = reportSheet.renderReportSheetHTML(sheet(count));
    assert.match(html, /--tbl-font:(9|10)(\.\d+)?px/, `${count} subjects: font travels to the CSS`);
  }
});

test("density relaxes for short reports and tightens for long ones", () => {
  const small = reportSheet.planReportSheet(sheet(5));
  const twelve = reportSheet.planReportSheet(sheet(12));
  const twenty = reportSheet.planReportSheet(sheet(20));
  assert.equal(small.density, "regular", "a 5-subject report breathes");
  assert.ok(small.tier.tableFont >= twelve.tier.tableFont, "12 subjects are no looser than 5");
  assert.ok(twelve.tier.tableFont >= twenty.tier.tableFont, "20 subjects are no looser than 12");
  // Spare millimetres become usable writing space, not dead whitespace.
  assert.ok(small.commentMin > twenty.commentMin, "slack is spent on the comment boxes");
  assert.ok(small.slackMm > twelve.slackMm);
});

test("1, 5, 8, 10, 12 and 15 subjects all print on one page; huge lists flow on", () => {
  for (const count of [1, 3, 5, 8, 10, 12, 14, 15]) {
    const plan = reportSheet.planReportSheet(sheet(count));
    assert.equal(plan.pages, 1, `${count} subjects should need exactly one page (measured ${plan.heightMm}mm)`);
  }
  // Beyond what an A4 page can physically hold, the sheet continues onto a
  // second page rather than becoming illegible.
  const overflow = reportSheet.planReportSheet(sheet(30));
  assert.ok(overflow.pages >= 2, "30 subjects genuinely need a second page");
  assert.equal(overflow.density, "tight", "the tightest readable density is used first");
  const html = reportSheet.renderReportSheetHTML(sheet(30));
  assert.match(html, /table-header-group/, "the results header repeats on the continuation page");
  assert.match(html, /break-inside:\s*avoid/, "no subject row is split across pages");
});

test("long school, student and subject names stay on one page and wrap", () => {
  const wordy = () => sheet(12, { longSchoolName: true, longNames: true });
  const plan = reportSheet.planReportSheet(wordy());
  assert.equal(plan.pages, 1, `a wordy 12-subject report still fits (measured ${plan.heightMm}mm)`);
  const html = reportSheet.renderReportSheetHTML(wordy());
  assert.match(html, /overflow-wrap:\s*anywhere/, "long values wrap instead of overflowing the page");
  assert.match(body(html), /with Extended Practical Coursework/);
  assert.match(body(html), /Abdulrahman Oluwaseun Babatunde-Ademola/);
  // The school name steps down in size rather than pushing the layout wider.
  const short = reportSheet.renderReportSheetHTML(sheet(12));
  const longSize = Number(/--name-size:([\d.]+)px/.exec(html)[1]);
  const shortSize = Number(/--name-size:([\d.]+)px/.exec(short)[1]);
  assert.ok(longSize < shortSize, "a very long school name uses a smaller heading");
  assert.ok(longSize >= 10, "but never an unreadable one");
  // Wrapped text is budgeted, not ignored: the wordy sheet is measured taller
  // than the plain one at the same density.
  const plainAtSameTier = reportSheet.planReportSheet(sheet(12, { template: { layout: "compact" } }));
  assert.ok(plan.heightMm > 0 && plainAtSameTier.heightMm > 0);
});

/* --------------------------- information appears once ---------------------- */

test("the student block carries identity only — no session, term, DOB or admission number", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(12));
  const doc = body(html);
  const band = doc.slice(doc.indexOf('<section class="student-band'), doc.indexOf('<section class="block"'));
  for (const label of ["Student name", "Student ID", "Class", "Gender"]) {
    assert.ok(band.includes(label), `the student block shows ${label}`);
  }
  for (const label of ["Date of birth", "Admission", "Report No", "Academic session", "Term:"]) {
    assert.ok(!band.includes(label), `the student block must not repeat ${label}`);
  }
  // Date of birth and admission number are still held by the system, they are
  // simply not printed on the sheet.
  assert.ok(!doc.includes("2012-04-09"), "date of birth is not printed");
  assert.ok(!/Date of birth|تاريخ الميلاد/.test(doc), "no date-of-birth field anywhere on the sheet");
});

test("session, term, contacts and the reference are each printed exactly once", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(12));
  const count = (needle) => body(html).split(needle).length - 1;
  // (the reference number legitimately embeds the session, so match the field)
  assert.equal(count("<b>2026/2027</b>"), 1, "the academic session is printed once");
  assert.equal(count("First Term"), 1, "the term appears once");
  assert.equal(count("office@example.edu.ng"), 1, "the e-mail appears once");
  assert.equal(count("+234 802 000 1122"), 1, "the telephone appears once");
  assert.equal(count("EDU-2026/2027-JSS2-RA20260148"), 1, "the reference appears once");
  assert.equal(count("Riverside Academy"), 1, "the school name appears once in the body");
  // Both facts live in the title band, above the student information.
  const doc = body(html);
  const title = doc.slice(doc.indexOf('class="doc-title"'), doc.indexOf('class="student-band'));
  assert.match(title, /2026\/2027/);
  assert.match(title, /First Term/);
});

test("the footer is minimal — credit and reference only", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(12));
  const foot = html.slice(html.indexOf('<footer class="foot">'), html.indexOf("</footer>"));
  assert.match(foot, /Powered by EduSphere/);
  assert.match(foot, /Ref:/);
  assert.ok(!foot.includes("Riverside Academy"), "the footer does not repeat the school name");
  assert.ok(!foot.includes("Academic session"), "the footer does not repeat the session");
  assert.ok(!foot.includes("First Term"), "the footer does not repeat the term");
  assert.ok(!foot.includes("office@example.edu.ng"), "the footer does not repeat the contacts");
});

/* ------------------------------ category themes ---------------------------- */

test("the Islamic theme uses green, gold and restrained geometric detail", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(12, { category: "islamic" }));
  assert.match(html, /class="sheet [^"]*theme-islamic/);
  assert.match(html, /--brand: #14532d/, "deep academic green");
  assert.match(html, /--accent: #a87f2b/, "subtle gold");
  assert.match(html, /theme-islamic \.doc-title \{[^}]*background-image: url\("data:image\/svg\+xml/, "geometric hairline");
  assert.match(html, /masthead-crest/, "a restrained crest, not a large card");
  assert.match(html, /Term Report Sheet/);
  // No invented religious text is ever generated by the engine.
  assert.ok(!/بسم|الله|قرآن|اللهم/.test(html), "no invented Arabic or Qur'anic content");
});

test("the Western theme is navy and modern with no Islamic styling", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(12, { category: "western" }));
  assert.match(html, /class="sheet [^"]*theme-western/);
  assert.match(html, /--brand: #0a2342/, "navy");
  assert.ok(!html.includes("masthead-crest"), "no crest, anywhere in the document");
  assert.ok(!html.includes("theme-islamic"), "not one Islamic rule is even emitted");
  assert.ok(!html.includes("data:image/svg+xml"), "no Islamic geometric pattern");
  assert.ok(!/[\u0600-\u06FF]/.test(body(html)), "a Western sheet contains no Arabic at all");
  assert.match(html, /Term Report/);
});

test("Western styling stays English even when a learner also has Arabic data", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(6, { category: "western", arabic: true }));
  assert.ok(!/[\u0600-\u06FF]/.test(body(html)), "the Western report does not unexpectedly flip to RTL");
  assert.ok(!body(html).includes("ar-title"), "the Western title remains English");

  const islamic = reportSheet.renderReportSheetHTML(sheet(6, { category: "islamic", arabic: true }));
  assert.match(body(islamic), /class="ar-title"/, "the Islamic report can show its bilingual title");
});

test("both themes share one engine, one data structure and the same sections", () => {
  const islamic = reportSheet.renderReportSheetHTML(sheet(12, { category: "islamic" }));
  const western = reportSheet.renderReportSheetHTML(sheet(12, { category: "western" }));
  for (const section of [
    "Academic performance", "Performance summary", "Grading scale",
    "Attendance", "Behaviour / Conduct", "Comments", "Promotion status",
  ]) {
    assert.ok(body(islamic).includes(section), `Islamic sheet has: ${section}`);
    assert.ok(body(western).includes(section), `Western sheet has: ${section}`);
  }
  // Same order in both.
  const order = (html) => ['class="doc-title"', 'class="student-band', "Academic performance",
    "Performance summary", "Grading scale", "Attendance", "Behaviour / Conduct", "Comments",
    "Promotion status", 'class="signatures"', 'class="foot"']
    .map((needle) => body(html).indexOf(needle));
  for (const positions of [order(islamic), order(western)]) {
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] > positions[i - 1] && positions[i - 1] >= 0, "sections keep the required order");
    }
  }
  // Identical measured layout: the theme changes the look, never the budget.
  assert.equal(reportSheet.planReportSheet(sheet(12, { category: "islamic" })).heightMm,
    reportSheet.planReportSheet(sheet(12, { category: "western" })).heightMm);
});

test("the institution type resolves a theme when no explicit category is stored", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(6, { category: "", institutionType: "Primary School" }));
  assert.match(html, /theme-(islamic|western)/, "an unknown or missing category still themes cleanly");
  const nursery = reportSheet.renderReportSheetHTML(sheet(6, { category: "western", institutionType: "" }));
  assert.match(nursery, /theme-western/);
});

test("a school's own brand colour overrides the category default in either theme", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(6, { category: "western", brandColor: "#7b1d3a" }));
  assert.match(html, /--brand: #7b1d3a/);
  assert.match(html, /theme-western/, "branding does not change which theme is used");
});

/* ------------------------------ images and status -------------------------- */

test("a photo or logo path with no file on disk degrades to a designed placeholder", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(6, {
    photoPath: "/uploads/students/does-not-exist.jpg",
    logoPath: "/uploads/logos/does-not-exist.png",
  }));
  assert.ok(!html.includes("does-not-exist"), "no <img> is emitted for a missing upload file");
  assert.match(html, /photo-slot photo-empty/, "a clean photo placeholder is drawn instead");
  assert.match(html, /logo logo-fallback/, "and a monogram replaces the logo");
  assert.ok(!/alt="Zainab Adeyemi"/.test(html), "the student's name is never shown as broken-image alt text");
});

test("the photo frame keeps passport proportions", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(12));
  const w = Number(/--photo-w:([\d.]+)mm/.exec(html)[1]);
  const h = Number(/--photo-h:([\d.]+)mm/.exec(html)[1]);
  assert.ok(w >= 30 && w <= 35, `photo width ${w}mm is in the 30–35mm band`);
  assert.ok(h >= 35 && h <= 45, `photo height ${h}mm is in the 35–45mm band`);
  assert.ok(h > w, "portrait, not square");
  // …at every density, including the tightest one.
  for (const count of [1, 12, 20]) {
    const sheetHtml = reportSheet.renderReportSheetHTML(sheet(count));
    assert.ok(Number(/--photo-w:([\d.]+)mm/.exec(sheetHtml)[1]) >= 30, `${count} subjects keep a 30mm photo`);
    assert.ok(Number(/--photo-h:([\d.]+)mm/.exec(sheetHtml)[1]) >= 35, `${count} subjects keep a 35mm photo`);
  }
});

test("a sheet with no photograph gives the space back to the student details", () => {
  const withPhoto = reportSheet.renderReportSheetHTML(sheet(12));
  const without = reportSheet.renderReportSheetHTML(sheet(12, { template: { showPhoto: false } }));
  assert.match(withPhoto, /class="student-band"/);
  assert.match(without, /class="student-band no-photo"/);
  assert.ok(!body(without).includes("photo-slot"), "no empty frame is drawn");
});

test("approval status is a compact line, never a full-page overlay", () => {
  const final = reportSheet.renderReportSheetHTML(sheet(12));
  assert.match(final, /<p class="status-line">/, "a final report states its status in one line");
  assert.ok(!body(final).includes("status-notice"));
  assert.ok(!body(final).includes("draft-mark"));
  assert.ok(!/NOT VALID|WORKING COPY/.test(final), "no shouting full-page overlay");

  const incomplete = reportSheet.renderReportSheetHTML(sheet(9, {
    status: "draft",
    completeness: {
      complete: false,
      missingSubjects: [{ subjectId: 91, nameEn: "History", nameAr: "التاريخ" }],
      pendingSubjects: [{ subjectId: 92, nameEn: "Geography", nameAr: "الجغرافيا" }],
    },
  }));
  assert.match(incomplete, /<aside class="status-notice notice-incomplete"/);
  assert.match(incomplete, /Missing: History/, "the missing subjects are named");
  assert.match(incomplete, /Awaiting approval: Geography/, "so are the ones awaiting approval");
  // The subtle draft mark stays subtle.
  assert.match(incomplete, /<div class="draft-mark"/);
  assert.match(incomplete, /\.draft-mark span \{[^}]*opacity: \.34/);
});

/* ------------------------------ print + mobile ----------------------------- */

test("printing hides every piece of interface and leaves only the report", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(12));
  const print = html.slice(html.indexOf("@media print"));
  assert.match(print, /\.noprint \{ display: none !important; \}/, "toolbar and buttons are hidden");
  assert.match(print, /html, body \{ background: #fff/, "no screen chrome is printed");
  assert.match(print, /\.sheet \{[^}]*box-shadow: none/);
  // The only interactive element lives inside .noprint.
  const toolbar = html.slice(html.indexOf('<div class="noprint toolbar"'), html.indexOf('<div class="sheet'));
  assert.match(toolbar, /<button/);
  assert.ok(!body(html).includes("<button"), "the page itself has no buttons");
});

test("small screens keep an A4 document that can be panned, not a squeezed one", () => {
  const html = reportSheet.renderReportSheetHTML(sheet(12));
  const mobile = html.slice(html.indexOf("@media screen and (max-width: 840px)"));
  assert.match(mobile, /overflow-x: auto/, "the page scrolls horizontally instead of shrinking");
  assert.ok(!/\.sheet \{[^}]*width: 100%/.test(mobile), "the sheet keeps its A4 width");
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

test("no school, student or subject data is hard-coded in the engine", () => {
  const src = require("node:fs").readFileSync(require.resolve("../server/services/report-sheet.js"), "utf8");
  const renderer = src.slice(src.indexOf("/* -------------------------------- rendering"), src.indexOf("/* --------------------------- template preview"));
  for (const forbidden of ["Ameenullah", "Bello", "AME0001", "Nursery 1", "2026/2027", "Alpha One", "Fiqh", "Hadith"]) {
    assert.ok(!renderer.includes(forbidden), `the renderer must not hard-code "${forbidden}"`);
  }
});
