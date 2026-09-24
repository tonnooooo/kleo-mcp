#!/usr/bin/env node
/**
 * STEP 3 OF THE FIDELITY BENCH: draw the pictures of planned films and look at them (24 September 2026).
 *
 *   node scripts/fidelity-bench/stills.mjs --runs old:legacy,new:new --cases pastry-chef,treehouse-friends,diner-sign
 *        [--src src] [--judge @cf/google/gemma-4-26b-a4b-it] [--vision <in-loop model>] [--attempts 3] [--pass 0.85]
 *        [--max-shots 0] [--max-pairs 6] [--no-identity] [--judge-thinking off|on] [--force] [--out <report.md>]
 *
 * Each `run:engine` pair draws the stills of the storyboards plan.mjs wrote for <run>, with one of two engines:
 *
 * - `new`: Kleo's stills engine, imported from <src>/stills.ts (the --src tree, default this worktree's src) and run
 *   through the REST shim: a character sheet per cast member (drawCastSheet), then every shot with the sheets of the
 *   cast it shows as reference images, each judged by the in-loop vision model and redrawn up to --attempts times
 *   (drawStill). When the src tree has no stills.ts (the old code) the pair is skipped with a message.
 * - `legacy`: a proxy of what the rented GPU drew until 24 September (worker/kleo_pictures.py): the author's
 *   image_prompt cut to BASE_MAX 150 characters on a word, the cast look of whoever the prompt names put in FRONT as a
 *   whole "name: look" sentence only if it fits CONTEXT_MAX 110 (whole or not at all), the look's STYLE_SUFFIX last,
 *   the per-film negative prompt; drawn on @cf/bytedance/stable-diffusion-xl-lightning (SDXL like RealVisXL / DreamShaper
 *   XL on the box, and its CLIP encoder truncates at 77 tokens exactly like theirs), one draw, no judge, no retry.
 *
 * Then EVERY still of every pair is judged by a vision model that is NOT the in-loop one (gemma-4 by default; the
 * engine's loop uses llama-4-scout): one yes/no question per VISUAL gold item of the case, asked of every picture
 * (the gold ids are the bench's, not Kleo's spec ids, so a shot's `covers` cannot be mapped to them; an item counts as
 * shown when any picture of the film shows it — "at": first/last pins a framing to the first or last picture), plus
 * the look (photograph vs drawn animation). Identity: for each character, the first picture that shows them against
 * each later one (up to --max-pairs), "the same individual?". A look attribute "holds" in a picture when the character
 * it belongs to is in that picture and the attribute is answered yes.
 *
 * Writes out/<run>/stills-<engine>/<case>/<shot>.(jpg|png) (+ cast/<id>.jpg sheets), a record.json per case, an
 * index.html contact sheet per pair, out/<run>/stills-<engine>.json, and a comparison report (default
 * out/stills-report-<pairs>.md). Cost: see README.md (new engine ≈ $0.02-0.06 per still, legacy free, judge ≈ $0.001).
 */
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  parseArgs, loadCases, runDir, readJson, writeJson, makeEnv, runJson, chatJson, dataUrl, mimeOfBytes, pool, withTag, ledgerSum,
  shotsOf, esc, pct, usd, OUT_DIR, REPO_DIR,
} from "./lib.mjs";

