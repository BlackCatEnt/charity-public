import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ROOT = 'rituals/modlog';

function today() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

export async function logModAction({ evt, action, type, reason, extra = {} }) {
  const line = {
    ts: new Date().toISOString(),
    hall: evt.hall,
    roomId: evt.roomId,
    userId: evt.userId,
    userName: evt.userName,
    messageId: evt.meta?.messageId || null,
    text: evt.text,
    action,   // 'delete' | 'timeout' | 'warn' | 'block'
    type,     // 'spoiler' | 'slur' | 'spam' | 'event-guard' | ...
    reason,
    ...extra
  };
  const p = join(ROOT, `${today()}.jsonl`);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(line) + '\n', 'utf8');
  return p;
}
