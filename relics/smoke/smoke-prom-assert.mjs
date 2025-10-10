import http from 'node:http';

const wantSmokeRetry = (process.env.SMOKE || 'false').toLowerCase() === 'true';

function fetchMetrics(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function sample(metric, text, where = null) {
  const lines = text.split('\n').map(s => s.trim());
  const rx = new RegExp(`^${metric}(\\{[^}]*\\})?\\s+(\\d+(?:\\.\\d+)?)$`);
  const hits = [];
  for (const line of lines) {
    const m = line.match(rx);
    if (!m) continue;
    const labels = {};
    if (m[1]) {
      m[1].slice(1, -1).split(',').filter(Boolean).forEach(pair => {
        const [k, v] = pair.split('=');
        labels[k.trim()] = (v || '').trim().replace(/^"|"$/g,'');
      });
    }
    if (where && !Object.entries(where).every(([k,v]) => labels[k] === v)) continue;
    hits.push(Number(m[2]));
  }
  return hits.reduce((a,b)=>a+b, 0);
}

(async () => {
  const port = Number(process.env.KEEPER_METRICS_PORT || 8140);
  const url = `http://127.0.0.1:${port}/metrics`;
  const text = await fetchMetrics(url);

  const ok = sample('keeper_processed_total', text, { result: 'ok' });
  const dedup = sample('hall_dedup_drop_total', text);
  const retry = sample('scribe_retry_total', text, { reason: 'transport' });

  const errs = [];
  if (ok <= 0) errs.push('keeper_processed_total{result="ok"} must be > 0');
  if (dedup <= 0) errs.push('hall_dedup_drop_total must be > 0');
  if (wantSmokeRetry && retry <= 0) errs.push('scribe_retry_total{reason="transport"} must be > 0 when SMOKE=true');

  if (errs.length) {
    console.error('Metric assertions failed:\n - ' + errs.join('\n - ') + '\n\n/metrics dump:\n' + text);
    process.exit(1);
  }
  console.log('Metrics assertions passed.');
})();
