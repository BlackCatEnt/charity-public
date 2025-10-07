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

export class PromRegistry {
  constructor(){ this.items = []; }
  counter(name, help){ const c = new Counter(name, help); this.items.push(c); return c; }
  gauge(name, help){ const g = new Gauge(name, help); this.items.push(g); return g; }
  toText(){ return this.items.map(i => i.toText()).join('\n'); }
}

// Singleton (simple)
export const registry = new PromRegistry();
export const m_keeper_processed = registry.counter('keeper_processed_total','Keeper processed items');
export const m_keeper_qdepth   = registry.gauge('keeper_queue_depth','Current queue depth');
export const m_scribe_write    = registry.counter('scribe_write_total','Scribe write attempts');
export const m_scribe_retry    = registry.counter('scribe_retry_total','Scribe retries by reason');
export const m_hall_dedup_drop = registry.counter('hall_dedup_drop_total','Events dropped by hall de-dup');
