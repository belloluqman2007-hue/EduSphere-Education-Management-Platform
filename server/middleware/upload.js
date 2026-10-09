"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — secure file uploads
   ----------------------------------------------------------------------------
   • images only (jpg/png/webp), max size from env
   • random file names (client name never used on disk)
   • stored under uploads/<context>/
   ========================================================================== */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const config = require("../config");
const mediaStore = require("../services/media-store");

/* The extension written to disk is chosen from this map, NOT from the name the
   client supplied. A browser-uploaded name is attacker-controlled, and multer's
   fileFilter only sees the Content-Type header — which is also attacker-
   controlled. Trusting the name meant a file declared `image/png` but called
   "evil.html" was stored as .html and later served from our own origin as
   text/html, which is stored XSS and defeats the `script-src 'self'` CSP.
   Deriving the extension from the (validated) MIME makes the two agree. */
const ALLOWED_IMAGE_EXT = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);
const ALLOWED_MIME = new Set(ALLOWED_IMAGE_EXT.keys());

function makeStorage(context, baseDir, extFor) {
  const dir = path.join(baseDir || config.UPLOAD_DIR, context);
  fs.mkdirSync(dir, { recursive: true });
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      // Name and extension are both generated here; nothing the client sent is
      // used to build the path on disk.
      const ext = extFor(file);
      cb(null, Date.now() + "-" + crypto.randomBytes(8).toString("hex") + ext);
    },
  });
}

/** Extension for an image, taken from the MIME type the filter already allowed. */
function imageExt(file) {
  return ALLOWED_IMAGE_EXT.get(file.mimetype) || ".bin";
}

/** Marks an error so the central handler can answer 4xx instead of 500. */
function rejectUpload(message) {
  return Object.assign(new Error(message), { status: 400, expose: true });
}

/* Dual-write: every stored file is also persisted in the media_files table so
   it survives deploys that replace the container filesystem. Very large files
   (the backup importer) stay disk-only — they are restored from backups and
   would bloat the database. */
const PERSIST_MAX_BYTES = 10 * 1024 * 1024;

function persistToMediaStore(file) {
  if (!file || !file.path || !file.filename) return Promise.resolve();
  if (Number(file.size || 0) > PERSIST_MAX_BYTES) return Promise.resolve();
  return fsp.readFile(file.path).then((buffer) => {
    const context = path.basename(path.dirname(file.path));
    const webPath = `/uploads/${context}/${file.filename}`;
    return mediaStore.put(webPath, buffer, file.mimetype).catch(() => false);
  }).catch(() => false);
}

/** Wraps a multer single-file middleware with the media-store copy. */
function withMediaPersistence(up) {
  return (req, res, next) => {
    up(req, res, (err) => {
      if (err) return next(err);
      const file = (req.files && (Array.isArray(req.files) ? req.files[0] : req.files)) || req.file;
      Promise.resolve(persistToMediaStore(file)).then(() => next()).catch(next);
    });
  };
}

const imageFilter = (req, file, cb) => {
  if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
  cb(rejectUpload("Only JPG, PNG or WEBP images are allowed."));
};

/** multer instance for a named context dir, e.g. "logos", "photos" */
function imageUploader(context, field) {
  const up = multer({
    storage: makeStorage(context, null, imageExt),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
    fileFilter: imageFilter,
  });
  return withMediaPersistence(up.single(field || "file"));
}

/**
 * Generic single-file upload for trusted (super-admin) endpoints — used by the
 * backup importer. Extension + MIME are both checked, size is capped, and the
 * file name is generated (the client name is never used).
 */
function fileUploader(context, field, options = {}) {
  const allowed = options.mimeTypes || null;
  // The stored extension is restricted to the caller's allow-list (first entry
  // when the client's own suffix is not on it), so it can never be attacker-
  // chosen even though this uploader accepts non-image types.
  const extFor = (file) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (options.extensions && options.extensions.includes(ext)) return ext;
    if (options.extensions && options.extensions.length) return options.extensions[0];
    return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".bin";
  };
  const up = multer({
    storage: makeStorage(context, options.dir, extFor),
    limits: { fileSize: (options.maxMb || 50) * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (options.extensions && !options.extensions.includes(ext)) {
        return cb(rejectUpload("Only " + options.extensions.join(", ") + " files are allowed."));
      }
      if (allowed && !allowed.includes(file.mimetype)) {
        return cb(rejectUpload("Unsupported file type (" + file.mimetype + ")."));
      }
      cb(null, true);
    },
  });
  return withMediaPersistence(up.single(field || "file"));
}

module.exports = { imageUploader, fileUploader };
