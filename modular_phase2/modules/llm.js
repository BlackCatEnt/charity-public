// modules/llm.js
const BASE        = process.env.LLM_BASE || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const JSON_MODEL  = process.env.LLM_JSON_ROUTER  || 'llama3.1:8b-instruct-q8_0';
const FAST_MODEL  = process.env.LLM_MODEL_FAST   || 'llama3.1:8b-instruct-q8_0';
const SMART_MODEL = process.env.LLM_MODEL_SMART  || 'qwen2.5:14b-instruct-q4_K_M';

/**
 * Call Ollama /api/chat and optionally parse JSON.
 * Falls back through models[] if a 404 occurs (model not pulled).
 */
async function callOllamaChat({ model, messages, json = false, maxTokens = 256, fallbacks = [] }) {
  const tryOnce = async (m) => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: m,
        messages,
        options: { num_predict: maxTokens },
        stream: false
      })
    });
    if (!res.ok) {
      const err = new Error(`ollama ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data?.message?.content ?? data?.response ?? '';
    if (!json) return String(text).trim();

    // try to extract clean JSON from fenced block or trailing object
    const mjson = text.match(/```json([\s\S]*?)```/i) || text.match(/{[\s\S]*}$/);
    const raw = mjson ? (mjson[1] || mjson[0]) : text;
    try { return JSON.parse(raw); } catch { return { _raw: text }; }
  };

  const models = [model, ...fallbacks].filter(Boolean);
  let lastErr;
  for (const m of models) {
    try { return await tryOnce(m); }
    catch (e) {
      lastErr = e;
      // only continue fallback chain on “model missing”
      if (e?.status !== 404) break;
    }
  }
  throw lastErr;
}

export async function chatText({ system, user, model = FAST_MODEL, maxTokens = 200 }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  return callOllamaChat({
    model,
    messages,
    json: false,
    maxTokens,
    fallbacks: [SMART_MODEL] // try smart if fast is missing
  });
}

export async function chatJson({ system, user, schemaHint = '', model = JSON_MODEL, maxTokens = 200 }) {
  const guard = `Respond ONLY with JSON. ${schemaHint}`.trim();
  const messages = [
    { role: 'system', content: `${system}\n\n${guard}`.trim() },
    { role: 'user', content: user }
  ];

  // Try JSON router first; on 404 fall back to FAST→SMART and best-effort parse
  try {
    return await callOllamaChat({ model, messages, json: true, maxTokens });
  } catch (e) {
    const text = await callOllamaChat({
      model: FAST_MODEL,
      messages,
      json: false,
      maxTokens,
      fallbacks: [SMART_MODEL]
    });
    try { return JSON.parse(text); } catch { return { _raw: text }; }
  }
}

export const MODELS = { BASE, JSON_MODEL, FAST_MODEL, SMART_MODEL };
