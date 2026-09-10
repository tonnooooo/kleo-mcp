/**
 * TypeScript mirror of worker/keou/contract.py validate(), restricted to *storyboards*:
 * a full Keou project object without `id`, `script_file`, `music_quiet` and without any
 * scene of kind `image` (no assets can travel with a job). Enums are copied verbatim from
 * contract.py; keep the two files in sync. Error wording follows contract.py so a worker-side
 * failure and a server-side failure read the same.
 *
 * Kleo additions on top of the Keou project (the worker strips them before writing project.json):
 *   - top-level "kleo_style": cartoon | realistic | cyber | stickman (default cyber = the Keou look, no pictures);
 *   - style "picture" (docs/PICTURE-STYLE.md): the cartoon/realistic look. Each scene cuts between several full-screen
 *     pictures ("shots"), like a short documentary: no beats, no icons, no HUD. One shot = one generated picture,
 *     identified by `<sceneId>-s<n>`; the old per-scene "image_prompt" is accepted as shorthand for a single shot and
 *     normalised away here, so what is stored (and what the engine sees) always carries shots.
 * Clients never set scene.image or shot.image themselves: the server generates the pictures and the worker attaches them.
 */

export const STYLES = ["editorial", "technical", "illustrated", "terminal", "stickman", "cinema", "picture"] as const;
export const KINDS = ["hero", "list", "compare", "steps", "metric", "image", "quote", "closing", "story", "cinema"] as const;
export const BEAT_KINDS = ["icon", "type", "terminal", "steps", "people", "bars", "timeline", "dialog", "cta", "split", "grid"] as const;
export const BEAT_ICONS = ["coffee", "desk", "hoodie", "keyboard", "hand", "bug", "alarm", "shield", "radar", "car", "keyfob", "house", "amplifier", "pouch", "lock", "timer", "check", "cross", "figure", "thief", "phone", "wave", "clock"] as const;
export const BEAT_FX = ["lit", "dead", "key", "open", "drive", "alarm", "point", "run", "think"] as const;
export const CINEMA_ACCENTS = ["green", "cyan", "red", "amber"] as const;
export const STORY_ACTS = ["idle", "explain", "point-up", "shrug", "think", "alarm", "hold", "drop", "wave", "walk", "run", "crouch"] as const;
export const STORY_CAST = ["hero", "thief", "thief2"] as const;
export const STORY_PROPS = ["keyfob", "car", "house", "amplifier", "pouch", "timer", "bar", "check"] as const;
export const STORY_FX = ["drive-off", "relay", "relay-fail", "signal", "drop"] as const;
export const STORY_ACCENTS = ["green", "red", "amber"] as const;
export const VISUALS = ["focus", "network", "cycle", "spark", "globe", "check", "growth"] as const;
export const BASE_MOTION = ["galaxy", "orbit-compare", "voice-signal", "ai-network", "data-flow"] as const;
export const ESCAPE_MOTION = ["timeline-track", "package-server", "sandbox-grid", "swarm-board", "cluster-intrusion", "kill-chain", "flag-grid", "defense-side", "paper-grader", "terminal-quote"] as const;
export const MOTION = [...BASE_MOTION, ...ESCAPE_MOTION] as const;
export const LABELLED_MOTION = ["voice-signal", "ai-network", "data-flow", ...ESCAPE_MOTION] as const;
/** Kokoro voices per language. Italian (lang_code 'i') is supported by kokoro 0.9.4 (requirements.txt). */
export const VOICES: Record<string, readonly string[]> = {
  fr: ["ff_siwis"],
  en: ["af_heart", "am_michael", "bf_emma"],
  it: ["if_sara", "im_nicola"],
};
export const LANGUAGES = Object.keys(VOICES);
export const FORMATS = ["9:16", "16:9"] as const;
/** Kleo visual styles. cartoon/realistic cut between generated pictures (Keou style "picture"); cyber is the plain Keou look; stickman is Keou's stickman. */
export const KLEO_STYLES = ["cartoon", "realistic", "cyber", "stickman"] as const;
export type KleoStyle = (typeof KLEO_STYLES)[number];
/** Styles whose shots get a generated picture; they are exactly the styles that use the Keou style "picture". */
export const PICTURE_STYLES: readonly KleoStyle[] = ["cartoon", "realistic"];
export const IMAGE_PROMPT_MAX = 240;
/** Shot fields (picture style): the picture, the big words on it, the word it cuts on, the Ken Burns move. */
export const SHOT_MOTION = ["in", "out", "left", "right"] as const;
export const IMAGE_PROMPT_MIN = 2;
export const SHOT_CAPTION_MAX = 40;
export const SHOT_HL_MAX = 20;
export const SHOT_AT_MAX = 24;
/**
 * Everything a shot may carry, mirroring contract.py SHOT_FIELDS with image_prompt where the engine has the
 * worker-attached `image`. contract.py refuses a shot with any other key, and it only runs once the GPU is rented
 * and the pictures are drawn: whatever the server lets through here is paid for before the engine throws it out.
 */
