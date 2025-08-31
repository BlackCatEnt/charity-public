// Lightweight per-channel conversation state with TTL-based “intent stickiness”.

const _state = new Map(); // key: channel, value: { topic, until, meta }
const DEFAULT_TTL_MS = 3 * 60 * 1000; // 3 minutes

export function setTopic(channel, topic, { ttlMs = DEFAULT_TTL_MS, meta = {} } = {}) {
  const until = Date.now() + ttlMs;
  _state.set(channel, { topic, until, meta });
}

export function getTopic(channel) {
  const s = _state.get(channel);
  if (!s) return null;
  if (Date.now() > s.until) { _state.delete(channel); return null; }
  return s; // { topic, until, meta }
}

export function clearTopic(channel) {
  _state.delete(channel);
}

// returns { topic, sticky, meta } — sticky=true if held by state
export function withTopic(channel, fallbackDetectFn) {
  const s = getTopic(channel);
  if (s) return { topic: s.topic, sticky: true, meta: s.meta };
  const t = (typeof fallbackDetectFn === 'function') ? fallbackDetectFn() : null;
  return { topic: t, sticky: false, meta: {} };
}
// --- legacy aliases for older callers ---
export const currentTopic = (channel) => {
  const s = getTopic(channel);
  return s ? s.topic : null;
};

export const latchTopic = (channel, topic, opts) => {
  return setTopic(channel, topic, opts);
};
