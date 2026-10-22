"use strict";
/* ============================================================================
   EDUSPHERE AI — the widget in a real DOM
   ----------------------------------------------------------------------------
   The server tests prove the spaces are separated. This proves the browser
   actually PRESENTS the right one:

     • a visitor gets the public assistant, the registration shortcuts and a
       real "Chat on WhatsApp" link (a wa.me URL, opening in a new tab);
     • a student gets the student greeting and NONE of the administrator
       furniture — no WhatsApp hand-off, no registration buttons, no copilot;
     • sending a message goes to the right endpoint and the reply is rendered.

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

const PUBLIC_SPACE = {
  key: "public",
  label: "EduSphere AI",
  subtitle: "Registration, plans & getting started",
  greeting: "Hello! I'm EduSphere AI. I can walk you through registering your school.",
  suggestions: ["How do I register my school?", "How much does EduSphere cost?", "What does EduSphere do?", "What happens after I apply?"],
  capabilities: ["How to register an Islamic school or Western academy", "Plans, prices and what each tier includes", "The portals"],
  handoff: { kind: "whatsapp", label: "Chat on WhatsApp" },
};

const STUDENT_SPACE = {
  key: "student",
  label: "EduSphere AI · Student",
  subtitle: "Your results, attendance, fees and timetable",
  greeting: "Hi! I'm EduSphere AI in your student portal. What do you need?",
  suggestions: ["What were my last results?", "What is my attendance?", "How much school fees do I still owe?", "What is my timetable today?"],
  capabilities: ["Your published results and report cards", "Your attendance record", "Your fee statement and balance"],
  handoff: { kind: "school_office", label: "Message your school" },
};

const WA = {
  available: true,
  number: "2348012345678",
  display: "+2348012345678",
  link: "https://wa.me/2348012345678?text=Hello%20EduSphere",
  message: "Hello EduSphere",
  api_enabled: true,
};

function makeDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://edusphere.example/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.eval(SOURCE);
  return dom;
}

function stubPublic(dom, { infoReply } = {}) {
  const calls = [];
  dom.window.API = {
    me: async () => ({ loggedIn: false }),
    get: async () => { throw new Error("no session"); },
    post: async () => { throw new Error("no session"); },
    public: {
      get: async (p) => {
        calls.push({ method: "GET", path: p });
        if (p === "/ai/info") {
          return Object.assign({
            surface: "public",
            space: PUBLIC_SPACE,
            welcome: { greeting: PUBLIC_SPACE.greeting, suggestions: PUBLIC_SPACE.suggestions },
            live: false,
            whatsapp: WA,
            links: { register_islamic_school: "/register-madrasa", register_western_academy: "/register-academy" },
          }, infoReply || {});
        }
        throw new Error("unexpected " + p);
      },
      post: async (p, body) => {
        calls.push({ method: "POST", path: p, body });
        return { reply: "Open /register-madrasa to begin.", sources: ["How do I register my school?"], mode: "knowledge-base" };
      },
    },
  };
  return calls;
}

function stubStudent(dom) {
  const calls = [];
  dom.window.API = {
    me: async () => ({ loggedIn: true, role: "student", user: { id: 7, role: "student", fullName: "Alpha One" } }),
    get: async (p) => {
      calls.push({ method: "GET", path: p });
      if (p === "/ai/status") {
        return {
          surface: "student",
          role: "student",
          space: STUDENT_SPACE,
          welcome: { greeting: STUDENT_SPACE.greeting, suggestions: STUDENT_SPACE.suggestions },
          live: false,
          whatsapp: WA,
          institution: "Test School",
        };
      }
      if (p === "/ai/copilot") return { capabilities: [] };
      throw new Error("unexpected " + p);
    },
    post: async (p, body) => {
      calls.push({ method: "POST", path: p, body });
      return { reply: "Your last published average was 72%.", sources: [], mode: "knowledge-base" };
    },
    public: { get: async () => { throw new Error("should not call the public API when signed in"); } },
  };
  return calls;
}

async function mount(dom) {
  await dom.window.EduSphereAI.mount();
  return dom.window.document.querySelector(".ai-root");
}

test("a visitor gets the public assistant with a real WhatsApp link", { skip }, async () => {
  const dom = makeDom();
  const calls = stubPublic(dom);
  const root = await mount(dom);
  assert.ok(root, "the widget mounted");

  assert.ok(calls.some((c) => c.path === "/ai/info"), "the server's public space was requested");
  assert.equal(root.querySelector(".ai-panel-title").textContent, PUBLIC_SPACE.label);
  assert.equal(root.querySelector(".ai-panel-sub").textContent, PUBLIC_SPACE.subtitle);
  assert.match(root.querySelector(".ai-msg-bot").textContent, /Hello! I'm EduSphere AI/);

  // The direct WhatsApp entry point: a real wa.me URL, in a new tab.
  const launcher = root.querySelector(".ai-wa-launcher");
  assert.ok(launcher, "the floating WhatsApp button exists");
  assert.equal(launcher.getAttribute("href"), WA.link);
  assert.equal(launcher.getAttribute("target"), "_blank");
  assert.match(launcher.getAttribute("rel"), /noopener/);

  // And the same hand-off inside the panel.
  const cta = root.querySelector(".ai-wa-cta");
  assert.ok(cta, "the panel offers Chat on WhatsApp");
  assert.equal(cta.getAttribute("href"), WA.link);
  assert.match(cta.textContent, /Chat on WhatsApp/);

  // Registration shortcuts, because this is the registration space.
  const links = Array.from(root.querySelectorAll(".ai-action-links a")).map((a) => a.getAttribute("href"));
  assert.deepEqual(links, ["/register-madrasa", "/register-academy"]);

  // No copilot on the public site.
  assert.equal(root.querySelector(".ai-copilot").hidden, true);

  // Opening the panel works and the suggestions are the public ones.
  root.querySelector(".ai-launcher").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.equal(root.querySelector(".ai-panel").hidden, false);
  const chips = Array.from(root.querySelectorAll(".ai-suggestions .ai-chip")).map((c) => c.textContent);
  // Three suggestions at most: a menu, not a wall. And opening the icon is a
  // full-screen chat with a minimize control back to the launcher.
  assert.deepEqual(chips, PUBLIC_SPACE.suggestions.slice(0, 3));
  assert.ok(root.classList.contains("ai-root--fullscreen"), "the icon opens a full-screen chat");
  assert.ok(root.querySelector(".ai-panel-minimize"), "the full-screen chat can be minimized");
  root.querySelector(".ai-panel-minimize").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.ok(!root.classList.contains("ai-root--fullscreen"), "minimize returns to the floating launcher");
});

test("a visitor's message reaches the public endpoint and the reply is shown", { skip }, async () => {
  const dom = makeDom();
  const calls = stubPublic(dom);
  const root = await mount(dom);
  const form = root.querySelector(".ai-form");
  root.querySelector(".ai-input").value = "How do I register my school?";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 40));

  const sent = calls.find((c) => c.method === "POST");
  assert.ok(sent, "a message was sent");
  assert.equal(sent.path, "/ai/chat", "the public endpoint, not the signed-in one");
  assert.equal(sent.body.message, "How do I register my school?");
  assert.ok(sent.body.session_id, "the anonymous session id travels with the message");

  const bubbles = Array.from(root.querySelectorAll(".ai-msg")).map((b) => b.textContent);
  assert.ok(bubbles.some((t) => t.includes("How do I register my school?")), "the question is echoed");
  assert.ok(bubbles.some((t) => t.includes("Open /register-madrasa to begin.")), "the answer is rendered");
});

test("without a configured number the WhatsApp buttons are not rendered at all", { skip }, async () => {
  const dom = makeDom();
  stubPublic(dom, { infoReply: { whatsapp: { available: false, number: "", link: "", message: "" } } });
  const root = await mount(dom);
  assert.equal(root.querySelector(".ai-wa-launcher"), null, "no dead WhatsApp button");
  assert.equal(root.querySelector(".ai-wa-cta"), null);
  assert.ok(root.querySelector(".ai-action-links"), "registration shortcuts still work");
});

test("a student gets the student space, and none of the admin furniture", { skip }, async () => {
  const dom = makeDom();
  const calls = stubStudent(dom);
  const root = await mount(dom);

  assert.ok(calls.some((c) => c.path === "/ai/status"), "the server decided the space");
  assert.equal(root.querySelector(".ai-panel-title").textContent, STUDENT_SPACE.label);
  assert.equal(root.querySelector(".ai-panel-sub").textContent, STUDENT_SPACE.subtitle);
  assert.match(root.querySelector(".ai-msg-bot").textContent, /student portal/i);

  assert.equal(root.querySelector(".ai-wa-launcher"), null, "a signed-in student gets no public WhatsApp CTA");
  assert.equal(root.querySelector(".ai-wa-cta"), null);
  assert.equal(root.querySelector(".ai-action-links"), null, "no registration buttons inside a portal");
  assert.equal(root.querySelector(".ai-copilot").hidden, true, "no school-wide copilot for a student");

  const chips = Array.from(root.querySelectorAll(".ai-suggestions .ai-chip")).map((c) => c.textContent);
  assert.deepEqual(chips, STUDENT_SPACE.suggestions.slice(0, 3));
  assert.ok(chips.some((c) => /results/i.test(c)), "the student's own questions");
  assert.ok(!chips.some((c) => /upgrade|invoice|limit/i.test(c)), "never the administrator's questions");
});

test("a student's message goes to the signed-in endpoint, not the public one", { skip }, async () => {
  const dom = makeDom();
  const calls = stubStudent(dom);
  const root = await mount(dom);
  root.querySelector(".ai-input").value = "What were my last results?";
  root.querySelector(".ai-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 40));

  const sent = calls.find((c) => c.method === "POST");
  assert.ok(sent);
  assert.equal(sent.path, "/ai/chat");
  assert.equal(sent.body.message, "What were my last results?");
  assert.equal(sent.body.session_id, undefined, "the public session id is not sent on a signed-in call");
  const bubbles = Array.from(root.querySelectorAll(".ai-msg")).map((b) => b.textContent);
  assert.ok(bubbles.some((t) => t.includes("72%")), "the answer is rendered");
});

test("the server's space wins over the client's guess", { skip }, async () => {
  const dom = makeDom();
  // The browser asks to be treated as an admin; the server says it is a parent.
  dom.window.API = {
    me: async () => ({ loggedIn: true, role: "parent", user: { id: 3, role: "parent" } }),
    get: async () => ({
      surface: "parent",
      space: {
        key: "parent",
        label: "EduSphere AI · Parent",
        subtitle: "Your children's progress, fees and meetings",
        greeting: "Hello! I'm EduSphere AI in the parent portal.",
        suggestions: ["How are my children doing?", "What is my child's attendance?", "How much school fees do I owe?", "How do I book a parent-teacher meeting?"],
        capabilities: [],
        handoff: { kind: "school_office" },
      },
      whatsapp: WA,
    }),
    post: async () => ({ reply: "ok" }),
    public: { get: async () => { throw new Error("not public"); } },
  };
  const root = await mount(dom);
  assert.equal(root.querySelector(".ai-panel-title").textContent, "EduSphere AI · Parent");
  assert.match(root.querySelector(".ai-msg-bot").textContent, /parent portal/i);
});