export const SHOT_FIELDS = ["image_prompt", "caption", "hl", "at", "motion"] as const;
/** Shots per scene: a cinema scene cuts up to four times, a closing shows one picture (two at most). */
export const SHOTS_PER_SCENE: Record<"cinema" | "closing", [number, number]> = { cinema: [1, 4], closing: [1, 2] };
export const CLOSING_BUTTON_MAX = 24;
/** Scene ids may not end with the shot suffix: picture ids are `<sceneId>-s<n>` and must stay unambiguous. */
export const SHOT_ID_SUFFIX_RE = /-s\d+$/;
/**
 * Pictures a video may carry in total (server + worker): 24 for a Short, 48 for a long video. Defined here so the
 * server (images.ts, re-exported there), the guide and the tests all read the same number.
 */
export const MAX_PICTURES = (duration_s: number): number => (duration_s <= 90 ? 24 : 48);
export const WIDTHS: Record<string, readonly number[]> = { "9:16": [540, 1080, 2160], "16:9": [960, 1920, 3840] };

/** Fields a storyboard must not carry (the worker adds them) and the scene kind it cannot use. */
export const FORBIDDEN_FIELDS = ["id", "script_file", "music_quiet"] as const;
export const FORBIDDEN_KINDS = ["image"] as const;
export const FORBIDDEN_SCENE_FIELDS = ["image", "image_credit", "motion", "motion_labels", "motion_text", "motion_date", "motion_count", "motion_total", "motion_stage"] as const;

export type Format = (typeof FORMATS)[number];
export type Storyboard = Record<string, unknown> & { scenes: Record<string, unknown>[] };

/** The Kleo style of a storyboard: explicit kleo_style, else stickman/cartoon for a stickman/picture project, else cyber. */
export function kleoStyleOf(sb: unknown): KleoStyle {
  const c = (typeof sb === "object" && sb !== null ? sb : {}) as Record<string, unknown>;
  if ((KLEO_STYLES as readonly string[]).includes(c.kleo_style as string)) return c.kleo_style as KleoStyle;
  if (c.style === "stickman") return "stickman";
  return c.style === "picture" ? "cartoon" : "cyber";
}
/**
 * Every picture of a storyboard, flattened in scene → shot order: `{ id: "<sceneId>-s<n>", image_prompt }`.
 * Only the styles that draw pictures (cartoon/realistic) have any; a cyber or stickman storyboard returns [].
 * A scene-level image_prompt without shots (old format, not yet normalised) counts as the single shot 1.
 */
export function pictureScenes(sb: unknown): { id: string; image_prompt: string }[] {
  const c = (typeof sb === "object" && sb !== null ? sb : {}) as Record<string, unknown>;
  if (!PICTURE_STYLES.includes(kleoStyleOf(c)) || !Array.isArray(c.scenes)) return [];
  return (c.scenes as unknown[]).flatMap((s) => {
    const sc = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    if (typeof sc.id !== "string" || !sc.id) return [];
    const shots = Array.isArray(sc.shots) ? (sc.shots as unknown[]) : typeof sc.image_prompt === "string" ? [{ image_prompt: sc.image_prompt }] : [];
    return shots.flatMap((sh, i) => {
      const o = (typeof sh === "object" && sh !== null ? sh : {}) as Record<string, unknown>;
      const p = typeof o.image_prompt === "string" ? o.image_prompt.trim() : "";
      return p ? [{ id: `${sc.id}-s${i + 1}`, image_prompt: p }] : []; // a shot without a prompt keeps its index: ids follow the shot number
    });
  });
}
export interface ValidateOptions {
  format: Format;
  language: string;
  /** Maximum number of errors collected (default 10). */
  maxErrors?: number;
}
export type ValidateResult = { ok: true; storyboard: Storyboard } | { ok: false; errors: string[] };

