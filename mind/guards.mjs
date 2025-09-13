// mind/guards.mjs
function parseList(s=''){ return new Set((s||'').split(',').map(x=>x.trim()).filter(Boolean)); }

const curatorDiscord = parseList(process.env.CURATORS_DISCORD_IDS);
const curatorTwitch  = parseList(process.env.CURATORS_TWITCH_IDS);

const gmDiscord = (process.env.GUILDMASTER_DISCORD_ID || '').trim();
const gmTwitch  = (process.env.GUILDMASTER_TWITCH_ID  || '').trim();

const legacyNames = new Set( // fallback only if IDs are missing
  (process.env.CURATORS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)
);

// in-memory observer flag
let OBSERVER_ON = false;

export const guards = {
  isCurator(evt){
    if (evt.hall === 'discord' && evt.userId && curatorDiscord.has(String(evt.userId))) return true;
    if (evt.hall === 'twitch'  && evt.userId && curatorTwitch.has(String(evt.userId)))   return true;
    // legacy fallback by name (spoofable; keep only as last resort)
    const u = (evt.userName || '').toLowerCase();
    return legacyNames.has(u);
  },
  isGuildMaster(evt){
    if (evt.hall === 'discord' && evt.userId) return String(evt.userId) === gmDiscord;
    if (evt.hall === 'twitch'  && evt.userId) return String(evt.userId) === gmTwitch;
    return false;
  },
  get observer(){ return OBSERVER_ON; },
  set observer(v){ OBSERVER_ON = !!v; }
};
