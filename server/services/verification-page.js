"use strict";
/* ============================================================================
   EduSphere — the page a QR code opens
   ----------------------------------------------------------------------------
   Someone holding a card walks up to a gate, a bank, an exam hall. They point
   a phone camera at the QR code and land HERE. So this page has one job: say
   plainly whether the card is real, and let anyone see why.

   Deliberate choices:

   • No login, no session, no cookies required. It must load for a stranger.
   • No CSS or JS file is needed to read the verdict — the page is fully
     server-rendered with inline styles, and the camera scanner is a progressive
     enhancement layered on top. A browser without getUserMedia still gets the
     code printed under the QR to type in.
   • It shows only what is already printed on the card. No guardian phone
     numbers, no fees, no results, no ids.
   • "Unknown code" and "revoked" are different answers, and both are honest:
     a revoked card says revoked, which is the whole point of being able to
     revoke one.
   • noindex + no-store: a verification page should never be cached by a shared
     proxy or read out of a search result.
   ========================================================================== */
const { escapeHtml, safeAssetPath, dateLabel } = require("./print-documents");

const VERDICTS = {
  valid: { tone: "ok", title: "This card is valid", note: "The school confirms this card belongs to the person named above and is currently active." },
  revoked: { tone: "bad", title: "This card has been cancelled", note: "The school reported this card as lost, stolen or withdrawn. Do not accept it." },
  inactive: { tone: "warn", title: "This holder is not currently active", note: "The card is genuine, but the school says this person is no longer an active student or member of staff." },
  closed: { tone: "warn", title: "This school is not currently active", note: "The card was issued by a school that is not active on the platform, so it cannot be confirmed." },
  unknown: { tone: "bad", title: "No card matches this code", note: "This code is not in the EduSphere register. Check the code, or ask the holder for another form of identification." },
};