const MAX_ERRORS = 10;
class TooMany extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const printable = (s: string) => ![...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const sorted = (list: readonly string[]) => `[${[...list].sort().map((x) => `'${x}'`).join(", ")}]`;
const subset = (items: unknown[], set: readonly string[]) => items.every((x) => typeof x === "string" && (set as readonly string[]).includes(x));
/** The engine's word key (engine/picture.js `key`): lowercase, everything but a-z0-9%$ dropped. */
const wordKey = (w: string) => w.toLowerCase().replace(/[^a-z0-9%$]/g, "");
/** A text as the engine reads it: whitespace-separated words, keyed, empties dropped (engine/picture.js shotStarts). */
const wordsOf = (s: string) => s.split(/\s+/).map(wordKey).filter(Boolean);
/**
 * True when `at` quotes the scene voice the way *both* engine checks read it, so an accepted cut is really anchored:
 *   - picture.js shotStarts() keys the shot's words and the aligned s.words and looks for the shot's words as a
 *     contiguous run of the scene's. A fragment that is not a whole word ("orty pirate", "he st") matches no run,
 *     so the cut silently falls back to the even split — the picture lands on nothing in particular.
 *   - contract.py (like the cinema-beat rule it reuses) keeps a raw substring test on the lowercased voice, and it
 *     runs on the GPU after the pictures are paid for, so a quote it would reject must never leave the server.
 * Both are required: neither implies the other ("hello world" is whole words of "Hello, world" but not a substring).
 */
export const quotesVoice = (at: string, voice: string): boolean => {
  const toks = wordsOf(at), said = wordsOf(voice);
  if (!toks.length || !voice.toLowerCase().includes(at.toLowerCase())) return false;
  for (let i = 0; i + toks.length <= said.length; i++) if (toks.every((tk, m) => said[i + m] === tk)) return true;
  return false;
};

class Collector {
  errors: string[] = [];
  private max: number;
  constructor(max: number) { this.max = max; }
  add(msg: string): void {
    this.errors.push(msg);
    if (this.errors.length >= this.max) throw new TooMany();
  }
  /** contract.py text(): required non-blank string up to `maximum` chars. Returns true when valid. */
  text(value: unknown, label: string, maximum = 180): value is string {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) {
      this.add(`${label}: required text, maximum ${maximum} characters`);
      return false;
    }
    return true;
  }
  finite(value: unknown, low: number, high: number, label: string): boolean {
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) {
      this.add(`${label}: expected a number between ${low} and ${high}`);
      return false;
    }
    return true;
  }
}

