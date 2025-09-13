import { mkdir, appendFile, readFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = 'soul/memory/episodes';

async function exists(p){ try{ await access(p, FS.F_OK); return true; } catch { return false; } }
async function ensureDir(p){ await mkdir(p, { recursive: true }); }

function dayFile(d=new Date()){ return join(BASE, d.toISOString().slice(0,10) + '.jsonl'); }

async function writeLine(path, obj){
  await ensureDir(dirname(path));
  await appendFile(path, JSON.stringify(obj) + '\n', 'utf8');
}

async function readLines(path){
  if(!(await exists(path))) return [];
  const raw = await readFile(path, 'utf8').catch(()=>'');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim(); if(!s) continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

export function makeMemory({ maxTurns = 6 } = {}) {
  return {
    async noteUser(evt){
      const rec = {
        ts: new Date().toISOString(),
        hall: evt.hall, roomId: evt.roomId,
        role: 'user', userId: evt.userId, userName: evt.userName || '',
        text: evt.text || ''
      };
      await writeLine(dayFile(), rec);
    },
    async noteAssistant(evt, text){
      const rec = {
        ts: new Date().toISOString(),
        hall: evt.hall, roomId: evt.roomId,
        role: 'assistant', userId: null, userName: 'Charity',
        text: text || ''
      };
      await writeLine(dayFile(), rec);
    },
    async recall(evt, turns = maxTurns){
      // read today's file (simple + fast). Expand to yesterday if you want later.
      const all = await readLines(dayFile());
      const filtered = all.filter(r => r.hall === evt.hall && r.roomId === evt.roomId);
      // take last N user/assistant lines (2 per turn)
      const take = Math.max(2*turns, 2);
      return filtered.slice(-take);
    }
  };
}
