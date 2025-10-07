// hive/scribe/index.mjs
import { makeTransport } from "./transport.mjs";
import { withRetry } from "./backoff.mjs";
import { counter, flush, setDefaultMetricTags } from "./metrics.mjs";
// Scribe = producer only. Export/roll-up handled by Sentry.
import { m_scribe_write, m_scribe_retry } from '../metrics/prom.mjs';
import os from "node:os";

const SMOKE_MODE = process.env.SMOKE === 'true';
const FAKE_FAIL_RATIO = Number(process.env.SMOKE_FAKE_FAIL_RATIO || '0'); // e.g., 0.3

const defaultTags = {
  app: process.env.APP_NAME || "charity",
  host: os.hostname(),
  build: process.env.GIT_SHA || process.env.COMMIT_SHA || "dev",
};

setDefaultMetricTags(defaultTags);

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
export async function sendLines(ndjsonLines) {
  const start = Date.now();
  const backoffOpts = {
    base: Number(process.env.SCRIBE_BACKOFF_BASE_MS || 250),
    factor: Number(process.env.SCRIBE_BACKOFF_FACTOR || 2),
    cap: Number(process.env.SCRIBE_BACKOFF_CAP_MS || 120000),
    maxRetries: Number(process.env.SCRIBE_BACKOFF_MAX_RETRIES || 8),
  };

  try {
    await withRetry(() => transport.send(ndjsonLines), backoffOpts);
    counter("scribe.sent", ndjsonLines.length, { transport: transport.name, status: "ok", ...defaultTags });
  } catch (err) {
    counter("scribe.drop", ndjsonLines.length, {
      transport: transport.name,
      status: "error",
      code: err?.code || "ERR",
      ...defaultTags,
});
    throw err;
  } finally {
    counter("scribe.ms", Date.now() - start, { transport: transport.name, ...defaultTags });
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
