#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function loadScribe() {
  const cwd = process.cwd();
  const candidates = [
    // relative to this script (expected layout)
    resolve(__dirname, "../hive/scribe/index.mjs"),
    // relative to project root if run from repo root
    resolve(cwd, "hive/scribe/index.mjs"),
    // absolute “safety rope” if your root really is A:\Charity
    "A:/Charity/hive/scribe/index.mjs",
  ];

  let firstError;
  for (const p of candidates) {
    const exists = fs.existsSync(p);
    if (!exists) continue;
    try {
      return await import(pathToFileURL(p).href);
    } catch (e) {
      if (!firstError) firstError = e;
      // keep trying other candidates
    }
  }
  if (firstError) {
    console.error("Scribe import found a file but failed to load. Root cause:");
    console.error(firstError);
  }
  throw new Error(
    "Could not import Scribe. Checked:\n  " +
      candidates.map((p) => `${p}  ${fs.existsSync(p) ? "(exists)" : "(missing)"}`).join("\n  ")
  );
}

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    })
  );
  return {
    transport: args.transport || process.env.SCRIBE_TRANSPORT_URL || "stdout:",
    failRate: Number(args["fail-rate"] ?? process.env.SCRIBE_SMOKE_FAIL_RATE ?? 0),
    n: Number(args.n ?? 25),
    batch: Number(args.batch ?? 5),
  };
}

function mkEvent(i) {
  return {
    ts: new Date().toISOString(),
    counter: true,
    name: "smoke.event",
    value: 1,
    tags: { i, source: "smoke", node: process.pid },
  };
}

function toNDJSON(objs) {
  return objs.map((o) => JSON.stringify(o));
}

(async () => {
  const { transport, failRate, n, batch } = parseArgs();
  process.env.SCRIBE_TRANSPORT_URL = transport;

  const { sendLines } = await loadScribe(); // <-- now shows real errors if import breaks

  let sent = 0,
    dropped = 0,
    attempts = 0;
  const t0 = Date.now();
  const events = Array.from({ length: n }, (_, i) => mkEvent(i + 1));

  for (let k = 0; k < events.length; k += batch) {
    const slice = events.slice(k, k + batch);
    const lines = toNDJSON(slice);

    attempts++;
    const simulateFail = Math.random() < failRate;
    try {
      if (simulateFail) throw new Error("SMOKE_SIMULATED_FAILURE");
      await sendLines(lines);
      sent += slice.length;
    } catch (err) {
      console.error(`[smoke] batch ${attempts} failed: ${err.message}`);
      dropped += slice.length;
    }
  }

  const ms = Date.now() - t0;
  const rate = sent / n;
  console.log(
    `[smoke] done: sent=${sent} dropped=${dropped} total=${n} batches=${attempts} time_ms=${ms} success_rate=${(
      rate * 100
    ).toFixed(1)}%`
  );

  const isReal = !(String(transport).startsWith("stdout"));
  if (isReal && rate < 0.95) process.exitCode = 1;
})();
