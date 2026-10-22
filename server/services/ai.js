"use strict";
/* ============================================================================
   EDUSPHERE AI — assistant service
   ----------------------------------------------------------------------------
   One assistant, SEVEN spaces (see `ai-spaces.js`):

     public       the marketing website — registration, plans, guides
     super_admin  the platform console — every institution, one view
     admin        a school administrator's dashboard
     teacher      the teacher workspace
     student      the student portal
     parent       the parent portal
     whatsapp     the WhatsApp line (short answers, human hand-off)

   Design rules that are load-bearing, not stylistic:

   1. SCOPED. Retrieval reads only the knowledge scopes the space owns. A
      student can never be answered with the administrator's subscription
      instructions, and the public site can never read console content. The
      route decides the space from the AUTHENTICATED ROLE — never the browser.

   2. GROUNDED. The model is given the retrieved slice of the curated
      `ai_knowledge` table and is instructed to answer only from it plus live
      tool results. Free invention about pricing is the one failure mode that
      costs real money.

   3. USEFUL WITHOUT A MODEL. With no AI_API_KEY every space still answers:
      first from a confident knowledge match, otherwise with a real menu of the
      questions that space can answer plus its hand-off. There is no
      "assistant not switched on" dead end.

   4. TOOLS ARE SERVER-SIDE AND SCOPED. A tool never receives a tenant id from
      the model; the route closes over the session. There is no `change_plan`,
      `approve_payment` or `delete` tool anywhere.

   5. CHEAP BY DEFAULT. Small context window, low temperature, capped tokens,
      and a per-surface rate limit in the route.
   ========================================================================== */
const db = require("../db");
const aiConfig = require("./ai-config");
const spaces = require("./ai-spaces");
const knowledge = require("./ai-knowledge");
const { cleanStr } = require("../util");

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);
const MAX_TOOL_ROUNDS = 4;
/* A match must clear this before it is allowed to be the whole answer. Below
   it we prefer an honest menu to a confident wrong paragraph. */
const CONFIDENT_SCORE = 3;

/* --------------------------- context budgets ------------------------------ */

/* How much conversation and how many knowledge entries a turn may send.
   The public website is the surface an anonymous visitor drives, and the one
   that hit provider token ceilings first: a stranger gets a short memory and a
   narrow slice of the knowledge base, while a signed-in workspace keeps the
   full 12-message thread. Counted in MESSAGES (the unit `messages.slice(-12)`
   always used), not question/answer pairs. */
const TURN_LIMITS = {
  public: { history: 4, knowledge: 3 },
  // A school's own assistant: a visitor asks two or three questions about the
  // school, so a slightly longer memory than the marketing page and the same
  // narrow knowledge slice (this space's only scope is "all").
  school: { history: 6, knowledge: 3 },
  whatsapp: { history: 12, knowledge: 5 },
};
const DEFAULT_TURN_LIMITS = { history: 12, knowledge: 5 };
function turnLimits(surface) {
  return TURN_LIMITS[surface] || DEFAULT_TURN_LIMITS;
}
/* The single retry after a 413/429 sends this little: two messages of history
   and a knowledge block small enough that a free-tier per-minute ceiling is
   usually cleared. */
const RETRY_HISTORY = 2;
function retryKnowledgeLimit(surface, current) {
  // The public turn already sends three entries; the retry must be smaller
  // than the first attempt or it is not a cheaper request at all.
  return surface === "public" ? Math.min(current, 2) : Math.min(current, 3);
}

/* ------------------------------ knowledge -------------------------------- */

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "did", "how", "what", "why", "when",
  "can", "i", "my", "me", "we", "our", "you", "your", "it", "to", "of", "in", "on", "for", "and",
  "or", "with", "this", "that", "please", "help", "need", "want", "get", "have", "has", "any",
  "there", "about", "from", "will", "would", "should", "could", "am", "be", "been", "just",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Keyword-overlap retrieval. Cheap, dependency-free, and good enough for a
    knowledge base measured in hundreds — not millions — of entries.

    The weights matter: a word in the QUESTION is worth far more than the same
    word buried in a long answer, so "how do I register my school?" lands on
    the registration entry rather than on an entry that happens to mention
    "school" six times. */
