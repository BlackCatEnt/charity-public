// token.js
import fs from 'fs';
import axios from 'axios';

const STATE_PATH = './data/token_state.json';

// ---------- State helpers ----------
export function loadTokenState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {
      access_token: '',
      refresh_token: '',
      client_id: '',
      client_secret: '',
      scopes: [],
      expires_at: 0,
      last_refresh_attempt: 0,
    };
  }
}

export function saveTokenState(st) {
  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}

// ---------- Validate current access token ----------
export async function validateToken(accessToken) {
  if (!accessToken) return { ok: false, error: 'No access token' };
  try {
    const { data } = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${accessToken}` },
      timeout: 15000,
    });
    // expires_in is seconds from now
    const seconds = data.expires_in ?? 0;
    const now = Date.now();
    return {
      ok: true,
      login: data.login,
      scopes: data.scopes || [],
      client_id: data.client_id,
      expires_at: now + seconds * 1000,
      minutesRemaining: Math.floor(seconds / 60),
    };
  } catch (e) {
    return { ok: false, error: e?.response?.data || e.message };
  }
}

// ---------- Single-flight refresher (mutex) ----------
let inflightRefresh = null;

/**
 * Refresh a user access token using the stored refresh_token.
 * - Reacts to 401s elsewhere; you can also call proactively.
 * - Ensures only one refresh happens at a time.
 * Twitch requires: POST x-www-form-urlencoded with client_id, client_secret, grant_type=refresh_token, refresh_token (URL-encoded). :contentReference[oaicite:4]{index=4}
 */
export async function refreshToken(stateArg) {
  if (inflightRefresh) return inflightRefresh; // share result

  inflightRefresh = (async () => {
    let state = stateArg || loadTokenState();

    if (!state.refresh_token) {
      inflightRefresh = null;
      return { ok: false, error: 'Missing refresh_token' };
    }
    if (!state.client_id || !state.client_secret) {
      inflightRefresh = null;
      return { ok: false, error: 'Missing client_id/client_secret' };
    }

    try {
      const body = new URLSearchParams({
        client_id: state.client_id,
        client_secret: state.client_secret,
        grant_type: 'refresh_token',
        // URLSearchParams safely URL-encodes the refresh_token as Twitch requires. :contentReference[oaicite:5]{index=5}
        refresh_token: state.refresh_token,
      });

      const { data } = await axios.post(
        'https://id.twitch.tv/oauth2/token',
        body.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 }
      );

      const now = Date.now();
      const expiresIn = data.expires_in ?? 0;

      // Persist BOTH tokens — refresh_token may rotate! :contentReference[oaicite:6]{index=6}
      const next = {
        ...state,
        access_token: data.access_token,
        refresh_token: data.refresh_token || state.refresh_token,
        scopes: data.scope || data.scopes || state.scopes || [],
        expires_at: now + expiresIn * 1000,
        last_refresh_attempt: now,
      };
      saveTokenState(next);
      inflightRefresh = null;
      return { ok: true, state: next };
    } catch (e) {
      inflightRefresh = null;
      return { ok: false, error: e?.response?.data || e.message };
    }
  })();

  return inflightRefresh;
}

// ---------- Optional: Axios instance for Helix with 401->refresh->retry-once ----------
/**
 * Create an axios instance for Twitch Helix that:
 *  - Injects Client-Id and Bearer from current token state.
 *  - On 401: refreshes once (guarded) and retries the request.
 * This implements Twitch’s recommended reactive refresh flow. :contentReference[oaicite:7]{index=7}
 */
export function createTwitchApi() {
  const api = axios.create({
    baseURL: 'https://api.twitch.tv/helix',
    timeout: 20000,
  });

  api.interceptors.request.use((config) => {
    const st = loadTokenState();
    config.headers = {
      ...(config.headers || {}),
      'Client-Id': st.client_id || '',
      'Authorization': st.access_token ? `Bearer ${st.access_token}` : '',
    };
    return config;
  });

  api.interceptors.response.use(
    (res) => res,
    async (error) => {
      const { response, config } = error || {};
      if (!response || response.status !== 401 || config?._retry) {
        throw error;
      }
      // mark & refresh once
      config._retry = true;
      const st = loadTokenState();
      const r = await refreshToken(st);
      if (!r.ok) throw error;
      // retry with new token
      const fresh = loadTokenState();
      config.headers = {
        ...(config.headers || {}),
        'Client-Id': fresh.client_id || '',
        'Authorization': fresh.access_token ? `Bearer ${fresh.access_token}` : '',
      };
      return api.request(config);
    }
  );

  return api;
}

// ---------- Status helper (for logs/whispers) ----------
export function getTokenStatus() {
  const st = loadTokenState();
  const now = Date.now();
  const minutes = st.expires_at ? Math.max(0, Math.round((st.expires_at - now) / 60000)) : null;
  return {
    hasAccess: !!st.access_token,
    hasRefresh: !!st.refresh_token,
    minutesRemaining: minutes,
    clientType: 'unknown (ensure Confidential in app settings if possible)', // See docs re: Public vs Confidential. :contentReference[oaicite:8]{index=8}
  };
}
