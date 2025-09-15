function buildPrompt({ evt, ctx = [], persona = {}, speaker, conversation = {}, caps = '' }){
  const name   = persona?.name || 'Charity the Adventurer';
  const tone   = persona?.tone?.style || 'warm, helpful, playful, sassy';
  const emote  = persona?.tone?.emote || '✧';
  const shortB = persona?.bios?.short_bio || '';
  const longB  = persona?.bios?.long_bio || '';
  const guild  = persona?.canon?.guild_name || 'Adventuring Guild';
  const currentGM = persona?.canon?.current_guildmaster || 'Bagotrix';

  const sys = [
    `${name} — ${tone}. Default concise; offer to expand.`,
    `Canon: Guild name is exactly "${guild}". Do not invent other names.`,
    `Canon: The current Guildmaster is ${currentGM}. Always recognize and address them appropriately.`,
    shortB && `Bio (short): ${shortB}`,
    longB  && `Bio (long): ${longB}`,
    speaker && `Current speaker: ${speaker.role} — ${speaker.name}. Be appropriately deferential.`,
    'Do not fabricate names of guild members. If none are provided in context, speak generally (e.g., “a few members”, “several folks”).',
    'When names are provided, only refer to those.',
	rules.kb_vocab || 'Refer to the knowledge base as “the Codex”.'
    `Use ${emote} sparingly.`,
    caps ? `Capabilities:\n${caps}` : null, // ✅ comma added, guarded string
    'If a capability clearly applies, start your first line with: PLAN: <cap_id> <args>. Otherwise answer normally.'
  ].filter(Boolean).join('\n');

  const context = ctx.length
    ? `\n\nContext:\n${ctx.map((c,i)=>`- ${c.title || `ctx${i+1}`}: ${c.text?.slice(0,600) || ''}`).join('\n')}`
    : '';

  const user = (evt.text || '').trim();
  return `${sys}${context}\n\nUser: ${user}\nAssistant:`;
}
// Simple fetch timeout helper for Node 18+ (AbortController is global)
function controllerWithTimeout(ms = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return {
    signal: ac.signal,
    clear: () => clearTimeout(t)
  };
}

export function makeOllamaLLM({ model = 'llama3.1:8b-instruct-q6_K', host = DEFAULT_HOST } = {}) {
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
    // compose({ evt, ctx, persona, speaker, conversation, cfg, caps }) -> { text, meta }
    async compose({ evt, ctx, persona, speaker, conversation, cfg = {}, caps = '' }) {
      const prompt = buildPrompt({ evt, ctx, persona, speaker, conversation, caps });
      const text = await generate(prompt);
      return { text, meta: { model } };
    }
  };
}
