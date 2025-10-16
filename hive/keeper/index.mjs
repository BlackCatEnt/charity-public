// File: hive/keeper/index.mjs
// v0.2 Ops Polish reference keeper (keeps v0.1 defaults when envs unset)
// single-runner lock, idempotency, atomic moves, retention, heartbeat, metrics.
// Windows-first, no external deps.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { setTimeout as delay } from 'node:timers/promises';
import CONFIG from './config.mjs';
import { createLogger } from './log.mjs';
import Scribe from '../scribe/index.mjs';
import { metricsIngest, startMetrics } from "#sentry/metrics/rollup.mjs";
import { TokenBucket } from "./qos.mjs";
import { scribeWriteWithRetry } from "#hive/scribe/index.mjs";
import { createPushgatewayPusher } from "#hive/metrics/pushgateway.mjs";
import { m_scribe_write, m_scribe_retry } from "#hive/metrics/prom.mjs";
import {
   registry,
   m_keeper_processed,
   m_keeper_qdepth,
   m_hall_dedup_drop,
   m_keeper_events_total,
   m_keeper_event_duration_ms,   // NEW
   m_keeper_errors_total         // NEW
} from '../metrics/prom.mjs';
let __keeperPgw; // hold pusher for shutdown
startMetrics();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Paths ---
const ROOT = path.resolve(__dirname, '..', '..');     // repo root (two up from /hive/keeper)
const RELICS_DIR = path.join(ROOT, 'relics');
const QUEUE_DIR   = process.env.KEEPER_QUEUE_DIR  || path.join(RELICS_DIR, '.queue', 'incoming');
const RUNTIME_DIR = process.env.KEEPER_RUNTIME_DIR || path.join(RELICS_DIR, '.runtime');
const DLQ_DIR = path.join(RUNTIME_DIR, 'dlq'); // canonical DLQ for v0.4
const PROCESSED_DIR = path.join(RUNTIME_DIR, 'queue_processed');
const FAILED_DIR = path.join(RUNTIME_DIR, 'queue_failed');
const TMP_DIR = path.join(RUNTIME_DIR, 'tmp');
const HEARTBEAT_FILE = path.join(RUNTIME_DIR, 'keeper.alive');
const LOCK_FILE = path.join(RUNTIME_DIR, 'keeper.lock');
const HASH_MARKS_DIR = path.join(RUNTIME_DIR, 'keeper_hashes');
const LOG_DIR = process.env.KEEPER_LOG_DIR ?? "relics/.runtime/logs/events";
const LOG_FILE = process.env.KEEPER_LOG_FILE ?? "keeper.jsonl";
const ECHO = (process.env.KEEPER_LOG_ECHO ?? "0") === "1";
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const METRICS_PORT = Number(process.env.KEEPER_METRICS_PORT || 8140);

ensureDir(LOG_DIR);
const logPath = path.join(LOG_DIR, LOG_FILE);
const out = fs.createWriteStream(logPath, { flags: "a" });

// Retention policy
const RETAIN_PROCESSED_DAYS = 7;
const RETAIN_FAILED_DAYS = 30;

const SMOKE = (process.env.SMOKE || 'false').toLowerCase() === 'true';
const FAIL_RATIO = Number(process.env.SMOKE_FAKE_FAIL_RATIO || '0'); // e.g., 0.3..1.0

// Internal state
let _stopRequested = false;
let _isOwnerOfLock = false;
let _lastRetentionYDay = -1;
let _counters = { processed: 0, failed: 0, skipped: 0 };
let _qos = {
  rateLimitHits: 0,
  duplicatesSkipped: 0, // file-level dupes already counted as "skipped"
  overflowRejects: 0
};
// publish for the /metrics JSON handler
globalThis._qos = _qos;

