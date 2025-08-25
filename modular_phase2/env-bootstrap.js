// data/env-bootstrap.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const candidates = [
  'C:\\twitch-bot\\Charity\\.env',         // project root (Windows absolute)
  path.join(__dirname, '..', '.env'),      // project root relative to /data
  path.join(__dirname, '.env')             // .env inside /data
];

let loadedFrom = null;
for (const p of candidates) {
  try {
    if (fs.existsSync(p)) {
      const r = dotenv.config({ path: p });
      if (!r.error) { loadedFrom = p; break; }
    }
  } catch {}
}

// Fallback to default cwd search if nothing matched
if (!loadedFrom) {
  const r = dotenv.config();
  if (!r.error) loadedFrom = '(process cwd)';
}

// Show a check if critical keys exist
const ok = !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET && process.env.TWITCH_OAUTH);
const mark = ok ? '✅' : '⚠️';
const msg  = ok ? `Loaded .env from ${loadedFrom}` : `Env not complete (${loadedFrom || 'not found'})`;
console.log(`${mark} ${msg}`);

// Optional hard check
export function assertRequiredEnv() {
  const required = ['TWITCH_CHANNEL','TWITCH_BOT_USERNAME','TWITCH_OAUTH','TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET'];
  const missing = required.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
  if (missing.length) {
    const hint = 'Missing required env vars: ' + missing.join(', ') + '. Check .env (see .env.example).';
    console.error(hint);
    throw new Error(hint);
  }
}
