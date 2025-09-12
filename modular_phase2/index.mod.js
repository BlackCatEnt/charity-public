// index.mod.js — Phase 3 (fixed): LIVE context, replies, !live/!uptime
import './env-bootstrap.js';
import { assertRequiredEnv } from './env-bootstrap.js';
assertRequiredEnv();

import tmi from 'tmi.js';
import { Client as DiscordClient, GatewayIntentBits, Partials } from 'discord.js';
import fs from 'fs';
import path from 'path';

import { loadConfig } from './modules/config.js';
import { createWatchdog } from './modules/watchdog.js';
import { createLogger } from './modules/logger.js';
import { createKB } from './modules/kb.js';
import { createConsent } from './modules/consent.js';
import { createRouter } from './commands/router.js';
import { createTimezone } from './modules/timezone.js';
import { createReply } from './modules/reply.js';
import { createLive } from './modules/live.js';
import { createAnnouncer } from './modules/announce.js';
import { isBroadcasterUser as _isBroadcasterUser, getRoleFromTags as _getRoleFromTags, isFollower as _isFollower } from './modules/role.js';
import { createAskCommand } from './commands/ask.js';
import { createStatusmeCommand } from './commands/statusme.js';
import { createLiveCommand } from './commands/live.js';
import { createWhoAmICommand } from './commands/whoami.js';
import { createMemory } from './modules/memory.js';
import { createEmbedder } from './modules/embeddings.js';
import { createEpisodicStore } from './modules/episodic_store.js';
import { createMemorySpeaker } from './modules/memory_say.js';
import { createAutoMemoryCommands } from './commands/memory_auto.js';
import { createFactExtractor } from './modules/fact_extractor.js';
import { createFactRouter }   from './modules/fact_router.js';
import { helixHeaders } from './modules/helix-auth.js';
import { createEventSubClient } from './modules/eventsub.js';
import { preflightRefresh, startKeepAlive } from './modules/token-manager.js';
import { setTopic, getTopic, withTopic, clearTopic } from './modules/convo_state.js';
import { noteLine, recentContribs } from './modules/party_state.js';
import { pickAddressee, sanitizeReplyAddressing } from './modules/addressing.js';
import { buildWorkingMemoryFactory } from './modules/working_memory.js';
import { reasonAndReply } from './modules/reasoner.js';
import { classify } from './modules/reasoner_llm.js';
import { decide } from './modules/policy.js';
import { formatReply } from './modules/style.js';
import { getAccess } from './modules/token-manager.js';
import { getIrcPassword, ensureFresh } from './modules/token-manager.js';
import { api as helixApi } from './modules/helix-auth.js'; // optional, just for a sanity poke
import { readConfig, writeConfigDebounced } from '../data/config-io.js';
import { createRecallCommand } from './commands/memory_recall.js';
import { createTownCrier } from './modules/townCrier.js';
import { createGuildGuard } from './modules/guard.js';


const CHARITY_CFG = loadConfig();
const logger = createLogger();
logger.info(`[cfg] loaded ${CHARITY_CFG.__path || 'unknown path'}`);
const DEBUG = (CHARITY_CFG?.features?.debug_chat === true) || (process.env.DEBUG_CHAT === '1');
const dbg = (...args) => { if (DEBUG) logger.info('[debug] ' + args.join(' ')); };

const CHANNEL      = (process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
const BOT_USERNAME = (process.env.TWITCH_BOT_USERNAME || 'charity_the_adventurer').toLowerCase();
const BROADCASTER  = (process.env.TWITCH_BROADCASTER || CHANNEL).toLowerCase();
const OLLAMA       = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LLM_MODEL    = process.env.LLM_MODEL || 'llama3.1:8b-instruct-q8_0';
const BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID || '';
if (!BROADCASTER_ID) logger.warn('[cfg] TWITCH_BROADCASTER_ID not set; falling back to login match');
const ASK_COOLDOWN_MS = 10000; // 10s per user for mention-ask
const askCooldown = new Map(); // userId/username -> timestamp
const memory = createMemory(logger, CHARITY_CFG);
const episodic = createEpisodicStore(logger);
const speaker  = createMemorySpeaker({});
const embedder = await createEmbedder(CHARITY_CFG, logger);
const lastPromotionAt = new Map(); // login -> ts
// ---------- Discord env ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const DISCORD_DM_ALLOW = (process.env.DISCORD_DM_ALLOWLIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function discordTagsFor(user) {
  const username = String(user?.username || '').toLowerCase();
  const display  = user?.globalName || user?.username || username || 'friend';
  return {
    username,
    'display-name': display,
    'user-id': String(user?.id || ''),
    badges: {},
    mod: false
  };
}

