"use strict";
/* ============================================================================
   EDUSPHERE PLATFORM — ADMIN → MY INSTITUTION (tenant-scoped)
   ----------------------------------------------------------------------------
   Backs the eight screens of the administrator's "My Institution" section:

     GET/PUT    /api/madrasa/institution            profile, information,
                                                    appearance, contact and
                                                    settings (one record)
     POST       /api/madrasa/institution/image/:kind  logo | hero | badge | favicon
     DELETE     /api/madrasa/institution/image/:kind
     GET        /api/madrasa/institution/website     public-website control room
     PUT        /api/madrasa/institution/website     publish / SEO / visibility
     GET/POST   /api/madrasa/institution/pages       website pages
     PATCH/DEL  /api/madrasa/institution/pages/:id
     PUT        /api/madrasa/institution/pages/reorder
     GET/POST   /api/madrasa/institution/albums      gallery albums
     PATCH/DEL  /api/madrasa/institution/albums/:id
     GET/POST   /api/madrasa/institution/media       gallery images + videos
     PATCH/DEL  /api/madrasa/institution/media/:id
     PUT        /api/madrasa/institution/media/reorder

   SECURITY
   Mounted inside the existing /api/madrasa router stack, so every request is
   already requireAuth + requireTenant. Each mutating route additionally runs
   `adminOrSupport`, i.e. only the madrasa administrator of THIS tenant (or a
   super admin explicitly inspecting it with ?madrasaId) can write. Tenant ids
   are never read from the request body.
   ========================================================================== */
const express = require("express");
const db = require("../db");
const { asyncHandler, err, ok, cleanStr, toNum, logActivity } = require("../util");
const { imageUploader } = require("../middleware/upload");
const institution = require("../services/institution");
const mi = require("../services/my-institution");
const { requireStaffPermission, can } = require("../services/permissions");
const { gateFeature } = require("../middleware/subscription");

const router = express.Router();

/* --------------------------------------------------------------------------
   Shared helpers
   -------------------------------------------------------------------------- */

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function truthy(v) {
  if (typeof v === "boolean") return v;
  const s = String(v === null || v === undefined ? "" : v).toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

/** http(s) URLs only — never javascript:, data: or a relative path. */
function safeUrl(value, max) {
  const s = cleanStr(value, max || 255);
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

/**
 * Builds an UPDATE for the madaris row from `body`, honouring the field
 * catalogue in services/my-institution.js. Returns { sets, vals } or an
 * { error } describing the first rejected value.
 */
function buildMadrasaUpdate(body, allowed) {
  const textFields = mi.allTextFields();
  const sets = [];
  const vals = [];

  for (const [key, raw] of Object.entries(body || {})) {
    if (raw === undefined) continue;
    if (allowed && !allowed.has(key)) continue;

    if (mi.COLOR_FIELDS.includes(key)) {
      const c = cleanStr(raw, 20);
      if (c && !HEX.test(c)) return { error: `${key.replace(/_/g, " ")} must be a hex colour like #220b40.` };
      sets.push(`${key} = ?`); vals.push(c);
      continue;
    }
    if (mi.BOOLEAN_FIELDS.includes(key)) {
      sets.push(`${key} = ?`); vals.push(truthy(raw) ? 1 : 0);
      continue;
    }
    if (key === "student_capacity") {
      const s = cleanStr(raw, 10);
      if (s === "") { sets.push("student_capacity = ?"); vals.push(null); continue; }
      const n = toNum(s, -1);
      if (!Number.isInteger(n) || n < 0 || n > 1000000) return { error: "Student capacity must be a whole number." };
      sets.push("student_capacity = ?"); vals.push(n);
      continue;
    }
    if (key === "founded_year") {
      const y = cleanStr(raw, 8);
      if (y && !/^\d{4}$/.test(y)) return { error: "Founded year must be a 4-digit year." };
      sets.push("founded_year = ?"); vals.push(y);
      continue;
    }
    if (key === "opening_time" || key === "closing_time") {
      const t = cleanStr(raw, 5);
      if (t && !TIME.test(t)) return { error: "Opening and closing hours must look like 08:00." };
      sets.push(`${key} = ?`); vals.push(t);
      continue;
    }
    if (key === "email" || key === "admissions_email") {
      const e = cleanStr(raw, 120);
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: "Please enter a valid email address." };
      sets.push(`${key} = ?`); vals.push(e);
      continue;
    }
    if (key === "custom_domain") {
      const domain = cleanStr(raw, 255).toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
      if (domain && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain))) {
        return { error: "Custom domain must look like www.example.com." };
      }
      sets.push("custom_domain = ?"); vals.push(domain);
      continue;
    }
    if (["website", "maps_link", "facebook", "instagram", "twitter", "youtube", "linkedin", "tiktok"].includes(key)) {
      const max = key === "maps_link" ? 255 : (key === "website" ? 160 : 200);
      const u = safeUrl(raw, max);
      if (u === null) return { error: `${key.replace(/_/g, " ")} must be a full link starting with http:// or https://` };
      sets.push(`${key} = ?`); vals.push(u);
      continue;
    }
    if (key === "admission_status") {
      const s = cleanStr(raw, 20).toLowerCase();
      if (!mi.ADMISSION_STATUSES.includes(s)) return { error: "Admission status must be open or closed." };
      sets.push("admission_status = ?"); vals.push(s);
      continue;
    }
    if (key === "category") {
      // The category decides the WHOLE admin experience and is assigned at
      // approval time. It is deliberately not editable here.
      continue;
    }
    if (mi.ENUM_FIELDS[key]) {
      const s = cleanStr(raw, 80);
      if (s && !mi.ENUM_FIELDS[key].includes(s)) return { error: `Unsupported value for ${key.replace(/_/g, " ")}.` };
      sets.push(`${key} = ?`); vals.push(s);
      continue;
    }
    if (key === "institution_type") {
      const s = cleanStr(raw, 60);
      const known = [...institution.ISLAMIC_TYPES, ...institution.WESTERN_TYPES];
      if (s && !known.includes(s)) return { error: "Choose an institution type from the list." };
      sets.push("institution_type = ?"); vals.push(s);
      continue;
    }
    if (key === "school_days") {
      const days = (Array.isArray(raw) ? raw : String(raw || "").split(","))
        .map((d) => cleanStr(d, 3))
        .filter((d) => mi.SCHOOL_DAY_OPTIONS.includes(d));
      sets.push("school_days = ?"); vals.push(days.join(","));
      continue;
    }
    if (textFields.has(key)) {
      const value = cleanStr(raw, textFields.get(key));
      if (key === "name_en" && !value) return { error: "Institution name is required." };
      sets.push(`${key} = ?`); vals.push(value);
      continue;
    }
  }
  return { sets, vals };
}

