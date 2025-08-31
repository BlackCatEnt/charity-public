// modular_phase2/modules/consent.js (drop-in)
// ESM module

// very small, explicit set of contact-y phrases to sanitize unless consent is on
const CONTACT_RX =
  /\b(?:hug|hugs|cuddle|cuddles|kiss|kisses|nuzzle|nuzzles|snuggle|snuggles)\b|\*(?:hug|hugs|cuddle|cuddles|kiss|kisses|nuzzle|nuzzles|snuggle|snuggles)\*/gi;

function buildProperReplacers(cfg) {
  const pairs = cfg?.style?.lexicon?.proper_nouns || [];
  // build case-insensitive word-boundary regex replacers
  return pairs
    .map(([from, to]) => {
      if (!from || !to) return null;
      const escaped = String(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { rx: new RegExp(`\\b${escaped}\\b`, 'gi'), to: String(to) };
    })
    .filter(Boolean);
}

function normalizeProperNouns(text, replacers) {
  let out = String(text || '');
  for (const r of replacers) out = out.replace(r.rx, r.to);
  return out;
}

export function createConsent(CHARITY_CFG = {}, logger = console) {
  const replacers = buildProperReplacers(CHARITY_CFG);

  // Decide if this speaker is trusted/consented for touchy phrases
  function hasTouchConsent(tags, isBroadcasterUser) {
    try {
      // Broadcaster is always trusted
      if (typeof isBroadcasterUser === 'function' && isBroadcasterUser(tags)) return true;

      // Trusted list from config
      const trusted = (CHARITY_CFG?.style?.lexicon?.consent?.trusted || [])
        .map(s => String(s || '').toLowerCase());
      const name = String(tags?.['display-name'] || tags?.username || '').toLowerCase();
      if (name && trusted.includes(name)) return true;

      // Per-user override toggled by the !tc command (if you implement it)
      if (typeof tags?._touchConsentOn === 'boolean') return !!tags._touchConsentOn;

      // Default policy
      return CHARITY_CFG?.style?.lexicon?.consent?.default_opt_in === true;
    } catch {
      return false;
    }
  }

  function applyConsentPolicy(str) {
    // remove contact-y verbs/emotes; compress whitespace
    let cleaned = String(str || '').replace(CONTACT_RX, '').replace(/\s{2,}/g, ' ').trim();
    return cleaned;
  }

  // Main speaking adapter used by index.mod.js
  function makeSayWithConsent(client, twitchSafe, isBroadcasterUser, opts = {}) {
    const useReplies = CHARITY_CFG?.features?.use_replies === true;
    const sendReplyCore = opts.sendReplyCore; // optional function supplied by reply module

    return async function sayWithConsent(channel, tags, text, parentMsgId = null) {
      // normalize proper nouns
      let out = normalizeProperNouns(text, replacers);

      // sanitize physical-contact language unless consent true
      if (!hasTouchConsent(tags, isBroadcasterUser)) {
        out = applyConsentPolicy(out);
      }

      // prefer threaded replies if enabled and we were handed a parent
      if (useReplies && typeof sendReplyCore === 'function' && parentMsgId) {
        await sendReplyCore(channel, twitchSafe(out), parentMsgId);
      } else {
        await client.say(channel, twitchSafe(out));
      }
    };
  }

  // Optional: simple !tc handler; feel free to expand later
  function makeTouchConsentHandler({ sayWithConsent, formatAddress, getSignatureForMood, getCurrentMood }) {
    return async function handleTouchConsentCommand(channel, tags, rest = '') {
      const arg = String(rest || '').trim().toLowerCase();
      const sig = getSignatureForMood(getCurrentMood());
      if (arg === 'yes') {
        tags._touchConsentOn = true;
        return sayWithConsent(channel, tags, `${formatAddress(tags)} noted. I will allow respectful contact gestures with your consent. ${sig}`);
      }
      if (arg === 'no') {
        tags._touchConsentOn = false;
        return sayWithConsent(channel, tags, `${formatAddress(tags)} understood. I will not initiate contact and will sanitize contact gestures. ${sig}`);
      }
      const on = tags._touchConsentOn === true ? 'ON' : 'OFF';
      return sayWithConsent(channel, tags, `${formatAddress(tags)} touch consent is currently **${on}**. Use "!tc yes" to allow respectful contact gestures or "!tc no" to disable. ${sig}`);
    };
  }

  return { makeSayWithConsent, makeTouchConsentHandler };
}
