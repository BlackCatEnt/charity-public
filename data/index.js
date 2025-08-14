// index.js
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

import {
  loadTokenState, validateToken, refreshToken, saveTokenState, getTokenStatus, createTwitchApi
} from './token.js';

// --- Env basics (order matters) ---
const CHANNEL       = (process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
const BOT_USERNAME  = (process.env.TWITCH_BOT_USERNAME || 'charity_the_adventurer').toLowerCase();
const BROADCASTER   = (process.env.TWITCH_BROADCASTER || CHANNEL).toLowerCase();

// --- Token monitor knobs ---
const TOKEN_ALERT_MIN        = parseInt(process.env.TOKEN_ALERT_MINUTES || '15', 10);
const TOKEN_CHECK_EVERY_MIN  = parseInt(process.env.TOKEN_CHECK_INTERVAL_MINUTES || '10', 10);
const REFRESH_COOLDOWN_MIN   = parseInt(process.env.REFRESH_COOLDOWN_MINUTES || '180', 10);
const MIN_GAIN_MINUTES       = parseInt(process.env.MIN_TOKEN_GAIN_MINUTES || '20', 10);

// OAuth (tmi.js wants "oauth:<token>") — we’ll supply via async function so it’s always fresh
let OAUTH = process.env.TWITCH_OAUTH || '';

// LLM cfg
const OLLAMA    = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'llama3.1:8b-instruct-q4_K_M';

// Guard (we also assertRequiredEnv above; this keeps the legacy behavior)
if (!CHANNEL || !BOT_USERNAME) {
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

// --- Startup announcement (LLM persona) ---
function twitchSafe(msg, limit = 480) {
  // Leave room for mentions/emotes; Twitch hard cap ~500 chars
  return (msg || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * Uses the LLM to craft a short, in-character startup line for Charity.
 * Reads optional env STARTUP_EMOTES, e.g., "🐾⚔️🛡️".
 */
async function startupAnnouncement() {
  try {
    const emotes = process.env.STARTUP_EMOTES || '🐾⚔️🛡️';
    const channel = (process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
    const guildMaster = (process.env.TWITCH_BROADCASTER || channel).toLowerCase();

    const system = `You are Charity the Adventurer: a brave, armored, anthropomorphic cat who wields a sword and shield.
You adore the guild master "${guildMaster}" (the broadcaster "Bagotrix"), are inquisitive and playfully snarky (but kind).
You care deeply about the Adventuring Guild (channel subscribers past & present).
Write a SINGLE short startup line (1–2 sentences max) announcing you're online, nosy about what's happening on stream, welcoming guild members, and inviting !ask or !rules.
Keep it cozy, fun, and PG. Avoid spammy punctuation or ALL CAPS. Keep under 220 characters.`;

    const user = `Generate that one-line greeting now. Do NOT include hashtags. Avoid unicode art. Append these emotes at the end: ${emotes}`;

    const { data } = await axios.post(`${OLLAMA}/api/chat`, {
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      stream: false
    }, { timeout: 20000 });

    let line = data?.message?.content || (data?.messages?.slice(-1)[0]?.content) || '';
    line = twitchSafe(line, 480);

    if (!line) {
      line = `Charity reporting for duty! Nosy paws at the ready—what quests are we chasing today, Adventuring Guild? Try !ask for help or !rules for house code. ${emotes}`;
    }

    await client.say('#' + channel, line);
  } catch {
    const emotes = process.env.STARTUP_EMOTES || '🐾⚔️🛡️';
    const channel = (process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
    const fallback = `Charity online—shield polished, whiskers twitching. Hey Adventuring Guild, I’m here if you need me: try !ask or !rules. ${emotes}`;
    try { await client.say('#' + channel, twitchSafe(fallback)); } catch {}
  }
}

// Cooldowns
const lastByUser = new Map();
const USER_COOLDOWN_MS = 20_000; // 20s

// ---------- TMI client with always-fresh token ----------
// Twitch recommends reacting to 401s, not proactive timers; supplying a fresh token on connect helps too. :contentReference[oaicite:9]{index=9}
const client = new tmi.Client({
  identity: {
    username: BOT_USERNAME,
    password: async () => {
      const st = loadTokenState();
      const tok = st.access_token || (OAUTH || '').replace(/^oauth:/i, '');
      return tok ? `oauth:${tok}` : '';
    }
  },
  channels: [ CHANNEL ]
});

// ---------- Minimal whisper helper (falls back to channel) ----------
async function whisperOrSay(targetUser, msg) {
  try {
    if (client.whisper) {
      await client.whisper(targetUser, msg);
      return true;
    }
  } catch {}
  try {
    await client.say('#' + CHANNEL, '@' + targetUser + ' ' + msg);
  } catch {}
  return false;
}

// ---------- Preflight token check/refresh before connecting ----------
(async () => {
  // Merge env into stored state
  let st  = loadTokenState();
  st.client_id     = process.env.TWITCH_CLIENT_ID     || st.client_id || '';
  st.client_secret = process.env.TWITCH_CLIENT_SECRET || st.client_secret || '';
  st.refresh_token = process.env.TWITCH_REFRESH       || st.refresh_token || '';

  // Prefer env access token if provided (strip oauth:)
  const rawEnv = (process.env.TWITCH_OAUTH || '').replace(/^oauth:/i, '');
  let accessToCheck = st.access_token || rawEnv;

  let needRefresh = false;
  if (!accessToCheck) {
    needRefresh = true;
    logger.warn('[auth] no access token found; attempting refresh before connect...');
  } else {
    const v = await validateToken(accessToCheck);
    if (!v.ok) {
      needRefresh = true;
      logger.warn('[auth] token invalid; attempting refresh before connect...');
    } else {
      const mins = v.minutesRemaining ?? 0;
      if ((v.login || '').toLowerCase() !== BOT_USERNAME) {
        logger.error(`[auth] token belongs to "${v.login}" but BOT_USERNAME is "${BOT_USERNAME}". Use a token for the bot account.`);
        process.exit(1);
      }
      const sc = new Set(v.scopes || []);
      if (!(sc.has('chat:read') && sc.has('chat:edit'))) {
        logger.error('[auth] missing scopes chat:read and/or chat:edit');
        process.exit(1);
      }
      // Save expiry info for status messages
      st.expires_at = v.expires_at;
      saveTokenState(st);

      if (mins <= TOKEN_ALERT_MIN) {
        needRefresh = true;
        logger.info(`[auth] token valid but expires in ~${mins} min; refreshing before connect...`);
      }
    }
  }

  if (needRefresh) {
    const r = await refreshToken(st); // guarded
    if (!r.ok) {
      logger.error(`[auth] refresh failed before connect: ${JSON.stringify(r.error).slice(0,200)}`);
      process.exit(1);
    }
    st = r.state;
    saveTokenState(st);
    process.env.TWITCH_OAUTH = st.access_token; // keep plain (no oauth:) in env
    logger.info('[auth] refresh succeeded before connect; proceeding.');
  }
})();

client.connect()
  .then(() => logger.info(`Connected as ${BOT_USERNAME}, joined #${CHANNEL}`))
  .catch(err => { logger.error(`TMI connect failed: ${err}`); process.exit(1); });

// ---------- Example Helix client with 401->refresh->retry ----------
const helix = createTwitchApi();

// ---------- Channel/Live Context Helper (works online OR offline) ----------
async function getChannelOrLiveContext() {
  const login = (process.env.TWITCH_BROADCASTER || CHANNEL).toLowerCase();

  // helper: resolve login -> user_id (cached in memory for speed)
  if (!global.__BROADCASTER_ID) {
    try {
      const u = await helix.get('/users', { params: { login } });
      global.__BROADCASTER_ID = u?.data?.data?.[0]?.id || null;
    } catch { /* ignore */ }
  }
  const broadcaster_id = global.__BROADCASTER_ID;

  // 1) Try "live" first
  try {
    const { data } = await helix.get('/streams', { params: { user_login: login } });
    const live = data?.data?.[0];
    if (live) {
      let gameName = live.game_name || '';
      if (!gameName && live.game_id) {
        try {
          const g = await helix.get('/games', { params: { id: live.game_id } });
          gameName = g?.data?.data?.[0]?.name || '';
        } catch { /* ignore */ }
      }
      const lines = [
        `StreamTitle: ${live.title || ''}`,
        `Game: ${gameName || ''}`,
        `IsLive: yes`,
        `ViewerCount: ${live.viewer_count ?? ''}`,
        `StartedAt: ${live.started_at || ''}`
      ];
      return { lines, isLive: true };
    }
  } catch { /* ignore */ }

  // 2) Fallback: channel info (works offline)
  try {
    if (!broadcaster_id) return { lines: [], isLive: false };
    const { data } = await helix.get('/channels', { params: { broadcaster_id } });
    const ch = data?.data?.[0];
    if (!ch) return { lines: [], isLive: false };

    let gameName = ch.game_name || '';
    if (!gameName && ch.game_id) {
      try {
        const g = await helix.get('/games', { params: { id: ch.game_id } });
        gameName = g?.data?.data?.[0]?.name || '';
      } catch { /* ignore */ }
    }

    const lines = [
      `StreamTitle: ${ch.title || ''}`,
      `Game: ${gameName || ''}`,
      `IsLive: no`,
      `BroadcasterId: ${broadcaster_id}`
    ];
    return { lines, isLive: false };
  } catch (e) {
    return { lines: [], isLive: false };
  }
}


// ---------- Chat handling ----------
client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  const text = message.trim();
  const user = tags['display-name'] || tags.username;

  // Simple commands
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
  if (text === '!streamstatus') {
    const c = await getChannelOrLiveContext();
    const t = (c.lines.find(l => l.startsWith('StreamTitle:')) || '').replace('StreamTitle: ', '');
    const g = (c.lines.find(l => l.startsWith('Game:')) || '').replace('Game: ', '');
    const liveFlag = c.isLive ? 'LIVE' : 'offline';
    client.say(channel, `Status: ${liveFlag} · Title: ${t || '—'} · Game: ${g || '—'}`);
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
    : text.replace(new RegExp(`@${BOT_USERNAME}\\s*`, 'i'), '').trim();
  if (!question) return;

  try {
    // Build KB context
    const hits = await retrieve(question, 3);
    const kbContext = hits.map(h => `(${h.file}) ${h.text}`).join('\n---\n');

    // Build live/channel context (works online or offline)
    const liveCtx = await getChannelOrLiveContext();
    const liveContext = liveCtx.lines.join('\n');

    // Merge and ask model (your generate() uses ONLY provided context)
    const mergedContext = [liveContext, kbContext].filter(Boolean).join('\n---\n').trim();

    const answer = await generate(mergedContext, question);
    const reply = answer || "I'm not sure - try !faq for more info.";
    client.say(channel, `@${user} ${reply}`);
    logger.info(`Answered ${user}: ${question} => ${reply}`);
  } catch (err) {
    logger.error(`Error answering: ${err}`);
  }
});


// ---------- Reconnect with a new token ----------
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

// ---------- Token monitor & auto-refresh (reactive + periodic sanity) ----------
async function tokenCheckLoop() {
  let st = loadTokenState();
  if (!st.access_token && !st.refresh_token) {
    setTimeout(tokenCheckLoop, TOKEN_CHECK_EVERY_MIN * 60 * 1000);
    return;
  }

  const v = st.access_token ? await validateToken(st.access_token) : { ok: false };
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
      await whisperOrSay(BROADCASTER, `[token] expires in ~${Math.max(0, Math.round(mins))} min (at ${iso}). Attempting refresh...`);

      st.last_refresh_attempt = now;
      saveTokenState(st);

      const r = await refreshToken(st); // guarded
      if (r.ok) {
        const prevExp = st.expires_at || 0;
        st = r.state;
        const gainedMin = Math.round((st.expires_at - prevExp)/60000);
        saveTokenState(st);

        if (gainedMin >= MIN_GAIN_MINUTES) {
          await whisperOrSay(BROADCASTER, `[token] refresh succeeded (+${gainedMin} min). Reconnecting...`);
          await reconnectWithToken(st.access_token);
        } else {
          await whisperOrSay(BROADCASTER, `[token] refresh succeeded but gained only +${gainedMin} min. No reconnect.`);
        }
      } else {
        await whisperOrSay(BROADCASTER, `[token] refresh FAILED: ${JSON.stringify(r.error).slice(0,200)}. Manual check required.`);
      }
    }
  } else {
    await whisperOrSay(BROADCASTER, `[token] invalid/expired token. Attempting refresh...`);
    const r = await refreshToken(st); // guarded
    if (r.ok) {
      st = r.state;
      saveTokenState(st);
      await whisperOrSay(BROADCASTER, `[token] refresh succeeded after invalidation. Reconnecting...`);
      await reconnectWithToken(st.access_token);
    } else {
      await whisperOrSay(BROADCASTER, `[token] refresh FAILED: ${JSON.stringify(r.error).slice(0,200)}. Manual intervention required.`);
    }
  }

  setTimeout(tokenCheckLoop, TOKEN_CHECK_EVERY_MIN * 60 * 1000);
}
client.on('connected', () => {
  // kick off token monitor shortly after connect
  setTimeout(tokenCheckLoop, 10_000);
  // announce Charity once she’s fully connected
  setTimeout(() => { startupAnnouncement(); }, 2_000);
});

// ---------- Example of reactive 401 handling on a Helix call ----------
// (Call somewhere in your code; this shows the "retry once on 401" behavior from createTwitchApi)
async function exampleGetSelf() {
  try {
    const resp = await helix.get('/users'); // 401 here will trigger refresh + retry once
    return resp.data;
  } catch (e) {
    logger.warn('Helix call failed even after refresh: ' + (e?.response?.status || e?.message));
    return null;
  }
}
