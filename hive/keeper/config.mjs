// hive/keeper/config.mjs
// v0.2 Ops Polish — Env-driven configuration with sane defaults
// Defaults preserve v0.1 behavior when envs are unset.

import path from 'node:path';
import fs from 'node:fs';

function coerceInt(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function coerceStr(v, def) {
  return (v === undefined || v === null || v === '') ? def : String(v);
}

function coerceLevel(v, def='info') {
  const allowed = new Set(['debug','info','warn','error']);
  const lvl = coerceStr(v, def).toLowerCase();
  return allowed.has(lvl) ? lvl : def;
}

export const CONFIG = Object.freeze({
  INTERVAL_MS: coerceInt(process.env.KEEPER_INTERVAL_MS, 2000),
  MAX_FILES_PER_TICK: coerceInt(process.env.KEEPER_MAX_FILES_PER_TICK, 50),
  RETAIN_PROCESSED_DAYS: coerceInt(process.env.KEEPER_RETAIN_PROCESSED_DAYS, 7),
  RETAIN_FAILED_DAYS: coerceInt(process.env.KEEPER_RETAIN_FAILED_DAYS, 30),
  LOG_DIR: path.resolve(coerceStr(process.env.KEEPER_LOG_DIR, 'relics/.runtime/logs')),
  LOG_LEVEL: coerceLevel(process.env.KEEPER_LOG_LEVEL, 'info'),
});

// Ensure log dir exists early (no-throw)
try { fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true }); } catch {}

export default CONFIG;