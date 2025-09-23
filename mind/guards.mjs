import { isGuildmaster, isModerator } from '#mind/identity.mjs';

const curators = new Set(
  (process.env.CURATORS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

let OBSERVER_ON = true;

export const guards = {
  isCurator(evt) {
    // Consider GM and moderators as curators too
    if (isGuildmaster(evt) || isModerator(evt)) return true;
    const u = (evt.userName || '').toLowerCase();
    return curators.has(u);
  },
  canObserver(evt) {
    return isGuildmaster(evt) || isModerator(evt);
  },
  get observer() { return OBSERVER_ON; },
  set observer(v) { OBSERVER_ON = !!v; }
};
