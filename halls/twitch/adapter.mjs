/** @param {{ingest:(evt)=>void, send:(roomId,msg,opt?)=>Promise<void>}} core */
// halls/twitch/adapter.mjs
import tmi from 'tmi.js';
import { getTwitchToken, refreshTwitch, scheduleTwitchAutoRefresh } from '#relics/tokens.mjs';
import { validateTwitch } from '#relics/twitch-validate.mjs';
import { evaluateMessage } from '#mind/moderation.mjs';
import { moderate } from './mod.actions.mjs';

client.on('message', async (channel, tags, msg, self) => {
  if (self) return;
  const evt = {
    hall: 'twitch',
    roomId: channel.replace('#',''),
    userId: tags['user-id'],
    userName: tags['username'],
    text: msg,
    meta: { messageId: tags['id'], isMod: tags.mod === true || (tags.badges && 'broadcaster' in tags.badges) }
  };

  try {
    const decision = await evaluateMessage(evt, msg);
    if (!decision.ok) {
      await moderate(io, evt, decision, _llm);   // do the mod action + sassy message
      // still ingest for memory (optional): you may mark it as moderated
    }
  } catch(e) { console.warn('[mod]', e.message); }

  // continue the normal pipeline
  orchestrator.ingest(evt).catch(()=>{});
});


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

  let tok = await getTwitchToken('bot');

  // validate token -> if 401, try a forced refresh once
  async function ensureValidToken() {
    try {
      const info = await validateTwitch('bot');
      const tokenUser = (info.login || '').toLowerCase();
      if (tokenUser !== botUser) {
        throw new Error(`[twitch] Token belongs to @${tokenUser}, but TWITCH_BOT_USERNAME is @${botUser}.`);
      }
      const scopes = info.scopes || [];
      if (!scopes.includes('chat:read') || !scopes.includes('chat:edit')) {
        throw new Error(`[twitch] Bot token missing chat scopes. Have [${scopes.join(', ')}], need chat:read, chat:edit.`);
      }
    } catch (e) {
      // Only attempt refresh if we can and it looks like an auth failure
      const msg = e?.message || '';
      const canRefresh = !!tok.refresh_token;
      if (canRefresh && /validate\]\s*401/i.test(msg)) {
        console.warn('[twitch] token invalid at boot; attempting refresh…');
        tok = await refreshTwitch('bot', tok);
      } else {
        throw e;
      }
    }
  }

  await ensureValidToken();

  const client = new tmi.Client({
    options: { debug: false, messagesLogLevel: 'info' },
    connection: { secure: true, reconnect: true },
    identity: { username: botUser, password: `oauth:${tok.access_token}` },
    channels: [ `#${channel}` ]
  });

  const stopRefresh = scheduleTwitchAutoRefresh('bot', 45*60*1000);

  client.on('reconnect', async () => {
    try {
      // keep the password fresh for reconnects
      const fresh = await getTwitchToken('bot');
      client.opts.identity.password = `oauth:${fresh.access_token}`;
      console.log('[twitch] password rotated before reconnect');
    } catch(e){ console.warn('[twitch] token rotate failed:', e.message); }
  });

  client.on('message', async (channelName, tags, message, self) => {
    if (self) return;
    try { 
      const replyToMe = !!(
       (tags['reply-parent-user-login'] && tags['reply-parent-user-login'].toLowerCase() === botUser.toLowerCase()) ||
       (tags['reply-parent-user-id'] && tags['reply-parent-user-id'] === tags['user-id']) // fallback check
    );
    await core.ingest({
      hall: 'twitch',
      roomId: channelName.replace(/^#/, ''),
      userId: tags['user-id'] ?? '',
      userName: tags['display-name'] ?? tags['username'] ?? '',
      text: message,
      ts: Date.now(),
      meta: { rawTags: tags, replyToMe }
    });
	   } catch (e) { console.error('[twitch] ingest error:', e?.message || e); }
 });

  await client.connect();

  return {
    async send(roomId, text){ await client.say(`#${roomId}`, text); },
    async stop(){ stopRefresh(); try { await client.disconnect(); } catch {} }
  };
 }