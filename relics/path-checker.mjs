// relics/path-checker.mjs
import 'dotenv/config';
import { readFile, access, mkdir } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.warn(`⚠️  ${m}`);
const err = (m) => console.error(`❌ ${m}`);

async function exists(p) {
  try { await access(p, FS.F_OK); return true; } catch { return false; }
}

async function readJson(p) {
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw);
}

async function main() {
  let failures = 0;

  // 1) Required folders
  const mustHaveDirs = [
    'boot', 'mind', 'heart', 'soul', 'rituals', 'halls', 'codex', 'relics', 'sentry', 'trials'
  ];
  for (const d of mustHaveDirs) {
    if (await exists(d)) ok(`folder present: ${d}`);
    else { failures++; err(`missing folder: ${d}`); }
  }

  // Ensure soul subfolders exist (create if missing)
  for (const d of ['soul/kb', 'soul/memory/episodes', 'soul/cache']) {
    if (!(await exists(d))) await mkdir(d, { recursive: true });
    ok(`ready: ${d}`);
  }

  // 2) package.json checks: type=module + import aliases
  const pkg = await readJson('package.json');
  if (pkg.type === 'module') ok(`package.json: "type":"module"`);
  else { failures++; err(`package.json missing "type":"module"`); }

  const aliases = pkg.imports || {};
  const requiredAliases = ['#mind/*', '#heart/*', '#soul/*', '#halls/*', '#rituals/*', '#codex/*', '#relics/*', '#sentry/*', '#core/*', '#adapters/*'];
  const missingAliases = requiredAliases.filter(a => !(a in aliases));
  if (missingAliases.length === 0) ok('package.json: path aliases present');
  else { failures++; err(`missing import aliases: ${missingAliases.join(', ')}`); }

  // 3) Manifest sanity
  if (!(await exists('codex/models.manifest.json'))) {
    failures++; err('codex/models.manifest.json not found');
  }
  const manifest = await readJson('codex/models.manifest.json').catch(() => null);
  if (!manifest) { failures++; err('models.manifest.json could not be parsed'); }
  else {
    ok('models.manifest.json parsed');

    // LLM
    if (manifest.llm?.engine === 'ollama') {
      const host = (process.env.OLLAMA_HOST ?? manifest.llm.host ?? '').toString();
      if (host) ok(`LLM engine=ollama host=${host}`);
      else { failures++; err('LLM ollama host not set (env OLLAMA_HOST or manifest.llm.host)'); }
      if (!manifest.llm.model) { failures++; err('LLM model missing'); }
      else ok(`LLM model=${manifest.llm.model}`);
    } else if (manifest.llm?.engine === 'onnxrt') {
      const base = process.env.MODELS_HOME ?? manifest.models_home ?? 'A:/models';
      const p = join(base, manifest.llm.path || '');
      if (manifest.llm.path && (await exists(p))) ok(`LLM onnx path ok: ${p}`);
      else { failures++; err(`LLM onnx path missing: ${p}`); }
    } else {
      warn('LLM engine not recognized; skipping check');
    }

    // Embeddings
    if (manifest.embeddings?.engine === 'service') {
      const host = (process.env.EMBED_HOST ?? manifest.embeddings.host ?? '').toString();
      if (host) ok(`Embeddings engine=service provider=${manifest.embeddings.provider || 'unknown'} host=${host}`);
      else { failures++; err('Embeddings service host not set (env EMBED_HOST or manifest.embeddings.host)'); }
    } else if (manifest.embeddings?.engine === 'onnxrt') {
      const base = process.env.MODELS_HOME ?? manifest.models_home ?? 'A:/models';
      const p = join(base, manifest.embeddings.path || '');
      if (manifest.embeddings.path && (await exists(p))) ok(`Embeddings onnx path ok: ${p}`);
      else { failures++; err(`Embeddings onnx path missing: ${p}`); }
    } else {
      warn('Embeddings engine not recognized; skipping check');
    }

    // ASR
    if (manifest.asr?.engine === 'none') ok('ASR disabled (engine=none)');
  }

  // 4) Env for halls (no secrets printed)
  const twitchVars = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_BROADCASTER', 'TWITCH_BOT_USERNAME', 'TWITCH_BOT_OAUTH'];
  const discordVars = ['DISCORD_BOT_TOKEN'];
  const missingTwitch = twitchVars.filter(v => !process.env[v]);
  const missingDiscord = discordVars.filter(v => !process.env[v]);

  if (missingTwitch.length) { warn(`Twitch env missing: ${missingTwitch.join(', ')}`); } else ok('Twitch env present');
  if (missingDiscord.length) { warn(`Discord env missing: ${missingDiscord.join(', ')}`); } else ok('Discord env present');

  // 5) Shim presence (for third-party snippets)
  const shimFiles = [
    'core/router.mjs',
    'adapters/twitch.mjs',
    'adapters/discord.mjs'
  ];
  for (const f of shimFiles) {
    if (await exists(f)) ok(`compat shim present: ${f}`);
    else warn(`compat shim missing (optional): ${f}`);
  }

  if (failures) {
    err(`Path check completed with ${failures} error(s).`);
    process.exit(1);
  } else {
    ok('All critical checks passed.');
    process.exit(0);
  }
}

main().catch(e => { err(e.stack || e.message); process.exit(1); });
