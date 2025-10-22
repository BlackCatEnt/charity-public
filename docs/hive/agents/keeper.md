# Hive Keeper (Conductor)

**Intent**  
Coordinate the Hive. Route tasks, apply basic guardrails, and log outcomes so we can learn.

**MVP Role**  
- Task router (→ Scribe, Busy, Muse, Herald, etc.)
- FIFO queue with priority + retry
- Lightweight limits/cooldowns pre-dispatch
- Outcome logging + metric events

**Personality**  
Calm, brief, decisive.

**APIs (examples)**  
- `keeper.route(task)` → {accepted|queued|denied}
- `keeper.degrade(reason)` → fallback result
- Emits `keeper_events_total{service=...,status=...}`

**Collaborators**  
[Charity](charity.md) • [Scribe](scribe.md) • [Guard](guard.md) • [Herald](herald.md) • [Busy](busy.md) • [Muse](muse.md) • [Kodex](kodex.md)
