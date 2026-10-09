"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — Express app factory
   ----------------------------------------------------------------------------
   Security layers (in order):
     1. helmet (CSP for our static assets, no sensitive headers)
     2. global API rate limit
     3. session (DB-backed, httpOnly, sameSite=lax, secure in production)
     4. CSRF double-submit guard on state-changing API calls
     5. user loading (fresh DB record every request)
     6. route-level role + tenant guards (backend-enforced isolation)
   No route trusts client-supplied tenant ids.
   ========================================================================== */
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const session = require("express-session");

const config = require("./config");
const DBSessionStore = require("./session-store");
const { loadUser, requireSuperAdmin } = require("./middleware/auth");
const { apiLimiter, loginLimiter, resetRequestLimiter } = require("./middleware/ratelimit");
const { router: authRouter, csrfGuard, ensureCsrfToken } = require("./routes/auth");
const platformRouter = require("./routes/platform");
const { router: madrasaRouter, rootRouter: madrasaRootRouter } = require("./routes/madrasa");
const studentsRouter = require("./routes/students");
const teachersRouter = require("./routes/teachers");
const classesRouter = require("./routes/classes");
const { router: resultsRouter } = require("./routes/results");
const attendanceRouter = require("./routes/attendance");
const feesRouter = require("./routes/fees");
const paymentRouter = require("./routes/payment");
const payrollRouter = require("./routes/payroll");
const leaveRouter = require("./routes/leave");
const { router: expensesRouter, budgetRouter } = require("./routes/expenses");
const announcementsRouter = require("./routes/announcements");
const communicationRouter = require("./routes/communication");
const ptmRouter = require("./routes/ptm");
const portalRouter = require("./routes/portal");
const publicRouter = require("./routes/public");
const admissionsRouter = require("./routes/admissions");
const timetableRouter = require("./routes/timetable").router;
const exportsRouter = require("./routes/exports");
const extrasRouter = require("./routes/extras");
const backupsRouter = require("./routes/backups").router;
const calendarRouter = require("./routes/calendar");
const supportRouter = require("./routes/support").router;
// Chat & Support — threaded conversations between an authenticated
// institution user and the Super Admin / EduSphere support desk. One shared
// architecture for Islamic and Western institutions.
const { router: supportChatRouter, platformRouter: supportChatAdminRouter } = require("./routes/support-chat");
const quranProgressRouter = require("./routes/quran-progress");
const academicRouter = require("./routes/academic");
const libraryRouter = require("./routes/library");
const documentsRouter = require("./routes/documents");
const healthRouter = require("./routes/health");
const adminRouter = require("./routes/admin");
const institution = require("./services/institution");
const perfMonitor = require("./services/perf-monitor");
const { asyncHandler, ok, err, toNum, logActivity } = require("./util");
const db = require("./db");

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind a proxy (Render/Railway) for correct req.ip

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
  }));

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  /* ------------------------- CORS (allow-list) --------------------------- */
  // Same-origin by default (no headers needed). Cross-origin only if the
  // operator explicitly allows the origin via CORS_ORIGINS.
  const allowedOrigins = new Set(config.CORS_ORIGINS);
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
      if (req.method === "OPTIONS") return res.status(204).end();
    }
    next();
  });

  /* ----------------------- frontend runtime config ----------------------- */
  // The SPA is same-origin by default and calls /api. If the operator sets
  // API_BASE_URL (API hosted on a different origin), this endpoint serves
  // it to the frontend — no hard-coded production URLs anywhere in code.
  app.get("/app-config.js", async (req, res) => {
    const host = String(req.get("host") || "").split(":")[0].toLowerCase();
    const custom = host ? await db.get(
      "SELECT slug FROM madaris WHERE LOWER(custom_domain) = ? AND status = 'active' AND public_listing = 1 AND website_published <> 0",
      [host]
    ) : null;
    res
      .type("application/javascript")
      .set("Cache-Control", "no-store")
      .send("window.__APP_CONFIG__=" + JSON.stringify({
        apiBase: config.EFFECTIVE_API_BASE,
        categoryConfig: institution.clientCategoryConfig(),
        schoolSlug: custom ? custom.slug : "",
      }) + ";");
  });

  // Static frontend + uploads
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use("/uploads", express.static(config.UPLOAD_DIR, { maxAge: "1h", fallthrough: true }));
  // The durable copy: every upload is also stored in the media_files table, so
  // a deploy that replaces the container filesystem (no persistent disk) no
  // longer wipes portraits, signatures and logos. The disk stays the fast
  // path; this answers only when the file is gone.
  app.use("/uploads", async (req, res, next) => {
    try {
      const mediaStore = require("./services/media-store");
      const webPath = "/uploads" + (req.path === "/" ? "" : req.path);
      const found = await mediaStore.get(webPath);
      if (!found) return next();
      res.set("Cache-Control", "public, max-age=3600");
      res.type(found.mime);
      return res.send(found.data);
    } catch (e) {
      return next();
    }
  });
  // Uploads are files, never pages. Without this terminator a missing file
  // (a photo/logo path that outlived its file — restored backup, ephemeral
  // disk) fell through to the SPA fallback below, so <img src="/uploads/…">
  // received "200 OK, text/html" and every browser painted a broken-image
  // icon with the alt text next to it — exactly the broken logos and student
  // photographs seen on report sheets. Answering 404 lets the <img> error
  // event fire so the report's placeholder (monogram / photo silhouette) can
  // take over, and keeps HTML out of image and file responses everywhere
  // else in the platform too.
  app.use("/uploads", (req, res) => {
    res.status(404);
    if (req.accepts("json") && !req.accepts("html")) return res.json({ error: "Not found." });
    res.type("txt").send("Not found.");
  });

  /* ----------------- pretty per-school links (/s/<slug>) --------------- */
  // Every registered madrasa gets its own shareable link,
  // e.g. https://your-domain/s/noor-ul-islam — it opens that school's own
  // public page directly (not the platform landing). The SPA reads the slug
  // from the path on boot and routes to #/madrasa/<slug>. /school/ and /m/
  // are accepted aliases of the same link.
  const schoolLinkHandler = async (req, res) => {
    // Resolve the slug at the edge as well as in the public API. This gives
    // crawlers and direct requests a real 404 for an unknown/unpublished
    // institution instead of briefly serving another tenant's shell.
    if (req.params && req.params.slug) {
      const school = await db.get(
        "SELECT id FROM madaris WHERE slug = ? AND status = 'active' AND public_listing = 1 AND website_published <> 0",
        [String(req.params.slug).toLowerCase()]
      );
      if (!school) {
        return res.status(404).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Institution not found</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#faf8fc;color:#241532}main{max-width:560px;padding:40px;text-align:center}a{display:inline-block;margin-top:18px;padding:12px 18px;background:#200a3d;color:#fff;border-radius:8px;text-decoration:none}</style></head><body><main><p>Public website</p><h1>Institution not found</h1><p>This institution may be unpublished or the address may be incorrect.</p><a href="/">Return to EduSphere</a></main></body></html>`);
      }
    }
    return res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  };
  // Canonical institution website URL. The older aliases remain backwards
  // compatible, but all generated links use /schools/:slug.
  app.get("/schools/:slug", schoolLinkHandler);
  app.get("/schools/:slug/:page", schoolLinkHandler);
  app.get("/s/:slug", schoolLinkHandler);
  app.get("/school/:slug", schoolLinkHandler);
  app.get("/m/:slug", schoolLinkHandler);
  // Public directory landing pages. Their initial structure is intentionally
  // frontend-only while search, listings and category-specific registration
  // are developed in later milestones.
  app.get("/islamic-schools", schoolLinkHandler);
  app.get("/western-schools", schoolLinkHandler);
  app.get("/register-madrasa", schoolLinkHandler);
  // Western Academies get their OWN registration page (navy/sky identity and
  // academy-specific fields) instead of reusing the Madrasa onboarding form.
  app.get("/register-academy", schoolLinkHandler);
  // Each onboarding stage is a real, reloadable page of its own — the SPA
  // shell reads the stage from the path:
  //   /register-madrasa/administrator   /register-academy/administrator
  //   /register-madrasa/review          /register-academy/review
  //   /register-madrasa/submitted       /register-academy/submitted
  // Serving them explicitly keeps refreshing or sharing the Administrator page
  // working regardless of the SPA fallback below.
  app.get("/register-madrasa/:stage", schoolLinkHandler);
  app.get("/register-academy/:stage", schoolLinkHandler);
  // The admin section's own addresses. /login is the administrator sign-in
  // page (it ALWAYS asks for credentials — a live session never bypasses
  // it); /admin is the section itself and falls back to sign-in when the
  // visitor is not authenticated. Real paths (not a hash route) so the
  // page reloads cleanly with fresh state.
  app.get("/login", schoolLinkHandler);
  app.get("/admin", schoolLinkHandler);
  app.get("/admin/login", schoolLinkHandler);
  // Self-service password recovery — real, shareable addresses so a reset
  // link (from email, or handed over by an administrator) opens directly.
  app.get("/forgot-password", schoolLinkHandler);
  app.get("/reset-password", schoolLinkHandler);
  // Parent portal — "Book a meeting" (Parent-Teacher Meetings). Real,
  // reloadable addresses so a parent can bookmark the booking page; the SPA
  // shell mounts the parent module there and the API enforces the session.
  app.get("/parent", schoolLinkHandler);
  app.get("/parent/meetings", schoolLinkHandler);
  // Teacher and Student portals — real, reloadable addresses of their own so
  // a bookmark or shared link opens the right workspace directly.
  app.get("/teacher", schoolLinkHandler);
  app.get("/student", schoolLinkHandler);

  /* --------------------- QR verification pages (/verify) -----------------
   These are the URLs printed into a card's and a certificate's QR code, so
   they are real paths rather than SPA hash routes: a phone camera opens them
   directly, without a session, and they must answer correctly even in a
   browser that runs no JavaScript at all. Content is rendered server-side by
   services/verification-page.js.
   ---------------------------------------------------------------------- */
  const verificationPage = require("./services/verification-page");
  const cardCredentials = require("./services/card-credentials");
  const { scanLimiter } = require("./middleware/ratelimit");

  app.get("/verify", scanLimiter, asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store").type("html").send(verificationPage.renderScanPage(null));
  }));

  app.get("/verify/card/:code", scanLimiter, asyncHandler(async (req, res) => {
    const result = await cardCredentials.lookupCard(req.params.code);
    const page = result
      ? verificationPage.renderCardPage(cardCredentials.cardVerificationView(result))
      : verificationPage.renderCardUnknownPage(req.params.code);
    res.set("Cache-Control", "no-store").type("html").status(result ? 200 : 404).send(page);
  }));

  // The QR on a card carries the short form: /verify/<code>.
  app.get("/verify/:code", scanLimiter, asyncHandler(async (req, res) => {
    const result = await cardCredentials.lookupCard(req.params.code);
    const page = result
      ? verificationPage.renderCardPage(cardCredentials.cardVerificationView(result))
      : verificationPage.renderCardUnknownPage(req.params.code);
    res.set("Cache-Control", "no-store").type("html").status(result ? 200 : 404).send(page);
  }));

  app.get("/verify/certificate/:code", scanLimiter, asyncHandler(async (req, res) => {
    const clean = String(req.params.code || "").trim().toLowerCase();
    const row = /^[a-z0-9-]{6,64}$/.test(clean) ? await db.get(
      `SELECT c.id, c.verify_code, c.issued_date, c.config,
              s.first_name, s.middle_name, s.last_name, s.photo_path,
              t.name AS template_name, cl.name_en AS class_name, a.label AS session_label,
              m.id AS madrasa_id, m.name_en AS institution_name, m.motto_en, m.logo_path, m.status AS school_status,
              m.city, m.state_name
         FROM certificates c
         JOIN students s ON s.id = c.student_id AND s.madrasa_id = c.madrasa_id
         JOIN certificate_templates t ON t.id = c.template_id AND t.madrasa_id = c.madrasa_id
         LEFT JOIN classes cl ON cl.id = s.class_id AND cl.madrasa_id = s.madrasa_id
         LEFT JOIN academic_sessions a ON a.id = s.session_id AND a.madrasa_id = s.madrasa_id
         JOIN madaris m ON m.id = c.madrasa_id
        WHERE c.verify_code = ?`, [clean]
    ) : null;
    if (!row) {
      return res.status(404).type("html").send(verificationPage.renderCertificatePage({
        verdict: "unknown", code: clean, school: { name: "EduSphere" }, holderName: "", reference: "",
      }));
    }
    let config = {};
    try { config = JSON.parse(String(row.config || "{}")); } catch (e) { config = {}; }
    const view = {
      code: row.verify_code,
      verdict: row.school_status === "active" ? "valid" : "inactive",
      reference: `CERT-${String(row.issued_date || "").slice(0, 4)}-${String(row.id).padStart(6, "0")}`,
      holderName: [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" "),
      photoPath: row.photo_path || "",
      title: (config && config.title) || row.template_name || "Certificate",
      award: (config && config.award) || "",
      className: row.class_name || "",
      session: row.session_label || "",
      issued: String(row.issued_date || "").slice(0, 10),
      school: { name: row.institution_name, motto: row.motto_en, logo: row.logo_path, city: row.city, state: row.state_name },
    };
    await logActivity(db, { madrasaId: row.madrasa_id, userId: null, action: "certificate.verify.page", entity: "certificate", entityId: String(row.id), meta: { valid: view.verdict === "valid" }, ip: req.ip });
    res.set("Cache-Control", "no-store").type("html").send(verificationPage.renderCertificatePage(view));
  }));

  /* ------------------------- PUBLIC API (no login) -------------------- */
  // The logged-out public site (directory, madrasa profile, online admission,
  // result checking). Mounted BEFORE the session/CSRF stack on purpose:
  // anonymous visitors then neither create database session rows nor need a
  // CSRF token, and they are governed by their own, stricter rate limits.
  app.use("/api/public", publicRouter);

  /* ------------------------------ API -------------------------------- */
  const api = express.Router();
  api.use(apiLimiter);

  // Public bootstrap config (no auth, no session). Lets the SPA discover the
  // effective API base instead of hard-coding a URL.
  api.get("/config", (req, res) => {
    res.json({
      apiBase: config.EFFECTIVE_API_BASE,
      appName: "Multi-Madrasa Management Platform",
      env: config.NODE_ENV,
      paymentGateway: config.PAYMENT_GATEWAY,
    });
  });

  // Login and password-reset requests are separately (more strictly) rate
  // limited — both are unauthenticated surfaces.
  api.use("/auth/login", loginLimiter);
  api.use("/auth/forgot-password", resetRequestLimiter);

  // Sessions
  const sessionSecret = config.SESSION_SECRET || "dev-only-insecure-secret-000000000000000000000000";
  api.use(session({
    name: "mm_session",
    secret: sessionSecret,
    store: new DBSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: config.SESSION_MAX_AGE_MS,
      httpOnly: true,
      sameSite: "lax",
      secure: config.IS_PRODUCTION,
    },
  }));

  api.use(csrfGuard);
  api.use(loadUser);
  // Authenticated API payloads must never sit in a shared/proxy cache or be
  // re-served from disk cache after logout (browser Back must not re-expose
  // data). Only anonymous responses (config, csrf token, health) stay neutral.
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    next();
  });

  // CSRF token must be obtainable before login as well
  api.get("/csrf-token", (req, res) => res.json({ csrfToken: ensureCsrfToken(req) }));

  api.use("/auth", authRouter);
  // Cross-cutting admin capabilities (granular permissions, the institution
  // audit log, dashboard "needs attention" and global search). It owns no new
  // data model — it reads the tables the existing modules already own, always
  // through the same session/tenant guards.
  api.use("/admin", adminRouter);
  api.use("/platform", platformRouter);
  // Super Admin half of Chat & Support. Mounted behind the same
  // requireSuperAdmin guard the rest of the platform API uses, so an
  // institution administrator can never reach the platform-wide queue.
  api.use("/platform/conversations", requireSuperAdmin, supportChatAdminRouter);
  api.use("/madrasa", madrasaRouter);
  api.use("/classes", classesRouter);
  api.use(madrasaRootRouter); // /api/subjects, /api/sessions, /api/grading + legacy class fallback
  api.use("/students", studentsRouter);
  api.use("/teachers", teachersRouter);
  api.use("/results", resultsRouter);
  api.use("/attendance", attendanceRouter);
  // Payment callback/webhook are intentionally mounted before the authenticated API
  // router; initiate/status still enforce session and tenant guards themselves.
  api.use("/fees/payment", paymentRouter);
  api.use("/fees", feesRouter);
  // Expenses and budget allocation (categories, expenses, approvals, receipts, budgets, reports)
  api.use("/expenses", expensesRouter);
  api.use("/budget", budgetRouter);
  // Payroll (salary structures, pay periods, payslips, advances) is a separate
  // tenant-scoped admin ledger that follows the same mount/guard conventions
  // as the fees module above.
  api.use("/payroll", payrollRouter);
  // Staff leave (types, requests, approvals, balances, calendar). Same
  // tenant/role conventions as payroll above; it reuses the existing staff
  // accounts, academic sessions and teacher_attendance register rather than
  // introducing a parallel HR system.
  api.use("/leave", leaveRouter);
  api.use("/announcements", announcementsRouter);
  // Communication is a single tenant-scoped module. The short notification
  // mount is retained for existing portal/integration clients; the admin UI
  // uses /communication/* so announcements, messages, notifications and parent
  // communication are one sidebar section.
  api.use("/communication", communicationRouter);
  // Announcements are the same canonical router under the Communication URL;
  // this is only a compatibility mount, not a second data model or editor.
  api.use("/communication/announcements", announcementsRouter);
  api.use("/notifications", communicationRouter);
  // Parent-Teacher Meeting booking. It belongs to the Communication group in
  // the admin sidebar but keeps its own short mount, exactly like the other
  // tenant modules. It reuses users/students/parent_links/terms and the
  // existing notification service — no parallel people or messaging model.
  api.use("/ptm", ptmRouter);
  api.use("/portal", portalRouter);
  api.use("/admissions", admissionsRouter);
  api.use("/timetable", timetableRouter);
  // Category-specific Islamic academic module. It shares the same session,
  // tenant and student data engine; the route itself refuses Western tenants.
  api.use("/quran-progress", quranProgressRouter);
  api.use("/academic", academicRouter);
  api.use("/library", libraryRouter);
  // Keep the short /api/exams address for integrations while the dashboard
  // uses the grouped /api/academic/exams address.
  api.use("/exams", academicRouter);
  // Academic calendar & school events (shared by the admin workspace and the
  // portals; audience targeting is enforced server-side).
  api.use("/calendar", calendarRouter);
  // Platform support tickets — the institution's half. The super admin's
  // queue lives under /api/platform/tickets in platform.js.
  // Chat & Support (institution side) sits beside the older ticket queue
  // under the same /api/support prefix — one support area, two mounts.
  api.use("/support/chat", supportChatRouter);
  api.use("/support", supportRouter);
  api.use("/exports", exportsRouter);
  // Server-rendered ID cards and certificates. This mount remains inside the
  // authenticated API/session stack, while the route module applies its own
  // staff/admin role guards and tenant predicates.
  api.use("/documents", documentsRouter);
  api.use("/", extrasRouter); // /api/chat, /api/homework, /api/notifications, /api/users
  // Backups & storage diagnostics (super admin). Mounted before /platform so
  // the platform router never sees these paths.
  api.use("/platform/backups", backupsRouter);

  /* ------------------------------ activity log ------------------------ */
  api.get("/activity", asyncHandler(async (req, res) => {
    if (!req.user) return err(res, 401, "Authentication required.");
    if (req.user.role === "super_admin") {
      const mid = toNum(req.query.madrasaId, 0);
      const limit = Math.min(200, toNum(req.query.limit, 50));
      const rows = mid
        ? await db.all("SELECT * FROM activity_log WHERE madrasa_id = ? ORDER BY id DESC LIMIT ?", [mid, limit])
        : await db.all("SELECT * FROM activity_log ORDER BY id DESC LIMIT ?", [limit]);
      return ok(res, { activity: rows });
    }
    if (!req.user.madrasaId) return err(res, 403, "Permission denied.");
    const limit = Math.min(200, toNum(req.query.limit, 50));
    const rows = await db.all("SELECT * FROM activity_log WHERE madrasa_id = ? ORDER BY id DESC LIMIT ?", [req.user.madrasaId, limit]);
    ok(res, { activity: rows });
  }));

  /* ------------------------------ health ------------------------------ */
  api.get("/health", (req, res) => res.json({ ok: true, service: "multi-madrasa-platform" }));
  // Load-test / staging diagnostics (PERF_MONITOR=1 only): event-loop lag,
  // heap, CPU and pool utilisation for THIS process. Super admin only, so a
  // production-like deployment exposes nothing even when left enabled.
  if (config.PERF_MONITOR) {
    perfMonitor.start();
    api.get("/perf", requireSuperAdmin, asyncHandler(async (req, res) => {
      res.json(await perfMonitor.snapshot(db));
    }));
    api.post("/perf/reset", requireSuperAdmin, asyncHandler(async (req, res) => {
      perfMonitor.reset();
      res.json({ ok: true });
    }));
  }
  // Student Health & Medical records (tenant-scoped). Mounted AFTER the
  // service healthcheck above so GET /api/health keeps answering the uptime
  // probe anonymously; everything under /api/health/* is the medical module,
  // which enforces  medical module,
  // which enforces its own session/tenant/role guards.
  api.use("/health", healthRouter);

  app.use("/api", api);

  // 404 for unknown API routes
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

  // SPA fallback: unknown non-API GET -> index.html
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api") && req.accepts("html")) {
      return res.sendFile(path.join(__dirname, "..", "public", "index.html"));
    }
    next();
  });

  // Central error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body too large." });
    }
    if (err && err.status === 400 && /JSON/i.test(err.message)) {
      return res.status(400).json({ error: "Invalid JSON body." });
    }
    // Upload rejections are the caller's fault, not a server fault. Multer
    // surfaces them as thrown errors, which previously fell through to the
    // 500 branch below: the upload was correctly refused but the client was
    // told the server had crashed, and the real reason was swallowed.
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "That file is too large." });
    }
    if (err && (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE")) {
      return res.status(400).json({ error: "Unexpected file upload." });
    }
    if (err && err.expose && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}

module.exports = { createApp };
