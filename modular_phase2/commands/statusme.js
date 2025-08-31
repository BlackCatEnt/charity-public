// commands/statusme.js — prints role, consent, trust, timezone, token minutes remaining
async function importTokenModuleFromHere() {
  try { return await import('../../token.js'); } catch {}
  try { return await import('../token.js'); } catch {}
  try { return await import('./token.js'); } catch {}
  return null;
}

export function createStatusmeCommand(deps) {
  const {
    CHARITY_CFG,
    tzmod,
    consent,
    sayWithConsent, formatAddress, getSignatureForMood, getCurrentMood,
    isBroadcasterUser, getRoleFromTags, isFollower,
    BROADCASTER
  } = deps;

  return async function handleStatusme(channel, tags) {
    const follower = await isFollower(tags);
    const role = getRoleFromTags(tags, follower, BROADCASTER, CHARITY_CFG?.style?.lexicon?.guild_master);
    const tz = tzmod.getUserTzFromTags(tags);
    const consentOn = consent.getConsentForUser(tags) ? 'yes' : 'no';
    const trusted = consent.isTrustedForContact(tags, isBroadcasterUser) ? 'yes' : 'no';

    let tokenMin = 'n/a';
    try {
      const tok = await importTokenModuleFromHere();
      if (tok?.loadTokenState && tok?.validateToken) {
        const st = tok.loadTokenState();
        const t = st?.access_token || (process.env.TWITCH_OAUTH || '').replace(/^oauth:/i, '');
        if (t) {
          const v = await tok.validateToken(t);
          if (v && typeof v.minutesRemaining === 'number') tokenMin = String(v.minutesRemaining);
        }
      }
    } catch {}

    const sig = getSignatureForMood(getCurrentMood());
    const addressed = formatAddress(tags);
    const line = `${addressed} status — role: ${role}; consent: ${consentOn}; trusted: ${trusted}; timezone: ${tz}; token_min_remaining: ${tokenMin} ${sig}`;
    await sayWithConsent(channel, tags, line);
    return true;
  };
}
