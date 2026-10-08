"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — DATABASE_URL query parameters
   ----------------------------------------------------------------------------
   mysql2 copies EVERY query parameter of a connection URI into its options and
   prints "Ignoring invalid configuration option passed to Connection: <name>"
   for each one it does not recognise. `ssl-mode` is such a parameter: it is the
   MySQL Connector/J and MySQL Shell spelling of the TLS setting (`sslmode` is
   the PostgreSQL spelling, accepted here too). mysql2 has no ssl-mode option;
   its TLS switch is the `ssl` object, which this app sets from DB_SSL.

   splitUrlSslMode() removes those parameters before the driver sees the URL and
   returns the requested mode, so the boot can say what it means. The mode is
   deliberately NOT applied: the connection has always been plaintext (mysql2
   ignored the parameter), and switching it to TLS could stop the app from
   connecting to a server that does not offer TLS. Set DB_SSL=true to turn TLS
   on on purpose. See docs/DATABASE.md → "TLS".
   ========================================================================== */

const SSL_MODE_PARAMS = new Set(["ssl-mode", "sslmode"]);

/**
 * Splits a connection URL into the same URL without the ssl-mode parameters and
 * the mode it asked for: null when it did not ask, "" when it asked with no value.
 */
function splitUrlSslMode(url) {
  const text = String(url || "");
  const q = text.indexOf("?");
  if (q === -1) return { url: text, sslMode: null };
  let sslMode = null;
  const kept = [];
  for (const pair of text.slice(q + 1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    if (SSL_MODE_PARAMS.has(key)) {
      sslMode = normaliseSslMode(eq === -1 ? "" : pair.slice(eq + 1));
    } else {
      kept.push(pair);
    }
  }
  const base = text.slice(0, q);
  return { url: kept.length ? base + "?" + kept.join("&") : base, sslMode };
}

/** "REQUIRED", "verify-ca" and "VERIFY_CA" all become "VERIFY_CA". */
function normaliseSslMode(raw) {
  let value = String(raw);
  try {
    value = decodeURIComponent(value);
  } catch (e) {
    // A malformed escape is kept as written.
  }
  return value.trim().toUpperCase().replace(/-/g, "_");
}

module.exports = { splitUrlSslMode, normaliseSslMode };
