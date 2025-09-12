A:\Charity\
  boot\
    index.mjs                  # tiny boot: load codex, spin up mind, register halls
  mind\                         # (Core/orchestrator)
    orchestrator.mjs
    bus.mjs
    router.mjs                  # unified message pipeline
    safety.mjs
    delays.mjs                  # human-like timing
    telemetry.mjs
  heart\                        # (Personality)
    base\charity.base.json
    overlays\README.md
    overlays\2025-09-11_humor-foundation.json
  soul\                         # (Data)
    kb\                         # knowledge base, chunks, provenance
	kb\index\               	# vector stores (gitignored)
    memory\episodes\            # episodic logs
    cache\
	cache\onnxrt\           	# onnx/tensorrt runtime caches (gitignored)	
  rituals\                      # (Training & curation)
    feedback\2025-09\           # realtime thumbs/tags as JSONL
    snapshots\weekly\
    cli\charity-cli.mjs         # dataset:snapshot|load|rollback|health
  halls\                        # (Platform adapters)
    twitch\adapter.mjs
    discord\adapter.mjs
    shared\normalizers.mjs      # platform→unified event
  codex\                        # (Config & docs)
    models.manifest.json    	# small, versioned pointers to A:\models\
    charity.config.json         # single source of truth
    README.md                   # map of metaphor → tech
  relics\                       # (Tools & scripts)
    path-checker.mjs        	# verifies manifest + filesystem
    publish.mjs
  sentry\                       # (Ops/observability hooks)
    metrics-exporter.mjs
  trials\                       # (Tests)
    e2e\
    unit\
