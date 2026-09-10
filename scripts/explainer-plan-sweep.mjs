#!/usr/bin/env node
/**
 * The same twenty-four prompts as test/explainer-planner.test.mjs, but against the real model.
 *
 * The offline sweep proves the planner survives a model that answers badly in the ways we already know
 * about. This one asks the harder question: given a real Workers AI model and a subject nobody wrote
 * the style for, does the film that comes back actually obey the rules — the hook, the pace, the turn,
 * the payoff — or does it merely validate? It prints a table of which rule failed how often, which is
 * the only honest way to decide whether a rule needs a better prompt or a mechanical repair.
 *
 * It costs real Workers AI calls and renders nothing.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/explainer-plan-sweep.mjs [--long] [--limit N]
 */
import { generateStoryboard, planFor } from "../src/storyboard.ts";
import { checkExplainer } from "../src/explainer-plan.ts";
import { validateStoryboard } from "../src/keou-contract.ts";

const PROMPTS = [
  ["en", "Why bread rises: what yeast is actually doing in the dough while you wait."],
  ["en", "How a volcano decides when to erupt, and why the warning signs are always the same three."],
  ["en", "What your bank actually does with the money you deposit on Monday morning."],
  ["en", "The Roman aqueduct that still carries water, and the one engineering idea behind it."],
  ["en", "Why planes are struck by lightning and nothing happens to anyone on board."],
  ["en", "How noise-cancelling headphones cancel a sound by making the opposite of it."],
  ["it", "Perché il caffè espresso esce amaro e i due errori che lo causano ogni volta."],
  ["it", "Come funziona davvero un vaccino a mRNA, spiegato senza una sola parola tecnica."],
  ["it", "La truffa del finto corriere: come arriva l'SMS e cosa succede se tocchi il link."],
  ["fr", "Pourquoi la Tour Eiffel grandit de quinze centimètres chaque été."],
  ["fr", "Comment une batterie de voiture électrique perd sa capacité, et à quelle vitesse."],
  ["en", "What happens in your body during the first ten minutes of a cold shower."],
  ["en", "Why supermarket eggs are never washed in Europe and always washed in America."],
  ["en", "How a mortgage rate is set, and who actually decides the number you are offered."],
  ["en", "The physics of a curveball: why the ball turns and the batter cannot see it coming."],
  ["en", "How doctors find a broken bone that does not show up on the first X-ray."],
  ["en", "Why the deep sea is dark but not empty, and what lives at four kilometres down."],
  ["en", "How your phone knows it is you before you touch it, and what it stores to do that."],
  ["en", "The day the Mississippi ran backwards, and the fault line that did it."],
  ["en", "Why concrete from two thousand years ago outlasts concrete poured last year."],
  ["en", "How a password becomes a hash, and why the website cannot read yours back."],
  ["en", "What a wildfire does to soil, and why the second year is worse than the first."],
  ["en", "How the postal system routes a letter with a wrong postcode to the right street."],
  ["en", "Why some songs get stuck in your head and the trick that reliably clears them."],
];

const args = process.argv.slice(2);
const long = args.includes("--long");
const limit = Number(args[args.indexOf("--limit") + 1]) || PROMPTS.length;
const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) { console.error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"); process.exit(2) }

/** env.AI, over the REST API, so the sweep runs from a terminal instead of inside a Worker. */
const env = {
  INTERNAL_SECRET: "x",
  AI: {
    async run(model, inputs) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(inputs),
      });
      const j = await r.json();
      if (!r.ok || j.success === false) throw new Error(`${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
      return j.result;
    },
  },
};

const [template, dur, format] = long ? ["explainer-long", 300, "16:9"] : ["explainer-short", 45, "9:16"];
const tally = new Map();
const rows = [];
for (const [i, [language, prompt]] of PROMPTS.slice(0, limit).entries()) {
  const job = { id: `sweep_${i}`, template, prompt, params: JSON.stringify({ duration_s: dur, format, language, voice: null, style: "explainer" }) };
  const t0 = Date.now();
  let row;
  try {
    const res = await generateStoryboard(env, job);
    const plan = planFor(job);
    const v = validateStoryboard(res.storyboard, { format, language });
    const rules = checkExplainer(res.storyboard.scenes, { duration: dur, language });
    for (const x of rules) tally.set(x.rule, (tally.get(x.rule) ?? 0) + 1);
    const drawings = res.storyboard.scenes.reduce((n, s) => n + (s.art?.length ?? 0), 0);
    row = { i: i + 1, language, ok: v.ok, scenes: res.scenes, words: res.words, drawings, rules: rules.map((r) => r.rule), attempts: res.attempts, s: ((Date.now() - t0) / 1000).toFixed(0), errors: v.ok ? [] : v.errors.slice(0, 2) };
  } catch (e) {
    row = { i: i + 1, language, ok: false, scenes: 0, words: 0, drawings: 0, rules: ["THREW"], s: ((Date.now() - t0) / 1000).toFixed(0), errors: [String(e).slice(0, 200)] };
    tally.set("THREW", (tally.get("THREW") ?? 0) + 1);
  }
  rows.push(row);
  console.log(`${String(row.i).padStart(2)} ${row.language} ${row.ok ? "valid  " : "INVALID"} ${String(row.scenes).padStart(2)} scenes ${String(row.drawings).padStart(3)} drawings ${String(row.words).padStart(3)}w ${row.s}s  ${row.rules.join(",") || "—"}${row.errors.length ? "  " + row.errors.join(" | ") : ""}`);
}

console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} valid · ${rows.filter((r) => r.ok && !r.rules.length).length}/${rows.length} valid AND rule-clean`);
console.log("rule violations across the sweep:");
for (const [rule, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${rule}`);
