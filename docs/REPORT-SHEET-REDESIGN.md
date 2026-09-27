# Term Report Sheet — Official A4 Redesign (Implementation Report)

Scope: **presentation only.** The report sheet's business logic — CA/exam/total
arithmetic, percentages, grades, grade points, averages, positions, class
averages, attendance figures, promotion decisions, the review/approval
workflow, publication gating, permissions, multi-tenancy, authentication and
every API contract and database table — is untouched. All figures still come
from `services/grading.js` and `term_summaries` through the single report
engine (`services/report-sheet.js`). Nothing on the sheet is hard-coded per
school.

---

## 1. Files changed

| File | Change |
| ---- | ------ |
| `server/services/report-sheet.js` | The redesign. Renderer split into **model → planner → markup**: `reportModel()` derives every displayed value once, `measureSheet()`/`planSheet()` budget the page in millimetres, `renderReportSheetHTML()` only emits markup. New: `planColumns()` (adaptive subject/remark column widths), `reportTheme()` + `themeCss()` (Islamic / Western category themes), `geometricPattern()`, `planReportSheet()` (new export — the measured page plan), `FIT_RESERVE_MM`, `DENSITY_TIERS`, `PAGE_SIZES`. Rewritten HTML + CSS for masthead, title band, student band, results table, summary, grading scale, attendance, conduct, comments, promotion, signatures, footer. `madrasaInfo` now carries `category` / `institutionType`. `sampleReportSheet()` takes an optional third `category` argument. Removed: `brandColorOf()` (superseded by `reportTheme()`), the old "landscape when >11 subjects" rule, and the Report No./Term/Session/DOB/Admission-No. fields from the student block. |
| `server/app.js` | **Image-loading root-cause fix**: a `/uploads` 404 terminator after the static mount, so a missing upload never falls through to the SPA HTML fallback. |
| `server/services/grading.js` | `reportCardData()`'s `madrasa` object now also returns `brandColor`, `category`, `institutionType` (presentation only — no calculation reads them). |
| `server/routes/results.js` | `/results/report-template/preview` passes the viewing tenant's own category so the preview shows that school's real theme. |
| `test/report-sheet-layout.test.js` | **New**, 20 tests: the one-page contract, density/readability floors, de-duplication, the two themes, image placeholders, print and mobile CSS. |
| `test/report-sheet.test.js` | **Two added** tests (nothing removed or weakened): the `/uploads` 404 behaviour and per-tenant category theming. |
| `public/js/report-sheet-viewer.js` | Unchanged — the placeholder/print contract it implements is preserved by the new markup. |
| `docs/REPORT-SHEET.md`, `docs/REPORT-SHEET-REDESIGN.md` | Updated. |
| `report-sheet-preview.html`, `report-template-sample.html` | Regenerated from the real pipeline (the preview is now a genuine 12-subject, one-page sheet). |

## 2. Components / templates changed

One template engine, one data structure, one set of sections — the theme is a
variable, not a fork.

```
reportModel(data, opts)          ← normalises input, derives every displayed value once
  └── planSheet(model)           ← measures the document in mm, picks a density tier
        └── measureSheet(m,tier) ← per-block millimetre budget
renderReportSheetHTML(data,opts) ← reportModel(...) + markup only
planReportSheet(data, opts)      ← exported plan, so the layout contract is testable
renderBulkReportSheets(sheets)   ← one stylesheet, one sheet per printed page
```

Section order (identical in both themes):

1. **Masthead** (once): logo/monogram · school name (EN + AR) · motto · address · tel · email · website
2. **Title band**: "Term Report Sheet" / "Term Report" · Academic Session · Term
3. **Student information**: Student name · Student ID · Class · Gender + photograph, with the result status beside it
4. **Academic performance**: `SUBJECT | CA | EXAM | TOTAL | % | GRADE | REMARK` (configurable columns, dynamic subject count)
5. **Performance summary**: Subjects offered · Total marks · Average · Overall grade · Position · Class size · Class average — one compact row
6. **Grading scale**: a single-strip legend under the summary
7. **Attendance | Behaviour / Conduct**: side by side
8. **Comments**: class teacher · head of institution
9. **Promotion status** strip (+ next term dates)
10. **Signatures**
11. **Minimal footer**: "Powered by EduSphere" · `Ref:` — nothing else

