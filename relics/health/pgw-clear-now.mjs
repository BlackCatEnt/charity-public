// relics/health/pgw-clear-now.mjs
// Clears Pushgateway groups for both Keeper & Scribe regardless of how Charity stopped.

import os from "node:os";

const PGW_URL      = process.env.PGW_URL || "http://127.0.0.1:9091";
const PGW_JOB      = process.env.PGW_JOB || "charity";
const PGW_INSTANCE = process.env.PGW_INSTANCE || os.hostname();
const SERVICES     = ["keeper", "scribe"];

const esc = (s) => encodeURIComponent(String(s));
const urls = [
  // service-scoped
  ...SERVICES.map(svc => `${PGW_URL.replace(/\/+$/,"")}/metrics/job/${esc(PGW_JOB)}/instance/${esc(PGW_INSTANCE)}/service/${esc(svc)}`),
  // instance-scoped
  `${PGW_URL.replace(/\/+$/,"")}/metrics/job/${esc(PGW_JOB)}/instance/${esc(PGW_INSTANCE)}`,
  // job-scoped
  `${PGW_URL.replace(/\/+$/,"")}/metrics/job/${esc(PGW_JOB)}`
];

for (const u of urls) {
  try {
    const res = await fetch(u, { method: "DELETE" });
    console.log(`[DEL] ${res.status} ${u}`);
  } catch (e) {
    console.log(`[DEL] fail ${u} -> ${e?.message || e}`);
  }
}
