// Ollama embeddings adapter
export async function embedTextsOllama(model, texts, { baseUrl = 'http://127.0.0.1:11434', normalize = true } = {}) {
  const url = `${baseUrl}/api/embeddings`;
  const out = [];
  for (const t of texts) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: t })
    });
    if (!res.ok) {
      throw new Error(`Ollama embeddings error: ${res.status} ${await res.text()}`);
    }
    const j = await res.json();
    let v = j.embedding;
    if (normalize) v = l2normalize(v);
    out.push(v);
  }
  return out;
}

function l2normalize(vec) {
  let s = 0.0;
  for (const x of vec) s += x * x;
  const n = Math.sqrt(s) || 1.0;
  return vec.map(x => x / n);
}
