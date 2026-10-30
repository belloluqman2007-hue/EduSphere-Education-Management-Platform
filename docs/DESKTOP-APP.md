# EduSphere Desktop (Windows, macOS, Linux)

The desktop app is the same EduSphere platform in a native window, with one
addition the browser can never offer: **it can be the school's own server**.
A school with no internet runs the app on the office PC and every phone, tablet
and laptop on the school Wi-Fi keeps working — attendance, results, fees, Hifz
logs and printing — then syncs to the cloud when a connection returns.

- **Installers:** `EduSphere-<version>-win-x64.exe`, `-win-arm64.exe`,
  `-mac-universal.dmg`, `-linux-x64.AppImage`, `-linux-x64.deb` (+ arm64).
- **No fork of the web app.** The desktop shell loads the very same
  `public/` bundle (including the Phase 2 offline engine) and, in LAN hub mode,
  boots the very same `server/` Express + SQLite code.

---

## 1. Install

> **Not technical?** [docs/INSTALL.md](INSTALL.md) is the same information
> written for a head teacher, including how to make the release page produce
> these files in the first place (copy the two workflow files into
> `.github/workflows/`, then publish a `v1.0.0` tag).

| OS | File | Steps |
|---|---|---|
| **Windows 10/11** (x64 or arm64) | `EduSphere-1.0.0-win-x64.exe` | Double-click → *Install for me only* (no admin rights needed) → the app opens. A desktop and Start-menu shortcut are created. SmartScreen will warn on an unsigned build: **More info → Run anyway** (a signed release from the project does not). |
| **macOS 13+** (Intel + Apple silicon) | `EduSphere-1.0.0-mac-universal.dmg` | Open the `.dmg`, drag **EduSphere** onto the *Applications* alias. First launch of an unsigned build: right-click the app → **Open** → *Open*. |
| **Linux** | `EduSphere-1.0.0-linux-x64.AppImage` or `.deb` | AppImage: `chmod +x EduSphere-*.AppImage && ./EduSphere-*.AppImage`. Debian/Ubuntu: `sudo apt install ./EduSphere-1.0.0-linux-x64.deb`. |
| **Linux (keyring)** | — | The device token is encrypted with the OS keychain. Install `libsecret-1-0` (GNOME Keyring) or KWallet — the `.deb` depends on it. Without a keyring the app still works, but the sign-in lasts for the session only (it says so in Desktop settings). |

Uninstalling never deletes school data: the database, uploads and backups live in
the per-user data folder (below) and are removed only by hand.

---

## 2. First run — pick a mode

