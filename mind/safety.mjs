export function makeSafety() {
  const banned = []; // add words/regex as needed
  return {
    pass(evt) {
      const t = (evt.text || '').toLowerCase();
      return !banned.some(x => t.includes(x));
    }
  };
}
