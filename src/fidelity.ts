/**
 * THE FIDELITY JUDGE: does the planned film contain what the user asked for (24 September 2026).
 *
 * The owner, after watching the September films: "it does not follow the images, it does not follow anything; make
 * the video almost identical to what the user wants". Measured on 18 production jobs, 176 concrete requirements: 70%
 * kept, 10% CONTRADICTED on screen (a red apron for a lilac one, the villain's clothes on the hero, the party before
 * the cake), and 22 inventions that changed the films. Until this module the only check was whether 60% of the words
 * of eight must_keep facts turned up somewhere in the narration — a bag of words over the one track that cannot show
 * a colour — and it was a warning.
 *
 * The judge has two halves, and neither is trusted alone:
 *   - the DETERMINISTIC half is src/spec.ts coverage(): what the storyboard CLAIMS (every must item listed in some
 *     shot's "covers" or said in a voice line, the events first shown in the user's order, no unknown ids);
 *   - the SEMANTIC half is a model reading the spec and the planned shots — the image_prompt the still will be drawn
 *     from, the action the clip will move, the voice the viewer hears — and answering, per MUST item, whether the
 *     plan keeps it, weakens it, loses it or contradicts it, plus every invention that changes the film.
 * The model's reading decides what is really on screen; the deterministic half overrules it where it can be certain
 * (an event shown out of order is contradicted whatever the model says; a line the narration never says is not
 * "kept"), and it is the whole answer when the model cannot be reached — the judge never throws and never blocks a
 * film for want of a model.
 *
 * Nothing here knows which model answers: the caller (src/storyboard.ts) passes `call`, so a test can hold it still.
 */
import { coverage, itemById, mustItems, type CoverageResult, type RequestSpec, type SpecItem } from "./spec.ts";
import { answerText, firstJson } from "./vision.ts";

export type VerdictStatus = "kept" | "paraphrased" | "lost" | "contradicted";
export const VERDICT_STATUSES: readonly VerdictStatus[] = ["kept", "paraphrased", "lost", "contradicted"];

export interface ItemVerdict {
  /** The spec item id ("R3"). */
  id: string;
  status: VerdictStatus;
  /** The shot ids ("<sceneId>-s<n>") where the item is shown — or, for a contradiction, where it is contradicted. */
  shots: string[];
  /** Why, in a few words: what is weak, what is wrong. */
  note?: string;
}

export interface PlanFidelity {
  /** One verdict per MUST item of the spec, in the spec's order. */
  verdicts: ItemVerdict[];
  /** Things the plan added that CHANGE the film the user asked for (not harmless detail). */
  inventions: string[];
  /** (kept + 0.5 × paraphrased) / must items; 1 when the spec has no must item. */
  score: number;
  /** Which judge answered: the model's name, or "deterministic" when only the coverage check did. */
  judge: string;
  /** The deterministic half, as it was merged. */
  coverage: CoverageResult;
}

/** Limits on what the judge's answer may carry into a report or a repair prompt. */
export const JUDGE_LIMITS = { note: 200, invention: 200, inventions: 10, shots: 12 } as const;

/**
 * The judge's system message. Strict JSON, one verdict per requirement, and the four statuses defined so that two
 * readings of the same plan agree: a contradiction is something SHOWN or SAID that is the opposite of the request,
 * not merely something missing.
 */
