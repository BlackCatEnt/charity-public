import cfg from '#codex/moderation.config.json' assert { type:'json' };
import { lookupGame, spoilerLexiconFor } from '#soul/games/index.mjs';

const RE_LINK  = /\bhttps?:\/\/\S+/i;
const RE_SPAM  = /(.)\1{5,}|([^\s])(?:\s*\2){8,}/;          // long repeats
const RE_ALLCAPS = /^[^a-z]{24,}$/;
const SLURS = [/fag|retard|coon|slut|whore|kys|rape/i];      // expand privately

export async function evaluateMessage(evt, text) {
  if (!cfg.enabled) return { ok:true };
  const t = (text||'').trim();
  if (!t) return { ok:true };

  // spoilers
  const gTitle = cfg?.spoilers?.active_game?.trim();
  if (gTitle) {
    const game = await lookupGame(gTitle); // {title, aliases, characters?, spoilers?}
    const lex  = new Set([
      ...(cfg.spoilers.keywords || []),
      ...spoilerLexiconFor(game)
    ].map(s => s.toLowerCase()));
    const lower = t.toLowerCase();
    let hits = 0;
    for (const k of lex) if (k && lower.includes(k)) hits++;
    const severity = hits >= 2 ? 3 : (hits === 1 ? 2 : 0);
    if (severity && cfg.spoilers.strict) {
      return { ok:false, type:'spoiler', severity, reason:`Possible spoilers about ${game?.title||gTitle}`, hits };
    }
  }

  // slurs
  if (SLURS.some(r => r.test(t))) return { ok:false, type:'slur', severity:3, reason:'Hate / harassment' };

  // spammy (basic)
  if (RE_LINK.test(t) || RE_SPAM.test(t) || RE_ALLCAPS.test(t)) {
    return { ok:false, type:'spam', severity:2, reason:'Link / spam / noise' };
  }

  return { ok:true };
}
