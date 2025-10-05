import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import axios from 'axios';

export function createKB(logger, OLLAMA, EMBED_MODEL = (process.env.EMBED_MODEL || 'bge-m3')) {
  let KB = { docs: [] };
  const KB_PATH = path.resolve('./data/kb_index.json');

  function load() {
    try {
      KB = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
      logger?.info?.(`KB loaded: ${KB.docs.length} chunks`);
    } catch (e) {
      logger?.warn?.('KB not indexed or invalid JSON. Run: npm run index-kb; error: ' + (e?.message || e));
      KB = { docs: [] };
    }
  }
  load();

  chokidar.watch(KB_PATH).on('change', () => {
    logger?.info?.('KB index changed; reloading...');
    load();
  });

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-8);
  }

  async function embed(text) {
    const { data } = await axios.post(`${OLLAMA}/api/embeddings`, { model: EMBED_MODEL, prompt: text });
    return data.embedding;
  }

  async function retrieve(query, k = 3) {
    if (!KB.docs?.length) return [];
    const filtered = KB.docs.filter(d => Array.isArray(d.vec) && d.vec.length);
    if (!filtered.length) return [];
    const qvec = await embed(query);
    const scored = filtered.map(d => ({ ...d, score: cosine(qvec, d.vec) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  return { load, retrieve };
}
