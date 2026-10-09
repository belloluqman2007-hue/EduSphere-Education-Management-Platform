"use strict";
/* ============================================================================
   EduSphere — shared print-document toolkit
   ----------------------------------------------------------------------------
   ID cards and certificates are server-rendered HTML that the browser prints.
   The rendering helpers live here (not inside the route file) because three
   surfaces need exactly the same look:

     • the printable card / certificate itself
     • the live preview inside the dashboard editor
     • the public "scan to verify" page a phone opens from a QR code

   Keeping ONE copy of the palette and the QR encoder is what stops a printed
   card and its on-screen preview drifting apart.

   This module returns HTML fragments and CSS only. Every value that comes
   from the database passes through escapeHtml(), so no stored field can
   inject markup into a page that a staff member (or a stranger, for the
   public verification page) opens.
   ========================================================================== */

/* ------------------------------ text safety ----------------------------- */
function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Uploaded images only — never a remote URL and never a javascript: target. */
function safeAssetPath(value) {
  const path = String(value === null || value === undefined ? "" : value).trim().slice(0, 500);
  return /^\/uploads\/[A-Za-z0-9_./-]+$/.test(path) ? path : "";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dateLabel(value) {
  const raw = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const [year, month, day] = raw.split("-");
  const monthName = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(month) - 1];
  return monthName ? `${Number(day)} ${monthName} ${year}` : `${day}/${month}/${year}`;
}

function shortDateLabel(value) {
  const raw = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const [year, month, day] = raw.split("-");
  return `${day}/${month}/${year}`;
}

/** First line of a school's address block, for the tiny print on a card. */
function oneLine(value, max = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

/* --------------------------------- theme -------------------------------- */
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

/** Normalises one row from `madaris` (aliased by the queries) for rendering. */
function schoolIdentity(row) {
  return {
    name: row.institution_name || "",
    nameAr: row.institution_name_ar || "",
    logo: safeAssetPath(row.logo_path),
    badge: safeAssetPath(row.badge_path),
    motto: row.motto_en || "",
    address: [row.address, row.city, row.state_name].filter(Boolean).join(", "),
    phone: row.phone || "",
    category: row.category || "",
    institutionType: row.institution_type || "",
    brandColor: row.brand_color || "",
  };
}

/**
 * Visual identity for one school. `category` is normalised loosely: the school
 * rows that reach here come from four different queries, and a Western academy
 * stored as `Academy` / `Comprehensive` must not be printed in madrasa green.
 */
function documentTheme(school, overrides = {}) {
  const WESTERN_HINT = /^(western|academy|comprehensive|secondary|high school|primary|nursery|montessori|college)$/i;
  const raw = String(school.category || "").trim().toLowerCase();
  const key = raw === "western" || WESTERN_HINT.test(String(school.institutionType || raw)) ? "western" : "islamic";
  const palette = DOC_PALETTE[key];
  const explicit = HEX_COLOR.test(String(overrides.accentColor || "")) ? overrides.accentColor : "";
  const brand = explicit || (HEX_COLOR.test(String(school.brandColor || "")) ? school.brandColor : palette.brand);
  return {
    western: key === "western",
    brand,
    brandDark: mixHex(brand, "#000000", 0.32),
    brandDeep: mixHex(brand, "#000000", 0.55),
    brandSoft: mixHex(brand, "#ffffff", 0.9),
    brandMid: mixHex(brand, "#ffffff", 0.72),
    tint: mixHex(brand, "#ffffff", 0.965),
    accent: HEX_COLOR.test(String(overrides.accentColor || "")) ? palette.accent : palette.accent,
    accentSoft: mixHex(palette.accent, "#ffffff", 0.6),
    accentInk: mixHex(palette.accent, "#000000", 0.15),
  };
}

function themeStyle(theme) {
  return `--brand:${theme.brand};--brand-dark:${theme.brandDark};--brand-deep:${theme.brandDeep};`
    + `--brand-soft:${theme.brandSoft};--brand-mid:${theme.brandMid};--tint:${theme.tint};`
    + `--accent:${theme.accent};--accent-soft:${theme.accentSoft};--accent-ink:${theme.accentInk}`;
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

/** School mark: the uploaded logo when there is one, otherwise a monogram. */
function schoolMark(school, sizeClass = "") {
  if (school.badge || school.logo) {
    return `<img src="${escapeHtml(school.badge || school.logo)}" alt="">`;
  }
  return `<span${sizeClass ? ` class="${sizeClass}"` : ""}>${escapeHtml(String(school.name || "S").trim().slice(0, 1).toUpperCase() || "S")}</span>`;
}

/* --------------------------------- QR code --------------------------------
   A dependency-free encoder, kept in-process because printable pages must
   work offline and adding a package for a QR code is not worth it. It covers
   byte-mode versions 1–10 at error-correction level L — up to 295 bytes, far
   more than a `/verify/<code>` URL needs.
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
  { version: 10, blocks: 2, total: 86, data: 68, ecc: 18 },
];
const QR_ALIGNMENT = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

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
    for (let i = 1; line && i < line.length; i++) {
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

/**
 * QR code as inline SVG. Returns "" when the payload does not fit, so a
 * caller can leave the ornament out instead of printing a broken symbol.
 */
function qrSvg(text, options = {}) {
  const candidates = Array.from({ length: 8 }, (_, mask) => ({ mask, matrix: qrMatrix(text, mask) })).filter((x) => x.matrix);
  if (!candidates.length) return "";
  const chosen = candidates.reduce((best, current) => qrPenalty(current.matrix) < qrPenalty(best.matrix) ? current : best);
  const matrix = chosen.matrix; const size = matrix.length; const paths = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r][c]) paths.push(`M${c} ${r}h1v1h-1z`);
  const fg = options.color || "#0f172a";
  const bg = options.background || "#ffffff";
  const label = options.label || "QR code";
  return `<svg class="qr-code" viewBox="-4 -4 ${size + 8} ${size + 8}" role="img" aria-label="${escapeHtml(label)}" shape-rendering="crispEdges"><rect x="-4" y="-4" width="${size + 8}" height="${size + 8}" fill="${escapeHtml(bg)}"/><path d="${paths.join("")}" fill="${escapeHtml(fg)}"/></svg>`;
}

