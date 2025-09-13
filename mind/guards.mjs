const curators = new Set(
  (process.env.CURATORS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

// simple observer flag (in-memory)
let OBSERVER_ON = false;

export const guards = {
  isCurator(evt) {
    const u = (evt.userName || '').toLowerCase();
    return curators.has(u);
  },
  get observer() { return OBSERVER_ON; },
  set observer(v) { OBSERVER_ON = !!v; }
};
