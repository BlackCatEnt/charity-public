import fs from 'node:fs';
import path from 'node:path';

const humorPath = path.resolve('heart/overlays/2025-09-11_humor-foundation.json');
const recent = new Map();

function loadHumor() {
  return JSON.parse(fs.readFileSync(humorPath, 'utf-8'));
}

export function quip(bucket, vars = {}) {
  const data = loadHumor();
  const arr = data[bucket] || data['generic_wit'] || ["..."];
  let i = Math.floor(Math.random() * arr.length);
  if (arr.length > 1 && i === recent.get(bucket)) {
    i = (i + 1) % arr.length;
  }
  recent.set(bucket, i);
  let s = arr[i];
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
