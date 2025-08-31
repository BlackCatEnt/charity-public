// tools/intent-smoke.mjs
import 'dotenv/config';
import { classifyIntent } from '../modular_phase2/modules/reasoner_llm.js';
import { createEmbedder } from '#embeddings';

const arg = process.argv.slice(2).join(' ').trim() || 'Hello, how are you?';
const embedder = await createEmbedder();

console.log('utter:', arg);
const intent = await classifyIntent(arg, { embedder });
console.log('classifyIntent:', intent);
