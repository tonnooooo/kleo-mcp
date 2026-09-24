/**
 * THE SPEC: what the user asked for, taken apart into requirements a machine can check (24 September 2026).
 *
 * Until this module existed, the user's request travelled through Kleo as one string. Every stage re-read it and
 * re-interpreted it: the treatment replaced it with an "angle" and a narrative device drawn at random, the direction
 * re-extracted eight "facts" from it and dropped every one that mentioned an appearance, the planner deleted its
 * sentences that contained a format word, and the only check at the end was whether 60% of the words of those eight
 * facts turned up anywhere in the narration. Measured on 18 production jobs (9-22 September): of 176 concrete things
 * users asked for, 70% survived, 10% were CONTRADICTED on screen, and 22 inventions changed the films. The owner's
 * verdict: "it does not follow the images, it does not follow anything".
 *
 * The spec is the fix at the root. One step, before any creative decision, turns the request into typed, atomic
 * items — a character, how they look, the place, an object, what happens and in which order, a shot the user
 * described, the style, a text that must be read on screen, a line the narrator must say, what must not appear —
 * each with an id, the user's own words (`quote`) and whether it is a must. Every later stage is written UNDER it and
 * checked AGAINST it: the treatment, the direction, the outline (which scene covers which item), every shot (the
 * items it shows, the cast it contains), every drawn picture (a vision model answers one question per item) and the
 * report the user gets with the video.
 *
 * Two modes. FAITHFUL (the default for anything the user actually described): the film is the user's film — their
 * characters, their events in their order, their place, their style; Kleo adds only what they left open, and says
 * what it added. OPEN (a bare subject, "surprise me"): the producer's creative method applies as before, still
 * without contradicting a single item.
 *
 * Nothing here calls a model: the words, the shape, the repair and the checks, so a test can hold them still. The
 * server call that writes a spec lives in src/storyboard.ts (writeSpec); the assistant writes one under
 * specMethodText() through kleo_adapt_prompt.
 */

/* ------------------------------------------------------------------ the shape */

/**
 * The kinds of requirement. Each one is checked where it can be seen or heard:
 * - character: someone who is in the film (a person, an animal, a creature), by name or role.
 * - look:      one visible attribute of a cast member (hair, clothes, age, build, colours) — `who` names the cast id.
 * - place:     where it happens (a setting the camera sees).
 * - object:    a thing that must be seen.
 * - action:    something a character does on screen — `who` names the cast id when there is one.
 * - event:     a beat of the story; events carry `order` (1, 2, 3…) and the film keeps that order.
 * - shot:      a framing or composition the user described ("a close-up of her hands", "seen from above").
 * - style:     the visual style or a reference the user named ("like a Pixar film", "black and white", "neon night").
 * - text:      words that must be READ on screen (a sign, a title, a note) — `text` holds the exact words.
 * - line:      words the narrator must SAY — `quote` holds them as the user wrote them.
 * - mood:      a tone or feeling the user asked for.
 * - exclude:   something that must NOT appear or be said.
 */
export const SPEC_KINDS = ["character", "look", "place", "object", "action", "event", "shot", "style", "text", "line", "mood", "exclude"] as const;
export type SpecKind = (typeof SPEC_KINDS)[number];
/** Kinds a picture can prove or disprove: the ones a vision model is asked about. */
export const VISUAL_KINDS: readonly SpecKind[] = ["character", "look", "place", "object", "action", "event", "shot", "style", "text", "exclude"];
/** Kinds the narration proves. */
export const SPOKEN_KINDS: readonly SpecKind[] = ["line"];
/** Kinds a SHOT must claim (in `covers`) to be counted: everything visual except the film-wide style and the exclusions. */
export const SHOT_KINDS_TO_COVER: readonly SpecKind[] = ["character", "look", "place", "object", "action", "event", "shot", "text"];

export interface SpecItem {
  /** "R1", "R2"… unique within the spec. */
  id: string;
  kind: SpecKind;
  /** The requirement in plain ENGLISH, self-contained and checkable ("the pastry chef wears a lilac apron"). For kind "text" the exact on-screen words go in quotes inside it. */
  text: string;
  /** The user's own words this item comes from, verbatim, in their language. The proof it was not invented. */
  quote: string;
  /** true when the user said it (or it is essential to what they said); false for a nice-to-have they only hinted. */
  must: boolean;
  /** The cast id (from `cast`) this item is about: required for look, usual for action. */
  who?: string | null;
  /** For events: 1, 2, 3… in the order the user told them. */
  order?: number | null;
}

export interface SpecCast {
  /** "c1", "c2"… unique within the spec. */
  id: string;
  /** How the film calls them: a name the user gave ("Mara") or a role ("the pastry chef"). */
  name: string;
  /** EVERYTHING the user said about how they look, in English, as one description a painter could draw from — plus
   *  what a reference image shows, when the user gave one. Never shortened to a role. */
  look: string;
  /** The reference (from `refs`) that shows this character, when the user gave one. */
  ref?: string | null;
}

export const REF_ROLES = ["character", "object", "place", "style"] as const;
export type RefRole = (typeof REF_ROLES)[number];

export interface SpecRef {
  /** "ref1", "ref2"… unique within the spec. */
  id: string;
  /** Kleo's handle for the stored image ("kref_ab12cd34"), as src/refs.ts returns it. */
  handle: string;
  role: RefRole;
  /** The cast id or the item id it illustrates. */
  for?: string | null;
  /** What the image shows, in English, written by Kleo's vision model when the image was received. */
  description?: string | null;
}

export type SpecMode = "faithful" | "open";
/** How the narration relates to the user's words: free = Kleo writes it; lines = some lines are the user's; verbatim = the user wrote the whole narration. */
export type NarrationMode = "free" | "lines" | "verbatim";

export interface RequestSpec {
  v: 1;
  mode: SpecMode;
  /** One English sentence: the film the user asked for, as they asked for it. */
  summary: string;
  items: SpecItem[];
  cast: SpecCast[];
  refs: SpecRef[];
  /** What the user left to Kleo, in English ("the ending", "the setting", "who the characters are"). Kleo may decide these, and says so. */
  open: string[];
  narration: NarrationMode;
  /** The narration the user wrote, word for word, when narration is "verbatim"; null otherwise. */
  script: string | null;
}

