// modules/fact_extractor.js
export function createFactExtractor({
  OLLAMA,
  model,                          // reuse LLM_MODEL
  isBroadcasterUser,
  broadcasterLogin,               // BROADCASTER (lowercased)
  normalizeKey,                   // from index.mod.js
  cleanValue,                     // from index.mod.js
  bannedRx = /\b(nsfw|porn|sex|sexual|explicit|fetish|gore)\b/i
}) {
  const lastRun = new Map(); // user-id -> ts
  const MIN_LEN = 24;        // ignore very short messages
  const COOLDOWN_MS = 45_000;

  // concept we protect (who owns/runs the guild)
  const GUILD_RX = /(guild\s*master|who\s+runs\s+the\s+guild|own\s+the\s+guild|run\s+the\s+guild)/i;

  function shouldTry(text, tags) {
    if (!text || text.startsWith('!')) return false;
    if (text.length < MIN_LEN) return false;
    const id = String(tags['user-id'] || tags.username || '').toLowerCase();
    const last = lastRun.get(id) || 0;
    const ok = (Date.now() - last) > COOLDOWN_MS;
    if (ok) lastRun.set(id, Date.now());
    return ok;
  }

  function safeParseArray(s) {
    try { const j = JSON.parse(s); return Array.isArray(j) ? j : []; } catch {}
    // try to pull a ```json block
    const m = /```json\s*([\s\S]+?)```/i.exec(s) || /```[\s\S]+?```/i.exec(s);
    if (m) { try { const j = JSON.parse(m[1]); return Array.isArray(j) ? j : []; } catch {} }
    // try to find first [...] JSON array
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a >= 0 && b > a) { try { const j = JSON.parse(s.slice(a, b+1)); return Array.isArray(j) ? j : []; } catch {} }
    return [];
  }

  function postFilter(items, tags) {
    const out = [];
    const isGM = isBroadcasterUser?.(tags) === true;
    for (const it of (items || [])) {
      let k = normalizeKey(it.key || it.k || '');
      let v = cleanValue(it.value || it.v || '');
      if (!k || !v) continue;
      if (bannedRx.test(k) || bannedRx.test(v)) continue;

      // protect guild ownership/relationship concept
      if (k === 'adventuring_guild' || GUILD_RX.test(v)) {
        if (!isGM) continue; // only the Guild Master can set this concept
        k = 'adventuring_guild';
        v = 'We both own the Adventuring Guild and run it together.';
      }

      // constrain length
      if (v.length > 160) v = v.slice(0, 160);

      // normalize some common dates
      if (k === 'when_we_met') {
        const d = new Date(v);
        if (!isNaN(d)) {
          const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), da=String(d.getUTCDate()).padStart(2,'0');
          v = `${y}-${m}-${da}`;
        }
      }

      const conf = Math.max(0.5, Math.min(1.0, Number(it.confidence ?? 0.8)));
      const scope = (it.scope || it.type || 'profile').toLowerCase();
      if (scope !== 'profile') continue; // only durable facts
      out.push({ key: k, value: v, confidence: conf });
      if (out.length >= 3) break; // cap per message
    }
    return out;
  }

   async function extractCandidates(text, tags) {
    if (!shouldTry(text, tags)) return [];
    const messages = [
      { role: 'system', content:
        [
          'You extract POSSIBLE durable user profile facts (candidates) from ONE Twitch chat message.',
          'Return ONLY JSON array: [{ "key": "...", "value": "...", "confidence": 0.0-1.0, "scope": "profile" }]. No prose.',
          'Keys must be short snake_case (e.g., favorite_genre, platform_main, when_we_met, spouse_name, city, comfort_game).',
          'Only facts about the SPEAKER; ignore the bot or other users.',
          'No secrets, no PII beyond public handles; keep PG-13.',
          'Prefer persistent tastes, identity, relationships, dates, long-term projects. Ignore fleeting/one-off chatter.',
          'If no suitable facts, return [].'
        ].join(' ')
      },
      { role: 'system', content:
        'Examples: ' +
        'Input: "I got married to Trin last year — her username is trincroft." ' +
        'Output: [{"key":"spouse_name","value":"Trin","confidence":0.9,"scope":"profile"},' +
        '{"key":"spouse_handle","value":"trincroft","confidence":0.85,"scope":"profile"}] :: ' +
        'Input: "My favorite genre is RPGs, also love metroidvania." ' +
        'Output: [{"key":"favorite_genre","value":"RPGs","confidence":0.9,"scope":"profile"},' +
        '{"key":"likes_metroidvania","value":"yes","confidence":0.7,"scope":"profile"}]'
      },
      { role: 'user', content: String(text).slice(0, 500) }
    ];

    let raw = '';
    try {
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false })
      });
      const data = await res.json().catch(()=>({}));
      raw = data?.message?.content || (Array.isArray(data?.messages) ? data.messages.slice(-1)[0]?.content : '') || '';
    } catch (e) {
      return []; // never crash message flow
    }
	let arr = safeParseArray(raw);
    // Tiny heuristic fallback if the model failed to JSONify
    if (!arr.length) {
      const spouseName = /\bmarried\s+to\s+([A-Za-z][\w-]{1,31})\b/i.exec(text);
      const spouseHandle = /\busername\s+is\s+@?([A-Za-z][\w-]{1,31})\b/i.exec(text);
      const tmp = [];
      if (spouseName) tmp.push({ key:'spouse_name', value: spouseName[1], confidence: 0.75, scope: 'profile' });
      if (spouseHandle) tmp.push({ key:'spouse_handle', value: spouseHandle[1].toLowerCase(), confidence: 0.75, scope: 'profile' });
      if (tmp.length) arr = tmp;
    }
        // Map to candidate rows (carry both raw and normalized)
    const filtered = postFilter(arr, tags);
    return filtered.map(it => ({
      key: it.key,                // normalized key
      key_raw: it.key,            // we keep same; callers may pass original if desired
      value: it.value,            // normalized value
      value_raw: it.value,        // same
      confidence: it.confidence,
      evidence: String(text).slice(0, 240)
    }));
  }

   return { extractCandidates };
}
