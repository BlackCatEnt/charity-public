// hive/scribe/index.mjs
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTransport } from "./transport.mjs";
import { withRetry } from "./backoff.mjs";
import { counter, flush, setDefaultMetricTags } from "./metrics.mjs";
import { createPushgatewayPusher } from "#hive/metrics/pushgateway.mjs";
import {
  m_scribe_write,
  m_scribe_retry,
  m_scribe_batches_total,
  m_scribe_flush_duration_ms,     // NEW
  m_scribe_write_errors_total,     // NEW
  m_scribe_poison_total,
  m_scribe_duplicates_total
} from '../metrics/prom.mjs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..'); // repo root (two up from /hive/scribe)
const RELICS_DIR = path.join(ROOT, 'relics');
const RUNTIME_DIR = path.join(RELICS_DIR, '.runtime');
const STATE_DIR = path.join(RELICS_DIR, '.state');
const POISON_DIR = path.join(RELICS_DIR, '.queue', 'poison');
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(POISON_DIR, { recursive: true });
const DEDUPE_FILE = path.join(STATE_DIR, 'scribe-dedupe.json');

const SMOKE_MODE = process.env.SMOKE === 'true';
const FAKE_FAIL_RATIO = Number(process.env.SMOKE_FAKE_FAIL_RATIO || '0'); // e.g., 0.3

// ----- Dedupe store (persistent set of seen event_id)
const dedupe = {
  set: new Set(),
  dirty: false,
};

async function dedupeLoad() {
  try {
    const raw = await fsp.readFile(DEDUPE_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) dedupe.set = new Set(arr);
  } catch {}
}
async function dedupeSave() {
  if (!dedupe.dirty) return;
  dedupe.dirty = false;
  try {
    const arr = Array.from(dedupe.set);
    await fsp.writeFile(DEDUPE_FILE, JSON.stringify(arr));
  } catch {}
}
// keep store bounded (simple FIFO trim)
function dedupeRemember(id, max = Number(process.env.SCRIBE_DEDUPE_MAX || 100_000)) {
  if (dedupe.set.has(id)) return false;
  dedupe.set.add(id);
  dedupe.dirty = true;
  // opportunistic trim
  if (dedupe.set.size > max) {
    const toDrop = Math.floor(max * 0.1); // drop 10% oldest-ish
    let i = 0;
    for (const k of dedupe.set) {
      dedupe.set.delete(k);
      if (++i >= toDrop) break;
    }
    dedupe.dirty = true;
  }
  return true;
}
function dedupeSeen(id) { return dedupe.set.has(id); }

// warm the store
await dedupeLoad();
// flush dedupe on graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { try { await dedupeSave(); } finally { process.exit(0); } });
}

const defaultTags = {
  app: process.env.APP_NAME || "charity",
  host: os.hostname(),
  build: process.env.GIT_SHA || process.env.COMMIT_SHA || "dev",
};

setDefaultMetricTags(defaultTags);

// --- Pushgateway (prod) ---
let __scribePgw;
try {
  __scribePgw = createPushgatewayPusher({ service: "scribe", clearOnStop: true });
  __scribePgw.start();
} catch {}

import http from "node:http";
const ADMIN_PORT = Number(process.env.SCRIBE_ADMIN_PORT ?? 8142);
http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/shutdown") {
    try { await __scribePgw?.stop(); } catch {}
    res.writeHead(200).end("ok");
    process.exit(0);
    return;
  }
  if (req.url === "/healthz") { res.writeHead(200).end("ok"); return; }
  res.writeHead(404).end("not found");
}).listen(ADMIN_PORT, "127.0.0.1", () => {
  console.log(`[scribe] admin listening on 127.0.0.1:${ADMIN_PORT}`);
});

// Accept both "stdout" and "stdout:" to be forgiving
function normalizeUrl(u) {
  if (!u || u === "stdout") return "stdout:";
  return u;
}

const TRANSPORT_URL = normalizeUrl(process.env.SCRIBE_TRANSPORT_URL || "stdout:");
const transport = makeTransport(TRANSPORT_URL);
const AUTOFLUSH = (process.env.SCRIBE_METRICS_AUTOFLUSH ?? "1") !== "0";

// Helper: normalize payloads into NDJSON lines
function toNdjsonLines(payload) {
  if (payload == null) return [];
  // already an array of strings?
  if (Array.isArray(payload)) {
    if (payload.length === 0) return [];
    if (typeof payload[0] === "string") return payload;
    return payload.map((o) => JSON.stringify(o));
  }
  // string: if it contains newlines, assume it's NDJSON already
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return [];
    return trimmed.includes("\n") ? trimmed.split(/\r?\n/).filter(Boolean)
                                  : [trimmed];
  }
  // single object
  return [JSON.stringify(payload)];
}

/**
 * Send an array of NDJSON lines using the configured transport with jittered backoff.
 * @param {string[]} ndjsonLines
 */
