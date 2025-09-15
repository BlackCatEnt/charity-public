// Blocks confident "we're hosting X" style claims unless an event exists in KB.
// Looks for soul/kb/events.jsonl with lines like: {"id":"e-1","title":"Founders Day","date":"2025-09-15", ...}
import { readFile } from 'node:fs/promises';
import { writeFeedback } from '#rituals/feedback/writer.mjs';

async function loadEvents() {
  let raw = '';
  try { raw = await readFile('soul/kb/events.jsonl', 'utf8'); }
  catch { return []; } // no events file yet
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

export async function guardEventAnnouncements(text, evt) {
  const msg = (text || '').toLowerCase();
  // "announcey" phrases + event-y nouns
  const announce = /(we(?:'|’)re|we are|we will|we'll|i'm|i am)\s+(hosting|holding|running|planning|organizing|celebrating)\b/.test(msg);
  const nouns    = /(event|celebration|anniversary|workshop|quest|tournament|giveaway|party|festival|meetup|stream)\b/.test(msg);
  if (!(announce && nouns)) return { ok: true, text };

  const events = await loadEvents(); // titles only is fine for now
  const titles = new Set(events.map(e => (e.title || '').toLowerCase()).filter(Boolean));
  const hasKnown = [...titles].some(t => t && msg.includes(t));
  if (hasKnown) return { ok: true, text };

  // Block and redirect to a confirmation flow + log feedback
  try {
    await writeFeedback({
      evt,
      rating: 'bad',
      tags: ['-events', '-hallucination'],
      note: 'Announcement blocked: not found in KB'
    });
  } catch {}
  return {
    ok: false,
    text: "I can check the Codex for scheduled events to be sure—would you like me to confirm with the Guild Master before announcing anything?"
  };
}
