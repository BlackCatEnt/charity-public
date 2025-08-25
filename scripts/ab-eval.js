#!/usr/bin/env node
/**
 * A/B eval for two Ollama models (serial, deterministic-ish).
 * - Reads OLLAMA_HOST, LLM_MODEL_A, LLM_MODEL_B from env (with defaults).
 * - Runs a small prompt set and prints timing + length + first line preview.
 *
 * Usage:
 *   node scripts/ab-eval.js
 * Optional env:
 *   OLLAMA_HOST=http://127.0.0.1:11434
 *   LLM_MODEL_A=llama3.1:8b-instruct-q8_0
 *   LLM_MODEL_B=qwen2.5:7b-instruct
 *   ABEVAL_MAXCHARS=220   # clamp preview chars in report
 *   ABEVAL_TIMEOUT_MS=20000
 */

import axios from "axios";

const HOST   = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const MODEL_A = process.env.LLM_MODEL_A || "llama3.1:8b-instruct-q8_0";
const MODEL_B = process.env.LLM_MODEL_B || "qwen2.5:7b-instruct";
const PREVIEW = parseInt(process.env.ABEVAL_MAXCHARS || "120", 10);
const TIMEOUT = parseInt(process.env.ABEVAL_TIMEOUT_MS || "20000", 10);

// Keep the system prompt similar to your bot so behavior is representative
const SYSTEM = (channel = "bagotrix", bot = "charity_the_adventurer") => `
You are the Twitch bot "${bot}" for the channel "${channel}".
Answer ONLY using the provided context if present; if it's missing, be brief and helpful.
Keep replies to 1–2 short sentences. Stay cozy, kind, and PG.
`;

// Minimal prompt set — edit to taste; you can also move this to a JSON later.
const PROMPTS = [
  { name: "Startup line", context: "", user: "Generate a single welcoming startup line inviting !ask or !rules." },
  { name: "!ask general", context: "StreamTitle: Cozy RPG Night\nGame: Final Fantasy IX", user: "What are we playing today?" },
  { name: "KB grounded", context: "Rules: Be kind; avoid spoilers; respect mods.", user: "What are the rules?" },
  { name: "Edge: slang/typo", context: "", user: "yo wat u doin here bot?" },
  { name: "Edge: short fuse", context: "", user: "Explain !ask fast." },
];

axios.defaults.baseURL = HOST;
axios.defaults.timeout = TIMEOUT;
axios.defaults.headers.common["Content-Type"] = "application/json";

function clamp(s, n) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

async function chat(model, system, context, user) {
  const messages = [
    { role: "system", content: system.trim() },
  ];

  // If context is present, feed it like your bot does
  if (context && context.trim()) {
    messages.push({
      role: "user",
      content: `Context:\n${context.trim()}\n\nQuestion: ${user.trim()}`
    });
  } else {
    messages.push({ role: "user", content: user.trim() });
  }

  const t0 = performance.now();
  try {
    const { data } = await axios.post("/api/chat", {
      model,
      stream: false,
      messages
    });
    const t1 = performance.now();
    const content =
      data?.message?.content ??
      (Array.isArray(data?.messages) ? data.messages.at(-1)?.content : "") ??
      "";
    return {
      ok: true,
      ms: Math.round(t1 - t0),
      text: (content || "").trim()
    };
  } catch (e) {
    const t1 = performance.now();
    return {
      ok: false,
      ms: Math.round(t1 - t0),
      text: `ERROR: ${e?.response?.status || ""} ${e?.message || e}`
    };
  }
}

function pad(str, n) {
  return (str + " ".repeat(n)).slice(0, n);
}

async function run() {
  const system = SYSTEM();

  const rows = [];
  for (const p of PROMPTS) {
    const rA = await chat(MODEL_A, system, p.context, p.user);
    const rB = await chat(MODEL_B, system, p.context, p.user);

    rows.push({
      name: p.name,
      A_ms: rA.ms,
      B_ms: rB.ms,
      A_len: rA.text.length,
      B_len: rB.text.length,
      A_ok: rA.ok,
      B_ok: rB.ok,
      A_preview: clamp(rA.text, PREVIEW),
      B_preview: clamp(rB.text, PREVIEW),
    });
  }

  // Pretty print
  const wName = 18, wMS = 6, wOK = 4, wLen = 6, wPrev = PREVIEW + 2;
  const line =
    pad("Prompt", wName) +
    pad("A ms", wMS) + pad("A ✓", wOK) + pad("A len", wLen) +
    pad("B ms", wMS) + pad("B ✓", wOK) + pad("B len", wLen) +
    " | " + pad("A preview", wPrev) + " | " + pad("B preview", wPrev);

  console.log("\n=== A/B Model Eval ===");
  console.log(`Host: ${HOST}`);
  console.log(`A: ${MODEL_A}`);
  console.log(`B: ${MODEL_B}\n`);
  console.log(line);
  console.log("-".repeat(line.length));

  let A_sum = 0, B_sum = 0, A_ok = 0, B_ok = 0;
  for (const r of rows) {
    A_sum += r.A_ms; B_sum += r.B_ms;
    if (r.A_ok) A_ok++; if (r.B_ok) B_ok++;
    console.log(
      pad(r.name, wName) +
      pad(String(r.A_ms), wMS) + pad(r.A_ok ? "✓" : "×", wOK) + pad(String(r.A_len), wLen) +
      pad(String(r.B_ms), wMS) + pad(r.B_ok ? "✓" : "×", wOK) + pad(String(r.B_len), wLen) +
      " | " + pad(r.A_preview, wPrev) + " | " + pad(r.B_preview, wPrev)
    );
  }

  const n = rows.length || 1;
  console.log("\nTotals:");
  console.log(`A avg ms: ${Math.round(A_sum / n)}  • successes: ${A_ok}/${n}`);
  console.log(`B avg ms: ${Math.round(B_sum / n)}  • successes: ${B_ok}/${n}`);
  console.log("\nTips:");
  console.log("- Prefer the model with fewer errors, lower avg ms, and better previews for tone & grounding.");
  console.log("- Add or edit PROMPTS in this file for your own scenarios.");
  console.log("- For a longer run, duplicate and expand the PROMPTS array.");
}

run().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
