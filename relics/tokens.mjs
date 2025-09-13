import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { access, constants as FS } from 'node:fs';
import { join } from 'node:path';

const STORE_DIR = 'soul/cache/tokens';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

async function ensureDir(p) { try { await mkdir(p, { recursive: true }); } catch {} }
async function exists(p){ try{ await access(p, FS.F_OK); return true;}catch{return false;} }

async function readJson(p){ return JSON.parse(await readFile(p,'utf8')); }
async function writeJson(p, obj){ await ensureDir(STORE_DIR); await writeFile(p, JSON.stringify(obj,null,2)); }

function now(){ return Date.now(); }
function willExpireSoon(expires_at, skewMs=10*60*1000){ return !expires_at || (expires_at - now() < skewMs); }

const fileFor = (name) => join(STORE_DIR, `${name}.json`);

export async function getTwitchToken(name='bot'){
  // Priority: cache file → env (one-shot import)
  const f = fileFor(name);
  let rec = (await exists(f)) ? await readJson(f) : null;

  if(!rec){
    // try one-time import from envs
    const accEnv = process.env[name === 'bot' ? 'TWITCH_BOT_OAUTH' : 'TWITCH_BROADCASTER_OAUTH'];
    const refEnv = process.env[name === 'bot' ? 'TWITCH_BOT_REFRESH' : 'TWITCH_BROADCASTER_REFRESH'];
    if(accEnv){
      rec = {
        access_token: accEnv.replace(/^oauth:/,''),
        refresh_token: refEnv || null,
        scope: [],
        // assume 3h validity if unknown; will refresh if refresh_token present
        expires_at: now() + 3*60*60*1000
      };
      await writeJson(f, rec);
    }else{
      throw new Error(`[tokens] no token for ${name}; set .env or place ${f}`);
    }
  }

  // refresh if we can and it’s expiring soon
  if(rec.refresh_token && willExpireSoon(rec.expires_at)){
    rec = await refreshTwitch(name, rec);
    await writeJson(f, rec);
  }

  return rec;
}

export async function refreshTwitch(name, rec){
  const client_id = process.env.TWITCH_CLIENT_ID;
  const client_secret = process.env.TWITCH_CLIENT_SECRET;
  if(!client_id || !client_secret) throw new Error('[tokens] missing TWITCH_CLIENT_ID/SECRET for refresh');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: rec.refresh_token,
    client_id,
    client_secret
  });

  const res = await fetch(TWITCH_TOKEN_URL, { method:'POST', body: params });
  if(!res.ok){
    throw new Error(`[tokens] refresh failed for ${name}: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const expires_at = now() + (json.expires_in ?? 3600)*1000;

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? rec.refresh_token,
    scope: json.scope ?? rec.scope ?? [],
    expires_at
  };
}

// background refresher (call once at boot if you want)
export function scheduleTwitchAutoRefresh(name='bot', everyMs=60*60*1000){
  let timer = setInterval(async () => {
    try {
      const f = fileFor(name);
      if(!(await exists(f))) return;
      const rec = await readJson(f);
      if(rec.refresh_token && willExpireSoon(rec.expires_at)) {
        const upd = await refreshTwitch(name, rec);
        await writeJson(f, upd);
        console.log(`[tokens] refreshed ${name} until ${new Date(upd.expires_at).toISOString()}`);
      }
    } catch (e) { console.warn('[tokens] auto-refresh error:', e.message); }
  }, everyMs);
  return () => clearInterval(timer);
}
