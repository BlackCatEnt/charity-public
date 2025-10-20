// A:\Charity\hive\common\metrics.mjs
import os from "node:os";
import process from "node:process";
import {
  Counter,
  Histogram,
  Registry,
  Pushgateway,
  collectDefaultMetrics,
} from "prom-client";

// ----- Environment (with sane defaults)
const PGW_ENABLED = (process.env.PGW_ENABLED ?? "true").toLowerCase() !== "false";
const PGW_URL = process.env.PGW_URL ?? "http://127.0.0.1:9091";
const PGW_JOB = process.env.PGW_JOB ?? "charity";
const PGW_INSTANCE = process.env.PGW_INSTANCE ?? os.hostname();
const PGW_INTERVAL_MS = Number(process.env.PGW_PUSH_INTERVAL_MS ?? 5000);

// ----- Registry & defaults
export const registry = new Registry();
collectDefaultMetrics({ register: registry });
registry.setDefaultLabels({ job: PGW_JOB, instance: PGW_INSTANCE });

// Helper (not strictly required but handy for tests)
export function withServiceLabels(service) {
  return { job: PGW_JOB, instance: PGW_INSTANCE, service };
}

// ----- Metrics (shared by Keeper & Scribe)
export const metrics = {
  // No extra labelNames here so inc() works directly
  keeper_events_total: new Counter({
    name: "keeper_events_total",
    help: "Total number of events processed by Keeper.",
    registers: [registry],
  }),

  // Errors by reason
  keeper_errors_total: new Counter({
    name: "keeper_errors_total",
    help: "Keeper errors by reason.",
    registers: [registry],
    labelNames: ["reason"],
  }),

  // Scribe write result errors (e.g., 'error', 'timeout')
  scribe_write_errors_total: new Counter({
    name: "scribe_write_errors_total",
    help: "Scribe write errors by result.",
    registers: [registry],
    labelNames: ["result"],
  }),

  // Latency histograms
  keeper_event_duration_ms: new Histogram({
    name: "keeper_event_duration_ms",
    help: "End-to-end Keeper event processing time (ms).",
    registers: [registry],
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  }),

  scribe_flush_duration_ms: new Histogram({
    name: "scribe_flush_duration_ms",
    help: "Scribe batch flush duration (ms).",
    registers: [registry],
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  }),

  // Scribe batch “volume” counter; includes transport + status
  scribe_batches_total: new Counter({
    name: "scribe_batches_total",
    help: "Total number of records flushed by Scribe (sum of batch sizes).",
    registers: [registry],
    labelNames: ["status", "transport"],
  }),
};

// ----- Pushgateway pusher
let pushTimer = null;
let pgw = null;
let pushFn = null;

/**
 * createPushgatewayPusher({ service, clearOnStop=true })
 * start(): begin periodic pushes
 * stop(): stop timer + final push
 * clear(): delete series for this job (and instance/service via default labels)
 */
export function createPushgatewayPusher({ service, clearOnStop = true } = {}) {
  if (!PGW_ENABLED) {
    return {
      start() {},
      async stop() {},
      async clear() {},
      labels() {
        return { service };
      },
    };
  }

  // set/override default labels to include service for this process
  registry.setDefaultLabels({ job: PGW_JOB, instance: PGW_INSTANCE, service });
  pgw = new Pushgateway(PGW_URL, {}, registry);

  pushFn = async () => {
    // pushAdd preserves time series not mentioned in this batch
    await pgw.pushAdd({ jobName: PGW_JOB });
  };

  const start = () => {
    if (!pushTimer) pushTimer = setInterval(pushFn, PGW_INTERVAL_MS);
  };

  const stop = async () => {
    if (pushTimer) {
      clearInterval(pushTimer);
      pushTimer = null;
    }
    try {
      await pushFn(); // final flush
    } catch {
      /* ignore */
    }
  };

  const clear = async () => {
    try {
      await pgw.delete({ jobName: PGW_JOB });
    } catch {
      /* ignore */
    }
  };

  // Graceful shutdown hooks
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      try {
        await stop();
        if (clearOnStop) await clear();
      } finally {
        process.exit(0);
      }
    });
  }

  return {
    start,
    stop,
    clear,
    labels: () => withServiceLabels(service),
  };
}
