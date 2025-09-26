import { openSqlite, ensureSchema } from '#relics/sqlite.mjs';
import { embedOne, normalize, cosine } from '#relics/embeddings.mjs';

export async function makeVectorMemory({
  dbPath = process.env.MEMORY_DB || 'soul/memory/memory.db',
  minChars = 8,
  candidateLimit = 1000
} = {}) {
  const db = openSqlite(dbPath);
  ensureSchema(db);

  const insertMsg = db.prepare(`
    INSERT INTO messages (ts, hall, roomId, role, userId, userName, text)
    VALUES (@ts, @hall, @roomId, @role, @userId, @userName, @text)
  `);
  const insertEmb = db.prepare(`
    INSERT INTO embeddings (message_id, dim, vec) VALUES (@message_id, @dim, @vec)
  `);

  function pickCandidates({ hall, roomId, userId, scope='room', sinceTs = 0 }) {
    // scope: 'room' | 'user' | 'hall' | 'global'
    if (scope === 'room') {
      return db.prepare(
        `SELECT * FROM messages WHERE hall=? AND roomId=? AND ts>=? ORDER BY ts DESC LIMIT ?`
      ).all(hall, roomId, sinceTs, candidateLimit);
    }
    if (scope === 'user' && userId) {
      return db.prepare(
        `SELECT * FROM messages WHERE userId=? AND ts>=? ORDER BY ts DESC LIMIT ?`
      ).all(String(userId), sinceTs, candidateLimit);
    }
    if (scope === 'hall') {
      return db.prepare(
        `SELECT * FROM messages WHERE hall=? AND ts>=? ORDER BY ts DESC LIMIT ?`
      ).all(hall, sinceTs, candidateLimit);
    }
    return db.prepare(
      `SELECT * FROM messages WHERE ts>=? ORDER BY ts DESC LIMIT ?`
    ).all(sinceTs, candidateLimit);
  }

  function loadVecs(ids) {
    if (!ids.length) return new Map();
    const sql = `SELECT message_id, vec FROM embeddings WHERE message_id IN (${ids.map(()=>'?').join(',')})`;
    const rows = db.prepare(sql).all(...ids);
    const map = new Map();
    for (const r of rows) {
      const arr = JSON.parse(r.vec);
      map.set(r.message_id, Float32Array.from(arr));
    }
    return map;
  }

  return {
    // index a turn
    async indexTurn({ evt, role='user', text='' }) {
      const clean = (text||'').trim();
      if (clean.length < minChars) return;
      const vRaw = await embedOne(clean).catch(()=>null);
      if (!vRaw) return;
      const v = normalize(vRaw);
      const ts = Date.now();
      const info = insertMsg.run({
        ts, hall: evt.hall, roomId: evt.roomId, role, userId: evt.userId || null, userName: evt.userName || null, text: clean
      });
      insertEmb.run({ message_id: info.lastInsertRowid, dim: v.length, vec: JSON.stringify(Array.from(v)) });
    },

    // semantic recall for current query
    async recallSimilar({ evt, queryText, k=3, days=30, scope=process.env.MEMORY_VECTOR_SCOPE || 'room' }) {
      const q = (queryText||'').trim();
      if (!q) return [];
      const vqRaw = await embedOne(q).catch(()=>null);
      if (!vqRaw) return [];
      const vq = normalize(vqRaw);
      const sinceTs = Date.now() - (Math.max(1, days) * 24*60*60*1000);

      const cands = pickCandidates({ hall: evt.hall, roomId: evt.roomId, userId: evt.userId, scope, sinceTs });
      if (!cands.length) return [];

      const vecMap = loadVecs(cands.map(c => c.id));
      const scored = [];
      for (const c of cands) {
        const vc = vecMap.get(c.id);
        if (!vc) continue;
        // avoid echoing the exact last user message by requiring at least 16 chars difference
        if (c.text === q) continue;
        const sim = cosine(vq, vc);
        scored.push({ sim, rec: c });
      }
      scored.sort((a,b)=> b.sim - a.sim);
      const picks = scored.slice(0, k);
      return picks.map((p,i) => ({
        title: `Long-term recall #${i+1} (${p.rec.role})`,
        text: p.rec.text
      }));
    }
  };
}
