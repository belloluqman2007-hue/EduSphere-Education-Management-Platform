# Android incremental interface updates

**Status:** This is an Android-only implementation. It needs a new APK and operator configuration; it does not update an already-installed APK until that new APK is installed. Native Android changes still need a new APK. Test on a spare Android device before rollout. Never delete the old app or clear app data before its offline queue is synced.

The updater checks only `https://bello-institute.onrender.com/mobile-updates/manifest`, regardless of the school's API connection. The manifest is signed with RSA-SHA256, the verification key is embedded in the APK, and each downloaded file is checked against its signed SHA-256 and size. Updates are staged before activation; if the new UI doesn't confirm startup, the previous bundle is restored on the next launch. This is a basic startup recovery, not a guarantee against every runtime bug. The update server and signing-key owner can distribute code with the app's privileges, so restrict access to both. HTTPS redirects are rejected. Offline user records and pending queue are not part of the bundle.

## One-time operator setup

1. On a trusted computer outside the repository, generate and keep an RSA signing key. Back it up securely; losing it means shipping another APK with a new public key. Never commit it, put it in GitHub, or share it in chat:

   ```sh
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out ~/edusphere-update-private.pem
   chmod 600 ~/edusphere-update-private.pem
   openssl pkey -in ~/edusphere-update-private.pem -pubout -outform DER | openssl base64 -A
   ```

2. Copy the **public** base64 output into `mobile/android/update-public-key.txt`, replacing its empty contents, and commit that public file before building. This is public and is embedded in the Android build; never put the private key in the repository. For local builds, the `EDUSPHERE_UPDATE_PUBLIC_KEY` environment variable may be used instead. Existing Android APK signing (`EDUSPHERE_KEYSTORE_*` secrets) is separate and must remain the same as the installed app's signing key for an in-place update.
3. Add Render environment variable `MOBILE_UPDATE_PRIVATE_KEY` containing the entire PEM private key, including its BEGIN/END lines. Render also accepts the PEM with newline characters represented by `\n`; create that text on your own computer if necessary. Only trusted Render administrators should access this key. Do not send it in chat. Deploy the updated server. Without this variable, the manifest returns 503 and updating is disabled.
4. After committing the public key, rerun the **Mobile** workflow for the desired commit. Download the release APK artifact and install it over the old APK, using the same Android package-signing key. If Android refuses, do not uninstall before syncing and backing up offline work. A debug-signed GitHub build may use a different signing key from an earlier build.
5. Open the app online. Compatible later deployments of `public/` on Render are signed automatically. When files differ, the app displays the estimated file-download size and asks **Update now** or **Later**. It verifies and stages the complete bundle while downloading only files that differ. The original bundle and old bundle are reused for unchanged files. A large changed asset, such as a video, will still be a large download; disk space is needed for a complete staged bundle.

## Verification before rollout

Use a spare Android phone, not a production device. Install the newly signed APK, connect it to a test school and sync data. Deploy a small interface change to the trusted Render server, choose Later and verify nothing changes; reopen, choose Update now and verify the reported and actual download size, updated UI and offline data after restart. Interrupt a download and verify the previous app still opens. Also test network loss, a signature mismatch, an invalid file hash, and a broken update followed by an app restart. This repository's JavaScript tests do not replace these device tests.

`nativeApi` in the signed manifest is currently `1`, matching the new Android updater. If a web change needs a newer native API, release a compatible APK and change this protocol version rather than serving incompatible web code to old binaries. The server holds a cached manifest for the lifetime of its process; deploy/restart after changing assets or signing key. An incompatible or incorrectly configured signing key causes checks to fail closed without a prompt.
