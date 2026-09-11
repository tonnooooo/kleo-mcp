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
  x,y place it in this frame's pixels. A drawing is about 420 wide and 383 tall at size 1, so two of them want 450 pixels between their centres or they overlap and read as one broken object. Overlap only when you mean it, as a hand ON a card. room/corridor/blank/reader/city/hotels ARE the space the others stand in, and everything goes ON those. THE CAPTION OWNS THE BOTTOM OF THE FRAME — it is burned in from ${Math.round(fh * .78)} down — so keep y at or under ${Math.round(fh * .70)}: a drawing under the caption is a drawing the viewer reads words through.
  "at" is WHEN the drawing appears: quote 1-4 words copied EXACTLY from THAT scene's own voice line. Spread them across the line — the last drawing of a scene must land in the SECOND HALF of the sentence, or the picture stops moving while the voice keeps going.
  "until" (same form) is when it leaves; give one drawing an "until" and the next an "at" on the same words so they overlap and the frame is never empty.
  "drawn":true means it is already on the page at the first frame. The FIRST drawing of the FIRST scene must have it, or the film opens on black.
  Drawings: ${SKETCH_ART.join(", ")}.
  Extras: tint/led/beam/chip = an accent colour on the drawing or one part of it; mood (${quoted(SKETCH_MOODS)}) on "face"; count 1-12 on crowd/footprints/blank/chain; text (≤24, the only drawing that carries words) on "tag"; open/open_to on "door" and "lock"; reach on "figure"; flags no (crossed out or broken), sweat, xray, flash, flip, leader.
  Accents: ${quoted(SKETCH_ACCENTS)} — one per scene, never two in a frame.
THE LINE IS A SENTENCE, NOT A CAPTION. The caption on screen is made FROM the line automatically, word by word: you never write one. A line of three or four words is refused every time, and it is the single most common way this look is written wrongly. Count the words in the language you are writing in, not in English.
  GOOD  "This looks like a normal hotel key card. It isn't."   (10 words)
  GOOD  "Read one card once, and the lock gives up its secret." (11 words)
  BAD   "Websites don't see passwords"                          (4 words - a caption, not a line)
