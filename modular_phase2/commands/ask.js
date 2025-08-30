// commands/ask.js
import { personaSystem } from '../modules/persona.js';

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Turn whatever getChannelOrLiveContext() returns (string | array | object)
// into a single compact string the model can consume.
function stringifyContext(ctx, { statusLine, profileLine } = {}) {
  const parts = [];
  const push = (s) => { if (s && String(s).trim()) parts.push(String(s).trim()); };

  if (typeof ctx === 'string') {
    push(ctx);
  } else if (Array.isArray(ctx)) {
    for (const it of ctx) {
      if (!it) continue;
      if (typeof it === 'string') push(it);
      else if (typeof it.text === 'string') push(it.text);
      else if (typeof it.value === 'string') push(it.value);
    }
  } else if (ctx && typeof ctx === 'object') {
    if (Array.isArray(ctx.lines)) {
      for (const l of ctx.lines) {
        if (typeof l === 'string') push(l);
        else if (l && typeof l.text === 'string') push(l.text);
      }
    }
    if (typeof ctx.viewerLine === 'string') push(ctx.viewerLine);
    if (typeof ctx.profileFacts === 'string') push('[Profile Facts] ' + ctx.profileFacts);
  }
  push(statusLine);
  push(profileLine);
  return parts.join('\n');
}

function sanitizeAddressing({ text, prefix, tags, cfg, isBroadcasterUser }) {
  let out = String(text || '').trim();
  const lex = cfg?.style?.lexicon || {};
  const gmName = (lex.guild_master || 'Bagotrix').toLowerCase();
  const display = (tags['display-name'] || tags.username || '').toLowerCase();
  const isGM = (typeof isBroadcasterUser === 'function' && isBroadcasterUser(tags)) || display === gmName;

  // 1) Remove an exact duplicate prefix if the model echoed it at the start
  if (prefix) {
    const pfx = escapeRegex(prefix);
    out = out.replace(new RegExp('^\\s*' + pfx + '\\s*', 'i'), '').trim();
  }

  // 2) Remove common leading vocative forms (model-generated), e.g. "Guild Master @Bagotrix," "@Bagotrix -", "Guild Master Bagotrix:"
  const gmTitle = 'Guild\\s*Master';
  const gmUser  = escapeRegex((lex.guild_master || 'Bagotrix'));
  const dispRaw = (tags['display-name'] || tags.username || '');
  const dispEsc = escapeRegex(dispRaw);
  const botUser = (process.env.TWITCH_BOT_USERNAME || 'charity_the_adventurer');
  const botUserAlt = escapeRegex(botUser).replace(/_/g, '[ _]?');

  const leadingVocatives = [
    new RegExp(`^\\s*@${botUserAlt}[:,\\-\\s]*`, 'i'),
    new RegExp(`^\\s*(?:${gmTitle})\\s+@?${gmUser}[:,\\-\\s]*`, 'i'),
    // NEW: remove a duplicate of the viewer’s name at the start, with/without '@'
    new RegExp(`^\\s*@?${dispEsc}[:,\\-\\s]*`, 'i')
  ];
  for (const rx of leadingVocatives) {
    out = out.replace(rx, '').trim();
  }

  // 3) If we’re talking directly to the GM, change third-person “Guild Master Bagotrix” → “you”
  if (isGM) {
    out = out.replace(new RegExp(`\\b${gmTitle}\\s+${gmUser}\\b`, 'gi'), 'you');
    // Also soften any leftover "@Bagotrix" mid-sentence to "you" when addressing them
    out = out.replace(new RegExp(`@${gmUser}\\b`, 'gi'), 'you');
  }

  return out.trim();
}

function isStreamOpsQuestion(q) {
  const s = String(q || '').toLowerCase();
  return /\b(stream|go live|live|offline|online|uptime|schedule|title|game|raid|shout\s*out|commands?|overlay|obs|scene|mic|audio|bitrate|drops|twitch)\b/.test(s);
}

