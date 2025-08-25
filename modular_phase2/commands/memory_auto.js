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

    // pull candidate episodes & facts
    const { hits: eps = [] } = await episodic.searchUserEpisodes({
      tags, embedder, query: 'what they care about recently', topK: 4
    });
    const facts =
      episodic.getProfileFactsCombined?.(tags, 8) ||
      episodic.getFactsByTags?.(tags, 8) ||
      [];

    // pick best path (fact vs recent episode)
    const choice = speaker.chooseReplyPath({ facts, episodes: eps, minConf: 0.6 });

    const name = tags['display-name'] || tags.username || 'friend';
    let line;

    if (choice.kind === 'recall') {
      const v = String(choice.fact.v ?? '').trim() || 'that topic';
      const when = daysAgo(choice.fact.last_seen || choice.fact.first_seen);
      const opts = [
        `I remember you’re into ${v} — ${when}.`,
        `Last we talked you mentioned ${v}.`,
        `Noted: you like ${v} (${when}).`,
        `I kept a note you enjoy ${v}.`
      ];
      line = pickPhrase(tags['user-id'] || 0, opts);

    } else if (choice.kind === 'episode') {
      const line1 = speaker.lineFor({
        display: tags['display-name'] || tags.username,
        episode: choice.ep,
        confidence: choice.ep.score || 0,
        minConfidence: 0.6,
        repeatSupport: 1,
        includeName: false
      });
      line = line1 || `I noted a recent topic you brought up—care to dig in?`;

    } else {
      line = `I don’t know your tastes yet — tell me one thing you’re into!`;
    }

    console?.info?.(
      `[trace] !me path=${choice.kind} fact=${choice?.fact?.k || ''} epScore=${choice?.ep?.score || ''}`
    );
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

  async function handlePrivacy(channel, tags) {
    return sayWithConsent(channel, tags, `${formatAddress(tags)} I keep lightweight notes to personalize chat. Commands: !me | !optout | !optin | !forgetme | !profile`);
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
    const facts = episodic.getProfileFactsCombined?.(tags, 8) || [];
    if (!facts.length) {
      return sayWithConsent(channel, tags,
        `${formatAddress(tags)} I don’t have your long-term profile yet—teach me with !remember key: value`);
    }
    const byKey = Object.fromEntries(facts.map(f => [f.k, f]));
    let opener = '';
    if (byKey.when_we_met?.v) opener = `since ${byKey.when_we_met.v}`;
    const nice = facts.find(f => f.k !== 'when_we_met');
    return sayWithConsent(
      channel, tags,
      `${formatAddress(tags)} ${opener ? `We’ve quested together ${opener}. ` : ''}${nice ? `You’re into ${nice.k.replace(/_/g,' ')} — ${nice.v}.` : ''}`
    );
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
