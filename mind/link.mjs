import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import crypto from 'node:crypto';

const MAP = 'soul/memory/links/map.json';
const PENDING = 'soul/memory/links/pending.json';

async function readJSON(p, def){ try { return JSON.parse(await readFile(p,'utf8')); } catch { return def; } }
async function writeJSON(p, data){ await mkdir(dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(data, null, 2), 'utf8'); }

const keyOf = (evt) => `${evt.hall}:${evt.userId || evt.userName || ''}`;

export async function startLink(evt){
  const code = String(Math.floor(100000 + Math.random()*900000));
  const pending = await readJSON(PENDING, {});
  pending[code] = { from: evt.hall, user_key: keyOf(evt), ts: Date.now() };
  await writeJSON(PENDING, pending);
  return code;
}

export async function completeLink(evt, code){
  const pending = await readJSON(PENDING, {});
  const rec = pending[code];
  if (!rec) throw new Error('code not found or expired');
  if (rec.from === evt.hall) throw new Error('use the code from the other platform');

  const map = await readJSON(MAP, { pairs: [], index: {} });
  const a = rec.user_key;
  const b = keyOf(evt);

  let id = map.index[a] || map.index[b];
  if (!id) id = crypto.randomBytes(4).toString('hex');

  // upsert
  const now = new Date().toISOString();
  let pair = map.pairs.find(p => p.id === id);
  if (!pair) { pair = { id, created_at: now, updated_at: now }; map.pairs.push(pair); }
  pair[rec.from] = a;
  pair[evt.hall] = b;
  pair.updated_at = now;

  map.index[a] = id;
  map.index[b] = id;

  delete pending[code];
  await writeJSON(MAP, map);
  await writeJSON(PENDING, pending);
  return id;
}

export async function unifiedKeyFor(evt){
  const map = await readJSON(MAP, { index: {} });
  const k = keyOf(evt);
  return map.index[k] || k;
}
