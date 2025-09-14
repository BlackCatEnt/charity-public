import { readFile, writeFile } from 'node:fs/promises';
import actors from '#codex/actors.json' assert { type: 'json' };

const ACTORS_PATH = 'codex/actors.json';
const norm = (s='') => s.toLowerCase().trim();

function inList(list, v){ return Array.isArray(list) && list.includes(v); }

export function identify(evt){
  const uId = evt.userId || '';
  const uName = norm(evt.userName || '');
  const gm = actors.guildmaster;

  const isGM =
    (evt.hall === 'discord' && gm?.discord?.id && uId === gm.discord.id) ||
    (evt.hall === 'twitch'  && gm?.twitch?.id  && uId === gm.twitch.id)  ||
    (gm?.aliases || []).some(a => a === uName);

  if (isGM) return { role: 'Guildmaster', name: gm?.name || 'Guildmaster' };
  return { role: 'Member', name: evt.userName || 'Adventurer' };
}

export function isGuildmaster(evt){
  const who = identify(evt);
  return who.role === 'Guildmaster';
}

export function isModerator(evt){
  const uId = evt.userId || '';
  const uName = norm(evt.userName || '');
  // 1) actors.json explicit IDs per hall
  const modIds = (actors.moderators?.[evt.hall]) || [];
  if (inList(modIds, uId)) return true;

  // 2) CURATORS fallback (names)
  const curators = (process.env.CURATORS || '')
    .split(',').map(s => norm(s)).filter(Boolean);
  if (curators.includes(uName)) return true;

  // 3) Twitch tag fallback (if adapter provided it)
  if (evt.hall === 'twitch' && evt.meta?.rawTags) {
    const t = evt.meta.rawTags;
    if (t.mod === true || t.mod === '1') return true;
    const badges = t.badges || {};
    if (badges.moderator || badges.broadcaster) return true;
  }

  return false;
}

/** DM + correct secret required to (re)claim GM */
export function canUseIAM(evt, text){
  if (evt.hall !== 'discord' || !evt.meta?.isDM) return false;
  const secret = (process.env.IAM_SECRET || '').trim();
  if (!secret) return false;
  const supplied = text.split(/\s+/).slice(2).join(' ').trim(); // after '!iam guildmaster '
  return supplied === secret;
}

/** Persist current user's platform ID as guildmaster */
export async function recordGuildmasterId(evt){
  const raw = await readFile(ACTORS_PATH, 'utf8');
  const data = JSON.parse(raw);
  data.guildmaster = data.guildmaster || {};
  data.guildmaster.name = data.guildmaster.name || evt.userName || 'Guildmaster';
  data.guildmaster.discord = data.guildmaster.discord || {};
  data.guildmaster.twitch  = data.guildmaster.twitch  || {};

  if (evt.hall === 'discord') data.guildmaster.discord.id = evt.userId;
  if (evt.hall === 'twitch')  data.guildmaster.twitch.id  = evt.userId;

  await writeFile(ACTORS_PATH, JSON.stringify(data, null, 2), 'utf8');
  // also update in-memory copy so it takes effect immediately
  actors.guildmaster = data.guildmaster;
}