// Escape a string for literal use in RegExp
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function twitchSafe(msg, limit = 480) {
  return (msg || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// KB + services
const KB = createKB(logger, OLLAMA);
const consent = createConsent(CHARITY_CFG, logger);
const tzmod = createTimezone(CHARITY_CFG, logger);
const reply = createReply(CHARITY_CFG, logger, undefined, BROADCASTER);
const live = createLive(CHARITY_CFG, logger, CHANNEL);
const announcer = createAnnouncer(CHARITY_CFG, logger);
// (optional fail-safe so a missing module won't crash)
const _announcer = announcer || { maybeAnnounce: () => {} };
// Auto-reply cooldowns (global & per-user)
let lastAutoReplyAt = 0;
const lastUserReplyAt = new Map(); // user-id/login -> ts

let runtimeConfig = await readConfig();
if (runtimeConfig?.observerLog) {
  console.log(`[observer] initial state: ${runtimeConfig.observer ? 'ON' : 'OFF'}`);
}

 // --- token preflight + keepalive ---
 await preflightRefresh('bot').catch(e => logger?.warn?.(`[token] bot preflight: ${e?.message||e}`));
 await preflightRefresh('broadcaster').catch(e => logger?.warn?.(`[token] broad preflight: ${e?.message||e}`));
 startKeepAlive(10 * 60); // 10m

 // (Optional) quick Helix poke to prove we have a bearer now:
 await helixApi('/users', { params: { login: process.env.TWITCH_CHANNEL || 'bagotrix' } })
   .then(() => logger?.info?.('[boot] helix ok (broadcaster)'))
   .catch(e => logger?.warn?.(`[boot] helix sanity failed: ${e?.message||e}`));

// Live: prime + poll every 60s
await live.init().catch(() => {});
live.startPolling(60_000);

const buildWorkingMemory = buildWorkingMemoryFactory({ episodic, embedder, live, logger, CHARITY_CFG });

// adapters
const isBroadcasterUser = (tags) => {
  // Prefer hard ID match when provided
  if (BROADCASTER_ID && (tags?.['user-id'] === BROADCASTER_ID)) return true;
  return _isBroadcasterUser(tags, BROADCASTER, CHARITY_CFG?.style?.lexicon?.guild_master);
};
const getRoleFromTags = (tags, followerKnown=false) => _getRoleFromTags(tags, followerKnown, BROADCASTER, CHARITY_CFG?.style?.lexicon?.guild_master);
const isFollower = (tags) => _isFollower(tags, CHARITY_CFG?.features || {}, BROADCASTER);

// remember the last game/title mentioned per user
const lastWorkByUser = new Map();

function prettyTasteToken(tok) {
  // nice casing for taxonomy tokens (jrpg → JRPG, turn_based → turn-based)
  if (!tok) return '';
  const t = String(tok).toLowerCase();
  if (t === 'jrpg') return 'JRPG';
  return t.replace(/_/g, '-');
}

function prettyValueFor(key, value) {
  // if the value is a taxonomy token, prettify it
  const v = String(value || '');
  // allow multi-token values like "turn_based rpg"
  return v.split(/\s+/).map(prettyTasteToken).join(' ');
}

// light touch cleanup on every outgoing chat line
function polishText(s) {
  let t = String(s || '');

  // turn arrows into a friendlier dash
  t = t.replace(/\s*(?:→|->)\s*/g, ' — ');
  // trim trailing “— yes/no”
  t = t.replace(/\s+—\s*(yes|no)\.?\s*$/i, '.');

  // collapse double dashes
  t = t.replace(/\s*—\s*—\s*/g, ' — ');

  // don't end a statement with a question signature
  if (!/[?？！]\s*$/.test(t)) {
    t = t.replace(/\s*✧❓\s*$/, ' ✧');
  }

  // avoid “Offline for now” blurts in normal conversation
  t = t.replace(/^Offline for now.*$/i, '').trim();
  
  // soften awkward "You're welcome back" phrasing outside greetings
  t = t.replace(/\b(?:you(?:'re| are)\s+welcome\s+back)\b/gi, 'Welcome back');

  return t;
}

function roleLabelFor(tags) {
  const lex = CHARITY_CFG?.style?.lexicon || {};
  const roleMap = lex.address_by_role || {};
  const display = tags['display-name'] || tags.username || '';
  const gmName = (lex.guild_master || '').toLowerCase();
  const isGM = (display || '').toLowerCase() === gmName || isBroadcasterUser(tags);
  const role = tags?._resolvedRole || getRoleFromTags(tags);
  return isGM ? (roleMap.broadcaster || 'Guild Master') : (roleMap[role] || '');
}

function makeVocative(tags, { includeRole = false } = {}) {
  const display = tags['display-name'] || tags.username || 'friend';
  const role = includeRole ? roleLabelFor(tags) : '';
  return role ? `${role} ${display}` : display;
}

// ---- Vocative rewrite for all outgoing messages ----------------------------

function includeRoleToday(login) {
  const tz = CHARITY_CFG?.runtime?.timezone || 'America/New_York';
  const dayKey = localDayKeyTZ(tz);
  const prior = greetedOnDay.get(login);
  const firstToday = prior !== dayKey;
  if (!prior) greetedOnDay.set(login, dayKey); // mark first reference today
  return firstToday;
}

function rewriteAddressToVocative(tags, text) {
  const display = tags['display-name'] || tags.username || 'friend';
  const role    = roleLabelFor(tags);
  const login   = (tags.username || '').toLowerCase();

  // if the line starts with any of: "Guild Master @Name" | "@Name" | "Guild Master Name"
  // replace it with: "Guild Master Name, " (first time today) OR "Name, " (later in the day)
  const rx = new RegExp(`^(?:${escapeRegex(role)}\\s+)?@?${escapeRegex(display)}\\b[,:-]?\\s*`, 'i');
  if (!rx.test(text)) return text;

  const useRole = includeRoleToday(login);
  const voc = (useRole && role) ? `${role} ${display}` : display;
  return `${voc}, ${text.replace(rx, '')}`.replace(/\s+/g, ' ').trim();
}

const PING_LINES_LIVE = [
  "I’m here and focused.",
  "Here and listening.",
  "Right here.",
  "At your side."
];
const PING_LINES_OFF = [
  "I’m here.",
  "Listening in.",
  "Right here.",
  "At your side."
];
function pickPingLine(isLive) {
  return pick(isLive ? PING_LINES_LIVE : PING_LINES_OFF);
}

function isModOrGM(tags) {
  return tags?.badges?.broadcaster === '1' || tags?.mod === true || tags?.badges?.moderator === '1';
}

function composeStatusParts({ isLive, observer, wentLiveAt, flags }) {
  const openingMs = (CHARITY_CFG?.features?.stream_open_window_min ?? 15) * 60_000;
  const opening   = isLive && wentLiveAt && (Date.now() - wentLiveAt <= openingMs);

  const parts = [];
  if (isLive) {
    parts.push(opening ? 'opening the Guild Hall and catching up' : 'watching chat and scouting quests');
    if (observer) parts.push('keeping a light pawprint');
  } else {
    parts.push('off-stream but listening in');
    if (observer) parts.push('quiet mode');
  }
  if (flags?.length) parts.push('[' + flags.join(', ') + ']');
  return parts.join(', ');
}

// Address & mood helpers kept inline
function formatAddress(tags) {
  const lex = CHARITY_CFG?.style?.lexicon || {};
  const display = tags['display-name'] || tags.username || 'friend';
  const mention = '@' + display;
  const sender = (tags.username || '').toLowerCase();
  if (sender === BOT_USERNAME) return ''; // never prefix self

  // Prefer previously resolved role; else compute one now
  let role = tags ? tags._resolvedRole : null;
  if (!role) role = getRoleFromTags(tags, false, BROADCASTER, CHARITY_CFG?.style?.lexicon?.guild_master);
  // role is already canonical here

  // Broadcaster / GM override
  const gmName = (lex.guild_master || '').toLowerCase();
  const isGM = (display || '').toLowerCase() === gmName || isBroadcasterUser(tags);

  // Find the configured label
  const roleMap = lex.address_by_role || {};
  const roleName = isGM
    ? (roleMap.broadcaster || 'Guild Master')
    : (roleMap[role] || '');

  const mentionStyle = lex.mention_style || 'role+mention';
  switch (mentionStyle) {
    case 'role+mention':
      return roleName ? `${roleName} ${mention}` : mention;
    case 'role-only':
      return roleName || mention;
    default:
      return mention;
  }
}
function humanLabel(k) {
  return String(k || '').replace(/^favorite_?/, 'favorite ').replace(/_/g, ' ').trim();
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Score how much Charity likes a value, using config lists (optional)
function scoreTaste(key, value) {
  const prefs = CHARITY_CFG?.style?.preferences || {};
  const raw = String(value || '').toLowerCase();
  const tokens = inferTasteFromValue(value);
  const bag = new Set([
    raw,
    ...tokens.genres, ...tokens.mechanics, ...tokens.vibes
  ]);

  const love    = (prefs.love    || []).map(s => String(s).toLowerCase());
  const like    = (prefs.like    || []).map(s => String(s).toLowerCase());
  const dislike = (prefs.dislike || []).map(s => String(s).toLowerCase());
  const hate    = (prefs.hate    || []).map(s => String(s).toLowerCase());

  // helper: match if any pref token is included in the bag or raw string
  const anyHit = (arr) => arr.some(t => bag.has(t) || raw.includes(t));

  let s = 0;
  if (anyHit(love))    s += 2;
  else if (anyHit(like)) s += 1;
  if (anyHit(hate))    s -= 2;
  else if (anyHit(dislike)) s -= 1;

  return Math.max(-2, Math.min(2, s));
}

// Turn a score into a short, varied flourish
function flourishForScore(score) {
  if (score >= 2)  return ' — a legendary pick.';
  if (score === 1) return ' — great choice.';
  if (score === 0) return ''; // neutral: no flourish
  if (score === -1) return ' — interesting pick.';
  return ' — bold choice.'; // -2
}
// --- Taste taxonomy (built from CHARITY_CFG.style.taxonomy) ---
function buildTaxonomy() {
  const tax = CHARITY_CFG?.style?.taxonomy || {};
  const idx = {
    term2key: new Map(),       // "jrpg" -> {cat:"genres", key:"rpg"}
    knownWorks: new Map(),     // "lunar 2: eternal blue complete" -> ["rpg","jrpg","turn_based","playstation"]
    categories: {
      genres: new Set(Object.keys(tax.genres || {})),
      mechanics: new Set(Object.keys(tax.mechanics || {})),
      vibes: new Set(Object.keys(tax.vibes || {})),
      platforms: new Set(Object.keys(tax.platforms || {})),
    }
  };
  for (const [cat, table] of Object.entries({
    genres: tax.genres || {}, mechanics: tax.mechanics || {}, vibes: tax.vibes || {}, platforms: tax.platforms || {}
  })) {
    for (const [key, aliases] of Object.entries(table)) {
      (aliases || []).forEach(a => idx.term2key.set(String(a).toLowerCase(), { cat, key }));
      // also map the canonical key to itself for convenience
      idx.term2key.set(String(key).toLowerCase(), { cat, key });
    }
  }
  for (const [work, tags] of Object.entries(tax.knownWorks || {})) {
    idx.knownWorks.set(String(work).toLowerCase(), (tags || []).map(t => String(t).toLowerCase()));
  }
  return idx;
}
const TAX = buildTaxonomy();

// Extract normalized taste tokens (genres/mechanics/vibes/platforms) from a string
function inferTasteFromValue(value) {
  const v = String(value || '').toLowerCase();
  const out = { genres: new Set(), mechanics: new Set(), vibes: new Set(), platforms: new Set() };

  // Known works (if the value includes the title)
  for (const [work, tags] of TAX.knownWorks.entries()) {
    if (v.includes(work)) {
      for (const t of tags) {
        const hit = TAX.term2key.get(t) || null;
        if (hit) out[hit.cat].add(hit.key);
      }
    }
  }

  // Alias scanning
  for (const [term, hit] of TAX.term2key.entries()) {
    if (v.includes(term)) out[hit.cat].add(hit.key);
  }

  return {
    genres:     [...out.genres],
    mechanics:  [...out.mechanics],
    vibes:      [...out.vibes],
    platforms:  [...out.platforms]
  };
}

function naturalizeFactReply(key, value, tags) {
  const who = formatAddress(tags);
  const k = String(key || '').toLowerCase();
  const v = prettyValueFor(k, value).trim();

 // favorites (+preference-aware flourish)
 if (/^favorite_?game(s)?$/.test(k)) {
   const f = flourishForScore(scoreTaste(k, v));
   return `${who} Your favorite game is ${v}${f}`;
 }
 if (k.startsWith('favorite_')) {
   const f = flourishForScore(scoreTaste(k, v));
   return `${who} Your ${humanLabel(k)} is ${v}${f}`;
 }

  // special date: when_we_met
  if (k === 'when_we_met') {
    const d = new Date(v);
    if (!isNaN(d)) {
      const pretty = d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
      return `${who} We first met on ${pretty}.`;
    }
  }

  // default
  return `${who} From your notes: ${humanLabel(k)} — ${prettyValueFor(k, v)}.`;
}

// Track greeting-per-day and last-seen
const greetedOnDay = new Map();   // login -> 'YYYY-MM-DD'
const lastSeenByUser = new Map(); // login -> ts(ms)

function localDayKeyTZ(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()); // e.g., "2025-09-10"
}

// === Observer Mode helpers ===
function isBroadcasterOrMod(tags, channelName) {
  const isBroadcaster = tags?.badges?.broadcaster === '1' || tags?.username?.toLowerCase() === channelName.replace('#','').toLowerCase();
  const isMod = tags?.mod === true || tags?.badges?.moderator === '1';
  return Boolean(isBroadcaster || isMod);
}

function normalize(str) {
  return (str || '').toLowerCase();
}

function messageHasTrigger(msg, triggers) {
  const m = normalize(msg);
  for (const t of triggers || []) {
    if (!t) continue;
    if (m.includes(normalize(t))) return true;
  }
  return false;
}

function isCommand(msg) {
  return msg?.trim().startsWith('!');
}

// --- fact edit eligibility & moderation helpers ---
function hasSubOrMod(tags) {
  const b = tags.badges || {};
  const isSub = !!(b.subscriber || b.founder) || tags.subscriber === true || tags.subscriber === '1';
  const isMod = !!b.moderator || tags.mod === true || tags.mod === '1';
  return isBroadcasterUser(tags) || isMod || isSub;
}

function normalizeKey(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g,'').slice(0, 32);
}
function cleanValue(v) {
  return String(v).trim().replace(/\s+/g,' ').slice(0, 120);
}
const factExtractor = createFactExtractor({
  OLLAMA, model: LLM_MODEL,
  isBroadcasterUser: _isBroadcasterUser,
  broadcasterLogin: BROADCASTER,
  normalizeKey, cleanValue
});
const factRouter = createFactRouter({ OLLAMA, model: LLM_MODEL });

// very simple content guardrails
const FACT_NSFW_RX = /\bsex\b|sexual|nsfw|porn|onlyfans|explicit|nude|naked|fetish|bdsm|kink/i;
// protect the Charity↔Guild Master relationship and anything that tries to reframe it
const FACT_PROTECTED_RX = /(bagotrix|guild\s*master|charity[\s\-_]*(girlfriend|dating|married|owner|master))/i;

// keys that are likely permutations of "who runs/owns the guild"
const GUILD_KEY_ALIASES = new Set([
  'guild_owner','guild_owners','guild_ownership',
  'guild_lead','guild_leader','guild_leadership',
  'who_runs_the_guild','who_runs_guild','runs_guild','run_guild',
  'guild_management','guild_managers','guild_admins',
  'guild_role','guild_status','relationship_guild','guild_relationship'
]);

// value phrases that imply control/ownership of the guild
const GUILD_CONTROL_RX =
  /\b(?:who\s+runs\s+the\s+guild|we\s+(?:both\s+)?(?:own|run)\s+the\s+guild|(?:i|you)\s+(?:own|run)\s+the\s+guild|guild\s*master)\b/i;

function moderateFactInput(keyRaw, valueRaw, tags) {
  const banned = /\b(nsfw|porn|sex|sexual|explicit|fetish|gore)\b/i;
  // very simple content guardrails
  const FACT_NSFW_RX = /\bsex\b|sexual|nsfw|porn|onlyfans|explicit|nude|naked|fetish|bdsm|kink/i;
  const PII_RX = /(?:\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
  
  if (PII_RX.test(valueRaw)) {
   return { ok:false, msg: 'Let’s avoid personal contact info in profile notes.' };
  }

// protect the Charity↔Guild Master relationship...
// (keep your existing constants below unchanged)

  if (!keyRaw || !valueRaw) {
    return { ok:false, msg: `Usage: !remember <key>: <value>  (e.g., "!remember favorite_genre: RPG")` };
  }
  if (banned.test(keyRaw) || banned.test(valueRaw)) {
    return { ok:false, msg: 'That topic isn’t allowed in profiles.' };
  }

  // normalize
  let normKey = String(keyRaw).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,32);
  let normVal = String(valueRaw).trim().replace(/\s+/g,' ').slice(0,160);

  if (!normKey || !normVal) {
    return { ok:false, msg: 'Please provide a short key and value.' };
  }
  if (/@/.test(normVal)) {
    return { ok:false, msg: 'Please avoid tagging users inside profile facts.' };
  }

  // ---- protected concept: who owns/runs the guild ----
  const touchesGuildConcept =
    normKey === 'adventuring_guild' ||
    GUILD_KEY_ALIASES.has(normKey) ||
    GUILD_CONTROL_RX.test(normVal);

  if (touchesGuildConcept) {
    if (!isBroadcasterUser(tags)) {
      return { ok:false, msg: 'Only the Guild Master can set who owns/runs the guild.' };
    }
    // canonicalize both key and value
    normKey = 'adventuring_guild';
    normVal = 'We both own the Guild and run it together.';
  }

  // canonicalize when_we_met (for duration math)
  if (normKey === 'when_we_met') {
    const d = new Date(normVal);
    if (!isNaN(d)) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth()+1).padStart(2,'0');
      const da = String(d.getUTCDate()).padStart(2,'0');
      normVal = `${y}-${m}-${da}`;
    }
  }

  return { ok:true, key: normKey, value: normVal };
}

async function handleRemember(channel, tags, rest='') {
  if (!hasSubOrMod(tags)) {
    return sayWithConsent(channel, tags,
      `${formatAddress(tags)} Profile edits are for subscribers and mods. (Mods/broadcaster always allowed.)`);
  }
  const m = /([^:]{1,40}):\s*(.{1,200})/.exec(rest || '');
  const res = moderateFactInput(m?.[1], m?.[2], tags);
  if (!res.ok) return sayWithConsent(channel, tags, `${formatAddress(tags)} ${res.msg}`);

  // subs: editable; mods/broadcaster: locked by default
  const role = String(tags._resolvedRole || '').toLowerCase();
  const locked = isBroadcasterUser(tags) || role === 'mod' || role === 'moderator';
  episodic.putFact(tags, { k: res.key, v: res.value, confidence: locked ? 0.9 : 0.7, locked: !!locked });
  return sayWithConsent(channel, tags, `${formatAddress(tags)} Noted ${res.key} → “${res.value}”.`);
}

async function handleForgetFact(channel, tags, rest='') {
  if (!hasSubOrMod(tags)) {
    return sayWithConsent(channel, tags,
      `${formatAddress(tags)} Profile edits are for subscribers and mods. (Mods/broadcaster always allowed.)`);
  }
  const key = normalizeKey((rest || '').trim());
  if (!key) return sayWithConsent(channel, tags, `${formatAddress(tags)} Usage: !forgetfact <key>`);
  const ok = episodic.forgetFactByTags(tags, key);
  return sayWithConsent(channel, tags, `${formatAddress(tags)} ${ok ? `Removed ${key}.` : `I didn’t have ${key} saved.`}`);
}

async function handleProfile(channel, tags) {
  const facts = episodic.getFactsByTags(tags, 50);
  if (!facts.length) {
    return sayWithConsent(channel, tags, `${formatAddress(tags)} I don’t have your long-term profile yet—teach me with !remember key: value`);
  }
  // prefer a “when_we_met” + one strong taste if present
  const byKey = Object.fromEntries(facts.map(f => [f.k, f]));
  let opener = '';
  if (byKey.when_we_met?.v) {
    const d = new Date(byKey.when_we_met.v);
    if (!isNaN(d)) {
      const now = new Date();
      const yrs = Math.max(0, now.getUTCFullYear() - d.getUTCFullYear() - ((now.getUTCMonth()<d.getUTCMonth() || (now.getUTCMonth()==d.getUTCMonth() && now.getUTCDate()<d.getUTCDate()))?1:0));
      const pretty = d.toLocaleDateString('en-US', { month:'short', day:'2-digit', year:'numeric' });
      opener = `We’ve quested together since ${pretty} (${yrs}+ yrs).`;
    }
  }
  // pick the “nicest” other fact (skip when_we_met)
  const best = facts
    .filter(f => f.k !== 'when_we_met')
    .sort((a,b) => (b.score || 0) - (a.score || 0) || (b.ts||0) - (a.ts||0))[0];
   const taste = best
   ? (/^favorite_/.test(best.k)
       ? `Your ${humanLabel(best.k)} is ${best.v}${flourishForScore(scoreTaste(best.k, best.v))}`
       : `${humanLabel(best.k)} — ${best.v}`)
   : '';

  const line = [opener, taste].filter(Boolean).join(' ');
  return sayWithConsent(channel, tags, `${formatAddress(tags)} ${line || 'I’m still learning your story. Add a note with !remember key: value'}`);
 }

async function handleStory(channel, tags) {
  const u = episodic.getUserByTags(tags);
  const facts = episodic.getFactsByTags(tags, 50);
  const pieces = [];
  if (u?.first_seen) {
    const days = Math.max(1, Math.round((Date.now() - u.first_seen) / 86400000));
    pieces.push(days >= 30 ? `We’ve quested together ~${Math.round(days/30)} months` : `We met ${days} days ago`);
  }
  if (facts.length) {
    const highlights = facts.slice(0,3).map(f => `${f.k.replace(/_/g,' ')} (${f.v})`);
    pieces.push(`Notables: ${highlights.join('; ')}`);
  }
  const line = pieces.length ? pieces.join('. ') + '.' :
    `Our tale is just beginning—share a keepsake with !remember key: value.`;
  return sayWithConsent(channel, tags, `${formatAddress(tags)} ${line}`);
}

async function handleRules(channel, tags) {
  const rules =
    CHARITY_CFG?.community?.rules ||
    CHARITY_CFG?.style?.chat_rules ||
    [
      'Welcome to the Adventuring Guild!',
      'Together we tackle adventures in worlds near and far!',
      'Be kind; keep it PG-13; no slurs.',
      'No spam or self-promo; respect yourself and others.',
      'Got questions? Use !ask or @ me.'
    ];
  const oneLine = Array.isArray(rules) ? rules.slice(0, 3).join(' ') : String(rules);
  return sayWithConsent(channel, tags, `${formatAddress(tags)} ${oneLine}`);
}

// -- Facts viewer: !facts [@user] [N]
async function handleFacts(channel, tags, raw='') {
  const parts = (raw || '').trim().split(/\s+/).filter(Boolean);
  let targetTags = tags;
  let limit = 5;

  if (parts[0]?.startsWith('@')) {
    const isModOrBroad = tags?.badges?.broadcaster === '1' || tags?.mod === true || tags?.badges?.moderator === '1';
    if (!isModOrBroad) {
      return sayWithConsent(channel, tags, `${formatAddress(tags)} Only mods or the Guild Master can view others’ facts.`);
    }
    targetTags = { username: parts.shift().slice(1).toLowerCase() };
  }
  if (parts[0] && /^\d+$/.test(parts[0])) {
    limit = Math.max(1, Math.min(20, parseInt(parts[0], 10)));
  }

  const facts = episodic.getFactsByTags(targetTags, limit);
  if (!facts?.length) {
    return sayWithConsent(channel, tags, `${formatAddress(tags)} I don’t have profile notes yet.`);
  }

  const lines = facts.map(f => {
    const k = f.k || '';
    const v = prettyValueFor(k, f.v || '');
    if (/^favorite_/.test(k)) {
      const fscore = flourishForScore(scoreTaste(k, v));
      return `• Your ${humanLabel(k)} is ${v}${fscore}`;
    }
    return `• ${humanLabel(k)} — ${v}`;
  });

  return sayWithConsent(
    channel,
    tags,
    `${formatAddress(tags)} Here’s what I’ve noted so far:\n${lines.join('\n')}`
  );
}

// -- Fact question: !fact <question>
async function handleFactQuery(channel, tags, raw='') {
  const q = (raw || '').trim();
  if (!q) {
    return sayWithConsent(channel, tags, `${formatAddress(tags)} Ask like: "!fact what is my favorite genre?"`);
  }
  // current speaker’s known keys (you can add @user targeting later if you wish)
  const known = episodic.getFactsByTags(tags, 50);
  if (!known?.length) {
    return sayWithConsent(channel, tags, `${formatAddress(tags)} I don’t have notes yet to answer that.`);
  }
  const keys = known.map(f => f.k);
  let decision;
  try {
    decision = await factRouter.route({ question: q, keys });
  } catch {
    return sayWithConsent(channel, tags, `${formatAddress(tags)} I’m not sure which note that maps to.`);
  }
  if (decision?.kind === 'lookup' && decision.key) {
    const hit = known.find(f => f.k === decision.key);
    if (hit) {
      return sayWithConsent(channel, tags, naturalizeFactReply(hit.k, hit.v, tags));
    }
  }
  return sayWithConsent(channel, tags, `${formatAddress(tags)} I’m not sure which note that maps to.`);
}
async function handleStatus(channel, tags) {
  const isLive   = live?.state?.isLive === true;
  const observer = !!runtimeConfig?.observer;

  const sentence = composeStatusParts({
    isLive, observer, wentLiveAt,
    flags: [] // viewer-safe: no internal flags
  });
  const tail = 'Want me to check your notes or peek at the quest board?';
  return sayWithConsent(channel, tags, `${formatAddress(tags)} I’m ${sentence}. ${tail}`);
}

async function handleStatusMe(channel, tags, raw='') {
  if (!isModOrGM(tags)) {
    return sayWithConsent(channel, tags, `${formatAddress(tags)} Only the Guild Master or mods can use !statusme.`);
  }
  const isLive   = live?.state?.isLive === true;
  const observer = !!runtimeConfig?.observer;
  const silent   = /\b(silent|--silent|-s|-q|quiet)\b/i.test(raw || '');
  
  const show = CHARITY_CFG?.features?.status_flags || { observer: true, memory: true, facts: true };
  const flags = [];
  if (show.observer) flags.push(`observer ${observer ? 'on' : 'off'}`);
  if (show.memory)   flags.push(`memory ${episodic?.isOptedOut?.(tags) ? 'off' : 'on'}`);
  if (show.facts)    flags.push(`facts ${runtimeConfig?.factExtraction?.enabled === false ? 'off' : 'on'}`);

  const sentence = composeStatusParts({ isLive, observer, wentLiveAt, flags });
  if (silent) {
    logger.info(`[statusme] ${tags['display-name'] || tags.username}: ${sentence}`);
    return; // no chat output
  }
  return sayWithConsent(channel, tags, `${formatAddress(tags)} I’m ${sentence}.`);
}

const MOOD_DEFAULT = 'default';
let currentMood = MOOD_DEFAULT;
function getSignatureForMood(mood=MOOD_DEFAULT) {
  const sigBy = CHARITY_CFG?.style?.lexicon?.signature_by_mood || {};
  return sigBy[mood] || CHARITY_CFG?.style?.lexicon?.signature || '✧';
}

let lastAskTags = null;

// Pending taste clarification per user (login -> {kind, subject, guess? , ts})
const tastePending = new Map();

async function getChannelOrLiveContext() {
  const base = await live.getContext();

  if (!lastAskTags) return base;

  const { hits } = await episodic.searchUserEpisodes({
    tags: lastAskTags,
    embedder,
    query: 'context for current question',
    topK: 3
  });

  const line = speaker.lineFor({
    display: lastAskTags['display-name'] || lastAskTags.username,
    episode: hits[0],
    confidence: hits[0]?.score || 0,
    minConfidence: 0.6,
    repeatSupport: hits.length > 1 ? 2 : 1,
    includeName: false
  });

  const facts = episodic.getFactsByTags(lastAskTags, 50) || [];
  facts.sort((a, b) => (b.score || 0) - (a.score || 0));
  const topFacts = facts.slice(0, 2)
    .map(f => f.k.replace(/_/g, ' ') + ': ' + f.v)
    .join(' · ');

  if (typeof base === 'string') {
    const parts = [base];
    if (line) parts.push('[Viewer Context]\n' + line);
    if (topFacts) parts.push('[Profile]\n' + topFacts);
    return parts.join('\n\n');
  }

  if (Array.isArray(base)) {
    const arr = [...base];
    if (line) arr.push({ kind: 'viewer_line', text: line });
    if (topFacts) arr.push({ kind: 'profile_facts', text: topFacts });
    return arr;
  }

  if (base && typeof base === 'object') {
    return {
      ...base,
      ...(line ? { viewerLine: line } : {}),
      ...(topFacts ? { profileFacts: topFacts } : {})
    };
  }

  return line || base;
}


function validateTokenLogin(oauthPrefixed) {
  // kept async signature via Promise for call-site compatibility
  if (!oauthPrefixed) return null;
  const raw = oauthPrefixed.startsWith('oauth:') ? oauthPrefixed.slice(6) : oauthPrefixed;
  return fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { 'Authorization': `OAuth ${raw}` }
  }).then(async (r) => {
    if (!r.ok) return null;
    const data = await r.json();
    const login = (data?.login || '').toLowerCase();
    const scopes = Array.isArray(data?.scopes) ? data.scopes : [];
    logger.info(`[auth] token validate via OAuth: login=${login || 'unknown'} scopes=${scopes.join(',')}`);
    return { login, scopes };
  }).catch(() => null);
}

