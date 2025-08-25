// modules/reply.js — unified "reply to a specific message" helper
// Tries native tmi.js reply if available; otherwise falls back to Helix Send Chat Message API; else plain say.
export function createReply(CHARITY_CFG, logger, importTokenModule, BROADCASTER_LOGIN) {
  const useReplies = Boolean(CHARITY_CFG?.features?.use_replies);
  async function sendReply({ channel, message, parentMsgId, client, twitchSafe }) {
    const text = twitchSafe ? twitchSafe(message) : (message || '');
    if (!useReplies || !parentMsgId) {
      return client.say(channel, text);
    }
    // 1) Native tmi.js client.reply if present
    try {
      if (typeof client.reply === 'function') {
        return await client.reply(channel, text, parentMsgId);
      }
    } catch (e) {
      logger?.warn?.('[reply] native client.reply failed, will try Helix: ' + (e?.message || e));
    }
    // 2) Helix Send Chat Message API
    try {
      const tok = await importTokenModule();
      const api = tok?.createTwitchApi?.();
      const validate = tok?.validateToken;
      if (api && typeof validate === 'function') {
        const v = await validate();
        const senderId = v?.userId || v?.user_id;
        if (!senderId) throw new Error('No sender user_id from token validate');
        // Resolve broadcaster id
        const chanLogin = (BROADCASTER_LOGIN || '').toLowerCase();
        const { data: who } = await api.get('/users', { params: { login: chanLogin } });
        const broadcasterId = who?.data?.[0]?.id;
        if (!broadcasterId) throw new Error('No broadcaster_id resolved for ' + chanLogin);
        const body = {
          broadcaster_id: broadcasterId,
          sender_id: senderId,
          message: text,
          reply_parent_message_id: parentMsgId
        };
        const { data } = await api.post('/chat/messages', body);
        if (!data?.data?.[0]?.is_sent) {
          logger?.warn?.('[reply] Helix /chat/messages returned not sent: ' + JSON.stringify(data));
        }
        return true;
      }
    } catch (e) {
      logger?.warn?.('[reply] Helix send failed, falling back to say: ' + (e?.message || e));
    }
    // 3) Fallback: regular say
    return client.say(channel, text);
  }
  return { sendReply };
}
