/**
 * The explainer arm of the planner.
 *
 * Everything that is specific to the "explainer" look lives here — its brief, the rules the model is
 * given, the JSON schema it decodes into, the deterministic repairs, and the checks — so that
 * src/storyboard.ts only has to ask "is this the explainer?" and delegate.
 *
 * The part that matters is EXPLAINER_RULES. A hook and "entertainment" are usually written as advice
 * in a prompt, which is the same as not having them: nothing measures whether the film that comes back
 * actually opens with a hook, or whether anything moves after the first second. Here each one is a
 * function over the finished storyboard. What can be fixed by arithmetic is fixed (`repair`); what
 * needs the model to write differently comes back as `feedback` on the next attempt, in the words the
 * model has to act on. A rule nobody can check is a rule the model is free to ignore, and it does.
 */
import {
  SKETCH_ACCENTS, SKETCH_ART, SKETCH_DROP, SKETCH_ENTER, SKETCH_EXIT, SKETCH_MOODS, SKETCH_MOTION, quotesVoice,
} from "./keou-contract.ts";
import { narrativeFor } from "./templates.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const quoted = (a: readonly string[]) => a.join(" | ");

/* ------------------------------------------------------------------ the brief */

// THE NUMBERS LIVE IN src/templates.ts, once. They used to be here AND in the planner's briefs, which is two
// places to remember on the day the rhythm of a look changes — and the rhythm of a look changes often.
const SHORT = narrativeFor("explainer-short"), LONG = narrativeFor("explainer-long");
/** Words per scene. A Short's line is one breath; a long film's is a sentence you can follow while a drawing changes. */
export const EXPLAINER_WORDS: Record<"short" | "long", [number, number]> = { short: SHORT.wordsPerScene, long: LONG.wordsPerScene };
/** Seconds one drawing may hold the frame before the film stops moving. Measured against the reference Short. */
const SECONDS_PER_DRAWING: Record<"short" | "long", number> = { short: SHORT.shotSeconds, long: LONG.shotSeconds };
/** Speech rate the planner budgets with (words per second at speed 1.1), shared with wordBudget. */
const WPS = 2.6;

export const lengthOf = (duration: number): "short" | "long" => (duration <= 90 ? "short" : "long");

export const EXPLAINER_GUIDANCE: Record<"short" | "long", string> = { short: SHORT.guidance, long: LONG.guidance };

/* ------------------------------------------------------------------ the rules given to the model */

