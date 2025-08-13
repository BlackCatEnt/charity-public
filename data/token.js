import fs from 'fs';
import path from 'path';
import axios from 'axios';

const DATA_DIR = path.resolve('./data');
const TOKEN_FILE = path.join(DATA_DIR, 'token.json');

function ensureDataDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

export function loadTokenState() {
  ensureDataDir();
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch {}
  const envAccess   = process.env.TWITCH_OAUTH || stored.access_token || '';
  const envRefresh  = process.env.TWITCH_REFRESH || stored.refresh_token || '';
  const clientId    = process.env.TWITCH_CLIENT_ID || stored.client_id || '';
  const clientSecret= process.env.TWITCH_CLIENT_SECRET || stored.client_secret || '';
  return {
    access_token: envAccess.replace(/^oauth:/i, ''),
    refresh_token: envRefresh,
    client_id: clientId,
    client_secret: clientSecret,
    expires_at: stored.expires_at || null,
    last_refresh_attempt: stored.last_refresh_attempt || null,
    last_refresh_success: stored.last_refresh_success || null
  };
}

export function saveTokenState(state) {
  ensureDataDir();
  const toSave = {
    access_token: state.access_token || '',
    refresh_token: state.refresh_token || '',
    client_id: state.client_id || '',
    client_secret: state.client_secret || '',
    expires_at: state.expires_at || null,
    last_refresh_attempt: state.last_refresh_attempt || null,
    last_refresh_success: state.last_refresh_success || null
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(toSave, null, 2));
}

export async function validateToken(accessToken) {
  try {
    const { data } = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${accessToken}` }, timeout: 15000
    });
    const minutes = Math.floor((data.expires_in || 0) / 60);
    const expires_at = Date.now() + (data.expires_in || 0) * 1000;
    return { ok: true, minutesRemaining: minutes, expires_at, login: data.login, client_id: data.client_id, scopes: data.scopes || [] };
  } catch (e) {
    return { ok: false, error: e?.response?.data || e?.message || 'validate_failed' };
  }
}

export async function refreshToken(state) {
  const { client_id, client_secret, refresh_token } = state;
  if (!client_id || !client_secret || !refresh_token) {
    return { ok: false, error: 'missing_client_or_refresh' };
  }
  try {
    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refresh_token);
    params.set('client_id', client_id);
    params.set('client_secret', client_secret);
    const { data } = await axios.post('https://id.twitch.tv/oauth2/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000
    });
    const expires_at = Date.now() + (data.expires_in || 0) * 1000;
    const next = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refresh_token,
      client_id,
      client_secret,
      expires_at,
      last_refresh_attempt: Date.now(),
      last_refresh_success: Date.now()
    };
    saveTokenState(next);
    return { ok: true, state: next };
  } catch (e) {
    const now = Date.now();
    const copy = { ...state, last_refresh_attempt: now };
    saveTokenState(copy);
    return { ok: false, error: e?.response?.data || e?.message || 'refresh_failed' };
  }
}

export function getTokenStatus() {
  const st = loadTokenState();
  let minutesRemaining = null;
  if (st.expires_at) minutesRemaining = Math.round((st.expires_at - Date.now())/60000);
  return { valid: !!st.access_token, expiresAt: st.expires_at || null, minutesRemaining };
}