Deliberately **removed** from the sheet (the data stays in the database and on
every other screen/export): Report No. as a field, Term, Academic Session, Date
of Birth, Admission Number and Section/Program from the student block; the
repeated school name, contacts, session and term in the footer. No section
cards, no green boxes — thin 0.25 mm rules and 6 % brand tints, so the results
table is the visual focus.

## 3. CSS / print changes

- `@page { size: A4 portrait|landscape; margin: 0 }`; the **sheet** carries the
  9 mm printable margin, so the on-screen preview is the printed page, and
  `box-decoration-break: clone` keeps those margins on a continuation page.
- All geometry travels per sheet as **inline CSS custom properties**
  (`--row-h`, `--tbl-font`, `--photo-w`, `--comment-min`, …) written by the
  planner; theme colours live in `:root`. A bulk document can therefore share
  one stylesheet while each sheet keeps its own measured density.
- Fixed-layout results table with a `<colgroup>`: numeric columns get exact
  millimetre widths, the subject and remark columns share what is left
  (see §7).
- Pagination: `thead { display: table-header-group }` (header repeats),
  `tr { break-inside: avoid }` (no split rows), `break-inside: avoid` on
  notices/comment boxes/signatures, `orphans: 2; widows: 2`.
- Printing: `@media print` hides `.noprint` (the whole toolbar — the only
  interactive element in the document), removes the page background and the
  sheet shadow, and keeps brand colours with `print-color-adjust: exact`.
- Mobile: `@media screen and (max-width: 840px)` keeps the sheet at true A4
  width and lets the page pan (`overflow-x: auto`) instead of squeezing the
  document. The `.sheet` stays a direct child of `<body>` (required by the
  bulk extractor), so no scroll wrapper is introduced.
- RTL: the document flips to `dir="rtl"` when the student has an Arabic name;
  all spacing uses logical properties (`padding-inline-start`,
  `margin-inline-start`, `border-inline-start`, `text-align: start`).

## 4. How the broken logo / student photo was actually fixed

**Root cause (found, not guessed).** `server/app.js` mounts
`express.static(UPLOAD_DIR, { fallthrough: true })` on `/uploads`, and further
down a SPA fallback answers *any* GET that `req.accepts("html")` with
`index.html`. Browsers send `Accept: image/*,*/*;q=0.8` for `<img>` requests —
which matches `*/*`, so `req.accepts("html")` is true. A photo or logo path
that outlived its file (restored backup, ephemeral disk, moved upload volume)
therefore returned **HTTP 200 `text/html`**, the browser could not decode it
as an image, and painted a broken-image icon with the student's name as alt
text. The stored paths were never the problem.

**Fix, in three layers:**

1. **Transport (the real fix)** — `server/app.js` now terminates `/uploads`
   with a 404 immediately after the static mount. Uploads are files, never
   pages; the SPA can no longer impersonate an image anywhere in the platform.
   Application routes still fall through to the SPA exactly as before.
2. **Render time** — `assetServed()` (already present) stats the file inside
   `config.UPLOAD_DIR` and only then emits an `<img>`. Otherwise the renderer
   draws the designed placeholder: a brand monogram tile for the logo, a
   framed silhouette for the photograph. No `alt` text, no broken icon, no
   raw path is ever shown.
3. **Request time** — every emitted image carries `data-fallback="logo|photo"`;
   `/js/report-sheet-viewer.js` swaps in the identical placeholder if a file
   disappears between render and request (CSP-safe: inline `onerror` is
   blocked by `script-src-attr 'none'`).

The photo frame is **30–31 mm × 35–37 mm** at every density, i.e. passport
proportions, `object-fit: cover`, never distorted or cropped to a square.

