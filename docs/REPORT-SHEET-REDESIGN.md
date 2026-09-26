# Term Report Sheet — Professional A4 Redesign (Implementation Report)

Scope: **presentation only.** The report sheet's business logic — result
calculations, grading, positions, class averages, promotion decisions, the
review/approval workflow, publication gating, permissions, multi-tenancy and
every API contract — is untouched. All data on the sheet still comes from the
single report engine (`services/report-sheet.js`) fed by `services/grading.js`
and `term_summaries`; nothing is hard-coded per school.

## Files changed

| File | Change |
| ---- | ------ |
| `server/services/report-sheet.js` | New professional A4 renderer (`renderReportSheetHTML`): masthead, title band, student information section with photograph, fixed-layout results table, performance summary table, grading-scale strip, attendance table, conduct grid, comment boxes, promotion block, signature blocks, pinned footer. Added `assetServed()` (server-side image existence check), `tint()` colour helper, date display formatting, status-notice component, subtle watermark, adaptive density, brand-colour pass-through, single-student attendance fallback before the term is computed. `renderBulkReportSheets` now emits exactly one viewer script. |
| `public/js/report-sheet-viewer.js` | **New.** Same-origin script for every rendered report document: wires the Print / Save as PDF button (the platform CSP is `script-src-attr 'none'`, which silently blocks the old inline `onclick`) and swaps any image that fails at request time for the same clean placeholder the server renders — a broken-image icon or raw alt text is never shown. |
| `test/report-sheet.test.js` | Four **added** tests (no existing test removed or weakened): image existence gating, CSP-safe print button + single bulk script, working-copy watermark lifecycle, A4 print-ready layout markers. |
| `docs/REPORT-SHEET.md` | Documents the A4 layout, the image verification pipeline and the working-copy rules. |
| `report-sheet-preview.html`, `report-template-sample.html` | Regenerated from the actual engine (these committed artifacts document the current output). |
| `.gitignore` | Ignores the agent scratch directory (`.arena/`). |

## How the broken school logo / student photo were fixed

**Root cause (reproduced, not assumed):** the sheet emitted an `<img>` for any
`photo_path`/`logo_path` matching `/uploads/…`. When the file is missing on
disk (typical after a database restore onto a fresh host, or an ephemeral
filesystem), `express.static(..., { fallthrough: true })` falls through to the
SPA fallback, so the browser receives **HTTP 200 `text/html`** for the image
URL — it paints a broken-image icon and shows the alt text ("Bello Luqman").
The URL construction itself was correct; the existence of the file was never
verified.

**Fix (server-side, primary):** `assetServed()` resolves the `/uploads/…` path
inside `config.UPLOAD_DIR`, rejects `..` segments, and stats the file. An
`<img>` is emitted only when the bytes can actually be served. Everything
else degrades to a designed placeholder: a monogram tile for the logo, a
framed silhouette box for the photograph (no broken icon, no alt text). The
existing `asset()` same-origin allow-list is unchanged.

**Fix (client-side, secondary):** each emitted image carries
`data-fallback="logo|photo"`; `/js/report-sheet-viewer.js` listens for `error`
events (CSP-safe — inline `onerror` is blocked like `onclick`) and swaps in
the identical placeholder if a file disappears between render and request.

## A4 print layout

`@page { size: A4 portrait|landscape; margin: 0 }` — the sheet itself carries
the printable margins (10–12 mm), so the screen preview is the printed page.
Portrait reports are budgeted to fit one page (adaptive `d-dense` mode
tightens rows/sections when there are ≥8 subjects, an incomplete-status
notice, or the compact template). Long reports fragment cleanly: repeated
table headers (`table-header-group`), rows never split
(`break-inside: avoid`), `box-decoration-break: clone` keeps the margins on
continuation pages, and the footer is pinned to the foot of the page via an
absolutely-positioned block inside a min-height content box (on a multi-page
report it lands at the end of the last page instead of orphaning). Printing
hides every screen control (`@media print` + `.noprint`), keeps brand colours
(`print-color-adjust: exact`) and remains legible in grayscale. On phones the
document stays A4-proportioned with horizontal panning rather than being
squeezed.

## Draft / approval watermark behaviour

Unchanged semantics, redesigned presentation. `deriveReportStatus` still
computes the weakest workflow stage. A **staff** preview whose report is
draft/returned/submitted/under-review gets a subtle horizontal
"Working copy — not final" mark (11px, 38% opacity, behind the content — no
giant vertical watermark). Incomplete reports get a compact
"RESULT STATUS — INCOMPLETE / AWAITING APPROVAL" notice naming the missing or
pending subjects (e.g. *"Awaiting approval: Fiqh"*). Approved, published and
locked reports — and every student/parent portal and public-checker copy —
carry **no** draft marking. The institution-configured template watermark
(`showWatermark` + `watermarkText`) remains available and renders as a faint
centred band.

## Tests

- Full suite: `npm test` → **628 passed, 0 failed** (624 pre-existing + 4 added).
  Includes the complete report-sheet, result-lifecycle, grading, portal,
  public-checker, tenant-isolation and upload-hardening suites.
- Live scenario verification (booted app, real HTTP): approved report,
  incomplete draft (missing + awaiting-approval subjects), published report,
  student portal copy, public result-checker copy, bulk class generation
  (3 sheets, one page break each, one script tag), template preview for
  classic/modern/compact layouts, school with logo, school without logo,
  student with photo, student with dangling photo path, student with no photo,
  long school/subject names (46-char school name, long Arabic subject names),
  RTL and LTR documents.

## Remaining issues that need backend/data attention (not fixed here)

1. **`attendanceBreakdownMap` only covers students with a computed
   `term_summaries` row.** The single-student sheet now falls back to the
   per-student `attendanceBreakdown` (same table, same arithmetic) so a
   pre-compute staff preview still shows real attendance; the batched bulk
   path still requires the term to be computed first (by design — bulk only
   includes students with summaries).
2. **ID cards / certificates** (`routes/documents.js`) emit upload URLs with
   the same unverified-path pattern the report sheet had. Out of scope here,
   but `assetServed()` is reusable if the same fix is wanted there.
3. If uploads live on an ephemeral disk (see `docs/PERSISTENCE.md`), the
   placeholders will appear after every redeploy until a persistent volume is
   attached — a deployment concern, not a rendering one.
