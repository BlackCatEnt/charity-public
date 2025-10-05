// modules/embeddings.js
// Chooses the best available embedder at runtime.
// Order: BGE-M3 (ONNX GPU/CPU) → Ollama embeddings → hashing fallback.

export async function createEmbedder(CHARITY_CFG = {}, logger = console) {
  const prefer = String(CHARITY_CFG?.memory?.embedder || 'auto').toLowerCase(); // 'auto' | 'bge-m3' | 'ollama' | 'hash'
  const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  // Use a 1024-dim model so it matches BGE-M3’s dimensionality
  const OLLAMA_MODEL = process.env.EMBED_MODEL || CHARITY_CFG?.memory?.embed_model || 'bge-m3';

  // ---- Ollama helpers (used as fallback from the BGE branch) ----
  async function ollamaEmbedOne(text) {
    const res = await fetch(`${OLLAMA}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: String(text ?? '') })
    });
    if (!res.ok) throw new Error(`ollama embeddings failed: ${res.status}`);
    const j = await res.json();
    const arr = j?.embedding;
    return (Array.isArray(arr) && arr.length) ? Float32Array.from(arr) : null;
  }

  async function ollamaEmbedMany(texts = []) {
    const out = [];
    for (const s of texts) out.push(await ollamaEmbedOne(s));
    return out;
  }

  // --- try BGE-M3 first ---
  if (prefer === 'auto' || prefer === 'bge-m3') {
    try {
      const bge = await import('./bge-m3.js');
      if (typeof bge.embed === 'function') {
        logger.info('[embed] using bge-m3 (service/hybrid)');
        let warned = false;

        const embed = async (t) => {
          // 1) try BGE (service → local ONNX). It returns Float32Array or null.
          let v = await bge.embed(String(t ?? ''));
          if (v instanceof Float32Array && v.length) return v;
          // 2) fallback to Ollama (dimension-compatible model set above)
          try {
            v = await ollamaEmbedOne(t);
            if (v instanceof Float32Array && v.length) {
              if (!warned) { warned = true; logger.warn('[embed] BGE unavailable; using Ollama fallback'); }
              return v;
            }
          } catch {}
          // 3) last resort: empty vector so pipeline doesn’t crash
          return new Float32Array(1024);
        };

        const embedMany = async (arr = []) => {
          // Prefer BGE batch if available
          let vecs = [];
          if (typeof bge.embedMany === 'function') {
            vecs = await bge.embedMany(arr);
          } else {
            vecs = await Promise.all(arr.map(s => bge.embed(String(s ?? ''))));
          }
          // Fill any misses with Ollama
          let usedFallback = false;
          const out = new Array(arr.length);
          for (let i = 0; i < arr.length; i++) {
            let v = vecs[i];
            if (!(v instanceof Float32Array) || v.length === 0) {
              try { v = await ollamaEmbedOne(arr[i]); } catch {}
              if (!(v instanceof Float32Array) || v.length === 0) v = new Float32Array(1024);
              usedFallback = true;
            }
            out[i] = v;
          }
          if (usedFallback && !warned) { warned = true; logger.warn('[embed] BGE had misses; Ollama filled gaps'); }
          return out;
        };

        return { name: 'bge-m3', dims: 1024, embed, embedMany };
      }
    } catch (e) {
      logger.warn('[embed] bge-m3 not available: '  (e?.message || e));
    }
  }

  // --- fallback: Ollama embeddings ---
  if (prefer === 'auto' || prefer === 'ollama') {
    async function embedOllama(text) {
      const res = await fetch(`${OLLAMA}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt: String(text ?? '') })
      });
      if (!res.ok) throw new Error(`ollama embeddings failed: ${res.status}`);
      const j = await res.json();
      if (!j?.embedding) throw new Error('ollama: no "embedding" in response');
      return Float32Array.from(j.embedding);
    }

    try {
      const probe = await embedOllama('healthcheck');
      const dims = probe.length || 1024;
      logger.info(`[embed] using Ollama embeddings (${OLLAMA_MODEL}), dims=${dims}`);
      const embed = async (t) => (t ? await embedOllama(t) : new Float32Array(dims));
      const embedMany = async (arr = []) => {
        const out = [];
        for (const s of arr) out.push(await embedOllama(s));
        return out;
      };
      return { name: `ollama:${OLLAMA_MODEL}`, dims, embed, embedMany };
    } catch (e) {
      logger.warn('[embed] Ollama embeddings unavailable: ' + (e?.message || e));
    }
  }

  // --- final fallback: deterministic hashing embedder (no deps) ---
  const DIMS = 1024;
  logger.warn(`[embed] falling back to hashing embedder (dims=${DIMS})`);

  const hash = (str) => {
    // FNV-1a 32-bit
    let x = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      x ^= str.charCodeAt(i);
      x = Math.imul(x, 16777619) >>> 0;
    }
    return x >>> 0;
  };

  const embed = async (text = '') => {
    const v = new Float32Array(DIMS);
    const s = String(text);
    // char-3gram-ish hashing
    for (let i = 0; i < s.length; i++) {
      const h = hash(s.slice(Math.max(0, i - 2), i + 1));
      v[h % DIMS] += 1;
    }
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < DIMS; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIMS; i++) v[i] /= norm;
    return v;
  };

  const embedMany = async (arr = []) => Promise.all(arr.map(embed));
  return { name: 'hashing-1024', dims: DIMS, embed, embedMany };
}
