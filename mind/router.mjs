import { delayFor } from '#mind/delays.mjs';
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
  const t = (text || '').toLowerCase().trim();
  const nameHits = /\bcharity\b/.test(t);
  const cmd = /^[!.]/.test(t); // commands like !ask, !kb …
  const replyHit = !!evt.meta?.replyToMe;
  const mentionHit = !!evt.meta?.mentionedMe;
  return nameHits || cmd || replyHit || mentionHit || !!evt.meta?.isDM;
}

export function createRouter({ memory, rag, llm, safety, persona, cfg, vmem } = {}) {
  const _safety = safety ?? defaultSafety();
  const _rag    = rag    ?? defaultRag();
  const _llm    = llm    ?? defaultLLM();

  return {
    async handle(evt, io) {
	  // record user message (existing)
	  if (typeof memory?.noteUser === 'function') await memory.noteUser(evt);
	  // index user message into vector memory (best effort)
	  if (vmem?.indexTurn) { vmem.indexTurn({ evt, role: 'user', text: evt.text }).catch(()=>{}); }

	  // ===== Training / Observer quick commands (curators only) =====
      const isCurator = guards.isCurator(evt);
      const text = evt.text?.trim() || '';
	  const speaker = identify(evt); // { role, name }
	  const conversation = {
		  isDM: !!evt.meta?.isDM,
		  isReply: !!evt.meta?.replyToMe,
		  mentioned: !!evt.meta?.mentionedMe
	  };
	  // lightweight trace of *inputs* that shaped this reply
	  const _conv = { isDM: !!evt.meta?.isDM, isReply: !!evt.meta?.replyToMe, mentioned: !!evt.meta?.mentionedMe };
	  const _why = startWhy(evt);
	  whyAdd(evt, {
	    addressed: {
	    observer: !!guards.observer,
        reason: _conv.isDM ? 'dm' :
            _conv.isReply ? 'reply' :
            _conv.mentioned ? 'mention' :
            (/^[!.]/.test(text) ? 'command' : 'open')
        }
      });
	const emit = async (outText, meta = {}) => {
	  const allowed   = persona?.conduct?.allowed_emotes || [];
	  const allowPurr = persona?.conduct?.allow_purr ?? false;

	  // 1) start with the raw reply
	  let out = (outText ?? '').trim();
	  if (!out) return;

	  // 2) event guard on the raw text
	  const guarded = await guardEventAnnouncements(out, evt);
	  if (!guarded.ok) {
		out = guarded.text;
		whyPost(evt, { guardedEvent: true });
	  }

	  // 3) postfilters (sanitize → deaddress → concise)
	  const beforeLen = out.length;

	  out = sanitizeOut(out, { allowedEmotes: allowed, allowPurr });
	  out = deaddress(out, { isDM: conversation.isDM, isReply: conversation.isReply });
	  out = enforceConcise(out, {
		maxSentences: persona?.reply_prefs?.concise_sentences ?? 2,
		maxChars:     persona?.reply_prefs?.concise_max_chars ?? 280
	  });

	  if (!out) return;

	  const afterLen = out.length;
	  whyPost(evt, {
		trimmed: afterLen < beforeLen,
		deaddressed: !!evt.meta?.isDM || !!evt.meta?.replyToMe
	  });

	  // 4) deliver + log
	  await delayFor(out);
	  await io.send(evt.roomId, out, { hall: evt.hall, ...meta });

	  await memory?.noteAssistant?.(evt, out);
	  if (vmem?.indexTurn) vmem.indexTurn({ evt, role: 'assistant', text: out }).catch(() => {});
	};

	  // Observer: ignore unless addressed or it's a privileged command
	  if (guards.observer && !isAddressed(evt, text)) return;
	  // Feed conversational event wizard if active
	  if (hasWizard(evt) && !/^[!.]/.test(text)) {
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

	  if (/^!events\s+list\b/i.test(text)) {
	    const evs = await listEvents();
	    if (!evs.length) { await emit('No events found in the Codex.'); return; }
	    const lines = evs.slice(-5).map(e => `• ${e.date} — ${e.title}`);
	    await emit(`Latest events:\n${lines.join('\n')}`); return;
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

	 const capsText = summarizeCapabilities();
	 const capsCtx  = [{ title: 'Capabilities', text: capsText }];

	 const ctx = [...roleHints, ...moodHint, ...memoryCtx, ...userCtx, /* participantsCtx if you use it */ ...vCtx, ...ragCtx, ...capsCtx];
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
	  // Option A) calculator route for simple math/date phrasing
	  if (isCalcQuery(text)) {
	    const r = calcInline(text);
  	    if (r) { await emit(`≈ ${r}`); return; }
	  }

	  // Choose pipeline: normal vs deliberate
	  const wantReason = (process.env.REASONING_DEFAULT === 'on')
	    || /\b(why|compare|pros|cons|strategy|plan|steps|trade-?offs?)\b/i.test(text);

	  let reply;
	  if (wantReason) {
	    // confidence gate: if low, ask concise clarifier instead of guessing
	    const conf = ragConfidence([...vCtx, ...ragCtx], { min: 2, thresh: 0.55 });
	    if (!conf.ok) { await emit(lowConfidencePrompt({ question: 'what specific topic/source should I check?' })); return; }

	    reply = await deliberate({ _llm, evt, ctx, persona, speaker, conversation, caps: capsText,
		  cfg: { reasoning: { selfConsistency: 2, selfCheck: true }, temp: 0.6 } });
		const plan = (reply?.text || '').match(/^PLAN:\s*([a-z0-9_.-]+)(?:\s+(.*))?/i);
		if (plan) {
		  const capId = plan[1], args = plan[2] || '';
		  const cap = CAPABILITIES.find(c => c.id === capId);
		  if (!allowedFor(evt, cap, { guards })) { await emit('I can’t run that action here.', { noMoreHint: true }); return; }

		  switch (capId) {
			case 'events.add': {
			  const m = args.match(/"([^"]+)"\s+(\d{4}-\d{2}-\d{2})(?:\s+"([^"]+)")?/);
			  if (!m) { await emit('Usage: !event add "Title" YYYY-MM-DD "Optional description"'); return; }
			  const rec = await addEvent({ title: m[1], date: m[2], desc: m[3] || '', source: 'plan' });
			  await emit(`Event added: ${rec.title} on ${rec.date}. ✧`); return;
			}
			case 'events.list': {
			  const evs = await listEvents(); const lines = evs.slice(-5).map(e => `• ${e.date} — ${e.title}`);
			  await emit(lines.length ? `Latest events:\n${lines.join('\n')}` : 'No events in the Codex.'); return;
			}
			case 'events.sync': {
			  const guildId = evt.meta?.guildId || process.env.DISCORD_GUILD_ID;
			  if (!guildId) { await emit('Missing DISCORD_GUILD_ID.'); return; }
			  const s = await syncDiscordScheduledEvents(guildId);
			  await emit(`Synced Discord events. Added ${s.added} new.`); return;
			}
			case 'kb.reload': {
			  const ok = await _rag?.reload?.().catch(() => false);
			  await emit(ok ? 'Codex reloaded.' : 'Reload attempted.'); return;
			}
			case 'observer.set': {
			  const on = /\bon\b/i.test(args);
			  if (!guards.canObserver(evt)) { await emit('Only moderators or the Guild Master can change Observer.'); return; }
			  guards.observer = on; await emit(`Observer mode ${on ? 'ON' : 'OFF'}.`); return;
			}
		  }
		}

	  } else {
	    reply = await _llm.compose({ evt, ctx, persona, speaker, conversation, cfg });
	  }

	  await emit(reply?.text, reply?.meta);
    }
  }
}