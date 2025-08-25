// commands/whoami.js — broadcaster-only self-check with mood meaning + identity
export function createWhoAmICommand({
  CHARITY_CFG,
  sayWithConsent,
  formatAddress,
  getSignatureForMood,
  getCurrentMood,
  isBroadcasterUser
}) {
  function describeMood(key, cfg) {
    // Allow config to override mood blurbs
    const fromCfg = cfg?.mood?.descriptions?.[key];
    if (fromCfg) return String(fromCfg);

    // Sensible defaults
    const d = {
      default:   'balanced, warm adventurer voice',
      curious:   'inquisitive and observant; asks gentle questions',
      hype:      'energetic, battle-ready; rallies the guild',
      proud:     'formal, knightly; honors accomplishments',
      supportive:'empathetic and calming; reassurance first',
      sassy:     'playful, lightly teasing but kind',
      rage:      'fiery and protective; draws a hard line'
    };
    return d[key] || d.default;
  }

  return async function handleWhoAmI(channel, tags) {
    // Broadcaster-only; silently ignore if not the Guild Master
    if (!isBroadcasterUser(tags)) return false;

    const id   = CHARITY_CFG?.identity || {};
    const name = id.name || 'Charity';
    const bio  = (id.short_bio || '').trim();
    const phys = (id.physicality || '').trim();
    const community = CHARITY_CFG?.style?.lexicon?.community_name || 'Adventuring Guild';
    const gmName    = CHARITY_CFG?.style?.lexicon?.guild_master || 'Bagotrix';

    // Compact gear detection
    const low = phys.toLowerCase();
    const gear = [];
    if (/helmet/.test(low)) gear.push('helmet');
    if (/(chest\s*plate|breastplate|chest armor|chest)/.test(low)) gear.push('chest plate');
    if (/sword/.test(low)) gear.push('sword');
    if (/shield/.test(low)) gear.push('shield');
    const gearText = gear.length ? ` Gear: ${gear.join(', ')}.` : '';

    // Who she believes she is (fallback if bio is sparse)
    const identityOneLiner =
      bio ||
      `right-hand cat to Guild Master ${gmName} and co-owner of the ${community}`;

    const moodKey = (getCurrentMood && getCurrentMood()) || 'default';
    const moodLine = `${moodKey} — ${describeMood(moodKey, CHARITY_CFG)}`;

    const prefix = formatAddress(tags);
    const sig = getSignatureForMood(moodKey);

    const line = `I am ${name}, ${identityOneLiner}.` + gearText + ` Mood: ${moodLine}.`;

    await sayWithConsent(channel, tags, `${prefix} ${line} ${sig}`);
    return true;
  };
}