The first window asks one question. You can change the answer at any time from
**EduSphere → Desktop settings…** (or the tray's **Mode** menu).

### a) Cloud-synced app
*Best for an office with working internet.*

1. Choose **Cloud-synced app**.
2. Enter the address your school already uses in a browser, e.g.
   `https://school.edusphere.app` (an address without `https://`, or with
   credentials embedded, is refused).
3. Sign in. On success the server mints a **device token** (`eds_…`). The app
   stores it in the OS keychain, and every request is authenticated with
   `Authorization: Bearer …` — no cookies, no CSRF handshake.

Everything the Phase 2 engine does in a browser still happens here: reads come
from the local IndexedDB store, writes go to the outbox first, and the sync pill
in the header drains the queue when the connection returns.

### b) Local school LAN hub
*Best for a school with no reliable internet.*

1. Choose **Local school LAN hub**. Pick the administrator username (default
   `admin`) and a password of at least 8 characters — this is the first sign-in
   for the database created on this PC. The password is stored in the OS
   keychain, never in a file, and is shown once on the pairing window.
2. The app starts the real EduSphere server inside the app: SQLite database,
   migrations and seeds run automatically in
   `<user data>/data/madrasa_platform.sqlite`, with `NODE_ENV=production` and a
   generated 96-character `SESSION_SECRET` kept in the keychain.
3. A **School LAN Hub** window opens showing:
   - the address for this computer (`http://127.0.0.1:<port>/`),
   - every reachable LAN address (`http://192.168.x.x:<port>/`) with a **QR code**
     (drawn by the platform's own encoder, the one printed on student cards),
   - firewall guidance for the current OS.

Phones/tablets: connect to the school Wi-Fi, scan the QR (or type the address),
sign in. They are talking to the PC, so a downed internet line changes nothing.

**Ports.** By default a free port is chosen on every launch and shown on the
pairing window. To pin one, set `hub.port` in
`<user data>/settings.json` (e.g. `4123`); if that port is taken the app falls
back to a free one and says so in the log.

**Firewall.** Allow the port on **private** networks only (see the pairing
window for the exact Windows/macOS/Linux instructions). Never forward it from
the internet: the hub is a LAN service. LAN mode is the *only* mode that binds
`0.0.0.0`; cloud mode always binds `127.0.0.1` and serves nothing.

**Optional upstream cloud.** `hub.upstream = { enabled: true, baseUrl: "…" }`
passes `EDUSPHERE_UPSTREAM_BASE_URL` to the embedded server for a later phase;
nothing is uploaded until that feature ships.

---

## 3. Where the data lives

| OS | Data folder (`EduSphere → Open data folder`) |
|---|---|
| Windows | `%APPDATA%\EduSphere\data` |
| macOS | `~/Library/Application Support/EduSphere/data` |
| Linux | `~/.config/EduSphere/data` |

Inside it: `madrasa_platform.sqlite` (the whole school), `uploads/` (photos,
logos, signatures) and `backups/` (JSON snapshots). Alongside it,
`settings.json` (mode/address/window — no secrets) and `secrets/` (safeStorage
ciphertext) and `logs/main.log`.

## 4. Backup and restore

- **Automatic:** every 3 hours the embedded server writes a JSON snapshot to
  `data/backups/` (12 kept). A final snapshot is written on every clean quit.
- **Manual:** *Platform → Backups* in the UI writes one on demand and can
  download it; or run the CLI against the same folder:

  ```bash
  DATA_DIR="<data folder>" npx --yes node -e "require('./server/backup.js')"
  # with the repository checked out:
  DATA_DIR="<data folder>" node server/backup.js --list
  DATA_DIR="<data folder>" node server/backup.js --restore <name>
  ```

  (Close the app first: SQLite allows one writer.)
- **Restore on a new PC:** install the app, quit it, copy the old `data` folder
  over the new one, start the app. An empty database is even auto-restored from
  the newest snapshot on boot.

---

## 5. Printing and PDF export (works offline)

- **Ctrl/Cmd + P** — native print dialog for whatever is on screen.
- **Ctrl/Cmd + Shift + P** — *Save as PDF…* using Chromium's `printToPDF`.
- Report cards, receipts, ID cards and certificates render from the **local**
  server in LAN mode, so printing works during an outage. Batch report sheets
  are rendered in an off-screen window and saved as one PDF.
- The page can also ask the shell directly through
  `window.__EDUSPHERE_NATIVE__.print()` / `.savePdf()`.

---

## 6. Deep links

`edusphere://` is registered with the OS on first run:

| Link | Effect |
|---|---|
| `edusphere://sync` | flush the offline outbox now |
| `edusphere://settings` | open Desktop settings |
| `edusphere://hub` | open the LAN Hub pairing window |
| `edusphere://mode/hub`, `edusphere://mode/cloud` | switch mode |
| `edusphere://about` | About EduSphere |
| `edusphere://open/<path>` | navigate inside the workspace (same origin only) |

Anything else is rejected (wrong scheme, `..`, control characters, foreign host)
and the app simply stays where it is.

## 7. Build the installers locally

```bash
# once
npm ci                       # repository root (platform deps, tests)
cd desktop && npm ci         # Electron + electron-builder (never in the root)

npm run icons                # (re)generate PNG/ICO/ICNS/AppImage icons
npm test                     # 53 headless tests, no display needed
npm run stage                # copy ../server and ../public into desktop/
npm run dist                 # all targets for THIS OS → desktop/dist/
npm run dist:linux           # AppImage + .deb
npm run dist:win             # NSIS .exe (x64 + arm64)
npm run dist:mac             # universal .dmg
npm start                    # run the unpackaged app (development mode)
```

Artifacts are named `EduSphere-<version>-<os>-<arch>.<ext>` in `desktop/dist/`.
Cross-building is limited (a macOS `.dmg` needs macOS); GitHub Actions does all
three — see the next section.

## 8. CI release workflow

The installer pipeline lives in **`docs/ci/desktop-release.yml`** (versioned
there because the branch automation account has no GitHub `workflows`
permission). Activate it once:

```bash
mkdir -p .github/workflows
cp docs/ci/desktop-release.yml .github/workflows/desktop-release.yml
git add .github/workflows/desktop-release.yml && git commit -m "ci: enable desktop release workflow"
```

It then runs on every push: a headless test job (desktop suite + the
SQL/CSRF/login guards), a build matrix on `ubuntu-24.04` / `macos-latest` /
`windows-latest` with npm caching and `npm ci` at the root *and* in `desktop/`,
artifacts uploaded on every run, and — on a `v*` tag — a release job that
attaches every installer to the GitHub Release.

> **Why `ubuntu-24.04` and not `ubuntu-latest`?** Release legs are pinned to an
> image instead of the moving label (GitHub has announced `ubuntu-latest`
> migrates to Ubuntu 26.04 / glibc 2.43, where electron-builder's bundled
> AppImage tooling is known to break). The pin is asserted by
> `desktop/test/packaging.test.js`.
>
> **The Linux leg needs `homepage` in `desktop/package.json`.** It builds an
> AppImage *and* a `.deb`; the `.deb` is produced by fpm, which aborts the whole
> job with *"Please specify project homepage, see …/configuration#metadata"* if
> that field is missing. `description`, `license` and `author.email` are read by
> the same code, and all four are now asserted by the packaging suite.

## 9. Code signing (optional, env-driven)

Unsigned builds work everywhere; a signed build removes the OS warnings.

| Target | Secrets | Notes |
|---|---|---|
| Windows | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | base64 `.pfx` / a path to it. |
| macOS | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Developer ID Application certificate. |
| macOS notarization | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | CI adds `--config.mac.notarize=true` only when `MAC_CSC_LINK` is set. |

`electron-builder.yml` ships `notarize: false` so a local build never fails on a
missing certificate. Hardened-runtime entitlements live in
`desktop/resources/entitlements.mac.plist` (JIT, `network.server` for LAN mode,
printing) and `entitlements.mac.inherit.plist` for the helper processes.

## 10. Security posture (verified by `desktop/test/`)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no remote
  module, no `<webview>`, `webSecurity: true`.
- The window may only navigate inside its own origin; every new window is denied
  and every other link goes to the real browser (http/https/mailto only).
- Page permission requests (camera, mic, geolocation) are refused.
- The device token is stored **only** encrypted with Electron `safeStorage`
  (Keychain / DPAPI / libsecret) and never in `localStorage`; with no keychain it
  stays in memory for the session and says so.
- Cloud mode binds loopback only; `0.0.0.0` is reachable exclusively in LAN hub
  mode, behind a single `bindHostForMode()` policy function.
- `uncaughtException` / `unhandledRejection` are logged to
  `logs/main.log` and answered with a friendly dialog; a crashed or unreachable
  page is replaced by a real recovery page.
- The web app's CSP is untouched — the shell injects nothing into the pages.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| "EduSphere could not open the workspace" | Cloud mode: check the address and the internet. LAN mode: give the hub a few seconds, then *Try again*. |
| Phones cannot reach the hub | Same Wi-Fi? Guest/isolated networks hide devices. Allow the port on the private network (pairing window). |
| App starts in the wizard every time | `settings.json` was unreadable; a copy is kept as `settings.corrupt-<ts>.json` in the data folder. |
| "sign-in lasts for this session only" | No OS keychain (Linux without libsecret/KWallet). Install it, or accept per-session sign-in. |
| Frozen installer / black window on Linux | Use the AppImage or install the `.deb` (it pulls `libsecret`, `libgtk-3`, `libnss3`). |
| Need the log | `EduSphere → About` shows the data folder; logs are in `logs/main.log` (rotated at 2 MB). |
