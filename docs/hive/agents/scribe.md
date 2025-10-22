# Scribe (Writer Bee)

**Intent**  
Record what happens. Turn activity into metrics/logs for analysis.

**MVP Role**  
- Ingest events from Keeper
- Write Prometheus metrics (Pushgateway)
- NDJSON fallback (rotating)
- Flush/batch controls

**APIs**  
- `scribe.write(metric, labels, value)`
- `scribe.ndjson.append(event)`

**Downstream**  
→ [Sentry](sentry.md) exposes `/metrics` to Prometheus/Grafana.

**Personality**  
Methodical librarian.
