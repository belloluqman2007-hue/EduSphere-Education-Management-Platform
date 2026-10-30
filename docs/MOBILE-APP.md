# EduSphere Mobile (Android phones & tablets, iPhone & iPad)

EduSphere Mobile is the **same application** that runs in the browser and on the
desktop — the identical `public/` bundle, the same offline engine, the same
screens — wrapped in a thin native shell so a teacher can walk a classroom with
a phone, mark attendance by pointing the camera at a pupil's card, and keep
working when the school's Wi-Fi does not.

There is **no second app to learn**: a change made on the phone is the same
record the office sees on its computer, because both talk to the same server
through the same `window.API` layer.

---

## 1. Install

> **Not technical?** [docs/INSTALL.md](INSTALL.md) walks through the Android
> install (including the "unknown apps" prompt) and how to get the `.apk` in
> the first place: copy the two workflow files into `.github/workflows/`, then
> publish a `v1.0.0` tag.

| Platform | How pupils and teachers get it |
| --- | --- |
| **Android phone / tablet** | **Google Play Console** (internal testing → closed → production), or the `.apk` from a GitHub Release for schools that side-load |
| **iPhone / iPad** | **TestFlight**, then the App Store; the `.ipa` is uploaded with Xcode/Transporter |

The app needs **Android 6.0 (API 23)** or newer, or **iOS / iPadOS 14** or newer.
It runs on a phone and expands to two columns on a tablet — the same download,
no separate "HD" build.

---

## 2. First run — pick a mode

Exactly like the desktop app, the first screen asks one question: *where does
this device get its data?*

### a) School server (cloud or on-premise)

Type the school's address, e.g. `https://school.edusphere.app`, or scan the
**QR code** the office prints from **Settings → Devices**. The address is
remembered; the user signs in once and the device is registered. From then on
the phone opens **straight to the dashboard** — the school server is a
90-day device session, not a password in a box.

### b) **LAN hub** (no internet at all)

The school's office computer runs the Phase 3 desktop/hub build. On the same
Wi-Fi the phone can reach it at a private address such as
`http://192.168.1.20:4123` — the exact address is shown on the hub's
**Settings → This device** screen, and the same QR code fills it in.

Plain `http://` is accepted **only** for private networks
(`10.x`, `172.16–31.x`, `192.168.x`, `localhost`, `*.local`). A public address
must be `https://`; anything else is refused on the spot, so a mistyped or
malicious link cannot downgrade the connection. **LAN hub** mode works with the
router unplugged from the internet: the phone syncs to the office computer over
the school's own Wi-Fi.

> **Changed your mind?** *Settings → Connection* lets you switch between the two
> at any time. Queued work is kept and sent to whichever server you choose next,
> because the queue is stored per account, not per address.

---

## 3. Working offline

Everything that reads data reads it from **the phone's own copy**:

```
app-private SQLite database → edusphere_offline.db
  collections · meta · outbox · id_map · snapshots · kv
```

That database lives in the app's private storage (Android: `databases/`;
iOS: `Application Support/`), **not** in the WebView cache — so clearing the
browser cache, closing the app, or killing it from the task switcher does not
touch it. Writes are committed one statement at a time (WAL on iOS), so a
battery-flat phone mid-save loses at most the tap in progress, never the queue.

Anything the phone cannot send yet goes into the **pending queue** (the
`outbox` table). It survives:

* the app being **killed** from the task switcher,
* a **restart** and even a **phone reboot**,
* a **cache clear** (Settings → Apps → Storage → Clear cache),
* a flight-mode trip to a village school.

When the connection returns, the queue is sent in order, and the server's answer
is what decides what the phone shows — never the phone's guess.

This is the **same** Phase 2 engine as the web app and desktop: `offline-db.js`,
`sync-engine.js`, `outbox`, the same conflict rules. Mobile adds only the
*storage backend* (SQLite instead of IndexedDB) behind that same API. A phone
upgraded from an older build copies its IndexedDB queue into SQLite **once**
(`migrateFromIndexedDB`), marked with `MIGRATION_FLAG`.

---

## 4. Attendance by camera

**Attendance → Scan a card** opens the camera:

1. **Permission is requested at that moment**, not at launch. The app explains
   *why* ("to read the pupil's card") before the OS dialog appears.
2. **Granted** → a viewfinder with a **torch** button (for a dim classroom, and
   only if the camera reports a torch). A QR code is decoded **on the device**;
   no photo ever leaves the phone, and the frame is not stored.
3. **Denied once** → the app shows the explanation again, focuses the **manual
   code box**, and does not nag with a Settings button.
4. **Denied permanently** → the app **never calls the camera again**; it offers
   *Open Settings* (`[data-scanner-settings]`) and the manual box.
