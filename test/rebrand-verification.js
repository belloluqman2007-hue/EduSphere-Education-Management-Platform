"use strict";
/* EduSphere rebrand verification — drives the real dev server in jsdom and
   checks the requirement-25 checklist items that are visible in the DOM. */
const { JSDOM, VirtualConsole } = require("jsdom");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra ? ` — ${extra}` : "")); }
}

async function openPage(path, { settle = 1200 } = {}) {
  const pageErrors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    const msg = String((e.detail && e.detail.message) || e.message || e);
    if (!/Not implemented/i.test(msg)) pageErrors.push(msg);
  });
  vc.on("error", (...a) => pageErrors.push(a.map(String).join(" ")));
  let cookie = "";
  const dom = await JSDOM.fromURL(BASE + path, {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.fetch = async (input, init = {}) => {
        const url = String(input).startsWith("http") ? input : BASE + input;
        const headers = new Headers(init.headers || {});
        if (cookie) headers.set("cookie", cookie);
        const res = await fetch(url, { ...init, headers, redirect: "manual" });
        for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
          const jar = {};
          for (const p of cookie.split(";")) { const i = p.indexOf("="); if (i > 0) jar[p.slice(0, i).trim()] = jar[p.slice(0, i).trim()] || p.slice(i + 1); }
          const pair = c.split(";")[0]; const i = pair.indexOf("=");
          jar[pair.slice(0, i).trim()] = pair.slice(i + 1);
          cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
        }
        return res;
      };
    },
  });
  await sleep(settle);
  return {
    window: dom.window, doc: dom.window.document, pageErrors, cookie,
    $: (s) => dom.window.document.querySelector(s),
    $$: (s) => Array.from(dom.window.document.querySelectorAll(s)),
    async type(sel, value) { const el = this.$(sel); el.value = value; },
    close() { try { dom.window.close(); } catch (e) {} },
  };
}

/** The tenant's own name, straight from its public payload — the checks below
    must follow the demo data, not a name hard-coded in this file. */
async function publicName(slug) {
  const res = await fetch(`${BASE}/api/public/schools/${slug}`);
  const body = await res.json();
  return (body && body.madrasa && body.madrasa.nameEn) || "";
}

async function login(page, user, pass) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (let i = 0; i < 40 && !page.$("#dashLoginForm, #portalLoginForm"); i++) await sleep(50);
    const form = page.$("#dashLoginForm") || page.$("#portalLoginForm");
    if (!form) throw new Error("no login form for " + user);
    form.elements.username.value = user;
    form.elements.password.value = pass;
    form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 60 && !page.$(".dash-sidebar") && !page.$("#portalRoot"); i++) await sleep(100);
    if (page.$(".dash-sidebar") || page.$("#portalRoot")) return;
    const err = page.$(".dash-login-error");
    if (err && /too many/i.test(err.textContent)) { await sleep(4000); continue; }
    console.log(`    (retry ${attempt + 1} for ${user}: ${err ? err.textContent : "no error shown"})`);
    await sleep(1500);
  }
}

