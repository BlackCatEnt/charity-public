import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const KB_DIR = path.resolve('./kb');
const OUT = path.resolve('./data/kb_index.json');
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';

function walk(dir) {
  return fs.readdirSync(dir).flatMap(f => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) return walk(p);
    return [p];
  });
}

async function embed(text) {
  const body = { model: EMBED_MODEL, prompt: text };
  const { data } = await axios.post(`${OLLAMA}/api/embeddings`, body, { timeout: 60000 });
  return data.embedding;
}

function normalizeWhitespace(s) {
  return s.replace(/\r/g,'').replace(/\s+/g, ' ').trim();
}

(async () => {
  const files = walk(KB_DIR).filter(p => !p.endsWith('.csv') ? true : false); // ignore csv for now
  const docs = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    // simple chunking
    const chunks = raw.split(/\n\n+/g).map(t => normalizeWhitespace(t)).filter(Boolean);
    for (const chunk of chunks) {
      const vec = await embed(chunk);
      docs.push({ file: path.relative(KB_DIR, file), text: chunk, vec });
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ created: new Date().toISOString(), docs }, null, 2));
  console.log(`Indexed ${docs.length} chunks -> ${OUT}`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
