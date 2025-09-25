import fs from 'fs';
import path from 'path';

const files = process.argv.slice(2);
let hadErr = false;

for (const file of files) {
  const data = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
  const lines = data.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue; // skip blank lines
    try {
      JSON.parse(raw);
    } catch (e) {
      console.error(${file}:: );
      // show a short snippet to help locate
      const snippet = raw.length > 140 ? raw.slice(0,140)+'…' : raw;
      console.error('  > ' + snippet);
      hadErr = true;
    }
  }
}
process.exit(hadErr ? 1 : 0);