const args = parseArgs();
const pairs = String(args.runs ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((p) => { const [run, engine = "new"] = p.split(":"); return { run, engine }; });
if (!pairs.length || !args.cases || pairs.some((p) => !["new", "legacy"].includes(p.engine))) {
  console.error("usage: stills.mjs --runs <run>:<new|legacy>[,…] --cases a,b,c [--src dir] [--judge model] [--vision model] [--attempts 3] [--pass 0.85] [--max-shots 0] [--max-pairs 6] [--no-identity] [--judge-thinking off|on] [--force] [--out report.md]");
  process.exit(2);
}
const cases = loadCases(args.cases);
const src = resolve(process.cwd(), String(args.src ?? join(REPO_DIR, "src")));
const judgeModel = String(args.judge ?? "@cf/google/gemma-4-26b-a4b-it");
const legacyModel = String(args["legacy-model"] ?? "@cf/bytedance/stable-diffusion-xl-lightning");
const maxShots = Number(args["max-shots"] ?? 0);
const maxPairs = Number(args["max-pairs"] ?? 6);
const identity = !args["no-identity"];
const force = !!args.force;
const judgeThinking = String(args["judge-thinking"] ?? "off");

/* ------------------------------------------------------------------ the legacy proxy (worker/kleo_pictures.py) */

// EXACTLY worker/kleo_pictures.py STYLE_SUFFIX / NEGATIVE_PROMPT / STYLE_NEGATIVE / budgets as of dab7084.
const STYLE_SUFFIX = {
  cartoon: "flat vector cartoon illustration, bold clean outlines, vivid warm colors, simple shapes",
  realistic: "cinematic photograph, RAW photo, 35mm lens, natural light, sharp focus on the subject, real skin and fabric texture, high detail",
  animation: "frame from a 2D animated feature film, hand-painted background, clean expressive character design, cel shading, rich colour, cinematic composition, high detail",
};
const NEGATIVE_PROMPT = "text, letters, watermark, logo, caption, subtitles, blurry, soft focus, cgi, 3d render, illustration, drawing, comic, anime, manga, line art, cartoon, painting, plastic skin, oversmooth, low detail, deformed, low quality";
const STYLE_NEGATIVE = {
  cartoon: NEGATIVE_PROMPT, realistic: NEGATIVE_PROMPT,
  animation: "text, letters, watermark, logo, caption, subtitles, photograph, photorealistic, live action, real skin, 3d render, cgi, blurry, low detail, deformed, extra fingers, low quality",
};
const PROMPT_MAX = 240, BASE_MAX = 150, CONTEXT_MAX = 110, NEGATIVE_MAX = 320;
const PRONOUN_HINTS = /(?<![\p{L}\p{N}_])(?:she|her|hers|herself|he|him|his|himself|the character|the protagonist)(?![\p{L}\p{N}_])/iu;
const NEGATION = /\b(?:no|never|without|not)\s+(?:a |an |the |any )?([^,.;:()]{3,40}?)(?=[,.;:()]|\s+(?:and|but|or|is|are|ever|shown|seen|visible)\b|$)/gi;
const squash = (s) => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function headNounIn(name, prompt) {
  const parts = name.trim().toLowerCase().split(/\s+/);
  const head = parts[parts.length - 1] ?? "";
  if (head.length < 4) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escRe(head)}(?![\\p{L}\\p{N}_])`, "iu").test(prompt);
}
/** kleo_pictures.cast_in: whole name or a head noun no other character shares; a lone character is also "she"/"he". */
function castIn(direction, prompt) {
  const cast = (direction?.cast ?? []).map((m) => ({ name: squash(m?.name), look: squash(m?.look) })).filter((m) => m.name && m.look);
  const lowered = String(prompt ?? "").toLowerCase();
  const heads = cast.map((m) => m.name.toLowerCase().split(/\s+/).pop() ?? "");
  const unique = heads.map((h) => h !== "" && heads.filter((x) => x === h).length === 1);
  const named = cast.filter((m, i) => lowered.includes(m.name.toLowerCase()) || (unique[i] && headNounIn(m.name, String(prompt ?? ""))));
  if (named.length || cast.length !== 1) return named;
  return PRONOUN_HINTS.test(String(prompt ?? "")) ? cast : [];
}
/** kleo_pictures.cast_for → context_for with budget CONTEXT_MAX: each "name: look" WHOLE or not at all. */
function castLead(direction, prompt) {
  const bits = []; let used = 0;
  for (const m of castIn(direction, prompt)) {
    const text = squash(`${m.name}: ${m.look}`).replace(/[,.;]+$/, "");
    const cost = text.length + (bits.length ? 2 : 0);
    if (used + cost > CONTEXT_MAX) continue;
    bits.push(text); used += cost;
  }
  return bits.join(". ");
}
/** kleo_pictures.full_prompt: <lead>, <scene prompt cut to 150 on a word>, <context>, <style suffix>. */
export function legacyPrompt(imagePrompt, style, direction) {
  let base = squash(imagePrompt).slice(0, PROMPT_MAX).trim();
  if (base.length > BASE_MAX) base = base.slice(0, BASE_MAX).includes(" ") ? base.slice(0, BASE_MAX).replace(/\s+\S*$/, "") : base.slice(0, BASE_MAX);
  base = base.trim().replace(/[,.;]+$/, "");
  let head = squash(castLead(direction, imagePrompt));
  if (head.length > CONTEXT_MAX) head = head.slice(0, CONTEXT_MAX).includes(" ") ? head.slice(0, CONTEXT_MAX).replace(/\s+\S*$/, "") : "";
  head = head.replace(/[,.;]+$/, "");
  return [head, base, STYLE_SUFFIX[style] ?? STYLE_SUFFIX.realistic].filter(Boolean).join(", ");
}
function negatedTerms(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(NEGATION)) {
    const t = squash(m[1]);
    if (!t || /^(?:one|longer|more|less|matter|way)\b/i.test(t)) continue;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (/\bfaces?\b/i.test(t)) for (const f of ["face", "portrait"]) if (!out.includes(f)) out.push(f);
  }
  return out;
}
/** kleo_pictures.negative_for: the look's negative plus the direction's forbidden list and negated look clauses, ≤ 320 chars. */
export function legacyNegative(direction, style) {
  const base = STYLE_NEGATIVE[style] ?? NEGATIVE_PROMPT;
  const terms = [];
  if (direction && typeof direction === "object") {
    const negated = negatedTerms([...(direction.cast ?? []).map((m) => String(m?.look ?? "")), String(direction.world ?? "")].join(". "));
    for (let t of [...(direction.forbidden ?? []), ...negated]) {
      t = squash(t).replace(/[,.;]+$/, "");
      if (t && !base.toLowerCase().includes(t.toLowerCase()) && !terms.some((x) => x.toLowerCase() === t.toLowerCase())) terms.push(t);
    }
  }
  let joined = base;
  for (const t of terms) { if (joined.length + t.length + 2 > NEGATIVE_MAX) break; joined += ", " + t; }
  return joined;
}
const seedFor = (id) => createHash("sha256").update(String(id)).digest().readUInt32BE(0) & 0x7fffffff;
const SDXL_SIZE = { "9:16": { width: 768, height: 1344 }, "16:9": { width: 1344, height: 768 } };

/* ------------------------------------------------------------------ drawing */

const extOf = (bytes) => (mimeOfBytes(bytes) === "image/png" ? "png" : mimeOfBytes(bytes) === "image/webp" ? "webp" : "jpg");
const existing = (dir, id) => { for (const e of ["jpg", "png", "webp"]) { const f = join(dir, `${id}.${e}`); if (existsSync(f)) return f; } return null; };
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function drawLegacy(c, plan, shots, dir) {
  const sb = plan.storyboard, style = sb.kleo_style ?? c.style, fmt = sb.format ?? c.format, direction = sb.direction ?? plan.direction ?? null;
  const negative = legacyNegative(direction, style);
  return pool(shots, 3, async (sh) => {
    const prompt = legacyPrompt(sh.image_prompt, style, direction);
    const rec = { id: sh.id, image_prompt: sh.image_prompt, prompt, negative, seed: seedFor(sh.id), covers: sh.covers, cast: sh.cast };
    const have = existing(dir, sh.id);
    if (have && !force) return { ...rec, file: have };
    try {
      // 8 steps: SDXL-lightning is distilled for few steps. At its default (20) with a negative prompt it returned a
      // BLACK frame on the smoke run of 24 September (16 KB); at 8 the same prompt and seed drew the picture. A frame
      // that still comes back blank (a JPEG this small at this size is a flat colour) is drawn once more on the next seed.
      let bytes = null, blank = 0;
      for (let k = 0; k < 2; k++) {
        const r = await runJson(legacyModel, { prompt, negative_prompt: negative, ...SDXL_SIZE[fmt === "16:9" ? "16:9" : "9:16"], num_steps: 8, seed: (rec.seed + k) & 0x7fffffff });
        bytes = r.binary ?? (r.result?.image ? Buffer.from(r.result.image, "base64") : null);
        if (!bytes) throw new Error("no image in the answer");
        if (bytes.length >= 30_000) break;
        blank++;
      }
      const file = join(dir, `${sh.id}.${extOf(bytes)}`);
      writeFileSync(file, bytes);
      return { ...rec, file, fresh: true, ...(blank ? { blank } : {}) };
    } catch (e) { return { ...rec, error: String(e?.message ?? e).slice(0, 300) }; }
  });
}

async function drawNew(mod, c, plan, shots, dir) {
  const sb = plan.storyboard, look = (sb.kleo_style ?? c.style) === "animation" ? "animation" : "realistic", format = (sb.format ?? c.format) === "16:9" ? "16:9" : "9:16";
  const spec = plan.spec ?? null, direction = sb.direction ?? plan.direction ?? null;
  const env = makeEnv({ STILL_MODEL: args["still-model"], VISION_MODEL: args.vision, STILL_ATTEMPTS: args.attempts, STILL_PASS: args.pass });
  const opts = { ...(args.attempts ? { attempts: Number(args.attempts) } : {}), ...(args.pass ? { pass: Number(args.pass) } : {}) };
  // THE SHEETS: the spec's cast when the plan has a spec, otherwise the direction's (an old plan drawn by the new engine).
  const members = spec?.cast?.length ? spec.cast.map((m) => ({ id: m.id, name: m.name, look: m.look })) : (direction?.cast ?? []).map((m) => ({ id: m.name, name: m.name, look: m.look }));
  const sheets = new Map();
  const sheetDir = join(dir, "cast");
  mkdirSync(sheetDir, { recursive: true });
  const sheetRecs = [];
  for (const m of members) {
    const safe = norm(m.id).replace(/ /g, "-") || "x";
    const have = existing(sheetDir, safe);
    try {
      let bytes, score = null;
      if (have && !force) bytes = new Uint8Array(readFileSync(have));
      else { const r = await mod.drawCastSheet(env, spec, m, look, null, opts); bytes = r.bytes; score = r.score; writeFileSync(join(sheetDir, `${safe}.${extOf(bytes)}`), bytes); }
      sheets.set(norm(m.name), { bytes, mime: mimeOfBytes(bytes) });
      sheetRecs.push({ id: m.id, name: m.name, file: existing(sheetDir, safe), score });
    } catch (e) { sheetRecs.push({ id: m.id, name: m.name, error: String(e?.message ?? e).slice(0, 300) }); }
  }
  const visual = plan.treatment?.visual ?? sb.treatment?.visual ?? null;
  const recs = await pool(shots, 3, async (sh) => {
    const shot = { id: sh.id, image_prompt: sh.image_prompt, shot_kind: sh.shot_kind, covers: sh.covers, cast: sh.cast, action: sh.action };
    const who = typeof mod.stillCast === "function" ? mod.stillCast(shot, spec, direction) : [];
    const refs = who.map((m) => ({ label: m.name, image: sheets.get(norm(m.name)) })).filter((r) => r.image).slice(0, 4);
    const input = { shot, spec, direction, look, format, visual, refs };
    const prompt = typeof mod.compileStill === "function" ? mod.compileStill(input).prompt : null;
    const rec = { id: sh.id, image_prompt: sh.image_prompt, prompt, covers: sh.covers, cast: sh.cast, refs: refs.map((r) => r.label) };
    const have = existing(dir, sh.id);
    const prevRec = readJson(join(dir, "record.json"))?.shots?.find((x) => x.id === sh.id);
    if (have && !force) return { ...(prevRec ?? {}), ...rec, file: have, fresh: false };
    try {
      const r = await mod.drawStill(env, input, opts);
      const file = join(dir, `${sh.id}.${extOf(r.bytes)}`);
      writeFileSync(file, r.bytes);
      return { ...rec, file, fresh: true, loop: { score: r.score, mustFailed: r.mustFailed, failed: r.failed, tries: r.tries, judged: r.judged } };
    } catch (e) { return { ...rec, error: String(e?.message ?? e).slice(0, 300) }; }
  });
  return { recs, sheets: sheetRecs };
}

/* ------------------------------------------------------------------ the independent judge */

const stripNo = (t) => String(t).replace(/^\s*(?:no|never|without|not|nothing like)\s+/i, "").replace(/[.\s]+$/, "");
function questionsFor(c, look) {
  const qs = [{ id: "look", question: look === "animation" ? "Is this image a drawn 2D animation frame (not a photograph and not a 3D render)?" : "Does this image look like a real photograph (not a drawing, painting or 3D render)?", expect: "yes" }];
  for (const g of c.gold.filter((x) => x.visual)) {
    const text = g.text.replace(/^the (?:FIRST|final) shot (?:is|shows) /i, "");
    const question = g.kind === "exclude" ? `Does the image show ${stripNo(g.text)}?`
      : g.kind === "text" ? `Is this written legibly and spelled correctly in the image: ${g.text}?`
      : g.kind === "style" ? `Is the image in this style: ${g.text}?`
      : `Does the image show this: ${text}?`;
    qs.push({ id: g.id, question, expect: g.kind === "exclude" ? "no" : "yes" });
  }
  return qs;
}
/** Bumped whenever the questions' wording or the call changes, so a cached answer is never reused across versions. */
const JUDGE_VERSION = "v2-image-first";
const yesNo = (v) => { const s = String(v ?? "").trim().toLowerCase(); return /^(yes|y|true)\b/.test(s) ? "yes" : /^(no|n|false)\b/.test(s) ? "no" : "?"; };

/**
 * One vision call: the image(s) FIRST, then the questions, and a one-line description before the answers. Both
 * choices were measured on the smoke run of 24 September on one SDXL still (a pink neon sign in a desert): with the
 * text first gemma-4 (thinking off) answered "no" to every question, "is this a photograph" included; with the image
 * first, and asked to say what it sees before answering, it answered "yes" to the photograph and "no" to the diner,
 * the waitress and the unreadable sign — right on all eight. The description is kept in the record: it is how a
 * reader of the contact sheet can see what the judge believed it was looking at.
 */
async function askImages(images, questions, preface = "") {
  const keys = questions.map((_, i) => `q${i + 1}`);
  const prompt = `${preface}Look at the picture${images.length > 1 ? "s" : ""} and answer each question "yes" or "no", judging only what is actually visible. If something is only partly true, answer "no".
${questions.map((q, i) => `${keys[i]}: ${q.question}`).join("\n")}
First write ONE short line describing what the picture${images.length > 1 ? "s show" : " shows"}. Then answer with ONE JSON object mapping each question id to "yes" or "no", for example {"q1":"no","q2":"yes"}.`;
  const content = [...images.map((b) => ({ type: "image_url", image_url: { url: dataUrl(b) } })), { type: "text", text: prompt }];
  const r = await chatJson(judgeModel, [{ role: "user", content }], { maxTokens: judgeThinking === "off" ? 800 : 6000, retries: 1, thinking: judgeThinking });
  const seen = r.text.replace(/```(?:json)?/gi, "").split(/\{/)[0].trim().split("\n")[0]?.slice(0, 300) ?? "";
  return { ...Object.fromEntries(questions.map((q, i) => [q.id, yesNo(r.json?.[keys[i]])])), _seen: seen };
}

