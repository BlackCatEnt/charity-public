// Load env first (prints ✅ if OK)
import './env-bootstrap.js';
import { assertRequiredEnv } from './env-bootstrap.js';
assertRequiredEnv();

// Path helpers (needed for __dirname and KB path)
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

import fs from 'fs';
import axios from 'axios';
import chokidar from 'chokidar';
import winston from 'winston';
import tmi from 'tmi.js';

import { loadTokenState, validateToken, refreshToken, saveTokenState, getTokenStatus } from './token.js';

// --- Env basics (order matters) ---
const CHANNEL       = (process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
const BOT_USERNAME  = (process.env.TWITCH_BOT_USERNAME || 'charity_the_adventurer').toLowerCase();
const BROADCASTER   = (process.env.TWITCH_BROADCASTER || CHANNEL).toLowerCase();

// --- Token monitor knobs ---
const TOKEN_ALERT_MIN        = parseInt(process.env.TOKEN_ALERT_MINUTES || '15', 10);
const TOKEN_CHECK_EVERY_MIN  = parseInt(process.env.TOKEN_CHECK_INTERVAL_MINUTES || '10', 10);
const REFRESH_COOLDOWN_MIN   = parseInt(process.env.REFRESH_COOLDOWN_MINUTES || '180', 10);
const MIN_GAIN_MINUTES       = parseInt(process.env.MIN_TOKEN_GAIN_MINUTES || '20', 10);

// OAuth (tmi.js wants "oauth:<token>")
let OAUTH = process.env.TWITCH_OAUTH || '';
if (OAUTH && !OAUTH.startsWith('oauth:')) OAUTH = `oauth:${OAUTH}`;

const OLLAMA    = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'llama3.1:8b-instruct-q4_K_M';

// Guard (we also assertRequiredEnv above; this keeps the legacy behavior)
if (!CHANNEL || !BOT_USERNAME || !OAUTH) {
  console.error('Missing required env vars. See .env.example');
  process.exit(1);
}

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: './logs/bot.log' }),
    new winston.transports.Console()
  ]
});

// Load KB index
let KB = { docs: [] };
const KB_PATH = path.resolve('./data/kb_index.json');
function loadKB() {
  try {
    KB = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    logger.info(`KB loaded: ${KB.docs.length} chunks`);
  } catch {
    logger.warn('KB not indexed yet. Run: npm run index-kb');
    KB = { docs: [] };
  }
}
loadKB();

// Hot-reload when index file changes
chokidar.watch(KB_PATH).on('change', () => {
  logger.info('KB index changed; reloading...');
  loadKB();
});

// Simple cosine similarity
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-8);
}

async function embed(text) {
  const { data } = await axios.post(`${OLLAMA}/api/embeddings`, { model: process.env.EMBED_MODEL || 'nomic-embed-text', prompt: text });
  return data.embedding;
}

async function retrieve(query, k = 3) {
  if (!KB.docs?.length) return [];
  const qvec = await embed(query);
  const scored = KB.docs.map(d => ({ ...d, score: cosine(qvec, d.vec) }));
  scored.sort((a,b) => b.score - a.score);
  return scored.slice(0, k);
}

async function generate(context, userQuestion) {
  const system = `You are the Twitch bot "charity_the_adventurer" for the channel "${CHANNEL}".
Answer ONLY using the provided context. If the answer isn't there, say you're not sure and suggest !faq.
Keep replies to 1-2 short sentences.`;

  const prompt = `Context:\n${context}\n\nQuestion: ${userQuestion}`;

  const { data } = await axios.post(`${OLLAMA}/api/chat`, {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    stream: false
  }, { timeout: 60000 });

  const msg = data?.message?.content || (data?.messages?.slice(-1)[0]?.content) || '';
  return msg.trim();
}

// Cooldowns
const lastByUser = new Map();
const USER_COOLDOWN_MS = 20_000; // 20s

// TMI client
const client = new tmi.Client({
  identity: { username: BOT_USERNAME, password: OAUTH },
  channels: [ CHANNEL ]
});

