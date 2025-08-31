// A:\Charity\tools\token-status.mjs
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// NOTE: this relative path is from /tools -> /modular_phase2/modules
import {
  preflightRefresh,
  getSummary,
} from '../modular_phase2/modules/token-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Load .env from likely places (prints once per hit)
function loadEnvAt(p) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    console.log(`✅ Loaded .env from ${p}`);
    return true;
  }
  return false;
}
[
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '..', '.env'),
  'A:\\Charity\\.env',
].forEach(loadEnvAt);

// Make sure tokens are fresh (refresh if <30m remain)
await preflightRefresh(1800, console).catch(() => {});

// Now summarize both identities
const bot = await getSummary('bot');
const broadcaster = await getSummary('broadcaster');

console.log(JSON.stringify({ bot, broadcaster }, null, 2));
