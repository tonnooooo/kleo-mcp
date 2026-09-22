/**
 * THE DISSOLVES (22 September 2026). The owner, after watching the first animatic of the day (gt_w4tuqvgh, 30 s,
 * eleven hard cuts): "essendo un video, aggiungi anche qualche dissolvenza — molto clean, non bullshit — una o
 * massimo due su 30 secondi, più il video è lungo più ne metti". So a dissolve is a punctuation mark, not a style:
 *
 *   - it sits ONLY between two acts (a chapter change), never between two shots of one scene — picture.js already
 *     measured what a cross-dissolve between two unrelated generated pictures is (a double exposure), and inside an
 *     act the film keeps its hard cuts;
 *   - there is at most ONE per PER_SECONDS seconds of film (30 s → 1, 60 s → 2, 120 s → 5), and never more than
 *     the film has act boundaries;
 *   - they are spread evenly over the film's length (the boundary nearest each k/(n+1) mark), so a 30-second film
 *     dissolves once, near its middle, where the treatment's pacing says the film changes gear.
 *
 * The mark is one word on the INCOMING scene, `transition: "dissolve"`; a scene without it cuts. Three places read
 * it and nothing else: worker/keou/engine/picture.js draws the outgoing scene's last picture under the incoming one
 * for DISSOLVE_S seconds (the animatic), render.mjs writes it into build/shots.json, and worker/kleo_video.py
 * build_footage cross-fades the two clips of the track with xfade for the same DISSOLVE_S (the film). The two
 * contracts (src/keou-contract.ts, worker/keou/contract.py) accept exactly "cut" and "dissolve".
 */

/** Seconds of the cross-dissolve. picture.js carries the same number as DISSOLVE; test/transitions.test.mjs holds them equal. */
export const DISSOLVE_S = 0.8;
/** One dissolve per this many seconds of film. */
export const PER_SECONDS = 25;
export const TRANSITIONS = ["cut", "dissolve"] as const;
export type Transition = (typeof TRANSITIONS)[number];

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const words = (s: unknown): number => (typeof s === "string" ? s.split(/\s+/).filter(Boolean).length : 0);

/** How many dissolves a film of `duration_s` seconds gets, before the act boundaries cap it. */
export const dissolveBudget = (duration_s: number): number => Math.max(1, Math.round(Math.max(0, duration_s) / PER_SECONDS));

/**
 * The indices of the scenes that OPEN an act: a chapter label different from the scene before (or, without labels,
 * an accent change). Never the first scene, which opens the film and has nothing to dissolve from.
 */
export function actBoundaries(scenes: unknown[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < scenes.length; i++) {
    const a = scenes[i - 1], b = scenes[i];
    if (!isObj(a) || !isObj(b)) continue;
    const ca = typeof a.chapter === "string" ? a.chapter.trim() : "", cb = typeof b.chapter === "string" ? b.chapter.trim() : "";
    if (ca || cb) { if (ca !== cb) out.push(i); }
    else if (a.accent !== b.accent && (a.accent !== undefined || b.accent !== undefined)) out.push(i);
  }
  return out;
}

/**
 * Marks the dissolves on a storyboard's scenes and returns the indices marked. Idempotent: earlier marks are cleared
 * first, so a storyboard finished twice carries the same dissolves. Pure — no clock, no model.
 */
export function placeTransitions<T extends { scenes?: unknown }>(sb: T, duration_s: number): number[] {
  const scenes = Array.isArray(sb.scenes) ? (sb.scenes as unknown[]) : [];
  for (const s of scenes) if (isObj(s)) delete s.transition;
  const boundaries = actBoundaries(scenes);
  if (!boundaries.length || duration_s <= 0) return [];
  const n = Math.min(boundaries.length, dissolveBudget(duration_s));
  // Where each scene starts, as a share of the film: the narration's words are the clock the planner has here.
  const total = scenes.reduce<number>((a, s) => a + (isObj(s) ? words(s.voice) : 0), 0) || scenes.length;
  const starts: number[] = [];
  let acc = 0;
  for (const s of scenes) { starts.push(acc / total); acc += isObj(s) ? words(s.voice) : 0; }
  if (!scenes.some((s) => isObj(s) && words(s.voice))) for (let i = 0; i < scenes.length; i++) starts[i] = i / scenes.length;
  const chosen = new Set<number>();
  for (let k = 1; k <= n; k++) {
    const target = k / (n + 1);
    let best = -1, dist = Infinity;
    for (const i of boundaries) {
      if (chosen.has(i)) continue;
      const d = Math.abs(starts[i] - target);
      if (d < dist - 1e-9) { dist = d; best = i; }   // a tie goes to the earlier boundary, never to floating-point noise
    }
    if (best >= 0) chosen.add(best);
  }
  const marked = [...chosen].sort((a, b) => a - b);
  for (const i of marked) (scenes[i] as Record<string, unknown>).transition = "dissolve";
  return marked;
}

/** The transition a scene asks for, in the two words the engine knows; anything else is a cut. */
export const transitionOf = (s: unknown): Transition => (isObj(s) && s.transition === "dissolve" ? "dissolve" : "cut");
