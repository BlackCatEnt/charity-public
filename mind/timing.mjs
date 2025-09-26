// Wrap existing delays so the chat layer has one simple entry point.
import { delayFor, typingDelayFor, humanPause } from './delays.mjs';

export async function chatDelay(text = '', cfg = {}, kind = 'banter') {
  // Prefer per-word “typing” feel for short quips; length-based for longer lines
  const isShort = (text || '').length <= 120;
  const targetMs = isShort ? typingDelayFor(text) : await delayFor(text);
  // Optional extra human pause by kind (e.g., 'banter', 'system', 'narration')
  await humanPause(null, kind);
  // Final sleep to approximate the target
  await new Promise(r => setTimeout(r, targetMs));
}
