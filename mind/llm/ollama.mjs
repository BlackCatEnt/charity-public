import 'dotenv/config';

const DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const TIMEOUT_MS = 30_000;

function controllerWithTimeout(ms = TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

function buildPrompt({ evt, ctx = [], persona = {} }) {
  const name   = persona?.name || 'Charity the Adventurer';
  const tone   = persona?.tone?.style || 'warm, helpful, playful, sassy';
  const emote  = persona?.tone?.emote || '✧';
  const shortB = persona?.bios?.short_bio || '';
  const longB  = persona?.bios?.long_bio || '';
  const guild  = persona?.canon?.guild_name || 'Adventuring Guild';

  const sys = [
    `${name} — ${tone}. Stay concise by default; offer to expand.`,
    `Canon: The guild is called exactly "${guild}". Do not invent other guild names.`,
    shortB ? `Bio (short): ${shortB}` : '',
    longB  ? `Bio (long): ${longB}`  : '',
    `When addressing users, be kind and practical. Emote sparingly like ${emote}.`
  ].filter(Boolean).join('\n');

  const context = ctx.length
    ? `\n\nContext:\n${ctx.map((c, i) => `- ${c.title || `ctx${i+1}`}: ${c.text?.slice(0, 600) || ''}`).join('\n')}`
    : '';

  const user = (evt.text || '').trim();
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