5. **No camera / broken camera** → manual entry, always.

The scan calls the same `attendance.scan` endpoint as every other surface
(through `window.API`, so the CSRF/device-token rules are identical). On the
phone the request no longer needs a CSRF handshake — it carries the device
token from the OS store instead.

> A pupil's card is a printed QR code containing the pupil's EduSphere code.
> Cards are generated from **Students → Print cards**; nothing personal is
> encoded on the card itself.

The manifest declares `CAMERA` with `uses-feature camera required="false"`, and
`MainActivity` **never** requests the permission at launch. `Info.plist`
carries `NSCameraUsageDescription` in plain language.

---

## 5. Native behaviour

* **Safe areas** — the layout respects notches, rounded corners and the home
  indicator; nothing important hides behind them.
* **44 px targets** (48 px for primary actions) — a thumb, not a mouse.
* **Hardware/gesture back** closes an open dialog, sheet or drawer **first**,
  then steps back through history, and only leaves the app from the dashboard.
* **No rubber-band scroll** on the app frame; a screen that fits does not bounce.
* **Keyboard-aware** — the focused field scrolls above the keyboard instead of
  underneath it.
* **Tablet two-column register** — the same register becomes master/detail on a
  tablet's width, without duplicating rows or `id`s.
* **Deep links** — `edusphere://sync`, `edusphere://open/reports/term-1`,
  `edusphere://hub?url=…`. Only that scheme and those actions are accepted;
  the path is normalised and may not escape the app.
* **Printing / PDF** — goes through the OS print sheet (`print`) and the OS save
  dialog (`savePdf`), so a phone can share a report to WhatsApp or mail without
  a printer driver.
* **A friendly screen instead of a blank page** — an uncaught error, a rejected
  promise, or a shell that does not paint within 12 seconds shows
  *"Something went wrong on this screen — your work is saved on this device"*
  with a **Reload** button.

---

## 6. Where the data lives, and how to back it up

| Data | Where | Backed up by |
| --- | --- | --- |
| Session token | **Android Keystore** (AES-256-GCM) / **iOS Keychain** | nothing — `ThisDeviceOnly`, never leaves the phone |
| Offline database | app-private SQLite | the school server, once synced (Settings → Sync now) |
| Pending queue | the same database (`outbox`) | sent automatically when online; nothing to export |
| Server address | plain app preferences | re-enter or re-scan the QR code |

Android backups are **off** (`android:allowBackup="false"`), and the Keychain
item is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` with the service
`app.edusphere.mobile.secrets`. **The token is never written to
`localStorage`, to a file, to a cookie or to a log.** If the phone is wiped or
the app is reinstalled, the token is gone by design — sign in again and the
queue is rebuilt from the server.

**Switching phones:** sign out on the old device (which destroys its token),
install on the new one, sign in. Queued work that has *not* been synced has to
be synced first — the app warns before a sign-out that has unsent work.

---

## 7. Build it yourself

The mobile workspace is **self-contained**. The repository root stays a plain
web project: `npm install` at the root does not download Capacitor, and the root
`npm test` is unchanged. Everything mobile lives in `mobile/`:

```bash
cd mobile
npm install            # Capacitor + native tooling only in here
npm test               # the mobile test suite (no device needed)

