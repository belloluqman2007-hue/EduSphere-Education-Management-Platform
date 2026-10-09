"use strict";
/* ============================================================================
   EduSphere — printable documents
   ----------------------------------------------------------------------------
   This module deliberately returns HTML, not PDF files. The browser's print
   engine is the document renderer, which keeps the feature small, portable
   and consistent with the existing fee receipts and report cards.

   Every query below is tenant-scoped from the authenticated user's session.
   No request can select a different madrasa by posting a madrasa_id.
   ========================================================================== */
const express = require("express");
const db = require("../db");
const tokens = require("../services/tokens");
const { asyncHandler, err, ok, cleanStr, toNum, validDate, logActivity } = require("../util");
const { requireAuth, requireTenant, requireRole } = require("../middleware/auth");
const { effectiveTenantId, getTeacherAssignments } = require("../middleware/tenant");
const { requireStaffPermission } = require("../services/permissions");
const institution = require("../services/institution");

const router = express.Router();
router.use(requireAuth, requireTenant);

const STAFF = requireRole("madrasa_admin", "teacher");
const ADMIN = requireRole("madrasa_admin");
const TEMPLATE_TYPES = new Set(["graduation", "achievement", "completion", "participation", "custom"]);
const MAX_TEMPLATE_LENGTH = 200000;
const MAX_CUSTOM_FIELD_LENGTH = 500;

