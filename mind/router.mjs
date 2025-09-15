import { delayFor } from '#mind/delays.mjs';
import { guards } from '#mind/guards.mjs';
import { tryRecordFeedback } from '#mind/feedback.mjs';
import { getRag, setRag } from '#mind/rag.store.mjs';
import { makeKeywordRag } from '#mind/rag.keyword.mjs';
import { nowInfo } from '#mind/time.mjs';
import { identify, canUseIAM, recordGuildmasterId, isGuildmaster } from '#mind/identity.mjs';
import { summarizeRecentAffect } from '#mind/affect.mjs';
import { startLink, completeLink } from '#mind/link.mjs';
import { sanitizeOut } from '#mind/postfilter.mjs';
import { guardEventAnnouncements } from '#mind/guard.events.mjs';


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
	  const emit = async (outText, meta = {}) => {
		const allowed = persona?.conduct?.allowed_emotes || [];
		const allowPurr = persona?.conduct?.allow_purr ?? false;

		let out = (outText ?? '').trim();

		// ⛳️ Event announcement guard
		const evt = await guardEventAnnouncements(out);
		if (!evt.ok) out = evt.text;

		// existing sanitizer
		out = sanitizeOut(out, { allowedEmotes: allowed, allowPurr });
		if (!out) return;

		await delayFor(out);
		await io.send(evt.roomId, out, { hall: evt.hall, ...meta });

		await memory?.noteAssistant?.(evt, out);
		if (vmem?.indexTurn) vmem.indexTurn({ evt, role: 'assistant', text: out }).catch(()=>{});
      };

		await delayFor(out);
		await io.send(evt.roomId, out, { hall: evt.hall, ...meta });

		// record + (optional) vector index
		await memory?.noteAssistant?.(evt, out);
		if (vmem?.indexTurn) vmem.indexTurn({ evt, role: 'assistant', text: out }).catch(()=>{});
	  };

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


      // Feedback capture: "fb good", "fb bad", or "fb +humor -verbose note: ... "
      if (isCurator && text.toLowerCase().startsWith('fb ')) {
        const ok = await tryRecordFeedback(evt, text, { source: 'chat' });
        if (ok) await io.send(evt.roomId, 'Noted.', { hall: evt.hall });
        return;
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
      // If observer is ON, ignore unless directly addressed or command
      const isAddressed = /^!ask\b/i.test(text) || /(^|[\s@])charity\b/i.test(text);
      if (guards.observer && !isAddressed) return;

      // ===== Normal pipeline =====
      if (!_safety.pass(evt)) return;

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

	  const ctx = [...roleHints, ...moodHint, ...memoryCtx, ...userCtx, ...vCtx, ...ragCtx];
	 
	  if (ctx?.length) console.log('[rag] ctx:', ctx.map(c => c.title));
	  if (/^!whoami\b/i.test(text)) {
		const promptEvt = { ...evt, text:
		  "Introduce yourself to the Guild in 2–3 lines using your bio and canon. " +
		  "Speak in your own voice, not as a definition. Avoid quoting bios verbatim."
      };
		const reply = await _llm.compose({ evt, ctx, persona, speaker, cfg, promptEvt });
		const out = (reply?.text ?? '').trim() || "I’m Charity, your guild guide and companion. ✧";
		await emit(out, (reply?.meta || {}));
		return;
      }
      const reply = await _llm.compose({ evt, ctx, persona, speaker, cfg });
	  await emit(reply?.text, reply?.meta);
	  }
    }
  };
}
