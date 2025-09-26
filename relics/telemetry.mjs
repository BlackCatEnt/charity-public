export function log(level, msg, meta = {}) {
  const ts = new Date().toISOString();
  const line = { ts, level, msg, ...meta };
  if (level === "error") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}
export const info  = (msg, meta) => log("info",  msg, meta);
export const warn  = (msg, meta) => log("warn",  msg, meta);
export const error = (msg, meta) => log("error", msg, meta);

