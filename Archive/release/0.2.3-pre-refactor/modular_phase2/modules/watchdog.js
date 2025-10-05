// ESM module
import ms from 'ms';
const now = () => Date.now();


export function createWatchdog(client, {
pingEveryMs = ms('30s'),
pingTimeoutMs = ms('6s'),
joinTimeoutMs = ms('10s'),
maxBackoffMs = ms('60s')
} = {}) {
let timer = null, lastPongAt = now(), backoff = 2000, joined = false;


function schedulePing() {
clearInterval(timer);
timer = setInterval(async () => {
try {
const start = now();
await Promise.race([
client.ping(),
new Promise((_, rej) => setTimeout(() => rej(new Error('ping-timeout')), pingTimeoutMs))
]);
lastPongAt = now();
backoff = Math.min(backoff, 5000); // reset backoff after healthy ping
} catch (e) {
console.warn('[watchdog] ping failed:', e.message);
reconnect();
}
}, pingEveryMs);
}


async function reconnect() {
try { await client.disconnect(); } catch {}
await sleep(backoff);
try {
await client.connect();
await waitForJoin(joinTimeoutMs);
backoff = Math.min(backoff * 2, maxBackoffMs);
} catch (e) {
console.warn('[watchdog] reconnect failed:', e.message);
backoff = Math.min(backoff * 2, maxBackoffMs);
reconnect();
}
}


function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


function waitForJoin(timeout) {
return new Promise((resolve, reject) => {
if (joined) return resolve();
const to = setTimeout(() => reject(new Error('join-timeout')), timeout);
const onJoin = (channel, username, self) => {
if (!self) return; // only care about our own join confirmation
clearTimeout(to);
client.removeListener('join', onJoin);
joined = true;
console.log('[watchdog] joined', channel);
resolve();
};
client.on('join', onJoin);
});
}


return {
start() { schedulePing(); },
markJoined() { joined = true; },
stop() { clearInterval(timer); },
};
}