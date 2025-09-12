// Single-app, per-identity token manager for Twitch (bot + broadcaster)
import 'dotenv/config';

const MIN_REMAINING_S = 600;        // refresh when <10m remain unless caller passes a lower/higher threshold
const REFRESH_COOLDOWN_MS = 60_000; // don't hammer Twitch if a refresh fails

const ACCESS_ENV  = { bot: 'TWITCH_OAUTH',            broadcaster: 'TWITCH_OAUTH_BROADCASTER' };
const REFRESH_ENV = { bot: 'TWITCH_REFRESH',          broadcaster: 'TWITCH_REFRESH_BROADCASTER' };
const IDENTS = ['bot', 'broadcaster'];

const _lastAttempt = { bot: 0, broadcaster: 0 };
const _inflight    = { bot: null, broadcaster: null };

function accessEnvName(id)  { return ACCESS_ENV[id]  || ACCESS_ENV.bot; }
function refreshEnvName(id) { return REFRESH_ENV[id] || REFRESH_ENV.bot; }

function creds() {
  return {
    client_id:     process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
  };
}

// ---------- low-level helpers ----------

/** Returns whatever is in env (may be bare or "oauth:..."). */
export function getAccess(id = 'bot') {
  const name = accessEnvName(id);
  return process.env[name] || '';
}

/** Returns the bare bearer value (no 'oauth:' prefix). */
export function getBearer(id = 'bot') {
  const raw = getAccess(id);
  if (!raw) return '';
  return raw.startsWith('oauth:') ? raw.slice(6) : raw;
}

/** Set access/refresh into process.env (normalizes access to "oauth:..."). */
export function setAccess(id = 'bot', access, refresh) {
  const nameA = accessEnvName(id);
  const nameR = refreshEnvName(id);
  const norm  = access ? (access.startsWith('oauth:') ? access : `oauth:${access}`) : '';
  if (norm)    process.env[nameA] = norm;
  if (refresh) process.env[nameR] = refresh;
  return { access: norm, refresh };
}

function maskToken(t) {
  if (!t) return '';
  const raw = t.startsWith('oauth:') ? t.slice(6) : t;
  if (!raw) return '';
  return `${raw.slice(0,4)}...${raw.slice(-4)}`;
}

// ---------- validation / refresh ----------

