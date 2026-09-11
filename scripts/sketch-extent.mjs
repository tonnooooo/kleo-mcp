/* Runs every drawing against a context that records where it actually puts ink, tracking the
   translate/rotate/scale the builder does itself, and prints how far each one reaches below its own
   centre. That number is the caption safe area: a table nobody has to guess at. */
import { readFileSync } from "node:fs";
const SRC = readFileSync("worker/keou/engine/sketch.js", "utf8");

function run(name, opts) {
  let m = [1, 0, 0, 1, 0, 0], stack = [], lo = 0, hi = 0, le = 0, ri = 0, w = 6;
  const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
  const pt = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const yy = m[1]*x + m[3]*y + m[5], xx = m[0]*x + m[2]*y + m[4];
    lo = Math.min(lo, yy - w); hi = Math.max(hi, yy + w);
    le = Math.min(le, xx - w); ri = Math.max(ri, xx + w);
  };
  const ctx = new Proxy({}, { get(_, k) {
    switch (k) {
      case "canvas": return { width: 2160, height: 3840 };
      case "save": return () => stack.push(m.slice());
      case "restore": return () => { m = stack.pop() ?? m };
      case "translate": return (x, y) => { m = mul(m, [1,0,0,1,x,y]) };
      case "rotate": return (a) => { m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]) };
      case "scale": return (x, y) => { m = mul(m, [x,0,0,y,0,0]) };
      case "setTransform": return () => { m = [1,0,0,1,0,0] };
      case "moveTo": case "lineTo": return (x, y) => pt(x, y);
      case "arc": return (x, y, r) => { pt(x - r, y - r); pt(x + r, y + r) };
      case "fillRect": case "strokeRect": case "rect": return (x, y, ww, h) => { pt(x, y); pt(x + ww, y + h) };
      case "createRadialGradient": case "createLinearGradient": return () => ({ addColorStop() {} });
      case "measureText": return () => ({ width: 100 });
      case "lineWidth": return w;
      default: return typeof k === "symbol" ? undefined : () => {};
    }
  }, set(_, k, v) { if (k === "lineWidth" && Number.isFinite(v)) w = v; return true } });
  const win = { document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } };
  const box = { __ART: null };
  new Function("window", "document", "globalThis_", SRC.replace("const ART = {};", "const ART = {}; globalThis_.__ART = ART;"))(win, win.document, box);
  win.KEOU_SKETCH.attach({ ctx, W: 1080, H: 1920 });
  for (const t of [0, .6, 1.4, 2.7]) box.__ART[name](t, .5, { es: 99, ...opts });
  return { up: Math.round(-lo), down: Math.round(hi), left: Math.round(-le), right: Math.round(ri) };
}

const names = [...SRC.matchAll(/^\s*ART\.(\w+)\s*=/gm)].map((x) => x[1]);
const table = {};
for (const n of names) {
  const a = run(n, {}), b = run(n, { count: 12, open: 1, open_to: 1, flash: true, no: true, text: "XXXXXXXX", mood: "scared", flip: true, xray: true });
  table[n] = { up: Math.max(a.up, b.up), down: Math.max(a.down, b.down), left: Math.max(a.left, b.left), right: Math.max(a.right, b.right) };
}
console.log(JSON.stringify(table));
console.error(Object.entries(table).map(([k, v]) => `${k.padEnd(12)} up ${String(v.up).padStart(4)} down ${String(v.down).padStart(4)} left ${String(v.left).padStart(4)} right ${String(v.right).padStart(4)}`).join("\n"));
