// hive/scribe/metrics.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

// --- config (local midnight in America/New_York by default)
const METRICS_DIR = resolvePath(process.env.SCRIBE_METRICS_DIR || "relics/.runtime/metrics");
const TZ = process.env.SCRIBE_TZ || "America/New_York";

// in-memory line buffer; flush() appends lines to today's file
const pending = [];

// public API ---------------------------------------------------------------

function recordCounter(name, value = 1, tags = {}) {
  const ev = {
    ts: new Date().toISOString(),
    counter: true,
    name,
    value,
    tags: { ...defaultMetricTags, ...tags },
  };
  pending.push(JSON.stringify(ev));
}

function recordGauge(name, value, tags = {}) {
  const ev = {
    ts: new Date().toISOString(),
    gauge: true,
    name,
    value,
    tags: { ...defaultMetricTags, ...tags },
  };
  pending.push(JSON.stringify(ev));
}

async function flushNdjson() {
  if (pending.length === 0) return;
  const file = await getTodayFilePath();
  ensureDirSync(path.dirname(file));
  const payload = pending.join("\n") + "\n";
  pending.length = 0;
  await fsp.appendFile(file, payload, "utf8");
}

let counter = recordCounter;
let gauge = recordGauge;
let flush = flushNdjson;

async function counterAndFlush(name, value = 1, tags = {}) {
  counter(name, value, tags);
  await flush();
}

// helpers -----------------------------------------------------------------

let defaultMetricTags = {};
function setDefaultMetricTags(tags) { defaultMetricTags = { ...tags }; }

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

// --- Pushgateway bridge for counters/gauges -------------------------------
const PG_URL = process.env.SCRIBE_PUSHGATEWAY_URL || null;   // e.g., http://localhost:9091
const PG_JOB = process.env.SCRIBE_PUSHGATEWAY_JOB || "keeper";
let _pushEnabled = !!PG_URL;

// Aggregate absolute samples so we can publish in Prom exposition format.
// Key = `${name}\n${sortedLabelString}`
const _ctrAgg = new Map();
const _gaugeAgg = new Map();

function labelsKey(tags) {
  const entries = Object.entries(tags || {}).sort((a,b)=>a[0].localeCompare(b[0]));
  return entries.map(([k,v])=>`${k}=${JSON.stringify(String(v))}`).join(",");
}

// keep original pending buffer/impl
// (Assumes 'pending', 'defaultMetricTags', 'getTodayFilePath', 'ensureDirSync' exist above)
const _origFlush = flush;
const _origCounter = counter;
const _origGauge = gauge;

counter = function counter(name, value = 1, tags = {}) {
  _origCounter(name, value, tags);
  if (_pushEnabled) {
    const key = `${name}\n${labelsKey({ ...defaultMetricTags, ...tags })}`;
    _ctrAgg.set(key, (_ctrAgg.get(key) || 0) + Number(value));
  }
};

gauge = function gauge(name, value, tags = {}) {
  _origGauge(name, value, tags);
  if (_pushEnabled) {
    const key = `${name}\n${labelsKey({ ...defaultMetricTags, ...tags })}`;
    _gaugeAgg.set(key, Number(value));
  }
};

async function flushPushgateway() {
  if (!_pushEnabled) return;
  let body = "";
  for (const [k, v] of _ctrAgg.entries()) {
    const [name, lbl] = k.split("\n");
    body += `${name}{${lbl}} ${v}\n`;
  }
  for (const [k, v] of _gaugeAgg.entries()) {
    const [name, lbl] = k.split("\n");
    body += `${name}{${lbl}} ${v}\n`;
  }
  if (!body) return;

  const url = new URL(`${PG_URL}/metrics/job/${encodeURIComponent(PG_JOB)}`);
  const client = url.protocol === "https:" ? https : http;

  await new Promise((resolve, reject) => {
    const req = client.request(url, { method: "PUT", timeout: 5000 }, res => {
      res.on("data", () => {});
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end(body);
  });
}

flush = async function flush() {
  await _origFlush();
  await flushPushgateway();
};

const metrics = {
  counter, gauge, flush,
  counterAndFlush,
  setDefaultMetricTags
};

export { counter, gauge, flush, counterAndFlush, setDefaultMetricTags, metrics };

export default { counter, gauge, flush, counterAndFlush, setDefaultMetricTags };
