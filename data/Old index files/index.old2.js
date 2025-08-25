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
  loadTokenState, validateToken, refreshToken, saveTokenState, createTwitchApi
} from './token.js';

// Optional persona/config (after imports + __dirname)
let CHARITY_CFG = null;
try {
  const raw = fs.readFileSync(path.resolve(__dirname, '../config/charity-config.json'), 'utf8');
  CHARITY_CFG = JSON.parse(raw);
} catch {
  /* no local config is fine; fall back to env */
}

// Safer axios defaults (timeouts + JSON)
axios.defaults.timeout = 20000; // chat runs also set timeouts, this makes other calls consistent
axios.defaults.headers.common['Content-Type'] = 'application/json';

// Version info
const PKG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

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
const LLM_MODEL = process.env.LLM_MODEL || 'llama3.1:8b-instruct-q8_0';

// Guard (we also assertRequiredEnv above; this keeps the legacy behavior)
if (!CHANNEL || !BOT_USERNAME) {
  console.error('Missing required env vars. See .env.example');
  process.exit(1);
}

// Ensure logs dir exists
try { fs.mkdirSync('./logs', { recursive: true }); } catch {}

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

// --- Debug toggle (config or env) ---
const DEBUG = (CHARITY_CFG?.features?.debug_chat === true) || (process.env.DEBUG_CHAT === '1');
const dbg = (...args) => { if (DEBUG) logger.info('[debug] ' + args.join(' ')); };

// --- User prefs (per-user timezone) ---
const USER_PREFS_PATH = path.resolve('./data/user_prefs.json');
let USER_PREFS = { tzByUserId: {} };
function loadUserPrefs() {
  try {
    USER_PREFS = JSON.parse(fs.readFileSync(USER_PREFS_PATH, 'utf8'));
    if (!USER_PREFS.tzByUserId) USER_PREFS.tzByUserId = {};
  } catch {
    USER_PREFS = { tzByUserId: {} };
  }
}
function saveUserPrefs() {
  try {
    fs.mkdirSync(path.dirname(USER_PREFS_PATH), { recursive: true });
    fs.writeFileSync(USER_PREFS_PATH, JSON.stringify(USER_PREFS, null, 2), 'utf8');
  } catch (e) {
    logger.warn('Failed saving user_prefs.json: ' + (e?.message || e));
  }
}
loadUserPrefs();

// --- Time & wording helpers (local awareness; supports asker-specific TZ) ---
const TZ = (CHARITY_CFG?.runtime?.timezone || process.env.TZ || 'America/New_York');
function getUserTzFromTags(tags) {
 const uid = tags?.['user-id'];
  const t = uid && USER_PREFS.tzByUserId[uid];
  return t || TZ;
}
function _getLocalParts(date=new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
  const parts = fmt.formatToParts(date).reduce((m,p)=>{m[p.type]=p.value; return m;}, {});
  const hour24 = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(date));
  return {
    hour24,
    minute: parts.minute,
    wday: parts.weekday,
    mon: parts.month,
    day: parts.day,
    time: `${parts.hour}:${parts.minute} ${parts.dayPeriod || ''}`.trim().replace('  ', ' ')
  };
}
function daypartPhrase(hour24) {
  return (hour24 >= 18 && hour24 <= 23) ? 'tonight' : 'last night';
}
function localClockLine(tz = TZ) {
  const p = _getLocalParts(new Date(), tz);
  return `Local time for you: ${p.wday} ${p.mon} ${p.day} ${p.time} (${tz})`;
}
function maybeTimeAwareRephrase(q, tz = TZ) {
  if (!q) return q;
  const p = _getLocalParts(new Date(), tz);
  const phrase = daypartPhrase(p.hour24);
  if (/\b(last\s+night|tonight)\b/i.test(q)) return q; // user already chose
  return q.replace(/\bgood\s+night\b/i, `good ${phrase}`)
          .replace(/\bthe\s+night\b/i, `${phrase}`)
          .replace(/\bnight\b/i, `${phrase}`);
}

// Boot identity breadcrumb (now logger is initialized)
logger.info(`[boot] channel=#${CHANNEL} bot=${BOT_USERNAME} broadcaster=${BROADCASTER}`);

