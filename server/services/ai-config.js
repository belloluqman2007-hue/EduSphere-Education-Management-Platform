"use strict";
/* ============================================================================
   AI PROVIDER CONFIGURATION — the layer between .env and the assistant
   ----------------------------------------------------------------------------
   The assistant needs three things to talk to a model: a key, a base URL and a
   model name. Before this module they could only come from the environment,
   read once at boot in config.AI, so changing them meant SSH + a restart.

   Now there are TWO layers:

     1. THE ENVIRONMENT (config.AI) — deploy-time control. It still wins, per
        field: if AI_API_KEY is set in the environment the stored key is
        ignored, and an operator can revoke dashboard configuration by setting
        the env var. This is deliberate: whoever controls the host must be able
        to take the key out of the hands of the dashboard.

     2. THE DATABASE (platform_settings) — what the super admin edits under
        Platform → AI Assistant. Keys: ai_provider, ai_base_url, ai_model,
        ai_enabled, ai_api_key (encrypted at rest).

   Everything is resolved at REQUEST time through resolve(), with a short
   in-process cache (30s) and explicit invalidation on save, so a key saved in
   the dashboard is used by the very next message — no restart.

   SECURITY NOTES
   • The key never leaves the server: callers receive keySet + keyLast4 only.
   • At rest it is AES-256-GCM encrypted with sha256(SESSION_SECRET), the same
     derivation services/tokens.js uses for signed tokens. Without a
     SESSION_SECRET it is stored as-is and a boot warning says so — refusing to
     boot would take the whole platform down over an optional feature.
   • The base URL is fetched server-side, so it is an SSRF surface: only
     http(s), https-only in production, and no loopback/link-local/private
     hosts or cloud metadata endpoints.
   ========================================================================== */
const crypto = require("crypto");
const config = require("../config");
const subscription = require("./subscription");
const { cleanStr } = require("../util");

/* ------------------------------ constants -------------------------------- */

/** The presets the dashboard offers. All four speak the OpenAI-compatible
    `/chat/completions` shape that services/ai.js already implements. */
const PRESETS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    console: "https://platform.openai.com/api-keys",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    console: "https://console.groq.com/keys",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    console: "https://openrouter.ai/keys",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    model: "",
    console: "",
  },
  none: {
    label: "None",
    baseUrl: "",
    model: "",
    console: "",
  },
};
const PROVIDERS = Object.keys(PRESETS);

/** The value the browser ever sees in place of a stored secret. */
const SECRET_MASK = "••••";
/** platform_settings keys this module owns. */
const SETTING_KEYS = ["ai_provider", "ai_base_url", "ai_model", "ai_enabled", "ai_api_key"];

const CACHE_TTL_MS = 30 * 1000;

/* ------------------------------ encryption ------------------------------- */

const SESSION_SECRET = String(config.SESSION_SECRET || "").trim();
/* Same derivation as services/tokens.js: sha256(SESSION_SECRET) → 32 bytes. */
const CIPHER_KEY = SESSION_SECRET ? crypto.createHash("sha256").update(SESSION_SECRET).digest() : null;
const CIPHER_PREFIX = "enc:v1:";
/** Values of ai_enabled that mean "off". */
const ENABLED_OFF = new Set(["0", "false", "no", "off"]);

let warnedPlaintext = false;
let warnedUndecryptable = false;
/** Explains, once per process, that the key is not encrypted. Called at boot
    (module load) and again if a key is actually stored without a secret. */
function warnPlaintextOnce() {
  if (warnedPlaintext) return;
  warnedPlaintext = true;
  console.warn(
    "WARNING: SESSION_SECRET is not set — an AI provider API key saved from " +
    "Platform → AI Assistant will be stored UNENCRYPTED in platform_settings. " +
    "Set SESSION_SECRET (32+ characters) to encrypt it at rest."
  );
}
if (!CIPHER_KEY) warnPlaintextOnce();

/**
 * AES-256-GCM. Output: "enc:v1:<iv b64>:<tag b64>:<ciphertext b64>".
 * Empty input → empty output; a value that is already plaintext is stored
 * as-is when there is no secret, and returned unchanged when read.
 */
function encryptSecret(plain) {
  const value = String(plain == null ? "" : plain);
  if (!value) return "";
  if (!CIPHER_KEY) { warnPlaintextOnce(); return value; }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CIPHER_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return CIPHER_PREFIX + [iv, tag, ciphertext].map((b) => b.toString("base64")).join(":");
}

/** Returns the plaintext key, or "" when the row cannot be decrypted (for
    example after SESSION_SECRET changed). Never throws. */
