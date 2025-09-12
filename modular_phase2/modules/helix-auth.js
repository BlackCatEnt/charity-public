// Helix helpers (always build proper Bearer headers)
import { ensureFresh, getBearer } from './token-manager.js';

const BASE = 'https://api.twitch.tv/helix';

function stripOauthPrefix(v = '') {
  return v && v.startsWith('oauth:') ? v.slice(6) : v;
}

/** role: 'broadcaster' | 'bot' */
export async function helixHeaders(role = 'broadcaster') {
  // Best-effort freshness
  try { await ensureFresh(role); } catch {}

  // Primary source: token-manager (env-backed)
  let bearer = getBearer(role);

  // Fallback: read env directly to tolerate early boot
  if (!bearer) {
    const envKey = role === 'bot' ? 'TWITCH_OAUTH' : 'TWITCH_OAUTH_BROADCASTER';
    bearer = stripOauthPrefix(process.env[envKey] || '');
  }

  if (!bearer) throw new Error(`[helix] no bearer for ${role}`);

  const clientId = process.env.TWITCH_CLIENT_ID || '';
  if (!clientId) throw new Error('[helix] TWITCH_CLIENT_ID missing');

  return {
    'Client-Id': clientId,
    'Authorization': `Bearer ${bearer}`,
    'Content-Type': 'application/json',
  };
}

export async function helixFetch(path, {
  method = 'GET',
  role   = 'broadcaster',
  params = null,
  body   = null,
  headers = {},
} = {}) {
  const h  = await helixHeaders(role);
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const url = `${BASE}${path}${qs}`;

  const res = await fetch(url, {
    method,
    headers: { ...h, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[helix] ${res.status} ${res.statusText} ${text || ''}`.trim());
  }
  return res.json();
}

export const api      = (path, opts = {}) => helixFetch(path, opts);
export const helixGet = (path, opts = {}) => helixFetch(path, { ...opts, method:'GET' });
