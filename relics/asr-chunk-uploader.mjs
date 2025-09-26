// Watches temp/asr_chunks/*.wav -> POST to ASR -> POST to audio hall with tags.
// Adds: clear error source, backoff on failure, rate limit to 1 chunk/s, skip tiny/silent chunks.

import fs from 'node:fs';
import path from 'node:path';

const CHUNK_DIR = path.resolve('temp/asr_chunks');
const ASR_URL   = process.env.ASR_URL  || 'http://127.0.0.1:8123/transcribe';
const HALL_URL  = process.env.HALL_URL || 'http://127.0.0.1:8130/asr';

const DEFAULT_TAGS = {
  origin: process.env.TAG_ORIGIN || 'stream',
  game:   process.env.TAG_GAME   || 'Unknown',
  scene:  process.env.TAG_SCENE  || 'Unknown',
  speaker:process.env.TAG_SPEAKER|| 'bagotrix'
};

const posted = new Set();
let lastPostTs = 0;
let backoffMs = 0;
const START_TS = Date.now();

function now() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function stableRead(full) {
  // wait until file size stabilizes (ffmpeg finished writing)
  let last = -1;
  for (let i = 0; i < 10; i++) {
    const st = fs.statSync(full);
    if (st.size > 2000 && st.size === last) return fs.readFileSync(full); // >~0.05s audio
    last = st.size;
    await sleep(120);
  }
  return fs.readFileSync(full);
}

async function postAsr(bytes) {
  // try raw bytes first
  let res;
  try {
    res = await fetch(ASR_URL, { method:'POST', headers:{'content-type':'audio/wav'}, body: bytes });
  } catch (e) {
    throw new Error(`ASR fetch error: ${e.message}`);
  }
  if (res.status === 400) {
    // retry as multipart if server said "too small/empty"
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'chunk.wav');
    try {
      res = await fetch(ASR_URL, { method:'POST', body: form });
    } catch (e) {
      throw new Error(`ASR fetch(multipart) error: ${e.message}`);
    }
  }
  if (!res.ok) throw new Error(`ASR HTTP ${res.status} ${await res.text()}`);
  return await res.json(); // {text, lang, duration}
}

async function postHall(json) {
  let res;
  try {
    res = await fetch(HALL_URL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(json) });
  } catch (e) {
    throw new Error(`HALL fetch error: ${e.message}`);
  }
  if (!res.ok) throw new Error(`HALL HTTP ${res.status} ${await res.text()}`);
  return await res.json();
}

async function tick() {
  try {
    if (backoffMs > 0) { await sleep(backoffMs); backoffMs = 0; }

    if (!fs.existsSync(CHUNK_DIR)) return;

    // process at most 1 chunk/sec: pick the newest ready chunk and skip the rest
    // list *.wav, filter out files older than launcher start, and sort by mtime
    const entries = fs.readdirSync(CHUNK_DIR)
      .filter(f => /^chunk_\d+\.wav$/.test(f))
      .map(f => {
        const full = path.join(CHUNK_DIR, f);
        const st = fs.statSync(full);
        return { full, mtime: st.mtimeMs, size: st.size };
      })
      // ignore anything that predates this process (stale from previous run)
      .filter(e => e.mtime >= START_TS - 2000)
      .sort((a, b) => a.mtime - b.mtime);
    if (!entries.length) return;
    const { full } = entries[entries.length - 1];

    if (posted.has(full)) return; // already processed

    // simple rate-limit (1/sec)
    if (now() - lastPostTs < 1000) return;

    const bytes = await stableRead(full);
    if (!bytes || bytes.length < 2500) { posted.add(full); return; } // very tiny -> skip

    const asr = await postAsr(bytes);
    const text = (asr?.text || '').trim();
    posted.add(full);
    lastPostTs = now();

    if (text) {
      await postHall({ text, lang: asr.lang || 'en', tags: DEFAULT_TAGS });
      console.log('[uploader]', text);
    }
  } catch (e) {
    console.warn('[uploader]', e.message);
    // gentle backoff to avoid console spam / hammering services
    backoffMs = Math.min(4000, (backoffMs || 500) * 2);
  }
}

setInterval(tick, 250);
console.log('[uploader] watching', CHUNK_DIR, 'ASR:', ASR_URL, 'HALL:', HALL_URL);
