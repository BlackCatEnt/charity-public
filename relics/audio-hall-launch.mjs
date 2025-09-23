// A:\Charity\relics\audio-hall-launch.mjs
import { initAudioHall } from '../halls/audio/adapter.mjs';

// --- minimal IO adapter (replace with Twitch/Discord senders later) ---
const io = {
  async send(roomId, text, meta = {}) {
    if (!text) return;
    console.log('[Charity]', text);
    // TODO: forward to Twitch chat / Discord here.
  }
};

// --- Charity brain (router) ---
const router = createRouter({});

// --- bus shim: map speech.final → router.handle() ---
const bus = {
  async emit(type, payload) {
    if (type !== 'speech.final') return;
    const t = String(payload?.text || '').trim();
    if (!t) return;

    const tags = payload?.tags || {};
    const evt = {
      hall: 'audio',
      roomId: 'stream',            // any stable room id you prefer
      userId: 'asr',               // synthetic user id for ASR
      userName: tags.speaker || 'Caster',
      text: t,
      meta: { isDM: false }
    };
    try {
      await router.handle(evt, io);
    } catch (e) {
      console.error('[bus.emit] router.handle failed:', e?.message || e);
    }
  }
};

// --- start the hall server ---
const port = Number(process.env.HALL_PORT || 8130);
const default_tags = {
  origin: process.env.TAG_ORIGIN || 'stream',
  game:   process.env.TAG_GAME   || 'Unknown',
  scene:  process.env.TAG_SCENE  || 'Unknown',
  speaker:process.env.TAG_SPEAKER|| 'bagotrix'
};
initAudioHall(bus, { services: { audio: { port, default_tags } } });
