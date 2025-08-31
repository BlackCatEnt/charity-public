import { setTopic } from './convo_state.js';

/**
 * Very lightweight intent+reply composer.
 * Keeps “quest brainstorming” sticky and avoids name drift.
 */
export async function reasonAndReply(ctx, wm, { logger }) {
  const text = (ctx.text || '').trim();
  const lower = text.toLowerCase();

  // Keep a simple “quest brainstorm” track sticky for a few minutes.
  if (/\b(quest|brainstorm|adventure|hook|mission|job)\b/.test(lower)) {
    setTopic(ctx.channel, 'quest_brainstorm', { ttlMs: 5 * 60 * 1000, meta: { starter: ctx.userLogin } });
    const reply = `Great idea! Two quick hooks:\n• “Library Lanterns” — gather starlit pages to restore a dusty grimoire.\n• “Cinder Spire” — a short arena trial for newer guildies.\nWhich should we shape first?`;
    return { intent: 'quest_brainstorm', reply };
  }

  if (wm.topic === 'quest_brainstorm') {
    const reply = `Still on quests—want cozy “Library Lanterns” or faster “Cinder Spire”? Say “lanterns” or “cinder”.`;
    return { intent: 'quest_brainstorm_followup', reply };
  }

  // Common small-talk: who are you?
  if (/\bwho\s+are\s+you\b/i.test(text)) {
    return { intent: 'whoami', reply: `I’m Charity, the Adventuring Guild’s resident senior knight and helper. I listen, remember small preferences (opt-out anytime), and spin up quests for the party.` };
  }

  // Soft contextual nudge: reference last other-speaker line without naming
  const other = (wm.lines || []).filter(l => l.login && l.login !== (ctx.userLogin || '').toLowerCase()).slice(-1)[0];
  const tap = other ? `I’m tracking the thread and can weave replies from recent lines. ` : '';
  return { intent: 'chit_chat', reply: `${tap}Want to brainstorm quests, or switch topics? Say “quests” or “switch”.` };
}