async function judgeStills(c, recs, dir) {
  const look = c.style === "animation" ? "animation" : "realistic";
  const qs = questionsFor(c, look);
  const cacheFile = join(dir, "judge-cache.json");
  const cache = readJson(cacheFile, {});
  for (const r of recs) {
    if (!r.file) continue;
    const bytes = readFileSync(r.file);
    const key = createHash("sha1").update(judgeModel + judgeThinking + JUDGE_VERSION).update(JSON.stringify(qs)).update(bytes).digest("hex");
    if (!cache[key] || force) {
      const answers = {};
      for (let i = 0; i < qs.length; i += 12) Object.assign(answers, await askImages([bytes], qs.slice(i, i + 12)));
      cache[key] = answers;
    }
    r.judge = cache[key];
  }
  // IDENTITY: the first picture that shows a character against each later one.
  const idRes = [];
  if (identity) for (const g of c.gold.filter((x) => x.kind === "character" && x.visual && !x.group)) {
    const shown = recs.filter((r) => r.judge?.[g.id] === "yes");
    if (shown.length < 2) { idRes.push({ id: g.id, pictures: shown.length, pairs: 0, same: 0 }); continue; }
    const anchor = shown[0];
    let pairs = 0, same = 0; const detail = [];
    for (const other of shown.slice(1, 1 + maxPairs)) {
      const a = readFileSync(anchor.file), b = readFileSync(other.file);
      const key = createHash("sha1").update(judgeModel + judgeThinking + JUDGE_VERSION).update(`identity ${g.text}`).update(a).update(b).digest("hex");
      if (!cache[key] || force) cache[key] = await askImages([a, b], [{ id: "same", question: `Both images show ${g.text}. Is it the SAME individual in image 1 and image 2 — same face, hair, build, clothes or markings?` }], "Image 1 and image 2 are two pictures from the same film. ");
      pairs++; if (cache[key].same === "yes") same++;
      detail.push({ a: anchor.id, b: other.id, same: cache[key].same });
    }
    idRes.push({ id: g.id, pictures: shown.length, pairs, same, detail });
  }
  writeJson(cacheFile, cache);
  return { questions: qs, identity: idRes };
}

