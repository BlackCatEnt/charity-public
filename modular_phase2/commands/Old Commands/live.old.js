// commands/live.js — shows current live status: title/game/uptime
export function createLiveCommand(deps) {
  const { live, sayWithConsent, formatAddress, getSignatureForMood, getCurrentMood } = deps;

  return async function handleLive(channel, tags) {
    const ctx = live.getContext();
    const sig = getSignatureForMood(getCurrentMood());
    const prefix = formatAddress(tags);
    if (ctx.isLive) {
      const up = typeof ctx.uptimeHhMm === 'function' ? ctx.uptimeHhMm() : '';
      const first = ctx.lines[0] || 'LIVE';
      const line = `${prefix} ${first}${up ? '' : ''} ${sig}`;
      await sayWithConsent(channel, tags, line);
    } else {
      const first = ctx.lines[0] || 'OFFLINE';
      await sayWithConsent(channel, tags, `${prefix} ${first} ${sig}`);
    }
    return true;
  };
}
