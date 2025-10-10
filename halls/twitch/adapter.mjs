/** @param {{ingest:(evt)=>Promise<void>}} core */
// halls/twitch/adapter.mjs
import tmi from 'tmi.js';

import { getTwitchToken, refreshTwitch, scheduleTwitchAutoRefresh } from '#relics/tokens.mjs';
import { validateTwitch } from '#relics/twitch-validate.mjs';
import { createGuildGuard } from '#mind/guild_guard.mjs';
import modConf from '#codex/moderation.config.json' assert { type: 'json' };
import { RecentIdCache } from '#halls/common/recent-cache.mjs';
import { metricsIngest } from '#sentry/metrics/rollup.mjs';

const TWITCH_DEDUP_TTL  = Number(process.env.HALL_TWITCH_DEDUP_WINDOW_MS || process.env.HALL_DEDUP_WINDOW_MS || 10_000);
const TWITCH_DEDUP_MAX  = Number(process.env.HALL_TWITCH_DEDUP_MAX || process.env.HALL_DEDUP_MAX || 2000);
const twitchDedup = new RecentIdCache({ ttlMs: TWITCH_DEDUP_TTL, max: TWITCH_DEDUP_MAX });
// Startup grace (extra-aggressive dedupe window)
const TWITCH_DEDUP_GRACE_MS = Number(process.env.HALL_TWITCH_DEDUP_STARTUP_GRACE_MS || process.env.HALL_DEDUP_STARTUP_GRACE_MS || 60_000);
const twitchContentDedup = new RecentIdCache({ ttlMs: TWITCH_DEDUP_GRACE_MS, max: TWITCH_DEDUP_MAX });
const bootTs = Date.now();

export default async function startHall(core, cfg) {
  const channel = (process.env.TWITCH_BROADCASTER || cfg?.twitch?.channel || '').toLowerCase();
  if (!channel) throw new Error('[twitch] TWITCH_BROADCASTER or cfg.twitch.channel required');

  const botUser = (process.env.TWITCH_BOT_USERNAME || cfg?.twitch?.bot || '').toLowerCase();
  if (!botUser) throw new Error('[twitch] TWITCH_BOT_USERNAME or cfg.twitch.bot required');

  let tok = await getTwitchToken('bot');

  // validate token -> if 401, try a forced refresh once
  async function ensureValidToken() {
    try {
      const info = await validateTwitch('bot');
      const tokenUser = (info.login || '').toLowerCase();
      if (tokenUser !== botUser) {
        throw new Error(`[twitch] Token belongs to @${tokenUser}, but TWITCH_BOT_USERNAME is @${botUser}.`);
      }
      const scopes = info.scopes || [];
      if (!scopes.includes('chat:read') || !scopes.includes('chat:edit')) {
        throw new Error(`[twitch] Bot token missing chat scopes. Have [${scopes.join(', ')}], need chat:read, chat:edit.`);
      }
    } catch (e) {
      const msg = e?.message || '';
      const canRefresh = !!tok.refresh_token;
      if (canRefresh && /validate\]\s*401/i.test(msg)) {
        console.warn('[twitch] token invalid at boot; attempting refresh…');
        tok = await refreshTwitch('bot', tok);
      } else {
        throw e;
      }
    }
  }

  await ensureValidToken();

  const client = new tmi.Client({
    options: { debug: false, messagesLogLevel: 'info' },
    connection: { secure: true, reconnect: true },
    identity: { username: botUser, password: `oauth:${tok.access_token}` },
    channels: [ `#${channel}` ]
  });

  // Pass the LLM from the orchestrator if exposed; guard will fall back if absent
  const guard = createGuildGuard({
    cfg: modConf?.guild_guard,
    llm: core?.llm,
    channelName: `#${channel}`
  });

  const stopRefresh = scheduleTwitchAutoRefresh('bot', 45 * 60 * 1000);

  client.on('reconnect', async () => {
    try {
      const fresh = await getTwitchToken('bot');
      client.opts.identity.password = `oauth:${fresh.access_token}`;
      console.log('[twitch] password rotated before reconnect');
    } catch (e) { console.warn('[twitch] token rotate failed:', e.message); }
  });

  client.on('message', async (channelName, tags, message, self) => {
    if (self) return;

    // --- Duplicate-message debounce (Twitch) ---
    // Prefer canonical Twitch message id; fall back to a deterministic composite.
    const msgId =
      tags?.id ||
      tags?.['message-id'] || // some libs set this
      `${tags?.['user-id'] || tags?.username || 'anon'}:${tags?.tmiSentTs || tags?.['tmi-sent-ts'] || ''}:${message}`;
    const inGrace = (Date.now() - bootTs) < TWITCH_DEDUP_GRACE_MS;
    // During grace, also dedupe by content-per-user (catches replayed messages with new IDs)
    const contentKey = `${tags?.['user-id'] || tags?.username || 'anon'}::${message}`;

    if (twitchDedup.has(msgId) || (inGrace && twitchContentDedup.has(contentKey))) {
      const reason = twitchDedup.has(msgId) ? 'msgId' : 'startup_grace_content';
      console.log(`metric=hall_dedup_drop value=1 hall=twitch reason=${reason} id=${JSON.stringify(msgId)} contentKey=${JSON.stringify(contentKey)}`);
      try { metricsIngest?.({ type: 'hall_dedup_drop', hall: 'twitch', reason }); } catch {}
      return;
    }
    twitchDedup.add(msgId);
    if (inGrace) twitchContentDedup.add(contentKey);
    // 1) Guard runs first (fast). If it acts, stop here.
	try {
	       const acted = await guard.onMessage(
        {
          hall: 'twitch',
          roomId: channelName.replace(/^#/, ''), // e.g., 'bagotrix'
          userId: tags['user-id'],
          userName: tags['display-name'] || tags.username,
          text: message,
          meta: { messageId: tags.id }
        },
        tags,
        { send: (room, msg) => client.say(`#${room}`, msg) } // minimal io facade
      );
	  if (acted) return;
	} catch (e) { console.warn('[guard] error', e?.message || e); }

	// 2) Guard commands for mods/GM
    if (/^!guard\b/i.test(message)) {
      const args = message.trim().split(/\s+/).slice(1);
      await guard.command(args, tags, { send: (room, msg) => client.say(`#${room}`, msg) });
	  return;
	}

	// 3) Fall through to the orchestrator (Charity)

	try {
      const replyToMe = !!(
        (tags['reply-parent-user-login'] && tags['reply-parent-user-login'].toLowerCase() === botUser.toLowerCase()) ||
        (tags['reply-parent-user-id'] && tags['reply-parent-user-id'] === tags['user-id'])
      );
      await core.ingest({
        hall: 'twitch',
        roomId: channelName.replace(/^#/, ''),
        userId: tags['user-id'] ?? '',
        userName: tags['display-name'] ?? tags['username'] ?? '',
        text: message,
        ts: Date.now(),
        meta: { rawTags: tags, replyToMe, messageId: msgId, dedupeInGrace: inGrace }
      });
    } catch (e) {
      console.error('[twitch] ingest error:', e?.message || e);
    }
  });

  await client.connect();

  return {
    async send(roomId, text, meta = {}) {
      // keep planner traces out of chat
      if (meta?.internal) return;
      await client.say(`#${roomId}`, text);
    },
    async stop() {
      stopRefresh();
      try { await client.disconnect(); } catch {}
    }
  };
}
