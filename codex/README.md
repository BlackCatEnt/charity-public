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

### Metrics
- Counter rollups every minute to `relics/.runtime/logs/metrics/YYYY-MM/metrics-YYYY-MM-DD.jsonl`
- Configure: `METRICS_ROLLUP_INTERVAL_MS`, `METRICS_DIR`.
- Optional fan-out of all Keeper events through Scribe: `SCRIBE_FANOUT=1`.
