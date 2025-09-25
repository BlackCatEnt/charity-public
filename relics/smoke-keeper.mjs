import { handleEvent } from "#hive/herald/index.mjs";
import { processQueueOnce } from "#hive/keeper/index.mjs";

await handleEvent("keeper smoke");
const n = await processQueueOnce();
console.log("keeper processed files:", n);