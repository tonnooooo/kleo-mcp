#!/usr/bin/env node
/**
 * One explainer, written by the real chain.
 *
 * scripts/explainer-plan-sweep.mjs answers "does the planner survive twenty-four subjects"; this answers
 * the different question that has to be settled before anything is rendered: given ONE subject and a real
 * model, is the storyboard that comes back a film — hook, pace, turn, payoff — or only a valid document?
 * It prints the rule report next to the storyboard, so the two are read together.
 *
 *   node scripts/explainer-make.mjs "<subject>" <out.json> [--long] [--lang it]
 *
 * Reads the Cloudflare account from wrangler.jsonc and the token from the wrangler OAuth session, so it
 * runs against the same Workers AI the deployed worker uses. It renders nothing and rents nothing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateStoryboard, planFor } from "../src/storyboard.ts";
import { checkExplainer } from "../src/explainer-plan.ts";
import { validateStoryboard } from "../src/keou-contract.ts";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const subject = args[0];
const out = args[1];
if (!subject || !out) { console.error('usage: explainer-make.mjs "<subject>" <out.json> [--long] [--lang it]'); process.exit(2) }
const long = args.includes("--long");
const language = args.includes("--lang") ? args[args.indexOf("--lang") + 1] : "en";
const [template, duration_s, format] = long ? ["explainer-long", 300, "16:9"] : ["explainer-short", 40, "9:16"];

/** The account the deployed worker uses, read from the same file wrangler reads. */
const jsonc = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
const account = /"account_id"\s*:\s*"([0-9a-f]+)"/.exec(jsonc)?.[1];
const token = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(`${process.env.HOME}/.wrangler/config/default.toml`, "utf8"))?.[1];
if (!account || !token) { console.error("no Cloudflare account or wrangler session"); process.exit(2) }

const env = {
  INTERNAL_SECRET: "x",
  AI: {
    async run(model, inputs) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(inputs),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) throw new Error(`${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
      return j.result;
    },
  },
};

const job = { id: "gt_make", template, prompt: subject, params: JSON.stringify({ duration_s, format, language, voice: null, style: "explainer" }) };
const t0 = Date.now();
let res;
try { res = await generateStoryboard(env, job) }
catch (e) { console.log(JSON.stringify({ ok: false, subject, error: String(e).slice(0, 400) })); process.exit(1) }

const sb = res.storyboard;
const v = validateStoryboard(sb, { format, language });
const rules = checkExplainer(sb.scenes, { duration: duration_s, language });
const drawings = sb.scenes.reduce((n, s) => n + (s.art?.length ?? 0), 0);
const names = [...new Set(sb.scenes.flatMap((s) => (s.art ?? []).map((a) => a.name)))];
const words = sb.scenes.reduce((n, s) => n + s.voice.split(/\s+/).filter(Boolean).length, 0);

writeFileSync(out, JSON.stringify(sb, null, 1) + "\n");
console.log(JSON.stringify({
  ok: v.ok && rules.length === 0,
  valid: v.ok, subject, out, template, language,
  title: sb.title, scenes: sb.scenes.length, drawings, distinct_drawings: names.length, words,
  seconds_of_speech: Math.round((words / 2.6) * 10) / 10,
  hook: sb.scenes[0]?.voice, payoff: sb.scenes.at(-1)?.voice,
  broken_rules: rules.map((r) => r.rule), rule_detail: rules.slice(0, 4).map((r) => r.message),
  contract_errors: v.ok ? [] : v.errors.slice(0, 4),
  attempts: res.attempts, model_calls_ms: Date.now() - t0,
}, null, 1));