export const JUDGE_SYSTEM = `You are Kleo's continuity supervisor. Kleo turns a user's request into a short narrated film. You are given the user's REQUIREMENTS (items R1, R2… with the user's own words, and a cast c1, c2… with how each character looks) and the PLAN of the film: every shot with the picture that will be drawn (image_prompt), what moves in it (action), who is in it (cast), which requirements it claims (covers), and the narration of every scene (voice).

For EACH requirement listed under JUDGE THESE, decide one status by reading what the plan will actually SHOW and SAY — not what it claims in "covers":
- "kept": a picture clearly shows it (or, for a line the narrator must say, the voice says those words), as the user described it.
- "paraphrased": it is there but weakened, generic or partial — "a woman" for "a thin woman with short blonde hair", "a cake" for "a three-tier lemon cake", the line said in other words.
- "lost": nothing in the pictures or the narration shows or says it.
- "contradicted": a picture or a line shows the OPPOSITE or something incompatible — the wrong colour, the wrong person, the wrong place, the wrong number, the events in the wrong order, something the user excluded shown anyway.
"shots" lists the shot ids where it is kept or paraphrased, or where it is contradicted; [] when lost. "note" says in a few words what is weak or wrong (empty when kept).

Then list under "inventions" every thing the plan ADDS that CHANGES the film the user asked for: a character, an event, a place, an ending, a twist, a period they did not ask for and did not leave open. Harmless detail (light, weather, a background object) is not an invention. [] when there are none.

Answer with STRICT JSON and nothing else — no prose, no markdown fences:
{"verdicts":[{"id":"R1","status":"kept|paraphrased|lost|contradicted","shots":["01-a-s1"],"note":"…"}],"inventions":["…"]}`;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

/** The plan's shots as the judge reads them, with the ids coverage() and the stills use ("<sceneId>-s<n>"). */
function planLines(sb: unknown): string {
  const scenes = isObj(sb) && Array.isArray(sb.scenes) ? sb.scenes.filter(isObj) : [];
  const out: string[] = [];
  scenes.forEach((sc, i) => {
    const sid = String(sc.id ?? `scene-${i + 1}`);
    out.push(`SCENE ${i + 1} (${sid}) voice: "${clip(sc.voice, 400)}"`);
    const shots = Array.isArray(sc.shots) ? sc.shots.filter(isObj) : [];
    shots.forEach((sh, j) => {
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "");
      const bits = [`image: ${clip(sh.image_prompt, 400)}`];
      if (typeof sh.action === "string" && sh.action.trim()) bits.push(`action: ${clip(sh.action, 240)}`);
      if (list(sh.cast)) bits.push(`cast: ${list(sh.cast)}`);
      if (list(sh.covers)) bits.push(`covers: ${list(sh.covers)}`);
      out.push(`  ${sid}-s${j + 1} | ${bits.join(" | ")}`);
    });
  });
  return out.join("\n");
}

/** The judge's user message: the requirements, the plan, and the items to judge (the MUST ones). */
export function judgePrompt(spec: RequestSpec, storyboard: unknown): string {
  const cast = spec.cast.length ? `CAST:\n${spec.cast.map((c) => `  ${c.id} ${c.name}: ${c.look}`).join("\n")}\n` : "";
  const items = spec.items.map((i) => `  ${i.id} [${i.kind}${i.kind === "event" && i.order ? ` #${i.order}` : ""}${i.must ? ", MUST" : ""}] ${i.text}${i.who ? ` (${i.who})` : ""} — user: "${i.quote}"`).join("\n");
  const judge = mustItems(spec).map((i) => i.id).join(", ");
  const d = isObj(storyboard) && isObj(storyboard.direction) ? storyboard.direction : null;
  const dcast = d && Array.isArray(d.cast) ? d.cast.filter(isObj).map((m) => `  ${clip(m.name, 40)}: ${clip(m.look, 420)}`).join("\n") : "";
  return `THE USER'S REQUIREMENTS (mode ${spec.mode}; summary: ${spec.summary})
${cast}REQUIREMENTS:
${items}${spec.open.length ? `\nLEFT TO KLEO (additions here are allowed, not inventions): ${spec.open.join("; ")}` : ""}

THE PLAN${dcast ? `\nThe characters as the plan draws them (this description is added to every picture that shows them):\n${dcast}` : ""}
${planLines(storyboard)}

JUDGE THESE: ${judge || "(no must item)"}
Return the JSON object only.`;
}

/** The answer's object, whatever shape the call returned: an object, a JSON string, or a Workers AI envelope. */
function answerObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") return firstJson(raw);
  if (!isObj(raw)) return null;
  if (Array.isArray(raw.verdicts)) return raw;
  const text = answerText(raw);
  return text ? firstJson(text) : null;
}