function scoreEntry(entry, words) {
  if (!words.length) return 0;
  const q = String(entry.question || "").toLowerCase();
  const kw = String(entry.keywords || "").toLowerCase();
  const topic = String(entry.topic || "").toLowerCase();
  const ans = String(entry.answer || "").toLowerCase();
  let score = 0;
  let matched = 0;
  for (const w of words) {
    let hit = 0;
    if (q.includes(w)) hit += 6;
    if (kw.includes(w)) hit += 4;
    if (topic.includes(w)) hit += 3;
    if (ans.includes(w)) hit += 1;
    if (hit) matched += 1;
    score += hit;
  }
  if (!matched) return 0;
  // Adjacent-word phrases in the question are a strong signal.
  for (let i = 0; i < words.length - 1; i++) {
    if (q.includes(`${words[i]} ${words[i + 1]}`)) score += 5;
  }
  return score / Math.sqrt(words.length);
}

/** Retrieval with space priority: an answer written for THIS space beats an
    equally relevant answer inherited from a broader one. */
async function retrieve(surface, query, limit = 5) {
  const scopes = spaces.scopesFor(surface);
  let rows = [];
  try {
    rows = await db.all(
      `SELECT scope, topic, question, answer, keywords FROM ai_knowledge
        WHERE is_active = 1 AND scope IN (${scopes.map(() => "?").join(",")})
        ORDER BY sort_order, id LIMIT 800`,
      scopes
    );
  } catch (e) {
    return []; // table missing (pre-migration): answer from tools only
  }
  if (!rows.length) return [];
  const words = tokenize(query);
  if (!words.length) return [];
  const weightFor = (scope) => {
    const idx = scopes.indexOf(scope);
    if (idx <= 0) return 1.35;
    return Math.max(1, 1.35 - idx * 0.08);
  };
  return rows
    .map((r) => ({ entry: r, score: scoreEntry(r, words) * weightFor(r.scope) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.entry);
}

/** Rule-based fallback answer for a CONFIDENT match, used when no model is
    configured or the provider is down. Returns null when the match is weak —
    an honest menu beats a confident wrong answer. */
function fallbackAnswer(surface, query, hits) {
  if (!hits || !hits.length) return null;
  const words = tokenize(query);
  const scored = hits.map((h) => ({ entry: h, score: scoreEntry(h, words) }));
  const top = scored.sort((a, b) => b.score - a.score)[0];
  if (!top || top.score < CONFIDENT_SCORE) return null;
  return {
    content: top.entry.answer,
    sources: hits.slice(0, 3).map((h) => h.question).filter(Boolean),
    mode: "knowledge-base",
  };
}

/** The questions this space can actually answer, closest scope first. */
async function topQuestions(surface, limit = 6) {
  const space = spaces.spaceOf(surface);
  const primary = (space.scopes || [])[0];
  let rows = [];
  try {
    rows = await db.all(
      "SELECT question FROM ai_knowledge WHERE is_active = 1 AND scope = ? ORDER BY sort_order, id LIMIT ?",
      [primary, limit]
    );
  } catch (e) {
    rows = [];
  }
  return rows.map((r) => r.question).filter(Boolean);
}

/** A real answer when nothing matched: what this space can help with, the
    questions it can answer, and the right hand-off. Never a dead end. */
async function menuAnswer(surface) {
  const space = spaces.spaceOf(surface);
  const questions = await topQuestions(surface, 6);
  const lines = [];
  lines.push(space.fallbackTitle || "Here is what I can help with:");
  if (space.capabilities && space.capabilities.length) {
    for (const cap of space.capabilities) lines.push(`• ${cap}`);
  } else if (questions.length) {
    for (const q of questions) lines.push(`• ${q}`);
  }
  if (questions.length && space.capabilities && space.capabilities.length) {
    lines.push("");
    lines.push("Try asking:");
    for (const q of questions.slice(0, 4)) lines.push(`• ${q}`);
  }
  if (space.handoffLine) {
    lines.push("");
    lines.push(space.handoffLine);
  }
  return { content: lines.join("\n"), sources: [], mode: "menu", toolCalls: [] };
}

/** "What do I say when the page opens?" — the same menu, used by /status. */
async function welcome(surface) {
  const space = spaces.spaceOf(surface);
  return {
    greeting: space.greeting,
    suggestions: space.suggestions.slice(),
    capabilities: space.capabilities.slice(),
  };
}

/* ------------------------------ provider --------------------------------- */

/**
 * One OpenAI-compatible `/chat/completions` call.
 *
 * The configuration comes from the RESOLVER (env + dashboard), never from a
 * boot-time constant — a key saved under Platform → AI Assistant must work on
 * the very next message. `options.config` lets the "Test connection" endpoint
 * exercise values that have not been saved yet.
 *
 * Returns null when no model is configured; throws with status 502 when the
 * provider refuses. The key is scrubbed from any error text.
 */
async function chatCompletion(payload, options = {}) {
  const cfg = options.config || await aiConfig.resolve();
  if (!cfg || !cfg.enabled) return null;
  const timeoutMs = Number(options.timeoutMs || TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const scrub = (text) => {
    let out = String(text == null ? "" : text);
    if (cfg.apiKey) out = out.split(cfg.apiKey).join("••••");
    return out;
  };
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(Object.assign({ model: cfg.model }, payload)),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const providerMessage = (data && data.error && (data.error.message || data.error)) ||
        (data && data.message) || `AI provider error (${res.status})`;
      const e = new Error(scrub(providerMessage));
      e.status = 502;
      e.providerStatus = res.status;
      throw e;
    }
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw Object.assign(new Error(`The provider did not answer within ${Math.round(timeoutMs / 1000)} seconds.`), { status: 502 });
    }
    if (e && typeof e.message === "string") e.message = scrub(e.message);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------- failure reporting --------------------------- */

/* Why a turn that was supposed to use the model answered from the knowledge
   base instead. Before this, the route's catch block turned every provider
   refusal into an ordinary knowledge-base answer, so a 429 and "no key
   configured" were byte-identical in the response — which is exactly how a
   green "Test connection" could sit next to an assistant that never used the
   model. */

const STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** The provider's own HTTP status and message, never the key. */
function providerFailure(e) {
  const raw = Number(e && (e.providerStatus || e.provider_status));
  const status = Number.isFinite(raw) && raw > 0 ? raw : null;
  const message = String((e && e.message) || "The provider refused the request.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return { status, message };
}

/** One line a human can act on: "429 Too Many Requests: Rate limit reached…". */
function describeFailure(failure) {
  const f = failure || {};
  const message = String(f.message || "The provider refused the request.").slice(0, 300);
  if (!f.status) return message;
  return `${f.status} ${STATUS_TEXT[f.status] || "Provider error"}: ${message}`;
}

/** A 400/422 that complains about tools or function calling. The usual cause is
    a model that does not implement the OpenAI tool-call shape at all, which a
    plain one-message probe can never reveal because it sends no tools. */
function toolsRejected(failure) {
  if (!failure || (failure.status !== 400 && failure.status !== 422)) return false;
  return /tool|function[\s_-]?call|tool_choice/i.test(failure.message);
}

/* One warning per DISTINCT provider error: a busy assistant must not fill the
   log with the same 429 on every message, and a new error must still surface. */
const loggedFailures = new Set();
function logFailureOnce(where, failure) {
  const key = `${where}|${failure.status}|${failure.message}`;
  if (loggedFailures.has(key)) return;
  if (loggedFailures.size >= 50) loggedFailures.clear();
  loggedFailures.add(key);
  console.warn(
    `AI provider fallback (${where}): ${describeFailure(failure)} — ` +
    "answering from the knowledge base; run Platform → AI Assistant → Run diagnostics to see the full payload result."
  );
}

/* The last REALISTIC probe result, so the dashboard can show a red pill without
   spending a provider call on every page load. In-process on purpose: it is a
   diagnostic breadcrumb, not configuration. */
let lastProbeResult = null;
function recordProbe(result) {
  const safe = Object.assign({}, result, { at: new Date().toISOString() });
  delete safe.apiKey;
  delete safe.key;
  lastProbeResult = safe;
  return safe;
}
function lastProbe() {
  return lastProbeResult;
}

/* ------------------------------ turns ------------------------------------ */

const ROLE_LABEL = {
  super_admin: "the EduSphere platform operator (super admin)",
  madrasa_admin: "the institution administrator",
  teacher: "a teacher",
  student: "a student",
  parent: "a parent or guardian",
};

/** The "who am I talking to" block. Built from the session by the route; the
    model never sees a tenant id it could choose to trust instead of this. */
function contextBrief(surface, context) {
  const bits = [];
  if (context.role) bits.push(`You are speaking to ${ROLE_LABEL[context.role] || context.role}.`);
  if (context.userName) bits.push(`Their name is ${context.userName}.`);
  if (context.schoolName) bits.push(`You are the assistant on the public website of ${context.schoolName}. You speak for that school and know nothing about any other institution.`);
  if (context.institutionName) bits.push(`Their institution is ${context.institutionName}.`);
  if (context.category) bits.push(`The institution is registered as ${context.category === "western" ? "a Western academy" : "an Islamic school"}.`);
  if (context.plan) bits.push(`Current plan: ${context.plan}.`);
  if (context.subscriptionStatus) bits.push(`Subscription status: ${context.subscriptionStatus}.`);
  if (context.studentName) bits.push(`Their own student record belongs to ${context.studentName}.`);
  if (context.children && context.children.length) bits.push(`The children linked to their account: ${context.children.join(", ")}.`);
  if (context.today) bits.push(`Today is ${context.today}.`);
  return bits.join(" ");
}

function systemPrompt(surface, extra) {
  const space = spaces.spaceOf(surface);
  return [space.systemPrompt || spaces.SPACES.admin.systemPrompt, extra ? `\n\nWHO YOU ARE TALKING TO\n${extra}` : ""].join("");
}

function knowledgeBlock(hits) {
  if (!hits || !hits.length) return "";
  return `\n\nKNOWLEDGE BASE (authoritative — prefer this over your own assumptions):\n` +
    hits.map((h, i) => `[${i + 1}] ${h.topic ? h.topic + " — " : ""}${h.question}\n${h.answer}`).join("\n\n");
}

/** OpenAI-style tool schemas, from the route's tool definitions. */
function toolSchemas(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters || { type: "object", properties: {} } },
  }));
}

