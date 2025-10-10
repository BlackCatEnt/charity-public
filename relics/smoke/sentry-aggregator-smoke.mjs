// Smoke: runs on alternate ports so it won't clash with dev producers.
import http from 'node:http';
import { MetricsAggregator } from '../../sentry/aggregator.mjs';
import { startServer } from '../../sentry/server.mjs';
import { startPushLoop } from '../../sentry/exporters/pushgateway.mjs';

const KEEPER_PORT = 18131;
const SCRIBE_PORT = 18132;
const PUSHGW_PORT = 19099;
const SENTRY_PORT = 18150;

function startFakeProducer(port, lines) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      res.statusCode = 200; res.setHeader('content-type','text/plain');
      res.end(lines.join('\n') + '\n');
    } else { res.statusCode = 404; res.end('nope'); }
  });
  return new Promise(resolve => srv.listen(port, () => resolve(srv)));
}

function startFakePushgateway(port, onPush) {
  const srv = http.createServer((req, res) => {
    if (req.method === 'PUT' && req.url.startsWith('/metrics/job/')) {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { onPush(body); res.statusCode = 202; res.end('ok'); });
      return;
    }
    res.statusCode = 404; res.end('nope');
  });
  return new Promise(resolve => srv.listen(port, () => resolve(srv)));
}

(async () => {
  const keeper = await startFakeProducer(KEEPER_PORT, [
    '# HELP keeper_events_total total events',
    '# TYPE keeper_events_total counter',
    'keeper_events_total{kind="ingest"} 42',
  ]);
  const scribe = await startFakeProducer(SCRIBE_PORT, [
    '# HELP scribe_batches_total total batches',
    '# TYPE scribe_batches_total counter',
    'scribe_batches_total 7',
  ]);

  let pushedBody = null;
  const pg = await startFakePushgateway(PUSHGW_PORT, body => { pushedBody = body; });

  const aggregator = new MetricsAggregator({
    targetsByService: {
      keeper: [`http://127.0.0.1:${KEEPER_PORT}/metrics`],
      scribe: [`http://127.0.0.1:${SCRIBE_PORT}/metrics`]
    },
    scrapeIntervalMs: 250
  });
  aggregator.start();
  const api = startServer({ aggregator, port: SENTRY_PORT });

  // Push to our fake gateway
  const pusher = startPushLoop({
    aggregator,
    pushUrl: `http://127.0.0.1:${PUSHGW_PORT}`,
    intervalMs: 500
  });

  // Let a couple scrapes happen
  await new Promise(r => setTimeout(r, 1000));

  // Fetch combined metrics
  const res = await fetch(`http://127.0.0.1:${SENTRY_PORT}/metrics`);
  const text = await res.text();
  console.log('\n--- COMBINED METRICS ---\n' + text);

  // Assertions
  if (!text.includes('keeper_events_total{') || !text.includes('scribe_batches_total{')) {
    console.error('Missing expected metric names'); process.exit(2);
  }
  if (!text.includes('service="keeper"') || !text.includes('service="scribe"')) {
    console.error('Missing service labels'); process.exit(3);
  }
  if (!text.includes(`instance="127.0.0.1:${KEEPER_PORT}"`) || !text.includes(`instance="127.0.0.1:${SCRIBE_PORT}"`)) {
    console.error('Missing instance labels'); process.exit(4);
  }
  if (!pushedBody || !pushedBody.includes('keeper_events_total')) {
    console.error('Pushgateway body not received'); process.exit(5);
  }

  // Clean shutdown
  pusher.stop();
  aggregator.stop();
  await new Promise(r => api.close(r));
  await new Promise(r => keeper.close(r));
  await new Promise(r => scribe.close(r));
  await new Promise(r => pg.close(r));
  console.log('sentry-aggregator-smoke: PASS');
  process.exit(0);
})();
