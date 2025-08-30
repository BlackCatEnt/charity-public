// modules/role.js — normalized role resolution + follower check (stable keys)
const followerCache = new Map(); // userId -> { at, isFollower, err }

// --- Canonical role keys used across the bot & config ---
// broadcaster, mod, vip, founder, subscriber, follower, non_follower
export function normalizeRoleKey(role) {
  const r = String(role || '').toLowerCase();
  switch (r) {
    case 'broadcaster':
    case 'streamer':
    case 'owner':
      return 'broadcaster';

    case 'moderator':
    case 'mod':
      return 'mod';

    case 'vip':
    case 'vips':
      return 'vip';

    case 'founder':
    case 'founders':
      return 'founder';

    case 'subscriber':
    case 'sub':
    case 'subs':
      return 'subscriber';

    case 'follower':
    case 'followers':
      return 'follower';

    case 'non_follower':
    case 'viewer':
    case 'guest':
    case 'visitor':
      return 'non_follower';

    default:
      return r || 'non_follower';
  }
}

export function isBroadcasterUser(tags, envChannel, guildMaster) {
  try {
    const b = tags?.badges || {};
    if (b.broadcaster === '1') return true;
    // Sometimes room-id === user-id for the broadcaster
    if (tags['room-id'] && tags['user-id'] && tags['room-id'] === tags['user-id']) return true;

    const display = (tags['display-name'] || tags.username || '').toLowerCase();
    const chanLogin = (envChannel || '').toLowerCase();
    const gm = (guildMaster || '').toLowerCase();
    if (display && (display === chanLogin || display === gm)) return true;

    return false;
  } catch {
    return false;
  }
}

export function getRoleFromTags(tags, followerKnown = false, envChannel, guildMaster) {
  try {
    const b = tags?.badges || {};

    if (isBroadcasterUser(tags, envChannel, guildMaster)) return 'broadcaster';
    if (tags.mod) return 'mod';
    if (b.vip === '1') return 'vip';
    if (b.founder) return 'founder';
    if (b.subscriber === '1' || b.sub === '1' || tags.subscriber) return 'subscriber';

    // Fall back to follower / non_follower
    const raw = followerKnown ? 'follower' : 'non_follower';
    return normalizeRoleKey(raw);
  } catch {
    return 'non_follower';
  }
}

async function importTokenModuleFromHere() {
  // Try multiple relative paths depending on deployment layout
  try { return await import('../../token.js'); } catch {}
  try { return await import('../token.js'); } catch {}
  try { return await import('./token.js'); } catch {}
  return null;
}

export async function isFollower(tags, features = {}, envChannel) {
  try {
    if (!features?.follower_role_enabled) return false;
    const userId = tags?.['user-id'];
    if (!userId) return false;

    const now = Date.now();
    const hit = followerCache.get(userId);
    const TTL = (features?.follower_cache_ttl_sec ?? 600) * 1000;
    if (hit && (now - hit.at) < (hit.err ? 60_000 : TTL)) return hit.isFollower;

    let api;
    try {
      const mod = await importTokenModuleFromHere();
      api = mod?.createTwitchApi?.();
    } catch {
      followerCache.set(userId, { isFollower: false, at: now, err: true });
      return false;
    }
    if (!api) {
      followerCache.set(userId, { isFollower: false, at: now, err: true });
      return false;
    }

    const chanLogin = (envChannel || '').toLowerCase();
    const { data: who } = await api.get('/users', { params: { login: chanLogin } });
    const broadcasterId = who?.data?.[0]?.id;
    if (!broadcasterId) {
      followerCache.set(userId, { isFollower: false, at: now, err: true });
      return false;
    }

    const { data } = await api.get('/channels/followers', { params: { broadcaster_id: broadcasterId, user_id: userId } });
    const isF = Array.isArray(data?.data) && data.data.length > 0;
    followerCache.set(userId, { isFollower: isF, at: now });
    return isF;
  } catch {
    const userId = tags?.['user-id'] || 'unknown';
    followerCache.set(userId, { isFollower: false, at: Date.now(), err: true });
    return false;
  }
}