/** Everything the admin SPA needs to render any of the eight screens. */
function institutionPayload(m, extras = {}) {
  const category = institution.normalizeCategory(m.category, m.institution_type);
  return Object.assign({
    madrasa: m,
    category,
    terminology: institution.terminology(category),
    appearance: mi.resolveAppearance(m),
    options: mi.clientConfig(),
  }, extras);
}

/* --------------------------------------------------------------------------
   Website page records
   -------------------------------------------------------------------------- */

/**
 * Creates the default page set for a tenant the first time it is needed,
 * carrying over any copy written with the older website editors so nothing
 * an administrator already typed is lost.
 */
async function ensureDefaultPages(madrasaId) {
  const existing = await db.get("SELECT COUNT(*) AS n FROM website_pages WHERE madrasa_id = ?", [madrasaId]);
  if (Number(existing.n) > 0) return;

  const settingRows = await db.all("SELECT key_name, value FROM settings WHERE madrasa_id = ?", [madrasaId]);
  const settings = {};
  settingRows.forEach((r) => { settings[r.key_name] = r.value; });
  const madrasa = await db.get("SELECT description_en, admission_info FROM madaris WHERE id = ?", [madrasaId]);

  let order = 0;
  for (const page of mi.DEFAULT_PAGES) {
    const legacy = mi.LEGACY_SETTING_KEY[page.slug];
    let title = page.title;
    let body = "";
    if (legacy) {
      title = cleanStr(settings[`website_${legacy}_title`], 160) || page.title;
      body = cleanStr(settings[`website_${legacy}_content`], 60000) || "";
    }
    if (!body && page.slug === "home") body = cleanStr(madrasa && madrasa.description_en, 60000) || "";
    if (!body && page.slug === "admissions") body = cleanStr(madrasa && madrasa.admission_info, 60000) || "";
    await db.run(
      `INSERT INTO website_pages
        (madrasa_id, slug, title, summary, body, seo_title, seo_description,
         is_published, in_navigation, is_system, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [madrasaId, page.slug, title, "", body, "", "",
       page.published ? 1 : 0, page.nav ? 1 : 0, page.system ? 1 : 0, order++]
    );
  }
}

/* ==========================================================================
   1 & 2 & 4 & 7 & 8 — the institution record
   ========================================================================== */

module.exports = function institutionRoutes(resolveMadrasa, adminOrSupport) {
  router.get("/", requireStaffPermission("website.view"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const [pageCount, publishedPages, albumCount, mediaCount, currentSession] = await Promise.all([
      db.get("SELECT COUNT(*) AS n FROM website_pages WHERE madrasa_id = ?", [m.id]),
      db.get("SELECT COUNT(*) AS n FROM website_pages WHERE madrasa_id = ? AND is_published = 1", [m.id]),
      db.get("SELECT COUNT(*) AS n FROM gallery_albums WHERE madrasa_id = ?", [m.id]),
      db.get("SELECT COUNT(*) AS n FROM gallery_images WHERE madrasa_id = ?", [m.id]),
      db.get(
        `SELECT s.label,
                (SELECT t.name_en FROM terms t WHERE t.madrasa_id = s.madrasa_id AND t.session_id = s.id ORDER BY t.position LIMIT 1) AS first_term
           FROM academic_sessions s WHERE s.madrasa_id = ? AND s.is_current = 1 ORDER BY s.id DESC LIMIT 1`,
        [m.id]
      ),
    ]);
    const classes = await db.all(
      "SELECT name_en FROM classes WHERE madrasa_id = ? AND is_active = 1 ORDER BY sort_order, id",
      [m.id]
    );
    ok(res, institutionPayload(m, {
      stats: {
        pages: Number(pageCount.n),
        publishedPages: Number(publishedPages.n),
        albums: Number(albumCount.n),
        media: Number(mediaCount.n),
        classes: classes.length,
      },
      classNames: classes.map((c) => c.name_en),
      currentSession: currentSession ? currentSession.label : "",
      currentTerm: currentSession ? (currentSession.first_term || "") : "",
    }));
  }));

  /**
   * Each My Institution screen writes different columns, so each one names the
   * permission it needs rather than sharing a single blanket grant:
   *   profile / information / contact / settings → institution.settings
   *   appearance / website copy                  → website.edit
   * Flipping a visibility switch (publishing the site, listing it in the
   * public directory, exposing results or admissions) additionally requires
   * website.publish, whichever screen it is sent from.
   */
  const SECTION_PERMISSION = {
    profile: "institution.settings",
    information: "institution.settings",
    contact: "institution.settings",
    settings: "institution.settings",
    appearance: "website.edit",
    website: "website.edit",
  };
  const PUBLISH_FIELDS = ["website_published", "public_listing", "public_results", "public_admissions"];

  router.put("/", adminOrSupport, asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const body = req.body || {};
    const section = cleanStr(body.section, 30) || "profile";
    const list = mi.TEXT_FIELDS[section];
    // An unknown section must not silently write the whole record.
    if (!list) return err(res, 400, "Unknown institution section.");

    // Server-side authorisation for this specific screen, and for the
    // visibility switches it may carry.
    const needed = SECTION_PERMISSION[section] || "institution.settings";
    if (!(await can(req, needed))) {
      return err(res, 403, "You do not have permission to perform this action.", { requiredPermission: needed });
    }
    if (PUBLISH_FIELDS.some((f) => body[f] !== undefined) && !(await can(req, "website.publish"))) {
      return err(res, 403, "You do not have permission to change the public visibility of this website.", { requiredPermission: "website.publish" });
    }

    const allowed = new Set(list.map(([field]) => field));
    // Section-specific extras that are not plain text columns.
    if (section === "profile") ["founded_year"].forEach((f) => allowed.add(f));
    if (section === "information") ["student_capacity", "admission_status", "school_days"].forEach((f) => allowed.add(f));
    if (section === "appearance") mi.COLOR_FIELDS.forEach((f) => allowed.add(f));
    if (section === "website") ["website_published", "public_listing", "public_results", "public_admissions"].forEach((f) => allowed.add(f));
    if (section === "contact") {
      mi.BOOLEAN_FIELDS.filter((f) => f.startsWith("show_") || f === "contact_form_enabled").forEach((f) => allowed.add(f));
    }
    // The Settings screen's Website and Privacy tabs surface a few switches
    // and the default SEO copy that also live on the Public Website screen.
    // They are the same columns, not duplicates — either screen may write them.
    if (section === "settings") {
      ["website_published", "public_listing", "public_results", "public_admissions",
       "seo_title", "seo_description", "seo_keywords"].forEach((f) => allowed.add(f));
    }

    const built = buildMadrasaUpdate(body, allowed);
    if (built.error) return err(res, 400, built.error);
    if (!built.sets.length) return err(res, 400, "Nothing to update.");

    /* Plan gates for the two Premium "Branding & growth" capabilities. Both are
       checked against the tenant resolved above (never a client-supplied id)
       and both answer with the upgrade offer, so the My Institution screens can
       show what the school would get instead of a bare refusal. */
    if (section === "appearance") {
      if (!(await gateFeature(req, res, m.id, "branding_custom"))) return;
    }
    if (body.custom_domain !== undefined && String(body.custom_domain || "").trim()) {
      if (!(await gateFeature(req, res, m.id, "custom_domain"))) return;
    }

    // A custom host is a tenant selector. Never allow two institutions to
    // claim the same hostname, otherwise the first database row could decide
    // which tenant a browser sees.
    const customDomainSet = built.sets.findIndex((set) => set === "custom_domain = ?");
    if (customDomainSet >= 0) {
      const domain = String(built.vals[customDomainSet] || "").toLowerCase();
      if (domain) {
        const conflict = await db.get(
          "SELECT id FROM madaris WHERE LOWER(custom_domain) = ? AND id <> ?",
          [domain, m.id]
        );
        if (conflict) return err(res, 400, "That custom domain is already assigned to another institution.");
      }
    }

    built.sets.push("updated_at = CURRENT_TIMESTAMP");
    built.vals.push(m.id);
    await db.run(`UPDATE madaris SET ${built.sets.join(", ")} WHERE id = ?`, built.vals);
    logActivity(db, {
      madrasaId: m.id, userId: req.user.id, action: `institution.${section}.update`,
      entity: "madrasa", entityId: String(m.id), ip: req.ip,
    });
    const fresh = await db.get("SELECT * FROM madaris WHERE id = ?", [m.id]);
    ok(res, institutionPayload(fresh, { saved: true }));
  }));

  /** Resets the whole appearance block back to the category defaults. */
  router.post("/appearance/reset", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    if (!(await gateFeature(req, res, m.id, "branding_custom"))) return;
    const columns = [...mi.COLOR_FIELDS, "font_family", "header_style", "footer_style",
      "button_style", "card_style", "homepage_layout", "website_theme"];
    await db.run(
      `UPDATE madaris SET ${columns.map((c) => `${c} = ''`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [m.id]
    );
    logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "institution.appearance.reset", entity: "madrasa", entityId: String(m.id), ip: req.ip });
    const fresh = await db.get("SELECT * FROM madaris WHERE id = ?", [m.id]);
    ok(res, institutionPayload(fresh, { reset: true }));
  }));

  /* ------------------------------------------------------------------------
     Images: logo, cover/hero, badge/emblem, favicon
     ------------------------------------------------------------------------ */
  const IMAGE_KINDS = {
    logo: { column: "logo_path", dir: "logos" },
    hero: { column: "hero_image_path", dir: "hero" },
    badge: { column: "badge_path", dir: "badges" },
    favicon: { column: "favicon_path", dir: "favicons" },
  };

  router.post("/image/:kind", adminOrSupport, requireStaffPermission("website.edit"), (req, res, next) => {
    const kind = IMAGE_KINDS[String(req.params.kind || "")];
    if (!kind) return err(res, 400, "Unknown image type.");
    return imageUploader(kind.dir, "image")(req, res, (uploadError) => {
      if (uploadError) return err(res, 400, uploadError.message || "Upload failed.");
      next();
    });
  }, asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const kind = IMAGE_KINDS[String(req.params.kind)];
    if (!req.file) return err(res, 400, "No image uploaded.");
    const path = `/uploads/${kind.dir}/${req.file.filename}`;
    await db.run(`UPDATE madaris SET ${kind.column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [path, m.id]);
    logActivity(db, { madrasaId: m.id, userId: req.user.id, action: `institution.image.${req.params.kind}`, entity: "madrasa", entityId: String(m.id), ip: req.ip });
    ok(res, { ok: true, kind: req.params.kind, path });
  }));

  router.delete("/image/:kind", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const kind = IMAGE_KINDS[String(req.params.kind || "")];
    if (!kind) return err(res, 400, "Unknown image type.");
    await db.run(`UPDATE madaris SET ${kind.column} = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [m.id]);
    ok(res, { ok: true, kind: req.params.kind, path: "" });
  }));

  /* ========================================================================
     3 — Public Website control room
     ======================================================================== */
  router.get("/website", requireStaffPermission("website.view"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    await ensureDefaultPages(m.id);
    const [pages, counts] = await Promise.all([
      db.all("SELECT * FROM website_pages WHERE madrasa_id = ? ORDER BY sort_order, id", [m.id]),
      db.get(
        `SELECT
           (SELECT COUNT(*) FROM admission_requests WHERE madrasa_id = ? AND status = 'pending') AS pending_applications,
           (SELECT COUNT(*) FROM term_summaries WHERE madrasa_id = ? AND published_at IS NOT NULL) AS published_results,
           (SELECT COUNT(*) FROM announcements WHERE madrasa_id = ? AND is_active = 1 AND publish_public = 1) AS public_notices,
           (SELECT COUNT(*) FROM gallery_images WHERE madrasa_id = ? AND is_published = 1) AS published_media,
           (SELECT COUNT(*) FROM users WHERE madrasa_id = ? AND role = 'teacher' AND is_active = 1) AS teachers`,
        [m.id, m.id, m.id, m.id, m.id]
      ),
    ]);
    ok(res, institutionPayload(m, {
      pages,
      counts: {
        pendingApplications: Number(counts.pending_applications),
        publishedResults: Number(counts.published_results),
        publicNotices: Number(counts.public_notices),
        publishedMedia: Number(counts.published_media),
        teachers: Number(counts.teachers),
      },
      urls: {
        site: `/schools/${m.slug}`,
        legacySite: `/s/${m.slug}`,
        website: `${req.protocol}://${req.get("host")}/schools/${m.slug}`,
        directory: `/madrasa/${m.slug}`,
        apply: `/apply/${m.slug}`,
        results: `/results-check?madrasa=${m.slug}`,
      },
    }));
  }));

  /* ========================================================================
     5 — Website Pages
     ======================================================================== */
  router.get("/pages", requireStaffPermission("website.view"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    await ensureDefaultPages(m.id);
    const pages = await db.all("SELECT * FROM website_pages WHERE madrasa_id = ? ORDER BY sort_order, id", [m.id]);
    ok(res, { pages, defaults: mi.DEFAULT_PAGES.map((p) => ({ ...p })) });
  }));

  router.post("/pages", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    await ensureDefaultPages(m.id);
    const b = req.body || {};
    const title = cleanStr(b.title, 160);
    if (!title) return err(res, 400, "Page title is required.");
    const slug = mi.pageSlug(b.slug || title);
    if (!slug) return err(res, 400, "Page title must contain letters or numbers.");
    const dup = await db.get("SELECT id FROM website_pages WHERE madrasa_id = ? AND slug = ?", [m.id, slug]);
    if (dup) return err(res, 400, "A page with this address already exists.");
    const last = await db.get("SELECT MAX(sort_order) AS n FROM website_pages WHERE madrasa_id = ?", [m.id]);
    const r = await db.run(
      `INSERT INTO website_pages
        (madrasa_id, slug, title, summary, body, seo_title, seo_description,
         is_published, in_navigation, is_system, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
      [m.id, slug, title, cleanStr(b.summary, 400), cleanStr(b.body, 60000),
       cleanStr(b.seo_title, 160), cleanStr(b.seo_description, 320),
       truthy(b.is_published) ? 1 : 0, truthy(b.in_navigation) ? 1 : 0,
       Number(last && last.n ? last.n : 0) + 1]
    );
    logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "website.page.create", entity: "website_page", entityId: String(r.lastInsertRowid), ip: req.ip });
    ok(res, { ok: true, id: r.lastInsertRowid, slug });
  }));

  router.patch("/pages/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const page = await db.get("SELECT * FROM website_pages WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
    if (!page) return err(res, 404, "Page not found.");
    const b = req.body || {};
    const sets = []; const vals = [];
    if (b.title !== undefined) {
      const title = cleanStr(b.title, 160);
      if (!title) return err(res, 400, "Page title is required.");
      sets.push("title = ?"); vals.push(title);
    }
    if (b.slug !== undefined && !Number(page.is_system)) {
      const slug = mi.pageSlug(b.slug);
      if (!slug) return err(res, 400, "Page address must contain letters or numbers.");
      const dup = await db.get("SELECT id FROM website_pages WHERE madrasa_id = ? AND slug = ? AND id <> ?", [m.id, slug, page.id]);
      if (dup) return err(res, 400, "A page with this address already exists.");
      sets.push("slug = ?"); vals.push(slug);
    }
    for (const [key, max] of [["summary", 400], ["body", 60000], ["seo_title", 160], ["seo_description", 320]]) {
      if (b[key] !== undefined) { sets.push(`${key} = ?`); vals.push(cleanStr(b[key], max)); }
    }
    // Taking a page live (or pulling it down) changes what the public can see,
    // so it needs the publishing permission rather than plain edit rights.
    if (b.is_published !== undefined && !(await can(req, "website.publish"))) {
      return err(res, 403, "You do not have permission to publish or unpublish website pages.", { requiredPermission: "website.publish" });
    }
    for (const key of ["is_published", "in_navigation"]) {
      if (b[key] !== undefined) { sets.push(`${key} = ?`); vals.push(truthy(b[key]) ? 1 : 0); }
    }
    if (!sets.length) return err(res, 400, "Nothing to update.");
    sets.push("updated_at = CURRENT_TIMESTAMP");
    vals.push(page.id);
    await db.run(`UPDATE website_pages SET ${sets.join(", ")} WHERE id = ?`, vals);
    logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "website.page.update", entity: "website_page", entityId: String(page.id), ip: req.ip });
    ok(res, { ok: true });
  }));

  router.delete("/pages/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const page = await db.get("SELECT * FROM website_pages WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
    if (!page) return err(res, 404, "Page not found.");
    // Core pages back real features (admissions form, news feed, contact
    // details). They can be unpublished, never deleted, so the public site
    // cannot end up referring to a page that no longer exists.
    if (Number(page.is_system)) return err(res, 400, "Core pages cannot be deleted — unpublish them instead.");
    await db.run("DELETE FROM website_pages WHERE id = ?", [page.id]);
    logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "website.page.delete", entity: "website_page", entityId: String(page.id), ip: req.ip });
    ok(res, { ok: true });
  }));

  router.put("/pages/reorder", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const order = Array.isArray(req.body && req.body.order) ? req.body.order : [];
    if (!order.length) return err(res, 400, "No page order supplied.");
    let position = 0;
    for (const id of order) {
      // Scoped by madrasa_id: an id from another tenant simply updates nothing.
      await db.run("UPDATE website_pages SET sort_order = ? WHERE id = ? AND madrasa_id = ?", [position++, toNum(id, 0), m.id]);
    }
    ok(res, { ok: true, count: position });
  }));

  /* ========================================================================
     6 — Gallery: albums and media
     ======================================================================== */
  router.get("/albums", requireStaffPermission("website.view"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const albums = await db.all(
      `SELECT a.*,
              (SELECT COUNT(*) FROM gallery_images g WHERE g.album_id = a.id AND g.madrasa_id = a.madrasa_id) AS media_count,
              (SELECT g.image_path FROM gallery_images g WHERE g.id = a.cover_image_id AND g.madrasa_id = a.madrasa_id) AS cover_path
         FROM gallery_albums a WHERE a.madrasa_id = ? ORDER BY a.sort_order, a.id`,
      [m.id]
    );
    ok(res, { albums, categories: [...mi.GALLERY_CATEGORIES] });
  }));

  router.post("/albums", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const b = req.body || {};
    const title = cleanStr(b.title, 160);
    if (!title) return err(res, 400, "Album title is required.");
    const category = mi.GALLERY_CATEGORIES.includes(cleanStr(b.category, 60)) ? cleanStr(b.category, 60) : "School Activities";
    const last = await db.get("SELECT MAX(sort_order) AS n FROM gallery_albums WHERE madrasa_id = ?", [m.id]);
    const r = await db.run(
      `INSERT INTO gallery_albums (madrasa_id, title, description, category, is_published, is_featured, sort_order)
       VALUES (?,?,?,?,?,?,?)`,
      [m.id, title, cleanStr(b.description, 600), category,
       b.is_published === undefined ? 1 : (truthy(b.is_published) ? 1 : 0),
       truthy(b.is_featured) ? 1 : 0, Number(last && last.n ? last.n : 0) + 1]
    );
    logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "gallery.album.create", entity: "gallery_album", entityId: String(r.lastInsertRowid), ip: req.ip });
    ok(res, { ok: true, id: r.lastInsertRowid });
  }));

  router.patch("/albums/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const album = await db.get("SELECT * FROM gallery_albums WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
    if (!album) return err(res, 404, "Album not found.");
    const b = req.body || {};
    const sets = []; const vals = [];
    if (b.title !== undefined) {
      const title = cleanStr(b.title, 160);
      if (!title) return err(res, 400, "Album title is required.");
      sets.push("title = ?"); vals.push(title);
    }
    if (b.description !== undefined) { sets.push("description = ?"); vals.push(cleanStr(b.description, 600)); }
    if (b.category !== undefined) {
      const category = cleanStr(b.category, 60);
      if (category && !mi.GALLERY_CATEGORIES.includes(category)) return err(res, 400, "Unknown gallery category.");
      sets.push("category = ?"); vals.push(category || "School Activities");
    }
    if (b.cover_image_id !== undefined) {
      const coverId = toNum(b.cover_image_id, 0);
      if (coverId) {
        const image = await db.get("SELECT id FROM gallery_images WHERE id = ? AND madrasa_id = ?", [coverId, m.id]);
        if (!image) return err(res, 400, "Cover image not found in this gallery.");
        sets.push("cover_image_id = ?"); vals.push(coverId);
      } else { sets.push("cover_image_id = ?"); vals.push(null); }
    }
    for (const key of ["is_published", "is_featured"]) {
      if (b[key] !== undefined) { sets.push(`${key} = ?`); vals.push(truthy(b[key]) ? 1 : 0); }
    }
    if (!sets.length) return err(res, 400, "Nothing to update.");
    vals.push(album.id);
    await db.run(`UPDATE gallery_albums SET ${sets.join(", ")} WHERE id = ?`, vals);
    ok(res, { ok: true });
  }));

  router.delete("/albums/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const album = await db.get("SELECT * FROM gallery_albums WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
    if (!album) return err(res, 404, "Album not found.");
    // Deleting an album must never delete photographs: they return to the
    // unfiled pool so an accidental click cannot destroy a school's archive.
    await db.run("UPDATE gallery_images SET album_id = NULL WHERE album_id = ? AND madrasa_id = ?", [album.id, m.id]);
    await db.run("DELETE FROM gallery_albums WHERE id = ?", [album.id]);
    logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "gallery.album.delete", entity: "gallery_album", entityId: String(album.id), ip: req.ip });
    ok(res, { ok: true });
  }));

  router.get("/media", requireStaffPermission("website.view"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const albumId = toNum(req.query.albumId, 0);
    const category = cleanStr(req.query.category, 60);
    const params = [m.id];
    let sql = "SELECT * FROM gallery_images WHERE madrasa_id = ?";
    if (albumId) { sql += " AND album_id = ?"; params.push(albumId); }
    if (category && mi.GALLERY_CATEGORIES.includes(category)) { sql += " AND category = ?"; params.push(category); }
    sql += " ORDER BY sort_order, id";
    const media = await db.all(sql, params);
    ok(res, { media, categories: [...mi.GALLERY_CATEGORIES] });
  }));

  /** Image upload (multipart) — the same pipeline the old gallery used. */
  router.post("/media", adminOrSupport, requireStaffPermission("website.edit"), (req, res, next) => {
    imageUploader("gallery", "image")(req, res, (uploadError) => {
      if (uploadError) return err(res, 400, uploadError.message || "Upload failed.");
      next();
    });
  }, asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    if (!req.file) return err(res, 400, "No image uploaded.");
    const b = req.body || {};
    const count = await db.get("SELECT COUNT(*) AS n FROM gallery_images WHERE madrasa_id = ?", [m.id]);
    if (Number(count.n) >= 200) return err(res, 400, "Gallery limit reached (200 items).");
    const albumId = toNum(b.album_id, 0);
    if (albumId) {
      const album = await db.get("SELECT id FROM gallery_albums WHERE id = ? AND madrasa_id = ?", [albumId, m.id]);
      if (!album) return err(res, 400, "Album not found.");
    }
    const category = mi.GALLERY_CATEGORIES.includes(cleanStr(b.category, 60)) ? cleanStr(b.category, 60) : "School Activities";
    const r = await db.run(
      `INSERT INTO gallery_images
        (madrasa_id, image_path, caption, sort_order, album_id, category, media_type, video_url, is_published, is_featured)
       VALUES (?,?,?,?,?,?, 'image', '', ?, ?)`,
      [m.id, `/uploads/gallery/${req.file.filename}`, cleanStr(b.caption, 200), Number(count.n),
       albumId || null, category, b.is_published === undefined ? 1 : (truthy(b.is_published) ? 1 : 0), truthy(b.is_featured) ? 1 : 0]
    );
    logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "gallery.media.add", entity: "gallery_image", entityId: String(r.lastInsertRowid), ip: req.ip });
    ok(res, { ok: true, id: r.lastInsertRowid, imagePath: `/uploads/gallery/${req.file.filename}` });
  }));

  /** Video entry (JSON) — referenced by URL, with an optional poster image. */
  router.post("/media/video", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const b = req.body || {};
    const url = safeUrl(b.video_url, 500);
    if (!url) return err(res, 400, "Enter a full video link starting with http:// or https://");
    const count = await db.get("SELECT COUNT(*) AS n FROM gallery_images WHERE madrasa_id = ?", [m.id]);
    if (Number(count.n) >= 200) return err(res, 400, "Gallery limit reached (200 items).");
    const albumId = toNum(b.album_id, 0);
    if (albumId) {
      const album = await db.get("SELECT id FROM gallery_albums WHERE id = ? AND madrasa_id = ?", [albumId, m.id]);
      if (!album) return err(res, 400, "Album not found.");
    }
    const category = mi.GALLERY_CATEGORIES.includes(cleanStr(b.category, 60)) ? cleanStr(b.category, 60) : "School Activities";
    const poster = cleanStr(b.image_path, 255);
    const r = await db.run(
      `INSERT INTO gallery_images
        (madrasa_id, image_path, caption, sort_order, album_id, category, media_type, video_url, is_published, is_featured)
       VALUES (?,?,?,?,?,?, 'video', ?, ?, ?)`,
      [m.id, poster.startsWith("/uploads/") ? poster : "", cleanStr(b.caption, 200), Number(count.n),
       albumId || null, category, url, b.is_published === undefined ? 1 : (truthy(b.is_published) ? 1 : 0), truthy(b.is_featured) ? 1 : 0]
    );
    logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "gallery.video.add", entity: "gallery_image", entityId: String(r.lastInsertRowid), ip: req.ip });
    ok(res, { ok: true, id: r.lastInsertRowid });
  }));

  router.patch("/media/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const item = await db.get("SELECT * FROM gallery_images WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
    if (!item) return err(res, 404, "Gallery item not found.");
    const b = req.body || {};
    const sets = []; const vals = [];
    if (b.caption !== undefined) { sets.push("caption = ?"); vals.push(cleanStr(b.caption, 200)); }
    if (b.category !== undefined) {
      const category = cleanStr(b.category, 60);
      if (category && !mi.GALLERY_CATEGORIES.includes(category)) return err(res, 400, "Unknown gallery category.");
      sets.push("category = ?"); vals.push(category || "School Activities");
    }
    if (b.album_id !== undefined) {
      const albumId = toNum(b.album_id, 0);
      if (albumId) {
        const album = await db.get("SELECT id FROM gallery_albums WHERE id = ? AND madrasa_id = ?", [albumId, m.id]);
        if (!album) return err(res, 400, "Album not found.");
        sets.push("album_id = ?"); vals.push(albumId);
      } else { sets.push("album_id = ?"); vals.push(null); }
    }
    if (b.video_url !== undefined && String(item.media_type) === "video") {
      const url = safeUrl(b.video_url, 500);
      if (!url) return err(res, 400, "Enter a full video link starting with http:// or https://");
      sets.push("video_url = ?"); vals.push(url);
    }
    for (const key of ["is_published", "is_featured"]) {
      if (b[key] !== undefined) { sets.push(`${key} = ?`); vals.push(truthy(b[key]) ? 1 : 0); }
    }
    if (!sets.length) return err(res, 400, "Nothing to update.");
    vals.push(item.id);
    await db.run(`UPDATE gallery_images SET ${sets.join(", ")} WHERE id = ?`, vals);
    ok(res, { ok: true });
  }));

  router.delete("/media/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const item = await db.get("SELECT * FROM gallery_images WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
    if (!item) return err(res, 404, "Gallery item not found.");
    await db.run("UPDATE gallery_albums SET cover_image_id = NULL WHERE cover_image_id = ? AND madrasa_id = ?", [item.id, m.id]);
    await db.run("DELETE FROM gallery_images WHERE id = ?", [item.id]);
    logActivity(db, { madrasaId: m.id, userId: req.user.id, action: "gallery.media.delete", entity: "gallery_image", entityId: String(item.id), ip: req.ip });
    ok(res, { ok: true });
  }));

  router.put("/media/reorder", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const order = Array.isArray(req.body && req.body.order) ? req.body.order : [];
    if (!order.length) return err(res, 400, "No media order supplied.");
    let position = 0;
    for (const id of order) {
      await db.run("UPDATE gallery_images SET sort_order = ? WHERE id = ? AND madrasa_id = ?", [position++, toNum(id, 0), m.id]);
    }
    ok(res, { ok: true, count: position });
  }));

  /* ========================================================================
     Public programs and achievements
     ======================================================================== */
  router.get("/programs", requireStaffPermission("website.view"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const programs = await db.all(
      "SELECT * FROM public_programs WHERE madrasa_id = ? ORDER BY sort_order, id", [m.id]
    );
    ok(res, { programs });
  }));

  router.post("/programs", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const b = req.body || {};
    const title = cleanStr(b.title || b.name, 160);
    if (!title) return err(res, 400, "Program title is required.");
    const track = ["islamic", "western", "both"].includes(cleanStr(b.education_track || b.educationTrack, 20).toLowerCase())
      ? cleanStr(b.education_track || b.educationTrack, 20).toLowerCase() : "both";
    const last = await db.get("SELECT MAX(sort_order) AS n FROM public_programs WHERE madrasa_id = ?", [m.id]);
    const r = await db.run(
      `INSERT INTO public_programs
        (madrasa_id, title, description, education_track, category, level_name, duration,
         image_path, is_published, is_featured, sort_order, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [m.id, title, cleanStr(b.description, 6000), track, cleanStr(b.category, 80) || "Other",
       cleanStr(b.level_name || b.level, 100), cleanStr(b.duration, 100), cleanStr(b.image_path, 500),
       truthy(b.is_published) ? 1 : 0, truthy(b.is_featured) ? 1 : 0,
       Number(last && last.n || 0) + 1, req.user.id]
    );
    ok(res, { ok: true, id: r.lastInsertRowid, program: await db.get("SELECT * FROM public_programs WHERE id = ? AND madrasa_id = ?", [r.lastInsertRowid, m.id]) });
  }));

  router.patch("/programs/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const row = await db.get("SELECT * FROM public_programs WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
    if (!row) return err(res, 404, "Program not found.");
    const b = req.body || {}; const sets = []; const vals = [];
    if (b.title !== undefined) { const title = cleanStr(b.title, 160); if (!title) return err(res, 400, "Program title is required."); sets.push("title = ?"); vals.push(title); }
    for (const [key, max] of [["description", 6000], ["category", 80], ["level_name", 100], ["duration", 100], ["image_path", 500]]) {
      if (b[key] !== undefined) { sets.push(`${key} = ?`); vals.push(cleanStr(b[key], max)); }
    }
    if (b.education_track !== undefined) {
      const track = cleanStr(b.education_track, 20).toLowerCase();
      if (!["islamic", "western", "both"].includes(track)) return err(res, 400, "Education track must be Islamic, Western or both.");
      sets.push("education_track = ?"); vals.push(track);
    }
    for (const key of ["is_published", "is_featured"]) if (b[key] !== undefined) { sets.push(`${key} = ?`); vals.push(truthy(b[key]) ? 1 : 0); }
    if (!sets.length) return err(res, 400, "Nothing to update.");
    vals.push(row.id, m.id);
    await db.run(`UPDATE public_programs SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?`, vals);
    ok(res, { ok: true, program: await db.get("SELECT * FROM public_programs WHERE id = ? AND madrasa_id = ?", [row.id, m.id]) });
  }));

  router.delete("/programs/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    const r = await db.run("DELETE FROM public_programs WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
    if (!r.changes) return err(res, 404, "Program not found.");
    ok(res, { ok: true });
  }));


  router.get("/achievements", requireStaffPermission("website.view"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res);
    if (!m) return;
    ok(res, { achievements: await db.all("SELECT * FROM institution_achievements WHERE madrasa_id = ? ORDER BY sort_order, id", [m.id]) });
  }));

  router.post("/achievements", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res); if (!m) return;
    const b = req.body || {}; const title = cleanStr(b.title, 200);
    if (!title) return err(res, 400, "Achievement title is required.");
    const last = await db.get("SELECT MAX(sort_order) AS n FROM institution_achievements WHERE madrasa_id = ?", [m.id]);
    const r = await db.run(
      `INSERT INTO institution_achievements (madrasa_id,title,description,achievement_date,image_path,is_published,is_featured,sort_order,created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [m.id, title, cleanStr(b.description, 6000), validDate(b.achievement_date), cleanStr(b.image_path, 500), truthy(b.is_published) ? 1 : 0, truthy(b.is_featured) ? 1 : 0, Number(last && last.n || 0) + 1, req.user.id]
    );
    ok(res, { ok: true, id: r.lastInsertRowid });
  }));

  router.patch("/achievements/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res); if (!m) return;
    const row = await db.get("SELECT * FROM institution_achievements WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
    if (!row) return err(res, 404, "Achievement not found.");
    const b = req.body || {}; const sets = []; const vals = [];
    for (const [key, max] of [["title", 200], ["description", 6000], ["image_path", 500]]) if (b[key] !== undefined) { const value = cleanStr(b[key], max); if (key === "title" && !value) return err(res, 400, "Achievement title is required."); sets.push(`${key} = ?`); vals.push(value); }
    if (b.achievement_date !== undefined) { sets.push("achievement_date = ?"); vals.push(validDate(b.achievement_date)); }
    for (const key of ["is_published", "is_featured"]) if (b[key] !== undefined) { sets.push(`${key} = ?`); vals.push(truthy(b[key]) ? 1 : 0); }
    if (!sets.length) return err(res, 400, "Nothing to update.");
    vals.push(row.id, m.id); await db.run(`UPDATE institution_achievements SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND madrasa_id = ?`, vals);
    ok(res, { ok: true });
  }));

  router.delete("/achievements/:id", adminOrSupport, requireStaffPermission("website.edit"), asyncHandler(async (req, res) => {
    const m = await resolveMadrasa(req, res); if (!m) return;
    const result = await db.run("DELETE FROM institution_achievements WHERE id = ? AND madrasa_id = ?", [toNum(req.params.id, 0), m.id]);
    if (!result.changes) return err(res, 404, "Achievement not found.");
    ok(res, { ok: true });
  }));

  return router;
};

module.exports.ensureDefaultPages = ensureDefaultPages;
