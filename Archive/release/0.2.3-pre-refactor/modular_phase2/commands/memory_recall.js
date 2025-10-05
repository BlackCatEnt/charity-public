// commands/memory_recall.js
export function createRecallCommand({ episodic, embedder, sayWithConsent, formatAddress }) {
  // Usage:
  //  !recall          → last 3 of self (semantic if vectors exist; else recent)
  //  !recall 5        → last 5 of self
  //  !recall @user 5  → last 5 of @user (mods/broadcaster only)

  const isModOrBroad = (tags) =>
    tags?.badges?.broadcaster === '1' ||
    tags?.mod === true || tags?.badges?.moderator === '1';

  return async function handleRecall(channel, tags, raw='') {
    const parts = (raw || '').trim().split(/\s+/).filter(Boolean);
    let targetTags = tags;
    let limit = 3;

    if (parts[0]?.startsWith('@')) {
      if (!isModOrBroad(tags)) {
        return sayWithConsent(channel, tags, `${formatAddress(tags)} Only mods or the Guild Master can recall others’ history.`);
      }
      targetTags = { username: parts.shift().slice(1).toLowerCase() }; // minimal key for episodic
    }
    if (parts[0] && /^\d+$/.test(parts[0])) {
      limit = Math.max(1, Math.min(10, parseInt(parts[0], 10)));
    }

    // Prefer semantic recall if vectors exist & embedder is available
    let hits = [];
    try {
      const res = await episodic.searchUserEpisodes({ tags: targetTags, embedder, query: '', limit });
      hits = Array.isArray(res?.hits) && res.hits.length ? res.hits : [];
    } catch { /* fall back below */ }

    // Fallback: if no vectors yet, just lean on profile+ingest recency via facts
    if (!hits.length) {
      const facts = episodic.getFactsByTags(targetTags, limit);
      if (facts.length) {
        const lines = facts
          .map(f => `• ${f.k.replace(/_/g,' ')}: ${f.v}`)
          .join('\n');
        return sayWithConsent(channel, tags, `${formatAddress(tags)} Recent profile notes:\n${lines}`);
      }
      return sayWithConsent(channel, tags, `${formatAddress(tags)} I don’t have recent notes yet.`);
    }

    const lines = hits
      .sort((a,b) => (b.ts||0)-(a.ts||0))
      .slice(0, limit)
      .map(ep => {
        const d = new Date(ep.ts);
        const at = d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        return `• ${at} — ${ep.text}`;
      });

    return sayWithConsent(channel, tags, `${formatAddress(tags)} Recent notes:\n${lines.join('\n')}`);
  };
}
