import { helixDeleteMessage, helixTimeoutUser } from '#relics/helix.mjs';
import { logModAction } from '#rituals/modlog/writer.mjs';

export async function moderate(io, evt, decision, llm) {
  const { type, reason, severity } = decision;

  // 1) Delete the message (if we have its id)
  if (evt.meta?.messageId) {
    try { await helixDeleteMessage({ msgId: evt.meta.messageId }); } catch {}
    await logModAction({ evt, action: 'delete', type, reason, extra: { severity } });
  }

  // 2) Timeout once (pick seconds by violation type)
  const secs = type === 'spoiler' ? 300
             : type === 'slur'    ? 600
             : type === 'spam'    ? 120
             : 0;
  if (secs > 0) {
    try { await helixTimeoutUser({ userId: evt.userId, secs, reason: type }); } catch {}
    await logModAction({ evt, action: 'timeout', type, reason, extra: { secs, severity } });
  }

  // 3) Sassy, respectful explain (one sentence)
  const prompt = `Write a one-sentence, playful but respectful mod message to @${evt.userName}.
Reason: ${reason}. Hall: Twitch. Do not reveal filters. Avoid insults. Keep it under 120 chars.`;
  const r = await llm.compose({
    evt: { ...evt, text: prompt },
    ctx: [],
    persona: { tone: { style: 'sassy, kind' }, conduct: { allowed_emotes: ['\u2727'] } } // ✧
  });

  const line = (r?.text || '').trim() || `Heads up @${evt.userName} — ${reason}. ✧`;
  await io.send(evt.roomId, line, { hall: 'twitch' });
}
