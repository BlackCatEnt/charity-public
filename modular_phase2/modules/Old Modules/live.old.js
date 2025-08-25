// modules/live.js — Live context polling via Twitch Helix
export function createLive(CHARITY_CFG, logger, importTokenModule, channelLogin) {
  const POLL_SEC = Number(process.env.LIVE_POLL_SEC || CHARITY_CFG?.features?.live_poll_sec || 30);
  const login = String(channelLogin || '').toLowerCase();
  let timer = null;
  const gameCache = new Map();

  const state = { isLive: false, title: '', gameId: '', gameName: '', startedAt: null, lastChecked: 0, lastChange: 0 };

  async function ensureApi() {
    const tok = await importTokenModule();
    const api = tok?.createTwitchApi?.();
    if (!api) throw new Error('Twitch API not available');
    return api;
  }
  async function resolveUserId(api) {
    if (!login) throw new Error('channel login missing');
    const { data } = await api.get('/users', { params: { login } });
    const id = data?.data?.[0]?.id;
    if (!id) throw new Error('broadcaster id not found for ' + login);
    return id;
  }
  async function fetchGameName(api, id) {
    if (!id) return '';
    if (gameCache.has(id)) return gameCache.get(id);
    const { data } = await api.get('/games', { params: { id } });
    const name = data?.data?.[0]?.name || '';
    if (name) gameCache.set(id, name);
    return name;
  }
  async function fetchOnce() {
    try {
      const api = await ensureApi();
      const broadcasterId = await resolveUserId(api);
      const { data: sdata } = await api.get('/streams', { params: { user_id: broadcasterId } });
      const live = Array.isArray(sdata?.data) && sdata.data.length > 0 ? sdata.data[0] : null;
      const { data: cdata } = await api.get('/channels', { params: { broadcaster_id: broadcasterId } });
      const chan = Array.isArray(cdata?.data) && cdata.data.length > 0 ? cdata.data[0] : null;

      const now = Date.now();
      if (live) {
        const gameName = await fetchGameName(api, live.game_id || chan?.game_id);
        const upd = { isLive: true, title: live.title || chan?.title || '', gameId: live.game_id || chan?.game_id || '', gameName, startedAt: live.started_at ? new Date(live.started_at).toISOString() : null, lastChecked: now };
        if (upd.isLive !== state.isLive) upd.lastChange = now;
        Object.assign(state, upd);
      } else {
        const gameName = await fetchGameName(api, chan?.game_id);
        const upd = { isLive: false, title: chan?.title || '', gameId: chan?.game_id || '', gameName, startedAt: null, lastChecked: now };
        if (upd.isLive !== state.isLive) upd.lastChange = now;
        Object.assign(state, upd);
      }
    } catch (e) { logger?.warn?.('[live] fetchOnce failed: ' + (e?.message || e)); }
  }
  function start() { stop(); fetchOnce(); timer = setInterval(fetchOnce, Math.max(10, POLL_SEC) * 1000); logger?.info?.(`[live] polling every ${Math.max(10, POLL_SEC)}s for ${login}`); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function getContext() {
    const lines = [];
    if (state.isLive) { const g = state.gameName ? ` — playing ${state.gameName}` : ''; lines.push(`LIVE: ${state.title || 'On stream'}${g}`); if (state.startedAt) lines.push(`Stream started at ${state.startedAt}`); }
    else { const g = state.gameName ? ` (${state.gameName})` : ''; if (state.title) lines.push(`OFFLINE: ${state.title}${g}`); else lines.push(`OFFLINE`); }
    return { lines, isLive: state.isLive, snapshot: { ...state } };
  }
  return { start, stop, getContext, state };
}