// --- Preflight token check/refresh before connecting ---
(async () => {
  // Raw token from env (strip oauth:)
  let raw = (process.env.TWITCH_OAUTH || '').replace(/^oauth:/i, '');
  let st  = loadTokenState(); // pulls stored client_id/secret/refresh, merges with env

  // Prefer env client_id/secret if present
  st.client_id     = process.env.TWITCH_CLIENT_ID     || st.client_id || '';
  st.client_secret = process.env.TWITCH_CLIENT_SECRET || st.client_secret || '';
  st.refresh_token = process.env.TWITCH_REFRESH       || st.refresh_token || '';

  const v = await validateToken(raw);
  const alertMin = TOKEN_ALERT_MIN; // e.g., 15
  let needRefresh = false;

  if (!v.ok) {
    needRefresh = true;
    logger.warn('[auth] token invalid; attempting refresh before connect...');
  } else {
    const mins = v.minutesRemaining ?? 0;
    if (mins <= alertMin) {
      needRefresh = true;
      logger.info(`[auth] token valid but expires in ~${mins} min; refreshing before connect...`);
      st.expires_at = v.expires_at;
      saveTokenState(st);
    }
    // Sanity: ensure token belongs to the bot user
    if ((v.login || '').toLowerCase() !== BOT_USERNAME) {
      logger.error(`[auth] token belongs to "${v.login}" but BOT_USERNAME is "${BOT_USERNAME}". Use a token for the bot account.`);
      process.exit(1);
    }
    // Scopes sanity
    const sc = new Set(v.scopes || []);
    if (!(sc.has('chat:read') && sc.has('chat:edit'))) {
      logger.error('[auth] missing scopes chat:read and/or chat:edit');
      process.exit(1);
    }
  }

  if (needRefresh) {
    const r = await refreshToken(st);
    if (!r.ok) {
      logger.error(`[auth] refresh failed before connect: ${JSON.stringify(r.error).slice(0,200)}`);
      // Don’t proceed; TMI would just fail to login in a loop
      process.exit(1);
    }
    st = r.state;
    saveTokenState(st);
    // Update env-driven password for tmi
    let newTok = st.access_token || '';
    if (newTok && !newTok.startsWith('oauth:')) newTok = `oauth:${newTok}`;
    client?.opts && (client.opts.identity.password = newTok);
    process.env.TWITCH_OAUTH = st.access_token; // keep plain (no oauth:) in env
    logger.info('[auth] refresh succeeded before connect; proceeding.');
  }
})();

client.connect()
  .then(() => logger.info(`Connected as ${BOT_USERNAME}, joined #${CHANNEL}`))
  .catch(err => { logger.error(`TMI connect failed: ${err}`); process.exit(1); });

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  const text = message.trim();
  const user = tags['display-name'] || tags.username;

  // Simple commands (instant from files, no LLM)
  if (text === '!rules') {
    client.say(channel, `@${user} Please be kind, avoid spoilers, and respect the mods. More: !faq`);
    return;
  }
  if (text === '!schedule') {
    client.say(channel, `@${user} Tue & Thu 8-11 PM, Sat 2-5 PM (ET). Check panel for updates.`);
    return;
  }
  if (text === '!reloadkb' && (tags.mod || tags.badges?.broadcaster === '1')) {
    loadKB();
    client.say(channel, `KB reloaded.`);
    return;
  }

  const askPrefix = '!ask ';
  const isMention = text.toLowerCase().includes(`@${BOT_USERNAME.toLowerCase()}`);
  const isAsk = text.toLowerCase().startsWith(askPrefix);

  if (!(isAsk || isMention)) return;

  // cooldown
  const now = Date.now();
  const last = lastByUser.get(user) || 0;
  if (now - last < USER_COOLDOWN_MS) return;
  lastByUser.set(user, now);

  const question = isAsk
    ? text.slice(askPrefix.length)
    : text.replace(new RegExp(`@${BOT_USERNAME}\\s*`, 'i'), '').trim(); // NOTE: \\s, not \s

  if (!question) return;

  try {
    const hits = await retrieve(question, 3);
    const context = hits.map(h => `(${h.file}) ${h.text}`).join('\n---\n');
    const answer = await generate(context, question);
    const reply = answer || "I'm not sure - try !faq for more info.";
    client.say(channel, `@${user} ${reply}`);
    logger.info(`Answered ${user}: ${question} => ${reply}`);
  } catch (err) {
    logger.error(`Error answering: ${err}`);
  }
});

