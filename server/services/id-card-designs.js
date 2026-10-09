"use strict";
/* ============================================================================
   EduSphere — ID card rendering
   ----------------------------------------------------------------------------
   One card engine, many holders. A student card and a staff card are the same
   object: a portrait, an identity block, four or five facts, a security
   pattern and a QR code that opens a verification page. Only the DATA differs,
   so this module takes a normalised "holder" shape and both roles are then
   printed by the same code path — which is how a staff card ends up with the
   same QR verification, revocation and print-sheet behaviour a student card
   already had, instead of a second, weaker implementation.

   Print geometry (unchanged, because printers and guillotines have opinions):
     • ID-1 card, 85.6 × 54 mm, front and back
     • eight cards to an A4 portrait sheet (2 × 4) with crop marks
   ========================================================================== */
const {
  escapeHtml,
  safeAssetPath,
  schoolMark,
  themeStyle,
  documentTheme,
  ISLAMIC_LATTICE,
  qrBlock,
} = require("./print-documents");

const HOLDER_STYLES = {
  student: { label: "Student", accent: null, kind: "student" },
  teacher: { label: "Staff", accent: null, kind: "staff" },
  staff: { label: "Staff", accent: null, kind: "staff" },
};

/**
 * holder = {
 *   type: "student"|"teacher",
 *   name, initials, photoPath, roleLabel,
 *   fields: [{label, value}],           // printed on the front
 *   meta:   [{label, value}],           // printed on the back
 *   serial, validThrough, issued, designation,
 *   emergency, address, phone,
 *   holderSignature, issuerSignature,    // printed signature image paths
 *   verifyUrl, school, theme
 * }
 */
function cardClasses(holder, side, theme) {
  const kind = (HOLDER_STYLES[holder.type] || HOLDER_STYLES.student).kind;
  return ["id-card", `id-${side}`, `role-${kind}`, theme.western ? "category-western" : "category-islamic",
    String(holder.name || "").length > 24 ? "is-long" : "",
    holder.photoPath ? "has-photo" : "has-monogram"].filter(Boolean).join(" ");
}

function fieldRows(fields, extraClass = "") {
  return `<dl class="${extraClass || "id-fields"}">${fields
    .filter((field) => field && field.value !== "" && field.value !== null && field.value !== undefined)
    .map((field) => `<div><dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd></div>`)
    .join("")}</dl>`;
}

/** The tail of the verification code, printed so a card can be checked by
    typing it when a camera cannot focus on a scratched QR. */
function shortCode(code) {
  const value = String(code || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!value) return "";
  return value.length > 8 ? `${value.slice(0, 4)} ${value.slice(-4)}` : value;
}

/** Front: portrait, identity, the facts a security guard needs, and the QR. */
function idCardFront(holder) {
  const theme = holder.theme;
  const photo = safeAssetPath(holder.photoPath);
  const role = holder.roleLabel || (HOLDER_STYLES[holder.type] || HOLDER_STYLES.student).label;
  const qr = holder.verifyUrl
    ? qrBlock(holder.verifyUrl, { className: "qr-block id-qr", captionText: "Scan to verify", linkLabel: "Open verification page" })
    : `<div class="id-qr id-qr-empty" aria-hidden="true"><span>No QR</span></div>`;
  return `<article class="${cardClasses(holder, "front", theme)}" style="${themeStyle(theme)}">
    <span class="id-guilloche" aria-hidden="true"></span>
    <header class="id-head">
      <div class="id-mark">${schoolMark(holder.school)}</div>
      <div class="id-school"><strong>${escapeHtml(holder.school.name || "School")}</strong><span>${escapeHtml(role)} identity card</span></div>
      <span class="id-session">${escapeHtml(holder.serial || "")}</span>
    </header>
    <div class="id-body">
      <div class="id-photo">${photo
        ? `<img src="${escapeHtml(photo)}" alt="Portrait of ${escapeHtml(holder.name)}">`
        : `<div class="id-photo-empty">${escapeHtml(holder.initials || "S")}</div>`}</div>
      <div class="id-info">
        <h2 class="id-name">${escapeHtml(holder.name)}</h2>
        ${holder.designation ? `<p class="id-role-line">${escapeHtml(holder.designation)}</p>` : ""}
        ${fieldRows(holder.fields)}
      </div>
      <div class="id-side">${qr}</div>
    </div>
    <footer class="id-foot">
      <span>${escapeHtml(holder.school.motto || "Official school identification")}</span>
      <span class="id-valid">${escapeHtml(holder.validThrough ? `Valid ${holder.validThrough}` : `Issued ${holder.issued || ""}`)}</span>
    </footer>
  </article>`;
}

