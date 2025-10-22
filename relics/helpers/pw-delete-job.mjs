// relics/helpers/pw-delete-job.mjs
const pushUrl = (process.env.PUSHGATEWAY_URL || "http://localhost:9091").replace(/\/+$/, "");
function getArg(name) {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=")[1];
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}
const job = getArg("job") || process.env.SCRIBE_JOB || "scribe-smoke";
const url = `${pushUrl}/metrics/job/${encodeURIComponent(job)}`;
(async () => {
  try {
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[pw-delete] ${res.status} ${res.statusText} ${body}`);
      process.exit(1);
    }
    console.log(`[pw-delete] deleted ${url}`);
    process.exit(0);
  } catch (e) {
    console.error(`[pw-delete] error: ${e?.message || e}`);
    process.exit(2);
  }
})();
