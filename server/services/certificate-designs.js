"use strict";
/* ============================================================================
   EduSphere — certificate designs
   ----------------------------------------------------------------------------
   WHY THIS FILE EXISTS
   A certificate template used to be a box of raw HTML plus {{placeholders}},
   which asked a school administrator to be a web developer: the only way to
   change a certificate was to edit markup, and the only way to break one was
   to lose a closing tag. Nobody signs up to run a school for that.

   So a template is now two ordinary decisions:
     1. pick a design from a gallery, and
     2. fill in a form (title, wording, which details to print, who signs).
   The wording is plain text with a handful of {{tokens}}. The designs here
   turn that into a printable A4 document — there is nothing to write, and
   nothing to get wrong.

   Every design is one CSS block scoped under `.cert-design-<key>` plus a small
   amount of optional ornament markup. No external assets, no webfonts, no
   JavaScript: the same output prints from the school's own browser and from a
   stranger's phone after a QR scan.
   ========================================================================== */
const {
  escapeHtml,
  safeAssetPath,
  schoolMark,
  themeStyle,
  documentTheme,
  patternUrl,
  DOC_PALETTE,
  ISLAMIC_LATTICE_CERT,
  dateLabel,
  qrBlock,
} = require("./print-documents");

const CERT_TYPES = ["graduation", "achievement", "completion", "participation", "merit", "appreciation", "custom"];

/* What each kind of certificate says by default — the form is pre-filled, not
   blank, so a school can print a correct certificate without typing. */
const TYPE_DEFAULTS = {
  graduation: { title: "Certificate of Graduation", award: "Graduated with Honours", kicker: "This is to certify that" },
  achievement: { title: "Certificate of Achievement", award: "Outstanding Achievement", kicker: "This is proudly presented to" },
  completion: { title: "Certificate of Completion", award: "Successfully Completed", kicker: "This is to certify that" },
  participation: { title: "Certificate of Participation", award: "Active Participation", kicker: "This is to acknowledge" },
  merit: { title: "Certificate of Merit", award: "Awarded for Academic Merit", kicker: "This is to certify that" },
  appreciation: { title: "Letter of Appreciation", award: "Grateful Appreciation", kicker: "With sincere thanks to" },
  custom: { title: "Certificate", award: "", kicker: "This is to certify that" },
};

/* The tokens a school can drop into the wording. Everything a printable
   certificate legitimately needs, and nothing else. */
const TOKENS = [
  { token: "holder_name", label: "Full name", hint: "student or staff" },
  { token: "identifier", label: "Admission / staff ID" },
  { token: "class", label: "Class or department" },
  { token: "session", label: "Academic session" },
  { token: "term", label: "Term" },
  { token: "program", label: "Programme" },
  { token: "school", label: "School name" },
  { token: "award", label: "Award line" },
  { token: "date", label: "Date of issue" },
  { token: "reference", label: "Certificate number" },
  { token: "custom_field_1", label: "Custom 1" },
  { token: "custom_field_2", label: "Custom 2" },
  { token: "custom_field_3", label: "Custom 3" },
];

/* Which facts a certificate can carry, and where each one comes from. */
const FACTS = [
  { key: "identifier", label: "Admission No." },
  { key: "class", label: "Class" },
  { key: "session", label: "Session" },
  { key: "term", label: "Term" },
  { key: "program", label: "Programme" },
  { key: "track", label: "Track" },
  { key: "result", label: "Result / grade" },
  { key: "date", label: "Date" },
];

/* --------------------------- ornament fragments ---------------------------
   Hand-written SVG so the documents stay self-contained. They are decorative
   (aria-hidden) and never the only carrier of information.
-------------------------------------------------------------------------- */
const LAUREL_SVG = `<svg class="cert-laurel" viewBox="0 0 120 60" aria-hidden="true" focusable="false">
  <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <path d="M58 54C36 48 22 36 18 20"/>
    <path d="M62 54c22-6 36-18 40-34"/>
    <g>
      <path d="M18 20c-6 1-10-2-12-7 6-2 10 0 12 7z"/><path d="M23 29c-6 0-10-4-11-9 6-1 10 2 11 9z"/>
      <path d="M30 37c-6 0-10-3-12-8 6-1 10 1 12 8z"/><path d="M39 43c-5 1-10-1-12-6 6-2 10 0 12 6z"/>
      <path d="M49 48c-5 2-10 0-13-5 6-2 11-1 13 5z"/>
    </g>
    <g>
      <path d="M102 20c6 1 10-2 12-7-6-2-10 0-12 7z"/><path d="M97 29c6 0 10-4 11-9-6-1-10 2-11 9z"/>
      <path d="M90 37c6 0 10-3 12-8-6-1-10 1-12 8z"/><path d="M81 43c5 1 10-1 12-6-6-2-10 0-12 6z"/>
      <path d="M71 48c5 2 10 0 13-5-6-2-11-1-13 5z"/>
    </g>
  </g>
</svg>`;

const CREST_SVG = (monogram) => `<svg class="cert-crest" viewBox="0 0 60 68" aria-hidden="true" focusable="false">
  <path d="M30 2 57 10v27c0 15-12 24-27 29C15 61 3 52 3 37V10z" fill="none" stroke="currentColor" stroke-width="2.4"/>
  <path d="M30 9 50 15v22c0 11-9 18-20 22-11-4-20-11-20-22V15z" fill="currentColor" opacity=".08"/>
  <text x="30" y="41" text-anchor="middle" font-family="Georgia,serif" font-size="21" font-weight="700" fill="currentColor">${escapeHtml(monogram)}</text>
</svg>`;

function starLattice(category) {
  return category === "islamic" ? ISLAMIC_LATTICE_CERT : patternUrl(DOC_PALETTE.western.accent, 0.09);
}

