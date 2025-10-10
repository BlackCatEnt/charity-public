// Lightweight TTL cache for message/event IDs
export class RecentIdCache {
  constructor({ ttlMs = 10_000, max = 2000 } = {}) {
    this.ttl = ttlMs;
    this.max = max;
    this.map = new Map(); // id -> expiresAt
  }
  has(id) {
    if (!id) return false;
    this._gc();
    return this.map.has(id);
  }
  add(id) {
    if (!id) return;
    this._gc();
    this.map.set(id, Date.now() + this.ttl);
    if (this.map.size > this.max) this._trim();
  }
  _gc() {
    const now = Date.now();
    for (const [k, exp] of this.map) { if (exp <= now) this.map.delete(k); }
  }
  _trim() {
    // remove oldest insertions to bound memory
    let toRemove = this.map.size - this.max;
    for (const k of this.map.keys()) {
      this.map.delete(k);
      if (--toRemove <= 0) break;
    }
  }
}