const score = (verdicts: readonly ItemVerdict[]): number => {
  if (!verdicts.length) return 1;
  const kept = verdicts.filter((v) => v.status === "kept").length, para = verdicts.filter((v) => v.status === "paraphrased").length;
  return Math.round(((kept + 0.5 * para) / verdicts.length) * 1000) / 1000;
};

/** The shots that claim an item in their covers, in film order: the deterministic answer to "where is it". */
function claimingShots(sb: unknown, id: string): string[] {
  const scenes = isObj(sb) && Array.isArray(sb.scenes) ? sb.scenes.filter(isObj) : [];
  return scenes.flatMap((sc, i) => (Array.isArray(sc.shots) ? sc.shots.filter(isObj) : []).flatMap((sh, j) =>
    Array.isArray(sh.covers) && sh.covers.includes(id) ? [`${String(sc.id ?? `scene-${i + 1}`)}-s${j + 1}`] : []));
}

/** What the deterministic half alone says about one must item. */
function deterministicVerdict(spec: RequestSpec, sb: unknown, it: SpecItem, cov: CoverageResult): ItemVerdict {
  if (cov.outOfOrder.includes(it.id)) return { id: it.id, status: "contradicted", shots: claimingShots(sb, it.id), note: "shown out of the user's order" };
  if (cov.uncovered.includes(it.id)) return { id: it.id, status: "lost", shots: [], note: it.kind === "line" ? "the narration never says it" : "no shot claims it" };
  return { id: it.id, status: "kept", shots: claimingShots(sb, it.id) };
}

/**
 * THE JUDGE. Asks the model once for a verdict per MUST item and the inventions, then merges the deterministic
 * coverage: an event out of order is "contradicted" whatever the model said; a line the narration does not say is at
 * best "paraphrased"; an item the model skipped gets the deterministic verdict. Never throws: a model that fails,
 * times out or answers nonsense leaves the deterministic verdicts, with judge "deterministic".
 */
export async function judgePlan(
  spec: RequestSpec,
  storyboard: unknown,
  call: (system: string, user: string, maxTokens: number) => Promise<unknown>,
  judgeName: string,
): Promise<PlanFidelity> {
  let cov: CoverageResult;
  try { cov = coverage(spec, storyboard); } catch { cov = { uncovered: [], outOfOrder: [], unknownIds: [], unknownCast: [], problems: [] }; }
  const musts = (() => { try { return mustItems(spec); } catch { return [] as SpecItem[]; } })();
  const fallback = (): PlanFidelity => {
    const verdicts = musts.map((it) => deterministicVerdict(spec, storyboard, it, cov));
    return { verdicts, inventions: [], score: score(verdicts), judge: "deterministic", coverage: cov };
  };
  if (!musts.length) return { verdicts: [], inventions: [], score: 1, judge: "deterministic", coverage: cov };

  let answer: Record<string, unknown> | null = null;
  try {
    answer = answerObject(await call(JUDGE_SYSTEM, judgePrompt(spec, storyboard), Math.min(4000, 600 + 90 * musts.length)));
  } catch { answer = null; }
  if (!answer || !Array.isArray(answer.verdicts)) return fallback();

  try {
    // Shot ids the plan really has: a verdict that points at a shot that does not exist points at nothing.
    const known = new Set<string>();
    const scenes = isObj(storyboard) && Array.isArray(storyboard.scenes) ? storyboard.scenes.filter(isObj) : [];
    scenes.forEach((sc, i) => (Array.isArray(sc.shots) ? sc.shots : []).forEach((_, j) => known.add(`${String(sc.id ?? `scene-${i + 1}`)}-s${j + 1}`)));
    const byId = new Map<string, Record<string, unknown>>();
    for (const v of answer.verdicts) if (isObj(v) && typeof v.id === "string" && !byId.has(v.id.trim())) byId.set(v.id.trim(), v);
    let heard = 0;
    const verdicts: ItemVerdict[] = musts.map((it) => {
      const v = byId.get(it.id);
      const status = v && typeof v.status === "string" ? (v.status.trim().toLowerCase() as VerdictStatus) : null;
      if (!v || !status || !VERDICT_STATUSES.includes(status)) return deterministicVerdict(spec, storyboard, it, cov);
      heard++;
      const shots = (Array.isArray(v.shots) ? v.shots : []).filter((s): s is string => typeof s === "string" && known.has(s.trim())).map((s) => s.trim()).slice(0, JUDGE_LIMITS.shots);
      const note = clip(v.note, JUDGE_LIMITS.note);
      const out: ItemVerdict = { id: it.id, status, shots, ...(note ? { note } : {}) };
      // Where the deterministic half is certain, it wins.
      if (cov.outOfOrder.includes(it.id) && out.status !== "contradicted")
        return { id: it.id, status: "contradicted", shots: shots.length ? shots : claimingShots(storyboard, it.id), note: clip(`shown out of the user's order${note ? `; ${note}` : ""}`, JUDGE_LIMITS.note) };
      if (it.kind === "line" && cov.uncovered.includes(it.id) && out.status === "kept")
        return { id: it.id, status: "paraphrased", shots, note: clip(`the narration does not say the user's words${note ? `; ${note}` : ""}`, JUDGE_LIMITS.note) };
      return out;
    });
    // A model that judged none of the items it was asked about did not judge: the answer is the deterministic one.
    if (!heard) return fallback();
    const inventions = (Array.isArray(answer.inventions) ? answer.inventions : [])
      .map((x) => clip(x, JUDGE_LIMITS.invention)).filter(Boolean).slice(0, JUDGE_LIMITS.inventions);
    return { verdicts, inventions, score: score(verdicts), judge: judgeName || "model", coverage: cov };
  } catch {
    return fallback();
  }
}

