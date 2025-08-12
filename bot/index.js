import tmi from 'tmi.js';
import dotenv from 'dotenv';
import fs from 'fs';
import axios from 'axios';
import path from 'path';
import chokidar from 'chokidar';
import winston from 'winston';
dotenv.config();
import { loadTokenState, validateToken, refreshToken, saveTokenState, getTokenStatus } from './token.js';

const CHANNEL = process.env.TWITCH_CHANNEL;
const BOT_USERNAME = process.env.TWITCH_BOT_USERNAME;
let OAUTH = process.env.TWITCH_OAUTH;
// tmi.js requires tokens in the form 'oauth:<token>'
if (OAUTH && !OAUTH.startsWith('oauth:')) OAUTH = `oauth:${OAUTH}`;
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'llama3.1:8b-instruct-q4_K_M';
const BROADCASTER = process.env.TWITCH_BROADCASTER || CHANNEL;
const TOKEN_ALERT_MIN = parseInt(process.env.TOKEN_ALERT_MINUTES || '60', 10);
const TOKEN_CHECK_EVERY_MIN = parseInt(process.env.TOKEN_CHECK_INTERVAL_MINUTES || '15', 10);


if (!CHANNEL || !BOT_USERNAME || !OAUTH) {
  console.error('Missing required env vars. See .env.example');
  process.exit(1);
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: './logs/bot.log' }),
    new winston.transports.Console()
  ]
});

// Load KB index
let KB = { docs: [] };
const KB_PATH = path.resolve('./data/kb_index.json');
function loadKB() {
  try { KB = JSON.parse(fs.readFileSync(KB_PATH, 'utf8')); logger.info(`KB loaded: ${KB.docs.length} chunks`); }
  catch { logger.warn('KB not indexed yet. Run: npm run index-kb'); KB = { docs: [] }; }
}
loadKB();

// Hot-reload when index file changes
chokidar.watch(KB_PATH).on('change', () => {
  logger.info('KB index changed; reloading...');
  loadKB();
});

// Simple cosine similarity
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-8);
}

async function embed(text) {
  const { data } = await axios.post(`${OLLAMA}/api/embeddings`, { model: process.env.EMBED_MODEL || 'nomic-embed-text', prompt: text });
  return data.embedding;
}

async function retrieve(query, k=3) {
  if (!KB.docs?.length) return [];
  const qvec = await embed(query);
  const scored = KB.docs.map(d => ({ ...d, score: cosine(qvec, d.vec) }));
  scored.sort((a,b) => b.score - a.score);
  return scored.slice(0, k);
}

async function generate(context, userQuestion) {
  const system = `You are the Twitch bot "charity_the_adventurer" for the channel "${CHANNEL}". 
Answer ONLY using the provided context. If the answer isn't there, say you're not sure and suggest !faq. 
Keep replies to 1–2 short sentences.`;

  const prompt = `Context:\n${context}\n\nQuestion: ${userQuestion}`;

  const { data } = await axios.post(`${OLLAMA}/api/chat`, {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    stream: false
  }, { timeout: 60000 });

  const msg = data?.message?.content || (data?.messages?.slice(-1)[0]?.content) || '';
  return msg.trim();
}

// Cooldowns
const lastByUser = new Map();
const USER_COOLDOWN_MS = 20_000; // 20s

const client = new tmi.Client({
  identity: { username: BOT_USERNAME, password: OAUTH },
  channels: [ CHANNEL ]
});

client.connect().then(() => logger.info(`Connected as ${BOT_USERNAME}, joined #${CHANNEL}`))
  .catch(err => { logger.error(`TMI connect failed: ${err}`); process.exit(1); });

client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  const text = message.trim();
  const user = tags['display-name'] || tags.username;

  // Simple commands (instant from files, no LLM)
  if (text === '!rules') { client.say(channel, `@${user} Please be kind, avoid spoilers, and respect the mods. More: !faq`); return; }
  if (text === '!schedule') { client.say(channel, `@${user} Tue & Thu 8–11 PM, Sat 2–5 PM (ET). Check panel for updates.`); return; }
  if (text === '!reloadkb' && (tags.mod || tags.badges?.broadcaster === '1')) { loadKB(); client.say(channel, `KB reloaded.`); return; }

  const askPrefix = '!ask ';
  const isMention = text.toLowerCase().includes(`@${BOT_USERNAME.toLowerCase()}`);
  const isAsk = text.toLowerCase().startsWith(askPrefix);

  if (!(isAsk || isMention)) return;

  // cooldown
  const now = Date.now();
  const last = lastByUser.get(user) || 0;
  if (now - last < USER_COOLDOWN_MS) return;
  lastByUser.set(user, now);

  const question = isAsk ? text.slice(askPrefix.length) : text.replace(new RegExp(`@${BOT_USERNAME}\s*`, 'i'), '').trim();
  if (!question) return;

  try {
    const hits = await retrieve(question, 3);
    const context = hits.map(h => `(${h.file}) ${h.text}`).join('\n---\n');
    const answer = await generate(context, question);
    const reply = answer || "I'm not sure—try !faq for more info.";
    client.say(channel, `@${user} ${reply}`);
    logger.info(`Answered ${user}: ${question} => ${reply}`);
  } catch (err) {
    logger.error(`Error answering: ${err}`);
  }
});


