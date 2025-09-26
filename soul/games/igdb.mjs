// Minimal IGDB client focused on lookup-by-title and aliases.
// Requires: TWITCH_CLIENT_ID and either IGDB_APP_TOKEN or TWITCH_CLIENT_SECRET to mint one.

const IGDB_URL = 'https://api.igdb.com/v4';
let mem = { token: null, exp: 0 };

async function getAppToken() {
  const now = Date.now();
  if (mem.token && now < mem.exp - 60_000) return mem.token;

  const token = process.env.IGDB_APP_TOKEN;
  if (token) { mem = { token, exp: now + 86_400_000 }; return token; }

  const cid = process.env.TWITCH_CLIENT_ID;
  const sec = process.env.TWITCH_CLIENT_SECRET;
  if (!cid || !sec) throw new Error('IGDB needs TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET or IGDB_APP_TOKEN');

  const u = new URL('https://id.twitch.tv/oauth2/token');
  u.searchParams.set('client_id', cid);
  u.searchParams.set('client_secret', sec);
  u.searchParams.set('grant_type', 'client_credentials');
  const res = await fetch(u, { method:'POST' });
  const j = await res.json();
  if (!res.ok) throw new Error(`token ${res.status}: ${JSON.stringify(j)}`);
  mem = { token: j.access_token, exp: now + (j.expires_in*1000) };
  return mem.token;
}

async function igdb(path, query) {
  const token = await getAppToken();
  const res = await fetch(`${IGDB_URL}/${path}`, {
    method: 'POST',
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    },
    body: query
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`igdb ${path} ${res.status}: ${JSON.stringify(j)}`);
  return j;
}

export async function lookupGameIGDB(title) {
  const t = (title||'').trim();
  if (!t) return { title:'', aliases:[], characters:[], spoilers:[] };

  // 1) search for the game by name or alternative name
  const q = `
    fields id,name,summary,alternative_names.name;
    search "${t}";
    where version_parent = null & category != (3,4);  // exclude mods/episodes where possible
    limit 1;
  `;
  const [game] = await igdb('games', q).catch(()=>[]);
  if (!game) return { title: t, aliases:[], characters:[], spoilers:[] };

  // 2) hydrate aliases (alternative_names)
  const aliases = (game.alternative_names || []).map(a => a.name).filter(Boolean);

  // (Optional) you could fetch characters via /characters endpoint if needed.
  // Keeping it light for now.

  // basic spoiler seeds from summary keywords (very conservative)
  const spoilers = [];
  if (/\btrue ending\b/i.test(game.summary||'')) spoilers.push('true ending');
  if (/\bfinal boss\b/i.test(game.summary||'')) spoilers.push('final boss');
  if (/\bpost-credits\b/i.test(game.summary||'')) spoilers.push('post-credits');

  return { title: game.name, aliases, summary: game.summary || '', characters: [], spoilers };
}
