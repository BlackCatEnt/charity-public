import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export function loadConfig() {
  // Optional explicit override
  const envPath = process.env.CHARITY_CONFIG_PATH && process.env.CHARITY_CONFIG_PATH.trim();

  const candidates = [
    envPath && path.resolve(envPath),
    // Common root locations
    path.resolve(process.cwd(), 'charity-config.json'),
    path.resolve(process.cwd(), 'config', 'charity-config.json'),
    // When started from modular_phase2/
    path.resolve(__dirname, '../../config/charity-config.json'),
    // If a copy exists next to modular files
    path.resolve(__dirname, '../config/charity-config.json')
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        Object.defineProperty(cfg, '__path', { value: p, enumerable: false });
        return cfg;
      }
    } catch {
      /* ignore and try next */
    }
  }

  // Safe defaults so addressing/signature keep working (same as your current fallback)
  const fallback = {
    style: {
      lexicon: {
        mention_style: 'role+mention',
        address_by_role: { broadcaster: 'Guild Master' },
        signature: '✧'
      }
    }
  };
  Object.defineProperty(fallback, '__path', { value: '(default)', enumerable: false });
  return fallback;
}
