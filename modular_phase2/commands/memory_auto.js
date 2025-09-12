// commands/memory_auto.js
export function createAutoMemoryCommands({
  episodic, embedder, speaker,
  sayWithConsent, formatAddress,
  hasSubOrMod, moderateFactInput,
  isBroadcasterUser
}) {

  function daysAgo(ts) {
    const d = Math.max(0, (Date.now() - (ts || 0)) / 86400000);
    if (d < 1) return 'earlier today';
    if (d < 2) return 'yesterday';
    if (d < 7) return `${Math.round(d)} days ago`;
    if (d < 30) return 'recently';
    if (d < 60) return 'a while back';
    return 'a while back';
  }
  function pickPhrase(seed, options) {
    const idx = Math.abs((Number(seed) || 0) % options.length);
    return options[idx];
  }
  function scoreFact(f) {
    const DAY = 86400000;
    const ageDays = Math.max(0, (Date.now() - (f.last_seen || f.first_seen || 0)) / DAY);
    const recency = Math.max(0.35, 1 - (ageDays / 60)); // soft decay over 60d
    const conf = Math.max(0.4, (f.confidence || f.score || 0.6));
    const lockBoost = f.locked ? 0.1 : 0.0;
    return recency * conf + lockBoost;
  }

async function handleMe(channel, tags) {
  if (episodic?.isOptedOut?.(tags)) {
    return sayWithConsent(channel, tags,
      `${formatAddress(tags)} You’re opted out of personalization — use !optin anytime.`);
  }

  // Pull a broader set, then score/sort newest-first
  const facts =
    episodic.getProfileFactsCombined?.(tags, 16) ||
    episodic.getFactsByTags?.(tags, 16) || [];

  if (!facts.length) {
    return sayWithConsent(channel, tags,
      `${formatAddress(tags)} I don’t have much yet—tell me one thing you’re into!`);
  }

  const scored = facts.map(f => ({
    ...f,
    _s: scoreFact(f),                       // recency + confidence
    _t: f.last_seen || f.first_seen || 0,   // timestamp for tie-break
  }))
  .sort((a, b) => (b._s - a._s) || (b._t - a._t));

  // Skip boilerplate keys like when_we_met
  const top = scored.filter(f => f.k !== 'when_we_met').slice(0, 3);

  const bits = top.map(f => {
    const key = f.k.replace(/_/g, ' ');
    const val = String(f.v ?? '').trim();
    return `${key} — ${val}`;
  });

  const line = bits.length
    ? `Here’s what’s top of mind: ${bits.join(' • ')}.`
    : `I don’t know your tastes yet — tell me one thing you’re into!`;

  return sayWithConsent(channel, tags, `${formatAddress(tags)} ${line}`);
}


  async function handleOptOut(channel, tags) {
    episodic.setOptOutByTags(tags, true);
    return sayWithConsent(channel, tags,
      `${formatAddress(tags)} Got it — I won’t keep personal notes. (Use !optin anytime.)`);
  }

  async function handleOptIn(channel, tags) {
    episodic.setOptOutByTags(tags, false);
    return sayWithConsent(channel, tags,
      `${formatAddress(tags)} Thanks! I’ll remember small preferences to chat better.`);
  }

  async function handleForgetMe(channel, tags) {
    episodic.forget(tags);
    return sayWithConsent(channel, tags,
      `${formatAddress(tags)} Wiped your profile & episodes for this channel.`);
  }

// replace the whole handlePrivacy() with this
async function handlePrivacy(channel, tags) {
  const on = !episodic?.isOptedOut?.(tags);
  return sayWithConsent(
    channel,
    tags,
    `${formatAddress(tags)} Memory: ${on ? 'on' : 'off'}. cmds: !me !profile !optout !optin !forgetme`
  );
}

  // natural-language “remember key: value”
  async function handleRemember(channel, tags, text) {
    if (!hasSubOrMod?.(tags)) {
      return sayWithConsent(channel, tags,
        `${formatAddress(tags)} Profile editing is for subscribers and mods. Whisper a mod or subscribe to add long-term notes.`);
    }
    const m = /^!remember\s+([^:]{1,40}):\s*(.{1,200})/i.exec(text || '');
    if (!m) return sayWithConsent(channel, tags, `${formatAddress(tags)} Use: !remember key: value`);
    const rawKey = m[1], rawVal = m[2];
    const ok = moderateFactInput ? moderateFactInput(rawKey, rawVal, tags)
                                 : { ok:true, key:rawKey.trim(), value:rawVal.trim() };
    if (!ok.ok) return sayWithConsent(channel, tags, `${formatAddress(tags)} ${ok.msg}`);
    episodic.upsertFactByTags(tags, ok.key, ok.value, { confidence: 0.9, locked: true });
    return sayWithConsent(channel, tags, `${formatAddress(tags)} Noted ${ok.key.replace(/_/g,' ')} → “${ok.value}”.`);
  }

  async function handleForgetFact(channel, tags, text) {
    if (!hasSubOrMod?.(tags)) {
      return sayWithConsent(channel, tags,
        `${formatAddress(tags)} Only subscribers/mods can remove profile facts.`);
    }
    const m = /^!forgetfact\s+(.{1,40})$/i.exec(text || '');
    if (!m) return sayWithConsent(channel, tags, `${formatAddress(tags)} Use: !forgetfact key`);
    const key = m[1].trim().toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
    const ok = episodic.forgetFactByTags(tags, key);
    return sayWithConsent(channel, tags,
      `${formatAddress(tags)} ${ok ? `Forgot ${key.replace(/_/g,' ')}` : `I didn’t have ${key.replace(/_/g,' ')}`}.`);
  }


async function handleProfile(channel, tags) {
  const facts = episodic.getProfileFactsCombined?.(tags, 24) || [];
  if (!facts.length) {
    return sayWithConsent(channel, tags,
      `${formatAddress(tags)} I don’t have your long-term profile yet—teach me with !remember key: value`);
  }

  const byKey = Object.fromEntries(facts.map(f => [f.k, f]));
  const opener = byKey.when_we_met?.v ? `We’ve quested together since ${byKey.when_we_met.v}. ` : '';

  const sorted = facts
    .filter(f => f.k !== 'when_we_met')
    .map(f => ({ ...f, _s: scoreFact(f), _t: f.last_seen || f.first_seen || 0 }))
    .sort((a, b) => (b._s - a._s) || (b._t - a._t));

  const nice = sorted[0];
  const line = nice
    ? `${opener}You’re into ${nice.k.replace(/_/g, ' ')} — ${String(nice.v).trim()}.`
    : `I’m still learning your long-term preferences.`;

  return sayWithConsent(channel, tags, `${formatAddress(tags)} ${line}`);
}


  return {
    handleMe,
    handleOptOut,
    handleOptIn,
    handleForgetMe,
    handlePrivacy,
    handleRemember,
    handleForgetFact,
    handleProfile
  };
}