// Load KB index
let KB = { docs: [] };
const KB_PATH = path.resolve('./data/kb_index.json');
function loadKB() {
  try {
    KB = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    logger.info(`KB loaded: ${KB.docs.length} chunks`);
  } catch (e) {
    logger.warn('KB not indexed or invalid JSON. Run: npm run index-kb; error: ' + (e?.message || e));
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

// --- follower detection cache ---
const followerCache = new Map(); // userId -> { isFollower: boolean, at: epoch_ms }
const FOLLOWER_TTL = (CHARITY_CFG?.features?.follower_cache_ttl_sec ?? 600) * 1000;

let BROADCASTER_ID = null;
async function getBroadcasterId(api) {
  if (BROADCASTER_ID) return BROADCASTER_ID;
  const login = (process.env.TWITCH_BROADCASTER || process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
  const { data } = await api.get(`/users?login=${encodeURIComponent(login)}`);
  BROADCASTER_ID = data?.data?.[0]?.id || null;
  return BROADCASTER_ID;
}

function isBroadcasterUser(tags) {
  try {
    const b = tags?.badges || {};
    if (b.broadcaster === '1') return true;
    const display = (tags['display-name'] || tags.username || '').toLowerCase();
    const cfgChannel = (process.env.TWITCH_BROADCASTER || process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
    const cfgGuildMaster = (CHARITY_CFG?.style?.lexicon?.guild_master || '').toLowerCase();
    // Treat the chatter as broadcaster if they match channel login OR configured guild master name
    return !!display && (display === cfgChannel || display === cfgGuildMaster);
  } catch { return false; }
}

async function isFollower(tags) {
  // If feature off, short-circuit
  if (!CHARITY_CFG?.features?.follower_role_enabled) return false;

  // If we don't have a user-id from IRC tags, we can't check
  const userId = tags['user-id'];
  if (!userId) return false;

  // Cache check
  const hit = followerCache.get(userId);
  const now = Date.now();
  if (hit) {
    const ttl = hit.err ? 60_000 : FOLLOWER_TTL; // short cache on errors
    if ((now - hit.at) < ttl) return hit.isFollower;
  }

  // Call Helix: requires moderator:read:followers, and token user must be mod/broadcaster
  try {
    const api = createTwitchApi(); // your token.js helper
    const broadcasterId = await getBroadcasterId(api);
    if (!broadcasterId) throw new Error('no broadcaster id');

    // GET https://api.twitch.tv/helix/channels/followers?broadcaster_id=...&user_id=...
    const { data } = await api.get(`/channels/followers`, {
      params: { broadcaster_id: broadcasterId, user_id: userId }
    });

    const isF = Array.isArray(data?.data) && data.data.length > 0;
    followerCache.set(userId, { isFollower: isF, at: now });
    return isF;
  } catch (e) {
    // On any error (missing scope/mod status), cache "unknown=false" briefly to avoid spam
    followerCache.set(userId, { isFollower: false, at: Date.now(), err: true }); // 1 min short TTL
    return false;
  }
}

function getRoleFromTags(tags, followerKnown = false) {
  const b = tags.badges || {};
  // Primary: badge
  if (isBroadcasterUser(tags)) return 'broadcaster';
  // Fallback 1: same user as the room owner
  if (tags['room-id'] && tags['user-id'] && tags['room-id'] === tags['user-id']) {
    return 'broadcaster';
  }
  // Fallback 2: login matches configured channel/broadcaster
  const chanLogin = (process.env.TWITCH_BROADCASTER || process.env.TWITCH_CHANNEL || '').toLowerCase();
  if (chanLogin && (tags.username || '').toLowerCase() === chanLogin) {
    return 'broadcaster';
  }
  if (tags.mod)               return 'mod';
  if (b.vip === '1')          return 'vip';
  if (b.founder)              return 'founder';
  if (b.subscriber || b.sub)  return 'subscriber';
  // defer follower vs non_follower below
  return followerKnown ? 'follower' : 'non_follower';
}

async function classifyRole(tags) {
  const follower = await isFollower(tags);
  return getRoleFromTags(tags, follower);
}

function formatAddress(tags) {
  const lex = CHARITY_CFG?.style?.lexicon || {};
  const display = tags['display-name'] || tags.username || 'friend';
  const mention = '@' + display;
  
  // Never address the bot itself
  const sender = (tags.username || '').toLowerCase();
  if (sender === BOT_USERNAME) return '';

  // Prefer previously resolved role; otherwise, recompute quickly with our robust check
  let role = tags ? tags._resolvedRole : null;
  if (!role) role = getRoleFromTags(tags, /*followerKnown=*/false);

  // If this chatter equals configured guild master name, force the display title to "Guild Master"
  const gmName = (lex.guild_master || '').toLowerCase();
  const isGM = (display || '').toLowerCase() === gmName || isBroadcasterUser(tags);
  const roleName = isGM
    ? ((lex.address_by_role || {}).broadcaster || 'Guild Master')
    : ((lex.address_by_role || {})[role] || '');
  switch (lex.mention_style) {
    case 'role+mention': return roleName ? `${roleName} ${mention}` : mention;
    case 'role-only':    return roleName || mention;
    default:             return mention; // 'mention'
  }
}

// Optional: debug to verify resolution in logs
function dbgRole(tags) {
  const display = tags['display-name'] || tags.username;
  const role = tags?._resolvedRole;
  logger.debug(`[role] user=${display} resolved=${role} isBroadcaster=${isBroadcasterUser(tags)}`);
}

function maybeAppreciateNonSub(role, text) {
  const lex = CHARITY_CFG?.style?.lexicon || {};
  if ((role === 'non_follower' || role === 'follower') && lex.non_sub_appreciation) {
    return `${text} ${lex.non_sub_appreciation}`;
  }
  return text;
}

async function embed(text) {
  const { data } = await axios.post(`${OLLAMA}/api/embeddings`, { model: process.env.EMBED_MODEL || 'bge-m3', prompt: text });
  return data.embedding;
}

async function retrieve(query, k = 3) {
  if (!KB.docs?.length) return [];
  const filtered = KB.docs.filter(d => Array.isArray(d.vec) && d.vec.length);
  if (!filtered.length) return [];
  const qvec = await embed(query);
  const scored = filtered.map(d => ({ ...d, score: cosine(qvec, d.vec) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

//Persona prompt plumbing (keeps “context-only” guard)
function personaSystem(mood = MOOD_DEFAULT) {
  const id  = CHARITY_CFG?.identity || {};
  const st  = CHARITY_CFG?.style || {};
  const md  = CHARITY_CFG?.mood?.styles?.[mood] || {};
  const rules = (st.rules || []).map(r => `- ${r}`).join('\n');
  const bio  = id.short_bio || 'a playful, kind, inquisitive cat adventurer';
  const phys = id.physicality ? `Physicality: ${id.physicality}` : '';
  const baseVoice = st.voice || 'cozy, curious, quick-witted but gentle';
  const moodVoice = md.voice ? `Mood voice: ${md.voice}` : '';
  const community = st.lexicon?.community_name || 'the community';

  return [
    `You are "${id.name || 'Charity'}".`,
    `Persona: ${bio}. ${phys}`.trim(),
    `Voice: ${baseVoice}. ${moodVoice}`.trim(),
    `Address ${community} warmly; follow style rules; keep replies short.`,
    `Hard constraints:`,
    `- Use ONLY the provided Context (and live stream status if given).`,
    `- If the answer is not in Context, say you’re not sure and invite a next step.`,
	`- Never invent stream activity unless confirmed by streamstatus.`,
    rules || '- Keep it kind and PG.'
  ].join('\n');
}

// Time-aware, mood-aware, live-aware generation (asker-specific timezone)
async function generate(context, userQuestion, mood = currentMood, tz = TZ) {
  const system = personaSystem(mood);
  // Live/channel context (existing helper in your codebase)
  const liveCtx = (typeof getChannelOrLiveContext === 'function')
    ? await getChannelOrLiveContext() : { lines: [], isLive: false };
  const streamStatus = liveCtx?.isLive ? 'LIVE' : 'OFFLINE';

  // Local time line & rephrase ("night" -> "last night"/"tonight" based on tz)
  const clockLine = localClockLine(tz);
  const rephrased = maybeTimeAwareRephrase(String(userQuestion || '').trim(), tz);

  // Merge status + clock + live lines + caller-provided context + guardrails
  const merged = [
    `Stream is currently ${streamStatus}.`,
    clockLine,
    Array.isArray(liveCtx?.lines) ? liveCtx.lines.join('\n').trim() : '',
    String(context || '').trim(),
    `Guidance: If a user mentions "night" without specifics, interpret it relative to the asker's local time (tz=${tz}): use "last night" unless it is currently evening (18:00–23:59), then use "tonight".`,
    `Do not imply a stream occurred unless the status is LIVE. If uncertain, say you're not sure and invite them to share.`
  ].filter(Boolean).join('\n---\n');

  const { data } = await axios.post(`${OLLAMA}/api/chat`, {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: `Context:\n${merged}\n\nQuestion: ${rephrased}` }
    ],
    stream: false
  }, { timeout: 60000 });

  const msg = data?.message?.content || (data?.messages?.slice(-1)[0]?.content) || '';
  return (msg || '').trim();
}

function twitchSafe(msg, limit = 480) {
   // Leave room for mentions/emotes; Twitch hard cap ~500 chars
   return (msg || '').replace(/\s+/g, ' ').trim().slice(0, limit);
 }

// --- Commands: per-user timezone ---
async function handleSetTzCommand(channel, tags, args) {
  const tz = (args || '').trim();
  if (!tz) {
    return client.say(channel, `${formatAddress(tags)} usage: !settz America/New_York ✧`);
  }
  try {
    // Basic validation via Intl
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
  } catch {
    return client.say(channel, `${formatAddress(tags)} I don’t recognize that timezone. Example: "America/Chicago" or "Europe/London". ✧`);
  }
  const uid = tags?.['user-id'];
  if (!uid) return;
  USER_PREFS.tzByUserId[uid] = tz;
  saveUserPrefs();
  return client.say(channel, `${formatAddress(tags)} got it! I’ll speak in your local time (${tz}) from now on. ✧`);
}

async function handleMyTimeCommand(channel, tags) {
  const tz = getUserTzFromTags(tags);
  return client.say(channel, `${formatAddress(tags)} ${localClockLine(tz)} ✧`);
}

/**
 * Uses the LLM to craft a short, in-character startup line for Charity.
 * Reads optional env STARTUP_EMOTES, e.g., "🐾⚔️🛡️".
 * Consolidated version: the model returns JUST the sentence (no greeting, no emotes);
 * we add greeting/CTA/signature/emotes exactly once here.
 */
let _startupAnnouncedAt = 0;
async function startupAnnouncementUnified() {
  if (Date.now() - _startupAnnouncedAt < 10000) return; // ignore duplicates within 10s
  _startupAnnouncedAt = Date.now();
  try {
    const emotes  = (CHARITY_CFG?.emotes?.startup_emotes) || process.env.STARTUP_EMOTES || '🐾⚔️🛡️';
    const channel = (process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
    const guild   = (process.env.TWITCH_BROADCASTER || channel).toLowerCase();
    const lex     = CHARITY_CFG?.style?.lexicon || {};
    const greet   = pickOne(lex.greeting_variants, 'Hey');
    const cta     = pickOne(lex.call_to_action, 'try !ask');
    const sig     = getSignatureForMood(currentMood);

    const system = [
      `You are Charity the Adventurer: a brave, armored, anthropomorphic cat with expressive ears and a soft purr.`,
      `You adore the guild master "${guild}" (broadcaster "Bagotrix"), are inquisitive and playful but kind.`,
      `Write ONE short line (<=220 chars) that welcomes chat and invites !ask or !rules.`,
      `Do NOT start with a greeting and do NOT include emotes or hashtags.`
    ].join('\n');

    const user = `Return just the sentence (no greeting, no emotes).`;

    const { data } = await axios.post(`${OLLAMA}/api/chat`, {
      model: LLM_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false
    }, { timeout: 20000 });

    let line = data?.message?.content || (data?.messages?.slice(-1)[0]?.content) || '';
    // Trim & strip any wrapping quotes
    line = (line || '').trim().replace(/^\"|\"$/g, '');

    // Compose once: greeting + model line + CTA + sig + emotes, then Twitch-safe trim
    line = twitchSafe(`${greet}! ${line} ${cta}. ${sig} ${emotes}`, 480);

    if (!line) {
      line = `Charity reporting for duty! Nosy paws at the ready—what quests are we chasing today? ${cta}. ${sig} ${emotes}`;
      line = twitchSafe(line, 480);
    }

    await client.say('#' + channel, line);
  } catch (e) {
    const channel  = (process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
    const fallback = `Charity online—shield polished, whiskers twitching. I’m here if you need me: try !ask or !rules.`;
    try { await client.say('#' + channel, twitchSafe(fallback)); } catch {}
  }
}

// ---------------- Lexicon helpers ----------------
function pickOne(v, fallback = '') {
  if (!v) return fallback;
  const arr = Array.isArray(v) ? v : [v];
  return arr[Math.floor(Math.random() * arr.length)] ?? fallback;
}

function getSignatureForMood(mood) {
  const lex = CHARITY_CFG?.style?.lexicon || {};
  const map = lex.signature_by_mood || {};
  return map[mood] || lex.signature || '✧';
}

// ---------- Small-talk intent ----------
const SMALLTALK_RX = [
  /^(hi|hello|hey|yo|howdy)\b/i,
  /\bgood (morning|afternoon|evening|night)\b/i,
  /\bwhat'?s up\b/i,
  /\bhow (are|r) (you|u)\b/i,
  /\bhow'?s it going\b/i
];

function isSmallTalk(text) {
  if (!text || text.startsWith('!')) return false; // commands excluded
  const t = text.trim().toLowerCase();
  return SMALLTALK_RX.some(rx => rx.test(t));
}

// ----------Small-talk reply builder (no facts, just vibes) ----------
function buildSmallTalkReply(tags, role) {
  const lex  = CHARITY_CFG?.style?.lexicon || {};
  const greet = pickOne(lex.greeting_variants, 'Hey');
  const cta   = pickOne(lex.call_to_action, 'try !ask');
  const tic   = pickOne(lex.cat_tics, '');
  const sig   = getSignatureForMood(currentMood);
  const moodEmote = pickOne(CHARITY_CFG?.mood?.styles?.[currentMood]?.emotes, '');

  // Keep cheerful, zero facts, one short stage direction at most
  const beat = tic ? ` ${tic}` : '';
  const line = `${greet}! I’m here and ready to help—${cta}.${beat} ${sig} ${moodEmote}`.trim();
  const addressed = formatAddress(tags);
  const body = maybeAppreciateNonSub(role, line);
  return twitchSafe(`${addressed} ${body}`, 480);
}

// ---------------- Mood handling ----------------
const MOOD_DEFAULT = CHARITY_CFG?.mood?.default || 'curious';
let currentMood = MOOD_DEFAULT;
let moodSetAt = 0;
const MOOD_DECAY = Number(CHARITY_CFG?.features?.mood_decay_ms || 180000);

function updateMoodFromText(text) {
  const triggers = CHARITY_CFG?.mood?.triggers || [];
  const t = (text || '').toLowerCase();
  for (const rule of triggers) {
    try {
      const rx = new RegExp(rule.match, 'i');
      if (rx.test(t)) {
        currentMood = rule.set || MOOD_DEFAULT;
        moodSetAt = Date.now();
        return;
      }
    } catch { /* ignore bad regex */ }
  }
}

function decayMoodIfNeeded() {
  if (!moodSetAt) return;
  if (Date.now() - moodSetAt > MOOD_DECAY) {
    currentMood = MOOD_DEFAULT;
    moodSetAt = 0;
  }
}

/**
 * Uses the LLM to craft a short, in-character startup line for Charity.
 * Reads optional env STARTUP_EMOTES, e.g., "🐾⚔️🛡️".
 */

// Cooldowns
const lastByUser = new Map();
const USER_COOLDOWN_MS = CHARITY_CFG?.cooldowns?.user_ms ?? 20_000; // 20s

// Returns "oauth:<token>" or "" if we don't have one yet.
function getOauth() {
  const st  = loadTokenState();
  const raw = st.access_token || (OAUTH || '').replace(/^oauth:/i, '');
  return raw ? `oauth:${raw}` : '';
}

// ---------- TMI client with always-fresh token ----------
// Twitch recommends reacting to 401s, not proactive timers; supplying a fresh token on connect helps too.
const client = new tmi.Client({
  // TMI internals
  options: {
    debug: false,
    messagesLogLevel: "warn"
  },
  connection: {
    secure: true,
    reconnect: true,          // auto-retry on disconnects
    timeout: 60000,           // wait longer for server responses
    server: "irc-ws.chat.twitch.tv",
    port: 443
  },
  identity: {
    username: BOT_USERNAME,
    password: getOauth()      // "oauth:<access_token>"
  },
  channels: [ CHANNEL ]        // we'll also call join() explicitly after connect
});

// ---- DEBUG: TMI connection diagnostics ----
client.on('connected', (addr, port) => {
  logger.info(`[tmi] connected to ${addr}:${port} as ${BOT_USERNAME}`);
});
client.on('reconnect', () => logger.warn('[tmi] reconnecting...'));
client.on('disconnected', (reason) => logger.warn('[tmi] disconnected: ' + reason));
client.on('join', (chan, username, self) => {
  if (self) logger.info(`[tmi] joined ${chan} as ${username}`);
});
client.on('part', (chan, username, self) => {
  if (self) logger.warn(`[tmi] parted ${chan} as ${username}`);
});
client.on('notice', (channel, msgid, message) => {
  logger.warn(`[tmi] NOTICE ${channel} ${msgid || ''} :: ${message}`);

if (String(message).includes('Unrecognized command: /w')) {
  logger.warn('[hint] Twitch removed whispers over IRC. Set WHISPER_MODE=api and add scope user:manage:whispers to use Helix; otherwise we fallback to public @mention.');
}

});

// ---------- Whisper helper (reliable, safe, with fallback) ----------
const WHISPER_MAX = 450; // leave headroom under Twitch's ~500 cap

function normalizeUser(u) {
  return (u || '').replace(/^@+/, '').trim();
}

/**
 * Sends a whisper to targetUser; if unavailable/fails, falls back to a public @mention.
 * Options:
 *  - prefix: string to prepend (e.g., "[token]")
 *  - silentFallback: if true, don't send the public fallback
 */

async function whisper(targetUser, msg, opts = {}) {
  const user = normalizeUser(targetUser);
  if (!user || !msg) return false;

  const prefix = opts.prefix ? `${opts.prefix} ` : '';
  const body = twitchSafe(`${prefix}${msg}`, WHISPER_MAX);

  // Prefer Helix API if enabled & scoped; otherwise fall back to public @mention
  if (WHISPER_MODE === 'api') {
    try {
      // Resolve bot id once
      if (!BOT_USER_ID) BOT_USER_ID = await getUserIdByLogin(BOT_USERNAME);
      const toId = await getUserIdByLogin(user);

      if (BOT_USER_ID && toId) {
        // POST /helix/whispers?from_user_id=BOT_USER_ID&to_user_id=toId  { message }
        await helix.post('/whispers', { message: body }, { params: { from_user_id: BOT_USER_ID, to_user_id: toId } });
        return true;
      }
    } catch (e) {
      logger.warn(`[whisper-api] failed for ${user}: ${e?.response?.status || ''} ${e?.message || e}`);
      // fall through to public mention unless silenced
    }
  }

  // Graceful public fallback
  try {
    if (!opts.silentFallback) {
      await client.say('#' + CHANNEL, '@' + user + ' ' + body);
    }
  } catch (e) {
    logger.warn(`[whisper-fallback] say() failed for ${user}: ${e?.message || e}`);
  }

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
  } else {const v = await validateToken(accessToCheck);
    if (!v.ok) {
      needRefresh = true;
      logger.warn('[auth] token invalid; attempting refresh before connect...');
    } else {const mins = v.minutesRemaining ?? 0;
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

async function assertChatToken(identityUser = BOT_USERNAME) {
  const st = loadTokenState();
  const tok = st?.access_token;
  if (!tok) {
    logger.error('[auth] no access token present in token state.');
    process.exit(1);
  }

  const v = await validateToken(tok);
  if (!v.ok) {
    logger.error('[auth] access token is invalid prior to connect.');
    process.exit(1);
  }

  const login = (v.login || '').toLowerCase();
  const expected = (identityUser || '').toLowerCase();
  const scopes = new Set(v.scopes || []);

  logger.info(`[auth] token login=${login} scopes=[${[...scopes].join(', ')}]`);

  if (login !== expected) {
    logger.error(
      `[auth] token belongs to "${login}" but BOT_USERNAME is "${expected}". ` +
      `The TMI username must match the token owner. Use a user token for ${expected}.`
    );
    process.exit(1);
  }
  if (!(scopes.has('chat:read') && scopes.has('chat:edit'))) {
    logger.error('[auth] token missing required scopes: chat:read and chat:edit.');
    process.exit(1);
  }
}

await assertChatToken(BOT_USERNAME);

// Ensure TMI uses freshest token before connecting
client.opts.identity.password = getOauth();

client.connect()
  .then(async () => {
    logger.info(`Connected as ${BOT_USERNAME} (socket up)`);

    // Explicit join (even if channels: [CHANNEL] is set). This gives us a clear error if it fails.
    try {
      await client.join('#' + CHANNEL);
      logger.info(`[tmi] joined #${CHANNEL}`);
    } catch (e) {
      logger.warn(`[tmi] explicit join failed: ${e?.message || e}`);
    }

    // Light liveness ping a few seconds after join (helps keep the session warm)
    setTimeout(() => {
      try { client.ping(); logger.info('[tmi] ping sent'); } catch {}
    }, 3000);

    // Optional liveness line (enable with STARTUP_PING=1)
    if (process.env.STARTUP_PING === '1') {
      try { await client.say('#' + CHANNEL, 'I Live! ✅'); }
      catch (e) { logger.warn('[diag] say failed after initial connect: ' + (e?.message || e)); }
    }
  })
  .catch(err => { logger.error(`TMI connect failed: ${err}`); process.exit(1); });

// ---------- Example Helix client with 401->refresh->retry ----------
const helix = createTwitchApi();

// ---------- Whisper mode & ID cache ----------
// WHISPER_MODE: 'api' to use Helix whispers (requires user:manage:whispers + verified phone), 'off' to disable
const WHISPER_MODE = (process.env.WHISPER_MODE || CHARITY_CFG?.features?.whispers || 'off').toLowerCase();
let BOT_USER_ID = null; // resolved lazily via /users
const _userIdCache = new Map(); // login -> id

async function getUserIdByLogin(login) {
  const key = (login || '').toLowerCase();
  if (_userIdCache.has(key)) return _userIdCache.get(key);
  try {
    const resp = await helix.get('/users', { params: { login: key } });
    const id = resp?.data?.data?.[0]?.id || null;
    if (id) _userIdCache.set(key, id);
    return id;
  } catch { return null; }
}

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

let HANDLERS_ATTACHED = false;
function attachHandlersOnce() {
  if (HANDLERS_ATTACHED) return;
  HANDLERS_ATTACHED = true;
  
// message/command handling is below...
// ---------- Chat handling ----------
client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  if ((tags.username || '').toLowerCase() === BOT_USERNAME) return; // don't react to our own messages
  const text = message.trim();
  const user = tags['display-name'] || tags.username;
  dbg('msg:from=', (tags['display-name'] || tags.username), 'text=', JSON.stringify(text));

// Update/decay mood based on chat content
  updateMoodFromText(text);
  decayMoodIfNeeded();
  
// Resolve role (subscriber/mod/vip/follower/non_follower) and pre-format address
  const role = await classifyRole(tags);
  tags._resolvedRole = role;                 // let formatAddress read the resolved role
  dbgRole(tags);
  const addressed = formatAddress(tags);     // e.g., "Guild Master @Bagotrix"

// --- Small-talk mode: greet/banter without making factual claims
  if (isSmallTalk(text)) {
    dbg('branch=smalltalk', 'mood=', currentMood);
	const line = buildSmallTalkReply(tags, role);
    await client.say(channel, line);
    return;
  }

// parse your existing commands...
// --- New: per-user timezone commands ---
  if (/^!settz\b/i.test(text)) {
    const args = text.replace(/^!settz\b/i, '').trim();
    return void handleSetTzCommand(channel, tags, args);
  }
  if (/^!mytime\b/i.test(text)) {
    return void handleMyTimeCommand(channel, tags);
  }

  // Simple commands
  if (text === '!rules') {
    dbg('branch=command', 'cmd=!rules');
	const cta = pickOne(CHARITY_CFG?.style?.lexicon?.call_to_action, 'try !ask');
    await client.say(channel, twitchSafe(`${addressed} Please be kind, avoid spoilers, and respect the mods. More: !faq • ${cta}`, 480));
    return;
  }
  if (text === '!schedule') {
    dbg('branch=command', 'cmd=!schedule');
	const hello = pickOne(CHARITY_CFG?.style?.lexicon?.greeting_variants, 'Hey');
    await client.say(channel, twitchSafe(`${addressed} ${hello}! Tue & Thu 8–11 PM, Sat 2–5 PM (ET). Check panel for updates.`, 480));
    return;
  }
  if (text === '!reloadkb' && (tags.mod || tags.badges?.broadcaster === '1')) {
    loadKB();
	dbg('branch=command', 'cmd=!reloadkb');
    await client.say(channel, `KB reloaded.`);
    return;
  }
  if (text === '!version') {
     dbg('branch=command', 'cmd=!version');
	await client.say(channel, `Charity v${PKG.version} • ${BOT_USERNAME} on #${CHANNEL}`);
    return;
}
  if (text === '!streamstatus') {
    dbg('branch=command', 'cmd=!streamstatus');
	const c = await getChannelOrLiveContext();
    const t = (c.lines.find(l => l.startsWith('StreamTitle:')) || '').replace('StreamTitle: ', '');
    const g = (c.lines.find(l => l.startsWith('Game:')) || '').replace('Game: ', '');
    const liveFlag = c.isLive ? 'LIVE' : 'offline';
    const parts = [];
    parts.push(liveFlag);
    if (t) parts.push(t);
    if (g) parts.push(g);
    await client.say(channel, `${addressed} ${parts.join(' • ')}`);
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

dbg('branch=qa', 'mood=', currentMood, 'question=', JSON.stringify(question || text));

  try {
    // Build KB context once
    const kbHits = await retrieve(question, 3);
    const kbContext = (kbHits || []).map(h => `(${h.file}) ${h.text}`).join('\n---\n');

    // Build live/channel context (works online or offline)
    const liveCtx = await getChannelOrLiveContext();
    const liveContext = liveCtx.lines.join('\n');

    // Merge and ask model (generate() answers ONLY from provided context)
    const mergedContext = [liveContext, kbContext].filter(Boolean).join('\n---\n').trim();

    // Decide if Context is strong enough to answer
    const MIN = Number(CHARITY_CFG?.features?.min_context_score ?? process.env.MIN_CONTEXT_SCORE ?? 0.25);
    let reply;
    if (!kbHits?.length || (kbHits[0].score ?? 0) < MIN) {
      dbg('qa=abstain', 'topScore=', kbHits?.[0]?.score ?? 0, 'min=', MIN);
      // Abstain: keep it friendly and brief; rotate a CTA
      const cta = pickOne(CHARITY_CFG?.style?.lexicon?.call_to_action, 'try !ask');
      reply = `I’m not sure from what I have — ${cta} or give me a bit more detail.`;
    } else {const askerTz = getUserTzFromTags(tags);
      const answer = await generate(mergedContext, question, currentMood, askerTz);
      reply = answer || `I’m not sure — ${pickOne(CHARITY_CFG?.style?.lexicon?.call_to_action, 'try !ask')}.`;
    }
    const sig = getSignatureForMood(currentMood);
    const body = maybeAppreciateNonSub(role, reply);
    await client.say(channel, twitchSafe(`${addressed} ${body} ${sig}`, 480));
    logger.info(`Answered ${user}: ${question} => ${reply}`);
  } catch (err) {
    logger.error(`Error answering: ${err}`);
  }
});

client.on('connected', async () => {
    await startupAnnouncementUnified();
  });
}

// call this exactly once after you create `client`
attachHandlersOnce();
client.on('ping', () => logger.info('[tmi] << ping'));
client.on('pong', (latency) => logger.info('[tmi] >> pong ' + (latency != null ? `${latency}ms` : '')));
client.on('raw_message', (msgCloned, msg) => {
  // Uncomment if you need to see low-level IRC traffic
  // logger.debug('[tmi] RAW ' + msg?.raw);
});

// ---------- Reconnect with a new token ----------

async function reconnectWithToken(newToken) {
  let tok = newToken;
  if (tok && !tok.startsWith('oauth:')) tok = `oauth:${tok}`;
  try { await client.disconnect(); } catch {}
  client.opts.identity.password = tok;
  try {
    await assertChatToken(BOT_USERNAME); // validates the freshly refreshed token
    await client.connect();
    logger.info('Reconnected with refreshed token.');
    try {
      await client.say('#' + CHANNEL, '[diag] Charity reconnected ✅');
    } catch (e) {
      logger.warn('[diag] say failed after reconnect: ' + (e?.message || e));
    }
  } catch (e) {
    logger.error('Reconnect failed after refresh/assert: ' + (e?.message || e));
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
      await whisper(BROADCASTER, `expires in ~${Math.max(0, Math.round(mins))} min (at ${iso}). Attempting refresh...`, { prefix: '[token]' });

      st.last_refresh_attempt = now;
      saveTokenState(st);

      const r = await refreshToken(st); // guarded
      if (r.ok) {
        const prevExp = st.expires_at || 0;
        st = r.state;
        const gainedMin = Math.round((st.expires_at - prevExp)/60000);
        saveTokenState(st);

        if (gainedMin >= MIN_GAIN_MINUTES) {
          await whisper(BROADCASTER, `refresh succeeded (+${gainedMin} min). Reconnecting...`, { prefix: '[token]' });
          await reconnectWithToken(st.access_token);
        } else {await whisper(BROADCASTER, `refresh succeeded but gained only +${gainedMin} min. No reconnect.`, { prefix: '[token]' });
        }
      } else {await whisper(BROADCASTER, `refresh FAILED: ${JSON.stringify(r.error).slice(0,200)}. Manual check required.`, { prefix: '[token]', silentFallback: true });
      }
    }
  } else {await whisper(BROADCASTER, `invalid/expired token. Attempting refresh...`, { prefix: '[token]' });
    const r = await refreshToken(st); // guarded
    if (r.ok) {
      st = r.state;
      saveTokenState(st);
      await whisper(BROADCASTER, `refresh succeeded after invalidation. Reconnecting...`, { prefix: '[token]' });
      await reconnectWithToken(st.access_token);
    } else {await whisper(BROADCASTER, `refresh FAILED: ${JSON.stringify(r.error).slice(0,200)}. Manual intervention required.`, { prefix: '[token]', silentFallback: true });
    }
  }

  setTimeout(tokenCheckLoop, TOKEN_CHECK_EVERY_MIN * 60 * 1000);
}
client.on('connected', () => {
  // kick off token monitor shortly after connect
  setTimeout(tokenCheckLoop, 10_000);
  // announce Charity once she’s fully connected
  setTimeout(() => { startupAnnouncementUnified(); }, 2_000);
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