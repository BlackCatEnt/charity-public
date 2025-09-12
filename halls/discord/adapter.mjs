/** @param {{ingest:(evt)=>void, send:(roomId,msg,opt?)=>Promise<void>}} core */
// halls/Discord/adapter.mjs 
import { Client, GatewayIntentBits, Partials } from 'discord.js';

function toUnified(msg){
  return {
    hall: 'discord',
    roomId: msg.channelId,
    userId: msg.author?.id ?? '',
    userName: msg.author?.username ?? '',
    text: msg.content ?? '',
    ts: msg.createdTimestamp ?? Date.now(),
    meta: { isDM: msg.channel?.isDMBased?.() ?? false }
  };
}

export default async function startHall(core, cfg){
  const token = process.env.DISCORD_BOT_TOKEN;
  if(!token) throw new Error('[discord] DISCORD_BOT_TOKEN required');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel] // for DMs
  });
  
 // after client = new Client(...)
  const onReady = () => console.log(`[discord] logged in as ${client.user.tag}`);
  client.once('clientReady', onReady); // new name (v15)
  
client.on('messageCreate', async (msg) => {
  if (msg.author?.bot) return;
  try {
    const evt = toUnified(msg);
    await core.ingest(evt);
  } catch (e) {
    console.error('[discord] ingest error:', e?.stack || e?.message || e);
  }
});

  await client.login(token);

  return {
    async send(roomId, text, meta={}){
      const channel = await client.channels.fetch(roomId).catch(()=>null);
      if(!channel || !('send' in channel)) return;
      await channel.send(text);
    },
    async stop(){
      try { await client.destroy(); } catch {}
    }
  };
}