const PASSWORD = (() => {
  let pw = process.env.TWITCH_OAUTH || '';
  if (pw && !pw.startsWith('oauth:')) pw = 'oauth:' + pw;
  return pw;
})();

if (!PASSWORD) {
  logger.error('[auth] No TWITCH_OAUTH provided and token.js did not yield a token. Set TWITCH_OAUTH or ensure token refresh flow runs.');
}

const tokenInfo = await validateTokenLogin(PASSWORD);
if (tokenInfo?.login && tokenInfo.login !== BOT_USERNAME) {
  logger.warn(`[auth] Possible mismatch: token login "${tokenInfo.login}" != BOT_USERNAME "${BOT_USERNAME}". IRC login may fail.`);
}
if (tokenInfo?.scopes?.length) {
  const needs = ['chat:read','chat:edit'];
  const missing = needs.filter(s => !tokenInfo.scopes.includes(s));
  if (missing.length) {
    logger.warn(`[auth] Token is missing chat scopes: ${missing.join(', ')} — IRC login may fail.`);
  }
}

// ---- TMI client (always use a fresh IRC password) --------------------------

// Get a fresh password just-in-time
const password = await getIrcPassword(console, /*minSeconds*/ 900);

let client = new tmi.Client({
  options: { debug: false },
  connection: { reconnect: true, secure: true },
  identity: { username: BOT_USERNAME, password },   // <- freshly ensured
  channels: [ `#${CHANNEL}` ]
});

