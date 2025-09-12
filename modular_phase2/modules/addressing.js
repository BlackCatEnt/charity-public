// Deterministic addressing + reply cleanup + name/intent helpers

// Format a mention for a user/tags consistently, e.g. "@DisplayName"
export function formatAddress(tagsOrName) {
  if (!tagsOrName) return '@friend';
  if (typeof tagsOrName === 'string') {
    const s = tagsOrName.trim().replace(/\s+/g, ' ');
    return s.startsWith('@') ? s : `@${s}`;
  }
  const disp = tagsOrName['display-name'] || tagsOrName.username || 'friend';
  return '@' + String(disp).trim().replace(/\s+/g, ' ');
}

// Alias for compatibility with older imports
export const canonicalAddress = formatAddress;

// Choose the addressee we’ll speak to (based on author identity)
export function pickAddressee({ authorLogin, authorDisplay }) {
  const disp = authorDisplay || authorLogin || 'friend';
  return '@' + String(disp).trim().replace(/\s+/g, ' ');
}

// Ensure we don't accidentally keep foreign @mentions in the reply
export function sanitizeReplyAddressing(reply, addressee) {
  const safe = String(reply || '');
  if (!safe) return safe;
  const keep = String(addressee || '').toLowerCase();
  return safe
    .replace(/@\w[\w_]+/g, m => (m.toLowerCase() === keep ? m : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// --- mention detection helpers used by policy/reasoner ---

const BOT_LOGIN = (process.env.BOT_USERNAME || 'charity_the_adventurer').toLowerCase();

// True if the text is referring to OUR bot (by @login or by canonical name)
export function isSelfMention(text) {
  const t = String(text || '');
  if (!t) return false;
  const loginRe = new RegExp(`@?${BOT_LOGIN.replace(/_/g, '[ _]?')}\\b`, 'i');
  if (loginRe.test(t)) return true;
  // also accept "Charity the Adventurer" (brand name)
  if (/\bcharity(?:\s+the\s+adventurer)?\b/i.test(t) && /the\s+adventurer/i.test(t)) return true;
  return false;
}

// Heuristic: someone is talking about "charity" the concept (donations, nonprofits), not the bot.
export function isGenericCharity(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/\bcharity the adventurer\b/i.test(t)) return false; // that’s us
  if (isSelfMention(t)) return false; // explicit @ mention or brand name
  const hasCharityWord = /\bcharity|charities|charitable\b/i.test(t);
  const philanthropyCtx = /\b(donate|donation|nonprofit|fundraiser|fund|foundation|benefit|501c3|drive)\b/i.test(t);
  return hasCharityWord && philanthropyCtx;
}
