// Response policy: short, sassy/authoritatively playful; utility answers stay concise.
// Works with addressing + topic modules you have now.
import { formatReply, formatUtility } from './style.js';
import { pickAddressee, sanitizeReplyAddressing } from './addressing.js';
import { getTopic, setTopic, clearTopic } from './convo_state.js';

// tiny helpers
function nowStrings() {
  const d = new Date();
  return {
    date: d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  };
}

function capLen(s, n = 220) { return (s && s.length > n) ? (s.slice(0, n - 1) + '…') : s; }

export function decide({ intent, text, authorLogin, authorDisplay, platform = 'twitch' }) {
  const at = pickAddressee({ authorLogin, authorDisplay });
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
      // No weather tool wired yet—stay in-character, honest.
      out = `${at} I can’t see the sky from this post, but I can pull it later if you want me to wire a weather tool.`;
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
      out = `${at} Ask me about guild logistics, quests, schedules, or just chat. I’ll keep it brief.`;
      break;
    }
    case 'smalltalk':
    default: {
      // Short, grounded, and not syrupy.
      if (/how\s+are\s+you/i.test(text)) {
        out = `${at} Focused. Sorting the roster and keeping watch. You?`;
      } else {
        // keep it one line, nudge for specifics
        out = `${at} I’m listening. Want logistics, ideas, or just chatter?`;
      }
      break;
    }
  }

  // address cleanup in case any template leaked placeholders
  out = sanitizeReplyAddressing(out, at);
  // fit twitch line budget
  out = capLen(out, platform === 'twitch' ? 220 : 400);

  return { text: out, topic: getTopic() };
}
