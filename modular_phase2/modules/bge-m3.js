// modules/bge-m3.js — hybrid BGE-M3 embedder: service → local ONNX → upstream fallback
import { LRUCache } from 'lru-cache';

const BGE_HTTP = process.env.BGE_M3_HTTP || 'http://127.0.0.1:8009';
const BGE_ONNX_PATH = process.env.BGE_ONNX_PATH || 'A:\\models\\bge-m3\\bge-m3.onnx';
const BGE_TOKENIZER_JSON = process.env.BGE_TOKENIZER_JSON || 'A:\\models\\bge-m3\\tokenizer.json';
const MAX_LEN = Number(process.env.BGE_MAX_LEN || 512);
const DEBUG = process.env.BGE_DEBUG === '1';

const cache = new LRUCache({ max: 5000 });

// -------- Service path (batch) --------
async function httpEmbedMany(texts) {
  const res = await fetch(`${BGE_HTTP}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body}`);
  }
  const j = await res.json();
  if (!Array.isArray(j?.embeddings) || j.embeddings.length !== texts.length) {
    throw new Error('invalid /embed response');
  }
  return j.embeddings.map(v => Float32Array.from(v));
}

// -------- Local ONNX path (lazy init) --------
let _ort = null;
let _sess = null;
let _tok = null;

async function ensureLocalOnnx() {
  if (_sess && _tok) return true;
  try {
    // dynamic imports so this file loads even if onnxruntime-node isn’t installed
    _ort = await import('onnxruntime-node');
    const { Tokenizer } = await import('tokenizers');

    _tok = Tokenizer.fromFile(BGE_TOKENIZER_JSON);

    // Prefer CUDA if present, otherwise CPU. (DML isn’t exposed in onnxruntime-node)
    const providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'];
    _sess = await _ort.InferenceSession.create(BGE_ONNX_PATH, { executionProviders: providers });
    if (DEBUG) console.warn('[bge-m3] local ONNX ready with providers:', providers.join(','));
    return true;
  } catch (e) {
    if (DEBUG) console.warn('[bge-m3] local ONNX unavailable:', e?.message || e);
    _sess = null;
    _tok = null;
    return false;
  }
}

function padTo(arr, len, padVal = 0) {
  if (arr.length >= len) return arr.slice(0, len);
  const out = arr.slice();
  out.length = len;
  out.fill(padVal, arr.length);
  return out;
}

function encodeIdsAndMask(text) {
  const enc = _tok.encode(String(text ?? ''));
  const ids = padTo(enc.ids, MAX_LEN, 0);
  const mask = new Array(Math.min(enc.ids.length, MAX_LEN)).fill(1);
  while (mask.length < MAX_LEN) mask.push(0);
  // ONNX Runtime expects int64 → BigInt64Array
  const input_ids = BigInt64Array.from(ids.map(n => BigInt(n)));
  const attention_mask = BigInt64Array.from(mask.map(n => BigInt(n)));
  return { input_ids, attention_mask, mask_f32: Float32Array.from(mask) };
}

async function onnxEmbedMany(texts) {
  if (!await ensureLocalOnnx()) throw new Error('onnx not available');

  const results = [];
  for (const t of texts) {
    const { input_ids, attention_mask, mask_f32 } = encodeIdsAndMask(t);
    const feeds = { input_ids, attention_mask };

    // run
    const out = await _sess.run(feeds);
    // pick first output
    const firstKey = Object.keys(out)[0];
    let X = out[firstKey]; // usually Float32Array view with dims [1, seq, hidden] or [1, hidden]

    // ONNX Runtime returns a TypedArray but not shape; we infer by length.
    // Use mask to mean-pool if sequence > hidden
    let vec;
    const hiddenGuess = 1024; // bge-m3
    if (X.length > hiddenGuess) {
      // shape ~ [1, seq, hidden]; compute seq = X.length / hidden
      const seq = Math.round(X.length / hiddenGuess);
      const hidden = Math.floor(X.length / seq);
      const f = new Float32Array(hidden);
      for (let s = 0; s < Math.min(seq, MAX_LEN); s++) {
        const w = mask_f32[s];
        if (!w) continue;
        const offset = s * hidden;
        for (let h = 0; h < hidden; h++) f[h] += X[offset + h] * w;
      }
      let denom = 0;
      for (let s = 0; s < Math.min(seq, MAX_LEN); s++) denom += mask_f32[s];
      denom = denom || 1;
      for (let h = 0; h < hidden; h++) f[h] /= denom;
      vec = f;
    } else {
      // already pooled [1, hidden] → squeeze
      vec = X;
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm;

    results.push(vec);
  }
  return results;
}

// -------- Public API (hybrid) --------
export async function embed(text) {
  const s = String(text ?? '');
  const key = 'e:' + s;
  const hit = cache.get(key);
  if (hit) return hit;

  // 1) service
  try {
    const [v] = await httpEmbedMany([s]);
    cache.set(key, v);
    return v;
  } catch (e) {
    if (DEBUG) console.warn('[bge-m3] service failed:', e?.message || e);
  }

  // 2) local onnx
  try {
    const [v] = await onnxEmbedMany([s]);
    cache.set(key, v);
    return v;
  } catch (e) {
    if (DEBUG) console.warn('[bge-m3] onnx failed:', e?.message || e);
  }

  // 3) let upstream fallback (Ollama) handle it
  return null;
}

export async function embedMany(texts) {
  const src = Array.isArray(texts) ? texts.map(t => String(t ?? '')) : [String(texts ?? '')];
  const out = new Array(src.length);
  const misses = [];
  const missIdx = [];

  for (let i = 0; i < src.length; i++) {
    const k = 'e:' + src[i];
    const hit = cache.get(k);
    if (hit) out[i] = hit;
    else { misses.push(src[i]); missIdx.push(i); }
  }

  if (misses.length) {
    // 1) service
    let ok = false;
    try {
      const vecs = await httpEmbedMany(misses);
      for (let j = 0; j < vecs.length; j++) {
        const i = missIdx[j], k = 'e:' + src[i];
        cache.set(k, vecs[j]); out[i] = vecs[j];
      }
      ok = true;
    } catch (e) {
      if (DEBUG) console.warn('[bge-m3] service batch failed:', e?.message || e);
    }

    // 2) local onnx
    if (!ok) {
      try {
        const vecs = await onnxEmbedMany(misses);
        for (let j = 0; j < vecs.length; j++) {
          const i = missIdx[j], k = 'e:' + src[i];
          cache.set(k, vecs[j]); out[i] = vecs[j];
        }
        ok = true;
      } catch (e) {
        if (DEBUG) console.warn('[bge-m3] onnx batch failed:', e?.message || e);
      }
    }

    // 3) leave nulls where both failed (upstream will fallback)
    if (!ok) for (const i of missIdx) out[i] = null;
  }

  return out;
}
