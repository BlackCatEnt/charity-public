// mind/why.mjs — minimal per-room trace (no PII beyond what you already log)
const LAST = new Map(); // key = `${hall}:${roomId}`

const k = (evt) => `${evt.hall}:${evt.roomId}`;

export function startWhy(evt) {
  const s = {
    ts: new Date().toISOString(),
    addressed: { observer: false, reason: 'unknown' },
    style: { isDM: !!evt.meta?.isDM, isReply: !!evt.meta?.replyToMe, mentioned: !!evt.meta?.mentionedMe },
    ctx: { memory: 0, userLinked: 0, sources: [], participants: null },
    postfilter: { trimmed: false, deaddressed: false, guardedEvent: false }
  };
  LAST.set(k(evt), s);
  return s;
}
export function whyAdd(evt, patch)   { Object.assign(LAST.get(k(evt)) ?? startWhy(evt), patch); }
export function whyCtx(evt, patch)   { Object.assign((LAST.get(k(evt)) ?? startWhy(evt)).ctx, patch); }
export function whyPost(evt, patch)  { Object.assign((LAST.get(k(evt)) ?? startWhy(evt)).postfilter, patch); }
export function getWhy(evt)          { return LAST.get(k(evt)); }
