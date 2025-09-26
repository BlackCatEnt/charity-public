import fs from "fs";
import path from "path";

const ROOT = process.argv[2] || process.cwd();
const IGNORE = /\\(node_modules|\.git|Archive)\\|soul\\memory\\episodes\\|soul\\kb\\index\\|soul\\cache\\/i;

const files = [];
(function walk(d){
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (IGNORE.test(p)) continue;
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && (p.endsWith(".js") || p.endsWith(".mjs"))) files.push(p);
  }
})(ROOT);

// load package.json imports (aliases)
let imports = {};
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  imports = pkg.imports || {};
} catch {}

function resolveAlias(spec) {
  // exact match first
  let raw = imports[spec];
  if (raw) {
    if (typeof raw === "object") raw = raw.default || raw.import || Object.values(raw)[0];
    return String(raw);
  }
  // wildcard e.g. "#codex/*"
  for (const key of Object.keys(imports)) {
    if (!key.includes("*")) continue;
    // escape regex specials EXCEPT the * we'll replace
    const rx = "^" + key
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "(.+)")
      + "$";
    const m = spec.match(new RegExp(rx));
    if (m) {
      let t = imports[key];
      if (t && typeof t === "object") t = t.default || t.import || Object.values(t)[0];
      return String(t).replace("*", m[1]);
    }
  }
  return null;
}

const unresolved = [];
const re = /(?:^|\s)(?:import\s+[^'"]*from\s*|import\s*|export\s+[^'"]*from\s*|require\(\s*)['"]([^'"]+)['"]\s*\)?/g;

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];

    if (/^(node:|https?:|data:)/.test(spec)) continue; // builtins/urls

    let target = spec;
    let baseDir = path.dirname(f);

    if (spec.startsWith("#")) {
      const mapped = resolveAlias(spec);
      if (!mapped) { unresolved.push(`${f}: missing alias ${spec}`); continue; }
      if (mapped.startsWith(".") || mapped.startsWith("/")) {
        target = mapped;
        baseDir = ROOT;
      } else {
        // non-path alias -> treat as package import; skip
        continue;
      }
    }

    if (target.startsWith(".") || target.startsWith("/")) {
      const base = path.resolve(baseDir, target);
      const cands = [
        base,
        `${base}.mjs`, `${base}.js`, `${base}.json`,
        path.join(base, "index.mjs"),
        path.join(base, "index.js"),
        path.join(base, "index.json"),
      ];
      if (!cands.some(p => fs.existsSync(p))) {
        unresolved.push(`${f}: unresolved ${spec}`);
      }
    } // else: bare package import -> ignore
  }
}

if (unresolved.length) { console.warn(unresolved.join("\n")); process.exit(1); }
else { console.log("OK: imports resolved."); }