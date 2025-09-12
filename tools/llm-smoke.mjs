// tools/llm-smoke.mjs
import { classifyIntent } from '../modular_phase2/modules/reasoner_llm.js';
import { createEmbedder } from '#embeddings';
import { MODELS } from '../modular_phase2/modules/llm.js';

const utter = process.argv.slice(2).join(' ') || 'Hello, how are you?';

console.log('Using:', MODELS);

const embedder = await createEmbedder().catch(() => null);
const result = await classifyIntent(utter, { embedder });

console.log('utter:', utter);
console.log('classifyIntent:', result);
