// relics/smoke/scribe-backpressure-smoke.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..", "..");
const relics = path.join(root, "relics");
const runtime = path.join(relics, ".runtime");
const retryDir = path.join(runtime, "scribe_retry");
const ndjsonSink = path.join(relics, "scribe.ndjson");

// Enable deterministic fake fail for smoke-only runs
process.env.NODE_ENV = "smoke";
process.env.SCRIBE_FAKE_FAIL_RATIO = process.env.SCRIBE_FAKE_FAIL_RATIO || "0.3";

// Tune batching/backoff to make the smoke quick
process.env.SCRIBE_BATCH_MAX = process.env.SCRIBE_BATCH_MAX || "20";
process.env.SCRIBE_FLUSH_MS = process.env.SCRIBE_FLUSH_MS || "50";
process.env.SCRIBE_BACKOFF_BASE_MS = "50";
process.env.SCRIBE_BACKOFF_MAX_MS = "400";
process.env.SCRIBE_JITTER_PCT = "0.1";
process.env.SCRIBE_RETRY_TTL_MS = "60000"; // 1m (should not hit)

await fs.mkdir(runtime, { recursive: true });
await fs.mkdir(retryDir, { recursive: true });
await fs.writeFile(ndjsonSink, "", "utf8").catch(()=>{});

const { startScribe, scribeWrite, _flushNow, _retrySweep, _getScribeMetrics, _getScribeDebug } = await import("#hive/scribe/backpressure.mjs");

// Patch writeSink by shadowing the module (quick hack): move the file aside if needed.
// For simplicity in this smoke, we simulate failure by replacing fs.appendFile globally would be too invasive.
// Instead, we inject failure by writing special records that we detect here:
let i = 0;
const realAppend = (await import("node:fs/promises")).appendFile;
(async () => {})(); // noop

await startScribe();

// Enqueue 200 records; mark ~30% with a fail flag the sink can react to.
// Our backpressure module appends to relics/scribe.ndjson, so we simulate "sink failure"
// by randomly throwing when batch is being written: easiest is to temporarily make the file unwritable.
// That's OS-noisy; instead we approximate by sending batches fast and verifying retries > 0.

for (let k=0; k<200; k++) {
  await scribeWrite({ type:"smoke-scribe", id:k, payload:{ k } });
}


// Deterministically execute multiple flushes now so the fake-fail path MUST trigger.
// We’ll call _flushNow() several times even if inflight appears 0 due to races.
{
  // Print debug so we can see the fake-fail config actually took.
  const dbg = _getScribeDebug?.() || {};
  console.log(JSON.stringify({ kind: "scribe_smoke_debug", dbg }, null, 2));

  // Force multiple flush invocations (guarantees period-based fake fail will fire)
  for (let n = 0; n < 12; n++) {
    await _flushNow();
  }
  // Now ensure the buffer is truly empty with a bounded drain loop
  let spins = 0;
  while ((_getScribeMetrics()?.inflight ?? 0) > 0 && spins < 50) {
    await _flushNow();
    spins++;
  }
}

// Retry sweeps until the retry queue is empty or timeout
{
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    await _retrySweep();
    const q = Number(_getScribeMetrics()?.queue_depth ?? 0);
    if (q === 0) break;
    await new Promise(r => setTimeout(r, 80));
  }
}

// Inspect metrics
const resp = _getScribeMetrics() || {};
console.log(JSON.stringify({ kind:"scribe_smoke_summary", metrics: resp }, null, 2));
try {
  assert(resp.batches_flushed >= 1, "no batches flushed");
  assert(resp.retry_count > 0, "retry counter did not increase (fake fail not active?)");
  process.exit(0);
} catch (e) {
  console.error(String(e?.stack || e?.message || e));
  process.exit(1);
}

// hard stop for CI/dev so the script never hangs the shell
setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref?.();
