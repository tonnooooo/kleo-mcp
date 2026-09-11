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

/**
 * HELD OUT. Written without reading the vocabularies, by sessions that then handed them over. The author of
 * the first seventeen had read the OLD English word lists earlier in the same session and said so, and
 * chose prompts that avoid the words it remembered — which is the condition every real sentence lives in,
 * so it makes the set harder rather than easier. "expect" is what a person would want; where two answers
 * are defensible the second is listed in "also", and either counts.
 */
const PROMPTS = [
  { lang: "it", text: "Mia nonna diceva che il pane di una volta durava una settimana e adesso ammuffisce in due giorni. Fammi un video che spiega perché.", expect: "realistic", also: "explainer" },
  { lang: "it", text: "Mio nonno partì in nave a diciassette anni e non tornò più al paese. Voglio raccontarlo in un minuto.", expect: "cartoon" },
  { lang: "it", text: "Come fa il semaforo a sapere che c'è una macchina che aspetta?", expect: "explainer", also: "cyber" },
  { lang: "it", text: "Ho comprato un materasso da ottocento euro e dormo peggio di prima. Fammi un video su come si sceglie.", expect: "realistic" },
  { lang: "it", text: "Cosa succede al corpo quando smetti di bere alcol per trenta giorni?", expect: "explainer", also: "realistic" },
  { lang: "en", text: "My landlord says the boiler is fine but the radiators are cold on the top floor only. Make a video explaining what's actually happening.", expect: "explainer" },
  { lang: "en", text: "I want to tell people what happened the night the lights went out across half the country in 2003.", expect: "realistic", also: "cartoon" },
  { lang: "en", text: "Explain what actually happens to the money when I tap my card.", expect: "explainer", also: "cyber" },
  { lang: "en", text: "A short about the woman who sold the Eiffel Tower twice.", expect: "cartoon", also: "realistic" },
  { lang: "en", text: "Why does my sourdough smell like nail polish?", expect: "explainer" },
  // The boundary pairs: identical vocabulary, opposite correct answers. These are the ones that count.
  { lang: "it", text: "Spiegami cos'è una VPN a mia madre.", expect: "explainer", pair: "vpn" },
  { lang: "it", text: "Fammi un video sui cinque attacchi informatici più costosi della storia.", expect: "cyber", pair: "vpn" },
  { lang: "it", text: "Perché il wi-fi dell'hotel è pericoloso? Voglio una cosa corta che capisca chiunque.", expect: "explainer", pair: "wifi" },
  { lang: "it", text: "Spiega in un minuto perché l'acqua bollente in freezer a volte ghiaccia prima di quella fredda.", expect: "explainer", pair: "indep" },
  { lang: "en", text: "Explain why a password manager is safer than remembering them, to someone who is sure it is less safe.", expect: "explainer", pair: "pw" },
  { lang: "en", text: "Show how our data goes from the app to the servers to the third parties nobody reads about.", expect: "cyber", pair: "pw" },
  { lang: "en", text: "Break down how much of a phone bill is actually the network and how much is everything else.", expect: "cyber", pair: "wifi" },
];

const words = process.argv.includes("--words");
const root = resolve(import.meta.dirname, "..");
const account = /"account_id"\s*:\s*"([0-9a-f]+)"/.exec(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"))?.[1];
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
  const out = await AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "system", content: "You plan short videos. Answer with JSON only." }, { role: "user", content: directionPrompt(job(p), plan) }],
    max_tokens: 900, temperature: 0.3,
    response_format: { type: "json_schema", json_schema: directionSchema() },
  });
  let raw = out.response;
  if (typeof raw === "string") { const i = raw.indexOf("{"), j = raw.lastIndexOf("}"); raw = JSON.parse(raw.slice(i, j + 1)); }
  return { style: raw?.style ?? null, why: String(raw?.why ?? "").slice(0, 80) };
}

const ok = (p, got) => got === p.expect || got === p.also;
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
// request; one that collapses them onto one look is reading the topic.
const pairs = {};
for (const r of rows) if (r.p.pair && r.p.pair !== "indep") (pairs[r.p.pair] ??= []).push(r);
const told = Object.values(pairs).filter((g) => g.length === 2 && g.every((r) => ok(r.p, r.model)));
if (!words) console.log(`coppie distinte (entrambe giuste): ${told.length}/${Object.keys(pairs).length}`);
const indep = rows.find((r) => r.p.pair === "indep");
if (!words && indep) console.log(`indipendenza (nessuna parola tecnica): ${ok(indep.p, indep.model) ? "explainer raggiungibile senza vocabolario informatico" : `FALLITA -> ${indep.model}`}`);
