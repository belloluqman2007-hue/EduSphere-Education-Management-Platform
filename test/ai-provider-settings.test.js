"use strict";
/* ============================================================================
   AI PROVIDER SETTINGS — the dashboard configuration layer
   ----------------------------------------------------------------------------
   Proves the properties that make it safe to let a super admin connect a model
   from the browser instead of editing .env on the server:

     • only a super admin can read, save or test the provider;
     • the API key never comes back through any endpoint — not the AI settings
       payload and not the generic platform settings payload;
     • a key saved in the dashboard is used by the PUBLIC assistant on the very
       next message, with no restart (the provider is stubbed at fetch);
     • the environment wins per field, and the database fills the gaps;
     • a blank / sentinel key keeps the stored one;
     • a base URL is validated (SSRF), and a provider failure is reported
       without echoing the secret;
     • switching the model off still leaves a working knowledge-base assistant.
   ========================================================================== */
const test = require("node:test");
const assert = require("node:assert/strict");
const { initEnv, setup, Client, PASSWORD, SA_PASSWORD } = require("./helpers");

initEnv();
// Keep the "test connection" bucket out of the way — production stays at 5/min.
process.env.AI_TEST_RATE_LIMIT = "100";
// No environment override for the database tests (each field is exercised
// explicitly further down).
process.env.AI_API_KEY = "";
process.env.AI_BASE_URL = "";
process.env.AI_MODEL = "";

const config = require("../server/config");
const aiConfig = require("../server/services/ai-config");
const ai = require("../server/services/ai");

const FAKE_BASE = "https://ai.example-provider.test/v1";
const DASHBOARD_KEY = "sk-dashboard-1234567890-abcd";
const TEST_KEY = "sk-test-only-9876543210-wxyz";

let ctx, superAdmin, admin;

/* --------------------------- the provider stub --------------------------- */
/* The server and this test share a process, so replacing global fetch lets the
   provider be faked without touching the HTTP client that talks to the app. */
const REAL_FETCH = globalThis.fetch;
let providerCalls = [];
let providerMode = "ok"; // "ok" | "error"

