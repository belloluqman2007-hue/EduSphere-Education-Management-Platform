"use strict";
/* ============================================================================
   PUBLIC SCHOOL WEBSITES — browser-level regression (jsdom)
   ----------------------------------------------------------------------------
   Every institution gets its own complete website at /schools/:slug. This test
   drives the REAL site in a real DOM against the REAL API for a content-rich
   tenant and for a nearly empty one, proving:

     • the site is a school website, not a dashboard: hero, sections, custom
       pages, gallery, results checker, contact — all from the school's data
     • each school's identity survives (brand colours, theme, layout, Arabic
       name, no another-tenant content)
     • empty sections are left out instead of publishing empty boxes
     • the public forms really submit (application, message, result verify)
     • the interactive layer works (drawer, lightbox, album filter, in-page nav)
     • AND the admin's "Edit website" / "View website" controls are clickable —
       the regression that made them silently do nothing.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { initEnv, setup } = require("./helpers");
initEnv();

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch (e) { /* production install */ }
const skip = !JSDOM ? "jsdom devDependency not installed" : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ROOT = path.join(__dirname, "..");

let ctx;
let rich;              // /schools/testa — a fully configured school
let sparse;            // /schools/testb — a school that has published almost nothing
const opened = [];     // every jsdom window, closed when the file finishes

/** Opens a page in jsdom with cookie-aware fetch, collecting script errors. */
async function openPage(base, url, { settle = 2600, cookie = "" } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (error) => {
    const message = String((error.detail && error.detail.message) || error.message || error);
    if (!/Not implemented/i.test(message)) errors.push(message);
  });
  vc.on("error", (...args) => errors.push(args.map(String).join(" ")));
  const dom = await JSDOM.fromURL(base + url, {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.scrollTo = () => {};
      if (window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = () => {};
      window.fetch = async (input, init = {}) => {
        const target = String(input).startsWith("http") ? input : base + input;
        const headers = new Headers(init.headers || {});
        if (cookie) headers.set("cookie", cookie);
        const response = await fetch(target, { ...init, headers });
        for (const header of (response.headers.getSetCookie ? response.headers.getSetCookie() : [])) {
          const pair = header.split(";")[0];
          const eq = pair.indexOf("=");
          if (eq > 0) cookie = pair.slice(0, eq + 1) + pair.slice(eq + 1);
        }
        return response;
      };
    },
  });
  opened.push(dom);
  await sleep(settle);
  const doc = dom.window.document;
  return {
    window: dom.window, doc, errors,
    $: (selector) => doc.querySelector(selector),
    $$: (selector) => Array.from(doc.querySelectorAll(selector)),
    click(selector) {
      const el = typeof selector === "string" ? doc.querySelector(selector) : selector;
      assert.ok(el, `expected ${selector} to exist`);
      el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
      return el;
    },
    submit(selector, values) {
      const form = typeof selector === "string" ? doc.querySelector(selector) : selector;
      assert.ok(form, `expected ${selector} to exist`);
      for (const [name, value] of Object.entries(values || {})) {
        const field = form.querySelector(`[name="${name}"]`);
        if (field) field.value = value;
      }
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      return form;
    },
    async waitFor(fn, label) {
      for (let i = 0; i < 80; i++) {
        const value = fn();
        if (value) return value;
        await sleep(100);
      }
      throw new Error("timed out waiting for " + (label || "condition"));
    },
  };
}

/** Reads text that a form wrote into its result paragraph. */
function settledText(doc, selector) {
  const el = doc.querySelector(selector);
  const text = el ? el.textContent.trim() : "";
  return text && !/…$/.test(text) ? text : "";
}

