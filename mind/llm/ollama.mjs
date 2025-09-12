import 'dotenv/config';

const DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const TIMEOUT_MS = 30_000;

function controllerWithTimeout(ms = TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

function buildPrompt({ evt, ctx = [], persona = {} }) {
  const sys = [
    `You are Charity the Adventurer: warm, helpful, playful, fantasy guild theme.`,
    `Stay concise by default; offer to expand. Avoid inventing relationships.`,
  ].join(' ');

  const context = ctx.length
    ? `\n\nContext:\n${ctx.map((c, i) => `- ${c.title || `ctx${i+1}`}: ${c.text?.slice(0, 400) || ''}`).join('\n')}`
    : '';

  const user = evt.text?.trim() || '';
  return `${sys}${context}\n\nUser: ${user}\nAssistant:`;
}

export function makeOllamaLLM({ model = 'llama3.1:8b-instruct-q8_0', host = DEFAULT_HOST } = {}) {
  async function generate(prompt) {
    const url = `${host}/api/generate`;
    const body = { model, prompt, stream: false };
    const { signal, clear } = controllerWithTimeout();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
      clear();
      if (!res.ok) throw new Error(`ollama ${res.status} ${await res.text()}`);
      const json = await res.json();
      return (json?.response || '').trim();
    } catch (e) {
      return `[LLM temporarily unavailable: ${e.message}]`;
    }
  }

  return {
    /**
     * compose({ evt, ctx, persona, cfg }) -> { text, meta }
     */
    async compose({ evt, ctx, persona }) {
      const prompt = buildPrompt({ evt, ctx, persona });
      const text = await generate(prompt);
      return { text, meta: { model } };
    }
  };
}
