// modules/episodic_store.js
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export function createEpisodicStore(logger) {
  const FILE = path.resolve(process.cwd(), 'data', 'episodic.sqlite');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const db = new Database(FILE);
  db.pragma('journal_mode = WAL');
  // open-schema candidate facts (per-user)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS candidate_facts (
      user_id     TEXT NOT NULL,
      key_norm    TEXT NOT NULL,
      key_raw     TEXT,
      value_norm  TEXT NOT NULL,
      value_raw   TEXT,
      confidence  REAL DEFAULT 0.7,
      count       INTEGER DEFAULT 1,
      evidence    TEXT,
      episode_id  INTEGER,
      last_seen   INTEGER,
      PRIMARY KEY (user_id, key_norm, value_norm)
    )
  `).run();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display TEXT,
      first_seen INTEGER,
      last_seen INTEGER,
      visits INTEGER DEFAULT 0,
      opt_out INTEGER DEFAULT 0,
      disclosed INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      text TEXT NOT NULL,
      importance REAL DEFAULT 1.0
    );
    CREATE TABLE IF NOT EXISTS vectors (
      episode_id INTEGER PRIMARY KEY,
      dim INTEGER NOT NULL,
      v BLOB NOT NULL
    );
	CREATE TABLE IF NOT EXISTS facts (
	  user_id   TEXT NOT NULL,
	  k         TEXT NOT NULL,
	  v         TEXT NOT NULL,
	  confidence REAL DEFAULT 0.9,
	  first_seen INTEGER NOT NULL,
	  last_seen  INTEGER NOT NULL,
	  locked     INTEGER DEFAULT 1,
	  PRIMARY KEY (user_id, k)
	);
    CREATE INDEX IF NOT EXISTS idx_episodes_user_ts ON episodes(user_id, ts DESC);
  `);

  const upsertUser = db.prepare(`
    INSERT INTO users (id, display, first_seen, last_seen, visits, opt_out, disclosed)
    VALUES (@id, @display, @ts, @ts, 1, COALESCE(@opt_out,0), COALESCE(@disclosed,0))
    ON CONFLICT(id) DO UPDATE SET
      display=excluded.display,
      last_seen=excluded.last_seen,
      visits=users.visits+1
  `);
  const putFact = db.prepare(`
	INSERT INTO facts (user_id,k,v,confidence,first_seen,last_seen,locked)
	VALUES (@user_id,@k,@v,@confidence,@ts,@ts,@locked)
	ON CONFLICT(user_id,k) DO UPDATE SET
	  v=excluded.v,
      confidence=MAX(facts.confidence, excluded.confidence),
      last_seen=excluded.last_seen,
      locked=MAX(facts.locked, excluded.locked)
  `);

	const delFact = db.prepare(`DELETE FROM facts WHERE user_id=? AND k=?`);
	const listFacts = db.prepare(`
	  SELECT k,v,confidence,first_seen,last_seen,locked
	  FROM facts
	  WHERE user_id=?
	  ORDER BY locked DESC, confidence DESC, last_seen DESC
	  LIMIT ?
  `);

  const upsertCand = db.prepare(`
    INSERT INTO candidate_facts (user_id,key_norm,key_raw,value_norm,value_raw,confidence,count,evidence,episode_id,last_seen)
    VALUES (@user_id,@key,@key_raw,@value,@value_raw,@confidence,@count,@evidence,@episode_id,@last_seen)
    ON CONFLICT(user_id,key_norm,value_norm) DO UPDATE SET
      count      = candidate_facts.count + 1,
      confidence = MAX(candidate_facts.confidence, excluded.confidence),
      evidence   = COALESCE(excluded.evidence, candidate_facts.evidence),
      episode_id = COALESCE(excluded.episode_id, candidate_facts.episode_id),
      last_seen  = excluded.last_seen
  `);

  const listCand = db.prepare(`
    SELECT key_norm AS k, value_norm AS v, confidence, count, last_seen, evidence
    FROM candidate_facts
    WHERE user_id=?
    ORDER BY (confidence + count*0.05) DESC, last_seen DESC
    LIMIT ?
  `);

  const getUser = db.prepare(`SELECT * FROM users WHERE id=?`);
  const setOpt = db.prepare(`UPDATE users SET opt_out=? WHERE id=?`);
  const forgetUser = db.prepare(`DELETE FROM users WHERE id=?`);
  const deleteEpisodes = db.prepare(`DELETE FROM episodes WHERE user_id=?`);
  const setDisclosed = db.prepare(`UPDATE users SET disclosed=1 WHERE id=?`);

  const addEp = db.prepare(`INSERT INTO episodes (user_id, ts, text, importance) VALUES (?, ?, ?, ?)`);
  const putVec = db.prepare(`INSERT INTO vectors (episode_id, dim, v) VALUES (?, ?, ?)`);

  const getUserEpisodes = db.prepare(`SELECT e.id, e.ts, e.text, e.importance, v.dim, v.v
    FROM episodes e JOIN vectors v ON v.episode_id = e.id
    WHERE e.user_id = ? ORDER BY e.ts DESC LIMIT ?`);

  function userId(tags) {
    return String(tags['user-id'] || tags.username || '').toLowerCase();
  }
   function display(tags) {
     return tags['display-name'] || tags.username || 'someone';
   }

  // alias for older helpers that referenced idFromTags
  const idFromTags = (tags) => userId(tags);
  
  function toBlob(float32) {
    return Buffer.from(new Uint8Array(new Float32Array(float32).buffer));
  }
  function fromBlob(buf) {
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Float32Array.from(f32);
  }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i=0;i<a.length;i++){ const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  return {
    file: FILE,
    getUserByTags(tags) { return getUser.get(userId(tags)); },
    setOptOutByTags(tags, val) {
      const id = userId(tags);
      const ts = Date.now();
      // ensure the row exists so UPDATE always works
      upsertUser.run({ id, display: display(tags), ts, opt_out: val ? 1 : 0, disclosed: 0 });
      setOpt.run(val ? 1 : 0, id);
    },
	
	addFactCandidates(tags, episodeId, items=[]) {
      const uid = userId(tags);
      const now = Date.now();
      for (const it of items) {
        const key = (it.key || it.k || '').trim();
        const value = (it.value || it.v || '').trim();
        if (!key || !value) continue;
        upsertCand.run({
          user_id: uid,
          key,
          key_raw: it.key_raw || it.key || null,
          value,
          value_raw: it.value_raw || it.value || null,
          confidence: Math.max(0.5, Math.min(1.0, Number(it.confidence ?? 0.75))),
          count: 1,
          evidence: it.evidence || null,
          episode_id: episodeId || null,
          last_seen: now
        });
      }
    },

    // merge confirmed facts + "promoted" candidates (generic, no hard-coding)
    getProfileFactsCombined(tags, limit = 8) {
      const id = userId(tags);
      const DAY = 86400000, now = Date.now();
      const hard = this.getFactsByTags(tags, limit*2);
      const seenKeys = new Set(hard.map(f => f.k));
      const cans = listCand.all(id, limit*3).filter(c => {
        // promotion rules: enough support OR high confidence, and not too old
        const fresh = (now - (c.last_seen || 0)) < 60*DAY;
        return fresh && (c.count >= 2 || c.confidence >= 0.85);
      }).map(c => ({
        k: c.k, v: c.v, confidence: c.confidence, locked: false, ts: c.last_seen,
        score: c.confidence + Math.min(0.3, c.count*0.05) + Math.max(0, 0.3 - ((now-(c.last_seen||now))/DAY)/200)
      })).filter(c => !seenKeys.has(c.k));
      const merged = [...hard, ...cans]
         .sort((a,b)=> (b.score||0)-(a.score||0) || (b.ts||0)-(a.ts||0))
         .slice(0, limit);
       return merged;
    },
	mostRecentByTags(tags) {
      const id = idFromTags(tags);
      const row = db.prepare(
        `SELECT id, ts, text, importance FROM episodes
         WHERE user_id=? ORDER BY ts DESC LIMIT 1`
      ).get(id);
      return row || null;
    },

    getFactsByTags(tags, limit = 8) {
      const id = idFromTags(tags);
      const rows = listFacts.all(id, limit);
      const now = Date.now(), DAY = 86400000;
      return rows.map(r => ({
        k: r.k, v: r.v, confidence: r.confidence, first_seen: r.first_seen, last_seen: r.last_seen, locked: r.locked,
        ts: r.last_seen,
        score:
          (r.confidence || 0.5) +
          (r.locked ? 0.2 : 0) +
          Math.max(0, 0.3 - ((now - (r.last_seen || now)) / DAY) / 200)
      }));
    },

    markDisclosedByTags(tags) {
      setDisclosed.run(userId(tags));
    },
    async ingest({ tags, text, embedder, importance = 1.0 }) {
      const id = userId(tags);
      const ts = Date.now();
      upsertUser.run({ id, display: display(tags), ts, opt_out: 0, disclosed: 0 });


      const u = getUser.get(id);
      if (u?.opt_out) return null;

      const info = addEp.run(id, ts, text.slice(0, 500), importance);
      const prompt = text.slice(0, 500);
      const [vec] = await (embedder.embedPassage ? embedder.embedPassage([prompt])
                                                 : embedder.embed([prompt]));
      putVec.run(info.lastInsertRowid, embedder.dim, toBlob(vec));
      return info.lastInsertRowid;
    },
	upsertFactByTags(tags, k, v, { confidence=0.9, locked=true } = {}) {
	  const id = userId(tags);
	  const ts = Date.now();
	  upsertUser.run({ id, display: display(tags), ts, opt_out: 0, disclosed: 0 });

	  const u = getUser.get(id);
	  if (u?.opt_out) return false;

	putFact.run({
      user_id: id,
      k: String(k).toLowerCase().trim(),
      v: String(v).trim(),
      confidence: Number(confidence),
      ts,
      locked: locked ? 1 : 0
	});
    return true;
},

	forgetFactByTags(tags, k) {
      return delFact.run(userId(tags), String(k).toLowerCase().trim()).changes > 0;
},

    searchUserEpisodes: async function ({ tags, embedder, query, topK = 8, lookback = 400 }) {
      const id = userId(tags);
      const rows = getUserEpisodes.all(id, lookback);
      if (!rows.length) return { hits: [], queryVec: null };
 
      const [qvec] = await (embedder.embedQuery ? embedder.embedQuery(query || 'general preference and recent topics')
                                                 : embedder.embed(query || 'general preference and recent topics'));
      const now = Date.now();
      const DAY = 86400000;
      // Only compare vectors that match the current embedder's dimension (e.g., 1024 for BGE-M3)
      const sameDim = rows.filter(r => r.dim === embedder.dim);
      if (!sameDim.length) return { hits: [], queryVec: qvec };

      const scored = sameDim.map(r => {
        const v = fromBlob(r.v);
        const sim = cosine(qvec, v);
        const ageDays = Math.max(0, (now - r.ts) / DAY);
        const recency = Math.max(0.35, 1 - (ageDays / 60)); // decay over 60d, floor at 0.35
        const imp = r.importance || 1.0;
        const score = sim * recency * imp;
        return { id: r.id, ts: r.ts, text: r.text, sim, recency, imp, score };
       });
       scored.sort((a,b)=>b.score - a.score);
       return { hits: scored.slice(0, topK), queryVec: qvec };
     },
    forget(tags) {
      const id = userId(tags);
      deleteEpisodes.run(id);
      forgetUser.run(id);
    }
  };
}
export async function storeFact(tags, k, v, { conf = 0.5 } = {}) {
  const id = idFromTags(tags);
  const key = String(k).trim().toLowerCase().replace(/\s+/g,'_').slice(0, 48);
  const val = String(v).trim().slice(0, 160);
  if (!id || !key || !val) return false;

  // reject NSFW/forbidden keys here too
  if (/(nsfw|porn|sex|sexual|explicit|fetish|gore)/i.test(key + ' ' + val)) return false;

  // upsert: increment seen_count, use max(conf), refresh timestamps
  upsertFact.run({
    id, k: key, v: val,
    confidence: conf,
    ts: Date.now()
  });
  return true;
}
