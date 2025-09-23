// A:\Charity\halls\audio\adapter.mjs
import express from 'express';

export async function initAudioHall(io, cfg = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const port = cfg?.services?.audio?.port ?? 8130;
  const defaultTags = cfg?.services?.audio?.default_tags ?? {
    origin: 'stream', game: 'Unknown', scene: 'Unknown', speaker: 'Unknown'
  };

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/asr', async (req, res) => {
    const { text, lang, tags } = req.body || {};
	console.log('[audio-hall] got:', { text, lang, tags });
    const content = String(text || '').trim();
    if (!content) return res.status(400).json({ ok:false, error:'missing text' });

    try {
      // hand off to the brain
      await io.ingest({
        hall: 'audio',
        roomId: 'stream',
        userId: 'asr',
        userName: (tags?.speaker || defaultTags.speaker || 'Caster'),
        text: content,
        meta: { isDM: false, lang: (lang || 'en'), tags: { ...defaultTags, ...(tags || {}) } }

      });
      res.json({ ok:true });
    } catch (e) {
      console.error('[audio-hall] ingest failed:', e?.message || e);
      res.status(500).json({ ok:false, error:'ingest failed' });
    }
  });

  const server = app.listen(port, () => {
    console.log(`[audio-hall] http://127.0.0.1:${port}/asr  tags:`, defaultTags);
  });

  // ⬅️ IMPORTANT: Audio hall does not send outbound messages anywhere.
  return {
    send: async () => { /* no-op: prevents recursion */ },
    stop: () => server.close()
  };
}
