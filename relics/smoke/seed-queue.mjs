import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const qdir = join(here, '..', '.queue', 'incoming');

await mkdir(qdir, { recursive: true });

const a = { source: 'twitch', kind: 'event', id: randomUUID() };
const b1 = { source: 'twitch', kind: 'event', id: randomUUID() };
const b2 = { source: 'twitch', kind: 'event', id: randomUUID(), __dedupDropped: true };

await writeFile(join(qdir, 'smoke-a.jsonl'), JSON.stringify(a), 'utf8');
await writeFile(join(qdir, 'smoke-b.jsonl'), JSON.stringify(b1) + '\n' + JSON.stringify(b2), 'utf8');

console.log(JSON.stringify({ kind: 'seed_queue', qdir, files: ['smoke-a.jsonl','smoke-b.jsonl'] }));
