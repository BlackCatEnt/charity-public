// hive/keeper/log.mjs
// v0.2 Ops Polish — daily-rotating logger with retention cull
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LEVELS = ['debug','info','warn','error'];
const LEVEL_TO_INT = Object.fromEntries(LEVELS.map((l,i)=>[l,i]));

function pad(n){ return String(n).padStart(2,'0'); }
function ymd(date=new Date()){
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}

export class RotatingLogger {
  constructor({ dir, level='info', filenamePrefix='keeper', retentionDays=14 }) {
    this.dir = dir;
    this.level = LEVEL_TO_INT[level] ?? LEVEL_TO_INT.info;
    this.filenamePrefix = filenamePrefix;
    this.retentionDays = retentionDays;
    this.currentDate = ymd();
    this.stream = null;
    this._openStream();
    // opportunistic retention sweep once per process boot
    this._sweepOldLogs().catch(()=>{});
  }

  _logFilePath(dateStr=this.currentDate) {
    return path.join(this.dir, `${this.filenamePrefix}-${dateStr}.log`);
  }

  _openStream() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    if (this.stream) { try { this.stream.end(); } catch {} }
    const p = this._logFilePath();
    this.stream = fs.createWriteStream(p, { flags: 'a', encoding: 'utf8' });
  }

  _rollIfNeeded() {
    const now = ymd();
    if (now !== this.currentDate) {
      this.currentDate = now;
      this._openStream();
    }
  }

  _write(level, obj) {
    if ((LEVEL_TO_INT[level] ?? 1) < this.level) return;
    this._rollIfNeeded();
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, level, ...obj });
    try {
      this.stream.write(line + '\n');
    } catch (e) {
      // last-ditch: write to stderr
      try { process.stderr.write(`[keeper-log-fail] ${ts} ${e?.message}\n`); } catch {}
    }
  }

  debug(evt, data={}) { this._write('debug', { evt, ...data }); }
  info(evt, data={})  { this._write('info',  { evt, ...data }); }
  warn(evt, data={})  { this._write('warn',  { evt, ...data }); }
  error(evt, data={}) { this._write('error', { evt, ...data }); }

  async _sweepOldLogs() {
    const cutoff = Date.now() - this.retentionDays*24*3600*1000;
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return; }
    for (const f of files) {
      if (!f.startsWith(this.filenamePrefix+'-') || !f.endsWith('.log')) continue;
      const datePart = f.slice(this.filenamePrefix.length+1, f.length-4); // YYYY-MM-DD
      const t = Date.parse(datePart);
      if (!Number.isFinite(t)) continue;
      if (t < cutoff) {
        const p = path.join(this.dir, f);
        try { fs.unlinkSync(p); } catch {}
      }
    }
  }
}

export function createLogger({ dir, level, filenamePrefix='keeper', retentionDays=14 }) {
  return new RotatingLogger({ dir, level, filenamePrefix, retentionDays });
}

export default RotatingLogger;