async function tenantId(req, res) {
  const tid = effectiveTenantId(req);
  if (!tid) {
    err(res, 400, "Madrasa context required.");
    return null;
  }
  return Number(tid);
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeAssetPath(value) {
  const path = cleanStr(value, 500);
  // Logos and photos are uploaded through the existing image pipeline. Do not
  // turn a database value into an arbitrary remote image or javascript URL.
  return /^\/uploads\/[A-Za-z0-9_./-]+$/.test(path) ? path : "";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dateLabel(value) {
  const raw = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const [year, month, day] = raw.split("-");
  return `${day}/${month}/${year}`;
}

function studentName(student) {
  return [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ").trim();
}

/* Columns shared by every printable student card, so the single and bulk
   layouts cannot drift apart. Tenant scoping is applied by each caller. */
const STUDENT_DOC_SELECT = `
    SELECT s.*, c.name_en AS class_name, a.label AS session_label,
           m.name_en AS institution_name, m.name_ar AS institution_name_ar, m.logo_path,
           m.slug AS institution_slug, m.motto_en, m.category, m.brand_color,
           m.address, m.city, m.state_name, m.phone
    FROM students s
    LEFT JOIN classes c ON c.id = s.class_id AND c.madrasa_id = s.madrasa_id
    LEFT JOIN academic_sessions a ON a.id = s.session_id AND a.madrasa_id = s.madrasa_id
    JOIN madaris m ON m.id = s.madrasa_id`;

async function studentDocumentRow(tid, studentId) {
  return db.get(`${STUDENT_DOC_SELECT} WHERE s.id = ? AND s.madrasa_id = ?`, [studentId, tid]);
}

async function assertTeacherCanSee(req, res, tid, student) {
  if (req.user.role !== "teacher") return true;
  const scope = await getTeacherAssignments(tid, req.user.id);
  if (scope.anyClassAnySubject || scope.assignedClassIds.has(Number(student.class_id))) return true;
  err(res, 404, "Student not found.");
  return false;
}

/* --------------------------------------------------------------------------
   QR support
   --------------------------------------------------------------------------
   A small dependency-free QR encoder is kept here because printable pages
   must work offline and the platform intentionally does not add a PDF/QR
   package just for an optional ID-card decoration. It supports byte-mode
   QR versions 1–9 at error-correction level L, enough for a short signed
   profile URL. The resulting SVG is a real QR matrix, not a screenshot or a
   remote image request.
---------------------------------------------------------------------------- */
const QR_BLOCKS_L = [
  null,
  { version: 1, blocks: 1, total: 26, data: 19, ecc: 7 },
  { version: 2, blocks: 1, total: 44, data: 34, ecc: 10 },
  { version: 3, blocks: 1, total: 70, data: 55, ecc: 15 },
  { version: 4, blocks: 1, total: 100, data: 80, ecc: 20 },
  { version: 5, blocks: 1, total: 134, data: 108, ecc: 26 },
  { version: 6, blocks: 2, total: 86, data: 68, ecc: 18 },
  { version: 7, blocks: 2, total: 98, data: 78, ecc: 20 },
  { version: 8, blocks: 2, total: 121, data: 97, ecc: 24 },
  { version: 9, blocks: 2, total: 146, data: 116, ecc: 30 },
];
const QR_ALIGNMENT = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]];

function gfTables() {
  const exp = new Uint8Array(512);
  const log = new Int16Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  return { exp, log };
}
const GF = gfTables();
function gfMul(a, b) {
  return a && b ? GF.exp[GF.log[a] + GF.log[b]] : 0;
}
function qrGenerator(eccLength) {
  let poly = [1];
  for (let i = 0; i < eccLength; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF.exp[i]);
    }
    poly = next;
  }
  return poly;
}
function qrEcc(data, eccLength) {
  const generator = qrGenerator(eccLength);
  const result = new Uint8Array(eccLength);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[eccLength - 1] = 0;
    for (let i = 0; i < eccLength; i++) result[i] ^= gfMul(generator[i + 1], factor);
  }
  return result;
}
function qrBch(value, polynomial) {
  let v = value;
  const degree = 31 - Math.clz32(polynomial);
  while (v && (31 - Math.clz32(v)) >= degree) v ^= polynomial << ((31 - Math.clz32(v)) - degree);
  return v;
}
function qrBitsFor(data, version, capacity) {
  const bytes = Buffer.from(data, "utf8");
  const bits = [0, 1, 0, 0];
  const lengthBits = version < 10 ? 8 : 16;
  for (let i = lengthBits - 1; i >= 0; i--) bits.push((bytes.length >>> i) & 1);
  for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
  const totalBits = capacity * 8;
  for (let i = 0; i < Math.min(4, totalBits - bits.length); i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
  let pad = 0;
  while (codewords.length < capacity) codewords.push((pad++ % 2) ? 0x11 : 0xec);
  return codewords;
}
function qrDataCodewords(text) {
  const bytes = Buffer.byteLength(String(text), "utf8");
  const entry = QR_BLOCKS_L.find((x) => x && bytes <= x.data * x.blocks - (x.version < 10 ? 2 : 3));
  if (!entry) return null;
  return { bytes: Buffer.from(String(text), "utf8"), entry };
}
function qrInterleaved(text) {
  const selected = qrDataCodewords(text);
  if (!selected) return null;
  const { bytes, entry } = selected;
  const dataWords = qrBitsFor(text, entry.version, entry.data * entry.blocks);
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < entry.blocks; i++) {
    const block = Uint8Array.from(dataWords.slice(offset, offset + entry.data));
    offset += entry.data;
    blocks.push({ data: block, ecc: qrEcc(block, entry.ecc) });
  }
  const out = [];
  for (let i = 0; i < entry.data; i++) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  for (let i = 0; i < entry.ecc; i++) for (const block of blocks) out.push(block.ecc[i]);
  return { version: entry.version, bytes, codewords: out };
}
function qrMatrix(text, mask) {
  const encoded = qrInterleaved(text);
  if (!encoded) return null;
  const version = encoded.version;
  const size = 17 + version * 4;
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      if (row + r < 0 || row + r >= size || col + c < 0 || col + c >= size) continue;
      matrix[row + r][col + c] = (r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)));
    }
  };
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
  const alignment = QR_ALIGNMENT[version] || [];
  for (const row of alignment) for (const col of alignment) {
    if (matrix[row][col] !== null) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) matrix[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
  }
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] === null) matrix[6][i] = i % 2 === 0;
    if (matrix[i][6] === null) matrix[i][6] = i % 2 === 0;
  }
  matrix[size - 8][8] = true;
  const formatData = (1 << 3) | mask; // level L = 01
  const format = ((formatData << 10) | qrBch(formatData << 10, 0x537)) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const bit = ((format >>> i) & 1) === 1;
    if (i < 6) matrix[i][8] = bit;
    else if (i < 8) matrix[i + 1][8] = bit;
    else matrix[size - 15 + i][8] = bit;
    if (i < 8) matrix[8][size - i - 1] = bit;
    else if (i < 9) matrix[8][15 - i - 1 + 1] = bit;
    else matrix[8][15 - i - 1] = bit;
  }
  // Versions 7+ carry an 18-bit version code in two 3×6 blocks (top-right and
  // bottom-left). Without it a scanner cannot read the larger profile URLs.
  if (version >= 7) {
    const info = (version << 12) | qrBch(version << 12, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const bit = ((info >>> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = (i % 3) + size - 11;
      matrix[r][c] = bit;
      matrix[c][r] = bit;
    }
  }
  const data = [];
  for (const word of encoded.codewords) for (let i = 7; i >= 0; i--) data.push((word >>> i) & 1);
  let bitIndex = 0; let row = size - 1; let direction = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (const c of [col, col - 1]) if (matrix[row][c] === null) {
        let bit = bitIndex < data.length ? data[bitIndex++] === 1 : false;
        const invert = [
          (row + c) % 2 === 0, row % 2 === 0, c % 3 === 0, (row + c) % 3 === 0,
          (Math.floor(row / 2) + Math.floor(c / 3)) % 2 === 0,
          (row * c) % 2 + (row * c) % 3 === 0,
          ((row * c) % 2 + (row * c) % 3) % 2 === 0,
          ((row * c) % 3 + (row + c) % 2) % 2 === 0,
        ][mask];
        matrix[row][c] = invert ? !bit : bit;
      }
      row += direction;
      if (row < 0 || row >= size) { row -= direction; direction = -direction; break; }
    }
  }
  return matrix;
}
function qrPenalty(matrix) {
  const size = matrix.length; let score = 0;
  const linePenalty = (line) => {
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  };
  for (let r = 0; r < size; r++) linePenalty(matrix[r]);
  for (let c = 0; c < size; c++) linePenalty(matrix.map((row) => row[c]));
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const a = matrix[r][c];
    if (a === matrix[r + 1][c] && a === matrix[r][c + 1] && a === matrix[r + 1][c + 1]) score += 3;
  }
  for (let r = 0; r < size; r++) for (let c = 0; c < size - 6; c++) if (matrix[r].slice(c, c + 7).join("") === "true,false,true,true,true,false,true") score += 40;
  for (let c = 0; c < size; c++) for (let r = 0; r < size - 6; r++) if (matrix.slice(r, r + 7).map((row) => row[c]).join("") === "true,false,true,true,true,false,true") score += 40;
  let dark = 0; for (const row of matrix) for (const cell of row) if (cell) dark++;
  score += Math.floor(Math.abs(100 * dark / (size * size) - 50) / 5) * 10;
  return score;
}
function qrSvg(text) {
  const candidates = Array.from({ length: 8 }, (_, mask) => ({ mask, matrix: qrMatrix(text, mask) })).filter((x) => x.matrix);
  if (!candidates.length) return "";
  const chosen = candidates.reduce((best, current) => qrPenalty(current.matrix) < qrPenalty(best.matrix) ? current : best);
  const matrix = chosen.matrix; const size = matrix.length; const paths = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r][c]) paths.push(`M${c} ${r}h1v1h-1z`);
  return `<svg class="qr-code" viewBox="-4 -4 ${size + 8} ${size + 8}" role="img" aria-label="QR code linking to the student's public profile" shape-rendering="crispEdges"><rect x="-4" y="-4" width="${size + 8}" height="${size + 8}" fill="#fff"/><path d="${paths.join("")}" fill="#111827"/></svg>`;
}

