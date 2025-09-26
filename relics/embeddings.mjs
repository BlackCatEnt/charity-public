import 'dotenv/config';

const HOST = process.env.EMBED_HOST || 'http://127.0.0.1:8089';

// Try a few common response shapes.
function pickVectors(json){
  if (!json) return null;
  if (Array.isArray(json.vectors)) return json.vectors;
  if (Array.isArray(json.embeddings)) return json.embeddings;
  if (Array.isArray(json.data)) {
    // OpenAI-like: [{embedding:[...]}]
    const arr = json.data.map(x => x.embedding || x.vector).filter(Boolean);
    if (arr.length) return arr;
  }
  return null;
}

export async function embedBatch(texts = []) {
  if (!texts.length) return [];
  const res = await fetch(`${HOST}/embed`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ input: texts })
  }).catch(() => null);
  if (!res || !res.ok) throw new Error(`[embed] ${res?.status || 'ERR'} ${await res?.text()?.catch(()=> '') || ''}`);
  const json = await res.json().catch(()=>null);
  const vecs = pickVectors(json);
  if (!vecs || !Array.isArray(vecs[0])) throw new Error('[embed] unexpected response');
  return vecs.map(v => Float32Array.from(v));
}

export async function embedOne(text) {
  const [v] = await embedBatch([text]);
  return v || null;
}

// math helpers
export function l2norm(v){ let s=0; for(let i=0;i<v.length;i++) s+=v[i]*v[i]; return Math.sqrt(s)||1; }
export function normalize(v){ const n=l2norm(v); const out=new Float32Array(v.length); for(let i=0;i<v.length;i++) out[i]=v[i]/n; return out; }
export function cosine(a,b){ let s=0; const L=Math.min(a.length,b.length); for(let i=0;i<L;i++) s+=a[i]*b[i]; return s; } // already normalized