## 5. Islamic theme

Selected from the tenant's **existing** category
(`madaris.category` / `institution_type`, normalised by
`services/institution.js` — no new school-type system was created).

- Deep academic green `#14532d` with a restrained gold accent `#a87f2b`.
- Serif academic typography for headings (Georgia / Times / Noto Naskh Arabic).
- Centred masthead with a small diamond crest; a double rule (green + gold).
- Framed title band carrying a very faint 8-point-star hairline (two crossed
  squares, 45 % opacity, generated as an inline SVG data URI) and `◆` marks
  either side of the title.
- Diamond section markers, gold-underlined table header, double-ruled
  promotion badge, gold hairline above the footer.
- **No invented religious content.** The engine generates no Arabic of its own
  beyond the UI labels used when the *student's own record* is Arabic, and no
  Qur'anic or devotional text at all.

## 6. Western theme

- Navy `#0a2342` with a slate-blue accent `#3f6fa6`.
- Modern sans typography (Segoe UI Semibold family).
- Left-aligned masthead with a navy keyline and the contact block stacked at
  the right; single solid rule.
- Reversed **solid navy title bar** (white text) instead of a framed band.
- Square accent markers, slate zebra striping, solid navy promotion badge with
  a navy keyline on the strip.
- **Zero Islamic styling**: `themeCss()` emits only the active theme, so a
  Western report contains no crest, no geometric pattern, no `theme-islamic`
  selector — not even unused ones — and no Arabic anywhere in the document.

In both themes a school's own configured brand colour (template `brandColor`,
else `madaris.brand_color`) overrides the category default, so tenant branding
still wins.

## 7. How 12 subjects were made to fit one A4 portrait page

Not by shrinking everything. The renderer **measures the document before it
writes it**:

- `measureSheet(model, tier)` budgets every block in millimetres — masthead
  (including the wrapped school-name lines), rules, title, student band,
  table (rows **plus** an allowance for wrapped subject/remark lines), status
  notice, summary, legend, attendance/conduct pair, comments, promotion,
  signatures, footer.
- `planSheet()` walks three density tiers and takes the **loosest one that
  fits** A4's 279 mm of printable height with a 5 mm safety reserve:

  | tier | table text | row height | photo | picked for |
  | ---- | ---------- | ---------- | ----- | ---------- |
  | `regular` | 10.2 px | 6.0 mm | 31 × 37 mm | ≤ 10 subjects |
  | `dense`   | 9.6 px  | 5.2 mm | 30 × 35.5 mm | 11–15 subjects |
  | `tight`   | 9.0 px  | 4.6 mm | 30 × 35 mm | 16–20 subjects |

  Table text never drops below **9 px** and rows never below 4.6 mm, which is
  the readability floor the design is allowed to use.
- Leftover millimetres are **given back** where they are useful — the comment
  boxes (`+0.42 × slack`, capped) and the signature space (`+0.2 × slack`) —
  so a 5-subject report breathes instead of leaving a dead band above the
  footer.
- `planColumns()` apportions the two text columns: a roster of short subject
  names hands its surplus to the remark column and vice versa, aiming to keep
  the longest entry in each on two lines. This is what keeps a wordy
  12-subject report (long subject names *and* sentence-length remarks) on one
  page.
- Structural savings that bought the space: session/term moved into the title
  band, five fields removed from the student block, attendance and conduct
  paired side by side, the grading scale reduced to a one-row strip, the
  promotion block reduced to a strip with no heading, and the footer cut to a
  single short line.

Measured result (default 6 columns, portrait):

| subjects | 1 | 5 | 8 | 10 | **12** | 14 | 15 | 18 | 20 | 24 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| density | regular | regular | regular | regular | **dense** | dense | dense | tight | tight | tight |
| height (mm of 279) | 212.9 | 236.9 | 254.9 | 266.9 | **257.8** | 268.2 | 273.4 | 265.9 | 275.1 | 293.5 |
| pages | 1 | 1 | 1 | 1 | **1** | 1 | 1 | 1 | 1 | 2 |

