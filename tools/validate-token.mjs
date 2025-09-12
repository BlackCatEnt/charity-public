// tools/validate-token.mjs
import '../modular_phase2/env-bootstrap.js'; // ensure .env loaded from A:\Charity
const tokenRaw = process.env.TWITCH_OAUTH || process.env.OAUTH_TOKEN || '';
if (!tokenRaw) { console.error('No TWITCH_OAUTH or OAUTH_TOKEN set.'); process.exit(1); }

const token = tokenRaw.startsWith('oauth:') ? tokenRaw.slice(6) : tokenRaw;

const res = await fetch('https://id.twitch.tv/oauth2/validate', {
  headers: { Authorization: `OAuth ${token}` }
});
if (!res.ok) {
  console.error('Validate failed:', res.status, await res.text());
  process.exit(2);
}
const info = await res.json();
console.log('Token info:', info);

const required = new Set(['chat:read','chat:edit']);
const have = new Set(info.scopes || []);
const missing = [...required].filter(s => !have.has(s));

if (missing.length) console.error('Missing scopes:', missing.join(', '));

const expectedUser = (process.env.TWITCH_BOT_USERNAME || '').toLowerCase();
const actualUser = (info.login || '').toLowerCase();
if (expectedUser && actualUser && expectedUser !== actualUser) {
  console.error(`Token user mismatch: expected ${expectedUser} but token is for ${actualUser}`);
  process.exitCode = 3;
}