/** Limits, printed in the method and enforced by the repair. */
export const S = {
  items: 40,
  text: 220,
  quote: 240,
  cast: 6,
  name: 40,
  look: 420,
  refs: 8,
  open: 8,
  openLen: 100,
  summary: 300,
  script: 3000,
} as const;

/* ------------------------------------------------------------------ helpers */

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const inSet = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === "string" && (set as readonly string[]).includes(v);

/** Letters and digits only, lower case, accents folded: the form two spellings of the same words share. */
export function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
const wordsOf = (s: string): string[] => norm(s).split(" ").filter(Boolean);

/**
 * Whether `quote` is really in `request`: the whole quote verbatim (after folding case, accents and punctuation), or
 * — for a quote the writer shortened or stitched — at least 70% of its words of three letters or more present in the
 * request. It is the one guard against a spec that invents what the user never said: an item whose quote is not in
 * the request is an invention wearing the user's name.
 */
export function quoteInRequest(quote: string, request: string): boolean {
  const q = norm(quote), r = norm(request);
  if (!q) return false;
  if (r.includes(q)) return true;
  const qw = q.split(" ").filter((w) => w.length >= 3);
  if (!qw.length) return r.split(" ").includes(q);
  const rw = new Set(r.split(" "));
  // A five-letter prefix stands for the word, so "apron"/"aprons" and "grembiule"/"grembiuli" are the same.
  const stems = new Set([...rw].map((w) => w.slice(0, 5)));
  const hit = qw.filter((w) => rw.has(w) || stems.has(w.slice(0, 5))).length;
  return hit / qw.length >= 0.7;
}

/** The phrases by which a user hands the subject to Kleo: a delegation is an OPEN spec by definition. */
const DELEGATE_RE = /\b(stupiscimi|sorprendimi|scegli tu|decidi tu|fai tu|inventa tu|a tua scelta|come vuoi tu|surprise me|you (?:choose|pick|decide)|your (?:choice|call|pick)|anything you (?:like|want)|whatever you (?:like|want|think))\b/i;

/**
 * The kinds that are the user's own story rather than a bare topic: someone in it, something that happens, a shot they
 * described, words to be read or said. A writer's "faithful" standing on one of these is kept (modeFor).
 */
const STORY_KINDS: readonly SpecKind[] = ["character", "event", "shot", "text", "line"];

/**
 * FAITHFUL or OPEN, decided by what the spec actually contains: a request with a character plus anything about them,
 * or two events, or a described shot, or a place and an action, is a film the user already has in mind — FAITHFUL. A
 * delegation is OPEN whatever anybody claims, and so is a bare subject with at most two must items…
 *
 * …UNLESS THE WRITER CALLED IT FAITHFUL AND IT STANDS ON THE USER'S STORY (24 September 2026). The spec method (rule
 * 9 below, and kleo_adapt_prompt's next step) tells the writer "faithful when the user described what happens or who
 * is in it", and the same writer is told to write its treatment "as-told" under a faithful spec. This function used to
 * ignore the claim, so "un film su mio nonno Pietro" (one character item, nothing about him) was re-decided OPEN after
 * the assistant had written a faithful spec and an as-told treatment, and kleo_create_video refused the treatment it
 * had been told to write. The writer read the request and Kleo did not; a writer's "faithful" is kept whenever it has
 * at least one must item that is the user's own story (STORY_KINDS). An "open" claim is still overruled upwards by the
 * contents: a film the user described is theirs whatever the writer thought.
 */
export function modeFor(items: readonly SpecItem[], request: string, claimed?: unknown): SpecMode {
  if (DELEGATE_RE.test(request)) return "open";
  const must = items.filter((i) => i.must);
  const count = (k: SpecKind) => must.filter((i) => i.kind === k).length;
  if (count("event") >= 2 || count("shot") >= 1 || count("line") >= 1 || count("text") >= 1) return "faithful";
  if (count("character") >= 1 && (count("look") + count("action") + count("place") + count("event")) >= 1) return "faithful";
  if (count("place") >= 1 && count("action") + count("event") >= 1) return "faithful";
  if (must.length >= 4) return "faithful";
  if (claimed === "faithful" && must.some((i) => STORY_KINDS.includes(i.kind))) return "faithful";
  return "open";
}

/* ------------------------------------------------------------------ repair and check */

/**
 * The reasons a spec is refused, in words the writer can act on. Empty means it is a spec. `request` is the user's
 * text the quotes must come from; references are checked against the handles Kleo actually holds when `handles` is
 * given.
 */
