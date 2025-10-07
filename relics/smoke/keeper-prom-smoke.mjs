// relics/smoke/keeper-prom-smoke.mjs
import http from 'node:http';
import { start as startKeeper } from '#hive/keeper/index.mjs';
import { scribeWriteWithRetry } from '#hive/scribe/index.mjs';

const PORT = Number(process.env.KEEPER_METRICS_PORT || 8140);
const PROBE = `http://127.0.0.1:${PORT}/metrics`;

function waitFor(url, timeoutMs = 8000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function ping() {
      http.get(url, res => { res.resume(); resolve(); })
          .on('error', () => (Date.now() - t0 > timeoutMs) ? reject(new Error('timeout')) : setTimeout(ping, 150));
    })();
  });
}

(async () => {
  // start keeper using the current API
  await startKeeper({ intervalMs: 500, scribeSend: scribeWriteWithRetry });
  await waitFor(PROBE);
  // optionally keep alive a moment for at least one tick
  await new Promise(r => setTimeout(r, 1200));

  // seed a dedup-dropped event if you want the counter to move every run
  // (we normally seed via seed-queue.mjs in CI)
  console.log(JSON.stringify({ kind: 'keeper_prom_smoke', ok: true }));
})().catch(e => { console.error(e); process.exit(1); });