/** Byte capacity of the encoder, used by tests and by the size guard below. */
const QR_MAX_BYTES = 295;

/* ----------------------------- print page shell -------------------------- */
const PRINT_BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#e6ebf2;color:#172033;font-family:Arial,"Segoe UI",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.print-bar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:#101a2e;color:#fff;font:600 13px/1.3 Arial,"Segoe UI",sans-serif;box-shadow:0 2px 12px rgba(16,24,40,.2)}
.print-bar .pb-title{min-width:0;display:flex;align-items:center;gap:10px;overflow:hidden}
.print-bar .pb-title span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.92}
.print-bar .pb-badge{flex:none;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.16);font:700 10px/1.6 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase}
.print-bar .pb-actions{flex:none;display:flex;align-items:center;gap:8px}
.print-bar button,.print-bar a.bar-link{border:0;border-radius:8px;background:#fff;color:#101a2e;padding:8px 14px;font:700 13px Arial,sans-serif;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.print-bar button.ghost,.print-bar a.bar-link{background:rgba(255,255,255,.14);color:#fff}
.print-bar button:focus-visible,.print-bar a.bar-link:focus-visible{outline:2px solid #f2c14e;outline-offset:2px}
@media print{body{background:#fff}.print-bar{display:none!important}}`;

/**
 * Wraps a printable document. `interactive` adds the print toolbar; the
 * preview inside the editor turns it off. Scripts are separate files only,
 * because the platform CSP is script-src 'self'.
 */
function printShell(title, css, body, options = {}) {
  const { interactive = true, badge = "", actions = "", lang = "en", dir = "ltr" } = options;
  const bar = interactive
    ? `<div class="print-bar"><div class="pb-title">${badge ? `<span class="pb-badge">${escapeHtml(badge)}</span>` : ""}<span>${escapeHtml(title)}</span></div><div class="pb-actions">${actions}<button id="printPageBtn" type="button">Print / Save as PDF</button></div></div>`
    : "";
  const script = interactive ? '<script src="/js/print.js"></script>' : "";
  return `<!doctype html><html lang="${escapeHtml(lang)}" dir="${dir}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${PRINT_BASE_CSS}\n${css}</style></head><body>${bar}${body}${script}</body></html>`;
}

/** Scannable QR block with its caption — shared by card, certificate and page. */
function qrBlock(url, options = {}) {
  if (!url || Buffer.byteLength(String(url), "utf8") > QR_MAX_BYTES) return "";
  const svg = qrSvg(url, { label: options.label || "Scan to verify this card" });
  if (!svg) return "";
  const caption = options.caption === false ? "" : `<figcaption>${escapeHtml(options.captionText || "Scan to verify")}</figcaption>`;
  return `<figure class="${escapeHtml(options.className || "qr-block")}"><a href="${escapeHtml(url)}" rel="noopener" aria-label="${escapeHtml(options.linkLabel || "Open verification page")}">${svg}</a>${caption}</figure>`;
}

module.exports = {
  DOC_PALETTE,
  ISLAMIC_LATTICE,
  ISLAMIC_LATTICE_CERT,
  QR_MAX_BYTES,
  dateLabel,
  documentTheme,
  escapeHtml,
  mixHex,
  oneLine,
  patternUrl,
  printShell,
  qrBlock,
  qrSvg,
  safeAssetPath,
  schoolIdentity,
  schoolMark,
  shortDateLabel,
  themeStyle,
  today,
};