function decryptSecret(stored) {
  const raw = String(stored == null ? "" : stored);
  if (!raw) return "";
  if (!raw.startsWith(CIPHER_PREFIX)) return raw; // plaintext row (no SESSION_SECRET at save time)
  if (!CIPHER_KEY) return "";
  try {
    const [ivB64, tagB64, dataB64] = raw.slice(CIPHER_PREFIX.length).split(":");
    if (!ivB64 || !tagB64 || !dataB64) return "";
    const decipher = crypto.createDecipheriv("aes-256-gcm", CIPHER_KEY, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch (e) {
    if (!warnedUndecryptable) {
      warnedUndecryptable = true;
      console.warn(
        "WARNING: the stored AI provider key could not be decrypted (was SESSION_SECRET changed?). " +
        "The assistant is answering from the knowledge base; re-save the key under Platform → AI Assistant."
      );
    }
    return "";
  }
}

/** True for the placeholder the browser echoes back instead of a real key. */
function isSecretMask(value) {
  const v = String(value == null ? "" : value).trim();
  return v === SECRET_MASK || v === "****" || /^•+$/.test(v);
}

/** Last 4 characters, and only for keys long enough that 4 characters are not
    most of the secret. */
function lastFour(secret) {
  const s = String(secret || "");
  return s.length >= 8 ? s.slice(-4) : "";
}

/* --------------------------- base URL validation ------------------------- */

/* Hosts that must never be fetched server-side. 169.254.169.254 is the cloud
   metadata service (credentials live there); 10/8, 172.16/12 and 192.168/16
   are the private networks the app itself usually runs inside. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
  "metadata", "metadata.google.internal", "instance-data", "metadata.azure.internal",
]);

function ipv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

function blockedHost(hostname) {
  let host = String(hostname || "").trim().toLowerCase();
  if (!host) return "empty";
  // WHATWG URLs keep IPv6 in brackets.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  while (host.endsWith(".")) host = host.slice(0, -1);

  if (BLOCKED_HOSTNAMES.has(host)) return "localhost";
  if (host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return "local network name";

  const v4 = ipv4Parts(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return "unspecified address (0.0.0.0/8)";
    if (a === 127) return "loopback address (127.0.0.0/8)";
    if (a === 10) return "private network (10.0.0.0/8)";
    if (a === 172 && b >= 16 && b <= 31) return "private network (172.16.0.0/12)";
    if (a === 192 && b === 168) return "private network (192.168.0.0/16)";
    if (a === 169 && b === 254) return "link-local / cloud metadata address (169.254.0.0/16)";
    return "";
  }

  // IPv6: loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === "::1") return "loopback address (::1)";
  if (host === "::") return "unspecified address (::)";
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return "private IPv6 network (fc00::/7)";
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return "link-local IPv6 address (fe80::/10)";
  return "";
}

/**
 * Validates a provider base URL for server-side use.
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
function validateBaseUrl(raw, options = {}) {
  const isProd = options.production === undefined ? Boolean(config.IS_PRODUCTION) : Boolean(options.production);
  let value = String(raw == null ? "" : raw).trim();
  if (!value) return { ok: true, value: "" }; // blank = "not configured", not a bad URL
  value = value.replace(/\/+$/, "");
  if (value.length > 500) return { ok: false, error: "That base URL is too long (500 characters maximum)." };

  let url;
  try { url = new URL(value); } catch (e) {
    return { ok: false, error: "That is not a valid URL. It should look like https://api.openai.com/v1" };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, error: "The base URL must start with http:// or https:// — no other scheme is accepted." };
  }
  if (isProd && url.protocol !== "https:") {
    return { ok: false, error: "In production the base URL must use https:// — an API key must not travel over plain http." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "The base URL must not contain a username or password." };
  }
  const blocked = blockedHost(url.hostname);
  if (blocked) {
    return {
      ok: false,
      error: `That base URL points at ${blocked}, which the server refuses to call. ` +
        "Use the public address of your provider (for example https://api.openai.com/v1).",
    };
  }
  if (!url.hostname.includes(".")) {
    return { ok: false, error: "That base URL does not contain a public domain name." };
  }
  return { ok: true, value: value.replace(/\/+$/, "") };
}

/* ------------------------------ resolution ------------------------------- */

function normalizeProvider(value) {
  const p = String(value == null ? "" : value).trim().toLowerCase();
  return PROVIDERS.includes(p) ? p : "";
}

/**
 * The precedence rule, as a pure function so it can be read (and tested) in
 * one place: env wins per field, the database fills the gaps, and a provider
 * preset fills a blank base URL / model.
 *
 * @param {{apiKey?:string, baseUrl?:string, model?:string}} envLayer  config.AI
 * @param {object} settings  subscription.getSettings() (decrypted key not required)
 */
function combine(envLayer, settings) {
  const env = envLayer || {};
  const s = settings || {};

  const envKey = String(env.apiKey || "").trim();
  const envBase = String(env.baseUrl || "").trim().replace(/\/+$/, "");
  const envModel = String(env.model || "").trim();

  const storedKey = decryptSecret(s.ai_api_key);
  const storedBase = String(s.ai_base_url || "").trim().replace(/\/+$/, "");
  const storedModel = String(s.ai_model || "").trim();

  const storedProvider = normalizeProvider(s.ai_provider);
  let provider = storedProvider || "custom";
  const preset = PRESETS[provider] || PRESETS.custom;

  const apiKey = envKey || storedKey;
  const baseUrl = envBase || storedBase || preset.baseUrl || "";
  const model = envModel || storedModel || preset.model || "";
  if (provider === "none" && (apiKey || baseUrl)) provider = "custom";

  // An explicit "off" in the database disables the assistant — unless the key
  // itself is supplied by the environment, which is the deploy-time layer and
  // therefore wins. The knowledge base answers either way.
  const dbEnabled = !ENABLED_OFF.has(String(s.ai_enabled == null ? "1" : s.ai_enabled).trim().toLowerCase());
  // One complete configuration (key + base URL + model) is what "live" means.
  const enabled = Boolean(apiKey && baseUrl && model) && (envKey ? true : dbEnabled);

  const envActive = Boolean(envKey || envBase || envModel);
  const dbActive = Boolean(storedKey || storedBase || storedModel);
  const source = envActive ? "env" : dbActive ? "settings" : "none";

  return {
    enabled,
    apiKey,
    baseUrl,
    model,
    provider,
    source,
    keySet: Boolean(apiKey),
    keyLast4: lastFour(apiKey),
    // Which layer supplied each field — what the dashboard's "env is
    // overriding the form" line is built from.
    origins: {
      apiKey: envKey ? "env" : storedKey ? "settings" : "none",
      baseUrl: envBase ? "env" : storedBase ? "settings" : baseUrl ? "preset" : "none",
      model: envModel ? "env" : storedModel ? "settings" : model ? "preset" : "none",
    },
    // True when the environment pins a field, so the form must not pretend a
    // value typed here would be used.
    locked: {
      apiKey: Boolean(envKey),
      baseUrl: Boolean(envBase),
      model: Boolean(envModel),
    },
  };
}

let cache = null; // { at:number, value:object }

/** The resolver every request path uses. ~30s cache; `invalidate()` on save. */
async function resolve() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  let settings = {};
  try {
    settings = await subscription.getSettings();
  } catch (e) {
    settings = {}; // the assistant degrades to the knowledge base; it never dies
  }
  const value = combine(config.AI, settings);
  cache = { at: Date.now(), value };
  return value;
}

/** Explicit invalidation, called after every save from the dashboard. */
function invalidate() {
  cache = null;
}

/* -------------------------------- saving --------------------------------- */

/**
 * Persists the dashboard layer through subscription.setSetting (no new SQL)
 * and invalidates the cache, so the next message uses the new values.
 *
 * apiKey rules, in order:
 *   clearApiKey === true      → delete the stored key
 *   omitted / blank / "••••"  → keep the existing key untouched
 *   anything else             → encrypt and store
 *
 * @returns {Promise<object>} the freshly resolved configuration
 */
async function save(input = {}) {
  const b = input || {};
  const provider = normalizeProvider(b.provider);
  if (b.provider !== undefined && !provider) {
    throw Object.assign(new Error("Unknown AI provider."), { status: 400 });
  }

  const rawBase = b.baseUrl === undefined ? undefined : b.baseUrl;
  let baseUrl;
  if (rawBase !== undefined) {
    const checked = validateBaseUrl(cleanStr(rawBase, 500));
    if (!checked.ok) throw Object.assign(new Error(checked.error), { status: 400 });
    baseUrl = checked.value;
  }

  const updates = [];
  if (provider) updates.push(["ai_provider", provider]);
  if (baseUrl !== undefined) updates.push(["ai_base_url", baseUrl]);
  if (b.model !== undefined) updates.push(["ai_model", cleanStr(b.model, 120)]);
  if (b.enabled !== undefined) updates.push(["ai_enabled", b.enabled ? "1" : "0"]);

  if (b.clearApiKey === true) {
    updates.push(["ai_api_key", ""]);
  } else {
    const rawKey = String(b.apiKey == null ? "" : b.apiKey).trim();
    if (rawKey && !isSecretMask(rawKey)) {
      updates.push(["ai_api_key", encryptSecret(cleanStr(rawKey, 400))]);
    }
    // blank / sentinel / omitted → leave the stored key exactly as it is
  }

  for (const [key, value] of updates) await subscription.setSetting(key, value);
  invalidate();
  return resolve();
}

module.exports = {
  PRESETS, PROVIDERS, SETTING_KEYS, SECRET_MASK, CACHE_TTL_MS,
  encryptSecret, decryptSecret, isSecretMask, lastFour,
  validateBaseUrl, blockedHost, normalizeProvider,
  combine, resolve, invalidate, save,
};
