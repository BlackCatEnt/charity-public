import { recentContribs } from './party_state.js';
import { getTopic } from './convo_state.js';

export function buildWorkingMemoryFactory({ episodic, embedder, live, logger, CHARITY_CFG }) {
  return async function buildWorkingMemory({ channel, focusText, tags }) {
    const lines = recentContribs(channel, { windowMs: 5 * 60 * 1000, max: 8 });
    const topic = getTopic(channel);
    const facts = tags ? (episodic.getFactsByTags(tags, 5) || []) : [];
    let liveCtx = null;
    try { liveCtx = await live.getContext(); } catch { /* non-fatal */ }

    return {
      focusText: String(focusText || ''),
      topic: topic?.topic || null,
      topicSticky: !!topic,
      lines,
      facts,
      liveCtx,
      embedder, // available for downstream extractors
      style: CHARITY_CFG?.style || {}
    };
  };
}
// --- compatibility helpers used by policy.js ---

/**
 * embedWorking(ctx): returns { vector, dim }
 * ctx.focusText should be the text we want embedded; falls back to ''
 */
export async function embedWorking(ctx = {}) {
  const text = (ctx.focusText ?? '').toString();
  const e = ctx.embedder;
  if (!e || typeof e.embed !== 'function') return { vector: [], dim: 0 };

  try {
    const v = await e.embed(text);
    const dim = Array.isArray(v) ? v.length : 0;
    return { vector: Array.isArray(v) ? v : [], dim };
  } catch (err) {
    ctx?.logger?.warn?.('[wm] embedWorking failed: ' + (err?.message || err));
    return { vector: [], dim: 0 };
  }
}

/**
 * rememberSmallTalk(msg, opts): extremely conservative default.
 * Return true if you want the message stored as a low-importance episode.
 */
export function rememberSmallTalk(msg = '', { userId, channel } = {}) {
  const s = String(msg || '').trim();
  if (!s) return false;
  // Ignore super-short noise; keep “small talk” that contains at least one noun-ish token.
  if (s.length < 8) return false;
  // You can beef this up later with a classifier; for now keep it on.
  return true;
}

/**
 * noteRepeater(state, msg): tiny repeater detector.
 * Returns a short annotation string when someone repeats the same command/phrase frequently.
 */
export function noteRepeater(state = {}, msg = '') {
  const key = (String(msg || '').trim().toLowerCase());
  if (!key) return null;
  state._seen = state._seen || new Map();
  const n = (state._seen.get(key) || 0) + 1;
  state._seen.set(key, n);
  if (n === 3) return 'I’m noticing you’ve asked that a few times—want me to summarize or pin it?';
  if (n > 5)   return 'Heads up: you’ve repeated that a lot; want me to remember it as a quick note?';
  return null;
}
