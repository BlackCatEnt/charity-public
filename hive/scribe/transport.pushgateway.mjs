// ESM: Node >=18
import os from "node:os";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Pushgateway transport with batching + backpressure signals.
 * Produces a *monotonic* counter: scribe_batches_total
 */
export function createPushgatewayTransport(opts = {}) {
  const {
    pushgatewayUrl = process.env.PUSHGATEWAY_URL || "http://localhost:9091",
    job = process.env.SCRIBE_JOB || "scribe-smoke",
    instance =
      process.env.SCRIBE_INSTANCE || os.hostname().replace(/\./g, "_"),
    batchMax = asInt(process.env.SCRIBE_BATCH_MAX, 10),
    flushMs = asInt(process.env.SCRIBE_FLUSH_MS, 150),
    drainOnExit = asBool(process.env.SCRIBE_DRAIN_ON_EXIT, true),
    dryRun = asBool(process.env.SCRIBE_DRY_RUN, false),
    staticLabels = { service: "scribe" },
  } = opts;

  const queue = [];
  let timer = null;
  let totalPushed = 0;
  let backpressureOn = false;
  let lastOverThresholdAt = 0;

  function emit(evt = {}) {
    // evt could be anything; for v0.3 we only need to count "batches"
    queue.push(evt);
    checkBackpressure();
  }

  function start() {
    if (timer) return;
    timer = setInterval(async () => {
      if (queue.length === 0) return;
      const batch = queue.splice(0, batchMax);
      totalPushed += batch.length;
      checkBackpressure();

      const exposition = toExpositionFormat({
        metric: "scribe_batches_total",
        help: "Monotonic counter of Scribe-exported batches",
        type: "counter",
        labels: staticLabels,
        value: totalPushed,
      });

      if (dryRun) {
        console.log(
          `[scribe] DRY RUN push -> ${job}/${instance} value=${totalPushed} size=${batch.length}`
        );
        return;
      }

      try {
        const url = `${pushgatewayUrl.replace(/\/+$/, "")}/metrics/job/${encodeURIComponent(
          job
        )}/instance/${encodeURIComponent(instance)}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: exposition,
        });
        if (!res.ok) {
          const body = await safeText(res);
          console.error(
            `[scribe] push failed ${res.status} ${res.statusText}: ${body}`
          );
        } else {
          // Successful
          // optionally: console.log(`[scribe] push ok: total=${totalPushed}`);
        }
      } catch (err) {
        console.error(`[scribe] push error:`, err?.message || err);
      }
    }, flushMs);
  }

  async function stop({ drain = drainOnExit } = {}) {
    if (timer) clearInterval(timer);
    timer = null;
    if (drain && queue.length > 0) {
      const batch = queue.splice(0);
      totalPushed += batch.length;

      const exposition = toExpositionFormat({
        metric: "scribe_batches_total",
        help: "Monotonic counter of Scribe-exported batches",
        type: "counter",
        labels: staticLabels,
        value: totalPushed,
      });

      if (!dryRun) {
        try {
          const url = `${pushgatewayUrl.replace(/\/+$/, "")}/metrics/job/${encodeURIComponent(
            job
          )}/instance/${encodeURIComponent(instance)}`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: exposition,
          });
          if (!res.ok) {
            const body = await safeText(res);
            console.error(
              `[scribe] drain push failed ${res.status} ${res.statusText}: ${body}`
            );
          }
        } catch (err) {
          console.error(`[scribe] drain push error:`, err?.message || err);
        }
      } else {
        console.log(
          `[scribe] DRY RUN drain -> ${job}/${instance} value=${totalPushed} size=${batch.length}`
        );
      }
    }
    // tiny sleep to let the last POST flush TCP buffers in CI
    await sleep(25);
  }

  // backpressure heuristic
  function checkBackpressure() {
    const over = queue.length > 2 * batchMax;
    const now = Date.now();

    if (over) {
      if (lastOverThresholdAt === 0) lastOverThresholdAt = now;
      const sustained = now - lastOverThresholdAt > 2 * flushMs;
      if (sustained && !backpressureOn) {
        backpressureOn = true;
        console.warn(`[scribe] scribe:backpressure:on q=${queue.length}`);
      }
    } else {
      lastOverThresholdAt = 0;
      if (backpressureOn) {
        backpressureOn = false;
        console.warn(`[scribe] scribe:backpressure:off q=${queue.length}`);
      }
    }
  }

  // graceful shutdown hooks
  if (asBool(process.env.SCRIBE_HOOK_SIGNALS, true)) {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, async () => {
        await stop({ drain: true });
        process.exit(0);
      });
    }
    process.on("beforeExit", async () => {
      await stop({ drain: true });
    });
  }

  return { emit, start, stop, stats: () => ({ totalPushed, q: queue.length }) };
}

function toExpositionFormat({ metric, help, type, labels = {}, value }) {
  const lbl = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join(",");
  const header = `# HELP ${metric} ${help}\n# TYPE ${metric} ${type}\n`;
  return lbl.length
    ? `${header}${metric}{${lbl}} ${value}\n`
    : `${header}${metric} ${value}\n`;
}

function asInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function asBool(v, d) {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return d;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return d;
}
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