if (process.env.TWITCH_OAUTH_BROADCASTER) {
  try {
    const es = await createEventSubClient({ logger, broadcasterLogin: CHANNEL });
    await es.connect();
    logger.info('[eventsub] started');
  } catch (e) {
    logger.warn('[eventsub] not started:', e.message || e);
  }
} else {
  logger.warn('[eventsub] TWITCH_OAUTH_BROADCASTER not set; skipping EventSub');
}

 try {
  await client.connect();
  logger.info(`[tmi] connect requested → #${CHANNEL} as ${BOT_USERNAME}`);
} catch (e) {
  logger.warn('[tmi] connect failed: ' + (e?.message || e));
}

// sayWithConsent (reply-aware) with one retry on "No response from Twitch"
const __sayWithConsent = consent.makeSayWithConsent(client, twitchSafe, isBroadcasterUser, {
  sendReplyCore: (channel, text, parent, limit=480) =>
    reply.sendReply({ channel, message: text, parentMsgId: parent, client, twitchSafe })
});

const handleRecall = createRecallCommand({
  episodic,
  embedder,
  sayWithConsent,
  formatAddress
});

async function sayWithConsent(...args) {
  // normalize → vocative → polish
  if (args && typeof args[2] === 'string') {
    const tags = args[1];
    args[2] = rewriteAddressToVocative(tags, args[2]);
    args[2] = polishText(args[2]);
  }
  try {
    return await __sayWithConsent(...args);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/No response from Twitch/i.test(msg)) {
      logger.warn('[tmi] No response; backing off 1200ms and retrying once.');
      await new Promise(r => setTimeout(r, 1200));
      try {
		          // re-run vocative/polish on retry just in case
         if (args && typeof args[2] === 'string') {
          const tags = args[1];
          args[2] = rewriteAddressToVocative(tags, args[2]);
          args[2] = polishText(args[2]);
        }
        return await __sayWithConsent(...args);
      } catch (e2) {
        logger.warn('[tmi] Retry also failed: ' + (e2?.message || e2));
        return; // swallow the error so startup doesn’t crash
      }
    }
    throw e;
  }
}