function signedProfileUrl(req, student) {
  const token = tokens.sign({ purpose: "public-student-profile", m: Number(student.madrasa_id), s: Number(student.id) }, 15 * 60);
  const path = `/api/public/student-profile/${token}`;
  const host = req.get("host");
  if (!host) return path;
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${host}${path}`;
}

/* --------------------------- shared print design ------------------------- */
// The palette matches the term report sheets (services/report-sheet.js):
// forest green + old gold for Islamic madaris, navy + slate blue for Western
// academies. A school's own brand colour (Settings) overrides the base brand.
const DOC_PALETTE = {
  islamic: { brand: "#14532d", accent: "#a87f2b" },
  western: { brand: "#0a2342", accent: "#3f6fa6" },
};
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function mixHex(hex, target, ratio) {
  const from = parseInt(hex.slice(1), 16);
  const to = parseInt(target.slice(1), 16);
  const channel = (shift) => {
    const a = (from >> shift) & 255;
    const b = (to >> shift) & 255;
    return Math.round(a + (b - a) * ratio).toString(16).padStart(2, "0");
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/** Visual identity for one school, derived from its existing category field. */
function documentTheme(school) {
  const key = institution.normalizeCategory(school.category, "") === "western" ? "western" : "islamic";
  const palette = DOC_PALETTE[key];
  const brand = HEX_COLOR.test(String(school.brandColor || "")) ? school.brandColor : palette.brand;
  return {
    western: key === "western",
    brand,
    brandDark: mixHex(brand, "#000000", 0.3),
    brandSoft: mixHex(brand, "#ffffff", 0.9),
    tint: mixHex(brand, "#ffffff", 0.96),
    accent: palette.accent,
    accentSoft: mixHex(palette.accent, "#ffffff", 0.6),
  };
}

function themeStyle(theme) {
  return `--brand:${theme.brand};--brand-dark:${theme.brandDark};--brand-soft:${theme.brandSoft};--tint:${theme.tint};--accent:${theme.accent};--accent-soft:${theme.accentSoft}`;
}

/** Faint geometric star lattice (Islamic themes only). Colour is a constant. */
function patternUrl(color, opacity) {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'>"
    + `<g fill='none' stroke='${color}' stroke-opacity='${opacity}' stroke-width='1'>`
    + "<rect x='10' y='10' width='20' height='20'/>"
    + "<rect x='10' y='10' width='20' height='20' transform='rotate(45 20 20)'/></g></svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
const ISLAMIC_LATTICE = patternUrl(DOC_PALETTE.islamic.accent, 0.2);
const ISLAMIC_LATTICE_CERT = patternUrl(DOC_PALETTE.islamic.accent, 0.11);

/** Normalises a school row (aliased by the queries below) for every renderer. */
function schoolIdentity(row) {
  return {
    name: row.institution_name || "",
    nameAr: row.institution_name_ar || "",
    logo: safeAssetPath(row.logo_path),
    motto: row.motto_en || "",
    address: [row.address, row.city, row.state_name].filter(Boolean).join(", "),
    phone: row.phone || "",
    category: row.category || "",
    brandColor: row.brand_color || "",
  };
}

function schoolMark(school) {
  return school.logo
    ? `<img src="${escapeHtml(school.logo)}" alt="">`
    : `<span>${escapeHtml(String(school.name || "S").trim().slice(0, 1).toUpperCase() || "S")}</span>`;
}

function noStore(res) {
  res.set("Cache-Control", "no-store");
}

/* ------------------------------- ID cards -------------------------------- */
async function loadIdCardStudent(req, res, tid, id) {
  const student = await studentDocumentRow(tid, id);
  if (!student) { err(res, 404, "Student not found."); return null; }
  if (!await assertTeacherCanSee(req, res, tid, student)) return null;
  return student;
}

function qrFigure(url) {
  const svg = qrSvg(url);
  if (!svg) return "";
  return `<figure class="id-qr" data-profile-url="${escapeHtml(url)}"><a href="${escapeHtml(url)}" aria-label="Open public student profile">${svg}</a><figcaption>Scan to verify</figcaption></figure>`;
}

function idCardClasses(theme, name, side) {
  return ["id-card", side, theme.western ? "category-western" : "category-islamic", name.length > 24 ? "is-long" : ""]
    .filter(Boolean).join(" ");
}

/** Front of the card: identity, photo and (optionally) the profile QR. */
function idCardFrontMarkup(student, qrUrl, issuedLabel) {
  const school = schoolIdentity(student);
  const theme = documentTheme(school);
  const name = studentName(student);
  const photo = safeAssetPath(student.photo_path);
  const fields = [
    ["Admission no.", student.admission_no],
    ["Class", student.class_name || "Not assigned"],
    ["Session", student.session_label || "Not set"],
  ];
  return `<article class="${idCardClasses(theme, name, "id-front")}" style="${themeStyle(theme)}">
    <header class="id-head"><div class="id-mark">${schoolMark(school)}</div><div class="id-school"><strong>${escapeHtml(school.name || "School")}</strong><span>Student identity card</span></div></header>
    <div class="id-body">
      <div class="id-photo">${photo ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(name)}">` : `<div class="id-photo-empty">${escapeHtml(String(name || "S").slice(0, 1).toUpperCase())}</div>`}</div>
      <div class="id-info">
        <span class="id-role">Student</span>
        <h2 class="id-name">${escapeHtml(name)}</h2>
        <dl class="id-fields">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
      </div>
      ${qrUrl ? qrFigure(qrUrl) : ""}
    </div>
    <footer class="id-foot"><span>${escapeHtml(school.motto || "Official student identification")}</span><span>Issued ${escapeHtml(issuedLabel)}</span></footer>
  </article>`;
}

/** Back of the card: terms, school contact, emergency contact, signatures. */
function idCardBackMarkup(student, issuedLabel) {
  const school = schoolIdentity(student);
  const theme = documentTheme(school);
  const name = studentName(student);
  const contacts = [
    ["School", school.address],
    ["Phone", school.phone],
    ["Emergency", student.emergency_contact || student.parent_phone || ""],
  ].filter(([, value]) => value);
  const subtitle = !theme.western && school.nameAr
    ? `<span dir="rtl" lang="ar">${escapeHtml(school.nameAr)}</span>`
    : "<span>Student identity card</span>";
  return `<article class="${idCardClasses(theme, name, "id-back")}" style="${themeStyle(theme)}">
    <header class="id-head"><div class="id-mark">${schoolMark(school)}</div><div class="id-school"><strong>${escapeHtml(school.name || "School")}</strong>${subtitle}</div></header>
    <div class="id-body">
      <p class="id-terms">This card remains the property of ${escapeHtml(school.name || "the school")}. Carry it on school premises and show it when asked. If found, please return it to the school office.</p>
      <dl class="id-contact">${contacts.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
      <div class="id-signs"><span>Holder's signature</span><span>Principal's signature</span></div>
    </div>
    <footer class="id-foot"><span>${escapeHtml(student.admission_no)} · ${escapeHtml(name)}</span><span>Issued ${escapeHtml(issuedLabel)}</span></footer>
  </article>`;
}

const idSlot = (inner) => `<div class="id-slot">${inner}</div>`;

function printShell(title, css, body, { interactive = true } = {}) {
  const bar = interactive
    ? `<div class="print-bar"><span>${escapeHtml(title)}</span><button id="printPageBtn" type="button">Print / Save as PDF</button></div>`
    : "";
  const script = interactive ? '<script src="/js/print.js"></script>' : "";
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PRINT_BASE_CSS}\n${css}</style></head><body>${bar}${body}${script}</body></html>`;
}

const PRINT_BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#e6ebf2;color:#172033;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.print-bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:#1f3154;color:#fff;font:600 13px/1.3 Arial,"Segoe UI",sans-serif}
.print-bar span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9}
.print-bar button{flex:none;border:0;border-radius:7px;background:#fff;color:#1f3154;padding:8px 14px;font:700 13px Arial,sans-serif;cursor:pointer}
.print-bar button:focus-visible{outline:2px solid #a87f2b;outline-offset:2px}
@media print{body{background:#fff}.print-bar{display:none!important}}`;

const ID_CARD_CSS = `
.id-slot{position:relative;width:85.6mm;height:54mm;margin:12px auto}
.id-card{position:relative;display:flex;flex-direction:column;width:85.6mm;height:54mm;overflow:hidden;border-radius:3.2mm;background:#fff;color:#1b2538;break-inside:avoid;box-shadow:0 1px 2px rgba(16,24,40,.14),0 6px 18px rgba(16,24,40,.16)}
.id-head{position:relative;flex:none;display:flex;align-items:center;gap:2.6mm;height:12.6mm;padding:0 3.4mm;background:linear-gradient(118deg,var(--brand-dark) 0%,var(--brand) 62%,var(--brand) 100%);color:#fff}
.id-head::after{content:"";position:absolute;left:0;right:0;bottom:0;height:.9mm;background:var(--accent)}
.id-mark{flex:none;width:8.6mm;height:8.6mm;border-radius:50%;background:#fff;display:grid;place-items:center;overflow:hidden;box-shadow:0 0 0 .5mm var(--accent)}
.id-mark img{width:100%;height:100%;object-fit:contain;padding:.8mm}
.id-mark span{font:700 3.8mm/1 Georgia,"Times New Roman",serif;color:var(--brand)}
.id-school{min-width:0;flex:1}
.id-school strong{display:block;font:800 3.1mm/1.15 Arial,"Segoe UI",sans-serif;letter-spacing:.035em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.id-school span{display:block;margin-top:.7mm;font:600 2mm/1.2 Arial,"Segoe UI",sans-serif;letter-spacing:.14em;text-transform:uppercase;opacity:.86}
.id-body{position:relative;flex:1;min-height:0;display:flex;align-items:center;gap:3.2mm;padding:2.8mm 3.4mm 2mm;background:linear-gradient(180deg,#fff 0%,var(--tint) 100%);overflow:hidden}
.id-body::before{content:"";position:absolute;inset:0;pointer-events:none;background-size:9mm 9mm}
.category-islamic .id-body::before{background-image:${ISLAMIC_LATTICE}}
.category-western .id-body::before{background-image:repeating-linear-gradient(135deg,rgba(10,35,66,.05) 0 .25mm,transparent .25mm 3mm)}
.id-photo{position:relative;z-index:1;flex:none;width:19.5mm;height:24.5mm;padding:.7mm;border-radius:2.2mm;background:#fff;box-shadow:0 0 0 .3mm var(--accent),0 .7mm 1.8mm rgba(16,24,40,.2)}
.id-photo img,.id-photo-empty{display:block;width:100%;height:100%;border-radius:1.5mm;object-fit:cover}
.id-photo-empty{display:grid;place-items:center;background:var(--brand-soft);color:var(--brand);font:800 8mm Georgia,serif}
.id-info{position:relative;z-index:1;min-width:0;flex:1;display:flex;flex-direction:column;gap:1.3mm}
.id-role{align-self:flex-start;padding:.5mm 1.9mm;border-radius:1mm;background:var(--accent);color:#fff;font:800 1.9mm/1.2 Arial,sans-serif;letter-spacing:.2em;text-transform:uppercase}
.id-name{margin:0;font:700 3.5mm/1.15 Georgia,"Times New Roman",serif;color:var(--brand-dark);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.is-long .id-name{font-size:2.8mm}
.id-fields{margin:0;display:grid;gap:.8mm}
.id-fields div,.id-contact div{display:grid;grid-template-columns:19mm minmax(0,1fr);align-items:baseline;gap:1mm}
.id-fields dt,.id-contact dt{white-space:nowrap;font:700 1.9mm/1.25 Arial,sans-serif;letter-spacing:.05em;text-transform:uppercase;color:#6b7689}
.id-fields dd,.id-contact dd{margin:0;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:700 2.4mm/1.25 Arial,sans-serif;color:#1b2538}
.id-qr{position:relative;z-index:1;flex:none;width:14mm;margin:0;text-align:center}
.id-qr a{display:block;width:14mm;height:14mm}
.id-qr svg{display:block;width:14mm;height:14mm}
.id-qr figcaption{margin-top:.7mm;font:700 1.6mm/1.2 Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#6b7689}
.id-foot{position:relative;flex:none;display:flex;justify-content:space-between;align-items:center;gap:2mm;height:6.2mm;padding:0 3.4mm;background:var(--brand-soft);border-top:.25mm solid var(--accent-soft);font:600 2mm/1 Arial,sans-serif;color:#44506a;letter-spacing:.02em}
.id-foot span{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.id-foot span:last-child{flex:none;color:var(--brand);font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.id-back .id-body{flex-direction:column;align-items:stretch;justify-content:flex-start;gap:1.7mm;padding:2.9mm 3.4mm 2mm}
.id-terms{position:relative;z-index:1;margin:0;font:400 2.2mm/1.42 Georgia,"Times New Roman",serif;color:#354057}
.id-contact{position:relative;z-index:1;margin:0;display:grid;gap:.9mm}
.id-signs{position:relative;z-index:1;margin-top:auto;display:flex;justify-content:space-between;gap:6mm}
.id-signs span{flex:1;padding-top:.9mm;border-top:.3mm solid #475467;font:700 1.8mm/1.2 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6b7689}
.id-side-label{margin:14px 0 2px;text-align:center;font:700 11px/1 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#667085}
`;

const ID_SINGLE_CSS = `
@page{size:85.6mm 54mm;margin:0}
.id-single{padding:0 0 18px}
.id-single .id-slot{margin:0 auto 14px}
.id-single .id-slot:first-of-type{margin-top:4px}
@media screen{.id-single .id-card{box-shadow:0 1px 2px rgba(16,24,40,.14),0 10px 26px rgba(16,24,40,.22)}}
@media print{body{background:#fff}.id-side-label{display:none}.id-single{padding:0}.id-single .id-slot,.id-single .id-slot:first-of-type{margin:0;break-after:page;page-break-after:always}.id-single .id-slot:last-of-type{break-after:auto;page-break-after:auto}.id-card{box-shadow:none}}
`;

// Eight cards per A4 portrait sheet (two columns by four rows) with crop
// marks drawn just outside every card so the cut lines are easy to find.
const ID_SHEET_CSS = `
@page{size:A4 portrait;margin:10mm}
.id-sheet{width:190mm;height:276mm;margin:0 auto;display:grid;grid-template-columns:repeat(2,85.6mm);grid-template-rows:repeat(4,54mm);gap:8mm 10mm;align-content:center;justify-content:center;break-after:page;page-break-after:always}
.id-sheet:last-of-type{break-after:auto;page-break-after:auto}
.id-sheet .id-slot{margin:0}
.id-sheet .id-card{box-shadow:none}
.id-sheet .id-slot::before{content:"";position:absolute;inset:-4mm;pointer-events:none;background:
  linear-gradient(#777,#777) 0 3.5mm/2.5mm .2mm no-repeat,
  linear-gradient(#777,#777) 3.5mm 0/.2mm 2.5mm no-repeat,
  linear-gradient(#777,#777) 91.1mm 3.5mm/2.5mm .2mm no-repeat,
  linear-gradient(#777,#777) 90.1mm 0/.2mm 2.5mm no-repeat,
  linear-gradient(#777,#777) 0 58.5mm/2.5mm .2mm no-repeat,
  linear-gradient(#777,#777) 3.5mm 59.5mm/.2mm 2.5mm no-repeat,
  linear-gradient(#777,#777) 91.1mm 58.5mm/2.5mm .2mm no-repeat,
  linear-gradient(#777,#777) 90.1mm 59.5mm/.2mm 2.5mm no-repeat}
@media screen{.id-sheet{margin:16px auto;background:#fff;box-shadow:0 2px 14px rgba(16,24,40,.12)}}
@media print{body{background:#fff}.id-sheet{margin:0}}
`;

router.get("/id-card/bulk", STAFF, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const classId = toNum(req.query.classId, 0);
  if (!classId) return err(res, 400, "classId is required.");
  const klass = await db.get("SELECT id, name_en FROM classes WHERE id = ? AND madrasa_id = ?", [classId, tid]);
  if (!klass) return err(res, 404, "Class not found.");
  if (req.user.role === "teacher") {
    const scope = await getTeacherAssignments(tid, req.user.id);
    if (!scope.anyClassAnySubject && !scope.assignedClassIds.has(classId)) return err(res, 404, "Class not found.");
  }
  const side = String(req.query.side || "front").toLowerCase() === "back" ? "back" : "front";
  const students = await db.all(`${STUDENT_DOC_SELECT}
    WHERE s.madrasa_id = ? AND s.class_id = ? AND s.status NOT IN ('withdrawn','inactive')
    ORDER BY s.last_name, s.first_name, s.id`, [tid, classId]);
  if (!students.length) return err(res, 404, "No students found in this class.");
  const issued = dateLabel(today());
  const cards = students.map((student) => (side === "back"
    ? idCardBackMarkup(student, issued)
    : idCardFrontMarkup(student, "", issued)));
  const sheets = [];
  for (let i = 0; i < cards.length; i += 8) {
    sheets.push(`<section class="id-sheet">${cards.slice(i, i + 8).map(idSlot).join("")}</section>`);
  }
  noStore(res);
  res.type("html").send(printShell(`ID cards — ${klass.name_en} (${side === "back" ? "backs" : "fronts"})`, ID_CARD_CSS + ID_SHEET_CSS, sheets.join("")));
}));

router.get("/id-card/:studentId", STAFF, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const student = await loadIdCardStudent(req, res, tid, toNum(req.params.studentId, 0)); if (!student) return;
  const issued = dateLabel(today());
  const withQr = ["1", "true", "yes"].includes(String(req.query.qr || "").toLowerCase());
  const qrUrl = withQr ? signedProfileUrl(req, student) : "";
  const body = `<section class="id-single">
    <p class="id-side-label">Front</p>${idSlot(idCardFrontMarkup(student, qrUrl, issued))}
    <p class="id-side-label">Back</p>${idSlot(idCardBackMarkup(student, issued))}
  </section>`;
  noStore(res);
  res.type("html").send(printShell(`ID card — ${studentName(student)}`, ID_CARD_CSS + ID_SINGLE_CSS, body));
}));