/** Conversation history, capped. `limit` counts MESSAGES, the unit the old
    `messages.slice(-12)` used. */
function turnMessages(messages, limit) {
  return (messages || [])
    .slice(-limit)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 4000) }));
}

/**
 * Runs one assistant turn.
 *
 * A provider refusal is NEVER silent. The answer still comes from the
 * knowledge base — "never a dead end" is unchanged — but the result now says
 * WHY (`fallback_reason`, `provider_status`, `degraded`, `note`), so a caller
 * can tell "no key configured" from "the model exists and refused this turn".
 *
 * Two cheap self-healing retries happen before falling back:
 *   • the provider rejects `tools`/`tool_choice` (400/422) → same turn, no tools;
 *   • the provider says 413/429 (too large / rate limited) → same turn with two
 *     messages of history and a smaller knowledge block.
 *
 * @param {object} o
 * @param {"public"|"super_admin"|"admin"|"teacher"|"student"|"parent"|"whatsapp"} o.surface
 * @param {{role:string,content:string}[]} o.messages  conversation so far (no system)
 * @param {Array}  [o.tools]   OpenAI-style tool definitions + `run(args, ctx)`
 * @param {object} [o.context] who is asking (role, institution, plan…) — server-built
 * @returns {Promise<{content:string, sources:string[], mode:string, toolCalls:Array}>}
 */
