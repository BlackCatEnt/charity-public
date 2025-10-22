# Charity Hive — Agents Library

> Mental model: **Charity** is the on‑stage “Queen Bee.” **[Hive Keeper](agents/keeper.md)** conducts. The other bees are backstage specialists coordinated by Keeper. If a bee is down, Keeper degrades gracefully; **[Scribe](agents/scribe.md)** still logs and **[Sentry](agents/sentry.md)** exposes health.

## Agents

- [Charity (On‑stage Persona)](agents/charity.md)
- [Hive Keeper (Conductor)](agents/keeper.md)
- [Scribe (Writer Bee)](agents/scribe.md)
- [Sentry (Metrics Aggregator)](agents/sentry.md)
- [Guard Bee (Policy Enforcer)](agents/guard.md)
- [Herald (Announcer)](agents/herald.md)
- [Busy Bee (Engagement & Moment Amplifier)](agents/busy.md)
- [Muse Bee (Creative Powerhouse)](agents/muse.md)
- [Kodex Bee (Memory & Knowledge)](agents/kodex.md)
- [Tinker Bee (Sandbox Experimenter)](agents/tinker.md)
- [Architect Bee (System Builder)](agents/architect.md)

## High‑Level Flow

```text
User/Chat → Guard → Keeper → {Busy | Muse | Scribe | Herald | …}
                              ↘ approval path (Felix/Mod via Discord or chat)
Busy (pre‑approved plays) → OBS/Overlay cues via Charity
Scribe → Pushgateway → Sentry → Prometheus/Grafana
Kodex ⇄ Keeper/Muse/Herald (context & recall)
Tinker → Architect (post‑MVP)
```

## Boot Order

1) Keeper → 2) Kodex (light) → 3) Scribe → 4) Sentry → 5) Guard → 6) Herald → 7) Busy/Muse → 8) Tinker/Architect
