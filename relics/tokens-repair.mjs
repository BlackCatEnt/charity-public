import 'dotenv/config';
import { getTwitchToken, refreshTwitch } from '#relics/tokens.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const STORE = 'soul/cache/tokens';
async function save(kind, rec) {
  const p = `${STORE}/${kind}.json`;
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(rec, null, 2), 'utf8');
}

async function validate(accessToken) {
  const r = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` }
  });
  return { ok: r.ok, status: r.status, text: await r.text().catch(()=> '') };
}

const kind = process.argv[2] || 'bot';

try {
  const rec = await getTwitchToken(kind);
  const v1 = await validate(rec.access_token);
  if (v1.ok) {
    console.log(`[repair:${kind}] token valid; no action needed.`);
    process.exit(0);
  }
  console.log(`[repair:${kind}] validate=${v1.status} ${v1.text}`);
  if (!rec.refresh_token) throw new Error(`no refresh token for ${kind}; set TWITCH_${kind.toUpperCase()}_REFRESH`);
  const upd = await refreshTwitch(kind, rec);
  await save(kind, upd);
  const v2 = await validate(upd.access_token);
  if (!v2.ok) throw new Error(`refresh failed second validate: ${v2.status} ${v2.text}`);
  console.log(`[repair:${kind}] refreshed; good until ${new Date(upd.expires_at).toISOString()}`);
  process.exit(0);
} catch (e) {
  console.error('[repair] error:', e.message || e);
  process.exit(1);
}
