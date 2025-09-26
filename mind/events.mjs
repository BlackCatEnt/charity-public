import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getDiscordClient } from '#halls/discord/adapter.mjs'; // add this export below

const FILE = 'soul/kb/events.jsonl';

async function ensureFile() { await mkdir(dirname(FILE), { recursive: true }); }

export async function listEvents() {
  try {
    const raw = await readFile(FILE, 'utf8');
    return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(JSON.parse);
  } catch { return []; }
}

export async function addEvent({ title, date, desc='', source='manual' }) {
  if (!title || !date) throw new Error('title and date required (YYYY-MM-DD)');
  await ensureFile();
  const rec = {
    id: `ev-${Date.now()}`, title, date, desc, source,
    created_at: new Date().toISOString()
  };
  await appendFile(FILE, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

export async function syncDiscordScheduledEvents(guildId) {
  const client = getDiscordClient?.();
  if (!client) throw new Error('discord client not available');
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('discord guild not in cache');
  const coll = await guild.scheduledEvents.fetch().catch(() => null);
  if (!coll) throw new Error('no scheduled events');
  const events = await listEvents();
  const seen = new Set(events.map(e => `${e.title}|${e.date}`));
  let added = 0;

  for (const ev of coll.values()) {
    const title = ev.name || '';
    const date = ev.scheduledStartAt?.toISOString()?.slice(0,10) || '';
    const desc = ev.description || '';
    if (!title || !date) continue;
    const key = `${title}|${date}`;
    if (seen.has(key)) continue;
    await addEvent({ title, date, desc, source: 'discord' });
    seen.add(key);
    added++;
  }
  return { added, total: coll.size };
}