function validateBeats(c: Record<string, unknown>, s: Record<string, unknown>, label: string, e: Collector): void {
  if (c.style !== "cinema") { e.add(`${label}: cinema scenes need the cinema style`); return; }
  const beats = s.beats;
  if (!Array.isArray(beats) || beats.length < 1 || beats.length > 8) { e.add(`${label}: beats must list one to eight hero visuals`); return; }
  const voice = typeof s.voice === "string" ? s.voice.toLowerCase() : "";
  beats.forEach((b: unknown, j: number) => {
    const bl = `${label} beat ${j + 1}`;
    if (!isObj(b) || !(BEAT_KINDS as readonly string[]).includes(b.kind as string)) { e.add(`${bl}: kind must be one of ${sorted(BEAT_KINDS)}`); return; }
    const k = b.kind as string;
    if ("at" in b) {
      if (e.text(b.at, `${bl} at`, 24) && !voice.includes((b.at as string).toLowerCase())) e.add(`${bl}: at must quote words from this scene's voice`);
    }
    if ("label" in b && ["icon", "split", "grid"].includes(k)) e.text(b.label, `${bl} label`, 24);
    if (k === "split" || k === "grid") {
      const items = b.items;
      const [lo, hi] = k === "split" ? [2, 2] : [2, 3];
      if (!Array.isArray(items) || items.length < lo || items.length > hi || !subset(items, BEAT_ICONS)) e.add(`${bl}: ${k} needs ${lo}-${hi} icon names`);
      if ("fx" in b && !(BEAT_FX as readonly string[]).includes(b.fx as string)) e.add(`${bl}: unknown fx`);
    }
    if (k === "icon") {
      if (!(BEAT_ICONS as readonly string[]).includes(b.name as string)) e.add(`${bl}: icon name must be one of ${sorted(BEAT_ICONS)}`);
      if ("fx" in b && !(BEAT_FX as readonly string[]).includes(b.fx as string)) e.add(`${bl}: unknown icon fx`);
      if ("size" in b) e.finite(b.size, 0.3, 1.0, `${bl} size`);
    }
    if (k === "type") {
      e.text(b.text, `${bl} text`, 40);
      if ("slam" in b && !isBool(b.slam)) e.add(`${bl}: slam must be a boolean`);
      if ("hl" in b) e.text(b.hl, `${bl} hl`, 20);
      if ("icon" in b && !(BEAT_ICONS as readonly string[]).includes(b.icon as string)) e.add(`${bl}: icon must be one of ${sorted(BEAT_ICONS)}`);
      if ("fx" in b && !(BEAT_FX as readonly string[]).includes(b.fx as string)) e.add(`${bl}: unknown type fx`);
    }
    if (k === "terminal") {
      const lines = b.lines;
      if (!Array.isArray(lines) || lines.length < 1 || lines.length > 4) e.add(`${bl}: terminal needs 1-4 lines`);
      else for (const ln of lines) { if (e.text(ln, `${bl} line`, 48) && !printable(ln)) e.add(`${bl}: lines must be printable`); }
      if ("label" in b) e.text(b.label, `${bl} label`, 16);
    }
    if (k === "steps") {
      const items = b.items;
      if (!Array.isArray(items) || items.length < 2 || items.length > 4) e.add(`${bl}: steps need 2-4 items`);
      else {
        for (const it of items) e.text(it, `${bl} item`, 14);
        if ("lit" in b && (!isInt(b.lit) || b.lit < 0 || b.lit > items.length)) e.add(`${bl}: lit out of range`);
      }
    }
    if (k === "people") {
      let okNums = true;
      for (const key of ["total", "lit"]) {
        const v = b[key];
        if (!isInt(v) || v < 0 || v > 12) { e.add(`${bl}: ${key} must be 0-12`); okNums = false; }
      }
      if (okNums && (b.lit as number) > (b.total as number)) e.add(`${bl}: lit exceeds total`);
      if ("label" in b) e.text(b.label, `${bl} label`, 32);
    }
    if (k === "bars") {
      const labels = b.labels, values = b.values;
      if (!Array.isArray(labels) || !Array.isArray(values) || labels.length < 1 || labels.length > 4 || labels.length !== values.length) e.add(`${bl}: bars need 1-4 labels with matching values`);
      else {
        for (const lb of labels) e.text(lb, `${bl} label`, 14);
        for (const v of values) if (!isInt(v) || v < 0 || v > 1000000) { e.add(`${bl}: values must be integers 0-1000000`); break; }
      }
    }
    if (k === "timeline") {
      const labels = b.labels;
      if (!Array.isArray(labels) || labels.length < 2 || labels.length > 4) e.add(`${bl}: timeline needs 2-4 labels`);
      else {
        for (const lb of labels) e.text(lb, `${bl} label`, 14);
        if ("icons" in b && (!Array.isArray(b.icons) || b.icons.length !== labels.length || !subset(b.icons, BEAT_ICONS))) e.add(`${bl}: icons must name one icon per label`);
      }
    }
    if (k === "dialog") {
      e.text(b.text, `${bl} text`, 32);
      if ("count" in b && (!isInt(b.count) || b.count < 1 || b.count > 5)) e.add(`${bl}: count must be 1-5`);
    }
    if (k === "cta") {
      if ("label" in b) e.text(b.label, `${bl} label`, 24);
      if ("toggles" in b) {
        if (!Array.isArray(b.toggles) || b.toggles.length < 1 || b.toggles.length > 3) e.add(`${bl}: 1-3 toggles`);
        else for (const tg of b.toggles) e.text(tg, `${bl} toggle`, 14);
      }
    }
  });
  if ("chapter" in s) e.text(s.chapter, `${label} chapter`, 32);
  if ("accent" in s && !(CINEMA_ACCENTS as readonly string[]).includes(s.accent as string)) e.add(`${label}: accent must be green, cyan, red or amber`);
  if ("hl" in s) e.text(s.hl, `${label} hl`, 24);
}