/* ------------------------------- the designs ------------------------------
   layout flags per design:
     header : centered | band | side
     photo  : framed | circle | aside | none
     name   : ruled | plain | outline
     edges  : frame | edge-band | open
-------------------------------------------------------------------------- */
const DESIGNS = [
  {
    key: "heritage",
    name: "Heritage Classic",
    tagline: "Double-rule frame, gold details, timeless serif centre.",
    mood: "Formal",
    suits: ["graduation", "completion", "merit"],
    swatch: "linear-gradient(135deg,#14532d 0%,#1c6b3c 55%,#a87f2b 100%)",
    layout: { header: "centered", photo: "framed", name: "ruled", edges: "frame" },
    ornament: "corners-diamond",
  },
  {
    key: "royal",
    name: "Royal Crest",
    tagline: "Deep colour band with a school crest and a printed seal.",
    mood: "Prestigious",
    suits: ["graduation", "achievement", "appreciation"],
    swatch: "linear-gradient(140deg,#0a2342 0%,#123a67 60%,#c9a227 100%)",
    layout: { header: "band", photo: "framed", name: "outline", edges: "frame" },
    ornament: "crest",
  },
  {
    key: "modern",
    name: "Modern Minimal",
    tagline: "Flat white, one strong accent line, sans-serif clarity.",
    mood: "Contemporary",
    suits: ["completion", "participation", "custom"],
    swatch: "linear-gradient(120deg,#0f172a 0%,#334155 60%,#38bdf8 100%)",
    layout: { header: "side", photo: "circle", name: "plain", edges: "open" },
    ornament: "edge-line",
  },
  {
    key: "geometric",
    name: "Islamic Geometric",
    tagline: "Star lattice, arched panel and the Arabic name set large.",
    mood: "Traditional",
    suits: ["graduation", "merit", "appreciation"],
    swatch: "linear-gradient(135deg,#0b3d24 0%,#14532d 50%,#c8a24a 100%)",
    layout: { header: "centered", photo: "framed", name: "ruled", edges: "arch" },
    ornament: "lattice",
  },
  {
    key: "laurel",
    name: "Laurel Merit",
    tagline: "Wreath around the award — made for results and honours.",
    mood: "Celebratory",
    suits: ["merit", "achievement", "participation"],
    swatch: "linear-gradient(135deg,#1f2937 0%,#4b5563 55%,#b45309 100%)",
    layout: { header: "centered", photo: "circle", name: "plain", edges: "frame" },
    ornament: "laurel",
  },
  {
    key: "ribbon",
    name: "Achievement Ribbon",
    tagline: "Corner ribbon and a bold award block. Loud in a good way.",
    mood: "Energetic",
    suits: ["achievement", "participation", "custom"],
    swatch: "linear-gradient(135deg,#3b0764 0%,#6d28d9 55%,#f0abfc 100%)",
    layout: { header: "side", photo: "aside", name: "outline", edges: "edge-band" },
    ornament: "ribbon",
  },
  {
    key: "executive",
    name: "Executive Ledger",
    tagline: "Ruled header, ledger detail table, monogram seal.",
    mood: "Corporate",
    suits: ["completion", "appreciation", "custom"],
    swatch: "linear-gradient(140deg,#111827 0%,#1f2937 55%,#94a3b8 100%)",
    layout: { header: "band", photo: "aside", name: "plain", edges: "open" },
    ornament: "crest",
  },
];

const DESIGN_BY_KEY = new Map(DESIGNS.map((design) => [design.key, design]));
const DEFAULT_DESIGN = "heritage";

function designByKey(key) {
  const clean = String(key || "").trim().toLowerCase();
  if (DESIGN_BY_KEY.has(clean)) return DESIGN_BY_KEY.get(clean);
  return null;
}

function designList() {
  return DESIGNS.map((design) => ({
    key: design.key,
    name: design.name,
    tagline: design.tagline,
    mood: design.mood,
    suits: design.suits.slice(),
    swatch: design.swatch,
    layout: design.layout,
    ornament: design.ornament,
  }));
}

/* ------------------------------ the config -------------------------------
   A template's `config` JSON is the whole design brief. Unknown keys are
   dropped and every value is bounded, so a stored template can never carry a
   megabyte of text or a stray tag into the renderer.
-------------------------------------------------------------------------- */
const TEXT_LIMITS = { eyebrow: 60, title: 160, kicker: 200, body: 900, award: 200, closing: 240, footerNote: 200, watermark: 40 };
const BOOL_KEYS = ["showPhoto", "showFacts", "showAward", "showSeal", "showQr", "showWatermark", "showArabic", "showMotto", "showSignatureDates", "showHolderStatus"];
/* What a certificate prints under the name. `term` and `result` are here
   because they are the two facts a school most often types when it issues one,
   and a certificate that quietly drops them is worse than one with fewer lines.
   A fact with no value is skipped, so an empty term never prints as a blank. */
const DEFAULT_FACTS = ["identifier", "class", "session", "term", "program", "result", "date"];

function cleanText(value, max) {
  return String(value === null || value === undefined ? "" : value).replace(/<[^>]*>/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max);
}

function cleanMultiline(value, max) {
  const raw = String(value === null || value === undefined ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/<[^>]*>/g, " ")
    // Tabs and long runs of spaces are already flattened to one space above;
    // this keeps the paragraph breaks a person pressed Enter to create.
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return raw.slice(0, max);
}

function cleanHex(value) {
  const s = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : "";
}

function normaliseSignatory(input, index) {
  const source = input && typeof input === "object" ? input : {};
  const label = cleanText(source.label, 60) || (index === 0 ? "Principal" : index === 1 ? "Class Teacher" : "Witness");
  const signature = safeAssetPath(source.signaturePath || source.signature_path);
  const out = {
    label,
    name: cleanText(source.name, 120),
    title: cleanText(source.title, 80),
    signaturePath: signature,
    // `userId`, `user_id` and `signatureUserId` all name the same thing: the
    // staff account whose saved signature should print here.
    userId: [source.userId, source.user_id, source.signatureUserId, source.signature_user_id]
      .map((value) => Number(value)).find((value) => Number.isFinite(value) && value > 0) || 0,
    showSignature: source.showSignature !== false && source.show_signature !== false,
    showDate: source.showDate !== false && source.show_date !== false,
  };
  return out;
}

