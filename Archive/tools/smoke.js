// tools/smoke.js — verbose smoke to diagnose early exits

console.log('[smoke] starting', { cwd: process.cwd(), node: process.version });

process.on('unhandledRejection', (e) => {
  console.error('[smoke] unhandledRejection:', e?.stack || e);
  process.exitCode = 13;
});
process.on('uncaughtException', (e) => {
  console.error('[smoke] uncaughtException:', e?.stack || e);
  process.exit(14);
});
process.on('exit', (code) => {
  console.log('[smoke] exiting with code', code);
});

let tmi;
try {
  tmi = (await import('tmi.js')).default ?? (await import('tmi.js'));
  console.log('[smoke] tmi loaded ok');
} catch (e) {
  console.error('[smoke] failed to load tmi.js:', e?.message || e);
  process.exit(21);
}

let envLoaded = false;
try {
  const envBoot = await import('../modular_phase2/env-bootstrap.js');
  if (envBoot?.assertRequiredEnv) envBoot.assertRequiredEnv();
  envLoaded = true;
  console.log('[smoke] env-bootstrap loaded');
} catch (e) {
  console.warn('[smoke] env-bootstrap not loaded (OK):', e?.message || e);
}

const CHANNEL      = (process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
const BOT_USERNAME = (process.env.TWITCH_BOT_USERNAME || 'charity_the_adventurer').toLowerCase();
let OAUTH          = process.env.TWITCH_OAUTH || process.env.OAUTH_TOKEN;

console.log('[smoke] env snapshot', {
  CHANNEL,
  BOT_USERNAME,
  hasToken: Boolean(OAUTH),
  envBoot: envLoaded
});

if (!OAUTH) {
  console.error('[smoke] Missing TWITCH_OAUTH (or OAUTH_TOKEN).');
  process.exit(1);
}
if (!OAUTH.startsWith('oauth:')) OAUTH = 'oauth:' + OAUTH;

const client = new tmi.Client({
  connection: { reconnect: true, secure: true },
  identity: { username: BOT_USERNAME, password: OAUTH },
  channels: [ `#${CHANNEL}` ]
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let joined = false;

client.on('connected', (addr, port) => console.log('[smoke] connected', { addr, port }));
client.on('join', (ch, user, self) => {
  if (self) { joined = true; console.log('[smoke] joined', ch); }
});
client.on('disconnected', (reason) => console.warn('[smoke] disconnected:', reason));

(async () => {
  try {
    console.log('[smoke] connecting…');
    await client.connect();
  } catch (e) {
    console.error('[smoke] connect failed:', e?.message || e);
    process.exit(2);
  }

  await sleep(5000);
  if (!joined) {
    console.error('[smoke] did not join within 5s (check token/channel/permissions).');
    try { await client.disconnect(); } catch {}
    process.exit(3);
  }

  try {
    await client.say(`#${CHANNEL}`, `[smoke] hello ${Date.now()}`);
    console.log('[smoke] sent test message');
  } catch (e) {
    console.warn('[smoke] send failed:', e?.message || e);
  }

  try { await client.disconnect(); } catch {}
  console.log('[smoke] PASS');
  process.exit(0);
})();
