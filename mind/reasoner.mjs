// Lightweight multi-pass reasoner for Charity.
// Uses your existing LLM (_llm.compose) and RAG store.

function pickMajority(cands=[]) {
  if (!cands.length) return '';
  const norm = s => (s||'').toLowerCase().replace(/\s+/g,' ').trim();
  const counts = new Map();
  for (const c of cands){ const n=norm(c); counts.set(n,(counts.get(n)||0)+1); }
  const best = [...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0];
  return cands.find(c => norm(c)===best) || cands[0];
}

export async function deliberate({ _llm, evt, ctx, persona, speaker, conversation, cfg = {}, caps = '' }) {
  const modelCfg = cfg.reasoning || {};
  const passes = Math.max(1, Math.min(3, modelCfg.selfConsistency || 2));

  // 1) brief plan (not shown to user)
  const planPrompt = [
    'Make a terse plan (bullets) for how to answer. Use the provided context. 3 bullets max.',
    'Output: just the bullets; no preface.'
  ].join(' ');
  const plan = await _llm.compose({ evt, ctx, persona, speaker, conversation, caps,
    cfg: { ...cfg, system_hint: planPrompt, max_tokens: 120 } });

  // 2) candidates (short)
  const cands = [];
  for (let i=0;i<passes;i++){
    const cand = await _llm.compose({ evt, ctx, persona, speaker, conversation, caps,
      cfg: { ...cfg, max_tokens: 220, temp: (cfg.temp ?? 0.6) + i*0.1,
        system_hint: 'Answer naturally in 1–2 concise sentences, grounded in context.' }});
    cands.push((cand?.text||'').trim());
  }

  // 3) quick self-check (optional) — use the picked one
  const picked = pickMajority(cands);
  if (!modelCfg.selfCheck) return { text: picked, meta: { plan: plan?.text, cands } };

  const checkQ = `Check the following answer against context. If factual or well-supported, reply "OK". Otherwise reply "REVISE:" and give a 1–2 sentence corrected answer.\n\nANSWER:\n${picked}`;
  const chk = await _llm.compose({ evt, ctx, persona, speaker, conversation,
    cfg: { ...cfg, max_tokens: 120, temp: 0.2, system_hint: checkQ }});

  if (/^ok\b/i.test(chk?.text||'')) return { text: picked, meta: { plan: plan?.text, cands } };
  const m = (chk?.text||'').match(/^revi(se|sion)?:\s*(.+)$/i);
  return { text: (m?.[2] || picked).trim(), meta: { plan: plan?.text, cands } };
}
