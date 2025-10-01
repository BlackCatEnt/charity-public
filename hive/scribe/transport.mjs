// hive/scribe/transport.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Normalize the SCRIBE_TRANSPORT_URL string and return a transport object:
 * { name: "stdout"|"file"|"http", send(lines: string[]): Promise<void> }
 */
export function makeTransport(urlStr) {
  const t = normalize(urlStr);
  if (t.kind === "stdout") return stdoutTransport();
  if (t.kind === "file")   return fileTransport(t.filePath);
  if (t.kind === "http")   return httpTransport(t.href);
  throw new Error(`Unsupported SCRIBE_TRANSPORT_URL: ${urlStr}`);
}

/* -------------------- normalize helpers -------------------- */

function normalize(raw) {
  const s = String(raw ?? "").trim();
  // allow "stdout" or "stdout:"
  if (!s || s === "stdout" || s === "stdout:") return { kind: "stdout" };

  // file://A:/dir/file.ndjson or file:///A:/dir/file.ndjson
  if (s.toLowerCase().startsWith("file://")) {
    // strip scheme and leading slashes; keep drive letter on Windows
    let p = s.replace(/^file:\/+/i, "");
    return { kind: "file", filePath: p };
  }

  // bare Windows/posix path → treat as file
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith("/") || s.startsWith("\\")) {
    return { kind: "file", filePath: s };
  }

  if (/^https?:\/\//i.test(s)) return { kind: "http", href: s };

  throw new Error(`Unrecognized transport URL: ${raw}`);
}

/* -------------------- transports -------------------- */

function stdoutTransport() {
  return {
    name: "stdout",
    async send(lines) {
      const payload = Array.isArray(lines) ? lines.join("\n") + "\n" : String(lines) + "\n";
      process.stdout.write(payload);
    },
  };
}

function ensureDirSync(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fileTransport(filePath) {
  ensureDirSync(filePath);
  return {
    name: "file",
    async send(lines) {
      const payload = Array.isArray(lines) ? lines.join("\n") + "\n" : String(lines) + "\n";
      await fsp.appendFile(filePath, payload, "utf8");
    },
  };
}

function httpTransport(href) {
  return {
    name: "http",
    async send(lines) {
      const body = Array.isArray(lines) ? lines.join("\n") + "\n" : String(lines) + "\n";
      const res = await fetch(href, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body,
      });
      if (!res.ok) {
        const text = await safeText(res);
        const err = new Error(`HTTP ${res.status} ${res.statusText}`);
        err.code = `HTTP_${res.status}`;
        err.details = text?.slice(0, 400);
        throw err;
      }
    },
  };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}
