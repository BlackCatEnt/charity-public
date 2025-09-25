# Charity — Architecture (v0.3)

[ Gateways ] → Herald → .queue → Keeper → Scribe → soul/memory/*
(Discord/Twitch/CLI) (JSONL) (writer)

## Roles (Hive)

- **Herald** (`hive/herald`)  
  Normalizes inbound events to a single message shape and appends them to the local queue (`relics/.queue/YYYY-MM-DD.jsonl`).

- **Keeper** (`hive/keeper`)  
  Daemon that drains the queue: reads each JSONL record and forwards to Scribe. Writes a heartbeat file to `relics/.runtime/keeper.alive`.

- **Scribe** (`hive/scribe`)  
  Writes durable memory (`soul/memory/episodes/YYYY-MM-DD.jsonl`) and feedback (`rituals/feedback/YYYY-MM/feedback.jsonl`). No secrets; public-repo safe.

## Message shape
```json
{
  "type": "user.input",
  "source": "discord",
  "session": "guild:123#chan:456#user:789",
  "text": "hello charity",
  "ts": "2025-09-25T23:14:42Z"
}

## Paths & Runtime

- Source aliases: #hive/*, #relics/*, #codex/*, #boot/* (see package.json → imports).
- Runtime dirs (gitignored):
	- relics/.queue/ (ingress buffer)
	- relics/.runtime/ (heartbeats, processed/failed)
- Env overrides:
	- CHARITY_QUEUE_DIR=A:\CharityRuntime\.queue
	- CHARITY_RUNTIME_DIR=A:\CharityRuntime\.runtime
	- CHARITY_KEEPER_INTERVAL_MS=2000

## Stability & CI

- relics/repo-health.ps1 gates JSON/JSONL, JS syntax, import resolution, legacy paths.
- GitHub Actions (.github/workflows/health.yml) runs health on every PR.

## Start on boot (Windows)

- Task Scheduler entry points:
	- node A:\Charity\boot\index.mjs (main)
	- (optionally) node A:\Charity\relics\run-keeper.mjs (if running Keeper as its own task)