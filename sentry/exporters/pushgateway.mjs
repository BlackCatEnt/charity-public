// Minimal Pushgateway export: PUT text exposition to /metrics/job/<job>
export function startPushLoop({ aggregator, pushUrl, jobName = 'charity_sentry_aggregator', intervalMs = 60000 }) {
if (!pushUrl) return { stop: () => {} };
const path = `${pushUrl.replace(/\/$/, '')}/metrics/job/${encodeURIComponent(jobName)}`;
let timer = setInterval(async () => {
try {
const body = aggregator.getCombinedText();
const res = await fetch(path, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body });
if (!res.ok) throw new Error(`pushgateway HTTP ${res.status}`);
console.log(JSON.stringify({ kind: 'sentry_push_ok', to: path }));
} catch (err) {
console.error(JSON.stringify({ kind: 'sentry_push_fail', to: path, err: String(err) }));
}
}, intervalMs);
return { stop: () => clearInterval(timer) };
}