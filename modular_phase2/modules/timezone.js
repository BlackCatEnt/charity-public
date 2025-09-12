import fs from 'fs';
import path from 'path';

export function createTimezone(CHARITY_CFG, logger) {
  const USER_PREFS_PATH = path.resolve('./data/user_prefs.json');
  let USER_PREFS = { tzByUserId: {} };
  function load() {
    try {
      USER_PREFS = JSON.parse(fs.readFileSync(USER_PREFS_PATH, 'utf8'));
      if (!USER_PREFS.tzByUserId) USER_PREFS.tzByUserId = {};
    } catch { USER_PREFS = { tzByUserId: {} }; }
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(USER_PREFS_PATH), { recursive: true });
      fs.writeFileSync(USER_PREFS_PATH, JSON.stringify(USER_PREFS, null, 2), 'utf8');
    } catch (e) { logger?.warn?.('Failed saving user_prefs.json: ' + (e?.message || e)); }
  }
  load();

  const DEFAULT_TZ = (CHARITY_CFG?.runtime?.timezone || process.env.TZ || 'America/New_York');

  function getUserTzFromTags(tags) {
    const uid = tags?.['user-id'];
    const t = uid && USER_PREFS.tzByUserId[uid];
    return t || DEFAULT_TZ;
  }

  function _getLocalParts(date = new Date(), tz = DEFAULT_TZ) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: true
    });
    const parts = fmt.formatToParts(date).reduce((m,p)=>{m[p.type]=p.value; return m;}, {});
    const hour24 = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(date));
    return {
      hour24,
      minute: parts.minute,
      wday: parts.weekday,
      mon: parts.month,
      day: parts.day,
      time: `${parts.hour}:${parts.minute} ${parts.dayPeriod || ''}`.trim().replace('  ', ' ')
    };
  }

  function daypartPhrase(hour24) {
    return (hour24 >= 18 && hour24 <= 23) ? 'tonight' : 'last night';
  }

  function localClockLine(tz = DEFAULT_TZ) {
    const p = _getLocalParts(new Date(), tz);
    return `Local time for you: ${p.wday} ${p.mon} ${p.day} ${p.time} (${tz})`;
  }

  function maybeTimeAwareRephrase(q, tz = DEFAULT_TZ) {
    if (!q) return q;
    const p = _getLocalParts(new Date(), tz);
    const phrase = daypartPhrase(p.hour24);
    if (/\b(last\s+night|tonight)\b/i.test(q)) return q;
    return q.replace(/\bgood\s+night\b/i, `good ${phrase}`)
            .replace(/\bthe\s+night\b/i, `${phrase}`)
            .replace(/\bnight\b/i, `${phrase}`);
  }

  function makeTimezoneCommands({ sayWithConsent, formatAddress }) {
    async function handleSetTzCommand(channel, tags, args) {
      const tz = (args || '').trim();
      if (!tz) return sayWithConsent(channel, tags, `${formatAddress(tags)} usage: !settz <IANA zone, e.g., Europe/London>`);
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        const uid = tags?.['user-id'];
        if (uid) { USER_PREFS.tzByUserId[uid] = tz; save(); }
        return sayWithConsent(channel, tags, `${formatAddress(tags)} set your timezone to ${tz}.`);
      } catch {
        return sayWithConsent(channel, tags, `${formatAddress(tags)} invalid timezone. Try something like America/Chicago or Europe/London.`);
      }
    }
    async function handleMyTimeCommand(channel, tags) {
      const tz = getUserTzFromTags(tags);
      return sayWithConsent(channel, tags, `${formatAddress(tags)} ${localClockLine(tz)}`);
    }
    return { handleSetTzCommand, handleMyTimeCommand };
  }

  return { getUserTzFromTags, _getLocalParts, daypartPhrase, localClockLine, maybeTimeAwareRephrase, makeTimezoneCommands, DEFAULT_TZ };
}
