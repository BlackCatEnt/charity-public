// Reasoner / intent router (heuristics-first, JSON-LLM fallback)
import { chatJson } from './llm.js';

const INTENTS = [
  'presence',        // “are you there?”, “you there?”
  'greeting',        // “hi”, “hello”, “hey”
  'smalltalk',       // casual meta (“how are you?”) or light convo
  'date',            // day/time/date
  'weather',         // “weather/forecast/rain/temp…”
  'quest_planning',  // “quest/brainstorm/event…”
  'switch_topic',    // “switch topic”, “new topic”
  'emote_reaction',  // message mostly emotes
  'help',            // “help”, “how do i…”
  'meta'             // other bot/meta inquiries
];

// --- simple helpers ---
const rx = {
  presence: /\b(are\s+you\s+there|you\s+there|still\s+there|awake|ping|yo\??)\b/i,
  greeting: /^(hi|hello|hey|yo|sup|hiya|howdy)\b/i,
  bye: /\b(bye|gtg|g2g|good\s*night|see\s*ya)\b/i,
  weather: /\b(weather|forecast|rain|snow|sunny|cloudy|temperature|temp|windy)\b/i,
  date: /\b(what('?| i)s\s*(the\s*)?(date|day)|what('| i)s\s*the\s*time|time\s+is\s+it|today\b)\b/i,
  quest: /\b(quest|brainstorm|adventure|event|campaign|raid|dungeon)\b/i,
  switchTopic: /\b(switch(\s+the)?\s+topic|change\s+topic|new\s+topic|let'?s\s+switch)\b/i,
  help: /\b(help|how\s+do\s+i|what\s+can\s+you\s+do)\b/i,
  emoteLike: /^[\s:;()<>[\]{}0-9A-Za-z_#*+|\\\/\-♥❤💖💗💓💞💕💘✨⭐🌟🔥😄😅😊😂🤣😎😍🙌👍🙏🤝💯🎉🎊🥳😺😸😻😽🙀😼😹😾 ]{1,80}$/,
};

function mostlyEmotes(s) {
  // If it’s short and matches “emote-like” with at least one non-word emoji or a known emote token, call it emote_reaction
  if (s.length > 80) return false;
  const hasHeartOrEmoji = /♥|❤|💖|💗|💓|💞|💕|💘|✨|⭐|🌟|🔥|🎉|🎊|🥳|😺|Kappa|Pog|LUL|OMEGALUL|FeelsGoodMan|FeelsBadMan|bagotrHeart/i.test(s);
  return rx.emoteLike.test(s) && hasHeartOrEmoji;
}

// --- main classifier ---
export async function classify(text, opts = {}) {
  const t = (text || '').trim();
  const low = t.toLowerCase();
  const meta = { source: 'heuristic', why: '' };
  if (!t) return { intent: 'smalltalk', confidence: 0.5, source: 'heuristic', why: 'empty text' };

  // Tier 1: crisp checks (high precision)
  if (rx.presence.test(low)) return { intent: 'presence', confidence: 0.98, ...meta, why: 'presence keywords' };
  if (mostlyEmotes(t)) return { intent: 'emote_reaction', confidence: 0.95, ...meta, why: 'mostly emotes' };
  if (rx.switchTopic.test(low)) return { intent: 'switch_topic', confidence: 0.95, ...meta, why: 'explicit switch topic' };

  // Tier 2: disambiguate weather vs date (“what’s the weather today?” should be weather, not date)
  const hitWeather = rx.weather.test(low);
  const hitDate = rx.date.test(low);
  if (hitWeather) return { intent: 'weather', confidence: 0.94, ...meta, why: 'explicit weather keywords' };
  if (hitDate)   return { intent: 'date',    confidence: 0.90, ...meta, why: 'explicit date/time keywords' };

  // Tier 2: quest planning
  if (rx.quest.test(low)) return { intent: 'quest_planning', confidence: 0.85, ...meta, why: 'quest/brainstorm keywords' };

  // Tier 2: greeting & small meta
  if (rx.greeting.test(low)) return { intent: 'greeting', confidence: 0.75, ...meta, why: 'greeting pattern' };
  if (/\bhow\s+are\s+you\b/i.test(low)) return { intent: 'smalltalk', confidence: 0.8, ...meta, why: 'social check-in' };
  if (rx.help.test(low)) return { intent: 'help', confidence: 0.8, ...meta, why: 'help keywords' };

  // If heuristics are unsure and a JSON router model is available, ask it once.
  const useLLM = process.env.LLM_JSON_ROUTER && (opts.useLLM ?? true);
  if (useLLM) {
    try {
      const sys = [
        'You are an intent classifier for a Twitch/Discord character.',
        `Allowed intents: ${INTENTS.join(', ')}.`,
        'Return strict JSON: {"intent": "<one of allowed>", "confidence": <0..1>, "why": "<short reason>"}',
        'Prefer "smalltalk" for casual messages; "presence" only for “are you there”-style pings;',
        'If message mentions weather, choose "weather" not "date".',
      ].join(' ');
      const user = `Message: ${t}`;
      const json = await chatJson({ system: sys, user, temperature: 0.0 });
      const intent = typeof json?.intent === 'string' ? json.intent : 'smalltalk';
      let conf = Number(json?.confidence); if (!Number.isFinite(conf)) conf = 0.65;
      const why = typeof json?.why === 'string' ? json.why : 'router default';
      if (!INTENTS.includes(intent)) return { intent: 'smalltalk', confidence: 0.55, source: 'heuristic', why: 'fallback (invalid LLM intent)' };
      return { intent, confidence: Math.max(0, Math.min(conf, 1)), source: 'router', why };
    } catch {
      // fall through to smalltalk
    }
  }

  return { intent: 'smalltalk', confidence: 0.6, source: 'heuristic', why: 'default smalltalk' };
}

export { classify as classifyIntent,INTENTS };