Every line must carry a fact, a name or a number that the line before it did not have, and no line may repeat what an earlier one said.
One of the first three lines must TURN: say what the viewer expects, then take it away — "but", "except", "it turns out", "never".
Every scene must draw at least one thing its own line NAMES. If the line says "cable", one drawing is the cable.
`;
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
  en: /\b(but|actually|except|until|however|instead|isn't|wasn't|turns out|the problem|never|nobody|nothing|no longer)\b/i,
  it: /\b(ma|però|invece|tranne|finché|in realtà|il problema|mai|nessuno|niente|non è|non ha)\b/i,
  fr: /\b(mais|sauf|jusqu'à|en fait|pourtant|le problème|jamais|personne|rien|n'est pas)\b/i,
};
/** What the last line owes the viewer: a question that sends them back, or something to do. */
const PAYOFF: Record<string, RegExp> = {
  en: /\?|\b(you|your|check|change|turn off|stop|never|always|ask)\b/i,
  it: /\?|\b(tu|tuo|tua|controlla|cambia|spegni|smetti|chiedi|mai|sempre)\b/i,
  fr: /\?|\b(tu|ton|ta|votre|vérifie|change|éteins|arrête|demande|jamais|toujours)\b/i,
};
const pat = <T,>(m: Record<string, T>, lang: string): T => m[lang] ?? m.en;
/**
 * WHICH SPOKEN WORDS NAME WHICH DRAWING.
 *
 * The founding rule of this look is "one phrase, one drawing, and the drawing is literally what the words
 * say". It was prose in the prompt and nothing checked it, so the real model answered a line about a
 * charging cable by drawing a crowd, and three readers all noticed before any rule did.
 *
 * This is that rule made checkable: for each of the fifty-nine drawings, the words a narrator would
 * actually SAY that mean "draw this", in the three languages Kleo speaks. Drafted per family and then
 * audited for collisions: eighty-six words were claimed by more than one drawing. Fourteen of those were
 * too generic to name anything and were dropped from all of them. The other seventy-two were KEPT by every
 * claimant, on purpose — the rule below only asks whether ONE drawing in a scene is named, so a shared word
 * can only make it more forgiving, never wrong. Removing them cost a false accusation immediately: two
 * "figure" drawings for the line "two people can steal a car" is correct art, and an index where only
 * "crowd" may own "people" called it a mistake.
 *
 * It is deliberately not exhaustive. A drawing with no word in the line is allowed as long as ANOTHER
 * drawing in the same scene is named: the rule asks that the scene draw what it says, not that every
 * drawing be a noun the narrator pronounced.
 */
const SKETCH_WORDS: Record<string, { en: string[]; it: string[]; fr: string[] }> = {
  bell: { en: ["bell", "bells", "alarm", "alarms", "alarm bell", "alert", "alerts", "siren", "rings", "ringing", "rang", "warning", "sounds the alarm", "alarm goes off", "red alert"], it: ["campanello", "campana", "campanello d allarme", "allarme", "allarmi", "allerta", "avviso", "avvisi", "sirena", "suona", "squilla", "suona l allarme", "scatta l allarme", "avvertimento", "notifica"], fr: ["cloche", "sonnette", "alarme", "alarmes", "alerte", "alertes", "sir\u00e8ne", "sonne", "sonnerie", "retentit", "d\u00e9clenche l alarme", "sonne l alarme", "avertissement", "notification"] },
  blank: { en: ["blank", "blanks", "empty", "nothing", "none", "zero", "not a single", "no results", "missing", "absent", "wiped", "cleared", "emptied", "nil", "not one"], it: ["vuoto", "vuote", "in bianco", "bianche", "niente", "nulla", "zero", "nessuno", "nessuna", "mancante", "manca", "assente", "cancellato", "svuotato", "neanche uno"], fr: ["vide", "vides", "blanc", "blanche", "rien", "z\u00e9ro", "aucun", "aucune", "manquant", "manque", "absent", "effac\u00e9", "vid\u00e9", "pas un seul"] },
  book: { en: ["rule", "rules", "law", "laws", "legal", "illegal", "regulation", "regulations", "policy", "forbidden", "banned", "allowed", "book", "manual", "handbook", "rulebook", "by law", "terms and conditions"], it: ["regola", "regole", "legge", "leggi", "legale", "illegale", "normativa", "norme", "regolamento", "vietato", "divieto", "consentito", "libro", "manuale", "per legge", "secondo la legge"], fr: ["r\u00e8gle", "r\u00e8gles", "loi", "lois", "l\u00e9gal", "ill\u00e9gal", "r\u00e9glementation", "r\u00e8glement", "norme", "interdit", "interdiction", "autoris\u00e9", "livre", "manuel", "selon la loi"] },
  box: { en: ["box", "boxes", "parcel", "parcels", "package", "packages", "carton", "cardboard box", "crate", "container", "shipment", "shipping", "delivery", "delivered", "courier", "couriers", "delivery driver", "postman", "post office"], it: ["scatola", "scatole", "scatolone", "pacco", "pacchi", "pacchetto", "cartone", "cassa", "container", "spedizione", "spedizioni", "consegna", "consegne", "imballaggio", "corriere", "corrieri", "postino", "ufficio postale"], fr: ["bo\u00eete", "bo\u00eetes", "carton", "cartons", "colis", "paquet", "paquets", "caisse", "conteneur", "emballage", "exp\u00e9dition", "envoi", "livraison", "livr\u00e9", "coursier", "livreur", "livreurs", "facteur"] },
  brain: { en: ["brain", "mind", "thinks", "thinking", "thought", "memory", "remembers", "learns", "neurons", "idea", "consciousness", "mental", "understands"], it: ["cervello", "mente", "pensa", "pensiero", "ragiona", "memoria", "ricorda", "impara", "neuroni", "idea", "coscienza", "mentale", "capisce"], fr: ["cerveau", "esprit", "pense", "pens\u00e9e", "r\u00e9fl\u00e9chit", "m\u00e9moire", "se souvient", "apprend", "neurones", "id\u00e9e", "conscience", "mental", "comprend"] },
  bug: { en: ["bug", "bugs", "malware", "virus", "viruses", "trojan", "worm", "spyware", "ransomware", "keylogger", "rootkit", "infected", "infects", "infection", "malicious software", "malicious code"], it: ["virus", "malware", "trojan", "worm", "spyware", "ransomware", "keylogger", "insetto", "infetto", "infettato", "infetta", "infezione", "software malevolo", "codice malevolo", "programma dannoso"], fr: ["virus", "malware", "logiciel malveillant", "cheval de troie", "ver", "spyware", "logiciel espion", "ran\u00e7ongiciel", "ransomware", "insecte", "infect\u00e9", "infecte", "infection", "code malveillant"] },
  bulb: { en: ["idea", "ideas", "lightbulb", "light bulb", "insight", "brainwave", "invention", "invented", "eureka", "figured it out", "came up with", "realized", "genius", "inspiration", "brainstorm", "solution"], it: ["idea", "idee", "lampadina", "intuizione", "invenzione", "inventato", "eureka", "ha capito", "venuta in mente", "geniale", "genio", "ispirazione", "trovata", "soluzione", "brainstorming"], fr: ["id\u00e9e", "id\u00e9es", "ampoule", "intuition", "invention", "invent\u00e9", "eur\u00eaka", "il a compris", "trouv\u00e9", "g\u00e9nial", "g\u00e9nie", "inspiration", "illumination", "solution", "brainstorming"] },
  calendar: { en: ["date", "dates", "day", "days", "week", "weeks", "month", "months", "year", "years", "calendar", "schedule", "appointment", "tomorrow", "yesterday", "every day", "annual", "what day", "daily", "weekly", "monthly", "every single day", "deadline", "birthday"], it: ["data", "date", "giorno", "giorni", "settimana", "settimane", "mese", "mesi", "anno", "anni", "calendario", "agenda", "appuntamento", "domani", "ieri", "ogni giorno", "annuale", "che giorno", "quotidiano", "quotidianamente", "settimanale", "mensile", "ogni singolo giorno", "scadenza", "compleanno"], fr: ["date", "dates", "jour", "jours", "semaine", "semaines", "mois", "ann\u00e9e", "ann\u00e9es", "calendrier", "agenda", "rendez vous", "demain", "hier", "chaque jour", "annuel", "quel jour", "quotidien", "tous les jours", "hebdomadaire", "mensuel", "échéance", "anniversaire"] },
  camera: { en: ["camera", "cameras", "security camera", "security cameras", "cctv", "surveillance camera", "surveillance", "webcam", "lens", "camera lens", "filming", "films", "footage"], it: ["telecamera", "telecamere", "fotocamera", "videocamera", "webcam", "videosorveglianza", "sorveglianza", "cctv", "filma", "riprende", "inquadra", "filmato di sorveglianza"], fr: ["camera", "cam\u00e9ra", "cam\u00e9ras", "webcam", "appareil photo", "camera de surveillance", "cam\u00e9ra de surveillance", "videosurveillance", "vid\u00e9osurveillance", "surveillance", "cctv", "filme", "filmer"] },
  car: { en: ["car", "cars", "vehicle", "vehicles", "automobile", "auto", "tesla", "electric car", "ev"], it: ["auto", "automobile", "automobili", "macchina", "macchine", "veicolo", "veicoli", "tesla", "auto elettrica", "vettura"], fr: ["voiture", "voitures", "auto", "automobile", "vehicule", "v\u00e9hicule", "v\u00e9hicules", "tesla", "voiture electrique", "voiture \u00e9lectrique", "bagnole"] },
  chain: { en: ["chain", "chains", "chained", "link", "links", "linked", "blockchain", "on chain", "supply chain", "chain reaction", "tied together", "bound", "attached", "hyperlink", "clickable link"], it: ["catena", "catene", "concatenato", "anello", "anelli", "maglia", "blockchain", "catena di fornitura", "reazione a catena", "legato", "vincolato", "attaccato", "collegamento", "collegamenti", "link"], fr: ["cha\u00eene", "cha\u00eenes", "encha\u00een\u00e9", "maillon", "maillons", "blockchain", "cha\u00eene de blocs", "cha\u00eene d'approvisionnement", "r\u00e9action en cha\u00eene", "li\u00e9", "attach\u00e9", "ligot\u00e9", "lien", "liens", "hyperlien"] },
  chart: { en: ["chart", "charts", "curve", "trend", "trending", "growth", "grows", "rising", "rises", "climbing", "falls", "drops", "decline", "spike", "statistics", "the numbers"], it: ["grafico", "grafici", "curva", "andamento", "tendenza", "trend", "crescita", "cresce", "sale", "aumenta", "scende", "cala", "calo", "picco", "statistiche", "i numeri"], fr: ["graphique", "graphiques", "courbe", "tendance", "croissance", "augmente", "monte", "grimpe", "chute", "baisse", "d\u00e9clin", "pic", "statistiques", "les chiffres"] },
  chip: { en: ["chip", "chips", "microchip", "processor", "processors", "cpu", "silicon", "silicon chip", "semiconductor", "circuit", "transistor"], it: ["chip", "microchip", "processore", "processori", "microprocessore", "cpu", "silicio", "chip di silicio", "semiconduttore", "circuito", "transistor"], fr: ["puce", "puces", "puce electronique", "puce \u00e9lectronique", "microprocesseur", "processeur", "cpu", "silicium", "semi conducteur", "circuit", "transistor"] },
  city: { en: ["city", "cities", "town", "towns", "skyline", "downtown", "urban", "metropolis", "city centre", "city center", "skyscrapers", "neighborhood"], it: ["citt\u00e0", "cittadina", "in citt\u00e0", "centro citt\u00e0", "centro urbano", "urbano", "urbana", "metropoli", "skyline", "grattacieli", "quartiere"], fr: ["ville", "villes", "en ville", "centre ville", "urbain", "urbaine", "m\u00e9tropole", "agglom\u00e9ration", "gratte ciel", "quartier"] },
  clock: { en: ["time", "seconds", "minutes", "hours", "clock", "timer", "countdown", "how long", "takes", "delay", "instant", "instantly", "waiting", "waits", "in real time", "milliseconds", "timestamp", "timestamps", "what time", "how often", "duration", "hour", "minute"], it: ["tempo", "secondi", "minuti", "ore", "orologio", "timer", "conto alla rovescia", "quanto ci mette", "ritardo", "istante", "subito", "aspetta", "attesa", "in tempo reale", "millisecondi", "che ora", "quante volte", "durata", "orario", "minuto"], fr: ["temps", "secondes", "minutes", "heures", "horloge", "chrono", "compte \u00e0 rebours", "combien de temps", "retard", "instant", "tout de suite", "attendre", "attente", "en temps r\u00e9el", "millisecondes", "quelle heure", "heure", "durée", "horodatage", "combien de fois"] },
  cloud: { en: ["cloud", "the cloud", "clouds", "online", "server", "servers", "hosting", "hosted", "saas", "upload", "uploads", "sync", "syncs", "remote", "icloud", "drive"], it: ["cloud", "nuvola", "in cloud", "online", "server", "hosting", "saas", "caricare", "carica", "upload", "sincronizza", "sincronizzazione", "remoto", "icloud", "drive"], fr: ["cloud", "nuage", "dans le cloud", "en ligne", "serveur", "serveurs", "h\u00e9berg\u00e9", "saas", "t\u00e9l\u00e9verser", "synchroniser", "synchronisation", "distant", "icloud", "drive"] },
  code: { en: ["code", "source code", "codebase", "script", "scripts", "program", "programming", "programmer", "developer", "software", "coding", "compile", "lines of code", "syntax", "algorithm", "api"], it: ["codice", "codice sorgente", "script", "programma", "programmazione", "programmare", "programmatore", "sviluppatore", "software", "compilare", "riga di codice", "righe di codice", "algoritmo", "api"], fr: ["code", "code source", "script", "programme", "programmation", "programmeur", "d\u00e9veloppeur", "logiciel", "coder", "compiler", "ligne de code", "lignes de code", "algorithme", "api"] },
  coin: { en: ["money", "coin", "coins", "cash", "price", "cost", "costs", "pay", "pays", "paid", "payment", "expensive", "cheap", "dollars", "euros", "fee", "cents", "budget"], it: ["soldi", "denaro", "moneta", "monete", "prezzo", "costo", "costa", "pagare", "paga", "pagato", "pagamento", "costoso", "caro", "economico", "euro", "centesimi", "spesa", "budget"], fr: ["argent", "monnaie", "prix", "co\u00fbt", "co\u00fbte", "payer", "paye", "pay\u00e9", "paiement", "cher", "co\u00fbteux", "pas cher", "euros", "centimes", "d\u00e9pense", "budget"] },
  corridor: { en: ["corridor", "corridors", "hallway", "hallways", "hall", "passage", "passageway", "aisle", "walkway", "down the hall", "along the corridor", "at the end of the corridor"], it: ["corridoio", "corridoi", "passaggio", "passaggi", "corsia", "corsie", "andito", "disimpegno", "lungo il corridoio", "in corridoio", "in fondo al corridoio"], fr: ["couloir", "couloirs", "corridor", "corridors", "passage", "coursive", "d\u00e9gagement", "long couloir", "dans le couloir", "au bout du couloir"] },
  crowbar: { en: ["crowbar", "pry", "pries", "prying", "break in", "breaks in", "break-in", "broke in", "forced entry", "forces open", "forced", "intrusion", "intruder", "burglar", "burglary", "breach", "brute force"], it: ["piede di porco", "leva", "scasso", "scassinare", "scassinato", "forzare", "forzato", "forzatura", "effrazione", "irruzione", "intrusione", "intruso", "ladro", "scardinare", "entra con la forza", "forza bruta"], fr: ["pied de biche", "levier", "forcer", "forc\u00e9", "force la porte", "fracturer", "effraction", "cambriolage", "cambrioleur", "intrusion", "intrus", "s introduit", "d\u00e9foncer", "force brute"] },
  crowd: { en: ["crowd", "crowds", "people", "everyone", "everybody", "users", "millions", "masses", "audience", "population", "group", "society", "community", "all of us", "anyone", "anybody", "strangers", "customers", "clients", "passengers", "thousands", "billions"], it: ["folla", "gente", "persone", "tutti", "utenti", "milioni", "massa", "pubblico", "popolazione", "gruppo", "societ\u00e0", "comunit\u00e0", "chiunque", "sconosciuti", "clienti", "passeggeri", "migliaia", "miliardi"], fr: ["foule", "gens", "personnes", "tout le monde", "utilisateurs", "millions", "masse", "public", "population", "groupe", "soci\u00e9t\u00e9", "communaut\u00e9", "quiconque", "inconnus", "clients", "passagers", "milliers", "milliards"] },
  door: { en: ["door", "doors", "doorway", "front door", "entrance", "entry", "exit", "open the door", "opens", "knock", "threshold", "gateway", "gate", "access", "way in", "login", "log in", "logs in", "logged in", "sign in", "signs in", "sign up", "let in", "lets you in", "gets in"], it: ["porta", "porte", "portone", "portoncino", "porta principale", "ingresso", "entrata", "uscita", "soglia", "apre la porta", "bussa", "accesso", "varco", "accedi", "accede", "accedere", "login", "fa entrare", "registrarsi", "iscriviti"], fr: ["porte", "portes", "portail", "porte principale", "entr\u00e9e", "entrer", "sortie", "seuil", "ouvre la porte", "frappe \u00e0 la porte", "acc\u00e8s", "franchir la porte", "connexion", "se connecte", "se connecter", "laisse entrer", "inscription"] },
  envelope: { en: ["email", "emails", "mail", "inbox", "message", "messages", "letter", "envelope", "newsletter", "spam", "phishing", "writes back", "reply", "send", "sends", "sent", "sending", "sender", "recipient", "receive", "receives", "received", "attachment", "attachments"], it: ["email", "mail", "posta", "posta elettronica", "casella di posta", "messaggio", "messaggi", "lettera", "busta", "newsletter", "spam", "phishing", "risposta", "invia", "inviare", "inviato", "manda", "mandare", "mandato", "mittente", "destinatario", "ricevi", "ricevere", "ricevuto", "allegato"], fr: ["email", "mail", "courriel", "courrier", "bo\u00eete mail", "message", "messages", "lettre", "enveloppe", "newsletter", "spam", "hame\u00e7onnage", "r\u00e9ponse", "envoie", "envoyer", "envoyé", "expéditeur", "destinataire", "reçoit", "recevoir", "reçu", "pièce jointe"] },
  eye: { en: ["eye", "eyes", "watching", "watched", "looks", "looking", "sees", "sight", "vision", "surveillance", "monitoring", "observes", "gaze", "spying", "being seen", "read", "reads", "reading", "eavesdrop", "eavesdrops", "eavesdropping", "intercept", "intercepts", "intercepted", "snoop", "snoops", "peek", "listens in", "visible", "in plain sight"], it: ["occhio", "occhi", "sguardo", "guarda", "osserva", "vede", "vista", "sorveglianza", "sorvegliato", "monitoraggio", "spia", "ti guarda", "visto", "legge", "leggere", "leggono", "intercetta", "intercettare", "origlia", "sbircia", "sbirciare", "visibile", "in chiaro"], fr: ["\u0153il", "oeil", "yeux", "regard", "regarde", "observe", "voit", "vue", "surveillance", "surveill\u00e9", "espionne", "coup d \u0153il", "vu", "lit", "lire", "intercepte", "intercepter", "épie", "espionner", "visible", "en clair"] },
  face: { en: ["face", "faces", "facial", "portrait", "selfie", "expression", "head", "facial recognition", "face id", "identity photo", "looks like you", "sender", "senders", "recipient", "recipients", "who you are", "who sent it", "smile"], it: ["viso", "volto", "faccia", "facciale", "espressione", "ritratto", "testa", "selfie", "riconoscimento facciale", "face id", "il tuo volto", "mittente", "destinatario", "chi sei", "chi ha inviato", "sorriso"], fr: ["visage", "visages", "figure", "facial", "faciale", "portrait", "selfie", "expression", "t\u00eate", "reconnaissance faciale", "face id", "expéditeur", "destinataire", "qui vous êtes", "sourire"] },
  figure: { en: ["person", "someone", "somebody", "individual", "human", "user", "man", "woman", "guy", "character", "silhouette", "human being", "a single person", "people", "persons", "two people", "each other", "sender", "senders", "recipient", "recipients", "friend", "friends"], it: ["persona", "qualcuno", "individuo", "umano", "essere umano", "utente", "uomo", "donna", "tizio", "sagoma", "figura", "una persona", "persone", "gente", "due persone", "a vicenda", "mittente", "destinatario", "amico", "amici", "conoscente"], fr: ["personne", "quelqu un", "individu", "humain", "\u00eatre humain", "utilisateur", "homme", "femme", "type", "silhouette", "une seule personne", "personnes", "gens", "deux personnes", "l un l autre", "expéditeur", "destinataire", "ami", "amis"] },
  fingerprint: { en: ["fingerprint", "fingerprints", "thumbprint", "print", "biometric", "biometrics", "touch id", "identity", "identification", "unique", "identifies you", "proof it is you", "thumb", "finger", "touch", "touches", "touching", "tap", "taps"], it: ["impronta digitale", "impronte digitali", "biometrico", "biometria", "touch id", "identit\u00e0", "identificazione", "univoco", "ti identifica", "dito", "pollice", "impronta", "tocca", "tocchi", "toccare", "sfiora"], fr: ["empreinte digitale", "empreintes digitales", "biom\u00e9trique", "biom\u00e9trie", "touch id", "identit\u00e9", "identification", "unique", "vous identifie", "doigt", "pouce", "empreinte", "touche", "toucher", "tapote"] },
  folder: { en: ["folder", "folders", "file", "files", "directory", "archive", "archives", "document", "documents", "dossier", "records", "paperwork", "filing", "account", "accounts", "profile", "profiles", "record"], it: ["cartella", "cartelle", "file", "archivio", "archivi", "documento", "documenti", "directory", "fascicolo", "dossier", "pratiche", "schedario", "account", "profilo", "profili", "registro", "scheda"], fr: ["dossier", "dossiers", "fichier", "fichiers", "r\u00e9pertoire", "archives", "document", "documents", "classeur", "paperasse", "pochette", "compte", "comptes", "profil", "profils", "registre"] },
  footprints: { en: ["footprints", "footprint", "tracks", "trail", "traces", "trace", "traceable", "tracked", "tracking", "follows", "followed", "breadcrumbs", "digital footprint", "leaves traces", "covers his tracks"], it: ["orme", "tracce", "traccia", "tracciato", "tracciamento", "tracciare", "tracciabile", "segue le tracce", "pedinato", "pedinamento", "impronta digitale", "lascia tracce"], fr: ["traces", "trace", "trac\u00e9", "tra\u00e7age", "tracer", "tra\u00e7able", "traqu\u00e9", "traque", "piste", "pistes", "filature", "empreinte num\u00e9rique", "laisse des traces"] },
  gear: { en: ["gear", "gears", "cog", "cogs", "mechanism", "machinery", "engine", "settings", "configuration", "how it works", "under the hood", "automation", "moving parts"], it: ["ingranaggio", "ingranaggi", "meccanismo", "macchinario", "motore", "macchina", "impostazioni", "configurazione", "come funziona", "sotto il cofano", "automazione", "regolazione", "parti in movimento"], fr: ["engrenage", "engrenages", "rouage", "rouages", "m\u00e9canisme", "moteur", "r\u00e9glages", "param\u00e8tres", "configuration", "sous le capot", "automatisation", "pi\u00e8ces mobiles"] },
  globe: { en: ["globe", "world", "worldwide", "global", "globally", "planet", "earth", "international", "abroad", "overseas", "countries", "continents", "around the world", "across the globe"], it: ["globo", "mondo", "mondiale", "globale", "pianeta", "terra", "internazionale", "estero", "oltreoceano", "paesi", "continenti", "in tutto il mondo", "nel mondo"], fr: ["globe", "monde", "mondial", "mondiale", "plan\u00e8te", "terre", "international", "internationale", "\u00e9tranger", "pays", "continents", "outre mer", "partout dans le monde", "dans le monde entier"] },
  graph: { en: ["network", "networks", "node", "nodes", "mesh", "graph", "topology", "peer to peer", "decentralized", "distributed", "cluster", "hub", "social network", "interconnected"], it: ["rete", "reti", "nodo", "nodi", "grafo", "topologia", "peer to peer", "decentralizzato", "distribuito", "cluster", "hub", "rete sociale", "interconnesso"], fr: ["r\u00e9seau", "r\u00e9seaux", "n\u0153ud", "n\u0153uds", "graphe", "maillage", "topologie", "pair \u00e0 pair", "d\u00e9centralis\u00e9", "distribu\u00e9", "cluster", "hub", "r\u00e9seau social", "interconnect\u00e9"] },
  hand: { en: ["hand", "hands", "palm", "fingers", "grabs", "holds", "reaches", "taps", "swipes", "points", "gesture", "picks up", "lets go", "click", "clicks", "clicking", "clicked", "touch", "touches", "touching", "tap", "tapping", "lend", "lends", "borrow", "borrows", "hands over", "press", "presses"], it: ["mano", "mani", "palmo", "dita", "afferra", "prende", "tiene", "tocca", "indica", "gesto", "preme", "lascia", "clicca", "cliccare", "cliccato", "clic", "click", "tocchi", "toccare", "sfiora", "presta", "prestare", "in prestito", "premi", "premere"], fr: ["main", "mains", "paume", "doigts", "attrape", "saisit", "tient", "touche", "appuie", "montre du doigt", "geste", "l\u00e2che", "clic", "clique", "cliquer", "cliqué", "toucher", "appuyer", "prête", "prêter", "emprunte"] },
  handshake: { en: ["handshake", "deal", "agreement", "partnership", "trust", "alliance", "cooperation", "pact", "shake hands", "they agree", "teams up", "mutual trust"], it: ["stretta di mano", "accordo", "patto", "intesa", "fiducia", "alleanza", "collaborazione", "partnership", "si accordano", "si stringono la mano", "fidarsi"], fr: ["poign\u00e9e de main", "accord", "entente", "pacte", "confiance", "alliance", "partenariat", "coop\u00e9ration", "serrer la main", "s entendent", "se font confiance"] },
  hotels: { en: ["hotel", "hotels", "motel", "motels", "resort", "resorts", "inn", "hostel", "lodging", "accommodation", "hospitality", "guesthouse", "bed and breakfast", "hotel chain", "overnight stay", "stay the night"], it: ["albergo", "alberghi", "hotel", "motel", "resort", "ostello", "ostelli", "pensione", "bed and breakfast", "struttura ricettiva", "strutture ricettive", "ospitalit\u00e0", "catena alberghiera", "pernottamento"], fr: ["h\u00f4tel", "h\u00f4tels", "motel", "auberge", "auberge de jeunesse", "g\u00eete", "pension", "h\u00f4tellerie", "cha\u00eene h\u00f4teli\u00e8re", "complexe h\u00f4telier", "nuit\u00e9e"] },
  intruder: { en: ["intruder", "hacker", "attacker", "thief", "burglar", "stranger", "breaks in", "break in", "intrusion", "trespasser", "unauthorized", "sneaks in", "cybercriminal", "gets inside"], it: ["intruso", "hacker", "ladro", "malintenzionato", "estraneo", "pirata informatico", "si intrufola", "irruzione", "effrazione", "non autorizzato", "criminale", "entra di nascosto"], fr: ["intrus", "pirate", "hacker", "voleur", "cambrioleur", "malfaiteur", "s introduit", "intrusion", "effraction", "non autoris\u00e9", "cybercriminel", "entre en douce"] },
  key: { en: ["key", "keys", "unlock", "unlocks", "unlocked", "unlocking", "private key", "access key", "master key", "spare key", "keyring", "keychain", "turns the key", "password", "passwords", "passcode", "pin", "pin code", "credentials", "login", "log in", "logs in", "sign in", "access code"], it: ["chiave", "chiavi", "sbloccare", "sblocca", "sbloccato", "chiave privata", "chiave di accesso", "chiave maestra", "mazzo di chiavi", "portachiavi", "gira la chiave", "apre con la chiave", "password", "codice pin", "pin", "credenziali", "accedi", "accedere", "login", "codice di accesso"], fr: ["cl\u00e9", "cl\u00e9s", "clef", "d\u00e9verrouiller", "d\u00e9verrouille", "d\u00e9verrouill\u00e9", "d\u00e9bloquer", "cl\u00e9 priv\u00e9e", "cl\u00e9 d acc\u00e8s", "passe partout", "trousseau", "porte cl\u00e9s", "tourne la cl\u00e9", "mot de passe", "mots de passe", "code pin", "code secret", "identifiants", "connexion", "se connecter"] },
  keycard: { en: ["keycard", "keycards", "key card", "badge", "badges", "access card", "id card", "swipe card", "swipe", "key fob", "fob", "pass", "magstripe", "rfid card"], it: ["tessera", "tessere", "tesserino", "badge", "carta magnetica", "tessera magnetica", "tessera di accesso", "scheda di accesso", "pass", "cartellino", "striscia la tessera"], fr: ["badge", "badges", "carte d acc\u00e8s", "carte magn\u00e9tique", "carte \u00e0 puce", "carte", "passe", "badge d acc\u00e8s", "porte badge", "carte de service"] },
  laptop: { en: ["laptop", "laptops", "computer", "computers", "pc", "macbook", "notebook", "keyboard", "typing on the laptop", "type", "types", "typing", "typed", "keystroke", "keystrokes", "website", "websites", "site", "sites", "web page", "webpage", "browser", "screen", "online"], it: ["portatile", "computer portatile", "computer", "pc", "laptop", "macbook", "notebook", "tastiera", "digita", "digiti", "digitare", "digitato", "tasti", "sito", "siti", "sito web", "pagina web", "browser", "schermo", "online"], fr: ["ordinateur", "ordinateurs", "ordinateur portable", "portable", "pc", "mac", "macbook", "laptop", "clavier", "tape", "taper", "tapé", "saisie", "site", "sites", "site web", "page web", "navigateur", "écran", "en ligne"] },
  lock: { en: ["lock", "locks", "padlock", "locked", "lock it", "password", "passwords", "passcode", "encryption", "encrypted", "encrypt", "locked down", "sealed", "under lock", "encrypts", "encrypting", "decrypt", "decrypts", "decrypted", "decrypting", "decryption", "end to end", "confidential", "private", "privacy", "scrambled"], it: ["lucchetto", "lucchetti", "serratura", "serrature", "chiuso a chiave", "bloccato", "blocca l accesso", "password", "parola d ordine", "cifratura", "crittografia", "criptato", "cifrato", "sotto chiave", "cifra", "cifrare", "cripta", "criptare", "decifrare", "decriptare", "crittografato", "riservato", "privato", "privacy"], fr: ["cadenas", "serrure", "verrou", "verrouill\u00e9", "verrouille", "verrouillage", "mot de passe", "mots de passe", "chiffrement", "chiffr\u00e9", "crypt\u00e9", "scell\u00e9", "sous cl\u00e9", "chiffre", "chiffrer", "crypte", "crypter", "déchiffre", "déchiffrer", "décrypter", "confidentiel", "privé", "vie privée", "bout en bout"] },
  magnifier: { en: ["magnifying glass", "magnifier", "search", "searches", "searching", "find", "finds", "look closer", "closely", "inspect", "examine", "investigate", "zoom in", "detail", "details", "audit", "analyze"], it: ["lente", "lente d'ingrandimento", "cerca", "cercare", "ricerca", "trova", "trovare", "esamina", "esaminare", "ispezionare", "indagare", "analizzare", "guardare da vicino", "zoom", "dettaglio", "dettagli"], fr: ["loupe", "chercher", "cherche", "recherche", "trouver", "trouve", "examiner", "examine", "inspecter", "enqu\u00eater", "analyser", "regarder de plus pr\u00e8s", "zoom", "d\u00e9tail", "d\u00e9tails"] },
  phone: { en: ["phone", "phones", "smartphone", "smartphones", "mobile phone", "cell phone", "cellphone", "iphone", "android phone", "handset", "calls", "text message", "sms", "text", "texts", "texting", "app", "apps", "whatsapp", "sim", "sim card", "phone number"], it: ["telefono", "telefoni", "cellulare", "cellulari", "smartphone", "telefonino", "iphone", "chiamata", "chiamare", "chiama", "android", "messaggio di testo", "sms", "messaggino", "messaggini", "app", "applicazione", "whatsapp", "sim", "scheda sim", "numero di telefono"], fr: ["telephone", "t\u00e9l\u00e9phone", "t\u00e9l\u00e9phones", "smartphone", "smartphones", "mobile", "iphone", "appel", "appelle", "appeler", "android", "sms", "texto", "textos", "appli", "application", "whatsapp", "sim", "carte sim", "numéro de téléphone"] },
  question: { en: ["question", "questions", "why", "how come", "ask", "asks", "wonder", "wondering", "doubt", "unclear", "unknown", "mystery", "puzzled", "confused", "uncertain", "no one knows"], it: ["domanda", "domande", "perch\u00e9", "come mai", "chiedere", "chiede", "chiedersi", "dubbio", "dubbi", "incerto", "mistero", "poco chiaro", "non si sa", "interrogativo"], fr: ["question", "questions", "pourquoi", "demander", "se demander", "doute", "douteux", "incertain", "myst\u00e8re", "interrogation", "on ne sait pas", "flou"] },
  reader: { en: ["reader", "readers", "card reader", "badge reader", "door reader", "scanner", "scans", "scan", "reads the card", "terminal", "turnstile", "access panel", "keypad", "sensor", "checkpoint"], it: ["lettore", "lettori", "lettore di tessere", "lettore di badge", "scanner", "scansiona", "scansione", "legge la tessera", "terminale", "tornello", "validatore", "pannello di accesso", "sensore", "varco"], fr: ["lecteur", "lecteurs", "lecteur de badge", "lecteur de carte", "badgeuse", "scanner", "scanne", "scan", "lit la carte", "borne", "terminal", "tourniquet", "capteur", "sas d acc\u00e8s"] },
  robot: { en: ["robot", "robots", "android", "ai", "artificial intelligence", "bot", "chatbot", "automated", "automation", "virtual assistant", "machine learning", "the model"], it: ["robot", "androide", "automa", "intelligenza artificiale", "ia", "bot", "chatbot", "automatico", "automatizzato", "assistente virtuale", "apprendimento automatico"], fr: ["robot", "robots", "andro\u00efde", "intelligence artificielle", "ia", "bot", "chatbot", "automatis\u00e9", "automatique", "assistant virtuel", "apprentissage automatique"] },
  rocket: { en: ["rocket", "rockets", "launch", "launches", "launched", "launching", "liftoff", "blast off", "takes off", "outer space", "spaceship", "orbit", "skyrocket", "countdown", "to the moon"], it: ["razzo", "razzi", "lancio", "lancia", "lanciare", "lanciato", "decollo", "decolla", "astronave", "navicella", "orbita", "conto alla rovescia", "verso la luna"], fr: ["fus\u00e9e", "fus\u00e9es", "lancement", "lance", "lancer", "lanc\u00e9", "d\u00e9collage", "d\u00e9colle", "vaisseau spatial", "navette", "orbite", "compte \u00e0 rebours", "vers la lune", "monte en fl\u00e8che"] },
  room: { en: ["room", "rooms", "bedroom", "guest room", "single room", "double room", "suite", "chamber", "interior", "indoors", "inside", "apartment", "studio", "unit", "four walls"], it: ["stanza", "stanze", "camera", "camere", "camera da letto", "camera singola", "camera doppia", "suite", "interno", "dentro", "appartamento", "monolocale", "vano"], fr: ["chambre", "chambres", "salle", "suite", "int\u00e9rieur", "dedans", "appartement", "studio", "chambre double", "chambre simple"] },
  router: { en: ["router", "routers", "modem", "wifi", "wifi router", "hotspot", "access point", "wireless network", "home network", "gateway", "wifi box", "network", "networks", "wifi network", "connection"], it: ["router", "modem", "wifi", "rete wifi", "hotspot", "access point", "punto di accesso", "senza fili", "rete domestica", "ripetitore wifi", "modem di casa", "rete", "reti", "connessione", "connetti", "connettere", "collegarsi"], fr: ["routeur", "routeurs", "box", "box internet", "modem", "wifi", "borne wifi", "hotspot", "reseau sans fil", "r\u00e9seau sans fil", "point acces wifi", "réseau", "réseaux", "connexion réseau"] },
  satellite: { en: ["satellite", "satellites", "orbit", "orbits", "orbiting", "in orbit", "gps", "gps satellite", "starlink", "in space"], it: ["satellite", "satelliti", "orbita", "in orbita", "orbitante", "gps", "satellitare", "navigazione satellitare", "starlink", "spaziale"], fr: ["satellite", "satellites", "orbite", "en orbite", "gps", "satellitaire", "starlink", "navigation par satellite", "constellation de satellites", "spatial"] },
  scale: { en: ["scale", "scales", "balance", "balanced", "weigh", "weighs", "weighing", "trade off", "tradeoff", "fair", "fairness", "justice", "law", "legal", "court", "pros and cons"], it: ["bilancia", "equilibrio", "bilanciato", "pesare", "pesa", "compromesso", "giusto", "equit\u00e0", "giustizia", "legge", "legale", "tribunale", "pro e contro", "confronto"], fr: ["balance", "\u00e9quilibre", "\u00e9quilibr\u00e9", "peser", "p\u00e8se", "compromis", "juste", "\u00e9quit\u00e9", "justice", "loi", "l\u00e9gal", "tribunal", "pour et contre", "comparaison"] },
  server: { en: ["server", "servers", "data center", "datacenter", "server room", "cloud", "in the cloud", "database", "mainframe", "rack", "hosting", "hosted", "backend", "storage", "store", "stores", "stored", "storing", "saved", "saves"], it: ["server", "data center", "centro dati", "sala server", "cloud", "nel cloud", "database", "banca dati", "mainframe", "rack", "hosting", "ospitato sul server", "archiviazione", "archivia", "memorizza", "memorizzato", "conserva", "conservato", "salva", "salvato"], fr: ["serveur", "serveurs", "centre de donnees", "centre de donn\u00e9es", "datacenter", "salle des serveurs", "cloud", "nuage", "base de donnees", "base de donn\u00e9es", "hebergement", "h\u00e9berg\u00e9", "mainframe", "stockage", "stocke", "stocké", "stocker", "conserve", "enregistre", "enregistré"] },
  shield: { en: ["shield", "shields", "shielded", "protection", "protects", "protected", "protect", "defense", "defends", "defended", "antivirus", "firewall", "guard", "guards", "safeguard", "immune"], it: ["scudo", "scudi", "protezione", "protegge", "protetto", "proteggere", "difesa", "difende", "difeso", "antivirus", "firewall", "corazza", "barriera", "respinge", "al riparo"], fr: ["bouclier", "boucliers", "protection", "prot\u00e8ge", "prot\u00e9g\u00e9", "prot\u00e9ger", "d\u00e9fense", "d\u00e9fend", "d\u00e9fendu", "antivirus", "pare feu", "rempart", "barri\u00e8re", "blind\u00e9", "repousse"] },
  signal: { en: ["signal", "signals", "broadcast", "broadcasts", "transmit", "transmits", "transmission", "beams", "emits", "radio", "radio waves", "antenna", "airwaves", "wireless", "wifi", "over the air", "radios", "transmitted"], it: ["segnale", "segnali", "trasmette", "trasmettere", "trasmissione", "emette", "irradia", "onde", "onde radio", "radio", "antenna", "wireless", "wifi", "via etere", "manda un segnale", "senza fili"], fr: ["signal", "signaux", "\u00e9met", "\u00e9mission", "transmet", "transmission", "diffuse", "ondes", "ondes radio", "radio", "antenne", "balise", "sans fil", "wifi", "par les airs", "transmettre"] },
  suitcase: { en: ["suitcase", "suitcases", "luggage", "baggage", "bag", "bags", "carry on", "cabin bag", "checked bag", "packing", "packed", "pack your bags", "travel", "trip", "airport", "airports", "flight", "flights", "boarding", "boarding pass", "departure", "vacation", "holiday", "tourist", "tourists"], it: ["valigia", "valigie", "bagaglio", "bagagli", "bagaglio a mano", "bagaglio da stiva", "trolley", "borsone", "fare la valigia", "fare le valigie", "viaggio", "viaggiare", "in viaggio", "aeroporto", "aeroporti", "volo", "voli", "imbarco", "partenza", "vacanza", "vacanze", "turista", "turisti"], fr: ["valise", "valises", "bagage", "bagages", "sac", "sacs", "bagage \u00e0 main", "bagage en soute", "faire sa valise", "faire ses valises", "voyage", "voyager", "en voyage", "aéroport", "aéroports", "vol", "vols", "embarquement", "départ", "vacances", "touriste"] },
  tag: { en: ["tag", "tags", "tagged", "label", "labels", "labeled", "sticker", "badge", "name", "named", "called", "nickname", "marked", "title", "identifier", "username", "usernames", "handle"], it: ["etichetta", "etichette", "targhetta", "cartellino", "adesivo", "nome", "chiamato", "si chiama", "soprannome", "tag", "taggato", "titolo", "dicitura", "identificativo", "nome utente", "nomi utente"], fr: ["\u00e9tiquette", "\u00e9tiquettes", "\u00e9tiquet\u00e9", "tag", "badge", "autocollant", "nom", "nomm\u00e9", "appel\u00e9", "surnom", "libell\u00e9", "marqu\u00e9", "titre", "identifiant", "nom utilisateur", "pseudo"] },
  tree: { en: ["tree", "trees", "forest", "woods", "park", "nature", "outdoors", "green", "greenery", "garden", "plant", "plants", "leaves", "branches", "roots", "shade"], it: ["albero", "alberi", "bosco", "boschi", "foresta", "parco", "natura", "verde", "giardino", "pianta", "piante", "foglie", "rami", "radici", "aria aperta"], fr: ["arbre", "arbres", "for\u00eat", "bois", "parc", "nature", "verdure", "vert", "jardin", "plante", "plantes", "feuilles", "branches", "racines", "plein air"] },
  usb: { en: ["usb", "usb stick", "usb drive", "usb key", "flash drive", "thumb drive", "memory stick", "pen drive", "dongle", "usb port", "cable", "cables", "charging cable", "charging lead", "charger", "chargers", "cord", "plug", "plugs", "plug in", "plugged in", "connector", "socket", "adapter"], it: ["usb", "chiavetta", "chiavetta usb", "chiavette", "pennetta usb", "penna usb", "pendrive", "memoria usb", "porta usb", "dongle", "cavo", "cavi", "cavetto", "cavo di ricarica", "caricabatterie", "caricatore", "spina", "presa", "connettore", "adattatore"], fr: ["usb", "cle usb", "cl\u00e9 usb", "cl\u00e9s usb", "clef usb", "dongle", "memoire usb", "m\u00e9moire usb", "port usb", "memoire flash", "câble", "câbles", "cable", "cordon", "chargeur", "chargeurs", "fiche", "prise", "connecteur", "adaptateur"] },
  warning: { en: ["warning", "warns", "danger", "dangerous", "alert", "careful", "watch out", "beware", "risk", "risky", "threat", "caution", "hazard", "red flag", "alarm", "scam", "scams", "scammer", "fraud", "fake", "fakes", "faked", "trick", "tricks", "trap", "traps", "hoax", "counterfeit"], it: ["attenzione", "pericolo", "pericoloso", "allarme", "avviso", "avvertimento", "avverte", "rischio", "rischioso", "minaccia", "occhio", "stai attento", "cautela", "segnale di allarme", "truffa", "truffe", "truffatore", "frode", "falso", "falsa", "finto", "finta", "trucco", "inganno", "ingannare", "raggiro", "esca"], fr: ["attention", "danger", "dangereux", "alerte", "avertissement", "avertit", "risque", "risqu\u00e9", "menace", "prudence", "m\u00e9fiance", "m\u00e9fiez vous", "gare", "alerte rouge", "arnaque", "arnaques", "escroquerie", "escroc", "fraude", "faux", "fausse", "piège", "pièges", "leurre"] },
  writer: { en: ["encoder", "card encoder", "card writer", "key card", "key cards", "keycard", "room key", "hotel key", "magnetic stripe", "magstripe", "encodes", "encoded", "blank card", "card reader", "programs the card"], it: ["encoder", "codificatore", "codificatore di schede", "carta magnetica", "tessera magnetica", "scheda magnetica", "chiave elettronica", "chiave della stanza", "banda magnetica", "lettore di schede", "codifica", "codificare", "programmare la tessera"], fr: ["encodeur", "encodeuse de cartes", "carte magnetique", "carte magn\u00e9tique", "carte de chambre", "cle de chambre", "cl\u00e9 de chambre", "cl\u00e9 \u00e9lectronique", "badge", "badge magnetique", "bande magnetique", "lecteur de cartes", "encode", "encoder la carte"] },
};

/**
 * Words carried by every second sentence, in all three languages. They are dropped before two lines are
 * compared, because "the", "your" and "is" in common says nothing about whether two lines say the same thing.
 */
const COMMON = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "from", "by", "is", "are",
  "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "you", "your", "yours", "they",
  "them", "their", "we", "our", "he", "she", "his", "her", "not", "no", "can", "will", "would", "could", "has",
  "have", "had", "do", "does", "did", "so", "if", "when", "what", "who", "how", "why", "all", "every", "any",
  "one", "two", "into", "out", "up", "down", "then", "than", "just", "very", "more", "most", "some", "there",
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "e", "ed", "o", "di", "del", "della", "dei", "delle",
  "da", "dal", "in", "nel", "nella", "con", "su", "sul", "per", "tra", "fra", "che", "chi", "cosa", "come",
  "non", "ma", "però", "se", "ci", "si", "ti", "mi", "tuo", "tua", "tuoi", "tue", "suo", "sua", "è", "sono",
  "era", "essere", "ha", "hanno", "avere", "fa", "fare", "puo", "può", "quando", "poi", "già", "anche", "solo",
  "questo", "questa", "quello", "quella", "ogni", "tutto", "tutti",
  "le", "les", "un", "une", "des", "du", "de", "et", "ou", "dans", "sur", "pour", "avec", "que", "qui", "quoi",
  "ne", "pas", "est", "sont", "était", "être", "a", "ont", "avoir", "fait", "peut", "quand", "puis", "déjà",
  "aussi", "seulement", "ce", "cet", "cette", "ces", "tout", "tous", "votre", "vos", "ton", "ta", "tes",
]);
/** The words of a line that carry its meaning: everything else is grammar. */
const content = (line: string): Set<string> =>
  new Set(words(line.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " "))
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 2 && !COMMON.has(w)));
/**
 * Whether two content words are the same word. Not stemming — a stemmer per language is a dependency this
 * does not need — but the one case that matters: a singular and its plural. The shipped hotel film says
 * "hotel key card" in its first line and "thirteen thousand hotels" in its fifth, and a comparison that
 * cannot see those as the same word accuses the reference film of changing the subject.
 */
const same = (a: string, b: string): boolean => {
  if (a === b) return true;
  const [s1, s2] = a.length <= b.length ? [a, b] : [b, a];
  return s1.length >= 4 && s2.startsWith(s1) && s2.length - s1.length <= 2;
};
const has = (bag: Set<string>, w: string): boolean => { for (const x of bag) if (same(x, w)) return true; return false };
/** How much of the shorter line is inside the longer one: 1 means it says nothing new at all. */
const overlap = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (has(b, w)) shared++;
  return shared / Math.min(a.size, b.size);
};

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
      // Two in a row is already a stuck video: the drawing IS the cut, so repeating it means the film did
      // not cut. Measured on the real model, a film with seven scenes came back drawing a lock and a key
      // four times each and read as one long still.
      for (let i = 1; i < scenes.length; i++) {
        const a = artOf(scenes[i - 1])[0]?.name, b = artOf(scenes[i])[0]?.name;
        if (a && a === b) out.push({ rule: "variety", scene: i + 1, message: `scene ${i} and scene ${i + 1} both open on "${a}". The drawing is the cut: repeating it means the film never cut. Draw the thing THIS line names.` });
      }
      const first = scenes.map((s) => artOf(s)[0]?.name).filter(Boolean);
      const distinct = new Set(scenes.flatMap((s) => artOf(s).map((a) => a.name)));
      if (first.length >= 4 && distinct.size < Math.max(4, Math.ceil(scenes.length * 0.9)))
        out.push({ rule: "variety", scene: null, message: `the whole film is drawn with only ${distinct.size} different drawings across ${scenes.length} scenes. A film that recycles a lock and a key is a film with one picture in it — give each line the thing it actually names.` });
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
    id: "draws-what-it-says",
    why: "One phrase, one drawing, and the drawing is what the words name. A scene that draws none of the things its line mentions is a caption over a stock picture.",
    check: ({ scenes, language }) => scenes.flatMap((s, i) => {
      const line = " " + voiceOf(s).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ") + " ";
      if (line.trim().length < 12) return [];
      const named = artOf(s).filter((a) => {
        const w = SKETCH_WORDS[a.name as string];
        if (!w) return false;
        const list = (w as Record<string, string[]>)[language] ?? w.en;
        return [...list, ...(language === "en" ? [] : w.en)].some((word) => line.includes(" " + word + " ") || line.includes(" " + word + "s "));
      });
      if (named.length) return [];
      return [{ rule: "draws-what-it-says", scene: i + 1, message: `scene ${i + 1} draws ${artOf(s).map((a) => a.name).join(", ") || "nothing"} for the line "${voiceOf(s)}", and not one of them is a thing that line mentions. Draw what the words name — the picture is the sentence, not decoration beside it.` }];
    }),
  },
  {
    id: "echo",
    why: "A line that repeats the one before it spends three seconds telling the viewer something they already have.",
    check: ({ scenes }) => {
      const out: Violation[] = [];
      const bags = scenes.map((s) => content(voiceOf(s)));
      for (let i = 1; i < scenes.length; i++)
        for (let j = 0; j < i; j++) {
          if (overlap(bags[i], bags[j]) < 0.6) continue;
          out.push({ rule: "echo", scene: i + 1, message: `scene ${i + 1} says what scene ${j + 1} already said: "${voiceOf(scenes[j])}" then "${voiceOf(scenes[i])}". Every line must add a fact, a name or a number the film does not have yet — rewrite it or cut the scene.` });
          break;
        }
      return out;
    },
  },
  {
    id: "promise",
    why: "The hook names a thing and owes the viewer that thing. A film that changes subject after the hook was a different film's opening.",
    check: ({ scenes }) => {
      if (scenes.length < 4) return [];
      const hook = content(voiceOf(scenes[0]));
      if (hook.size < 2) return [];
      const half = scenes.slice(Math.ceil(scenes.length / 2));
      const later = new Set(half.flatMap((s) => [...content(voiceOf(s))]));
      const kept = [...hook].filter((w) => has(later, w));
      return kept.length ? [] : [{ rule: "promise", scene: null, message: `nothing the hook named comes back after the halfway point. The first line promises "${voiceOf(scenes[0])}"; the second half of the film has to pay that off by name, not change the subject.` }];
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
 * The drawing this line is asking for, and the words that asked. Returns the most SPECIFIC match — the
 * longest word that hit — because a line saying "charging cable" wants the cable, not whatever else a
 * shorter word in it happens to name. Drawings already in the scene are skipped: the point is to add
 * something the scene is missing, not to say what it already says.
 */
function drawingFor(line: string, language: string, taken: Set<string>): { name: string; word: string } | null {
  const hay = " " + line.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ") + " ";
  let best: { name: string; word: string } | null = null;
  for (const [name, w] of Object.entries(SKETCH_WORDS)) {
    if (taken.has(name)) continue;
    const list = [...((w as Record<string, string[]>)[language] ?? w.en), ...(language === "en" ? [] : w.en)];
    for (const word of list) {
      if (!hay.includes(" " + word + " ") && !hay.includes(" " + word + "s ")) continue;
      if (!best || word.length > best.word.length) best = { name, word };
    }
  }
  return best;
}

/**
 * What arithmetic can fix, before anyone is asked to write again.
 *
 * Three of these repairs exist because the word index made them possible. Until there was a table saying
 * which spoken words name which drawing, a scene that drew the wrong thing could only be sent back to the
 * model; now the line itself says what it wanted, and the anchor comes from the same word that chose the
 * drawing — the cut lands exactly where the thing is named. A retry costs a model call and comes back
 * wrong about half the time; this costs nothing and cannot.
 */
export function repairExplainer(scenes: unknown, format: string, language = "en"): void {
  const list = Array.isArray(scenes) ? (scenes.filter(isObj) as Record<string, unknown>[]) : [];
  if (!list.length) return;
  const first = artOf(list[0]);
  if (first.length && !first.some((a) => a.drawn === true)) { first[0].drawn = true; delete first[0].at }

  // 1. A scene that draws none of the things its line names, and 2. a scene with a single drawing holding
  //    the whole sentence. Both are answered from the line: it already said what it wanted drawn.
  for (const s of list) {
    const line = voiceOf(s);
    if (line.split(/\s+/).filter(Boolean).length < 4) continue;
    const art = artOf(s);
    const taken = new Set(art.map((a) => String(a.name)));
    const hay = " " + line.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ") + " ";
    const named = art.some((a) => {
      const w = SKETCH_WORDS[a.name as string];
      if (!w) return false;
      const l = [...((w as Record<string, string[]>)[language] ?? w.en), ...(language === "en" ? [] : w.en)];
      return l.some((x) => hay.includes(" " + x + " ") || hay.includes(" " + x + "s "));
    });
    if (named && art.length >= 2) continue;
    const pick = drawingFor(line, language, taken);
    if (!pick) continue;
    // The anchor comes from the same word that chose the drawing, so the cut lands where the thing is named.
    const at = quotesVoice(pick.word, line) ? pick.word : anchorAt(line, 0.5);
    const el: Record<string, unknown> = { name: pick.name };
    if (at) el.at = at; else el.drawn = true;
    art.push(el);
    s.art = art.slice(0, 8);
  }

  // 3. Two scenes in a row opening on the same drawing. The scene already owns another one: put it first.
  //    The drawing IS the cut in this look, so this is the difference between a cut and a still.
  for (let i = 1; i < list.length; i++) {
    const prev = artOf(list[i - 1])[0]?.name, art = artOf(list[i]);
    if (!prev || art[0]?.name !== prev) continue;
    const other = art.findIndex((a, k) => k > 0 && a.name !== prev);
    if (other < 0) continue;
    const [moved] = art.splice(other, 1);
    // The opener is what is on the page when the scene starts; whatever it displaces takes its cue.
    if (art[0] && typeof art[0].at !== "string" && art[0].drawn === true) { delete art[0].drawn; const a = anchorAt(voiceOf(list[i]), 0.45); if (a) art[0].at = a }
    if (typeof moved.at === "string") delete moved.at;
    moved.drawn = true;
    art.unshift(moved);
    list[i].art = art;
  }

  for (const s of list) {
    const v = voiceOf(s), w = words(v), art = artOf(s);
    if (art.length < 2 || w.length < 6) continue;
    const half = w.slice(Math.ceil(w.length / 2)).join(" ");
    if (art.some((a) => (typeof a.at === "string" && quotesVoice(a.at, half)) || (typeof a.at === "number" && a.at >= 0.45))) continue;
    const late = anchorAt(v, 0.55);
    if (late) art[art.length - 1].at = late;
  }
}
