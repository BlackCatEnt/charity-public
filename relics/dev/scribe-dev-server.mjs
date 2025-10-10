#!/usr/bin/env node
// Tiny NDJSON receiver for local testing.
// Usage: node relics/dev/scribe-dev-server.mjs [port=8787] [--fail-rate=0.0]

import http from "node:http";
import { parse } from "node:url";

const argv = process.argv.slice(2);
const port = Number(argv[0]) || Number(process.env.PORT) || 8787;
const failFlag = argv.find((a) => a.startsWith("--fail-rate="));
const FAIL_RATE = failFlag ? Number(failFlag.split("=")[1]) : Number(process.env.FAIL_RATE || 0);

const server = http.createServer((req, res) => {
  const { pathname } = parse(req.url, true);
  if (req.method !== "POST" || pathname !== "/ingest") {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found");
  }

  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    // Use literal backslash-n to avoid copy/paste corruption
    const lines = body.split("\\n").filter(Boolean);
    const preview = lines.slice(0, 3).join("\\n");
    const shouldFail = Math.random() < FAIL_RATE;

    const now = new Date().toISOString();
    console.log(`[${now}] /ingest ${shouldFail ? "FAIL 500" : "OK 200"}  lines=${lines.length}`);
    if (preview) console.log(preview + (lines.length > 3 ? "\\n… (" + (lines.length - 3) + " more)" : ""));

    if (shouldFail) {
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end("simulated failure");
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
});

server.listen(port, () => {
  console.log(`scribe-dev-server listening on http://localhost:${port}/ingest  (FAIL_RATE=${FAIL_RATE})`);
});