/** The numbers of one case: coverage over the film, exclusions, look attributes that hold, style, identity, order. */
function scoreCase(c, recs, judged) {
  const drawn = recs.filter((r) => r.file && r.judge);
  const ans = (r, id) => r.judge?.[id];
  const visMust = c.gold.filter((g) => g.visual && g.must && g.kind !== "exclude");
  const shownIn = (g) => {
    const pool = g.at === "first" ? drawn.slice(0, 1) : g.at === "last" ? drawn.slice(-1) : drawn;
    return pool.filter((r) => ans(r, g.id) === "yes");
  };
  const coverage = visMust.map((g) => ({ id: g.id, kind: g.kind, shown: shownIn(g).length > 0, pictures: shownIn(g).map((r) => r.id) }));
  const excludes = c.gold.filter((g) => g.kind === "exclude").map((g) => ({ id: g.id, violated: drawn.filter((r) => ans(r, g.id) === "yes").map((r) => r.id) }));
  let holdN = 0, holdY = 0;
  for (const g of c.gold.filter((x) => x.kind === "look" && x.who)) for (const r of drawn) if (ans(r, g.who) === "yes") { holdN++; if (ans(r, g.id) === "yes") holdY++; }
  const events = c.gold.filter((g) => g.order && g.visual).sort((a, b) => a.order - b.order);
  let last = -1, outOfOrder = 0, placed = 0;
  for (const e of events) { const i = drawn.findIndex((r) => ans(r, e.id) === "yes"); if (i < 0) continue; placed++; if (i < last) outOfOrder++; else last = i; }
  const id = judged.identity.filter((x) => x.pairs);
  const loop = drawn.filter((r) => r.loop);
  return {
    shots: recs.length, drawn: drawn.length, failed: recs.filter((r) => r.error).length,
    coverage_n: coverage.length, coverage_shown: coverage.filter((x) => x.shown).length,
    coverage_by_kind: Object.fromEntries([...new Set(coverage.map((x) => x.kind))].map((k) => [k, { n: coverage.filter((x) => x.kind === k).length, shown: coverage.filter((x) => x.kind === k && x.shown).length }])),
    excludes_n: excludes.length, excludes_violated: excludes.filter((x) => x.violated.length).length,
    look_hold_n: holdN, look_hold_yes: holdY,
    style_n: drawn.length, style_yes: drawn.filter((r) => ans(r, "look") === "yes").length,
    identity_pairs: id.reduce((s, x) => s + x.pairs, 0), identity_same: id.reduce((s, x) => s + x.same, 0),
    events_placed: placed, events_out_of_order: outOfOrder,
    loop_mean_score: loop.length ? loop.reduce((s, r) => s + (r.loop.score ?? 0), 0) / loop.length : null,
    loop_mean_tries: loop.length ? loop.reduce((s, r) => s + (r.loop.tries?.length ?? 1), 0) / loop.length : null,
    coverage, excludes, identity: judged.identity,
  };
}

