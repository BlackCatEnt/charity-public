// File: relics/run-keeper.mjs
// Purpose: launcher that runs Keeper as its own Node process (Task Scheduler target)
import { start } from '../hive/keeper/index.mjs';
import { send as sendToScribe } from '../hive/scribe/index.mjs';
start({ intervalMs: 2000, scribeSend: sendToScribe });
