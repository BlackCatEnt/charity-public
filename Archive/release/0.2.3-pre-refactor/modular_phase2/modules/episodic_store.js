// modules/episodic_store.js
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export function createEpisodicStore(logger = console) {
  const FILE = path.resolve(process.cwd(), 'data', 'episodic.sqlite');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });

  const db = new Database(FILE);
  db.pragma('journal_mode = WAL');

  // ---------- schema ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      display    TEXT,
      first_seen INTEGER,
      last_seen  INTEGER,
      visits     INTEGER DEFAULT 0,
      opt_out    INTEGER DEFAULT 0,
      disclosed  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      text       TEXT NOT NULL,
      importance REAL DEFAULT 1.0
    );

    CREATE TABLE IF NOT EXISTS vectors (
      episode_id INTEGER PRIMARY KEY,
      dim        INTEGER NOT NULL,
      v          BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS facts (
      user_id    TEXT NOT NULL,
      k          TEXT NOT NULL,
      v          TEXT NOT NULL,
      confidence REAL DEFAULT 0.9,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      locked     INTEGER DEFAULT 1,
      PRIMARY KEY (user_id, k)
    );

    -- open-schema candidate facts (per-user)
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
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_user_ts ON episodes(user_id, ts DESC);
  `);

  // ---------- statements ----------
  const upsertUser = db.prepare(`
    INSERT INTO users (id, display, first_seen, last_seen, visits, opt_out, disclosed)
    VALUES (@id, @display, @ts, @ts, 1, COALESCE(@opt_out,0), COALESCE(@disclosed,0))
    ON CONFLICT(id) DO UPDATE SET
      display   = excluded.display,
      last_seen = excluded.last_seen,
      visits    = users.visits + 1
  `);

  const setOpt        = db.prepare(`UPDATE users SET opt_out=? WHERE id=?`);
  const setDisclosed  = db.prepare(`UPDATE users SET disclosed=1 WHERE id=?`);
  const getUserRow    = db.prepare(`SELECT * FROM users WHERE id=?`);

  const addEpisode    = db.prepare(`INSERT INTO episodes (user_id, ts, text, importance) VALUES (?, ?, ?, ?)`);
  const putVec        = db.prepare(`INSERT INTO vectors  (episode_id, dim, v) VALUES (?, ?, ?)`);

  const listEpisodesWithVec = db.prepare(`
    SELECT e.id, e.ts, e.text, e.importance, v.dim, v.v
    FROM episodes e JOIN vectors v ON v.episode_id = e.id
    WHERE e.user_id = ?
    ORDER BY e.ts DESC
    LIMIT ?
  `);

  const putFactStmt = db.prepare(`
    INSERT INTO facts (user_id,k,v,confidence,first_seen,last_seen,locked)
    VALUES (@user_id,@k,@v,@confidence,@ts,@ts,@locked)
    ON CONFLICT(user_id,k) DO UPDATE SET
      v=excluded.v,
      confidence=MAX(facts.confidence, excluded.confidence),
      last_seen=excluded.last_seen,
      locked=MAX(facts.locked, excluded.locked)
  `);

  const delFactStmt = db.prepare(`DELETE FROM facts WHERE user_id=? AND k=?`);
  const listFactsStmt = db.prepare(`
    SELECT k,v,confidence,first_seen,last_seen,locked
    FROM facts
    WHERE user_id=?
    ORDER BY locked DESC, confidence DESC, last_seen DESC
    LIMIT ?
  `);

  const upsertCand = db.prepare(`
    INSERT INTO candidate_facts (user_id, key_norm, key_raw, value_norm, value_raw, confidence, count, evidence, episode_id, last_seen)
    VALUES (@user_id, @key, @key_raw, @value, @value_raw, @confidence, 1, @evidence, @episode_id, @last_seen)
    ON CONFLICT(user_id, key_norm, value_norm) DO UPDATE SET
      count = candidate_facts.count + 1,
      confidence = (candidate_facts.confidence*0.7 + excluded.confidence*0.3),
      evidence = COALESCE(excluded.evidence, candidate_facts.evidence),
      episode_id = COALESCE(excluded.episode_id, candidate_facts.episode_id),
      last_seen = excluded.last_seen
  `);

  const listCand = db.prepare(`
    SELECT key_norm as k, value_norm as v, confidence, count, last_seen
    FROM candidate_facts
    WHERE user_id=?
    ORDER BY confidence DESC, count DESC, last_seen DESC
    LIMIT ?
  `);

  // ---------- helpers ----------
  const userId  = tags => String(tags?.['user-id'] || tags?.username || '').toLowerCase();
  const display = tags => tags?.['display-name'] || tags?.username || 'someone';

  function toBlob(float32) {
    const arr = Array.isArray(float32) ? float32 : [];
    if (arr.length === 0) return Buffer.alloc(0);
    const f = new Float32Array(arr);
    return Buffer.from(new Uint8Array(f.buffer));
  }
  function fromBlob(buf) {
    if (!buf || buf.length === 0) return new Float32Array(0);
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Float32Array.from(f32);
  }
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i=0;i<n;i++){ const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // Single, correct opt-out helper
  function isOptedOut(tagsOrId) {
    // Auto-ignore infra bots
    const name = typeof tagsOrId === 'object' ? (tagsOrId.username || '') : '';
    const lower = String(name).toLowerCase();
    if (lower === 'nightbot' || lower === 'streamelements' || lower === 'moobot') return true;

    const id = (typeof tagsOrId === 'object')
      ? userId(tagsOrId)
      : String(tagsOrId || '').toLowerCase();

    if (!id) return false;
    const row = getUserRow.get(id);
    return !!row?.opt_out;
  }

  // ---------- API ----------
  return {
    file: FILE,

    getUserByTags(tags) {
      const id = userId(tags);
      return id ? getUserRow.get(id) : null;
    },

    setOptOutByTags(tags, val) {
      const id = userId(tags);
      if (!id) return 0;
      const ts = Date.now();
      // Always provide opt_out/disclosed to satisfy named params
      upsertUser.run({ id, display: display(tags), ts, opt_out: val ? 1 : 0, disclosed: 0 });
      setOpt.run(val ? 1 : 0, id);
      return 1;
    },

    setDisclosedByTags(tags) {
      const id = userId(tags);
      if (!id) return;
      const ts = Date.now();
      upsertUser.run({ id, display: display(tags), ts, opt_out: 0, disclosed: 1 });
      setDisclosed.run(id);
    },

    // Ingest a message (optionally with an existing vector)
    async ingest({ tags = {}, text = '', importance = 1.0, embedder, vector } = {}) {
      const uid = userId(tags);
      if (!uid) throw new Error('ingest: missing user id');
      const ts = Date.now();

      // ensure user row updated — include opt_out & disclosed defaults
      upsertUser.run({ id: uid, display: display(tags), ts, opt_out: 0, disclosed: 0 });

      // create episode
      const info = addEpisode.run(uid, ts, String(text || ''), Number(importance) || 1.0);
      const episodeId = info.lastInsertRowid;

      // resolve vector (prefer provided, else embed)
      let vec = Array.isArray(vector) ? vector : null;
      try {
        if (!vec && embedder && typeof embedder.embed === 'function') {
          vec = await embedder.embed(String(text || ''));
        }
        const dim = Array.isArray(vec) ? vec.length : 0;
        if (dim > 0) {
          putVec.run(episodeId, dim, toBlob(vec));
        }
      } catch (e) {
        logger?.warn?.('[episodic] embed failed: ' + (e?.message || e));
      }

      return episodeId;
    },

    async searchUserEpisodes({ tags = {}, embedder, query = '', limit = 20 } = {}) {
      const uid = userId(tags);
      const out = { queryVec: [], hits: [] };
      if (!uid || !embedder || typeof embedder.embed !== 'function') return out;

      const qv = await embedder.embed(String(query || ''));
      const dim = Array.isArray(qv) ? qv.length : 0;
      if (!dim) return out;
      out.queryVec = qv;

      const rows = listEpisodesWithVec.all(uid, Math.max(5, limit * 4));
      const scored = [];
      for (const r of rows) {
        const v = fromBlob(r.v);
        if (v.length !== r.dim || v.length === 0) continue;
        const score = cosine(qv, v) * (0.8 + 0.2 * Number(r.importance || 1));
        scored.push({ id: r.id, ts: r.ts, text: r.text, importance: r.importance, score });
      }
      scored.sort((a,b)=> b.score - a.score || b.ts - a.ts);
      out.hits = scored.slice(0, limit);
      return out;
    },

    getFactsByTags(tags, limit = 8) {
      const id = userId(tags);
      if (!id) return [];
      return listFactsStmt.all(id, Math.max(1, limit));
    },

    putFact(tags, { k, v, confidence = 0.9, locked = 1 }) {
      const id = userId(tags);
      if (!id) return 0;
      const now = Date.now();
      return putFactStmt.run({
        user_id: id,
        k: String(k || '').trim(),
        v: String(v || '').trim(),
        confidence: Math.max(0, Math.min(1, Number(confidence))),
        ts: now,
        locked: locked ? 1 : 0
      })?.changes || 0;
    },

    delFact(tags, key) {
      const id = userId(tags);
      if (!id) return 0;
      return delFactStmt.run(id, String(key || '').trim())?.changes || 0;
    },

    addFactCandidates(tags, episodeId, items = []) {
      const uid = userId(tags);
      if (!uid) return 0;
      const now = Date.now();
      let n = 0;
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
          evidence: it.evidence || null,
          episode_id: episodeId || null,
          last_seen: now
        });
        n++;
      }
      return n;
    },

    // Promote well-supported candidates to "facts"
    promoteCandidates({ tags, minConfidence = 0.9, minCount = 3, limit = 5, lock = 1 } = {}) {
      const uid = userId(tags);
      if (!uid) return 0;
      const DAY = 86400000, now = Date.now();
      const cans = listCand.all(uid, Math.max(5, limit * 3));
      let promoted = 0;
      for (const c of cans) {
        const fresh = (now - (c.last_seen || 0)) < 60*DAY;
        if (!fresh) continue;
        if (c.count >= minCount || c.confidence >= minConfidence) {
          promoted += this.putFact(tags, { k: c.k, v: c.v, confidence: c.confidence, locked: lock ? 1 : 0 }) ? 1 : 0;
        }
        if (promoted >= limit) break;
      }
      return promoted;
    },

    // expose helper
    isOptedOut,
  };
}
