// hive/scribe/index.mjs
// v0.2 Ops Polish — Real-ish Scribe adapter with failure classification and metrics
import { setTimeout as delay } from 'node:timers/promises';

export class Scribe {
  constructor({ logger, baseUrl='http://scribe.local/stub', simulate='auto' } = {}) {
    this.log = logger;
    this.baseUrl = baseUrl;
    this.simulate = simulate; // 'auto'|'success'|'retry'|'terminal'
    this.metrics = {
      keeper_scribe_sent: 0,
      keeper_scribe_retries: 0,
      keeper_scribe_dropped: 0,
    };
  }

  classifyError(e) {
    const code = e?.code ?? e?.status ?? e?.statusCode;
    if (code === undefined || code === null) {
      // Network-ish / unknown: assume retryable
      return { retryable: true, code: undefined };
    }
    if (code === 429) return { retryable: true, code };
    if (code >= 500) return { retryable: true, code };
    // Most 4xx are terminal
    return { retryable: false, code };
  }

  async send(record, { maxRetries=3, backoffMs=200 } = {}) {
    // HTTP stub: simulate success/failure modes without doing I/O.
    const mode = this.simulate;
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        await this.#fakeHttp(record, mode, attempt);
        this.metrics.keeper_scribe_sent++;
        this.log?.info?.('scribe.sent', { attempt });
        return true;
      } catch (e) {
        const { retryable, code } = this.classifyError(e);
        if (retryable && attempt <= maxRetries) {
          this.metrics.keeper_scribe_retries++;
          this.log?.warn?.('scribe.retry', { attempt, code, msg: e?.message });
          await delay(backoffMs * attempt);
          continue;
        }
        // terminal or out of retries
        this.metrics.keeper_scribe_dropped++;
        this.log?.error?.('scribe.drop', { attempt, code, msg: e?.message });
        return false;
      }
    }
  }

  async #fakeHttp(_record, mode, attempt) {
    // Modes:
    //  - 'success': always 200
    //  - 'retry'  : first one or two attempts -> 503, then 200
    //  - 'terminal': 400
    //  - 'auto'   : read flags from process.env or record.__force
    const flags = {
      forceRetry: process.env.SMOKE_FORCE_RETRY === '1' || _record?.__force === 'retry',
      forceTerminal: process.env.SMOKE_FORCE_TERMINAL === '1' || _record?.__force === 'terminal',
      forceSuccess: process.env.SMOKE_FORCE_SUCCESS === '1' || _record?.__force === 'success',
    };
    const effective = mode === 'auto'
      ? (flags.forceSuccess ? 'success' : (flags.forceTerminal ? 'terminal' : (flags.forceRetry ? 'retry' : 'success')))
      : mode;

    // tiny delay to mimic IO
    await delay(15);

    if (effective === 'success') return;
    if (effective === 'terminal') {
      const err = new Error('Bad Request');
      err.status = 400;
      throw err;
    }
    if (effective === 'retry') {
      if (attempt < 2) {
        const err = new Error('Service Unavailable');
        err.status = 503;
        throw err;
      }
      return; // success on retry
    }
    return;
  }
}

export default Scribe;