/** The prompt block. Printed from the enums, so the guide, the planner and the validator cannot disagree. */
export function explainerRules(format: string, duration: number): string {
  const [fw, fh] = format === "9:16" ? [1080, 1920] : [1920, 1080];
  const len = lengthOf(duration);
  const [lo, hi] = EXPLAINER_WORDS[len];
  return `Scenes are all kind "sketch" — there is no closing scene, no title card and no call to action: the film ends on its last drawing.
Hand-drawn white marker line art on pure black. The ONLY text on screen is the caption, burned in from the narration; nothing you write appears as a title.
SCENE: {"id":"01-hook","kind":"sketch","voice":"one narrated sentence of ${lo}-${hi} words - COUNT THEM","accent":<its section's accent>,"enter"?:${quoted(SKETCH_ENTER)},"exit"?:${quoted(SKETCH_EXIT)},"shot":{"zoom":[1,1.25],"focus":[x,y]},"art":[…],"hold"?:0.05}
  shot.zoom [start,end] with end GREATER than start — the camera never stops pushing in. focus is the point it pushes toward, in this frame's pixels (0-${fw} by 0-${fh}).
  exit "flare" blooms the accent out of the frame: use it once in the whole film, on the turn.
ART (2-8 per scene): {"name":<drawing>,"at":<words>,"until"?:<words>,"x"?:${Math.round(fw / 2)},"y"?:${Math.round(fh * .45)},"size"?:1,"motion"?:${quoted(SKETCH_MOTION)},"drawn"?:true,…}
  THE RULE THAT MAKES THIS LOOK WORK: one spoken phrase, one drawing, and the drawing is literally what the words say. "If you are worried" is a face with raised brows ({"name":"face","mood":"worried"}), not a mood. "They read the card" is a hand holding a card at a reader. Never a symbol where the thing itself can be drawn.
  x,y place it in this frame's pixels. A drawing is about 400 pixels tall at size 1 and needs that much clear space around its centre: put two side by side, not stacked, unless one is held or worn by the other. room/corridor/blank/reader fill the frame and everything else goes ON them. THE CAPTION OWNS THE BOTTOM OF THE FRAME — it is burned in from ${Math.round(fh * .78)} down — so keep y at or under ${Math.round(fh * .70)}: a drawing under the caption is a drawing the viewer reads words through.
  "at" is WHEN the drawing appears: quote 1-4 words copied EXACTLY from THAT scene's own voice line. Spread them across the line — the last drawing of a scene must land in the SECOND HALF of the sentence, or the picture stops moving while the voice keeps going.
  "until" (same form) is when it leaves; give one drawing an "until" and the next an "at" on the same words so they overlap and the frame is never empty.
  "drawn":true means it is already on the page at the first frame. The FIRST drawing of the FIRST scene must have it, or the film opens on black.
  Drawings: ${SKETCH_ART.join(", ")}.
  Extras: tint/led/beam/chip = an accent colour on the drawing or one part of it; mood (${quoted(SKETCH_MOODS)}) on "face"; count 1-12 on crowd/footprints/blank/chain; text (≤24, the only drawing that carries words) on "tag"; open/open_to on "door" and "lock"; reach on "figure"; flags no (crossed out or broken), sweat, xray, flash, flip, leader.
  Accents: ${quoted(SKETCH_ACCENTS)} — one per scene, never two in a frame.
THE LINE IS A SENTENCE, NOT A CAPTION. The caption on screen is made FROM the line automatically, word by word: you never write one. A line of three or four words is refused every time, and it is the single most common way this look is written wrongly.
  GOOD  "This looks like a normal hotel key card. It isn't."   (10 words)
  GOOD  "Read one card once, and the lock gives up its secret." (11 words)
  BAD   "Websites don't see passwords"                          (4 words - a caption, not a line)
  BAD   "Your password is safe"                                 (4 words - says nothing the next line can follow)
Every line must carry a fact, a name or a number that the line before it did not have.`;
}

/* ------------------------------------------------------------------ the schema it decodes into */

const str = { type: "string" };
/** Flat and closed: constrained decoding stays cheap, and a key the grammar invents cannot reach the validator. */
export function explainerSceneSchema(): Record<string, unknown> {
  const art = {
    type: "object",
    properties: {
      name: { type: "string", enum: [...SKETCH_ART] }, at: str, until: str, x: { type: "number" }, y: { type: "number" },
      size: { type: "number" }, motion: { type: "string", enum: [...SKETCH_MOTION] }, motion_over: { type: "number" },
      drawn: { type: "boolean" }, tint: { type: "string", enum: [...SKETCH_ACCENTS] }, led: { type: "string", enum: [...SKETCH_ACCENTS] },
      beam: { type: "string", enum: [...SKETCH_ACCENTS] }, chip: { type: "string", enum: [...SKETCH_ACCENTS] },
      mood: { type: "string", enum: [...SKETCH_MOODS] }, count: { type: "integer" }, text: str,
      open: { type: "number" }, open_to: { type: "number" }, swing_over: { type: "number" },
      no: { type: "boolean" }, sweat: { type: "boolean" }, xray: { type: "boolean" }, flash: { type: "boolean" },
      flip: { type: "boolean" }, leader: { type: "boolean" },
    },
    required: ["name"],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: {
      id: str, kind: { type: "string", enum: ["sketch"] }, voice: str, accent: { type: "string", enum: [...SKETCH_ACCENTS] },
      enter: { type: "string", enum: [...SKETCH_ENTER] }, exit: { type: "string", enum: [...SKETCH_EXIT] },
      shot: {
        type: "object",
        properties: { zoom: { type: "array", items: { type: "number" } }, focus: { type: "array", items: { type: "number" } } },
        required: ["zoom", "focus"], additionalProperties: false,
      },
      art: { type: "array", items: art }, hold: { type: "number" },
    },
    required: ["id", "kind", "voice", "accent", "shot", "art"],
    additionalProperties: false,
  };
}

