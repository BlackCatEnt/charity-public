// tools/embeddings-test.mjs
import * as emb from '#embeddings';

try {
  const e = await emb.createEmbedder();
  const vecs = await e.embedMany(['hello', 'world']);
  const lens = vecs.map(v => (v ? v.length : 0));
  console.log('[embed] provider:', e.name, 'dims=', e.dims, 'lens=', lens);
  if (lens.some(n => n === 0)) process.exitCode = 2;
} catch (err) {
  console.error(err);
  process.exit(1);
}
