"use strict";
/* ============================================================================
   EduSphere Desktop — School LAN Hub information window
   ----------------------------------------------------------------------------
   In Local Standalone / School LAN Hub mode the app runs the real EduSphere
   server on the school PC and listens on the LAN so phones and tablets on the
   same Wi-Fi keep working with no internet. Three things MUST be visible to the
   person sitting at that PC, because they cannot be discovered by clicking:

     1. the address phones should open (and a QR to scan),
     2. the fact that this machine is now reachable from the local network,
     3. what to do when the campus firewall blocks port access.

   The window is a static, script-free HTML document (`script-src 'none'`), so
   nothing in it can call the server, the filesystem or the bridge. The pairing
   QR is drawn with the platform's own encoder (server/services/print-documents
   .qrSvg) — the same code that prints student cards, so a phone camera that
   reads a card also reads this.
   ========================================================================== */
const os = require("os");

/** Every non-internal IPv4 address on this machine (LAN + virtual adapters). */
function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const name of Object.keys(interfaces || {})) {
    for (const entry of interfaces[name] || []) {
      const family = typeof entry.family === "number" ? "IPv" + entry.family : String(entry.family || "");
      if (family !== "IPv4") continue;
      if (entry.internal) continue;
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(entry.address || ""))) continue;
      out.push({ name, address: entry.address });
    }
  }
  return out;
}