function ensureDirs() {
  for (const d of [QUEUE_DIR, RUNTIME_DIR, PROCESSED_DIR, FAILED_DIR, TMP_DIR, HASH_MARKS_DIR, DLQ_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function exclusiveLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    _isOwnerOfLock = true;
    const payload = JSON.stringify(
      { pid: process.pid, startedAt: new Date().toISOString(), host: process.env.COMPUTERNAME || '' },
      null, 2
    );
    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);
    const release = () => { try { if (_isOwnerOfLock) fs.unlinkSync(LOCK_FILE); } catch {} _isOwnerOfLock = false; };
    const shutdown = async () => {
      _stopRequested = true;
      try { await __keeperPgw?.stop(); } catch {}
      try { globalThis.__keeperHttpServer?.close(); } catch {}
      release();
      process.exit(0);
    };
    process.once('exit', release);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

function sha256OfFileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

async function markHashProcessed(hash) {
  const markFile = path.join(HASH_MARKS_DIR, `${hash}.done`);
  await fsp.writeFile(markFile, `${Date.now()}`);
}
function wasHashProcessed(hash) {
  const markFile = path.join(HASH_MARKS_DIR, `${hash}.done`);
  return fs.existsSync(markFile);
}

function writeHeartbeat() {
  const hb = { pid: process.pid, ts: new Date().toISOString(), counters: _counters };
  try { fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(hb)); } catch {}
}

function isJsonl(file) { return file.toLowerCase().endsWith('.jsonl'); }

async function* listQueueFiles() {
  const entries = await fsp.readdir(QUEUE_DIR, { withFileTypes: true });
  const files = entries.filter(e => e.isFile() && isJsonl(e.name)).map(e => e.name).sort();
  for (const name of files) yield path.join(QUEUE_DIR, name);
}

function ensureEventId(rec) {
  if (rec && rec.event_id) return rec;
  const hall = String(rec?.source || rec?.hall || "unknown");
  const kind = String(rec?.kind || "unknown");
  // include ts + body-ish to stabilize the hash for “same logical event”
  const ts   = String(rec?.ts ?? "");
  const body = JSON.stringify(rec?.body ?? rec ?? {});
  const raw  = `${hall}|${kind}|${ts}|${body}`;
  const event_id = crypto.createHash('sha256').update(raw).digest('hex');
  return { ...rec, event_id };
}

async function readJsonl(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const records = [];
  let malformed = 0;
  for (const line of lines) {
    try { records.push(JSON.parse(line)); }
    catch { records.push({ kind:'malformed', raw: line }); malformed++; }
  }
  if (malformed) console.log(`metric=keeper_malformed_lines value=${malformed} file=${JSON.stringify(path.basename(filePath))}`);
  return records;
}
// hive/keeper/index.mjs — top-level helper
async function withRetries(fn, {tries=5, baseMs=100, maxMs=3000}) {
  let attempt = 0, lastErr;
  while (attempt < tries) {
    try { return await fn(); } 
    catch (e) {
      lastErr = e;
      const delay = Math.min(baseMs * (2 ** attempt), maxMs);
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
  throw lastErr;
}

async function processFile({ filePath, scribeSend }) {
  const hash = sha256OfFileSync(filePath);
  const hashSidecar = filePath + '.sha256';
  try { await fsp.writeFile(hashSidecar, hash); } catch {}

  if (wasHashProcessed(hash)) {
    _counters.skipped++;
    console.log(`metric=keeper_skipped_files value=1 file=${JSON.stringify(path.basename(filePath))} reason=already_processed`);
    return 'skipped';
  }

  const tmpName = `${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.wrk`;
  const tmpPath = path.join(TMP_DIR, tmpName);
  await fsp.rename(filePath, tmpPath); // atomic within same volume

  let status = 'processed';
  // HOIST so catch can access on partial failure:
  /** @type {any[]} */ let records = [];
  /** @type {number} */ let i = -1;
  
  try {
    records = await readJsonl(tmpPath);
    // simple token-bucket maps
    const hallBuckets = new Map();
    const beeBuckets = new Map();
    const mkBucket = (tps=50, cap=100) => new TokenBucket({ tokensPerSec: tps, bucketSize: cap });
    const getHall = (name) => hallBuckets.get(name) || hallBuckets.set(name, mkBucket( process.env[`RL_${name.toUpperCase()}_TPS`] ? Number(process.env[`RL_${name.toUpperCase()}_TPS`]) : 10,
                                                                                      process.env[`RL_${name.toUpperCase()}_CAP`] ? Number(process.env[`RL_${name.toUpperCase()}_CAP`]) : 20 )).get(name);
    const getBee  = (name) => beeBuckets.get(name)  || beeBuckets.set(name,  mkBucket( process.env[`RL_BEE_${name.toUpperCase()}_TPS`] ? Number(process.env[`RL_BEE_${name.toUpperCase()}_TPS`]) : 10,
                                                                                      process.env[`RL_BEE_${name.toUpperCase()}_CAP`] ? Number(process.env[`RL_BEE_${name.toUpperCase()}_CAP`]) : 20 )).get(name);

    i = 0;
    for (; i < records.length; i++) {
      const rec = records[i];
      const hall = String(rec?.source || "unknown");
      const bee  = String(rec?.bee || rec?.target || "core");
      const kind = String(rec?.kind || "unknown");

      // Fast-path: simulate hall-level dedup drop if the record carries the flag
      if (rec?.__dedupDropped === true) {
        m_hall_dedup_drop.inc({ hall }, 1);
        // Skip sending to scribe for dropped events
        continue;
      }
      // Block until tokens are available (bounded by RL_MAX_WAIT_MS)
      const maxWait = Number(process.env.RL_MAX_WAIT_MS || 5000); // 5s default
      const step    = 50;  // 50ms polling step
      let waited = 0;
      while (!(getHall(hall).allow(1) && getBee(bee).allow(1))) {
        _qos.rateLimitHits++;
        if (waited >= maxWait) {
          // AFTER waiting long enough, don't fail the whole file:
          // degrade to best-effort by waiting a little longer once (keeps pipeline moving)
          await delay(step);
          break;
        }
        await delay(step);
        waited += step;
      }
      const t0 = performance.now();
      const ok = await withRetries(() => scribeSend(ensureEventId(rec)), { tries: 5, baseMs: 100, maxMs: 1500 });
      if (!ok) throw new Error('scribeSend returned false');
      // Count successful processing
      m_keeper_processed.inc({ hall, kind, result: 'ok' }, 1);
      // NEW: canonical total counter (post-success)
      m_keeper_events_total.inc({ hall, kind }, 1);
      // NEW: latency histogram (ms) per successful record
      try { m_keeper_event_duration_ms.observe(performance.now() - t0, { hall, kind }); } catch {}	  
    }
    await markHashProcessed(hash);
    const finalName = `${path.basename(filePath)}`;
    await fsp.rename(tmpPath, path.join(PROCESSED_DIR, finalName));
    _counters.processed++;
    console.log(`metric=keeper_processed_files value=1 file=${JSON.stringify(finalName)} lines=${records.length}`);
    status = 'processed';
  } catch (e) {
    const finalName = `${path.basename(filePath)}`;
    try { await fsp.rename(tmpPath, path.join(FAILED_DIR, finalName)); } catch {}
    _counters.failed++;

    // small helpers for readability
    const emitErrorMetrics = () => {
      try {
        const rec  = (Array.isArray(records) && i >= 0) ? records[i] : null;
        const hall = String(rec?.source || "unknown");
        const kind = String(rec?.kind   || "unknown");
        m_keeper_processed.inc({ hall, kind, result: "error" }, 1);
        m_keeper_errors_total.inc({ reason: String(e?.code || "send"), hall, kind }, 1);
      } catch {}
    };
    const requeueRemainder = async () => {
      if (!(i >= 0 && Array.isArray(records))) return false;
      const remainder = records.slice(i);
      if (remainder.length === 0) return false;
      const stamp       = new Date().toISOString().replace(/[:.]/g, "-");
      const requeueName = `requeue-${finalName.replace(/\.jsonl$/,"")}-${stamp}.jsonl`;
      const requeuePath = path.join(QUEUE_DIR, requeueName);
      const payload     = remainder.map(r => JSON.stringify(r)).join("\n") + "\n";
      await fsp.writeFile(requeuePath, payload, "utf8");
      console.log(`metric=keeper_requeued_records value=${remainder.length} requeue=${JSON.stringify(requeueName)} from=${JSON.stringify(finalName)} failed_index=${i}`);
      keeperLog({ type: "keeper.partial_fail", file: finalName, requeued: requeueName, count: remainder.length, failed_index: i, error: String(e?.message || e) });
      return true;
    };

    // 1) try to requeue what we didn't process
    let requeued = false;
    try {
      requeued = await requeueRemainder();
    } catch {/* non-fatal */}
    emitErrorMetrics();
    status = "failed";
    if (requeued) return status;  // partial failure handled — do NOT DLQ whole file

    // 2) full failure: copy to DLQ for visibility
    try {
      await fsp.copyFile(path.join(FAILED_DIR, finalName), path.join(DLQ_DIR, finalName));
      keeperLog({ type: "dlq.record", reason: String(e?.message || e), file: finalName });
    } catch {}
    console.log(`metric=keeper_failed_files value=1 file=${JSON.stringify(finalName)} error=${JSON.stringify(String(e?.message || e))}`);
  } finally {
    try { await fsp.unlink(hashSidecar); } catch {}
  }
  return status;
}

function daysToMs(days) { return days * 24 * 60 * 60 * 1000; }
function ydayOf(d) { const start = new Date(Date.UTC(d.getUTCFullYear(),0,0)); return Math.floor((d - start) / 86400000); }

async function retentionSweepOnce(now = new Date()) {
  const doYDay = ydayOf(now);
  if (_lastRetentionYDay === doYDay) return; // once per UTC day
  _lastRetentionYDay = doYDay;

  async function sweep(dir, days) {
    const cutoff = Date.now() - daysToMs(days);
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        const p = path.join(dir, e.name);
        try {
          const st = await fsp.stat(p);
          if (st.mtimeMs < cutoff) { await fsp.unlink(p); }
        } catch {}
      }
    } catch {}
  }
  await sweep(PROCESSED_DIR, RETAIN_PROCESSED_DAYS);
  await sweep(FAILED_DIR, RETAIN_FAILED_DAYS);
  console.log(
    `metric=keeper_retention_sweep value=1 processed_days=${RETAIN_PROCESSED_DAYS} failed_days=${RETAIN_FAILED_DAYS}`
  );
}

export async function processQueueOnce(opts = {}) {
  const { scribeSend = async (_rec) => true, maxFilesPerTick = 50 } = opts;
  ensureDirs();
  let handled = 0;
  for await (const filePath of listQueueFiles()) {
    if (handled >= maxFilesPerTick) break;
    try {
      const status = await processFile({ filePath, scribeSend });
      if (status) handled++;
    } catch (e) {
      console.log(`metric=keeper_internal_errors value=1 file=${JSON.stringify(path.basename(filePath))} error=${JSON.stringify(String(e?.message || e))}`);
	  try { m_keeper_errors_total.inc({ reason: 'internal' }, 1); } catch {}
	}
  }
  return handled;
}

function startHttpServer() {
  const port = Number(process.env.KEEPER_METRICS_PORT || 8140);
  // eslint-disable-next-line no-console
  console.log(`[keeper] metrics listening on http://127.0.0.1:${port}`);

  const server = http.createServer(async (req, res) => {
    try {
      const files = await fsp.readdir(QUEUE_DIR, { withFileTypes: true });
      const jsonl = files.filter(d => d.isFile() && d.name.toLowerCase().endsWith('.jsonl'));
      const queueDepth = jsonl.length;
      // keep the gauge fresh
      m_keeper_qdepth.set({ queue: 'ingest' }, queueDepth);
	  
      if (req.method === 'POST' && req.url === '/shutdown') {
        // graceful stop that clears PGW even when no OS signal is delivered
        try { await __keeperPgw?.stop(); } catch {}
        try { if (_isOwnerOfLock) { fs.unlinkSync(LOCK_FILE); _isOwnerOfLock = false; } } catch {}
        res.writeHead(200).end("ok");
        process.exit(0);
        return;
      }
      if (req.url === '/metrics') {
        const body = registry.toText();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        return void res.end(body);
      }

      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ ok: true, queueDepth }));
      }

      // quick introspection helper
      if (req.url === '/debug') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({
          queueDir: QUEUE_DIR,
          runtimeDir: RUNTIME_DIR,
          processedDir: PROCESSED_DIR,
          failedDir: FAILED_DIR,
          dlqDir: DLQ_DIR,
          maxFilesPerTick: Number(process.env.MAX_FILES_PER_TICK || 50),
          env: {
            RL_TWITCH_TPS: process.env.RL_TWITCH_TPS,
            RL_TWITCH_CAP: process.env.RL_TWITCH_CAP,
            RL_BEE_BUSY_TPS: process.env.RL_BEE_BUSY_TPS,
            RL_BEE_BUSY_CAP: process.env.RL_BEE_BUSY_CAP
          },
          queueDepth,
          jsonlSample: jsonl.slice(0, 10).map(d => d.name)
        }, null, 2));
      }

      res.writeHead(404); res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    }
  });

  server.keepAliveTimeout = 5000;
  server.headersTimeout = 7000;
  server.listen(port, '127.0.0.1');
  globalThis.__keeperHttpServer = server;
  return server;
}