(async () => {
  const DEMO_PASSWORD = "Parent1234!"; // demo users share this password family
  const demoUsers = {
    "demo-quraniyya-admin": "Demo1234!", "demo-quraniyya-ust1": "Demo1234!",
    "demo-quraniyya-stu1": "Student1234!", "demo-quraniyya-parent1": DEMO_PASSWORD,
    "demo-fatihah-admin": "Demo1234!",
  };

  console.log("\n── 1. Global homepage (EduSphere branding, no Arabic) ──");
  {
    const p = await openPage("/");
    check("document.title is “EduSphere — Education Management Platform”", p.doc.title === "EduSphere — Education Management Platform", p.doc.title);
    check("header brand uses /assets/edusphere-logo.png", (p.$(".brand-logo img") || {}).src?.endsWith("/assets/edusphere-logo.png"));
    check("hero shows the official EduSphere logo", (p.$(".hero-logo") || {}).src?.endsWith("/assets/edusphere-logo.png"));
    check("hero headline is “Smarter Management for Modern Education”", /Smarter Management for/.test(p.$("#hero-title")?.textContent || ""));
    const actions = p.$$(".platform-hero-intro .hero-actions a").map((a) => a.textContent.trim());
    check("hero has Get Started", actions.some((t) => /Get Started/.test(t)), actions.join("|"));
    check("hero has Sign In", actions.some((t) => /Sign In/.test(t)), actions.join("|"));
    check("no Arabic anywhere in the global homepage main", p.$$('#main-content [lang="ar"]').length === 0);
    check("no Arabic in the global footer", p.$$('.site-footer [lang="ar"]').length === 0);
    check("no BELLO text on the page", !/BELLO/i.test(p.doc.body.textContent));
    const body = p.doc.body.textContent;
    check("homepage communicates Finance/Payroll/Library/Parent Portal capabilities",
      ["Finance", "Payroll", "Library", "Parent Portal", "Attendance", "Admissions"].every((c) => body.includes(c)));
    check("favicon is the EduSphere logo", (p.doc.querySelector('link[rel="icon"]') || {}).href?.endsWith("/assets/edusphere-logo.png"));
    check("manifest link present", Boolean(p.doc.querySelector('link[rel="manifest"]')));
    check("no client errors", p.pageErrors.length === 0, p.pageErrors.join(" | "));
    p.close();
  }

  console.log("\n── 2. Unified login page (global platform branding) ──");
  {
    const p = await openPage("/login");
    check("login card shows the official EduSphere logo", (p.$(".dash-login-card .brand-row img") || {}).src?.endsWith("/assets/edusphere-logo.png"));
    check("heading says “Sign in to EduSphere”", /Sign in to EduSphere/.test(p.$(".dash-login-card h1")?.textContent || ""));
    check("no manual role selection on the login card", !p.$(".dash-login-card select"));
    check("no Arabic on the login page", p.$$('[lang="ar"]').length === 0);
    check("no BELLO branding on the login page", !/BELLO/i.test(p.doc.body.textContent));
    p.close();
  }

  console.log("\n── 3. School public website (tenant A: Islamic) ──");
  {
    const p = await openPage("/schools/demo-quraniyya", { settle: 1800 });
    check("school page title is the school's own name", p.doc.title.includes("Al-Quraniyya"), p.doc.title);
    check("school Arabic name is preserved (school-specific Arabic)", p.$$('.school-ar[lang="ar"]').length >= 1);
    check("no automatic subject tag list on the public website", p.$$("#programs .school-tag-list").length === 0);
    const programsText = p.$("#programs")?.textContent || "";
    check("hard-coded subjects (Qur'an/Tajweed/Fiqh) are not auto-listed", !/Tajweed|Fiqh|Tawheed|Nahw/.test(programsText));
    check("“Stay Connected” / Open School App section present", /Stay connected with our school/i.test(p.doc.body.textContent) && /Open School App/.test(p.doc.body.textContent));
    check("no fake app-store links", !/play\.google\.com|apps\.apple\.com/i.test(p.doc.body.textContent));
    check("footer credits “Powered by EduSphere”", /Powered by EduSphere/.test(p.doc.body.textContent));
    check("meta description set dynamically", (p.doc.querySelector('meta[name="description"]') || {}).content?.length > 10);
    check("og:title set to the school", (p.doc.querySelector('meta[property="og:title"]') || {}).content?.includes("Al-Quraniyya"));
    check("no BELLO branding on the school site", !/BELLO/i.test(p.doc.body.textContent));
    check("no client errors", p.pageErrors.length === 0, p.pageErrors.join(" | "));
    p.close();
  }

  console.log("\n── 4. School public website (tenant B: Western) ──");
  {
    const nameB = await publicName("demo-fatihah");
    const p = await openPage("/schools/demo-fatihah", { settle: 1800 });
    check("tenant B title is its own name", Boolean(nameB) && p.doc.title.includes(nameB), p.doc.title);
    check("tenant A's Arabic name does NOT appear on tenant B", !p.doc.body.textContent.includes("مدرسة القرونية"));
    check("tenant A's name does NOT appear on tenant B", !p.doc.body.textContent.includes("Al-Quraniyya"));
    check("no subject tag list on tenant B either", p.$$("#programs .school-tag-list").length === 0);
    check("Powered by EduSphere on tenant B", /Powered by EduSphere/.test(p.doc.body.textContent));
    p.close();
  }

  console.log("\n── 5. Islamic admin sidebar (subjects are data, not navigation) ──");
  {
    const p = await openPage("/admin");
    await login(p, "demo-quraniyya-admin", demoUsers["demo-quraniyya-admin"]);
    await sleep(1500);
    const sidebar = p.$(".dash-sidebar")?.textContent || "";
    const nav = p.$(".dash-nav")?.textContent || "";
    check("sidebar renders", sidebar.length > 0);
    check("no standalone “Islamic Subjects” section", !/Islamic Subjects/.test(nav));
    for (const s of ["Qur'an", "Quran", "Tajweed", "Hadith", "Fiqh", "Tawheed", "Aqeedah", "Seerah", "Nahw", "Sarf", "Arabic", "Imla'"]) {
      check(`sidebar does not list “${s}” as navigation`, !nav.includes(s));
    }
    check("Academic → Curriculum & Subjects is present", /Curriculum & Subjects/.test(nav));
    check("Academic → Hifz Progress Tracker is present (Islamic)", /Hifz Progress Tracker/.test(nav));
    check("sidebar shows the institution's own name", sidebar.includes("Al-Quraniyya"));
    // open the subjects workspace through Academic
    p.window.BelloDashboard.go("academic/subjects");
    await sleep(1500);
    const content = p.$("#dashContent")?.textContent || "";
    check("Academic → Curriculum & Subjects workspace opens", /Curriculum & Subjects/.test(content));
    check("subject categories are listed as data", /Qur'an/.test(content));
    check("subject records still manageable (Add subject flow exists)", Boolean(p.$("#subjectCategoryGrid")));
    // quran tracker still reachable
    p.window.BelloDashboard.go("quran/progress");
    await sleep(1500);
    check("Qur'an / Hifz tracker still works via its route", /Qur'an \/ Hifz/i.test(p.$("#dashContent")?.textContent || ""));
    check("no client errors", p.pageErrors.length === 0, p.pageErrors.join(" | "));
    p.close();
  }

  console.log("\n── 6. Western admin sidebar ──");
  {
    const nameB = await publicName("demo-fatihah");
    const p = await openPage("/admin");
    await login(p, "demo-fatihah-admin", demoUsers["demo-fatihah-admin"]);
    await sleep(1500);
    const sidebar = p.$(".dash-sidebar")?.textContent || "";
    const nav = p.$(".dash-nav")?.textContent || "";
    check("sidebar renders", sidebar.length > 0);
    check("no “Academic Programs” standalone subject section", !/Academic Programs/.test(nav));
    for (const s of ["Mathematics", "English", "Sciences", "Computer Science", "Technology", "Business", "Arts", "Social Sciences", "Languages"]) {
      check(`sidebar does not list “${s}” as navigation`, !nav.includes(s));
    }
    check("Academic → Curriculum & Subjects is present", /Curriculum & Subjects/.test(nav));
    check("no Qur'an / Hifz item for Western institutions", !nav.includes("Qur'an"));
    check("sidebar shows the institution's own name", Boolean(nameB) && sidebar.includes(nameB));
    check("no client errors", p.pageErrors.length === 0, p.pageErrors.join(" | "));
    p.close();
  }

  console.log("\n── 7. Portals (school-branded shell) ──");
  for (const [user, pass, role] of [
    ["demo-quraniyya-ust1", demoUsers["demo-quraniyya-ust1"], "teacher"],
    ["demo-quraniyya-stu1", demoUsers["demo-quraniyya-stu1"], "student"],
    ["demo-quraniyya-parent1", demoUsers["demo-quraniyya-parent1"], "parent"],
  ]) {
    const p = await openPage("/" + role);
    await login(p, user, pass);
    await sleep(1500);
    const brand = p.$(".dash-brand")?.textContent || "";
    check(`${role} portal sign-in works and mounts the workspace`, Boolean(p.$("#portalRoot")) || Boolean(p.$(".dash-sidebar")));
    check(`${role} portal shell is school-branded (Al-Quraniyya)`, brand.includes("Al-Quraniyya"), brand);
    check(`${role} portal has no BELLO branding`, !/BELLO/i.test(p.doc.body.textContent));
    check(`${role} portal: no client errors`, p.pageErrors.length === 0, p.pageErrors.join(" | "));
    p.close();
  }

  console.log("\n── 8. Super admin ──");
  if (!process.env.SUPER_ADMIN_PASSWORD) {
    console.log("  (skipped — start the dev server with SUPER_ADMIN_PASSWORD set to check the super admin console)");
  } else {
    const p = await openPage("/login");
    await login(p, "admin", process.env.SUPER_ADMIN_PASSWORD);
    await sleep(2000);
    const brand = p.$(".dash-brand")?.textContent || "";
    check("super admin signs in and reaches the platform console", /Super Admin|Platform/.test(brand + p.doc.title), brand);
    check("super admin sidebar shows EduSphere (global platform)", brand.includes("EduSphere"), brand);
    check("super admin brand logo is the official EduSphere logo", (p.$(".dash-brand-logo img") || {}).src?.endsWith("/assets/edusphere-logo.png"));
    check("no client errors", p.pageErrors.length === 0, p.pageErrors.join(" | "));
    p.close();
  }

  console.log(`\n════════ RESULT: ${pass} passed, ${fail} failed ════════`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
