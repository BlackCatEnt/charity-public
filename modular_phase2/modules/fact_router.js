// modular_phase2/modules/fact_router.js
export function createFactRouter({ OLLAMA, model }) {
  async function route({ question, keys }) {
    const ks = (keys || []).filter(Boolean).slice(0, 50);
    if (!question || ks.length === 0) return { kind:'none', confidence:0.0 };

    const messages = [
      { role:'system', content: [
        'You are a router that maps a viewer question to ONE fact key from a provided list.',
        'Only choose keys from the list. If none apply, answer kind:"none".',
        'Return ONLY strict JSON: {"kind":"lookup","key":"<one_of_keys>","confidence":0.0-1.0} or {"kind":"none","confidence":0.0-1.0}.',
        'Examples:',
        'Q:"who did I marry?" -> key might be spouse_name or spouse_handle',
        'Q:"what is my favorite genre?" -> favorite_genre',
        'Q:"when did we meet?" -> when_we_met'
      ].join(' ') },
      { role:'user', content: `Keys: ${ks.join(', ')}` },
      { role:'user', content: `Question: ${String(question).trim()}` }
    ];

    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream:false,
          options: { temperature: 0, top_p: 0.9 }
        })
      });
      const data = await res.json().catch(()=>({}));
      const txt = data?.message?.content || '';
      const m = txt.match(/\{[\s\S]*\}$/);
      const json = m ? JSON.parse(m[0]) : JSON.parse(txt);
      const kind = (json.kind || '').toLowerCase();
      const key  = typeof json.key === 'string' ? json.key : undefined;
      const confidence = Math.max(0, Math.min(1, Number(json.confidence ?? 0)));
      if (kind === 'lookup' && key && ks.includes(key)) {
        return { kind:'lookup', key, confidence };
      }
      return { kind:'none', confidence };
    } catch {
      return { kind:'none', confidence:0.0 };
    }
  }
  return { route };
}