export function start({ intervalMs = 2000, scribeSend } = {}) {
  ensureDirs();
  // start({ intervalMs }) caller can pass; otherwise adapt:
  const effectiveInterval = Math.max(200, Math.min(5000, intervalMs));

  if (!exclusiveLock()) {
    console.log('Hive Keeper already running (lock present). Exiting.');
    return () => {};
  }
  _stopRequested = false;
  
  // --- Pushgateway (prod) ---
  try {
    __keeperPgw = createPushgatewayPusher({ service: "keeper", clearOnStop: true });
    __keeperPgw.start();
  } catch {}

  // --- Optional boot smoke to prove keeper_events_total wiring ---
  if ((process.env.KEEPER_EMIT_BOOT_SMOKE ?? "0") === "1") {
    try { m_keeper_events_total.inc({ hall: "system", kind: "boot_smoke" }, 1); } catch {}
  }
  
  // Bind HTTP probes only when we are the active instance
  if (!globalThis.__keeperHttpServerStarted) {
    try {
      startHttpServer();
      globalThis.__keeperHttpServerStarted = true;
    } catch (e) {
      if (String(e?.code) === 'EADDRINUSE') {
        console.warn('[keeper] metrics port in use; skipping HTTP probe startup');
      } else {
        console.warn('[keeper] HTTP probe failed to start:', e);
      }
    }
  }

  const tick = async () => {
    if (_stopRequested) return;
    try {
      await retentionSweepOnce();
      const maxFilesPerTick = Number(process.env.MAX_FILES_PER_TICK || 50);
      await processQueueOnce({ scribeSend: scribeWriteWithRetry, maxFilesPerTick });
    } catch (e) {
      console.log(`metric=keeper_tick_errors value=1 error=${JSON.stringify(String(e?.message || e))}`);
    } finally { writeHeartbeat(); }
  };

  let running = false;
  const scheduleNext = () => {
    if (_stopRequested) return;
    setTimeout(async () => {
      if (running) return scheduleNext();
      running = true;
      await tick();
      running = false;
      scheduleNext();
    }, effectiveInterval);
  };

  tick().then(() => scheduleNext());

  return function stop() {
    _stopRequested = true;
    if (_isOwnerOfLock) { try { fs.unlinkSync(LOCK_FILE); } catch {}; _isOwnerOfLock = false; }
  };
}
const log = createLogger({
  dir: CONFIG.LOG_DIR,
  level: CONFIG.LOG_LEVEL,
  filenamePrefix: 'keeper',
  retentionDays: 14, // per spec
});

