import fs from 'node:fs';
import path from 'node:path';
import { embedTextsOllama } from './embeddings.ollama.mjs';

const cfg = {
  kbDir: path.resolve('soul/kb'),
  indexDir: path.resolve('soul/kb/index/nomic-v1'),
  model: 'nomic-embed-text',
  baseUrl: 'http://127.0.0.1:11434',
  chunkChars: 1200,
  chunkOverlap: 200,
  normalize: true,
};

await fs.promises.mkdir(cfg.indexDir, { recursive: true });

function chunkText(s, size, overlap) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + size));
    i += size - overlap;
  }
  return out;
}

const files = fs.readdirSync(cfg.kbDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
if (!files.length) {
  console.log(`[reindex] No KB files found in ${cfg.kbDir}`);
  process.exit(0);
}

const records = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(cfg.kbDir, f), 'utf-8');
  const chunks = chunkText(text, cfg.chunkChars, cfg.chunkOverlap);
  console.log(`[reindex] ${f} -> ${chunks.length} chunks`);
  const embs = await embedTextsOllama(cfg.model, chunks, { baseUrl: cfg.baseUrl, normalize: cfg.normalize });
  for (let i = 0; i < chunks.length; i++) {
    records.push({ id: `${f}:${i}`, file: f, i, text: chunks[i], vec: embs[i] });
  }
}

const out = path.join(cfg.indexDir, 'index.jsonl');
fs.writeFileSync(out, records.map(r => JSON.stringify(r)).join('\n'));
console.log(`[reindex] Wrote ${records.length} records → ${out}`);
