// A:\Charity\modular_phase2\modules\live.js
// Live context polling via Twitch Helix (with disk cache)

import fs from 'fs';
import path from 'path';
import { api } from './helix-auth.js';

export function createLive(CHARITY_CFG, logger, channelLogin) {
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
    lastChange: 0,
  };

  function loadFromDisk() {
    try {
      const raw = fs.readFileSync(CACHE_PATH, 'utf8');
      const obj = JSON.parse(raw);
      for (const k of ['isLive','title','gameId','gameName','startedAt','lastChecked','lastChange']) {
        if (k in obj) state[k] = obj[k];
      }
      logger?.info?.('[live] cache loaded');
    } catch {/* no-op */}
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
    const m = Math.floor(uptimeMs() / 60000);
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, '0');
    return `${h}:${mm}`;
  }

  function getContext() {
    return {
      isLive: state.isLive,
      title: state.title,
      gameId: state.gameId,
      gameName: state.gameName,
      startedAt: state.startedAt,
      uptime: uptimeHhMm(),
      lastChecked: state.lastChecked,
      lastChange: state.lastChange,
    };
  }

  async function resolveUserId() {
    if (!login) throw new Error('channel login missing');
    const j = await api('users', { id: 'broadcaster', query: { login }, logger });
    const id = j?.data?.[0]?.id;
    if (!id) throw new Error('broadcaster id not found for ' + login);
    return id;
  }

  async function fetchGameName(gameId) {
    if (!gameId) return '';
    if (gameCache.has(gameId)) return gameCache.get(gameId);
    const j = await api('games', { id: 'broadcaster', query: { id: gameId }, logger });
    const name = j?.data?.[0]?.name || '';
    if (name) gameCache.set(gameId, name);
    return name;
  }

  async function fetchOnce() {
    try {
      const broadcasterId = await resolveUserId();
      const j = await api('streams', { id: 'broadcaster', query: { user_id: broadcasterId }, logger });
      const live = j?.data?.[0];

      state.lastChecked = Date.now();
      const was = state.isLive;
      state.isLive = !!live;

      if (live) {
        state.title     = live.title || '';
        state.gameId    = live.game_id || '';
        state.startedAt = live.started_at || null;
        state.gameName  = await fetchGameName(state.gameId);
      }

      if (state.isLive !== was) {
        state.lastChange = Date.now();
        logger?.info?.(`[live] ${state.isLive ? 'LIVE' : 'OFFLINE'} — ${state.title || ''}`);
      }

      saveToDisk();
    } catch (e) {
      logger?.warn?.('[live] fetchOnce failed: ' + (e?.message || e));
    }
  }

  function start() {
    loadFromDisk();
    logger?.info?.(`[live] polling every ${POLL_SEC}s for ${login}`);
    stop();
    timer = setInterval(fetchOnce, POLL_SEC * 1000);
    fetchOnce();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start, stop, uptimeHhMm,
    getState: () => ({ ...state }),
    getContext,
  };
}
