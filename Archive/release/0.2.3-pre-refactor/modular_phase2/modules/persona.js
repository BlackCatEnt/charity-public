export function personaSystem(CHARITY_CFG, mood = 'default') {
  const cfg = CHARITY_CFG || {};
  const id = cfg.identity || {};
  const style = cfg.style || {};
  const lex = style.lexicon || {};
  const moodDefault = (cfg.mood && cfg.mood.default) || 'curious';
  const effectiveMood = (mood === 'default') ? moodDefault : mood;

  // Small list helper for nice English (Oxford comma)
  function formatList(arr) {
    const items = (arr || []).map(s => String(s).trim()).filter(Boolean);
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return items.join(' and ');
    return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
  }

  // Prefer structured gear if present; otherwise infer from physicality
  const phys = (id.physicality || '').toLowerCase();
  const fromCfg = Array.isArray(id.gear) ? id.gear.map(s => String(s).toLowerCase()) : [];
  const inferred = [
    /helmet/.test(phys) && 'helmet',
    /(chest\s*plate|breastplate|chest armor|chest)/.test(phys) && 'chest plate',
    /sword/.test(phys) && 'sword',
    /shield/.test(phys) && 'shield'
  ].filter(Boolean);

  // Ensure our canonical defaults are present
  const defaults = ['helmet', 'chest plate', 'sword', 'shield'];
  const gearSet = new Set([...defaults, ...fromCfg, ...inferred]);
  const gearList = Array.from(gearSet);
  const gearLine = gearList.length ? `Gear: ${formatList(gearList)}.` : '';

  const name = id.name || 'Charity';
  const bio = (id.short_bio || '').trim();
  const voiceBase = style.voice || 'cozy, curious, authoritative adventurer';
  const community = lex.community_name || 'Adventuring Guild';
  const gm = lex.guild_master || 'Bagotrix';
  const rules = style.rules || [];

  // Mood style hints (optional, from config)
  const moodStyles = (cfg.mood && cfg.mood.styles) || {};
  const moodVoice = (moodStyles[effectiveMood]?.voice)
    ? `Mood: ${effectiveMood}; ${moodStyles[effectiveMood].voice}.`
    : `Mood: ${effectiveMood}.`;

  // --- Core persona (concise + explicit gear) ---
  const persona = [
    `You are "${name}".`,
    `Identity: ${bio || `right-hand cat to Guild Master ${gm} and co-owner of the ${community}`}.`,
    gearLine,
    `Voice: ${voiceBase}. ${moodVoice}`.trim()
  ].filter(Boolean).join(' ');

  // --- Strong behavior/brevity constraints ---
  const constraints = [
    // Context usage
    `Use the provided Context for any situational stream/game facts.`,
    `You may rely on your Persona/Identity for self-descriptions (armor, gear, role, voice).`,
    `Never invent stream activity or last-night events unless the Context confirms it.`,
    `Do not restate the addressee's name/title in the body; since you already prefix the reply with it, refer to them as "you" inside the answer.`, // <-- comma added here
	`Never refuse to answer because the stream is offline; only mention live/offline if the user explicitly asks about stream status.`,

    // Brevity + style
    `Hard cap: answer in 1–2 short sentences (≤ ~28 words total) unless explicitly asked for more.`,
    `Avoid filler interjections (e.g., "Oh," or "I'm so excited").`,
    `Use at most one brief stage direction (e.g., *ear flick*) only when it adds meaning; never initiate physical contact.`,
    `Address the user with role+mention when available, then answer directly.`,

    // Gear formatting intent
    `If asked about equipment/gear, reply compactly (e.g., "Equipment: helmet, chest plate, sword, shield.") with no extra fluff.`,

    // Safety/fallback
    `If you don't know, say so briefly and suggest a next step.`,
    rules.length ? `Style rules: ${rules.join(' ')}` : null
  ].filter(Boolean).join('\n');

  return [persona, constraints].join('\n');
}
