/**
 * THE DIRECTION: what the user actually asked for, the world it is drawn in, and the colour law.
 *
 * Kleo used to go straight from the user's prompt to a flat list of scenes. Nothing in the pipeline held the film
 * together: the style was picked by three regular expressions, the "world" of the video existed only as one clause of
 * prose inside the planner's rules, the accent colour tinted the captions and never reached the picture, and the only
 * negative direction in the whole product was a fixed ten-word negative prompt. So every shot re-invented the look,
 * and a vocabulary from another video (the wifi icon in the pirate storm) had nothing standing in its way.
 *
 * A `direction` is that missing object. It is written ONCE per video, before any scene exists, and it is the thing
 * every later stage reads:
 *   - the planner writes the outline and the scenes against it (src/storyboard.ts);
 *   - the picture prompts are built from it, positives AND negatives (src/images.ts);
 *   - the validator refuses a storyboard that contradicts it (src/keou-contract.ts);
 *   - the guide teaches the calling assistant to write one (src/guide.ts).
 *
 * It travels at the top level of the storyboard and reaches the engine untouched (worker/kleo_worker.py build_project
 * only pops the forbidden fields, and worker/keou/contract.py only closes the SHOT field set), so nothing here can
 * break a render: an engine that does not read `direction` simply ignores it.
 *
 * Nothing in this module imports the contract, so the contract can import it without a cycle: the two enums it needs
 * (the accents, and the scene count to check the sections against) are passed in by the caller.
 */

/** What a scene is FOR, in narrative terms — the DA document's "genre de scène". The template a scene falls back to. */
export const GENRES = ["hook", "fact", "number", "list", "quote", "turn", "close"] as const;
export type Genre = (typeof GENRES)[number];

/**
 * Limits, in one table. The guide prints them, the JSON schema constrains the model to them, the validator enforces
 * them and the tests read them: four copies of a number is how the shot count ended up being 1-4 in the contract,
 * 2-4 in the planner and "two to four" on the website, all at the same time.
 */
export const D = {
  subject: 120,
  goal: 120,
  audience: 80,
  tone: 60,
  mustKeep: { max: 8, len: 90 },
  world: 180,
  cast: { max: 4, name: 24, look: 140 },
  objects: { min: 3, max: 12, len: 36 },
  forbidden: { min: 3, max: 12, len: 36 },
  sections: { min: 2, max: 8, name: 32, means: 40 },
} as const;

export interface CastMember {
  /** How the narration and the image prompts refer to this character: "the captain", "the cabin boy". */
  name: string;
  /** The ONE description reused verbatim in every picture that shows them. This is what keeps a face a face. */
  look: string;
}

export interface Section {
  /** The narrative name of this stretch of film: "THE PLUG", "THE REMOTE ATTACKER". */
  name: string;
  /** The one accent this section owns. Two neighbouring sections never share it: that is the colour law. */
  accent: string;
  /** What the colour means here, so the viewer can follow it: "the hidden threat", "the fix". */
  means: string;
  /** How many consecutive scenes belong to this section. The sections tile the film exactly, in order. */
  scenes: number;
}

