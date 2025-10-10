// hive/scribe/backpressure.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { metricsIngest } from "#sentry/metrics/rollup.mjs";

const RELICS_DIR = path.resolve("relics");
const RUNTIME_DIR = process.env.KEEPER_RUNTIME_DIR || path.join(RELICS_DIR, ".runtime");
const RETRY_DIR = process.env.SCRIBE_RETRY_DIR || path.join(RUNTIME_DIR, "scribe_retry");
const DLQ_DIR = path.join(RUNTIME_DIR, "dlq");

const BATCH_MAX = Number(process.env.SCRIBE_BATCH_MAX || 100);
const FLUSH_MS  = Number(process.env.SCRIBE_FLUSH_MS || 250);
const BACKOFF_BASE = Number(process.env.SCRIBE_BACKOFF_BASE_MS || 250);
const BACKOFF_MAX  = Number(process.env.SCRIBE_BACKOFF_MAX_MS  || 5000);
const JITTER_PCT   = Number(process.env.SCRIBE_JITTER_PCT || 0.2);
const RETRY_TTL_MS = Number(process.env.SCRIBE_RETRY_TTL_MS || 5 * 60 * 1000);

let buffer = [];
let flushTimer = null;
let flushing = false;
let draining = false; // when true, _flushNow() is driving the drain synchronously

let _m = {
  inflight: 0,
  batches_flushed: 0,
  flush_ms_p50: 0,
  flush_ms_p95: 0,
  retry_count: 0,
  dropped_ttl: 0,
  queue_depth: 0
};
globalThis.__scribeMetrics = _m;

async function ensureDirs() {
  await fs.mkdir(RETRY_DIR, { recursive: true });
  await fs.mkdir(DLQ_DIR, { recursive: true });
}

function jitter(ms) {
  const d = ms * JITTER_PCT;
  return ms + ((Math.random() * 2 - 1) * d);
}

function nowStamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

const FAKE_FAIL_RATIO = process.env.SCRIBE_FAKE_FAIL_RATIO
  ? Number(process.env.SCRIBE_FAKE_FAIL_RATIO)
  : 0;
const IS_SMOKE = (process.env.NODE_ENV || "").toLowerCase() === "smoke";
let __fakeFailCounter = 0;

async function writeSink(ndjson) {
  // Deterministic(ish) failure injector for smokes.
  if (IS_SMOKE && FAKE_FAIL_RATIO > 0) {
    // e.g., ratio 0.3 => fail roughly 30% of calls, but with a stable cadence
    __fakeFailCounter++;
    const period = Math.max(1, Math.round(1 / FAKE_FAIL_RATIO));
    if (__fakeFailCounter % period === 0) {
      throw new Error("scribe sink (fake) failure for smoke");
    }
  }
  // Default sink: append to relics/scribe.ndjson
  const sink = path.join(RELICS_DIR, "scribe.ndjson");
  await fs.appendFile(sink, ndjson, "utf8");
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_MS);
  flushTimer.unref?.();
}

async function flush() {
  if (flushing) return;
  if (buffer.length === 0) return;
  flushing = true;
  const started = Date.now();
  // take at most BATCH_MAX; leave the rest for follow-up flushes
  const batch = buffer.splice(0, Math.max(1, BATCH_MAX));
  _m.inflight = buffer.length;

  const ndjson = batch.map(r => JSON.stringify(r)).join("\n") + "\n";

  try {
    await writeSink(ndjson);
    _m.batches_flushed++;
    recordFlushLatency(Date.now() - started);
    metricsIngest?.({ type: "scribe_batches_flushed" });
  } catch (e) {
    // Spill to disk for retry
    await spillForRetry(batch);
  } finally {
    flushing = false;
    // If we're not in a test-driven drain, keep normal scheduling behavior.
    if (!draining) {
      if (buffer.length >= BATCH_MAX) {
        const im = setImmediate(() => { void flush(); }); // drain next batch promptly
        im.unref?.();
      } else if (buffer.length > 0) {
        if (!flushTimer) scheduleFlush();               // tail of the burst on timer
      }
    }
    // kick a retry sweep in background (but don't keep process alive)
    const t = setTimeout(() => { void retrySweep(); }, 0);
    t.unref?.();
  }
}

function recordFlushLatency(ms) {
  // tiny sliding window quantiles (simple & good enough)
  const arr = (recordFlushLatency._w ||= []);
  arr.push(ms); if (arr.length > 100) arr.shift();
  const sorted = [...arr].sort((a,b)=>a-b);
  const p = q => sorted[Math.min(sorted.length-1, Math.floor(q*(sorted.length-1)))];
  _m.flush_ms_p50 = p(0.50);
  _m.flush_ms_p95 = p(0.95);
}