/* -------------------------- certificate templates ----------------------- */
function cleanTemplateHtml(value) {
  // The editor is intentionally HTML-based, but stored templates must not be
  // able to execute scripts when a certificate is opened by a staff member.
  return String(value || "").slice(0, MAX_TEMPLATE_LENGTH)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|src)\s*=\s*["']\s*javascript:[^"']*["']/gi, "");
}
function templateType(value) {
  const type = cleanStr(value, 30).toLowerCase();
  return TEMPLATE_TYPES.has(type) ? type : "custom";
}
function normalizeCustomFields(value) {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch (_) { source = {}; }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) source = {};
  const out = {};
  for (let i = 1; i <= 3; i++) out[`custom_field_${i}`] = cleanStr(source[`custom_field_${i}`] ?? source[String(i)] ?? "", MAX_CUSTOM_FIELD_LENGTH);
  return out;
}
function replacePlaceholders(template, values) {
  return cleanTemplateHtml(template).replace(/\{\{\s*(student_name|class|session|date|custom_field_[1-3])\s*\}\}/gi, (_, key) => escapeHtml(values[String(key).toLowerCase()] || ""));
}

router.get(["/templates", "/certificate-templates"], ADMIN, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const templates = await db.all("SELECT id, madrasa_id, name, type, html_template, created_at, archived_at FROM certificate_templates WHERE madrasa_id=? ORDER BY archived_at IS NOT NULL, name, id DESC", [tid]);
  ok(res, { templates });
}));

