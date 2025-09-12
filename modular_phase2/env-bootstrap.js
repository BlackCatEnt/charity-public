// modular_phase2/env-bootstrap.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Project root is one level up from modular_phase2/
const ROOT = path.resolve(__dirname, '..');
process.env.CHARITY_ROOT = process.env.CHARITY_ROOT || ROOT;

// Prefer .env in project root (A:\Charity\.env)
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`✅ Loaded .env from ${envPath}`);
} else {
  dotenv.config(); // last-resort defaults
  console.warn('⚠️ No .env at project root; loaded defaults if present');
}

// Normalize important vars
function coalesce(...vars) {
  for (const v of vars) if (v && String(v).trim()) return String(v).trim();
  return '';
}

process.env.TWITCH_BOT_USERNAME = coalesce(
  process.env.TWITCH_BOT_USERNAME,
  process.env.BOT_USER,
  'charity_the_adventurer'
);

process.env.TWITCH_CHANNEL = coalesce(
  process.env.TWITCH_CHANNEL,
  process.env.CHANNEL,
  'bagotrix'
);

// Accept either TWITCH_OAUTH or OAUTH_TOKEN; don’t force prefix here
process.env.TWITCH_OAUTH = coalesce(process.env.TWITCH_OAUTH, process.env.OAUTH_TOKEN, '');

export function assertRequiredEnv() {
  const missing = [];
  if (!process.env.TWITCH_BOT_USERNAME) missing.push('TWITCH_BOT_USERNAME');
  if (!process.env.TWITCH_CHANNEL)      missing.push('TWITCH_CHANNEL');
  if (!process.env.TWITCH_OAUTH)        missing.push('TWITCH_OAUTH (or OAUTH_TOKEN)');

  if (missing.length) {
    throw new Error('Missing required env: ' + missing.join(', '));
  }
}

export const CHARITY_ROOT = ROOT;
