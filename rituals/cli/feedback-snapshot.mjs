import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function parseArgs() {
  const a = new Map(process.argv.slice(2).flatMap(arg => {
    const m = arg.match(/^--([^=]+)=(.*)$/); return m ? [[m[1], m[2]]] : [];
  }));
  return {
    window: a.get('window') || '7d',       // 7d, 14d
    out: a.get('out') || `heart/overlays/${new Date().toISOString().slice(0,10)}_auto-overlay.json`
  };
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate()-n); return d; }
function parseWin(w) { const m = w.match(/^(\d+)d$/i); return m ? Number(m[1]) : 7; }

async function loadFeedback(dir='rituals/feedback') {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const f = join(dir, d.name, 'feedback.jsonl');
    const raw = await readFile(f, 'utf8').catch(() => '');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim(); if (!s) continue;
      try { out.push(JSON.parse(s)); } catch {}
    }
  }
  return out;
}

function aggregate(feedback, since) {
  const rows = feedback.filter(r => {
    const t = Date.parse(r.ts); return Number.isFinite(t) && t >= +since;
  });
  const tags = new Map(); let pos=0, neg=0, neu=0;
  for (const r of rows) {
    if (r.rating > 0) pos++;
    else if (r.rating < 0) neg++;
    else neu++;
    for (const t of (r.tags || [])) tags.set(t, (tags.get(t)||0)+1);
  }
  return { rows, pos, neg, neu, tags };
}

function deriveOverlay(agg) {
  const get = (k) => agg.tags.get(k) || 0;
  // heuristics
  const humorBias = get('+humor') - get('-humor');
  const verboseBias = get('+verbose') - get('-verbose');
  const warmthBias = get('+warm') - get('-warm');

  const style = {};
  if (humorBias > 0) style.wit = 'playful, quick quips, keep clarity';
  if (humorBias < 0) style.wit = 'straightforward, minimal quips';
  if (verboseBias > 0) style.verbosity = 'expand a bit more by default';
  if (verboseBias < 0) style.verbosity = 'default to concise';
  if (warmthBias > 0) style.tone = 'extra warm and encouraging';

  const templates = {};
  if (get('+ack')) templates.ack = ['Got it. ✧', 'Understood, Guild Master.'];
  if (get('+quip')) templates.quip_pool = ['Logged in the Codex.', 'Moonpetal tea incoming.'];

  return {
    id: `auto-overlay-${new Date().toISOString().slice(0,10)}`,
    priority: 40,
    style,
    templates,
    provenance: {
      window_days: undefined,
      totals: { positive: agg.pos, negative: agg.neg, neutral: agg.neu },
      top_tags: Array.from(agg.tags.entries()).sort((a,b)=>b[1]-a[1]).slice(0,12)
    }
  };
}

async function main() {
  const args = parseArgs();
  const days = parseWin(args.window);
  const since = daysAgo(days);

  const fb = await loadFeedback();
  const agg = aggregate(fb, since);
  const overlay = deriveOverlay(agg);
  overlay.provenance.window_days = days;

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(overlay, null, 2), 'utf8');

  console.log(`✅ Snapshot complete (${days}d): ${agg.pos} 👍 / ${agg.neg} 👎 / ${agg.neu} · tags=${agg.tags.size}`);
  console.log(`→ Overlay written: ${args.out}`);
  if (overlay.provenance.top_tags.length) {
    console.log('Top tags:', overlay.provenance.top_tags.map(([k,v]) => `${k}:${v}`).join(', '));
  }
}
main().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