function normaliseConfig(input, options = {}) {
  const source = input && typeof input === "object" ? input : {};
  const type = CERT_TYPES.includes(String(source.type || "").toLowerCase()) ? String(source.type).toLowerCase() : (options.type || "custom");
  const designKey = designByKey(source.designKey || source.design_key) ? String(source.designKey || source.design_key).toLowerCase() : (options.designKey || DEFAULT_DESIGN);
  const design = designByKey(designKey) || DESIGN_BY_KEY.get(DEFAULT_DESIGN);
  const defaults = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.custom;

  const config = {
    designKey: design.key,
    type,
    accentColor: cleanHex(source.accentColor || source.accent_color),
    paper: source.paper === "tinted" ? "tinted" : "white",
    layout: design.layout,
  };
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    const given = source[key] !== undefined ? source[key] : defaults[key];
    config[key] = key === "body" ? cleanMultiline(given, max) : cleanText(given, max);
  }
  if (!config.title) config.title = defaults.title;
  if (!config.body) config.body = defaultBody(type);

  for (const key of BOOL_KEYS) {
    const value = source[key] !== undefined ? source[key] : source[key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())];
    config[key] = value === undefined ? key !== "showWatermark" : !(value === false || value === 0 || value === "0" || value === "false");
  }

  const factsRaw = Array.isArray(source.facts) ? source.facts : DEFAULT_FACTS;
  const allowed = new Set(FACTS.map((f) => f.key));
  const facts = factsRaw.map((f) => cleanText(typeof f === "string" ? f : f && f.key, 24)).filter((f) => allowed.has(f));
  config.facts = [...new Set(facts)].slice(0, 8);

  const custom = source.customFields && typeof source.customFields === "object" ? source.customFields : source.custom_fields || {};
  config.customFields = {
    custom_field_1: cleanText(custom.custom_field_1, 500),
    custom_field_2: cleanText(custom.custom_field_2, 500),
    custom_field_3: cleanText(custom.custom_field_3, 500),
  };

  const signatories = (Array.isArray(source.signatories) ? source.signatories : [])
    .map((sig, index) => normaliseSignatory(sig, index))
    .slice(0, 3);
  config.signatories = signatories.length ? signatories : [
    normaliseSignatory({ label: "Principal" }, 0),
    normaliseSignatory({ label: "Class Teacher" }, 1),
  ];
  return config;
}

/* --------------------------------------------------------------------------
   Legacy conversion
   ----------------------------------------------------------------------------
   Templates written before this change stored a block of HTML. Rather than
   keep an HTML editor (and its sanitiser) alive forever, the stored markup is
   reduced to plain text and mapped onto the fields it was clearly using:
   `cert-kicker` → kicker, `cert-name` → the holder token, `cert-award` → award,
   `cert-note` → closing. Anything left over becomes the body. The result is a
   normal config, printable by the same renderer as a hand-built one.
-------------------------------------------------------------------------- */
const LEGACY_CLASSES = [
  ["cert-kicker", "kicker"],
  ["cert-name", "name"],
  ["cert-award", "award"],
  ["cert-note", "note"],
];

function textOf(fragment) {
  return cleanMultiline(
    String(fragment || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/h[1-6]>|<\/div>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
    TEXT_LIMITS.body
  );
}

function legacyConfigFromHtml(html) {
  let source = String(html || "").slice(0, 200000);
  const picked = {};
  // First pass: lift out the blocks that already correspond to a field, and
  // blank them in the source so the wording below does not repeat them.
  const blockPattern = /<([a-z0-9]+)([^>]*class="([^"]*)"[^>]*)>([\s\S]*?)<\/\1>/gi;
  source = source.replace(blockPattern, (block, tag, attrs, classes, inner) => {
    for (const [className, field] of LEGACY_CLASSES) {
      if (new RegExp(`\\b${className}\\b`).test(String(classes || ""))) {
        if (!picked[field]) picked[field] = textOf(inner);
        return "";
      }
    }
    return block;
  });
  const parts = [];
  const otherPattern = /<([a-z0-9]+)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = otherPattern.exec(source))) {
    if (/^(?:p|div|h[1-6]|li|blockquote|td)$/.test(match[1])) {
      const text = textOf(match[3]);
      if (text) parts.push(text);
    }
  }
  // A title cannot be inferred from a body paragraph, and a certificate with
  // no title looks broken, so the first line of a heading is reused.
  const heading = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(source);
  const title = heading ? cleanText(textOf(heading[1]), TEXT_LIMITS.title) : "";
  const body = parts.length ? [...new Set(parts)].join("\n\n") : "";
  // An <h1> that only restates the body's first line is a heading, not a
  // sentence — drop the duplicate so the certificate does not print it twice.
  const deDuplicated = title && body.split("\n\n")[0] === title ? body.split("\n\n").slice(1).join("\n\n") : body;
  const config = {
    title: title && !/certificate of/i.test(title) ? "" : title,
    kicker: picked.kicker || "",
    award: picked.award || "",
    closing: picked.note || "",
    body: deDuplicated && deDuplicated !== title ? deDuplicated : "",
  };
  // A paragraph-level sweep cannot see inline markup, and an old template that
  // printed `{{custom_field_1}}` inside a <strong> would otherwise lose that
  // information in conversion. Any token the source mentions and the fields
  // above dropped is re-attached to the body, where the school can see it,
  // rename it or delete it deliberately.
  const flat = textOf(source);
  const assembled = Object.keys(config).map((key) => String(config[key] || "")).join(" ");
  // The holder's name is printed by the layout itself, in large type, so a
  // template that only used a token to restate it is not missing anything.
  const IMPLIED = ["holder_name", "student_name", "name", "full_name"];
  const lostTokens = [];
  const tokenPattern = /\{\{\s*[a-z0-9_]+\s*\}\}/gi;
  let tokenMatch;
  while ((tokenMatch = tokenPattern.exec(flat))) {
    const token = tokenMatch[0];
    const key = token.replace(/[^a-z0-9_]/gi, "").toLowerCase();
    if (IMPLIED.indexOf(key) >= 0) continue;
    if (assembled.indexOf(token) < 0 && lostTokens.indexOf(token) < 0) lostTokens.push(token);
  }
  if (lostTokens.length) {
    config.body = [config.body, lostTokens.join(" · ")].filter(Boolean).join("\n\n");
  }
  // {{student_name}} was the only name token; the new one is holder_name.
  for (const key of ["kicker", "award", "closing", "body"]) {
    config[key] = String(config[key] || "").replace(/\{\{\s*student_name\s*\}\}/gi, "{{holder_name}}");
  }
  Object.keys(config).forEach((key) => { if (!config[key]) delete config[key]; });
  return config;
}

