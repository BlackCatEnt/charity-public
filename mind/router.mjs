import { delayFor } from '#mind/delays.mjs';
import { guards } from '#mind/guards.mjs';
import { tryRecordFeedback } from '#mind/feedback.mjs';
import { getRag, setRag } from '#mind/rag.store.mjs';
import { makeKeywordRag } from '#mind/rag.keyword.mjs';


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

export function createRouter({ memory, rag, llm, safety, persona, cfg } = {}) {
  const _safety = safety ?? defaultSafety();
  const _rag    = rag    ?? defaultRag();
  const _llm    = llm    ?? defaultLLM();

  return {
    async handle(evt, io) {
      // ===== Training / Observer quick commands (curators only) =====
      const isCurator = guards.isCurator(evt);
      const text = evt.text?.trim() || '';

      // Observer toggle: "!observer on|off|status"
      if (isCurator && /^!observer\b/i.test(text)) {
        const mode = (text.split(/\s+/)[1] || '').toLowerCase();
        if (mode === 'on' || mode === 'off') {
          guards.observer = (mode === 'on');
          await io.send(evt.roomId, `Observer mode ${guards.observer ? 'ON' : 'OFF'}.`, { hall: evt.hall });
        } else {
          await io.send(evt.roomId, `Observer is ${guards.observer ? 'ON' : 'OFF'}.`, { hall: evt.hall });
        }
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


      // Feedback capture: "fb good", "fb bad", or "fb +humor -verbose note: ... "
      if (isCurator && text.toLowerCase().startsWith('fb ')) {
        const ok = await tryRecordFeedback(evt, text, { source: 'chat' });
        if (ok) await io.send(evt.roomId, 'Noted.', { hall: evt.hall });
        return;
      }

      // If observer is ON, ignore unless directly addressed or command
      const isAddressed = /^!ask\b/i.test(text) || /(^|[\s@])charity\b/i.test(text);
      if (guards.observer && !isAddressed) return;

      // ===== Normal pipeline =====
      if (!_safety.pass(evt)) return;

      const activeRag = getRag() || _rag;
      const ctx = await (activeRag?.context?.(evt, memory) ?? []);
	  if (ctx?.length) console.log('[rag] ctx:', ctx.map(c => c.title));
      const reply = await _llm.compose({ evt, ctx, persona, cfg });

      const out = (reply?.text ?? '').trim();
      if (!out) return; // nothing to say

      await delayFor(out); // human-like pacing
      await io.send(evt.roomId, out, { hall: evt.hall, ...(reply?.meta || {}) });
    }
  };
}
