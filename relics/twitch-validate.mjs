import { getTwitchToken } from '#relics/tokens.mjs';
import { pathToFileURL } from 'node:url';

export async function validateTwitch(kind = 'bot') {
  const tok = await getTwitchToken(kind);
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { 'Authorization': `OAuth ${tok.access_token}` }
  });
  if (!res.ok) throw new Error(`[validate] ${res.status} ${await res.text()}`);
  return res.json(); // {client_id, login, user_id, expires_in, scopes:[...]}
}

// Run when invoked via `node relics/twitch-validate.mjs bot`
const invokedPath = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (invokedPath && import.meta.url === invokedPath) {
  const kind = process.argv[2] || 'bot';
  try {
    const info = await validateTwitch(kind);
    console.log(`[validate:${kind}] login=${info.login} scopes=${(info.scopes||[]).join(',')} expires_in=${info.expires_in}s`);
  } catch (e) {
    console.error('[validate] error:', e.message || e);
    process.exit(1);
  }
}
