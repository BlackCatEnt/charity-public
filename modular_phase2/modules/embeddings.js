// modules/embeddings.js
import fs from 'fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// defer picking the ORT package until we know the EP

let Tokenizer;
try {
  ({ Tokenizer } = require('tokenizers')); // native HF tokenizers
} catch (_) {
  // If this throws later, we’ll tell the user to (re)install tokenizers prebuild.
}

export async function createEmbedder(CHARITY_CFG, logger) {
  const cfg = CHARITY_CFG?.memory || {};
  const provider = (cfg.embed_provider || process.env.EMBED_PROVIDER || 'openai').toLowerCase();

  if (provider === 'openai') return await createOpenAI(cfg, logger);
  if (provider === 'bge-m3') return await createBGE(cfg, logger);

  logger?.warn?.('[emb] Unknown provider, using noop.');
  return {
    name: 'noop',
    dim: 384,
    async embed(texts) {
      const a = Array.isArray(texts) ? texts : [texts];
      return a.map(() => new Float32Array(384));
    }
  };
}

async function createOpenAI(cfg, logger) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    logger?.warn?.('[emb] OPENAI_API_KEY missing; using noop to avoid crash.');
    return {
      name: 'openai-missing-key',
      dim: 384,
      async embed(t) { const a = Array.isArray(t) ? t : [t]; return a.map(() => new Float32Array(384)); }
    };
  }
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: key });
  const model = cfg.openai_model || 'text-embedding-3-small';
  return {
    name: 'openai',
    dim: 1536,
    async embed(texts) {
      const arr = Array.isArray(texts) ? texts : [texts];
      const res = await client.embeddings.create({ model, input: arr });
      return res.data.map(d => Float32Array.from(d.embedding));
    }
  };
}

