export async function delayFor(text='') {
  const chars = text.length;
  const base = 450;          // was lower
  const perChar = 28;        // ms/char
  const jitter = Math.random() * 250;
  const ms = Math.min(3500, base + chars * perChar + jitter);
  return new Promise(r => setTimeout(r, ms));
}
export async function humanPause(ev, kind) {
  const base = kind === 'banter' ? 280 : 420;
  const jitter = Math.floor(Math.random()*520);
  await sleep(base + jitter);
}
// A:\Charity\mind\delays.mjs
export function typingDelayFor(text) {
  const words = (text || "").split(/\s+/).length || 6;
  const base = 220 + Math.random() * 300;      // jitter
  const perWord = 35 + Math.random() * 25;      // light variability
  return Math.min(2500, Math.round(base + words * perWord));
}
