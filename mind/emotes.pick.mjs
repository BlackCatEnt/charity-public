export function pickEmote(intent='ack', hall='twitch', pool=[]) {
  const want = intent === 'thanks' ? ['bagotrHeart2','bagotrHeart'] :
              intent === 'warn'   ? ['✧'] :
              intent === 'lol'    ? ['LUL','PogChamp'] :
              ['✧'];
  for (const w of want) if (pool.includes(w)) return w;
  return pool[0] || '';
}
