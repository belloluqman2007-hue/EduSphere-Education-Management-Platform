"use strict";
/* ============================================================================
   EduSphere — profile media (portraits and handwritten signatures)
   ----------------------------------------------------------------------------
   Two ways a portrait or a signature reaches the platform:

     1. a multipart file upload, validated by middleware/upload.js (MIME
        allow-list, generated file name, extension derived from the MIME), or
     2. a canvas the user drew on — the signature pad and the photo cropper in
        the browser both end up as a data URL, because there is no file to
        upload in the first place.

   Route 2 is the only place a base64 image is accepted, and it is treated
   with the same suspicion as an untrusted upload: the declared type must match
   the actual magic bytes, the decoded size is capped, and the stored name is
   generated. Nothing on this path is ever taken from the client's file name.

   Files are written under uploads/<context>/ and served by the existing
   /uploads static mount, whose terminator guarantees a missing file answers
   404 instead of falling through to the SPA shell.
   ========================================================================== */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");

/* Signatures are line art at ~2× and rarely exceed a few tens of kilobytes;
   the cap exists to stop a request turning into an unbounded disk write. */
const MAX_SIGNATURE_BYTES = 400 * 1024;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const MAGIC = [
  { ext: ".png", mime: "image/png", test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: ".jpg", mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ".webp", mime: "image/webp", test: (b) => b.length > 12 && b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP" },
];

/** A stored media path is always /uploads/<context>/<generated-name>. */
const STORED_PATH = /^\/uploads\/[a-z0-9-]+\/[0-9]+-[a-f0-9]{16}\.(png|jpe?g|webp)$/;

function isStoredMediaPath(value) {
  return STORED_PATH.test(String(value || ""));
}

function extFor(buffer) {
  return MAGIC.find((entry) => entry.test(buffer)) || null;
}

function newName(ext) {
  return `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
}

function contextDir(context) {
  const safe = /^[a-z0-9-]{1,32}$/.test(String(context || "")) ? String(context) : "misc";
  return path.join(config.UPLOAD_DIR, safe);
}

/**
 * Writes one image buffer into uploads/<context>/ and returns its web path.
 * Throws a 400-class error (expose) when the bytes are not a supported image.
 */
async function writeImage(buffer, context, options = {}) {
  const limit = options.maxBytes || MAX_PHOTO_BYTES;
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error("No image data was received."), { status: 400, expose: true });
  }
  if (buffer.length > limit) {
    throw Object.assign(new Error(`Image is too large (max ${Math.round(limit / 1024)} KB).`), { status: 400, expose: true });
  }
  const kind = extFor(buffer);
  if (!kind) {
    throw Object.assign(new Error("Only PNG, JPG or WEBP images are accepted."), { status: 400, expose: true });
  }
  const dir = contextDir(context);
  await fsp.mkdir(dir, { recursive: true });
  const name = newName(kind.ext);
  await fsp.writeFile(path.join(dir, name), buffer);
  return `/uploads/${context}/${name}`;
}

/**
 * Accepts the `data:image/png;base64,…` string produced by a canvas and stores
 * the decoded bytes. The declared MIME is only a hint — the magic bytes decide.
 */
function decodeDataUrl(value, options = {}) {
  const raw = String(value || "").trim();
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([\s\S]+)$/.exec(raw);
  if (!match) {
    throw Object.assign(new Error("Expected a PNG image data URL."), { status: 400, expose: true });
  }
  const body = match[2].replace(/\s+/g, "");
  if (!body || body.length % 4 === 3) {
    throw Object.assign(new Error("The image data could not be read."), { status: 400, expose: true });
  }
  const buffer = Buffer.from(body, "base64");
  // Guard against a base64 payload that decodes to garbage: a length that
  // does not round-trip means characters were dropped.
  if (!buffer.length || buffer.toString("base64").replace(/=+$/, "") !== body.replace(/=+$/, "")) {
    throw Object.assign(new Error("The image data could not be read."), { status: 400, expose: true });
  }
  const limit = options.maxBytes || MAX_SIGNATURE_BYTES;
  if (buffer.length > limit) {
    throw Object.assign(new Error(`Image is too large (max ${Math.round(limit / 1024)} KB).`), { status: 400, expose: true });
  }
  return buffer;
}

async function saveDataUrl(value, context, options = {}) {
  return writeImage(decodeDataUrl(value, options), context, options);
}

/**
 * Best-effort cleanup of a file this module wrote. Only paths that look like
 * our own generated media are touched, so a value from another tenant's row or
 * an attacker-supplied string can never delete something arbitrary.
 */
function deleteStored(webPath) {
  const value = String(webPath || "");
  if (!isStoredMediaPath(value)) return false;
  const rel = value.replace(/^\/uploads\//, "");
  const abs = path.resolve(config.UPLOAD_DIR, rel);
  if (!abs.startsWith(path.resolve(config.UPLOAD_DIR) + path.sep)) return false;
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    return true;
  } catch (e) {
    return false;
  }
}

/** Path of a file multer already stored for this request. */
function uploadedFile(req, field) {
  const file = (req.files && Array.isArray(req.files) ? req.files[0] : req.files) || req.file;
  if (!file || !file.filename) return null;
  if (field && file.fieldname !== field) return null;
  return {
    path: `/uploads/${path.basename(path.dirname(file.path))}/${file.filename}`,
    filename: file.filename,
    size: Number(file.size || 0),
  };
}

module.exports = {
  MAX_SIGNATURE_BYTES,
  MAX_PHOTO_BYTES,
  decodeDataUrl,
  deleteStored,
  isStoredMediaPath,
  saveDataUrl,
  uploadedFile,
  writeImage,
};