`planReportSheet(data, opts)` returns this plan, which is what
`test/report-sheet-layout.test.js` asserts against.

## 8. How 15+ subjects are handled

- **15** → `dense` (9.6 px), one page, 273.4 mm of 279 mm.
- **16–20** → `tight` (9.0 px, 4.6 mm rows), still one page.
- **21+** → the design refuses to shrink further and flows onto page 2
  *cleanly*: the results header repeats (`table-header-group`), no row is ever
  split, `box-decoration-break: clone` preserves the 9 mm margins on the
  continuation page, and notices/comment boxes/signature blocks are
  `break-inside: avoid`.
- Overflow is therefore only ever a genuine capacity decision, never a layout
  accident.

## 9. Tests performed

- **`npm test` — full suite, nothing deleted or weakened.** 628 pre-existing
  tests plus 22 added (20 in the new `test/report-sheet-layout.test.js`, 2
  appended to `test/report-sheet.test.js`).
- New layout/theme coverage: 1 / 3 / 5 / 8 / 10 / 12 / 14 / 15 / 20 / 30
  subjects; both themes; readability floors (≥ 9 px, ≥ 4.5 mm rows); density
  progression; long school name (67 chars), long student name, long subject
  names and sentence-length remarks; de-duplication of session, term,
  contacts, reference and school name; the student block containing identity
  only; the minimal footer; Islamic ornament present / Western ornament
  absent; no Arabic in a Western sheet; brand-colour override; institution
  type resolving a theme; missing photo *and* missing logo degrading to
  placeholders; photo frame proportions; `showPhoto: false`; compact status
  line vs. incomplete notice naming missing/pending subjects; the subtle draft
  mark; print CSS hiding all interface; mobile panning; and a source-level
  check that no school/student/subject name is hard-coded in the renderer.
- Integration coverage (existing + added): approved / draft / incomplete /
  published reports, portal copy, public-checker copy, bulk class generation
  (one script tag, one page per student), template preview for
  classic/modern/compact, RTL and LTR documents, per-tenant theming with the
  neighbouring tenant unaffected, cross-tenant/IDOR refusals, and the new
  `/uploads` 404 behaviour (including that real app routes still reach the
  SPA).
- Artifacts regenerated from the real pipeline:
  `report-sheet-preview.html` (a genuine 12-subject RTL sheet, `dense`,
  254.8 mm of 279 mm, one page) and `report-template-sample.html`.

## 10. Remaining issues / notes

1. **No browser was available in this environment**, so page fitting is
   verified by the analytical millimetre model plus unit tests rather than by
   a rasterised PDF. The model is deliberately conservative (5 mm reserve, and
   every block budgeted at or above its CSS height); a real print check on a
   target printer is still worth doing once.
2. **Landscape holds fewer rows, by physics.** `orientation: auto` now only
   turns landscape when *all seven* result columns are enabled (the old
   "more than 11 subjects → landscape" rule was removed because portrait now
   handles long lists better). A4 landscape has 192 mm of printable height, so
   a 12-subject landscape sheet legitimately uses two pages. Schools wanting
   12+ subjects on one page should leave the grade-point column off, which is
   the default.
3. **ID cards / certificates** (`routes/documents.js`) still emit upload URLs
   without the `assetServed()` existence check. The `/uploads` 404 terminator
   now protects them from the HTML-instead-of-image failure, but they have no
   designed placeholder yet. Out of scope here; `assetServed()` is reusable.
4. **`attendanceBreakdownMap` only covers students with a computed
   `term_summaries` row** (pre-existing). The single-student sheet falls back
   to `attendanceBreakdown`, so a pre-compute preview still shows real
   attendance; bulk still requires the term to be computed, by design.
5. If uploads live on an ephemeral disk (see `docs/PERSISTENCE.md`) the
   placeholders will appear after every redeploy until a persistent volume is
   attached — a deployment concern, not a rendering one.
