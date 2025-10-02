// hive/scribe/metrics.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// --- config (local midnight in America/New_York by default)
const METRICS_DIR = resolvePath(process.env.SCRIBE_METRICS_DIR || "relics/.runtime/metrics");
const TZ = process.env.SCRIBE_TZ || "America/New_York";

// in-memory line buffer; flush() appends lines to today's file
const pending = [];

// public API ---------------------------------------------------------------

/**
 * Record a counter event that will be written as NDJSON on flush().
 * @param {string} name
 * @param {number} [value=1]
 * @param {Record<string,string|number|boolean>} [tags={}]
 */
export function counter(name, value = 1, tags = {}) {
  const ev = {
    ts: new Date().toISOString(),
    counter: true,
    name,
    value,
    tags: { ...defaultMetricTags, ...tags },
  };
  pending.push(JSON.stringify(ev));
}

/**
 * Append all pending lines to today's metrics NDJSON file.
 * Rotates daily by local (configurable) timezone.
 */
export async function flush() {
  if (pending.length === 0) return;
  const file = await getTodayFilePath();
  ensureDirSync(path.dirname(file));
  const payload = pending.join("\n") + "\n";
  pending.length = 0;
  await fsp.appendFile(file, payload, "utf8");
}

// (optional) convenience: flush immediately after writing one event
export async function counterAndFlush(name, value = 1, tags = {}) {
  counter(name, value, tags);
  await flush();
}

// helpers -----------------------------------------------------------------

let defaultMetricTags = {};
export function setDefaultMetricTags(tags) { defaultMetricTags = { ...tags }; }

function resolvePath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let _lastDayKey = null;
let _todayFile = null;

async function getTodayFilePath() {
  const dayKey = yyyymmdd(new Date(), TZ); // e.g., 2025-09-30
  if (dayKey !== _lastDayKey || !_todayFile) {
    _lastDayKey = dayKey;
    _todayFile = path.join(METRICS_DIR, `${dayKey}.ndjson`);
  }
  return _todayFile;
}

function yyyymmdd(d, timeZone) {
  // en-CA yields YYYY-MM-DD; keep it locale-safe and zero-padded
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // "YYYY-MM-DD"
}

// default export (optional)
export default { counter, flush, counterAndFlush };