async function spillForRetry(records, attempt=1, bornAt=Date.now()) {
  _m.retry_count++;
  metricsIngest?.({ type: "scribe_retry_enqueued" });
  const stamp = nowStamp();
  const key = crypto.randomBytes(4).toString("hex");
  const meta = { attempt, bornAt };
  const payload = JSON.stringify({ meta, records }) + "\n";
  const file = `srq-${stamp}-${key}.json`;
  await fs.writeFile(path.join(RETRY_DIR, file), payload, "utf8");
  await updateQueueDepth();
}

async function updateQueueDepth() {
  try {
    const list = await fs.readdir(RETRY_DIR);
    _m.queue_depth = list.filter(n => n.endsWith(".json")).length;
  } catch { _m.queue_depth = 0; }
}

async function retrySweep() {
  await ensureDirs();
  let files = await fs.readdir(RETRY_DIR);
  files = files.filter(n => n.endsWith(".json")).sort(); // FIFO-ish
  for (const f of files) {
    let blob;
    const fp = path.join(RETRY_DIR, f);
    try { blob = JSON.parse(await fs.readFile(fp, "utf8")); } catch { continue; }
    const { meta, records } = blob || {};
    const age = Date.now() - (meta?.bornAt ?? Date.now());
    if (age > RETRY_TTL_MS) {
      // TTL expired → DLQ the batch
      _m.dropped_ttl += (records?.length || 0);
      metricsIngest?.({ type: "scribe_dropped_ttl" });
      const dlqName = `scribe-dlq-${f.replace(/^srq-/, "")}`;
      try {
        await fs.copyFile(fp, path.join(DLQ_DIR, dlqName));
      } catch {}
      await fs.rm(fp, { force: true });
      await updateQueueDepth();
      continue;
    }
    // backoff = base * 2^(attempt-1), jittered
    const attempt = (meta?.attempt || 1);
    const backoff = Math.min(BACKOFF_MAX, BACKOFF_BASE * (2 ** (attempt - 1)));
    const dueAt = (meta?.lastAttemptAt || meta?.bornAt || 0) + backoff;
    if (Date.now() < jitter(dueAt - (meta?.lastAttemptAt || meta?.bornAt || 0)) + (meta?.lastAttemptAt || meta?.bornAt || 0)) {
      continue; // not yet time
    }
    // Try again as a batch
    const ndjson = (records||[]).map(r => JSON.stringify(r)).join("\n") + "\n";
    try {
      await writeSink(ndjson);
      _m.batches_flushed++;
      metricsIngest?.({ type: "scribe_batches_flushed" });
      await fs.rm(fp, { force: true });
      await updateQueueDepth();
    } catch {
      // bump attempt & write back
      const meta2 = { attempt: attempt + 1, bornAt: meta?.bornAt ?? Date.now(), lastAttemptAt: Date.now() };
      const payload = JSON.stringify({ meta: meta2, records }) + "\n";
      await fs.writeFile(fp, payload, "utf8");
    }
  }
}

export async function startScribe() {
  await ensureDirs();
  // opportunistic sweeper
  setInterval(() => { void retrySweep(); }, 1000).unref?.();
}

export async function scribeWrite(rec) {
  buffer.push(rec);
  _m.inflight = buffer.length;
  if (buffer.length >= BATCH_MAX) {
    if (!flushing) { void flush(); }
    else if (!flushTimer) { scheduleFlush(); } // make sure a follow-up is armed
  } else {
    scheduleFlush();
  }
  return true; // enqueue always succeeds
}

// Optional: direct flush for tests
export async function _flushNow() {
  // Deterministically drain all batches (test/admin helper).
  draining = true;
  try {
    // Cancel any timer; we'll drive the drain.
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    while (buffer.length > 0) {
      await flush();
      // safety: if someone re-armed the timer, cancel again
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    }
  } finally {
    draining = false;
  }
}
export async function _retrySweep() { await retrySweep(); }
// Test/diagnostic helpers (no-op in prod)
export function _getScribeMetrics() { return globalThis.__scribeMetrics || _m; }
export function _getScribeDebug() {
  return {
    isSmoke: (process.env.NODE_ENV || "").toLowerCase() === "smoke",
    fakeFailRatio: Number(process.env.SCRIBE_FAKE_FAIL_RATIO || 0),
    batchMax: Number(process.env.SCRIBE_BATCH_MAX || 100),
    flushMs: Number(process.env.SCRIBE_FLUSH_MS || 250),
    drainingFlag: Boolean(draining),
  };
}
