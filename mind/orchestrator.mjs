// A:\Charity\mind\orchestrator.mjs
import fs from "node:fs/promises";
import path from "node:path";
import persona from '#heart/base/charity.base.json' assert { type: 'json' };
import manifest from '#codex/models.manifest.json' assert { type: 'json' };
import { createRouter } from '#mind/router.mjs';
import { makeOllamaLLM } from '#mind/llm/ollama.mjs';
import { makeKeywordRag } from '#mind/rag.keyword.mjs';
import { setRag } from '#mind/rag.store.mjs';
import { makeSafety } from '#mind/safety.mjs';
import { makeMemory } from '#mind/memory.mjs';
import { makeVectorMemory } from '#mind/memory.vector.mjs';

const basePath = "A:/Charity/heart/base/charity.base.json";
const overlayPath = "A:/Charity/heart/overlays/2025-09-12_tone-casual.json";

function deepMerge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && typeof a === "object" && b && typeof b === "object") {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
    return out;
  }
  return b ?? a;
}

export async function loadPersona() {
  const [base, overlay] = await Promise.all([
    fs.readFile(basePath, "utf8"),
    fs.readFile(overlayPath, "utf8").catch(() => "{}")
  ]);
  return deepMerge(JSON.parse(base), JSON.parse(overlay));
}

export async function makeOrchestrator({ cfg }) {
  const halls = new Map();

  // LLM from manifest (engine=ollama)
  const llmModel = manifest?.llm?.model || 'llama3.1:8b-instruct-q6_K';
  const llmHost  = (process.env.OLLAMA_HOST || manifest?.llm?.host || 'http://127.0.0.1:11434');
  const llm = makeOllamaLLM({ model: llmModel, host: llmHost });
  const rag = await makeKeywordRag({});
  setRag(rag);
  const memory = makeMemory();
  const vmem   = await makeVectorMemory({});
  
  const router = createRouter({
    cfg,
    persona,
    safety: makeSafety(),
    rag,
    llm,
    memory,
	vmem
  });

  const io = {
    async send(roomId, text, meta = {}) {
      const hallName = meta.hall || meta.platform || 'twitch';
      const hall = halls.get(hallName);
      if (!hall) throw new Error(`No hall registered named "${hallName}"`);
      await hall.send(roomId, text, meta);
    },
    async ingest(evt) {
      try {
        await router.handle(evt, io);
      } catch (e) {
        console.error('[router] error handling event:', e?.stack || e?.message || e);
      }
    }
  };

  return {
    async registerHall(name, startHall) {
      const controller = await startHall({ ingest: io.ingest, send: io.send }, cfg);
      if (!controller?.send) {
        throw new Error(`Hall "${name}" must return { send, stop }`);
      }
      halls.set(name, {
        name,
        send: controller.send,
        stop: controller.stop || (async () => {})
      });
    },
    async start() {
      // (optional) use merged persona
      // const persona = await loadPersona();
      const { keeperLog } = await import("#hive/keeper/index.mjs");
      keeperLog({ type: "boot.online", halls: Array.from(halls.keys()) });
      const { scribeWrite } = await import("#hive/scribe/index.mjs");
      await scribeWrite({ type: "chat.msg", hall: "twitch", user: "bagotrix", len: 42 });
    },
    async stop() {
      for (const h of halls.values()) await h.stop();
    }
  };
}
