export function sanitizeOut(text = '', { allowedEmotes = [], allowPurr = false } = {}) {
  if (!text) return text;

  // Strip stage directions like *action* or _action_
  let out = text.replace(/\*[^*]+\*/g, '').replace(/_[^_]+_/g, '');

  // Forbidden contact verbs/phrases (case-insensitive)
  const banned = [
    /hugs?/i, /cuddles?/i, /snuggles?/i, /nuzzles?/i, /rubs?\s+(against|on)/i,
    /kisses?/i, /boops?/i, /pets?/i, /scritches?/i,
    /wraps?\s+.*?\s+arms/i, /holds?\s+hands?/i, /touch(?:es|ing)?/i
  ];
  if (!allowPurr) banned.push(/purrs?/i);

  let touched = false;
  for (const r of banned) {
    if (r.test(out)) touched = true;
    out = out.replace(r, '');
  }

  // Collapse extra whitespace created by removals
  out = out.replace(/\s{2,}/g, ' ').trim();

  // If we removed something, add a gentle sign-off with an allowed emote
  if (touched) {
    const sig = allowedEmotes[1] || allowedEmotes[0] || '';
    out = out ? (sig ? `${out} ${sig}` : out) : (sig || ''); // avoid empty reply
  }

  return out;
}
