// Refresh Twitch tokens on demand (bot/broadcaster/both) and update .env
// Usage:
//   node tools/token-refresh.mjs             # refresh both
//   node tools/token-refresh.mjs bot        # refresh bot only
//   node tools/token-refresh.mjs broadcaster# refresh broadcaster only

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// --- env loading (best-effort) ---
const ENV_CANDIDATES = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '..', '.env'),
  'A:\\Charity\\.env'
];

function loadEnvAt(p) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    console.log(`✅ Loaded .env from ${p}`);
    return true;
  }
  return false;
}
ENV_CANDIDATES.forEach(loadEnvAt);

// --- helpers ---
function envNames(id) {
  return id === 'broadcaster'
    ? { ACCESS: 'TWITCH_OAUTH_BROADCASTER', REFRESH: 'TWITCH_REFRESH_BROADCASTER' }
    : { ACCESS: 'TWITCH_OAUTH',            REFRESH: 'TWITCH_REFRESH' };
}
function mask(s = '') {
  const raw = s.startsWith('oauth:') ? s.slice(6) : s;
  if (!raw) return '';
  if (raw.length < 8) return '********';
  return `${raw.slice(0,4)}...${raw.slice(-4)}`;
}

// Update or add KEY=value lines in .env
function updateEnvFiles(updates) {
  const targets = ENV_CANDIDATES.filter(p => p && (p.endsWith('.env')));
  const unique = [...new Set(targets)];
  if (unique.length === 0) unique.push('A:\\Charity\\.env');

  for (const file of unique) {
    let lines = [];
    if (fs.existsSync(file)) {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    }
    const keys = Object.keys(updates);
    const seen = new Set();
    lines = lines.map(line => {
      for (const k of keys) {
        if (line.startsWith(`${k}=`)) {
          seen.add(k);
          return `${k}=${updates[k]}`;
        }
      }
      return line;
    });
    for (const k of keys) {
      if (!seen.has(k)) lines.push(`${k}=${updates[k]}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    console.log(`📝 Updated ${file}`);
  }
}

// Validate to show scopes/login/expires
async function validate(access) {
  if (!access) return { ok:false, expires_in:0, scopes:[] };
  const token = access.startsWith('oauth:') ? access.slice(6) : access;
  const r = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${token}` }
  });
  if (!r.ok) return { ok:false, expires_in:0, scopes:[] };
  const j = await r.json();
  return {
    ok: true,
    login: (j.login || '').toLowerCase(),
    expires_in: Number(j.expires_in || 0),
    scopes: Array.isArray(j.scopes) ? j.scopes : [],
    client_id: j.client_id
  };
}

async function refreshOne(id) {
  const { ACCESS, REFRESH } = envNames(id);
  const client_id = process.env.TWITCH_CLIENT_ID;
  const client_secret = process.env.TWITCH_CLIENT_SECRET;
  const refresh_token = process.env[REFRESH];

  if (!client_id || !client_secret) {
    throw new Error('Missing TWITCH_CLIENT_ID/SECRET in environment.');
  }
  if (!refresh_token) {
    throw new Error(`Missing ${REFRESH} for ${id}.`);
  }

  const body = new URLSearchParams({
    client_id, client_secret, grant_type: 'refresh_token', refresh_token
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type':'application/x-www-form-urlencoded' }, body
  });
  const text = await res.text();

  if (!res.ok) {
    if (res.status === 403 && text.includes('invalid client secret')) {
      throw new Error(`[${id}] 403 invalid client secret — make sure your .env secret matches the app that issued these refresh tokens.`);
    }
    if (res.status === 400 && text.includes('invalid refresh token')) {
      throw new Error(`[${id}] 400 invalid refresh token — re-auth that identity via Twitch CLI to obtain a new refresh token.`);
    }
    throw new Error(`[${id}] ${res.status} ${text}`);
  }

  const j = JSON.parse(text);
  const access  = j.access_token;
  const newRef  = j.refresh_token || refresh_token;
  const oauth   = access.startsWith('oauth:') ? access : `oauth:${access}`;

  // write back to env
  updateEnvFiles({ [ACCESS]: oauth, [REFRESH]: newRef });

  // update current process env
  process.env[ACCESS] = oauth;
  process.env[REFRESH] = newRef;

  // validate so we can show scopes/login/expires
  const v = await validate(oauth);
  return {
    id,
    ok: true,
    login: v.login || null,
    expires_in_s: v.expires_in || j.expires_in || null,
    scopes: v.scopes || [],
    access_masked: mask(oauth)
  };
}

async function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  const list = (arg === 'bot' || arg === 'broadcaster') ? [arg] : ['bot','broadcaster'];

  const out = {};
  for (const id of list) {
    try {
      out[id] = await refreshOne(id);
    } catch (e) {
      out[id] = { id, ok:false, error: String(e?.message || e) };
    }
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => {
  console.error(e?.stack || e);
  process.exit(1);
});
