# Sentry (Metrics Aggregator)

**Intent**  
Expose what Scribe wrote for monitoring/alerts.

**MVP Role**  
- Serve `/metrics` for Prometheus
- Health gauges (e.g., `sentry_up`, `keeper_alive`)
- Optional label normalization

**APIs**  
- HTTP `/metrics` (Prometheus text format)
- Health endpoints `/healthz`

**Upstream**  
Consumes from [Scribe](scribe.md) via Pushgateway.

**Personality**  
Alert lookout; terse status.
