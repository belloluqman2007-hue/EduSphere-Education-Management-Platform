"use strict";
/* ============================================================================
   EDUSPHERE AI — the widget in a real DOM
   ----------------------------------------------------------------------------
   The assistant is a DASHBOARD tool. It used to mount on every surface, and on
   the teacher/student/parent portals the floating launcher sat on top of the
   message composer and hid the very conversation it was meant to help with.
   These tests pin the restriction down in the browser:

     • a visitor on the public site gets NO launcher and costs no request;
     • a student in the portal gets NO launcher, not even the signed-in one;
     • an administrator inside #/app/dashboard DOES get the assistant, with the
       server-chosen space, and a message reaches /ai/chat;
     • leaving the dashboard unmounts the launcher immediately.

   The widget is loaded exactly as the page loads it (a plain <script>), with
   window.API stubbed at the boundary the real page provides.
   ========================================================================== */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch (e) { /* production install */ }
const skip = !JSDOM ? "jsdom devDependency not installed" : false;
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "public", "js", "edusphere-ai.js"), "utf8");

const ADMIN_SPACE = {
  key: "admin",
  label: "EduSphere AI · Admin",
  subtitle: "Your institution's assistant",
  greeting: "Hello! I am EduSphere AI for your institution.",
  suggestions: ["How is my institution doing this term?", "How much of my student limit have I used?", "How do I upgrade?"],
  capabilities: [],
  handoff: { kind: "support", label: "Chat & Support" },
};

const PUBLIC_SPACE = {
  key: "public",
  label: "EduSphere AI",
  subtitle: "Registration, plans & getting started",
  greeting: "Hello! I'm EduSphere AI.",
  suggestions: ["How do I register my school?"],
  capabilities: [],
  handoff: { kind: "whatsapp", label: "Chat on WhatsApp" },
};

function makeDom(url) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: url || "https://edusphere.example/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.eval(SOURCE);
  return dom;
}

function stubPublic(dom) {
  const calls = [];
  dom.window.API = {
    me: async () => ({ loggedIn: false }),
    get: async () => { throw new Error("no session"); },
    post: async () => { throw new Error("no session"); },
    public: {
      get: async (p) => {
        calls.push({ method: "GET", path: p });
        if (p === "/ai/info") return { surface: "public", space: PUBLIC_SPACE };
        throw new Error("unexpected " + p);
      },
      post: async (p, body) => { calls.push({ method: "POST", path: p, body }); return { reply: "ok" }; },
    },
  };
  return calls;
}

function stubAdmin(dom) {
  const calls = [];
  dom.window.API = {
    me: async () => ({ loggedIn: true, role: "madrasa_admin", user: { id: 1, role: "madrasa_admin", fullName: "Admin" } }),
    get: async (p) => {
      calls.push({ method: "GET", path: p });
      if (p === "/ai/status") {
        return {
          surface: "admin",
          role: "madrasa_admin",
          space: ADMIN_SPACE,
          welcome: { greeting: ADMIN_SPACE.greeting, suggestions: ADMIN_SPACE.suggestions },
          live: false,
          institution: "Test School",
        };
      }
      if (p === "/ai/copilot") return { capabilities: [] };
      throw new Error("unexpected " + p);
    },
    post: async (p, body) => {
      calls.push({ method: "POST", path: p, body });
      return { reply: "Your institution has 42 students.", sources: [], mode: "knowledge-base" };
    },
    public: { get: async () => { throw new Error("a signed-in dashboard never calls the public API"); } },
  };
  return calls;
}

async function mount(dom) {
  await dom.window.EduSphereAI.mount();
  return dom.window.document.querySelector(".ai-root");
}

test("a visitor on the public site gets no launcher at all", { skip }, async () => {
  const dom = makeDom("https://edusphere.example/");
  const calls = stubPublic(dom);
  const root = await mount(dom);
  assert.equal(root, null, "the assistant is not mounted on the public site");
  assert.equal(calls.length, 0, "and it costs no request");
});

test("a student in the portal gets no launcher, even though a session exists", { skip }, async () => {
  const dom = makeDom("https://edusphere.example/student");
  const calls = stubAdmin(dom);
  const root = await mount(dom);
  assert.equal(root, null, "the portal renders without the floating icon");
  assert.equal(calls.length, 0, "the portal never asks for the assistant");
});

test("an administrator inside the dashboard gets the assistant", { skip }, async () => {
  const dom = makeDom("https://edusphere.example/#/app/dashboard");
  const calls = stubAdmin(dom);
  const root = await mount(dom);
  assert.ok(root, "the widget mounted on the dashboard");

  assert.ok(calls.some((c) => c.path === "/ai/status"), "the server decided the space");
  assert.equal(root.querySelector(".ai-panel-title").textContent, ADMIN_SPACE.label);
  assert.equal(root.querySelector(".ai-panel-sub").textContent, ADMIN_SPACE.subtitle);
  assert.match(root.querySelector(".ai-msg-bot").textContent, /institution/i);

  const chips = Array.from(root.querySelectorAll(".ai-suggestions .ai-chip")).map((c) => c.textContent);
  assert.deepEqual(chips, ADMIN_SPACE.suggestions.slice(0, 3));

  root.querySelector(".ai-input").value = "How many students do we have?";
  root.querySelector(".ai-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 40));
  const sent = calls.find((c) => c.method === "POST" && c.path === "/ai/chat");
  assert.ok(sent, "the message reached the signed-in endpoint");
  const bubbles = Array.from(root.querySelectorAll(".ai-msg")).map((b) => b.textContent);
  assert.ok(bubbles.some((t) => t.includes("42 students")), "the answer is rendered");
});

test("leaving the dashboard unmounts the launcher immediately", { skip }, async () => {
  const dom = makeDom("https://edusphere.example/#/app/dashboard");
  stubAdmin(dom);
  const root = await mount(dom);
  assert.ok(root);

  // The SPA walks from the dashboard to the teacher portal without a reload.
  dom.window.location.hash = "#/teacher/messages";
  await dom.window.EduSphereAI.sync();
  assert.equal(dom.window.document.querySelector(".ai-root"), null, "no floating icon over the message composer");
});

test("a school's public website never receives the assistant", { skip }, async () => {
  const dom = makeDom("https://edusphere.example/schools/test-school");
  const calls = stubPublic(dom);
  const root = await dom.window.EduSphereAI.mount({ surface: "school", slug: "test-school" });
  assert.equal(root, null);
  assert.equal(calls.length, 0);
});

test("a parent portal user on the dashboard URL still gets nothing without the dashboard surface", { skip }, async () => {
  const dom = makeDom("https://edusphere.example/#/app/dashboard");
  dom.window.API = {
    me: async () => ({ loggedIn: true, role: "parent", user: { id: 3, role: "parent" } }),
    get: async () => ({ surface: "parent", space: { key: "parent", label: "Parent", subtitle: "", greeting: "Hi", suggestions: [], capabilities: [] } }),
    post: async () => ({ reply: "ok" }),
    public: { get: async () => { throw new Error("not public"); } },
  };
  const root = await mount(dom);
  assert.equal(root, null, "the server's non-dashboard surface wins over the URL");
});