/** Back: terms, contacts, printed signatures and the same serial for matching. */
function idCardBack(holder) {
  const theme = holder.theme;
  const contacts = (holder.meta || []).filter((field) => field && field.value);
  const signature = (label, path, name) => {
    const image = safeAssetPath(path);
    return `<div class="id-sign"><div class="id-sign-pad">${image ? `<img src="${escapeHtml(image)}" alt="">` : ""}</div>
      <span class="id-sign-rule"></span>
      <span class="id-sign-label">${escapeHtml(label)}</span>
      ${name ? `<span class="id-sign-name">${escapeHtml(name)}</span>` : ""}</div>`;
  };
  const subtitle = theme.western
    ? "<span>Staff identity card</span>"
    : (holder.school.nameAr ? `<span dir="rtl" lang="ar">${escapeHtml(holder.school.nameAr)}</span>` : "<span>Identity card</span>");
  return `<article class="${cardClasses(holder, "back", theme)}" style="${themeStyle(theme)}">
    <header class="id-head id-head-compact">
      <div class="id-mark">${schoolMark(holder.school)}</div>
      <div class="id-school"><strong>${escapeHtml(holder.school.name || "School")}</strong>${subtitle}</div>
    </header>
    <div class="id-body id-body-back">
      <p class="id-terms">This card remains the property of ${escapeHtml(holder.school.name || "the school")}. Carry it on school premises and show it when asked. If found, please return it to the school office.</p>
      ${contacts.length ? fieldRows(contacts, "id-contact") : ""}
      ${holder.emergency ? `<p class="id-emergency"><b>Emergency</b> ${escapeHtml(holder.emergency)}</p>` : ""}
      <div class="id-signs">${signature("Holder's signature", holder.holderSignature, "")}${signature("Principal's signature", holder.issuerSignature, holder.issuerName || "")}</div>
    </div>
    <footer class="id-foot"><span>${escapeHtml(holder.serial || "")} · ${escapeHtml(holder.name)}</span><span class="id-code">Card ${escapeHtml(shortCode(holder.code))}</span></footer>
  </article>`;
}

const idSlot = (inner) => `<div class="id-slot">${inner}</div>`;

