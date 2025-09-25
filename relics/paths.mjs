import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT         = path.resolve(here, "..");
export const QUEUE_DIR    = process.env.CHARITY_QUEUE_DIR   || path.join(ROOT, "relics", ".queue");
export const RUNTIME_DIR  = process.env.CHARITY_RUNTIME_DIR || path.join(ROOT, "relics", ".runtime");
export const EPISODES_DIR = path.join(ROOT, "soul", "memory", "episodes");
export const FEEDBACK_DIR = (month => path.join(ROOT, "rituals", "feedback", month))(new Date().toISOString().slice(0,7));
