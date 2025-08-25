import axios from 'axios';
import { personaSystem } from './persona.js';

export async function generateAnswer({ CHARITY_CFG, OLLAMA, LLM_MODEL }, { context, userQuestion, mood, tz, getChannelOrLiveContext }) {
  const system = personaSystem(CHARITY_CFG, mood);
  const liveCtx = (typeof getChannelOrLiveContext === 'function')
    ? await getChannelOrLiveContext() : { lines: [], isLive: false };
  const streamStatus = liveCtx?.isLive ? 'LIVE' : 'OFFLINE';

  const merged = [
    `Stream is currently ${streamStatus}.`,
    (liveCtx?.lines || []).join('\n').trim(),
    String(context || '').trim()
  ].filter(Boolean).join('\n---\n');

  const { data } = await axios.post(`${OLLAMA}/api/chat`, {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: `Context:\n${merged}\n\nQuestion: ${userQuestion}` }
    ],
    stream: false
  }, { timeout: 60000 });

  const msg = data?.message?.content || (data?.messages?.slice(-1)[0]?.content) || '';
  return (msg || '').trim();
}
