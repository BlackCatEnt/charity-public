import { info } from "#relics/telemetry.mjs";
import { QUEUE_DIR } from "#relics/paths.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Normalize any gateway event into a single shape */
export function toMessage(evt) {
  if (typeof evt === "string") {
    return { type: "user.input", source: "cli", session: "local", text: evt, ts: new Date().toISOString() };
  }
  const { type = "user.input", source = "unknown", session = "unknown", text = "", ts = new Date().toISOString() } = evt;
  return { type, source, session, text, ts };
}

/** Entry point */
export async function handleEvent(evt) {
  const msg = toMessage(evt);
  info("herald.received", { source: msg.source, session: msg.session, len: msg.text?.length ?? 0 });

  const rec  = { kind: "message", ...msg };
  const day  = new Date().toISOString().slice(0,10);
  const file = path.join(QUEUE_DIR, `${day}.jsonl`);

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(rec) + "\n", "utf8");
  return msg;
}