function installProviderStub() {
  globalThis.fetch = async (url, opts) => {
    const href = String(url && url.href ? url.href : url);
    if (!href.includes("ai.example-provider.test")) return REAL_FETCH(url, opts);
    providerCalls.push({
      url: href,
      authorization: (opts && opts.headers && opts.headers.Authorization) || "",
      body: JSON.parse((opts && opts.body) || "{}"),
    });
    if (providerMode === "error") {
      return new Response(JSON.stringify({ error: { message: "invalid api key provided" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      model: "fake-provider-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const savedSettings = () => superAdmin.req("GET", "/api/platform/ai/settings");

test.before(async () => {
  ctx = await setup();
  await ai.seedKnowledge();
  installProviderStub();
  superAdmin = new Client(ctx.base);
  await superAdmin.login("testadmin", SA_PASSWORD);
  admin = new Client(ctx.base);
  await admin.login("admin-a", PASSWORD);
});

test.after(async () => {
  globalThis.fetch = REAL_FETCH;
  await ctx.close();
});

/* ------------------------------------------------------------------------ */
/* 1. only a super admin                                                    */
/* ------------------------------------------------------------------------ */

test("a non-super-admin gets 403 on all three provider endpoints", async () => {
  const get = await admin.req("GET", "/api/platform/ai/settings");
  assert.equal(get.status, 403, JSON.stringify(get.data));

  const save = await admin.api("PUT", "/api/platform/ai/settings", {
    provider: "custom", base_url: FAKE_BASE, model: "m", api_key: TEST_KEY, enabled: true,
  });
  assert.equal(save.status, 403, JSON.stringify(save.data));

  const probe = await admin.api("POST", "/api/platform/ai/test", {
    provider: "custom", base_url: FAKE_BASE, model: "m", api_key: TEST_KEY,
  });
  assert.equal(probe.status, 403, JSON.stringify(probe.data));

  // The knowledge editor next door enforces the same rule.
  const knowledge = await admin.req("GET", "/api/platform/ai/knowledge");
  assert.equal(knowledge.status, 403);
});

/* ------------------------------------------------------------------------ */
/* 2. saving a key makes the assistant live, with no restart                */
/* ------------------------------------------------------------------------ */

test("the dashboard starts with no model, and the public assistant still answers", async () => {
  const status = await superAdmin.req("GET", "/api/ai/status");
  assert.equal(status.status, 200);
  assert.equal(status.data.live, false);
  assert.equal(status.data.source, "none");

  // Requirement: never fail closed when no model is configured.
  const anon = new Client(ctx.base);
  const chat = await anon.api("POST", "/api/public/ai/chat", { message: "How do I register my school?" });
  assert.equal(chat.status, 200, JSON.stringify(chat.data));
  assert.equal(chat.data.mode, "knowledge-base");
  assert.ok(chat.data.reply.length > 20);
});

test("saving a key flips /api/ai/status to live without a restart", async () => {
  const save = await superAdmin.api("PUT", "/api/platform/ai/settings", {
    provider: "custom",
    base_url: FAKE_BASE,
    model: "gpt-test",
    api_key: DASHBOARD_KEY,
    enabled: true,
  });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  assert.equal(save.data.resolved.enabled, true);
  assert.equal(save.data.resolved.source, "settings");
  assert.equal(save.data.resolved.key_set, true);
  assert.equal(save.data.resolved.key_last4, "abcd");

  // Same process, no restart: the authenticated status endpoint is live now.
  const status = await superAdmin.req("GET", "/api/ai/status");
  assert.equal(status.data.live, true, "the saved key is used immediately");
  assert.equal(status.data.ai_model, "gpt-test");
  assert.equal(status.data.source, "settings");

  // And the key was encrypted at rest.
  const row = await ctx.db.get("SELECT value FROM platform_settings WHERE key_name = 'ai_api_key'");
  assert.ok(row && row.value, "the key was persisted");
  assert.ok(row.value.startsWith("enc:v1:"), "stored AES-256-GCM, not plaintext");
  assert.ok(!row.value.includes(DASHBOARD_KEY), "the ciphertext does not contain the key");
});

test("the public website's assistant uses the saved key on the next message", async () => {
  providerCalls = [];
  const anon = new Client(ctx.base);
  const chat = await anon.api("POST", "/api/public/ai/chat", { message: "What does EduSphere do?" });
  assert.equal(chat.status, 200, JSON.stringify(chat.data));
  assert.equal(chat.data.mode, "ai", "answered by the model, not the knowledge base");
  assert.equal(providerCalls.length, 1, "exactly one provider call");
  assert.equal(providerCalls[0].url.endsWith("/chat/completions"), true);
  assert.equal(providerCalls[0].authorization, `Bearer ${DASHBOARD_KEY}`);
  assert.equal(providerCalls[0].body.model, "gpt-test");
});

/* ------------------------------------------------------------------------ */
/* 3. the key never reaches the browser                                     */
/* ------------------------------------------------------------------------ */

test("the key is never present in either settings response", async () => {
  const aiSettings = await savedSettings();
  assert.equal(aiSettings.status, 200);
  assert.equal(aiSettings.data.resolved.key_set, true);
  assert.equal(aiSettings.data.resolved.key_last4, "abcd");
  assert.ok(!JSON.stringify(aiSettings.data).includes(DASHBOARD_KEY), "AI settings leak the key");
  assert.ok(!("ai_api_key" in aiSettings.data.settings), "the AI payload exposes a raw column");

  // The generic platform settings endpoint used to return every row verbatim.
  const generic = await superAdmin.req("GET", "/api/platform/settings");
  assert.equal(generic.status, 200);
  assert.equal(generic.data.settings.ai_api_key, "••••", "redacted to the sentinel");
  assert.ok(!JSON.stringify(generic.data).includes(DASHBOARD_KEY), "platform settings leak the key");

  // The knowledge editor's status payload does not leak it either.
  const spaces = await superAdmin.req("GET", "/api/platform/ai/spaces");
  assert.ok(!JSON.stringify(spaces.data).includes(DASHBOARD_KEY));
  assert.equal(spaces.data.live, true);
  assert.equal(spaces.data.source, "settings");
});

/* ------------------------------------------------------------------------ */
/* 4. blank / sentinel keys keep the stored key                             */
/* ------------------------------------------------------------------------ */

test("a blank or sentinel key leaves the stored key intact", async () => {
  const sentinel = await superAdmin.api("PUT", "/api/platform/ai/settings", {
    provider: "custom", base_url: FAKE_BASE, model: "gpt-test", api_key: "••••", enabled: true,
  });
  assert.equal(sentinel.status, 200, JSON.stringify(sentinel.data));
  assert.equal(sentinel.data.resolved.key_set, true);
  assert.equal(sentinel.data.resolved.key_last4, "abcd");

  const blank = await superAdmin.api("PUT", "/api/platform/ai/settings", {
    provider: "custom", base_url: FAKE_BASE, model: "gpt-test", api_key: "", enabled: true,
  });
  assert.equal(blank.status, 200, JSON.stringify(blank.data));
  assert.equal(blank.data.resolved.key_set, true, "a blank field never deletes the key");

  const omitted = await superAdmin.api("PUT", "/api/platform/ai/settings", {
    provider: "custom", base_url: FAKE_BASE, model: "gpt-test", enabled: true,
  });
  assert.equal(omitted.status, 200, JSON.stringify(omitted.data));
  assert.equal(omitted.data.resolved.key_last4, "abcd");

  // The generic platform settings PUT treats the sentinel the same way — and
  // refuses to be a back door that writes the key unencrypted.
  const genericSentinel = await superAdmin.api("PUT", "/api/platform/settings", { ai_api_key: "••••" });
  assert.equal(genericSentinel.status, 200, JSON.stringify(genericSentinel.data));
  assert.equal((await savedSettings()).data.resolved.key_set, true);

  const genericRealKey = await superAdmin.api("PUT", "/api/platform/settings", { ai_api_key: "sk-smuggled-in" });
  assert.equal(genericRealKey.status, 400, "must not store a secret outside the encrypted path");
  assert.equal((await savedSettings()).data.resolved.key_set, true);

  // The public assistant still authenticates with the ORIGINAL key.
  providerCalls = [];
  const anon = new Client(ctx.base);
  await anon.api("POST", "/api/public/ai/chat", { message: "Tell me about plans" });
  assert.equal(providerCalls[0].authorization, `Bearer ${DASHBOARD_KEY}`);
});

/* ------------------------------------------------------------------------ */
/* 5. environment overrides, field by field                                 */
/* ------------------------------------------------------------------------ */

test("combine(): the environment wins per field and the database fills the gaps", () => {
  const stored = {
    ai_provider: "openai",
    ai_base_url: "https://stored.example.com/v1",
    ai_model: "stored-model",
    ai_api_key: "sk-stored-key-9999",
    ai_enabled: "1",
  };

  const allEnv = aiConfig.combine(
    { apiKey: "sk-env-key-1111", baseUrl: "https://env.example.com/v1", model: "env-model" },
    stored
  );
  assert.equal(allEnv.apiKey, "sk-env-key-1111");
  assert.equal(allEnv.baseUrl, "https://env.example.com/v1");
  assert.equal(allEnv.model, "env-model");
  assert.equal(allEnv.source, "env");
  assert.deepEqual(allEnv.locked, { apiKey: true, baseUrl: true, model: true });
  assert.equal(allEnv.keyLast4, "1111");

  // Only the model is overridden: the key and base URL still come from SQL.
  const onlyModel = aiConfig.combine({ model: "env-model" }, stored);
  assert.equal(onlyModel.apiKey, "sk-stored-key-9999");
  assert.equal(onlyModel.baseUrl, "https://stored.example.com/v1");
  assert.equal(onlyModel.model, "env-model");
  assert.equal(onlyModel.origins.apiKey, "settings");
  assert.equal(onlyModel.origins.model, "env");
  assert.equal(onlyModel.source, "env");

  // The dashboard toggle is honoured when the environment says nothing…
  const switchedOff = aiConfig.combine({}, Object.assign({}, stored, { ai_enabled: "0" }));
  assert.equal(switchedOff.enabled, false);
  assert.equal(switchedOff.keySet, true);
  // …and the environment's key still wins over it (the deploy-time layer).
  const envOverridesToggle = aiConfig.combine(
    { apiKey: "sk-env-key-1111", baseUrl: "https://env.example.com/v1" },
    Object.assign({}, stored, { ai_enabled: "0" })
  );
  assert.equal(envOverridesToggle.enabled, true);

  // Nothing anywhere → "none", and the assistant stays on the knowledge base.
  const nothing = aiConfig.combine({}, { ai_provider: "none", ai_enabled: "1" });
  assert.equal(nothing.enabled, false);
  assert.equal(nothing.source, "none");
});

test("env overrides are visible through the API and marked as locked", async () => {
  const previous = { apiKey: config.AI.apiKey, baseUrl: config.AI.baseUrl, model: config.AI.model };
  try {
    config.AI.model = "env-locked-model";
    config.AI.apiKey = "sk-env-override-0001";
    aiConfig.invalidate();

    const live = await savedSettings();
    assert.equal(live.data.resolved.model, "env-locked-model", "AI_MODEL wins over the stored model");
    assert.equal(live.data.resolved.key_last4, "0001", "AI_API_KEY wins over the stored key");
    assert.equal(live.data.resolved.base_url, FAKE_BASE, "the stored base URL fills the gap");
    assert.equal(live.data.resolved.source, "env");
    assert.equal(live.data.env.locked.model, true);
    assert.equal(live.data.env.locked.apiKey, true);
    assert.equal(live.data.env.locked.baseUrl, false);
    assert.ok(!JSON.stringify(live.data).includes("sk-env-override-0001"), "the env key is not echoed either");

    // The public assistant now authenticates with the ENV key.
    providerCalls = [];
    const anon = new Client(ctx.base);
    await anon.api("POST", "/api/public/ai/chat", { message: "What is EduSphere?" });
    assert.equal(providerCalls[0].authorization, "Bearer sk-env-override-0001");
  } finally {
    config.AI.model = previous.model;
    config.AI.apiKey = previous.apiKey;
    config.AI.baseUrl = previous.baseUrl;
    aiConfig.invalidate();
  }
});

/* ------------------------------------------------------------------------ */
/* 6. SSRF: the base URL is validated                                       */
/* ------------------------------------------------------------------------ */

test("bad base URLs are rejected with a readable message", async () => {
  const before = await savedSettings();
  for (const [bad, hint] of [
    ["http://localhost:3000/v1", /localhost/i],
    ["http://127.0.0.1:8080/v1", /loopback|127/i],
    ["http://169.254.169.254/latest/meta-data", /metadata|link-local|169\.254/i],
    ["http://192.168.1.10/v1", /private/i],
    ["http://10.0.0.5/v1", /private/i],
    ["file:///etc/passwd", /http/i],
    ["not a url", /valid URL/i],
  ]) {
    const res = await superAdmin.api("PUT", "/api/platform/ai/settings", {
      provider: "custom", base_url: bad, model: "gpt-test", enabled: true,
    });
    assert.equal(res.status, 400, `${bad} should be refused: ${JSON.stringify(res.data)}`);
    assert.match(String(res.data.error), hint);
  }
  // Nothing changed.
  const after = await savedSettings();
  assert.equal(after.data.resolved.base_url, before.data.resolved.base_url);
  assert.equal(after.data.resolved.key_set, true);

  // Production requires https even when the host is public.
  const prodHttp = aiConfig.validateBaseUrl("http://api.example.com/v1", { production: true });
  assert.equal(prodHttp.ok, false);
  assert.match(prodHttp.error, /https/i);
  const prodHttps = aiConfig.validateBaseUrl("https://api.example.com/v1/", { production: true });
  assert.equal(prodHttps.ok, true);
  assert.equal(prodHttps.value, "https://api.example.com/v1", "trailing slashes are stripped");
});

/* ------------------------------------------------------------------------ */
/* 7. test connection                                                       */
/* ------------------------------------------------------------------------ */

test("test connection reports success with latency, and provider failure without the secret", async () => {
  providerCalls = [];
  const good = await superAdmin.api("POST", "/api/platform/ai/test", {
    provider: "custom", base_url: FAKE_BASE, model: "gpt-test", api_key: TEST_KEY,
  });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.equal(good.data.ok, true);
  assert.equal(good.data.model, "fake-provider-model");
  assert.equal(typeof good.data.latencyMs, "number");
  assert.ok(good.data.latencyMs >= 0);
  assert.equal(providerCalls[0].authorization, `Bearer ${TEST_KEY}`, "uses the submitted key, not the saved one");

  providerMode = "error";
  try {
    const bad = await superAdmin.api("POST", "/api/platform/ai/test", {
      provider: "custom", base_url: FAKE_BASE, model: "gpt-test", api_key: TEST_KEY,
    });
    assert.equal(bad.status, 200, JSON.stringify(bad.data));
    assert.equal(bad.data.ok, false);
    assert.match(String(bad.data.error), /invalid api key/i, "the provider's own message is surfaced");
    assert.ok(!JSON.stringify(bad.data).includes(TEST_KEY), "the key must not be echoed");
    assert.ok(!JSON.stringify(bad.data).includes(DASHBOARD_KEY));
  } finally {
    providerMode = "ok";
  }

  // An SSRF-shaped URL is refused before any fetch happens.
  providerCalls = [];
  const ssrf = await superAdmin.api("POST", "/api/platform/ai/test", {
    provider: "custom", base_url: "http://169.254.169.254/latest", model: "gpt-test", api_key: TEST_KEY,
  });
  assert.equal(ssrf.status, 400);
  assert.equal(providerCalls.length, 0, "nothing was fetched");
});

/* ------------------------------------------------------------------------ */
/* 8. switching off still leaves a real assistant                           */
/* ------------------------------------------------------------------------ */

test("switching the model off returns to the knowledge base, not a dead end", async () => {
  const off = await superAdmin.api("PUT", "/api/platform/ai/settings", {
    provider: "custom", base_url: FAKE_BASE, model: "gpt-test", enabled: false,
  });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.resolved.enabled, false);
  assert.equal(off.data.settings.enabled, false);
  assert.equal(off.data.resolved.key_set, true, "the key is kept, just not used");

  const status = await superAdmin.req("GET", "/api/ai/status");
  assert.equal(status.data.live, false);

  providerCalls = [];
  const anon = new Client(ctx.base);
  const chat = await anon.api("POST", "/api/public/ai/chat", { message: "How do I register my school?" });
  assert.equal(chat.status, 200, JSON.stringify(chat.data));
  assert.notEqual(chat.data.mode, "ai");
  assert.equal(providerCalls.length, 0, "no provider call while switched off");
  assert.ok(chat.data.reply.length > 20);
});

test("presets carry the documented base URL and default model", () => {
  assert.equal(aiConfig.PRESETS.openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(aiConfig.PRESETS.openai.model, "gpt-4o-mini");
  assert.equal(aiConfig.PRESETS.groq.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(aiConfig.PRESETS.groq.model, "llama-3.3-70b-versatile");
  assert.equal(aiConfig.PRESETS.openrouter.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(aiConfig.PRESETS.openrouter.model, "openai/gpt-4o-mini");
  assert.equal(aiConfig.PRESETS.custom.baseUrl, "");
  assert.equal(aiConfig.PRESETS.custom.model, "");
});

test("the cipher round-trips and plaintext rows keep working", () => {
  const sealed = aiConfig.encryptSecret("sk-round-trip-123456");
  assert.ok(sealed.startsWith("enc:v1:"));
  assert.ok(!sealed.includes("sk-round-trip"));
  assert.equal(aiConfig.decryptSecret(sealed), "sk-round-trip-123456");
  // A row written before encryption existed (or with no SESSION_SECRET) is read as-is.
  assert.equal(aiConfig.decryptSecret("sk-legacy-plaintext"), "sk-legacy-plaintext");
  assert.equal(aiConfig.decryptSecret("enc:v1:not:valid:data"), "");
});

test("choosing provider \"none\" switches the model off but keeps the key", async () => {
  const res = await superAdmin.api("PUT", "/api/platform/ai/settings", { provider: "none", enabled: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.settings.provider, "none");
  assert.equal(res.data.resolved.enabled, false, "\"none\" never reads as live");
  assert.equal(res.data.resolved.key_set, true, "the key is kept so switching back is one click");

  const status = await superAdmin.req("GET", "/api/ai/status");
  assert.equal(status.data.live, false);
  assert.equal(status.data.source, "settings");
});

/* ------------------------------------------------------------------------ */
/* 9. the card itself, in a real DOM                                        */
/* ------------------------------------------------------------------------ */
/* The API tests prove the server; this proves the browser actually presents
   the provider card, fills the presets, keeps the key out of the form and
   wires the two buttons to the right endpoints. */

let JSDOM;
try { ({ JSDOM } = require("jsdom")); } catch (e) { /* production install */ }
const UI_SKIP = !JSDOM ? "jsdom devDependency not installed" : false;
const AI_SOURCE = require("node:fs").readFileSync(
  require("node:path").join(__dirname, "..", "public", "js", "edusphere-ai.js"), "utf8"
);

function makeAiDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"content\"></div></body></html>", {
    url: "https://edusphere.example/admin",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.eval(AI_SOURCE);
  return dom;
}

function settingsPayload(overrides = {}) {
  return Object.assign({
    settings: { provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", enabled: true },
    resolved: {
      enabled: true, provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini",
      source: "settings", key_set: true, key_last4: "1234",
      origins: { apiKey: "settings", baseUrl: "settings", model: "settings" },
    },
    env: { api_key_set: false, base_url_set: false, model_set: false, locked: { apiKey: false, baseUrl: false, model: false } },
    presets: aiConfig.PRESETS,
    mask: "••••",
    whatsapp: { available: true, number: "2348012345678", display: "+2348012345678", api_enabled: false },
  }, overrides);
}

test("the provider card renders the form, the status strip and the key placeholder", { skip: UI_SKIP }, async () => {
  const dom = makeAiDom();
  const doc = dom.window.document;
  const calls = [];
  dom.window.API = {
    get: async (p) => {
      calls.push({ method: "GET", path: p });
      if (p === "/platform/ai/spaces") {
        return { spaces: [], everywhere: {}, live: true, source: "settings", model: "gpt-4o-mini", whatsapp: { available: true, display: "+2348012345678" } };
      }
      if (p === "/platform/ai/knowledge") return { entries: [], live: true, model: "gpt-4o-mini" };
      if (p === "/platform/ai/settings") return settingsPayload();
      throw new Error("unexpected " + p);
    },
    put: async () => ({}),
    post: async () => ({}),
  };
  const content = doc.getElementById("content");
  const ctx = {
    I: new Proxy({}, { get: () => "" }),
    esc: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    toast: () => {},
    openModal: () => { throw new Error("not used"); },
    closeModal: () => {},
    bindRouteButtons: () => {},
  };

  await dom.window.EduSphereAI.render(ctx, content, "platform/ai");

  assert.ok(calls.some((c) => c.path === "/platform/ai/settings"), "the card asks for the provider settings");

  const form = content.querySelector("#aiProviderForm");
  assert.ok(form, "the provider card exists");
  const select = form.querySelector("select[name=provider]");
  const providers = Array.from(select.options).map((o) => o.value);
  for (const p of ["openai", "groq", "openrouter", "custom"]) assert.ok(providers.includes(p), `${p} is offered`);

  const status = content.querySelector("#aiProviderStatus").textContent;
  assert.match(status, /Live/);
  assert.match(status, /gpt-4o-mini/);
  assert.match(status, /from dashboard/);

  // The key is never in the DOM; only its last four characters as a placeholder.
  const keyInput = form.querySelector("input[name=api_key]");
  assert.equal(keyInput.value, "", "the input starts empty");
  assert.equal(keyInput.getAttribute("type"), "password");
  assert.equal(keyInput.getAttribute("placeholder"), "••••1234");

  // The WhatsApp hand-off is discoverable from the same card.
  const link = Array.from(content.querySelectorAll("a")).find((a) => /WhatsApp line/.test(a.textContent));
  assert.ok(link, "the WhatsApp settings link exists");
  assert.equal(link.getAttribute("href"), "#/app/" + encodeURIComponent("platform/settings"));

  // Choosing a preset fills base URL + model, and both stay editable.
  select.value = "groq";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(form.querySelector("input[name=base_url]").value, "https://api.groq.com/openai/v1");
  assert.equal(form.querySelector("input[name=model]").value, "llama-3.3-70b-versatile");
  assert.equal(form.querySelector("input[name=model]").disabled, false);

  // "None" means knowledge-base only: the toggle unticks itself.
  const toggle = form.querySelector("input[name=enabled]");
  assert.equal(toggle.checked, true);
  select.value = "none";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(toggle.checked, false);
  assert.equal(form.querySelector("input[name=base_url]").value, "");

  // Back to Groq for the connection test.
  select.value = "groq";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  toggle.checked = true;

  // Test connection renders the latency inline.
  let tested = null;
  dom.window.API.post = async (p, body) => {
    tested = { path: p, body };
    return { ok: true, latencyMs: 42, model: "llama-3.3-70b-versatile", error: null };
  };
  content.querySelector("#aiProviderTest").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(tested.path, "/platform/ai/test");
  assert.equal(tested.body.base_url, "https://api.groq.com/openai/v1");
  assert.match(content.querySelector("#aiTestResult").textContent, /Connected · llama-3\.3-70b-versatile · 42 ms/);
});

test("saving without typing a key omits it (so the stored key survives)", { skip: UI_SKIP }, async () => {
  const dom = makeAiDom();
  const doc = dom.window.document;
  let saved = null;
  dom.window.API = {
    get: async (p) => {
      if (p === "/platform/ai/spaces") return { spaces: [], everywhere: {}, live: true, model: "gpt-4o-mini", whatsapp: {} };
      if (p === "/platform/ai/knowledge") return { entries: [], live: true };
      if (p === "/platform/ai/settings") return settingsPayload();
      throw new Error("unexpected " + p);
    },
    put: async (p, body) => { saved = { path: p, body }; return settingsPayload(); },
    post: async () => ({}),
  };
  const content = doc.getElementById("content");
  const ctx = {
    I: new Proxy({}, { get: () => "" }),
    esc: (v) => String(v == null ? "" : v),
    toast: () => {},
    openModal: () => {},
    closeModal: () => {},
    bindRouteButtons: () => {},
  };
  await dom.window.EduSphereAI.render(ctx, content, "platform/ai");

  const form = content.querySelector("#aiProviderForm");
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(saved, "the form submitted");
  assert.equal(saved.path, "/platform/ai/settings");
  assert.equal("api_key" in saved.body, false, "a blank key field is omitted, never sent as empty");
  assert.equal(saved.body.provider, "openai");
  assert.equal(saved.body.base_url, "https://api.openai.com/v1");
  assert.equal(saved.body.enabled, true);

  // Typing a key DOES send it, so a replacement works.
  form.querySelector("input[name=api_key]").value = "sk-new-key-000111222";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(saved.body.api_key, "sk-new-key-000111222");
});
