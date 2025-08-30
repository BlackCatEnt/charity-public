// tools/reindex_kb.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createEmbedder } from '#embeddings';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const ROOT = process.cwd();
const ARGV = process.argv.slice(2);
const CFG_ARG = ARGV.find(a => a.startsWith('--cfg='))?.slice(6);
const CFG_PATH = path.resolve(ROOT, CFG_ARG || 'config/charity-config.json');
const OUT_PATH = path.resolve(ROOT, 'data', 'kb_index.json');

// Simple recursive file gatherer for .md/.txt
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (/\.(md|txt)$/i.test(entry.name)) yield p;
  }
}

function chunkText(text, maxLen = 900) {
  const paras = text.split(/\n\s*\n/g);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > maxLen) { if (cur) out.push(cur.trim()); cur = p; }
    else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) out.push(cur.trim());
  return out.filter(Boolean);
}

async function main() {
  // inputs: folders/files from argv (minus flags), else default to ./docs
  const inputs = ARGV.filter(a => !a.startsWith('--'));
  const targets = inputs.length ? inputs : [path.resolve(ROOT, 'docs')];

  // Load config → create current embedder (uses memory.bge_m3.* / openai_model)
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf-8'));
  } catch (e) {
    console.warn(`[kb] Warning: failed to parse ${CFG_PATH} (${e.message}). Falling back to environment variables.`);
    // Build a minimal in-memory config from env so we can proceed without a file
    cfg = {
      memory: {
        embed_provider: process.env.EMBED_PROVIDER || 'bge-m3',
        openai_model: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
        bge_m3: {
          onnx_path: process.env.BGE_M3_ONNX_PATH,
          tokenizer_json_path: process.env.BGE_M3_TOKENIZER_PATH,
          ep: process.env.ORT_EP || 'cpu',
          max_length: Number(process.env.BGE_M3_MAX_LENGTH || 512)
        }
      }
    };
  }
   const logger = { info: console.log, warn: console.warn };
   const emb = await createEmbedder(cfg, logger);

  const docs = [];
  for (const t of targets) {
    if (!fs.existsSync(t)) continue;
    const files = fs.statSync(t).isDirectory() ? Array.from(walk(t)) : [t];
    for (const f of files) {
      const raw = fs.readFileSync(f, 'utf-8');
      const chunks = chunkText(raw);
      if (!chunks.length) continue;

      // Embed chunks in modest batches
      for (let i = 0; i < chunks.length; i += 8) {
        const batch = chunks.slice(i, i + 8);
        const vecs = await (emb.embedPassage ? emb.embedPassage(batch) : emb.embed(batch));
        for (let j = 0; j < batch.length; j++) {
          docs.push({ file: path.relative(ROOT, f), text: batch[j], vec: Array.from(vecs[j]) });
        }
      }
      console.log(`[kb] indexed ${path.relative(ROOT, f)} (${chunks.length} chunks)`);
    }
  }

  // Write output
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const payload = { docs };
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`[kb] wrote ${docs.length} chunks → ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
