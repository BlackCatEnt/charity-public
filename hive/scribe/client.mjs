// A:\Charity\hive\scribe\client.mjs
// Best‑effort: append to scribe ingest file; scribe will sweep the folder.
import fs from "node:fs/promises";
import path from "node:path";


const OUT_DIR = "A:/Charity/relics/.runtime/scribe-ingest";


export async function emit(record) {
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const p = path.join(OUT_DIR, `${ts}-keeper.jsonl`);
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.appendFile(p, JSON.stringify(record) + "\n", "utf8");
}