/**
 * The judge's findings as sentences for ONE repair round of the planner: what is lost, what is contradicted and
 * where, what is only weakly there, what was invented, and what the deterministic check found that no verdict says
 * (a missing "covers" claim, an unknown id). Kept items say nothing. Deduplicated, in the spec's order.
 */
export function fidelityFeedback(f: PlanFidelity, spec: RequestSpec): string[] {
  const out: string[] = [];
  const where = (shots: readonly string[]) => (shots.length ? ` (shot${shots.length === 1 ? "" : "s"} ${shots.join(", ")})` : "");
  for (const v of f.verdicts) {
    const it = itemById(spec, v.id);
    if (!it || v.status === "kept") continue;
    const said = it.kind === "line";
    const what = `${v.id} (${it.kind}) "${clip(it.text, 160)}" — user: "${clip(it.quote, 120)}"`;
    const note = v.note ? `: ${v.note}` : "";
    if (v.status === "lost")
      out.push(said
        ? `${what} is missing${note} — the narrator must say it: put the user's words in a scene's "voice"`
        : `${what} is missing${note} — show it: write it into the image_prompt of the shot where it happens and list "${v.id}" in that shot's "covers"`);
    else if (v.status === "contradicted")
      out.push(`${what} is CONTRADICTED${where(v.shots)}${note} — the plan shows or says something else; change it so it is exactly what the user asked for${it.kind === "event" ? ", in the user's order of events" : ""}`);
    else
      out.push(`${what} is only weakly there${where(v.shots)}${note} — make it specific, exactly as the user described it${said ? " (the user's own words in the voice)" : " (every attribute, in the image_prompt)"}`);
  }
  for (const inv of f.inventions) out.push(`Not asked for: ${inv} — remove it, unless it is one of the things the user left to Kleo${spec.open.length ? ` (${spec.open.join("; ")})` : ""}`);
  // The deterministic problems whose item no verdict already sends back (a kept item nobody listed in "covers", an
  // unknown id, an unknown cast member): the stills engine reads "covers" and "cast", so they matter on their own.
  const reported = new Set(f.verdicts.filter((v) => v.status !== "kept").map((v) => v.id));
  for (const p of f.coverage.problems) {
    const id = /^(R?\w+?)[\s(:]/.exec(p)?.[1] ?? "";
    if (id && reported.has(id)) continue;
    out.push(p);
  }
  return [...new Set(out)];
}
