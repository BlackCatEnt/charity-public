// ESM, Node >= 18 (global fetch). No external deps.
import { URL } from 'node:url';

const HELP_RE = /^#\s*(HELP|TYPE)\s+([A-Za-z_:][A-Za-z0-9_:]*)\s*(.*)$/;
const SAMPLE_RE = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?Inf|NaN)(?:\s+\d+)?\s*$/;

function nowIso() { return new Date().toISOString(); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseTargets(targetsByService) {
  const out = [];
  for (const [service, urls] of Object.entries(targetsByService || {})) {
    for (const url of urls) {
      try {
        const u = new URL(url);
        const instance = `${u.hostname}${u.port ? ':' + u.port : ''}`;
        out.push({ service, url, instance });
      } catch (e) {
        console.error(JSON.stringify({ kind: 'sentry_warn', at: nowIso(), msg: 'invalid_target_url', service, url }));
      }
    }
  }
  return out;
}

function escapeLabelValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function addLabels(labelBlock, extra) {
  const extraPairs = Object.entries(extra).map(([k,v]) => `${k}="${escapeLabelValue(v)}"`);
  if (!labelBlock) return `{${extraPairs.join(',')}}`;
  const inside = labelBlock.slice(1, -1).trim();
  if (!inside) return `{${extraPairs.join(',')}}`;
  const pairs = inside.split(',').map(s => s.trim()).filter(Boolean);
  const keys = new Set(pairs.map(p => p.split('=')[0]));
  for (const [k,v] of Object.entries(extra)) {
    if (keys.has(k)) {
      for (let i=0;i<pairs.length;i++) if (pairs[i].startsWith(k+'=')) pairs[i] = `${k}="${escapeLabelValue(v)}"`;
    } else {
      pairs.push(`${k}="${escapeLabelValue(v)}"`);
    }
  }
  return `{${pairs.join(',')}}`;
}

export class MetricsAggregator {
  constructor({ targetsByService = {}, scrapeIntervalMs = 15000 } = {}) {
    this.targets = parseTargets(targetsByService);
    this.scrapeIntervalMs = scrapeIntervalMs;
    this._combinedText = `# sentry aggregator warming up\n`;
    this._timer = null;
    this._initial = false;

    // Self-metrics state
    this.scrapesTotal = 0;
    this.scrapeErrorsTotal = 0;
    this.lastMergeTs = nowSec();
    this.targetState = new Map(); // `${service}|${instance}` -> { up, lastSuccessTs, lastDurationSec }
    for (const t of this.targets) {
      this.targetState.set(`${t.service}|${t.instance}`, { up: 0, lastSuccessTs: 0, lastDurationSec: 0 });
    }
  }

  start() {
    this.scrapeOnce().catch(()=>{}).finally(() => { this._initial = true; });
    this._timer = setInterval(() => {
      this.scrapeOnce().catch(err => {
        console.error(JSON.stringify({ kind: 'sentry_error', at: nowIso(), msg: 'periodic_scrape_failed', err: String(err) }));
      });
    }, this.scrapeIntervalMs);
  }

  stop() { if (this._timer) clearInterval(this._timer); }

  async scrapeOnce() {
    this.scrapesTotal++;
    const batchStart = Date.now();

    const results = await Promise.allSettled(this.targets.map(t => this._scrapeTarget(t)));
    const good = [];
    for (let i=0;i<results.length;i++) {
      const r = results[i];
      const t = this.targets[i];
      const key = `${t.service}|${t.instance}`;
      const durSec = (Date.now() - batchStart) / 1000; // fallback if not measured per-target
      if (r.status === 'fulfilled') {
        good.push({ target: t, body: r.value.body });
        const d = r.value.durationSec ?? durSec;
        this.targetState.set(key, { up: 1, lastSuccessTs: nowSec(), lastDurationSec: d });
      } else {
        this.scrapeErrorsTotal++;
        const prev = this.targetState.get(key) || { lastSuccessTs: 0, lastDurationSec: 0 };
        this.targetState.set(key, { ...prev, up: 0 });
        console.error(JSON.stringify({ kind: 'sentry_warn', at: nowIso(), msg: 'scrape_failed', service: t.service, instance: t.instance, url: t.url, error: String(r.reason) }));
      }
    }
    this.lastMergeTs = nowSec();

    this._combinedText = this._mergeBodies(good);
    return this._combinedText;
  }

  async _scrapeTarget(t) {
    const ctl = new AbortController();
    const start = Date.now();
    const to = setTimeout(() => ctl.abort(), Math.min(this.scrapeIntervalMs - 5, 5000));
    try {
      const res = await fetch(t.url, { signal: ctl.signal, headers: { 'accept': 'text/plain' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return { body: text, durationSec: (Date.now() - start) / 1000 };
    } finally { clearTimeout(to); }
  }

  _selfMetricsText() {
    const out = [];
    out.push('# HELP sentry_scrapes_total Total scrape attempts performed by Sentry');
    out.push('# TYPE sentry_scrapes_total counter');
    out.push(`sentry_scrapes_total ${this.scrapesTotal}`);

    out.push('# HELP sentry_scrape_errors_total Total scrape errors across all targets');
    out.push('# TYPE sentry_scrape_errors_total counter');
    out.push(`sentry_scrape_errors_total ${this.scrapeErrorsTotal}`);

    out.push('# HELP sentry_last_merge_timestamp Seconds since epoch of last successful merge');
    out.push('# TYPE sentry_last_merge_timestamp gauge');
    out.push(`sentry_last_merge_timestamp ${this.lastMergeTs}`);

    out.push('# HELP sentry_target_up 1 if the last scrape for this target succeeded, else 0');
    out.push('# TYPE sentry_target_up gauge');

    out.push('# HELP sentry_scrape_last_success_timestamp Seconds since epoch of last successful scrape for this target');
    out.push('# TYPE sentry_scrape_last_success_timestamp gauge');

    out.push('# HELP sentry_scrape_duration_seconds Duration of last scrape for this target in seconds');
    out.push('# TYPE sentry_scrape_duration_seconds gauge');

    for (const t of this.targets) {
      const key = `${t.service}|${t.instance}`;
      const st = this.targetState.get(key) || { up: 0, lastSuccessTs: 0, lastDurationSec: 0 };
      const lbl = `{service="${escapeLabelValue(t.service)}",instance="${escapeLabelValue(t.instance)}"}`;
      out.push(`sentry_target_up${lbl} ${st.up}`);
      out.push(`sentry_scrape_last_success_timestamp${lbl} ${st.lastSuccessTs}`);
      out.push(`sentry_scrape_duration_seconds${lbl} ${st.lastDurationSec}`);
    }

    return out.join('\n');
  }

  _mergeBodies(items) {
    const seenHelp = new Set();
    const seenType = new Set();
    const out = [];
    out.push(`# collected_by sentry-aggregator at ${nowIso()}`);

    // 1) Self-metrics first
    out.push(this._selfMetricsText());

    // 2) Producers
    for (const { target, body } of items) {
      const lines = body.split(/\r?\n/);
      for (const line of lines) {
        if (!line || line.startsWith('#')) {
          const m = HELP_RE.exec(line);
          if (m) {
            const kind = m[1]; const name = m[2];
            if (kind === 'HELP') { if (seenHelp.has(name)) continue; seenHelp.add(name); }
            if (kind === 'TYPE') { if (seenType.has(name)) continue; seenType.add(name); }
            out.push(line);
          }
          continue;
        }
        const sm = SAMPLE_RE.exec(line);
        if (!sm) { continue; }
        const name = sm[1];
        const labels = sm[2];
        const value = sm[3];
        const withLabels = addLabels(labels, { service: target.service, instance: target.instance });
        out.push(`${name}${withLabels} ${value}`);
      }
    }
    out.push('# EOF');
    return out.join('\n') + '\n';
  }

  async ensureInitial() { while (!this._initial) { await sleep(10); } }
  getCombinedText() { return this._combinedText; }
}
