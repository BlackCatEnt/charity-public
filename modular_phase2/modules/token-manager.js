// modules/token-manager.js
// Manages bot & broadcaster tokens, validates/refreshes, persists to data/token_state.json

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.CHARITY_ROOT || path.resolve(process.cwd());
const STATE_PATH = path.join(ROOT, 'data', 'token_state.json');

const CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

const now = () => Date.now();
const SECS = (n) => n * 1000;
const EXP_SOON_BUFFER = SECS(90); // refresh ~90s before expiry

const kinds = /** @type {const} */ (['bot','broadcaster']);
const ENV_TOKEN = { bot: 'TWITCH_OAUTH', broadcaster: 'TWITCH_OAUTH_BROADCASTER' };
const ENV_REFRESH = { bot: 'TWITCH_REFRESH', broadcaster: 'TWITCH_REFRESH_BROADCASTER' };

async function readState() {
  try {
    const txt = await fs.readFile(STATE_PATH, 'utf8');
    return JSON.parse(txt);
  } catch {
    return { bot: {}, broadcaster: {} };
  }
}
async function writeState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function validateToken(accessToken) {
  const tok = accessToken.startsWith('oauth:') ? accessToken.slice(6) : accessToken;
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${tok}` }
  });
  if (!res.ok) throw new Error(`validate failed: ${res.status}`);
  return res.json();
}

async function refreshWith(refreshToken) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: params });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`refresh failed: ${res.status} ${t}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

function mask(s='') {
  if (!s) return '';
  const raw = s.startsWith('oauth:') ? s.slice(6) : s;
  return raw.slice(0,4) + '...' + raw.slice(-4);
}

export async function getAccessToken(kind /** 'bot'|'broadcaster' */) {
  if (!kinds.includes(kind)) throw new Error(`unknown token kind: ${kind}`);
  const state = await readState();
  const slot = state[kind] || (state[kind] = {});

  // Load from env if no state yet
  if (!slot.access_token) {
    const envTok = process.env[ENV_TOKEN[kind]] || '';
    if (envTok) slot.access_token = envTok;
  }
  if (!slot.refresh_token) {
    const envRef = process.env[ENV_REFRESH[kind]] || '';
    if (envRef) slot.refresh_token = envRef;
  }

  // Validate if we don't know expiry or it's soon/expired
  let mustValidate = !slot.expires_at || (slot.expires_at - now() < EXP_SOON_BUFFER);

  if (slot.access_token && mustValidate) {
    try {
      const info = await validateToken(slot.access_token);
      // Compute new expiry timestamp, with a small buffer
      slot.user_id = info.user_id;
      slot.login = info.login;
      slot.scopes = info.scopes || [];
      slot.expires_at = now() + SECS(info.expires_in || 0);
      mustValidate = false;
    } catch {
      // invalid token; try refresh below
      mustValidate = true;
    }
  }

  // Refresh if invalid/expired or expires very soon
  if ((!slot.expires_at || slot.expires_at - now() < EXP_SOON_BUFFER) && slot.refresh_token) {
    try {
      const out = await refreshWith(slot.refresh_token);
      slot.access_token = 'oauth:' + out.access_token;
      slot.refresh_token = out.refresh_token || slot.refresh_token; // twitch may rotate
      slot.expires_at = now() + SECS(out.expires_in || 0);
      const info = await validateToken(slot.access_token);
      slot.user_id = info.user_id; slot.login = info.login; slot.scopes = info.scopes || [];
      await writeState(state);
	  logger.info(`[token] refreshing ${kind} with client_id=${CLIENT_ID?.slice(0,8)}…`);
    } catch (e) {
      console.warn(`[token] ${kind} refresh failed: ${e.message}`);
      // keep going; caller may decide to proceed or error
    }
  } else {
    await writeState(state);
  }

  if (!slot.access_token) {
    throw new Error(`[token] no ${kind} access token configured. Set ${ENV_TOKEN[kind]} in .env or add to ${STATE_PATH}`);
  }
  return slot.access_token.startsWith('oauth:') ? slot.access_token.slice(6) : slot.access_token;
}

export async function getBearer(kind) {
  const tok = await getAccessToken(kind);
  return `Bearer ${tok}`;
}

export async function getSummary() {
  const s = await readState();
  const out = {};
  for (const k of kinds) {
    const t = s[k] || {};
    out[k] = {
      login: t.login || null,
      user_id: t.user_id || null,
      scopes: t.scopes || [],
      expires_in_s: t.expires_at ? Math.max(0, Math.floor((t.expires_at - now())/1000)) : null,
      has_refresh: Boolean(t.refresh_token),
      access_masked: mask(t.access_token || '')
    };
  }
  return out;
}

// --- add to token-manager.js ---
export function startKeepAlive({ intervalMs = 60_000, logger = console } = {}) {
  let timer = null;
  const tick = async () => {
    for (const kind of ['bot','broadcaster']) {
      try {
        await getAccessToken(kind); // validates/refreshes if needed
      } catch (e) {
        logger.warn(`[token] keepalive ${kind}: ${e?.message || e}`);
      }
    }
  };
  tick(); // run once immediately
  timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
