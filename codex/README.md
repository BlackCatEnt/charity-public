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

### CI: Scribe smoke
Public repo - [![Scribe smoke](https://github.com/BlackCatEnt/charity-public/actions/workflows/scribe-smoke.yml/badge.svg?branch=v0.3-next)](https://github.com/BlackCatEnt/charity-public/actions/workflows/scribe-smoke.yml)
This workflow boots a local NDJSON ingest server and runs the Scribe smoke script against it. It verifies:

- `SCRIBE_TRANSPORT_URL=http://127.0.0.1:8787/ingest` posts NDJSON successfully.
- Full-jitter backoff tolerates transient 500s from the local server.
- No secrets required; all tests run against localhost.



### Metrics
- Counter rollups every minute to `relics/.runtime/logs/metrics/YYYY-MM/metrics-YYYY-MM-DD.jsonl`
- Configure: `METRICS_ROLLUP_INTERVAL_MS`, `METRICS_DIR`.
- Optional fan-out of all Keeper events through Scribe: `SCRIBE_FANOUT=1`.

## Keeper v0.4 — Queue QoS & Idempotency

**What’s new**
- Token-bucket rate limits per **hall** and **bee** (env-tunable).
- File-hash idempotency (existing) documented + verified.
- Canonical DLQ mirror at `relics/.runtime/dlq/` and DLQ logs to Scribe.
- Embedded HTTP probes:
  - `GET /health` → `{ ok, queueDepth }`
  - `GET /metrics` → `{ queueDepth, processed, failed, skipped, rateLimitHits, duplicatesSkipped, overflowRejects }`
• Bounded queue scan: `MAX_FILES_PER_TICK` (default 50)
• Per-hall/bee token-bucket: RL_* envs (e.g., RL_TWITCH_TPS/CAP, RL_BEE_BUSY_TPS/CAP)
• Blocking rate limit: `RL_MAX_WAIT_MS` (default 5000) — waits before send; no file-level fail
• Idempotency: file-hash skip + processed catalog
• DLQ: `relics/.runtime/dlq/` (only for hard fails)
• Partial-fail safety: on mid-file error, remainder requeued as `requeue-*.jsonl`
• Probes: `/health`, `/metrics`, `/debug`

**Config via environment**
KEEPER_METRICS_PORT=8140
RL_TWITCH_TPS=5 RL_TWITCH_CAP=10
RL_DISCORD_TPS=15 RL_DISCORD_CAP=30
RL_AUDIO_TPS=5 RL_AUDIO_CAP=10
RL_BEE_BUSY_TPS=2 RL_BEE_BUSY_CAP=4
RL_BEE_MUSE_TPS=2 RL_BEE_MUSE_CAP=4
RL_BEE_SHIELD_TPS=20 RL_BEE_SHIELD_CAP=40
MAX_FILES_PER_TICK=10 # optional back-pressure cap

**Smoke**
- Flood Twitch/Busy: create a JSONL with 200 records (`type=qos-smoke, source=twitch, bee=busy`), then check `/metrics` → `rateLimitHits > 0`.
- Duplicate file → `skipped` increments.
- DLQ: drop one record with `type=force-error` → file appears in `relics/.runtime/dlq/`, `failed` increments.
- Rate limit: drop 200-line `twitch/busy` JSONL → see `rateLimitHits > 0`, `processed > 0`.  
- Requeue remainder: `node relics/smoke/keeper-requeue-smoke.mjs` → expect `keeper_requeued_records` and `requeue-*.jsonl`.