router.get(["/templates/:id", "/certificate-templates/:id"], ADMIN, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const template = await db.get("SELECT * FROM certificate_templates WHERE id=? AND madrasa_id=?", [toNum(req.params.id, 0), tid]);
  if (!template) return err(res, 404, "Certificate template not found.");
  ok(res, { template });
}));

router.post(["/templates", "/certificate-templates"], ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {}; const name = cleanStr(b.name, 160); const html = cleanTemplateHtml(b.html_template);
  if (!name) return err(res, 400, "Template name is required.");
  if (!html.trim()) return err(res, 400, "HTML template is required.");
  if (String(b.html_template || "").length > MAX_TEMPLATE_LENGTH) return err(res, 400, "HTML template is too large.");
  const requestedType = cleanStr(b.type, 30).toLowerCase();
  if (requestedType && !TEMPLATE_TYPES.has(requestedType)) return err(res, 400, "Invalid certificate template type.");
  const type = requestedType || "custom";
  const result = await db.run("INSERT INTO certificate_templates (madrasa_id,name,type,html_template) VALUES (?,?,?,?)", [tid, name, type, html]);
  logActivity(db, { madrasaId: tid, userId: req.user.id, action: "certificate_template.create", entity: "certificate_template", entityId: String(result.lastInsertRowid), ip: req.ip });
  ok(res, { ok: true, id: result.lastInsertRowid });
}));

