// ESM file (your repo already runs ESM). Node 18+ recommended.
import "../modular_phase2/env-bootstrap.js";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import fs from "node:fs";
import path from "node:path";

const TOKEN = process.env.DISCORD_TOKEN;
const ALLOW = (process.env.DISCORD_DM_ALLOWLIST || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.error("[discord-dm] DISCORD_TOKEN missing in env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent // safe for DMs; enabled in dev portal
  ],
  partials: [Partials.Channel] // required to receive DMs
});

// === Logging to a daily file for troubleshooting patterns ===
const logDir = path.resolve("A:/Charity/logs");
fs.mkdirSync(logDir, { recursive: true });
function log(line) {
  const file = path.join(logDir, `discord-dm-${new Date().toISOString().slice(0,10)}.log`);
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
}

// --- Plug point to your existing ask pipeline ---
let askFn = null;
async function wireAsk() {
  // Option A: direct import if you export an ask-style function
  // (rename this path/export if your repo differs)
  try {
    const mod = await import("../modular_phase2/index.mod.js");
    askFn = mod.askText || mod.ask || null;
    if (askFn) {
      console.log("[discord-dm] askFn wired from modular_phase2/index.mod.js");
      return;
    }
  } catch { /* fall through */ }

  // Option B: HTTP gateway (if you expose one locally as POST /ask)
  // Uncomment and implement below if you already have an /ask endpoint.
  // askFn = async (prompt, user) => {
  //   const r = await fetch("http://127.0.0.1:3210/ask", {
  //     method: "POST",
  //     headers: { "content-type": "application/json" },
  //     body: JSON.stringify({ prompt, user })
  //   });
  //   const data = await r.json();
  //   if (!r.ok) throw new Error(data?.error || "ask endpoint error");
  //   return data.text;
  // };

  if (!askFn) {
    console.warn("[discord-dm] No askFn found. Replies will echo until you wire it.");
    askFn = async (prompt) => `[placeholder] I heard: ${prompt}`;
  }
}
await wireAsk();

client.on("ready", () => {
  console.log(`[discord-dm] logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.guildId !== null) return;      // DMs only
    if (ALLOW.length && !ALLOW.includes(msg.author.id)) {
      await msg.reply("Sorry, DMs are restricted right now.");
      return;
    }

    const prompt = (msg.content || "").trim();
    if (!prompt) return;

    const t0 = Date.now();
    const thinking = await msg.reply("🧭 On it...");
    const answer = await askFn(prompt, {
      platform: "discord",
      userId: msg.author.id,
      userName: msg.author.username,
    });

    // Discord DM limit ~2000 chars
    await thinking.edit(String(answer).slice(0, 2000));
    log(`OK ${msg.author.tag}\n>>> ${prompt}\n<<< ${String(answer).replace(/\n/g," ")}\n(${Date.now()-t0}ms)`);
  } catch (e) {
    log(`ERR ${e?.stack || e}`);
    try { await msg.reply("⚠️ I hit an error. Check logs on the server."); } catch {}
  }
});

client.login(TOKEN);
