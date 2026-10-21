"use strict";
/* ============================================================================
   THE WHATSAPP LINE — one number, configured in one place
   ----------------------------------------------------------------------------
   The public website's "Chat on WhatsApp" button, the AI panel and the
   platform's info endpoints all need the same number and the same prefilled
   message. This module is that single source of truth.

   Resolution order:
     1. WHATSAPP_AI_DISPLAY_NUMBER  (environment / Render dashboard)
     2. Platform → Settings → WhatsApp line  (whatsapp_ai_number)
     3. the platform's public contact phone   (public_contact_phone)
     4. the billing contact phone             (billing_contact_phone)

   A number is normalised to international digits with no "+", which is what
   wa.me expects. A Nigerian local number (0803…) becomes 234803… so a school
   or operator who types the familiar local form still gets a working link.
   ========================================================================== */
const db = require("../db");
const config = require("../config");

const DEFAULT_MESSAGE = "Hello EduSphere, I would like to know more about the platform.";

/** International digits, no "+", no spaces. */
function digits(value) {
  let d = String(value || "").replace(/\D+/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  // 0803… (11 digits) → 234803… — the form people actually type in Nigeria.
  if (d.length === 11 && d.startsWith("0")) d = `234${d.slice(1)}`;
  return d;
}

async function settings() {
  try {
    const rows = await db.all(
      "SELECT key_name, value FROM platform_settings WHERE key_name IN ('whatsapp_ai_number','whatsapp_ai_message','public_contact_phone','billing_contact_phone')"
    );
    const out = {};
    for (const r of rows || []) out[r.key_name] = r.value == null ? "" : String(r.value);
    return out;
  } catch (e) {
    return {};
  }
}

/** `?text=` for a wa.me link, safely encoded (newlines allowed). */
function withText(link, text) {
  const t = String(text || "").trim();
  if (!link || !t) return link;
  return `${link}?text=${encodeURIComponent(t.slice(0, 900))}`;
}

function link(number, text) {
  const n = digits(number);
  return n ? withText(`https://wa.me/${n}`, text) : "";
}

/** The live line: what the website shows, and whether it can be used at all. */
async function line() {
  const s = await settings();
  const candidates = [
    config.WHATSAPP_AI.displayNumber,
    s.whatsapp_ai_number,
    s.public_contact_phone,
    s.billing_contact_phone,
  ];
  let number = "";
  for (const c of candidates) {
    const d = digits(c);
    if (d) { number = d; break; }
  }
  const message = String(s.whatsapp_ai_message || "").trim() || DEFAULT_MESSAGE;
  const apiEnabled = Boolean(config.WHATSAPP_AI.enabled);
  return {
    available: Boolean(number),
    number,
    display: number ? `+${number}` : "",
    message,
    link: link(number, message),
    // `api_enabled` says the Meta credentials are present (the assistant will
    // answer automatically). `available` only says the number is known, so a
    // school/operator can still offer WhatsApp before the bot is connected.
    api_enabled: apiEnabled,
    provider: config.WHATSAPP_AI.provider,
  };
}

module.exports = { line, link, digits, withText, DEFAULT_MESSAGE };
