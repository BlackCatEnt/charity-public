export function nextDelayMs({attempt, base=250, factor=2, cap=120000}){
const max = Math.min(cap, Math.floor(base * (factor ** attempt)));
return Math.floor(Math.random() * (max + 1));
}


export async function withRetry(sendFn, opts={}){
const {base=250, factor=2, cap=120000, maxRetries=8, onAttempt} = opts;
for (let attempt=0; attempt<=maxRetries; attempt++){
onAttempt?.(attempt);
try { return await sendFn(); }
catch (err){
if (attempt === maxRetries) throw err;
const delay = nextDelayMs({attempt, base, factor, cap});
await new Promise(r=>setTimeout(r, delay));
}
}
}