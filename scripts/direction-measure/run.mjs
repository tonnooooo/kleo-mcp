#!/usr/bin/env node
/**
 * Asks the REAL model to choose a look for every held-out request, and counts how often it is right.
 *
 * The number everyone has been quoting — 26% — belongs to pickKleoStyle, the word list, which since the planner
 * learned to prefer the direction only decides when the model call fails. What the model chooses had never been
 * measured. This measures it, on the same held-out requests, so the two numbers can be put side by side.
 *
 *   npx wrangler dev --remote -c scripts/direction-measure/wrangler.jsonc --port 8799
 *   node scripts/direction-measure/run.mjs [--limit N] [--out file.json]
 *
 * One request costs one model call (~83 neurons of the 10,000 free daily ones), so the full 27 cost about a fifth
 * of a day. A call refused for quota costs nothing and returns in milliseconds, which is why waiting is free.
 */
import { HELD_OUT, HELD_OUT_2, HELD_OUT_3 } from "../adaptation.mjs";

const BENCH = process.env.BENCH || "http://127.0.0.1:8799";
const limit = Number(process.argv[process.argv.indexOf("--limit") + 1]) || Infinity;
const outFile = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const variant = process.argv.includes("--variant") ? process.argv[process.argv.indexOf("--variant") + 1] : "baseline";

const SETS = [
  ["A — ordinary requests, written by another session", HELD_OUT],
  ["B — ordinary requests, written by the engine session", HELD_OUT_2],
  ["C — the border: same topic, opposite form", HELD_OUT_3],
];

const ask = async (item) => {
  const r = await fetch(BENCH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: item.p, template: item.t || "viral-short", language: item.lang || "en", duration_s: item.duration_s || 45, variant }),
  });
  return r.json();
};

const rows = [];
let quotaOut = false;
for (const [name, set] of SETS) {
  console.log(`\n${name}`);
  for (const item of set) {
    if (rows.length >= limit) break;
    const a = await ask(item);
    if (!a.ok && /4006|daily free allocation/.test(a.error || "")) { quotaOut = true; console.log("  QUOTA ESAURITA: la misura si ferma qui, nessun neurone speso"); break; }
    const got = a.ok ? a.style : null;
    const ok = got === item.want;
    rows.push({ set: name[0], lang: item.lang, prompt: item.p, want: item.want, got, prior: a.prior, ok, why: a.why, neurons: a.usage ? Math.round(((a.usage.prompt_tokens ?? 0) * 0.27 + (a.usage.completion_tokens ?? 0) * 0.85) / 1e6 / 0.000011) : null });
    const mark = ok ? "OK  " : "MISS";
    console.log(`  ${mark} [${item.lang}] want ${String(item.want).padEnd(10)} model ${String(got).padEnd(10)} lista ${String(a.prior).padEnd(10)} ${item.p.slice(0, 46)}`);
    if (!ok && a.why) console.log(`         perche': ${String(a.why).slice(0, 110)}`);
  }
  if (quotaOut) break;
}

const done = rows.length;
const right = rows.filter((r) => r.ok).length;
const priorRight = rows.filter((r) => r.prior === r.want).length;
const neurons = rows.reduce((a, r) => a + (r.neurons || 0), 0);
console.log(`\n${"=".repeat(70)}`);
console.log(`  variante:        ${variant}`);
console.log(`  IL MODELLO:      ${right}/${done} = ${done ? Math.round((100 * right) / done) : 0}%`);
console.log(`  LA LISTA SOLA:   ${priorRight}/${done} = ${done ? Math.round((100 * priorRight) / done) : 0}%   (quello che si misurava finora)`);
console.log(`  neuroni spesi:   ~${neurons} dei 10.000 giornalieri`);
if (quotaOut && !done) console.log(`  NIENTE MISURATO: quota esaurita prima del primo tentativo.`);
if (outFile) { (await import("node:fs")).writeFileSync(outFile, JSON.stringify(rows, null, 2)); console.log(`  righe salvate in ${outFile}`); }