async function quarantinePoison(line, reason = "parse") {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `poison-${stamp}.jsonl`;
    const p = path.join(POISON_DIR, name);
    await fsp.appendFile(p, line.trim() + `\n`, "utf8");
  } catch {}
}

/**
 * Filter lines into { good: string[], droppedDup: number, droppedPoison: number }
 * - tries JSON.parse
 * - if missing event_id, passes through (no dedupe)
 * - if event_id present: drop if seen; else remember and pass
 */
async function siftLinesForDedupe(lines) {
  const good = [];
  let droppedDup = 0, droppedPoison = 0;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      droppedPoison++;
      m_scribe_poison_total.inc({}, 1);
      await quarantinePoison(line, "parse");
      continue;
    }
    const id = obj?.event_id;
    if (!id) {
      // no event_id → not deduped, just forward
      good.push(line);
      continue;
    }
    if (dedupeSeen(id)) {
      droppedDup++;
      m_scribe_duplicates_total.inc({}, 1);
      continue;
    }
    dedupeRemember(id);
    good.push(line);
  }
  return { good, droppedDup, droppedPoison };
}

export async function sendLines(ndjsonLines) {
  const start = Date.now();
  const backoffOpts = {
    base: Number(process.env.SCRIBE_BACKOFF_BASE_MS || 250),
    factor: Number(process.env.SCRIBE_BACKOFF_FACTOR || 2),
    cap: Number(process.env.SCRIBE_BACKOFF_CAP_MS || 120000),
    maxRetries: Number(process.env.SCRIBE_BACKOFF_MAX_RETRIES || 8),
  };
    // dedupe/poison sieve
  const { good, droppedDup, droppedPoison } = await siftLinesForDedupe(ndjsonLines);
  if (droppedDup || droppedPoison) {
    // ensure state flush happens eventually
    setTimeout(() => { dedupeSave().catch(()=>{}); }, 0);
  }
  if (good.length === 0) {
    // nothing left to send; still count the attempt as success for observability
    try { m_scribe_flush_duration_ms.observe(Date.now() - start, { transport: transport.name }); } catch {}
    return;
  }


  try {
    await withRetry(() => transport.send(good), backoffOpts);
    counter("scribe.sent", good.length, { transport: transport.name, status: "ok", ...defaultTags });
    m_scribe_batches_total.inc({ transport: transport.name, status: "ok" }, good.length);
  } catch (err) {
    counter("scribe.drop", good.length, {
      transport: transport.name,
      status: "error",
      code: err?.code || "ERR",
      ...defaultTags,
});
    // count attempted size under 'error' for visibility (optional)
    m_scribe_batches_total.inc({ transport: transport.name, status: "error" }, good.length);
    // NEW: error counter (result label carries the error code/fallback)
    try { m_scribe_write_errors_total.inc({ result: String(err?.code || 'error') }, 1); } catch {}	
    throw err;
  } finally {
    counter("scribe.ms", Date.now() - start, { transport: transport.name, ...defaultTags });
    // NEW: flush latency histogram (ms)
    try { m_scribe_flush_duration_ms.observe(Date.now() - start, { transport: transport.name }); } catch {}	
    if (AUTOFLUSH) { try { await flush(); } catch {} }
  }
}

/**
 * Compatibility wrapper used by keeper/orchestrator.
 * Accepts: object | object[] | NDJSON string | string[] and sends via current transport.
 * Returns true on success (throws on failure).
 */
export async function scribeWrite(payload) {
  const lines = toNdjsonLines(payload);
  if (lines.length === 0) return true;
   // smoke: probabilistic failure to force retries
  if (SMOKE_MODE && Math.random() < FAKE_FAIL_RATIO) {
    m_scribe_write.inc({ result: 'retry' }, 1);
    m_scribe_retry.inc({ reason: 'transport' }, 1);
    throw new Error('SMOKE_FAKE_FAIL');
  }
  // normal write
  // await transport.send(payload)
  m_scribe_write.inc({ result: 'ok' }, 1);
  await sendLines(lines);
  return true;
}

export async function scribeWriteWithRetry(payload, max = 3) {
  let attempt = 0;
  while (attempt < max) {
    try {
      return await scribeWrite(payload);
    } catch (e) {
      attempt++;
      if (attempt >= max) {
        m_scribe_write.inc({ result: 'fail' }, 1);
		try { m_scribe_write_errors_total.inc({ result: 'fail' }, 1); } catch {}
        throw e;
      }
      await new Promise(r => setTimeout(r, 10));
    }
  }
}

// Lightweight OO wrapper for callers that expect a constructor.
export class Scribe {
  constructor({ logger } = {}) {
    this.log = logger || console;
  }
  // accept object | object[] | NDJSON string | string[]
  async write(payload) { return scribeWrite(payload); }
  // accept pre-built NDJSON lines or anything coercible
  async send(lines) { return sendLines(toNdjsonLines(lines)); }
}

export default Scribe;
