# Installing EduSphere — the plain-language guide

This page is for **teachers, head teachers and office staff** who want the
EduSphere apps on their computer or phone — no programming knowledge needed.
Everything is done by clicking in a web browser.

There are three things you can do here:

1. [Turn the "installer factory" on](#part-1--turn-the-installer-factory-on)
   (two files, one copy‑and‑paste each).
2. [Ask it to make version 1.0.0](#part-2--make-version-100-the-v100-tag).
3. [Download what it made and install it](#part-4--install-the-app)
   on Windows, Android, Mac or Linux.

> **Words used on this page**
> * **Repository** (or "repo") — the project's folder on GitHub. Yours is at
>   `github.com/belloluqman2007-hue/EduSphere-Education-Management-Platform`.
> * **Workflow** — a recipe GitHub follows automatically. EduSphere has two:
>   one that builds the computer apps, one that builds the phone apps.
> * **Release** — a public "download shelf" attached to one version number.
> * **Artifact / asset** — a file the recipe produced: an `.exe`, a `.dmg`, an
>   `.apk`, an `.AppImage`, a `.deb`.
> * **Tag** — a name stuck onto a version, like a sticker. `v1.0.0` is the
>   sticker that means "this is version 1.0.0".

---

## Part 1 — Turn the "installer factory" on

GitHub only runs workflows that live in a folder called
`.github/workflows/`. EduSphere keeps the two ready-made recipes in
`docs/ci/` (that is the copy the project owns and fixes). **You** copy each one
into the live folder, once, using the GitHub website.

The two files are:

| Recipe | Copy from | Paste to |
| --- | --- | --- |
| Computer apps (Windows / Mac / Linux) | `docs/ci/desktop-release.yml` | `.github/workflows/desktop-release.yml` |
| Phone apps (Android / iPhone) | `docs/ci/mobile-release.yml` | `.github/workflows/mobile-release.yml` |

Do this **twice** — once for each row. It takes about two minutes.

### Step 1 — open the recipe and copy everything in it

1. In the repository, click **`docs`**, then **`ci`**.
2. Click **`desktop-release.yml`**.
3. On the right, above the file, click the **copy raw file** button (the two
   little squares). If you cannot find it, click **Raw** first, then press
   **Ctrl + A** (Windows) or **⌘ + A** (Mac) and **Ctrl + C** / **⌘ + C**.
   You now have the whole file in your clipboard.

### Step 2 — paste it into the live folder

1. Go back to the **main page of the repository** (click the repository name at
   the top left).
2. Click the **Add file** button ▾ → **Create new file**.
3. A box appears with the grey words *Name your file…*. Click in it and type
   the **whole path**, slashes and all:

   ```
   .github/workflows/desktop-release.yml
   ```

   GitHub creates the folders for you as you type each `/`. Do **not** try to
   create the folders first — typing the path is the whole trick.
4. Click in the big empty editor below and press **Ctrl + V** / **⌘ + V**.
   The file you copied appears. Check that the **first line** is
   `name: Desktop installers`.
5. Scroll down to **Commit changes…**, leave *Commit directly to the `main`
   branch* selected, and click **Commit changes**.

### Step 3 — do it again for the phones

Repeat Steps 1–2 with the **other** file:

* copy `docs/ci/mobile-release.yml`
* create `.github/workflows/mobile-release.yml` the same way (Add file →
  Create new file → type the full path → paste → Commit changes)
* its first line is `name: Mobile apps (Android + iOS)`

### If GitHub says "file already exists"

That means the live copy is already there — but it may be the **old, broken**
version, which is exactly what this page exists to fix. In that case:

1. Open the live file: `.github/workflows/desktop-release.yml` (or the mobile
   one) by typing the path in the repository's address bar, or by clicking
   `.github` → `workflows` → the file name.
2. Click the **pencil** ✏️ (top right) to edit it.
3. Click in the editor, press **Ctrl + A** / **⌘ + A** to select everything,
   then **Ctrl + V** / **⌘ + V** to replace it with the copy you made in Step 1.
4. **Commit changes** again.

> **Why not edit `.github/workflows/` directly?** Because the automatic
> assistant account that maintains the repository is not allowed to write in
> that protected folder. `docs/ci/` is the copy it *can* keep correct, so that
> is the copy that gets tested on every change. Copying it in by hand is the
> one manual step — and it is the one you just did.

**Nothing runs yet.** The recipes only start working in Part 2, and they also
run on their own every time `main` is updated afterwards.

---

## Part 2 — Make version 1.0.0 (the `v1.0.0` tag)

A workflow that builds "on a tag" only builds when a tag appears. Creating the
tag by hand is the "go" button.

1. On the repository's main page, click **Releases** in the right-hand column
   (on a phone-sized screen: **⋯** near the top → Releases).
2. Click **Draft a new release**.
3. Click **Choose a tag**, type `v1.0.0` in the box, then click the
   **Create new tag: v1.0.0 on publish** entry that appears.
   *Careful: `v1.0.0`, lowercase `v`, no spaces. `1.0.0` alone will not work.*
4. Set the title to `EduSphere v1.0.0`.
5. In the description box write anything you like, e.g.
   *First release — Windows, Android, Mac and Linux.*
6. Leave **Set as a pre-release** unticked and **Set as latest release** ticked.
7. Click **Publish release**.

That click starts both recipes. A minute later, open the **Actions** tab: you
will see *Desktop installers* and *Mobile apps (Android + iOS)* running (a
yellow dot, then a green tick). Green tick = the files are ready.

* The desktop build takes roughly **10–20 minutes** (three operating systems,
  each downloading and packaging Electron).
* The Android build takes roughly **5–10 minutes**.
* The **iPhone** build only runs if the repository owner has switched it on and
  added Apple signing details (repository **Settings → Secrets and variables →
  Actions**). Without them, that one job is simply skipped — which is normal
  and does not affect Android or the computer apps.

> **Need to rebuild without changing the version?** Open **Actions**, pick the
> workflow on the left, click **Run workflow** → **Run workflow**. That is the
> manual switch; it does not create a new release, it only rebuilds.

---

## Part 3 — Where the files appear

Every build leaves its files in **two** places:

| Place | What you see there | Good for |
| --- | --- | --- |
| **The Release page** — *Releases* → *EduSphere v1.0.0* → **Assets** | The finished installers, with their real names (`EduSphere-1.0.0-win-x64.exe`, …) | Sending the app to a school. **This is the one to share.** |
| **The Actions run** — *Actions* → click the run → scroll to **Artifacts** | The same files inside a `.zip`, kept for 30 days | Looking at a build that is not a release yet |

The names follow one pattern — `EduSphere-<version>-<system>-<chip>.<type>`:

| File | It is for |
| --- | --- |
| `EduSphere-1.0.0-win-x64.exe` | Windows PC / laptop, normal 64-bit Intel or AMD |
| `EduSphere-1.0.0-win-arm64.exe` | Windows on ARM (Surface Pro X, Copilot+ PCs, Windows on Parallels) |
| `EduSphere-1.0.0-mac-universal.dmg` | Mac — **one file** that works on Intel and on Apple silicon |
| `EduSphere-1.0.0-linux-x64.AppImage` | Linux, no installation (Ubuntu, Fedora, …) |
| `EduSphere-1.0.0-linux-x64.deb` | Debian / Ubuntu, proper install |
| `EduSphere-1.0.0-android-debug.apk` | Android — a test build for trying things out |
| `EduSphere-1.0.0-android-release.apk` | Android — **the one to send to schools** |
| `EduSphere-1.0.0-android-release.aab` | Android — only for uploading to the Google Play Console |
| `EduSphere-1.0.0-ios.ipa` | iPhone / iPad — only if the Apple job was enabled |

The number `1.0.0` in the middle always matches the tag. A `v1.0.1` release
will produce `EduSphere-1.0.1-…` files.

---

## Part 4 — Install the app

### 4a. Windows 10 / 11 (`.exe`)

1. On the Release page, click `EduSphere-1.0.0-win-x64.exe` to download it
   (choose `-win-arm64.exe` only if the PC is an ARM device).
2. Open the file from your **Downloads** folder (or click it in the browser
   bar at the bottom of the window).
3. **"Windows protected your PC"** — this blue box appears because the build is
   **not signed with a paid Microsoft certificate**. It is not a virus warning;
   it means Microsoft has not met the publisher. Click **More info**, then
   **Run anyway**.
4. Choose **Install for me only** (no administrator password needed), or
   *Install for all users* on a shared office computer.
5. Leave **Run EduSphere** ticked and click **Finish**. A shortcut appears on
   the desktop and in the Start menu.

If your browser says *"EduSphere-1.0.0-win-x64.exe is not commonly
downloaded"*: click the **⋯** (or the arrow) next to the file in the downloads
list and choose **Keep**.

### 4b. Android phone or tablet (`.apk`)

1. On the phone, open the Release page and tap
   `EduSphere-1.0.0-android-release.apk`
   (use the **debug** one only if you are testing).
   *Never download the `.aab` — Android phones cannot install it, it is for the
   Play Store only.*
2. If Chrome asks *"Do you want to download this file?"* — tap **Download**.
3. Open it from the download notification, or from **Files → Downloads**.
4. Android will say **"For your security, your phone is not allowed to install
   unknown apps from this source"** (or *"Install unknown apps"*):
   * Tap **Settings** in that message.
   * Turn on **Allow from this source** for Chrome (or Files, whichever you
     used to open it).
   * Press **Back** — the install screen is still there.
5. Tap **Install** → **Open**.
6. Play Protect may add *"Unsafe app blocked"* or *"Send app for scanning?"*.
   Tap **More details** → **Install anyway** (or **Don't send**). This appears
   because the app did not come from the Play Store.

The same `.apk` runs on phones and on tablets — there is no separate tablet
version. It needs **Android 6.0 or newer**.

### 4c. Mac (`mac-universal.dmg`)

1. Download `EduSphere-1.0.0-mac-universal.dmg` (the same file works on an Intel
   Mac and on an M1/M2/M3/M4 Mac).
2. Double-click the `.dmg`, then drag the **EduSphere** icon onto the
   **Applications** folder next to it.
3. Eject the disk (the ⏏ next to it in Finder), then open **Applications** and
   double-click **EduSphere**.
4. **"EduSphere cannot be opened because the developer cannot be verified"** —
   this is macOS Gatekeeper and it appears because the build is **not
   notarized** by Apple. Get past it once, in either way:
   * **Right-click** (or Control-click) the app → **Open** → **Open** in the
     dialog, **or**
   * **System Settings → Privacy & Security**, scroll down, click
     **Open Anyway** next to the EduSphere message, then confirm with your
     password / Touch ID.
5. Later launches are normal double-clicks — macOS remembers your choice.

If macOS 15+ says the app *"is damaged and should be moved to the Trash"* (it
means the quarantine flag, not damage), open **Terminal** and paste:

```
xattr -dr com.apple.quarantine /Applications/EduSphere.app
```

### 4d. Linux (`.AppImage` or `.deb`)

**AppImage — nothing to install, works on any distribution**

1. Download `EduSphere-1.0.0-linux-x64.AppImage` (or `-arm64` on an ARM
   machine such as a Raspberry Pi 4/5).
2. Right-click the file → **Properties → Permissions → Allow executing file as
   program** (or in a terminal:
   `chmod +x ~/Downloads/EduSphere-1.0.0-linux-x64.AppImage`).
3. Double-click it. If nothing happens, run it from a terminal to see why:
   `~/Downloads/EduSphere-1.0.0-linux-x64.AppImage`

**Debian / Ubuntu `.deb` — a proper install with a menu entry**

```
sudo apt install ./Downloads/EduSphere-1.0.0-linux-x64.deb
```

`apt` (not `dpkg -i`) also pulls in the libraries the app needs. For the
keyring that keeps you signed in between sessions, make sure
`libsecret-1-0` (GNOME Keyring) or KWallet is installed — the `.deb` asks for
it automatically. Without a keyring the app still works, but you sign in again
after each restart.

### 4e. iPhone / iPad (`.ipa`, optional)

An `.ipa` cannot be installed by tapping it. It is uploaded to **TestFlight**
with Xcode or the Transporter app, and testers then install it through the
TestFlight app. If you do not see an `.ipa` on the Release page, the iPhone
build was not enabled — that is expected unless the Apple signing secrets are
configured.

---

## Something went wrong?

| What you see | What it means | What to do |
| --- | --- | --- |
| *Actions* shows a **red ✗** on *Desktop installers* or *Mobile apps* | A build failed; no installers for that platform | Open the red run, click the failed job, and read the last red lines. The message names the file and the command |
| The Release exists but has **no Assets** | The tag was pushed before the workflows were copied into `.github/workflows/` | Do Part 1, then Actions → *Run workflow* on each workflow (or publish `v1.0.1`) |
| I created the tag `1.0.0` (no `v`) | The workflows wait for `v*` tags | Create a new release with `v1.0.1`; the old tag can be deleted under *Releases* |
| Android: *"App not installed"* but nothing else | An older EduSphere build with a different signature is already on the phone | Uninstall the old EduSphere, then install again |
| Windows: SmartScreen shows only *"Don't run"* | The *More info* link is collapsed | Click the small **More info** text under the warning |
| Mac: *"Apple could not verify…"* every launch | Gatekeeper was not cleared | Do Step 4 of 4c once (right-click → Open, or Privacy & Security → Open Anyway) |
| The download is a `.zip` called `EduSphere-Windows` | You are in *Actions → Artifacts*, not on the Release page | Use **Releases → Assets** for the plain installers |

---

## For whoever maintains the repository

* The canonical recipes are `docs/ci/desktop-release.yml` and
  `docs/ci/mobile-release.yml`. **Fix them there**, never in the live folder —
  the live copy is a paste-in of these files.
* `desktop/test/packaging.test.js` parses both files as YAML and fails if a
  step-level `if:` ever reads `secrets` again (GitHub rejects the whole
  workflow with *"Unrecognized named-value: 'secrets'"*), if the platform guard
  list loses `--test-force-exit` or picks the known-failing
  `test/unified-login-ui.test.js` back up, if the Android job stops using
  `npx cap sync android`, or if the desktop Linux leg drifts off its
  `ubuntu-24.04` pin.
* Things that did break the release, and are now guarded by tests:
  * `mobile/capacitor.config.ts` is TypeScript, so `typescript` must stay a
    devDependency of `mobile/` (without it the Capacitor CLI exits 1 with
    *"Could not find installation of TypeScript"* before it writes anything).
  * `mobile/android/app/src/main/AndroidManifest.xml` must be well-formed XML.
    One missing `>` on the opening `<application …>` tag made Gradle's manifest
    merger fail with *"Element type \"application\" must be followed by either
    attribute specifications, \">\" or \"/>\""*. The mobile suite now parses
    every committed `.xml`/`.plist` file, so a typo fails `npm test` instead of
    the store build.
  * `desktop/package.json` must keep `homepage` (plus description, license and
    author e-mail): the Linux `.deb` is built by fpm, which aborts with
    *"Please specify project homepage"* and takes the AppImage down with it.
  * AndroidX versions in `mobile/android/variables.gradle` must be versions
    that actually exist (`coordinatorlayout 1.2.1` does not — 1.2.0 is the last
    release); Gradle fails with *"Could not find
    androidx.coordinatorlayout:coordinatorlayout:1.2.1"*.
  * The Linux runner is pinned to `ubuntu-24.04` for reproducibility.
* Signing is optional everywhere: with no secrets the same workflows still
  produce working, unsigned installers — which is why the "unknown publisher"
  messages above are expected. Add the secrets listed at the top of each
  workflow file to turn signing and notarizing on without changing any step.
