import cfg from '#codex/charity.config.json' assert { type:'json' };
import { readFile } from 'node:fs/promises';

let localCache = null;
async function loadLocal() {
  if (localCache) return localCache;
  try {
    const raw = await readFile('soul/kb/games.jsonl','utf8');
    localCache = raw.split(/\r?\n/).filter(Boolean).map(s => JSON.parse(s));
  } catch { localCache = []; }
  return localCache;
}

async function lookupLocal(title) {
  const rows = await loadLocal();
  const t = (title||'').toLowerCase();
  const rec = rows.find(g => g.title?.toLowerCase() === t ||
                              (g.aliases||[]).some(a => (a||'').toLowerCase() === t));
  if (rec) return rec;
  return { title, aliases: [], characters: [], spoilers: [] };
}

let igdb;
async function lookupIGDB(title) {
  if (!igdb) igdb = await import('#soul/games/igdb.mjs');
  return igdb.lookupGameIGDB(title);
}

export async function lookupGame(title) {
  const src = (cfg?.games?.source || 'local').toLowerCase();
  if (src === 'igdb') {
    const rec = await lookupIGDB(title).catch(()=>null);
    if (rec && (rec.title || rec.aliases?.length)) return rec;
  }
  return lookupLocal(title);
}

export function spoilerLexiconFor(game) {
  if (!game) return [];
  return [
    ...(game.characters || []),
    ...(game.spoilers || []),
    // lightweight generic flags
    'ending','final boss','true ending','secret ending','post-credits','plot twist','chapter ','act '
  ].filter(Boolean);
}
