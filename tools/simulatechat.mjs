// Quick offline harness: feeds chat lines through party_state + WM + reasoner.

import { noteLine } from '../modular_phase2/modules/party_state.js';
import { buildWorkingMemoryFactory } from '../modular_phase2/modules/working_memory.js';
import { reasonAndReply } from '../modular_phase2/modules/reasoner.js';

// lightweight stubs for deps we need
const logger = { info: console.log, warn: console.warn, error: console.error };
const CHARITY_CFG = { style: {} };
const episodic = {
  getFactsByTags: () => [],
  ingest: async () => {}
};
const embedder = { embed: async () => new Array(1024).fill(0) };
const live = { getContext: async () => ({ isLive: false, title: 'offline sim', viewers: 0 }) };

const buildWM = buildWorkingMemoryFactory({ episodic, embedder, live, logger, CHARITY_CFG });

const channel = '#bagotrix';
const lines = [
  { user: 'bagotrix', text: 'Are you there Charity?' },
  { user: 'charity_the_adventurer', text: 'Yes, what’s on your mind?' },
  { user: 'bagotrix', text: 'Been thinking about getting you ready for Discord too.' },
  { user: 'bagotrix', text: 'Could we brainstorm a new quest for the guild?' },
];

for (const l of lines) {
  noteLine({ channel, login: l.user, display: l.user, text: l.text, t: Date.now() });
}

const last = lines[lines.length - 1];
const tags = { username: last.user, 'display-name': last.user, 'user-id': '0' };
const ctx = { channel, userLogin: last.user, userDisplay: last.user, text: last.text };

const wm = await buildWM({ channel, focusText: last.text, tags });
const r = await reasonAndReply(ctx, wm, { logger });

console.log('\n--- simulatechat result ---');
console.log('intent:', r.intent);
console.log('reply:\n' + r.reply);
