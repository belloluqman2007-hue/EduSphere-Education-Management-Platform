"use strict";
// Authorize before either the disk or database copy can be served.
const db = require("../db");
const tokens = require("./tokens");

const OWNER_QUERIES = {
  avatars: ["SELECT madrasa_id FROM users WHERE photo_path = ?"],
  photos: ["SELECT madrasa_id FROM students WHERE photo_path = ?", "SELECT madrasa_id FROM users WHERE photo_path = ?"],
  signatures: ["SELECT madrasa_id FROM users WHERE signature_path = ?", "SELECT madrasa_id FROM students WHERE signature_path = ?", "SELECT madrasa_id FROM teacher_profiles WHERE signature_path = ?"],
  "teacher-photos": ["SELECT madrasa_id FROM teacher_profiles WHERE photo_path = ?", "SELECT madrasa_id FROM users WHERE photo_path = ?"],
  "application-photos": ["SELECT madrasa_id FROM admission_requests WHERE photo_path = ?"],
  "subscription-proofs": ["SELECT madrasa_id FROM subscription_invoices WHERE proof_path = ?"],
  "library-covers": ["SELECT madrasa_id FROM library_books WHERE cover_image_path = ?"],
  // Announcement/message paths may be supplied by clients. They cannot prove
  // ownership of an unowned legacy media row; fail closed rather than leak it.
  "announcement-images": [],
  "announcement-files": [],
  "message-attachments": [],
  logos: ["SELECT id AS madrasa_id FROM madaris WHERE logo_path = ?"],
  hero: ["SELECT id AS madrasa_id FROM madaris WHERE hero_image_path = ?"],
  badges: ["SELECT id AS madrasa_id FROM madaris WHERE badge_path = ?"],
  favicons: ["SELECT id AS madrasa_id FROM madaris WHERE favicon_path = ?"],
  gallery: ["SELECT madrasa_id FROM gallery_images WHERE image_path = ? AND media_type = 'image'"],
};

const PUBLIC_QUERIES = {
  logos: ["SELECT m.id AS madrasa_id FROM madaris m WHERE m.logo_path = ? AND m.status = 'active'"],
  hero: ["SELECT m.id AS madrasa_id FROM madaris m WHERE m.hero_image_path = ? AND m.status = 'active' AND m.public_listing = 1 AND m.website_published <> 0"],
  badges: ["SELECT m.id AS madrasa_id FROM madaris m WHERE m.badge_path = ? AND m.status = 'active' AND m.public_listing = 1 AND m.website_published <> 0"],
  favicons: ["SELECT m.id AS madrasa_id FROM madaris m WHERE m.favicon_path = ? AND m.status = 'active' AND m.public_listing = 1 AND m.website_published <> 0"],
  gallery: [
    "SELECT m.id AS madrasa_id FROM gallery_images g JOIN madaris m ON m.id = g.madrasa_id WHERE g.image_path = ? AND g.is_published = 1 AND m.status = 'active' AND m.public_listing = 1 AND m.website_published <> 0",
    "SELECT m.id AS madrasa_id FROM public_programs p JOIN madaris m ON m.id = p.madrasa_id WHERE p.image_path = ? AND p.is_published = 1 AND m.status = 'active' AND m.public_listing = 1 AND m.website_published <> 0",
    "SELECT m.id AS madrasa_id FROM institution_achievements a JOIN madaris m ON m.id = a.madrasa_id WHERE a.image_path = ? AND a.is_published = 1 AND m.status = 'active' AND m.public_listing = 1 AND m.website_published <> 0",
  ],
  "announcement-images": ["SELECT m.id AS madrasa_id FROM announcements a JOIN madaris m ON m.id = a.madrasa_id WHERE a.image_path = ? AND a.is_active = 1 AND a.publish_public = 1 AND (a.publish_until IS NULL OR a.publish_until >= CURRENT_DATE) AND m.status = 'active' AND m.public_listing = 1 AND m.website_published <> 0"],
  "teacher-photos": ["SELECT m.id AS madrasa_id FROM teacher_profiles p JOIN users u ON u.id = p.user_id AND u.madrasa_id = p.madrasa_id JOIN madaris m ON m.id = p.madrasa_id WHERE p.photo_path = ? AND p.public_display = 1 AND p.status = 'active' AND u.is_active = 1 AND m.status = 'active' AND m.public_listing = 1 AND m.website_published <> 0"],
};

function signedUrl(webPath) {
  if (!/^\/uploads\/[a-z0-9-]+\/[0-9]+-[a-f0-9]{16}\.(?:png|jpe?g|webp)$/.test(String(webPath || ""))) return "";
  return `${webPath}?media=${tokens.sign({ purpose: "public-media", path: webPath }, 900)}`;
}

async function allowed(webPath, user, token) {
  const match = /^\/uploads\/([a-z0-9-]+)\/[^/]+$/.exec(webPath);
  if (!match || match[1].startsWith("private-") || match[1] === "receipts") return false;
  const context = match[1];
  const grant = token && tokens.verify(token, "public-media");
  if (grant && grant.path === webPath) return true;
  const media = await db.get("SELECT madrasa_id FROM media_files WHERE web_path = ?", [webPath]);
  let ownerSet;
  async function owners() {
    if (ownerSet) return ownerSet;
    ownerSet = new Set();
    if (media && media.madrasa_id != null) {
      ownerSet.add(Number(media.madrasa_id));
    } else {
      // Legacy rows did not record ownership. Require one unambiguous owner.
      for (const sql of OWNER_QUERIES[context] || []) {
        for (const row of await db.all(sql, [webPath])) if (row.madrasa_id != null) ownerSet.add(Number(row.madrasa_id));
      }
    }
    return ownerSet;
  }
  for (const sql of PUBLIC_QUERIES[context] || []) {
    const published = await db.get(sql, [webPath]);
    if (published) {
      const known = await owners();
      // Publishing a URL owned by a different school must not make it public.
      if (known.size === 1 && known.has(Number(published.madrasa_id))) return true;
    }
  }
  if (!user) return false;
  if (user.role === "super_admin") return true;
  if (!user.madrasaId) return false;
  if (context === "message-attachments") {
    const known = await owners();
    if (known.size !== 1 || !known.has(Number(user.madrasaId))) return false;
    return !!await db.get("SELECT id FROM messages WHERE attachment_path = ? AND madrasa_id = ? AND (user_id = ? OR recipient_user_id = ?) LIMIT 1", [webPath, user.madrasaId, user.id, user.id]);
  }
  const known = await owners();
  return known.size === 1 && known.has(Number(user.madrasaId));
}

module.exports = { allowed, signedUrl };
