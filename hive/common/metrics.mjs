import os from "node:os";
import process from "node:process";
import { Counter, Histogram, Registry, Pushgateway, collectDefaultMetrics } from "prom-client";

// Environment (with sane defaults)
const PGW_ENABLED = process.env.PGW_ENABLED?.toLowerCase() !== "false"; // default true
const PGW_URL = process.env.PGW_URL ?? "http://127.0.0.1:9091";
const PGW_JOB = process.env.PGW_JOB ?? "charity";
const PGW_INSTANCE = process.env.PGW_INSTANCE ?? os.hostname();
const PGW_INTERVAL_MS = Number(process.env.PGW_PUSH_INTERVAL_MS ?? 5000);

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// Common labels across Keeper/Scribe
export function withServiceLabels(service) {
  return { job: PGW_JOB, instance: PGW_INSTANCE, service };
}

// Define counters here so both services share consistent names/help text.
export const metrics = {
  keeper_events_total: new Counter({
    name: "keeper_events_total",
    help: "Total number of events processed by Keeper.",
    registers: [registry],
    labelNames: ["status","transport"], // 'service' via default labels
  }),
  keeper_errors_total: new Counter({
    name: "keeper_errors_total",
    help: "Keeper errors by reason.",
    registers: [registry],
    labelNames: ["reason"], // 'service' via default labels
  }),
  scribe_write_errors_total: new Counter({
    name: "scribe_write_errors_total",
    help: "Scribe write errors by result.",
    registers: [registry],
    labelNames: ["result"], // 'service' via default labels
  }),
  keeper_event_duration_ms: new Histogram({
    name: "keeper_event_duration_ms",
    help: "End-to-end Keeper event processing time (ms).",
    registers: [registry],
    labelNames: [], // 'service' via default labels
    buckets: [5,10,25,50,100,250,500,1000,2500,5000],
  }),
  scribe_flush_duration_ms: new Histogram({
    name: "scribe_flush_duration_ms",
    help: "Scribe batch flush duration (ms).",
    registers: [registry],
    labelNames: [], // 'service' via default labels
    buckets: [5,10,25,50,100,250,500,1000,2500,5000],
  }),+  keeper_errors_total: new Counter({
    name: "keeper_errors_total",
    help: "Keeper errors by reason.",
    registers: [registry],
    labelNames: ["reason"], // 'service' via default labels
  }),
  scribe_write_errors_total: new Counter({
    name: "scribe_write_errors_total",
    help: "Scribe write errors by result.",
    registers: [registry],
    labelNames: ["result"], // 'service' via default labels
  }),
  keeper_event_duration_ms: new Histogram({
    name: "keeper_event_duration_ms",
    help: "End-to-end Keeper event processing time (ms).",
    registers: [registry],
    labelNames: [], // 'service' via default labels
    buckets: [5,10,25,50,100,250,500,1000,2500,5000],
  }),
  scribe_flush_duration_ms: new Histogram({
    name: "scribe_flush_duration_ms",
    help: "Scribe batch flush duration (ms).",
    registers: [registry],
    labelNames: [], // 'service' via default labels
    buckets: [5,10,25,50,100,250,500,1000,2500,5000],
  }),
  scribe_batches_total: new Counter({
    name: "scribe_batches_total",
    help: "Total number of batches flushed by Scribe (sum of batch sizes).",
    registers: [registry],
    labelNames: ["service"],
  }),
};

let pushTimer = null;
let pgw = null;
let pushFn = null;

export function createPushgatewayPusher({ service, clearOnStop = true } = {}) {
  if (!PGW_ENABLED) {
    return {
      start() {},
      async stop() {},
      async clear() {},
      labels() { return { service }; },
    };
  }

  pgw = new Pushgateway(PGW_URL, {}, registry);
  const labels = withServiceLabels(service);

  // Prom-client Pushgateway doesn't accept arbitrary labels on push call;
  // we set default labels on the registry via "labels" wrapper.
  registry.setDefaultLabels({ job: PGW_JOB, instance: PGW_INSTANCE, service });

  pushFn = async () => pgw.pushAdd({ jobName: PGW_JOB }).catch(() => {});

  const start = () => {
    if (!pushTimer) pushTimer = setInterval(pushFn, PGW_INTERVAL_MS);
  };

  const stop = async () => {
    if (pushTimer) {
      clearInterval(pushTimer);
      pushTimer = null;
    }
    // one last push to flush any stragglers
    try { await pushFn(); } catch {}
  };

  const clear = async () => {
    try {
      await pgw.delete({ jobName: PGW_JOB });
    } catch {}
  };

  // install shutdown hooks once per process
  // (idempotent-ish; calling multiple times is harmless)
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      try {
        await stop();
        if (clearOnStop) { await clear(); }
      } finally {
        process.exit(0);
      }
    });
  }

  return { start, stop, clear, labels: () => labels };
}
