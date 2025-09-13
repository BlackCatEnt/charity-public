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