const ID_CARD_CSS = `
.id-slot{position:relative;width:85.6mm;height:54mm;margin:12px auto}
.id-card{position:relative;display:flex;flex-direction:column;width:85.6mm;height:54mm;overflow:hidden;border-radius:3mm;background:#fff;color:#172033;break-inside:avoid;box-shadow:0 1px 2px rgba(16,24,40,.16),0 8px 22px rgba(16,24,40,.18)}
.id-guilloche{position:absolute;inset:0;pointer-events:none;opacity:.5;background:
  repeating-linear-gradient(115deg,rgba(255,255,255,.5) 0 .18mm,transparent .18mm 2.4mm),
  radial-gradient(120% 80% at 110% -10%,rgba(255,255,255,.35) 0,transparent 60%)}
.id-card>*{position:relative}
.id-head{flex:none;display:flex;align-items:center;gap:2.4mm;padding:2.1mm 3.2mm;background:linear-gradient(112deg,var(--brand-deep) 0%,var(--brand) 58%,var(--brand-dark) 100%);color:#fff;min-height:12.4mm}
.id-mark{flex:none;width:8.4mm;height:8.4mm;border-radius:50%;background:#fff;display:grid;place-items:center;overflow:hidden;box-shadow:0 0 0 .45mm var(--accent)}
.id-mark img{width:100%;height:100%;object-fit:contain;padding:.7mm}
.id-mark span{font:700 3.6mm/1 Georgia,"Times New Roman",serif;color:var(--brand)}
.id-school{min-width:0;flex:1}
.id-school strong{display:block;font:800 2.95mm/1.15 Arial,"Segoe UI",sans-serif;letter-spacing:.035em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.id-school span{display:block;margin-top:.5mm;font:600 1.75mm/1.2 Arial,sans-serif;letter-spacing:.16em;text-transform:uppercase;opacity:.88}
.id-session{flex:none;max-width:24mm;font:700 1.9mm/1.2 "SFMono-Regular",Consolas,monospace;letter-spacing:.04em;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.id-body{flex:1;min-height:0;display:flex;align-items:stretch;gap:2.8mm;padding:2.4mm 3.2mm 1.6mm;background:linear-gradient(180deg,#fff 0%,var(--tint) 100%)}
.category-islamic .id-body::before{content:"";position:absolute;inset:0;pointer-events:none;background-image:${ISLAMIC_LATTICE};background-size:9mm 9mm;opacity:.5}
.category-western .id-body::before{content:"";position:absolute;inset:0;pointer-events:none;background-image:repeating-linear-gradient(135deg,rgba(10,35,66,.045) 0 .25mm,transparent .25mm 3mm)}
.id-body>*{position:relative}
.id-photo{flex:none;width:19mm;height:24mm;padding:.6mm;border-radius:1.8mm;background:#fff;box-shadow:0 0 0 .28mm var(--accent-soft),0 .6mm 1.6mm rgba(16,24,40,.2)}
.id-photo img,.id-photo-empty{display:block;width:100%;height:100%;border-radius:1.3mm;object-fit:cover}
.id-photo-empty{display:grid;place-items:center;background:var(--brand-soft);color:var(--brand);font:800 6.5mm Georgia,serif}
.id-info{min-width:0;flex:1;display:flex;flex-direction:column;gap:1mm;justify-content:center}
.id-name{margin:0;font:700 3.6mm/1.12 Georgia,"Times New Roman",serif;color:var(--brand-dark);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.is-long .id-name{font-size:2.9mm}
.id-role-line{margin:.2mm 0 0;font:700 1.9mm/1.2 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--accent-ink)}
.role-staff .id-role-line{color:var(--brand)}
.id-fields,.id-contact{margin:.6mm 0 0;display:grid;gap:.65mm}
.id-fields div,.id-contact div{display:grid;grid-template-columns:17mm minmax(0,1fr);align-items:baseline;gap:1mm}
.id-fields dt,.id-contact dt{white-space:nowrap;font:700 1.75mm/1.25 Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#6b7689}
.id-fields dd,.id-contact dd{margin:0;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:700 2.3mm/1.25 Arial,sans-serif;color:#172033}
.id-side{flex:none;width:15mm;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1mm}
.id-qr{margin:0;width:15mm;text-align:center}
.id-qr a,.id-qr svg{display:block;width:15mm;height:15mm}
.id-qr figcaption{margin-top:.55mm;font:700 1.5mm/1.2 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#5b6474}
.id-qr-empty{display:grid;place-items:center;width:15mm;height:15mm;border:.24mm dashed #b6c0d0;border-radius:1.4mm;color:#8a94a6;font:700 1.5mm/1 Arial,sans-serif;text-transform:uppercase;letter-spacing:.08em}
.id-foot{flex:none;display:flex;justify-content:space-between;align-items:center;gap:2mm;min-height:5.6mm;padding:0 3.2mm;background:var(--brand-soft);border-top:.24mm solid var(--accent-soft);font:600 1.8mm/1 Arial,sans-serif;color:#44506a;letter-spacing:.02em}
.id-foot span{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.id-valid{flex:none;color:var(--brand);font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.id-code{flex:none;color:var(--brand);font:700 1.7mm/1 "SFMono-Regular",Consolas,monospace}
.id-body-back{flex-direction:column;align-items:stretch;justify-content:flex-start;gap:1.4mm;padding:2.4mm 3.2mm 1.4mm}
.id-head-compact{min-height:9.6mm;padding:1.5mm 3.2mm}
.id-terms{margin:0;font:400 2.05mm/1.4 Georgia,"Times New Roman",serif;color:#354057}
.id-emergency{margin:.4mm 0 0;font:400 2mm/1.3 Arial,sans-serif;color:#354057}
.id-emergency b{font:700 1.8mm/1.3 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6b7689;margin-right:1mm}
.id-contact{margin-top:.4mm;grid-template-columns:1fr}
.id-signs{margin-top:auto;display:flex;justify-content:space-between;gap:6mm}
.id-sign{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:.5mm}
.id-sign-pad{height:5.6mm;display:flex;align-items:flex-end;justify-content:center}
.id-sign-pad img{max-height:5.6mm;max-width:32mm;object-fit:contain;display:block}
.id-sign-rule{display:block;width:100%;border-top:.26mm solid #475467}
.id-sign-label{font:700 1.6mm/1.2 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6b7689}
.id-sign-name{font:700 1.9mm/1.1 Georgia,serif;color:#1b2538}
.id-side-label{margin:14px 0 2px;text-align:center;font:700 11px/1 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#667085}
`;

const ID_SINGLE_CSS = `
@page{size:85.6mm 54mm;margin:0}
.id-single{padding:0 0 18px}
.id-single .id-slot{margin:0 auto 14px}
.id-single .id-slot:first-of-type{margin-top:4px}
@media screen{.id-single .id-card{box-shadow:0 1px 2px rgba(16,24,40,.14),0 12px 30px rgba(16,24,40,.22)}}
@media print{body{background:#fff}.id-side-label{display:none}.id-single{padding:0}.id-single .id-slot,.id-single .id-slot:first-of-type{margin:0;break-after:page;page-break-after:always}.id-single .id-slot:last-of-type{break-after:auto;page-break-after:auto}.id-card{box-shadow:none}}
`;

// Eight cards per A4 portrait sheet (two columns by four rows) with crop marks
// drawn just outside every card so the cut lines are easy to find.
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

module.exports = { ID_CARD_CSS, ID_SHEET_CSS, ID_SINGLE_CSS, idCardBack, idCardFront, idSlot, shortCode };