npm run sync:web       # copy the repo's public/ into the mobile shells
npm run add:android    # once: create android/ (already committed)
npm run add:ios        # once: create ios/ (already committed)
```

In a browser the app loads one small guard (`public/js/native-boot.js`) and
**none** of the native code; inside Capacitor the guard pulls in the bridge, the
SQLite storage adapter and the mobile shell before `api.js` runs, so the phone
gets the native behaviour and the web app keeps its original boot speed.

`npm run sync:web` (`scripts/sync-web.js`) mirrors `desktop/scripts/stage.js`:
it copies `public/` into `android/app/src/main/assets/public` and
`ios/App/App/public`, refusing to run if the two ever disagree with the source.

Then build:

```bash
npm run build:android            # debug .apk, no signing needed
npm run build:android:release    # signed .apk + .aab   (needs a keystore)
npm run build:ios                # archive; exports .ipa when a team id is set
```

**Android signing** is environment-driven, so no secret is ever committed:

```
EDUSPHERE_KEYSTORE_PATH   # or android/keystore.properties
EDUSPHERE_KEYSTORE_PASSWORD
EDUSPHERE_KEY_ALIAS
EDUSPHERE_KEY_PASSWORD
```

With none of them set the **debug** key signs the build — that is how the
debug `.apk` in CI is produced. A release build needs a real **keystore**
(`.jks`), which is *never* committed; `mobile/` is scanned for keystores by the
test suite.

**iOS** needs macOS + Xcode + CocoaPods. The bundle id is
`app.edusphere.mobile`, deployment target 14.0, and the Keychain sharing
entitlement is not used (the app's own Keychain is enough). Set
`EDUSPHERE_IOS_TEAM_ID` (and a method, default `app-store`) and the build
exports an `.ipa`.

---

## 8. CI release workflow

`docs/ci/mobile-release.yml` is the canonical workflow; it is also committed at
`.github/workflows/mobile-release.yml` when the token has the `workflows`
permission. Jobs:

| Job | Runs on | Produces |
| --- | --- | --- |
| `test` | Ubuntu | lint + the mobile suite and the root suite |
| `android` | Ubuntu | `EduSphere-<version>-android-debug.apk`, and with a keystore `-android-release.apk` + `-android-release.aab` |
| `ios` | macOS | `EduSphere-<version>-ios.ipa` — **secret-gated** by `EDUSPHERE_IOS_BUILD` / `APPLE_TEAM_ID` |
| `release` | Ubuntu | attaches every artifact to a GitHub Release on a `v*` tag |

Artifacts are uploaded on **every push** to `main` (so a teacher can be handed
a build to test), and a `v*` tag adds them to a published Release. The iOS job
runs `xcodebuild archive` and `xcodebuild -exportArchive`; without the Apple
secrets it still builds an **unsigned** archive and says so, so a fork never
fails for lack of a certificate.

Secrets for a signed iOS build: `APPLE_TEAM_ID`, `APPLE_CERTIFICATE_BASE64`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_PROVISIONING_PROFILE_BASE64`,
`APPLE_KEYCHAIN_PASSWORD`.

---

## 9. Security posture (verified by `mobile/test/`)

Hard requirements, each proven by a test rather than promised:

* **No plaintext token, ever.** The bearer token is written only through
  `setSecureValue` → AndroidKeyStore AES-256-GCM / iOS Keychain. No
  `localStorage`, no cookie, no file, no log. A legacy browser token from an
  older build is **deleted**. (`secure-token.test.js`)
* **The token is not backed up** to another device (`ThisDeviceOnly`,
  `allowBackup="false"`).
* **The camera is only requested when the scanner opens**, with a rationale and
  a working permanently-denied path. (`camera-permission.test.js`)
* **No remote code, no `eval`, no `new Function`.** The QR decoder is vendored
  and served from the app's own bundle. (`security.test.js`)
* **Allow-lists** for servers (https or private-LAN http), deep links
  (`edusphere:` only) and `openExternal` (web, `mailto:`, `tel:` only).
* **Zero crashes**: uncaught errors, rejected promises and a silent boot all end
  on a recovery screen with a reload button, never a white rectangle.
  (`security.test.js`)
* **No data loss** on kill/restart/cache-clear, and no queue lost on an update
  (`storage-adapter.test.js`, `security.test.js`).

The **same frozen native contract** as the desktop shell is exposed at
`window.__EDUSPHERE_NATIVE__`:

```js
isNative, appVersion, platform, deviceId, deviceName, mode,
getDeviceToken(), setDeviceToken(t), clearDeviceToken(),
print(options), savePdf(options), openExternal(url)
```

`mobile/test/bridge-contract.test.js` freezes the surface, so a future change
that would silently break `api.js` fails the build on both platforms at once.

**Verified on this branch:** `mobile/` **94 tests passing** (bridge contract 14,
storage adapter 7, network listener 13, camera 11, API native path 8, packaging
17, secure token 11, security 13), and the root web
suite is unchanged by the mobile work.

---

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Cannot reach the school server" | Check the address in *Settings → Connection*; on a LAN hub make sure the phone is on the school Wi-Fi and the hub is running. |
| The camera never opens | *Settings → Apps → EduSphere → Permissions → Camera*; then use the manual code box — attendance still works. |
| Work is waiting to sync | The badge on the header shows the queue; tap it (or *Settings → Sync now*) once you are online. |
| A screen is blank | The app shows its recovery screen within 12 seconds; tap **Reload**. If it persists, sign out and back in — the queue is kept. |
| New phone | Sign out on the old one (it wipes its token), install, sign in, sync. |
| Nothing arrives in TestFlight | The iOS job is secret-gated: adding the Apple secrets is what turns the `.ipa` from unsigned into a TestFlight build. |

---

*Related: [DESKTOP-APP.md](DESKTOP-APP.md) · [OFFLINE-NATIVE-APP-ROADMAP.md](OFFLINE-NATIVE-APP-ROADMAP.md) · [OFFLINE-ARCHITECTURE.md](OFFLINE-ARCHITECTURE.md)*
