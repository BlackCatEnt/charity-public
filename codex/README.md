# Charity — Core/Halls Architecture (v0.3)

**Folders**
- `boot/` — tiny entrypoint
- `mind/` — orchestrator, router, safety, delays, telemetry, llm, rag
- `heart/` — persona base + overlays
- `soul/` — data: kb, memory, cache (gitignored)
- `halls/` — platform adapters (twitch, discord)
- `rituals/` — training + feedback + CLI
- `relics/` — tools (tokens, helix, json)
- `sentry/` — observability
- `trials/` — tests

**Path Aliases** (in `package.json`)
`#mind/*, #heart/*, #soul/*, #halls/*, #rituals/*, #codex/*, #relics/*, #sentry/*`
Compat: `#core/* → mind`, `#adapters/* → halls`

**Quick start**


## Observability (Keeper, Scribe, Metrics)

### Keeper
- Writes NDJSON events to `relics/.runtime/logs/events/keeper.jsonl`.
- Mirror to console: set `KEEPER_LOG_ECHO=1`.

### Scribe
- Pluggable transport via `SCRIBE_TRANSPORT_URL`:
  - `file://relics/.runtime/logs/events/scribe.jsonl` (default file sink)
  - `http(s)://...` (POST per line, JSON)
- Resilient jittered backoff: `SCRIBE_BACKOFF_MIN_MS`, `SCRIBE_BACKOFF_MAX_MS`, `SCRIBE_MAX_RETRIES`.

### Scribe (metrics + transport)


Set `SCRIBE_TRANSPORT_URL` to control delivery:
- `stdout` → writes NDJSON to stdout (debug)
- `file://A:/Charity/relics/.runtime/metrics/scribe.ndjson` → appends NDJSON to a file
- `http://localhost:8787/ingest` → posts `application/x-ndjson`


Backoff env (defaults in parentheses):
- `SCRIBE_BACKOFF_BASE_MS` (250)
- `SCRIBE_BACKOFF_FACTOR` (2.0)
- `SCRIBE_BACKOFF_CAP_MS` (120000)
- `SCRIBE_BACKOFF_MAX_RETRIES` (8)

**Env**
- `SCRIBE_TRANSPORT_URL` — `stdout:` | `file://A:/path/to/file.ndjson` | `http://localhost:8787/ingest`
- `SCRIBE_BACKOFF_BASE_MS` (250), `SCRIBE_BACKOFF_FACTOR` (2), `SCRIBE_BACKOFF_CAP_MS` (120000), `SCRIBE_BACKOFF_MAX_RETRIES` (8)
- `SCRIBE_METRICS_DIR` (default `relics/.runtime/metrics`), `SCRIBE_METRICS_AUTOFLUSH` (1=on), `SCRIBE_TZ` (default `America/New_York`)


**Runbook**
1. (Optional) Start a local ingest server:  
   `node relics/dev/scribe-dev-server.mjs 8787 --fail-rate=0.25`
2. Drive Scribe via env and run the smoke test:  
   `node relics/smoke-scribe.mjs --transport=http://localhost:8787/ingest --n=20 --batch=5`
3. File transport example:  
   `node relics/smoke-scribe.mjs --transport=file://A:/Charity/relics/.runtime/metrics/smoke.ndjson --n=20`
4. Metrics: NDJSON lines written/rotated daily under `relics/.runtime/metrics/YYYY-MM-DD.ndjson`
5. Backoff: full-jitter exponential with cap; resets on success.

### Metrics
- Counter rollups every minute to `relics/.runtime/logs/metrics/YYYY-MM/metrics-YYYY-MM-DD.jsonl`
- Configure: `METRICS_ROLLUP_INTERVAL_MS`, `METRICS_DIR`.
- Optional fan-out of all Keeper events through Scribe: `SCRIBE_FANOUT=1`.
