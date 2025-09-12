// modules/live.js — minimal, robust LIVE status helper.
// Uses /streams and /channels. No EventSub required.

import { helixGet } from './helix-auth.js';

export function createLive(cfg, logger, channelLogin) {
  const state = {
    isLive: false,
    viewerCount: 0,
    title: '',
    gameId: '',
    startedAt: 0,
    userId: (process.env.TWITCH_BROADCASTER_ID || '').trim(),
    lastPollAt: 0,
    lastError: null,
  };

  async function resolveUserId() {
    if (state.userId) return state.userId;
    const r = await helixGet('/users', { params: { login: channelLogin } });
    const id = r?.data?.[0]?.id;
    if (!id) throw new Error('live.resolveUserId: missing user id');
    state.userId = id;
    return id;
  }

  async function fetchOnce() {
    try {
      const uid = await resolveUserId();

      // 1) Are we live?
      const s = await helixGet('/streams', { params: { user_id: uid } });
      const live = s?.data?.[0];
      state.isLive = !!live;
      if (live) {
        state.viewerCount = live.viewer_count ?? 0;
        state.startedAt = live.started_at ? Date.parse(live.started_at) : 0;
      } else {
        state.viewerCount = 0;
        state.startedAt = 0;
      }

      // 2) Channel metadata (title/game)
      const c = await helixGet('/channels', { params: { broadcaster_id: uid } });
      const ch = c?.data?.[0];
      state.title = ch?.title || '';
      state.gameId = ch?.game_id || '';

      state.lastPollAt = Date.now();
      state.lastError = null;
      return { ...state };
    } catch (e) {
      state.lastError = e?.message || String(e);
      logger?.warn?.(`[live] fetchOnce failed: ${state.lastError}`);
      throw e;
    }
  }

  function startPolling(intervalMs = 60_000) {
    // poll immediately, then on interval
    fetchOnce().catch(() => {});
    const t = setInterval(() => fetchOnce().catch(() => {}), Math.max(10_000, intervalMs));
    return () => clearInterval(t);
  }

  async function init() { await fetchOnce(); } // for callers that expect .init()

  async function getContext() {
    // simple text context block, OK for prompts/logging
    if (!state.lastPollAt) return `Live context unknown`;
    const when = new Date(state.lastPollAt).toISOString().replace('T',' ').replace('Z',' UTC');
    const live = state.isLive ? 'LIVE' : 'offline';
    const title = state.title ? ` — “${state.title}”` : '';
    return `Stream is ${live}${title}. Viewers: ${state.viewerCount}. (as of ${when})`;
  }

  function start() {
    // phased out, kept as harmless convenience for older call sites
    startPolling(60_000);
  }

  return { state, fetchOnce, startPolling, init, getContext, start };
}
