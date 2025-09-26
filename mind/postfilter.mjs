export function sanitizeOut(text='', { allowedEmotes=[], allowPurr=false }={}) {
  if (!text) return text;
  let out = text.replace(/\*[^*]+\*/g,'').replace(/_[^_]+_/g,'');
  const banned = [/hugs?/i,/cuddles?/i,/snuggles?/i,/nuzzles?/i,/rubs?\s+(against|on)/i,/kisses?/i,/boops?/i,/pets?/i,/scritches?/i,/wraps?\s+.*?\s+arms/i,/holds?\s+hands?/i,/touch(?:es|ing)?/i];
  if (!allowPurr) banned.push(/purrs?/i);
  let touched = false;
  for (const r of banned){ if(r.test(out)) touched = true; out = out.replace(r,''); }
  out = out.replace(/\s{2,}/g,' ').trim();
  if (touched) { const sig = allowedEmotes[1] || allowedEmotes[0] || ''; out = out ? (sig ? `${out} ${sig}` : out) : (sig || ''); }
  return out;
}

export function deaddress(text='', { isDM=false, isReply=false }={}) {
  if (!(isDM||isReply) || !text) return text;
  return text
    .replace(/^\s*(?:guild\s*master|bagotrix)\s*[,:\-]\s*/i,'')
    .replace(/^\s*(?:hey|hi|hello|greetings)\s*[,!\-]?\s*/i,'')
    .replace(/(?:^|\n)\s*(?:guild\s*master|bagotrix)\s*[,:\-]\s*/gi,(m,p1)=>p1||'')
    .trim();
}

export function enforceConcise(text='', { maxSentences=2, maxChars=280 }={}) {
  if (!text) return text;
  const s = text.split(/(?<=[.!?])\s+/);
  let out = s.slice(0, maxSentences).join(' ');
  if (out.length > maxChars) out = out.slice(0, maxChars).trim();
  return out;
}
