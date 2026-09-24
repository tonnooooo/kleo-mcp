#!/usr/bin/env node
/**
 * STEP 1 OF THE FIDELITY BENCH: plan every case with a given copy of Kleo's planner (24 September 2026).
 *
 *   node scripts/fidelity-bench/plan.mjs --src <path to a kleo-mcp src dir> --run <name>
 *        [--cases a,b] [--model @cf/moonshotai/kimi-k2.6] [--budget-min 12] [--concurrency 2] [--retries 1]
 *        [--thinking off|on] [--min-max-tokens 0] [--vars KEY=VALUE,KEY=VALUE] [--force]
 *
 * The SAME script plans against the old code (a worktree at dab7084, `--src ../wt-baseline/src`) and the new one
 * (`--src src`): it imports <src>/storyboard.ts and calls generateStoryboard exactly as the orchestrator does, with a
 * job row made from the case (template "film", product "animatic", no voice) and an env whose AI binding is the REST
 * shim of lib.mjs. There is no PLAN_API_KEY, so every call runs on Workers AI with --model; everything else is the
 * code under test. Kimi runs in its instant mode (--thinking off, the default; see lib.mjs makeAi): with thinking on,
 * every planner call of the smoke run on 24 September came back empty, the reasoning having eaten max_tokens. A failed plan is retried once, as the orchestrator does; the second failure is recorded, not hidden.
 *
 * Writes scripts/fidelity-bench/out/<run>/<case>.json (the storyboard, the spec and fidelity report when the code
 * makes them, the treatment, the direction, the model, the time, the calls and their cost) and out/<run>/meta.json.
 * Cost: see README.md (kimi-k2.6 ≈ $0.10-0.30 per case).
 */
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { makeEnv, parseArgs, loadCases, runDir, writeJson, readJson, pool, withTag, ledger, ledgerSum, usd, REPO_DIR } from "./lib.mjs";

const args = parseArgs();
if (!args.run || !args.src) {
  console.error("usage: plan.mjs --src <kleo src dir> --run <name> [--cases a,b] [--model id] [--budget-min 12] [--concurrency 2] [--retries 1] [--thinking off|on] [--min-max-tokens N] [--vars K=V,…] [--force]");
  process.exit(2);
}
const src = resolve(process.cwd(), String(args.src));
if (!existsSync(join(src, "storyboard.ts"))) { console.error(`no storyboard.ts in ${src}`); process.exit(2); }
const model = String(args.model ?? "@cf/moonshotai/kimi-k2.6");
const budgetMin = String(args["budget-min"] ?? "12");
const concurrency = Number(args.concurrency ?? 2);
const retries = Number(args.retries ?? 1);
const thinking = String(args.thinking ?? "off");
const minMaxTokens = Number(args["min-max-tokens"] ?? 0) || undefined;
const extraVars = Object.fromEntries(String(args.vars ?? "").split(",").filter((kv) => kv.includes("=")).map((kv) => [kv.slice(0, kv.indexOf("=")).trim(), kv.slice(kv.indexOf("=") + 1).trim()]));
const cases = loadCases(args.cases);
const dir = runDir(args.run);

const sb = await import(pathToFileURL(join(src, "storyboard.ts")).href);
if (typeof sb.generateStoryboard !== "function") { console.error(`${src}/storyboard.ts exports no generateStoryboard`); process.exit(2); }

/** Which commit the src dir is at, so a report can never mix up old and new (read-only git calls). */
function srcRevision() {
  const git = (...a) => { try { return execFileSync("git", ["-C", src, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
  const head = git("rev-parse", "--short", "HEAD");
  const dirty = git("status", "--porcelain", "--", ".");
  return { head, dirty_files: dirty === null ? null : dirty.split("\n").filter(Boolean).length };
}
const meta = { run: args.run, src, repo: REPO_DIR, revision: srcRevision(), model, budget_min: budgetMin, thinking, min_max_tokens: minMaxTokens ?? null, vars: extraVars, started: new Date().toISOString(), node: process.version };
writeJson(join(dir, "meta.json"), meta);
console.log(`plan run "${args.run}" · src ${src} (${meta.revision.head ?? "no git"}${meta.revision.dirty_files ? `, ${meta.revision.dirty_files} changed files` : ""}) · ${model} · ${cases.length} cases`);

/** The job row the orchestrator would hand the planner for this case. */
const jobOf = (c) => ({
  id: `bench_${c.id}`, template: "film", prompt: c.prompt,
  params: JSON.stringify({ duration_s: c.duration_s, format: c.format, language: c.language, voice: null, style: c.style, product: "animatic" }),
});

const results = await pool(cases, concurrency, (c) => withTag(`plan:${c.id}`, async () => {
  const file = join(dir, `${c.id}.json`);
  const prev = readJson(file);
  if (prev?.ok && !args.force) { console.log(`- ${c.id}: already planned (use --force to redo)`); return prev; }
  const env = makeEnv({ AI_MODEL: model, PLAN_BUDGET_MIN: budgetMin, minMaxTokens, thinking, ...extraVars });
  const job = jobOf(c);
  const t0 = Date.now();
  const tries = [];
  let res = null;
  for (let attempt = 1; attempt <= 1 + retries && !res; attempt++) {
    const a0 = Date.now();
    try { res = await sb.generateStoryboard(env, job, { model }); tries.push({ attempt, ok: true, ms: Date.now() - a0 }); }
    catch (e) {
      tries.push({ attempt, ok: false, ms: Date.now() - a0, error: String(e?.message ?? e).slice(0, 2000), errors: Array.isArray(e?.errors) ? e.errors.slice(0, 40) : undefined, draft: attempt === 1 + retries ? e?.draft : undefined });
      console.log(`  ${c.id}: attempt ${attempt} failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  const cost = ledgerSum(`plan:${c.id}`);
  const out = {
    case: c.id, run: args.run, src, revision: meta.revision, model, ok: !!res, ms: Date.now() - t0, tries,
    calls: cost.calls, cost,
    ...(res ? {
      attempts: res.attempts, usage: res.usage, words: res.words, scenes: res.scenes, style: res.style, fixture: res.fixture,
      history: res.history, missing_facts: res.missing_facts, blocked_upgrade: res.blocked_upgrade,
      spec: res.spec ?? null, fidelity: res.fidelity ?? null, treatment: res.treatment ?? null, direction: res.direction ?? null,
      storyboard: res.storyboard,
    } : {}),
  };
  writeJson(file, out);
  const shots = res ? res.storyboard.scenes.reduce((s, sc) => s + (Array.isArray(sc.shots) ? sc.shots.length : 0), 0) : 0;
  console.log(`- ${c.id}: ${res ? `ok, ${res.scenes} scenes, ${shots} shots${res.fidelity ? `, self-judged fidelity ${Math.round(res.fidelity.score * 100)}%` : ""}` : "FAILED"} · ${Math.round(out.ms / 1000)} s · ${cost.calls} calls · ${usd(cost.usd)}`);
  return out;
}));

const all = ledgerSum("plan:");
const summary = {
  ...meta, finished: new Date().toISOString(), cases: results.length, ok: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).map((r) => r.case), calls: all.calls, errors: all.errors, usd: all.usd, by_model: all.by_model,
};
writeJson(join(dir, "meta.json"), summary);
writeJson(join(dir, `ledger-plan-${meta.started.replace(/[:.]/g, "-")}.json`), ledger);
console.log(`\n${summary.ok}/${summary.cases} planned · ${all.calls} calls (${all.errors} errors) · ${usd(all.usd)} this invocation · ${dir}`);
process.exit(summary.ok === summary.cases ? 0 : 1);