router.patch(["/templates/:id", "/certificate-templates/:id"], ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const id = toNum(req.params.id, 0); const existing = await db.get("SELECT * FROM certificate_templates WHERE id=? AND madrasa_id=?", [id, tid]);
  if (!existing) return err(res, 404, "Certificate template not found.");
  const b = req.body || {}; const sets = []; const values = [];
  if (b.name !== undefined) { const name = cleanStr(b.name, 160); if (!name) return err(res, 400, "Template name is required."); sets.push("name=?"); values.push(name); }
  if (b.type !== undefined) { const type = cleanStr(b.type, 30).toLowerCase(); if (!TEMPLATE_TYPES.has(type)) return err(res, 400, "Invalid certificate template type."); sets.push("type=?"); values.push(type); }
  if (b.html_template !== undefined) { if (String(b.html_template).length > MAX_TEMPLATE_LENGTH) return err(res, 400, "HTML template is too large."); const html = cleanTemplateHtml(b.html_template); if (!html.trim()) return err(res, 400, "HTML template is required."); sets.push("html_template=?"); values.push(html); }
  if (b.archived !== undefined) { sets.push("archived_at=?"); values.push(b.archived === true || b.archived === 1 || b.archived === "1" ? today() : null); }
  if (!sets.length) return err(res, 400, "Nothing to update.");
  values.push(id, tid); await db.run(`UPDATE certificate_templates SET ${sets.join(",")} WHERE id=? AND madrasa_id=?`, values);
  ok(res, { ok: true });
}));

/* ------------------------------- certificates --------------------------- */
async function certificateRow(tid, id) {
  return db.get(`
    SELECT c.*, t.name AS template_name, t.type AS template_type, t.html_template,
           s.first_name, s.middle_name, s.last_name, s.admission_no, s.class_id, s.session_id,
           cl.name_en AS class_name, a.label AS session_label,
           m.name_en AS institution_name, m.name_ar AS institution_name_ar, m.logo_path,
           m.motto_en, m.address, m.city, m.state_name, m.category, m.brand_color
    FROM certificates c
    JOIN certificate_templates t ON t.id=c.template_id AND t.madrasa_id=c.madrasa_id
    JOIN students s ON s.id=c.student_id AND s.madrasa_id=c.madrasa_id
    LEFT JOIN classes cl ON cl.id=s.class_id AND cl.madrasa_id=s.madrasa_id
    LEFT JOIN academic_sessions a ON a.id=s.session_id AND a.madrasa_id=s.madrasa_id
    JOIN madaris m ON m.id=c.madrasa_id
    WHERE c.id=? AND c.madrasa_id=?
  `, [id, tid]);
}
function certificateValues(row) {
  return Object.assign({
    student_name: studentName(row),
    class: row.class_name || "",
    session: row.session_label || "",
    date: dateLabel(row.issued_date),
  }, normalizeCustomFields(row.custom_fields));
}
function certificateReference(row) {
  const year = String(row.issued_date || today()).slice(0, 4);
  return `CERT-${year}-${String(row.id).padStart(6, "0")}`;
}

