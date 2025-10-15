#!/usr/bin/env node
import http from 'node:http';

const url = process.env.KEEPER_HEALTH_URL || 'http://127.0.0.1:8140/health';
const deadlineMs = Date.now() + Number(process.env.KEEPER_HEALTH_DEADLINE_MS || 20000); // 20s

function once() {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume(); // ignore body
      resolve(res.statusCode && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  while (Date.now() < deadlineMs) {
    if (await once()) process.exit(0);
    await new Promise(r => setTimeout(r, 500));
  }
  console.error(`keeper health did not become ready: ${url}`);
  process.exit(1);
})();
