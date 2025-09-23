import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeVectorMemory } from '#mind/memory.vector.mjs';

function parseArgs(){
  const a = new Map(process.argv.slice(2).flatMap(s => {
    const m = s.match(/^--([^=]+)=(.*)$/); return m ? [[m[1], m[2]]] : [];
  }));
  return {
    days: Number(a.get('days') || 30),
    dir: a.get('dir') || 'soul/memory/episodes'
  };
}

async function* iterFiles(dir){
  const ents = await readdir(dir, { withFileTypes: true }).catch(()=>[]);
  for (const e of ents) {
    if (e.isFile() && /\.jsonl$/i.test(e.name)) yield join(dir, e.name);
  }
}

async function readJsonl(path){
  const out = [];
  const raw = await readFile(path, 'utf8').catch(()=> '');
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim(); if(!s) continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

function withinDays(ts, days){
  const since = Date.now() - days*24*60*60*1000;
  const t = Date.parse(ts);
  return Number.isFinite(t) && t >= since;
}

async function main(){
  const args = parseArgs();
  const vmem = await makeVectorMemory({});

  let count = 0, files = 0;
  for await (const f of iterFiles(args.dir)) {
    const rows = await readJsonl(f);
    for (const r of rows) {
      if (!withinDays(r.ts, args.days)) continue;
      await vmem.indexTurn({
        evt: { hall: r.hall, roomId: r.roomId, userId: r.userId, userName: r.userName },
        role: r.role, text: r.text
      });
      count++;
    }
    files++;
  }
  console.log(`✅ Backfilled ${count} turns from ${files} files (<=${args.days}d).`);
}
main().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
