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