/**
 * Picture style: a scene is a run of full-screen pictures ("shots") cut on the narration. No beats, no icons.
 * Normalises the old shorthand (a scene-level image_prompt) into shots[0] in place, so what the caller stores and
 * what the engine receives never carries a scene-level image_prompt.
 */
function validateShots(s: Record<string, unknown>, label: string, kind: "cinema" | "closing", e: Collector): void {
  if ("beats" in s) e.add(`${label}: beats belong to the cinema style; the picture style cuts between "shots" instead`);
  if (typeof s.image_prompt === "string" && !("shots" in s)) { s.shots = [{ image_prompt: s.image_prompt.trim() }]; delete s.image_prompt; }
  else if ("image_prompt" in s) { e.add(`${label}: put the picture on a shot ("shots": [{"image_prompt": "…"}]), not on the scene`); delete s.image_prompt; }
  const [lo, hi] = SHOTS_PER_SCENE[kind];
  const shots = s.shots;
  if (!Array.isArray(shots) || shots.length < lo || shots.length > hi) { e.add(`${label}: shots must list ${lo}–${hi} full-screen pictures`); return; }
  const voice = typeof s.voice === "string" ? s.voice.toLowerCase() : "";
  shots.forEach((sh: unknown, j: number) => {
    const sl = `${label} shot ${j + 1}`;
    if (!isObj(sh)) { e.add(`${sl}: must be an object`); return; }
    if ("image" in sh) e.add(`${sl}: image is not allowed in a storyboard (describe the picture in image_prompt instead; Kleo generates it)`);
    // contract.py: `unknown = set(shot) - SHOT_FIELDS` → same wording, same sorted list. A stray "note" or "seed"
    // costs a whole rendered job otherwise. `image` keeps the dedicated message above.
    const unknown = Object.keys(sh).filter((k) => k !== "image" && !(SHOT_FIELDS as readonly string[]).includes(k));
    if (unknown.length) e.add(`${sl}: unknown shot fields ${sorted(unknown)}`);
    if (e.text(sh.image_prompt, `${sl} image_prompt`, IMAGE_PROMPT_MAX) && (sh.image_prompt as string).trim().length < IMAGE_PROMPT_MIN)
      e.add(`${sl} image_prompt: required text, minimum ${IMAGE_PROMPT_MIN} characters`);
    if ("caption" in sh) e.text(sh.caption, `${sl} caption`, SHOT_CAPTION_MAX);
    if ("hl" in sh) e.text(sh.hl, `${sl} hl`, SHOT_HL_MAX);
    if ("at" in sh) {
      if (j === 0) e.add(`${sl}: the first shot opens the scene, it cannot carry at`);
      else if (e.text(sh.at, `${sl} at`, SHOT_AT_MAX) && !quotesVoice(sh.at as string, voice)) e.add(`${sl}: at must quote words from this scene's voice`);
    }
    if ("motion" in sh && !(SHOT_MOTION as readonly string[]).includes(sh.motion as string)) e.add(`${sl}: motion must be one of ${sorted(SHOT_MOTION)}`);
  });
  if ("chapter" in s) e.text(s.chapter, `${label} chapter`, 32);
  if ("accent" in s && !(CINEMA_ACCENTS as readonly string[]).includes(s.accent as string)) e.add(`${label}: accent must be green, cyan, red or amber`);
  if ("hl" in s) e.text(s.hl, `${label} hl`, 24);
}

