## Summary

<!-- Provide a short summary of the changes -->

## Testing

<!-- Detail how you tested these changes -->

## Checklist

- [ ] QoS core at hive/keeper/qos.mjs
- [ ] Keeper wired to QoS and drains on SIGINT/SIGTERM
- [ ] Metrics emitted: keeper_*_total, keeper_qos_circuit_state
- [ ] Env flags documented
- [ ] Prom rules updated (keeper-qos-rules)
- [ ] Grafana dashboard added
- [ ] Smokes: keeper-qos-smoke.mjs, walking-skeleton.mjs
- [ ] CI workflow .github/workflows/keeper-v0_4.yml
- [ ] Unit tests (or smoke equivalents) for QoS helpers
- [ ] Docs updated (ARCHITECTURE QoS)
