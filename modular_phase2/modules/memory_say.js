// modules/memory_say.js
export function createMemorySpeaker(opts = {}) {
  const { rng = Math.random } = opts;
  const choose = (arr) => arr[Math.floor(rng() * arr.length)];

  const toWhen = (ts) => {
    const d = (Date.now() - ts) / 86400000;
    if (d < 1/24) return 'just now';
    if (d < 1)    return 'earlier today';
    if (d < 7)    return 'this week';
    if (d < 14)   return 'last week';
    return 'a while back';
  };

  const greets = ['Hey','Good to see you','Welcome back','Yo','Hi','Hey there'];
  const follow = [
    'still into {topic}?',
    'how’s {topic} going?',
    'been jamming any {topic} lately?',
    'what’s new with {topic}?',
    'did {topic} pan out?'
  ];
  const discovery = [
    'what are you into lately—games, music, builds?',
    'tell me one comfort game or genre you keep coming back to.',
    'what brought you in today—tips, chill vibes, or just lurking?',
    'hit me with one current obsession.'
  ];

  function extractTopic(text) {
    const cleaned = (text || '').replace(/https?:\/\/\S+/g, ' ').toLowerCase();
    const bits = cleaned.split(/[^a-z0-9+]+/g).filter(w => w && w.length > 2);
    const idx = Math.max(
      cleaned.indexOf('love '),
      cleaned.indexOf('like '),
      cleaned.indexOf('playing '),
      cleaned.indexOf('building '),
      cleaned.indexOf('working on ')
    );
    if (idx >= 0) {
      const chunk = cleaned.slice(idx).split(/[.!?]/)[0];
      return chunk.replace(/\b(i|im|i'm|like|love|playing|building|working|on|the|a|an|and|to|for)\b/g,'').trim();
    }
    return bits.slice(0, 3).join(' ');
  }

  // Small scoring helpers for the chooser
  const DAY = 86400000;
  const scoreFact = (f) => {
    const ageDays = Math.max(0, (Date.now() - (f.last_seen || f.ts || f.first_seen || 0)) / DAY);
    const recency  = Math.max(0.35, 1 - (ageDays / 60)); // soft decay over 60d
    const conf     = Math.max(0.4, Number(f.confidence || f.score || 0.6));
    const lock     = f.locked ? 0.10 : 0.00;
    const repeat   = Math.min(0.10, Number(f.count || 0) * 0.02);
    return recency * conf + lock + repeat; // 0..~1.2
  };
  const scoreEpisode = (ep) => {
    const ageDays = Math.max(0, (Date.now() - (ep.ts || 0)) / DAY);
    const recency = Math.max(0.40, 1 - (ageDays / 30)); // tighter window for episodes
    const sim     = Number(ep.score || 0.5);
    const imp     = Math.min(1, Number(ep.importance || 1));
    return sim * 0.7 + recency * 0.2 + imp * 0.1; // 0..1+
  };

  return {
    // confidence: 0..1 (sim × recency)
    lineFor({ display, episode, confidence, minConfidence = 0.6, repeatSupport = 1, includeName = true }) {
      const name = display || 'friend';

      // gate low-confidence / not-enough-support cases
      if (!(confidence >= minConfidence && repeatSupport >= 2) || !episode) {
        return includeName
          ? `${choose(greets)} ${name}, ${choose(discovery)}`
          : `${choose(greets)} — ${choose(discovery)}`;
      }

      const topic = extractTopic(episode.text) || 'that';
      const when  = toWhen(episode.ts);
      const g = choose(greets);
      const f = choose(follow).replace('{topic}', topic);
      return includeName
        ? `${g} ${name}—${when} you mentioned ${topic}; ${f}`
        : `${g} — ${when} you mentioned ${topic}; ${f}`;
    },

    // Decide whether to echo a recent episode or recall a strong profile fact
    chooseReplyPath({ facts = [], episodes = [], minConf = 0.6 } = {}) {
      const bestFact = facts.slice().sort((a,b) => scoreFact(b) - scoreFact(a))[0];
      const fScore   = bestFact ? scoreFact(bestFact) : 0;

      const bestEp   = episodes.slice().sort((a,b) => scoreEpisode(b) - scoreEpisode(a))[0];
      const eScore   = bestEp ? scoreEpisode(bestEp) : 0;

      // Prefer the clearly better one; otherwise prefer episode if comparable (feels “current”)
      if (fScore >= Math.max(minConf, eScore + 0.05)) return { kind: 'recall',  fact: bestFact, score: fScore };
      if (eScore >= minConf)                             return { kind: 'episode', ep: bestEp,   score: eScore };
      if (fScore >= minConf * 0.9)                       return { kind: 'recall',  fact: bestFact, score: fScore };
      return { kind: 'none' };
    }
  };
}
