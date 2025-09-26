export function isCalcQuery(text='') {
  return /(\d+\s*[-+*/]\s*\d+|\bpercent\b|\bpercentage\b|\bETA\b|\bhow long\b|\badd\b\s+\d+\s+(days?|weeks?|hours?))/i.test(text);
}
export function calcInline(text='') {
  try {
    // very small: only + - * /
    const m = text.match(/(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const a = parseFloat(m[1]), op=m[2], b=parseFloat(m[3]);
    const r = op==='+'?a+b: op==='-'?a-b: op==='*'?a*b: a/b;
    return Number.isFinite(r) ? String(+r.toFixed(4)) : null;
  } catch { return null; }
}
