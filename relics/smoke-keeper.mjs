// relics/smoke-keeper.mjs
// v0.5: keeper smoke that waits for /metrics and handles lock-owner cases.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import CONFIG from '../hive/keeper/config.mjs';
import { createLogger } from '../hive/keeper/log.mjs';
import { start as startKeeper } from '#hive/keeper/index.mjs';
import { scribeWriteWithRetry } from '#hive/scribe/index.mjs';

const PORT = Number(process.env.KEEPER_METRICS_PORT || 8140);
const PROBE = `http://127.0.0.1:${PORT}/metrics`;
const RUNTIME = new URL('../relics/.runtime/', import.meta.url).pathname;
const LOCK_FILE = RUNTIME + 'keeper.lock';

function waitFor(url, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
        setTimeout(ping, 150);
      });
    })();
  });
}

async function main() {
  const log = createLogger({
    dir: CONFIG.LOG_DIR,
    level: CONFIG.LOG_LEVEL,
    filenamePrefix: 'keeper',
    retentionDays: 14,
  });

  // Try to start keeper (it will refuse if lock is held)
  const stop = await startKeeper({ intervalMs: 500, scribeSend: scribeWriteWithRetry });

  try {
    // Either the new process we just started, or a pre-existing keeper, should expose /metrics.
    await waitFor(PROBE, 8000);
  } catch (e) {
    // Helpful hint: show lock owner if present
    try {
      const fs = await import('node:fs/promises');
      const lock = await fs.readFile(LOCK_FILE, 'utf8').catch(() => null);
      if (lock) console.error('Keeper lock present; contents:', lock);
    } catch {}
    throw e;
  }

  // Keep alive long enough for ≥1 tick
  await new Promise((r) => setTimeout(r, 1500));
  // leave process running; parent/CI will kill or next step will exit
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

export default main;
