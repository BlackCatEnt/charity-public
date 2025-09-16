// A:\Charity\mind\stylepass.mjs
export function stylePass(text, persona = {}) {
  let out = (text || '').trim();
  const s = persona.style || {};
  const rewrites = s.soft_rewrites || {};

  // phrase swaps
  for (const [from, to] of Object.entries(rewrites)) {
    out = out.replace(new RegExp(`\\b${from}\\b`, 'gi'), to);
  }
  // ban certain formal phrases
  for (const ban of s.banned_phrases || []) {
    out = out.replace(new RegExp(`\\b${ban}\\b`, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
  }
  // cap exclamations
  const maxBang = Number(s.max_exclamations ?? 1);
  if (maxBang >= 0) {
    const bangs = (out.match(/!/g) || []).length;
    if (bangs > maxBang) out = out.replace(/!/g, '').trim() + '!';
  }
  // light emoji sprinkle
  const rate = s.emoji_rate ?? 0;
  if (Math.random() < rate) {
    const pool = s.emoji_palette || [];
    if (pool.length) out += ' ' + pool[Math.floor(Math.random() * pool.length)];
  }
  return out;
}