export function specProblems(raw: unknown, request: string, opts: { handles?: readonly string[] } = {}): string[] {
  const out: string[] = [];
  if (!isObj(raw)) return ["the spec must be a JSON object"];
  const items = Array.isArray(raw.items) ? raw.items : null;
  if (!items) return ["spec.items: missing — the list of what the user asked for"];
  if (!items.length) out.push("spec.items: empty — every request asks for at least its subject");
  if (items.length > S.items) out.push(`spec.items: ${items.length}, the limit is ${S.items} — merge the smallest details into the item they belong to`);
  const cast = Array.isArray(raw.cast) ? raw.cast.filter(isObj) : [];
  if (cast.length > S.cast) out.push(`spec.cast: ${cast.length} characters, the limit is ${S.cast}`);
  const castIds = new Set(cast.map((c) => String(c.id ?? "")));
  cast.forEach((c, i) => {
    if (typeof c.id !== "string" || !c.id.trim()) out.push(`spec.cast[${i}]: needs an id ("c1")`);
    if (typeof c.name !== "string" || !c.name.trim()) out.push(`spec.cast[${i}]: needs a name (the user's name for them, or their role)`);
    if (typeof c.look !== "string" || c.look.trim().split(/\s+/).length < 3) out.push(`spec.cast[${i}] "${String(c.name ?? "")}": "look" must describe how they look in English (at least a few words: what the user said, or what a painter would need) — never just the role`);
  });
  const refs = Array.isArray(raw.refs) ? raw.refs.filter(isObj) : [];
  if (refs.length > S.refs) out.push(`spec.refs: ${refs.length} images, the limit is ${S.refs}`);
  for (const r of refs) {
    if (!inSet(r.role, REF_ROLES)) out.push(`spec.refs ${String(r.id ?? "?")}: role must be one of ${REF_ROLES.join(", ")}`);
    if (opts.handles && !opts.handles.includes(String(r.handle ?? ""))) out.push(`spec.refs ${String(r.id ?? "?")}: "${String(r.handle ?? "")}" is not an image Kleo received — pass the handle kleo_adapt_prompt or the upload page returned`);
  }
  const ids = new Set<string>();
  items.forEach((it, i) => {
    if (!isObj(it)) { out.push(`spec.items[${i}]: must be an object`); return; }
    const id = String(it.id ?? "");
    if (!id) out.push(`spec.items[${i}]: needs an id ("R${i + 1}")`);
    else if (ids.has(id)) out.push(`spec.items: id "${id}" is used twice`);
    ids.add(id);
    if (!inSet(it.kind, SPEC_KINDS)) out.push(`spec item ${id || i + 1}: kind "${String(it.kind)}" is not one of ${SPEC_KINDS.join(", ")}`);
    if (typeof it.text !== "string" || it.text.trim().length < 3) out.push(`spec item ${id || i + 1}: needs "text", the requirement in plain English`);
    if (typeof it.quote !== "string" || !it.quote.trim()) out.push(`spec item ${id || i + 1}: needs "quote", the user's own words it comes from`);
    // What the user wrote is the prompt, their intake answers AND their corrections after the read-back (24 September
    // 2026): the refusal used to say "put it under open", which turned a user's own correction ("add my dog Pepe") into
    // one of Kleo's decisions, never checked again.
    else if (!quoteInRequest(it.quote, request)) out.push(`spec item ${id || i + 1}: the quote "${clip(it.quote, 80)}" is not in the user's request — an item must come from what the user wrote: the prompt, their answers (must_keep, audience, tone), or the corrections they gave after the read-back, passed word for word as "corrections". What Kleo decides on its own goes under "open", never in the items`);
    if (it.kind === "look" && !castIds.has(String(it.who ?? ""))) out.push(`spec item ${id || i + 1}: a "look" item names the cast member it describes in "who" (one of ${[...castIds].join(", ") || "the cast ids"})`);
    if (it.who !== undefined && it.who !== null && it.who !== "" && !castIds.has(String(it.who))) out.push(`spec item ${id || i + 1}: "who" is "${String(it.who)}", which is not a cast id`);
  });
  const events = items.filter((it) => isObj(it) && it.kind === "event");
  if (events.length >= 2 && events.some((e) => !(typeof (e as Record<string, unknown>).order === "number")))
    out.push("spec: every \"event\" item carries its \"order\" (1, 2, 3… as the user told them)");
  if (raw.narration === "verbatim" && (typeof raw.script !== "string" || raw.script.trim().split(/\s+/).length < 5))
    out.push("spec: narration \"verbatim\" needs the user's narration in \"script\", word for word");
  return out;
}

/**
 * The writer's answer fitted to the limits, or null when it is not a spec (specProblems says why). Items whose quote is
 * not in the request are dropped rather than refused when `lenient` (the second attempt of the server's writer: a spec
 * with one invented item removed is still the user's spec). The mode is re-decided from the items and the writer's
 * claim (modeFor).
 */
