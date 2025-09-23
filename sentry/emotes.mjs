import { helixGetChannelEmotes, helixGetGlobalEmotes } from '#relics/helix.mjs';

export async function syncTwitchEmotes({ channelId }) {
  const [ch, gl] = await Promise.all([
    helixGetChannelEmotes({ broadcasterId: channelId }).catch(()=>({data:[]})),
    helixGetGlobalEmotes().catch(()=>({data:[]}))
  ]);
  const names = [...(ch.data||[]), ...(gl.data||[])].map(e => e.name).filter(Boolean);
  return Array.from(new Set(names));
}

export async function syncDiscordEmotes(discordClient, guildId) {
  const g = discordClient.guilds.cache.get(guildId);
  if (!g) return [];
  const emojis = g.emojis.cache.map(e => e.toString()); // :name:id:
  return emojis;
}
