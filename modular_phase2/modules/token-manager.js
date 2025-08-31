// A:\Charity\modular_phase2\modules\token-manager.js
// Single-app, per-identity token manager for Twitch (bot + broadcaster)

const MIN_REMAINING_S = 600;        // default: refresh when <10m remains (used only if caller doesn't pass a threshold)
const REFRESH_COOLDOWN_MS = 60_000; // don't hammer Twitch if a refresh fails
const _lastAttempt = { bot: 0, broadcaster: 0 };
const _inflight = { bot: null, broadcaster: null };

const ACCESS_ENV  = { bot: 'TWITCH_OAUTH',            broadcaster: 'TWITCH_OAUTH_BROADCASTER' };
const REFRESH_ENV = { bot: 'TWITCH_REFRESH',          broadcaster: 'TWITCH_REFRESH_BROADCASTER' };
const IDENTS = ['bot', 'broadcaster'];

function accessEnvName(id)  { return ACCESS_ENV[id]   || ACCESS_ENV.bot; }
function refreshEnvName(id) { return REFRESH_ENV[id]  || REFRESH_ENV.bot; }

function creds() {
  return {
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
  };
}

export function getAccess(id = 'bot') {
  return process.env[accessEnvName(id)] || '';
}
export function getBearer(id = 'bot') {
  const v = getAccess(id);
  return v?.startsWith('oauth:') ? v.slice(6) : (v || '');
}

function maskToken(access) {
  if (!access) return '';
  const raw = access.startsWith('oauth:') ? access.slice(6) : access;
  return `${raw.slice(0,4)}...${raw.slice(-4)}`;
}

// Validate token: returns expires, login, scopes
export async function validateToken(accessBare) {
  if (!accessBare) return { ok: false, expires_in: 0, scopes: [] };
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessBare}` }
  });
  if (!res.ok) {
    return { ok: false, expires_in: 0, scopes: [], status: res.status };
  }
  const j = await res.json();
  return {
    ok: true,
    expires_in: Number(j.expires_in || 0),
    login: (j.login || '').toLowerCase(),
    client_id: j.client_id,
    scopes: Array.isArray(j.scopes) ? j.scopes : []
  };
}

// Internal: refresh the given identity using the single-app credentials
async function refreshOne(id, logger) {
  const now = Date.now();
  if (now - _lastAttempt[id] < REFRESH_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown' };
  }
  if (_inflight[id]) return _inflight[id];
  _lastAttempt[id] = now;

  const { client_id, client_secret } = creds();
  if (!client_id || !client_secret) {
    logger?.error?.('[token] missing TWITCH_CLIENT_ID/SECRET in environment');
    return { ok: false, reason: 'missing_client_secret' };
  }
  const refresh_token = process.env[refreshEnvName(id)];
  if (!refresh_token) return { ok: false, reason: 'missing_refresh_token' };

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
      const msg = `${res.status} ${text}`;
      if (res.status === 403 && text.includes('invalid client secret')) {
        logger?.error?.(`[token] ${id} refresh failed: invalid client secret (does .env match the app that issued these tokens?)`);
        return { ok: false, reason: 'invalid_client_secret' };
      }
      if (res.status === 400 && text.includes('invalid refresh token')) {
        logger?.error?.(`[token] ${id} refresh failed: invalid refresh token (re-auth needed)`);
        return { ok: false, reason: 'invalid_refresh' };
      }
      logger?.warn?.(`[token] ${id} refresh failed: ${msg}`);
      return { ok: false, reason: 'http_' + res.status };
    }

    const j = JSON.parse(text);
    const access = j.access_token;
    const newRefresh = j.refresh_token || refresh_token;

    // normalize & update env live
    const normAccess = access.startsWith('oauth:') ? access : `oauth:${access}`;
    process.env[accessEnvName(id)]   = normAccess;
    process.env[refreshEnvName(id)]  = newRefresh;

    logger?.info?.(`[token] ${id} refreshed, expires_in=${j.expires_in}s`);
    return { ok: true, access: normAccess, refresh: newRefresh, expires_in: j.expires_in };
  })().finally(() => { _inflight[id] = null; });

  _inflight[id] = p;
  return p;
}

// Public: ensure token is valid and refreshed if it's close to expiry
export async function ensureFresh(identity = 'bot', minSeconds = MIN_REMAINING_S, logger = console) {
  try {
    const bearer = getBearer(identity);
    if (!bearer) {
      logger?.warn?.(`[token] ${identity} has no access token in env; skip preflight`);
      return { ok:false, reason:'no_access' };
    }
    const v = await validateToken(bearer);
    if (!v.ok) {
      logger?.warn?.(`[token] ${identity} validate failed; attempting refresh…`);
      return refreshOne(identity, logger);
    }
    if (Number(v.expires_in || 0) < minSeconds) {
      logger?.info?.(`[token] ${identity} has ${v.expires_in}s left (<${minSeconds}); refreshing…`);
      return refreshOne(identity, logger);
    }
    return { ok:true, reason:'fresh', expires_in: v.expires_in };
  } catch (e) {
    logger?.warn?.(`[token] ${identity} ensureFresh error: ${e?.message || e}`);
    return { ok:false, reason:'exception' };
  }
}

// Convenience: produce the JSON used by tools/token-status.mjs
export async function getSummary(id = 'bot') {
  const access = getAccess(id);
  const bearer = getBearer(id);
  const v = await validateToken(bearer);

  let user_id = null;
  try {
    const cid = process.env.TWITCH_CLIENT_ID || v.client_id;
    if (cid && bearer) {
      const r = await fetch('https://api.twitch.tv/helix/users', {
        headers: { 'Authorization': `Bearer ${bearer}`, 'Client-Id': cid }
      });
      if (r.ok) {
        const j = await r.json();
        user_id = j?.data?.[0]?.id || null;
      }
    }
  } catch (_) {}

  return {
    login: v.login || null,
    user_id,
    scopes: v.scopes || [],
    expires_in_s: v.expires_in ?? 0,
    has_refresh: !!process.env[refreshEnvName(id)],
    access_masked: maskToken(access)
  };
}

// --- preflight + keepalive helpers -----------------------------------------

/** Run a one-shot preflight for bot + broadcaster. */
export async function preflightRefresh(minSeconds = 1800, logger = console) {
  const results = await Promise.allSettled([
    ensureFresh('bot',         minSeconds, logger),
    ensureFresh('broadcaster', minSeconds, logger),
  ]);
  const summary = results.map(r => r.status === 'fulfilled' ? r.value : ({ ok:false, reason:'exception' }));
  logger?.info?.(`[token] preflight: bot=${summary[0]?.reason || (summary[0]?.ok?'ok':'fail')} broad=${summary[1]?.reason || (summary[1]?.ok?'ok':'fail')}`);
  return { bot: summary[0], broadcaster: summary[1] };
}

/** Light keep-alive that checks every 10 minutes and refreshes if <15 min remain. */
export function startKeepAlive(logger = console) {
  const TIMER = 10 * 60 * 1000;
  const THRESH = 15 * 60; // seconds
  clearInterval(globalThis.__charityTokenTimer__);
  globalThis.__charityTokenTimer__ = setInterval(() => {
    ensureFresh('bot', THRESH, logger);
    ensureFresh('broadcaster', THRESH, logger);
  }, TIMER).unref?.();
  logger?.info?.('[token] keep-alive started (10m interval)');
}