export function createAskCommand({
  CHARITY_CFG, OLLAMA, LLM_MODEL,
  tzmod, KB,
  getChannelOrLiveContext,
  sayWithConsent, formatAddress,
  getSignatureForMood, getCurrentMood,
  isBroadcasterUser,
  episodic,
  factRouter
}) {

  return async function handleAskCommand(channel, tags, line) {
    const m = /^\s*!ask\s+(.+)/i.exec(line || '');
    if (!m) return false;

    const userQuestion = m[1].trim();
    // map "default" -> configured default (e.g., "curious")
    const moodKey = (getCurrentMood && getCurrentMood()) || 'default';
    const effectiveMood = (moodKey === 'default' && CHARITY_CFG?.mood?.default)
      ? CHARITY_CFG.mood.default
      : moodKey;

	const system = (typeof personaSystem === 'function')
	  ? personaSystem(CHARITY_CFG, effectiveMood)
	  : String(personaSystem || '');

	const ctx = await getChannelOrLiveContext();
	const ops = isStreamOpsQuestion(userQuestion);

	// If not a stream-ops question, don't nudge the model with "OFFLINE".
	const otherLines = (ctx?.lines || []).filter(l => !/^Stream is currently/i.test(l));

	const statusLine = (ops && ctx)
	  ? `Stream is currently ${ctx.isLive ? 'LIVE' : (ctx.known ? 'OFFLINE' : 'UNKNOWN')}.`
	  : null;

  // Pull a couple of high-value profile facts to help with “who/what/when” questions
  let profileLine = '';
  try {
    if (episodic && typeof episodic.getProfileFactsCombined === 'function') {
      const facts = episodic.getProfileFactsCombined(tags, 6) || [];
      const qlc = userQuestion.toLowerCase();
      const wantsGuild = /\b(guild|own|owner|run|leader|master)\b/i.test(qlc);
      const top2 = facts
        .filter(f => f.k !== 'when_we_met')
        .filter(f => f.k !== 'adventuring_guild' || wantsGuild)
        .sort((a,b)=> (b.score||0)-(a.score||0) || (b.ts||0)-(a.ts||0))
        .slice(0,2)
        .map(f => `${f.k.replace(/_/g,' ')}=${f.v}`);
      if (top2.length) profileLine = `Profile notes: ${top2.join('; ')}`;
    }
  } catch {}
  
  // Generic: ask the router to map the question to one of THIS viewer’s keys
  if (episodic && factRouter && typeof episodic.getFactsByTags === 'function') {
    const facts = episodic.getFactsByTags(tags, 24) || [];
    const keys = facts.map(f => f.k);
    if (keys.length) {
      const routed = await factRouter.route({ question: userQuestion, keys });
      if (routed?.kind === 'lookup' && routed.confidence >= 0.6) {
        const byKey = Object.fromEntries(facts.map(f => [f.k, f]));
        const f = byKey[routed.key];
        if (f?.v) {
          // small, varied one-liners
          const variants = [
            () => `You ${routed.key.includes('spouse') ? 'married' : 'shared'} ${routed.key.endsWith('_handle') ? '@'+f.v : f.v}.`,
            () => `That’s ${routed.key.replace(/_/g,' ')}: ${routed.key.endsWith('_handle') ? '@'+f.v : f.v}.`,
            () => `${routed.key.replace(/_/g,' ')} → ${routed.key.endsWith('_handle') ? '@'+f.v : f.v}.`
          ];
          const say = variants[Math.floor(Math.random()*variants.length)]();
          await sayWithConsent(channel, tags, `${formatAddress(tags)} ${say}`);
          return true;
        }
      }
    }
  }

	// Build the merged context string for the LLM
	const merged = stringifyContext(ctx, { statusLine, profileLine });

	const outputRules = [
	  'Output rules:',
	  '- Keep replies to **1–2 short sentences** (≤ ~28 words total) unless explicitly asked for more.',
      '- Treat personal details about the viewer ONLY if they appear in "Profile notes" or "Viewer Context".',
      '- Do **not** infer personal facts from the stream title, current game, or KB.',
      '- Use exact proper nouns: say "Adventuring Guild" (not "adventurous guild").',
      '- Mention the guild only if the user asked about it.',
      '- If unsure about a personal detail, ask to confirm rather than guessing.',
	  '- Avoid filler like "Oh," or "I am so excited".',
	  '- Use at most one brief stage direction like *ear flick* only when it adds meaning.',
	  '- If the user asks about equipment/gear, answer as: "Equipment: helmet, chest plate, sword, shield." (compact, no fluff).',
	  '- Never refuse to answer because the stream is offline; only mention live/offline if the user asked about stream status.'
	].join('\n');

	const messages = [
	  { role: 'system', content: system },
	  { role: 'system', content: outputRules },
	  { role: 'user',   content: `Context:\n${merged}\n\nQuestion: ${userQuestion}` }
	];

    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, messages, stream: false })
    });
    const data = await res.json().catch(() => ({}));
    const raw = data?.message?.content
             || (Array.isArray(data?.messages) ? data.messages.slice(-1)[0]?.content : '')
             || '';

    const prefix = formatAddress(tags);
	const sig = getSignatureForMood(effectiveMood);

	let body = (raw || '').trim();
	body = sanitizeAddressing({
	  text: body,
	  prefix,
	  tags,
	  cfg: CHARITY_CFG,
	  isBroadcasterUser
	});

  await sayWithConsent(channel, tags, `${prefix} ${body || 'I’m not sure yet—could you share a bit more?'} ${sig}`);

  };
}
