// relics/smoke/walking-skeleton.mjs
import http from 'node:http';

const gateway = process.env.PUSHGATEWAY_URL || 'http://localhost:9091';
const job = process.env.PUSH_JOB || 'keeper_skeleton';
const body = `# TYPE keeper_skeleton_up gauge\nkeeper_skeleton_up 1\n`;

const req = http.request(`${gateway}/metrics/job/${encodeURIComponent(job)}`, { method: 'PUT' }, (res) => {
  let data = '';
  res.on('data', (d) => (data += d));
  res.on('end', () => {
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    console.log(JSON.stringify({ kind: 'walking_skeleton_push', status: res.statusCode, ok }));
    process.exit(ok ? 0 : 1);
  });
});
req.on('error', (e) => {
  console.error(e);
  process.exit(1);
});
req.end(body);
