// hive/keeper/qos.mjs
import { metrics } from '../scribe/metrics.mjs';

export function tokenBucket({ capacity, refillPerSec }) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
    last = now;
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    return false;
  };
}

export function concurrencyLimiter({ max }) {
  let inFlight = 0;
  return async (fn) => {
    while (inFlight >= max) await new Promise((r) => setTimeout(r, 1));
    inFlight++;
    try {
      return await fn();
    } finally {
      inFlight--;
    }
  };
}

export function jitteredBackoff({ baseMs = 100, factor = 2, maxMs = 5000, jitterPct = 0.2 }) {
  return (attempt) => {
    const exp = Math.min(maxMs, baseMs * Math.pow(factor, attempt));
    const jitter = exp * jitterPct * (Math.random() * 2 - 1);
    return Math.max(0, Math.floor(exp + jitter));
  };
}

export function circuitBreaker({ failureThreshold = 8, cooldownSec = 30 }) {
  let fails = 0;
  let state = 'closed';
  let nextTry = 0;
  return {
    allow() {
      return state === 'closed' || Date.now() >= nextTry;
    },
    record(ok) {
      if (ok) {
        fails = 0;
        if (state === 'open') state = 'half';
        else state = 'closed';
      } else {
        fails++;
        if (fails >= failureThreshold) {
          state = 'open';
          nextTry = Date.now() + cooldownSec * 1000;
        }
      }
      metrics.gauge('keeper_qos_circuit_state', state === 'open' ? 2 : state === 'half' ? 1 : 0);
    },
    state: () => state,
  };
}

export function withQoS(handler, opts) {
  const allowToken = tokenBucket({ capacity: opts.burst, refillPerSec: opts.rps });
  const limit = concurrencyLimiter({ max: opts.concurrency });
  const backoff = jitteredBackoff(opts.backoff || {});
  const cb = circuitBreaker(opts.circuit || {});
  let draining = false;

  const run = async (task) => {
    if (draining) throw new Error('draining');
    if (!cb.allow()) {
      metrics.counter('keeper_skipped_circuit_total');
      throw new Error('circuit_open');
    }
    let attempt = 0;
    for (;;) {
      if (!allowToken()) {
        metrics.counter('keeper_throttled_total');
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      try {
        metrics.counter('keeper_attempt_total');
        const res = await limit(() => handler(task));
        cb.record(true);
        metrics.counter('keeper_success_total');
        return res;
      } catch (e) {
        cb.record(false);
        metrics.counter('keeper_failure_total');
        if (attempt++ >= opts.maxRetries) throw e;
        const wait = backoff(attempt);
        metrics.counter('keeper_retry_total');
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };

  const stop = () => {
    draining = true;
  };
  return { run, stop };
}
