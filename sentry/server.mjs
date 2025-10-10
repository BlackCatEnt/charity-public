import http from 'node:http';

export function startServer({ aggregator, port = 8150 }) {
  const server = http.createServer(async (req, res) => {
    const { url, method } = req;
    if (method !== 'GET') { res.statusCode = 405; return res.end('Method Not Allowed'); }

    if (url === '/healthz') {
      res.statusCode = 200; res.setHeader('content-type','application/json');
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url === '/readyz') {
      await aggregator.ensureInitial();
      res.statusCode = 200; res.setHeader('content-type','application/json');
      return res.end(JSON.stringify({ ready: true }));
    }

    if (url === '/metrics') {
      await aggregator.ensureInitial();
      const text = aggregator.getCombinedText();
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      return res.end(text);
    }
	
	if (url === '/version') {
	  res.statusCode = 200; res.setHeader('content-type','application/json');
	  return res.end(JSON.stringify({
		name: 'sentry-aggregator',
		version: process.env.SENTRY_VERSION || 'v0.6',
		scrape_ms: Number(process.env.SENTRY_SCRAPE_INTERVAL_MS || 15000)
	  }));
	}

    res.statusCode = 404; res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(JSON.stringify({ kind: 'sentry_listen', port }));
  });
  return server;
}
