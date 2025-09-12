// modules/townCrier.js
import { getAdSchedule, snoozeNextAd, startCommercial } from './ads.js';

export function createTownCrier({ cfg, getTokens, broadcasterId, sendChat, log }) {
    // cfg is the *ads* sub-config; enable unless explicitly disabled
  const state = {
    timers: new Set(),
    lastAnnouncedFor: null,
    enabled: (cfg?.enabled !== false),
    lastErrAt: 0,
    lastNoneAt: 0,
    lastNoneVal: null
  };

  function clearTimers() { for (const t of state.timers) clearTimeout(t); state.timers.clear(); }
  function say(msg) { if (!state.enabled || !msg) return; sendChat(msg); }

  async function planWarnings({ speakErrors = false, speakNone = false } = {}) {
    clearTimers();
    try {
      const { clientId, accessToken } = await getTokens('broadcaster');
      if (!accessToken) {
        throw new Error('missing broadcaster access token');
      }
      const info = await getAdSchedule({ clientId, accessToken, broadcasterId });
      if (!info) return;
      const { next_ad_at, duration, preroll_free_time, snooze_count } = info;
      if (!next_ad_at) {
        if (speakNone) {
          const now = Date.now();
          const noneCoolMs = Number(cfg?.noneCooldownMs ?? 60_000);
          const curVal = String(preroll_free_time ?? 0);
          if (now - state.lastNoneAt > noneCoolMs || state.lastNoneVal !== curVal) {
            say(render(cfg.templates?.none, { PREROLL: preroll_free_time ?? 0 }));
            state.lastNoneAt = now;
            state.lastNoneVal = curVal;
          }
        }
        return;
      }
      const next = new Date(next_ad_at).getTime();
      const now = Date.now();
      if (state.lastAnnouncedFor === next) return; // already scheduled
      const warnList = (cfg.warnSeconds || [120,60,30,10]).map(s => next - (s * 1000)).filter(t => t > now);
      for (const at of warnList) {
        const eta = Math.round((next - at) / 1000);
        state.timers.add(setTimeout(() => say(render(cfg.templates?.warn, { ETA: eta, SNOOZES: snooze_count ?? 0 })), at - now));
      }
      state.timers.add(setTimeout(() => say(render(cfg.templates?.live, { DUR: duration ?? 60 })), Math.max(0, next - now)));
      state.lastAnnouncedFor = next;
    } catch (e) {
      log?.('ads', e);
      if (speakErrors) {
        const now = Date.now();
        const coolMs = Number(cfg?.errorCooldownMs ?? 60_000);
        if (now - state.lastErrAt > coolMs) {
          say('🛎️ The Town Crier can’t fetch the ad schedule right now (auth).');
          state.lastErrAt = now;
        }
      }
    }
  }

  function render(tpl, vals) { return (tpl || '').replace(/\{(\w+)\}/g, (_, k) => `${vals[k] ?? ''}`); }

  async function handleCommand(cmd, args, userIsBroadcasterOrMod) {
    if (cmd === 'ads') {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'next') { await planWarnings({ speakErrors: true, speakNone: true }); return; }
      if (sub === 'snooze' && userIsBroadcasterOrMod) {
        const { clientId, accessToken } = await getTokens('broadcaster');
        const r = await snoozeNextAd({ clientId, accessToken, broadcasterId });
        say(render(cfg.templates?.snoozed, { SNOOZES: r?.snooze_count ?? '?' }));
         await planWarnings({ speakErrors: true, speakNone: true }); return;
      }
      if (sub === 'run' && userIsBroadcasterOrMod) {
        const len = Math.min(180, Math.max(30, parseInt(args[1] || '60', 10) || 60));
        const { clientId, accessToken } = await getTokens('broadcaster');
        const r = await startCommercial({ clientId, accessToken, broadcasterId, length: len });
        say(`🏷️ Starting a ${r?.length || len}s break. Cooldown ${r?.retry_after ?? '?'}s.`);
        return;
      }
      say('Usage: !ads next | !ads snooze | !ads run <30..180>');
    }
  }

  const interval = setInterval(() => planWarnings({ speakErrors: false, speakNone: false }).catch(e => log?.('ads', e)), cfg.pollMs || 30000);

  return {
    shutdown() { clearInterval(interval); clearTimers(); },
    handleCommand,
    refresh(opts) { return planWarnings({ speakErrors: !!(opts && opts.speakErrors), speakNone: !!(opts && opts.speakNone) }); }
  };
}