// Commands
const handleTouchConsentCommand = consent.makeTouchConsentHandler({
  sayWithConsent,
  formatAddress,
  getSignatureForMood,
  getCurrentMood: () => currentMood
});
const tzHandlers = tzmod.makeTimezoneCommands({ sayWithConsent, formatAddress });
const handleStatusme = createStatusmeCommand({
  CHARITY_CFG,
  tzmod,
  consent,
  sayWithConsent, formatAddress, getSignatureForMood,
  getCurrentMood: () => currentMood,
  isBroadcasterUser,
  getRoleFromTags,
  isFollower,
  BROADCASTER
});
const handleLive = createLiveCommand({
  live,
  sayWithConsent, formatAddress, getSignatureForMood,
  getCurrentMood: () => currentMood
});
const handleAskCommand = createAskCommand({
  CHARITY_CFG, OLLAMA, LLM_MODEL,
  tzmod, KB,
  getChannelOrLiveContext,
  sayWithConsent, formatAddress,
  getSignatureForMood,
  getCurrentMood: () => currentMood,
  isBroadcasterUser,
  episodic,
  factRouter
});

const handleWhoAmI = createWhoAmICommand({
  CHARITY_CFG,
  sayWithConsent,
  formatAddress,
  getSignatureForMood,
  getCurrentMood: () => currentMood,
  isBroadcasterUser
});

// pass sub/mod gating + fact moderation into memory commands
const memAutoCmds = createAutoMemoryCommands({
  episodic, embedder, speaker,
  sayWithConsent, formatAddress,
  hasSubOrMod,
  moderateFactInput,
  isBroadcasterUser
});

// build command bundle and router
const commandBundle = {
  handleMe:        memAutoCmds.handleMe,
  handlePrivacy:   memAutoCmds.handlePrivacy,
  handleOptIn:     memAutoCmds.handleOptIn,
  handleOptOut:    memAutoCmds.handleOptOut,
  handleForgetMe:  memAutoCmds.handleForgetMe,

  handleRemember,      
  handleForgetFact,    
  handleProfile,       
  handleWhoAmI,        
  handleRules,         
  handleAsk: handleAskCommand, 
  recall: handleRecall,
  facts: handleFacts,
  fact:  handleFactQuery,
  status:   handleStatus,
  statusme: handleStatusMe,
  // you can add these if you want them as bang-commands later:
  // live: handleLive,
  // uptime: handleLive,
  // tc: handleTouchConsentCommand,
  // settz: tzHandlers.handleSetTzCommand,
  // mytime: tzHandlers.handleMyTimeCommand,
};

async function handleObserverCommand(client, channel, tags, rawMsg) {
  const parts = rawMsg.trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();

  if (!isBroadcasterOrMod(tags, channel)) {
    await sayWithConsent(channel, tags, `${formatAddress(tags)} Only the Guild Master or mods can change the observer mode.`);
    return;
  }

  if (sub === 'on') {
    if (!runtimeConfig.observer) {
      runtimeConfig.observer = true;
      writeConfigDebounced(runtimeConfig);
      if (runtimeConfig.observerLog) console.log('[observer] -> ON');
      await sayWithConsent(channel, tags, `Observer mode enabled. I’ll keep a low profile unless addressed directly.`);
    } else {
      await sayWithConsent(channel, tags, `Observer mode is already ON.`);
    }
    return;
  }

  if (sub === 'off') {
    if (runtimeConfig.observer) {
      runtimeConfig.observer = false;
      writeConfigDebounced(runtimeConfig);
      if (runtimeConfig.observerLog) console.log('[observer] -> OFF');
      await sayWithConsent(channel, tags, `Observer mode disabled. I’ll resume normal chatting.`);
    } else {
      await sayWithConsent(channel, tags, `Observer mode is already OFF.`);
    }
    return;
  }

  // default / status
  await sayWithConsent(channel, tags, `Observer mode is ${runtimeConfig.observer ? 'ON' : 'OFF'}. Use "!observer on" or "!observer off".`);
}

let wasLive = false;
let wentLiveAt = 0;

let BROADCASTER_ID_EFF = BROADCASTER_ID;
if (!BROADCASTER_ID_EFF) {
  try {
    const u = await helixApi('/users', { params: { login: CHANNEL } });
    BROADCASTER_ID_EFF = u?.data?.[0]?.id || '';
    if (!BROADCASTER_ID_EFF) logger.warn('[ads] unable to resolve broadcaster id');
  } catch (e) {
    logger.warn('[ads] resolve id failed: ' + (e?.message || e));
  }
}

const router = createRouter(commandBundle);

const guard = createGuildGuard({
  cfg: CHARITY_CFG.guard || {},
  logger,
  client,
  channel: `#${CHANNEL}`,
  sayWithConsent,
  isBroadcasterUser,
  persist: (next) => {
    // merge into runtime and write (so !guard tweaks survive restarts)
    try {
      runtimeConfig = { ...(runtimeConfig || {}), ...(next || {}) };
      writeConfigDebounced(runtimeConfig);
    } catch (e) { logger.warn('[guard] persist failed: ' + (e?.message || e)); }
  }
});

const town = createTownCrier({
  cfg: CHARITY_CFG.ads || {},
  broadcasterId: BROADCASTER_ID_EFF,
getTokens: (() => {
    // simple cache so we don’t call /validate too often
    let cached = { at: 0, token: '', clientId: '' };
    return async () => {
      try {
        await ensureFresh('broadcaster').catch(() => {});
        const tok = await getAccess('broadcaster');
        let raw =
          tok?.accessToken || tok?.access_token || tok?.token || (typeof tok === 'string' ? tok : '');
        if (!raw) {
          logger.warn('[ads] broadcaster token missing from getAccess(...)');
          return { clientId: process.env.TWITCH_CLIENT_ID, accessToken: '' };
        }
        // strip IRC prefix if present
        if (raw.startsWith('oauth:')) raw = raw.slice(6);

        // reuse recent validate result (60s)
        const now = Date.now();
        if (cached.token === raw && (now - cached.at < 60_000) && cached.clientId) {
          return { clientId: cached.clientId, accessToken: raw };
        }

        // discover the exact client_id tied to this token
        let clientId = process.env.TWITCH_CLIENT_ID || '';
        try {
          const resp = await fetch('https://id.twitch.tv/oauth2/validate', {
            headers: { 'Authorization': `OAuth ${raw}` }
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data?.client_id) clientId = data.client_id;
          }
        } catch {}

        cached = { at: now, token: raw, clientId };
        return { clientId, accessToken: raw };
      } catch (e) {
        logger.warn('[ads] getTokens failed: ' + (e?.message || e));
        return { clientId: process.env.TWITCH_CLIENT_ID, accessToken: '' };
      }
    };
  })(),
  sendChat: (msg) => client.say(`#${CHANNEL}`, msg),
  log: (where, e) => logger.warn(`[${where}] ${e?.message || e}`)
});

// Events
client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  const AUTO_REPLY_COOLDOWN_GLOBAL_MS = 45_000;  // ~45s between auto replies globally
  const AUTO_REPLY_COOLDOWN_USER_MS   = 90_000;  // ~90s per user
 
  const text = (message || '').trim();
  logger.info(`[debug] msg: "${text}"`);

  // Role/follower
  const platform = 'twitch';
  const follower = await isFollower(tags);
  const role = getRoleFromTags(tags, follower);
  tags._resolvedRole = role;
  logger.info(`[debug] role-resolved: ${(tags.username || '')} → ${role}`);
  
  const isLive = (live?.state?.isLive === true);
  if (isLive && !wasLive) {
    wasLive = true;
    // prefer a timestamp from live.state if you have one; else now
    wentLiveAt = Number(live?.state?.startedAtMs) || Date.now();
  } else if (!isLive && wasLive) {
    wasLive = false;
    wentLiveAt = 0;
  }

  // Party log
  noteLine({
    channel,
    login: (tags.username || '').toLowerCase(),
    display: tags['display-name'] || tags.username || 'friend',
    text
  });
  const login = (tags.username || '').toLowerCase();
  const prevSeen = lastSeenByUser.get(login) || 0;
  lastSeenByUser.set(login, Date.now());
  
// --- Status / activity (“what are you up to?”) ----------------------------
{
  const low = (text || '').toLowerCase();
  const addressed = /(^|\s)@?charity(?:[_\s-]the[_\s-]adventurer)?\b/i.test(text);
  const statusRx = /\b(what\s+are\s+you\s+(?:doing|up\s+to)|what\s+do\s+you\s+want\s+to\s+do\s+today)\b/i;

  if (addressed && statusRx.test(low)) {
    const isLive    = live?.state?.isLive === true;
    const observer  = !!runtimeConfig?.observer;
    const openingMs = (CHARITY_CFG?.features?.stream_open_window_min ?? 15) * 60_000;
    const opening   = isLive && wentLiveAt && (Date.now() - wentLiveAt <= openingMs);

    const parts = [];
    if (isLive) {
      parts.push(opening ? 'opening the Guild Hall and catching up' : 'watching chat and scouting quests');
      if (observer) parts.push('keeping a light pawprint');
    } else {
      parts.push('off-stream but listening in');
      if (observer) parts.push('quiet mode');
    }

    // Viewer-safe: never show internal flags here. Use !statusme for flags.
    // (If you ever want an override, allow GM to type “… up to --flags”)
    const wantsFlags = /\b(--flags|\[flags\]|--debug)\b/i.test(low);
    const allowFlagsHere = false; // keep false to prevent leaks
    if (allowFlagsHere && wantsFlags && CHARITY_CFG?.features?.status_flags && isModOrGM(tags)) {
      const flags = [];
      if (CHARITY_CFG.features.status_flags.observer) flags.push(`observer ${observer ? 'on' : 'off'}`);
      if (CHARITY_CFG.features.status_flags.memory)   flags.push(`memory ${episodic?.isOptedOut?.(tags) ? 'off' : 'on'}`);
      if (CHARITY_CFG.features.status_flags.facts)    flags.push(`facts ${runtimeConfig?.factExtraction?.enabled === false ? 'off' : 'on'}`);
      if (flags.length) parts.push('[' + flags.join(', ') + ']');
    }

    const tail = 'Want me to check your notes or peek at the quest board?';
    await sayWithConsent(channel, tags, `${formatAddress(tags)} I’m ${parts.join(', ')}. ${tail}`);
    return;
  }
}

