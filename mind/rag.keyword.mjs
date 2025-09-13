import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const STOP = new Set(['the','a','an','of','to','in','on','and','or','for','is','it','this','that','with','as','at','be','by','are','was','were','from','but','not','you','your','i','we','our','us','me']);
const tok = (s='') => (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !STOP.has(w));

export async function makeKeywordRag({ kbDir='soul/kb', topK=3, maxChars=700 } = {}) {
  const entries = [];
  const files = (await readdir(kbDir, { withFileTypes: true }))
    .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.jsonl'))
    .map(d => join(kbDir, d.name));

  for (const f of files) {
    const raw = await readFile(f, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim(); if (!s) continue;
      try {
        const j = JSON.parse(s);
        const title = (j.title || '').toString();
        const text  = (j.text  || '').toString();
        const tokens = tok(`${title} ${text}`);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t)||0)+1);
        entries.push({ id:j.id || `${entries.length+1}`, title, text, tokens:new Set(tokens), tf });
      } catch {}
    }
  }

  const df = new Map(); for (const d of entries) for (const t of d.tokens) df.set(t, (df.get(t)||0)+1);
  const N = Math.max(1, entries.length);
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t)||0)));

  function score(query) {
    const qTokens = tok(query); if (!qTokens.length || !entries.length) return [];
    const qtf = new Map(); for (const t of qTokens) qtf.set(t, (qtf.get(t)||0)+1);
    const qW = Math.sqrt(Array.from(qtf).reduce((s,[t,c]) => s + (c*idf(t))**2, 0)) || 1;

    const results = [];
    for (const d of entries) {
      let dot = 0;
      for (const [t,qc] of qtf) { const dc = d.tf.get(t) || 0; if (dc) dot += (qc*idf(t))*(dc*idf(t)); }
      if (!dot) continue;
      const dW = Math.sqrt(Array.from(d.tf).reduce((s,[t,c]) => s + (c*idf(t))**2, 0)) || 1;
      const sim = dot/(qW*dW);
      const txt = d.text.length > maxChars ? d.text.slice(0,maxChars) + '…' : d.text;
      results.push({ sim, doc: d, title: d.title, text: txt });
    }
    results.sort((a,b) => b.sim - a.sim);
    return results.slice(0, topK).map(r => ({ title:r.title, text:r.text }));
  }

  return {
    async context(evt/*, memory */) {
      const text = (evt.text || '').trim();
      const q = text.startsWith('!ask') ? text.replace(/^!ask\s*/i,'').trim() : text;
      return score(q);
    },
    stats() { return { files: files.length, docs: entries.length }; }
  };
}
