import persona from '#heart/base/charity.base.json' assert { type: 'json' };
import manifest from '#codex/models.manifest.json' assert { type: 'json' };
import { createRouter } from '#mind/router.mjs';
import { makeOllamaLLM } from '#mind/llm/ollama.mjs';
import { makeKeywordRag } from '#mind/rag.keyword.mjs';
import { setRag } from '#mind/rag.store.mjs';
import { makeSafety } from '#mind/safety.mjs';
import { makeMemory } from '#mind/memory.mjs';


export async function makeOrchestrator({ cfg }) {
  const halls = new Map();

  // LLM from manifest (engine=ollama)
  const llmModel = manifest?.llm?.model || 'llama3.1:8b-instruct-q8_0';
  const llmHost  = (process.env.OLLAMA_HOST || manifest?.llm?.host || 'http://127.0.0.1:11434');
  const llm = makeOllamaLLM({ model: llmModel, host: llmHost });
  const rag = await makeKeywordRag({});
  setRag(rag);
  const memory = makeMemory();
  
  const router = createRouter({
    cfg,
    persona,
    safety: makeSafety(),
    rag,
    llm,
    memory
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
      console.log(`[boot] halls online: ${[...halls.keys()].join(', ')}`);
    },
    async stop() {
      for (const h of halls.values()) await h.stop();
    }
  };
}
