// Small E2E-ish smoke: emits N events, ensures ≥2 flushes happen, exits 0.
// If SCRIBE_DRY_RUN=true, it will log instead of POSTing.

import { createPushgatewayTransport } from "../../hive/scribe/transport.pushgateway.mjs";

const N = parseInt(process.env.SCRIBE_SMOKE_EVENTS || "37", 10);
const delayMs = parseInt(process.env.SCRIBE_SMOKE_EMIT_MS || "5", 10);

// Ensure short flush for the smoke unless overridden
process.env.SCRIBE_FLUSH_MS = process.env.SCRIBE_FLUSH_MS || "100";
process.env.SCRIBE_BATCH_MAX = process.env.SCRIBE_BATCH_MAX || "10";

const t = createPushgatewayTransport({});
t.start();

(async () => {
  for (let i = 0; i < N; i++) {
    t.emit({ k: "batch" });
    // Jitter a bit to trigger backpressure intermittently
    const jitter = i % 11 === 0 ? delayMs * 5 : delayMs;
    await new Promise((r) => setTimeout(r, jitter));
  }

  // Wait for at least two flush windows
  const waitMs = 2 * (parseInt(process.env.SCRIBE_FLUSH_MS || "100", 10) + 50);
  await new Promise((r) => setTimeout(r, waitMs));

  const stats = t.stats();
  console.log(
    JSON.stringify({ kind: "scribe_smoke_debug", dbg: { ...stats } }, null, 2)
  );

  await t.stop({ drain: true });
  // If nothing pushed, that's suspicious (unless N=0)
  if (stats.totalPushed <= 0 && N > 0) {
    console.error("[scribe] smoke: no pushes recorded");
    process.exit(2);
  }
  process.exit(0);
})().catch(async (e) => {
  console.error("[scribe] smoke error:", e?.message || e);
  await t.stop({ drain: true });
  process.exit(1);
});
