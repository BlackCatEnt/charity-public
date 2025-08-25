// index.mod.js — Phase 1 modular main
import './env-bootstrap.js';
import { assertRequiredEnv } from './env-bootstrap.js';
assertRequiredEnv();

import tmi from 'tmi.js';
import axios from 'axios';
import path from 'path';
import { loadConfig } from './modules/config.js';
import { createLogger } from './modules/logger.js';
import { createKB } from './modules/kb.js';
import { createConsent } from './modules/consent.js';
import { createTimezone } from './modules/timezone.js';
import { isBroadcasterUser as _isBroadcasterUser, getRoleFromTags as _getRoleFromTags, isFollower as _isFollower } from './modules/role.js';
import { generateAnswer } from './modules/generate.js';
import { routeTouchConsent } from './commands/touchConsent.js';
import { createTwitchApi, loadTokenState, validateToken, refreshToken, saveTokenState } from './token.js';

const CHARITY_CFG = loadConfig();
const logger = createLogger();
const DEBUG = (CHARITY_CFG?.features?.debug_chat === true) || (process.env.DEBUG_CHAT === '1');
const dbg = (...args) => { if (DEBUG) logger.info('[debug] ' + args.join(' ')); };

const CHANNEL      = (process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
const BOT_USERNAME = (process.env.TWITCH_BOT_USERNAME || 'charity_the_adventurer').toLowerCase();
const BROADCASTER  = (process.env.TWITCH_BROADCASTER || CHANNEL).toLowerCase();
const OLLAMA       = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LLM_MODEL    = process.env.LLM_MODEL || 'llama3.1:8b-instruct-q8_0';

// Utilities reused from your current index.js
function twitchSafe(msg, limit = 480) {
  return (msg || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// KB
const KB = createKB(logger, OLLAMA);

// Consent + Timezone modules
const consent = createConsent(CHARITY_CFG, logger);
const tzmod = createTimezone(CHARITY_CFG, logger);

// shallow adapters to avoid circular deps
const isBroadcasterUser = (tags) => _isBroadcasterUser(tags, BROADCASTER, CHARITY_CFG?.style?.lexicon?.guild_master);
const getRoleFromTags = (tags, followerKnown=false) => _getRoleFromTags(tags, followerKnown, BROADCASTER, CHARITY_CFG?.style?.lexicon?.guild_master);
const isFollower = (tags) => _isFollower(tags, CHARITY_CFG?.features || {}, BROADCASTER);

// ---- Address & small helpers (kept inline) ----
function formatAddress(tags) {
  const lex = CHARITY_CFG?.style?.lexicon || {};
  const display = tags['display-name'] || tags.username || 'friend';
  const mention = '@' + display;
  const sender = (tags.username || '').toLowerCase();
  if (sender === BOT_USERNAME) return '';

  let role = tags ? tags._resolvedRole : null;
  if (!role) role = getRoleFromTags(tags, false);
  const gmName = (lex.guild_master || '').toLowerCase();
  const isGM = (display || '').toLowerCase() === gmName || isBroadcasterUser(tags);
  const roleName = isGM ? ((lex.address_by_role || {}).broadcaster || 'Guild Master')
                        : ((lex.address_by_role || {})[role] || '');
  switch (lex.mention_style) {
    case 'role+mention': return roleName ? `${roleName} ${mention}` : mention;
    case 'role-only':    return roleName || mention;
    default:             return mention;
  }
}
function pickOne(list, fallback) {
  if (Array.isArray(list) && list.length) return list[Math.floor(Math.random() * list.length)];
  return fallback;
}

// Mood: keep a tiny placeholder (your real implementation can be slotted in)
const MOOD_DEFAULT = 'default';
let currentMood = MOOD_DEFAULT;
function getSignatureForMood(mood=MOOD_DEFAULT) {
  const sigBy = CHARITY_CFG?.style?.lexicon?.signature_by_mood || {};
  return sigBy[mood] || CHARITY_CFG?.style?.lexicon?.signature || '✧';
}

// Live context (placeholder; wire to your real helper if present)
async function getChannelOrLiveContext() {
  // Minimal offline stub; replace with your Helix-based function from current code.
  return { lines: [], isLive: false };
}

// Build sayWithConsent wrapper now that client doesn't exist yet
let sayWithConsent = null; // will be bound after client init
const makeHandlers = () => ({
  handleTouchConsentCommand: consent.makeTouchConsentHandler({
    sayWithConsent,
    formatAddress,
    getSignatureForMood,
    getCurrentMood: () => currentMood
  }),
  handleSetTzCommand: null,
  handleMyTimeCommand: null
});

// Setup client with refreshed oauth
const client = new tmi.Client({
  options: { debug: false },
  identity: {
    username: BOT_USERNAME,
    password: async () => {
      const tok = await loadTokenState();
      return tok?.access_token ? `oauth:${tok.access_token}` : (process.env.TWITCH_OAUTH || '');
    }
  },
  channels: [ `#${CHANNEL}` ]
});

// Now that client exists, bind sayWithConsent and time commands
sayWithConsent = consent.makeSayWithConsent(client, twitchSafe, isBroadcasterUser);
const { handleSetTzCommand, handleMyTimeCommand } = tzmod.makeTimezoneCommands({ sayWithConsent, formatAddress });
const handlers = makeHandlers();
handlers.handleSetTzCommand = handleSetTzCommand;
handlers.handleMyTimeCommand = handleMyTimeCommand;

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  if ((tags.username || '').toLowerCase() === BOT_USERNAME) return;
  const text = (message || '').trim();
  dbg('msg:', JSON.stringify(text));

  // role preface
  const follower = await isFollower(tags);
  const role = getRoleFromTags(tags, follower);
  tags._resolvedRole = role;
  const addressed = formatAddress(tags);

  // route !tc
  if (/^!tc\b/i.test(text)) {
    const args = text.replace(/^!tc\b/i, '').trim();
    return void handlers.handleTouchConsentCommand(channel, tags, args);
  }
  // timezone commands
  if (/^!settz\b/i.test(text)) {
    const args = text.replace(/^!settz\b/i, '').trim();
    return void handlers.handleSetTzCommand(channel, tags, args);
  }
  if (/^!mytime\b/i.test(text)) {
    return void handlers.handleMyTimeCommand(channel, tags);
  }

  // QA / !ask path (minimal sketch)
  const askMatch = text.match(/^!ask\s+(.+)$/i);
  if (askMatch) {
    const question = askMatch[1];
    const ctx = ''; // You can layer KB + live context here
    const tz = tzmod.getUserTzFromTags(tags);
    const ans = await generateAnswer(
      { CHARITY_CFG, OLLAMA, LLM_MODEL },
      { context: ctx, userQuestion: question, mood: currentMood, tz, getChannelOrLiveContext }
    );
    const sig = getSignatureForMood(currentMood);
    return sayWithConsent(channel, tags, `${addressed} ${ans} ${sig}`);
  }
});

client.on('connected', () => {
  logger.info('Connected to chat');
});

client.connect();
