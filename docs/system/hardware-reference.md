# Charity Hardware Reference

This document provides a quick reference for hardware requirements and recommendations when running Charity’s LLM and related systems. It is intended as a snapshot guide to inform upgrades and scaling decisions.

---

## Current Baseline (Recommended Today)
- **GPU:** RTX 4080 (16GB VRAM)
- **Model:** Local 13B instruct model (Q4–Q6 quantization)
- **Fallback:** Cloud “big model” only for complex planning or special events
- **System RAM:** 32GB recommended
- **Storage:** NVMe SSD, budget ~100GB+ for models + indexes
- **Result:** Fast, consistent, reliable — 90% local + occasional cloud bursts

---

## Model Size Reference Table

| Model Size | 4-bit VRAM | 6–8-bit VRAM | Practical Notes |
|------------|------------|--------------|----------------|
| 7B–8B      | ~6 GB      | ~8–12 GB     | Fits comfortably on RTX 4080. Great for routing and chat flavor. |
| 13B–14B    | ~10 GB     | ~14–18 GB    | Sweet spot on RTX 4080. Stronger tool use & tone consistency. |
| 30B+       | ~24 GB+    | ~30–40 GB    | Requires 24GB+ cards or multi-GPU rigs. Long-term only. |
| 70B        | ~45 GB+    | ~70–90 GB    | Server-grade or multi-GPU. Not feasible on single 4080. |

---

## Additional Notes
- **System RAM:** 32GB is recommended for embeddings, RAG pipelines, and tool integrations.  
- **Storage:** NVMe SSD strongly preferred. Models + indexes can grow to 100GB+ over time.  
- **Thermals/Power:** Streaming + inference can stress the GPU; maintain headroom to avoid OBS frame drops.  
- **Scalability:** Router + guardrails allow small models to handle 90% of tasks. Larger models should be used selectively, or via cloud fallback.

---

_Last updated: August 2025_