/* ------------------------------------------------------------------ contact sheet */

function contactSheet(pair, rows) {
  const card = (c, r) => {
    const ok = (q) => { const a = r.judge?.[q.id]; return a === q.expect ? "ok" : a === "?" || a === undefined ? "unk" : "bad"; };
    const qs = rows.find((x) => x.c.id === c.id).judged.questions;
    return `<figure class="card">${r.file ? `<img loading="lazy" src="${esc(`${c.id}/${r.file.split(/[\\/]/).pop()}`)}" alt="${esc(r.id)}">` : `<div class="err">${esc(r.error ?? "not drawn")}</div>`}
<figcaption><b>${esc(r.id)}</b>${r.loop ? ` · in-loop ${pct(r.loop.score)}, ${r.loop.tries?.length ?? 1} tr${(r.loop.tries?.length ?? 1) === 1 ? "y" : "ies"}` : ""}${r.covers?.length ? ` · covers ${esc(r.covers.join(" "))}` : ""}${r.refs?.length ? ` · refs ${esc(r.refs.join(", "))}` : ""}
<p class="ip">${esc(r.image_prompt)}</p>${r.judge?._seen ? `<p class="seen">judge saw: ${esc(r.judge._seen)}</p>` : ""}
<ul>${qs.map((q) => `<li class="${ok(q)}">${esc(q.id)} ${esc(r.judge?.[q.id] ?? "–")} <span>${esc(q.question)}</span></li>`).join("")}</ul>
${r.prompt ? `<details><summary>drawn prompt</summary><p>${esc(r.prompt)}</p>${r.negative ? `<p><i>negative:</i> ${esc(r.negative)}</p>` : ""}</details>` : ""}</figcaption></figure>`;
  };
  const sections = rows.map(({ c, recs, s, sheets }) => `<section><h2>${esc(c.id)} <small>${esc(c.style)} · ${esc(c.format)} · ${s.drawn}/${s.shots} drawn · coverage ${s.coverage_shown}/${s.coverage_n} · look attributes ${s.look_hold_yes}/${s.look_hold_n} · identity ${s.identity_same}/${s.identity_pairs} · exclusions broken ${s.excludes_violated}/${s.excludes_n}</small></h2>
<p class="req">${esc(c.prompt)}</p>
${sheets?.length ? `<div class="sheets">${sheets.map((m) => m.file ? `<figure class="sheet"><img src="${esc(`${c.id}/cast/${m.file.split(/[\\/]/).pop()}`)}" alt="${esc(m.name)}"><figcaption>${esc(m.name)}${m.score !== null && m.score !== undefined ? ` · ${pct(m.score)}` : ""}</figcaption></figure>` : `<p class="err">${esc(m.name)}: ${esc(m.error)}</p>`).join("")}</div>` : ""}
<div class="grid">${recs.map((r) => card(c, r)).join("")}</div></section>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stills ${esc(pair.run)} ${esc(pair.engine)}</title>
<style>:root{--bg:#fafaf8;--fg:#1d1d1b;--mut:#6b6b66;--ok:#1f7a3a;--bad:#b3261e;--card:#fff;--line:#e3e3de}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--mut:#9a9a94;--ok:#6fcf8a;--bad:#ff8a80;--card:#20201e;--line:#34342f}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0 auto;max-width:1400px;padding:16px}
h2 small{font-weight:400;color:var(--mut);font-size:13px}.req{color:var(--mut)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.card,.sheet{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:0;padding:8px}.card img,.sheet img{width:100%;border-radius:4px}
.sheets{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.sheet{width:140px}.ip{color:var(--mut);font-size:12px}.seen{font-size:12px;font-style:italic}
ul{list-style:none;padding:0;margin:4px 0;font-size:12px}li span{color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad);font-weight:600}.unk{color:var(--mut)}.err{color:var(--bad)}</style></head>
<body><h1>Stills — run ${esc(pair.run)}, engine ${esc(pair.engine)}</h1><p>Judge: ${esc(judgeModel)}. Green = the answer the request wants; red = not.</p>${sections}</body></html>`;
}

/* ------------------------------------------------------------------ main */

const results = [];
for (const pair of pairs) {
  let mod = null;
  if (pair.engine === "new") {
    const f = join(src, "stills.ts");
    if (!existsSync(f)) { console.log(`${pair.run}:new — ${src} has no stills.ts, skipped`); continue; }
    try { mod = await import(pathToFileURL(f).href); } catch (e) { console.log(`${pair.run}:new — cannot load ${f}: ${String(e?.message ?? e).slice(0, 300)}; skipped`); continue; }
  }
  const base = join(runDir(pair.run), `stills-${pair.engine}`);
  const rows = [];
  for (const c of cases) {
    const plan = readJson(join(runDir(pair.run), `${c.id}.json`));
    if (!plan?.ok) { console.log(`- ${pair.run}:${pair.engine} ${c.id}: no successful plan, skipped`); continue; }
    let shots = shotsOf(plan.storyboard);
    if (maxShots > 0) shots = shots.slice(0, maxShots);
    const dir = join(base, c.id);
    mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const tag = `stills:${pair.run}:${pair.engine}:${c.id}`;
    const drawn = await withTag(`${tag}:draw`, () => pair.engine === "legacy" ? drawLegacy(c, plan, shots, dir).then((recs) => ({ recs, sheets: [] })) : drawNew(mod, c, plan, shots, dir));
    // Stills reused from an earlier invocation cost nothing now: their time and price are the ones recorded then.
    const prevRecord = readJson(join(dir, "record.json"));
    const fresh = drawn.recs.some((r) => r.fresh);
    const drawMs = fresh || !prevRecord ? Date.now() - t0 : prevRecord.draw_ms;
    const judged = await withTag(`${tag}:judge`, () => judgeStills(c, drawn.recs, dir));
    const s = scoreCase(c, drawn.recs, judged);
    const cost = { draw: fresh || !prevRecord ? ledgerSum(`${tag}:draw`).usd : prevRecord.cost?.draw ?? 0, judge: ledgerSum(`${tag}:judge`).usd || (prevRecord?.cost?.judge ?? 0) };
    writeJson(join(dir, "record.json"), { case: c.id, run: pair.run, engine: pair.engine, draw_ms: drawMs, cost, sheets: drawn.sheets, shots: drawn.recs, score: s });
    rows.push({ c, recs: drawn.recs, s, sheets: drawn.sheets, judged, cost, drawMs });
    console.log(`- ${pair.run}:${pair.engine} ${c.id}: ${s.drawn}/${s.shots} stills · coverage ${s.coverage_shown}/${s.coverage_n} · look attrs ${s.look_hold_yes}/${s.look_hold_n} · identity ${s.identity_same}/${s.identity_pairs} · exclusions broken ${s.excludes_violated}/${s.excludes_n} · ${Math.round(drawMs / 1000)} s · draw ${usd(cost.draw)} judge ${usd(cost.judge)}`);
  }
  if (!rows.length) continue;
  writeFileSync(join(base, "index.html"), contactSheet(pair, rows));
  const tot = (k) => rows.reduce((a, r) => a + (Number(r.s[k]) || 0), 0);
  const agg = {
    run: pair.run, engine: pair.engine, judge: judgeModel, cases: rows.map((r) => r.c.id),
    shots: tot("shots"), drawn: tot("drawn"), failed: tot("failed"),
    coverage: tot("coverage_n") ? tot("coverage_shown") / tot("coverage_n") : null, coverage_n: tot("coverage_n"),
    look_hold: tot("look_hold_n") ? tot("look_hold_yes") / tot("look_hold_n") : null, look_hold_n: tot("look_hold_n"),
    style: tot("style_n") ? tot("style_yes") / tot("style_n") : null,
    identity: tot("identity_pairs") ? tot("identity_same") / tot("identity_pairs") : null, identity_pairs: tot("identity_pairs"),
    excludes_violated: tot("excludes_violated"), excludes_n: tot("excludes_n"),
    events_out_of_order: tot("events_out_of_order"), events_placed: tot("events_placed"),
    draw_usd: rows.reduce((a, r) => a + r.cost.draw, 0), judge_usd: rows.reduce((a, r) => a + r.cost.judge, 0),
    s_per_still: tot("drawn") ? rows.reduce((a, r) => a + r.drawMs, 0) / 1000 / tot("drawn") : null,
    per_case: Object.fromEntries(rows.map((r) => [r.c.id, { coverage: r.s.coverage_n ? r.s.coverage_shown / r.s.coverage_n : null, look_hold: r.s.look_hold_n ? r.s.look_hold_yes / r.s.look_hold_n : null, identity: r.s.identity_pairs ? r.s.identity_same / r.s.identity_pairs : null, excludes_violated: r.s.excludes_violated, drawn: r.s.drawn, shots: r.s.shots }])),
  };
  writeJson(join(runDir(pair.run), `stills-${pair.engine}.json`), agg);
  results.push(agg);
  console.log(`${pair.run}:${pair.engine}: contact sheet ${join(base, "index.html")}`);
}

if (results.length) {
  const cols = results.map((r) => `${r.run}:${r.engine}`);
  const row = (label, f) => `| ${label} | ${results.map(f).join(" | ")} |`;
  const md = [
    `# Fidelity bench — stills: ${cols.join(" vs ")}`, "",
    `Judge: \`${judgeModel}\` (not the engine's in-loop judge). Cases: ${[...new Set(results.flatMap((r) => r.cases))].join(", ")}. Written ${new Date().toISOString()}.`, "",
    `| | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`,
    row("stills drawn", (r) => `${r.drawn}/${r.shots}`),
    row("**visual must items shown somewhere in the film**", (r) => `${pct(r.coverage)} (n ${r.coverage_n})`),
    row("**look attributes that hold** (when the character is in the picture)", (r) => `${pct(r.look_hold)} (n ${r.look_hold_n})`),
    row("**same character across pictures**", (r) => `${pct(r.identity)} (${r.identity_pairs} pairs)`),
    row("pictures in the right look (photo / drawn)", (r) => pct(r.style)),
    row("exclusions broken", (r) => `${r.excludes_violated}/${r.excludes_n}`),
    row("events shown out of the user's order", (r) => `${r.events_out_of_order}/${r.events_placed}`),
    row("seconds per still (drawing, incl. retries)", (r) => (r.s_per_still ?? 0).toFixed(1)),
    row("drawing cost", (r) => usd(r.draw_usd)),
    row("judging cost", (r) => usd(r.judge_usd)),
    "", "## By case (coverage · look attributes · identity)", "",
    `| case | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`,
    ...cases.map((c) => `| ${c.id} | ${results.map((r) => { const x = r.per_case[c.id]; return x ? `${pct(x.coverage)} · ${pct(x.look_hold)} · ${pct(x.identity)}${x.excludes_violated ? ` · ${x.excludes_violated} excl. broken` : ""}` : "—"; }).join(" | ")} |`),
    "", `Contact sheets: ${results.map((r) => `out/${r.run}/stills-${r.engine}/index.html`).join(", ")}`, "",
  ].join("\n");
  const outFile = args.out ? String(args.out) : join(OUT_DIR, `stills-report-${cols.join("-vs-").replace(/:/g, "-")}.md`);
  writeFileSync(outFile, md);
  console.log(`\nreport: ${outFile} · total ${usd(ledgerSum("stills:").usd)}`);
}
