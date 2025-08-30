// modules/announce.js — Startup greeting (stable, no physicality by default)
export function createAnnouncer(CHARITY_CFG, logger) {
  const once = { sent: false };
  const pick = (arr, fallback='Hello') =>
    (Array.isArray(arr) && arr.length) ? arr[Math.floor(Math.random() * arr.length)] : fallback;

  function buildLine({ isLive }) {
  const lex = CHARITY_CFG?.style?.lexicon || {};
  const greet = pick(lex.greeting_variants, 'Greetings');
  const audience = pick(lex.audience_nickname_alt, lex.community_name || 'Adventuring Guild');
  const cta = pick(lex.call_to_action, 'try !ask');
  const sig = (lex.signature_by_mood?.default) || lex.signature || '✧';

  if (isLive) {
    return `${greet}, ${audience}! Charity reporting—ask me anything with !ask, or check your time with !mytime. ${sig}`;
  }
  return `${greet}, ${audience}! Charity on duty. The Guild Hall is quiet for now—feel free to chat or ${cta}. ${sig}`;
}


  async function maybeAnnounce({ sayWithConsent, channel, isLive }) {
    const enabled = CHARITY_CFG?.features?.startup_greeting_enabled;
    if (enabled === false) return;
    if (once.sent) return;
    once.sent = true;

    try {
      // IMPORTANT: order = (channel, text [, tags])
      await sayWithConsent(channel, buildLine({ isLive }));
    } catch (e) {
      logger?.warn?.('[announce] failed to send greeting: ' + (e?.message || e));
    }
  }

  return { maybeAnnounce };
}
