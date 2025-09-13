import { guards } from '#mind/guards.mjs';
import { tryRecordFeedback } from '#mind/feedback.mjs';
import { getRag, setRag } from '#mind/rag.store.mjs';
import { makeKeywordRag } from '#mind/rag.keyword.mjs';
import { nowInfo } from '#mind/time.mjs';
import { identify, canUseIAM, recordGuildmasterId, isGuildmaster } from '#mind/identity.mjs';
import { summarizeRecentAffect } from '#mind/affect.mjs';
import { startLink, completeLink } from '#mind/link.mjs';
import { guardEventAnnouncements } from '#mind/guard.events.mjs';
import { addEvent, listEvents, syncDiscordScheduledEvents } from '#mind/events.mjs';
import { startWizard, stepWizard, cancelWizard, hasWizard } from '#mind/wizards/event_add.mjs';
import { startWhy, whyAdd, whyCtx, whyPost, getWhy } from '#mind/why.mjs';
import { sanitizeOut, deaddress, enforceConcise } from '#mind/postfilter.mjs';
import { deliberate } from '#mind/reasoner.mjs';
import { ragConfidence, lowConfidencePrompt } from '#mind/confidence.mjs';
import { isCalcQuery, calcInline } from '#relics/calc.mjs';
import { CAPABILITIES, summarizeCapabilities, allowedFor } from '#mind/capabilities.mjs';
import { syncTwitchEmotes, syncDiscordEmotes } from '#sentry/emotes.mjs';
import { delayFor } from '#mind/delays.mjs';
import { stylePass } from '#mind/stylepass.mjs';
import { chatDelay } from '#mind/timing.mjs';


// -- simple JSON helpers (local) ---------------------------------------------
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

async function readJSONSafe(p, fallback = {}) {
  try { return JSON.parse(await readFile(p, 'utf8')); }
  catch { return fallback; }
}
async function saveJSON(p, data) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}
/** Update a JSON config file (defaults to codex/ when only a filename is given) */
async function updateConfig(relOrPath, mutate) {
  const p = /[\\/]/.test(relOrPath) ? relOrPath : `codex/${relOrPath}`;
  const cur = await readJSONSafe(p, {});
  const next = (await mutate?.(cur)) ?? cur;
  await saveJSON(p, next);
  return next;
}

// Safe defaults until real services are passed in from the orchestrator.
function defaultSafety() { return { pass: () => true }; }
function defaultRag()     { return { context: async () => [] }; }
function defaultLLM()     {
  const replyFor = (evt) => {
    const text = (evt.text || '').trim();

    // Simple command: !ask ...
    if (/^!ask\b/i.test(text)) {
      const q = text.replace(/^!ask\s*/i, '').trim();
      return q ? `You asked: “${q}”. (LLM wire-up coming soon.)`
               : `What would you like to ask?`;
    }

    // If addressed by name, be friendly.
    if (/(^|[\s@])charity\b/i.test(text)) {
      return `Hi ${evt.userName || 'there'}!`;
    }

    // Otherwise: no response (lets Observer Mode keep quiet)
    return '';
  };

  return {
    compose: async ({ evt }) => ({ text: replyFor(evt), meta: {} })
  };
}


function isAddressed(evt, text='') {
  const t = (text || '').toLowerCase();
  const nameHits = /\bcharity\b/.test(t);
  // treat as a command ONLY if the first non-whitespace char is '!'
  const cmd = /^\s*!/.test(t);
  const replyHit = !!evt.meta?.replyToMe;
  const mentionHit = !!evt.meta?.mentionedMe;
  return nameHits || cmd || replyHit || mentionHit || !!evt.meta?.isDM;
}

// Minimal per-hall deduper (message id or hash), 30s TTL
const RECENT = new Map(); // key -> ts
function keyOf(evt) {
  return `${evt.hall}:${evt.meta?.messageId || ''}:${evt.userId || ''}:${(evt.text || '').slice(0,64)}`;
}
function seenRecently(evt, ttlMs = 30_000) {
  const k = keyOf(evt);
  const now = Date.now();
  const last = RECENT.get(k);
  RECENT.set(k, now);
  if (RECENT.size > 500) for (const [kk, ts] of RECENT) if (now - ts > ttlMs) RECENT.delete(kk);
  return last && (now - last) < ttlMs;
}