async function ask({ surface = "public", messages = [], tools = [], context = {} }) {
  const space = spaces.spaceOf(surface);
  const last = messages[messages.length - 1];
  const query = last && last.content ? String(last.content) : "";
  if (!cleanStr(query, 4000)) {
    return { content: space.emptyQuery || space.greeting, sources: [], mode: "empty", toolCalls: [] };
  }

  const limits = turnLimits(surface);
  const hits = await retrieve(surface, query, limits.knowledge);

  // Resolved per request: a key saved from the dashboard applies immediately,
  // and an environment override still wins. No model configured (or the
  // dashboard switched it off) → answer from the knowledge base, or from the
  // space's own menu. Both are real answers; there is no dead end. The reason
  // is reported too, because "no model" and "the model failed" used to be
  // indistinguishable in the response.
  const cfg = await aiConfig.resolve();
  if (!cfg.enabled) {
    const fb = fallbackAnswer(surface, query, hits);
    const base = fb || await menuAnswer(surface);
    return Object.assign({}, base, {
      toolCalls: base.toolCalls || [],
      fallback_reason: "no_model_configured",
      provider_status: null,
    });
  }

  const systemBase = systemPrompt(surface, contextBrief(surface, context));
  const toolDefs = toolSchemas(tools);
  const maxTokens = surface === "whatsapp" ? 400 : 700;

  /** One attempt, always from a clean conversation: a retry must not inherit a
      tool result or a history slice the provider has just refused. Throws the
      provider's own error; the caller decides what to retry. */
  const attemptTurn = async ({ history, hitSlice, withTools }) => {
    const convo = [
      { role: "system", content: systemBase + knowledgeBlock(hitSlice) },
      ...history,
    ];
    const defs = withTools ? toolDefs : [];
    const calls = [];
    const usage = { in: 0, out: 0 };
    const sources = (hitSlice || []).map((h) => h.question).filter(Boolean);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const payload = {
        messages: convo,
        temperature: 0.2,
        max_tokens: maxTokens,
      };
      if (defs.length) Object.assign(payload, { tools: defs, tool_choice: "auto" });

      const data = await chatCompletion(payload, { config: cfg });
      const choice = data && data.choices && data.choices[0];
      if (!choice) throw Object.assign(new Error("The provider answered 200 but without choices[0].message."), { status: 502 });

      if (data.usage) {
        usage.in += Number(data.usage.prompt_tokens || 0);
        usage.out += Number(data.usage.completion_tokens || 0);
      }

      const msg = choice.message || {};
      if (msg.tool_calls && msg.tool_calls.length) {
        convo.push(msg);
        for (const call of msg.tool_calls) {
          const name = call.function && call.function.name;
          const tool = (tools || []).find((t) => t.name === name);
          let args = {};
          try { args = JSON.parse((call.function && call.function.arguments) || "{}"); } catch (e) { args = {}; }
          let out;
          try {
            out = tool ? await tool.run(args, context) : { error: "Unknown tool." };
          } catch (e) {
            out = { error: String((e && e.message) || "Tool failed.") };
          }
          calls.push({ name, args, result: out });
          convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out).slice(0, 6000) });
        }
        continue;
      }

      return {
        content: String(msg.content || "").trim() || "I could not put an answer together. Please ask again or contact the EduSphere team.",
        sources,
        mode: "ai",
        toolCalls: calls,
        tokens: usage,
      };
    }

    return {
      content: "I need a moment — please try that again, or ask the EduSphere team directly through Chat & Support.",
      sources,
      mode: "ai",
      toolCalls: calls,
      tokens: usage,
    };
  };

  const historyAll = turnMessages(messages, limits.history);
  let toolsAllowed = toolDefs.length > 0;
  let failure = null;

  try {
    return await attemptTurn({ history: historyAll, hitSlice: hits, withTools: toolsAllowed });
  } catch (e) {
    failure = providerFailure(e);
  }

  // Retry 1 — the model does not implement tool calling. Drop the tools and
  // try the same turn once: a conversational answer is still a real answer.
  if (toolsAllowed && toolsRejected(failure)) {
    logFailureOnce(`${surface} (tools rejected, retrying without them)`, failure);
    toolsAllowed = false;
    try {
      return await attemptTurn({ history: historyAll, hitSlice: hits, withTools: false });
    } catch (e) {
      failure = providerFailure(e);
    }
  }

  // Retry 2 — request too large or rate limited. Two messages of history and a
  // smaller knowledge block are what fits under a free-tier per-minute ceiling.
  if (failure.status === 413 || failure.status === 429) {
    logFailureOnce(`${surface} (too large or rate limited, retrying with a trimmed context)`, failure);
    try {
      return await attemptTurn({
        history: turnMessages(messages, Math.min(limits.history, RETRY_HISTORY)),
        hitSlice: hits.slice(0, retryKnowledgeLimit(surface, limits.knowledge)),
        withTools: toolsAllowed,
      });
    } catch (e) {
      failure = providerFailure(e);
    }
  }

  logFailureOnce(`${surface} (answering from the knowledge base)`, failure);
  const base = fallbackAnswer(surface, query, hits) || await menuAnswer(surface);
  const reason = describeFailure(failure);
  return Object.assign({}, base, {
    toolCalls: base.toolCalls || [],
    fallback_reason: reason,
    provider_status: failure.status,
    degraded: true,
    note: `Model unavailable: ${reason}`,
  });
}

