// index.mod.js — Phase 2 main with refreshable token + robust token module resolution
import './env-bootstrap.js';
import { assertRequiredEnv } from './env-bootstrap.js';
assertRequiredEnv();

import tmi from 'tmi.js';
import { loadConfig } from './modules/config.js';
import { createLogger } from './modules/logger.js';
import { createKB } from './modules/kb.js';
import { createConsent } from './modules/consent.js';
import { createTimezone } from './modules/timezone.js';
import { createLive } from './modules/live.js';
import { createAnnouncer } from './modules/announce.js';
import { createReply } from './modules/reply.js';
import { isBroadcasterUser as _isBroadcasterUser, getRoleFromTags as _getRoleFromTags, isFollower as _isFollower } from './modules/role.js';
import { createAskCommand } from './commands/ask.js';
import { createStatusmeCommand } from './commands/statusme.js';
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
const reply = createReply(CHARITY_CFG, logger, importTokenModule, BROADCASTER);
const live = createLive(CHARITY_CFG, logger, importTokenModule, BROADCASTER);
const announcer = createAnnouncer(CHARITY_CFG, logger);
live.start();

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
  const mentionStyle = lex.mention_style || 'role+mention';
  switch (mentionStyle) {
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
  return live.getContext();
}

// Resolve token module in a robust way
async function importTokenModule() {
  try { return await import('./token.js'); } catch {}
  try { return await import('../token.js'); } catch {}
  try { return await import('../../token.js'); } catch {}
  return null;
}

// ---- AUTH (refreshable via token.js preferred; fallback to env) ----
async function resolvePassword() {
  try {
    const tok = await importTokenModule();
    if (tok?.loadTokenState && tok?.validateToken) {
      let st = tok.loadTokenState();
      if (st?.access_token) {
        const v = await tok.validateToken(st.access_token);
        if (!v.ok || (v.minutesRemaining != null && v.minutesRemaining < 10)) {
          const r = await tok.refreshToken(st);
          if (r.ok) st = tok.loadTokenState();
        }
        if (st?.access_token) {
          const pref = st.access_token.startsWith('oauth:') ? st.access_token : `oauth:${st.access_token}`;
          logger.info('[auth] Using token.js access_token');
          return pref;
        }
      }
    }
  } catch (e) {
    logger.warn('[auth] token.js not available or failed, falling back to TWITCH_OAUTH: ' + (e?.message || e));
  }
  let pw = process.env.TWITCH_OAUTH;
  if (pw && !pw.startsWith('oauth:')) pw = 'oauth:' + pw;
  if (pw) logger.info(`[auth] Using TWITCH_OAUTH env (len=${pw.length}) for bot=${BOT_USERNAME}`);
  return pw;
}

// Periodic token upkeep (every 5 minutes) — best-effort
try {
  const tok = await importTokenModule();
  setInterval(async () => {
    try {
      const st = tok?.loadTokenState?.();
      if (!st?.access_token) return;
      const v = await tok.validateToken(st.access_token);
      if (!v.ok || (v.minutesRemaining != null && v.minutesRemaining < 10)) {
        const r = await tok.refreshToken(st);
        if (r.ok) logger.info('[auth] token refreshed (periodic)');
      }
    } catch {}
  }, 5 * 60 * 1000);
} catch {}

const PASSWORD = await resolvePassword();
if (!PASSWORD) {
  logger.error('[auth] No TWITCH_OAUTH provided and token.js did not yield a token. Set TWITCH_OAUTH or ensure token refresh flow runs.');
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

// sayWithConsent after client is available
const sayWithConsent = consent.makeSayWithConsent(client, twitchSafe, isBroadcasterUser, {
  sendReplyCore: (channel, text, parent, limit=480) => reply.sendReply({ channel, message: text, parentMsgId: parent, client, twitchSafe })
});

// build handlers
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
const handleAskCommand = createAskCommand({
  CHARITY_CFG, OLLAMA, LLM_MODEL,
  tzmod, KB,
  getChannelOrLiveContext,
  sayWithConsent, formatAddress,
  getSignatureForMood,
  getCurrentMood: () => currentMood
});

const router = createRouter({
  handlers: { statusme: handleStatusme,
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
 // Startup announcer (Phase 3)
 announcer.maybeAnnounce({ sayWithConsent, channel: `#${CHANNEL}`, isLive: live.state.isLive });
});
client.on('disconnected', (reason) => {
  logger.warn('[tmi] disconnected: ' + reason);
});

try {
  await client.connect();
} catch (err) {
  logger.error('[tmi] connect failed: ' + (err?.message || err));
}
