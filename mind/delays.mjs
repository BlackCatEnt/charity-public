const cfg = { base: 200, perChar: 15, max: 1500, jitter: 200 };
export const delayFor = async (text='') => new Promise(r => {
  const ms = Math.min(cfg.max, cfg.base + text.length * cfg.perChar + Math.random()*cfg.jitter);
  setTimeout(r, ms);
});