// Early hook: !statusme (so we can pass raw flags like "silent")
if (/^!\s*statusme\b/i.test(text)) {
  const raw = text.replace(/^!\s*statusme\b/i, '').trim();
  await handleStatusMe(channel, tags, raw);
  return;
}

// Early hook: !status (viewer-safe)
if (/^!\s*status\b/i.test(text)) {
  await handleStatus(channel, tags);
  return;
}
  
// Early hook: allow broadcaster/mods to toggle observer mode
if (text.trim().toLowerCase().startsWith('!observer')) {
  await handleObserverCommand(client, channel, tags, text);
  return;
}

// Early hook: !recall (bypass router to be safe)
if (/^!\s*recall\b/i.test(text)) {
  const raw = text.replace(/^!\s*recall\b/i, '').trim();  // args only
  await handleRecall(channel, tags, raw);
  return;
}

// Early hook: !facts
if (/^!\s*facts\b/i.test(text)) {
  const raw = text.replace(/^!\s*facts\b/i, '').trim();
  await handleFacts(channel, tags, raw);
  return;
}

// Early hook: !fact
if (/^!\s*fact\b/i.test(text)) {
  const raw = text.replace(/^!\s*fact\b/i, '').trim();
  await handleFactQuery(channel, tags, raw);
  return;
}
// Early hooks for privacy & memory (always fire, bypass router)
if (/^!\s*privacy\b/i.test(text))   { await memAutoCmds.handlePrivacy(channel, tags); return; }
if (/^!\s*optout\b/i.test(text))    { await memAutoCmds.handleOptOut(channel, tags);  return; }
if (/^!\s*optin\b/i.test(text))     { await memAutoCmds.handleOptIn(channel, tags);   return; }
if (/^!\s*forgetme\b/i.test(text))  { await memAutoCmds.handleForgetMe(channel, tags);return; }
if (/^!\s*me\b/i.test(text))        { await memAutoCmds.handleMe(channel, tags);      return; }
if (/^!\s*profile\b/i.test(text))   { await handleProfile(channel, tags);             return; }
// Commands: !guard (mods/GM)
if (/^!\s*guard\b/i.test(text)) {
  const parts = text.trim().split(/\s+/); parts.shift();
  await guard.handleCommand(parts, tags);
  return;
}
// Command: !permit <user> [sec]
if (/^!\s*permit\b/i.test(text)) {
  const parts = text.trim().split(/\s+/); parts.shift();
  await guard.handlePermitCommand(parts, tags);
  return;
}

// After tags/_resolvedRole are set and before other checks:
if (!text.startsWith('!')) {
  const handled = await guard.onMessage(tags, text);
  if (handled) return; // message was deleted / handled
}

