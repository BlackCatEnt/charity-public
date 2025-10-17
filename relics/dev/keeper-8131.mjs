import { createPushgatewayPusher } from "../../hive/metrics/pushgateway.mjs";


// envs (override in your shell as needed)
const PUSH_URL  = process.env.PUSH_URL  ?? "http://localhost:9091";
const JOB       = process.env.METRICS_JOB ?? "charity_sentry_aggregator";
const INSTANCE  = process.env.INSTANCE ?? "local";

const metrics = createPushgatewayPusher({
  baseUrl: PUSH_URL,
  job: JOB,
  instance: INSTANCE,
  service: "keeper",
  flushMs: 5000,
  clearOnStop: true,
});

// ... your existing keeper dev logic ...
// WHENEVER you "handle an event", call:
function onKeeperEventHandled() {
  metrics.inc("keeper_events_total", 1);
}

// Example fake tick so you can see rate() move while developing:
setInterval(() => onKeeperEventHandled(), 2000);
process.on("SIGINT", async () => {
  await metrics.flush();
  process.exit(0);
});
process.on("SIGTERM", async () => { await metrics.stop(); process.exit(0); });
console.log(`[metrics][keeper] PUSH_URL=${PUSH_URL} job=${JOB} instance=${INSTANCE}`);
