import { createTwitchApi } from '../token.js'; // adjust if your token helper lives elsewhere
const followerCache = new Map();
let BROADCASTER_ID = null;

export async function getBroadcasterId(api, loginFromEnv) {
  if (BROADCASTER_ID) return BROADCASTER_ID;
  const login = (loginFromEnv || 'bagotrix').toLowerCase();
  const { data } = await api.get(`/users?login=${encodeURIComponent(login)}`);
  BROADCASTER_ID = data?.data?.[0]?.id || null;
  return BROADCASTER_ID;
}

export function isBroadcasterUser(tags, envChannel, guildMaster) {
  try {
    const b = tags?.badges || {};
    if (b.broadcaster === '1') return true;
    const display = (tags['display-name'] || tags.username || '').toLowerCase();
    const cfgChannel = (envChannel || 'bagotrix').toLowerCase();
    const cfgGuildMaster = (guildMaster || '').toLowerCase();
    return !!display && (display === cfgChannel || display === cfgGuildMaster);
  } catch { return false; }
}

export async function isFollower(tags, features, envChannel) {
  if (!features?.follower_role_enabled) return false;
  const userId = tags['user-id']; if (!userId) return false;

  const hit = followerCache.get(userId);
  const now = Date.now();
  const FOLLOWER_TTL = (features?.follower_cache_ttl_sec ?? 600) * 1000;
  if (hit) {
    const ttl = hit.err ? 60_000 : FOLLOWER_TTL;
    if ((now - hit.at) < ttl) return hit.isFollower;
  }

  try {
    const api = createTwitchApi();
    const broadcasterId = await getBroadcasterId(api, envChannel);
    if (!broadcasterId) throw new Error('no broadcaster id');
    const { data } = await api.get(`/channels/followers`, {
      params: { broadcaster_id: broadcasterId, user_id: userId }
    });
    const isF = Array.isArray(data?.data) && data.data.length > 0;
    followerCache.set(userId, { isFollower: isF, at: now });
    return isF;
  } catch (e) {
    followerCache.set(userId, { isFollower: false, at: Date.now(), err: true });
    return false;
  }
}

export function getRoleFromTags(tags, followerKnown, envChannel, guildMaster) {
  const b = tags.badges || {};
  if (isBroadcasterUser(tags, envChannel, guildMaster)) return 'broadcaster';
  if (tags['room-id'] && tags['user-id'] && tags['room-id'] === tags['user-id']) return 'broadcaster';
  const chanLogin = (envChannel || '').toLowerCase();
  if (chanLogin && (tags.username || '').toLowerCase() === chanLogin) return 'broadcaster';
  if (tags.mod) return 'mod';
  if (b.vip === '1') return 'vip';
  if (b.founder) return 'founder';
  if (b.subscriber || b.sub) return 'subscriber';
  return followerKnown ? 'follower' : 'non_follower';
}
