# Mobile app: updates, storage, and Render uploads

## Releasing an Android app update

The mobile app bundles the shared `public/` files. After changing those files or native Android code, build and distribute a new app release:

```sh
cd mobile
npm ci
npm run android:release
```

The release build produces an APK and an AAB under `mobile/android/app/build/outputs/`. Release signing must be configured before an AAB can be uploaded as a production release. For users who already installed it, publish the new version through the same distribution channel and keep the same Android application ID and signing key. Android/Google Play can deliver optimized/delta updates where supported; users do not normally have to uninstall and reinstall the app. The package still must be updated to receive bundled UI changes. Existing app-private SQLite data is designed to survive an ordinary app update; uninstalling the app or clearing its app data can remove it.

Changes made only to the server/API can be deployed to Render without rebuilding the app, provided the app remains compatible with the API.

## Preserve photos and logos on Render

The service must have a persistent disk mounted at `/var/data`. Its Render environment must include:

```text
DATA_DIR=/var/data
UPLOAD_DIR=/var/data/uploads
BACKUP_DIR=/var/data/backups
PERSISTENT_VOLUME_DIR=/var/data
DATABASE_DRIVER=mysql
DATABASE_URL=<the existing MySQL connection string>
```

In Render, open the **existing** web service for `bello-institute.onrender.com`, check **Disks** for a disk mounted at `/var/data`, then check **Environment** for the values above and redeploy. The startup log should report upload and backup paths under `/var/data` and must no longer warn that those paths are ephemeral. The repository's `render.yaml` declares these settings, but an existing Render service can retain independent dashboard settings; confirm the live service after applying them.

Moving the upload path protects files that still exist on the old instance; it cannot recover files already removed from Render's ephemeral filesystem. Check Platform → Backups and any downloaded copies before concluding that lost photos are unrecoverable.

## Native photo URLs

The native app serves its interface from a local WebView origin, while photos are served by the paired EduSphere server. The native bridge now rewrites `/uploads/...` image paths to the paired server's origin. This fix is part of the bundled app code, so it reaches phones in the next app build/update; it does not restore photos deleted from the server.
