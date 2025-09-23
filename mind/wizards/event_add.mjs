import { addEvent } from '#mind/events.mjs';

const SESS = new Map(); // key = hall:room:user

const keyFor = (evt) => `${evt.hall}:${evt.roomId}:${evt.userId}`;

function parseDate(s='') {
  const m = s.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (!m) return null;
  const [ , y, mo, d ] = m.map(Number);
  const iso = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  if (isNaN(Date.parse(iso))) return null;
  return iso;
}

export function startWizard(evt) {
  const k = keyFor(evt);
  const s = { step: 'title', data: {}, startedAt: Date.now() };
  SESS.set(k, s);
  return 'Let’s add an event. What’s the **title**? (You can say something like: “Founders Day”)';
}

export function cancelWizard(evt) {
  SESS.delete(keyFor(evt));
  return 'Event creation canceled.';
}

export async function stepWizard(evt, text) {
  const k = keyFor(evt);
  const s = SESS.get(k);
  if (!s) return { done: false, prompt: null };

  const t = (text || '').trim();

  if (s.step === 'title') {
    if (t.length < 3) return { done:false, prompt:'Title feels too short—what should we call it?' };
    s.data.title = t;
    s.step = 'date';
    return { done:false, prompt:'Great! What **date** is it? (YYYY-MM-DD)' };
  }

  if (s.step === 'date') {
    const iso = parseDate(t);
    if (!iso) return { done:false, prompt:'I couldn’t read that date. Try `YYYY-MM-DD`.' };
    s.data.date = iso;
    s.step = 'desc';
    return { done:false, prompt:'Optional: any short **description**? (or type `skip`)' };
  }

  if (s.step === 'desc') {
    if (t.toLowerCase() !== 'skip') s.data.desc = t;
    s.step = 'confirm';
    const { title, date, desc='' } = s.data;
    return { done:false, prompt:`Confirm add:\n• **${title}** on **${date}**\n${desc ? `• ${desc}\n` : ''}Type \`save\` to store it, or \`cancel\`.` };
  }

  if (s.step === 'confirm') {
    if (/^cancel$/i.test(t)) { SESS.delete(k); return { done:true, prompt:'Event creation canceled.' }; }
    if (!/^save$/i.test(t))  { return { done:false, prompt:'Please type `save` to store, or `cancel`.' }; }
    const rec = await addEvent({ ...s.data, source:'chat' });
    SESS.delete(k);
    return { done:true, prompt:`Event saved: **${rec.title}** on **${rec.date}**. ✧` };
  }

  return { done:false, prompt:'(Unexpected step) try `!event cancel` and start again.' };
}

/** True if this user has a live wizard session in this room. */
export function hasWizard(evt) { return SESS.has(keyFor(evt)); }
