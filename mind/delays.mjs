export async function delayFor(text='') {
  const chars = text.length;
  const base = 450, perChar = 28, jitter = Math.random() * 250;
  const ms = Math.min(3500, base + chars * perChar + jitter);
  return new Promise(r => setTimeout(r, ms));
}

export async function humanPause(_ev, kind) {
  const base = (kind === 'banter') ? 280 : 420;
  const jitter = Math.floor(Math.random() * 520);
  await new Promise(r => setTimeout(r, base + jitter)); 
}

export function typingDelayFor(text) {
  const words = (text || '').split(/\s+/).length || 6;
  const base = 220 + Math.random() * 300;
  const perWord = 35 + Math.random() * 25;
  return Math.min(2500, Math.round(base + words * perWord));
}

