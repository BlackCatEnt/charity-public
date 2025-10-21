// Run: node relics/smoke/scribe-poison-and-dup.mjs
// NOTE: Stop Charity first to avoid port binding conflicts (or we bind admin to 0).

// Minimize side effects from scribe admin server:
process.env.SCRIBE_ADMIN_PORT = process.env.SCRIBE_ADMIN_PORT || "0";
// Keep transport simple; dedupe/poison happen BEFORE transport anyway.
process.env.SCRIBE_TRANSPORT_URL = process.env.SCRIBE_TRANSPORT_URL || "stdout:";

// Make sure our pushgateway labels match your env (optional):
process.env.PGW_JOB = process.env.PGW_JOB || "charity";
process.env.PGW_INSTANCE = process.env.PGW_INSTANCE || "ADVENTURING-GUI";

import { sendLines } from "../../hive/scribe/index.mjs";

// Build three lines:
// 1) good JSON with explicit event_id
// 2) duplicate (same event_id)
// 3) malformed JSON (poison)
const good = JSON.stringify({ event_id: "SMOKE-DUP-1", kind: "ping", hall: "tavern", ts: Date.now() });
const dup  = JSON.stringify({ event_id: "SMOKE-DUP-1", kind: "ping", hall: "tavern", ts: Date.now() });
// malformed:
const poison = '{ "kind": "ping", "hall": "bad", '; // intentionally broken

console.log("[smoke] sending 1 good + 1 duplicate + 1 poison…");
await sendLines([good, dup, poison]);
console.log("[smoke] done. Now scrape pushgateway to see counters.");
