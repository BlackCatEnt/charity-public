# Scribe v0.3 — Transport & Backpressure

This module batches in-memory events and exports a **monotonic counter**
(`scribe_batches_total`) to **Prometheus Pushgateway**. It includes simple,
tunable backpressure and a clean-exit smoke.

## Env Vars

- `PUSHGATEWAY_URL` (default `http://localhost:9091`)
- `SCRIBE_JOB` (default `scribe-smoke`)
- `SCRIBE_INSTANCE` (optional; default machine hostname)
- `SCRIBE_BATCH_MAX` (default `10`)
- `SCRIBE_FLUSH_MS` (default `150`)
- `SCRIBE_DRAIN_ON_EXIT` (`true|false`, default `true`)
- `SCRIBE_DRY_RUN` (`true|false`, default `false`) – skip HTTP, log only

## Backpressure (simple signal)
If queue length stays `> 2 * SCRIBE_BATCH_MAX` for `> 2 * SCRIBE_FLUSH_MS`,
Scribe logs `scribe:backpressure:on`; it flips back to `off` when recovered.

## Smoke (E2E)
```

npm run smoke:scribe

```
Emits a finite number of events, waits for ≥2 flushes, then exits 0. With a
local Pushgateway + Prometheus + Grafana, you should see
`scribe_batches_total` increasing (`rate(...)` shows >0).

## Dev helper (clear stale series)
```
Cross-platform delete:
- Node:  npm run pw:delete:node -- --job scribe-smoke
- PowerShell: npm run pw:delete -- --job scribe-smoke
- curl:  npm run pw:delete:curl   (requires curl)
- npm run pw:delete -- --job scribe-smoke

```
Removes the job from Pushgateway to avoid ghost series between runs.
