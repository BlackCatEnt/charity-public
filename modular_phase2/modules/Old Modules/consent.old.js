import fs from 'fs';
import path from 'path';

export function createConsent(CHARITY_CFG, logger) {
  const CONSENT_PATH = path.resolve('./data/touch_consent.json');
  let TOUCH_CONSENT = { users: {} };

  function load() {
    try {
      TOUCH_CONSENT = JSON.parse(fs.readFileSync(CONSENT_PATH, 'utf8'));
      if (!TOUCH_CONSENT.users) TOUCH_CONSENT.users = {};
    } catch { TOUCH_CONSENT = { users: {} }; }
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(CONSENT_PATH), { recursive: true });
      fs.writeFileSync(CONSENT_PATH, JSON.stringify(TOUCH_CONSENT, null, 2), 'utf8');
    } catch (e) {
      logger?.warn?.('Failed saving touch_consent.json: ' + (e?.message || e));
    }
  }
  load();

  const TRUSTED_CONTACTS = new Set(
    (CHARITY_CFG?.style?.lexicon?.trusted_contact_users || []).map(s => String(s || '').toLowerCase())
  );

  function getConsentForUser(tags) {
    const uid = tags?.['user-id'];
    if (!uid) return false;
    return TOUCH_CONSENT.users[uid] === true;
  }

  function isTrustedForContact(tags, isBroadcasterUser) {
    const name = (tags?.['display-name'] || tags?.username || '').toLowerCase();
    return Boolean(isBroadcasterUser?.(tags) || TRUSTED_CONTACTS.has(name) || getConsentForUser(tags));
  }

 // Basic contact-gesture scrubbing. We only remove if the user has NOT given consent
  // (mods/broadcaster or users in trusted list are treated as consenting).
  const CONTACT_RX =
    /(\*+)?\s*(?:hugs?|snuggles?|cuddles?|head\s*pats?|pats?|boops?|kisses?)\s*(\*+)?/gi;

  // Proper nouns / house style — enforce canonical wording
  function normalizeHouseStyle(str) {
    let s = String(str ?? '');

    // Canonical names from config if present
    const lex = CHARITY_CFG?.style?.lexicon || {};
    const guildName = lex.community_name || 'Adventuring Guild';
    const charFull  = lex.character_full || 'Charity the Adventurer';

    // Common slips → canonical
    s = s.replace(/\badventurous guild\b/gi, guildName);
    s = s.replace(/\badventuring guild\b/gi, guildName);       // proper case
    s = s.replace(/\bguild master\b/gi, 'Guild Master');
    s = s.replace(/\bcharity the adventurer\b/gi, charFull);

    // Optional: extra terms from config (if you later add a glossary)
    const extra = lex.proper_nouns || []; // e.g., [{from:/\bmy guild\b/gi, to:"Adventuring Guild"}]
    for (const it of extra) {
      try {
        if (it && it.from && it.to) s = s.replace(it.from, it.to);
      } catch {}
    }
    return s;
  }

  // Scrub contact unless trusted, collapse spaces, apply house style
  function applyConsentPolicy(str, tags, isBroadcasterUser) {
    let cleaned = String(str ?? '');

    const trusted = isTrustedForContact(tags, isBroadcasterUser);
    if (!trusted) cleaned = cleaned.replace(CONTACT_RX, '');

    cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
    cleaned = normalizeHouseStyle(cleaned);
    return cleaned;
  }

  // Accept both (channel, text) and (channel, tags, text)
  function makeSayWithConsent(client, twitchSafe, isBroadcasterUser, opts = {}) {
    return function sayWithConsent(channel, a, b, limit = 480) {
      let tags, msg;
      if (typeof a === 'string' && b === undefined) {
        // old 2-arg style: (channel, text)
        tags = undefined; msg = a;
      } else {
        // new 3-arg style: (channel, tags, text)
        tags = a; msg = b;
      }
      const safe = applyConsentPolicy(msg, tags, isBroadcasterUser);
      return client.say(channel, twitchSafe(safe, limit));
    };
  }

  function makeTouchConsentHandler({ sayWithConsent, formatAddress, getSignatureForMood, getCurrentMood }) {
    return async function handleTouchConsentCommand(channel, tags, args) {
      const uid = tags?.['user-id'];
      if (!uid) return;
      const val = (args || '').trim().toLowerCase();
      if (!val) {
        const on = getConsentForUser(tags) ? 'yes' : 'no';
        return sayWithConsent(channel, tags, `${formatAddress(tags)} touch consent is currently **${on}**. Use "!tc yes" to allow respectful contact gestures or "!tc no" to disable. ${getSignatureForMood(getCurrentMood())}`);
      }
      if (val === 'yes' || val === 'y') {
        TOUCH_CONSENT.users[uid] = true; save();
        return sayWithConsent(channel, tags, `${formatAddress(tags)} noted. I will allow respectful contact gestures with your consent. ${getSignatureForMood(getCurrentMood())}`);
      }
      if (val === 'no' || val === 'n') {
        TOUCH_CONSENT.users[uid] = false; save();
        return sayWithConsent(channel, tags, `${formatAddress(tags)} understood. I will not initiate contact and will sanitize contact gestures. ${getSignatureForMood(getCurrentMood())}`);
      }
      return sayWithConsent(channel, tags, `${formatAddress(tags)} usage: !tc yes | !tc no | !tc (to view). ${getSignatureForMood(getCurrentMood())}`);
    };
  }

  return { load, save, getConsentForUser, isTrustedForContact, applyConsentPolicy, makeSayWithConsent, makeTouchConsentHandler };
}
