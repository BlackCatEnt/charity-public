/** @param {{ingest:(evt)=>void, send:(roomId,msg,opt?)=>Promise<void>}} core */
// halls/twitch/adapter.mjs
import tmi from 'tmi.js';
import { getTwitchToken, scheduleTwitchAutoRefresh } from '#relics/tokens.mjs';
import { validateTwitch } from '#relics/twitch-validate.mjs';

function toUnified({ channel, tags, message }){
  return {
    hall: 'twitch',
    roomId: channel.replace(/^#/,''),
    userId: tags['user-id'] ?? '',
    userName: tags['display-name'] ?? tags['username'] ?? '',
    text: message,
    ts: Date.now(),
    meta: { rawTags: tags }
  };
}

export default async function startHall(core, cfg){
  const channel = (process.env.TWITCH_BROADCASTER || cfg?.twitch?.channel || '').toLowerCase();
  if(!channel) throw new Error('[twitch] TWITCH_BROADCASTER or cfg.twitch.channel required');

  const botUser = (process.env.TWITCH_BOT_USERNAME || cfg?.twitch?.bot || '').toLowerCase();
  if(!botUser) throw new Error('[twitch] TWITCH_BOT_USERNAME or cfg.twitch.bot required');

  const tok = await getTwitchToken('bot'); // ensures fresh from cache/refresh
  // Validate token belongs to the bot user and has chat scopes
  const info = await validateTwitch('bot');
  const tokenUser = (info.login || '').toLowerCase();
  if (tokenUser !== botUser) {
    throw new Error(`[twitch] Token belongs to @${tokenUser}, but TWITCH_BOT_USERNAME is @${botUser}. 
  Generate a bot token for @${botUser} or set TWITCH_BOT_USERNAME=${tokenUser}.`);
  }
  const scopes = info.scopes || [];
  if (!scopes.includes('chat:read') || !scopes.includes('chat:edit')) {
    throw new Error(`[twitch] Bot token missing chat scopes. Have: [${scopes.join(', ')}], need: chat:read, chat:edit.`);
  }

  const client = new tmi.Client({
    options: { debug: false, messagesLogLevel: 'info' },
    connection: { secure: true, reconnect: true },
    identity: { username: botUser, password: `oauth:${tok.access_token}` },
    channels: [ `#${channel}` ]
  });

  // periodic refresh in background (does not sever current IRC; helps on reconnects)
  const stopRefresh = scheduleTwitchAutoRefresh('bot', 45*60*1000);

client.on('message', async (channelName, tags, message, self) => {
  if (self) return;
  try {
    const evt = toUnified({ channel: channelName, tags, message });
    await core.ingest(evt);
  } catch (e) {
    console.error('[twitch] ingest error:', e?.stack || e?.message || e);
  }
});


  client.on('connected', (_addr, _port) => {
    console.log(`[twitch] connected as ${botUser} to #${channel}`);
  });

  // On reconnect attempts, tmi.js will re-use the same password; if it has expired,
  // a disconnect/login fail may happen. We update the password just before 'reconnect'.
  client.on('reconnect', async () => {
    try {
      const fresh = await getTwitchToken('bot');
      client.opts.identity.password = `oauth:${fresh.access_token}`;
      console.log('[twitch] password rotated before reconnect');
    } catch(e){ console.warn('[twitch] token rotate failed:', e.message); }
  });

 try {
  await client.connect();
} catch (e) {
  console.error('[twitch] connect failed:', e?.message || e);
  console.error('[twitch] run: node relics/twitch-validate.mjs bot  -> verify login & scopes');
  throw e;
}

  return {
    async send(roomId, text){
      await client.say(`#${roomId}`, text);
    },
    async stop(){
      stopRefresh();
      try { await client.disconnect(); } catch {}
    }
  };
}
