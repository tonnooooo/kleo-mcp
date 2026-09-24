#!/usr/bin/env node
/**
 * STEP 2 OF THE FIDELITY BENCH: an INDEPENDENT judge reads each planned film against the case's hand-written gold list
 * (24 September 2026).
 *
 *   node scripts/fidelity-bench/judge.mjs --runs old,new [--cases a,b] [--judge @cf/google/gemma-4-26b-a4b-it]
 *        [--repeat 1] [--judge-thinking off|on] [--max-tokens 8000] [--concurrency 4] [--with-action] [--force] [--out <report.md>]
 *
 * Independent means three things. The gold lists (cases.json) were written by hand from the prompt's words, not by
 * Kleo's spec writer. The judge is another model family (gemma-4 by default) from the planner (kimi-k2.6) and from
 * Kleo's in-loop judges (src/fidelity.ts, src/vision.ts). And the judge sees only what reaches the viewer: the
 * narration, every picture description (image_prompt), any caption, and the direction's cast looks and world — never
 * Kleo's own claims (spec, covers, fidelity report), so a plan cannot pass by saying it covered something.
 *
 * Each MUST gold item is labelled kept / paraphrased / lost / contradicted (definitions in JUDGE_RULES below), with the
 * shots where it appears; the user's events are checked for order from those shots; inventions that change the film are
 * listed. Two deterministic checks run beside the model: a line the user asked the narrator to say (quoted words in
 * the narration) and a text the user asked to read on screen (the quoted words in a picture description or caption).
 *
 * Writes out/<run>/judge/<case>.json, out/<run>/judge.json (the run's aggregate) and a report (default
 * out/report-<before>-vs-<after>.md, or out/report-<run>.md for one run) with the before/after table.
 * Cost: gemma-4 ≈ $0.001-0.003 per case per repeat (see README.md).
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs, loadCases, runDir, readJson, writeJson, chatJson, pool, withTag, ledgerSum, pct, usd, OUT_DIR } from "./lib.mjs";

const args = parseArgs();
const runs = String(args.runs ?? args.run ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!runs.length || runs.length > 2) {
  console.error("usage: judge.mjs --runs <before>[,<after>] [--cases a,b] [--judge model] [--repeat 1] [--judge-thinking off|on] [--max-tokens 8000] [--concurrency 4] [--with-action] [--force] [--out report.md]");
  process.exit(2);
}
const judgeModel = String(args.judge ?? "@cf/google/gemma-4-26b-a4b-it");
const repeat = Math.max(1, Number(args.repeat ?? 1));
const judgeThinking = String(args["judge-thinking"] ?? "off");
const maxTokens = Number(args["max-tokens"] ?? (judgeThinking === "off" ? 8000 : 16000));
const concurrency = Number(args.concurrency ?? 4);
const withAction = !!args["with-action"];
const cases = loadCases(args.cases);

const STATUSES = ["kept", "paraphrased", "lost", "contradicted"];

/* ------------------------------------------------------------------ what the viewer gets */

/** The planned film as the judge reads it: look, direction cast/world, then every scene's narration and pictures. */
export function filmText(plan) {
  const sb = plan.storyboard ?? {};
  const d = sb.direction ?? plan.direction ?? null;
  const lines = [`LOOK: ${sb.kleo_style ?? "?"} · FORMAT ${sb.format ?? "?"} · LANGUAGE ${sb.language ?? "?"}`];
  if (sb.title) lines.push(`TITLE: ${sb.title}`);
  if (d) {
    if (d.world) lines.push(`WORLD (applies to every picture): ${d.world}`);
    for (const m of d.cast ?? []) lines.push(`CAST — ${m.name}: ${m.look}`);
  }
  (sb.scenes ?? []).forEach((sc, i) => {
    lines.push(`\nSCENE ${i + 1} [${sc.id}]`);
    if (typeof sc.voice === "string") lines.push(`  NARRATION: "${sc.voice}"`);
    const shots = Array.isArray(sc.shots) ? sc.shots : typeof sc.image_prompt === "string" ? [{ image_prompt: sc.image_prompt }] : [];
    shots.forEach((sh, j) => {
      lines.push(`  SHOT ${sc.id}-s${j + 1}: PICTURE: ${sh.image_prompt ?? ""}`);
      if (sh.caption) lines.push(`    ON-SCREEN CAPTION: ${sh.caption}`);
      if (withAction && sh.action) lines.push(`    MOTION (film clip only): ${sh.action}`);
    });
  });
  return lines.join("\n");
}
const shotOrder = (plan) => (plan.storyboard?.scenes ?? []).flatMap((sc) => (Array.isArray(sc.shots) ? sc.shots : [{}]).map((_, j) => `${sc.id}-s${j + 1}`));
const narration = (plan) => (plan.storyboard?.scenes ?? []).map((s) => String(s.voice ?? "")).join(" ");
const pictures = (plan) => (plan.storyboard?.scenes ?? []).flatMap((s) => (Array.isArray(s.shots) ? s.shots : []).flatMap((sh) => [String(sh.image_prompt ?? ""), String(sh.caption ?? "")])).join(" \n ");

