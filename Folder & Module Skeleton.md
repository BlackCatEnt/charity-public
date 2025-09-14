A:\Charity\
  boot\
    index.mjs                  # tiny boot: load codex, spin up mind, register halls
  mind\                         # (Core/orchestrator)
    llm\ollama.mjs		        
	orchestrator.mjs
    bus.mjs
    router.mjs                  # unified message pipeline
    safety.mjs
    delays.mjs                  # human-like timing
    telemetry.mjs
    guards.mjs
    feedback.mjs
	rag.keyword.mjs
	rag.store.mjs
	time.mjs					# Time awareness
	memory.vector.mjs			# Vector memory module
  heart\                        # (Personality)
    base\charity.base.json
    overlays\README.md
    overlays\2025-09-11_humor-foundation.json
  soul\                         # (Data)
    kb\                         # knowledge base, chunks, provenance
	kb\index\               	# vector stores (gitignored)
    kb\charity-northstar.jsonl  
	memory\episodes\            # episodic logs
    cache\
	cache\onnxrt\           	# onnx/tensorrt runtime caches (gitignored)	
  rituals\                      # (Training & curation)
    feedback\2025-09\           # realtime thumbs/tags as JSONL
    feedback\writer.mjs			# 
	snapshots\weekly\
    cli\charity-cli.mjs         # dataset:snapshot|load|rollback|health
    cli\feedback-snapshot.mjs	# Feedback Snapshot CLI → overlay suggestion
	cli\memory-backfill.mjs		# Backfill CLI (index past episodic logs)
  halls\                        # (Platform adapters)
    twitch\adapter.mjs
    discord\adapter.mjs
    shared\normalizers.mjs      # platform→unified event
  codex\                        # (Config & docs)
    models.manifest.json    	# small, versioned pointers to A:\models\
    charity.config.json         # single source of truth
	actors.json					# a tiny identity map and pass it into the LLM so she knows who’s speaking.
    README.md                   # map of metaphor → tech
  relics\                       # (Tools & scripts)
    path-checker.mjs        	# verifies manifest + filesystem
    publish.mjs
	tokens.mjs
	helix.mjs					# twitch helix client
	helix-smoke.mjs				# helix Smoke Test	
	publish.ps1					# Simple PowerShell publisher (Windows-friendly)
	twitch-validate.mjs			# tiny validator (tells you whose token it is + scopes)
	embeddings.mjs				# Embedding client (BGE-M3 service)
	sqlite.mjs					# SQLite helper (auto-creates schema)
  sentry\                       # (Ops/observability hooks)
    metrics-exporter.mjs
  trials\                       # (Tests)
    e2e\
    unit\
  adapters\
	twitch.mjs					#twitch adapter shim
	discord.mjs					#discord adapter shim
  core\
	router.mjs					#mind router shim