before(async () => {
  if (skip) return;
  ctx = await setup();
  const db = ctx.db;
  const mid = ctx.madrasaA;

  /* ---- a school that uses the website it was given --------------------- */
  await db.run(`UPDATE madaris SET public_listing = 1, public_results = 1, public_admissions = 1,
      name_en = 'Al-Noor Model Academy', name_ar = 'أكاديمية النور النموذجية',
      motto_en = 'Knowledge, Character, Service', tagline = 'Faith and excellence, together',
      founded_year = '2009', description_en = ?, short_description = ?,
      history = ?, mission = ?, vision = ?, core_values = ?, philosophy = ?,
      ownership_type = 'Faith-based', head_name = 'Ustadh Ibrahim Alabi', head_title = 'Principal', show_head = 1,
      registration_no = 'OG/EDU/2009/441', accreditation_body = 'Ogun State Ministry of Education',
      accreditation_details = 'Accredited Qur an and Arabic studies centre.',
      levels_offered = 'Primary, Junior Secondary, Senior Secondary', languages_of_instruction = 'Arabic and English',
      student_capacity = 420, boarding_status = 'Day & Boarding', admission_status = 'open',
      opening_time = '07:30', closing_time = '16:00', school_days = 'Mon,Tue,Wed,Thu,Fri', show_hours = 1,
      website = 'https://alnoor.example', whatsapp = '+2348012345678', maps_link = 'https://maps.example/alnoor',
      facebook = 'https://facebook.com/alnoor', show_socials = 1,
      hero_image_path = '/assets/islamic-school-learning.jpg',
      brand_color = '#145138', secondary_color = '#d8a437',
      homepage_layout = 'hero-split', header_style = 'transparent', footer_style = 'detailed',
      card_style = 'elevated', button_style = 'pill', font_family = 'serif', website_theme = 'light',
      seo_title = 'Al-Noor Model Academy — Ijebu-Ode', seo_description = 'Qur an, Arabic and the Nigerian curriculum under one roof.'
    WHERE id = ?`, [
    "Al-Noor Model Academy prepares confident young Muslims for the modern world, combining Hifz, Arabic and the Nigerian curriculum on one campus.",
    "A faith-based academy for the whole child.",
    "Founded in 2009 with 24 pupils in a rented hall; today the academy teaches over 400 learners.",
    "To nurture pupils who memorise the Book, master the sciences and serve their community.",
    "To be the leading integrated Islamic academy in Ogun State.",
    "Taqwa, honesty, diligence and service.",
    "English and Arabic are taught side by side.",
    mid,
  ]);

  // Public teacher profile
  await db.run(`INSERT INTO teacher_profiles (madrasa_id, user_id, position, department, qualifications,
      specialization, public_bio, public_subjects, education_track, status, public_display)
      VALUES (?,?,?,?,?,?,?,?,?, 'active', 1)`,
    [mid, ctx.users.teacherA, "Head of Arabic", "Languages", "B.A. Arabic (Unilag)",
      "Tajweed", "Ustadh Yusuf coaches the school's Qur an competition team.", "Arabic, Tajweed", "islamic"]);

  // Programmes across both tracks
  const programmes = [
    ["Hifz Programme", "Full-time memorisation with Tajweed and monthly assessment.", "islamic", "Memorisation", "3 years", 1],
    ["Arabic Language", "Spoken and written Arabic, beginner to classical grammar.", "islamic", "Language", "Ongoing", 0],
    ["Primary School", "The Nigerian primary curriculum with Islamic studies and French.", "western", "Primary", "6 years", 0],
  ];
  for (const [title, description, track, category, duration, featured] of programmes) {
    await db.run(`INSERT INTO public_programs (madrasa_id, title, description, education_track, category,
        level_name, duration, is_published, is_featured, sort_order) VALUES (?,?,?,?,?,?,?, 1, ?, 1)`,
      [mid, title, description, track, category, category, duration, featured]);
  }

  // Gallery: one album, three photos
  const album = (await db.run(`INSERT INTO gallery_albums (madrasa_id, title, description, category, is_published, sort_order)
      VALUES (?,?,?,?,1,1)`, [mid, "Campus life", "Classrooms and celebration days.", "Academic"])).lastInsertRowid;
  for (const [image, caption] of [
    ["/assets/islamic-school-learning.jpg", "Qur an circle in the main hall"],
    ["/assets/western-academy-learning.jpg", "Science lesson in the lab"],
  ]) {
    await db.run(`INSERT INTO gallery_images (madrasa_id, album_id, image_path, caption, category, is_published, sort_order)
        VALUES (?,?,?,?, 'Academic', 1, 1)`, [mid, album, image, caption]);
  }

  // Achievement + published pages + public notices
  await db.run(`INSERT INTO institution_achievements (madrasa_id, title, description, achievement_date, is_published, sort_order)
      VALUES (?,?,?,?,1,1)`, [mid, "State Qur an Competition — 1st place",
      "Two pupils took first place in the Ogun State schools competition.", "2026-06-14"]);
  for (const [slug, title, nav] of [["about-us", "About Al-Noor", 1], ["our-history", "Our History", 1], ["fees", "School Fees", 1]]) {
    await db.run(`INSERT INTO website_pages (madrasa_id, slug, title, body, in_navigation, is_published, sort_order)
        VALUES (?,?,?,?,?,1,1)`, [mid, slug, title, `${title} — written by the school, published by the school.`, nav]);
  }
  await db.run(`INSERT INTO announcements (madrasa_id, title, body, audience, is_active, created_by, publish_public, category)
      VALUES (?,?,?, 'all', 1, ?, 1, 'Announcement')`,
    [mid, "New session resumption", "All pupils resume on 12 September.", ctx.users.adminA]);
  await db.run(`INSERT INTO announcements (madrasa_id, title, body, audience, is_active, created_by, publish_public, category, event_date, event_location)
      VALUES (?,?,?, 'all', 1, ?, 1, 'event', '2026-11-02', 'School hall')`,
    [mid, "Annual Qur an graduation", "Join us for the graduation of this year's Hifz class.", ctx.users.adminA]);
  for (const [key, value] of [
    ["application_start_date", "2026-08-01"],
    ["application_closing_date", "2099-01-31"],   // deliberately open for the test run
    ["admission_requirements", "Birth certificate, last result sheet and two passport photographs."],
    ["application_process", "Submit the online form\nPay the application fee\nBring the child for assessment\nReceive the decision"],
    ["available_programs", JSON.stringify(["Nursery", "Primary", "Hifz Programme"])],
    ["admission_faqs", "Do you offer transport?\nYes — two buses cover Ijebu-Ode.\n\nIs boarding compulsory?\nNo."],
  ]) {
    await db.run("INSERT INTO settings (madrasa_id, key_name, value) VALUES (?,?,?)", [mid, key, value]);
  }

  // The second (near-empty) school stays deliberately bare.
  await db.run("UPDATE madaris SET public_listing = 1, homepage_layout = 'hero-split' WHERE id = ?", [ctx.madrasaB]);

  // Publish one term so the public result checker has a real record to verify.
  const grading = require("../server/services/grading");
  await grading.computeClassTerm(mid, ctx.classA1, ctx.termA1, ctx.users.adminA);
  await db.run("UPDATE term_summaries SET published_at = CURRENT_TIMESTAMP WHERE madrasa_id = ? AND term_id = ? AND published_at IS NULL",
    [mid, ctx.termA1]);

  rich = await openPage(ctx.base, "/schools/testa");
  sparse = await openPage(ctx.base, "/schools/testb");
});
after(async () => {
  // jsdom windows keep timers alive; close them or the test file never exits.
  for (const dom of opened) { try { dom.window.close(); } catch (e) { /* already gone */ } }
  if (ctx) await ctx.close();
});

