# Charity vNext — Architecture for a Multifunctional AI Companion (mini‑J.A.R.V.I.S.)

**Owner:** Felix (Guild Master)  
**Tech Lead:** 🌿 Sage  
**Target Host:** Home server (RTX 4080, Windows)  
**Status:** R1 Draft (foundation spec for long‑term evolution)

---

## 0) Goals & Non‑Goals

**Primary goals**
- Real‑time, personable co‑pilot that reads Twitch chat, Discord, and stream audio.
- Differentiates Felix’s voice from others (speaker diarization) and forms durable, queryable **facts** with provenance.
- Fast, consistent answers with strong reasoning and safe behavior.
- Evolvable: easy to upgrade models (LLM, embeddings, ASR) without rewriting the bot.

**Non‑goals (for now)**
- Full autonomy (Charity acts without consent).  
- Vision/scene understanding beyond text+audio (we’ll leave image/video for later phases).

**Design principles**
- Separation of concerns (Node for I/O + orchestration; Python for heavy ML).  
- Reproducibility (explicit config, pinned models).  
- Observability (structured logs, metrics, health checks).  
- Privacy & consent (opt‑in channels, redaction, per‑speaker controls).

---

## 1) High‑Level System

**Bot Runtime (Node.js)**
- Ingests Twitch (TMI) + Discord events.
- Orchestrates retrieval, memory, and LLM prompting.
- Enforces consent, safety, and persona voice.

**LLM Service (Ollama, GPU)**
- Generates responses with low latency.  
- Models: `llama3.1:8b-instruct-q8_0` (primary), with optional lighter fallback.

**Embedding Service (Python FastAPI, GPU‑capable)**
- Text embeddings (BGE‑M3 initial).  
- Supports batching, mixed precision, and re‑ranking (optional).

**ASR + Diarization Service (Python)**
- ASR: Whisper (e.g., faster‑whisper) for low‑latency transcription.  
- Diarization: e.g., pyannote to separate Felix vs others.

**Vector Store + Memories**
- Start: SQLite + JSON (simple, local).  
- Grow to: Qdrant or Milvus when scale demands.  
- Memory types: episodic (time‑ordered), semantic facts, KB docs.

**Re‑ranker (optional, later)**
- Cross‑encoder improves top‑k relevance before LLM.

---

## 2) Detailed Components & Contracts

### 2.1 Bot Runtime (Node)
- **Responsibilities:** adapters (Twitch/Discord), prompt composer, consent checks, retrieval flow, tool calls, logging.
- **Key modules:**
  - `router.js` — command/event routing
  - `ask.js` — end‑to‑end !ask flow
  - `embeddings.js` — client to embedding provider(s)
  - `episodic_store.js` — episodic memory (with dim filter)
  - `fact_extractor.js` — extracts, normalizes, and stores claims
  - `memory_*` — memory write/say helpers
- **Config:** `config/charity-config.json` (canonical), plus env overrides.

### 2.2 LLM Service (Ollama)
- **Port:** `11434`
- **Env knobs:**
  - `LLM_MODEL` (e.g., `llama3.1:8b-instruct-q8_0`)
  - `OLLAMA_FLASH_ATTENTION=1`
  - `OLLAMA_NUM_PARALLEL=1..2` (KV cache VRAM trade‑off)
  - `OLLAMA_MAX_LOADED_MODELS=1` (stability)
  - `OLLAMA_KEEP_ALIVE=10m` (warm cache)
- **Contract:** standard `/api/chat` JSON; Node passes `model`, `messages`, `options`.

### 2.3 Embedding Service (Python FastAPI)
- **Port:** `8000`
- **Model (initial):** `BGE‑M3` (1024‑dim)
- **Batching:** up to 64 texts per call; fp16; GPU if available; CPU fallback.
- **Endpoints:**
  - `POST /embeddings`
    ```json
    {
      "texts": ["string", "string"],
      "task": "passage|query",
      "normalize": true
    }
    ```
    **Response:**
    ```json
    {
      "model": "bge-m3",
      "dim": 1024,
      "embeddings": [[...],[...]]
    }
    ```
  - `POST /rerank` (optional)
    ```json
    {
      "query": "string",
      "candidates": ["string", "string"],
      "k": 10
    }
    ```
    **Response:** `{ "scores": [0.91, 0.76, ...] }`
- **Notes:** Expose `/healthz`, `/metrics` (prom‑friendly), and model info at `/about`.

### 2.4 ASR + Diarization Service (Python)
- **Port:** `8010`
- **ASR:** faster‑whisper small/medium; VAD for chunking (we want low latency).  
- **Diarization:** pyannote; maintain a voiceprint for Felix (enrolled speaker ID), tag others anonymously (`speaker_B`, `speaker_C`).
- **Endpoints:**
  - `POST /asr`
    - Input: wav/flac or stream URL; params `{lang?, diarize?:true}`
    - Output: segments with `{start, end, text, speaker, conf}`

### 2.5 Memory Stores & Schemas

**Episodic memory**
- `id, user_id, ts, text, v (vector), dim, importance, tags[]`
- **Search rule:** compare only rows with `row.dim === embedder.dim` (prevents mismatch).

**Semantic facts**
- `id, entity, claim, value?, sources[], first_seen, last_seen, confidence, speakers[]`
- Keep provenance: `{source: twitch|discord|asr, channel, message_id|segment_id, ts}`
- Periodically consolidate duplicates; increase confidence when corroborated.

