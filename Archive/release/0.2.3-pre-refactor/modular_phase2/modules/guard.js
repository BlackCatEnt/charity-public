// modules/guard.js
// Guild Guard Filters v0.1 — friendly moderation with lore-style warnings
import fs from 'fs';
import path from 'path';

export function createGuildGuard({
  cfg = {},
  logger,
  client,              // tmi client
  channel,             // "#bagotrix"
  sayWithConsent,      // (channel, tags, text)
  isBroadcasterUser,   // (tags) => boolean
  persist              // (nextCfgObj) => void  (writes runtime config)
}) {
  const state = {
    enabled: cfg.enabled !== false,
    cooldownMs: Number(cfg.cooldownMs ?? 20000),
    timeoutSec: Math.max(10, Math.min(1200, Number(cfg.timeoutSec ?? 300))),
    caps: { min_len: Number(cfg.caps?.min_len ?? 12), max_pct: Number(cfg.caps?.max_pct ?? 0.72) },
    emotes: { max: Number(cfg.emotes?.max ?? 20) },
    links: {
      policy: String(cfg.links?.policy || 'block'), // allow|warn|block
      allow_domains: Array.isArray(cfg.links?.allow_domains) ? cfg.links.allow_domains.slice(0, 50) : [],
      allow_roles: Array.isArray(cfg.links?.allow_roles) ? cfg.links.allow_roles.map(s => String(s).toLowerCase()) : ['broadcaster','mod','vip']
    },
    templates: {
      caps: String(cfg.templates?.caps || '🛡️ Easy there, {USER} — less shouting in the hall.'),
      emotes: String(cfg.templates?.emotes || '🛡️ {USER}, that’s a few too many emotes for one breath.'),
      link_blocked: String(cfg.templates?.link_blocked || '🛡️ {USER}, links aren’t allowed right now.'),
      banned: String(cfg.templates?.banned || '🛡️ {USER}, that phrase isn’t welcome in the Guild.')
    },
    banned: Array.isArray(cfg.banned) ? cfg.banned.slice(0, 300) : [],
    exceptions: Array.isArray(cfg.exceptions) ? cfg.exceptions.map(s => String(s).toLowerCase()) : [],
    packs: { slurs: !!cfg.packs?.slurs, sexual: !!cfg.packs?.sexual },
    lastWarnAtByUser: new Map(), // login -> ts
    strikesByUser: new Map(),    // login -> count (for escalations)
    obfusMatchers: [],
    // NEW: permits + promo handling
    permitDefaultSec: Number(cfg.permitDefaultSec ?? cfg.links?.permit_default_sec ?? 60),
    permits: new Map(),          // login -> expiresAt(ms)
    promoTimeoutSec: Math.max(0, Number(cfg.promoTimeoutSec ?? 0)) // 0 = no auto-timeout
  };
  // --- Obfuscated-word detection ------------------------------------------
  const L33T = { a:'a@4', b:'b8', e:'e3', i:'i1!|', l:'l1|', o:'o0', s:'s$5', t:'t7+', g:'g9', z:'z2' };
  const SEP = '[\\s\\W_]+'; // any gap: space, dot, underscore, symbols
  function escapeClassChar(c){ return c.replace(/[-\\^]/g,'\\$&'); }
  function clsFor(ch){
    const pool = L33T[ch] || ch;
    const uniq = [...new Set(pool.split(''))].map(escapeClassChar).join('');
    return `[${uniq}]`;
  }
  function buildObfusRegex(word) {
    const base = String(word || '').toLowerCase().replace(/[^a-z0-9]/g,'');
    if (base.length < 3) return null; // ignore too-short tokens
    const parts = [...base].map(ch => /[a-z]/.test(ch) ? clsFor(ch) : ch);
    const body = parts.join(`${SEP}?`); // optional gaps between letters
    // Non-alnum boundaries prevent matches inside larger innocent words
    const patt = `(?:^|[^A-Za-z0-9])${body}(?:[^A-Za-z0-9]|$)`;
    return new RegExp(patt, 'i');
  }
  function loadPack(relPath){
    try {
      const fp = path.resolve(process.cwd(), relPath);
      if (!fs.existsSync(fp)) return [];
      return fs.readFileSync(fp,'utf8')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('#'));
    } catch { return []; }
  }
  function compileObfusMatchers() {
    const terms = [];
    if (state.packs.slurs)   terms.push(...loadPack('config/guard_packs/slurs.txt'));
    if (state.packs.sexual)  terms.push(...loadPack('config/guard_packs/sexual.txt'));
    const uniq = [...new Set(terms.map(s => s.toLowerCase()))];
    state.obfusMatchers = uniq.map(buildObfusRegex).filter(Boolean);
    logger?.info?.(`[guard] compiled ${state.obfusMatchers.length} obfuscation matchers`);
  }
  compileObfusMatchers();

  // --- Permits --------------------------------------------------------------
  const now = () => Date.now();
  function isPermitted(tags) {
    const login = (tags.username || '').toLowerCase();
    const exp = state.permits.get(login) || 0;
    if (!exp) return false;
    if (exp <= now()) { state.permits.delete(login); return false; }
    return true;
  }
  function consumePermit(tags) {
    const login = (tags.username || '').toLowerCase();
    state.permits.delete(login); // one-shot by default; TTL is safety net
  }
  function grantPermit(login, sec) {
    const s = Math.max(10, Math.min(600, Number(sec || state.permitDefaultSec)));
    state.permits.set(String(login || '').toLowerCase(), now() + s * 1000);
    return s;
  }  
  function save() {
    try {
      persist && persist({ guard: exportCfg() });
    } catch (e) {
      logger?.warn?.('[guard] persist failed: ' + (e?.message || e));
    }
  }
  function exportCfg() {
    return {
      enabled: state.enabled,
      cooldownMs: state.cooldownMs,
      timeoutSec: state.timeoutSec,
      caps: state.caps,
      emotes: state.emotes,
      links: state.links,
      banned: state.banned,
	  exceptions: state.exceptions,
      packs: state.packs,
      templates: state.templates,
      permitDefaultSec: state.permitDefaultSec,
      promoTimeoutSec: state.promoTimeoutSec
    };
  }

  // ---------- helpers
  const LOWER = (s) => String(s || '').toLowerCase();

  function isModOrGM(tags) {
    return tags?.badges?.broadcaster === '1' || tags?.mod === true || tags?.badges?.moderator === '1';
  }
  function isVip(tags) {
    return tags?.badges?.vip === '1';
  }
  function allowedByRoleForLinks(tags) {
    const roles = new Set((state.links.allow_roles || []).map(LOWER));
    if (roles.has('broadcaster') && isBroadcasterUser?.(tags)) return true;
    if (roles.has('mod') && isModOrGM(tags)) return true;
    if (roles.has('vip') && isVip(tags)) return true;
    return false;
  }
  function hasLink(text) {
    return /(?:https?:\/\/|www\.)\S+/i.test(text || '');
  }
  function domainOf(urlish) {
    try {
      const u = urlish.startsWith('http') ? new URL(urlish) : new URL('http://' + urlish);
      return u.hostname.replace(/^www\./i, '').toLowerCase();
    } catch { return ''; }
  }
  function allowedDomain(text) {
    const allow = new Set((state.links.allow_domains || []).map(LOWER));
    const rx = /((?:https?:\/\/|www\.)\S+)/ig;
    let m;
    while ((m = rx.exec(text || ''))) {
      const d = domainOf(m[1]);
      if (!d || !allow.has(d) && ![...allow].some(ad => d.endsWith('.'+ad))) {
        return false; // found a domain not on the allow-list
      }
    }
    return true;
  }
  // Obfuscated "dot TLD" like "d0t c o m"
  function hasObfuscatedDotTld(text) {
    const rx = /d[\W_]*[o0][\W_]*t[\W_]*(?:c[\W_]*o[\W_]*m|c[\W_]*o\b|n[\W_]*e[\W_]*t|o[\W_]*r[\W_]*g|g[\W_]*g|r[\W_]*u|x[\W_]*y[\W_]*z|s[\W_]*i[\W_]*t[\W_]*e|l[\W_]*i[\W_]*n[\W_]*k)\b/i;
    return rx.test(text || '');
  }
  // Common promo-spam tells (combined with link/obf link)
  const PROMO_RXES = [
    /\b(?:increase|boost|grow)\s+(?:your|yr)\s+(?:viewers?|followers?|audience)\b/i,
    /\bfree\s+(?:viewers?|followers?|subs?)\b/i,
    /\bcheck\s+(?:stream\s+details|my\s+(?:bio|profile))\b/i,
    /\btop\s+streamers?\s+already\s+use\s+it\b/i
  ];
  function isPromoSpam(text) {
    const t = String(text || '');
    return (PROMO_RXES.some(rx => rx.test(t)) && (hasLink(t) || hasObfuscatedDotTld(t)));
  }  
  function capsRatio(text) {
    const letters = (text || '').match(/[A-Za-z]/g) || [];
    const uppers  = (text || '').match(/[A-Z]/g) || [];
    if (letters.length < state.caps.min_len) return 0;
    return uppers.length / letters.length;
  }
  function emoteCountFromTags(tags) {
    const em = tags?.emotes || null;
    if (!em) return 0;
    // tmi.js emotes: { id: [ '0-4', '6-10' ], ... }
    let total = 0;
    for (const k of Object.keys(em)) total += (em[k] || []).length;
    return total;
  }
  function withinCooldown(login) {
    const now = Date.now();
    const last = state.lastWarnAtByUser.get(login) || 0;
    if (now - last < state.cooldownMs) return true;
    state.lastWarnAtByUser.set(login, now);
    return false;
  }
  function fmt(tpl, tags) {
    const user = tags['display-name'] || tags.username || 'friend';
    return String(tpl || '').replaceAll('{USER}', user);
  }

  async function deleteMessage(tags) {
    try {
      const id = tags?.id || tags?.['id'];
      if (id && typeof client.deletemessage === 'function') {
        await client.deletemessage(channel, id);
        return true;
      }
    } catch (e) {
      logger?.warn?.('[guard] delete failed: ' + (e?.message || e));
    }
    return false;
  }
  async function timeoutUser(tags, seconds, reason) {
    try {
      const login = (tags.username || '').toLowerCase();
      // /timeout works if the bot is mod
      await client.say(channel, `/timeout ${login} ${Math.max(10, Math.min(1200, Number(seconds||state.timeoutSec)))} ${reason || 'policy violation'}`);
      return true;
    } catch (e) {
      logger?.warn?.('[guard] timeout failed: ' + (e?.message || e));
      return false;
    }
  }

  // ---------- message moderation
  async function onMessage(tags, text) {
    if (!state.enabled) return false;
    if (isBroadcasterUser?.(tags) || isModOrGM(tags)) return false; // never police GM/mods

    const login = (tags.username || '').toLowerCase();
    const lowText = String(text || '').toLowerCase();
    const skipForExceptions = state.exceptions.some(ex => lowText.includes(ex));

    // Silent cleanup: lone "undefined" (common spam/glitch)
    if (/^\s*undefined\s*$/i.test(lowText)) {
      await deleteMessage(tags);
      return true;
    }

    // Promo-spam (e.g., "increase your viewers — check stream details doT com"):
    if (isPromoSpam(text) && !allowedByRoleForLinks(tags) && !isPermitted(tags)) {
      await deleteMessage(tags);
      if (state.promoTimeoutSec > 0) await timeoutUser(tags, state.promoTimeoutSec, 'promo spam');
      return true;
    }

    // 1) banned terms (regex or plain)
    if (state.banned?.length) {
      for (const pat of state.banned) {
        if (!pat) continue;
        let hit = false;
        try {
          // allow simple strings or /regex/ syntax
          const m = /^\/(.+)\/([i]*)$/.exec(String(pat)); // stringified /regex/i allowed
          const rx = m ? new RegExp(m[1], m[2]) : new RegExp(String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          hit = rx.test(text || '');
        } catch {
          // if bad regex, fallback to includes
          hit = lowText.includes(String(pat).toLowerCase());
        }
        if (hit && !skipForExceptions) {
          await deleteMessage(tags);
          if (!withinCooldown(login)) await sayWithConsent(channel, tags, fmt(state.templates.banned, tags));
          const strikes = (state.strikesByUser.get(login) || 0) + 1;
          state.strikesByUser.set(login, strikes);
          if (strikes >= 2) await timeoutUser(tags, state.timeoutSec, 'banned phrase');
          return true;
        }
      }
    }
    // 1b) obfuscation-aware packs (slurs/sexual) with boundaries & leet
    if (state.obfusMatchers.length && !skipForExceptions) {
      for (const rx of state.obfusMatchers) {
        if (rx.test(lowText)) {
          await deleteMessage(tags);
          if (!withinCooldown(login)) await sayWithConsent(channel, tags, fmt(state.templates.banned, tags));
          const strikes = (state.strikesByUser.get(login) || 0) + 1;
          state.strikesByUser.set(login, strikes);
          if (strikes >= 2) await timeoutUser(tags, state.timeoutSec, 'banned phrase');
          return true;
        }
      }
    }
        // 2) links (incl. obfuscated-dot)
    if (state.links.policy !== 'allow' && (hasLink(text || '') || hasObfuscatedDotTld(text || ''))) {
      if (isPermitted(tags)) { consumePermit(tags); return false; } // allow once; TTL remains as grace
      if (!allowedByRoleForLinks(tags) && !allowedDomain(text || '')) {
        await deleteMessage(tags);
        if (state.links.policy === 'block' && !withinCooldown(login)) {
          await sayWithConsent(channel, tags, fmt(state.templates.link_blocked, tags));
        }
        // (policy 'warn' could just allow but warn — current impl blocks by default)
        return true;
      }
    }

    // 3) caps
    if (capsRatio(text || '') >= state.caps.max_pct) {
      await deleteMessage(tags);
      if (!withinCooldown(login)) await sayWithConsent(channel, tags, fmt(state.templates.caps, tags));
      return true;
    }

    // 4) emotes
    const emotes = emoteCountFromTags(tags);
    if (emotes > state.emotes.max) {
      await deleteMessage(tags);
      if (!withinCooldown(login)) await sayWithConsent(channel, tags, fmt(state.templates.emotes, tags));
      return true;
    }

    return false; // no action
  }

  // ---------- commands: !guard ...
  async function handleCommand(args, tags) {
    if (!(isBroadcasterUser?.(tags) || isModOrGM(tags))) {
      await sayWithConsent(channel, tags, 'Only the Guild Master or mods can change the guard.');
      return;
    }
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'on')  { state.enabled = true;  save(); return sayWithConsent(channel, tags, '🛡️ Guild Guard enabled.'); }
    if (sub === 'off') { state.enabled = false; save(); return sayWithConsent(channel, tags, '🛡️ Guild Guard disabled.'); }
    if (sub === 'status') {
      const parts = [
        `enabled=${state.enabled}`,
        `caps>${Math.round(state.caps.max_pct*100)}%/${state.caps.min_len}+`,
        `emotes<=${state.emotes.max}`,
        `links=${state.links.policy} (${state.links.allow_domains.length} allow)`,
        `banned=${state.banned.length} patt.`,
        `timeout=${state.timeoutSec}s`
      ];
      return sayWithConsent(channel, tags, '🛡️ Guard: ' + parts.join(' | '));
    }
    if (sub === 'links' && args[1]) {
      const v = String(args[1]).toLowerCase();
      if (!/^(allow|warn|block)$/.test(v)) return sayWithConsent(channel, tags, 'Usage: !guard links <allow|warn|block>');
      state.links.policy = v; save();
      return sayWithConsent(channel, tags, `Links policy set to ${v}.`);
    }
    if (sub === 'caps' && args[1]) {
      const pct = Math.max(50, Math.min(100, parseInt(args[1], 10) || 72));
      state.caps.max_pct = pct / 100; save();
      return sayWithConsent(channel, tags, `Caps threshold set to ${pct}%.`);
    }
    if (sub === 'timeout' && args[1]) {
      const sec = Math.max(10, Math.min(1200, parseInt(args[1], 10) || state.timeoutSec));
      state.timeoutSec = sec; save();
      return sayWithConsent(channel, tags, `Timeout set to ${sec}s.`);
    }
    if (sub === 'addword' && args[1]) {
      const pat = args.slice(1).join(' ').trim();
      if (!pat) return sayWithConsent(channel, tags, 'Usage: !guard addword <pattern or /regex/i>');
      if (!state.banned.includes(pat)) state.banned.push(pat);
      save();
      return sayWithConsent(channel, tags, `Added banned pattern (#${state.banned.length}).`);
    }
    if (sub === 'rmword' && args[1]) {
      const pat = args.slice(1).join(' ').trim();
      const before = state.banned.length;
      state.banned = state.banned.filter(x => String(x) !== pat);
      save();
      return sayWithConsent(channel, tags, before === state.banned.length ? 'No exact match.' : 'Removed.');
    }
    if (sub === 'list') {
      const first = state.banned.slice(0, 5).join(', ') || '(none)';
      const more = state.banned.length > 5 ? ` (+${state.banned.length-5} more)` : '';
      return sayWithConsent(channel, tags, `Banned patterns: ${first}${more}`);
    }
	if (sub === 'packs' && args[1]) {
      const which = String(args[1]).toLowerCase();
      const val = String(args[2]||'').toLowerCase();
      if (!/^(slurs|sexual)$/.test(which) || !/^(on|off)$/.test(val)) {
        return sayWithConsent(channel, tags, 'Usage: !guard packs <slurs|sexual> <on|off>');
      }
      state.packs[which] = (val === 'on');
      compileObfusMatchers(); save();
      return sayWithConsent(channel, tags, `Pack ${which} turned ${val}.`);
    }
    if (sub === 'exception' && args[1]) {
      const term = args.slice(1).join(' ').trim().toLowerCase();
      if (!term) return sayWithConsent(channel, tags, 'Usage: !guard exception <word>');
      if (!state.exceptions.includes(term)) state.exceptions.push(term);
      save();
      return sayWithConsent(channel, tags, `Added exception: ${term}`);
    }

    return sayWithConsent(channel, tags, 'Usage: !guard on|off|status | links <allow|warn|block> | caps <50-100> | timeout <sec> | addword <pat> | rmword <pat> | list');
  }
  // ---------- command: !permit <user> [sec]
  async function handlePermitCommand(args, tags) {
    if (!(isBroadcasterUser?.(tags) || isModOrGM(tags))) {
      await sayWithConsent(channel, tags, 'Only the Guild Master or mods can permit links.');
      return;
    }
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'list') {
      const items = [...state.permits.entries()]
        .map(([login, exp]) => `${login}(${Math.max(0, Math.ceil((exp-now())/1000))}s)`);
      return sayWithConsent(channel, tags, items.length ? `Permits: ${items.join(', ')}` : 'No active permits.');
    }
    if (sub === 'clear') {
      state.permits.clear();
      return sayWithConsent(channel, tags, 'Cleared all permits.');
    }
    // main: !permit <user> [sec]
    const who = (args[0] || '').replace(/^@/,'');
    if (!who) return sayWithConsent(channel, tags, 'Usage: !permit <user> [sec]');
    const sec = Math.max(10, Math.min(600, parseInt(args[1] || state.permitDefaultSec, 10) || state.permitDefaultSec));
    const s = grantPermit(who, sec);
    return sayWithConsent(channel, tags, `Permitted @${who} to post a link for ${s}s.`);
  }

   return {
     onMessage,
     handleCommand,
     handlePermitCommand,
     exportCfg,
     shutdown() {}
   };
 }