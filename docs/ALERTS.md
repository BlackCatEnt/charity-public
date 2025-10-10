# Starter Alerts (PromQL)

## Dedup spike
Alert: High hall_dedup_drop rate
- Expression: increase(hall_dedup_drop_total[5m]) > 50
- Meaning: >50 drops in 5 minutes (tune per traffic).
- Label/hall scope: sum by (hall) (increase(hall_dedup_drop_total[5m])) > 50

## Growing queue depth
Alert: Queue depth rising
- Expression: max_over_time(keeper_queue_depth{queue="ingest"}[10m])
- min_over_time(keeper_queue_depth{queue="ingest"}[10m]) > 100
- Alternative (simple threshold): keeper_queue_depth{queue="ingest"} > 1000

## Scribe retries out-of-bounds
Alert: Retry rate elevated
- Expression: rate(scribe_retry_total[5m]) > 5
- Transport-only: rate(scribe_retry_total{reason="transport"}[5m]) > 5

## Keeper errors
Alert: Errors observed
- Expression: increase(keeper_processed_total{result="error"}[5m]) > 0

# Alerts & the Sentry combined endpoint

For alerts that consider multiple producers, prefer Sentry’s fan-in endpoint:
http://sentry:8150/metrics
All series include labels:
- `service`: one of `keeper|scribe|hall`
- `instance`: `host:port` of the producer

Examples:
- Rate by service: `sum by (service) (rate(keeper_events_total[5m]))`
- Any target down (scrape errors): watch for `sentry_warn{msg="scrape_failed"}` in logs and pair with blackbox or `up` metrics if your producers expose them.

## Sentry target down
**Alert:** Any target failing scrapes for 5m  
**Expr:** avg_over_time(sentry_target_up[5m]) < 1

**Labels:** service, instance

## Sentry scrape error rate elevated
**Alert:** Frequent scrape errors in the last 10m  
**Expr:** increase(sentry_scrape_errors_total[10m]) > 10

## Sentry stuck / no merges happening
**Alert:** Sentry stopped merging/scraping (stale pipeline)  
**Expr:** (time() - sentry_last_merge_timestamp) > 300

(Triggers if >5m since last successful merge.)

