import { helixDeleteMessage, helixTimeoutUser } from '#relics/helix.mjs';

export async function moderate(io, evt, decision, llm) {
  const { type, reason } = decision;
  // 1) Delete message (if we have id)
  if (evt.meta?.messageId) {
    await helixDeleteMessage({ msgId: evt.meta.messageId }).catch(()=>{});
  }

  // 2) Timeout
  if (type === 'spoiler') await helixTimeoutUser({ userId: evt.userId, secs: 300, reason: 'spoilers' }).catch(()=>{});
  if (type === 'slur')    await helixTimeoutUser({ userId: evt.userId, secs: 600, reason: 'harassment' }).catch(()=>{});
  if (type === 'spam')    await helixTimeoutUser({ userId: evt.userId, secs: 120, reason: 'spam' }).catch(()=>{});

  // 3) Sassy explanation (LLM-crafted; brief, never insulting)
  const prompt = `Write a one-sentence, playful but respectful mod message to @${evt.userName}.
  Reason: ${reason}. Hall: Twitch. Do not reveal filters. Avoid insults. Keep it under 120 chars.`;
  const r = await llm.compose({ evt:{...evt,text:''}, ctx:[], persona:{ tone:{style:'sassy, kind'}, conduct:{allowed_emotes:['✧']}});
  const line = (r?.text||'').trim() || `Heads up @${evt.userName} — ${reason}. ✧`;
  await io.send(evt.roomId, line, { hall:'twitch' });
}