const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#eef2f8;color:#152033;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;-webkit-text-size-adjust:100%;padding:16px 14px 34px;display:flex;flex-direction:column;align-items:center}
.vp{width:min(520px,100%);background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 18px 50px rgba(16,24,40,.14);border:1px solid #dde5f0}
.vp-head{display:flex;align-items:center;gap:12px;padding:16px 18px;color:#fff;background:linear-gradient(120deg,#0b1830,#1f3154)}
.vp-head img{width:44px;height:44px;border-radius:50%;background:#fff;object-fit:contain;padding:3px;flex:none}
.vp-head h1{margin:0;font-size:16px;font-weight:700;letter-spacing:.01em}
.vp-head p{margin:3px 0 0;font-size:12px;opacity:.82}
.verdict{display:flex;align-items:flex-start;gap:11px;margin:16px 18px 0;padding:13px 14px;border-radius:14px;border:1px solid;font-weight:600;font-size:15px;line-height:1.35}
.verdict small{display:block;font-weight:400;font-size:13px;opacity:.9;margin-top:4px}
.verdict .mark{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:15px;line-height:1}
.v-ok{background:#eafaef;border-color:#a7e0bb;color:#0f5c33}
.v-ok .mark{background:#12894b}
.v-bad{background:#fdecec;border-color:#f3bdbc;color:#8c1c1c}
.v-bad .mark{background:#c0272b}
.v-warn{background:#fff6e5;border-color:#f2d79b;color:#7a4c07}
.v-warn .mark{background:#b6791b}
.holder{display:flex;gap:14px;align-items:center;padding:16px 18px 6px}
.holder img,.holder .mono{width:72px;height:88px;border-radius:12px;object-fit:cover;background:#e9eef7;flex:none;border:1px solid #dde5f0}
.holder .mono{display:grid;place-items:center;font:700 30px/1 Georgia,serif;color:#3b5f9e}
.holder h2{margin:0;font-size:20px;line-height:1.2}
.holder p{margin:4px 0 0;font-size:13px;color:#5c6b86;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
dl{margin:8px 18px 4px;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
dl div{min-width:0;background:#f6f8fc;border:1px solid #e5eaf3;border-radius:12px;padding:9px 11px}
dt{margin:0;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#6b7a94;font-weight:700}
dd{margin:3px 0 0;font-size:15px;font-weight:600;word-break:break-word}
.code{margin:10px 18px 0;padding:11px 13px;border:1px dashed #c6d2e4;border-radius:12px;background:#fbfcfe}
.code b{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:17px;letter-spacing:.1em;text-transform:uppercase;display:block;margin-top:3px}
.scan{margin:14px 18px 18px;padding-top:14px;border-top:1px solid #e6ebf4}
.scan h3{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:#5c6b86}
.scan .row{display:flex;gap:8px;flex-wrap:wrap}
button,.btn{appearance:none;border:0;border-radius:11px;padding:11px 14px;font:700 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:7px;background:#1f3154;color:#fff}
button.ghost,.btn.ghost{background:#eef2f9;color:#1f3154;border:1px solid #d5dfec}
input[type=text]{flex:1;min-width:150px;padding:11px 12px;border:1px solid #cfd9e8;border-radius:11px;font:600 15px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;background:#fff;color:#152033}
video{width:100%;border-radius:14px;background:#0b1830;display:block;margin-top:10px}
.hint{margin:9px 0 0;font-size:12.5px;color:#6b7a94}
.err{margin:9px 0 0;color:#8c1c1c;font-size:13px;font-weight:600}
.foot{margin:14px 0 0;font-size:12px;color:#6b7a94;text-align:center;max-width:520px}
.foot a{color:#1f3154}
.badge{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.16);font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:700}
@media (max-width:420px){dl{grid-template-columns:1fr}.holder img,.holder .mono{width:58px;height:72px}}`;

const SCAN_SCRIPT = '<script src="/js/card-scanner.js"></script>';

function fieldList(pairs) {
  const rows = pairs.filter(([, value]) => value !== "" && value !== null && value !== undefined);
  if (!rows.length) return "";
  return `<dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

function head(school, badgeText) {
  const logo = safeAssetPath(school && school.logo);
  return `<header class="vp-head">${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ""}<div><h1>${escapeHtml((school && school.name) || "EduSphere")}</h1><p>${escapeHtml((school && school.motto) || "Card verification")}</p></div>${badgeText ? `<span class="badge">${escapeHtml(badgeText)}</span>` : ""}</header>`;
}

function verdictBlock(key, overrides = {}) {
  const verdict = VERDICTS[key] || VERDICTS.unknown;
  const symbol = verdict.tone === "ok" ? "✓" : verdict.tone === "warn" ? "!" : "✕";
  return `<div class="verdict v-${verdict.tone}"><span class="mark" aria-hidden="true">${symbol}</span><div>${escapeHtml(overrides.title || verdict.title)}<small>${escapeHtml(overrides.note || verdict.note)}</small></div></div>`;
}

/** Type-it-in fallback + camera button. The script itself is optional. */
function scanBlock(placeholder, actionHint) {
  return `<section class="scan">
    <h3>${escapeHtml(actionHint.title)}</h3>
    <div class="row" data-scanner data-endpoint="${escapeHtml(actionHint.endpoint)}" data-placeholder="${escapeHtml(placeholder)}">
      <input type="text" name="code" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(actionHint.aria)}">
      <button type="button" data-scanner-open>Scan with camera</button>
      <button type="button" class="ghost" data-scanner-check>Check</button>
    </div>
    <p class="hint">${escapeHtml(actionHint.hint)}</p>
    <p class="err" data-scanner-error hidden></p>
  </section>`;
}

function layout({ title, school, badgeText, body, action }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="theme-color" content="#1f3154">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style></head>
<body>
<main class="vp">
  ${head(school, badgeText)}
  ${body}
  ${action}
</main>
<p class="foot">Checked against the EduSphere register at ${escapeHtml(dateLabel(new Date().toISOString().slice(0, 10)))}. This page is the school's own record — a photograph of a card is not proof.<br><a href="${escapeHtml(action && action.homeLink ? action.homeLink : "/")}">School directory</a></p>
${SCAN_SCRIPT}
</body></html>`;
}

/**
 * The card verification page. `view` is services/card-credentials
 * cardVerificationView(); when the code matched nothing, pass
 * { verdict: "unknown", code }.
 */
function renderCardPage(view, { code } = {}) {
  const safeCode = view.code || code || "";
  const known = view.verdict !== "unknown";
  const body = known ? `
    ${verdictBlock(view.verdict)}
    <section class="holder">
      ${view.photoPath ? `<img src="${escapeHtml(safeAssetPath(view.photoPath))}" alt="Portrait of ${escapeHtml(view.name)}">` : `<span class="mono" aria-hidden="true">${escapeHtml(String(view.name || "S").trim().slice(0, 1).toUpperCase() || "S")}</span>`}
      <div><h2>${escapeHtml(view.name || "Unnamed holder")}</h2><p>${escapeHtml(view.holderType === "teacher" ? "Staff" : "Student")} · ${escapeHtml(view.role || "")}</p></div>
    </section>
    ${fieldList([
      [view.holderType === "teacher" ? "Staff ID" : "Admission no.", view.identifier],
      [view.holderType === "teacher" ? "Department" : "Class", view.department],
      ["Session / programme", view.meta || view.program],
      ["Card issued", view.issuedAt ? dateLabel(String(view.issuedAt).slice(0, 10)) : ""],
      ["School", view.school && view.school.name],
      ["Location", [view.school && view.school.city, view.school && view.school.state].filter(Boolean).join(", ")],
    ])}
    <div class="code"><span>Verification code</span><b>${escapeHtml(safeCode.replace(/(.{4})/g, "$1 ").trim())}</b></div>`
    : verdictBlock("unknown");
  return layout({
    title: known ? `Card check — ${view.name}` : "Card verification",
    school: view.school,
    badgeText: known ? (view.holderType === "teacher" ? "Staff card" : "Student card") : "Unknown card",
    body,
    action: scanBlock("Enter card code", {
      title: "Check another card",
      hint: "Point a camera at the QR code, or type the code printed under it. Codes are unique to one card.",
      endpoint: "/api/public/card/",
      aria: "Card verification code",
    }),
    homeLink: "/",
  });
}

function renderCardUnknownPage(rawCode) {
  return renderCardPage({ verdict: "unknown", code: String(rawCode || "").slice(0, 64) }, { code: rawCode });
}

/** Certificate verification — same trust model, different evidence. */
function renderCertificatePage(view) {
  const valid = view.verdict === "valid";
  const body = `
    ${verdictBlock(valid ? "valid" : view.verdict === "void" ? "bad" : "warn", {
    title: valid ? "This certificate is genuine" : view.verdict === "void" ? "This certificate has been voided" : "Certificate record found, school inactive",
    note: valid
      ? "The school issued this certificate to the person named below, on the date shown."
      : view.verdict === "void" ? "The school has voided this certificate. Do not rely on it." : "The issuing school is not currently active on the platform.",
  })}
    <section class="holder">
      ${view.photoPath ? `<img src="${escapeHtml(safeAssetPath(view.photoPath))}" alt="Portrait of ${escapeHtml(view.holderName)}">` : `<span class="mono" aria-hidden="true">${escapeHtml(String(view.holderName || "S").trim().slice(0, 1).toUpperCase() || "S")}</span>`}
      <div><h2>${escapeHtml(view.holderName || "Unnamed holder")}</h2><p>${escapeHtml(view.title || "Certificate")}</p></div>
    </section>
    ${fieldList([
      ["Certificate no.", view.reference],
      ["Award", view.award],
      ["Class", view.className],
      ["Session", view.session],
      ["Issued", view.issued ? dateLabel(view.issued) : ""],
      ["School", view.school && view.school.name],
    ])}
    <div class="code"><span>Certificate code</span><b>${escapeHtml(String(view.code || "").replace(/(.{4})/g, "$1 ").trim())}</b></div>`;
  return layout({
    title: `Certificate ${view.reference || ""}`,
    school: view.school,
    badgeText: "Certificate",
    body,
    action: scanBlock("Enter certificate code", {
      title: "Check a certificate",
      hint: "The certificate code is printed beside the QR code on the document.",
      endpoint: "/api/public/certificate/",
      aria: "Certificate verification code",
    }),
    homeLink: "/",
  });
}

function renderScanPage(school) {
  return layout({
    title: "Verify a card or certificate",
    school,
    badgeText: "Verification",
    body: `<section class="scan" style="border:0;margin-top:16px">
      <h3>Scan a school ID card</h3>
      <div class="row" data-scanner data-endpoint="/api/public/card/" data-placeholder="Enter card code" data-redirect="1">
        <input type="text" name="code" autocomplete="off" spellcheck="false" placeholder="Card or certificate code" aria-label="Verification code">
        <button type="button" data-scanner-open>Start camera</button>
        <button type="button" class="ghost" data-scanner-check>Check</button>
      </div>
      <p class="hint">The camera reads the QR code on the back or front of a card and opens its verification page. If a camera is not available, type the code printed under the QR.</p>
      <p class="err" data-scanner-error hidden></p>
    </section>`,
    action: "",
    homeLink: "/",
  });
}

module.exports = {
  VERDICTS,
  renderCardPage,
  renderCardUnknownPage,
  renderCertificatePage,
  renderScanPage,
};
