import { start } from "#hive/keeper/index.mjs";
const stop = start({});
process.on("SIGINT",  () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });