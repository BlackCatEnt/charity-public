// index.mod.js — Phase 3 (fixed): LIVE context, replies, !live/!uptime
import './env-bootstrap.js';
import { assertRequiredEnv } from './env-bootstrap.js';
assertRequiredEnv();

import tmi from 'tmi.js';
import fs from 'fs';
import path from 'path';

import { loadConfig } from './modules/config.js';
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
const embedder = await createEmbedder(CHARITY_CFG, logger);
const episodic = createEpisodicStore(logger);
const speaker  = createMemorySpeaker({});

// Escape a string for literal use in RegExp
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function twitchSafe(msg, limit = 480) {
  return (msg || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// Resolve token module in a robust way (used by reply + live services)
async function importTokenModule() {
  try { return await import('./token.js'); } catch {}
  try { return await import('../token.js'); } catch {}
  try { return await import('../../token.js'); } catch {}
  return null;
}

// KB + services
const KB = createKB(logger, OLLAMA);
const consent = createConsent(CHARITY_CFG, logger);
const tzmod = createTimezone(CHARITY_CFG, logger);
const reply = createReply(CHARITY_CFG, logger, importTokenModule, BROADCASTER);
const live = createLive(CHARITY_CFG, logger, importTokenModule, BROADCASTER);
const announcer = createAnnouncer(CHARITY_CFG, logger);
// (optional fail-safe so a missing module won't crash)
const _announcer = announcer || { maybeAnnounce: () => {} };

live.start();

// adapters
const isBroadcasterUser = (tags) => {
  // Prefer hard ID match when provided
  if (BROADCASTER_ID && (tags?.['user-id'] === BROADCASTER_ID)) return true;
  return _isBroadcasterUser(tags, BROADCASTER, CHARITY_CFG?.style?.lexicon?.guild_master);
};
const getRoleFromTags = (tags, followerKnown=false) => _getRoleFromTags(tags, followerKnown, BROADCASTER, CHARITY_CFG?.style?.lexicon?.guild_master);
const isFollower = (tags) => _isFollower(tags, CHARITY_CFG?.features || {}, BROADCASTER);

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
  episodic.upsertFactByTags(tags, res.key, res.value, { confidence: locked ? 0.9 : 0.7, locked });
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
  const facts = episodic.getFactsByTags(tags, 8);
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
  const taste = best ? `${best.k.replace(/_/g,' ')}: ${best.v}` : '';

  const line = [opener, taste].filter(Boolean).join(' ');
  return sayWithConsent(channel, tags, `${formatAddress(tags)} ${line || 'I’m still learning your story. Add a note with !remember key: value'}`);
 }

async function handleStory(channel, tags) {
  const u = episodic.getUserByTags(tags);
  const facts = episodic.getFactsByTags(tags, 5);
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


const MOOD_DEFAULT = 'default';
let currentMood = MOOD_DEFAULT;
function getSignatureForMood(mood=MOOD_DEFAULT) {
  const sigBy = CHARITY_CFG?.style?.lexicon?.signature_by_mood || {};
  return sigBy[mood] || CHARITY_CFG?.style?.lexicon?.signature || '✧';
}

let lastAskTags = null;



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

  const facts = episodic.getFactsByTags(lastAskTags, 6) || [];
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

// ---- AUTH (prefer token.js; fallback to env; sync .env; log validate result) ----
function detectEnvPath() {
  const hinted = process.env.ENV_FILE;
  if (hinted && hinted.trim()) return path.resolve(hinted.trim());
  return path.resolve('./.env');
}
function syncEnvVar(filePath, key, value) {
  let data = '';
  let crlf = '\n';
  if (fs.existsSync(filePath)) {
    data = fs.readFileSync(filePath, 'utf8');
    crlf = data.includes('\r\n') ? '\r\n' : '\n';
  }
  const line = `${key}=${value}`;
  if (!data) {
    fs.writeFileSync(filePath, line + crlf, 'utf8');
    return true;
  }
  const reLine = new RegExp(`^${key}=.*`, 'm');
  if (reLine.test(data)) {
    const current = reLine.exec(data)[0];
    if (current === line) return false;
    const updated = data.replace(reLine, line);
    fs.writeFileSync(filePath, updated, 'utf-8');
    return true;
  } else {
    if (!data.endsWith('\n') && !data.endsWith('\r\n')) data += crlf;
    data += line + crlf;
    fs.writeFileSync(filePath, data, 'utf-8');
    return true;
  }
}

async function resolvePassword() {
  // Prefer token.js (refreshable)
  try {
    const tok = await importTokenModule(); // tries ./token.js, ../token.js, ../../token.js
    if (tok?.loadTokenState) {
      let st = tok.loadTokenState();
      let access = st?.access_token;

      // If token.js exposes a validator/refresh, make sure it's fresh
      if (access && typeof tok.validateToken === 'function' && typeof tok.refreshToken === 'function') {
        try {
          const v = await tok.validateToken(access);
          const mins = (v && (v.minutesRemaining ?? v.minutes_remaining));
          if (!v?.ok || (typeof mins === 'number' && mins < 10)) {
            const r = await tok.refreshToken(st);
            if (r?.ok) {
              st = tok.loadTokenState();
              access = st?.access_token;
              logger.info('[auth] token.js access_token refreshed for IRC');
            }
          }
        } catch (e) {
          logger.warn('[auth] token.js validate/refresh failed: ' + (e?.message || e));
        }
      }

      if (access) {
        const normalized = access.startsWith('oauth:') ? access : `oauth:${access}`;
        // Sync to .env so future boots pick it up
        try {
          const envPath = detectEnvPath();
          const changed = syncEnvVar(envPath, 'TWITCH_OAUTH', normalized);
          if (changed) logger.info(`[auth] Synced TWITCH_OAUTH to ${envPath}`);
          process.env.TWITCH_OAUTH = normalized;
        } catch (e) {
          logger.warn('[auth] Failed to sync TWITCH_OAUTH to .env: ' + (e?.message || e));
        }
        logger.info('[auth] Using token.js access_token for IRC');
        return normalized;
      }
    }
  } catch (e) {
    logger.warn('[auth] token.js not available or failed, will try TWITCH_OAUTH: ' + (e?.message || e));
  }

  // Fallback to env
  let pw = process.env.TWITCH_OAUTH;
  if (pw && !pw.startsWith('oauth:')) pw = 'oauth:' + pw;
  if (pw) {
    // Normalize .env to include the oauth: prefix if missing
    try {
      const envPath = detectEnvPath();
      const changed = syncEnvVar(envPath, 'TWITCH_OAUTH', pw);
      if (changed) logger.info(`[auth] Normalized TWITCH_OAUTH in ${envPath}`);
    } catch (e) {
      logger.warn('[auth] Failed to normalize TWITCH_OAUTH in .env: ' + (e?.message || e));
    }
    logger.info(`[auth] Using TWITCH_OAUTH env (len=${pw.length}) for bot=${BOT_USERNAME}`);
  }
  return pw;
}

async function validateTokenLogin(oauthPrefixed) {
  if (!oauthPrefixed) return null;
  const raw = oauthPrefixed.startsWith('oauth:') ? oauthPrefixed.slice(6) : oauthPrefixed;
  // Try 'Bearer' first (Helix), then 'OAuth' (older scheme)
  for (const scheme of ['Bearer', 'OAuth']) {
    try {
      const res = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { 'Authorization': `${scheme} ${raw}` }
      });
      if (res.ok) {
        const data = await res.json();
        const login = (data?.login || '').toLowerCase();
        const scopes = Array.isArray(data?.scopes) ? data.scopes : [];
        logger.info(`[auth] token validate via ${scheme}: login=${login || 'unknown'} scopes=${scopes.join(',')}`);
        return { login, scopes };
      }
    } catch (e) {
      logger.warn('[auth] validate error: ' + (e?.message || e));
    }
  }
  logger.warn('[auth] token validation failed (this may be normal if using a pure IRC token).');
  return null;
}

const PASSWORD = await resolvePassword();
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

// tmi client
const client = new tmi.Client({
  options: { debug: false },
  identity: {
    username: BOT_USERNAME,
    password: PASSWORD
  },
  channels: [ `#${CHANNEL}` ]
});

// sayWithConsent (reply-aware) with one retry on "No response from Twitch"
const __sayWithConsent = consent.makeSayWithConsent(client, twitchSafe, isBroadcasterUser, {
  sendReplyCore: (channel, text, parent, limit=480) =>
    reply.sendReply({ channel, message: text, parentMsgId: parent, client, twitchSafe })
});

async function sayWithConsent(...args) {
  try {
    return await __sayWithConsent(...args);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/No response from Twitch/i.test(msg)) {
      logger.warn('[tmi] No response; backing off 1200ms and retrying once.');
      await new Promise(r => setTimeout(r, 1200));
      try {
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
  episodic,         // from createEpisodicStore(logger)
  embedder,         // from await createEmbedder(CHARITY_CFG, logger)
  speaker,          // from createMemorySpeaker({})
  sayWithConsent,   // built from consent + client
  formatAddress     // your helper in index.mod.js
});

// build command bundle and router
const commandBundle = {
  handleMe:        memAutoCmds.handleMe,
  handlePrivacy:   memAutoCmds.handlePrivacy,
  handleOptIn:     memAutoCmds.handleOptIn,
  handleOptOut:    memAutoCmds.handleOptOut,
  handleForgetMe:  memAutoCmds.handleForgetMe,

  handleRemember,      // from this file
  handleForgetFact,    // from this file
  handleProfile,       // from this file
  handleWhoAmI,        // from modules/whoami.js
  handleRules,         // from this file
  handleAsk: handleAskCommand, // from commands/ask.js

  // you can add these if you want them as bang-commands later:
  // live: handleLive,
  // uptime: handleLive,
  // statusme: handleStatusme,
  // tc: handleTouchConsentCommand,
  // settz: tzHandlers.handleSetTzCommand,
  // mytime: tzHandlers.handleMyTimeCommand,
};

const router = createRouter(commandBundle);

// Events
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const text = (message || '').trim();

  logger.info(`[debug] msg: "${text}"`);

  const follower = await isFollower(tags);
  const role = getRoleFromTags(tags, follower);
  tags._resolvedRole = role;
  logger.info(`[debug] role-resolved: ${(tags.username || '')} → ${role}`);

  // 1) bang-commands
  if (await router.route({ channel, tags, message: text })) return;

  // 2) mention alias → !ask
  const replyingToMe =
    ((tags['reply-parent-user-login'] || '').toLowerCase() === BOT_USERNAME) ||
    ((tags['reply-parent-display-name'] || '').toLowerCase().replace(/\s+/g,'_') === BOT_USERNAME);

  const atMe = new RegExp(`@${BOT_USERNAME}\\b`, 'i').test(text) ||
               new RegExp(`@${BOT_USERNAME.replace(/_/g,'[ _]?')}\\b`, 'i').test(text);

  const nicknames = (CHARITY_CFG?.style?.lexicon?.bot_nickname || []);
  const nickPart = [...nicknames, 'Charity', 'Charity the Adventurer']
    .map(n => escapeRegex(String(n).trim()).replace(/\s+/g, '[ _]*'))
    .filter(Boolean)
    .join('|');
  const nameHit = nickPart
    ? new RegExp(`\\b(?:${nickPart})\\b`, 'i').test(text)
    : /\bcharity\b/i.test(text);

  const looksLikeQuestion =
    /\?\s*$/.test(text) ||
    /\b(what|who|when|where|why|how|can|could|should|would|do|does|did|is|are|am|will)\b/i.test(text);

  const shouldTrigger = replyingToMe || atMe || (nameHit && looksLikeQuestion);

  // Memory-intent shortcut: if they ask about “remember me / recognize me”
  const asksAboutMemory =
    /\b(remember|recall|recognize|recognise|memory|memories)\b/i.test(text) ||
    /\b(do you|can you)\s+(still\s+)?(remember|recall|recognize|recognise)\b/i.test(text) ||
    /\b(know\s+(?:me|who\s+i\s+am))\b/i.test(text);

  if ((replyingToMe || atMe || nameHit) && asksAboutMemory) {
    await memAutoCmds.handleMe(channel, tags);
    return;
  }

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
      lastAskTags = tags;

      let question = text;
      if (replyingToMe && !looksLikeQuestion && !question.endsWith('?')) {
        question = `Follow-up: ${question}`;
      }

      await handleAskCommand(channel, tags, `!ask ${question}`);
      return;
    } catch (e) {
      logger.warn('[mention-ask] failed: ' + (e?.message || e));
    }
  }

  // 3) natural chat — ingest episode & extract profile facts
  if (text && !text.startsWith('!')) {
    await episodic.ingest({ tags, text, embedder, importance: 1.0 });

    const u = episodic.getUserByTags(tags);
    if (u && !u.disclosed && !u.opt_out) {
      await sayWithConsent(channel, tags, `${formatAddress(tags)} I remember small preferences to chat better — !optout anytime.`);
      episodic.markDisclosedByTags(tags);
    }

    // auto fact mining from free chat
    if (factExtractor && !episodic.isOptedOut(tags)) {
      try {
        const cands = await factExtractor.extractCandidates(text, tags);
        for (const c of (cands || [])) {
          if (!c || !c.key || !c.value) continue;
          await episodic.upsertFactByTags(tags, c.key, c.value, { confidence: c.confidence ?? 0.5 });
        }
      } catch (e) {
        logger.warn('[fact] extract failed: ' + (e?.message || e));
      }
    }

    // soft nudge line from lightweight memory module
    const evt = memory.updateFromMessage({ channel, tags, text });
    if (evt?.nudge) {
      await sayWithConsent(channel, tags, `${formatAddress(tags)} ${evt.nudge}`);
    }
  }
});

// After the message listener, the rest of the connection lifecycle handlers:

client.on('connected', () => {
  logger.info('Connected to chat');
});

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

client.on('disconnected', (reason) => {
  logger.warn('[tmi] disconnected: ' + reason);
});

try {
  await client.connect();
} catch (err) {
  logger.error('[tmi] connect failed: ' + (err?.message || err));
  // process stays alive so you can see logs; PM2 can restart if configured
}
