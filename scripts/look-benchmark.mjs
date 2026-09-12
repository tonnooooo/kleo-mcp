#!/usr/bin/env node
/**
 * Can Kleo tell which LOOK a request is asking for, from the request alone?
 *
 * The number this answers used to be 26 %, measured over prompts written blind by two sessions that had
 * not read the code. But that measured the KEYWORD fallback — three regular expressions over the prompt —
 * and not the model. Kleo has always had a better channel: step zero of the planner asks a model to read
 * the request and choose the look with a reason. Until 11 September 2026 that prompt offered four looks
 * and the drawn explainer was not one of them, so the model could not choose a thing it was never told
 * existed. This measures both channels side by side over the same held-out prompts.
 *
 *   node scripts/look-benchmark.mjs            both channels, all prompts
 *   node scripts/look-benchmark.mjs --words    the keyword fallback only, no model calls, free
 *
 * One model call per prompt, not one storyboard: the direction stage is isolated on purpose, because a
 * benchmark that cannot isolate the stage it measures is measuring something else.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { directionPrompt, directionSchema, planFor, pickKleoStyle } from "../src/storyboard.ts";

const root = resolve(import.meta.dirname, "..");

/**
 * HELD OUT, AND NOT OWNED BY THIS FILE.
 *
 * The prompts and their expected answers live in scripts/adaptation.mjs, which is where the corpus is kept.
 * They are read from there rather than copied, and the reason is a mistake made twice in one night.
 *
 * The session that keeps the corpus normalised three of another session's labels from "explainer" to
 * "cyber" while transcribing them — not out of carelessness, but toward what the tool being measured could
 * actually produce, which turns the measurement into the tool agreeing with itself. Then this file did the
 * same thing: written from the author's own message a few hours later, it had quietly moved "how does a
 * traffic light know a car is waiting" and "what happens to the money when I tap my card" from cyber to
 * explainer, both toward the style this session owns, and loosened two others with an extra accepted
 * answer that was never offered.
 *
 * Whoever can edit the answers will drift them toward what their own tool does well. The fix is not to be
 * more careful: it is to have one copy, owned by someone who is not measuring themselves with it.
 */
const SRC = readFileSync(resolve(root, "scripts/adaptation.mjs"), "utf8");
/** The corpus is kept in three named sets — one per session that wrote prompts blind. All of them count. */
const set = (name) => {
  const at = SRC.indexOf(`export const ${name} = [`);
  if (at < 0) return [];
  const from = SRC.indexOf("[", at), to = SRC.indexOf("\n];", from) + 2;
  return new Function(`return ${SRC.slice(from, to)}`)();
};
const PROMPTS = ["HELD_OUT", "HELD_OUT_2", "HELD_OUT_3"].flatMap((n) => set(n).map((x) => ({ set: n, lang: x.lang, text: x.p, expect: x.want, also: x.also, pair: x.pair })));
if (PROMPTS.length < 20) { console.error(`only ${PROMPTS.length} prompts read from the corpus — the sets moved, fix the reader before trusting a number`); process.exit(2) }

const words = process.argv.includes("--words");
const WRANGLER = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
const account = /"account_id"\s*:\s*"([0-9a-f]+)"/.exec(WRANGLER)?.[1];
/** The model production plans with, read from the same file production reads. The first version of this
 *  file named a 70B model by hand and scored 81 % on it; production runs a 17B model and scored 70 % on the
 *  same prompt. A benchmark that measures a different model than the one shipping measures nothing. */
const MODEL = /"AI_MODEL"\s*:\s*"([^"]+)"/.exec(WRANGLER)?.[1] ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
console.error(`modello: ${MODEL}`);
const token = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(`${process.env.HOME}/.wrangler/config/default.toml`, "utf8"))?.[1];

const AI = {
  async run(model, inputs) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(inputs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 200)}`);
    return j.result;
  },
};

const job = (p) => ({ id: "gt_bench", template: "viral-short", prompt: p.text, params: JSON.stringify({ duration_s: 45, format: "9:16", language: p.lang, voice: null }) });

/** Just step zero: one call, the direction, and the look it chose with its reason. */
async function modelPick(p) {
  const plan = planFor(job(p));
  const out = await AI.run(MODEL, {
    messages: [{ role: "system", content: "You plan short videos. Answer with JSON only." }, { role: "user", content: directionPrompt(job(p), plan) }],
    max_tokens: 900, temperature: 0.3,
    response_format: { type: "json_schema", json_schema: directionSchema() },
  });
  let raw = out.response;
  if (typeof raw === "string") { const i = raw.indexOf("{"), j = raw.lastIndexOf("}"); raw = JSON.parse(raw.slice(i, j + 1)); }
  return { style: raw?.style ?? null, why: String(raw?.why ?? "").slice(0, 80) };
}

const ok = (p, got) => got === p.expect || (Array.isArray(p.also) ? p.also.includes(got) : got === p.also);
const rows = [];
for (const p of PROMPTS) {
  const kw = pickKleoStyle("viral-short", p.text);
  let model = null, why = "";
  if (!words) {
    try { const r = await modelPick(p); model = r.style; why = r.why } catch (e) { model = "ERR"; why = String(e).slice(0, 70) }
  }
  rows.push({ p, kw, model, why });
  const mark = (v) => (v === null ? "    " : ok(p, v) ? " ok " : " NO ");
  console.log(`${p.lang}  parole:${mark(kw)}${String(kw).padEnd(10)} modello:${mark(model)}${String(model ?? "-").padEnd(10)} atteso ${p.expect.padEnd(10)} ${p.text.slice(0, 52)}`);
  if (why && !ok(p, model)) console.log(`        perché: ${why}`);
}

const pct = (n) => `${n}/${rows.length} = ${Math.round((n / rows.length) * 100)}%`;
console.log(`\nparole chiave: ${pct(rows.filter((r) => ok(r.p, r.kw)).length)}`);
if (!words) console.log(`modello:       ${pct(rows.filter((r) => ok(r.p, r.model)).length)}`);

// The pairs are the real test: same words, opposite answers. A picker that gets both is reading the
// request; one that collapses them onto one look is reading the topic. The corpus does not carry a pair
// field, so the pairs are named here by content — the first version read a field that did not exist and
// reported 0/3 on a run where all three were right.
const PAIR_OF = (t) => /VPN a mia madre|attacchi informatici/i.test(t) ? "vpn"
  : /wi-fi dell'hotel|phone bill/i.test(t) ? "wifi"
  : /password manager|third parties/i.test(t) ? "pw" : null;
const pairs = {};
for (const r of rows) { const k = PAIR_OF(r.p.text); if (k) (pairs[k] ??= []).push(r) }
const told = Object.values(pairs).filter((g) => g.length === 2 && g.every((r) => ok(r.p, r.model)));
if (!words) console.log(`coppie distinte (entrambe giuste): ${told.length}/${Object.keys(pairs).length}`);
const indep = rows.find((r) => /acqua bollente/i.test(r.p.text));
if (!words && indep) console.log(`indipendenza (nessuna parola tecnica): ${ok(indep.p, indep.model) ? "explainer raggiungibile senza vocabolario informatico" : `FALLITA -> ${indep.model}`}`);