/* ------------------------------------------------------------------ deterministic checks */

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** The words inside double quotes in a gold text ("the narration says \"festa a sorpresa\"" → festa a sorpresa). */
const quoted = (text) => [...String(text).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
/** Deterministic verdicts for line and text items that quote exact words: true = the words are there, false = not, null = n/a. */
function detCheck(item, plan) {
  const q = quoted(item.text);
  if (!q.length || !["line", "text"].includes(item.kind)) return null;
  const hay = norm(item.kind === "line" ? narration(plan) : pictures(plan));
  return q.every((x) => hay.includes(norm(x)));
}

/* ------------------------------------------------------------------ the judge */

export const JUDGE_SYSTEM = `You are an independent, strict script supervisor. You compare a PLANNED FILM (its narration and the description of every picture) with the REQUIREMENTS a user's request contains, and you report, requirement by requirement, whether the film delivers it. You judge only what is written in the planned film; you never assume that something unwritten will appear. You answer with ONE JSON object and nothing else.`;

const JUDGE_RULES = `HOW TO LABEL EACH REQUIREMENT:
- "kept": the film delivers it as specified, with all its specifics (colours, numbers, names, who does what).
- "paraphrased": it is there but weakened, generalised or only partly there (e.g. "an apron" for "a lilac apron"; a visual requirement that is only SAID in the narration and never described in a picture; the right event but missing a detail).
- "lost": the film does not contain it at all.
- "contradicted": the film shows or says something incompatible with it (a different hair colour, age, clothes or colour; a different place; the excluded thing appears; the event's outcome is different).
Where to look:
- A requirement marked VISUAL is delivered only if a PICTURE description (or the WORLD/CAST lines, which apply to every picture of that character or world) shows it. Narration alone makes it "paraphrased" at best.
- A "line" requirement is delivered only if the NARRATION contains those words (a translation or rewording is "paraphrased").
- A "text" requirement is delivered only if a picture description or caption asks for exactly those words to be readable on screen.
- An "exclude" requirement is "kept" when nothing in the film shows or says the excluded thing, "contradicted" when anything does.
- A "mood" or "style" requirement is judged on the film as a whole.
For every requirement list "shots": the SHOT ids (e.g. "03-storm-s2") where it appears, in film order; [] when it appears nowhere or only in the narration.
INVENTIONS: list what the film ADDS that changes the film the user asked for — a new main character, a different setting, an added plot event or twist, a different ending, a framing device (a narrator on screen, a flashback, a dream), a changed genre. Ordinary cinematic detail that fits the request (light, weather that fits, props that belong in the place, secondary extras) is NOT an invention. Mark each "major" (it changes what the film is about or what happens) or "minor".`;

export function judgePrompt(c, plan) {
  const reqs = c.gold.map((g) => `${g.id} [${g.kind}${g.visual ? ", VISUAL" : ""}${g.must ? "" : ", optional"}${g.order ? `, event #${g.order}` : ""}] ${g.text}`).join("\n");
  return `THE USER'S REQUEST (verbatim, ${c.language}):
"""${c.prompt}"""

REQUIREMENTS TO CHECK:
${reqs}

THE PLANNED FILM:
${filmText(plan)}

${JUDGE_RULES}

Answer with this JSON object only:
{"verdicts":[{"id":"G1","status":"kept|paraphrased|lost|contradicted","shots":["<shot id>"],"note":"<one short reason>"}],"inventions":[{"what":"<the addition>","shots":["<shot id>"],"severity":"major|minor"}]}
One verdict for EVERY requirement id above (${c.gold.map((g) => g.id).join(", ")}).`;
}

/** Majority status over repeats; a tie goes to the middle of the scale (paraphrased) rather than to either end. */
function majority(list) {
  const n = {};
  for (const s of list) n[s] = (n[s] ?? 0) + 1;
  const best = Math.max(...Object.values(n));
  const top = Object.keys(n).filter((s) => n[s] === best);
  return top.length === 1 ? top[0] : top.includes("paraphrased") ? "paraphrased" : top[0];
}

async function judgeCase(run, c) {
  const planFile = join(runDir(run), `${c.id}.json`);
  const plan = readJson(planFile);
  const file = join(runDir(run), "judge", `${c.id}.json`);
  if (!plan) return { case: c.id, run, missing: true };
  if (!plan.ok) {
    // A plan that failed delivers nothing: every must item is lost. Counted, and reported separately as a failure.
    return writeOut(file, { case: c.id, run, plan_ok: false, judge: null, verdicts: c.gold.map((g) => ({ id: g.id, status: "lost", shots: [], note: "no plan (planning failed)" })), inventions: [], ...score(c, null, c.gold.map((g) => ({ id: g.id, status: "lost", shots: [] })), []) });
  }
  const prompt = judgePrompt(c, plan);
  const hash = createHash("sha1").update(`${judgeModel}\n${repeat}\n${judgeThinking}\n${prompt}`).digest("hex");
  const prev = readJson(file);
  if (prev?.input_hash === hash && !args.force) return prev;
  const rounds = [];
  for (let r = 0; r < repeat; r++) {
    let res = null;
    try { res = await chatJson(judgeModel, [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: prompt }], { maxTokens, retries: 1, thinking: judgeThinking, timeoutMs: 300_000 }); }
    catch (e) { rounds.push({ error: String(e?.message ?? e).slice(0, 300) }); continue; }
    const v = Array.isArray(res.json?.verdicts) ? res.json.verdicts : [];
    rounds.push({ ms: res.ms, finish: res.finish, thinking: res.thinking, verdicts: v, inventions: Array.isArray(res.json?.inventions) ? res.json.inventions : [], raw: res.json ? undefined : res.text.slice(0, 1500) });
  }
  const ok = rounds.filter((r) => r.verdicts);
  const order = shotOrder(plan);
  const verdicts = c.gold.map((g) => {
    const got = ok.map((r) => r.verdicts.find((v) => String(v?.id) === g.id)).filter((v) => v && STATUSES.includes(String(v.status)));
    const det = detCheck(g, plan);
    if (!got.length) return { id: g.id, status: "unjudged", shots: [], det };
    const status = majority(got.map((v) => String(v.status)));
    const pick = got.find((v) => v.status === status) ?? got[0];
    const shots = (Array.isArray(pick.shots) ? pick.shots.map(String) : []).filter((s) => order.includes(s));
    return { id: g.id, status, shots, note: String(pick.note ?? "").slice(0, 300), det, ...(got.length > 1 ? { votes: got.map((v) => v.status) } : {}) };
  });
  const inventions = (ok[0]?.inventions ?? []).filter((x) => x && x.what).map((x) => ({ what: String(x.what).slice(0, 300), shots: Array.isArray(x.shots) ? x.shots.map(String) : [], severity: x.severity === "major" ? "major" : "minor" }));
  return writeOut(file, { case: c.id, run, plan_ok: true, judge: judgeModel, repeat, input_hash: hash, rounds: rounds.map(({ verdicts: _v, inventions: _i, ...r }) => r), verdicts, inventions, ...score(c, plan, verdicts, inventions) });
}
const writeOut = (file, x) => { writeJson(file, x); return x; };

/** The case's numbers: over its MUST items (optional items are listed but never scored). */
function score(c, plan, verdicts, inventions) {
  const must = c.gold.filter((g) => g.must);
  const by = (id) => verdicts.find((v) => v.id === id);
  const counted = must.filter((g) => by(g.id) && by(g.id).status !== "unjudged");
  const n = (s, list = counted) => list.filter((g) => by(g.id)?.status === s).length;
  const visual = counted.filter((g) => g.visual);
  // ORDER: the events (and ordered shots) the film shows, by their first shot, must come in the user's order.
  const order = plan ? shotOrder(plan) : [];
  const events = c.gold.filter((g) => g.order).sort((a, b) => a.order - b.order);
  let last = -1, outOfOrder = 0, placed = 0;
  for (const e of events) {
    const v = by(e.id);
    if (!v || !["kept", "paraphrased"].includes(v.status) || !v.shots?.length) continue;
    const first = Math.min(...v.shots.map((s) => order.indexOf(s)).filter((i) => i >= 0));
    if (!Number.isFinite(first)) continue;
    placed++;
    if (first < last) outOfOrder++; else last = first;
  }
  const dets = c.gold.map((g) => ({ g, v: by(g.id) })).filter((x) => x.v && x.v.det !== null && x.v.det !== undefined);
  return {
    mode: c.mode,
    must: must.length, judged: counted.length, unjudged: must.length - counted.length,
    kept: n("kept"), paraphrased: n("paraphrased"), lost: n("lost"), contradicted: n("contradicted"),
    score: counted.length ? (n("kept") + 0.5 * n("paraphrased")) / counted.length : null,
    visual_score: visual.length ? (n("kept", visual) + 0.5 * n("paraphrased", visual)) / visual.length : null,
    events: events.length, events_placed: placed, events_out_of_order: outOfOrder,
    inventions_major: inventions.filter((x) => x.severity === "major").length, inventions_minor: inventions.filter((x) => x.severity !== "major").length,
    det_checked: dets.length, det_passed: dets.filter((x) => x.v.det).length,
    det_disagree: dets.filter((x) => x.v.det !== (x.v.status === "kept")).map((x) => x.g.id),
    self_score: plan?.fidelity && typeof plan.fidelity.score === "number" ? plan.fidelity.score : null,
    plan_ms: plan?.ms ?? null, plan_usd: plan?.cost?.usd ?? null,
  };
}

/* ------------------------------------------------------------------ aggregate and report */

function aggregate(run, results) {
  const ok = results.filter((r) => !r.missing);
  const sum = (k, list = ok) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const judged = sum("judged");
  const perKind = {};
  for (const r of ok) {
    const c = cases.find((x) => x.id === r.case);
    for (const g of c.gold.filter((x) => x.must)) {
      const v = r.verdicts.find((x) => x.id === g.id);
      if (!v || v.status === "unjudged") continue;
      const k = (perKind[g.kind] ??= { n: 0, kept: 0, paraphrased: 0, lost: 0, contradicted: 0 });
      k.n++; k[v.status]++;
    }
  }
  for (const k of Object.values(perKind)) k.score = k.n ? (k.kept + 0.5 * k.paraphrased) / k.n : null;
  const faithful = ok.filter((r) => r.mode !== "open");
  const scores = ok.map((r) => r.score).filter((x) => typeof x === "number");
  const planned = ok.filter((r) => r.plan_ok);
  return {
    run, judge: judgeModel, cases: ok.length, plans_ok: planned.length, plans_failed: ok.filter((r) => !r.plan_ok).map((r) => r.case),
    must: sum("must"), judged, unjudged: sum("unjudged"),
    kept: sum("kept"), paraphrased: sum("paraphrased"), lost: sum("lost"), contradicted: sum("contradicted"),
    pooled_score: judged ? (sum("kept") + 0.5 * sum("paraphrased")) / judged : null,
    mean_case_score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    mean_case_score_planned: planned.length ? planned.reduce((a, r) => a + (r.score ?? 0), 0) / planned.length : null,
    events: sum("events"), events_placed: sum("events_placed"), events_out_of_order: sum("events_out_of_order"),
    inventions_major_faithful: sum("inventions_major", faithful), inventions_minor_faithful: sum("inventions_minor", faithful),
    det_checked: sum("det_checked"), det_passed: sum("det_passed"),
    mean_plan_s: planned.length ? planned.reduce((a, r) => a + (r.plan_ms ?? 0), 0) / planned.length / 1000 : null,
    plan_usd: sum("plan_usd"),
    self_scores: planned.filter((r) => r.self_score !== null).map((r) => ({ case: r.case, self: r.self_score, judge: r.score })),
    per_kind: perKind,
    per_case: Object.fromEntries(ok.map((r) => [r.case, { mode: r.mode, plan_ok: r.plan_ok, score: r.score, visual_score: r.visual_score, kept: r.kept, paraphrased: r.paraphrased, lost: r.lost, contradicted: r.contradicted, must: r.must, out_of_order: r.events_out_of_order, inventions_major: r.inventions_major, self_score: r.self_score }])),
  };
}

const f1 = (x) => (x === null || x === undefined ? "—" : typeof x === "number" ? (Number.isInteger(x) ? String(x) : x.toFixed(1)) : String(x));
const delta = (a, b, asPct) => (typeof a === "number" && typeof b === "number" ? `${b - a >= 0 ? "+" : ""}${asPct ? Math.round((b - a) * 100) + " pt" : (b - a).toFixed(Number.isInteger(b - a) ? 0 : 1)}` : "");

function report(aggs, details) {
  const [A, B] = aggs;
  const two = !!B;
  const head = two ? `| | ${A.run} (before) | ${B.run} (after) | Δ |\n|---|---|---|---|` : `| | ${A.run} |\n|---|---|`;
  const row = (label, get, asPct = false, fmt = asPct ? pct : f1) => two ? `| ${label} | ${fmt(get(A))} | ${fmt(get(B))} | ${delta(get(A), get(B), asPct)} |` : `| ${label} | ${fmt(get(A))} |`;
  const share = (k) => (a) => (a.judged ? a[k] / a.judged : null);
  const out = [];
  out.push(`# Fidelity bench — plans${two ? `: ${A.run} → ${B.run}` : `: ${A.run}`}`, "");
  out.push(`Judge: \`${judgeModel}\` (thinking ${judgeThinking}; independent of the planner and of Kleo's in-loop judges), ${repeat} round(s) per case, gold lists hand-written in cases.json. Written ${new Date().toISOString()}.`, "");
  out.push("## Totals (MUST items only)", "", head,
    row("cases / plans that succeeded", (a) => `${a.plans_ok}/${a.cases}`, false, String),
    row("must items judged", (a) => a.judged),
    row("**fidelity** (kept + ½ paraphrased, pooled)", (a) => a.pooled_score, true),
    row("fidelity, mean of cases", (a) => a.mean_case_score, true),
    row("fidelity, mean of planned cases only", (a) => a.mean_case_score_planned, true),
    row("kept", share("kept"), true),
    row("paraphrased", share("paraphrased"), true),
    row("lost", share("lost"), true),
    row("**contradicted**", share("contradicted"), true),
    row("events out of the user's order (of placed)", (a) => `${a.events_out_of_order}/${a.events_placed}`, false, String),
    row("major inventions (faithful cases)", (a) => a.inventions_major_faithful),
    row("minor inventions (faithful cases)", (a) => a.inventions_minor_faithful),
    row("quoted lines/texts present (deterministic)", (a) => `${a.det_passed}/${a.det_checked}`, false, String),
    row("mean planning time, s", (a) => a.mean_plan_s),
    row("planning cost", (a) => a.plan_usd, false, usd),
    "");
  const kinds = [...new Set(aggs.flatMap((a) => Object.keys(a.per_kind)))].sort();
  out.push("## By kind (fidelity; n = must items)", "", two ? `| kind | ${A.run} | ${B.run} | Δ | contradicted before → after |\n|---|---|---|---|---|` : `| kind | ${A.run} | contradicted |\n|---|---|---|`);
  for (const k of kinds) {
    const a = A.per_kind[k], b = B?.per_kind[k];
    out.push(two ? `| ${k} | ${pct(a?.score)} (n ${a?.n ?? 0}) | ${pct(b?.score)} (n ${b?.n ?? 0}) | ${delta(a?.score, b?.score, true)} | ${a?.contradicted ?? 0} → ${b?.contradicted ?? 0} |` : `| ${k} | ${pct(a?.score)} (n ${a?.n ?? 0}) | ${a?.contradicted ?? 0} |`);
  }
  out.push("", "## By case", "", two ? `| case | mode | ${A.run} | ${B.run} | Δ | contradicted | out of order | major inventions | Kleo's own score (after) |\n|---|---|---|---|---|---|---|---|---|` : `| case | mode | fidelity | contradicted | out of order | major inventions | Kleo's own score |\n|---|---|---|---|---|---|---|`);
  for (const c of cases) {
    const a = A.per_case[c.id], b = B?.per_case[c.id];
    if (!a && !b) continue;
    const fail = (x) => (x && !x.plan_ok ? " (plan failed)" : "");
    out.push(two
      ? `| ${c.id} | ${c.mode} | ${pct(a?.score)}${fail(a)} | ${pct(b?.score)}${fail(b)} | ${delta(a?.score, b?.score, true)} | ${a?.contradicted ?? "—"} → ${b?.contradicted ?? "—"} | ${a?.out_of_order ?? "—"} → ${b?.out_of_order ?? "—"} | ${a?.inventions_major ?? "—"} → ${b?.inventions_major ?? "—"} | ${pct(b?.self_score)} |`
      : `| ${c.id} | ${c.mode} | ${pct(a?.score)}${fail(a)} | ${a?.contradicted ?? "—"} | ${a?.out_of_order ?? "—"} | ${a?.inventions_major ?? "—"} | ${pct(a?.self_score)} |`);
  }
  out.push("", "## What was lost or contradicted", "");
  for (const c of cases) {
    const bits = [];
    for (const [i, a] of aggs.entries()) {
      const d = details[i].find((r) => r.case === c.id);
      if (!d || d.missing) continue;
      const bad = d.verdicts.filter((v) => ["lost", "contradicted", "unjudged"].includes(v.status) && c.gold.find((g) => g.id === v.id)?.must);
      const inv = d.inventions.filter((x) => x.severity === "major");
      if (!bad.length && !inv.length) continue;
      bits.push(`- **${a.run}**: ${bad.map((v) => `${v.id} ${v.status} — ${c.gold.find((g) => g.id === v.id).text}${v.note ? ` (${v.note})` : ""}`).join("; ") || "nothing lost"}${inv.length ? `; major inventions: ${inv.map((x) => x.what).join("; ")}` : ""}`);
    }
    if (bits.length) out.push(`### ${c.id}`, ...bits, "");
  }
  return out.join("\n") + "\n";
}

/* ------------------------------------------------------------------ main */

const details = [];
const aggs = [];
for (const run of runs) {
  const res = await pool(cases, concurrency, (c) => withTag(`judge:${run}:${c.id}`, () => judgeCase(run, c)));
  for (const r of res) if (r.missing) console.log(`- ${run}/${r.case}: no plan file, skipped`);
  details.push(res);
  const agg = aggregate(run, res);
  writeJson(join(runDir(run), "judge.json"), agg);
  aggs.push(agg);
  console.log(`${run}: fidelity ${pct(agg.pooled_score)} · kept ${agg.kept} · paraphrased ${agg.paraphrased} · lost ${agg.lost} · contradicted ${agg.contradicted} of ${agg.judged} · out of order ${agg.events_out_of_order} · major inventions ${agg.inventions_major_faithful} · plans ${agg.plans_ok}/${agg.cases}`);
}
const md = report(aggs, details);
const outFile = args.out ? String(args.out) : join(OUT_DIR, runs.length === 2 ? `report-${runs[0]}-vs-${runs[1]}.md` : `report-${runs[0]}.md`);
writeFileSync(outFile, md);
const cost = ledgerSum("judge:");
console.log(`\nreport: ${outFile} · judge calls ${cost.calls} (${cost.errors} errors) · ${usd(cost.usd)}`);
