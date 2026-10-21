#!/usr/bin/env node
"use strict";
/* ============================================================================
   REPRO — "Test connection is green, but the assistant never uses the model"
   ----------------------------------------------------------------------------
   A self-contained, offline reproduction of the fallback bug, kept so the
   behaviour can be re-checked without a provider account or a database.

   It starts a local OpenAI-compatible endpoint that behaves like a free-tier
   provider (documented Groq limits) and drives the REAL client code:

     • an 8-token ping with no system prompt, knowledge, history or tools —
       exactly what "Test connection" used to send → 200, always;
     • the REALISTIC public turn — system prompt (~2.3 KB), knowledge block,
       the three public tool schemas, max_tokens 700 → 429 once the minute's
       token budget is spent, or 400 when the model refuses tools.

   The last line of each block is the provider's verbatim HTTP status and
   message. That is the line that decides which suspect it is.

   Usage:  node scripts/ai-fallback-repro.js
   Notes:  no network egress and no credentials are needed; nothing is written.
   ========================================================================== */
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ai = require(path.join(ROOT, "server", "services", "ai"));
const spaces = require(path.join(ROOT, "server", "services", "ai-spaces"));
const knowledge = require(path.join(ROOT, "server", "services", "ai-knowledge"));

const KEY = "sk-repro-not-a-real-key-0000";
const MODEL = "openai/gpt-oss-120b";
/* Groq's free tier for this model: 8,000 tokens per minute (prompt + the
   requested completion). A minute is a long time in a chat window. */
const TPM_LIMIT = 8000;

let usedThisMinute = 0;
let windowStarted = Date.now();

function estimateTokens(body) {
  const prompt = JSON.stringify(body.messages || []).length;
  const tools = JSON.stringify(body.tools || []).length;
  return Math.ceil((prompt + tools) / 4) + Number(body.max_tokens || 0);
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch (e) { return send(400, { error: { message: "bad json" } }); }

    if (Date.now() - windowStarted > 60_000) { usedThisMinute = 0; windowStarted = Date.now(); }

    // Model 2: an id whose account/plan refuses tool calling outright.
    if (body.model === "llama-3.3-70b-versatile" && Array.isArray(body.tools) && body.tools.length) {
      return send(400, {
        error: {
          message: "tools is not supported by this model: llama-3.3-70b-versatile",
          type: "invalid_request_error",
        },
      });
    }

    const wanted = estimateTokens(body);
    if (usedThisMinute + wanted > TPM_LIMIT) {
      return send(429, {
        error: {
          message: `Rate limit reached for ${body.model} on tokens per minute (TPM): Limit ${TPM_LIMIT}, ` +
            `Used ${usedThisMinute}, Requested ${wanted}. Please try again in 6.2s.`,
          type: "tokens",
        },
      });
    }
    usedThisMinute += wanted;
    send(200, {
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: wanted, completion_tokens: 1 },
    });
  });
});

/* The public turn's knowledge block, straight from the curated seed. */
function publicHits(count) {
  return knowledge.SEED_KNOWLEDGE.filter((k) => ["public", "all"].includes(k.scope)).slice(0, count);
}
const PUBLIC_QUESTION = "How do I register my school, and how much does the Basic plan cost?";
const HISTORY = [
  { role: "user", content: "Hello, I run a small Islamic school in Ijebu-Ode." },
  { role: "assistant", content: "Welcome. I can explain registration, the plans and the prices. What would you like to know?" },
  { role: "user", content: PUBLIC_QUESTION },
];

const fail = (e) => ({ status: Number(e && e.providerStatus) || null, message: String((e && e.message) || e) });

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  console.log(`mock provider on ${baseUrl} (TPM ${TPM_LIMIT})\n`);

  // ---- 1. the OLD test: 8 tokens, no context, no tools --------------------
  const ping = await ai.chatCompletion(
    { messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 8, temperature: 0 },
    { config: { enabled: true, apiKey: KEY, baseUrl, model: MODEL } }
  );
  console.log("1) OLD \"Test connection\" (8-token ping, no tools, no system prompt)");
  console.log(`   -> HTTP 200, model ${ping.model}. GREEN — this is the false positive.\n`);

  // ---- 2. the REAL turn, three times inside one minute --------------------
  console.log("2) REALISTIC public turns, back to back (a chat window does this)");
  const cfg = { enabled: true, apiKey: KEY, baseUrl, model: MODEL };
  const captured = [];
  for (let i = 1; i <= 8; i++) {
    const out = await ai.probe({
      surface: "public",
      tools: publicToolsForProbe(),
      hits: publicHits(3),
      history: HISTORY,
      context: { today: new Date().toISOString().slice(0, 10) },
      config: cfg,
      record: false,
    });
    console.log(`   turn ${i}: HTTP ${out.httpStatus} · ${out.error ? out.error : "ok"} ` +
      `· sent ${out.request.bytes} bytes (~${out.request.approx_prompt_tokens} prompt tokens + ${out.request.max_tokens} max)`);
    if (out.error) { captured.push(out.error); break; }
  }
  console.log("   ^ the first turn fits; the Nth inside the same minute is refused. That is the 8K TPM");
  console.log("     ceiling, and the pre-fix code answered it with an ordinary knowledge-base reply.\n");

  // ---- 3. a model that refuses tools --------------------------------------
  usedThisMinute = 0;
  windowStarted = Date.now();
  console.log("3) A model that refuses `tools` (400 on every real turn)");
  const toolsModel = await ai.probe({
    surface: "public",
    tools: publicToolsForProbe(),
    hits: publicHits(3),
    history: HISTORY,
    context: { today: new Date().toISOString().slice(0, 10) },
    config: { enabled: true, apiKey: KEY, baseUrl, model: "llama-3.3-70b-versatile" },
    record: false,
  });
  console.log(`   -> HTTP ${toolsModel.httpStatus} · ${toolsModel.error}`);
  console.log("   The 8-token ping never sent tools, so it stayed green.\n");
  if (toolsModel.error) captured.push(toolsModel.error);

  console.log("Captured provider lines (for the PR description):");
  for (const line of captured) console.log(`   ${line}`);
  // Keep-alive sockets from fetch would otherwise hold the process open.
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
}

/* The service does not own tool definitions (routes do). For the probe we only
   need the three public schemas, so they are described here exactly as the
   route sends them. */
function publicToolsForProbe() {
  return [
    { name: "list_plans", description: "List the EduSphere subscription plans (Free / Basic / Premium) with their Naira prices, student/teacher limits and what each tier INCLUDES. Use this whenever someone asks about pricing, plans, what a tier offers, or which plan fits them.", parameters: { type: "object", properties: {} }, run: async () => ({}) },
    { name: "get_contact_details", description: "Get EduSphere's public contact details (email, phone, WhatsApp link) and the registration and sign-in URLs.", parameters: { type: "object", properties: {} }, run: async () => ({}) },
    {
      name: "register_interest",
      description: "Record that a visitor wants a demo or wants to register their institution. Ask for the institution name and a contact detail first.",
      parameters: { type: "object", properties: { institution_name: { type: "string" }, contact: { type: "string" }, note: { type: "string" } }, required: ["institution_name"] },
      run: async () => ({}),
    },
  ];
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
