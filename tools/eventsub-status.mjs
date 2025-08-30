// tools/eventsub-status.mjs — list EventSub subscriptions via Helix
import { helixHeaders } from '../modular_phase2/modules/helix-auth.js';

async function fetchAllSubs() {
  const headers = await helixHeaders('broadcaster'); // broadcaster token has the scopes you granted
  const out = [];
  let cursor = null;
  do {
    const url = new URL('https://api.twitch.tv/helix/eventsub/subscriptions');
    if (cursor) url.searchParams.set('after', cursor);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`eventsub/subscriptions ${res.status} ${body}`);
    }
    const j = await res.json();
    for (const s of (j?.data || [])) out.push(s);
    cursor = j?.pagination?.cursor || null;
  } while (cursor);
  return out;
}

function summarize(subs) {
  const pick = (s) => ({
    id: s.id,
    type: s.type,
    version: s.version,
    status: s.status,            // e.g., enabled
    condition: s.condition,      // object, varies per type
    transport: s.transport,      // { method: 'websocket', session_id: '...' } or 'webhook'
    created_at: s.created_at,
    cost: s.cost
  });
  return subs.map(pick);
}

(async () => {
  try {
    const subs = await fetchAllSubs();
    const brief = summarize(subs);
    console.log(JSON.stringify({
      ok: true,
      total: subs.length,
      websocket: brief.filter(s => s.transport?.method === 'websocket').length,
      webhook: brief.filter(s => s.transport?.method === 'webhook').length,
      subscriptions: brief
    }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    process.exit(1);
  }
})();