/**
 * Builds the REALISTIC turn a real visitor's message produces, sends it once,
 * and reports exactly what happened.
 *
 * This is the probe "Test connection" should always have been. The old test
 * sent one 8-token message with no system prompt, no knowledge, no history and
 * no tools, so it could pass while every real turn failed on a token ceiling or
 * a model that refuses `tools`. Both /api/platform/ai/test (mode "real") and
 * /api/platform/ai/diagnose call THIS function, so a green result means the
 * actual chat path works.
 *
 * @returns {Promise<{ok:boolean, latencyMs:number, httpStatus:number|null,
 *   error:string|null, mode:string, tokens:{in:number,out:number}, request:object}>}
 */
async function probe({ surface = "public", tools = [], hits = [], history = [], context = {}, config = null, timeoutMs = TIMEOUT_MS, record = true } = {}) {
  const limits = turnLimits(surface);
  const cfg = config || await aiConfig.resolve();
  // `record: false` keeps a test of unsaved form values out of the dashboard's
  // "last real probe" state: that breadcrumb describes the LIVE configuration.
  const finish = (result) => (record ? recordProbe(result) : result);
  const systemBase = systemPrompt(surface, contextBrief(surface, context));
  const toolDefs = toolSchemas(tools);
  const hitSlice = (hits || []).slice(0, limits.knowledge);
  const convo = [
    { role: "system", content: systemBase + knowledgeBlock(hitSlice) },
    ...turnMessages(history, limits.history),
  ];
  const maxTokens = surface === "whatsapp" ? 400 : 700;
  const payload = { messages: convo, temperature: 0.2, max_tokens: maxTokens };
  if (toolDefs.length) Object.assign(payload, { tools: toolDefs, tool_choice: "auto" });

  const body = JSON.stringify(payload);
  const request = {
    messages: convo.length,
    max_tokens: maxTokens,
    tools: toolDefs.map((t) => t.function.name),
    knowledge_entries: hitSlice.length,
    bytes: Buffer.byteLength(body),
    approx_prompt_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(convo)) / 4),
  };

  if (!cfg || !cfg.enabled) {
    return finish({
      ok: false, httpStatus: null, latencyMs: 0, mode: "knowledge-base",
      error: "No model is configured, so every space answers from the knowledge base.",
      tokens: { in: 0, out: 0 }, request,
    });
  }

  const started = Date.now();
  try {
    const data = await chatCompletion(payload, { config: cfg, timeoutMs });
    const choice = data && data.choices && data.choices[0];
    const msg = choice && choice.message;
    if (!choice || !msg) {
      // Suspect 5: a 200 whose shape the parser does not recognise.
      return finish({
        ok: false, httpStatus: 200, latencyMs: Date.now() - started, mode: "knowledge-base",
        error: "The provider answered 200 but without choices[0].message, so there is no answer to read.",
        tokens: { in: 0, out: 0 }, request,
      });
    }
    const usedTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const usage = data.usage || {};
    return finish({
      ok: true, httpStatus: 200, latencyMs: Date.now() - started,
      error: null, mode: usedTools ? "tool-call" : "ai",
      model: (data && data.model) || cfg.model || "",
      tokens: { in: Number(usage.prompt_tokens || 0), out: Number(usage.completion_tokens || 0) },
      request,
    });
  } catch (e) {
    const failure = providerFailure(e);
    return finish({
      ok: false, httpStatus: failure.status, latencyMs: Date.now() - started,
      mode: "knowledge-base", error: describeFailure(failure),
      tokens: { in: 0, out: 0 }, request,
    });
  }
}