/** cinema/direction accents → the five the marker draws with. The direction owns the rhythm; this owns the palette. */
const ACCENT_MAP: Record<string, string> = { red: "red", green: "green", cyan: "blue", blue: "blue", amber: "yellow", yellow: "yellow", white: "white" };
export const sketchAccent = (a: unknown): string => (typeof a === "string" && ACCENT_MAP[a]) || "white";

/* ------------------------------------------------------------------ deterministic repair */

const ART_SET = new Set<string>(SKETCH_ART);
/** Names models reach for that we can honour with a drawing we have, instead of dropping the element. */
const ART_SYNONYMS: Record<string, string> = {
  person: "figure", man: "figure", woman: "figure", human: "figure", people: "crowd", users: "crowd", crowd_of_people: "crowd",
  hacker: "intruder", attacker: "intruder", thief: "intruder", criminal: "intruder", stranger: "intruder",
  computer: "laptop", pc: "laptop", screen: "laptop", monitor: "laptop", terminal: "code", software: "code", program: "code",
  smartphone: "phone", mobile: "phone", app: "phone", tablet: "phone",
  wifi: "router", modem: "router", antenna: "signal", radio: "signal", waves: "signal", broadcast: "signal", bluetooth: "signal",
  padlock: "lock", password: "lock", encryption: "lock", security: "shield", firewall: "shield", antivirus: "shield", protection: "shield",
  virus: "bug", malware: "bug", ransomware: "bug", worm: "bug", trojan: "bug",
  email: "envelope", mail: "envelope", message: "envelope", letter: "envelope", phishing: "envelope",
  data: "folder", file: "folder", files: "folder", database: "server", datacenter: "server", rack: "server", cloud_server: "cloud",
  network: "graph", internet: "globe", world: "globe", earth: "globe", map: "globe", country: "city", town: "city", building: "city", office: "city",
  money: "coin", cash: "coin", dollar: "coin", euro: "coin", cost: "coin", price: "coin", payment: "coin", bank: "coin",
  time: "clock", timer: "clock", deadline: "calendar", date: "calendar", year: "calendar", day: "calendar",
  idea: "bulb", solution: "bulb", insight: "bulb", search: "magnifier", investigation: "magnifier", research: "magnifier",
  danger: "warning", alert: "warning", risk: "warning", problem: "warning", error: "warning",
  law: "book", rule: "book", policy: "book", manual: "book", documentation: "book", guide: "book",
  machine: "gear", process: "gear", system: "gear", mechanism: "gear", engine: "gear", ai: "brain", model: "brain", neural: "brain", algorithm: "brain",
  blockchain: "chain", link: "chain", supply_chain: "chain", growth: "chart", graph_line: "chart", statistics: "chart", numbers: "chart",
  launch: "rocket", startup: "rocket", vehicle: "car", truck: "car", nature: "tree", forest: "tree", climate: "tree",
  package: "box", parcel: "box", delivery: "box", container: "box", satellite_dish: "satellite", gps: "satellite",
  biometrics: "fingerprint", identity: "fingerprint", surveillance: "eye", privacy: "eye", watching: "eye",
  agreement: "handshake", deal: "handshake", partnership: "handshake", contract: "handshake",
  cctv: "camera", webcam: "camera", automation: "robot", bot: "robot", agent: "robot", drone: "robot",
  balance: "scale", tradeoff: "scale", comparison: "scale", choice: "scale", doubt: "question", mystery: "question", unknown: "question",
  cable: "usb", stick: "usb", drive: "usb", processor: "chip", silicon: "chip", hardware: "chip",
};
const artName = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (ART_SET.has(k)) return k;
  return ART_SYNONYMS[k] ?? ART_SYNONYMS[k.replace(/s$/, "")] ?? null;
};

