// modular_phase2/modules/policy.js
// Response policy: short, sassy/authoritatively playful; utility answers stay concise.
// Works with addressing + topic modules you have now.

import { formatReply, formatUtility } from './style.js';
import { pickAddressee, sanitizeReplyAddressing } from './addressing.js';
import { getTopic, setTopic, clearTopic } from './convo_state.js';

function nowStrings() {
  const d = new Date();
  return {
    date: d.toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  };
}
function capLen(s, n = 220) {
  return (s && s.length > n) ? (s.slice(0, n - 1) + '…') : s;
}

/**
 * Decide a fast, lightweight reply without invoking the full reasoner.
 * Returns an action object so the caller can choose how to send.
 *
 * @param {{platform?: 'twitch'|'discord'|'youtube', channel?: string, tags?: any,
 *          text: string, classification: {intent: string, confidence?: number, source?: string, why?: string}}} p
 * @returns {{kind:'SAY'|'ASK'|'NONE', text?: string}}
 */
export function decide(p) {
  const platform = p.platform || 'twitch';
  const text = p.text || '';
  const intent = p.classification?.intent || 'smalltalk';

  const at = pickAddressee({
    authorLogin: (p.tags?.username || '').toLowerCase(),
    authorDisplay: p.tags?.['display-name'] || p.tags?.username || 'friend'
  });
  const topic = getTopic();

  let out = '';

  switch (intent) {
    case 'presence': {
      out = `${at} I’m here—watching the field. What’s up?`;
      break;
    }
    case 'greeting': {
      out = `${at} Hey. You checking in or bringing news?`;
      break;
    }
    case 'date': {
      const { date, time } = nowStrings();
      out = formatUtility('date', `${date} — ${time}`);
      break;
    }
    case 'weather': {
      // No weather tool yet—be honest, in-character.
      out = `${at} I can’t see the sky from this post, but I can wire a weather tool if you want.`;
      break;
    }
    case 'quest_planning': {
      setTopic('quest_planning');
      out = `${at} Pick one to shape: “Library Lanterns” (story hunt) or “Cinder Spire” (arena warm-up).`;
      break;
    }
    case 'switch_topic': {
      clearTopic();
      out = `${at} Switched. What do you want to tackle next?`;
      break;
    }
    case 'emote_reaction': {
      out = `${at} Noted. I see it.`;
      break;
    }
    case 'help': {
      out = `${at} Ask me about guild logistics, quests, schedules—or just chat. I’ll keep it brief.`;
      break;
    }
    case 'smalltalk':
    default: {
      if (/how\s+are\s+you/i.test(text)) {
        out = `${at} Focused. Sorting the roster and keeping watch. You?`;
      } else {
        out = `${at} I’m listening. Want logistics, ideas, or just chatter?`;
      }
      break;
    }
  }

  out = sanitizeReplyAddressing(out, at);
  out = capLen(out, platform === 'twitch' ? 220 : 400);

  // keep the lightweight API the router expects
  return out ? { kind: 'SAY', text: out } : { kind: 'NONE' };
}
