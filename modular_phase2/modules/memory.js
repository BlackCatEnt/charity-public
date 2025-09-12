// modules/memory.js
import fs from 'fs';
import path from 'path';

export function createMemory(logger, cfg = {}) {
  const FILE = path.resolve(process.cwd(), 'data', 'memory.json');
  const MAX_RECENTS = cfg?.features?.memory?.max_recents ?? 50;
  const NUDGE_COOLDOWN_MS = (cfg?.features?.memory?.nudge_cooldown_sec ?? 1800) * 1000;
  const AUTO_ENABLED = cfg?.features?.memory?.enabled ?? true;

  function load() {
    try {
      const txt = fs.readFileSync(FILE, 'utf8');
      const j = JSON.parse(txt);
      // migrate old schema {users:{}, global:{notes:[]}} → keep users if present
      return {
        users: j.users || {},
        version: j.version || 2
      };
    } catch {
      return { users: {}, version: 2 };
    }
  }
  let state = load();

  function persist() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      logger?.warn('[memory] save failed: ' + (e?.message || e));
    }
  }

  // --- helpers
  const userKey = (tags) => String(tags['user-id'] || tags.username || '').toLowerCase();
  const display = (tags) => tags['display-name'] || tags.username || 'someone';
  const now = () => Date.now();

  const STOP = new Set([
    'the','and','that','with','this','from','have','been','your','what','about','just','like','love','hate',
    'for','you','are','was','but','not','fan','cant','can','stand','really','very','well','then','they',
    'http','https','www','com','net','org','lol','lmao','rofl','gg','ggs','brb','idk','imo','imho','okay','ok',
    'its','i','me','my','we','our','us','to','of','in','on','at','it','is','a','an','as','or','if','be','do'
  ]);

  const IMPORTANT = [
    'birthday','anniversary','graduat','wedding','engaged','married','divorc','promotion','promoted',
    'new job','hired','offer','laid off','fired','moving','relocat','house','apartment',
    'surgery','operation','procedure','diagnos','hospital','recover',
    'vacation','trip','travel','flight','fly','cruise','con','tournament',
    'pc build','gpu','cpu','keyboard','setup','stream anniversary','subiversary'
  ];

  const LIKE_RX = /\b(i\s+(?:really\s+)?(?:love|like|enjoy|prefer|main)|my\s*fav(?:orite)?\b)/i;
  const DISLIKE_RX = /\b(i\s+(?:really\s+)?(?:hate|dislike|avoid|can't\s*stand|not\s+a\s+fan)|least\s+favorite)\b/i;

  function tokenize(s) {
    const clean = (s || '')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[#@]/g, ' ')
      .toLowerCase();
    const bits = clean.split(/[^a-z0-9+]+/g).filter(w => w && w.length >= 3 && !STOP.has(w));
    // prefer multiword game-ish tokens like "metroidvania"
    return bits.slice(0, 20);
  }

  function ensureProfile(k, name) {
    const u = state.users[k] || {
      id: k,
      aliases: [],
      name: name || 'someone',
      firstSeen: now(),
      lastSeen: now(),
      seenCount: 0,
      privacy: { optOut: false },
      likes: {},     // keyword -> score
      dislikes: {},  // keyword -> score
      topics: {},    // keyword -> count
      events: [],    // {ts, type, text}
      recent: [],    // {ts, text}
      lastNudge: 0,
      summary: ''
    };
    if (name && u.name !== name && !u.aliases.includes(u.name)) {
      u.aliases.push(u.name);
      u.name = name;
    }
    state.users[k] = u;
    return u;
  }

  function bump(dict, token, amt = 1) {
    if (!token) return;
    dict[token] = (dict[token] || 0) + amt;
  }

  function detectImportant(text) {
    const low = (text || '').toLowerCase();
    const hit = IMPORTANT.find(k => low.includes(k));
    if (!hit) return null;
    // quick type normalization
    let type = 'life';
    if (/(birthday|annivers)/.test(hit)) type = 'milestone';
    else if (/(promot|job|offer|hired|laid off|fired)/.test(hit)) type = 'career';
    else if (/(surgery|diagnos|hospital|recover)/.test(hit)) type = 'health';
    else if (/(moving|relocat|house|apartment)/.test(hit)) type = 'move';
    else if (/(vacation|trip|travel|flight|cruise|con|tournament)/.test(hit)) type = 'trip';
    else if (/(pc build|gpu|cpu|keyboard|setup)/.test(hit)) type = 'build';
    return { ts: now(), type, text: text.slice(0, 140) };
    }

  function summarize(u) {
  const top = (obj, n=5) =>
    Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k])=>k);

  const likes = top(u.likes, 4);
  const dislikes = top(u.dislikes, 3);
  const topics = top(u.topics, 5);

  const parts = [];
  if (likes.length)    parts.push(`likes: ${likes.join(', ')}`);
  if (dislikes.length) parts.push(`dislikes: ${dislikes.join(', ')}`);
  if (topics.length)   parts.push(`talks about: ${topics.join(', ')}`);

  if (u.events.length) {
    const e = u.events[0];
    const recent = (e.type && e.type !== 'life') ? e.type :
                   (e.text ? e.text.slice(0, 50) : 'life update');
    parts.push(`recent: ${recent}`);
  }

  u.summary = parts.join(' | ');
  return u.summary;
}

  // --- Public API

  function updateFromMessage({ channel, tags, text }) {
    if (!AUTO_ENABLED) return {};
    if (!text || text.trim().startsWith('!')) return {}; // ignore commands

    const key = userKey(tags);
    if (!key) return {};
    const name = display(tags);
    const u = ensureProfile(key, name);

    if (u.privacy?.optOut) return {}; // respect opt-out

    u.seenCount++;
    u.lastSeen = now();

    const tokens = tokenize(text);
    const important = detectImportant(text);
    if (important) u.events.unshift(important);

    const liked = LIKE_RX.test(text);
    const disliked = DISLIKE_RX.test(text);

    // weight likes/dislikes a bit higher
    const base = liked ? 2 : disliked ? -2 : 1;
    tokens.forEach(t => {
      if (liked) bump(u.likes, t, 1);
      else if (disliked) bump(u.dislikes, t, 1);
      bump(u.topics, t, Math.max(1, base));
    });

    // keep a compact rolling recent history
    u.recent.unshift({ ts: now(), text: text.slice(0, 180) });
    if (u.recent.length > MAX_RECENTS) u.recent.length = MAX_RECENTS;

    // refresh summary every ~10 messages or when we logged an event
    if (u.seenCount % 10 === 1 || important) summarize(u);

    persist();

    // gentle nudge logic: only for very new users without data
    const shouldNudge =
      (u.seenCount <= 3) &&
      Object.keys(u.likes).length === 0 &&
      Object.keys(u.topics).length < 3 &&
      now() - (u.lastNudge || 0) > NUDGE_COOLDOWN_MS;

    if (shouldNudge) {
      u.lastNudge = now();
      persist();
      // rotate a few prompts to keep it fresh
      const prompts = [
        "what games or genres are your comfort picks lately?",
        "tell me one thing you’re into—music, shows, hobbies?",
        "what brought you here today—hunting tips, chill vibes, or just lurking?",
        "what’s your current obsession? a game, a show, a build?"
      ];
      const nudge = prompts[Math.floor(Math.random() * prompts.length)];
      return { nudge };
    }

    return {};
  }

  function getProfile(tags) {
    const k = userKey(tags);
    return k ? state.users[k] || null : null;
  }

  function getSummary(tags) {
    const u = getProfile(tags);
    if (!u) return '';
    return u.summary || summarize(u);
  }

  function setOptOut(tags, val) {
    const k = userKey(tags);
    if (!k) return false;
    const u = ensureProfile(k, display(tags));
    u.privacy = u.privacy || {};
    u.privacy.optOut = !!val;
    persist();
    return true;
  }

  function forgetUser(tags) {
    const k = userKey(tags);
    if (!k || !state.users[k]) return false;
    delete state.users[k];
    persist();
    return true;
  }

  return {
    file: FILE,
    updateFromMessage,
    getProfile,
    getSummary,
    setOptOut,
    forgetUser
  };
}