/** A quotable run of 1-3 words starting at or after `frac` of the line: what an anchor becomes when the model's was wrong. */
export function anchorAt(voice: string, frac: number): string | null {
  const w = words(voice);
  if (w.length < 2) return null;
  for (let i = Math.min(w.length - 1, Math.max(1, Math.round(w.length * frac))); i < w.length; i++) {
    for (const n of [2, 3, 1]) {
      if (i + n > w.length) continue;
      const cand = w.slice(i, i + n).join(" ");
      if (cand.length <= 32 && quotesVoice(cand, voice)) return cand;
    }
  }
  return null;
}

const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
/**
 * Like `num`, but a value outside the range is REPLACED rather than clamped. It is the right answer for
 * exactly one field: the camera's focus point. Clamping a focus of 99999 gives the bottom edge of the
 * frame and the camera spends the scene pushing into a corner — the defect survives the repair, wearing
 * a legal number. A focus nobody meant belongs back in the middle of the picture.
 */
const inside = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;

/**
 * Everything an explainer scene can be corrected into instead of refused: the kind, the accent, a camera
 * that forgot to move, a focus point off the page, a drawing under another name, an anchor that quotes
 * words the scene never says. A retry spent on any of these is a retry not spent on the writing.
 */
export function repairExplainerScene(s: Record<string, unknown>, format: string, accent?: string): Record<string, unknown> {
  const [fw, fh] = format === "9:16" ? [1080, 1920] : [1920, 1080];
  s.kind = "sketch";
  for (const k of ["chapter", "eyebrow", "title", "hl", "detail", "source", "beats", "shots", "items", "value", "unit",
    "animate_value", "quote", "button", "visual", "act", "cast", "props", "fx", "bubble", "image_prompt"]) delete s[k];
  s.accent = accent ? sketchAccent(accent) : sketchAccent(s.accent);
  if (!(SKETCH_ENTER as readonly string[]).includes(s.enter as string)) delete s.enter;
  if (!(SKETCH_EXIT as readonly string[]).includes(s.exit as string)) delete s.exit;
  s.hold = num(s.hold, 0.05, 0.6, 0.05);

  const shot = isObj(s.shot) ? s.shot : {};
  const zr = Array.isArray(shot.zoom) ? shot.zoom : [];
  let z0 = num(zr[0], 0.6, 3, 1), z1 = num(zr[1], 0.6, 4, z0 + 0.22);
  if (z1 <= z0) z1 = Math.min(4, z0 + 0.22);           // the camera never stops pushing in, so give it somewhere to go
  const fr = Array.isArray(shot.focus) ? shot.focus : [];
  s.shot = { zoom: [z0, z1], focus: [inside(fr[0], 0, fw, fw / 2), inside(fr[1], 0, fh, Math.round(fh * 0.45))] };

  const voice = typeof s.voice === "string" ? s.voice : "";
  const raw = Array.isArray(s.art) ? s.art.filter(isObj) : [];
  const art: Record<string, unknown>[] = [];
  raw.forEach((a, i) => {
    const name = artName(a.name);
    if (!name) return;                                  // a drawing nobody can draw is worse than one fewer drawing
    a.name = name;
    for (const key of ["at", "until"] as const) {
      const v = a[key];
      if (typeof v === "number") { a[key] = Math.min(key === "at" ? 0.95 : 1, Math.max(0, v)); continue }
      if (typeof v !== "string") { delete a[key]; continue }
      if (v.length > 32 || !quotesVoice(v, voice)) {
        // The model quoted words this scene does not say. Rather than a round trip, put the cut where it belongs:
        // spread over the line by position, later drawings later.
        const fixed = anchorAt(voice, raw.length > 1 ? 0.15 + (0.7 * i) / Math.max(1, raw.length - 1) : 0.4);
        if (fixed) a[key] = fixed; else delete a[key];
      }
    }
    if (typeof a.at === "string" && typeof a.until === "string" && a.at === a.until) delete a.until;
    if ("x" in a) a.x = num(a.x, -fw * 0.4, fw * 1.4, fw / 2);
    if ("size" in a) a.size = num(a.size, 0.1, 6, 1);
    if ("y" in a) {
      a.y = num(a.y, -fh * 0.25, fh * 1.25, Math.round(fh * 0.45));
      // The caption owns the bottom of the frame and the validator refuses a drawing that sits under it.
      // Lifting it is arithmetic — the author meant "low", not "behind the words" — so it costs nothing
      // here and a whole retry there.
      const drop = (SKETCH_DROP[a.name as string] ?? 250) * (typeof a.size === "number" ? a.size : 1) * 0.75;
      a.y = Math.min(a.y as number, Math.round(fh * 0.78 - drop));
    }
    if ("motion" in a && !(SKETCH_MOTION as readonly string[]).includes(a.motion as string)) delete a.motion;
    if ("motion_over" in a) a.motion_over = num(a.motion_over, 0.1, 4, 0.7);
    if ("mood" in a && !(SKETCH_MOODS as readonly string[]).includes(a.mood as string)) delete a.mood;
    if ("count" in a) a.count = Math.round(num(a.count, 1, 12, 4));
    for (const key of ["tint", "led", "beam", "chip"] as const)
      if (key in a && !(SKETCH_ACCENTS as readonly string[]).includes(a[key] as string)) delete a[key];
    for (const key of ["open", "open_to"] as const) if (key in a) a[key] = num(a[key], 0, 1, 0.5);
    if ("swing_over" in a) a.swing_over = num(a.swing_over, 0.2, 3, 1);
    if ("text" in a) { const tx = String(a.text ?? "").slice(0, 24).trim(); if (tx && a.name === "tag") a.text = tx; else delete a.text }
    for (const flag of ["no", "sweat", "xray", "flash", "flip", "leader"] as const) if (flag in a && typeof a[flag] !== "boolean") delete a[flag];
    if ("reach" in a && !(Array.isArray(a.reach) && a.reach.length === 2)) delete a.reach;
    art.push(a);
  });
  // A scene with nothing to draw still has to show something: the frame is never allowed to be empty.
  if (!art.length) art.push({ name: "question", drawn: true });
  s.art = art.slice(0, 8);
  return s;
}

