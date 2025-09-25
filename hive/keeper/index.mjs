import { QUEUE_DIR, RUNTIME_DIR } from "#relics/paths.mjs";
import { write as scribeWrite } from "#hive/scribe/index.mjs";
import { info, warn, error } from "#relics/telemetry.mjs";
import { promises as fs } from "node:fs";
import fss from "node:fs";
import path from "node:path";
import readline from "node:readline";

async function ensureDir(d){ await fs.mkdir(d, { recursive: true }); }

async function processFile(file) {
  let count = 0;
  const rl = readline.createInterface({ input: fss.createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const s = line.trim();
      if (!s) continue;
      let rec;
      try { rec = JSON.parse(s); }
      catch (e) { warn("keeper.bad.json", { file, err: e.message }); continue; }

      // route
      if (rec.kind === "feedback") {
        await scribeWrite({ kind: "feedback", data: rec });
      } else if (rec.kind === "message") {
        // store as an episode by default
        await scribeWrite({ kind: "episode", data: rec });
      } else {
        await scribeWrite({ kind: "misc", data: rec });
      }
      count++;
    }
    const outDir = path.join(RUNTIME_DIR, "queue_processed");
    await ensureDir(outDir);
    await fs.rename(file, path.join(outDir, path.basename(file)));
    info("keeper.file.processed", { file, count });
  } catch (e) {
    const failDir = path.join(RUNTIME_DIR, "queue_failed");
    await ensureDir(failDir);
    const failName = path.basename(file).replace(/\.jsonl$/,"") + "-" + Date.now() + ".jsonl";
    await fs.rename(file, path.join(failDir, failName));
    error("keeper.file.failed", { file, err: e.message });
  }
}

export async function processQueueOnce() {
  await ensureDir(QUEUE_DIR);
  const all = (await fs.readdir(QUEUE_DIR)).filter(n => n.endsWith(".jsonl")).sort();
  for (const name of all) {
    await processFile(path.join(QUEUE_DIR, name));
  }
  return all.length;
}

export function start({ intervalMs = Number(process.env.CHARITY_KEEPER_INTERVAL_MS) || 2000 } = {}) {
  info("keeper.start", { intervalMs, queue: QUEUE_DIR });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processQueueOnce();
      await ensureDir(RUNTIME_DIR);
      await fs.writeFile(path.join(RUNTIME_DIR, "keeper.alive"), new Date().toISOString());
    } catch (e) {
      error("keeper.tick.error", { err: e.message });
    } finally {
      running = false;
    }
  };
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}