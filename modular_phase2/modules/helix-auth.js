// A:\Charity\modular_phase2\modules\helix-auth.js
import { ensureFresh, getBearer } from './token-manager.js';

export async function helixHeaders(id = 'bot', logger) {
  // keep us inside Twitch’s expectations: only refresh when needed
  const f = await ensureFresh(id, logger);
  if (!f.ok) { logger?.warn?.(`[helix] ${id} token not fresh (${f.reason}); proceeding anyway`); }
  const bearer = getBearer(id);
  return {
    'Client-ID': process.env.TWITCH_CLIENT_ID,
    'Authorization': `Bearer ${bearer}`,
    'Content-Type': 'application/json',
  };
}

// Small helper for Helix calls with one retry on 401
export async function api(path, { method = 'GET', query, body, id = 'broadcaster', logger } = {}) {
  const u = new URL(`https://api.twitch.tv/helix/${path}`);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) v.forEach(x => u.searchParams.append(k, String(x)));
    else if (v != null) u.searchParams.set(k, String(v));
  }

  let headers = await helixHeaders(id, logger);
  let res = await fetch(u, { method, headers, body: body ? JSON.stringify(body) : undefined });

  if (res.status === 401) {
    // one polite retry after refresh
    await ensureFresh(id, logger);
    headers = await helixHeaders(id, logger);
    res = await fetch(u, { method, headers, body: body ? JSON.stringify(body) : undefined });
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
