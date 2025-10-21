import fs from 'node:fs';
import http from "node:http";
import { MetricsAggregator } from './aggregator.mjs';
import { startServer } from './server.mjs';
import { startPushLoop } from './exporters/pushgateway.mjs';


function readTargets(file) {
try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { return {}; }
}


const port = Number(process.env.SENTRY_PORT || 8150);
const scrapeMs = Number(process.env.SENTRY_SCRAPE_INTERVAL_MS || 15000);
const targetsFile = process.env.SENTRY_TARGETS_FILE || 'sentry/sentry.targets.json';
const targets = readTargets(targetsFile);
// after reading targets
const targetsEmpty = !targets || Object.values(targets).every(arr => !arr || arr.length === 0);

const aggregator = new MetricsAggregator({ targetsByService: targets, scrapeIntervalMs: scrapeMs });
// only start aggregator if we actually have targets
if (!targetsEmpty) {
  aggregator.start();
} else {
  console.log("[sentry] no targets configured; scrape loop disabled (push-export-only).");
}
const PORT = Number(process.env.SENTRY_PORT ?? 8150);

const server = http.createServer((req, res) => {
  if (req.url === "/metrics") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    // Minimal “I’m alive” metric. Replace/augment with prom-client scrape if you have it.
    res.end(`# HELP sentry_up 1 if Sentry is serving metrics
# TYPE sentry_up gauge
sentry_up 1
`);
    return;
  }
  res.statusCode = 404;
  res.end("ok");
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`[sentry] metrics listening on 0.0.0.0:${PORT}`)
);

startServer({ aggregator, port });


// Optional Pushgateway export
const pushUrl = process.env.EXPORT_PUSHGATEWAY_URL;
const jobName = process.env.EXPORT_JOB_NAME || 'charity_sentry_aggregator';
const pushMs = Number(process.env.EXPORT_INTERVAL_MS || 60000);
const pusher = startPushLoop({ aggregator, pushUrl, jobName, intervalMs: pushMs });


process.on('SIGINT', () => { pusher.stop?.(); aggregator.stop?.(); process.exit(0); });