function isPrivateAddress(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

/** The address a phone is most likely to reach — a private LAN IPv4 if any. */
function primaryLanAddress(interfaces) {
  const list = lanAddresses(interfaces);
  const preferred = list.find((entry) => isPrivateAddress(entry.address));
  return (preferred || list[0] || {}).address || "";
}

function hubUrls({ port, host = "" } = {}) {
  const p = Number(port) || 0;
  const localUrl = p ? "http://127.0.0.1:" + p + "/" : "";
  const ip = host || primaryLanAddress();
  const lanUrl = p && ip ? "http://" + ip + ":" + p + "/" : "";
  return { localUrl, lanUrl, host: ip };
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** OS-specific, copy-paste-friendly firewall guidance. */
function firewallGuidance(platform, port) {
  const p = Number(port) || 0;
  if (platform === "win32") {
    return [
      "Windows may ask to allow EduSphere on private networks — choose Allow.",
      "If phones cannot connect, open Windows Defender Firewall → Advanced settings → Inbound Rules → New Rule → Port → TCP → " + p + " → Allow, and tick Private networks.",
      "Also make sure the Wi-Fi network is marked \"Private\", not \"Public\" (Settings → Network & Internet → Wi-Fi → your network).",
    ];
  }
  if (platform === "darwin") {
    return [
      "macOS may ask whether to allow incoming connections — choose Allow.",
      "If phones cannot connect: System Settings → Network → Firewall → Options → allow EduSphere (or temporarily turn the firewall off to confirm it is the cause).",
      "Port " + p + " only needs to be open on the local network; never forward it from the internet.",
    ];
  }
  return [
    "Allow port " + p + "/tcp on the local network, e.g.  sudo ufw allow " + p + "/tcp  (or the equivalent in firewalld).",
    "If you use firewalld:  sudo firewall-cmd --add-port=" + p + "/tcp --permanent && sudo firewall-cmd --reload",
    "Never expose this port to the internet — it is meant for the school's own Wi-Fi only.",
  ];
}

function pairListHtml({ port, interfaces }) {
  const list = lanAddresses(interfaces);
  if (!list.length) {
    return "<p class=\"warn\">No local network address was found. Connect this computer to the school Wi-Fi or Ethernet, then reopen this window.</p>";
  }
  const p = Number(port) || 0;
  const seen = new Set();
  const rows = [];
  for (const entry of list) {
    const url = "http://" + entry.address + ":" + p + "/";
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push(
      "<li><code>" + escapeHtml(url) + "</code><span class=\"adapter\">" + escapeHtml(entry.name) +
      (isPrivateAddress(entry.address) ? "" : " · not a school network") + "</span></li>"
    );
  }
  return "<ul class=\"pairs\">" + rows.join("") + "</ul>";
}

/**
 * Build the whole LAN Hub document.
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.host]            primary LAN IPv4
 * @param {string} [options.adminUsername]
 * @param {string} [options.dataDir]
 * @param {string} [options.platform]        process.platform
 * @param {string} [options.firstRunPassword] shown ONCE on first hub boot
 * @param {object} [options.interfaces]      os.networkInterfaces() (tests)
 * @param {(text:string)=>string} [options.qrSvg] QR encoder (server's qrSvg)
 * @param {boolean} [options.upstreamEnabled]
 * @param {string} [options.upstreamBaseUrl]
 */
function hubInfoHtml(options = {}) {
  const port = Number(options.port) || 0;
  const platform = options.platform || process.platform;
  const { lanUrl, host } = hubUrls({ port, host: options.host || primaryLanAddress(options.interfaces) });
  const qrSvg = typeof options.qrSvg === "function" && lanUrl
    ? String(options.qrSvg(lanUrl, { label: "Scan to open EduSphere on this network" }) || "")
    : "";
  const firewall = firewallGuidance(platform, port)
    .map((line) => "<li>" + escapeHtml(line) + "</li>")
    .join("");
  const passwordBlock = options.firstRunPassword
    ? "<section class=\"panel accent\"><h2>First sign-in</h2>" +
      "<p>This computer has just created its own EduSphere database. Sign in once with:</p>" +
      "<p class=\"creds\">username <code>" + escapeHtml(options.adminUsername || "admin") + "</code><br>" +
      "password <code>" + escapeHtml(options.firstRunPassword) + "</code></p>" +
      "<p class=\"muted\">Change the password from your profile after signing in. It is not shown again.</p></section>"
    : "";
  const upstream = options.upstreamEnabled && options.upstreamBaseUrl
    ? "<p class=\"muted\">Upstream cloud sync is configured to <code>" + escapeHtml(options.upstreamBaseUrl) + "</code> (used in a later phase).</p>"
    : "<p class=\"muted\">No upstream cloud is configured — this hub works entirely on the school network.</p>";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EduSphere — School LAN Hub</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:28px;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f4fb;color:#241733}
h1{margin:0 0 4px;font-size:22px}
h2{margin:0 0 8px;font-size:15px;letter-spacing:.02em;text-transform:uppercase;color:#5a4a72}
p{margin:0 0 12px}
main{max-width:720px;margin:0 auto}
.panel{background:#fff;border:1px solid #e3dcf0;border-radius:14px;padding:18px 20px;margin:0 0 16px;box-shadow:0 1px 3px rgba(36,23,51,.06)}
.panel.accent{border-color:#c9b6ea;background:#fbf8ff}
.muted{color:#6b5f7d;font-size:13px}
.warn{color:#8a4b00}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f1ecfa;border-radius:5px;padding:1px 5px;word-break:break-all}
.pairs{list-style:none;margin:0;padding:0}
.pairs li{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;padding:6px 0;border-bottom:1px dashed #eee6f8}
.pairs li:last-child{border-bottom:0}
.adapter{color:#8a7fa0;font-size:12px}
.creds code{font-size:15px;background:#efe6ff}
.qr{width:200px;height:200px;display:block;margin:6px auto 2px}
.qr svg{width:100%;height:100%}
.two{display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.two>div{flex:1 1 260px;min-width:0}
ul.help{margin:0;padding-left:20px}
ul.help li{margin:0 0 8px}
footer{color:#8a7fa0;font-size:12px;padding-top:6px}
</style>
</head>
<body>
<main>
  <h1>School LAN Hub is running</h1>
  <p class="muted">This computer is the EduSphere server for your school. Phones, tablets and other PCs on the same Wi-Fi can sign in while the internet is down.</p>

  <section class="panel">
    <h2>Open on a phone or tablet</h2>
    <div class="two">
      <div>
        ${qrSvg ? `<span class="qr">${qrSvg}</span>` : ""}
        <p class="muted" style="text-align:center">Scan with the phone camera</p>
      </div>
      <div>
        <p>On this computer: <code>http://127.0.0.1:${escapeHtml(port)}/</code></p>
        <p>On the school network:</p>
        ${pairListHtml({ port, interfaces: options.interfaces })}
        <p class="muted">Devices must be on the same Wi-Fi network — guest/isolated networks hide each other.</p>
      </div>
    </div>
  </section>

  ${passwordBlock}

  <section class="panel">
    <h2>If other devices cannot connect</h2>
    <ul class="help">${firewall}</ul>
    <p class="muted">Detected network: ${host ? "<code>" + escapeHtml(host) + "</code>" : "none"}. Port ${escapeHtml(port)} is served by EduSphere itself; no internet is required.</p>
  </section>

  <section class="panel">
    <h2>Backups &amp; data</h2>
    <p>Your school's database, uploads and automatic JSON backups live in:</p>
    <p><code>${escapeHtml(options.dataDir || "")}</code></p>
    <p class="muted">Backups are written automatically to the <code>backups</code> folder inside it. Use EduSphere → Open data folder to copy one to a USB drive.</p>
    ${upstream}
  </section>

  <footer>EduSphere desktop ${escapeHtml(options.appVersion || "")} · ${escapeHtml(platform)} · LAN hub mode</footer>
</main>
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  firewallGuidance,
  hubInfoHtml,
  hubUrls,
  isPrivateAddress,
  lanAddresses,
  primaryLanAddress,
};
