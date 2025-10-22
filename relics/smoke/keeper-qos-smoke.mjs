// relics/smoke/keeper-qos-smoke.mjs
import { withQoS } from '../../hive/keeper/qos.mjs';
import { metrics } from '../../hive/scribe/metrics.mjs';

const N = Number(process.env.SMOKE_N ?? 200);
const fakeFailRatio = Number(process.env.SMOKE_FAIL_RATIO ?? 0.25);

async function task(t) {
  if (Math.random() < fakeFailRatio) throw new Error('boom');
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 8)));
  return t;
}

const qos = withQoS(task, {
  rps: Number(process.env.KEEPER_RPS ?? 50),
  burst: Number(process.env.KEEPER_BURST ?? 80),
  concurrency: Number(process.env.KEEPER_CONCURRENCY ?? 8),
  maxRetries: Number(process.env.KEEPER_MAX_RETRIES ?? 3),
  backoff: { baseMs: 50, factor: 2, maxMs: 500 },
  circuit: { failureThreshold: 12, cooldownSec: 5 },
});

const start = Date.now();
let ok = 0;
let bad = 0;
for (let i = 0; i < N; i++) {
  try {
    await qos.run({ i });
    ok++;
  } catch {
    bad++;
  }
}
const ms = Date.now() - start;
console.log(JSON.stringify({ kind: 'keeper_qos_smoke', ok, bad, ms }, null, 2));
await metrics.flush().catch(() => {});
process.exit(0);
