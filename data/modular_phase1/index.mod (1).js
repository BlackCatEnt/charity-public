// index.mod.js — Phase 2 modular main with command router
import './env-bootstrap.js';
import { assertRequiredEnv } from './env-bootstrap.js';
assertRequiredEnv();

import tmi from 'tmi.js';
import { loadConfig } from './modules/config.js';
import { createLogger } from './modules/logger.js';
import { createKB } from './modules/kb.js';
import { createConsent } from './modules/consent.js';
import { createTimezone } from './modules/timezone.js';
import { isBroadcasterUser as _isBroadcasterUser, getRoleFromTags as _getRoleFromTags, isFollower as _isFollower } from './modules/role.js';
import { createAskCommand } from './commands/ask.js';
import { createRouter } from './commands/router.js';

const CHARITY_CFG = loadConfig();
const logger = createLogger();
const DEBUG = (CHARITY_CFG?.features?.debug_chat === true) || (process.env.DEBUG_CHAT === '1');
const dbg = (...args) => { if (DEBUG) logger.info('[debug] ' + args.join(' ')); };

const CHANNEL      = (process.env.TWITCH_CHANNEL || 'bagotrix').toLowerCase();
const BOT_USERNAME = (process.env.TWITCH_BOT_USERNAME || 'charity_the_adventurer').toLowerCase();
const BROADCASTER  = (process.env.TWITCH_BROADCASTER || CHANNEL).toLowerCase();
const OLLAMA       = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LLM_MODEL    = process.env.LLM_MODEL || 'llama3.1:8b-instruct-q8_0';

function twitchSafe(msg, limit = 480) {
  return (msg || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// KB + services
const KB = createKB(logger, OLLAMA);
const consent = createConsent(CHARITY_CFG, logger);
const tzmod = createTimezone(CHARITY_CFG, logger);

// adapters
const isBroadcasterUser = (tags) => _isBroadcasterUser(tags, BROADCASTER, CHARITY_CFG?.style?.lexicon?.guild_master);
const getRoleFromTags = (tags, followerKnown=false) => _getRoleFromTags(tags, followerKnown, BROADCASTER, CHARITY_CFG?.style?.lexicon?.guild_master);
const isFollower = (tags) => _isFollower(tags, CHARITY_CFG?.features || {}, BROADCASTER);

// Address & mood helpers kept inline
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
const MOOD_DEFAULT = 'default';
let currentMood = MOOD_DEFAULT;
function getSignatureForMood(mood=MOOD_DEFAULT) {
  const sigBy = CHARITY_CFG?.style?.lexicon?.signature_by_mood || {};
  return sigBy[mood] || CHARITY_CFG?.style?.lexicon?.signature || '✧';
}
async function getChannelOrLiveContext() {
  return { lines: [], isLive: false };
}

// tmi client
const client = new tmi.Client({
  options: { debug: false },
  identity: {
    username: BOT_USERNAME,
    password: process.env.TWITCH_OAUTH ? process.env.TWITCH_OAUTH : undefined
  },
  channels: [ `#${CHANNEL}` ]
});

// sayWithConsent after client is available
const sayWithConsent = consent.makeSayWithConsent(client, twitchSafe, isBroadcasterUser);

// build handlers
const handleTouchConsentCommand = consent.makeTouchConsentHandler({
  sayWithConsent,
  formatAddress,
  getSignatureForMood,
  getCurrentMood: () => currentMood
});
const tzHandlers = tzmod.makeTimezoneCommands({ sayWithConsent, formatAddress });
const handleAskCommand = createAskCommand({
  CHARITY_CFG, OLLAMA, LLM_MODEL,
  tzmod, KB,
  getChannelOrLiveContext,
  sayWithConsent, formatAddress,
  getSignatureForMood,
  getCurrentMood: () => currentMood
});

const router = createRouter({
  handlers: {
    tc: handleTouchConsentCommand,
    settz: tzHandlers.handleSetTzCommand,
    mytime: tzHandlers.handleMyTimeCommand,
    ask: handleAskCommand
  }
});

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  if ((tags.username || '').toLowerCase() === BOT_USERNAME) return;
  const text = (message || '').trim();
  dbg('msg:', JSON.stringify(text));

  // resolve role prefix
  const follower = await isFollower(tags);
  const role = getRoleFromTags(tags, follower);
  tags._resolvedRole = role;

  // route commands
  const handled = await router.route(channel, tags, text);
  if (handled) return;

  // (Optional) smalltalk fallback can go here
});

client.on('connected', () => {
  logger.info('Connected to chat');
});

client.connect();
