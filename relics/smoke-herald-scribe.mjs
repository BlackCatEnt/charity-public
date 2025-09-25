import { handleEvent } from "#hive/herald/index.mjs";
import { write } from "#hive/scribe/index.mjs";

const msg = await handleEvent("hello from the smoke test");
await write({ kind: "episode", data: { actor: "cli", text: msg.text } });
console.log("smoke ok");
