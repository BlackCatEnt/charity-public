import { appendFeedback } from '#rituals/feedback/writer.mjs';

function parseFeedback(text) {
  // Patterns:
  //  fb good [note...]
  //  fb bad  [note...]
  //  fb +tag1 +tag2 -tag3 note: ... (rating optional)
  const m1 = text.match(/^fb\s+(good|bad)\b\s*(.*)$/i);
  const m2 = text.match(/^fb\s+(.+)$/i);

  if (m1) {
    return {
      rating: m1[1].toLowerCase() === 'good' ? 1 : -1,
      tags: [],
      note: m1[2]?.trim() || ''
    };
  }
  if (m2) {
    const body = m2[1];
    const tags = Array.from(body.matchAll(/[+-][\w-]+/g)).map(x => x[0]);
    const note = body.replace(/[+-][\w-]+/g, '').replace(/^note:\s*/i, '').trim();
    let rating = 0;
    if (tags.includes('+good') || tags.includes('+1') || /(^|\s)\+\+$/.test(body)) rating = 1;
    if (tags.includes('-bad') || tags.includes('-1') || /(^|\s)--$/.test(body)) rating = -1;
    return { rating, tags, note };
  }
  return null;
}

export async function tryRecordFeedback(evt, text, extra = {}) {
  const parsed = parseFeedback(text);
  if (!parsed) return false;

  const entry = {
    ts: new Date().toISOString(),
    hall: evt.hall,
    roomId: evt.roomId,
    userId: evt.userId,
    userName: evt.userName,
    text: evt.text,
    rating: parsed.rating,         // -1|0|1
    tags: parsed.tags,             // ["+humor","-verbose"]
    note: parsed.note || null,
    ...extra
  };
  await appendFeedback(entry);
  return true;
}
