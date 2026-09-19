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
/** The pictures that ask for a diagram, a screen with text or a quoted caption, with the words that gave them away. */
export function screenTextProblems(prompts: readonly { id: string; image_prompt: string }[]): { id: string; term: string }[] {
  const out: { id: string; term: string }[] = [];
  for (const p of prompts) { const term = screenTextIn(p.image_prompt); if (term) out.push({ id: p.id, term }); }
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
 * rewrite and costs a whole round trip, a repair costs nothing. The clause it adds is built from what the picture
 * already names, so the subject of the shot never changes — only its stillness does.
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
 * The picture, with something in it moving. Returns the prompt unchanged when it is already alive, and never grows
 * past `max` — a clause that would not fit takes the room from the end of the description instead of being dropped,
 * because a picture that is one adjective shorter is worth far more than one that comes back frozen.
 */
export function enliven(imagePrompt: string, max: number): string {
  const base = String(imagePrompt || "").trim();
  if (!base || stillness(base).alive) return base;
  const clause = livingClause(base);
  const tail = `, ${clause}`;
  if (base.length + tail.length <= max) return base + tail;
  const room = max - tail.length;
  if (room < 20) return base;                      // too tight to say both: leave the author's words alone
  const cut = base.slice(0, room);
  return (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[,\s]+$/, "") + tail;
}

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
export function pictureContext(d: Direction | null, imagePrompt: string, accent: string | null, look: string | null = null): string {
  if (!d) return "";
  const bits: string[] = [];
  for (const m of castFor(d.cast ?? [], imagePrompt)) bits.push(`${m.name}: ${m.look}`);
  if (d.world) bits.push(d.world);
  const light = accent && lightsPictures(look) ? ACCENT_LIGHT[accent] : null;
  if (light) bits.push(light);
  return bits.join(". ");
}

/**
 * Whether the section's accent is written into the picture prompt as a light source. Not for the ANIMATION look: on
 * the turbo SDXL model that draws it (8 steps, guidance 2) "a single warm red light source" is not a light, it is a
 * colour cast — the first frame of a pastel story about a pastry chef came back as a red kitchen, a red apron and a
 * red sauce (job gt_ad2musq5, 19 September 2026), and the apron the user had asked for was lilac. A drawn film keeps
 * its colour law on the layer, where the accent was born; the photographic looks keep the light.
 * Mirrored in worker/kleo_pictures.py lights_pictures().
 */
export const lightsPictures = (look: string | null | undefined): boolean => look !== "animation";

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