async function createBGE(cfg, logger) {
  const onnxPath = cfg?.bge_m3?.onnx_path || process.env.BGE_M3_ONNX_PATH;
  const tokPath  = cfg?.bge_m3?.tokenizer_json_path || process.env.BGE_M3_TOKENIZER_PATH;
  const maxLen   = cfg?.bge_m3?.max_length ?? 512;

  if (!onnxPath || !tokPath) {
    logger?.warn?.('[emb] bge-m3 needs memory.bge_m3.onnx_path and tokenizer_json_path');
    return unconfiguredEmbedder();
  }
  if (!fs.existsSync(onnxPath) || !fs.existsSync(tokPath)) {
    logger?.warn?.(`[emb] bge-m3 files not found: onnx=${onnxPath} tok=${tokPath}`);
    return unconfiguredEmbedder();
  }
  if (!Tokenizer) {
    throw new Error('[emb] tokenizers native module not available; install tokenizers and tokenizers-win32-x64-msvc');
  }

  const tokenizer = await Tokenizer.fromFile(tokPath);

  // Choose the right ORT package for the requested EP
  const epReq = String(cfg?.bge_m3?.ep || process.env.ORT_EP || '').toLowerCase();
  let ort;
  try {
    if (epReq === 'dml') {
      ort = require('onnxruntime-directml');
    } else {
      ort = require('onnxruntime-node'); // CPU (and where available, CUDA custom builds)
    }
  } catch (e) {
    logger?.warn?.(`[emb] Failed to load ORT for EP "${epReq}" → ${e?.message || e}; falling back to CPU.`);
    ort = require('onnxruntime-node');
  }

  const providers =
    epReq === 'dml'  ? ['dml'] :
    epReq === 'cuda' ? ['cuda','cpu'] :
                       ['cpu'];
   logger?.info?.('[emb] ONNX EPs requested: ' + providers.join(', '));
   const session = await ort.InferenceSession.create(onnxPath, { executionProviders: providers });


  const dim = 1024; // BGE-M3 hidden size
  
function formatForBGE(text, mode = 'passage') {
  // mode: 'passage' for stored notes, 'query' for lookups
  const prefix = mode === 'query' ? 'query: ' : 'passage: ';
  // keep it simple; you can add lowercase/trim if you like
  return prefix + String(text);
}

  async function encodeBatch(texts) {
  // Some tokenizers builds return a Promise from encode(), so normalize with Promise.all
  const encs = await Promise.all(
    texts.map(t => {
      const r = tokenizer.encode(String(t));
      return (r && typeof r.then === 'function') ? r : Promise.resolve(r);
    })
  );

  // normalize arrays / typed arrays → plain arrays
  const toArr = (x) => {
    if (!x) return [];
    if (Array.isArray(x)) return x;
    if (ArrayBuffer.isView(x)) return Array.from(x);
    try { return Array.from(x); } catch { return []; }
  };

  const ids = [], masks = [];
  for (const enc of encs) {
    // Be generous across tokenizers versions
    const idsRaw  = enc?.getIds?.() ?? enc?.getIDs?.() ?? enc?.ids;
    let   maskRaw = enc?.getAttentionMask?.() ?? enc?.attentionMask;

    let arrIdsAll  = toArr(idsRaw);
    let arrMaskAll = toArr(maskRaw);

    // If mask not provided, assume ones
    if (arrMaskAll.length === 0 && arrIdsAll.length > 0) {
      arrMaskAll = new Array(arrIdsAll.length).fill(1);
    }

    if (arrIdsAll.length === 0) {
      // Last-resort visibility to help if anything’s still off
      const toks = toArr(enc?.getTokens?.() ?? []);
      throw new Error(`[emb] tokenizer Encoding missing ids/attentionMask (tokens=${toks.length})`);
    }

    const arrIds  = arrIdsAll.slice(0, maxLen);
    const arrMask = arrMaskAll.slice(0, maxLen);
    while (arrIds.length < maxLen) { arrIds.push(0); arrMask.push(0); }

    ids.push(arrIds);
    masks.push(arrMask);
  }

  const flatIds  = ids.flat().map(n => BigInt(n));
  const flatMask = masks.flat().map(n => BigInt(n));

  return {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(flatIds), [encs.length, maxLen]),
    attention_mask: new ort.Tensor('int64', BigInt64Array.from(flatMask), [encs.length, maxLen])
  };
}

  function meanPool(lastHidden, mask, B, T, H) {
    const out = new Array(B).fill(null).map(() => new Float32Array(H));
    for (let b = 0; b < B; b++) {
      let denom = 0;
      for (let t = 0; t < T; t++) {
        const m = Number(mask[b*T + t]); if (!m) continue;
        denom++;
        const base = (b*T + t) * H;
        for (let h = 0; h < H; h++) out[b][h] += lastHidden[base + h];
      }
      denom = Math.max(1, denom);
      let norm = 0;
      for (let h = 0; h < H; h++) { out[b][h] /= denom; norm += out[b][h] * out[b][h]; }
      norm = Math.sqrt(norm) || 1;
      for (let h = 0; h < H; h++) out[b][h] /= norm;
    }
    return out;
  }

  async function embedCore(texts, mode) {
    const arr = (Array.isArray(texts) ? texts : [texts]).map(t => formatForBGE(t, mode));
    const { input_ids, attention_mask } = await encodeBatch(arr);
    const output = await session.run({ input_ids, attention_mask });
    const tensor = output.sentence_embedding || output.last_hidden_state || Object.values(output)[0];
    if (!tensor || !tensor.data) throw new Error('[emb] ONNX output tensor missing');
    if (tensor.dims.length === 2) {
      const [B, H] = tensor.dims;
      const res = [];
      for (let b = 0; b < B; b++) res.push(Float32Array.from(tensor.data.slice(b*H, (b+1)*H)));
      return res;
    } else {
      const [B, T, H] = tensor.dims;
      return meanPool(tensor.data, attention_mask.data, B, T, H);
    }
  }

  return {
    name: 'bge-m3',
    dim,
    // default: passage (keeps old calls working)
    embed:       (texts) => embedCore(texts, 'passage'),
    // explicit helpers
    embedPassage:(texts) => embedCore(texts, 'passage'),
    embedQuery:  (texts) => embedCore(texts, 'query'),
  };
}

function unconfiguredEmbedder() {
  return {
    name: 'bge-m3-unconfigured',
    dim: 1024,
    async embed(t) { const a = Array.isArray(t) ? t : [t]; return a.map(() => new Float32Array(1024)); }
  };
}
