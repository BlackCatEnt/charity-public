# Charity Twitch Bot – Development Roadmap (Aug 21 Addendum)
✅ Completed

Tier 0 — Baseline Stability

Charity can join Twitch chat, respond to !ask, and stay online without crashing.

GPU acceleration stable on RTX 4080 (CUDA 12.9).

Logging and preflight checks in place.

Phase 2 – Strategic Builders

✅ Town Crier (Ad Timer) v0.1 — shipped (warns/snoozes/manual-run, throttled chatter).

In Progress: Guild Guard Filters v0.1

Scope: banned-terms, caps/emote spam, link policy, lore warnings, per-user cooldown, optional timeout, mod commands, runtime persistence.

Next: v0.2 — auto-permit via !permit <user> (temporary link allow), OBS log overlay, per-rule analytics.

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

🎯 Current Focus: Tier 1–2 Features
Tier 1 — Conversational Reliability
Tier 2 — Knowledgeable Assistant

📌 Next Candidate (after Tier 1–2)

Phase 2 community immersion (Guild Guard Filters + Town Crier).

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

## Technical Foundations

 ### LLM Strategy
- **Daily Driver (Local 13B):**  
   Charity should default to a strong 13B instruct model running locally. This improves function calling and tone consistency compared to 7B while staying compatible with existing hardware (RTX 4080).

- **Router + Guardrails:**  
   All moderation and tool routing should flow through deterministic filters, classifiers, and rules. The LLM provides flavor and narrative, but moderation reliability comes from the guardrail stack, not just scaling the model.

- **Big Model Fallback (Cloud):**  
   For complex planning, special events, or unusually hard cases, Charity may “phone a friend” 🌿 and escalate to a large hosted model. This should be rare (≤10% of requests) to keep latency low and operations predictable.

- **Hybrid Design Goal:**  
   Keep 90% of Charity’s runtime local and fast, with burst capability into cloud scale only when strategically necessary.

- **Recommended Today:**  
   RTX 4080 + 13B local model as the daily driver, with cloud fallback for complex cases.

## Future Phases
- **Exploration of Larger Local Models:**  
   Depending on Charity’s success and community growth, future phases may consider local deployment of 30B+ class models. This would require upgraded hardware (e.g., 24GB+ VRAM GPUs or multi-GPU setups).  
   This is strictly a long-term, aspirational plan, not part of the immediate roadmap. Current focus remains on maximizing efficiency and reliability with 13B local + cloud fallback.

   **Hardware Quick Reference:**  
   • 7B–8B → ~6–12 GB VRAM (fits comfortably on RTX 4080).  
   • 13B–14B → ~10–18 GB VRAM (ideal on RTX 4080 16GB).  
   • 30B+ → ~24–40 GB VRAM (24GB+ cards or dual GPUs).  
   • 70B → 48GB+ VRAM per GPU, or multi-GPU server-grade hardware.  
   • System RAM: 32GB recommended for RAG + tools.  
   • Storage: NVMe, budget ~100GB+ for models + indexes.