// --- Privileged Command Helpers ---
function isBroadcaster(tags) { return tags.badges?.broadcaster === '1'; }
function isMod(tags) { return !!tags.mod || tags.badges?.moderator === '1'; }
function isPrivileged(tags) { return isBroadcaster(tags) || isMod(tags); }
async function whisper(client, username, text) { try { await client.whisper(username, text); return true; } catch (e) { return false; } }

// --- !tokenstatus Command ---
client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  const text = message.trim().toLowerCase();
  const user = tags['display-name'] || tags.username;
  if (text === '!tokenstatus' && isPrivileged(tags)) {
    const s = getTokenStatus?.();
    const label = s?.valid ? 'valid' : 'invalid';
    const mins = s?.minutesRemaining != null ? `${Math.max(0, Math.round(s.minutesRemaining))} min` : 'unknown';
    const exp = s?.expiresAt ? new Date(s.expiresAt).toISOString() : 'unknown';
    const msg = `[token] status=${label}, expires_in=${mins}, expires_at=${exp}`;
    const sent = await whisper(client, user, msg);
    if (!sent) client.say(channel, `@${user} Enable whispers to receive token status details.`);
  }
});


// --- Token monitor & auto-refresh ---
async function reconnectWithToken(newToken) {
  // Update env var and in-memory OAUTH for new connections
  let tok = newToken;
  if (tok && !tok.startsWith('oauth:')) tok = `oauth:${tok}`;
  // Update client identity on reconnect
  try {
    await client.disconnect();
  } catch {}
  client.opts.identity.password = tok;
  try {
    await client.connect();
    logger.info('Reconnected with refreshed token.');
  } catch (e) {
    logger.error('Reconnect failed after refresh: ' + e);
  }
}

async function tokenCheckLoop() {
  let st = loadTokenState();
  if (st.access_token) {
    const v = await validateToken(st.access_token);
    if (v.ok) {
      const mins = v.minutesRemaining ?? 0;
      if (!st.expires_at) { st.expires_at = v.expires_at; saveTokenState(st); }
      if (mins <= TOKEN_ALERT_MIN) {
        const iso = new Date(v.expires_at).toISOString();
        const ok = await whisper(client, BROADCASTER, `[token] expires in ~${mins} min (at ${iso}). Attempting refresh...`);
        if (!ok) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token expiry warning sent. Enable whispers for details.');
        const r = await refreshToken(st);
        if (r.ok) {
          st = r.state;
          const ok2 = await whisper(client, BROADCASTER, `[token] refresh succeeded. Next expiry ~${Math.round((st.expires_at - Date.now())/60000)} min (${new Date(st.expires_at).toISOString()}). Reconnecting...`);
          if (!ok2) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token refresh success. Enable whispers for details.');
          await reconnectWithToken(st.access_token);
        } else {
          const ok3 = await whisper(client, BROADCASTER, `[token] refresh FAILED: ${JSON.stringify(r.error).slice(0,200)}. Please run 'twitch refresh -r <refresh_token>' and update .env.`);
          if (!ok3) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token refresh failed. Check logs.');
        }
      }
    } else {
      const ok = await whisper(client, BROADCASTER, `[token] invalid/expired token. Attempting refresh...`);
      if (!ok) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token invalid; attempting refresh.');
      const r = await refreshToken(st);
      if (r.ok) {
        st = r.state;
        const ok2 = await whisper(client, BROADCASTER, `[token] refresh succeeded after invalidation. Reconnecting...`);
        if (!ok2) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token refreshed. Enable whispers for details.');
        await reconnectWithToken(st.access_token);
      } else {
        const ok3 = await whisper(client, BROADCASTER, `[token] refresh FAILED: ${JSON.stringify(r.error).slice(0,200)}. Manual intervention required.`);
        if (!ok3) client.say('#' + CHANNEL, '@' + BROADCASTER + ' token refresh failed. Check logs.');
      }
    }
  }
  setTimeout(tokenCheckLoop, TOKEN_CHECK_EVERY_MIN * 60 * 1000);
}
// Start after initial connection
client.on('connected', () => { setTimeout(tokenCheckLoop, 10_000); });