test("every school gets a complete website built from its own data", { skip }, async () => {
  const doc = rich.doc;
  assert.equal(rich.errors.length, 0, "no client errors: " + rich.errors.join(" | "));

  // It is a website, not the admin shell or the platform marketing page.
  assert.ok(doc.querySelector(".school-site-root"), "school site root rendered");
  assert.equal(doc.querySelectorAll(".site-header, .dash-sidebar").length, 0, "no platform chrome on a school website");

  // Hero: identity, Arabic name, motto, calls to action, live admission badge.
  assert.match(doc.querySelector(".ss-hero__title").textContent, /Al-Noor Model Academy/);
  assert.equal(doc.querySelector(".ss-hero__ar").getAttribute("lang"), "ar");
  assert.match(doc.querySelector(".ss-hero__motto").textContent, /Knowledge, Character, Service/);
  assert.ok(doc.querySelector(".ss-hero__actions .ss-btn"), "hero has a call to action");
  assert.ok(doc.querySelector(".ss-chip--live"), "admissions-open badge is shown while the window is open");
  assert.ok(doc.querySelector(".ss-hero__frame img"), "hero-split layout shows the school's own image");

  // Section navigation mirrors the sections that exist.
  const nav = rich.$$(".ss-subnav__link").map((a) => a.textContent.trim());
  for (const label of ["Home", "About", "Programmes", "Teachers", "Admissions", "Gallery", "Contact"]) {
    assert.ok(nav.includes(label), `section nav lists ${label} (${nav.join(" · ")})`);
  }
  assert.ok(nav.includes("Our History"), "a published Website Page joins the navigation");

  // Every section the school filled in is on the page.
  for (const id of ["about", "programs", "teachers", "achievements", "admissions", "gallery", "news-events", "page-our-history", "results", "school-app", "contact"]) {
    assert.ok(doc.getElementById(id), `section #${id} rendered`);
  }

  // Real content, not placeholders.
  assert.equal(rich.$$(".ss-program-card").length, 3, "all published programmes are shown");
  assert.equal(rich.$$(".ss-program--islamic").length, 1, "Islamic programmes are grouped separately");
  assert.equal(rich.$$(".ss-program--western").length, 1, "Western programmes are grouped separately");
  assert.equal(rich.$$(".ss-teacher").length, 1, "approved teacher profiles are shown");
  assert.equal(rich.$$(".ss-shot").length, 2, "gallery photos are shown");
  assert.equal(rich.$$(".ss-news-card").length, 1, "public news is shown");
  assert.equal(rich.$$(".ss-event").length, 1, "public events are shown");
  assert.equal(rich.$$(".ss-achievement").length, 1, "achievements are shown");
  assert.ok(rich.$$(".ss-value").length >= 4, "mission, vision, values and philosophy are shown");
  assert.ok(rich.$$(".ss-fact").length >= 5, "verified school facts are shown");
  assert.ok(doc.querySelector(".ss-facts").textContent.includes("420"), "student capacity is published");
  assert.match(doc.querySelector(".ss-admissions").textContent, /Birth certificate/, "admission requirements are published");
  assert.ok(rich.$$(".ss-step").length >= 4, "the application process is shown as steps");
  assert.match(doc.getElementById("contact").textContent, /\+234/, "contact details are published");

  // The school's own words, and the school's own pages.
  assert.match(doc.getElementById("about").textContent, /rented hall/, "the History the school wrote is on the site");
  assert.match(doc.getElementById("page-fees").textContent, /written by the school/);

  // The result checker exists for a school that publishes results.
  assert.ok(doc.getElementById("schoolResultsForm"), "public result checker is available");
  assert.match(doc.getElementById("results").textContent, /report card/i);

  // The school app section and the EduSphere credit.
  assert.match(doc.body.textContent, /Stay connected with our school/);
  assert.match(doc.body.textContent, /Open School App/);
  assert.match(doc.querySelector(".ss-footer").textContent, /Powered by EduSphere/);
  assert.equal(doc.querySelectorAll('.ss-footer a[href="/"][data-route="/"]').length, 1, "one EduSphere credit link");

  // SEO + social metadata point at this school.
  assert.match(doc.title, /Al-Noor Model Academy/);
  assert.match(doc.querySelector('meta[property="og:title"]').getAttribute("content"), /Al-Noor/);
  assert.ok(doc.querySelector('meta[name="description"]').getAttribute("content").length > 20);
});

