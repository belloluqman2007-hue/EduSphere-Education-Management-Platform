"use strict";
/* ============================================================================
   BILLING IS AN ADMINISTRATOR'S BUSINESS — and the operator's own details are
   editable from the platform console.
   ----------------------------------------------------------------------------
   Three promises are tested here:

     1. a teacher holds neither subscription permission, so the dashboard menu
        and route guard cannot show them billing;
     2. the server refuses the institution billing API to a teacher outright;
     3. a Super Admin can type their own public-website information once and an
        anonymous visitor immediately reads it from /api/public/site.
   ========================================================================== */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { initEnv, setup, Client, PASSWORD, SA_PASSWORD } = require("./helpers");
initEnv();
// Required AFTER initEnv(): permissions → db → config reads the environment.
const permissions = require("../server/services/permissions");

let ctx, sa, teacher;
before(async () => {
  ctx = await setup();
  sa = new Client(ctx.base);
  await sa.login("testadmin", SA_PASSWORD);
  teacher = new Client(ctx.base);
  await teacher.login("teacher-a", PASSWORD);
});
after(async () => { await ctx.close(); });

test("a teacher is never given the subscription permissions", () => {
  const teacherSet = new Set(permissions.roleDefaults("teacher"));
  assert.equal(teacherSet.has("subscription.view"), false);
  assert.equal(teacherSet.has("subscription.manage"), false);

  const adminSet = new Set(permissions.roleDefaults("madrasa_admin"));
  assert.equal(adminSet.has("subscription.view"), true, "the administrator keeps billing");
  assert.equal(adminSet.has("subscription.manage"), true);
});

test("the sidebar and the route guard hide billing from a teacher", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "dashboard.js"), "utf8");
  assert.match(source, /subscription: \["subscription\.view", "subscription\.manage"\]/,
    "the Subscription section is permission-gated");
  assert.match(source, /"subscription\/overview": \["subscription\.view"\]/,
    "and so is every screen inside it");
  assert.match(source, /function routeAllowed\(route\)/, "a typed hash is checked as well as the menu");
  assert.match(source, /if \(!routeAllowed\(route\)\)/, "the render path refuses a route the account cannot use");
});

test("the server refuses the institution's billing API to a teacher", async () => {
  const r = await teacher.req("GET", "/api/subscription");
  assert.equal(r.status, 403, "teachers can never read what the school pays");
  const plans = await teacher.req("GET", "/api/subscription/plans");
  assert.equal(plans.status, 403);
});

test("a Super Admin can publish their own details to the public website", async () => {
  const body = {
    public_operator_name: "EduSphere Education Platform",
    public_operator_about: "We build school software for Nigeria and beyond.",
    public_contact_email: "hello@edusphere.example",
    public_contact_phone: "+234 801 234 5678",
    public_contact_whatsapp: "0803 000 1111",
    public_contact_address: "Ijebu-Ode, Ogun State, Nigeria",
    public_support_hours: "Mon–Fri, 9:00–17:00 WAT",
    public_social_facebook: "https://facebook.com/edusphere",
    public_social_instagram: "https://instagram.com/edusphere",
    public_social_x: "https://x.com/edusphere",
    public_social_linkedin: "https://linkedin.com/company/edusphere",
    public_social_tiktok: "https://tiktok.com/@edusphere",
    public_footer_note: "Built in Nigeria for schools worldwide.",
  };
  const saved = await sa.api("PUT", "/api/platform/settings", body);
  assert.equal(saved.status, 200);

  const site = await new Client(ctx.base).req("GET", "/api/public/site");
  assert.equal(site.status, 200);
  assert.equal(site.data.site.operatorName, body.public_operator_name);
  assert.equal(site.data.site.operatorAbout, body.public_operator_about);
  assert.equal(site.data.site.contactEmail, body.public_contact_email);
  assert.equal(site.data.site.contactPhone, body.public_contact_phone);
  assert.equal(site.data.site.contactWhatsapp, body.public_contact_whatsapp);
  assert.equal(site.data.site.contactAddress, body.public_contact_address);
  assert.equal(site.data.site.supportHours, body.public_support_hours);
  assert.equal(site.data.site.socials.facebook, body.public_social_facebook);
  assert.equal(site.data.site.socials.tiktok, body.public_social_tiktok);
  assert.equal(site.data.site.footerNote, body.public_footer_note);
});

test("an institution administrator cannot edit the operator's public details", async () => {
  const admin = new Client(ctx.base);
  await admin.login("admin-a", PASSWORD);
  const r = await admin.api("PUT", "/api/platform/settings", { public_operator_name: "Hijacked" });
  assert.equal(r.status, 403);
});

test("the public website renders what the operator saved, and nothing dead", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  assert.match(app, /applySiteInfo/, "the footer is hydrated from the platform settings");
  assert.match(app, /window\.API\.public\.get\("\/site"\)/, "it reads the public site endpoint");
  for (const id of ["siteContactEmail", "siteContactPhone", "siteContactWhatsapp", "siteContactAddress", "siteHours", "siteSocials"]) {
    assert.ok(app.includes(id), "the footer exposes " + id);
  }
});

test("a blank field is simply not shown", async () => {
  await sa.api("PUT", "/api/platform/settings", {
    public_contact_email: "", public_contact_phone: "", public_contact_whatsapp: "",
    public_contact_address: "", public_support_hours: "", public_footer_note: "",
    public_social_facebook: "", public_social_instagram: "", public_social_x: "",
    public_social_linkedin: "", public_social_tiktok: "",
  });
  const site = await new Client(ctx.base).req("GET", "/api/public/site");
  assert.equal(site.data.site.contactEmail, "");
  assert.equal(site.data.site.socials.facebook, "");
  assert.equal(site.data.site.supportHours, "");
});
