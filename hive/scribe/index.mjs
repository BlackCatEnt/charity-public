import { info } from "#relics/telemetry.mjs";
import { EPISODES_DIR, FEEDBACK_DIR, RUNTIME_DIR } from "#relics/paths.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";

async function appendJsonl(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(obj) + "\n", "utf8");
}

export async function write(event) {
  const ts  = new Date().toISOString();
  const day = ts.slice(0,10);

  if (event.kind === "episode") {
    const file = path.join(EPISODES_DIR, `${day}.jsonl`);
    await appendJsonl(file, { ts, ...event.data });
    info("scribe.episode.write", { file, bytes: Buffer.byteLength(JSON.stringify(event.data)) });
    return { ok: true, file };
  }

  if (event.kind === "feedback") {
    const file = path.join(FEEDBACK_DIR, "feedback.jsonl");
    await appendJsonl(file, { ts, ...event.data });
    info("scribe.feedback.write", { file });
    return { ok: true, file };
  }

  const file = path.join(RUNTIME_DIR, "misc.jsonl");
  await appendJsonl(file, { ts, ...event });
  info("scribe.misc.write", { file });
  return { ok: true, file };
}

