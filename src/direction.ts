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
  /**
   * The cast (24 September 2026, the fidelity engine): six characters, a 40-character name and a 420-character look,
   * the same room the request spec (src/spec.ts S.cast/S.name/S.look) gives them. At 140 characters the look was cut
   * before the second half of what the user wrote — "short blonde hair tied up, a lilac apron, round glasses, a
   * flour-dusted grey jumper" lost its glasses and jumper — and at four characters the fifth person of a family story
   * was drawn with no description at all. The stills are drawn on the server by FLUX.2 now, which reads the whole
   * sentence; the 77-token CLIP ceiling that justified the short look no longer applies to them.
   */
  cast: { max: 6, name: 40, look: 420 },
  objects: { min: 3, max: 12, len: 36 },
  forbidden: { min: 3, max: 12, len: 36 },
  sections: { min: 2, max: 8, name: 32, means: 40 },
} as const;

export interface CastMember {
  /**
   * How the narration and the image prompts refer to this character: the name the user gave a fictional character
   * ("Mara", "Captain Oyelaran") or, when they gave none, the role ("the captain", "the cabin boy").
   */
  name: string;
  /** The ONE description reused verbatim in every picture that shows them. This is what keeps a face a face. */
  look: string;
  /** The request spec's cast id ("c1") this character is, when the film has a spec. Lets a shot's `cast` name them by id. */
  id?: string | null;
}

