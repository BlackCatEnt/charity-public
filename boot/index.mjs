import 'dotenv/config';
import cfg from '#codex/charity.config.json' assert { type: 'json' };
import { makeOrchestrator } from '#mind/orchestrator.mjs';
import twitch from '#halls/twitch/adapter.mjs';
import discord from '#halls/discord/adapter.mjs';
import { keepBroadcasterFresh } from '#relics/helix.mjs';
import { startTwitchGameWatch } from '#sentry/gamewatch.mjs';
import { initAudioHall } from '#halls/audio/adapter.mjs';
import { start as startKeeper } from '#hive/keeper/index.mjs';
import { scribeWrite } from '#hive/scribe/index.mjs';

// 1) build + start the orchestrator
const orch = await makeOrchestrator({ cfg });
await orch.registerHall('twitch', twitch);
await orch.registerHall('discord', discord);
await orch.registerHall('audio', initAudioHall);
await orch.start();

// 2) create a minimal io facade that uses the orchestrator’s send
const io = { send: (roomId, msg, opt) => orch.send(roomId, msg, opt) };

// 3) now start the game watcher (io is defined)
const stopGameWatch = startTwitchGameWatch({ io });
// keep a ref to stopGameWatch() if you want to cleanly stop it on shutdown

// --- Keeper v0.4: start file-queue worker + HTTP /health,/metrics ---
const scribeSend = async (rec) => {
  try { await scribeWrite(rec); return true; } catch { return false; }
};
startKeeper({
  intervalMs: Number(process.env.KEEPER_INTERVAL_MS || 2000),
  scribeSend
});

for (const sig of ['SIGINT','SIGTERM','beforeExit']) {
  process.on(sig, async () => { try { await flush(); } catch {} });
}

// optional: background token refresh
keepBroadcasterFresh();
