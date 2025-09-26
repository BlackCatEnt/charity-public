import modCfg from '#codex/moderation.config.json' assert { type: 'json' };
import { readFile } from 'node:fs/promises';
import { helixDeleteMessage, helixTimeoutUser } from '#relics/helix.mjs';
import { logModAction } from '#rituals/modlog/writer.mjs';

const PACKS_DIR = 'codex/guard/packs';

const NUM = { '0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','8':'b' };
const ZW = /[\u200B-\u200D\uFEFF]/g;

function norm(s='') {
  return s.toLowerCase()
    .replace(ZW,'')
    .replace(/[^\p{L}\p{N}]+/gu,'')            // remove separators
    .replace(/[0134578]/g, m => NUM[m] || m);  // un-leetspeak
}

async function loadPack(name) {
  try {
    const raw = await readFile(`${PACKS_DIR}/${name}.txt`, 'utf8');
    const terms = raw.split(/\r?\n/).map(l => l.split('#')[0].trim()).filter(Boolean);
    const set = new Set(terms.map(norm).filter(Boolean));
    return { name, terms, set };
  } catch { return { name, terms: [], set: new Set() }; }
}

function findBanned(text, packs) {
  const n = norm(text);
  const hits = [];
  for (const { name, set } of packs) {
    for (const t of set) {
      if (!t || t.length < 3) continue;
      if (n.includes(t)) { hits.push({ pack: name, term: t }); break; }
    }
  }
  return hits;
}

function findLinks(text) {
  // very tolerant url detector incl. "dot" / spaces
  const dot = `[\\.:·•\\s]*(?:dot|\\.)[\\s]*`;
  const tld = `(?:com|net|org|gg|tv|io|dev|app|co|us|uk|ca|de|fr|au|nl|se|no|jp)\\b`;
  const p1 = new RegExp(`\\b(?:https?:\\/\\/)?[\\w-]{2,}${dot}${tld}`, 'i');
  const p2 = /\bhttps?:\/\/\S+/i;
  return p1.test(text) || p2.test(text);
}

function roleForTags(tags) {
  if (tags?.badges?.broadcaster === '1') return 'broadcaster';
  if (tags?.mod) return 'mod';
  if (tags?.badges?.vip === '1') return 'vip';
  return 'viewer';
}

export function createGuildGuard({ cfg = modCfg?.guild_guard, llm, channelName }) {
  const state = {
    lastAct: new Map(),              // userId -> ts (cooldown)
    permit: new Map(),               // login -> expires (ms)
    packs: []
  };

  async function ensurePacks() {
    if (state.packs.length) return state.packs;
    const need = [];
    if (cfg?.packs?.slurs) need.push(loadPack('slurs'));
    if (cfg?.packs?.sexual) need.push(loadPack('sexual'));
    state.packs = await Promise.all(need);
    return state.packs;
  }

  function cooled(userId) {
    const now = Date.now();
    const last = state.lastAct.get(userId) || 0;
    if (now - last < (cfg?.cooldown_ms ?? 15000)) return false;
    state.lastAct.set(userId, now);
    return true;
  }

  async function sassyExplain(evt, reason) {
    const prompt = `Write a one-line, playful but respectful moderation notice to @${evt.userName} for: ${reason}.
Do not reveal filters. No sarcasm at the user. Keep under ${cfg?.notice_style?.max_chars ?? 140} chars.`;
    if (!llm?.compose) return `Heads up @${evt.userName} — ${reason}. ✧`;
    const r = await llm.compose({
      evt: { ...evt, text: prompt },
      ctx: [],
      persona: { tone: { style: cfg?.notice_style?.tone || 'sassy, kind' } }
    });
    return (r?.text?.trim() || `Heads up @${evt.userName} — ${reason}. ✧`);
  }

  async function onMessage(evt, tags, io) {
    if (!cfg?.enabled) return false;

    const role = roleForTags(tags);
    const userId = String(tags['user-id'] || evt.userId || '');
    const text = evt.text || '';
    await ensurePacks();

    // 1) Links
    if (cfg?.links?.block && role !== 'broadcaster' && !state.permit.has(tags?.username)) {
      const isAllowedRole = cfg?.links?.allow_roles?.includes(role);
      const whitelisted = (cfg?.links?.allow_domains || []).some(d => new RegExp(`\\b${d.replace('.', '\\.')}\\b`, 'i').test(text));
      if (!isAllowedRole && !whitelisted && findLinks(text)) {
        if (!cooled(userId)) return true;
        // act
        if (evt.meta?.messageId) {
          try { await helixDeleteMessage({ msgId: evt.meta.messageId }); } catch {}
        }
        try { await helixTimeoutUser({ userId, secs: cfg?.timeout_sec ?? 300, reason: 'links blocked' }); } catch {}
        await logModAction({ evt, action: 'timeout', type: 'links', reason: 'link posting blocked by policy' });
        const line = await sassyExplain(evt, 'links aren’t allowed right now');
        await io.send(evt.roomId, line, { hall: 'twitch' });
        return true;
      }
    }

    // 2) Word packs
    const hits = findBanned(text, state.packs);
    if (hits.length) {
      if (!cooled(userId)) return true;
      if (evt.meta?.messageId) {
        try { await helixDeleteMessage({ msgId: evt.meta.messageId }); } catch {}
      }
      try { await helixTimeoutUser({ userId, secs: cfg?.timeout_sec ?? 300, reason: 'banned phrase' }); } catch {}
      await logModAction({ evt, action: 'timeout', type: 'banned', reason: hits.map(h => h.pack).join(',') });
      const line = await sassyExplain(evt, 'that phrase isn’t welcome in the Guild');
      await io.send(evt.roomId, line, { hall: 'twitch' });
      return true;
    }

    return false; // no action
  }

  // --- tiny commands (mods/GM) ---
  async function command(args, tags, io) {
    const role = roleForTags(tags);
    if (!(role === 'broadcaster' || role === 'mod')) return;

    const sub = (args[0] || '').toLowerCase();
    if (sub === 'status') {
      await io.send(channelName, `Guard: ${cfg?.enabled ? 'ON' : 'OFF'} | links: ${cfg?.links?.block ? 'BLOCK' : 'allow'} | packs: ${state.packs.map(p=>p.name).join('+') || 'none'}`, { hall: 'twitch' });
      return;
    }
    if (sub === 'on' || sub === 'off') {
      cfg.enabled = (sub === 'on');
      await io.send(channelName, `Guard ${cfg.enabled ? 'ENABLED' : 'DISABLED'}.`, { hall: 'twitch' });
      return;
    }
    if (sub === 'permit') {
      const who = (args[1] || '').toLowerCase().replace(/^@/,'');
      const secs = Math.max(10, parseInt(args[2] || '60', 10));
      if (!who) { await io.send(channelName, 'Usage: !guard permit <user> [secs]', { hall: 'twitch' }); return; }
      state.permit.set(who, Date.now() + secs * 1000);
      setTimeout(() => state.permit.delete(who), secs * 1000).unref?.();
      await io.send(channelName, `Permitted @${who} to post one link for ${secs}s.`, { hall: 'twitch' });
      return;
    }
  }

  return { onMessage, command };
}