**KB docs**
- `docs[]: { file, text, vec }` (fixed dim per embedder). Rebuild when model changes.

---

## 3) Retrieval & Response Pipeline

1) **Ingest** event (Twitch/Discord/ASR segment).  
2) **Consent/filters** (NSFW, privacy, throttles).  
3) **Fact extraction** (optional, async) → write semantic facts with provenance.  
4) **Retrieval**
   - Embed query (GPU service).  
   - Vector search in episodic + KB; filter by dimension.  
   - Optional **re‑rank** with cross‑encoder.  
5) **Compose prompt** (persona, guardrails, short context).  
6) **Generate** via Ollama (GPU).  
7) **Memory write‑back** (episodes, facts if new info observed).  
8) **Log** structured event, metrics.

**Latency targets** (steady state):
- Embedding: ≤ 25 ms / text (batched).  
- Retrieval+rerank: ≤ 40 ms.  
- LLM first token: ≤ 300 ms; full answer ≤ 1.5–3.0 s for short replies.

---

## 4) Deployment Topology (single‑box to start)

**Processes**
- Ollama (GPU) on 11434
- Embedding service (Python) on 8000
- ASR+diarization service (Python) on 8010
- Charity (Node) on 3000 (or as now)

**Supervision**
- PM2 or NSSM for Windows services; auto‑restart on crash; health endpoints.

**Ports & firewall**
- Bind Python services to `127.0.0.1` (local only).  
- Expose nothing publicly; Charity is the only caller.

---

## 5) Configuration & Paths

**Aliases (Node `package.json`)**
```json
{
  "type": "module",
  "imports": {
    "#modules/*": "./modular_phase2/modules/*.js",
    "#config/*": "./config/*.json",
    "#tools/*": "./tools/*.js",
    "#embeddings": "./modular_phase2/modules/embeddings.js"
  }
}
```

**Canonical paths (`config/paths.json`)**
```json
{
  "ROOT_DOCS": "./docs",
  "KB_INDEX": "./data/kb_index.json",
  "CONFIG": "./config/charity-config.json",
  "EMBED_ONNX": "C:/models/bge-m3.onnx",
  "EMBED_TOKENIZER": "C:/models/bge-m3-tokenizer.json"
}
```

**Environment variables (summary)**
- LLM: `LLM_MODEL`, `OLLAMA_FLASH_ATTENTION`, `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_KEEP_ALIVE`  
- Embeddings: `EMBED_PROVIDER`, `ORT_EP`, `BGE_M3_ONNX_PATH`, `BGE_M3_TOKENIZER_PATH`  
- Twitch: client id/secret, bot username, channel, refresh token  
- Discord: bot token, guild id(s)

---

## 6) Observability & Safety

- **Logs:** structured JSON (`level, ts, module, event, duration_ms`).  
- **Metrics:** request counts, latency histograms, token usage, GPU/VRAM.  
- **Health:** `/healthz` per service; Node aggregates to `!health` command.  
- **Safety:** profanity/PII filters, consent flags per source, speaker‑scoped memory writes.

---

## 7) NVIDIA BGE‑M3 Optimization Notes (for the embedding service)

- Cache frequently accessed doc vectors; reuse across sessions.  
- Tune K in nearest‑neighbor search per task.  
- Mixed‑precision (fp16/bf16) for throughput + lower memory.  
- Validate hyperparameters regularly (speed/accuracy balance).  
- Use TensorRT/ONNX optimizations where appropriate for deployment.

---

## 8) Phased Delivery Plan (append to roadmap)

**Phase A — Foundation**
- Lock config & path aliases; add path checker.  
- Ensure LLM on GPU (Ollama); embeddings can remain CPU until service lands.  
- Episodic memory “same‑dim” filter in place.

**Phase B — Embeddings Service (GPU)**
- Stand up FastAPI BGE‑M3; switch Node provider to `service`.  
- Batch, normalize, and add optional cross‑encoder rerank.

**Phase C — Audio Ingest (ASR + Diarization)**
- OBS audio tap → ASR → diarization; tag segments; write facts.  
- Add per‑speaker consent & privacy controls.

**Phase D — Scale & UX**
- Move vectors to Qdrant; add analytics dashboard; fine‑tune prompts; per‑viewer memory.

---

## 9) Open Questions & Decisions
- Preferred vector DB once we outgrow SQLite (Qdrant vs Milvus).  
- Reranker choice (bge‑reranker‑large vs LLM‑based).  
- Whisper model size vs latency trade‑off.  
- Security posture for future remote access.

---

## 10) Appendix — Minimal API Samples

**Embeddings (FastAPI)**
```http
POST /embeddings
Content-Type: application/json
{
  "texts": ["What’s our raid schedule?"],
  "task": "query",
  "normalize": true
}
```
**ASR**
```http
POST /asr
Content-Type: application/json
{
  "audio_url": "http://localhost:9000/mix.wav",
  "diarize": true,
  "lang": "en"
}
```

**Re‑rank**
```http
POST /rerank
{
  "query": "what did Felix say about the Raid event?",
  "candidates": ["..."],
  "k": 5
}
```

**Facts (internal write)**
```json
{
  "entity": "Felix",
  "claim": "is organizing a Finalfantasy XIV Raid",
  "sources": [{"type":"twitch","message_id":"...","ts": 1731634952}],
  "confidence": 0.82
}
```

