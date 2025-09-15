// Tiny, dependency-free affect scorer: valence [-1..1], arousal [0..1]
const POS = ['lol','lmao','haha','yay','thanks','ty','pog','pogchamp','kekw','lul','<3','love','great','awesome','nice','cool','gg'];
const NEG = ['ugh','wtf','angry','mad','annoyed','sad','sorry','nope','rip','stupid','hate','bad','broken','bug'];
const POS_EMOTE = ['kappa','kekw','lul','pog','pogchamp','4head','clap','hype'];
const NEG_EMOTE = ['biblethump','feelsbadman','failfish','residentsleeper','pepehands'];

export function scoreAffect(text = '', meta = {}) {
  const t = (text || '').toLowerCase();
  let val = 0, ar = 0; const cues = [];

  // words
  for (const w of POS) if (t.includes(w)) { val += 1; cues.push(w); }
  for (const w of NEG) if (t.includes(w)) { val -= 1; cues.push(w); }

  // emojis (very coarse)
  const emojiCount = (t.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu) || []).length;
  if (emojiCount) { ar += Math.min(1, emojiCount / 5); cues.push(`emoji:${emojiCount}`); }

  // discord custom emoji by name: <:name:id> or <a:name:id>
  for (const m of t.matchAll(/<a?:([a-z0-9_]+):\d+>/gi)) {
    const name = m[1].toLowerCase();
    if (POS_EMOTE.includes(name)) { val += 1; cues.push(name); }
    if (NEG_EMOTE.includes(name)) { val -= 1; cues.push(name); }
  }

  // twitch emotes: if adapter provides names in text, catch them; else any emotes boost arousal
  if (meta?.rawTags?.emotes) { ar += 0.2; cues.push('twitch:emotes'); }
  for (const e of POS_EMOTE) if (t.includes(e)) { val += 1; cues.push(e); }
  for (const e of NEG_EMOTE) if (t.includes(e)) { val -= 1; cues.push(e); }

  // punctuation excitement
  const bangs = (text.match(/!+/g) || []).length;
  if (bangs) { ar += Math.min(1, bangs / 3); cues.push(`!x${bangs}`); }

  // normalize
  val = Math.max(-1, Math.min(1, val / 3));
  ar = Math.max(0, Math.min(1, ar));
  return { valence: Number(val.toFixed(2)), arousal: Number(ar.toFixed(2)), cues };
}

export function summarizeRecentAffect(rows = []) {
  const user = rows.filter(r => r.role === 'user' && r.affect);
  if (!user.length) return null;
  const v = user.reduce((s, r) => s + (r.affect?.valence || 0), 0) / user.length;
  const a = user.reduce((s, r) => s + (r.affect?.arousal || 0), 0) / user.length;
  return { valence: Number(v.toFixed(2)), arousal: Number(a.toFixed(2)), n: user.length };
}
