import { readFile } from 'node:fs/promises';

let cache = null;
async function load() {
  if (cache) return cache;
  try {
    const raw = await readFile('soul/kb/games.jsonl','utf8');
    cache = raw.split(/\r?\n/).filter(Boolean).map(s => JSON.parse(s));
  } catch { cache = []; }
  return cache;
}

export async function lookupGame(title) {
  const rows = await load();
  const t = title.toLowerCase();
  return rows.find(g => g.title?.toLowerCase() === t || (g.aliases||[]).some(a => a.toLowerCase() === t)) || { title };
}

export function spoilerLexiconFor(game) {
  if (!game) return [];
  return [
    ...(game.characters || []),     // names can be spoilers when paired with “dies/betrays”
    ...(game.spoilers || [])        // explicit phrases you add
  ].filter(Boolean);
}
