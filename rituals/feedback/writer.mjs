import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function yymm(d=new Date()){ return d.toISOString().slice(0,7); } // YYYY-MM
const fileFor = (d=new Date()) => `rituals/feedback/${yymm(d)}/feedback.jsonl`;

export async function appendFeedback(entry) {
  const file = fileFor();
  await mkdir(dirname(file), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  await appendFile(file, line, 'utf8');
  return file;
}