function defaultBody(type) {
  switch (type) {
    case "graduation":
      return "{{holder_name}}, admission number {{identifier}}, has satisfactorily completed the requirements of {{program}} in {{class}} for the {{session}} academic session and is hereby awarded this certificate of graduation.";
    case "completion":
      return "{{holder_name}} of {{class}} has successfully completed {{program}} during the {{session}} academic session, meeting all requirements set by {{school}}.";
    case "merit":
    case "achievement":
      return "This recognises {{holder_name}} of {{class}} for {{award}} in the {{term}} term of the {{session}} academic session. The school is proud of this consistent effort and excellent result.";
    case "participation":
      return "This acknowledges the active participation of {{holder_name}} of {{class}} in {{program}} during the {{session}} academic session.";
    case "appreciation":
      return "{{school}} records its sincere appreciation to {{holder_name}} for dedicated service and valued contribution during the {{session}} academic session.";
    default:
      return "This certifies that {{holder_name}} of {{class}} has fulfilled the requirements recorded by {{school}} for the {{session}} academic session.";
  }
}

/* ---------------------------- token expansion ----------------------------
   The body is plain text. Tokens are replaced with escaped values, so
   anything a school types stays text and can never become markup.
-------------------------------------------------------------------------- */
/* Natural guesses for the same fact, so a school that writes {{issued_date}}
   or {{admission_number}} gets a date and a number rather than a blank. These
   are aliases of the tokens in TOKENS, never new data. */
const TOKEN_ALIASES = {
  issued_date: "date",
  date_of_issue: "date",
  graduation_date: "date",
  admission_number: "admission_no",
  admission_no: "identifier",
  student_id: "identifier",
  staff_id: "identifier",
  certificate_number: "reference",
  certificate_no: "reference",
  cert_no: "reference",
  student_name: "holder_name",
  full_name: "holder_name",
  name: "holder_name",
  class_name: "class",
  student_class: "class",
  department: "class",
  programme: "program",
  course: "program",
  academic_session: "session",
  year: "session",
  grade: "result",
  school_name: "school",
  madrasa: "school",
  madrasa_name: "school",
};

function expandInline(text, values) {
  return escapeHtml(String(text || "")).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, rawKey) => {
    let key = String(rawKey).toLowerCase();
    if (TOKEN_ALIASES[key]) key = TOKEN_ALIASES[key];
    if (!Object.prototype.hasOwnProperty.call(values, key)) return "";
    const value = values[key];
    return escapeHtml(value === null || value === undefined ? "" : value);
  });
}

