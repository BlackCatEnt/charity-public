// File: hive/keeper/index.mjs
// v0.2 Ops Polish reference keeper (keeps v0.1 defaults when envs unset)
// single-runner lock, idempotency, atomic moves, retention, heartbeat, metrics.
// Windows-first, no external deps.


import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fsp from 'fs/promises';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { setTimeout as delay } from 'node:timers/promises';
import CONFIG from './config.mjs';
import { createLogger } from './log.mjs';
import Scribe from '../scribe/index.mjs';
import { metricsIngest, startMetrics } from "#sentry/metrics/rollup.mjs";
import { scribeWrite } from "#hive/scribe/index.mjs";

startMetrics();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Paths ---
const ROOT = path.resolve(__dirname, '..', '..');     // repo root (two up from /hive/keeper)
const RELICS_DIR = path.join(ROOT, 'relics');
const QUEUE_DIR = path.join(RELICS_DIR, '.queue');
const RUNTIME_DIR = path.join(RELICS_DIR, '.runtime');
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

ensureDir(LOG_DIR);
const logPath = path.join(LOG_DIR, LOG_FILE);
const out = fs.createWriteStream(logPath, { flags: "a" });

// Retention policy
const RETAIN_PROCESSED_DAYS = 7;
const RETAIN_FAILED_DAYS = 30;

// Internal state
let _stopRequested = false;
let _isOwnerOfLock = false;
let _lastRetentionYDay = -1;
let _counters = { processed: 0, failed: 0, skipped: 0 };

function ensureDirs() {
  for (const d of [QUEUE_DIR, RUNTIME_DIR, PROCESSED_DIR, FAILED_DIR, TMP_DIR, HASH_MARKS_DIR]) {
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
    process.once('exit',     () => { try { if (_isOwnerOfLock) fs.unlinkSync(LOCK_FILE); } catch {} });
    process.once('SIGINT',  () => { _stopRequested = true; });
	process.once('SIGTERM', () => { _stopRequested = true; });
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
  try {
    const records = await readJsonl(tmpPath);
    for (const rec of records) {
      const ok = await withRetries(() => scribeSend(rec), { tries: 5, baseMs: 100, maxMs: 1500 });
      if (!ok) throw new Error('scribeSend returned false');
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
    console.log(`metric=keeper_failed_files value=1 file=${JSON.stringify(finalName)} error=${JSON.stringify(String(e?.message || e))}`);
    status = 'failed';
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
    }
  }
  return handled;
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

  const tick = async () => {
    if (_stopRequested) return;
    try {
      await retentionSweepOnce();
      await processQueueOnce({ scribeSend });
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
const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();
if (isDirectRun) {
  run().catch(e => {
    log.error('keeper.crash', { msg: e?.message, stack: e?.stack });
    process.exitCode = 1;
  });
}
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
    Promise.resolve().then(() => scribeWrite(rec)).catch(() => {});
  }
}

// minimal health pulse (you can invoke this from boot once per minute)
export function keeperPulse(extra = {}) {
  keeperLog({ type: "keeper.pulse", ...extra });
}
export default run;
