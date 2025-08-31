// modules/style.js
const PLATFORM_CFG = {
  twitch:  { maxLines: 2, maxChars: 280, emoteBudget: 2 },
  discord: { maxLines: 4, maxChars: 800, emoteBudget: 3 },
  youtube: { maxLines: 3, maxChars: 300, emoteBudget: 2 },
};
const BASE_EMOTES = [ 'Kappa', 'PogChamp', 'LUL', 'FeelsStrongMan', 'FeelsWowMan' ];

function trimLines(s, maxLines) {
  const lines = s.split(/\r?\n/).slice(0, maxLines);
  return lines.join(' ');
}
function clampChars(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
function pickEmotes(text, budget, platform='twitch') {
  if (budget <= 0) return '';
  // lightweight heuristic: excitement → PogChamp, humor → LUL, default → Kappa
  const lower = text.toLowerCase();
  const chosen = [];
  if (lower.includes('amazing') || lower.includes('hype')) chosen.push('PogChamp');
  else if (lower.includes('lol') || lower.includes('funny')) chosen.push('LUL');
  if (chosen.length === 0) chosen.push('Kappa');
  return chosen.slice(0, budget).join(' ');
}

export function formatReply({ text, platform='twitch', useEmotes=true }) {
  const cfg = PLATFORM_CFG[platform] || PLATFORM_CFG.twitch;
  let out = trimLines(text.trim(), cfg.maxLines);
  out = clampChars(out, cfg.maxChars);
  if (useEmotes) {
    const em = pickEmotes(out, cfg.emoteBudget, platform);
    if (em) out = `${out} ${em}`;
  }
  return out;
}

// Slightly different “utility” voice: concise + authoritative
export function formatUtility({ fact, tag='', platform='twitch' }) {
  const cfg = PLATFORM_CFG[platform] || PLATFORM_CFG.twitch;
  let out = `Today: ${fact}.`;      // authoritative lead
  if (tag) out += ` ${tag}`;        // e.g., "(I might be off; want me to check?)"
  return clampChars(out, cfg.maxChars);
}