export function repairSpec(raw: unknown, request: string, opts: { lenient?: boolean; handles?: readonly string[] } = {}): RequestSpec | null {
  if (!isObj(raw)) return null;
  const problems = specProblems(raw, request, opts);
  const hard = opts.lenient ? problems.filter((p) => !/is not in the user's request/.test(p)) : problems;
  if (hard.length) return null;
  const cast: SpecCast[] = (Array.isArray(raw.cast) ? raw.cast.filter(isObj) : []).slice(0, S.cast).map((c, i) => ({
    id: clip(c.id, 12) || `c${i + 1}`, name: clip(c.name, S.name), look: clip(c.look, S.look), ref: clip(c.ref, 24) || null,
  }));
  const castIds = new Set(cast.map((c) => c.id));
  const items: SpecItem[] = (raw.items as unknown[]).filter(isObj)
    .filter((it) => inSet(it.kind, SPEC_KINDS) && typeof it.text === "string" && typeof it.quote === "string" && quoteInRequest(it.quote, request))
    .slice(0, S.items)
    .map((it, i) => ({
      id: clip(it.id, 12) || `R${i + 1}`,
      kind: it.kind as SpecKind,
      text: clip(it.text, S.text),
      quote: clip(it.quote, S.quote),
      must: it.must !== false,
      who: castIds.has(String(it.who ?? "")) ? String(it.who) : null,
      order: it.kind === "event" && typeof it.order === "number" && it.order > 0 ? Math.round(it.order) : null,
    }));
  if (!items.length) return null;
  const refs: SpecRef[] = (Array.isArray(raw.refs) ? raw.refs.filter(isObj) : []).slice(0, S.refs)
    .filter((r) => inSet(r.role, REF_ROLES) && typeof r.handle === "string" && r.handle.trim() && (!opts.handles || opts.handles.includes(r.handle)))
    .map((r, i) => ({ id: clip(r.id, 12) || `ref${i + 1}`, handle: clip(r.handle, 40), role: r.role as RefRole, for: clip(r.for, 12) || null, description: clip(r.description, 600) || null }));
  const narration: NarrationMode = inSet(raw.narration, ["free", "lines", "verbatim"] as const) ? (raw.narration as NarrationMode) : items.some((i) => i.kind === "line") ? "lines" : "free";
  const script = narration === "verbatim" ? clip(raw.script, S.script) || null : null;
  return {
    v: 1,
    mode: modeFor(items, request, raw.mode),
    summary: clip(raw.summary, S.summary) || items[0].text,
    items, cast, refs,
    open: (Array.isArray(raw.open) ? raw.open : []).map((o) => clip(o, S.openLen)).filter(Boolean).slice(0, S.open),
    narration: script ? "verbatim" : narration === "verbatim" ? "lines" : narration,
    script,
  };
}

/** A spec read back from a job's params: the shape is trusted only after this. The quotes were checked when it was stored. */
export function specOf(x: unknown): RequestSpec | null {
  if (!isObj(x) || !isObj(x.spec)) return null;
  const s = x.spec;
  if (s.v !== 1 || !Array.isArray(s.items) || !s.items.length) return null;
  return s as unknown as RequestSpec;
}

/* ------------------------------------------------------------------ reading a spec */

export const mustItems = (spec: RequestSpec): SpecItem[] => spec.items.filter((i) => i.must);
/** The items a picture must show somewhere in the film (claimed by shots through `covers`). */
export const shotItems = (spec: RequestSpec): SpecItem[] => spec.items.filter((i) => (SHOT_KINDS_TO_COVER as readonly string[]).includes(i.kind));
export const eventsInOrder = (spec: RequestSpec): SpecItem[] => spec.items.filter((i) => i.kind === "event" && i.order).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
export const itemById = (spec: RequestSpec, id: string): SpecItem | undefined => spec.items.find((i) => i.id === id);
export const castById = (spec: RequestSpec, id: string): SpecCast | undefined => spec.cast.find((c) => c.id === id || norm(c.name) === norm(id));

/**
 * The look of a cast member with every "look" item about them folded in: the description the picture model receives.
 * The spec's cast.look is the writer's sentence; the look items are the user's individual attributes, and a writer
 * that forgot one in the sentence must not make the painter forget it too.
 */
export function fullLook(spec: RequestSpec, castId: string): string {
  const c = castById(spec, castId);
  if (!c) return "";
  const base = c.look.replace(/[.\s]+$/, "");
  const lower = norm(base);
  const extra = spec.items.filter((i) => i.kind === "look" && i.who === c.id).map((i) => i.text.replace(/[.\s]+$/, "")).filter((t) => {
    const w = wordsOf(t).filter((x) => x.length >= 4);
    return w.length && w.filter((x) => lower.includes(x)).length / w.length < 0.6;
  });
  return [base, ...extra].join("; ");
}

/* ------------------------------------------------------------------ what the other stages read */

const KIND_LABEL: Record<SpecKind, string> = {
  character: "who", look: "looks", place: "where", object: "must be seen", action: "does", event: "happens", shot: "shot",
  style: "style", text: "on screen reads", line: "narrator says", mood: "mood", exclude: "NEVER",
};

/**
 * The spec as every planning stage reads it. It is printed ABOVE everything the producer or the planner decides,
 * because it is the brief: the items are the film, the rest is how it is told.
 */
export function specBlock(spec: RequestSpec): string {
  const cast = spec.cast.length
    ? `CAST (draw each exactly like this, in every shot they are in; refer to them by these names):\n${spec.cast.map((c) => `  ${c.id} ${c.name}: ${fullLook(spec, c.id)}${c.ref ? ` [reference image ${c.ref}]` : ""}`).join("\n")}\n`
    : "";
  const items = spec.items.map((i) => `  ${i.id} [${i.kind}${i.kind === "event" && i.order ? ` #${i.order}` : ""}${i.must ? ", MUST" : ""}] ${KIND_LABEL[i.kind]}: ${i.text}${i.who ? ` (${i.who})` : ""} — user: "${i.quote}"`).join("\n");
  const events = eventsInOrder(spec);
  const order = events.length >= 2 ? `\nORDER: the events happen in this order: ${events.map((e) => e.id).join(" → ")}. Never reorder them.` : "";
  const open = spec.open.length ? `\nLEFT TO KLEO (decide these, and list each decision): ${spec.open.join("; ")}.` : "\nLEFT TO KLEO: only how it is told — nothing about WHAT happens.";
  const script = spec.narration === "verbatim" && spec.script ? `\nTHE NARRATION IS THE USER'S, WORD FOR WORD — split it across the scenes, never rewrite it:\n"""${spec.script}"""` : "";
  const refs = spec.refs.length ? `\nREFERENCE IMAGES the user gave (Kleo draws from them): ${spec.refs.map((r) => `${r.id} (${r.role}${r.for ? ` of ${r.for}` : ""}): ${r.description ?? "an image"}`).join("; ")}.` : "";
  const mode = spec.mode === "faithful"
    ? "FAITHFUL: this is the user's film. Every MUST item is seen or heard, the characters look exactly as written, the events happen in the user's order, nothing contradicts an item, and nothing the user did not ask for replaces what they did."
    : "OPEN: the user gave a subject and left the film to Kleo. Every MUST item still appears and nothing contradicts one.";
  return `THE USER'S REQUEST, AS REQUIREMENTS (the brief — ${mode})
Summary: ${spec.summary}
${cast}REQUIREMENTS:
${items}${order}${refs}${open}${script}`;
}

/** The items owed by a stretch of the film, as the scene-writing prompt prints them. */
export function owedBlock(spec: RequestSpec, ids: readonly string[]): string {
  const got = ids.map((id) => itemById(spec, id)).filter((x): x is SpecItem => !!x);
  if (!got.length) return "";
  return `THESE SCENES MUST SHOW OR SAY (list each shot's item ids in its "covers"; a "line" is said in the voice):\n${got.map((i) => `  ${i.id} [${i.kind}] ${i.text}`).join("\n")}`;
}

/* ------------------------------------------------------------------ coverage, deterministic */

export interface CoverageShot { scene: number; shot: number; id: string; covers: string[]; cast: string[]; image_prompt: string }
export interface CoverageResult {
  /** Must items no shot claims (visual) or no voice line says (spoken). */
  uncovered: string[];
  /** Events whose first covering shot comes before an earlier event's. */
  outOfOrder: string[];
  /** Covers entries that name no item. */
  unknownIds: string[];
  /** Shots that claim a cast member who is not in the spec. */
  unknownCast: string[];
  /** Human sentences for the planner's feedback, one per problem. */
  problems: string[];
}

const shotsOf = (sb: unknown): CoverageShot[] => {
  const scenes = isObj(sb) && Array.isArray(sb.scenes) ? sb.scenes.filter(isObj) : [];
  return scenes.flatMap((sc, i) => (Array.isArray(sc.shots) ? sc.shots.filter(isObj) : []).map((sh, j) => ({
    scene: i + 1, shot: j + 1, id: `${String(sc.id ?? `scene-${i + 1}`)}-s${j + 1}`,
    covers: Array.isArray(sh.covers) ? sh.covers.map(String) : [],
    cast: Array.isArray(sh.cast) ? sh.cast.map(String) : [],
    image_prompt: typeof sh.image_prompt === "string" ? sh.image_prompt : "",
  })));
};
const voiceOf = (sb: unknown): string => (isObj(sb) && Array.isArray(sb.scenes) ? sb.scenes.filter(isObj).map((s) => String(s.voice ?? "")).join(" ") : "");

/**
 * Whether a line the user asked the narrator to say is said: the user's words, folded, inside the narration — or 80%
 * of its words of three letters or more, in the same order, when the writer adapted the grammar to the sentence.
 */
export function lineSaid(quote: string, narration: string): boolean {
  const q = norm(quote), n = norm(narration);
  if (!q) return true;
  if (n.includes(q)) return true;
  const qw = q.split(" ").filter((w) => w.length >= 3);
  if (!qw.length) return false;
  const nw = n.split(" ");
  let at = 0, hit = 0;
  for (const w of qw) { const k = nw.indexOf(w, at); if (k >= 0) { hit++; at = k + 1; } }
  return hit / qw.length >= 0.8;
}

/**
 * THE DETERMINISTIC HALF OF THE FIDELITY GATE. What a storyboard CLAIMS against the spec: every must item a picture
 * can show is claimed by at least one shot (`covers`), every must line is said in the voice, the user's events are
 * first shown in the user's order, and no shot names an item or a character the spec does not have. What a claim is
 * worth — whether the shot's picture really shows the item — is the semantic half (src/fidelity.ts, a judge model),
 * and the drawn pictures are checked again by the vision model (src/stills.ts).
 */
export function coverage(spec: RequestSpec, sb: unknown, opts: { cast?: readonly string[] } = {}): CoverageResult {
  const shots = shotsOf(sb);
  const voice = voiceOf(sb);
  const ids = new Set(spec.items.map((i) => i.id));
  // A shot's "cast" names the spec's cast (by id or name) OR the direction's own characters (24 September 2026). The
  // guide tells the writer to list every recurring character in "cast" so its look is attached, and the stills engine
  // looks those names up in direction.cast — but this check knew only the spec's cast, so an open film ("a Short about
  // pirates", spec cast []) whose direction invented "Captain Rook" was refused with "use its ids (c1, c2…)", ids that
  // do not exist. The direction's names are read off the storyboard itself, plus any the caller passes (a planner
  // chunk carries only its scenes).
  const directionCast = (isObj(sb) && isObj(sb.direction) && Array.isArray(sb.direction.cast) ? sb.direction.cast : [])
    .filter(isObj).flatMap((c) => [c.name, c.id]).filter((x): x is string => typeof x === "string" && !!x.trim());
  const castIds = new Set([...spec.cast.flatMap((c) => [c.id, norm(c.name)]), ...[...directionCast, ...(opts.cast ?? [])].flatMap((n) => [n, norm(n)])]);
  const res: CoverageResult = { uncovered: [], outOfOrder: [], unknownIds: [], unknownCast: [], problems: [] };
  for (const sh of shots) {
    for (const c of sh.covers) if (!ids.has(c) && !res.unknownIds.includes(c)) res.unknownIds.push(c);
    for (const c of sh.cast) if (!castIds.has(c) && !castIds.has(norm(c)) && !res.unknownCast.includes(c)) res.unknownCast.push(c);
  }
  const claimed = new Set(shots.flatMap((s) => s.covers));
  for (const it of mustItems(spec)) {
    if (it.kind === "line") { if (!lineSaid(it.quote, voice) && !lineSaid(it.text, voice)) { res.uncovered.push(it.id); res.problems.push(`${it.id}: the narrator never says "${clip(it.quote, 120)}", which the user asked to be said — put it in a "voice" line`); } continue; }
    if (it.kind === "character") {
      // A character is covered by any shot that claims them, their items, or lists them in its cast.
      const who = spec.cast.find((c) => norm(it.text).includes(norm(c.name)) || norm(it.quote).includes(norm(c.name)));
      const inCast = who ? shots.some((s) => s.cast.includes(who.id) || s.cast.map(norm).includes(norm(who.name))) : false;
      if (claimed.has(it.id) || inCast) continue;
    }
    if ((SHOT_KINDS_TO_COVER as readonly string[]).includes(it.kind) && !claimed.has(it.id)) {
      res.uncovered.push(it.id);
      res.problems.push(`${it.id} (${it.kind}): no shot shows "${clip(it.text, 120)}" — give it to the shot where it happens, write it into that shot's image_prompt, and list "${it.id}" in its "covers"`);
    }
  }
  const events = eventsInOrder(spec);
  let last = -1, lastId = "";
  for (const e of events) {
    const first = shots.findIndex((s) => s.covers.includes(e.id));
    if (first < 0) continue;
    if (first < last) { res.outOfOrder.push(e.id); res.problems.push(`${e.id} (event #${e.order}) is shown before ${lastId}, but the user told it after: keep the user's order of events`); }
    else { last = first; lastId = e.id; }
  }
  if (res.unknownIds.length) res.problems.push(`"covers" names ${res.unknownIds.map((x) => `"${x}"`).join(", ")}, which ${res.unknownIds.length === 1 ? "is not an item" : "are not items"} of the spec — use the spec's ids (R1, R2…)`);
  if (res.unknownCast.length) res.problems.push(`"cast" names ${res.unknownCast.map((x) => `"${x}"`).join(", ")}, which ${res.unknownCast.length === 1 ? "is not" : "are not"} in the spec's cast or the direction's — use the spec's ids (${spec.cast.length ? spec.cast.map((c) => c.id).join(", ") : "it has none"}) or a name from direction.cast`);
  return res;
}

/* ------------------------------------------------------------------ the method, for the assistant and the server */

/**
 * THE SPEC METHOD. The system message of the server's spec call, and the text kleo_adapt_prompt hands the assistant.
 * Its whole job is to NOT be creative: extraction, not interpretation.
 */
export const SPEC_METHOD = `You are Kleo's script supervisor. Kleo makes short narrated films (realistic live action, or a 2D animated film) from a user's request. Before any creative decision is taken, you take the request apart into the REQUIREMENTS the finished film will be checked against. You invent nothing: you extract. You answer with ONE JSON object and nothing else.

WHAT TO EXTRACT — every concrete thing the user wrote about the film's CONTENT becomes an item:
- character: each person, animal or creature in the film ("a thin pastry chef", "Captain Mara", "my dog").
- look: EACH visible attribute of a character as its own item — hair, age, build, clothes, colours, accessories — with "who" = that character's cast id. "short blonde hair tied up" and "lilac apron" are two items.
- place: where it happens. object: a thing that must be seen. action: what someone does. mood: a feeling asked for.
- event: each beat of the story, with "order" 1, 2, 3… in the order the user told them. A story told in five sentences is five events.
- shot: a framing the user described ("close-up of her hands", "seen from above", "the film opens on the empty street").
- style: a visual style or reference ("like Pixar", "black and white", "Wes Anderson colours", "anime").
- text: words that must be READ on screen (a sign, a note, a title) — put the exact words in quotes inside "text".
- line: words the NARRATOR must say — the user's words in "quote" (for instance "the narration must say 'festa a sorpresa'").
- exclude: anything the user said must NOT appear or be said.
Do NOT make items of the format (length, 16:9/9:16, platform), the music or subtitles answers, or the price: Kleo reads those elsewhere.

RULES:
1. "quote" is the user's own words, copied verbatim from the request in their language. An item without a quote from the request is an invention: leave it out.
2. "text" restates the item in plain ENGLISH, self-contained, so a person who never read the request can check it on a picture ("the chef's apron is lilac", not "lilac").
3. "must": true for what the user said; false only for what they merely hinted ("maybe", "if possible").
4. CAST: one entry per recurring character, "id" c1, c2…, "name" as the user calls them (their name, or their role if unnamed), "look" = everything the user said about their appearance, in English, as one description. If the user said nothing about how someone looks, write a neutral, concrete description that contradicts nothing they said AND add "the look of <name>" to "open" (it is Kleo's decision, not the user's).
5. REFERENCE IMAGES: when the user gave images, each one is listed with its handle; put it in "refs" with its role (character, object, place, style) and "for" (the cast id or item id it shows), and write what it shows into that character's "look" or the item's "text", precisely (hair, face, clothes, colours, shapes).
6. "open": what the user left to Kleo, in English, one short phrase each ("the ending", "the setting", "the narrator's words"). If they described the whole story, "open" holds only presentation details.
7. "narration": "verbatim" when the user wrote the narration itself (then "script" = that text, word for word), "lines" when they gave some lines the narrator must say, "free" otherwise.
8. "summary": one English sentence — the film the user asked for, as they asked for it. Not a pitch, not an improvement.
9. "mode": "faithful" when the user described what happens or who is in it (a character they named or described, an event, a shot, words to be read on screen or said); "open" when they gave only a subject or asked to be surprised. A faithful spec carries at least one such item with "must": true.

SHAPE:
{"v":1,"mode":"faithful|open","summary":"…","cast":[{"id":"c1","name":"…","look":"…","ref":null}],"items":[{"id":"R1","kind":"character|look|place|object|action|event|shot|style|text|line|mood|exclude","text":"…","quote":"…","must":true,"who":"c1"|null,"order":1|null}],"refs":[{"id":"ref1","handle":"kref_…","role":"character|object|place|style","for":"c1","description":"…"}],"open":["…"],"narration":"free|lines|verbatim","script":null}

Return the JSON object only: no prose before it, no markdown fences.`;

/** The user message of the server's spec call: the request, the answers the intake collected, the images received. */
export function specPrompt(input: { prompt: string; language: string; must_keep?: string | null; audience?: string | null; tone?: string | null; corrections?: string | null; refs?: { handle: string; description?: string | null; role?: string | null; name?: string | null }[] }, feedback?: string[]): string {
  const answers = [
    input.must_keep ? `The user answered "what must appear or must not": "${input.must_keep}"` : "",
    input.audience ? `The user said the film is for: "${input.audience}"` : "",
    input.tone ? `The user asked for this tone: "${input.tone}"` : "",
    // The user's corrections after the read-back (24 September 2026): part of what they asked, so items quote them too.
    input.corrections ? `After reading back what Kleo understood, the user corrected it: "${input.corrections}"` : "",
  ].filter(Boolean);
  const refs = input.refs?.length
    ? `\nIMAGES THE USER GAVE (use the handles in "refs"; describe what they show in the cast looks or item texts):\n${input.refs.map((r) => `- ${r.handle}${r.role ? ` (the user says: ${r.role}${r.name ? ` — ${r.name}` : ""})` : ""}: ${r.description ?? "no description yet"}`).join("\n")}`
    : "";
  const base = `USER REQUEST (language: ${input.language}):
"""${input.prompt.trim()}"""${answers.length ? `\n${answers.join("\n")}` : ""}${refs}

TASK: take this request apart into the spec, following the method. Quotes come from the request (or from the user's answers above) verbatim.`;
  return feedback?.length ? `${base}\n\nYOUR PREVIOUS ANSWER WAS REJECTED for these reasons; fix every one and return the whole object again:\n- ${feedback.join("\n- ")}` : base;
}

/**
 * The text a client assistant receives from kleo_adapt_prompt: the method, the request, and what to do with the result.
 * The assistant usually SEES images the user attached; it is told to describe them into the spec and to offer the
 * upload link so Kleo can draw from the picture itself.
 */
export function specMethodText(input: { prompt: string; language: string; refs?: { handle: string; description?: string | null }[] }): string {
  const refs = input.refs?.length ? `\nIMAGES KLEO HOLDS FOR THIS FILM: ${input.refs.map((r) => `${r.handle}${r.description ? ` (${r.description})` : ""}`).join("; ")}.` : "";
  return `STEP A — WRITE THE SPEC FIRST (what the user asked for, taken apart), following this method exactly. It is extraction, not creativity: every item quotes the user.

${SPEC_METHOD}

USER REQUEST (language: ${input.language}):
"""${input.prompt.trim()}"""${refs}
If the user attached pictures in this conversation that Kleo does not hold yet, describe each one precisely in the cast "look" (or the item "text") it belongs to, and offer them kleo_upload_link so Kleo can draw from the picture itself.
If, after you read the spec back, the user corrects it or adds something ("add my dog Pepe with a red collar"), change the spec as they say — an item added may quote their correction — and pass their correction, in their own words, as "corrections" to kleo_create_video: the prompt itself stays unchanged.`;
}

/** The spec as the user reads it back: what Kleo understood, one line each, before anything is charged. */
export function specText(spec: RequestSpec): string {
  const cast = spec.cast.map((c) => `- ${c.name}: ${fullLook(spec, c.id)}`).join("\n");
  const by = (k: SpecKind) => spec.items.filter((i) => i.kind === k);
  const lines: string[] = [];
  const add = (label: string, xs: SpecItem[]) => { if (xs.length) lines.push(`${label}: ${xs.map((x) => x.text).join("; ")}`); };
  add("Where", by("place"));
  add("What happens, in order", eventsInOrder(spec));
  add("Must be seen", [...by("object"), ...by("action"), ...by("shot")]);
  add("Style", by("style"));
  add("Written on screen", by("text"));
  add("The narrator says", by("line"));
  add("Never", by("exclude"));
  add("Mood", by("mood"));
  return `What Kleo understood (${spec.mode === "faithful" ? "your film, as you described it" : "a subject Kleo will develop"}): ${spec.summary}
${cast ? `Characters:\n${cast}\n` : ""}${lines.join("\n")}${spec.open.length ? `\nLeft to Kleo: ${spec.open.join("; ")}` : ""}`;
}

/** JSON schema for a constrained decoder (Workers AI json_schema): flat and closed where it can be. */
export const specSchema = (): Record<string, unknown> => {
  const str = { type: "string" };
  return {
    type: "object",
    required: ["v", "mode", "summary", "cast", "items", "refs", "open", "narration", "script"],
    properties: {
      v: { type: "number" }, mode: { type: "string", enum: ["faithful", "open"] }, summary: str,
      cast: { type: "array", items: { type: "object", required: ["id", "name", "look"], properties: { id: str, name: str, look: str, ref: str } } },
      items: { type: "array", items: { type: "object", required: ["id", "kind", "text", "quote", "must"], properties: { id: str, kind: { type: "string", enum: [...SPEC_KINDS] }, text: str, quote: str, must: { type: "boolean" }, who: str, order: { type: "number" } } } },
      refs: { type: "array", items: { type: "object", required: ["id", "handle", "role"], properties: { id: str, handle: str, role: { type: "string", enum: [...REF_ROLES] }, for: str, description: str } } },
      open: { type: "array", items: str },
      narration: { type: "string", enum: ["free", "lines", "verbatim"] },
      script: str,
    },
  };
};

/* ------------------------------------------------------------------ questions for the vision model */

export interface VisualCheck {
  /** The item id, or "cast:<id>", "style", "no-text", "exclude:<id>". */
  id: string;
  question: string;
  /** The answer that passes. */
  expect: "yes" | "no";
  /** A must check weighs double and a failed one sends the picture back. */
  must: boolean;
}

/**
 * The cast member a "character" item is about: its `who` when it names one, otherwise the cast member whose name
 * stands whole in the item's text or quote (a leading "the"/"a"/"an" of the name aside, so the cast name "the pastry
 * chef" is found in "a pastry chef"). Undefined for a character the cast does not hold — a crowd, "a fisherman in the
 * background" — which a picture can still be asked about as such.
 */
export function castOfItem(spec: RequestSpec, it: Pick<SpecItem, "text" | "quote" | "who">): SpecCast | undefined {
  if (it.who) { const c = castById(spec, it.who); if (c) return c; }
  const bare = (s: string) => norm(s).replace(/^(?:the|a|an)\s+/, "");
  return spec.cast.find((c) => { const n = bare(c.name); return !!n && [it.text, it.quote].some((s) => ` ${norm(String(s ?? ""))} `.includes(` ${n} `)); });
}

/**
 * BUILD, AGE AND BODY: the look words one frame cannot settle (24 September 2026). On the fidelity bench (4 cases, 35
 * stills) "thin build" was asked as a must and failed on pictures of a plainly slender woman: how thin, how tall, how
 * old a person is are judgements a vision model makes differently from one frame to the next, and every "no" bought a
 * redraw. A look item that says only that (thin, slim, tall, short, young, old, elderly, in her thirties, muscular…)
 * is asked softly; one that also names something concrete — hair, a garment, a colour, an accessory, a feature of the
 * face — stays a must, because that is exactly what a picture proves ("short blonde hair" is hair, not height).
 */
const BODY_RE = /\b(?:thin(?:ner)?|slim|skinny|slender|lean|lanky|wiry|willowy|frail|tall(?:er)?|short(?:er)?|petite|small|tiny|little|big|large|huge|heavy|heavyset|stocky|stout|burly|chubby|plump|fat|overweight|muscular|athletic|build|built|young(?:er)?|youthful|old(?:er)?|elderly|aged?|teen(?:age|ager)?s?|middle[- ]aged|years?[- ]old|(?:twent|thirt|fort|fift|sixt|sevent|eight|ninet)ies)\b/i;
const CONCRETE_RE = /\b(?:hair|haired|bun|ponytail|braids?|plaits?|curls|curly|fringe|bangs|bald|beard(?:ed)?|moustache|mustache|stubble|eyes?|eyebrows?|glasses|spectacles|freckles|scars?|tattoos?|face|nose|lips|skin|make-?up|apron|coat|jacket|shirt|t-shirt|blouse|dress|skirt|trousers|pants|jeans|shorts|hat|cap|beret|helmet|hood|hoodie|scarf|shawl|cloak|cape|robe|gown|uniform|suit|tie|vest|sweater|jumper|cardigan|gloves?|boots?|shoes?|sandals|sneakers|belt|necklace|earrings?|rings?|bracelet|watch|bag|backpack|sword|shield|armou?r|mask|crown|badge|collar|wears|wearing|dressed|red|orange|yellow|green|blue|purple|violet|lilac|lavender|pink|brown|black|white|grey|gray|blond|blonde|ginger|auburn|silver|golden|gold|beige|navy|teal|turquoise|crimson|striped|checked)\b/i;
/** Whether a look item speaks only of build, age or body (asked softly), with nothing concrete a picture proves. */
export const bodyOnlyLook = (text: string): boolean => BODY_RE.test(text) && !CONCRETE_RE.test(text);
const lookMust = (it: SpecItem): boolean => it.must && !bodyOnlyLook(it.text);

/**
 * The yes/no questions one picture is judged by (src/vision.ts asks them, src/stills.ts acts on the answers): one per
 * item the shot claims, one per cast member it shows (their look, attribute by attribute when the spec has look items),
 * the film's style, what must never appear, and — unless the shot is meant to carry words — no stray text.
 * Atomic yes/no questions, never a 1-10 score: measured in the literature (TIFA, DSG, VQAScore) they are what a vision
 * model answers reliably, and a failed one names exactly what to fix.
 *
 * ONLY WHAT ONE FRAME CAN PROVE IS A MUST (24 September 2026). The fidelity bench (4 cases, 35 stills) found almost
 * every still drawn three times and escalated to the dearer model — 7 of 7 on the pastry chef, ≈ $0.027 a still
 * against a $0.003-0.005 target — because the judge was asked, as musts, things no single picture can show:
 *   - a CHARACTER by role: "Does the image show this: the pastry chef?" failed on every pastry still although the
 *     woman in the lilac apron was there. A character of the cast now asks nothing of their own: they are checked
 *     through their look attributes (asked here) and, when the still is drawn from their sheet, through an identity
 *     question against it (src/stills.ts checksFor). A character the cast does not hold (a crowd, "a fisherman in the
 *     background") is still asked, concretely: "Does the image show a fisherman in the background?".
 *   - an EVENT or an ACTION: "organizes a surprise party for her best friend", "prepares the cake secretly" are story
 *     beats; a frame can be a moment of one, never prove it. Asked softly: "Could this image be a moment of this: …?".
 *   - BUILD and AGE: "thin build" (bodyOnlyLook above), asked softly.
 * A soft question still counts in the score and still lands in fidelity.json; it just never buys a redraw.
 */
export function visualChecks(spec: RequestSpec | null, shot: { covers?: readonly string[]; cast?: readonly string[] }, look: "realistic" | "animation"): VisualCheck[] {
  const out: VisualCheck[] = [];
  const style = look === "animation"
    ? { id: "style", question: "Is this image a drawn 2D animation frame (not a photograph and not a 3D render)?", expect: "yes" as const, must: true }
    : { id: "style", question: "Does this image look like a real photograph (not a drawing, painting or 3D render)?", expect: "yes" as const, must: true };
  out.push(style);
  if (!spec) return out;
  const claimed = (shot.covers ?? []).map((id) => itemById(spec, id)).filter((x): x is SpecItem => !!x);
  const shows = new Set((shot.cast ?? []).map((c) => castById(spec, c)?.id).filter(Boolean) as string[]);
  for (const it of claimed) {
    if (it.kind === "line" || it.kind === "mood" || it.kind === "style" || it.kind === "exclude") continue;
    if (it.kind === "look" && it.who) shows.add(it.who);
    if (it.kind === "character") {
      const c = castOfItem(spec, it);
      if (c) { shows.add(c.id); continue; } // checked by their look and their identity, never by their role
      out.push({ id: it.id, question: `Does the image show ${it.text.replace(/[.?\s]+$/, "")}?`, expect: "yes", must: it.must });
      continue;
    }
    if (it.kind === "event" || it.kind === "action") { out.push({ id: it.id, question: `Could this image be a moment of this: ${it.text}?`, expect: "yes", must: false }); continue; }
    const q = it.kind === "text" ? `Is the following text clearly written and readable in the image: ${it.text}?` : `Does the image show this: ${it.text}?`;
    out.push({ id: it.id, question: q, expect: "yes", must: it.kind === "look" ? lookMust(it) : it.must });
  }
  for (const cid of shows) {
    const c = castById(spec, cid);
    if (!c) continue;
    const attrs = spec.items.filter((i) => i.kind === "look" && i.who === c.id && !claimed.includes(i));
    if (attrs.length) for (const a of attrs) out.push({ id: `${a.id}`, question: `Does the image show this: ${a.text}?`, expect: "yes", must: lookMust(a) });
    // The whole look is asked only of a character the spec has NO look items for: when the shot claimed them all they
    // were asked one by one above, and the whole sentence ("a thin woman in her thirties…") fails on a body word the
    // way "thin build" did on the bench (24 September 2026).
    else if (!spec.items.some((i) => i.kind === "look" && i.who === c.id)) out.push({ id: `cast:${c.id}`, question: `Is there a character matching this description: ${c.look}?`, expect: "yes", must: true });
  }
  for (const it of spec.items.filter((i) => i.kind === "style" && i.must)) out.push({ id: it.id, question: `Is the image in this style: ${it.text}?`, expect: "yes", must: false });
  for (const it of spec.items.filter((i) => i.kind === "exclude")) out.push({ id: `exclude:${it.id}`, question: `Does the image show any of this: ${it.text.replace(/^(no|never|without|not)\s+/i, "")}?`, expect: "no", must: true });
  if (!claimed.some((i) => i.kind === "text")) out.push({ id: "no-text", question: "Is there any written text, lettering, caption or watermark in the image?", expect: "no", must: false });
  return out;
}