/* ------------------------------ persistence ------------------------------ */

async function conversation({ surface, madrasaId, userId, externalId }) {
  const existing = await db.get(
    "SELECT * FROM ai_conversations WHERE surface = ? AND external_id = ? ORDER BY id DESC",
    [surface, String(externalId || "")]
  );
  if (existing) return existing;
  const r = await db.run(
    "INSERT INTO ai_conversations (surface, madrasa_id, user_id, external_id) VALUES (?,?,?,?)",
    [surface, madrasaId || null, userId || null, String(externalId || "")]
  );
  return db.get("SELECT * FROM ai_conversations WHERE id = ?", [r.lastInsertRowid]);
}

async function history(conversationId, limit = 24) {
  const rows = await db.all(
    "SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
    [conversationId, limit]
  );
  return rows.reverse();
}

async function saveMessage(conversationId, role, content, meta = {}) {
  await db.run(
    "INSERT INTO ai_messages (conversation_id, role, content, sources, tokens_in, tokens_out) VALUES (?,?,?,?,?,?)",
    [conversationId, role, String(content || "").slice(0, 8000),
      meta.sources ? JSON.stringify(meta.sources) : null,
      Number((meta.tokens && meta.tokens.in) || 0), Number((meta.tokens && meta.tokens.out) || 0)]
  );
  await db.run("UPDATE ai_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [conversationId]);
}

/* --------------------------- knowledge seeding --------------------------- */

/** One-time rename of the old single `app` scope to `admin`. The old seed used
    `app` for every signed-in user; leaving it behind would give a student the
    administrator's answers. Idempotent. */
async function migrateLegacyScopes() {
  try {
    await db.run("UPDATE ai_knowledge SET scope = 'admin' WHERE scope = 'app'");
  } catch (e) {
    /* table not migrated yet — nothing to rename */
  }
}

async function seedKnowledge() {
  await migrateLegacyScopes();
  let entries;
  try {
    entries = await db.all("SELECT scope, question FROM ai_knowledge");
  } catch (e) {
    return 0; // table not migrated yet
  }
  const existing = new Set((entries || []).map((r) => `${String(r.scope).toLowerCase()}::${String(r.question).trim().toLowerCase()}`));
  const all = knowledge.SEED_KNOWLEDGE.concat(knowledge.tierKnowledge());
  let inserted = 0;
  let sort = (entries || []).length;
  for (const k of all) {
    const key = `${String(k.scope).toLowerCase()}::${String(k.question).trim().toLowerCase()}`;
    if (existing.has(key)) continue; // an operator may have edited it: leave it alone
    await db.run(
      "INSERT INTO ai_knowledge (scope, topic, question, answer, keywords, sort_order) VALUES (?,?,?,?,?,?)",
      [k.scope, k.topic, k.question, k.answer, k.keywords, sort++]
    );
    existing.add(key);
    inserted++;
  }
  return inserted;
}

/** Counts for the operator's console tool. */
async function knowledgeStats() {
  try {
    const rows = await db.all(
      "SELECT scope, COUNT(*) AS n, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active FROM ai_knowledge GROUP BY scope ORDER BY scope"
    );
    return rows.map((r) => ({ scope: r.scope, total: Number(r.n), active: Number(r.active || 0) }));
  } catch (e) {
    return [];
  }
}

module.exports = {
  ask, retrieve, fallbackAnswer, menuAnswer, welcome, topQuestions, seedKnowledge, knowledgeStats,
  conversation, history, saveMessage, chatCompletion,
  // Diagnostics: the realistic probe both "Test connection" (mode "real") and
  // GET /api/platform/ai/diagnose run, plus the last result for the card.
  probe, lastProbe, turnLimits,
  surfaceForRole: spaces.surfaceForRole,
  scopesFor: spaces.scopesFor,
  publicSpace: spaces.publicSpace,
  isTenantSurface: spaces.isTenantSurface,
  // There is deliberately NO synchronous `enabled` / `model` getter any more:
  // the answer depends on the environment AND the database, so callers must
  // `await require("./ai-config").resolve()`.
};
