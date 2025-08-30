// tools/audit_imports.js
import fs from 'fs'; import path from 'path';
const ROOT = process.argv[2] || process.cwd();
const jsFiles = [];
(function walk(d){ for(const e of fs.readdirSync(d, {withFileTypes:true})) {
  if (e.name === 'node_modules' || e.name === '.git') continue;
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p);
  else if (e.isFile() && p.endsWith('.js')) jsFiles.push(p);
}})(ROOT);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
const imports = pkg.imports || {};
const aliasKeys = Object.keys(imports);
const re = /^\s*(?:import\s+(?:[^;]*?\sfrom\s+)?|export\s+.*?\sfrom\s+|require\s*\()\s*['"]([^'"]+)['"]/mg;

let unresolved = [];
for (const f of jsFiles) {
  const txt = fs.readFileSync(f,'utf8'); let m;
  while ((m = re.exec(txt))) {
    const spec = m[1];
    if (/^[a-zA-Z]+:/.test(spec)) continue;
    if (spec.startsWith('#')) {
      if (!imports[spec]) unresolved.push(`${f}: missing alias ${spec}`);
      else {
        const t = imports[spec].replace(/\*.*$/,'');
        const abs = path.resolve(ROOT, t);
        if (!fs.existsSync(abs)) unresolved.push(`${f}: alias target missing ${spec}=>${t}`);
      }
    } else if (spec.startsWith('.') || spec.startsWith('..')) {
      const abs = path.resolve(path.dirname(f), spec);
      if (!fs.existsSync(abs) && !fs.existsSync(abs+'.js')) unresolved.push(`${f}: unresolved ${spec}`);
    }
  }
}
if (unresolved.length) { console.warn(unresolved.join('\n')); process.exitCode = 1; }
else console.log('OK: imports look resolvable.');