/* ------------------------------------------------------------------ the rules, as functions */

export interface Violation { rule: string; scene: number | null; message: string }
interface RuleCtx { scenes: Record<string, unknown>[]; len: "short" | "long"; language: string; duration: number }
export interface ExplainerRule {
  id: string;
  /** What it is for, in one line — printed by the docs and by the sweep report. */
  why: string;
  check(c: RuleCtx): Violation[];
}

const voiceOf = (s: Record<string, unknown>) => (typeof s.voice === "string" ? s.voice : "");
const artOf = (s: Record<string, unknown>) => (Array.isArray(s.art) ? (s.art.filter(isObj) as Record<string, unknown>[]) : []);
/** Seconds the narration of a scene takes, plus its hold: the same arithmetic run.py bills. */
const secondsOf = (s: Record<string, unknown>) => words(voiceOf(s)).length / WPS + num(s.hold, 0, 3, 0.05);

/** A hook is not a mood. Each family is a shape a first line can have, in the three languages Kleo speaks. */
const HOOK: Record<string, RegExp[]> = {
  en: [/\b(you|your|yours)\b/i, /\b(isn't|is not|aren't|doesn't|don't|won't|can't|never|nobody|nothing)\b/i, /\?/, /\b\d|\b(one|two|three|ten|hundred|thousand|million|billion)\b/i, /\b(stop|look|listen|imagine|watch|forget)\b/i, /^\W*(this|that|these|those|here)\b/i],
  it: [/\b(tu|tuo|tua|tuoi|tue|ti|vi|vostro)\b/i, /\b(non|nessuno|niente|mai)\b/i, /\?/, /\b\d|\b(uno|due|tre|dieci|cento|mille|milioni|miliardi)\b/i, /\b(guarda|ascolta|immagina|fermati|smetti)\b/i, /^\W*(questo|questa|questi|queste|ecco)\b/i],
  fr: [/\b(tu|ton|ta|tes|votre|vos|vous)\b/i, /\b(ne|n'|pas|jamais|personne|rien)\b/i, /\?/, /\b\d|\b(un|deux|trois|dix|cent|mille|millions|milliards)\b/i, /\b(regarde|écoute|imagine|arrête)\b/i, /^\W*(ce|cet|cette|ces|voici|voilà)\b/i],
};
/** The sentence that turns the film: without one somewhere early, a Short is a list of facts. */
const TURN: Record<string, RegExp> = {
  en: /\b(but|actually|except|until|however|instead|isn't|wasn't|turns out|the problem)\b/i,
  it: /\b(ma|però|invece|tranne|finché|in realtà|il problema)\b/i,
  fr: /\b(mais|sauf|jusqu'à|en fait|pourtant|le problème)\b/i,
};
/** What the last line owes the viewer: a question that sends them back, or something to do. */
const PAYOFF: Record<string, RegExp> = {
  en: /\?|\b(you|your|check|change|turn off|stop|never|always|ask)\b/i,
  it: /\?|\b(tu|tuo|tua|controlla|cambia|spegni|smetti|chiedi|mai|sempre)\b/i,
  fr: /\?|\b(tu|ton|ta|votre|vérifie|change|éteins|arrête|demande|jamais|toujours)\b/i,
};
const pat = <T,>(m: Record<string, T>, lang: string): T => m[lang] ?? m.en;
/** The drawings that stand for an idea rather than a thing: fine in the middle, wrong as the opening image. */
const ABSTRACT = new Set(["question", "warning", "blank", "tag", "chart", "graph", "scale"]);

export const EXPLAINER_RULES: ExplainerRule[] = [
  {
    id: "hook-shape",
    why: "The first line has to take something away from the viewer, point at the thing, ask them something, or put a number in front of them.",
    check: ({ scenes, language }) => {
      const v = voiceOf(scenes[0] ?? {});
      const hits = pat(HOOK, language).filter((re) => re.test(v)).length;
      return hits >= 2 ? [] : [{ rule: "hook-shape", scene: 1, message: `scene 1 is not a hook. Rewrite the first line so it does at least TWO of: speaks to the viewer ("you", "your"), contradicts what they believe ("it is not"), points at the thing on screen ("this looks like a normal key card"), asks them a question, states a number, or tells them to do something. It currently reads "${v}".` }];
    },
  },
  {
    id: "hook-length",
    why: "A hook that has not landed by the third second has not landed.",
    check: ({ scenes, len }) => {
      const max = len === "short" ? 14 : 20, n = words(voiceOf(scenes[0] ?? {})).length;
      return n <= max ? [] : [{ rule: "hook-length", scene: 1, message: `scene 1 is ${n} words; the opening line must be ${max} words or fewer. Cut it to one sentence that says the surprising thing and nothing else.` }];
    },
  },
  {
    id: "hook-drawn",
    why: "A film that fades in from black has already been swiped past.",
    check: ({ scenes }) => (artOf(scenes[0] ?? {}).some((a) => a.drawn === true) ? [] : [{ rule: "hook-drawn", scene: 1, message: `the first drawing of scene 1 needs "drawn": true, or the video opens on an empty black frame.` }]),
  },
  {
    id: "hook-object",
    why: "The viewer must see the thing being talked about, not a symbol standing in for it.",
    check: ({ scenes }) => {
      const art = artOf(scenes[0] ?? {});
      return art.some((a) => typeof a.name === "string" && !ABSTRACT.has(a.name)) ? []
        : [{ rule: "hook-object", scene: 1, message: `scene 1 draws only symbols (${art.map((a) => a.name).join(", ")}). Open on the actual object the video is about — the thing the viewer owns, holds or uses.` }];
    },
  },
  {
    id: "art-count",
    why: "Two drawings per scene is the difference between a film and a slideshow with a voice over it.",
    check: ({ scenes }) => scenes.flatMap((s, i) => (artOf(s).length >= 2 ? [] : [{ rule: "art-count", scene: i + 1, message: `scene ${i + 1} has ${artOf(s).length} drawing(s). Every scene needs at least two, each illustrating a different phrase of its own line.` }])),
  },
  {
    id: "art-pace",
    why: "One drawing may hold the frame for about two seconds. Longer and the viewer is listening to a podcast.",
    check: ({ scenes, len }) => {
      const cap = SECONDS_PER_DRAWING[len];
      return scenes.flatMap((s, i) => {
        const per = secondsOf(s) / Math.max(1, artOf(s).length);
        return per <= cap ? [] : [{ rule: "art-pace", scene: i + 1, message: `scene ${i + 1} holds one drawing for ${per.toFixed(1)}s (the limit is ${cap}s). Either add a drawing for a later phrase of the line, or make the line shorter.` }];
      });
    },
  },
  {
    id: "cue-spread",
    why: "If every drawing lands in the first second, the rest of the sentence plays over a still.",
    check: ({ scenes }) => scenes.flatMap((s, i) => {
      const v = voiceOf(s), w = words(v), art = artOf(s);
      if (art.length < 2 || w.length < 6) return [];
      const half = w.slice(Math.ceil(w.length / 2)).join(" ");
      const late = art.some((a) => (typeof a.at === "string" && quotesVoice(a.at, half)) || (typeof a.at === "number" && a.at >= 0.45));
      return late ? [] : [{ rule: "cue-spread", scene: i + 1, message: `every drawing in scene ${i + 1} appears in the first half of the line. Give the last one an "at" quoting words from the second half: "${half}".` }];
    }),
  },
  {
    id: "motion",
    why: "Something has to be moving other than the camera.",
    check: ({ scenes }) => scenes.flatMap((s, i) => {
      const art = artOf(s);
      const alive = art.some((a) => typeof a.motion === "string" || typeof a.at === "string" || typeof a.until === "string" || a.flash === true || a.no === true || typeof a.open === "number" || typeof a.open_to === "number");
      return alive ? [] : [{ rule: "motion", scene: i + 1, message: `nothing happens in scene ${i + 1}: no drawing has a "motion", an "at" or an "until". Give at least one of them something to do while the line is spoken.` }];
    }),
  },
  {
    id: "variety",
    why: "The same picture three scenes running reads as a stuck video.",
    check: ({ scenes }) => {
      const out: Violation[] = [];
      for (let i = 2; i < scenes.length; i++) {
        const n = [i - 2, i - 1, i].map((j) => artOf(scenes[j])[0]?.name);
        if (n[0] && n[0] === n[1] && n[1] === n[2]) out.push({ rule: "variety", scene: i + 1, message: `scenes ${i - 1}, ${i} and ${i + 1} all open on "${n[0]}". Change one of them: the drawings are the only thing the viewer is watching.` });
      }
      return out;
    },
  },
  {
    id: "turn",
    why: "A film with no reversal in the first third is a list, and lists do not hold anyone.",
    check: ({ scenes, language }) => {
      const third = Math.max(2, Math.ceil(scenes.length / 3));
      const re = pat(TURN, language);
      return scenes.slice(0, third).some((s) => re.test(voiceOf(s))) ? []
        : [{ rule: "turn", scene: null, message: `nothing turns in the first ${third} scenes. One of them has to break the expectation the hook set — the line where "but", "except" or "it turns out" belongs.` }];
    },
  },
  {
    id: "payoff",
    why: "The last line either sends the viewer back to the start or tells them what to do.",
    check: ({ scenes, language }) => {
      const v = voiceOf(scenes[scenes.length - 1] ?? {});
      return pat(PAYOFF, language).test(v) ? []
        : [{ rule: "payoff", scene: scenes.length, message: `the last line does not land: "${v}". End on a question that sends the viewer back to the start, or on the one thing they should do now.` }];
    },
  },
  {
    id: "word-window",
    why: "One breath per scene. Longer lines make the drawing wait; shorter ones make the cut feel nervous.",
    check: ({ scenes, len }) => {
      const [lo, hi] = EXPLAINER_WORDS[len];
      return scenes.flatMap((s, i) => {
        const n = words(voiceOf(s)).length;
        return n >= lo && n <= hi ? [] : [{ rule: "word-window", scene: i + 1, message: `scene ${i + 1} is ${n} words; every line must be ${lo}-${hi}. ${n < lo ? "Say more in it" : "Split it or cut it"}.` }];
      });
    },
  },
  {
    id: "colour",
    why: "One accent for a whole film is a black-and-white film; the colour is how the viewer reads the structure.",
    check: ({ scenes, len }) => {
      const used = new Set(scenes.map((s) => (typeof s.accent === "string" ? s.accent : "white")));
      const need = len === "short" ? 2 : 3;
      return used.size >= need ? [] : [{ rule: "colour", scene: null, message: `the whole film wears ${[...used].join(", ")}. It needs at least ${need} different accents — red for the threat, blue for the attacker's signal, green for what is fine, yellow for scale and money.` }];
    },
  },
];

/** Every violation, in scene order. `feedback` on the next attempt is exactly these messages. */
export function checkExplainer(scenes: unknown, opts: { duration: number; language: string }): Violation[] {
  const list = Array.isArray(scenes) ? (scenes.filter(isObj) as Record<string, unknown>[]) : [];
  if (!list.length) return [{ rule: "empty", scene: null, message: "the storyboard has no scenes" }];
  const c: RuleCtx = { scenes: list, len: lengthOf(opts.duration), language: opts.language, duration: opts.duration };
  return EXPLAINER_RULES.flatMap((r) => r.check(c)).sort((a, b) => (a.scene ?? 99) - (b.scene ?? 99));
}

/**
 * What arithmetic can fix, before anyone is asked to write again: the opening drawing that is not on the
 * page at frame zero, and the scene whose drawings all land in the first half of its own line.
 */
export function repairExplainer(scenes: unknown, format: string): void {
  const list = Array.isArray(scenes) ? (scenes.filter(isObj) as Record<string, unknown>[]) : [];
  if (!list.length) return;
  const first = artOf(list[0]);
  if (first.length && !first.some((a) => a.drawn === true)) { first[0].drawn = true; delete first[0].at }
  for (const s of list) {
    const v = voiceOf(s), w = words(v), art = artOf(s);
    if (art.length < 2 || w.length < 6) continue;
    const half = w.slice(Math.ceil(w.length / 2)).join(" ");
    if (art.some((a) => (typeof a.at === "string" && quotesVoice(a.at, half)) || (typeof a.at === "number" && a.at >= 0.45))) continue;
    const late = anchorAt(v, 0.55);
    if (late) art[art.length - 1].at = late;
  }
}
