// Estimate confidence from RAG hits; decide ask/answer.
export function ragConfidence(ragCtx=[], { min=2, scoreKey='score', thresh=0.5 }={}) {
  const hits = ragCtx.filter(x => typeof x?.[scoreKey] === 'number');
  const strong = hits.filter(x => x[scoreKey] >= thresh).length;
  const cov = strong; // simple: number of strong hits
  return { cov, ok: cov >= min };
}

export function lowConfidencePrompt({ question }) {
  return `I can answer, but I'd like one quick detail to be certain: ${question}`;
}