// This mock "scan" mimics v0.1 behaviors: process up to MAX_FILES_PER_TICK items
async function scanAndProcessOnce() {
  // For demo: pretend we processed N items
  const n = Math.min(CONFIG.MAX_FILES_PER_TICK, 5);
  log.info('tick', { max: CONFIG.MAX_FILES_PER_TICK, processed: n });
  return Array.from({length: n}, (_,i)=>({ id:`rec-${Date.now()}-${i}` }));
}

const scribe = new Scribe({ logger: log }); // simulate=auto by default

async function run() {
  log.info('keeper.start', { interval_ms: CONFIG.INTERVAL_MS });
  while (true) {
    const batch = await scanAndProcessOnce();
    for (const rec of batch) {
      const ok = await scribe.send({ ...rec, ts: Date.now() });
      log.info('scribe.metrics', { ...scribe.metrics });
    }
    await delay(CONFIG.INTERVAL_MS);
  }
}

//const isDirectRun = (() => {
  //try { return import.meta.url === pathToFileURL(process.argv[1]).href; }
  //catch { return false; }
//})();
//if (isDirectRun) {
  //run().catch(e => {
    //log.error('keeper.crash', { msg: e?.message, stack: e?.stack });
    //process.exitCode = 1;
  //});
//}
// Direct-run demo disabled in service mode:
// (We only run Keeper through boot -> start().)
export function keeperLog(event) {
  const rec = {
    ts: new Date().toISOString(),
    v: 1,
	node_id: process.env.NODE_ID || process.env.COMPUTERNAME || "",
    service: process.env.SERVICE_NAME || "keeper",
    version: process.env.SERVICE_VERSION || process.env.npm_package_version || "0.3.0",
    ...event,
  };
  const line = JSON.stringify(rec);
  out.write(line + "\n");
  if (ECHO) console.log(line);
  try { metricsIngest(rec); } catch {}
  if ((process.env.SCRIBE_FANOUT ?? "0") === "1") {
    // fan out asynchronously, don't block
    Promise.resolve()
     .then(() => scribeWriteWithRetry(rec))
     .catch(() => {});
  }
}
  export async function handleEvent(evt){
  // Update queue depth if you track it
  // (queue depth now set in HTTP handler; optional to keep this if you
  //  update depth elsewhere in your loop)
  
  // Example de-dup path
  if (evt.__dedupDropped) {
    m_hall_dedup_drop.inc({ hall: evt.hall || 'unknown' }, 1);
    return { result: 'dedup_drop' };
  }

  // Normal processing
  try {
    const kind = evt.kind || 'unknown';
    // ... your processing ...
    m_keeper_processed.inc({ kind, hall: evt.hall || 'unknown', result: 'ok' }, 1);
    return { result: 'ok' };
  } catch (err) {
    const kind = evt.kind || 'unknown';
    m_keeper_processed.inc({ kind, hall: evt.hall || 'unknown', result: 'error' }, 1);
    throw err;
  }
}

// minimal health pulse (you can invoke this from boot once per minute)
export function keeperPulse(extra = {}) {
  keeperLog({ type: "keeper.pulse", ...extra });
}
export default run;
