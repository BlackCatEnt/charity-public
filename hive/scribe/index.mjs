// hive/scribe/index.mjs
// v0.2 Ops Polish — Real-ish Scribe adapter with failure classification and metrics
import fs from "node:fs";
import path from "node:path";

const URL = process.env.SCRIBE_TRANSPORT_URL ?? "file://relics/.runtime/logs/events/scribe.jsonl";
const MIN_MS = parseInt(process.env.SCRIBE_BACKOFF_MIN_MS ?? "500", 10);   // 0.5s
const MAX_MS = parseInt(process.env.SCRIBE_BACKOFF_MAX_MS ?? "10000", 10); // 10s
const MAX_RETRIES = parseInt(process.env.SCRIBE_MAX_RETRIES ?? "6", 10);   // ~ up to ~10–20s worst case

const isFile = URL.startsWith("file://");
let fileStream;
if (isFile) {
  const p = URL.replace("file://", "");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fileStream = fs.createWriteStream(p, { flags: "a" });
}

function jitter(ms) {
  const spread = Math.min(ms, 250); // tighten spread for predictability
  return ms + Math.floor(Math.random() * spread);
}

import { setTimeout as delay } from 'node:timers/promises';

export async function scribeWrite(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), v: 1, ...record }) + "\n";
  if (isFile) {
    fileStream.write(line);
    return { ok: true, mode: "file" };
  }
  // http(s) mode
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: line,
      });
      if (res.ok) return { ok: true, mode: "http", status: res.status };
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === MAX_RETRIES) return { ok: false, error: String(err) };
      const base = Math.min(MAX_MS, Math.max(MIN_MS, MIN_MS * Math.pow(2, attempt)));
      await delay(jitter(base));
      attempt++;
    }
  }
}

export class Scribe {
  constructor({ logger, baseUrl='http://scribe.local/stub', simulate='auto' } = {}) {
    this.log = logger;
    this.baseUrl = baseUrl;
    this.simulate = simulate; // 'auto'|'success'|'retry'|'terminal'
    this.metrics = {
      keeper_scribe_sent: 0,
      keeper_scribe_retries: 0,
      keeper_scribe_dropped: 0,
    };
  }

  classifyError(e) {
    const code = e?.code ?? e?.status ?? e?.statusCode;
    if (code === undefined || code === null) {
      // Network-ish / unknown: assume retryable
      return { retryable: true, code: undefined };
    }
    if (code === 429) return { retryable: true, code };
    if (code >= 500) return { retryable: true, code };
    // Most 4xx are terminal
    return { retryable: false, code };
  }

  async send(record, { maxRetries=3, backoffMs=200 } = {}) {
    // HTTP stub: simulate success/failure modes without doing I/O.
    const mode = this.simulate;
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        await this.#fakeHttp(record, mode, attempt);
        this.metrics.keeper_scribe_sent++;
        this.log?.info?.('scribe.sent', { attempt });
        return true;
      } catch (e) {
        const { retryable, code } = this.classifyError(e);
        if (retryable && attempt <= maxRetries) {
          this.metrics.keeper_scribe_retries++;
          this.log?.warn?.('scribe.retry', { attempt, code, msg: e?.message });
          await delay(backoffMs * attempt);
          continue;
        }
        // terminal or out of retries
        this.metrics.keeper_scribe_dropped++;
        this.log?.error?.('scribe.drop', { attempt, code, msg: e?.message });
        return false;
      }
    }
  }

  async #fakeHttp(_record, mode, attempt) {
    // Modes:
    //  - 'success': always 200
    //  - 'retry'  : first one or two attempts -> 503, then 200
    //  - 'terminal': 400
    //  - 'auto'   : read flags from process.env or record.__force
    const flags = {
      forceRetry: process.env.SMOKE_FORCE_RETRY === '1' || _record?.__force === 'retry',
      forceTerminal: process.env.SMOKE_FORCE_TERMINAL === '1' || _record?.__force === 'terminal',
      forceSuccess: process.env.SMOKE_FORCE_SUCCESS === '1' || _record?.__force === 'success',
    };
    const effective = mode === 'auto'
      ? (flags.forceSuccess ? 'success' : (flags.forceTerminal ? 'terminal' : (flags.forceRetry ? 'retry' : 'success')))
      : mode;

    // tiny delay to mimic IO
    await delay(15);

    if (effective === 'success') return;
    if (effective === 'terminal') {
      const err = new Error('Bad Request');
      err.status = 400;
      throw err;
    }
    if (effective === 'retry') {
      if (attempt < 2) {
        const err = new Error('Service Unavailable');
        err.status = 503;
        throw err;
      }
      return; // success on retry
    }
    return;
  }
}

export default Scribe;