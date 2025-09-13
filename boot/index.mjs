import 'dotenv/config';
import cfg from '#codex/charity.config.json' assert { type: 'json' };
import { makeOrchestrator } from '#mind/orchestrator.mjs';
import twitch from '#halls/twitch/adapter.mjs';
import discord from '#halls/discord/adapter.mjs';
import { keepBroadcasterFresh } from '#relics/helix.mjs';

const orch = await makeOrchestrator({ cfg });

// Register halls (adapters)
await orch.registerHall('twitch', twitch);
await orch.registerHall('discord', discord);

// Go
await orch.start();

// after you create/start the orchestrator & halls:
keepBroadcasterFresh(); // no-op if you don’t have a refresh token saved