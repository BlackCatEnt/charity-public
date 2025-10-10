// A:\Charity\hive\keeper\qos.mjs
import crypto from "node:crypto";


export class TokenBucket {
constructor({ tokensPerSec, bucketSize }) {
this.capacity = bucketSize;
this.tokensPerSec = tokensPerSec;
this.tokens = bucketSize;
this.last = Date.now();
}
allow(n = 1) {
const now = Date.now();
const delta = (now - this.last) / 1000;
this.tokens = Math.min(this.capacity, this.tokens + delta * this.tokensPerSec);
this.last = now;
if (this.tokens >= n) { this.tokens -= n; return true; }
return false;
}
}


export class IdemStore {
constructor(ttlMs = 86400000) {
this.ttl = ttlMs; // default 24h
this.map = new Map();
}
_gc() {
const now = Date.now();
for (const [k, v] of this.map) if (v.expires <= now) this.map.delete(k);
}
has(key) {
this._gc();
return this.map.has(key);
}
put(key, meta = {}) {
this._gc();
this.map.set(key, { meta, expires: Date.now() + this.ttl });
}
static keyFor(evt) {
// stable key: source + type + content hash if payload is large
const base = `${evt.source||"?"}:${evt.type||"?"}:${evt.id||"?"}`;
if (evt.payload && typeof evt.payload === "object") {
const h = crypto.createHash("sha1").update(JSON.stringify(evt.payload)).digest("hex");
return `${base}:${h}`;
}
return base;
}
}


export class BoundedQueue {
constructor(maxSize, overflowPolicy = "reject", spillFn = null) {
this.max = maxSize; this.policy = overflowPolicy; this.q = [];
this.spillFn = spillFn; // async (item) => void to DLQ
}
size() { return this.q.length; }
push(item) {
if (this.q.length < this.max) { this.q.push(item); return { ok: true }; }
switch (this.policy) {
case "reject":
return { ok: false, reason: "queue_full" };
case "drop_oldest":
this.q.shift(); this.q.push(item); return { ok: true, dropped: "oldest" };
case "spill_to_dlq":
if (this.spillFn) this.spillFn(item);
return { ok: false, reason: "spilled_to_dlq" };
default:
return { ok: false, reason: "unknown_policy" };
}
}
pop() { return this.q.shift(); }
}