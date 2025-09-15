import 'dotenv/config';
import { getTwitchToken, refreshTwitch, scheduleTwitchAutoRefresh } from '#relics/tokens.mjs';

const HELIX = 'https://api.twitch.tv/helix';
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;

async function authHeaders(kind='broadcaster') {
  const tok = await getTwitchToken(kind);
  return {
    'Authorization': `Bearer ${tok.access_token}`,
    'Client-Id': CLIENT_ID,
    'Content-Type': 'application/json'
  };
}

export async function helixFetch(path, { method='GET', body=null, kind='broadcaster' } = {}) {
  const url = path.startsWith('http') ? path : `${HELIX}${path}`;
  let headers = await authHeaders(kind);
  let res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });

  // If unauthorized, try a forced refresh once (requires refresh token)
  if (res.status === 401) {
    try {
      const rec = await getTwitchToken(kind);
      const fresh = await refreshTwitch(kind, rec); // will throw if no refresh_token
      headers = {
        ...headers,
        'Authorization': `Bearer ${fresh.access_token}`
      };
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });
    } catch (e) {
      // bubble up the original 401 if refresh fails
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[helix] ${res.status} ${text}`);
  }
  // DELETE endpoints often return 204 (no content)
  if (res.status === 204) return { status: 204 };
  return res.json();
}

// Convenience: validate broadcaster token by fetching your user record
export async function getUserByLogin(login, kind='broadcaster') {
  const q = new URLSearchParams({ login });
  const data = await helixFetch(`/users?${q}`, { kind });
  return data?.data?.[0] || null;
}

// optional: call this once at boot to keep broadcaster token fresh in background
export function keepBroadcasterFresh() {
  return scheduleTwitchAutoRefresh('broadcaster', 45 * 60 * 1000);
}

// ---------- NEW: moderation helpers ----------
const BID = process.env.TWITCH_BROADCASTER_ID;      // your channel’s user id
const MID = process.env.TWITCH_BOT_USER_ID || BID;  // the bot’s user id (must be a mod)

// Delete a single chat message by id
export async function helixDeleteMessage({ msgId, broadcasterId = BID, moderatorId = MID, kind = 'bot' }) {
  if (!msgId) throw new Error('helixDeleteMessage: msgId required');
  const q = new URLSearchParams({
    broadcaster_id: String(broadcasterId),
    moderator_id:   String(moderatorId),
    message_id:     String(msgId)
  });
  // DELETE /moderation/chat
  return helixFetch(`/moderation/chat?${q}`, { method: 'DELETE', kind });
}

// Timeout (ban for N seconds)
export async function helixTimeoutUser({ userId, secs = 300, reason = '', broadcasterId = BID, moderatorId = MID, kind = 'bot' }) {
  if (!userId) throw new Error('helixTimeoutUser: userId required');
  const q = new URLSearchParams({
    broadcaster_id: String(broadcasterId),
    moderator_id:   String(moderatorId)
  });
  const body = { data: { user_id: String(userId), duration: Math.max(1, Math.floor(secs)), reason: reason?.slice(0, 500) || undefined } };
  // POST /moderation/bans
  return helixFetch(`/moderation/bans?${q}`, { method: 'POST', body, kind });
}

// (nice-to-have used by emote sync; add if you don’t already have them)
export async function helixGetChannelEmotes({ broadcasterId = BID, kind = 'bot' } = {}) {
  const q = new URLSearchParams({ broadcaster_id: String(broadcasterId) });
  return helixFetch(`/chat/emotes?${q}`, { kind });
}
export async function helixGetGlobalEmotes({ kind = 'bot' } = {}) {
  return helixFetch('/chat/emotes/global', { kind });
}