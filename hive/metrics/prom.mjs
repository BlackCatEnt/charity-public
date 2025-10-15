// ESM, zero-dep Prometheus text emitter
// Producer-side Prometheus text emitter (zero-dep).
// IMPORTANT: Services (Keeper, Scribe, halls) only *emit* metrics using this.
// Sentry is responsible for roll-up and export to external systems.
const sep = (o) => Object.entries(o).sort(([a],[b]) => a.localeCompare(b))
  .map(([k,v]) => `${k}="${String(v).replace(/"/g,'\\"')}"`).join(',');

class Counter {
  constructor(name, help){ this.name = name; this.help = help; this.series = new Map(); }
  inc(labels={}, value=1){
    const key = JSON.stringify(Object.entries(labels).sort());
    this.series.set(key, (this.series.get(key)||0) + (value||0));
  }
  toText(){
    const head = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    const lines = [];
    for (const [key, val] of this.series.entries()){
      const obj = Object.fromEntries(JSON.parse(key));
      const lab = Object.keys(obj).length ? `{${sep(obj)}}` : '';
      lines.push(`${this.name}${lab} ${val}`);
    }
    return head.concat(lines).join('\n');
  }
}

class Gauge {
  constructor(name, help){ this.name = name; this.help = help; this.series = new Map(); }
  set(labels={}, value=0){
    const key = JSON.stringify(Object.entries(labels).sort());
    this.series.set(key, value||0);
  }
  toText(){
    const head = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    const lines = [];
    for (const [key, val] of this.series.entries()){
      const obj = Object.fromEntries(JSON.parse(key));
      const lab = Object.keys(obj).length ? `{${sep(obj)}}` : '';
      lines.push(`${this.name}${lab} ${val}`);
    }
    return head.concat(lines).join('\n');
  }
}
class Histogram {
  constructor(name, help, buckets = [5,10,25,50,100,250,500,1000,2500,5000]) {
    this.name = name;
    this.help = help;
    this.buckets = [...buckets].sort((a,b)=>a-b);
    // map key -> { counts: number[], sum: number, count: number }
    this.series = new Map();
  }
  observe(value, labels = {}) {
    const key = JSON.stringify(Object.entries(labels).sort());
    const s = this.series.get(key) || { counts: Array(this.buckets.length).fill(0), sum: 0, count: 0 };
    // increment highest bucket that value fits (cumulative in toText)
    for (let i=0;i<this.buckets.length;i++){
      if (value <= this.buckets[i]) { s.counts[i]++; break; }
      if (i === this.buckets.length-1) s.counts[i]++; // fallback
    }
    s.sum += value;
    s.count += 1;
    this.series.set(key, s);
  }
  toText(){
    const head = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    const lines = [];
    for (const [key, s] of this.series.entries()) {
      const obj = Object.fromEntries(JSON.parse(key));
      // cumulative counts
      let cum = 0;
      for (let i=0;i<this.buckets.length;i++){
        cum += s.counts[i];
        const lab = `{${sep({ ...obj, le: String(this.buckets[i]) })}}`;
        lines.push(`${this.name}_bucket${lab} ${cum}`);
      }
      // +Inf bucket
      const labInf = `{${sep({ ...obj, le: "+Inf" })}}`;
      lines.push(`${this.name}_bucket${labInf} ${s.count}`);
      const base = Object.keys(obj).length ? `{${sep(obj)}}` : '';
      lines.push(`${this.name}_sum${base} ${s.sum}`);
      lines.push(`${this.name}_count${base} ${s.count}`);
    }
    return head.concat(lines).join('\n');
  }
}

export class PromRegistry {
  constructor(){ this.items = []; }
  counter(name, help){ const c = new Counter(name, help); this.items.push(c); return c; }
  gauge(name, help){ const g = new Gauge(name, help); this.items.push(g); return g; }
  histogram(name, help, buckets){ const h = new Histogram(name, help, buckets); this.items.push(h); return h; }
  toText(){ return this.items.map(i => i.toText()).join('\n') + '\n'; }
}

// Singleton (simple)
export const registry = new PromRegistry();
export const m_keeper_processed = registry.counter('keeper_processed_total','Keeper processed items');
export const m_keeper_qdepth   = registry.gauge('keeper_queue_depth','Current queue depth');
export const m_scribe_write    = registry.counter('scribe_write_total','Scribe write attempts');
export const m_scribe_retry    = registry.counter('scribe_retry_total','Scribe retries by reason');
export const m_hall_dedup_drop = registry.counter('hall_dedup_drop_total','Events dropped by hall de-dup');
// --- New counters requested for prod wiring (zero-dep registry) ---
export const m_keeper_events_total   = registry.counter(
  'keeper_events_total',
  'Total number of events processed by Keeper.'
);
export const m_scribe_batches_total  = registry.counter(
  'scribe_batches_total',
  'Total number of records flushed by Scribe (sum of batch sizes).'
);
// --- New: error counters (labels are supplied at call sites) ---
export const m_keeper_errors_total = registry.counter(
  'keeper_errors_total',
  'Keeper errors by reason.'
);
export const m_scribe_write_errors_total = registry.counter(
  'scribe_write_errors_total',
  'Scribe write errors by result.'
);

// --- New: latency histograms (milliseconds) ---
export const m_keeper_event_duration_ms = registry.histogram(
  'keeper_event_duration_ms',
  'End-to-end Keeper event processing time (ms).'
);
export const m_scribe_flush_duration_ms = registry.histogram(
  'scribe_flush_duration_ms',
  'Scribe batch flush duration (ms).'
);