export function createRouter({ memory, rag, llm, safety, persona, cfg, vmem } = {}) {
  const _safety = safety ?? defaultSafety();
  const _rag    = rag    ?? defaultRag();
  const _llm    = llm    ?? defaultLLM();
  // Module-local (above return) or closure-local near the top of createRouter:
  let lastPlannedAt = 0;
  const plannerCooldownMs = Number(process.env.PLANNER_COOLDOWN_MS || 45000);
  const eligibleToPlan = (Date.now() - lastPlannedAt) > plannerCooldownMs;

  return {
    async handle(evt, io) {
	  if (seenRecently(evt)) return; // already handled this message
      // record the user's message first (so recall includes it)
	  if (typeof memory?.noteUser === 'function') {
	    await memory.noteUser(evt);
      }
	  // record user message (existing)
	  if (typeof memory?.noteUser === 'function') await memory.noteUser(evt);
	  // index user message into vector memory (best effort)
	  if (vmem?.indexTurn) { vmem.indexTurn({ evt, role: 'user', text: evt.text }).catch(()=>{}); }

	  // ===== Training / Observer quick commands (curators only) =====
      const isCurator = guards.isCurator(evt);
      const text = (evt.text ?? '');
      // Ignore posts that are only ellipses/punctuation/whitespace (covers ".....", "……", lines of dashes, etc.)
      if (!/[A-Za-z0-9\u00A9-\u1FFF\u2C00-\uD7FF\u{1F300}-\u{1FAFF}]/u.test(text)) return;
	  
	  function classifyIntent(t) {
		  const s = (t || '').toLowerCase();
		  const isAction = /\b(build|fix|set ?up|install|connect|configure|make|deploy|write|generate|create)\b/.test(s);
		  if (/\b(help|what can you do|capabilities|how do you work)\b/.test(s)) return 'help';
		  if (isAction && /(?:\band\b|\bthen\b|->|\bsteps?\b|\bplan\b)/.test(s)) return 'multi_step_help';
		  if (isAction) return 'action_request';
		  if (s.length < 120 && /\b(hi|hey|lol|cool|thanks|gm|gn|pog|lmao)\b/.test(s)) return 'banter';
		  return /\?$/.test(s) ? 'simple_ask' : 'simple_ask';
		}
	const intent = classifyIntent(text);
	  
	  // was below; move it up here
		const speaker = identify(evt); // { role, name }
		const conversation = {
		  isDM: !!evt.meta?.isDM,
		  isReply: !!evt.meta?.replyToMe,
		  mentioned: !!evt.meta?.mentionedMe
		};

		// why-trace seed (emit uses whyPost)
		const _conv = { isDM: conversation.isDM, isReply: conversation.isReply, mentioned: conversation.mentioned };
		const _why = startWhy(evt);
		whyAdd(evt, {
		  addressed: {
			observer: !!guards.observer,
			reason: _conv.isDM ? 'dm' :
					_conv.isReply ? 'reply' :
					_conv.mentioned ? 'mention' :
					( /^\s*!/.test(text) ? 'command' : 'open')
		  }
		});

		// define emit BEFORE any branch uses it
		const emit = async (outText, meta = {}) => {
		  const allowed   = persona?.conduct?.allowed_emotes || [];
		  const allowPurr = persona?.conduct?.allow_purr ?? false;
		  let out = (outText ?? '').trim();
		  if (/^\s*PLAN[:>]/i.test(out)) return; // safety net: never post plans publicly
		  if (!out) return;

         // guard still runs even in raw mode (we don't want hidden event announcements)
          const guarded = await guardEventAnnouncements(out, evt);
          if (!guarded.ok) { out = guarded.text; whyPost(evt, { guardedEvent: true }); }

	     // meta.raw === true => skip postfilters (for precise system echoes)
	    const beforeLen = out.length;
	    if (!meta.raw) {
		 out = sanitizeOut(out, { allowedEmotes: allowed, allowPurr });
		 out = deaddress(out, { isDM: conversation.isDM, isReply: conversation.isReply });
		 out = enforceConcise(out, {
		   maxSentences: persona?.reply_prefs?.concise_sentences ?? 2,
		   maxChars:     persona?.reply_prefs?.concise_max_chars ?? 280
		 });
		 if (!out) return;
		 whyPost(evt, { trimmed: out.length < beforeLen, deaddressed: conversation.isDM || conversation.isReply });
   	     }
		// final tone polish (casual, playful)
		out = stylePass(out, persona);
		await chatDelay(out, cfg, 'banter');                   // human-like timing
		// inside createRouter(...), in the emit(outText, meta) function
		const cfgChannel =
		  process.env.TWITCH_CHANNEL ||
		  cfg?.services?.twitch?.channel ||
		  'bagotrix'; // fallback

		// If the event came from the Audio Hall, route the reply to Twitch instead
		const targetHall = meta?.hall || (evt.hall === 'audio' ? 'twitch' : evt.hall);

		// If we’re sending to Twitch due to audio-origin, make sure roomId is the real channel
		const targetRoom =
		  (evt.hall === 'audio' && targetHall === 'twitch')
			? cfgChannel
			: (meta?.roomId || evt.roomId);

		// ...after you build the final `out` string:
		await io.send(targetRoom, out, { ...meta, hall: targetHall });


		await memory?.noteAssistant?.(evt, out);
		if (vmem?.indexTurn) vmem.indexTurn({ evt, role: 'assistant', text: out }).catch(()=>{});
		};
	  
	  // near the top of handle(), right after you compute `text`
			  // --- set active game (quoted or unquoted) ---
		const mGameSet = text.match(/^!game\s+set\s+(.+)$/i);
		if (mGameSet && guards.canObserver(evt)) {
		  let g = (mGameSet[1] || '').trim();

		  // if the user used quotes, peel them; also normalize spaces & zero-widths
		  if ((g.startsWith('"') && g.endsWith('"')) || (g.startsWith('“') && g.endsWith('”'))) {
			g = g.slice(1, -1).trim();
		  }
		  g = g.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim(); // zero-width & squish

		  if (!g) { await emit('Usage: !game set "Title"'); return; }

		  await updateConfig('moderation.config.json', d => {
			d.spoilers = d.spoilers || {};
			d.spoilers.active_game = g;
		  });

		  // read back to verify what landed on disk
		  const conf = await readJSONSafe('codex/moderation.config.json', {});
		  const current = conf?.spoilers?.active_game || g;  // fall back to g if read fails

		  // escape just in case (avoid accidental markdown weirdness)
		  const safe = String(current).replace(/\*/g, '\\*').trim();

		  await emit(`Noted. Active game: ${safe}. Spoiler filters armed. ✧`, { raw: true });
		  return;
		}
		// !game auto on|off
		const ga = text.match(/^!game\s+auto\s+(on|off)\b/i);
		if (ga && guards.canObserver(evt)) {
		  const on = /on/i.test(ga[1]);
		  await updateConfig('charity.config.json', d => { d.games = d.games || {}; d.games.auto_detect = on; });
		  await emit(`Auto-detect is now **${on ? 'ON' : 'OFF'}**.`, { raw: true });
		  return;
		}

		// !game resync  — force one tick now
		if (/^!game\s+resync\b/i.test(text) && guards.canObserver(evt)) {
		  const info = await (await import('#relics/helix.mjs')).helixGetChannelInfo({});
		  const name = (info?.game_name || '').trim();
		  if (!name) { await emit('Could not read the current Twitch category.'); return; }
		  await updateConfig('moderation.config.json', d => { d.spoilers = d.spoilers || {}; d.spoilers.active_game = name; });
		  await emit(`Synced active game to **${name}**.`, { raw: true });
		  return;
		}

	  // Observer: ignore unless addressed or it's a privileged command
	  if (guards.observer && !isAddressed(evt, text)) return;
	  // Feed conversational event wizard if active
	  if (hasWizard(evt) && !/^\s*!/.test(text)) {
	    const step = await stepWizard(evt, text);
	    if (step.prompt) await emit(step.prompt);
	    return;
	  }
	  // KB reload: "!kb reload"
	  if (isCurator && /^!kb\s+reload\b/i.test(text)) {
		const newRag = await makeKeywordRag({});
		setRag(newRag);
		const stats = newRag.stats?.() || {};
		await io.send(evt.roomId, `KB reloaded (${stats.docs ?? 0} docs).`, { hall: evt.hall });
		return;
	  }
	  // Observer toggle: "!observer on|off|status"
	  if (/^!observer\b/i.test(text)) {
		if (!guards.canObserver(evt)) {
		await io.send(evt.roomId, 'Only moderators or the Guildmaster can use !observer.', { hall: evt.hall });
		return;
	  }
	  const mode = (text.split(/\s+/)[1] || '').toLowerCase();
	  if (mode === 'on' || mode === 'off') {
		 guards.observer = (mode === 'on');
		 await io.send(evt.roomId, `Observer mode ${guards.observer ? 'ON' : 'OFF'}.`, { hall: evt.hall });
	  } else {
		await io.send(evt.roomId, `Observer is ${guards.observer ? 'ON' : 'OFF'}.`, { hall: evt.hall });
	  }
	  return;
	}
   	  if (/^!why\b/i.test(text)) {
	    if (!guards.canObserver(evt)) { await emit('Only moderators or the Guild Master can view the why-trace.', { noMoreHint: true }); return; }
	    const w = getWhy(evt);
	    if (!w) { await emit('No recent trace for this room. Ask something, then `!why`.', { noMoreHint: true }); return; }

	    const lines = [
		  `when: ${w.ts}`,
		  `addressed: ${w.addressed.reason} (observer=${w.addressed.observer})`,
		  `style: dm=${w.style.isDM} reply=${w.style.isReply} mention=${w.style.mentioned}`,
		  `ctx: memory=${w.ctx.memory} userLinked=${w.ctx.userLinked}`,
		  w.ctx.participants ? `participants: ${w.ctx.participants}` : null,
		  w.ctx.sources?.length ? `sources: ${w.ctx.sources.join(' | ')}` : 'sources: none',
		  `postfilter: trimmed=${w.postfilter.trimmed} deaddressed=${w.postfilter.deaddressed} guardedEvent=${w.postfilter.guardedEvent}`
	    ].filter(Boolean);

	    await emit('why-trace:\n' + lines.join('\n'), { noMoreHint: true });
	    return;
      }

      // Feedback capture: "fb good", "fb bad", or "fb +humor -verbose note: ... "
      if (isCurator && text.toLowerCase().startsWith('fb ')) {
        const ok = await tryRecordFeedback(evt, text, { source: 'chat' });
        if (ok) await io.send(evt.roomId, 'Noted.', { hall: evt.hall });
        return;
      }
	  // EVENTS: add/list/sync (GM or mods)
	  if (/^!event\s+add\b/i.test(text)) {
	    if (!guards.canObserver(evt)) {
		  await emit('Only moderators or the Guild Master can add events.'); return;
	  }
	  // format: !event add "Title" 2025-09-20 "Short description"
	  const m = text.match(/^!event\s+add\s+"([^"]+)"\s+(\d{4}-\d{2}-\d{2})(?:\s+"([^"]+)")?/i);
	  if (!m) { await emit('Usage: !event add "Title" YYYY-MM-DD "Optional description"'); return; }
	  const rec = await addEvent({ title: m[1], date: m[2], desc: m[3] || '' });
	  await emit(`Event added: ${rec.title} on ${rec.date}. ✧`); return;
	  }

	  if (/^!events\s+sync\b/i.test(text)) {
	    if (!guards.canObserver(evt)) { await emit('Only moderators or the Guild Master can sync.'); return; }
	    const guildId = evt.meta?.guildId || process.env.DISCORD_GUILD_ID || '';
		  if (!guildId) {
		    await emit('I need a Discord guild id. Run `!events sync` **in a server channel** or set `DISCORD_GUILD_ID=<your server id>` in `.env`.', {});
		    return;
		  }
	    try {
		  const s = await syncDiscordScheduledEvents(guildId);
		  await emit(`Synced Discord scheduled events. Added ${s.added} new (total on Discord: ${s.total}).`);
	    } catch (e) {
		  await emit(`Sync failed: ${e.message}`);
	    }
	    return;
	  }
	  // Start conversational wizard
	  if (/^!event\s+(new|add)\b/i.test(text) && !/"[^"]+"\s+\d{4}-\d{2}-\d{2}/.test(text)) {
	    if (!guards.canObserver(evt)) { await emit('Only moderators or the Guild Master can add events.'); return; }
	    await emit(startWizard(evt)); return;
	  }

	  // Cancel wizard
	  if (/^!event\s+cancel\b/i.test(text)) {
	    if (!guards.canObserver(evt)) { await emit('Only moderators or the Guild Master can cancel event creation.'); return; }
	    await emit(cancelWizard(evt)); return;
	  }

	  // Account linking
	  if (/^!link\b$/i.test(text)) {
		const code = await startLink(evt);
		const other = evt.hall === 'twitch' ? 'Discord' : 'Twitch';
		await io.send(evt.roomId, `Link code: **${code}**. DM me on ${other} with: !link ${code}`, { hall: evt.hall });
		return;
	  }
	  const mLink = text.match(/^!link\s+(\d{6})\b/i);
	  if (mLink) {
		try {
		  await completeLink(evt, mLink[1]);
		  await io.send(evt.roomId, `Accounts linked. ✧`, { hall: evt.hall });
		  } catch (e) {
		  await io.send(evt.roomId, `Link failed: ${e.message}`, { hall: evt.hall });
		}
		return;
	  }


	  if (/^!time\b/i.test(text)) {
		const { pretty, tz } = nowInfo();
		await io.send(evt.roomId, `It’s ${pretty} (${tz}). ✧`, { hall: evt.hall });
		return;
      }
	  
	  if (/^!/.test(text)) {
		await emit('Unknown command. Try `!help`.', { noMoreHint: true });
		return;
	  }


      // ===== Normal pipeline =====
      if (!_safety.pass(evt)) return;
    
	// Build context first (so commands like !whoami can use it)
	  const activeRag = getRag?.() || _rag;
	  const recent = (typeof memory?.recall === 'function') ? await memory.recall(evt, 6) : [];
      const userRecent = (typeof memory?.recallByUser === 'function') ? await memory.recallByUser(evt, 4) : [];
	  const mood = summarizeRecentAffect(recent);
	  const moodHint = mood
		? [{
			title: 'Recent mood',
			text:
			  mood.valence <= -0.2 ? 'User seems frustrated. Be gentle, clear, and concrete.' :
			  mood.valence >=  0.4 ? 'User seems upbeat. A touch of playfulness is welcome.' :
                                'Neutral mood—keep responses balanced.'
		  }]
		: [];
	  const memoryText = recent.map(m => `${m.role === 'assistant' ? 'Charity' : (m.userName || 'User')}: ${m.text}`).join('\n');
	  const memoryCtx  = memoryText ? [{ title: 'Recent conversation', text: memoryText }] : [];
	  const userText   = userRecent.map(m => `${m.role === 'assistant' ? 'Charity' : (m.userName || 'User')}: ${m.text}`).join('\n');
	  const userCtx    = userText ? [{ title: 'Linked user history', text: userText }] : [];
	  const ragCtx     = await (activeRag?.context?.(evt, memory) ?? []);

	  // NEW: vector recall (semantic memory)
	  const qText = text.startsWith('!ask') ? text.replace(/^!ask\s*/i, '').trim() : text;
	  const vCtx  = vmem?.recallSimilar ? await vmem.recallSimilar({ evt, queryText: qText, k: 3, days: Number(process.env.MEMORY_VECTOR_DAYS || 30) }) : [];
	  const roleHints = isGuildmaster(evt)
		? [{ title: 'Sender role', text: 'The current speaker is the Guildmaster (Bagotrix). Address respectfully as “Guild Master”, never express uncertainty about their identity.' }]
	    : [];
	  // Example: you likely have these around already; fall back if missing
	  const recentCount     = Array.isArray(recent)     ? recent.length     : 0;
	  const userRecentCount = Array.isArray(userRecent) ? userRecent.length : 0;
	  const sourceTitles    = [...(vCtx||[]), ...(ragCtx||[])].map(c => c.title).filter(Boolean);

	  whyCtx(evt, {
	    memory: recentCount,
	    userLinked: userRecentCount,
	    sources: sourceTitles
  	  });
	  // If you build a participantsCtx, you can also record it:
	  if (typeof participantsCtx !== 'undefined' && Array.isArray(participantsCtx) && participantsCtx[0]?.text) {
	    whyCtx(evt, { participants: participantsCtx[0].text });
	  }

	  let capsText = '';
	  let capsCtx = [];
	  if (['help','action_request','multi_step_help'].includes(intent)) {
	  capsText = summarizeCapabilities();
	  capsCtx = [{ title: 'Capabilities', text: capsText }];
	  }

	 const isQuestion =
	   /[?]\s*$/.test(text) ||
	   /^\s*(who|what|when|where|why|how|which|do|does|did|can|could|will|would|are|is|was|were|should|shall)\b/i.test(text);
	   
     const styleHints = [];
	 if (isQuestion) {
	   styleHints.push({
	 	 title: 'Answer-first',
	 	 text: 'Begin with the direct answer in the first sentence. 1–2 sentences total; if unknown, say so briefly.'
	    });
	   // slightly cooler sampling for crisp answers
	   cfg = { ...cfg, temp: Math.min(0.45, cfg?.temp ?? 0.6) };
	  }

	 // --- Answer-first post-compose enforcement (runs only on prefaced answers) ---
	 function looksPrefacey(s = '') {
	   return /^(ah|oh|well|indeed|sure|absolutely|great question|i(?:'| a)m (?:glad|happy) you asked|good question|as for|regarding)\b/i
		 .test(s.trim());
	 }
	 async function enforceAnswerFirstText(text) {
	   if (!isQuestion || !looksPrefacey(text || '')) return text;
	   const r = await _llm.compose({
		 evt: { ...evt, text: `Rewrite to answer the user's question directly in the first sentence. Max 2 sentences. Remove any preface:\n\n${text}` },
		 ctx: [], persona, speaker, conversation,
		 cfg: { temp: 0.2, max_tokens: 120 }
	   });
	   return (r?.text || text).trim();
	 }

	 const ctx = [
	   ...roleHints, ...moodHint, ...memoryCtx, ...userCtx,
	   /* participantsCtx if any */, ...styleHints, ...vCtx, ...ragCtx,
	   ...capsCtx
	 ];
	  const roleHints = guards.isGuildMaster(evt)
	  ? [{ title: 'Sender role', text: 'The current speaker is the Guildmaster (BagOTrix). Address respectfully as “Guild Master” when appropriate.' }]
	  : [];

	  const ctx = [...roleHints, ...memoryCtx, ...vCtx, ...ragCtx];
	  if (ctx?.length) console.log('[rag] ctx:', ctx.map(c => c.title));

	  // !whoami (use the ctx, then return early)
	  if (/^!whoami\b/i.test(text)) {
		const promptEvt = { ...evt, text:
		  "Introduce yourself to the Guild in 2–3 lines using your bio and canon. " +
		  "Speak in your own voice, not as a definition. Avoid quoting bios verbatim."
		};
		const r = await _llm.compose({ evt: promptEvt, ctx, persona, speaker, conversation, cfg });
		const out = (r?.text ?? '').trim() || "I’m Charity, your guild guide and companion. ✧";
		await emit(out, (r?.meta || {}));
		return;
      }
      const reply = await _llm.compose({ evt, ctx, persona, cfg });

      const out = (reply?.text ?? '').trim();
      if (!out) return; // nothing to say
	  if (typeof memory?.noteAssistant === 'function') await memory.noteAssistant(evt, out);
	  // index assistant message too (best effort)
	  if (vmem?.indexTurn) { vmem.indexTurn({ evt, role: 'assistant', text: out }).catch(()=>{}); }

      await delayFor(out);
	  await io.send(evt.roomId, out, { hall: evt.hall, ...(reply?.meta || {}) });

	  if (typeof memory?.noteAssistant === 'function') {
	  await memory.noteAssistant(evt, out);
	  }
 
	  if (/^!spoilers\s+(on|off)\b/i.test(text) && guards.canObserver(evt)) {
	    const on = /on/i.test(text);
	    await updateConfig('moderation.config.json', d => { d.enabled = on; });
	    await emit(`Spoiler moderation ${on?'ON':'OFF'}.`);
	    return;
	  }
	  if (/^!emotes\s+sync\b/i.test(text) && guards.canObserver(evt)) {
	    const channelId = process.env.TWITCH_BROADCASTER_ID;
	    const guildId   = evt.meta?.guildId || process.env.DISCORD_GUILD_ID;

	    const tw = await syncTwitchEmotes({ channelId }).catch(() => []);
	    const dd = (evt.meta?.discordClient && guildId)
		  ? await syncDiscordEmotes(evt.meta.discordClient, guildId).catch(() => [])
		  : [];

	    await saveJSON('soul/cache/emotes.twitch.json', tw);
	    await saveJSON('soul/cache/emotes.discord.json', dd);

	    await emit(`Synced ${tw.length} Twitch and ${dd.length} Discord emotes. ✧`);
	    return;
	  }


	  // Option A) calculator route for simple math/date phrasing
	  if (isCalcQuery(text)) {
	    const r = calcInline(text);
  	    if (r) { await emit(`≈ ${r}`); return; }
	  }

// Choose pipeline: normal vs deliberate
const wantReason =
  (process.env.REASONING_DEFAULT === 'on' && intent !== 'banter')
  || ['multi_step_help','action_request','help'].includes(intent);

let reply;

if (wantReason) {
  reply = await deliberate({
    _llm, evt, ctx, persona, speaker, conversation, caps: capsText,
    cfg: { reasoning: { selfConsistency: 2, selfCheck: true }, temp: 0.6 }
  });

  const plan = (reply?.text || '').match(/^PLAN:\s*([a-z0-9_.-]+)(?:\s+(.*))?/i);
  if (plan && eligibleToPlan) {
    lastPlannedAt = Date.now();
    const capId = plan[1], args = plan[2] || '';
    const cap = CAPABILITIES.find(c => c.id === capId);
    if (!allowedFor(evt, cap, { guards })) { await emit('I can’t run that action here.'); return; }

    switch (capId) {
      case 'events.add': {
        const m = args.match(/"([^"]+)"\s+(\d{4}-\d{2}-\d{2})(?:\s+"([^"]+)")?/);
        if (!m) { await emit(`Usage: ${cap?.usage || 'events.add "Title" YYYY-MM-DD "Desc"'}`); return; }
        const rec = await addEvent({ title: m[1], date: m[2], desc: m[3] || '', source: 'plan' });
        await emit(`Event added: ${rec.title} on ${rec.date}. ✧`);
        return;
      }
      case 'events.list': {
        const evs = await listEvents();
        const lines = evs.slice(-5).map(e => `• ${e.date} — ${e.title}`);
        await emit(lines.length ? `Latest events:\n${lines.join('\n')}` : 'No events in the Codex.');
        return;
      }
      case 'events.sync': {
        const guildId = evt.meta?.guildId || process.env.DISCORD_GUILD_ID;
        if (!guildId) { await emit('Missing DISCORD_GUILD_ID.'); return; }
        const s = await syncDiscordScheduledEvents(guildId);
        await emit(`Synced Discord events. Added ${s.added} new.`);
        return;
      }
      case 'kb.reload': {
        const ok = await _rag?.reload?.().catch(() => false);
        await emit(ok ? 'Codex reloaded.' : 'Reload attempted.');
        return;
      }
      case 'observer.set': {
        const on = /\bon\b/i.test(args);
        if (!guards.canObserver(evt)) { await emit('Only moderators or the Guild Master can change Observer.'); return; }
        guards.observer = on;
        await emit(`Observer mode ${on ? 'ON' : 'OFF'}.`);
        return;
      }
      default: {
        await emit(`I can run ${capId}, but I need proper args. Try: ${cap?.usage ?? 'check help'}.`);
        return;
      }
    }
  }

  // If deliberate returned a PLAN but we didn't execute it (cooldown/unknown), don't leak it
  if (reply?.text?.startsWith('PLAN:')) reply.text = '';
} else {
  // simple/banter path
  reply = await _llm.compose({ evt, ctx, persona, speaker, conversation, cfg });
}


      if (reply?.text) reply.text = await enforceAnswerFirstText(reply.text);
      await emit(reply.text, reply?.meta);
    }
  }
}