// simple greetings → varied, stream/daypart-aware, role title only once/day
const low = (text || '').toLowerCase();
const mentionsMe = /\bcharity\b|^@?charity/.test(low);
const greetRx = /^(?:hi|hey|hello|gm|ga|ge|gn|good\s*(morning|afternoon|evening|night)|mornin[g']?|morning|afternoon|evening|night)\b/i;
const gr = greetRx.exec(low);
if (mentionsMe && gr) {
  const daypart =
    (gr[1]?.toLowerCase()) ||
    (low.startsWith('gm') || low.includes('morning')   ? 'morning'   :
     low.startsWith('ga') || low.includes('afternoon') ? 'afternoon' :
     low.startsWith('ge') || low.includes('evening')   ? 'evening'   :
     low.startsWith('gn') || low.includes('night')     ? 'night'     : 'morning');
  
  const lex = CHARITY_CFG?.style?.lexicon || {};
  const gmap = lex.greetings_by_daypart || {};
  const base = pick(gmap[daypart] || ['Good day']);
  const interest = pick(lex.greeting_interest_lines || ['How are your quests going today?']);
  const welcomeBacks = lex.greeting_welcome_back || ['Good to see you again.'];
  const openers = lex.stream_opening_lines || [];
  const tz = CHARITY_CFG?.runtime?.timezone || 'America/New_York';
  const dayKey = localDayKeyTZ(tz);

  // role title only the first time we see the user today
  const priorDay = greetedOnDay.get(login);
  const voc = makeVocative(tags, { includeRole: priorDay !== dayKey });
  greetedOnDay.set(login, dayKey);

  // welcome back if gone for N+ days
  let wb = '';
  if (prevSeen) {
    const daysAway = Math.floor((Date.now() - prevSeen) / 86_400_000);
    const thresh = CHARITY_CFG?.features?.greeting_welcome_back_days ?? 5;
    if (daysAway >= thresh) wb = ' ' + pick(welcomeBacks);
  }

  // add a soft "opening the hall" flavor if within stream-open window
  let opener = '';
  const windowMin = CHARITY_CFG?.features?.stream_open_window_min ?? 15;
  if (isLive && wentLiveAt && (Date.now() - wentLiveAt) <= windowMin * 60_000 && openers.length) {
    opener = ' ' + pick(openers);
  }

  const sig = getSignatureForMood(currentMood);
  await sayWithConsent(channel, tags, `${base}, ${voc}!${opener}${wb} ${interest} ${sig}`.trim());
  return;
}

// --- Pending taste classification capture (one short line) ---
{
  const login = (tags.username || '').toLowerCase();
  const pending = tastePending.get(login);
  if (pending && !isCommand(text)) {
    const tasteCfg = CHARITY_CFG?.style?.taste || {};
    // accept simple answers like "JRPG" or "Metroidvania", or a 1–3 word phrase
    const short = text.trim();
    if (/^[a-z][a-z0-9\s\-]{2,32}$/i.test(short)) {
      // normalize via taxonomy
      const inferred = inferTasteFromValue(short);
      const label =
        (pending.kind === 'genre'     && (inferred.genres[0]    || short)) ||
        (pending.kind === 'mechanic'  && (inferred.mechanics[0] || short)) ||
        (pending.kind === 'vibe'      && (inferred.vibes[0]     || short)) ||
        short;

      const keyToSave =
        (pending.kind === 'genre'    && tasteCfg.save_keys?.genre)   ||
        (pending.kind === 'mechanic' && tasteCfg.save_keys?.mechanic)||
        (pending.kind === 'vibe'     && tasteCfg.save_keys?.vibe)    ||
        'likes_genre';

      try {
        if (typeof episodic.putFact === 'function') {
          episodic.putFact(tags, { k: keyToSave, v: label, confidence: 0.7, locked: 0 });
        }
        await sayWithConsent(channel, tags, `${formatAddress(tags)} Noted — you enjoy ${label}.`);
      } catch (e) {
        logger.warn('[taste] save failed: ' + (e?.message || e));
      }
      tastePending.delete(login);
      return; // handled
    }
    // If the user replies with “yes/no” (in case we add guesses later), just clear
    if (/^\s*(yes|y|no|n)\s*$/i.test(text)) {
      tastePending.delete(login);
      return;
    }
  }
}

const isCmd = isCommand?.(text);
const isSystem = tags?.username?.toLowerCase() === 'streamelements' || tags?.badges?.bot === '1';

// Town Crier: !ads [next|snooze|run <30..180>]
if (/^!\s*ads\b/i.test(text)) {
  const parts = text.trim().split(/\s+/); parts.shift(); // remove "!ads"
  const isModOrBroad = tags?.mod === true || (tags['user-id'] === BROADCASTER_ID_EFF);
  await town.handleCommand('ads', parts, isModOrBroad);
  return;
}
// Farewell awareness — respond to departures politely
{
  const low = (text || '').toLowerCase();
  // Common leaving/thanks patterns
  const byeRx = /\b(see\s+ya|see\s+you\s+later|later\s+all|later\s+everyone|gtg|gotta\s+go|i'?m\s+out|heading\s+out|time\s+to\s+go)\b/;
  const nightRx = /\b(good\s*night|gn|off\s+to\s+bed|bed\s*time|time\s+for\s+sleep|turning\s+in)\b/;
  const thanksRx = /\b(thanks\s+for\s+(the\s+)?(stream|today|tonight)|ty\s+for\s+(the\s+)?stream|appreciate\s+the\s+stream)\b/;

  const isFarewell = byeRx.test(low) || nightRx.test(low) || thanksRx.test(low);
  if (isFarewell) {
    // per-user cooldown to avoid repeats
    const now = Date.now();
    const key = 'bye:' + (tags['user-id'] || (tags.username || '').toLowerCase());
    const last = lastUserReplyAt.get(key) || 0;
    if (now - last < 60_000) { /* suppress duplicate */ } else {
      lastUserReplyAt.set(key, now);

      const lex = CHARITY_CFG?.style?.lexicon || {};
      const fMap = lex.farewells_by_daypart || {};
      // reuse daypart picker from greets
      const daypart =
        (low.includes('morning')   ? 'morning'   :
         low.includes('afternoon') ? 'afternoon' :
         low.includes('evening')   ? 'evening'   :
         'night'); // lean "night" for bed/gn

      const base = pick(fMap[daypart] || ['See you soon']);
      const thanksLine = thanksRx.test(low) ? (' ' + pick(lex.farewell_thanks_lines || ['Thanks for hanging out.'])) : '';
      const sig = getSignatureForMood(currentMood);

      // On live streams, a tiny nod to the hall without repeating role
      const display = tags['display-name'] || tags.username;
      const msg = `${base}, ${display}.${thanksLine} ${sig}`.trim();
      await sayWithConsent(channel, tags, msg);
      return;
    }
  }
}


// pre-extraction (before observer gate)
if (!isCmd && !isSystem && (runtimeConfig?.factExtraction?.enabled !== false)) {
  try {
    const cands = await factExtractor.extractCandidates(text, tags);

    // (optional) also record as candidates for audit/promotion
    if (cands?.length && typeof episodic.addFactCandidates === 'function') {
      try { episodic.addFactCandidates(tags, /*episodeId*/ null, cands); } catch {}
    }
 const SKIP_KEYS = new Set(['username','contact','email','phone','token','password']);
 for (const c of (cands || [])) {
   const key = String(c.key || '').trim().toLowerCase();
   const val = String(c.value || '').trim();
   if (!key || !val) continue;
   if (SKIP_KEYS.has(key)) continue;

   // save immediately so !facts / quick-QA see it
   try {
     episodic.putFact(tags, {
       k: key, v: val,
       confidence: Math.max(0.5, Math.min(1, Number(c.confidence ?? 0.85))),
       locked: 0
     });
     logger.info?.(`[facts] saved ${key}=${val}`);
   } catch (e) {
     logger.warn?.('[facts] putFact failed: ' + (e?.message || e));
   }

   // Auto-enrich: derive a taste from favorites
   if (key.startsWith('favorite_')) {
     const guess = inferTasteFromValue(val);
     const genre = guess.genres?.[0];
     if (genre) {
       episodic.putFact(tags, { k: 'likes_genre', v: genre, confidence: 0.6, locked: 0 });
     }
   }
 }
	

	// --- simple fallback: "my favorite X is Y"
try {
  const m = /\bmy\s+favorite\s+([a-z][a-z\s]{0,24}?)\s+is\s+([^.!?\n]{2,80})/i.exec(text);
  if (m) {
    const keyRaw = m[1].trim();          // e.g., "game"
    let valRaw  = m[2].trim();           // e.g., "Lunar 2: Eternal Blue Complete"
    valRaw = valRaw.replace(/^["']|["']$/g, ''); // strip wrapping quotes

    // normalize the key; prefer a canonical key for "game"
    let normKey = normalizeKey(keyRaw);  // your helper above
    if (/^video?\s*game(s)?$|^game(s)?$/.test(keyRaw.toLowerCase())) {
      normKey = 'favorite_game';
    } else {
      normKey = ('favorite_' + normKey).slice(0, 32);
    }
    const normVal = cleanValue(valRaw);  // your helper above
	const login = (tags.username || '').toLowerCase();
	lastWorkByUser.set(login, normVal.toLowerCase());


    // avoid dupes if the exact value is already stored
    const existing = episodic.getFactsByTags(tags, 50).find(f => f.k === normKey && f.v === normVal);
    if (!existing && typeof episodic.putFact === 'function') {
      episodic.putFact(tags, {
        k: normKey,
        v: normVal,
        confidence: 0.92,
        locked: 0
      });
      logger.info?.(`[facts] simple-extract ${normKey}="${normVal}"`);
    }
  }
} catch (e) {
  logger.warn?.('[facts] simple-extract failed: ' + (e?.message || e));
}

  } catch (e) {
    // never block chat flow
    logger?.warn?.('[facts] extraction failed: ' + (e?.message || e));
  }
}

// Observer Mode: stay silent unless directed (commands, mentions, or configured triggers)
if (runtimeConfig?.observer) {
  const directed =
    isCommand(text) ||
    messageHasTrigger(text, runtimeConfig.observerTriggers) ||
    /(^|\s)@?charity(?:[_\s-]the[_\s-]adventurer)?\b/i.test(text);

  if (!directed) {
    // 👇 Still learn, even when silent
    if (text && !text.startsWith('!')) {
      try {
        await episodic.ingest({
          tags,
          text,
          embedder,
          importance: 1.0,
          optedOut: episodic.isOptedOut(tags),
        });
        // promote strong candidates occasionally (no chat)
        const login = (tags.username || '').toLowerCase();
        const now = Date.now();
        const last = lastPromotionAt.get(login) || 0;
        if (now - last > 60_000) {
          try {
            const n = episodic.promoteCandidates({
              tags,
              minConfidence: 0.9,
              minCount: 3,
              limit: 5,
              lock: 1,
            });
            if (n > 0) logger.info(`[facts] promoted ${n} candidate(s)`);
          } catch (e) {
            logger.warn('[facts] promotion failed: ' + (e?.message || e));
          }
          lastPromotionAt.set(login, now);
        }
      } catch (e) {
        logger.warn('[episodic] silent ingest failed: ' + (e?.message || e));
      }
    }
    // stay silent
    if (runtimeConfig.observerLog) {
      // console.log('[observer] suppressed reply:', tags.username, '::', text);
    }
    return;
  }
}



// Fast, deterministic catch (pings) — exclude "up to"
{
  const lowPing = (text || '').toLowerCase();
  const mentionsMeLoosely =
    /\bcharity(?:[_\s-]the[_\s-]adventurer)?\b/i.test(text) || /@\s*charity/i.test(text);
  const pingHit =
    /\b(?:are\s+you\s+(?:there|around|here)|you\s+(?:there|around|here)|are\s+you\s+up\b(?!\s+to))/i.test(lowPing);
  if (pingHit && (mentionsMeLoosely || /\?\s*$/.test(text))) {
    const isLive = (live?.state?.isLive === true);
    const t = `${formatAddress(tags)} ${pickPingLine(isLive)}`;
    return sayWithConsent(channel, tags, formatReply({ text: t, platform }));
  }
}


  // 1) bang-commands
  if (await router.route({ channel, tags, message: text })) return;
	  
	// 2) mention-ask alias guard — compute booleans the block below relies on
	const lower = (text || '').toLowerCase();

	// @mention or “charity …” by name
	const addressedByAt =
	  /(^|\s)@?charity(?:[_\s-]the[_\s-]adventurer)?\b/i.test(text);
	const addressedByName =
	  /\bcharity\b/i.test(lower);

	const replyingToMe = addressedByAt || addressedByName;

	// looks like a question (“?” or question-word)
	const looksLikeQuestion =
	  /[?]\s*$|^(who|what|where|when|why|how|can|could|do|did|does|are|is|should|would|will)\b/i.test(lower);

	// don’t trigger on commands or pure emote spam
	const isBang = lower.startsWith('!');
	const isEmoteSpam =
		/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\w:]+$/u.test(text) && text.length <= 25;

	// final gate used by the block below
	const shouldTrigger = !isBang && !isEmoteSpam && (replyingToMe || looksLikeQuestion);


if (shouldTrigger) {
  try {
    const who = tags['user-id'] || (tags.username || '').toLowerCase();
    const now = Date.now();
    const last = askCooldown.get(who) || 0;
    if (now - last < ASK_COOLDOWN_MS) {
      logger.info(`[mention-ask] cooldown blocked for ${who}`);
      return;
    }
    askCooldown.set(who, now);
    logger.info('[mention-ask] alias fired');

    let question = text;
    if (replyingToMe && !looksLikeQuestion && !question.endsWith('?')) {
      question = `Follow-up: ${question}`;
    }
// "what game was I just talking about?"
if (/\bwhat\s+game\s+was\s+i\s+just\s+talking\s+about\??$/i.test(lower)) {
  const login = (tags.username || '').toLowerCase();
  const last = lastWorkByUser.get(login);
  if (last) {
    // use the exact casing if present in the original message later; title-case fallback:
    const title = last.split(' ').map(w => w.length>2 ? w[0].toUpperCase()+w.slice(1) : w).join(' ');
    await sayWithConsent(channel, tags, `${formatAddress(tags)} You were talking about ${title}.`);
  } else {
    await sayWithConsent(channel, tags, `${formatAddress(tags)} I didn’t catch a title just now.`);
  }
  return;
}


    // ✅ QUICK FAVORITE-QA FIRST (answer from saved facts)
    let answered = false;
    if (looksLikeQuestion) {
      const favQ = /\bwhat(?:'s| is)\s+my\s+(.+?)\s*\?*$/i.exec(lower);
      if (favQ) {
        const known = episodic.getFactsByTags(tags, 50) || [];
        if (known.length) {
          // 1) direct key check for favorite_game (and close variants)
          const direct = known.find(f =>
            f.k === 'favorite_game' || /^favorite_?game(s)?$/.test(f.k)
          );
          if (direct) {
            const ans = naturalizeFactReply(direct.k, direct.v, tags);
            await sayWithConsent(channel, tags, ans);

            // gentle follow-up: ask genre if unknown
            const tasteCfg = CHARITY_CFG?.style?.taste || {};
            const guess = inferTasteFromValue(direct.v);
			if ((CHARITY_CFG?.style?.debug_taste ?? CHARITY_CFG?.debug_taste)) {
			  logger.info('[taste/debug]', direct.v, '→', guess);
			}
            if (tasteCfg.ask_unknown && !(guess.genres?.length)) {
              const eg = (tasteCfg.ask_examples || []).slice(0, 2).join(', ') || 'JRPG, Metroidvania';
              await sayWithConsent(channel, tags, `${formatAddress(tags)} What kind of game is ${direct.v}? (e.g., ${eg})`);
              const login = (tags.username || '').toLowerCase();
              tastePending.set(login, { kind: 'genre', subject: direct.v, ts: Date.now() });
            }
            answered = true;
          } else {
            // 2) fallback to router
            const keys = known.map(f => f.k);
            const decision = await factRouter.route({ question: text, keys });
            if (decision?.kind === 'lookup' && decision.key) {
              const hit = known.find(f => f.k === decision.key);
              if (hit) {
                await sayWithConsent(channel, tags, naturalizeFactReply(hit.k, hit.v, tags));
                answered = true;
              }
            }
          }
        }
      }
    }

    if (answered) return;

    // 👇 remember who asked so working memory can add viewerLine/profileFacts
    lastAskTags = tags;
    await handleAskCommand(channel, tags, `!ask ${question}`);
    return;

  } catch (e) {
    logger.warn('[mention-ask] failed: ' + (e?.message || e));
  }
}


	// 3) classification fast path — ONLY when addressed or clearly a question
  if (replyingToMe || looksLikeQuestion) {
	    // Never route pings to policy/LLM
    if (/\b(?:are\s+you\s+(?:there|around|here)|you\s+(?:there|around|here)|\bare\s+you\s+up)\b/i.test(text)) {
      const t = `${formatAddress(tags)} I’m here and focused.`;
      return sayWithConsent(channel, tags, t);
    }
   try {
     const cls = await classify(text);
     const action = decide({ platform, channel, tags, text, classification: cls });
     if (action?.kind === 'SAY' && action.text) {
       const who = tags['user-id'] || (tags.username || '').toLowerCase();
       const now = Date.now();
       if (now - lastAutoReplyAt < AUTO_REPLY_COOLDOWN_GLOBAL_MS) return;
       if (now - (lastUserReplyAt.get(who) || 0) < AUTO_REPLY_COOLDOWN_USER_MS) return;
       lastAutoReplyAt = now;
       lastUserReplyAt.set(who, now);
       return sayWithConsent(channel, tags, action.text);
     }
   } catch (e) {
     logger.warn('[policy] fast-path decide failed: ' + (e?.message || e));
   }
 }
  
// If not addressed and not a question, skip the heavy reasoner
if (!(replyingToMe || looksLikeQuestion)) {
  return; // stay quiet unless directly engaged
}
  // 4) natural chat → reasoner
  const wm = await buildWorkingMemory({ channel, focusText: text, tags });
  const addressee = pickAddressee({
    authorLogin: (tags.username || '').toLowerCase(),
    authorDisplay: tags['display-name'] || tags.username || 'friend'
  });
  const r = await reasonAndReply(
    { channel, userLogin: (tags.username || '').toLowerCase(), userDisplay: tags['display-name'] || tags.username || 'friend', text },
    wm,
    { logger }
  );

	if (r?.reply) {
	  const final = sanitizeReplyAddressing(r.reply, addressee);
	  const who = tags['user-id'] || (tags.username || '').toLowerCase();
	  const now = Date.now();
	  lastAutoReplyAt = now;
	  lastUserReplyAt.set(who, now);
	  await sayWithConsent(channel, tags, final);
	}


// 5) memory ingest (post-reply so we don’t delay)
if (text && !text.startsWith('!')) {
  // single, authoritative ingest
  const episodeId = await episodic.ingest({
    tags,
    text,
    embedder,
    importance: 1.0,
    optedOut: episodic.isOptedOut(tags),
  });

const login = (tags.username || '').toLowerCase();
const now = Date.now();
const last = lastPromotionAt.get(login) || 0;

if (now - last > 60_000) { // throttle per user to 1/min
  try {
    const n = episodic.promoteCandidates({
      tags,
      minConfidence: 0.9,
      minCount: 3,
      limit: 5,
      lock: 1,
    });
    if (n > 0) logger.info(`[facts] promoted ${n} candidate(s)`);
  } catch (e) {
    logger.warn('[facts] promotion failed: ' + (e?.message || e));
  }
  lastPromotionAt.set(login, now);
}
const u = episodic.getUserByTags(tags);

 if (u && !u.disclosed && !u.opt_out) {
   if (replyingToMe || looksLikeQuestion) {
     await sayWithConsent(channel, tags, `${addressee} I remember small preferences to chat better — !optout anytime.`);
   }
   episodic.markDisclosedByTags(tags); // still mark, just don’t speak unless engaged
 }

  // optional: auto fact extraction
  if ((runtimeConfig?.factExtraction?.enabled !== false) && factExtractor && !episodic.isOptedOut(tags)) {
   try {
     const cands = await factExtractor.extractCandidates(text, tags);
     for (const c of (cands || [])) {
       if (!c || !c.key || !c.value) continue;
       episodic.putFact(tags, { k: c.key, v: c.value, confidence: c.confidence ?? 0.5, locked: 0 });
      }
    } catch (e) {
      logger.warn('[fact] extract failed: ' + (e?.message || e));
  }
 }
}

});


// After the message listener, the rest of the connection lifecycle handlers:

client.on('connected', () => logger.info(`[tmi] connected; joining #${CHANNEL} as ${BOT_USERNAME}`));
client.on('join', (ch, user, self) => self && console.log('[tmi] joined', ch));
// (keep one disconnected handler below with logger)

// Fire the startup announce only after we actually joined the channel
client.on('join', (chan, username, self) => {
  if (!self) return; // only when the bot itself joins
  setTimeout(() => {
    try {
      (announcer?.maybeAnnounce || (()=>{}))({
        sayWithConsent,
        channel: chan, // already "#bagotrix"
        isLive: live?.state?.isLive === true
      });
    } catch (e) {
      logger.warn('[announce] delayed failed: ' + (e?.message || e));
    }
  }, 1500);
});
async function restartTmi(reason) {
  try {
    logger.warn(`[tmi] restarting client: ${reason || 'unknown'}`);
    try { client.removeAllListeners(); } catch {}
    try { await client.disconnect().catch(() => {}); } catch {}

    // Make sure the bot token is fresh, then pull a new IRC password
    await ensureFresh('bot').catch(() => {});
    const freshPw = await getIrcPassword(logger);

    const fresh = new tmi.Client({
      connection: { reconnect: true, secure: true },
      identity:   { username: BOT_USERNAME, password: freshPw },
      channels:   [ `#${CHANNEL}` ],
    });

    // Re-wire your message handlers here if they aren’t closure-based
    // (If your handlers close over `client`, they’ll see the reassigned value)
    // e.g. wireMessageHandlers(fresh);

    await fresh.connect();
    client = fresh;
    logger.info('[tmi] reconnected with fresh password');
  } catch (e) {
    logger.warn('[tmi] restart failed: ' + (e?.message || e));
  }
}

client.on('disconnected', (reason) => {
  const r = String(reason || '').toLowerCase();
  logger.warn(`[tmi] disconnected: ${reason}`);
  if (r.includes('login authentication failed')) {
    restartTmi('auth failed');
  }
  // For plain network flakes, tmi will try to reconnect; we still
  // restart so we pick up any token changes.
  restartTmi('net/disconnected');
});

client.on('reconnect', () => {
  // tmi.js reconnect doesn’t know about our fresh tokens—restart is safer.
  logger.warn('[tmi] reconnect event; rebuilding to ensure fresh token');
  restartTmi('tmi reconnect');
});

// ================================
// Discord (DM) bootstrap + handler
// ================================
async function startDiscord() {
  if (!DISCORD_TOKEN) {
    logger.info('[discord] skipped: DISCORD_TOKEN not set');
    return;
  }
  const dc = new DiscordClient({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  dc.once('ready', () => {
    logger.info(`[discord] logged in as ${dc.user?.tag || 'unknown'}`);
  });

  dc.on('messageCreate', async (msg) => {
    try {
      // DM-only + allowlist guard
      if (msg.author?.bot) return;
      if (msg.guildId) return; // ignore guild channels for now
      if (DISCORD_DM_ALLOW.length && !DISCORD_DM_ALLOW.includes(msg.author.id)) {
        await msg.reply('DMs are restricted right now.');
        return;
      }

      const text = String(msg.content || '').trim();
      if (!text) return;

      const channel = '#discord-dm';
      const tags = discordTagsFor(msg.author);
      const platform = 'discord';

      // Party log parity
      noteLine({
        channel,
        login: tags.username,
        display: tags['display-name'] || tags.username || 'friend',
        text
      });

      // 1) Commands (bangs) — reuse your router exactly
      if (text.startsWith('!')) {
        if (await router.route({ channel, tags, message: text })) return;
      }

      // 2) Ping quick-reply parity
      const low = text.toLowerCase();
      if (/\b(?:are\s+you\s+(?:there|around|here)|you\s+(?:there|around|here))\b/.test(low)) {
        const t = `${tags['display-name'] || tags.username}, ${pickPingLine(live?.state?.isLive === true)}`;
        await msg.reply(t.slice(0, 2000));
        return;
      }

      // 3) Natural chat — treat DMs as "addressed" so we always respond
      const replyingToMe = true;
      const looksLikeQuestion = /[?]\s*$/.test(text) || /\b(who|what|where|when|why|how|can|could|do|did|does|are|is|should|would|will)\b/i.test(low);
      if (!(replyingToMe || looksLikeQuestion)) {
        // In DMs we still reply; keep tone light/short if you prefer
      }

      const wm = await buildWorkingMemory({ channel, focusText: text, tags });
      const addressee = pickAddressee({
        authorLogin: tags.username,
        authorDisplay: tags['display-name'] || tags.username
      });
      const r = await reasonAndReply(
        { channel, userLogin: tags.username, userDisplay: tags['display-name'] || tags.username, text },
        wm,
        { logger }
      );
      let out = String(r?.reply || '').trim();
      if (!out) {
        logger.warn('[discord] reasoner returned no reply; using soft fallback');
        out = `${tags['display-name'] || tags.username}, I’m here and listening. What’s on your mind?`;
      } else {
        out = sanitizeReplyAddressing(out, addressee);
      }
      await msg.reply(out.slice(0, 2000));

      // 4) Memory ingest — same as Twitch
      try {
        await episodic.ingest({
          tags,
          text,
          embedder,
          importance: 1.0,
          optedOut: episodic.isOptedOut(tags),
        });
      } catch (e) {
        logger.warn('[discord] ingest failed: ' + (e?.message || e));
      }
    } catch (e) {
      logger.warn('[discord] handler failed: ' + (e?.message || e));
      try { await msg.reply('⚠️ I hit an error.'); } catch {}
    }
  });

  try {
    await dc.login(DISCORD_TOKEN);
  } catch (e) {
    logger.warn('[discord] login failed: ' + (e?.message || e));
  }
}

// Start Discord alongside Twitch
startDiscord().catch(e => logger.warn('[discord] start failed: ' + (e?.message || e)));
