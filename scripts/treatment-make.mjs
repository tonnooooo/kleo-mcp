#!/usr/bin/env node
/**
 * One request, N treatments, the real model.
 *
 * The unit tests prove the shape; only the production model can show whether what comes back is a film a
 * producer would sign, and whether two runs of the same request come back as two films. This asks Workers AI
 * for N treatments of one request (N seeds, so N draws) and prints them, plus a distance between them.
 *
 *   node scripts/treatment-make.mjs "<request>" [--n 2] [--duration 60] [--format 16:9] [--lang it] [--model <id>] [--out dir]
 *
 * Reads the account from wrangler.jsonc and the token from the wrangler OAuth session (the same Workers AI the
 * deployed worker uses). It renders nothing and rents nothing. Cost: one treatment on scout is ~150-250 neurons.
 * WRITE A LINE IN scripts/direction-measure/QUOTA.md BEFORE RUNNING: the daily bucket is shared by every session.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { writeTreatment } from "../src/storyboard.ts";
import { treatmentText, proseDistance as distance } from "../src/treatment.ts";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const request = args[0];
if (!request || request.startsWith("--")) { console.error('usage: treatment-make.mjs "<request>" [--n 2] [--duration 60] [--format 16:9] [--lang it] [--model <id>] [--out dir]'); process.exit(2); }
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const n = Number(opt("--n", 2));
const duration_s = Number(opt("--duration", 60));
const format = opt("--format", "16:9");
const language = opt("--lang", "en");
const outDir = opt("--out", null);

const jsonc = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
const account = /"account_id"\s*:\s*"([0-9a-f]+)"/.exec(jsonc)?.[1];
const token = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(`${process.env.HOME}/.wrangler/config/default.toml`, "utf8"))?.[1];
if (!account || !token) { console.error("no Cloudflare account or wrangler session"); process.exit(2); }
/** The model production plans with, unless --model says otherwise: a treatment measured on another model is a number about that model. */
const model = opt("--model", /"AI_MODEL"\s*:\s*"([^"]+)"/.exec(jsonc)?.[1]);

const env = {
  AI_MODEL: model,
  AI: {
    async run(m, inputs) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${m}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(inputs),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) throw new Error(`${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
      return j.result;
    },
  },
};

if (outDir) mkdirSync(outDir, { recursive: true });
const results = [];
for (let i = 0; i < n; i++) {
  const seed = `bench_${Date.now().toString(36)}_${i}`;
  const t0 = Date.now();
  const r = await writeTreatment(env, { prompt: request, duration_s, format, language }, { seed, model });
  results.push(r);
  console.log(`\n===== treatment ${i + 1}/${n} · model ${r.model} · ${r.attempts} attempt(s) · ${Date.now() - t0} ms · ~${r.est_neurons} neurons · tokens ${r.usage.prompt_tokens}+${r.usage.completion_tokens}`);
  if (!r.treatment) { console.log(`NONE: ${r.history.join(" | ")}`); continue; }
  console.log(treatmentText(r.treatment).replace(/\n\nNEXT STEP[\s\S]*$/, ""));
  if (outDir) writeFileSync(resolve(outDir, `treatment-${i + 1}.json`), JSON.stringify(r.treatment, null, 1) + "\n");
}
const ok = results.filter((r) => r.treatment);
const summary = { request, model, duration_s, format, language, asked: n, written: ok.length, neurons: results.reduce((s, r) => s + (r.est_neurons ?? 0), 0),
  draws: ok.map((r) => r.treatment.variation), loglines: ok.map((r) => r.treatment.logline), words: ok.map((r) => r.treatment.prose.split(/\s+/).length) };
if (ok.length >= 2) {
  const d = [];
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) d.push(distance(ok[i].treatment.prose + ok[i].treatment.logline, ok[j].treatment.prose + ok[j].treatment.logline));
  summary.distance = { min: Math.min(...d).toFixed(2), mean: (d.reduce((a, b) => a + b, 0) / d.length).toFixed(2) };
}
console.log("\n" + JSON.stringify(summary, null, 1));
process.exit(ok.length === n ? 0 : 1);