const CERT_CSS = `
@page{size:A4 landscape;margin:0}
.cert-page{position:relative;width:297mm;height:210mm;margin:0 auto;padding:9mm;background:#fff;overflow:hidden;color:#1d2433}
.cert-frame{position:relative;height:192mm;padding:3mm;border:.8mm solid var(--brand)}
.cert-frame::before{content:"";position:absolute;inset:2.2mm;border:.28mm solid var(--accent);pointer-events:none}
.cert-inner{position:relative;height:100%;display:flex;flex-direction:column;padding:8mm 15mm 5.5mm;overflow:hidden;background:linear-gradient(180deg,#fff 0%,var(--tint) 100%)}
.is-islamic .cert-inner::before{content:"";position:absolute;inset:0;pointer-events:none;background-image:${ISLAMIC_LATTICE_CERT};background-size:12mm 12mm}
.cert-inner>*{position:relative}
.cert-head{display:flex;align-items:center;justify-content:center;gap:6mm}
.cert-mark{flex:none;width:19mm;height:19mm;border-radius:50%;background:#fff;display:grid;place-items:center;overflow:hidden;box-shadow:0 0 0 .6mm var(--accent)}
.cert-mark img{width:100%;height:100%;object-fit:contain;padding:1.6mm}
.cert-mark span{font:700 8mm/1 Georgia,"Times New Roman",serif;color:var(--brand)}
.cert-school-name{margin:0;font:700 6.8mm/1.1 Georgia,"Times New Roman",serif;letter-spacing:.05em;text-transform:uppercase;color:var(--brand-dark)}
.cert-school-ar{margin:1.2mm 0 0;font:600 5mm/1.2 "Noto Naskh Arabic","Traditional Arabic",Georgia,serif;color:var(--brand)}
.cert-motto{margin:1.2mm 0 0;font:italic 3.4mm/1.2 Georgia,"Times New Roman",serif;color:#5b6474}
.cert-rule{display:flex;align-items:center;justify-content:center;height:6mm;margin:3mm 0 1mm}
.cert-rule::before,.cert-rule::after{content:"";flex:1;border-top:.3mm solid var(--accent-soft)}
.cert-rule span{flex:none;width:2.6mm;height:2.6mm;margin:0 3mm;background:var(--accent);transform:rotate(45deg)}
.cert-body{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;overflow:hidden;padding:0 8mm;color:#1d2433}
.cert-body h1{margin:0 0 2mm;font:700 13mm/1.05 Georgia,"Times New Roman",serif;letter-spacing:.01em;color:var(--brand-dark)}
.cert-body h2{margin:0 0 2mm;font:600 6.4mm/1.2 Georgia,"Times New Roman",serif;color:var(--brand)}
.cert-body p{margin:1.6mm 0;font:400 4.2mm/1.55 Georgia,"Times New Roman",serif;color:#344054}
.cert-body strong,.cert-body b{font-weight:700;color:var(--brand-dark)}
.cert-body .cert-kicker{margin:0 0 2.5mm;font:700 3.1mm/1.2 Arial,"Segoe UI",sans-serif;letter-spacing:.3em;text-transform:uppercase;color:var(--accent)}
.cert-body .cert-name{margin:0 0 3mm;padding:0 6mm 2mm;border-bottom:.35mm solid var(--accent);font:700 12mm/1.1 Georgia,"Times New Roman",serif;color:var(--brand-dark)}
.cert-body .cert-award{margin:3mm 0 1mm;font:700 6mm/1.2 Georgia,"Times New Roman",serif;color:var(--brand)}
.cert-body .cert-note{margin:0;font-size:3.6mm;color:#667085}
.cert-foot{flex:none;display:grid;grid-template-columns:1fr auto 1fr;align-items:end;gap:8mm;padding:0 10mm;margin-top:2mm}
.cert-sign{display:flex;flex-direction:column;align-items:center;gap:1.4mm}
.cert-sign-line{display:block;width:62mm;height:0;border-top:.3mm solid #475467}
.cert-sign-label{font:700 2.6mm/1 Arial,"Segoe UI",sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#475467}
.cert-seal{width:25mm;height:25mm;border-radius:50%;border:.9mm double var(--accent);background:radial-gradient(circle at 50% 35%,#fff 0%,var(--brand-soft) 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.9mm;box-shadow:0 .8mm 2mm rgba(16,24,40,.18)}
.cert-seal .cert-mark{width:12.5mm;height:12.5mm;box-shadow:none;background:transparent}
.cert-seal .cert-mark span{font-size:6mm}
.cert-seal small{font:700 1.7mm/1 Arial,"Segoe UI",sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--brand)}
.cert-meta{flex:none;display:flex;justify-content:space-between;gap:6mm;margin:3mm 0 0;font:600 2.5mm/1 Arial,"Segoe UI",sans-serif;letter-spacing:.03em;color:#667085}
.cert-corner{position:absolute;z-index:2;pointer-events:none}
.is-western .cert-corner{width:11mm;height:11mm;border:0 solid var(--accent)}
.is-western .cert-corner.tl{top:-.8mm;left:-.8mm;border-top-width:1.4mm;border-left-width:1.4mm}
.is-western .cert-corner.tr{top:-.8mm;right:-.8mm;border-top-width:1.4mm;border-right-width:1.4mm}
.is-western .cert-corner.bl{bottom:-.8mm;left:-.8mm;border-bottom-width:1.4mm;border-left-width:1.4mm}
.is-western .cert-corner.br{bottom:-.8mm;right:-.8mm;border-bottom-width:1.4mm;border-right-width:1.4mm}
.is-islamic .cert-corner{width:10mm;height:10mm;background:#fff;border:.9mm solid var(--accent);transform:rotate(45deg)}
.is-islamic .cert-corner.tl{top:-5mm;left:-5mm}
.is-islamic .cert-corner.tr{top:-5mm;right:-5mm}
.is-islamic .cert-corner.bl{bottom:-5mm;left:-5mm}
.is-islamic .cert-corner.br{bottom:-5mm;right:-5mm}
@media print{body{background:#fff}.cert-page{margin:0}}
`;

