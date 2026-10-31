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
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");
const config = require("../config");
const mediaStore = require("../services/media-store");
const { effectiveTenantId } = require("./tenant");

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

function makeStorage(context, baseDir, extFor, temporaryFallback = false) {
  const dir = path.join(baseDir || config.UPLOAD_DIR, context);
  return multer.diskStorage({
    destination: (req, file, cb) => {
      // Images have a required database copy; if the configured directory is
      // unavailable, use a request-private temporary directory only as staging.
      fs.mkdir(dir, { recursive: true }, async (err) => {
        if (!err) return cb(null, dir);
        if (!temporaryFallback || !["EACCES", "EPERM", "EROFS", "ENOTDIR"].includes(err.code)) return cb(err);
        let root;
        try {
          root = await fsp.mkdtemp(path.join(os.tmpdir(), "edusphere-upload-"));
          const staging = path.join(root, context);
          await fsp.mkdir(staging);
          const cleanup = () => { fsp.rm(root, { recursive: true, force: true }).catch(() => {}); };
          req.res.once("finish", cleanup);
          req.res.once("close", cleanup);
          return cb(null, staging);
        } catch (stageError) {
          if (root) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
          return cb(stageError);
        }
      });
    },
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

/* Web-facing media must be persisted before the route can report success.
   CSV and backup imports are transient scratch files and are not published. */
async function persistToMediaStore(file, required, req) {
  if (!file || !file.path || !file.filename) return;
  try {
    const buffer = await fsp.readFile(file.path);
    const context = path.basename(path.dirname(file.path));
    const webPath = `/uploads/${context}/${file.filename}`;
    const saved = await mediaStore.put(webPath, buffer, file.mimetype, req.user ? effectiveTenantId(req) : null);
    if (!saved && required) throw new Error("The uploaded image could not be saved to the media store.");
  } catch (err) {
    if (required) {
      // Do not leave a disk-only image behind when the durable write failed.
      await fsp.unlink(file.path).catch(() => {});
      throw err;
    }
  }
}

/** Wraps a multer single-file middleware with the media-store copy. */
function withMediaPersistence(up, required = false) {
  return (req, res, next) => {
    up(req, res, (err) => {
      if (err) return next(err);
      const file = (req.files && (Array.isArray(req.files) ? req.files[0] : req.files)) || req.file;
      persistToMediaStore(file, required, req).then(() => {
        if (file && required && config.IS_RENDER && config.DATABASE_DRIVER === "mysql") {
          const cleanup = () => { fsp.unlink(file.path).catch(() => {}); };
          res.once("finish", cleanup);
          res.once("close", cleanup);
        }
        next();
      }).catch(next);
    });
  };
}

const imageFilter = (req, file, cb) => {
  if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
  cb(rejectUpload("Only JPG, PNG or WEBP images are allowed."));
};

/** multer instance for a named context dir, e.g. "logos", "photos" */
function imageUploader(context, field, options = {}) {
  const up = multer({
    storage: makeStorage(context, null, imageExt, true),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
    fileFilter: imageFilter,
  });
  if (options.stagingOnly) {
    return (req, res, next) => up.single(field || "file")(req, res, (err) => {
      if (err) return next(err);
      if (req.file) {
        const cleanup = () => { fsp.unlink(req.file.path).catch(() => {}); };
        res.once("finish", cleanup);
        res.once("close", cleanup);
      }
      next();
    });
  }
  return withMediaPersistence(up.single(field || "file"), true);
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
  const privateStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      fsp.mkdtemp(path.join(os.tmpdir(), "edusphere-private-")).then((dir) => {
        req.privateUploadRoot = dir;
        cb(null, dir);
      }, cb);
    },
    filename: (req, file, cb) => cb(null, Date.now() + "-" + crypto.randomBytes(8).toString("hex") + extFor(file)),
  });
  const up = multer({
    storage: options.privateStorage ? privateStorage : makeStorage(context, options.dir, extFor, !options.dir),
    limits: { fileSize: (options.maxMb || 50) * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (options.extensions && !options.extensions.includes(ext)) {
        return cb(rejectUpload("Only " + options.extensions.join(", ") + " files are allowed."));
      }
      if (allowed && !allowed.includes(file.mimetype)) {
        return cb(rejectUpload("Unsupported file type (" + file.mimetype + ")."));
      }
      if (options.validate && !options.validate(file)) return cb(rejectUpload("Unsupported file type."));
      cb(null, true);
    },
  });
  // Custom directories include scratch imports read directly by their routes;
  // web-facing attachments must be durably persisted before reporting success.
  if (!options.privateStorage) {
    if (options.dir) return up.single(field || "file"); // private scratch import
    return withMediaPersistence(up.single(field || "file"), true);
  }
  return (req, res, next) => {
    up.single(field || "file")(req, res, async (err) => {
      if (err || !req.file) {
        if (req.privateUploadRoot) await fsp.rm(req.privateUploadRoot, { recursive: true, force: true }).catch(() => {});
        return next(err);
      }
      const file = req.file;
      const webPath = `/uploads/private-${context}/${file.filename}`;
      try {
        const bytes = await fsp.readFile(file.path);
        if (!await mediaStore.put(webPath, bytes, file.mimetype, req.user ? effectiveTenantId(req) : null)) throw new Error("Could not persist the uploaded document.");
        file.path = `dbmedia:${webPath}`;
        res.once("finish", () => {
          // A later database update may have succeeded before an error was
          // returned. Never delete bytes that are already referenced.
          if (res.statusCode >= 400) require("../services/private-media").removeIfUnused(`dbmedia:${webPath}`).catch((e) => console.error("Private upload cleanup failed:", e.message));
        });
        next();
      } catch (e) {
        next(e);
      } finally {
        if (req.privateUploadRoot) await fsp.rm(req.privateUploadRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  };
}

module.exports = { imageUploader, fileUploader };