// --- Token monitor & auto-refresh (tuned) ---
async function reconnectWithToken(newToken) {
  let tok = newToken;
  if (tok && !tok.startsWith('oauth:')) tok = `oauth:${tok}`;
  try { await client.disconnect(); } catch {}
  client.opts.identity.password = tok;
  try {
    await client.connect();
    logger.info('Reconnected with refreshed token.');
  } catch (e) {
    logger.error('Reconnect failed after refresh: ' + e);
  }
}

async function tokenCheckLoop() {
  let st = loadTokenState();
  if (st.access_token) {
    const v = await validateToken(st.access_token);
    if (v.ok) {
      const mins = v.minutesRemaining ?? 0;
      if (!st.expires_at) { st.expires_at = v.expires_at; saveTokenState(st); }

      if (mins <= TOKEN_ALERT_MIN) {
        const now = Date.now();
        const sinceAttemptMin = st.last_refresh_attempt ? (now - st.last_refresh_attempt)/60000 : Infinity;
        if (sinceAttemptMin < REFRESH_COOLDOWN_MIN && mins > 5) {
          return setTimeout(tokenCheckLoop, TOKEN_CHECK_EVERY_MIN * 60 * 1000);
        }

        const iso = new Date(v.expires_at).toISOString();
        const okWh1 = await whisper(client, BROADCASTER, `[token] expires in ~${Math.max(0, Math.round(mins))} min (at ${iso}). Attempting refresh...`);
        if (!okWh1) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token expiry warning sent. Enable whispers for details.');

        st.last_refresh_attempt = now;
        saveTokenState(st);

        const r = await refreshToken(st);
        if (r.ok) {
          const prevExp = st.expires_at || 0;
          st = r.state;
          const gainedMin = Math.round((st.expires_at - prevExp)/60000);
          saveTokenState(st);

          if (gainedMin >= MIN_GAIN_MINUTES) {
            const okWh2 = await whisper(client, BROADCASTER, `[token] refresh succeeded (+${gainedMin} min). Reconnecting...`);
            if (!okWh2) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token refresh success. Enable whispers for details.');
            await reconnectWithToken(st.access_token);
          } else {
            await whisper(client, BROADCASTER, `[token] refresh succeeded but gained only +${gainedMin} min. No reconnect.`);
          }
        } else {
          const okWh3 = await whisper(client, BROADCASTER, `[token] refresh FAILED: ${JSON.stringify(r.error).slice(0,200)}. Please run 'twitch refresh -r <refresh_token>' and update .env.`);
          if (!okWh3) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token refresh failed. Check logs.');
        }
      }
    } else {
      const okWh4 = await whisper(client, BROADCASTER, `[token] invalid/expired token. Attempting refresh...`);
      if (!okWh4) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token invalid; attempting refresh.');
      const r = await refreshToken(st);
      if (r.ok) {
        st = r.state;
        saveTokenState(st);
        const okWh5 = await whisper(client, BROADCASTER, `[token] refresh succeeded after invalidation. Reconnecting...`);
        if (!okWh5) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token refreshed. Enable whispers for details.');
        await reconnectWithToken(st.access_token);
      } else {
        const okWh6 = await whisper(client, BROADCASTER, `[token] refresh FAILED: ${JSON.stringify(r.error).slice(0,200)}. Manual intervention required.`);
        if (!okWh6) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token refresh failed. Check logs.');
      }
    }
  }
  setTimeout(tokenCheckLoop, TOKEN_CHECK_EVERY_MIN * 60 * 1000);
}
client.on('connected', () => { setTimeout(tokenCheckLoop, 10_000); });

// NOTE: this assumes you already have a `whisper(client, user, msg)` helper defined elsewhere.
// If not, I can add a minimal whisper() that DMs mods/broadcaster only.