function validateInner(input: unknown, opts: ValidateOptions, e: Collector): void {
  if (!isObj(input)) { e.add("storyboard must be a JSON object"); return; }
  const c = input;
  for (const f of FORBIDDEN_FIELDS) if (f in c) e.add(`${f} must not be part of a storyboard (the worker sets it)`);
  if (c.schema_version !== 1) e.add("schema_version must be 1");
  if (c.editorial_status !== "ready") e.add("editorial_status must be ready");
  e.text(c.title, "title", 120);
  if ("brand" in c) e.text(c.brand, "brand", 28);
  if (!(STYLES as readonly string[]).includes(c.style as string)) e.add(`style must be one of ${sorted(STYLES)}`);
  if (!(FORMATS as readonly string[]).includes(c.format as string) || ("fps" in c && c.fps !== 30 && c.fps !== 60)) e.add("format: 9:16 or 16:9; fps: 30 or 60");
  else if (c.format !== opts.format) e.add(`format must be ${opts.format} for this job, not ${String(c.format)}`);
  // Kleo style ⇔ Keou style. cartoon/realistic are the "picture" style (shots); stickman is Keou's stickman (9:16 only).
  const kleo = "kleo_style" in c ? c.kleo_style : undefined;
  if (kleo !== undefined && !(KLEO_STYLES as readonly string[]).includes(kleo as string)) e.add(`kleo_style must be one of ${sorted(KLEO_STYLES)}`);
  else if (kleo === "stickman" && c.format !== "9:16") e.add("The stickman style makes 9:16 Shorts only: use format 9:16, or pick another style (cartoon, realistic or cyber) for 16:9");
  else if (kleo === "stickman" && c.style !== "stickman") e.add(`kleo_style stickman needs the Keou style "stickman" (story scenes), not "${String(c.style)}"`);
  else if ((kleo === "cartoon" || kleo === "realistic") && c.style !== "picture") e.add(`kleo_style ${kleo} needs the Keou style "picture" (full-screen shots cut on the narration), not "${String(c.style)}"`);
  else if (kleo === "cyber" && c.style === "stickman") e.add('kleo_style cyber does not draw the stickman: set kleo_style to "stickman" or change the style');
  if (c.style === "picture" && kleo !== "cartoon" && kleo !== "realistic")
    e.add(`the Keou style "picture" is the cartoon/realistic look: set kleo_style to "cartoon" or "realistic"${kleo === undefined ? "" : `, not "${String(kleo)}"`}`);
  if (c.style === "stickman" && c.format !== "9:16" && kleo !== "stickman") e.add("The stickman style is laid out for 9:16 only");
  if ("width" in c && !(WIDTHS[c.format as string] ?? []).includes(c.width as number)) e.add("Invalid width for aspect ratio");
  const voices = VOICES[c.language as string];
  if (!voices || !voices.includes(c.voice as string)) e.add("Unsupported language/voice combination");
  else if (c.language !== opts.language) e.add(`language must be ${opts.language} for this job, not ${String(c.language)}`);
  e.finite(c.speed ?? 1, 0.8, 1.3, "speed");
  if ("music" in c && c.music !== "bed" && c.music !== "none") e.add("music must be bed or none");
  e.finite(c.max_duration ?? 600, 5, 1800, "max_duration");
  const scenes = c.scenes;
  if (!Array.isArray(scenes) || scenes.length < 2 || scenes.length > 240) { e.add("A project needs 2–240 scenes"); return; }
  const ids = new Set<string>();
  scenes.forEach((s: unknown, i: number) => {
    const label = `scene ${i + 1}`;
    if (!isObj(s)) { e.add(`${label}: must be an object`); return; }
    if (e.text(s.id, `${label} id`, 50)) {
      if (!/^[a-z0-9-]+$/.test(s.id) || ids.has(s.id)) e.add("Scene IDs must be unique slugs");
      else if (SHOT_ID_SUFFIX_RE.test(s.id)) e.add(`${label} id: "-s" followed by a number is reserved for picture ids (${s.id}-s1, …); rename the scene`);
      ids.add(s.id);
    }
    const kind = s.kind as string;
    if (!(KINDS as readonly string[]).includes(kind)) { e.add(`${label}: unknown composition`); return; }
    if ((FORBIDDEN_KINDS as readonly string[]).includes(kind)) e.add(`${label}: image scenes are not allowed in a storyboard (no assets); use another composition`);
    for (const f of FORBIDDEN_SCENE_FIELDS) if (f in s) e.add(`${label}: ${f} is not allowed in a storyboard${f === "image" ? " (describe the picture in image_prompt instead; Kleo generates it)" : ""}`);
    if (c.style === "picture") {
      if (kind !== "cinema" && kind !== "closing") e.add(`${label}: the picture style only draws cinema and closing scenes`);
      else validateShots(s, label, kind, e);
    } else {
      if ("shots" in s) e.add(`${label}: shots need the picture style (kleo_style cartoon or realistic)`);
      if ("image_prompt" in s) e.text(s.image_prompt, `${label} image_prompt`, IMAGE_PROMPT_MAX);
    }
    if (c.style === "cinema" && kind !== "cinema" && kind !== "closing") e.add(`${label}: the cinema style only draws cinema and closing scenes`);
    if (c.style !== "picture" && (kind === "cinema" || (kind === "closing" && c.style === "cinema" && "beats" in s))) validateBeats(c, s, label, e);
    if (kind === "closing" && c.style === "cinema") {
      if ("chapter" in s) e.text(s.chapter, `${label} chapter`, 32);
      if ("accent" in s && !(CINEMA_ACCENTS as readonly string[]).includes(s.accent as string)) e.add(`${label}: accent must be green, cyan, red or amber`);
    }
    if (c.style === "stickman" && kind !== "story" && kind !== "closing") e.add(`${label}: the stickman style only draws story and closing scenes`);
    if (kind === "story") {
      if (c.style !== "stickman") e.add(`${label}: story scenes need the stickman style`);
      if (!(STORY_ACTS as readonly string[]).includes((s.act ?? "idle") as string)) e.add(`${label}: act must be one of ${sorted(STORY_ACTS)}`);
      const cast = s.cast ?? ["hero"];
      if (!Array.isArray(cast) || cast.length < 1 || cast.length > 3 || !subset(cast, STORY_CAST) || !cast.includes("hero")) e.add(`${label}: cast must list hero and at most thief, thief2`);
      const props = s.props ?? [];
      if (!Array.isArray(props) || props.length > 3 || !subset(props, STORY_PROPS) || new Set(props).size !== props.length) e.add(`${label}: props must be up to three distinct names from ${sorted(STORY_PROPS)}`);
      if ("fx" in s && !(STORY_FX as readonly string[]).includes(s.fx as string)) e.add(`${label}: fx must be one of ${sorted(STORY_FX)}`);
      if ("accent" in s && !(STORY_ACCENTS as readonly string[]).includes(s.accent as string)) e.add(`${label}: accent must be green, red or amber`);
      for (const [key, limit] of [["bubble", 40], ["hl", 24]] as const) {
        if (key in s && e.text(s[key], `${label} ${key}`, limit) && !printable(s[key] as string)) e.add(`${label}: ${key} must be single-line printable text`);
      }
    }
    if (kind === "closing" && c.style === "stickman") {
      for (const [key, limit] of [["bubble", 40], ["hl", 24]] as const) if (key in s) e.text(s[key], `${label} ${key}`, limit);
    }
    e.text(s.voice, `${label} voice`, 350);
    e.text(s.title, `${label} title`, 90);
    // The picture style paints the closing button inside a pill: it is shorter than the editorial one.
    for (const [key, limit] of [["eyebrow", 40], ["detail", 110], ["source", 80], ["button", c.style === "picture" ? CLOSING_BUTTON_MAX : 40]] as const) if (key in s) e.text(s[key], `${label} ${key}`, limit);
    if (!(VISUALS as readonly string[]).includes((s.visual ?? "focus") as string)) e.add(`${label}: unknown visual`);
    if (kind === "steps" || kind === "list" || kind === "compare") {
      const items = s.items;
      const n = kind === "compare" ? 2 : 3;
      if (!Array.isArray(items) || items.length !== n) e.add(`${label}: ${n} items required`);
      else for (const item of items) e.text(item, `${label} item`, 42);
    }
    if ("terminal_lines" in s) {
      const tl = s.terminal_lines;
      if (c.style !== "terminal" || !Array.isArray(tl) || tl.length < 1 || tl.length > 3) e.add(`${label}: terminal_lines requires terminal style and 1–3 lines`);
      else for (const item of tl) { if (e.text(item, `${label} terminal line`, 48) && !printable(item)) e.add(`${label}: terminal lines must be single-line printable text`); }
    }
    if ("animate_value" in s) {
      if (kind !== "metric" || !isBool(s.animate_value)) e.add(`${label}: animate_value must be a metric boolean`);
      else if (s.animate_value && !/^\d+(?:,\d{3})*(?:\.\d+)?[^\d]*$/.test(String(s.value ?? ""))) e.add(`${label}: animated value needs an English-formatted numeric prefix`);
    }
    if (kind === "metric") { e.text(s.value, `${label} value`, 12); e.text(s.unit, `${label} unit`, 45); }
    if (kind === "quote") e.text(s.quote, `${label} quote`, 120);
    if (kind === "closing" && s.button && s.detail) e.add(`${label}: use either a closing button or a detail line`);
    e.finite(s.hold ?? 0.65, 0.15, 3, `${label} hold`);
  });
  const last = scenes[scenes.length - 1];
  if (!isObj(last) || last.kind !== "closing") e.add("Last scene must be a closing");
}

