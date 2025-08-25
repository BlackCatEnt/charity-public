// modules/live.js — Live context polling via Twitch Helix (with disk cache)
import fs from 'fs';
import path from 'path';

export function createLive(CHARITY_CFG, logger, importTokenModule, channelLogin) {
  const POLL_SEC = Number(process.env.LIVE_POLL_SEC || CHARITY_CFG?.features?.live_poll_sec || 30);
  const login = String(channelLogin || '').toLowerCase();
  let timer = null;
  const gameCache = new Map();
  const CACHE_PATH = path.resolve('./data/live_state.json');

  const state = {
    isLive: false,
    title: '',
    gameId: '',
    gameName: '',
    startedAt: null,
    lastChecked: 0,
    lastChange: 0
  };

  function loadFromDisk() {
    try {
      const raw = fs.readFileSync(CACHE_PATH, 'utf8');
      const obj = JSON.parse(raw);
      const keys = ['isLive','title','gameId','gameName','startedAt','lastChecked','lastChange'];
      for (const k of keys) if (k in obj) state[k] = obj[k];
      logger?.info?.('[live] cache loaded');
    } catch { /* no-op */ }
  }
  function saveToDisk() {
    try {
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
      fs.writeFileSync(CACHE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      logger?.warn?.('[live] cache save failed: ' + (e?.message || e));
    }
  }

  function uptimeMs() {
    try {
      if (!state.isLive || !state.startedAt) return 0;
      const start = new Date(state.startedAt).getTime();
      if (!start) return 0;
      return Math.max(0, Date.now() - start);
    } catch { return 0; }
  }
  function uptimeHhMm() {
    const ms = uptimeMs();
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, '0');
    return `${h}:${mm}`;
  }

  async function ensureApi() {
    const tok = await importTokenModule();
    const api = tok?.createTwitchApi?.();
    if (!api) throw new Error('Twitch API not available (token.js missing or createTwitchApi not exported)');
    return api;
  }

  async function resolveUserId(api) {
    if (!login) throw new Error('channel login missing');
    const { data } = await api.get('/users', { params: { login } });
    const id = data?.data?.[0]?.id;
    if (!id) throw new Error('broadcaster id not found for ' + login);
    return id;
  }

  async function fetchGameName(api, gameId) {
    if (!gameId) return '';
    if (gameCache.has(gameId)) return gameCache.get(gameId);
    const { data } = await api.get('/games', { params: { id: gameId } });
    const name = data?.data?.[0]?.name || '';
    if (name) gameCache.set(gameId, name);
    return name;
  }

  async function fetchOnce() {
    try {
      const api = await ensureApi();
      const broadcasterId = await resolveUserId(api);

      // Streams (live-only)
      const { data: sdata } = await api.get('/streams', { params: { user_id: broadcasterId } });
      const live = Array.isArray(sdata?.data) && sdata.data.length > 0 ? sdata.data[0] : null;

      // Channel info (title/category even when offline)
      const { data: cdata } = await api.get('/channels', { params: { broadcaster_id: broadcasterId } });
      const chan = Array.isArray(cdata?.data) && cdata.data.length > 0 ? cdata.data[0] : null;

      const now = Date.now();
      if (live) {
        const gameName = await fetchGameName(api, live.game_id || chan?.game_id);
        const upd = {
          isLive: true,
          title: live.title || chan?.title || '',
          gameId: live.game_id || chan?.game_id || '',
          gameName,
          startedAt: live.started_at ? new Date(live.started_at).toISOString() : null,
          lastChecked: now
        };
        if (upd.isLive !== state.isLive) upd.lastChange = now;
        Object.assign(state, upd);
      } else {
        const gameName = await fetchGameName(api, chan?.game_id);
        const upd = {
          isLive: false,
          title: chan?.title || '',
          gameId: chan?.game_id || '',
          gameName,
          startedAt: null,
          lastChecked: now
        };
        if (upd.isLive !== state.isLive) upd.lastChange = now;
        Object.assign(state, upd);
      }
      saveToDisk();
    } catch (e) {
      logger?.warn?.('[live] fetchOnce failed: ' + (e?.message || e));
    }
  }

  function start() {
    stop();
    loadFromDisk();
    fetchOnce();
    timer = setInterval(fetchOnce, Math.max(10, POLL_SEC) * 1000);
    logger?.info?.(`[live] polling every ${Math.max(10, POLL_SEC)}s for ${login}`);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function getContext() {
    const lines = [];
    if (state.isLive) {
      const g = state.gameName ? ` — playing ${state.gameName}` : '';
      const up = uptimeHhMm();
      lines.push(`LIVE: ${state.title || 'On stream'}${g} — uptime ${up}`);
      if (state.startedAt) lines.push(`Stream started at ${state.startedAt}`);
    } else {
      const g = state.gameName ? ` (${state.gameName})` : '';
      if (state.title) lines.push(`OFFLINE: ${state.title}${g}`);
      else lines.push(`OFFLINE`);
    }
    return { lines, isLive: state.isLive, snapshot: { ...state }, uptimeHhMm };
  }

  return { start, stop, getContext, state, uptimeHhMm };
}