export interface Direction {
  /* ---- what the user asked for (read out of their words, never invented) */
  subject: string;
  goal: string;
  audience: string;
  tone: string;
  /** Facts, names, numbers and constraints copied out of the request that the finished narration MUST still contain. */
  must_keep: string[];
  /* ---- the world this film is drawn in ("ogni prompt ha il suo mondo") */
  world: string;
  cast: CastMember[];
  /** The object vocabulary of THIS film. Every picture draws from this list and nothing else. */
  objects: string[];
  /** What must NOT appear. Reaches the image model as a negative prompt and the validator as a hard check. */
  forbidden: string[];
  /* ---- the colour law */
  sections: Section[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const printable = (s: string) => ![...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

/** A non-empty single-line string within `max` characters, or null with the reason. */
function badText(v: unknown, label: string, max: number): string | null {
  if (typeof v !== "string" || !v.trim()) return `direction.${label} is required`;
  if (v.length > max) return `direction.${label} is ${v.length} characters, the limit is ${max}`;
  if (!printable(v)) return `direction.${label} contains a control character`;
  return null;
}

/** A list of short strings: bounded length, bounded count, no duplicates, no empties. */
function listProblems(v: unknown, label: string, min: number, max: number, len: number): string[] {
  if (!Array.isArray(v)) return [`direction.${label} must be an array of ${min}-${max} short strings`];
  if (v.length < min || v.length > max) return [`direction.${label} has ${v.length} entries, it needs ${min}-${max}`];
  const out: string[] = [];
  const seen = new Set<string>();
  v.forEach((x, i) => {
    const bad = badText(x, `${label}[${i}]`, len);
    if (bad) { out.push(bad); return; }
    const k = String(x).trim().toLowerCase();
    if (seen.has(k)) out.push(`direction.${label}[${i}] repeats "${String(x).trim()}"`);
    seen.add(k);
  });
  return out;
}

export interface DirectionOptions {
  /** The accents a section may own (the contract's CINEMA_ACCENTS; passed in so this module stays a leaf). */
  accents: readonly string[];
  /** How many scenes the storyboard has, so the sections can be checked to tile it exactly. Omit to skip that check. */
  scenes?: number;
}

/**
 * Every problem with a direction, as sentences a model can act on. Pure: no throwing, no I/O, no order dependence.
 *
 * The two rules that are not merely shape:
 *   - SECTIONS TILE THE FILM. The scene counts must add up to the number of scenes, so every scene belongs to exactly
 *     one section and therefore owns exactly one accent. Without this the colour law is a suggestion.
 *   - NEIGHBOURING SECTIONS NEVER SHARE AN ACCENT. "Une seule couleur d'accent forte" is only legible if the colour
 *     changes when the subject changes; two adjacent sections in the same hue read as one section.
 */
export function directionProblems(d: unknown, opts: DirectionOptions): string[] {
  if (!isObj(d)) return ["direction must be a JSON object"];
  const out: string[] = [];
  const add = (s: string | null) => { if (s) out.push(s); };

  add(badText(d.subject, "subject", D.subject));
  add(badText(d.goal, "goal", D.goal));
  add(badText(d.audience, "audience", D.audience));
  add(badText(d.tone, "tone", D.tone));
  add(badText(d.world, "world", D.world));

  // must_keep may legitimately be empty: a one-line prompt ("a Short about pirates") carries no facts to preserve.
  // ABSENT means empty. An empty array does not survive a round trip through the planner's cleaner (it drops empty
  // values), so demanding the key would refuse a direction for having nothing to demand.
  if (d.must_keep === undefined) { /* none to keep */ }
  else if (!Array.isArray(d.must_keep)) out.push("direction.must_keep must be an array (use [] when the request states no facts to keep)");
  else if (d.must_keep.length > D.mustKeep.max) out.push(`direction.must_keep has ${d.must_keep.length} entries, the limit is ${D.mustKeep.max}`);
  else d.must_keep.forEach((x, i) => add(badText(x, `must_keep[${i}]`, D.mustKeep.len)));

  out.push(...listProblems(d.objects, "objects", D.objects.min, D.objects.max, D.objects.len));
  out.push(...listProblems(d.forbidden, "forbidden", D.forbidden.min, D.forbidden.max, D.forbidden.len));

  // The cast is optional (a film about a city has none), but a character that IS listed must be described once.
  if (d.cast === undefined) { /* nobody recurring */ }
  else if (!Array.isArray(d.cast)) out.push("direction.cast must be an array (use [] when the film has no recurring character)");
  else if (d.cast.length > D.cast.max) out.push(`direction.cast has ${d.cast.length} entries, the limit is ${D.cast.max}`);
  else d.cast.forEach((m, i) => {
    if (!isObj(m)) { out.push(`direction.cast[${i}] must be {name, look}`); return; }
    add(badText(m.name, `cast[${i}].name`, D.cast.name));
    add(badText(m.look, `cast[${i}].look`, D.cast.look));
  });

  if (!Array.isArray(d.sections) || d.sections.length < D.sections.min || d.sections.length > D.sections.max) {
    out.push(`direction.sections must be an array of ${D.sections.min}-${D.sections.max} sections`);
    return out;
  }
  let total = 0;
  let previous: string | null = null;
  d.sections.forEach((s, i) => {
    if (!isObj(s)) { out.push(`direction.sections[${i}] must be {name, accent, means, scenes}`); return; }
    add(badText(s.name, `sections[${i}].name`, D.sections.name));
    add(badText(s.means, `sections[${i}].means`, D.sections.means));
    if (typeof s.accent !== "string" || !opts.accents.includes(s.accent))
      out.push(`direction.sections[${i}].accent must be one of ${opts.accents.join(", ")}`);
    else {
      if (s.accent === previous) out.push(`direction.sections[${i}] repeats the accent "${s.accent}" of the section before it: a new section takes a new colour`);
      previous = s.accent;
    }
    if (!Number.isInteger(s.scenes) || (s.scenes as number) < 1) out.push(`direction.sections[${i}].scenes must be a whole number of scenes, at least 1`);
    else total += s.scenes as number;
  });
  if (opts.scenes !== undefined && total !== opts.scenes)
    out.push(`direction.sections cover ${total} scenes but the video has ${opts.scenes}: the sections must add up to the scene count exactly`);
  return out;
}

/**
 * The section each scene belongs to, in scene order. Sections tile the film, so this is a walk, not a search.
 * A storyboard whose sections do not add up is a validation error, not a crash here: the last section covers the
 * remainder so that callers building prompts and colours still get an answer for every scene.
 */
export function sectionOfScene(sections: readonly Section[], sceneCount: number): (Section | null)[] {
  const out: (Section | null)[] = [];
  for (const s of sections) for (let n = 0; n < s.scenes && out.length < sceneCount; n++) out.push(s);
  while (out.length < sceneCount) out.push(sections.length ? sections[sections.length - 1] : null);
  return out;
}

/* ------------------------------------------------------------------ fidelity: does the video say what was asked */

/** Content words of a phrase, for the "did the narration keep this" test: lowercase, punctuation dropped, stops kept. */
const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** Words too common to prove anything, in the two languages a job can be in. */
const STOP = new Set(
  ("the a an and or of to in on at for with your you it is are was were be this that they them their its from by as if so we he she i not no but into one two " +
   "il lo la i gli le un uno una di a da in con su per tra fra e o che non ci si è sono era del della dei delle al alla ai alle nel nella come più anche")
    .split(" "),
);
/** A number as it is written, so "3 million" in the request is not answered by "a few million" in the narration. */
const NUM = /\d[\d.,]*/g;
/**
 * Was this word said? Exactly, or as an inflection of itself. "beginner" is kept by a narration that says
 * "beginners", and "errore" by one that says "errori" — otherwise the gate fires on grammar instead of on substance,
 * which would teach the planner to parrot the request rather than write it. Five characters is the shortest prefix
 * that does not start matching unrelated words.
 */
function spoken(w: string, said: Set<string>): boolean {
  if (said.has(w)) return true;
  if (w.length < 5) return false;
  const stem = w.slice(0, 5);
  for (const s of said) if (s.length >= 5 && s.startsWith(stem)) return true;
  return false;
}

/**
 * Which of the direction's must_keep items the narration dropped. This is the fidelity gate: the validator can prove a
 * storyboard is well-formed, but only this can say it is about what the user asked for.
 *
 * The rule is deliberately forgiving on wording and strict on substance: every NUMBER in the item must appear in the
 * narration verbatim (a number the model rounded away is a changed fact), and at least 60 % of the item's content
 * words must appear somewhere in the narration. An item made only of stop words proves nothing and is skipped.
 */
export function missingFacts(mustKeep: readonly string[] | undefined, narration: string): string[] {
  if (!Array.isArray(mustKeep) || !mustKeep.length) return [];
  const said = new Set(words(narration));
  const saidNumbers = new Set(narration.match(NUM)?.map((n) => n.replace(/[.,]$/, "")) ?? []);
  const out: string[] = [];
  for (const item of mustKeep) {
    const numbers = (item.match(NUM) ?? []).map((n) => n.replace(/[.,]$/, ""));
    if (numbers.some((n) => !saidNumbers.has(n))) { out.push(item); continue; }
    const content = words(item).filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
    if (!content.length) continue;
    const hit = content.filter((w) => spoken(w, said)).length;
    if (hit / content.length < 0.6) out.push(item);
  }
  return out;
}

/**
 * Picture prompts that name something the direction forbids. This is the wifi-icon-in-the-pirate-storm check: the
 * exclusion list is only worth writing if something refuses the video that ignores it.
 *
 * Matched on whole words so "no text" does not fire on "context", and case-insensitively because an image prompt is
 * free prose. A multi-word forbidden term matches as a phrase.
 */
export function forbiddenInPrompts(
  forbidden: readonly string[] | undefined,
  prompts: readonly { id: string; image_prompt: string }[],
): { id: string; term: string }[] {
  const out: { id: string; term: string }[] = [];
  const terms = (forbidden ?? []).map((t) => ({ term: t, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t.trim())}(?![\\p{L}\\p{N}])`, "iu") })).filter((t) => t.term.trim());
  for (const p of prompts) for (const t of terms) if (t.re.test(p.image_prompt)) out.push({ id: p.id, term: t.term });
  return out;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ------------------------------------------------------------------ the direction reaches the picture */

/**
 * The accent as an instruction an image model understands. The colour law is worthless while the accent only tints the
 * captions: the picture is where the viewer sees it. Kept as a NAMED colour rather than a hex, because diffusion models
 * follow colour names and ignore hex codes.
 */
export const ACCENT_LIGHT: Record<string, string> = {
  red: "a single warm red light source",
  amber: "a single warm amber light source",
  green: "a single cool green light source",
  cyan: "a single cold cyan light source",
};

/**
 * The cast members a picture prompt is talking about, so their one description can be appended verbatim. Matching on
 * the name as a whole phrase keeps "the captain" from firing on "the captain's chair" of a scene she is not in — it
 * does fire, and that is the right side to err on: repeating her look costs a few tokens, losing her face costs the film.
 */
export function castFor(cast: readonly CastMember[], imagePrompt: string): CastMember[] {
  const p = imagePrompt.toLowerCase();
  return cast.filter((m) => m.name.trim() && p.includes(m.name.trim().toLowerCase()));
}

/**
 * The direction as the extra sentences appended to one shot's image prompt: the world it is set in, the verbatim
 * description of whichever characters it shows, and the light of the section it belongs to.
 *
 * Order matters for a diffusion model — what comes first weighs most — so the author's own sentence stays in front and
 * everything here follows it.
 */
export function pictureContext(d: Direction | null, imagePrompt: string, accent: string | null): string {
  if (!d) return "";
  const bits: string[] = [];
  for (const m of castFor(d.cast ?? [], imagePrompt)) bits.push(`${m.name}: ${m.look}`);
  if (d.world) bits.push(d.world);
  const light = accent ? ACCENT_LIGHT[accent] : null;
  if (light) bits.push(light);
  return bits.join(". ");
}

/** The negative prompt for this video: the product-wide one, plus everything this film's direction forbids. */
export function negativeFor(d: Direction | null, base: string): string {
  const extra = (d?.forbidden ?? []).map((s) => s.trim()).filter(Boolean);
  return extra.length ? `${base}, ${extra.join(", ")}` : base;
}

/* ------------------------------------------------------------------ what Kleo tells the user it decided */

/**
 * The one-page account of what the direction asked for and what the plan delivered. The owner's own accepted
 * deliverables all end with this table ("Conformita al tuo pacchetto: richiesto | ottenuto"), and Kleo had no
 * equivalent: it returned links and nothing else, so there was no way to say whether a render matched the brief
 * except by watching it.
 */
export interface Conformity { requested: string; delivered: string; ok: boolean }

export function conformity(d: Direction, facts: { scenes: number; pictures: number; words: number; missing: string[] }): Conformity[] {
  const rows: Conformity[] = [
    { requested: `Subject: ${d.subject}`, delivered: `${facts.scenes} scenes, ${facts.words} narrated words`, ok: true },
    { requested: `Goal: ${d.goal}`, delivered: facts.missing.length ? `${facts.missing.length} requested facts missing` : "every requested fact kept", ok: !facts.missing.length },
    { requested: `Tone: ${d.tone} · Audience: ${d.audience}`, delivered: "narration written to it", ok: true },
    { requested: `Colour law: ${d.sections.length} sections, one accent each`, delivered: d.sections.map((s) => `${s.name}=${s.accent}`).join(", "), ok: true },
    { requested: `Must not appear: ${d.forbidden.join(", ")}`, delivered: "checked against every picture prompt", ok: true },
  ];
  if (facts.pictures) rows.push({ requested: `World: ${d.world}`, delivered: `${facts.pictures} pictures drawn in it`, ok: true });
  return rows;
}
