// modules/eventsub.js
// Minimal EventSub WebSocket client for channel.subscribe / channel.follow / channel.cheer
// Requires: npm i ws
import { helixHeaders } from './helix-auth.js';

export async function createEventSubClient({ logger = console, broadcasterLogin }) {
  const { WebSocket } = await import('ws');

  const api = async (url, opt = {}, kind = 'broadcaster') => {
    const headers = await helixHeaders(kind);
    const res = await fetch(url, { ...opt, headers: { ...headers, ...(opt.headers||{}) } });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  };

  async function getUser(login, kind='broadcaster') {
    const j = await api(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {}, kind);
    if (!j.data?.length) throw new Error(`user not found: ${login}`);
    return j.data[0];
  }

  const broadcaster = await getUser(broadcasterLogin, 'broadcaster');
  const BROAD_ID = broadcaster.id;

  let ws, sessionId, pingTimer;

  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket('wss://eventsub.wss.twitch.tv/ws');

      ws.on('open', () => logger.info('[eventsub] ws open'));
      ws.on('message', async (buf) => {
        const msg = JSON.parse(String(buf));
        switch (msg.metadata.message_type) {
          case 'session_welcome':
            sessionId = msg.payload.session.id;
            logger.info('[eventsub] welcome, session=', sessionId);
            await subscribeBasics();
            startPings(msg.payload.session.keepalive_timeout_seconds ?? 10);
            resolve();
            break;

          case 'notification': {
            const { subscription, event } = msg.payload;
            const type = subscription.type;
            // ---- simple dispatcher (log-only for now) ----
            if (type === 'channel.subscribe') {
              logger.info(`[eventsub] SUB: user=${event.user_name} tier=${event.tier} cumulative=${event.cumulative_months ?? 0}`);
            } else if (type === 'channel.follow') {
              logger.info(`[eventsub] FOLLOW: user=${event.user_name}`);
            } else if (type === 'channel.cheer') {
              logger.info(`[eventsub] CHEER: user=${event.user_name} bits=${event.bits}`);
            } else {
              logger.info(`[eventsub] ${type}`, event);
            }
            break;
          }

          case 'session_keepalive':
            logger.debug?.('[eventsub] keepalive');
            break;

          case 'session_reconnect':
            logger.warn('[eventsub] reconnect requested, url=', msg.payload.session.reconnect_url);
            try { ws.close(); } catch {}
            connect();
            break;

          default:
            logger.info('[eventsub] message', msg.metadata.message_type);
        }
      });

      ws.on('error', (e) => { logger.error('[eventsub] error', e); reject(e); });
      ws.on('close', () => { logger.warn('[eventsub] closed'); stopPings(); });
    });
  }

  function startPings(timeoutSec) {
    stopPings();
    const ms = Math.max(5000, (timeoutSec - 2) * 1000);
    pingTimer = setInterval(() => ws?.ping?.(), ms);
  }
  function stopPings() { if (pingTimer) clearInterval(pingTimer); pingTimer = null; }

async function subscribeBasics() {
	// ensure broadcaster token is fresh (single app creds)
  const { ensureFresh } = await import('./token-manager.js');
  await ensureFresh('broadcaster', logger);

  async function sub(type, version, condition) {
    const body = { type, version, condition, transport: { method: 'websocket', session_id: sessionId } };
    return api('https://api.twitch.tv/helix/eventsub/subscriptions', { method: 'POST', body: JSON.stringify(body) }, 'broadcaster');
  }
  async function trySub(label, type, version, condition, neededScopes = []) {
    try {
      await sub(type, version, condition);
      logger.info(`[eventsub] sub OK: ${label}`);
    } catch (e) {
      const hint = neededScopes.length ? ` (requires: ${neededScopes.join(', ')})` : '';
      logger.warn(`[eventsub] sub FAIL: ${label} -> ${e.message}${hint}`);
    }
  }

  // 1) Subs
  await trySub('channel.subscribe', 'channel.subscribe', '1',
    { broadcaster_user_id: BROAD_ID });

  // 2) Follow (v2) — broadcaster can act as moderator but needs moderator:read:followers
  await trySub('channel.follow', 'channel.follow', '2',
    { broadcaster_user_id: BROAD_ID, moderator_user_id: BROAD_ID },
    ['moderator:read:followers']);

  // 3) Cheer — needs bits:read
  await trySub('channel.cheer', 'channel.cheer', '1',
    { broadcaster_user_id: BROAD_ID },
    ['bits:read']);

  logger.info('[eventsub] subscription attempts finished');
}

  return {
    connect,
    close: () => { try { ws?.close(); } catch {} },
  };
}
