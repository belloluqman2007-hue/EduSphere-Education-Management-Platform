"use strict";
/* ============================================================================
   EduSphere Desktop — deep links (`edusphere://…`)
   ----------------------------------------------------------------------------
   A deep link is UNTRUSTED input: it can arrive from any web page, chat message
   or e-mail, and on Windows/Linux it is simply a command-line argument. So the
   whole link is parsed here, in one place, with an allow-list of shapes:

       edusphere://sync                 flush the offline outbox now
       edusphere://settings             open Desktop Settings
       edusphere://hub                  show the LAN Hub / pairing window
       edusphere://mode/hub             switch to a runtime mode (cloud|hub)
       edusphere://about                About EduSphere
       edusphere://open/<in-app path>   navigate inside the workspace

   Anything else — another scheme, a `javascript:` payload, a `file:` path,
   control characters, an over-long string — is rejected with a reason and the
   app simply stays where it is. Nothing from a deep link is ever passed to
   `loadURL()` without being resolved against the *configured* base URL first.
   ========================================================================== */

const DEEP_LINK_SCHEME = "edusphere";
const MAX_DEEP_LINK_LENGTH = 2048;

const KINDS = Object.freeze({
  SYNC: "sync",
  SETTINGS: "settings",
  HUB: "hub",
  MODE: "mode",
  ABOUT: "about",
  OPEN: "open",
});

function fail(error) {
  return { ok: false, kind: null, error: String(error || "invalid deep link") };
}

/**
 * Parse a raw `edusphere:` URL into a small, fully validated action object.
 * @param {string} raw
 * @returns {{ok:boolean, kind?:string, mode?:string, path?:string, error?:string}}
 */
function parseDeepLink(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return fail("empty deep link");
  if (text.length > MAX_DEEP_LINK_LENGTH) return fail("deep link is too long");
  // Control characters are how a shell/log injection usually starts.
  if (/[\u0000-\u001f\u007f]/.test(text)) return fail("deep link contains control characters");
  // Checked on the RAW text: the URL parser would silently collapse "..", and
  // a link that meant to walk up a path must be refused, not repaired.
  if (text.includes("..")) return fail("path traversal is not allowed");

  let url;
  try {
    url = new URL(text);
  } catch (e) {
    return fail("not a URL");
  }
  if (url.protocol !== DEEP_LINK_SCHEME + ":") return fail("unsupported scheme");
  if (url.username || url.password) return fail("credentials are not allowed in a deep link");

  // `edusphere://sync`  → host "sync", pathname ""
  // `edusphere:///sync` → host "",      pathname "/sync"
  const host = String(url.hostname || "").toLowerCase();
  const segments = String(url.pathname || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });

  const head = host || (segments.shift() || "");
  const action = head.toLowerCase();

  if (action === KINDS.SYNC && segments.length === 0) return { ok: true, kind: KINDS.SYNC };
  if (action === KINDS.SETTINGS && segments.length === 0) return { ok: true, kind: KINDS.SETTINGS };
  if (action === KINDS.HUB && segments.length === 0) return { ok: true, kind: KINDS.HUB };
  if (action === KINDS.ABOUT && segments.length === 0) return { ok: true, kind: KINDS.ABOUT };
  if (action === KINDS.MODE && segments.length === 1) {
    const mode = segments[0].toLowerCase();
    if (mode !== "cloud" && mode !== "hub") return fail("unknown mode");
    return { ok: true, kind: KINDS.MODE, mode };
  }
  if (action === KINDS.OPEN) {
    const path = normalizeRoute(segments.join("/"));
    if (!path) return fail("invalid in-app path");
    return { ok: true, kind: KINDS.OPEN, path };
  }
  // `edusphere://app/admin/students` (the shell form used by the web build).
  if (action === "app" && segments.length) {
    const path = normalizeRoute(segments.join("/"));
    if (!path) return fail("invalid in-app path");
    return { ok: true, kind: KINDS.OPEN, path };
  }
  return fail("unknown action");
}

/**
 * Turn a path out of a deep link into a safe in-app route:
 * relative, no protocol, no traversal, no query, no fragment.
 */
function normalizeRoute(input) {
  let value = String(input == null ? "" : input)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\/+/, "")
    .trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "";      // no scheme at all
  if (value.includes("..")) return "";
  if (/^[\\/]/.test(value)) return "";
  value = value.split("#")[0].split("?")[0];
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(value)) return "";
  return value.replace(/\/{2,}/g, "/");
}

/**
 * Resolve a deep link against the base URL actually in use for the active
 * mode. Returns `{ url }` for navigation actions, `{ kind }` for shell actions
 * (sync/settings/hub/mode) and `{ error }` for anything invalid.
 */
function resolveDeepLink(raw, baseUrl) {
  const parsed = parseDeepLink(raw);
  if (!parsed.ok) return parsed;
  if (parsed.kind !== KINDS.OPEN) return parsed;

  let base;
  try {
    base = new URL(String(baseUrl || ""));
  } catch (e) {
    return fail("no base URL is configured");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return fail("base URL must be http(s)");
  const url = new URL(parsed.path, base);
  if (url.origin !== base.origin) return fail("path escaped the app origin");
  return { ok: true, kind: KINDS.OPEN, path: parsed.path, url: url.toString() };
}

module.exports = {
  DEEP_LINK_SCHEME,
  KINDS,
  MAX_DEEP_LINK_LENGTH,
  normalizeRoute,
  parseDeepLink,
  resolveDeepLink,
};
