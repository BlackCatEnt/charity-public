// What Charity can do at runtime — shown to the LLM and checked by the router.
export const CAPABILITIES = [
  { id: 'events.add',   role: 'mod', desc: 'Add an event to the Codex',      usage: 'events.add "Title" YYYY-MM-DD "Desc?"' },
  { id: 'events.list',  role: 'any', desc: 'List recent events',             usage: 'events.list' },
  { id: 'events.sync',  role: 'mod', desc: 'Sync Discord Scheduled Events',  usage: 'events.sync' },
  { id: 'kb.reload',    role: 'mod', desc: 'Reload knowledge base from disk',usage: 'kb.reload' },
  { id: 'observer.set', role: 'mod', desc: 'Toggle Observer mode',           usage: 'observer.set on|off' }
  // add more later (link.start, link.complete, etc.)
];

export function summarizeCapabilities() {
  return CAPABILITIES.map(c => `${c.id} — ${c.desc} (usage: ${c.usage})`).join('\n');
}

export function allowedFor(evt, cap, { guards }) {
  if (!cap) return false;
  if (cap.role === 'any') return true;
  return !!guards?.canObserver?.(evt); // Guildmaster/mods only
}
