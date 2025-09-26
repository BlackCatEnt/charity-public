// relics/smoke-keeper.mjs
// v0.2 Ops Polish smoke: success, retry->success, terminal->failed

import { setTimeout as delay } from 'node:timers/promises';
import CONFIG from '../hive/keeper/config.mjs';
import { createLogger } from '../hive/keeper/log.mjs';
import Scribe from '../hive/scribe/index.mjs';
import { pathToFileURL } from 'node:url';

function parseArgs() {
  const flags = new Set(process.argv.slice(2));
  return {
    success: flags.has('--success'),
    retry: flags.has('--retry'),
    terminal: flags.has('--terminal'),
  };
}

async function main() {
  const args = parseArgs();
  const log = createLogger({
    dir: CONFIG.LOG_DIR,
    level: CONFIG.LOG_LEVEL,
    filenamePrefix: 'keeper',
    retentionDays: 14,
  });

  log.info('smoke.start', { args });

  const scribe = new Scribe({ logger: log, simulate: 'auto' });

  // Case 1: success
  if (args.success) {
    const ok = await scribe.send({ smoke: 'success', __force: 'success' });
	console.log('SMOKE success:', ok, scribe.metrics);
    log.info('smoke.case', { case: 'success', ok, metrics: scribe.metrics });
  }

  // Case 2: retry -> success
  if (args.retry) {
    const ok = await scribe.send({ smoke: 'retry', __force: 'retry' }, { maxRetries: 3, backoffMs: 50 });
	console.log('SMOKE retry  :', ok, scribe.metrics);
    log.info('smoke.case', { case: 'retry', ok, metrics: scribe.metrics });
  }

  // Case 3: terminal -> failed
  if (args.terminal) {
    const ok = await scribe.send({ smoke: 'terminal', __force: 'terminal' });
	console.log('SMOKE terminal:', ok, scribe.metrics);
    log.info('smoke.case', { case: 'terminal', ok, metrics: scribe.metrics });
  }

  log.info('smoke.done');
}
const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch(e => {
    console.error(e);
    process.exitCode = 1;
  });
}

export default main;