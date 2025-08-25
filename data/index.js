// data/index.js — boot shim for modular Phase 2
// Works in both CommonJS and ESM projects by using dynamic import.
(async () => {
  try {
    await import('../modular_phase2/index.mod.js');
  } catch (err) {
    console.error('[boot] failed to load modular entry:', err);
    process.exitCode = 1;
  }
})();