test("a school website keeps that school's identity, theme and settings", { skip }, async () => {
  const doc = rich.doc;
  const root = doc.querySelector(".school-site-root");
  const vars = root.getAttribute("style") || "";
  assert.match(vars, /--ss-brand:#145138/, "the school's own brand colour is applied");
  assert.match(vars, /--ss-accent:#d8a437/, "the school's own accent colour is applied");
  assert.match(vars, /--ss-btn-radius:999px/, "the chosen button shape is applied");
  assert.match(vars, /Georgia/, "the chosen font family is applied");
  assert.equal(root.getAttribute("data-cards"), "elevated");
  assert.equal(root.getAttribute("data-theme"), "light");
  assert.equal(doc.querySelector(".ss-header").getAttribute("data-header"), "transparent");
  assert.equal(doc.querySelector(".ss-hero").getAttribute("data-layout"), "hero-split");

  // No other tenant's content can appear.
  const text = doc.body.textContent;
  assert.ok(!text.includes("Test Madrasa B"), "no other school's name leaks in");
  assert.ok(!text.includes("Motto B"), "no other school's motto leaks in");
});

test("a school with little published content shows fewer sections, never empty ones", { skip }, async () => {
  const doc = sparse.doc;
  assert.equal(sparse.errors.length, 0, "no client errors: " + sparse.errors.join(" | "));
  const ids = sparse.$$("main section[id]").map((s) => s.id);
  assert.ok(ids.includes("home") && ids.includes("about") && ids.includes("contact"), "core sections always render");
  for (const empty of ["programs", "teachers", "gallery", "news-events", "achievements"]) {
    assert.ok(!ids.includes(empty), `#${empty} is left out when the school has published nothing for it`);
  }
  assert.ok(doc.querySelector(".ss-hero__frame--crest"), "a logo-less school gets a branded crest instead of a blank hero");
  assert.equal(doc.querySelectorAll(".ss-hero__frame img").length, 0, "no invented hero image");
});

test("the public forms really submit", { skip }, async () => {
  const doc = rich.doc;

  // Online admission application
  rich.submit("#publicApplicationForm", {
    first_name: "Zaynab", last_name: "Salami", parent_name: "Mr Salami", parent_phone: "+2348099998888",
  });
  const applied = await rich.waitFor(() => settledText(doc, "#publicApplicationOutput"), "application reference");
  assert.match(applied, /Application received/i);
  assert.match(applied, /ADM-/, "the applicant is given a reference number");

  // Contact message
  rich.submit("#schoolContactForm", { name: "A Parent", email: "parent@example.com", message: "Please send the fee schedule." });
  const sent = await rich.waitFor(() => settledText(doc, "#schoolContactOutput"), "contact confirmation");
  assert.match(sent, /sent to the school/i);

  // Result checking against a published term
  rich.submit("#schoolResultsForm", { admissionNo: "TTA0001", surname: "One" });
  const verified = await rich.waitFor(() => settledText(doc, "#schoolResultsOutput"), "result verification");
  assert.match(verified, /Verified: Alpha One/);
  const row = await rich.waitFor(() => doc.querySelector(".ss-term-row"), "a published term row");
  assert.match(row.textContent, /First Term/);
  assert.match(row.querySelector("a").getAttribute("href"), /\/api\/public\/results\/report\//, "the report card link is the public token link");

  // A wrong record is refused, and the page says so instead of pretending.
  rich.submit("#schoolResultsForm", { admissionNo: "TTA0001", surname: "Nobody" });
  const refused = await rich.waitFor(() => {
    const text = settledText(doc, "#schoolResultsOutput");
    return /no matching record/i.test(text) ? text : "";
  }, "refusal message");
  assert.match(refused, /No matching record/i);
});

test("the interactive layer works (menu, lightbox, albums, in-page navigation)", { skip }, async () => {
  const doc = rich.doc;

  rich.click("#schoolMenuToggle");
  const drawer = doc.querySelector("#schoolDrawer");
  assert.ok(drawer.classList.contains("is-open"), "mobile drawer opens");
  assert.ok(drawer.querySelectorAll("a").length > 5, "the drawer carries the same navigation");
  rich.click("#schoolDrawerClose");
  assert.ok(!drawer.classList.contains("is-open"), "mobile drawer closes");

  rich.click(".ss-shot");
  const lightbox = doc.querySelector("#schoolLightbox");
  assert.ok(lightbox.classList.contains("is-open"), "gallery lightbox opens");
  assert.match(lightbox.querySelector("#schoolLightboxMedia").innerHTML, /<img /);
  assert.match(lightbox.querySelector("#schoolLightboxCount").textContent, /1 \/ 2/);
  rich.click("#schoolLightboxNext");
  assert.match(lightbox.querySelector("#schoolLightboxCount").textContent, /2 \/ 2/, "lightbox steps through the gallery");
  rich.click("#schoolLightboxClose");
  assert.ok(!lightbox.classList.contains("is-open"), "lightbox closes");

  const albums = rich.$$(".ss-album");
  if (albums.length > 1) {
    rich.click(albums[1]);
    assert.ok(albums[1].classList.contains("is-active"), "album filter can be selected");
  }

  rich.click('[data-school-link="gallery"]');
  assert.equal(rich.window.location.hash, "#gallery", "in-page links update the address without reloading");

  // Scroll reveals must end up visible (never leave content hidden).
  const reveals = rich.$$(".school-reveal");
  assert.ok(reveals.length > 10, "sections opt into the reveal animation");
  assert.equal(reveals.filter((el) => el.classList.contains("is-visible")).length, reveals.length,
    "every revealed block is visible after mount");
});

test("admin 'Edit website' / 'View website' controls can actually be clicked", { skip }, async () => {
  /* The regression: .dash-website-card::after was a decorative overlay painted
     above the buttons with no pointer-events rule, so every click on "Visit
     Website" and "Edit Website" was swallowed. Both halves of the fix are
     asserted here — the CSS, and the real click in a real DOM. */
  const dashboardCss = fs.readFileSync(path.join(ROOT, "public/css/dashboard.css"), "utf8");
  const overlay = dashboardCss.match(/\.dash-website-card::after\s*\{[^}]*\}/);
  assert.ok(overlay, "the website-card overlay rule still exists");
  assert.match(overlay[0], /pointer-events:\s*none/, "the overlay must never take pointer events");
  const actions = dashboardCss.match(/\.dash-website-actions\s*\{[^}]*\}/);
  assert.match(actions[0], /z-index:\s*1/, "the website-card controls sit above the overlay");

  // One delegated listener guarantees navigation even if a page forgets to bind.
  const dashboardJs = fs.readFileSync(path.join(ROOT, "public/js/dashboard.js"), "utf8");
  assert.match(dashboardJs, /document\.addEventListener\("click", \(event\) => \{[\s\S]{0,400}?closest\("\[data-nav-route\],\[data-mi-nav\]"\)/,
    "dashboard navigation is delegated from the document");

  const page = await openPage(ctx.base, "/login");
  await page.waitFor(() => page.$("#dashLoginForm"), "admin sign-in form");
  page.$("#dlUser").value = "admin-a";
  page.$("#dlPass").value = "Passw0rd!123";
  page.$("#dashLoginForm").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
  await page.waitFor(() => page.$("#dashContent"), "dashboard content");

  const card = await page.waitFor(() => page.$(".dash-website-card"), "the website card");
  const visit = card.querySelector('a[href^="/schools/"]');
  assert.ok(visit, "the card links to the live website");
  assert.equal(visit.getAttribute("target"), "_blank", "the live site opens in a new tab");

  // The reported fault: pressing Edit Website did nothing.
  const edit = card.querySelector('[data-nav-route="institution/appearance"]');
  assert.ok(edit, "the card offers Edit Website");
  edit.dispatchEvent(new page.window.Event("click", { bubbles: true, cancelable: true }));
  await page.waitFor(() => /Website Appearance/i.test(page.$("#dashContent").textContent),
    "the appearance screen after clicking Edit Website");
  assert.match(decodeURIComponent(page.window.location.hash), /institution\/appearance/);
  assert.match(page.$("#dashContent").textContent, /Branding/);
  assert.equal(page.errors.length, 0, "no client errors: " + page.errors.join(" | "));
});

test("the school website has exactly one stylesheet, loaded after the platform CSS", { skip }, async () => {
  const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
  const app = html.indexOf("/css/app.css");
  const site = html.indexOf("/css/school-site.css");
  assert.ok(site > app && app > -1, "school-site.css is linked after app.css so it wins the cascade");
  const appCss = fs.readFileSync(path.join(ROOT, "public/css/app.css"), "utf8");
  assert.ok(!/\.school-hero|\.school-site-header|\.school-stat-grid/.test(appCss),
    "the old school design system is gone from app.css — no conflicting rules");
  const siteCss = fs.readFileSync(path.join(ROOT, "public/css/school-site.css"), "utf8");
  for (const rule of [".ss-hero", ".ss-header", ".ss-footer", ".school-jmotion", "prefers-reduced-motion"]) {
    assert.ok(siteCss.includes(rule), `school-site.css defines ${rule}`);
  }
});
