import 'dotenv/config';
import { getTwitchToken, refreshTwitch, scheduleTwitchAutoRefresh } from '#relics/tokens.mjs';

const HELIX = 'https://api.twitch.tv/helix';
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;

async function authHeaders(kind='broadcaster') {
  const tok = await getTwitchToken(kind);
  return {
    'Authorization': `Bearer ${tok.access_token}`,
    'Client-Id': CLIENT_ID,
    'Content-Type': 'application/json'
  };
}

export async function helixFetch(path, { method='GET', body=null, kind='broadcaster' } = {}) {
  const url = path.startsWith('http') ? path : `${HELIX}${path}`;
  let headers = await authHeaders(kind);
  let res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });

  // If unauthorized, try a forced refresh once (requires refresh token)
  if (res.status === 401) {
    try {
      const rec = await getTwitchToken(kind);
      const fresh = await refreshTwitch(kind, rec); // will throw if no refresh_token
      headers = {
        ...headers,
        'Authorization': `Bearer ${fresh.access_token}`
      };
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });
    } catch (e) {
      // bubble up the original 401 if refresh fails
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[helix] ${res.status} ${text}`);
  }
  return res.json();
}

// Convenience: validate broadcaster token by fetching your user record
export async function getUserByLogin(login, kind='broadcaster') {
  const q = new URLSearchParams({ login });
  const data = await helixFetch(`/users?${q}`, { kind });
  return data?.data?.[0] || null;
}

// optional: call this once at boot to keep broadcaster token fresh in background
export function keepBroadcasterFresh() {
  return scheduleTwitchAutoRefresh('broadcaster', 45 * 60 * 1000);
}
