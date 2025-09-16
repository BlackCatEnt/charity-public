A:\Charity\
  boot\
    index.mjs                  # tiny boot: load codex, spin up mind, register halls
  mind\                         # (Core/orchestrator)
	stylepass.mjs 				# 	
	emotes.pick.mjs				# Light chooser
	moderation.mjs				# Evaluator (decides if a message violates)
	wizards/event_add.mjs		# Users can type normal sentences; the wizard asks for what’s missing, validates, and saves to the KB.
    capabilities.mjs			# Capabilities manifest (what exists, who can use it)
	reasoner.mjs				# (plan/check + self-consistency)
	confidence.mjs				# Confidence gate (evidence-first)
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
	affect.mjs					# Lightweight emotional memory (valence/arousal) + tone hint
	link.mjs					# Cross-platform account linking (Twitch↔Discord)
	postfilter.mjs				# Postfilter to sanitize outbound text
	events.mjs					# Events via chat + Discord Events sync
	guard.events.mjs			# Blocks confident "we're hosting X" style claims unless an event exists in KB.
  heart\                        # (Personality)
    base\charity.base.json
    overlays\README.md
    overlays\2025-09-11_humor-foundation.json
  soul\                         # (Data)
    kb\                         # knowledge base, chunks, provenance
	kb\index\               	# vector stores (gitignored)
    kb\charity-northstar.jsonl  
	kb\games.jsonl				# Local KB format
	memory\episodes\            # episodic logs
    cache\
	cache\onnxrt\           	# onnx/tensorrt runtime caches (gitignored)	
	games\igdb.mjs				# Game knowledge for spoiler checks
	games\index.mjs				# Games: facade (switches source)
  rituals\                      # (Training & curation)
    modlog\writer.mjs			# Modlog (JSONL per day)
	feedback\2025-09\           # realtime thumbs/tags as JSONL
    feedback\writer.mjs			# 
	snapshots\weekly\
    cli\charity-cli.mjs         # dataset:snapshot|load|rollback|health
    cli\feedback-snapshot.mjs	# Feedback Snapshot CLI → overlay suggestion
	cli\memory-backfill.mjs		# Backfill CLI (index past episodic logs)
  halls\                        # (Platform adapters)
    twitch\adapter.mjs
	twitch\mod.actions.mjs		# Act on violations (delete/timeout + sassy explain)
    discord\adapter.mjs
    shared\normalizers.mjs      # platform→unified event
  codex\                        # (Config & docs)
    moderation.config.json		# Config (what’s allowed + actions)
	models.manifest.json    	# small, versioned pointers to A:\models\
    charity.config.json         # single source of truth
	actors.json					# a tiny identity map and pass it into the LLM so she knows who’s speaking.
    README.md                   # map of metaphor → tech
  relics\                       # (Tools & scripts)
    calc.mjs					# Tiny math/date tool route
	path-checker.mjs        	# verifies manifest + filesystem
    publish.mjs
	tokens.mjs
	helix.mjs					# twitch helix client
	helix-smoke.mjs				# helix Smoke Test	
	publish.ps1					# Simple PowerShell publisher (Windows-friendly)
	twitch-validate.mjs			# tiny validator (tells you whose token it is + scopes)
	embeddings.mjs				# Embedding client (BGE-M3 service)
	sqlite.mjs					# SQLite helper (auto-creates schema)
	helix-get-users.mjs			# Twitch user IDs for moderators (and a handy CLI)
  sentry\                       # (Ops/observability hooks)
    metrics-exporter.mjs
	emotes.mjs					# Emote awareness (Discord + Twitch)
	gamewatch.mjs				# The watcher
  trials\                       # (Tests)
    e2e\
    unit\
  adapters\
	twitch.mjs					#twitch adapter shim
	discord.mjs					#discord adapter shim
  core\
	router.mjs					#mind router shim