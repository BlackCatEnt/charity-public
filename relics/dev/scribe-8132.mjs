import { createPushgatewayPusher } from "../../hive/metrics/pushgateway.mjs";

const PUSH_URL  = process.env.PUSH_URL  ?? "http://localhost:9091";
const JOB       = process.env.METRICS_JOB ?? "charity_sentry_aggregator";
const INSTANCE  = process.env.INSTANCE ?? "local";

const metrics = createPushgatewayPusher({
  baseUrl: PUSH_URL,
  job: JOB,
  instance: INSTANCE,
  service: "scribe",
  flushMs: 5000,
  clearOnStop: true,
});

// WHENEVER you "flush a batch", call:
function onScribeBatchFlushed(n = 1) {
  metrics.inc("scribe_batches_total", n);
}

// Example fake tick while developing:
setInterval(() => onScribeBatchFlushed(1), 3000);
process.on("SIGINT", async () => {
  await metrics.flush();
  process.exit(0);
});
process.on("SIGTERM", async () => { await metrics.stop(); process.exit(0); });
console.log(`[metrics][scribe] PUSH_URL=${PUSH_URL} job=${JOB} instance=${INSTANCE}`);

