// hive/metrics/pushgateway.mjs
// Zero-dep Pushgateway pusher for our custom PromRegistry.
// Posts the full exposition from prom.mjs to:
//   /metrics/job/{job}/instance/{instance}/service/{service}
// On shutdown, deletes service-, instance-, and job-scoped groups.

import os from "node:os";
import process from "node:process";
import { registry } from "./prom.mjs";

const PGW_URL      = process.env.PGW_URL || "http://127.0.0.1:9091";
const PGW_JOB      = process.env.PGW_JOB || "charity";
const PGW_INSTANCE = process.env.PGW_INSTANCE || os.hostname();
const INTERVAL_MS  = Number(process.env.PGW_PUSH_INTERVAL_MS || 5000);

function groupPath({ service }) {
  const esc = (s) => encodeURIComponent(String(s));
  return `${PGW_URL.replace(/\/+$/,"")}/metrics/job/${esc(PGW_JOB)}` +
         `/instance/${esc(PGW_INSTANCE)}/service/${esc(service)}`;
}
function instancePath() {
  const esc = (s) => encodeURIComponent(String(s));
  return `${PGW_URL.replace(/\/+$/,"")}/metrics/job/${esc(PGW_JOB)}/instance/${esc(PGW_INSTANCE)}`;
}
function jobPath() {
  const esc = (s) => encodeURIComponent(String(s));
  return `${PGW_URL.replace(/\/+$/,"")}/metrics/job/${esc(PGW_JOB)}`;
}

export function createPushgatewayPusher({ service, clearOnStop = true } = {}) {
  let timer = null;
  let cleared = false;

  async function pushOnce() {
    let body = registry.toText();
    if (!body.endsWith("\n")) body += "\n"; // Pushgateway requires trailing newline
    const url = groupPath({ service });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain; version=0.0.4" },
        body
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.error(`[metrics][${service}] push failed: ${res.status} ${res.statusText} url=${url} ${t}`);
      }
    } catch (e) {
      console.error(`[metrics][${service}] push error: ${e?.message || e}`);
    }
  }

  async function clear() {
    if (cleared) return;
    const urls = [groupPath({ service }), instancePath(), jobPath()];
    for (const url of urls) {
      try {
        const res = await fetch(url, { method: "DELETE" });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          console.error(`[metrics][${service}] delete failed: ${res.status} ${res.statusText} url=${url} ${t}`);
        }
      } catch (e) {
        console.error(`[metrics][${service}] delete error: ${e?.message || e}`);
      }
    }
    cleared = true;
  }

  const start = () => {
    if (timer) return;
    const firstDelay = Math.floor(Math.random() * Math.min(1000, INTERVAL_MS));
    setTimeout(() => {
      pushOnce();
      timer = setInterval(pushOnce, INTERVAL_MS);
      timer.unref?.();
    }, firstDelay);
  };

  const stop = async () => {
    if (timer) { clearInterval(timer); timer = null; }
    await pushOnce();
    if (clearOnStop) await clear();
  };

  // Windows-friendly shutdown hooks
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
    process.once(sig, async () => {
      try { await stop(); } finally { process.exit(0); }
    });
  }
  process.once("beforeExit", async () => { try { await stop(); } catch {} });
  // 'exit' cannot await async work; just mark as cleared to avoid double-runs.
  process.once("exit", () => { cleared = true; });

  return { start, stop, clear };
}
