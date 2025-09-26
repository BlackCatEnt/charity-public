import cfg from '#codex/charity.config.json' assert { type: 'json' };
import { helixGetChannelInfo } from '#relics/helix.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

async function readJSONSafe(p, fallback = {}) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}
async function saveJSON(p, data) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}
async function updateConfig(relOrPath, mutate) {
  const p = /[\\/]/.test(relOrPath) ? relOrPath : `codex/${relOrPath}`;
  const cur = await readJSONSafe(p, {});
  const next = (await mutate?.(cur)) ?? cur;
  await saveJSON(p, next);
  return next;
}

export function startTwitchGameWatch({ io } = {}) {
  if (!cfg?.games?.auto_detect) return () => {}; // no-op

  let last = null;
  const interval = Math.max(30_000, Number(cfg.games.auto_detect_interval_ms) || 120_000);
  const channelName = process.env.TWITCH_CHANNEL; // optional, for announce
  const announce = !!cfg?.games?.announce_changes;

  const tick = async () => {
    try {
      const info = await helixGetChannelInfo({});
      const name = (info?.game_name || '').trim();
      if (!name) return;

      if (!last || name.toLowerCase() !== last.toLowerCase()) {
        last = name;
        await updateConfig('moderation.config.json', d => {
          d.spoilers = d.spoilers || {};
          d.spoilers.active_game = name;
        });

        if (announce && io && channelName) {
          await io.send(channelName, `Game changed → **${name}**. Spoiler filter updated. ✧`, { hall: 'twitch', raw: true });
        }
      }
    } catch (e) {
      console.warn('[gamewatch]', e.message);
    }
  };

  // prime + schedule with a tiny jitter to avoid rate spikes
  tick();
  const id = setInterval(tick, interval + Math.floor(Math.random() * 5000));
  return () => clearInterval(id);
}
