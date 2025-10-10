// A:\Charity\hive\keeper\dlq.mjs
import fs from "node:fs/promises";
import path from "node:path";


export class DLQ {
constructor({ dir, maxFiles = 10000, scribeEmit }) {
this.dir = dir; this.maxFiles = maxFiles; this.scribeEmit = scribeEmit;
}
async ensureDir() { await fs.mkdir(this.dir, { recursive: true }); }
async count() {
await this.ensureDir();
const files = await fs.readdir(this.dir); return files.length;
}
async put(evt, reason = "unknown") {
await this.ensureDir();
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const fname = `${ts}-${evt.type||"evt"}-${evt.id||"noid"}.json`;
const p = path.join(this.dir, fname);
const rec = { ts, reason, evt };
await fs.writeFile(p, JSON.stringify(rec, null, 2), "utf8");
// best‑effort emit to Scribe
try { if (this.scribeEmit) await this.scribeEmit({ kind: "dlq", rec }); } catch {}
return p;
}
}