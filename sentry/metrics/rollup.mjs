// sentry/metrics/rollup.mjs
// Sentry owns roll-up/export of metrics emitted by producers.
// Options you can implement here (now or later):
// 1) Scrape producers' /metrics and re-expose a combined /metrics.
// 2) Transform to OTLP / pushgateway / remote-write.

import fs from "node:fs";
import path from "node:path";

const BUCKET_MS = parseInt(process.env.METRICS_ROLLUP_INTERVAL_MS ?? "60000", 10); // 1 min
const OUT_DIR = process.env.METRICS_DIR ?? "relics/.runtime/logs/metrics";

const counts = new Map(); // key -> number
let timer;

function keyOf(ev) {
  // default grouping: type + hall (if present)
  const t = ev.type ?? "unknown";
  const h = ev.hall ?? "-";
  return `${t}::${h}`;
}

export function metricsIngest(ev) {
  const k = keyOf(ev);
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

function flush() {
  const now = new Date();
  const day = now.toISOString().slice(0,10);
  const dir = path.join(OUT_DIR, day.slice(0,7)); // YYYY-MM
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `metrics-${day}.jsonl`);
  const payload = {
    ts: now.toISOString(),
    v: 1,
    kind: "rollup",
    bucket_ms: BUCKET_MS,
    counts: Object.fromEntries(counts.entries()),
  };
  fs.appendFileSync(file, JSON.stringify(payload) + "\n");
  counts.clear();
}

export function startMetrics() {
  if (timer) return;
  timer = setInterval(flush, BUCKET_MS);
}

export function stopMetrics() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export async function scrapeAndExport() {
  // placeholder: fetch from http://127.0.0.1:8140/metrics (Keeper), others too
  // combine/transform, then expose or forward.
}