export async function validateToken(bearerBare) {
  if (!bearerBare) return { ok:false, expires_in:0, scopes:[] };
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${bearerBare}` }
  });
  if (!res.ok) return { ok:false, expires_in:0, scopes:[], status:res.status };
  const j = await res.json();
  return {
    ok: true,
    login: (j.login || '').toLowerCase(),
    client_id: j.client_id,
    scopes: Array.isArray(j.scopes) ? j.scopes : [],
    expires_in: Number(j.expires_in || 0),
  };
}

async function refreshOne(id, logger = console) {
  const now = Date.now();
  if (now - _lastAttempt[id] < REFRESH_COOLDOWN_MS) {
    return { ok:false, reason:'cooldown' };
  }
  if (_inflight[id]) return _inflight[id];
  _lastAttempt[id] = now;

  const { client_id, client_secret } = creds();
  if (!client_id || !client_secret) {
    logger?.error?.('[token] missing TWITCH_CLIENT_ID/SECRET in env');
    return { ok:false, reason:'missing_client_secret' };
  }
  const refresh_token = process.env[refreshEnvName(id)];
  if (!refresh_token) {
    logger?.warn?.(`[token] ${id} has no refresh token in env`);
    return { ok:false, reason:'missing_refresh' };
  }

  const body = new URLSearchParams({
    client_id, client_secret, grant_type: 'refresh_token', refresh_token
  });

  const p = (async () => {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 403 && /invalid client secret/i.test(text)) {
        logger?.error?.(`[token] ${id} refresh failed: invalid client secret (does .env match the app that issued these tokens?)`);
        return { ok:false, reason:'invalid_client_secret' };
      }
      if (res.status === 400 && /invalid refresh token/i.test(text)) {
        logger?.error?.(`[token] ${id} refresh failed: invalid refresh token (re-auth needed)`);
        return { ok:false, reason:'invalid_refresh' };
      }
      logger?.warn?.(`[token] ${id} refresh failed: ${res.status} ${text}`);
      return { ok:false, reason:`http_${res.status}` };
    }

    const j = JSON.parse(text);
    const access     = j.access_token;
    const newRefresh = j.refresh_token || refresh_token;
    setAccess(id, access, newRefresh);
    logger?.info?.(`[token] ${id} refreshed, expires_in=${j.expires_in}s`);
    return { ok:true, access, refresh:newRefresh, expires_in:j.expires_in };
  })().finally(() => { _inflight[id] = null; });

  _inflight[id] = p;
  return p;
}

/** Ensure token is valid and optionally refresh if it's close to expiry. */
export async function ensureFresh(id = 'bot', minSeconds = MIN_REMAINING_S, logger = console) {
  try {
    const bearer = getBearer(id);
    if (!bearer) {
      logger?.warn?.(`[token] ${id} has no access token in env; skip preflight`);
      return { ok:false, reason:'no_access' };
    }
    const v = await validateToken(bearer);
    if (!v.ok) {
      logger?.warn?.(`[token] ${id} validate failed; attempting refresh…`);
      return refreshOne(id, logger);
    }
    if (Number(v.expires_in || 0) < minSeconds) {
      logger?.info?.(`[token] ${id} has ${v.expires_in}s left (<${minSeconds}); refreshing…`);
      return refreshOne(id, logger);
    }
    return { ok:true, reason:'fresh', expires_in: v.expires_in };
  } catch (e) {
    logger?.warn?.(`[token] ${id} ensureFresh error: ${e?.message || e}`);
    return { ok:false, reason:'exception' };
  }
}

/** IRC password for tmi.js (always returns "oauth:..."). */
export async function getIrcPassword(logger = console, minSeconds = 900) {
  try {
    await ensureFresh('bot', minSeconds, logger).catch(() => {});
    const tok = getAccess('bot');
    if (!tok) throw new Error('no bot access token in env');
    return tok.startsWith('oauth:') ? tok : `oauth:${tok}`;
  } catch (e) {
    logger?.warn?.(`[token] getIrcPassword failed: ${e?.message || e}`);
    const fallback = process.env.TWITCH_OAUTH || '';
    return fallback && fallback.startsWith('oauth:') ? fallback : (fallback ? `oauth:${fallback}` : '');
  }
}

// ---------- status helpers ----------

export async function getSummary(id = 'bot') {
  const access = getAccess(id);
  const bearer = getBearer(id);
  const v      = await validateToken(bearer);

  let user_id = null;
  try {
    const cid = process.env.TWITCH_CLIENT_ID || v.client_id || '';
    if (cid && bearer) {
      const r = await fetch('https://api.twitch.tv/helix/users', {
        headers: { 'Authorization': `Bearer ${bearer}`, 'Client-Id': cid }
      });
      if (r.ok) {
        const j = await r.json();
        user_id = j?.data?.[0]?.id || null;
      }
    }
  } catch {}

  return {
    login: v.login || null,
    user_id,
    scopes: v.scopes || [],
    expires_in_s: v.expires_in ?? 0,
    has_refresh: !!process.env[refreshEnvName(id)],
    access_masked: maskToken(access),
  };
}

// ---------- preflight + keepalive ----------

export async function preflightRefresh(minSeconds = 1800, logger = console) {
  const results = await Promise.allSettled([
    ensureFresh('bot',         minSeconds, logger),
    ensureFresh('broadcaster', minSeconds, logger),
  ]);
  const ok = i => results[i].status === 'fulfilled' ? (results[i].value.ok ? (results[i].value.reason || 'ok') : (results[i].value.reason || 'fail')) : 'exception';
  logger?.info?.(`[token] preflight: bot=${ok(0)} broad=${ok(1)}`);
  return { bot: results[0], broadcaster: results[1] };
}

export function startKeepAlive(logger = console) {
  const TIMER = 10 * 60 * 1000;  // 10 min
  const THRESH = 15 * 60;        // refresh if <15m left
  clearInterval(globalThis.__charityTokenTimer__);
  globalThis.__charityTokenTimer__ = setInterval(() => {
    ensureFresh('bot', THRESH, logger);
    ensureFresh('broadcaster', THRESH, logger);
  }, TIMER).unref?.();
  logger?.info?.('[token] keep-alive started (10m interval)');
}
