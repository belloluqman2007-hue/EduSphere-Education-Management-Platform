# Render Free and Aiven: uploads

## Storage and limits

EduSphere stores new image, document, receipt and support attachments in the existing `media_files` database table. Render's `/tmp` is used only for temporary processing, not as durable storage. A database failure causes the upload to fail. Images and public/private file URLs remain unchanged; private URLs are checked against the authenticated school before either disk or database contents are served. Deliberately published website images remain public. Public verification portraits use short-lived signed links.

Aiven's [Free MySQL documentation](https://aiven.io/docs/products/mysql/concepts/mysql-free-tier) states that its free plan has 1 GB disk, 1 GB RAM, one node and no credit-card requirement. Confirm your own service's plan in the Aiven console: using Aiven does not automatically mean that your plan is free. Base64 storage uses approximately one-third more space than the original file, and all database tables and indexes share the quota. Aiven says free services can be powered off after inactivity; check its console and notification emails. Monitor database usage and download independent backups. If the database is unavailable or full, uploads fail rather than silently becoming disk-only.

The migration changes MySQL `media_files.data` from `MEDIUMTEXT` to `LONGTEXT` to accommodate allowed 15 MB attachments after base64 encoding. MySQL server limits such as `max_allowed_packet` still apply. Aiven documents a default of 64 MB, but your actual service configuration may differ. Do not increase limits or change plans without checking their consequences.

During boot the app attempts to copy existing private documents from the configured `DATA_DIR` into the database. The upload-directory hydration also attempts to copy existing generated public/media files. **Neither can recover files already deleted from an old Render container**. If older files still exist on a volume, retain a backup and migrate them while that volume is available. The boot logs report missing or failed private-file migrations. Older announcement/message attachments without a recorded school owner are denied when their ownership cannot be verified safely; re-upload them rather than treating a client-supplied URL as proof of ownership. JSON snapshots saved under `/tmp` are also ephemeral; download them or use Aiven's database backup features. A database backup must include `media_files`.

## Existing Render web service

In Render, open your existing **Free web service → Environment**. Retain the existing production secrets and Aiven connection; do not create a new database or paste credentials into chat. Set or confirm:

| Key | Value | Why |
| --- | --- | --- |
| `NODE_VERSION` | `22.22.3` | Supported runtime. |
| `DATABASE_DRIVER` | `mysql` | Uses the external MySQL database. |
| `DATABASE_URL` | Existing Aiven MySQL connection URI | Obtain it from your existing MySQL service's Aiven console connection information. It contains a password; keep it secret. Do not replace it with an example. |
| `DB_SSL` | `true` | Enables encrypted MySQL transport. The current driver uses `rejectUnauthorized: false`, so it does **not** verify the server certificate; this is a pre-existing limitation. |
| `DATA_DIR` | `/tmp/edusphere` | Scratch data, not permanent storage. |
| `UPLOAD_DIR` | `/tmp/edusphere/uploads` | Temporary upload processing/cache only. |
| `BACKUP_DIR` | `/tmp/edusphere/backups` | Temporary snapshots only; download any snapshot you need. |
| `BACKUP_INTERVAL_MINUTES` | `0` | Avoid filling ephemeral storage with automatic snapshots. |
| `AUTO_RESTORE_ON_EMPTY_DB` | `0` | Do not auto-restore from ephemeral local snapshots. |

Keep your existing `SESSION_SECRET`, `SUPER_ADMIN_PASSWORD`, `PUBLIC_URL`, and other application settings. Do not set `DATA_PERSISTENT_ACK` to pretend that `/tmp` is durable. No additional storage account, storage API key, package, or paid Render disk is required by this change. `render.yaml` is a Blueprint for a new free service; editing it alone does not necessarily change an existing manually configured service.

Keep the existing Render build and start commands; `node server/index.js` is supported. After the code is committed, pushed and deployed, watch Render logs for successful MySQL connection and migration `046_media_files_longtext`. A database or migration failure must be resolved before using uploads.

## Test after deployment

1. Sign in as a school administrator and upload a small JPG/PNG portrait, a signature, and a document. Upload a receipt and a support attachment if those modules are in use. Confirm each upload displays or downloads the exact file.
2. In a separate private browser window, sign in to another school. Try each private URL and its relevant API download route: it must not return the first school's content. Confirm deliberately published school website images still display anonymously.
3. Note the uploaded file URLs. In Render, use **Manual Deploy → Deploy latest commit** (or restart the web service if available), then sign in again. Confirm the same files are still accessible; redeployment replaces the local filesystem but not Aiven's database.
4. Confirm in Aiven that storage usage remains within the service's free quota. Keep a separately downloaded backup. Review Render logs for media migration errors and any missing legacy files.

These checks cannot be performed against your private Aiven service from a local checkout unless you explicitly configure a test connection. Never share the Aiven URI or credentials in chat.
