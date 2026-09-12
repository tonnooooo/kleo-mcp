#!/usr/bin/env node
/**
 * Phase 0 on the REAL model, over REST, for the prompt of ONE COMMIT — no `wrangler dev`, no ports, no processes.
 *
 * The first bench was a Worker under `wrangler dev --remote`. It cost an hour in one day: workerd orphans on the
 * ports (wrangler respawns the child you kill), a pkill that killed the shell running it, and — the real damage —
 * the dev server bundles the folder it is started in and hot-reloads on every save, so a run from the shared folder
 * measured a prompt that belonged to no commit. This runner does what scripts/look-benchmark.mjs already did:
 * build the prompt in-process from the storyboard.ts of a given directory (a detached worktree on the commit) and
 * POST it to Workers AI's REST endpoint with the wrangler OAuth session. The model still runs on Cloudflare;
 * nothing renders here. A refused call (4006) costs nothing and proves auth and routing for free.
 *
 *   node scripts/direction-measure/run-rest.mjs --src <worktree> --label <name> [--repeat N] [--out dir]
 *
 * The prompt text comes from <worktree>/src/storyboard.ts; the corpus and this runner from the current folder.
 * KLEO_SESSION says who is spending; the ledger (QUOTA.md) gets a line before and after.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HELD_OUT, HELD_OUT_2, HELD_OUT_3 } from "../adaptation.mjs";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
// --probe: ONE tiny request (a few tokens, ~1 neuron) to ask "is the free allocation back?". Exit 0 = yes, 3 = still
// 4006, 2 = something else (auth, network). A scheduled run polls this for hours at no cost before spending 7,000.
const PROBE = process.argv.includes("--probe");
if (!PROBE && !SRC) { console.error("--src <worktree con src/storyboard.ts del commit da misurare>"); process.exit(2); }
const LABEL = arg("--label", "senza-nome");
const REPEAT = Number(arg("--repeat", "1")) || 1;
const OUTDIR = arg("--out", resolve(import.meta.dirname, "results"));
const WHO = process.env.KLEO_SESSION || "sconosciuta";
const ROOT = resolve(import.meta.dirname, "../..");
const LEDGER = resolve(import.meta.dirname, "QUOTA.md");

const wranglerEarly = readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8");
if (PROBE) {
  const acc = process.env.CLOUDFLARE_ACCOUNT_ID || /"account_id"\s*:\s*"([0-9a-f]+)"/.exec(wranglerEarly)?.[1];
  const mdl = /"AI_MODEL"\s*:\s*"([^"]+)"/.exec(wranglerEarly)?.[1];
  const tok = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(`${process.env.HOME}/.wrangler/config/default.toml`, "utf8"))?.[1];
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/ai/run/${mdl}`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "ok" }], max_tokens: 2 }) });
  const j = await r.json().catch(() => ({}));
  const msg = JSON.stringify(j.errors ?? "").slice(0, 160);
  if (r.ok && j.success) { console.log(`probe: quota disponibile (${j.result?.usage?.neurons ?? "?"} neuroni spesi per chiederlo)`); process.exit(0); }
  if (/4006|daily free allocation/.test(msg)) { console.log("probe: ancora 4006, quota esaurita (0 neuroni)"); process.exit(3); }
  console.log(`probe: risposta inattesa ${r.status} ${msg}`); process.exit(2);
}
const sb = await import(pathToFileURL(resolve(SRC, "src/storyboard.ts")).href);
const commit = (await import("node:child_process")).execSync("git rev-parse --short HEAD", { cwd: SRC }).toString().trim();
const wrangler = readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8");
const account = process.env.CLOUDFLARE_ACCOUNT_ID || /"account_id"\s*:\s*"([0-9a-f]+)"/.exec(wrangler)?.[1];
const model = /"AI_MODEL"\s*:\s*"([^"]+)"/.exec(readFileSync(resolve(SRC, "wrangler.jsonc"), "utf8"))?.[1] || /"AI_MODEL"\s*:\s*"([^"]+)"/.exec(wrangler)?.[1];
const token = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(`${process.env.HOME}/.wrangler/config/default.toml`, "utf8"))?.[1];
if (!account || !model || !token) { console.error("manca account, modello o token wrangler"); process.exit(2); }

const job = (p) => ({ id: "bench", template: p.t || "viral-short", prompt: p.p, params: JSON.stringify({ duration_s: p.duration_s || 45, format: "9:16", language: p.lang || "en", voice: null }) });
async function ask(p) {
  const j = job(p); const plan = sb.planFor(j);
  const body = { messages: [{ role: "user", content: sb.directionPrompt(j, plan) }], max_tokens: 900, temperature: 0.3, response_format: { type: "json_schema", json_schema: sb.directionSchema() } };
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j2 = await r.json().catch(() => ({}));
  if (!r.ok || !j2.success) { const m = JSON.stringify(j2.errors ?? j2).slice(0, 200); return { ok: false, error: `${r.status} ${m}`, quota: /4006|daily free allocation/.test(m), prior: plan.kleo }; }
  const res = j2.result ?? {}; let raw = res.response; if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { /* leave */ } }
  return { ok: true, style: raw?.style ?? null, why: raw?.why ?? null, confident: typeof raw?.confident === "boolean" ? raw.confident : null, prior: plan.kleo, neurons: res.usage?.neurons ?? null };
}