/** Paragraph-aware expansion: blank lines split, single newlines break. */
function expandTokens(text, values) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => `<p>${expandInline(chunk, values).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/* ------------------------------- the renderer ----------------------------- */
function factRows(config, facts) {
  return config.facts
    .map((key) => {
      const definition = FACTS.find((f) => f.key === key);
      if (!definition) return null;
      const value = cleanText(facts[key], 120);
      if (!value) return null;
      return { label: definition.label, value };
    })
    .filter(Boolean);
}

function sealMarkup(school, layout) {
  return `<div class="cert-seal"${layout === "band" ? ' data-style="band"' : ""}><div class="cert-mark">${schoolMark(school)}</div><small>Official seal</small></div>`;
}

function signatureMarkup(signatory, issued, index) {
  const signature = signatory.showSignature && signatory.signaturePath ? safeAssetPath(signatory.signaturePath) : "";
  return `<div class="cert-sign" data-slot="${index + 1}">
    <div class="cert-sign-pad">${signature ? `<img src="${escapeHtml(signature)}" alt="Signature of ${escapeHtml(signatory.name || signatory.label)}">` : ""}</div>
    <span class="cert-sign-rule" aria-hidden="true"></span>
    <p class="cert-sign-who">${escapeHtml(signatory.name || "")}</p>
    <p class="cert-sign-label">${escapeHtml(signatory.label)}</p>
    ${signatory.title ? `<p class="cert-sign-title">${escapeHtml(signatory.title)}</p>` : ""}
    ${signatory.showDate ? `<p class="cert-sign-date">Dated ${escapeHtml(issued)}</p>` : ""}
  </div>`;
}

/**
 * Full A4 certificate. `interactive` is false inside the editor's preview
 * frame, which also stops a preview from opening a print dialog.
 */
function renderCertificateDocument({ school, config, facts, values, ref, issued, templateName, verifyUrl, interactive = false, badge = "", forPreview = false }) {
  const design = designByKey(config.designKey) || DESIGN_BY_KEY.get(DEFAULT_DESIGN);
  const theme = documentTheme(school, { accentColor: config.accentColor });
  const layout = design.layout;
  const rows = factRows(config, facts);
  const monogram = escapeHtml(String(school.name || "S").trim().slice(0, 1).toUpperCase() || "S");
  // The portrait comes from the record being printed, never from the template
  // config, so a template cannot point at another holder's photograph.
  const photo = safeAssetPath(config.photoPath);

  const ornament = design.ornament === "laurel"
    ? `<div class="cert-ornament cert-ornament-laurel" aria-hidden="true">${LAUREL_SVG}</div>`
    : design.ornament === "crest"
      ? `<div class="cert-ornament cert-ornament-crest" aria-hidden="true">${CREST_SVG(monogram)}</div>`
      : design.ornament === "ribbon"
        ? `<span class="cert-ribbon" aria-hidden="true"><b>${escapeHtml(config.type === "custom" ? "Certificate" : config.type)}</b></span>`
        : "";

  const header = `
    <header class="cert-head cert-head-${layout.header}">
      ${layout.header === "band" ? `<div class="cert-band">` : ""}
      <div class="cert-mark">${schoolMark(school)}</div>
      <div class="cert-school">
        <p class="cert-school-name">${escapeHtml(school.name || "School")}</p>
        ${config.showArabic && school.nameAr ? `<p class="cert-school-ar" dir="rtl" lang="ar">${escapeHtml(school.nameAr)}</p>` : ""}
        ${config.showMotto && school.motto ? `<p class="cert-motto">${escapeHtml(school.motto)}</p>` : ""}
        ${school.address ? `<p class="cert-school-addr">${escapeHtml(school.address)}${school.phone ? ` · ${escapeHtml(school.phone)}` : ""}</p>` : ""}
      </div>
      ${layout.header === "band" ? `<div class="cert-band-mark">${CREST_SVG(monogram)}</div></div>` : ""}
    </header>`;

  const factsStrip = config.showFacts && rows.length
    ? `<dl class="cert-facts">${rows.map((row) => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`).join("")}</dl>`
    : "";

  const body = `
    <div class="cert-body">
      ${ornament}
      ${config.eyebrow ? `<p class="cert-eyebrow">${escapeHtml(config.eyebrow)}</p>` : ""}
      <h1 class="cert-title">${escapeHtml(config.title)}</h1>
      ${config.kicker ? `<p class="cert-kicker">${expandInline(config.kicker, values)}</p>` : ""}
      <div class="cert-holder${photo && layout.photo !== "none" ? ` has-photo photo-${layout.photo}` : ""}">
        ${photo && layout.photo !== "none" ? `<div class="cert-photo"><img src="${escapeHtml(photo)}" alt=""></div>` : `<div class="cert-photo cert-photo-empty"><span>${monogram}</span></div>`}
        <h2 class="cert-name">${escapeHtml(values.holder_name || "")}</h2>
        ${values.identifier ? `<p class="cert-holder-id">${escapeHtml(values.identifier)}</p>` : ""}
      </div>
      <div class="cert-text">${expandTokens(config.body, values)}</div>
      ${config.showAward && config.award ? `<p class="cert-award"><span>${expandInline(config.award, values)}</span></p>` : ""}
      ${factsStrip}
      ${config.closing ? `<p class="cert-closing">${expandInline(config.closing, values)}</p>` : ""}
    </div>`;

  const signatures = config.signatories.map((sig, index) => signatureMarkup(sig, issued, index)).join("");
  const verifyFigure = config.showQr && verifyUrl
    ? qrBlock(verifyUrl, { className: "qr-block cert-qr", captionText: "Verify certificate", linkLabel: "Open certificate verification" })
    : "";
  const footer = `
    <footer class="cert-foot">
      <div class="cert-sign-row">${signatures}</div>
      <div class="cert-stamp">
        ${config.showSeal ? sealMarkup(school, layout.header) : ""}
        ${verifyFigure}
      </div>
    </footer>`;

  const watermark = config.showWatermark && config.watermark
    ? `<div class="cert-watermark" aria-hidden="true"><span>${escapeHtml(config.watermark)}</span></div>`
    : "";

  const corners = design.ornament === "corners-diamond" || layout.edges === "frame"
    ? ["tl", "tr", "bl", "br"].map((pos) => `<span class="cert-corner ${pos}" aria-hidden="true"></span>`).join("")
    : "";

  const markup = `<main class="cert-page cert-design-${escapeHtml(design.key)} cert-edges-${escapeHtml(layout.edges)} ${theme.western ? "is-western" : "is-islamic"}${config.paper === "tinted" ? " is-tinted" : ""}${forPreview ? " is-preview" : ""}" style="${themeStyle(theme)}">
    <div class="cert-frame">${corners}
      <div class="cert-inner">
        ${watermark}
        ${header}
        <div class="cert-rule" aria-hidden="true"><span></span></div>
        ${body}
        ${footer}
        <p class="cert-meta"><span>Certificate No. ${escapeHtml(ref)}</span><span>${escapeHtml(templateName || design.name)}</span><span>Issued ${escapeHtml(issued)}</span>${config.footerNote ? `<span class="cert-foot-note">${escapeHtml(config.footerNote)}</span>` : ""}</p>
      </div>
    </div>
  </main>`;
  return { markup, design, theme, badge };
}

/* ---------------------------------- CSS ----------------------------------
   One base sheet shared by every design, then a scoped block per design.
   Sizes are in millimetres because the page is a physical A4 landscape.
-------------------------------------------------------------------------- */
const CERT_BASE_CSS = `
@page{size:A4 landscape;margin:0}
.cert-page{position:relative;width:297mm;height:210mm;margin:0 auto;padding:8mm;background:#fff;color:#1d2433;font-family:Georgia,"Times New Roman",serif}
.cert-frame{position:relative;height:194mm;padding:2.6mm;border:.75mm solid var(--brand)}
.cert-frame::before{content:"";position:absolute;inset:2mm;border:.26mm solid var(--accent);pointer-events:none}
.cert-inner{position:relative;height:100%;display:flex;flex-direction:column;padding:7mm 14mm 4mm;overflow:hidden;background:linear-gradient(180deg,#fff 0%,var(--tint) 100%)}
.cert-inner>*{position:relative}
.cert-page.is-islamic .cert-inner::before{content:"";position:absolute;inset:0;pointer-events:none;background-image:${ISLAMIC_LATTICE_CERT};background-size:12mm 12mm}
.cert-watermark{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;z-index:0}
.cert-watermark span{font:700 26mm/1 Arial,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:var(--brand);opacity:.06;transform:rotate(-14deg)}
.cert-head{display:flex;align-items:center;justify-content:center;gap:5mm}
.cert-mark{flex:none;width:18mm;height:18mm;border-radius:50%;background:#fff;display:grid;place-items:center;overflow:hidden;box-shadow:0 0 0 .55mm var(--accent)}
.cert-mark img{width:100%;height:100%;object-fit:contain;padding:1.4mm}
.cert-mark span{font:700 7.6mm/1 Georgia,"Times New Roman",serif;color:var(--brand)}
.cert-school{text-align:center}
.cert-school-name{margin:0;font:700 6.4mm/1.1 Georgia,serif;letter-spacing:.05em;text-transform:uppercase;color:var(--brand-dark)}
.cert-school-ar{margin:1mm 0 0;font:600 4.6mm/1.3 "Noto Naskh Arabic","Traditional Arabic",Georgia,serif;color:var(--brand)}
.cert-motto{margin:1mm 0 0;font:italic 3.2mm/1.2 Georgia,serif;color:#5b6474}
.cert-school-addr{margin:1mm 0 0;font:400 2.4mm/1.3 Arial,sans-serif;letter-spacing:.03em;color:#7a8496}
.cert-rule{display:flex;align-items:center;justify-content:center;height:5.4mm;margin:2.6mm 0 .6mm}
.cert-rule::before,.cert-rule::after{content:"";flex:1;border-top:.28mm solid var(--accent-soft)}
.cert-rule span{flex:none;width:2.4mm;height:2.4mm;margin:0 3mm;background:var(--accent);transform:rotate(45deg)}
.cert-body{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 6mm;overflow:hidden;color:#1d2433}
.cert-eyebrow{margin:0 0 1.6mm;font:700 2.7mm/1.2 Arial,sans-serif;letter-spacing:.34em;text-transform:uppercase;color:var(--accent)}
.cert-title{margin:0 0 1.8mm;font:700 11.4mm/1.06 Georgia,serif;letter-spacing:.01em;text-transform:uppercase;color:var(--brand-dark)}
.cert-kicker{margin:0 0 2.4mm;font:400 3.9mm/1.4 Georgia,serif;font-style:italic;color:#5b6474}
.cert-holder{display:flex;align-items:center;justify-content:center;gap:6mm;margin:0 0 2mm}
.cert-name{margin:0;padding:0 5mm 1.8mm;border-bottom:.34mm solid var(--accent);font:700 11mm/1.12 Georgia,serif;color:var(--brand-dark)}
.cert-holder-id{margin:1.4mm 0 0;font:600 3mm/1.2 Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#6b7689}
.cert-photo{flex:none;width:26mm;height:32mm;padding:.7mm;background:#fff;border-radius:1.6mm;box-shadow:0 0 0 .3mm var(--accent),0 .7mm 2mm rgba(16,24,40,.22)}
.cert-photo img,.cert-photo-empty{display:block;width:100%;height:100%;object-fit:cover;border-radius:1.1mm}
.cert-photo-empty{display:grid;place-items:center;background:var(--brand-soft);color:var(--brand);font:800 10mm Georgia,serif}
.cert-text{margin:0;max-width:230mm}
.cert-text p{margin:1.4mm 0;font:400 4mm/1.6 Georgia,serif;color:#344054}
.cert-award{margin:2.6mm 0 1mm;font:700 5.4mm/1.2 Georgia,serif;color:var(--brand)}
.cert-award span{display:inline-block;padding:1.2mm 6mm;border-radius:999px;background:var(--accent);color:#fff}
.cert-facts{margin:3.2mm 0 0;padding:2.2mm 4mm;display:flex;flex-wrap:wrap;justify-content:center;gap:1.4mm 8mm;border-top:.24mm solid var(--accent-soft);border-bottom:.24mm solid var(--accent-soft);background:rgba(255,255,255,.55)}
.cert-facts div{display:flex;align-items:baseline;gap:1.6mm}
.cert-facts dt{font:700 2.2mm/1.3 Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#79839a}
.cert-facts dd{margin:0;font:700 3.1mm/1.3 Arial,sans-serif;color:#1b2538}
.cert-closing{margin:2.6mm 0 0;font:italic 400 3.4mm/1.4 Georgia,serif;color:#5b6474}
.cert-foot{flex:none;display:flex;align-items:flex-end;justify-content:space-between;gap:8mm;padding:0 4mm;margin-top:2mm}
.cert-sign-row{flex:1;display:flex;align-items:flex-end;justify-content:space-between;gap:10mm}
.cert-sign{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:.9mm}
.cert-sign-pad{height:11mm;display:flex;align-items:flex-end;justify-content:center}
.cert-sign-pad img{max-height:11mm;max-width:52mm;object-fit:contain;display:block}
.cert-sign-rule{display:block;width:100%;max-width:62mm;border-top:.28mm solid #475467}
.cert-sign-who{margin:.6mm 0 0;font:700 3.3mm/1.2 Georgia,serif;color:#1b2538}
.cert-sign-label{margin:0;font:700 2.4mm/1.2 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#475467}
.cert-sign-title{margin:0;font:400 2.5mm/1.2 Arial,sans-serif;color:#6b7689}
.cert-sign-date{margin:.4mm 0 0;font:400 2.4mm/1.2 Arial,sans-serif;color:#6b7689}
.cert-stamp{flex:none;display:flex;align-items:flex-end;gap:4mm}
.cert-seal{width:24mm;height:24mm;border-radius:50%;border:.8mm double var(--accent);background:radial-gradient(circle at 50% 35%,#fff 0%,var(--brand-soft) 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.6mm;box-shadow:0 .7mm 1.8mm rgba(16,24,40,.18)}
.cert-seal .cert-mark{width:12mm;height:12mm;box-shadow:none;background:transparent}
.cert-seal .cert-mark span{font-size:5.6mm}
.cert-seal small{font:700 1.6mm/1 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--brand)}
.qr-block{margin:0;text-align:center}
.qr-block a{display:block}
.qr-block svg,.qr-block img{display:block;width:100%;height:auto}
.cert-qr{width:22mm;padding:1mm;background:#fff;border:.24mm solid #dbe2ec;border-radius:1.4mm}
.cert-qr figcaption,.id-qr figcaption{margin-top:.6mm;font:700 1.7mm/1.2 Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#6b7689}
.cert-meta{flex:none;display:flex;flex-wrap:wrap;justify-content:space-between;gap:5mm;margin:2.4mm 0 0;font:600 2.4mm/1.2 Arial,sans-serif;letter-spacing:.03em;color:#667085}
.cert-foot-note{color:var(--brand)}
.cert-corner{position:absolute;z-index:2;pointer-events:none}
.cert-corner.tl{top:-.7mm;left:-.7mm}
.cert-corner.tr{top:-.7mm;right:-.7mm}
.cert-corner.bl{bottom:-.7mm;left:-.7mm}
.cert-corner.br{bottom:-.7mm;right:-.7mm}
.cert-ornament{color:var(--accent);pointer-events:none}
.cert-ornament-laurel{position:absolute;top:-1mm;left:50%;transform:translateX(-50%);width:74mm;opacity:.5}
.cert-ornament-crest{width:16mm}
@media print{body{background:#fff}.cert-page{margin:0}}`;

const CERT_DESIGN_CSS = `
/* Heritage Classic — double frame with gold corner diamonds. */
.cert-design-heritage .cert-corner{width:9mm;height:9mm;background:#fff;border:.75mm solid var(--accent);transform:rotate(45deg)}
.cert-design-heritage .cert-corner.tl{top:-4.6mm;left:-4.6mm}
.cert-design-heritage .cert-corner.tr{top:-4.6mm;right:-4.6mm}
.cert-design-heritage .cert-corner.bl{bottom:-4.6mm;left:-4.6mm}
.cert-design-heritage .cert-corner.br{bottom:-4.6mm;right:-4.6mm}
/* Royal Crest — full colour header band, name in outline. */
.cert-design-royal .cert-frame{border-width:.55mm;padding:0}
.cert-design-royal .cert-frame::before{inset:.9mm;border-color:var(--accent-soft)}
.cert-design-royal .cert-inner{padding:0 14mm 5mm;background:#fff}
.cert-design-royal .cert-head{justify-content:flex-start;gap:6mm;margin:0 -14mm 4mm;padding:5mm 14mm;color:#fff;background:linear-gradient(112deg,var(--brand-deep) 0%,var(--brand) 55%,var(--brand-dark) 100%)}
.cert-design-royal .cert-head .cert-mark{box-shadow:0 0 0 .55mm var(--accent);background:#fff}
.cert-design-royal .cert-band{display:flex;flex:1;align-items:center;justify-content:space-between;gap:6mm;min-width:0}
.cert-design-royal .cert-band-mark{flex:none;width:16mm;color:var(--accent-soft)}
.cert-design-royal .cert-school{text-align:left}
.cert-design-royal .cert-school-name,.cert-design-royal .cert-motto{color:#fff}
.cert-design-royal .cert-motto{opacity:.85}
.cert-design-royal .cert-school-addr{color:rgba(255,255,255,.72)}
.cert-design-royal .cert-school-ar{color:var(--accent-soft)}
.cert-design-royal .cert-name{border:0;padding:0;text-shadow:0 .3mm 0 var(--accent-soft)}
.cert-design-royal .cert-ornament-crest{display:none}
/* Modern Minimal — no frame, side header, thin accent rail. */
.cert-design-modern .cert-frame{border:0;padding:0}
.cert-design-modern .cert-frame::before{content:none}
.cert-design-modern .cert-inner{font-family:Arial,"Segoe UI",sans-serif;background:#fff;padding:0 16mm 6mm}
.cert-design-modern .cert-inner::before{content:"";position:absolute;left:0;top:12mm;bottom:12mm;width:1.6mm;background:linear-gradient(180deg,var(--brand) 0%,var(--accent) 100%);border-radius:0 1mm 1mm 0}
.cert-design-modern .cert-head{justify-content:flex-start;gap:4mm}
.cert-design-modern .cert-school{text-align:left}
.cert-design-modern .cert-school-name{font:800 5.4mm/1.1 Arial,sans-serif;letter-spacing:.02em}
.cert-design-modern .cert-rule{height:2mm;margin:3mm 0 1mm}
.cert-design-modern .cert-rule::after{content:none}
.cert-design-modern .cert-rule span{display:none}
.cert-design-modern .cert-title{font:800 10mm/1.05 Arial,sans-serif;letter-spacing:-.01em;text-transform:none}
.cert-design-modern .cert-kicker{font:400 3.6mm/1.4 Arial,sans-serif;font-style:normal;color:#6b7689}
.cert-design-modern .cert-holder{flex-direction:column-reverse;gap:2.6mm}
.cert-design-modern .cert-holder.has-photo{flex-direction:row;align-items:center;gap:6mm}
.cert-design-modern .cert-name{font:800 10mm/1.05 Arial,sans-serif;border:0;padding:0;color:var(--brand-dark)}
.cert-design-modern .cert-text p{font:400 3.7mm/1.65 Arial,sans-serif;color:#3a475c}
.cert-design-modern .cert-photo{width:24mm;height:24mm;padding:0;border-radius:50%;box-shadow:0 0 0 .55mm var(--accent-soft)}
.cert-design-modern .cert-photo img,.cert-design-modern .cert-photo-empty{border-radius:50%}
.cert-design-modern .cert-facts{border-top:.2mm solid #e6eaf1;border-bottom:.2mm solid #e6eaf1;background:#f7f9fc;border-radius:2mm;padding:2mm 4mm}
/* Islamic Geometric — arched panel over the body. */
.cert-design-geometric .cert-inner{background:linear-gradient(180deg,#fff 0%,#f7fbf7 60%,var(--tint) 100%)}
.cert-design-geometric .cert-body{padding-top:2mm}
.cert-design-geometric .cert-body::before{content:"";position:absolute;inset:-2mm -2mm -1mm;border:.4mm solid var(--accent-soft);border-radius:60mm 60mm 3mm 3mm;pointer-events:none;background:rgba(255,255,255,.5)}
.cert-design-geometric .cert-body>*{position:relative}
.cert-design-geometric .cert-title{letter-spacing:.02em}
.cert-design-geometric .cert-school-ar{margin:1.4mm 0 0;font-size:5.2mm}
.cert-design-geometric .cert-corner{width:8mm;height:8mm;border:0;background:radial-gradient(circle at 50% 50%,var(--accent) 0 1.4mm,transparent 1.5mm),conic-gradient(from 45deg,var(--accent-soft) 0 25%,transparent 0 100%)}
/* Laurel Merit — wreath sits behind the award line. */
.cert-design-laurel .cert-ornament-laurel{position:static;transform:none;margin:0 0 -3mm;width:82mm;opacity:.75}
.cert-design-laurel .cert-award{margin-top:.4mm}
.cert-design-laurel .cert-name{border-bottom-style:double;border-bottom-width:.7mm}
/* Achievement Ribbon — ribbon badge in the corner + edge band. */
.cert-design-ribbon .cert-frame{border:0;padding:0}
.cert-design-ribbon .cert-frame::before{content:none}
.cert-design-ribbon .cert-inner{padding:0;background:linear-gradient(180deg,#fff 0%,var(--tint) 100%)}
.cert-design-ribbon .cert-ribbon{position:absolute;top:0;right:0;z-index:3;display:inline-flex;align-items:center;padding:2.4mm 9mm;background:linear-gradient(120deg,var(--accent-ink),var(--accent));color:#fff;font:800 2.8mm/1 Arial,sans-serif;letter-spacing:.24em;text-transform:uppercase;clip-path:polygon(14% 0,100% 0,100% 100%,14% 100%,0 50%)}
.cert-design-ribbon .cert-head{justify-content:flex-start;padding:6mm 14mm 0;gap:4mm}
.cert-design-ribbon .cert-school{text-align:left}
.cert-design-ribbon .cert-body{padding:2mm 16mm 0}
.cert-design-ribbon .cert-foot{padding:0 14mm}
.cert-design-ribbon .cert-rule{margin-left:14mm;margin-right:14mm}
.cert-design-ribbon .cert-name{border:0;padding:0;font-family:Arial,sans-serif;font-weight:800}
.cert-design-ribbon .cert-title{text-transform:none;font-family:Arial,sans-serif}
/* Executive Ledger — ruled header band and a ledger detail table. */
.cert-design-executive .cert-frame{border:.4mm solid #cbd5e1;padding:0}
.cert-design-executive .cert-frame::before{content:none}
.cert-design-executive .cert-inner{font-family:Arial,"Segoe UI",sans-serif;background:#fff;padding:0 15mm 5mm}
.cert-design-executive .cert-head{justify-content:flex-start;margin:0 -15mm 3mm;padding:4mm 15mm;background:#0f172a;color:#fff;background:linear-gradient(100deg,var(--brand-deep),var(--brand-dark))}
.cert-design-executive .cert-band{display:flex;flex:1;align-items:center;justify-content:space-between;gap:6mm}
.cert-design-executive .cert-band-mark{width:13mm;color:rgba(255,255,255,.5)}
.cert-design-executive .cert-mark{border-radius:2mm;box-shadow:none;background:rgba(255,255,255,.94)}
.cert-design-executive .cert-school{text-align:left}
.cert-design-executive .cert-school-name{font:800 5mm/1.1 Arial,sans-serif;letter-spacing:.06em;color:#fff}
.cert-design-executive .cert-motto,.cert-design-executive .cert-school-addr{color:rgba(255,255,255,.7)}
.cert-design-executive .cert-school-ar{color:#cbd5e1}
.cert-design-executive .cert-title{font:800 8.6mm/1.1 Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#0f172a}
.cert-design-executive .cert-rule{display:none}
.cert-design-executive .cert-name{font:800 9mm/1.1 Arial,sans-serif;border:0;padding:0;color:#0f172a;border-bottom:.4mm solid #0f172a;display:inline-block}
.cert-design-executive .cert-text p{font:400 3.5mm/1.6 Arial,sans-serif;color:#334155}
.cert-design-executive .cert-facts{justify-content:flex-start;gap:0;border:0;border-top:.24mm solid #cbd5e1;padding:0;background:#f8fafc;border-radius:0}
.cert-design-executive .cert-facts div{flex:1 0 33%;justify-content:space-between;padding:1.4mm 3mm;border-bottom:.24mm solid #e2e8f0}
.cert-design-executive .cert-ornament-crest{display:none}
/* Paper and edge variants shared across designs. */
.cert-page.is-tinted .cert-inner{background:linear-gradient(180deg,#fffdf7 0%,#f7f2e6 100%)}
.cert-edges-edge-band .cert-inner::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3mm;background:linear-gradient(90deg,var(--brand) 0%,var(--accent) 100%)}
.cert-edges-open .cert-frame,.cert-edges-open .cert-frame::before{border:0}
.cert-page.is-preview{transform-origin:top left}`;

const CERTIFICATE_CSS = CERT_BASE_CSS + "\n" + CERT_DESIGN_CSS;

/* --------------------------------------------------------------------------
   Preview-only rendering: a compact mock used by the design gallery. Same CSS,
   sample facts, no print bar — so the thumbnail and the print agree by
   construction instead of by hand-drawn mock-up markup.
-------------------------------------------------------------------------- */
function previewSchool() {
  return {
    name: "Al-Noor International Madrasa",
    nameAr: "مدرسة النور",
    motto: "Knowledge · Character · Service",
    address: "12 Ijebu Road, Ijebu-Ode, Ogun",
    phone: "+234 800 000 0000",
    logo: "",
    badge: "",
    category: "islamic",
    brandColor: "",
  };
}

function previewFacts() {
  return {
    identifier: "NIM/2026/0148",
    class: "SS 2 Blue",
    session: "2025/2026",
    term: "Second Term",
    program: "Tahfiz & Senior Secondary",
    track: "Islamic + Western",
    result: "Distinction (82%)",
    date: dateLabel(new Date().toISOString().slice(0, 10)),
  };
}

module.exports = {
  CERT_TYPES,
  DEFAULT_BODY_TEMPLATES: {
    graduation: defaultBody("graduation"),
    achievement: defaultBody("achievement"),
    completion: defaultBody("completion"),
    participation: defaultBody("participation"),
    merit: defaultBody("merit"),
    appreciation: defaultBody("appreciation"),
    custom: defaultBody("custom"),
  },
  CERTIFICATE_CSS,
  DESIGN_BY_KEY,
  DESIGNS,
  FACTS,
  TOKENS,
  TYPE_DEFAULTS,
  cleanText,
  designByKey,
  designList,
  legacyConfigFromHtml,
  expandTokens,
  TOKEN_ALIASES,
  normaliseConfig,
  previewFacts,
  previewSchool,
  renderCertificateDocument,
  signatureMarkup,
};
