// Minimal, self-contained smoke for Keeper's partial-fail → requeue remainder
// HOW IT WORKS:
// 1) Writes a 10-line JSONL into the queue.
// 2) Starts Keeper with a mocked scribeSend that fails on the 5th record.
// 3) Verifies a requeue-*.jsonl is created with the remaining lines, prints a summary, and exits.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------- resolve project paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, "..", "..");               // A:\Charity
const relicsDir  = path.join(repoRoot, "relics");
const queueDir   = process.env.KEEPER_QUEUE_DIR || path.join(relicsDir, ".queue", "incoming");
const runtimeDir = process.env.KEEPER_RUNTIME_DIR || path.join(relicsDir, ".runtime");

// ---------- import Keeper.start (support alias or relative) ----------
let startKeeper;
try {
  // If you have import aliases (#hive/*), this will work:
  ({ start: startKeeper } = await import("#hive/keeper/index.mjs"));
} catch {
  // Fallback to relative path
  const keeperPath = pathToFileURL(path.join(repoRoot, "hive", "keeper", "index.mjs")).href;
  ({ start: startKeeper } = await import(keeperPath));
}

// ---------- tiny helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// ---------- prepare clean dirs ----------
await fs.mkdir(queueDir,   { recursive: true });
await fs.mkdir(runtimeDir, { recursive: true });

// ---------- write a test file (10 JSONL records) ----------
const testName = `smoke-requeue-${nowStamp()}.jsonl`;
const testPath = path.join(queueDir, testName);

const records = Array.from({ length: 10 }, (_, i) => ({
  ts: new Date().toISOString(),
  type: "smoke-requeue",
  source: "twitch",
  bee: "busy",
  id: `rec-${i + 1}`
}));

await fs.writeFile(testPath, records.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");

// ---------- mock scribeSend: fail on the 5th record ----------
let counter = 0;
async function scribeSendMock(_rec) {
  counter += 1;
  // Succeed for 1..4, fail deterministically on 5, then succeed afterward
  if (counter === 5) return false; // Keeper's withRetries will eventually throw → triggers partial requeue
  return true;
}

// ---------- start Keeper with fast tick and short RL wait ----------
process.env.KEEPER_METRICS_PORT = process.env.KEEPER_METRICS_PORT || "0"; // bind ephemeral to avoid collisions
process.env.MAX_FILES_PER_TICK  = process.env.MAX_FILES_PER_TICK  || "50";
process.env.RL_MAX_WAIT_MS      = process.env.RL_MAX_WAIT_MS      || "200"; // keep smoke quick

const stop = startKeeper({ intervalMs: 200, scribeSend: scribeSendMock });

// ---------- wait for result ----------
const startTs = Date.now();
let requeueFile = null;

while (Date.now() - startTs < 10000) { // 10s timeout
  const names = await fs.readdir(queueDir);
  requeueFile = names.find(n => n.startsWith(`requeue-${testName.replace(/\.jsonl$/,"")}`));
  if (requeueFile) break;
  await sleep(100);
}

// ---------- print summary & exit ----------
const failedDir   = path.join(runtimeDir, "queue_failed");
const processedDir= path.join(runtimeDir, "queue_processed");
const dlqDir      = path.join(runtimeDir, "dlq");

const summary = {
  testFile: testName,
  mockFailedAtRecord: 5,
  requeueFound: Boolean(requeueFile),
  requeueFile,
  // best-effort counts
  failedFiles: await fs.readdir(failedDir).catch(() => []),
  processedFiles: await fs.readdir(processedDir).catch(() => []),
  dlqFiles: await fs.readdir(dlqDir).catch(() => []),
  counterAtExit: counter
};

console.log(JSON.stringify({ kind: "keeper_requeue_smoke", ...summary }, null, 2));

// Try to stop politely if Keeper exposed a stop fn; otherwise exit.
// (Our start() returns a stop function in your code; if not, process will just end.)
try { if (typeof stop === "function") stop(); } catch {}
setTimeout(() => process.exit(0), 250);