/** Full A4-landscape certificate: frame, school identity, template body, signatures. */
function certificateDocument({ title, school, body, ref, issued, templateName, interactive }) {
  const theme = documentTheme(school);
  const corners = ["tl", "tr", "bl", "br"].map((p) => `<span class="cert-corner ${p}"></span>`).join("");
  const markup = `<main class="cert-page ${theme.western ? "is-western" : "is-islamic"}" style="${themeStyle(theme)}">
    <div class="cert-frame">${corners}<div class="cert-inner">
      <header class="cert-head">
        <div class="cert-mark">${schoolMark(school)}</div>
        <div class="cert-school">
          <p class="cert-school-name">${escapeHtml(school.name || "School")}</p>
          ${school.nameAr ? `<p class="cert-school-ar" dir="rtl" lang="ar">${escapeHtml(school.nameAr)}</p>` : ""}
          ${school.motto ? `<p class="cert-motto">${escapeHtml(school.motto)}</p>` : ""}
        </div>
      </header>
      <div class="cert-rule" aria-hidden="true"><span></span></div>
      <div class="cert-body">${body}</div>
      <footer class="cert-foot">
        <div class="cert-sign"><span class="cert-sign-line"></span><span class="cert-sign-label">Principal</span></div>
        <div class="cert-seal" aria-label="Official seal"><div class="cert-mark">${schoolMark(school)}</div><small>Official seal</small></div>
        <div class="cert-sign"><span class="cert-sign-line"></span><span class="cert-sign-label">Class teacher</span></div>
      </footer>
      <p class="cert-meta"><span>Ref. ${escapeHtml(ref)}</span><span>${escapeHtml(templateName || "Certificate")}</span><span>Issued ${escapeHtml(issued)}</span></p>
    </div></div>
  </main>`;
  return printShell(title, CERT_CSS, markup, { interactive });
}

function renderCertificate(row) {
  return certificateDocument({
    title: `Certificate — ${studentName(row)}`,
    school: schoolIdentity(row),
    body: replacePlaceholders(row.html_template, certificateValues(row)),
    ref: certificateReference(row),
    issued: dateLabel(row.issued_date),
    templateName: row.template_name,
    interactive: true,
  });
}

/** Live preview in the template editor: same renderer, sample data, no print bar. */
function renderCertificatePreview(school, html) {
  const issued = dateLabel(today());
  const values = {
    student_name: "Amina Yusuf", class: "Class 6", session: "2026/2027", date: issued,
    custom_field_1: "Outstanding character", custom_field_2: "Principal's Award", custom_field_3: "",
  };
  return certificateDocument({
    title: "Certificate preview",
    school,
    body: replacePlaceholders(html, values),
    ref: `CERT-${today().slice(0, 4)}-000001`,
    issued,
    templateName: "Preview",
    interactive: false,
  });
}

router.post(["/templates/preview", "/certificate-templates/preview"], ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const raw = (req.body && req.body.html_template) || "";
  if (String(raw).length > MAX_TEMPLATE_LENGTH) return err(res, 400, "HTML template is too large.");
  const madrasa = await db.get(`SELECT name_en AS institution_name, name_ar AS institution_name_ar, logo_path,
      motto_en, address, city, state_name, phone, category, brand_color FROM madaris WHERE id = ?`, [tid]);
  if (!madrasa) return err(res, 404, "Madrasa not found.");
  noStore(res);
  res.type("html").send(renderCertificatePreview(schoolIdentity(madrasa), cleanTemplateHtml(raw)));
}));

router.post("/certificates", ADMIN, requireStaffPermission("documents.generate"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const b = req.body || {};
  const templateId = toNum(b.template_id, 0);
  const template = await db.get("SELECT id FROM certificate_templates WHERE id=? AND madrasa_id=? AND archived_at IS NULL", [templateId, tid]);
  if (!template) return err(res, 400, "Active certificate template not found.");
  let ids = Array.isArray(b.student_ids) ? b.student_ids : (b.student_id !== undefined ? [b.student_id] : []);
  ids = [...new Set(ids.map((id) => toNum(id, 0)).filter((id) => id > 0))];
  if (!ids.length) return err(res, 400, "At least one student_id is required.");
  const issuedDate = b.issued_date === undefined || b.issued_date === "" ? today() : validDate(b.issued_date);
  if (!issuedDate) return err(res, 400, "issued_date must be YYYY-MM-DD.");
  const customFields = normalizeCustomFields(b.custom_fields);
  const students = [];
  for (const id of ids) {
    const row = await db.get("SELECT id FROM students WHERE id=? AND madrasa_id=?", [id, tid]);
    if (!row) return err(res, 400, "One or more students were not found in this madrasa.");
    students.push(row.id);
  }
  const created = await db.transaction(async (tx) => {
    const out = [];
    for (const id of students) {
      const r = await tx.run("INSERT INTO certificates (madrasa_id,student_id,template_id,custom_fields,issued_date) VALUES (?,?,?,?,?)", [tid, id, templateId, JSON.stringify(customFields), issuedDate]);
      out.push(Number(r.lastInsertRowid));
    }
    return out;
  });
  for (const id of created) logActivity(db, { madrasaId: tid, userId: req.user.id, action: "certificate.issue", entity: "certificate", entityId: String(id), meta: { templateId, issuedDate }, ip: req.ip });
  ok(res, { ok: true, id: created[0], ids: created });
}));

router.get("/certificates", STAFF, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const where = ["c.madrasa_id=?"]; const params = [tid];
  if (req.query.studentId !== undefined) { const studentId = toNum(req.query.studentId, 0); if (!studentId) return err(res, 400, "studentId must be a valid id."); where.push("c.student_id=?"); params.push(studentId); }
  const rows = await db.all(`SELECT c.id,c.madrasa_id,c.student_id,c.template_id,c.custom_fields,c.issued_date,c.created_at,t.name AS template_name,t.type AS template_type,s.first_name,s.middle_name,s.last_name,s.admission_no FROM certificates c JOIN certificate_templates t ON t.id=c.template_id AND t.madrasa_id=c.madrasa_id JOIN students s ON s.id=c.student_id AND s.madrasa_id=c.madrasa_id WHERE ${where.join(" AND ")} ORDER BY c.issued_date DESC,c.id DESC LIMIT 500`, params);
  ok(res, { certificates: rows.map((row) => Object.assign({}, row, { student_name: studentName(row) })) });
}));

router.get("/certificates/:id", STAFF, requireStaffPermission("documents.view"), asyncHandler(async (req, res) => {
  const tid = await tenantId(req, res); if (tid == null) return;
  const row = await certificateRow(tid, toNum(req.params.id, 0));
  if (!row) return res.status(404).type("html").send("Certificate not found");
  if (!await assertTeacherCanSee(req, res, tid, row)) return;
  res.type("html").send(renderCertificate(row));
}));

module.exports = router;
module.exports._private = { qrSvg, replacePlaceholders, renderCertificate, renderCertificatePreview, idCardFrontMarkup, idCardBackMarkup, documentTheme };
