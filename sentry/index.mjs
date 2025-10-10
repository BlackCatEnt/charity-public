import fs from 'node:fs';
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


const aggregator = new MetricsAggregator({ targetsByService: targets, scrapeIntervalMs: scrapeMs });
aggregator.start();


startServer({ aggregator, port });


// Optional Pushgateway export
const pushUrl = process.env.EXPORT_PUSHGATEWAY_URL;
const jobName = process.env.EXPORT_JOB_NAME || 'charity_sentry_aggregator';
const pushMs = Number(process.env.EXPORT_INTERVAL_MS || 60000);
const pusher = startPushLoop({ aggregator, pushUrl, jobName, intervalMs: pushMs });


process.on('SIGINT', () => { pusher.stop?.(); aggregator.stop?.(); process.exit(0); });