/**
 * Validates a storyboard for a job. Collects up to 10 problems; never throws on bad input.
 * In style "picture" it also normalises in place: a scene-level image_prompt becomes shots[0], so the returned
 * storyboard is what gets stored and handed to the worker (no scene-level image_prompt survives).
 */
export function validateStoryboard(sb: unknown, opts: ValidateOptions): ValidateResult {
  const e = new Collector(opts.maxErrors ?? MAX_ERRORS);
  try { validateInner(sb, opts, e); } catch (err) { if (!(err instanceof TooMany)) throw err; }
  if (e.errors.length) return { ok: false, errors: e.errors };
  return { ok: true, storyboard: sb as Storyboard };
}

/** Kleo voice ids (templates.ts) → Kokoro voices. */
const KLEO_VOICES: Record<string, string> = { "narrator-en-m": "am_michael", "narrator-en-f": "af_heart", "narrator-it-m": "im_nicola", "narrator-it-f": "if_sara" };

/** Default Kokoro voice for a language and template; accepts a Kleo voice id or a Kokoro voice id as the preference. */
export function defaultVoice(language: string, templateId?: string, preferred?: string | null): string {
  const voices = VOICES[language] ?? VOICES.en;
  if (preferred) {
    const mapped = KLEO_VOICES[preferred] ?? preferred;
    if (voices.includes(mapped)) return mapped;
    // A voice of another language: keep the gender, switch the language.
    const male = /^(narrator-\w+-m|[a-z]m_)/.test(preferred);
    const byGender = voices.find((v) => (v[1] === "m") === male);
    if (byGender) return byGender;
  }
  const t = templateId ?? "";
  if (language === "en") {
    if (["viral-short", "reddit-story", "did-you-know", "cinematic-trailer", "motivational"].includes(t)) return "am_michael";
    if (t === "story-documentary") return "bf_emma";
    return "af_heart";
  }
  if (language === "it") return ["viral-short", "reddit-story", "did-you-know", "cinematic-trailer", "motivational"].includes(t) ? "im_nicola" : "if_sara";
  return voices[0];
}

/** Words of narration a duration can carry: ≈2.3 words/s at speed 1.1 (≈2.1 w/s at speed 1). */
export function wordBudget(duration_s: number, speed = 1.1): { target: number; min: number; max: number; wordsPerSecond: number } {
  const wps = 2.1 * speed;
  const target = Math.round(duration_s * wps);
  return { target, min: Math.round(target * 0.8), max: Math.round(target * 1.1), wordsPerSecond: Math.round(wps * 100) / 100 };
}
