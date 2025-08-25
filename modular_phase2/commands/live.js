// commands/live.js — concise !live / !uptime using live.getContext()

export function createLiveCommand({
  live,
  sayWithConsent,
  formatAddress,
  getSignatureForMood,
  getCurrentMood
}) {
  return async function handleLive(channel, tags) {
    const mood = (typeof getCurrentMood === 'function') ? getCurrentMood() : 'default';
    const sig  = (typeof getSignatureForMood === 'function') ? getSignatureForMood(mood) : '✧';
    const addr = (typeof formatAddress === 'function') ? formatAddress(tags) : '@' + (tags['display-name'] || tags.username || 'friend');

    const ctx = live?.getContext ? live.getContext() : { known: false };
    let line;

    if (ctx.known && ctx.isLive) {
      // live.js already composes compact lines (status + title/game/uptime)
      line = Array.isArray(ctx.lines) && ctx.lines.length ? ctx.lines.join(' — ') : 'Stream is currently LIVE.';
    } else if (ctx.known && !ctx.isLive) {
      line = 'Stream is currently OFFLINE.';
    } else {
      // unknown (e.g., Helix 5xx) — don’t claim offline
      line = 'Stream status is checking… try again in a moment.';
    }

    await sayWithConsent(channel, tags, `${addr} ${line} ${sig}`);
    return true;
  };
}
