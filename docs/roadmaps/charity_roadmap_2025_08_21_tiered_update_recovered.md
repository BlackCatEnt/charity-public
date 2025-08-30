# Charity Twitch Bot – Development Roadmap (Aug 21 Addendum)
...1: Core Features (Expanded)

### 🎮 Observer Mode
- Add lightweight listener that can run 24/7 without speaking unless addressed or on trigger words.
- Create an “Observer” flag to throttle non-essential responses, reducing chat noise.
- Observer mode allows research and monitoring while minimizing chat footprint.

### 🧠 Memory Enhancements
- Add better summary and fact extraction.
- Strengthen “episodic memory” and depth of understanding.
- Allow toggling memory usage from commands (per‑user or global).

### 🛡️ Safety
- Include guardrails for sensitive topics with quick escalation to “ask permission.”
- Track confidence and disclose uncertainty in real time.

### 🧭 Rulebook + Personality
- Create a reference rulebook for Charity’s tone.
- Keep tone consistent (curious, kind, a little sassy) while staying helpful.
- Maintain the “Guild” worldbuilding tone.

---

## 2: User Experience Improvements

### ✨ Clean Responses
- Limit unsolicited replies to reduce potential spam.
- Favor short responses with the option to expand on request.
- Use simple structure: first answer, then optional “more?” prompt.

### 🔔 Notifications & Events
- Add lightweight announcement system for important events (starting soon, ASMR day, giveaways, raids).
- Integrate with OBS/Twitch events for timed notifications.
- Ad break notifications with guild related CTA for subscribing.

### 🧭 Commands UX
- Consolidate commands (`!ask`, `!help`, `!rules`) and improve discoverability.
- Include a “what I can do” list when asked.

---

## 3: Platform Integration

### 🎥 Twitch
- Stable connection to chat and real-time handling.
- Respect cooldowns and per-user throttles.
- Command rate-limiting; double-check message intervals to avoid drops.

### 💬 Discord (Phase 1)
- Add a simple bot to mirror `!ask` and DMs.
- Keep state synchronized per user where possible.

### 🎙️ Audio & Voice (Phase 2)
- Investigate Whisper-based ASR for stream audio.
- Explore per‑speaker diarization (identify Guild Master vs. guests).
- Add voice command hooks (like “Charity, note this”).

### IGDB
- Integration with https://www.igdb.com/ to be able to eventually post bagotrix's opinions of games he plays.

---

## 4: Knowledge & Retrieval

### 📚 Knowledge Base
- Start with docs folder and curated notes as the primary KB.
- Implement re-index script to rebuild vectors when the embedder changes.
- Add versioning so re-index does not lose provenance.

### 🔎 Retrieval Quality
- Improve top‑k selection and chunking.
- Integrate a re‑ranker for improved context selection (future).

---

## 5: Memory & Facts

### 🧾 Facts Pipeline
- Extract key claims and facts automatically from chat Discord and audio transcripts (later).
- Store source pointers (message ID/time stamp/channel/speaker).
- Record confidence and allow moderation.

### 📜 Episodic Memory
- Store chat events with speaker tags and importance.
- Track chronology and key moments for later recall.

---

## 6: Reliability & Telemetry

### 🛠️ Stability
- Ensure persistent uptime for LLM + bot connections.
- Auto-reconnect to Twitch/Discord when necessary.
- Detect and back off on rate limits.

### 📈 Metrics
- Add counters for token usage and response latency.
- Add local logging for error investigation.

---

## 7: Developer Ergonomics

### 🔧 Configuration Hygiene
- Standardize config file; keep a single source of truth.
- Provide “example config” with placeholders for public repo.

### 🧪 Testing
- Add minimal unit tests for critical utilities (chunking, vector size filter, fact extraction).
- Script to validate config and environment (path checker).

---

## 8: Roadmap Tiers

### Tier 0 — Baseline Stability
- Charity can join chat, answer `!ask`, and not crash.
- LLM running with safe defaults; latency within acceptable bounds.
- Minimal logging and error reporting.

### Tier 1 — Conversational Reliability
- Improved prompt templates and persona consistency.
- Guardrails for sensitive subjects with opt-in/opt-out visibility.
- Episodic memory storing speaker-tagged episodes.

### Tier 2 — Knowledgeable Assistant
- Reindexable KB with clean embeddings.
- Retrieval + prompt construction is reliable and cuts token bloat.
- Basic fact extraction pipeline (from chat) — with source and confidence.

### Tier 3 — Multi‑Source Intelligence
- Discord parity for `!ask` and basic channel listening.
- Audio ingestion (ASR) with diarization to distinguish Felix vs. others.
- Memory writes based on audio facts (opt‑in, privacy‑aware).

### Tier 4 — Production Polish
- Observability dashboard (latency, tokens, embeddings rate, errors).
- Reranker added for retrieval quality.
- Public doc mirror and publishing checklist.

### Tier 5 — Advanced Co‑Pilot
- Per‑viewer memories (consent‑based) with export/delete.
- Cross‑channel context stitching (Twitch + Discord + audio).
- Natural planning & tool use for small tasks.

---

## 9: Notes & Constraints
- Avoid leaking secrets to public repos (use example configs).
- Favor small, iterative releases; each tier should be shippable.
- Align with the “Guild” theme for consistent experience.

---

## 10: Immediate Next Steps (from Aug 21 context)
- Keep model stable on GPU for snappy responses.
- Reindex docs with current embedder and verify retrieval.
- Harden `!ask` and cooldowns.
- Add path checker and example config for mirror publishing.
- Begin drafting ASR+diarization plan for Phase 2.

