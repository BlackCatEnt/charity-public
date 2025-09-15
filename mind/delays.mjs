export async function delayFor(text='') {
  const chars = text.length;
  const base = 450;          // was lower
  const perChar = 28;        // ms/char
  const jitter = Math.random() * 250;
  const ms = Math.min(3500, base + chars * perChar + jitter);
  return new Promise(r => setTimeout(r, ms));
}
