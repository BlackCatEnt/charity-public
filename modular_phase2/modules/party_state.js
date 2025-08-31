// Rolling, per-channel window of recent chat lines for short-term reasoning.

const _byChan = new Map(); // channel -> { lines: [], byUser: Map }

export function noteLine({ channel, login, display, text, t = Date.now() }) {
  let s = _byChan.get(channel);
  if (!s) { s = { lines: [], byUser: new Map() }; _byChan.set(channel, s); }
  const line = {
    t,
    login: (login || '').toLowerCase(),
    display: display || login || 'friend',
    text: String(text || '').slice(0, 500)
  };
  s.lines.push(line);
  if (s.lines.length > 200) s.lines.splice(0, s.lines.length - 200);
  s.byUser.set(line.login, { display: line.display, last: t });
}

export function recentContribs(channel, { windowMs = 5 * 60 * 1000, max = 8 } = {}) {
  const s = _byChan.get(channel);
  if (!s) return [];
  const cutoff = Date.now() - windowMs;
  const out = [];
  for (let i = s.lines.length - 1; i >= 0 && out.length < max; i--) {
    const L = s.lines[i];
    if (L.t < cutoff) break;
    out.unshift(L);
  }
  return out;
}

export function clearChannel(channel) { _byChan.delete(channel); }