const SETS = [["A", HELD_OUT], ["B", HELD_OUT_2], ["C", HELD_OUT_3]];
const stamp = new Date().toISOString().slice(0, 16) + "Z";
mkdirSync(OUTDIR, { recursive: true });
appendFileSync(LEDGER, `    ${stamp} | ${WHO} | fase 0 via REST, ${LABEL} (${commit}), ${model.split("/").pop()}, x${REPEAT} | ${27 * REPEAT} | ~${55 * 27 * REPEAT} stimati | IN CORSO\n`);
console.log(`== ${LABEL}  commit ${commit}  modello ${model}  x${REPEAT}`);
let spent = 0, summary = [];
for (let run = 1; run <= REPEAT; run++) {
  const rows = []; let quotaOut = false;
  for (const [set, items] of SETS) {
    for (const it of items) {
      const a = await ask(it);
      if (!a.ok && a.quota) { quotaOut = true; break; }
      const ok = a.ok && (a.style === it.want || (it.also ?? []).includes(a.style));
      rows.push({ set, lang: it.lang, prompt: it.p, want: it.want, also: it.also ?? [], got: a.ok ? a.style : null, error: a.ok ? null : a.error, prior: a.prior, ok, why: a.why ?? null, confident: a.confident ?? null, neurons: a.neurons });
      if (a.neurons) spent += a.neurons;
    }
    if (quotaOut) break;
  }
  const done = rows.length, right = rows.filter((r) => r.ok).length;
  const out = resolve(OUTDIR, `${stamp}-${commit}-${LABEL}-corsa${run}.json`);
  writeFileSync(out, JSON.stringify({ label: LABEL, commit, model, run, rows }, null, 2));
  const line = quotaOut && !done ? "RIFIUTATA 4006 (0 neuroni)" : `${right}/${done}` + (quotaOut ? " (interrotta: quota)" : "");
  // CALIBRATION of the model's own "confident". The look score says whether a sentence in the prompt moved the
  // choice; this says whether the field means anything: a model that is right as often when it says false as when
  // it says true is not confessing, it is guessing twice. Only prompts that carry the field produce these numbers.
  const sure = rows.filter((r) => r.confident === true), unsure = rows.filter((r) => r.confident === false);
  const cal = sure.length + unsure.length ? `   sicuro ${sure.filter((r) => r.ok).length}/${sure.length} giuste, non-sicuro ${unsure.filter((r) => r.ok).length}/${unsure.length} giuste` : "";
  summary.push(line + (cal ? ` [${cal.trim()}]` : ""));
  console.log(`   corsa ${run}: ${line}${cal}   ${done ? `A ${rows.filter((r) => r.set === "A" && r.ok).length}/${rows.filter((r) => r.set === "A").length}  B ${rows.filter((r) => r.set === "B" && r.ok).length}/${rows.filter((r) => r.set === "B").length}  C ${rows.filter((r) => r.set === "C" && r.ok).length}/${rows.filter((r) => r.set === "C").length}` : ""}   -> ${out.split("/").pop()}`);
  if (quotaOut) break;
}
appendFileSync(LEDGER, `    ${stamp} | ${WHO} | fase 0 via REST, ${LABEL} (${commit}) | fine | ~${Math.round(spent)} spesi | ${summary.join("; ")}\n`);