/** A spec cast entry as castFor reads it: the id a shot may name, and the name that ties it to the direction's cast. */
export interface CastRef { id: string; name: string }

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
    if (m.id !== undefined && m.id !== null && (typeof m.id !== "string" || m.id.length > 12)) out.push(`direction.cast[${i}].id must be the spec's cast id ("c1"), a short string`);
    if (typeof m.look === "string" && thinLook(m.look))
      out.push(`direction.cast[${i}].look "${m.look.trim()}" is a name, not a look: describe the character in one sentence a painter could work from — age or build, face, hair, clothes with their colours, one distinctive item (a 30-second Short about a warrior was drawn with a different face in every picture because its look was "a young Jedi-like warrior")`);
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
  // A storyboard arrives as untrusted JSON, so the runtime guard stays; the local keeps the element type.
  const facts: readonly string[] = Array.isArray(mustKeep) ? mustKeep.filter((x): x is string => typeof x === "string") : [];
  if (!facts.length) return [];
  const said = new Set(words(narration));
  const saidNumbers = new Set(narration.match(NUM)?.map((n: string) => n.replace(/[.,]$/, "")) ?? []);
  const out: string[] = [];
  for (const item of facts) {
    const numbers = (item.match(NUM) ?? []).map((n: string) => n.replace(/[.,]$/, ""));
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

/**
 * WHAT A PICTURE MAY NEVER BE ASKED TO DRAW, whatever the film: a diagram, a chart, a screen with words on it, a
 * readout, a quoted caption. Measured on a whole planned film on 14 September (Voyager, production model): five of
 * eight scenes asked for "a diagram showing the signal loss", "a screen displaying '24 billion kilometres'", "a
 * readout 'VOYAGER ONLINE'" — the explainer's habit dressed as photography, and the one thing an image model draws
 * worst. Numbers and words belong to the layer (src/graphics.ts); the picture shows a real place, object or person.
 */
const SCREEN_TEXT = [
  /\b(diagram|infographic|flowchart|chart|graph|schematic|blueprint|readout|dashboard|hud|overlay|subtitle|caption|label|logo|icon)s?\b/i,
  /\b(text|words?|letters|numbers|digits|font|typography)\b/i,
  /\b(on|onto|across) (?:a |the )?(?:screen|monitor|display)\b/i,
  /\b(screen|monitor|display|terminal)s? (?:displaying|showing|reading|that reads|that says|with the words?)\b/i,
  /['"‘’“”][^'"‘’“”]{2,40}['"‘’“”]/,   // a quoted string is a caption asking to be drawn
];
export function screenTextIn(prompt: string): string | null {
  for (const re of SCREEN_TEXT) { const m = re.exec(prompt); if (m) return m[0]; }
  return null;
}
/**
 * The pictures that ask for a diagram, a screen with text or a quoted caption, with the words that gave them away.
 *
 * `allowedIds` are the pictures that MUST carry words: the shots that cover a spec "text" item (24 September 2026).
 * A user who asked for a shop sign reading "Da Mara" or a note that says "sorry" asked for words in the picture, and
 * FLUX.2 draws readable text — so the rule that kept captions out of every picture would otherwise refuse the one
 * thing the user described. Those shots are skipped; every other picture is still held to the rule.
 */
export function screenTextProblems(prompts: readonly { id: string; image_prompt: string }[], allowedIds?: ReadonlySet<string>): { id: string; term: string }[] {
  const out: { id: string; term: string }[] = [];
  for (const p of prompts) {
    if (allowedIds?.has(p.id)) continue;
    const term = screenTextIn(p.image_prompt);
    if (term) out.push({ id: p.id, term });
  }
  return out;
}

/* ------------------------------------------------------------------ nothing in the frame may be dead */

/**
 * SOMETHING IN THE SHOT MUST MOVE BY ITSELF.
 *
 * Measured, not guessed. Nine clips at 1280x704, 49 frames, 30 steps, Wan 2.2 TI2V-5B on an RTX 6000 Ada
 * (median optical flow in pixels; the share of it a pure zoom explains):
 *
 *   face, crane down        4.35 px   alive        landscape, crane down   0.38 px   DEAD
 *   face, push in           1.74 px   alive        landscape, push in      0.89 px   alive
 *   face, track sideways    8.17 px   alive        object,    crane down   0.27 px   DEAD
 *   landscape, track        1.20 px   alive        object,    push in      0.03 px   DEAD
 *   object,    track        2.36 px   alive
 *
 * Two findings decide the shape of this rule, and both are counter-intuitive.
 *
 * 1. NAMING THE THING IS NOT ENOUGH. Both failing descriptions ALREADY contained the words a keyword check would
 *    look for: "low mist" and "dust in the air". They still froze, because those are STATES, not actions. So this
 *    does not hunt for nouns like mist, dust or smoke. It demands a subject that is DOING something — a present
 *    participle from a small, deliberate list. "low mist" is dead; "mist drifting fast across the tarmac" is alive.
 *
 * 2. A PERSON IS ALWAYS ALIVE. Every face clip moved, none of them because the prompt asked: a person in frame
 *    breathes and turns their head on their own. So a shot that shows someone is never asked for more.
 *
 * And it REPAIRS rather than refuses, exactly like the static_forced routing rule: a refusal sends the model back to
 * rewrite and costs a whole round trip, a repair costs nothing. The clause is built from what the picture already
 * names, so the subject of the shot never changes — only its stillness does. Since 24 September 2026 the clause goes
 * into the shot's "action" (motionHint), never into the image_prompt the still is drawn from.
 */

/** Anything that moves without being told to: it breathes, it turns its head, it fidgets. */
const LIVING_SUBJECT = /\b(man|men|woman|women|boy|boys|girl|girls|child|children|kid|kids|person|people|crowd|figure|figures|face|faces|hand|hands|rider|driver|worker|workers|sailor|sailors|captain|soldier|dancer|runner|dog|dogs|cat|cats|bird|birds|horse|horses|animal|animals|fish|whale|dolphin|insect|bee|butterfly)\b/i;

/**
 * Present participles that describe real movement. Kept small and specific on purpose: "-ing" alone matches
 * "building", "lighting" and "morning", none of which move anything.
 */
const MOTION_VERB = /\b(moving|passing|crossing|travelling|traveling|approaching|receding|entering|leaving|flowing|pounding|swelling|drifting|swirling|blowing|streaming|pouring|spilling|dripping|splashing|surging|breaking|crashing|rolling|tumbling|falling|rising|climbing|sinking|floating|hovering|gliding|soaring|flying|sailing|running|walking|marching|striding|riding|racing|charging|turning|spinning|circling|orbiting|swaying|rippling|flapping|snapping|whipping|waving|flickering|guttering|flaring|burning|smouldering|steaming|smoking|curling|boiling|bubbling|scattering|bursting|erupting|collapsing|crumbling|sliding|slipping|creeping|spreading|shaking|trembling|swinging|bouncing|leaping|jumping|chasing|opening|closing|reaching|pointing|throwing|catching|lifting|dropping)\b/i;

/**
 * What the picture already names, and the movement that belongs to it. The first match wins, and the order is
 * deliberate: STRONGEST ON SCREEN FIRST. A flame guttering is bright, local and unmistakable; dust swirling is
 * diffuse and low contrast. When a picture names several of these — a compass by candlelight with dust in the air
 * names two — the one a viewer will actually see moving is the one worth asking for.
 * Birds and other creatures are absent on purpose: they are LIVING_SUBJECT, so a picture that names one never
 * reaches this table at all.
 */
const ENLIVEN: readonly { of: RegExp; clause: string }[] = [
  { of: /\b(candle|candlelight|lantern|torch|fire|flame|campfire|hearth)\b/i, clause: "the flame guttering" },
  { of: /\b(wave|waves|sea|ocean|surf|tide)\b/i, clause: "waves breaking in the background" },
  { of: /\b(rain|downpour|storm)\b/i, clause: "rain falling hard through the shot" },
  { of: /\b(snow|blizzard)\b/i, clause: "snow blowing sideways" },
  { of: /\b(smoke|steam|vapour|vapor)\b/i, clause: "smoke curling upward" },
  { of: /\b(flag|sail|sails|curtain|cloth|banner|cape|scarf)\b/i, clause: "the cloth snapping in the wind" },
  { of: /\b(mist|fog|haze)\b/i, clause: "the mist drifting fast across the frame" },
  { of: /\b(sand|desert|dune)\b/i, clause: "sand blowing across the ground" },
  { of: /\b(leaf|leaves|tree|trees|grass|field|forest)\b/i, clause: "leaves moving in the wind" },
  { of: /\b(river|stream|waterfall|fountain)\b/i, clause: "water running past" },
  { of: /\b(road|street|traffic|car|cars|train|bus)\b/i, clause: "a vehicle passing through the frame" },
  { of: /\b(cloud|clouds|sky)\b/i, clause: "clouds moving across the sky" },
  { of: /\b(dust|motes|particles)\b/i, clause: "dust swirling through the light" },
];
/**
 * Every clause here must itself satisfy stillness(): the repair has to be recognised as a repair, or the rule
 * contradicts itself. test/direction.test.mjs asserts exactly that over the whole table — it is how "clouds moving
 * across the sky" was caught adding a word the detector did not know.
 */
/** When the picture names nothing that can be set moving, this is what a cinematographer adds: it works anywhere. */
const ENLIVEN_FALLBACK = "dust drifting through the light";
/** The table, exposed so a test can prove every clause in it is one the detector accepts. */
export const ENLIVEN_CLAUSES: readonly string[] = [...ENLIVEN.map((e) => e.clause), ENLIVEN_FALLBACK];

export interface Stillness {
  /** True when something in the shot moves on its own, so a generated clip will not come back frozen. */
  alive: boolean;
  /** Why, in one phrase, so a message to the author says something useful. */
  reason: string;
}

export function stillness(imagePrompt: string): Stillness {
  const p = String(imagePrompt || "");
  if (LIVING_SUBJECT.test(p)) return { alive: true, reason: "someone in frame moves on their own" };
  const verb = p.match(MOTION_VERB);
  if (verb) return { alive: true, reason: `something is ${verb[1].toLowerCase()}` };
  return { alive: false, reason: "nothing in it is doing anything" };
}

/** The movement to add to a still picture, chosen from what the picture already shows. Deterministic. */
export function livingClause(imagePrompt: string): string {
  const p = String(imagePrompt || "");
  for (const e of ENLIVEN) if (e.of.test(p)) return e.clause;
  return ENLIVEN_FALLBACK;
}

/**
 * The movement a still picture's CLIP should carry, or null when something in the picture already moves by itself.
 *
 * Until 24 September 2026 this clause was appended to the image_prompt itself (enliven), and when the prompt was near
 * its limit the AUTHOR'S WORDS were cut to make room: the end of a description the user dictated was replaced by
 * "dust drifting through the light", and the still model drew dust instead of what was asked. The movement belongs to
 * the clip, not to the still: the planner writes it into the shot's "action" (src/keou-contract.ts AUTHORING_SHOT_FIELDS)
 * when the author gave none, and the clip prompt reads it from there. The picture is drawn from the author's words only.
 */
export function motionHint(imagePrompt: string): string | null {
  const base = String(imagePrompt || "").trim();
  if (!base || stillness(base).alive) return null;
  return livingClause(base);
}

/**
 * DEPRECATED (24 September 2026): the picture is never rewritten any more — see motionHint(), which returns the clause
 * this used to append so it can travel in the shot's "action" instead. Kept, returning the author's prompt trimmed and
 * otherwise untouched, so a caller that still runs every image_prompt through it changes nothing and cuts nothing.
 */
export function enliven(imagePrompt: string, _max?: number): string {
  return String(imagePrompt || "").trim();
}

/**
 * A cast look too short to draw the same person twice. Job gt_6xchnk99 (20 September 2026): "a young Jedi-like
 * warrior" was the whole look, so the picture model invented a new face for every shot and the viewer saw a warped
 * one. Six words is the floor: "a tall grey-bearded man in a red coat" passes, "the captain" and "a young Jedi-like warrior" do not.
 */
export function thinLook(look: string): boolean {
  // A hyphenated word is one word ("Jedi-like", "grey-bearded"): fewer than six of them is a role, not a look.
  return (look.trim().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []).length < 6;
}

/**
 * Narration that describes the video instead of telling the story. The planning model copies the request's own
 * words about the format into the first line ("In a 30-second vertical YouTube Short, a young warrior receives…",
 * job gt_6xchnk99) and the narrator reads them out. Returns the offending words, or null. English and Italian.
 */
const FORMAT_TALK = /(?<![\p{L}])(?:\d+[- ]?(?:second|seconds|sec|secondi)(?![\p{L}])|\d+ ?s(?![\p{L}])|youtube shorts?|tiktok|vertical|horizontal|verticale|orizzontale|9:16|16:9|animatic|storyboard|voice-?over|narrat(?:or|ion|ore|azione)|in this (?:video|film|short)|in questo (?:video|film))(?![\p{L}])/iu;
/** "Short" as YouTube's noun is capitalised; "the ship shorts out" is the story. */
const SHORT_NOUN = /(?<![\p{L}])Shorts?(?![\p{L}])/u;
export function formatTalk(voice: string): string | null {
  const m = FORMAT_TALK.exec(voice) ?? SHORT_NOUN.exec(voice);
  return m ? m[0] : null;
}

/**
 * The request as the planner's prompts paste it: THE WHOLE REQUEST, whitespace folded, nothing taken out.
 *
 * From 20 to 24 September 2026 this deleted every sentence that contained a format word, because the 17B copied
 * "In a 30-second vertical YouTube Short…" into the narration (job gt_jm5btrj8). It deleted far more than the format:
 * "the narrator says 'festa a sorpresa'", "a 1990s bedroom with a vertical blind", "a woman walking down a vertical
 * street" all lost the sentence that carried them, and the film lost what the user asked for (measured on 18 jobs:
 * 10% of the users' requirements contradicted, a share of them never reaching the planner at all). The narration is
 * protected where the damage happened instead — formatTalk() on every voice line, in the planner and the validator —
 * and the request reaches the model as the user wrote it.
 */
export function storyRequest(prompt: string): string {
  return String(prompt ?? "").trim().replace(/\s+/g, " ");
}

/** The words a must_keep item about the FILM ITSELF is made of, beside the ones formatTalk() finds (all three languages). */
const FORMAT_VOCAB = new Set(
  ("duration durata durée length lunghezza long lungo lunga seconds second secondi secondo secondes sec minutes minute minuti minuto min " +
   "scene scenes scena scène scènes shot shots inquadrature inquadratura circa about around approximately environ format formato " +
   "video film short shorts reel clip youtube tiktok vertical horizontal verticale orizzontale narrated narrato narrata narrator narration " +
   "narrazione narratore narrateur voiceover voice over italian english french italiano inglese francese italien anglais language lingua " +
   "langue animatic storyboard subtitles sottotitoli music musica aspect ratio")
    .split(" "),
);

/**
 * True when a must_keep item is ONLY about the video — its length, format, language, narrator — and says nothing about
 * what is in it: "durata 30 secondi, circa 6 scene" (copied out of the prompt's LENGTH line and read aloud in scene 5
 * of a pastry-chef film, 20 September 2026), "a 30-second vertical Short", "narrated in Italian". An item that names
 * the format AND carries content — "the narrator must say 'festa a sorpresa'" — is content, and stays.
 */
export function formatOnly(item: string): boolean {
  if (!formatTalk(item)) return false;
  const content = words(item).filter((w) => !STOP.has(w) && !/^\d+s?$/.test(w) && !FORMAT_VOCAB.has(w));
  return content.length < 2;
}

/**
 * Whether a must_keep item is a character's LOOK: an appearance word in any of the three languages, or three fifths of
 * its content words inside some cast member's look. A look is proven by the pictures, not by the narration.
 */
export function lookFact(item: string, cast: readonly CastMember[]): boolean {
  if (APPEARANCE.test(item)) return true;
  const content = words(item).filter((w) => !STOP.has(w));
  if (content.length < 2) return false;
  return cast.some((m) => { const look = new Set(words(m.look).filter((w) => !STOP.has(w))); return content.filter((w) => look.has(w)).length / content.length >= 0.6; });
}

/**
 * The must_keep items the NARRATOR is held to: every item but the looks. "capelli biondi corti e raccolti, grembiule
 * lilla" was copied into must_keep, the fidelity gate forced the narrator to read it aloud, and the film opened on
 * "Capelli biondi raccolti, grembiule lilla, la pasticcera prepara…" (film-make, 20 September 2026). The look stays in
 * must_keep — it is something the user asked for, and the pictures are checked for it — but missingFacts() is run on
 * this list, so the viewer never hears a description read out.
 */
export function spokenFacts(mustKeep: readonly string[] | undefined, cast: readonly CastMember[] | undefined): string[] {
  const facts: readonly string[] = Array.isArray(mustKeep) ? mustKeep.filter((x): x is string => typeof x === "string") : [];
  return facts.filter((f) => !lookFact(f, Array.isArray(cast) ? cast : []));
}

/**
 * must_keep as the direction keeps it: EVERYTHING the user asked for, except an item that is only about the video's
 * own format (formatOnly). Until 24 September 2026 this also dropped every item that described an appearance, in any
 * language — so the user's "lilac apron" vanished from the one list the finished film was checked against, and nothing
 * noticed when the picture showed a red one. The appearance stays now; the narration is held to spokenFacts() only.
 * The name is kept because the planner calls it where the direction is repaired.
 */
export function dropLookFacts(mustKeep: readonly string[], _cast?: readonly CastMember[]): string[] {
  return mustKeep.filter((item) => typeof item === "string" && !formatOnly(item));
}
/** Words that describe how someone looks, in the three narration languages: hair, clothes, build, colours on a person. */
const APPEARANCE = /(?<![\p{L}])(?:hair|haired|blonde?|brunette|curly|beard(?:ed)?|moustache|apron|jacket|coat|dress|robe|cloak|hooded|boots|hat|cap|glasses|freckles|scar(?:red)?|slim|slender|thin|tall|short|stocky|athletic|build|capelli|biond[oaie]|castan[oaie]|ricci[oaie]?|barba|baffi|grembiule|giacca|cappotto|vestit[oaie]|mantell[oi]|stivali|cappell[oi]|occhiali|lentiggini|cicatric[ei]|magr[oaie]|snell[oaie]|alt[oaie]|bass[oaie]|robust[oaie]|cheveux|blond[es]?|barbe|tablier|veste|manteau|robe|capuche|bottes|chapeau|lunettes|mince|grand[es]?)(?![\p{L}])/iu;

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
export function castFor(
  castOrDirection: readonly CastMember[] | Pick<Direction, "cast"> | null | undefined,
  imagePrompt: string,
  shotCast?: readonly string[] | null,
  specCast?: readonly CastRef[] | null,
): CastMember[] {
  const cast: readonly CastMember[] = Array.isArray(castOrDirection) ? castOrDirection : ((castOrDirection as Pick<Direction, "cast"> | null | undefined)?.cast ?? []);
  // THE SHOT SAYS WHO IS IN IT (24 September 2026). Every rule below guesses the cast from the words of the prompt,
  // and a guess is wrong exactly when it matters most: two women in one scene, a pronoun in a two-character film, a
  // name the prompt paraphrased. The planner now writes "cast" on every shot (the ids or names of the characters in
  // the picture); when it did, that list decides, and the guessing is only the fallback for shots written before it.
  const explicit = explicitCast(cast, shotCast, specCast);
  if (explicit.length) return explicit;
  const p = imagePrompt.toLowerCase();
  // The head noun stands for a character only when no other character shares it: "the warrior" and "the dark
  // warrior" both end in "warrior", and matching on it dressed the hero as the villain in every shot of job
  // gt_jm5btrj8 (20 September 2026). With a shared head noun only the whole name counts.
  const heads = cast.map((m) => headNoun(m.name));
  const unique = (i: number) => heads[i] !== "" && heads.filter((h) => h === heads[i]).length === 1;
  const named = cast.filter((m, i) => m.name.trim() && (p.includes(m.name.trim().toLowerCase()) || (unique(i) && headNounIn(m.name, imagePrompt))));
  if (named.length || cast.length !== 1) return named;
  // A film with ONE recurring character: a picture that says "she", "her", "he" or "the character" shows that
  // character, whatever the planner called her in that sentence. Measured on job gt_7f7aaac6 (19 September 2026):
  // "She holds a spoon and mixes a bowl of batter" carried no look and came back as a brunette in a red apron,
  // between eight pictures of the blonde pastry chef in lilac the direction described.
  return PRONOUN_HINTS.test(imagePrompt) ? [cast[0]] : [];
}
/** A cast name as two spellings of it share: case, accents, a leading article and extra spaces folded away. */
const castKey = (s: string): string =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/^(?:(?:the|a|an|il|lo|la|le|un|una|uno)\s+|l['’])/, "").replace(/\s+/g, " ");

/**
 * The direction's cast members a shot's explicit `cast` names, in the shot's order: by the member's spec id ("c1"), by
 * name (case, accents and a leading article ignored), or by a spec cast id whose spec name is the member's name.
 * Entries that name nobody are ignored; an empty answer sends castFor() back to reading the prompt.
 */
function explicitCast(cast: readonly CastMember[], shotCast: readonly string[] | null | undefined, specCast: readonly CastRef[] | null | undefined): CastMember[] {
  const out: CastMember[] = [];
  if (!Array.isArray(shotCast) || !shotCast.length) return out;
  for (const raw of shotCast) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key) continue;
    const viaSpec = (specCast ?? []).find((c) => c && c.id === key);
    const hit = cast.find((m) => (typeof m.id === "string" && m.id === key) || castKey(m.name) === castKey(key) || (!!viaSpec && castKey(m.name) === castKey(viaSpec.name)));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** The pronouns and generic words that can only mean the film's one character. Mirrored in worker/kleo_pictures.py. */
export const PRONOUN_HINTS = /(?<![\p{L}])(?:she|her|hers|herself|he|him|his|himself|the character|the protagonist)(?![\p{L}])/iu;
/**
 * The head noun of a cast name — "chef" of "the pastry chef", "captain" of "the captain" — as a whole word of the
 * prompt: a planner that writes "the chef decorates a cake" means the pastry chef of the cast. Four letters or more,
 * so "the man" does not fire on "manuscript" and a two-letter tail matches nothing.
 */
export const headNoun = (name: string): string => name.trim().toLowerCase().split(/\s+/).pop() ?? "";
export function headNounIn(name: string, imagePrompt: string): boolean {
  const head = headNoun(name);
  if (head.length < 4) return false;
  return new RegExp(`(?<![\\p{L}])${escapeRe(head)}(?![\\p{L}])`, "iu").test(imagePrompt);
}

/**
 * The direction as the extra sentences appended to one shot's image prompt: the world it is set in, the verbatim
 * description of whichever characters it shows, and the light of the section it belongs to.
 *
 * Order matters for a diffusion model — what comes first weighs most — so the author's own sentence stays in front and
 * everything here follows it.
 */
export function pictureContext(
  d: Direction | null,
  imagePrompt: string,
  accent: string | null,
  look: string | null = null,
  shotCast?: readonly string[] | null,
  specCast?: readonly CastRef[] | null,
): string {
  if (!d) return "";
  const bits: string[] = [];
  for (const m of castFor(d.cast ?? [], imagePrompt, shotCast, specCast)) bits.push(`${m.name}: ${m.look}`);
  if (d.world) bits.push(d.world);
  const light = accent && lightsPictures(look) ? ACCENT_LIGHT[accent] : null;
  if (light) bits.push(light);
  return bits.join(". ");
}

/**
 * Whether the section's accent is written into the picture prompt as a light source: NO LOOK any more. On the turbo
 * SDXL model of the animation look "a single warm red light source" was a colour cast (job gt_ad2musq5, 19 September
 * 2026: a red kitchen, a red apron, a red sauce for a pastel story), so the animation lost it on 20 September. On 22
 * September the REALISTIC look, drawn by RealVisXL V5 since the 20th (an SDXL model too), did the same on the first
 * animatic with music (gt_hxed87em): red graphite dust on the paper in the "red" section, a glowing green pencil line
 * and a green lamp in the "green" one — the treatment's own palette (slate blue, brass, cream) overruled by the
 * colour law of the layer. The accent stays where it was born, on the layer (hud.js); the pictures follow the
 * treatment's visual language and nothing else. Kept as a function so both sides keep one switch (and one test).
 * Mirrored in worker/kleo_pictures.py lights_pictures().
 */
export const lightsPictures = (_look: string | null | undefined): boolean => false;

/**
 * Function words of the languages a film can be narrated in other than English. A picture prompt, a cast look or a
 * world sentence written in one of them reaches a text encoder trained on English (CLIP, for every model the GPU
 * draws with) and is read as noise: "capelli biondi corti e raccolti, grembiule lilla" came back as brown curls and a
 * red apron (job gt_ad2musq5). Two hits in one sentence is already a sentence in that language; one can be a name.
 */
const FOREIGN_WORDS = new RegExp(
  "(?<![\\p{L}])(?:" +
  // Italian
  "una|uno|un|della|delle|degli|dei|del|nella|nel|nelle|negli|nei|sulla|sul|sulle|sugli|sui|dalla|dalle|dagli|dai|dal|alla|alle|agli|ai|al|" +
  "che|gli|il|lo|la|le|di|con|col|coi|e|ed|i|da|su|tra|fra|ne|si|ma|più|senza|verso|contro|quando|poi|ancora|sempre|mentre|dove|sono|" +
  "tutti|tutte|tutto|tutta|suo|sua|suoi|sue|loro|questo|questa|questi|queste|quella|quelli|quelle|ogni|molto|molti|molte|" +
  "grande|grandi|piccolo|piccola|piccoli|piccole|sotto|sopra|dentro|accanto|vicino|davanti|dietro|" +
  // French
  "dans|avec|une|des|les|sur|pour|qui|est|et|au|aux|du|chez|sous|devant|derrière|à|où|ou|pas|très|tout|toute|tous|toutes|ses|leur|leurs|cette|ce|ces|vers|entre|pendant|avant|après|puis|encore" +
  ")(?![\\p{L}])", "giu");
/** True when `text` reads as Italian or French rather than English: at least `min` of its words are function words of those languages. */
export function notEnglish(text: unknown, min = 2): boolean {
  const hits = [...String(text ?? "").matchAll(FOREIGN_WORDS)].length;
  return hits >= min;
}
/** The cast names, looks, world, objects and forbidden terms of a direction that are not written in English. */
export function foreignPictureFields(d: Partial<Direction> | null | undefined): string[] {
  if (!d) return [];
  const out: string[] = [];
  if (notEnglish(d.world)) out.push("world");
  (d.cast ?? []).forEach((m, i) => { if (notEnglish(`${m?.name ?? ""} ${m?.look ?? ""}`)) out.push(`cast[${i}]`); });
  if (notEnglish((d.objects ?? []).join(" "), 3)) out.push("objects");
  if (notEnglish((d.forbidden ?? []).join(" "), 3)) out.push("forbidden");
  return out;
}

/** The negative prompt for this video: the product-wide one, plus everything this film's direction forbids. */
export function negativeFor(d: Direction | null, base: string): string {
  const extra = (d?.forbidden ?? []).map((s) => s.trim()).filter(Boolean);
  // What the cast looks and the world say in the NEGATIVE ("no visible face", "never a full face", "without a
  // logo") is not a description the picture model can draw from: measured on gt_hxed87em (22 September 2026), a cast
  // look of "no visible face" and a decision "only a hand and a forearm are ever seen" still drew a man's face in
  // the sixth picture. The negated clause belongs on the negative side, where the model reads a "no".
  for (const t of negatedTerms([...(d?.cast ?? []).map((m) => m.look), d?.world ?? ""].join(". "))) if (!extra.some((e) => e.toLowerCase() === t.toLowerCase())) extra.push(t);
  return extra.length ? `${base}, ${extra.join(", ")}` : base;
}

/**
 * The clauses a sentence NEGATES ("no visible face", "never a logo", "without other people"): the words after the
 * negation up to the next punctuation, at most 40 characters, plus "face, portrait" whenever a face is what is
 * denied — the two words a diffusion model actually reads as "do not draw a face". Mirrored in
 * worker/kleo_pictures.py negated_terms().
 */
export function negatedTerms(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:no|never|without|not)\s+(?:a |an |the |any )?([^,.;:()]{3,40}?)(?=[,.;:()]|\s+(?:and|but|or|is|are|ever|shown|seen|visible)\b|$)/gi;
  for (const m of text.matchAll(re)) {
    const t = m[1].trim().replace(/\s+/g, " ");
    if (!t || /^(?:one|longer|more|less|matter|way)\b/i.test(t)) continue;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (/\bfaces?\b/i.test(t)) for (const f of ["face", "portrait"]) if (!out.includes(f)) out.push(f);
  }
  return out;
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
