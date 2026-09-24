/**
 * THE TREATMENT: the user's sentence, expanded into the film a producer would make of it — BEFORE the direction,
 * before a single scene exists.
 *
 * Until 14 September 2026 the planner read "a video about accuracy in medicine" and went straight to work on those
 * six words: the direction named a world, the outline cut it into scenes, and nothing in between ever asked what
 * FILM this should be. Two identical requests got two near-identical videos; a bare subject got a generic one. The
 * treatment is that missing step, and it is written the way a production company writes one: an angle (a subject
 * is not a film; the one idea the film argues is), a narrative device, the opening image, the acts with their
 * seconds, the ending, the visual language, the pacing, the narrator's register, the recurring motifs, and a list
 * of every decision Kleo took that the user did not ask for — so the user can see them and change them.
 *
 * Two things make it a treatment rather than a template:
 *   - the MASTER PROMPT below is a METHOD, not a text to copy: every field is a decision the model has to take for
 *     THIS request, under a stated quality bar and a stated set of things Kleo cannot render;
 *   - the VARIATION: a narrative device and an opening family are drawn for each film from its own id, so the same
 *     request never gets the same film twice, and the draw is written into the treatment so it can be read back.
 *     Only for a film the user LEFT OPEN (24 September 2026): a request the user described is a FAITHFUL spec
 *     (src/spec.ts), its treatment is written under the spec's requirements at a cooler temperature, and its draw is
 *     "as-told/as-asked" — the user's events in the user's order, opening on the image the request opens on.
 *
 * It travels three ways: as `treatment` at the top level of the storyboard (the direction, the outline and every
 * scene are written under it; the worker passes it through untouched like `direction`), as `params.treatment` on a
 * job whose caller wrote or approved one through kleo_adapt_prompt, and as the answer of that tool.
 *
 * Nothing here calls a model. src/storyboard.ts owns the call (it owns the model, the prices and the retry); this
 * module owns the words, the shape and the repair, so a test can hold them still.
 */

/* ------------------------------------------------------------------ limits, in one table */

/** Character limits, printed in the prompt, enforced by the repair and checked by the tests. */
import { LAYER_METHOD, graphicsProblems, repairGraphics, graphicsBlock, isNoLayer, HUD_KINDS, EDGES, CORNERS, SUBTITLE_MODES, CHAPTER_MODES, type Graphics } from "./graphics.ts";
import { FILM_LOOKS, type FilmLook } from "./keou-contract.ts";
import { specBlock, type RequestSpec } from "./spec.ts";

export const T = {
  logline: 200,
  angle: 240,
  opening: 320,
  ending: 320,
  acts: { min: 2, max: 7, name: 32, purpose: 160 },
  visual: 420,
  pacing: 320,
  narrator: 260,
  motifs: { min: 2, max: 5, len: 60 },
  decisions: { max: 8, len: 120 },
  /** The composer's brief (22 September 2026): one line, instrumental, written only when the user asked for music. */
  music: 200,
  /**
   * The prose treatment, in words. `target` is what the prompt ASKS for; `minWords` is where the answer is refused.
   * The two are different on purpose, measured twice on the production model on 13 September: asked for "100-520"
   * it wrote 111-198 (the floor is what it aims at); refused under 140 it failed 7 of 15 (71-121 words, and the
   * second attempt no longer). So it is asked for 180-350 and refused under 100: a caption is still refused, and a
   * 17B model that lands short of its target still delivers a film.
   */
  prose: { minWords: 100, target: [180, 350] as const, maxWords: 520, maxChars: 3600 },
} as const;

/**
 * A decision that decides nothing. Measured: "The period is contemporary" and "The tone is informative" in most
 * treatments even after the method said they are not decisions; a 17B model keeps them, so the repair drops them.
 * A real period ("the 18th century") or a real setting stays.
 */
const NON_DECISION = /\b(contemporary|present[- ]day|modern[- ]day|nowadays|contemporane[oa]|ai giorni nostri|giorni nostri|oggi)\b|^\s*(the )?tone\b|^\s*il tono\b|\btone is\b|\btono è\b/i;

/**
 * Act names that are a FUNCTION, not a name. Measured on the production model: "INTRO", "SETUP", "CONCLUSION",
 * "RESOLUTION" and "THE_CHALLENGE" in most of fifteen treatments, "INTRO" three seconds long. An act named for
 * what it does in any film is an act nobody wrote for this one; it is sent back with the words below.
 */
const GENERIC_ACT = /^(?:THE[ _]?)?(?:INTRO(?:DUCTION)?|SET[ _-]?UP|OPENING|CONCLUSION|RESOLUTION|CLOSING|OUTRO|SUMMARY|OVERVIEW|BACKGROUND|CONTEXT|CAUSE|EFFECTS?|IMPACT|PROBLEM|SOLUTION|CHALLENGE|CONSEQUENCES?|DISCOVERY|REALI[SZ]ATION|REFLECTION|REASSURANCE|EXPLANATION|SCENE|PART|ACT|BODY|MIDDLE|END(?:ING)?|FINALE?|START|BEGINNING|INTRODUZIONE|CONCLUSIONE|APERTURA|CHIUSURA|SVILUPPO|RISOLUZIONE|PROBLEMA|SOLUZIONE|FINE|INIZIO)(?:[ _]?\d+)?$/i;
/** Words that name a device out loud. A logline that says "a witness recounts" has shown the scaffolding. */
const DEVICE_TELLS: Partial<Record<Device, RegExp>> = {
  "the-witness": /\b(witness|testimone)\b/i,
  countdown: /\b(countdown|conto alla rovescia)\b/i,
  "cold-open-mystery": /\b(mystery|mistero)\b/i,
  "one-day": /\b(a day in the life|one day in|una giornata (nella|di))\b/i,
  "then-and-now": /\b(then and now|ieri e oggi|allora e adesso)\b/i,
};
/** Function words of the two languages the film can be narrated in: enough to tell which one a prose is written in. */
const LANG_WORDS: Record<string, RegExp> = {
  it: /\b(il|la|lo|gli|le|di|del|della|dei|delle|che|con|per|una|uno|sul|sulla|nel|nella|non|sono|mentre|dove)\b/gi,
  en: /\b(the|of|and|with|that|this|from|into|while|where|there|then|when|which|his|her|their|its|not|are)\b/gi,
};
/** The language a text is written in, among the ones LANG_WORDS knows, or null when it cannot tell. */
export function languageOf(text: string): "it" | "en" | null {
  const it = (text.match(LANG_WORDS.it) ?? []).length, en = (text.match(LANG_WORDS.en) ?? []).length;
  if (it + en < 6) return null;
  return it > en * 1.5 ? "it" : en > it * 1.5 ? "en" : null;
}
/** Word overlap of two sentences, 0-1: how much the angle merely restates the logline. */
function overlap(a: string, b: string): number {
  const bag = (s: string) => new Set((s.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []));
  const A = bag(a), B = bag(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size);
}

/* ------------------------------------------------------------------ the variation */

/**
 * The narrative devices. One is DRAWN for every film (variationFor) and handed to the model as the shape this film
 * is told in. They are the devices short documentary actually uses, described in one line each so the model can
 * make one work for a subject it was not written for.
 */
export const DEVICES = {
  "cold-open-mystery": "open on a consequence nobody explains, then earn the explanation piece by piece",
  "one-day": "follow one day, dawn to night, and let the subject appear through what happens in it",
  "then-and-now": "cut between the way it was and the way it is; the gap between the two is the story",
  "the-object": "one object carries the film — follow it from hand to hand, place to place",
  "countdown": "everything moves toward one moment; the film is the time before it",
  "question-and-reveal": "ask one plain question in the first line and refuse to answer it until the last act",
  "the-witness": "tell it from the point of view of someone who was there and saw only part of it",
  "cause-to-consequence": "one cause, followed downstream through everything it changes",
  /**
   * NOT DRAWN (24 September 2026): the device of a FAITHFUL film, the one the user already told. Drawing a device for
   * a story the user described is how "a pastry chef bakes a cake for the village children, then they throw her a
   * surprise party" came back as a countdown to a party nobody had planned, told by a witness who was not in the
   * request. faithfulVariation() hands this one out; variationFor() never does.
   */
  "as-told": "tell it the way the user told it: their events, in their order",
} as const;
export type Device = keyof typeof DEVICES;
/** Every device a treatment may carry (the schema's enum): the drawn ones and "as-told". */
export const DEVICE_IDS = Object.keys(DEVICES) as Device[];
/** The devices a draw picks from: every one but "as-told", so an OPEN film's draw is exactly what it was before 24 September. */
export const DRAWN_DEVICES = DEVICE_IDS.filter((d) => d !== "as-told");

/** The opening families: how the first three seconds behave. Drawn with the device. */
export const OPENINGS = {
  "in-medias-res": "we arrive in the middle of something already happening",
  "the-detail-first": "one small object or texture fills the frame before we know where we are",
  "the-wide-silence": "a wide, still place with nobody in it, and the narration waits a beat",
  "the-contradiction": "an image that contradicts what the first line says",
  "the-face": "one person, close, doing something ordinary, before the subject is named",
  /** NOT DRAWN: the opening of a FAITHFUL film, where the user already said what the film opens on. */
  "as-asked": "the first image is the one the user's request starts with",
} as const;
export type Opening = keyof typeof OPENINGS;
export const OPENING_IDS = Object.keys(OPENINGS) as Opening[];
/** The openings a draw picks from: every one but "as-asked". */
export const DRAWN_OPENINGS = OPENING_IDS.filter((o) => o !== "as-asked");

export interface Variation { device: Device; opening: Opening; key: string }

/** FNV-1a over a string: stable across runtimes, spread enough over eight and five buckets. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * The draw for one film. The seed is the job id (unique per video, stable across a re-plan after a quota pause, so
 * the retry writes the same film) or, for kleo_adapt_prompt where no job exists yet, a fresh random id.
 */
export function variationFor(seed: string): Variation {
  const h = fnv1a(seed);
  const device = DRAWN_DEVICES[h % DRAWN_DEVICES.length];
  const opening = DRAWN_OPENINGS[Math.floor(h / DRAWN_DEVICES.length) % DRAWN_OPENINGS.length];
  return { device, opening, key: `${device}/${opening}` };
}

/**
 * THE DRAW OF A FAITHFUL FILM (24 September 2026): no draw. The owner, measuring 18 production jobs: "Kleo makes
 * videos at random". The random device and opening were written into the treatment of films the user had described
 * scene by scene, and the treatment then bent the user's story to fit them. A film whose spec is FAITHFUL is told as
 * the user told it and opens where the user's request opens; the key says so, so a treatment can be read back.
 */
export function faithfulVariation(): Variation {
  return { device: "as-told", opening: "as-asked", key: "as-told/as-asked" };
}

/** True when the request spec says this is the user's own film (src/spec.ts modeFor). */
export const isFaithful = (spec: RequestSpec | null | undefined): boolean => !!spec && spec.mode === "faithful";

/**
 * The treatment call's temperature. 0.85 is the producer's heat for a subject left to Kleo — two identical requests
 * should not get the same film. A FAITHFUL film is extraction and arrangement of what the user said, and heat there
 * is invention: 0.4 keeps the prose alive and the facts where the user put them.
 */
export function treatmentTemperature(spec: RequestSpec | null | undefined): number {
  return isFaithful(spec) ? 0.4 : 0.85;
}

/** The variation a treatment is written under: the caller's draw, or no draw at all when the spec is faithful. */
function effectiveVariation(input: { spec?: RequestSpec | null }, v: Variation): Variation {
  return isFaithful(input.spec) ? faithfulVariation() : v;
}

/* ------------------------------------------------------------------ the shape */

export interface Act {
  /** UPPERCASE, the act's name in this film: "THE EMPTY DRIVEWAY", "WHAT THE TEST FOUND". */
  name: string;
  /** What this act does to the viewer: what they learn or feel by the end of it. */
  purpose: string;
  /** Seconds of screen time. The acts add up to the film's length. */
  seconds: number;
}

export interface Treatment {
  /** The film in one sentence, with a verb: who does what, and what is at stake. */
  logline: string;
  /** The one idea the film argues. A subject is not an angle; "how a relay attack steals a car in 40 seconds" is. */
  angle: string;
  /** The narrative device the film is told with (one of DEVICES). */
  device: Device;
  /** The look the film is drawn in: filmed (realistic) or a 2D animated film (animation). Step 0 of the method. */
  look: FilmLook;
  /** The first three seconds, as an image the camera can hold, not as a sentence the narrator says. */
  opening: string;
  /** The last image, and what the viewer is left holding. */
  ending: string;
  acts: Act[];
  /** Lens, light, palette, time of day, camera temperament: the ONE world every shot is filmed in. */
  visual: string;
  /** The cut rhythm act by act, in seconds, and where the film slows down on purpose. */
  pacing: string;
  /** The narrator's register: person, tense, sentence length, what they never say. */
  narrator: string;
  /** Two to five recurring images the film returns to. */
  motifs: string[];
  /** Everything Kleo decided that the request did not ask for, so the user can see it and overrule it. */
  decisions: string[];
  /** The treatment proper: 100-520 words of prose a director could shoot from. */
  prose: string;
  /** The draw this film was written under ("cold-open-mystery/the-detail-first"), so identical requests can be told apart. */
  variation: string;
  /** The layer drawn over the film (src/graphics.ts), decided for this film; null when the film has none. */
  graphics: Graphics | null;
  /**
   * The composer's brief: one line for an instrumental track under the narration (genre, instruments, tempo, mood,
   * how it follows the acts), written when the user asked for music; null when they did not. Never a known song or
   * artist. The worker orders the track from kie.ai (Suno) and ducks it under the voice.
   */
  music: string | null;
}

/** What the user answered about the sound and the subtitles: the two options the method is told to honour. */
export interface SoundOptions {
  /** null: not asked (an internal call); otherwise wanted or not, with the user's words for the kind when given. */
  music?: { wanted: boolean; brief: string | null } | null;
  /** null: not asked; true: cinema subtitles burned in; false: none. */
  subtitles?: boolean | null;
}

/** "none" in every spelling a model or a person writes for no music. */
export function musicOf(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === false) return null;
  const s = clip(raw, T.music);
  if (!s || /^(none|no|null|nessuna|nessuno|niente|senza musica|no music|off|-)$/i.test(s)) return null;
  return s;
}

/* ------------------------------------------------------------------ the master prompt */

/**
 * THE MASTER PROMPT. It is the system message of the treatment call, and it is a method: what Kleo can and cannot
 * render, the questions a producer answers before a film exists, the bar the answer is held to, and the words that
 * are banned because a model reaches for them when it has nothing to say. It never describes one film; every
 * sentence of the film comes from the request and the draw.
 *
 * Kept as one string on purpose: it is read by people more often than by code, and the owner edits it by hand.
 */
export const MASTER_PROMPT = `You are the producer and showrunner of Kleo, a studio that makes short narrated films in two products from one treatment — the FILM, every shot a generated clip, and the ANIMATIC, the same frames with the camera moving over each one — in one of two looks: REALISTIC (live-action photography) or ANIMATION (a 2D animated feature: painted backgrounds, drawn characters). Your job is to read a user's request for a video and write the TREATMENT of the film a serious production company would make of it. You answer with ONE JSON object and nothing else.

WHAT KLEO CAN RENDER (write only what can be shot):
- Every shot starts as one still frame drawn in the film's look — in the film it becomes a piece of moving footage generated from that frame, in the animatic the camera moves over the frame itself, so every frame must read as a picture on its own: a place, an object, weather, light, a person seen as a person — in ANIMATION a character designed once, in words, and drawn the same in every shot (never a named living person, never a celebrity, never a logo, a brand or a product name: "a family car", not a make; a FICTIONAL character the user named keeps the user's name). Four to twelve seconds per shot. Where the user did not ask for spectacle, human scale beats spectacle: a hand on a cold door handle renders better than a city exploding. Where the user DID ask for it — a battle, a storm at sea, a city at night, an explosion — the film shows it.
- One narrator, a text-to-speech voice, reads short spoken sentences. MUSIC exists only when the user asked for it (step 12): one instrumental track, ducked under the voice, never a known song or artist; when they did not ask, there is none. There are NO interviews, NO archive footage, NO mixing of the two looks in one film, NO split screens, NO karaoke captions, NO icons, NO logos. Over the film there may be a LAYER, decided in step 11 and drawn from a closed grammar (a line, a readout, a stamp, cards, cinema subtitles, chapter titles) — or nothing, which is the usual answer; SUBTITLES on it are the user's decision, not yours (step 11 says which).
- Between two ACTS the film may DISSOLVE (a clean 0.8-second cross-dissolve, one per 25 seconds of film, never inside an act): Kleo places them from the acts you write, so the act boundaries are where the film breathes.
- 4K, 60 frames per second, 16:9 for YouTube or 9:16 for a Short. Fifteen seconds to five minutes for a film; an animatic is at most sixty seconds.

FIDELITY — THE REQUEST IS THE BRIEF. When the request comes with THE USER'S REQUEST, AS REQUIREMENTS (printed above it, items R1, R2… and a cast c1, c2…), those requirements are the film and everything below serves them:
- Every MUST item is in the film: SEEN (a picture shows it) or HEARD (the narrator says it). None is dropped, none is softened into something generic, none is replaced by an idea you like better.
- The user's EVENTS happen in the user's ORDER. The film starts where the user's story starts and ends where it ends, unless the ending is left to you.
- The user's CHARACTERS look exactly as described — every attribute, the colours included — and are called by the names the user gave them.
- You ADD only what the requirements leave open (LEFT TO KLEO), and every addition is one line in "decisions". Nothing you add contradicts an item: not a colour, not a person, not a place, not the order, not the ending.
- FAITHFUL mode (the user described the film): the ANGLE (step 1) is the point of the user's own story in one sentence, never a thesis that replaces it; the DEVICE is "as-told" (step 2); the OPENING is "as-asked" (step 3); the acts follow the user's events. OPEN mode (the user gave a subject, or asked to be surprised): steps 1-3 apply as written, and the requirements still hold.

THE METHOD — answer these in order, each for THIS request:
0. LOOK. "realistic" or "animation", written in "look". When the request names it — a cartoon, animated, anime, drawn, illustrated, "like Pixar" means animation; filmed, footage, documentary, photographed means realistic — or the tool call fixes it, that is the answer. Otherwise realistic, unless the subject cannot be photographed at all (a talking animal, a fairy tale, a world that does not exist, the inside of a body): then animation. When the request did not name it, the look is one of the decisions.
1. ANGLE. In FAITHFUL mode: the point of the user's own story, in one sentence, in their terms — what it is about, never a new claim that changes what happens. In OPEN mode: a subject is not a film. Find the one idea the film argues, small enough to be true and specific enough to be filmed: one place, one person or one object, one moment, and something at stake in it. The logline says what HAPPENS; the angle says what the film CLAIMS because of it, and the two must not be the same sentence in other words. Write the claim itself, as a sentence a person could disagree with, never "the film argues that" or "the film explores": not "the film argues that bread rises because of yeast" but "bread does not rise because of heat; it rises because something alive has been eating for an hour". If your angle could sit under any film on this subject, it is the subject again, not an angle. If the request is one word, choose the most filmable human-scale story inside it.
2. DEVICE. Tell the film with the narrative device assigned to it (it is given in the request). "as-told" means the user's own sequence of events IS the structure: tell it that way, nothing rearranged. Any other device: make it work for this subject and keep it invisible: the words "witness", "countdown", "mystery", "a day in the life" never appear in the logline, the angle or the narration. If the request itself dictates a structure (a list, a countdown, a comparison, a how-to), that structure wins and the device becomes a flavour.
3. OPENING. The first three seconds are an image, not a sentence: something the camera holds before the subject is named. The opening family assigned in the request says how it behaves; "as-asked" means the first image is the one the user's request starts with.
4. ACTS. Divide the length into two to seven acts. Each act's UPPERCASE name is two to four words, a moment or an image of THIS film — the thing on screen when it starts ("THE EMPTY DRIVEWAY", "FLOUR ON THE COUNTER") — never a shot description and never its function: not INTRO, SETUP, THE PROBLEM, THE SOLUTION, CONCLUSION, RESOLUTION. Each act has a purpose (what the viewer knows or feels at its end that they did not before) and its seconds; the seconds add up to the film's length, and no act is shorter than five seconds. A film under a minute has two or three acts; five minutes has five to seven.
5. ENDING. The last image is earned by everything before it: a return to the first image changed, the answer to the opening question, the object at rest. Never a summary, never "and that is why", never a call to action.
6. VISUAL LANGUAGE. One world, written as one sentence a cinematographer could shoot from, not a checklist ("the lens is standard, the light is fluorescent"): the lens (long and compressed, or wide and close), the light (source, colour, time of day), the palette (three colours at most), the camera's temperament (does it drift, hold, follow). Every shot of the film is filmed inside this sentence. CONCRETE AND SHARP: name real surfaces the camera can hold in focus — wet tarmac, wood grain, brushed metal, skin, paper, frost — and one plane in focus per shot. Nothing smooth, glossy or computer-generated: a frame that looks rendered is a frame the viewer stops believing. IN ANIMATION the same sentence names the drawn world instead: the line (thin and clean, or brushy), how the backgrounds are painted, the shape language of the characters — design each once, in words (build, face, hair, clothes, colours), and repeat it verbatim in every shot — flat cel shading or soft, a palette of three colours. Nothing photographic in it: an animated frame that looks like a photograph is a frame in the wrong film.
7. PACING. The cut rhythm in seconds, act by act, and the one place where the film slows down on purpose. A film that cuts at the same speed throughout is wallpaper.
8. NARRATOR. Person (second person is a tool, not a default: "you" only for what the viewer themselves does or feels, never for what engineers, pirates or a spacecraft did), tense, sentence length, what they never do. The narrator is a person who knows this subject and is talking to one viewer, not a voice reading a brochure.
9. MOTIFS. Two to five images the film returns to. A motif seen three times is what makes eight independently generated shots feel like one film.
10. DECISIONS. List every choice you made that the request did not ask for, one per line, so the person who asked can see it and change it. With requirements, these are exactly the things LEFT TO KLEO that you decided — and nothing that contradicts an item. A decision names something that could have been otherwise and that the viewer will SEE: the place, the period, who is in it, the object that carries it, how it ends. "The tone is informative", "the period is contemporary" and "the setting is a hospital" repeated from the angle are not decisions.
11. ${LAYER_METHOD}
12. MUSIC. Only when the request says the user wants music (THE SOUND, below): write "music", ONE line for a composer — instrumental, the genre or the palette of instruments, the tempo, the mood, and how it moves with the acts ("sparse felt piano over a low synth pad, 60 bpm, patient; swells once in act two, thins to a single note at the end"). Never a known song, never an artist's name, never lyrics. When the user did not ask for music, "music" is null and nothing else is written about it.

THE BAR: the discipline of a good documentary sequence — concrete, human-scale, one strong image per beat, nothing decorative. Facts and names and numbers written in the request are kept, all of them. Nothing else is invented: no statistics, no quotes, no dates, no named people, no diagnoses, no makes of car that the request did not give; where the film needs a fact the request did not supply, use only what is common knowledge and prefer a concrete observation over a number.

THE PROSE is the film described from the first image to the last, act by act, in the present tense: what we see, what we hear, what changes. It is not a shot list: never "the camera cuts to", never "the narrator says" before every line. Quote the narrator at most once per act; the rest is what is on screen.

BANNED WORDS AND MOVES, because a model reaches for them when it has nothing to say: stunning, breathtaking, epic, journey, delve, unleash, tapestry, testament, nestled, bustling, vibrant, "in a world where", "imagine a", "join us", "let's dive", "the film explores", "the film argues", rhetorical questions in a row, a montage of the subject "from around the world", drone shots of cities at sunset, the same sentence rewritten as the ending.

THE LANGUAGE: every field is written in the language the request names as the language of the film — the logline, the angle, the acts' names, the decisions, the prose, all of it. Only "device" and "look" stay in English. Return the JSON object only: no prose before it, no markdown fences.`;

/** The user message of the treatment call: the request, the frame, the draw, and the shape to return. */
export interface TreatmentInput {
  prompt: string; duration_s: number; format: "16:9" | "9:16"; language: string; look?: FilmLook | null; sound?: SoundOptions;
  /** The request taken apart (src/spec.ts): printed ABOVE everything, and in FAITHFUL mode it replaces the draw. */
  spec?: RequestSpec | null;
  /**
   * true when the writer is writing the spec in the same breath (the assistant road of kleo_adapt_prompt): the spec is
   * not known yet, so the draw is printed as conditional — faithful when THEIR spec is faithful, drawn only when it is open.
   */
  specPending?: boolean;
}

/** THE SOUND and THE SUBTITLES as the method prints them: what the user answered, and what the treatment must write. */
export function soundText(sound: SoundOptions | undefined): string {
  const m = sound?.music, s = sound?.subtitles;
  const music = m === undefined || m === null
    ? `THE SOUND: the user was not asked about music — write "music": null.`
    : m.wanted
    ? `THE SOUND: the user WANTS MUSIC${m.brief ? ` and asked for "${m.brief}"` : " and named no kind"} — write "music": one line for the composer (step 12)${m.brief ? ", built on their words" : ", chosen for this film"}.`
    : `THE SOUND: the user wants NO music — write "music": null.`;
  const subs = s === undefined || s === null
    ? `SUBTITLES: not asked — leave "subtitles" to the layer's rule.`
    : s
    ? `SUBTITLES: the user WANTS them — "graphics" MUST be a layer with "subtitles":"cinema" (a layer with subtitles alone and an empty hud is a legal layer; keep any other element the film earns).`
    : `SUBTITLES: the user wants NONE — "subtitles":"none" whatever else the layer carries.`;
  return `${music}\n${subs}`;
}

export function treatmentPrompt(input: TreatmentInput, v0: Variation, feedback?: string[]): string {
  const faithful = isFaithful(input.spec);
  const v = effectiveVariation(input, v0);
  const lang = { en: "English", it: "Italian", fr: "French" }[input.language] ?? input.language;
  const kind = input.format === "9:16" ? "a vertical Short (9:16)" : "a YouTube film (16:9)";
  const actsHint = input.duration_s <= 60 ? "2-3" : input.duration_s <= 150 ? "3-4" : "4-7";
  // The language is said three times on purpose — here, in the shape, and at the end — because said once, in the
  // master prompt, the production model answered an Italian request in English five times out of six.
  const inLang = input.language === "en" ? "" : `\nLANGUAGE OF THIS TREATMENT: ${lang.toUpperCase()}. Every field below is written in ${lang}, the act names and the decisions included; only "device" and "look" stay in English.`;
  // THE SPEC FIRST (24 September 2026): the requirements are the brief, so they are read before the request's prose,
  // the frame and the draw — what a model reads first is what it builds on.
  const spec = input.spec ? `${specBlock(input.spec)}\n\n` : "";
  const pending = !input.spec && input.specPending
    ? `THE DRAW DEPENDS ON THE SPEC YOU WROTE. If its mode is FAITHFUL (the user described who is in it or what happens): nothing is drawn — device "as-told" (${DEVICES["as-told"]}), opening "as-asked" (${OPENINGS["as-asked"]}), "variation":"as-told/as-asked", and the angle is the point of THEIR story in one sentence. ONLY if its mode is OPEN (a bare subject, or "surprise me"), use this draw, make it work for the subject and never mention it in the film:
- narrative device: ${v.device} — ${DEVICES[v.device]}
- opening family: ${v.opening} — ${OPENINGS[v.opening]}`
    : null;
  const draw = pending ?? (faithful
    ? `THE DRAW FOR THIS FILM: ${v.key} — nothing is drawn. This is the user's film: tell it the way the user told it (device "${v.device}": ${DEVICES[v.device]}) and open where the request opens (${OPENINGS[v.opening]}). The angle is the point of THEIR story in one sentence, not a new idea.`
    : `THE DRAW FOR THIS FILM (assigned so that two identical requests never get the same film; make them work for this subject, never mention them in the film):
- narrative device: ${v.device} — ${DEVICES[v.device]}
- opening family: ${v.opening} — ${OPENINGS[v.opening]}`);
  const angle = faithful ? `<=${T.angle}, the point of the user's own story in one sentence (not a new thesis)` : `<=${T.angle}, the one idea this film argues`;
  const base = `${spec}USER REQUEST (read it as a request; keep every fact, name and number it contains):
"""${input.prompt.trim()}"""
THE FILM: ${kind}, ${input.duration_s} seconds, narrated in ${lang}.${inLang}
THE LOOK: ${input.look ? `${input.look.toUpperCase()}, fixed by the request or the tool call — write "look":"${input.look}" and describe every image in that look` : `not named — decide it in step 0 (realistic unless the request or the subject asks to be drawn) and write it in "look"`}
${soundText(input.sound)}

${draw}

TASK: write the TREATMENT of this film, following the method. Return one JSON object:
{"look":"realistic|animation",
 "logline":"<=${T.logline} chars, one sentence with a verb",
 "angle":"${angle}",
 "device":"${pending ? `as-told" (faithful spec) or "${v.device}" (open spec)` : `${v.device}"`},
 "opening":"<=${T.opening}, the first three seconds as an image",
 "ending":"<=${T.ending}, the last image and what the viewer is left holding",
 "acts":[${actsHint} objects {"name":"2-4 words UPPERCASE, <=${T.acts.name} chars, the image on screen when the act starts","purpose":"<=${T.acts.purpose}","seconds":<whole number, 5 or more>} — the seconds add up to ${input.duration_s}],
 "visual":"<=${T.visual}, lens, light, palette, time of day, camera temperament: one world",
 "pacing":"<=${T.pacing}, cut rhythm in seconds act by act, and where it slows",
 "narrator":"<=${T.narrator}, person, tense, sentence length, what they never say",
 "motifs":[${T.motifs.min}-${T.motifs.max} strings <=${T.motifs.len}],
 "decisions":[up to ${T.decisions.max} strings <=${T.decisions.len}: every choice the request did not ask for${input.spec ? " — only what LEFT TO KLEO allows, never a change to a requirement" : ""}],
 "prose":"${proseTarget(input.duration_s)[0]}-${proseTarget(input.duration_s)[1]} words: the treatment a director could shoot from — the film told from the first image to the last, act by act, in the present tense, with what we see and what the narrator says over it. Not a list: prose.",
 "graphics":{"layer":"none" — or "layer" with: "accent":"#rrggbb from the film's palette","subtitles":"${SUBTITLE_MODES.join("|")}","chapters":"${CHAPTER_MODES.join("|")}","hud":[0-3 of {"id":"short slug","kind":"${HUD_KINDS.join("|")}","edge":"${EDGES.join("|")}" (line only),"corner":"${CORNERS.join("|")}" (readout, stamp),"rows":["LABEL", …] (readout only, 1-4),"means":"what it stands for, <=60"}]},
 "music":"<=${T.music} chars, the composer's brief (step 12) — or null when the user wants no music"}${input.language === "en" ? "" : `\nEverything in ${lang}.`}`;
  return feedback?.length
    ? `${base}\n\nYOUR PREVIOUS ANSWER WAS REJECTED for these reasons; fix every one and return the whole object again:\n- ${feedback.join("\n- ")}`
    : base;
}

/** JSON schema for constrained decoding: flat, closed, no oneOf. */
export const treatmentSchema = (): Record<string, unknown> => {
  const str = { type: "string" };
  const strArr = { type: "array", items: str };
  return {
    type: "object",
    additionalProperties: false,
    required: ["look", "logline", "angle", "device", "opening", "ending", "acts", "visual", "pacing", "narrator", "motifs", "decisions", "prose", "graphics", "music"],
    properties: {
      look: { type: "string", enum: [...FILM_LOOKS] },
      // The composer's brief, or the word "none": a constrained decoder cannot write null, musicOf reads "none" as null.
      music: str,
      logline: str, angle: str, device: { type: "string", enum: [...DEVICE_IDS] }, opening: str, ending: str,
      acts: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "purpose", "seconds"], properties: { name: str, purpose: str, seconds: { type: "number" } } } },
      visual: str, pacing: str, narrator: str, motifs: strArr, decisions: strArr, prose: str,
      // The layer: every field required and closed, because a grammar-constrained decoder cannot skip a property.
      // "layer": "none" is the usual answer; the rest is then ignored.
      graphics: {
        type: "object", additionalProperties: false, required: ["layer", "accent", "subtitles", "chapters", "hud"],
        properties: {
          layer: { type: "string", enum: ["none", "layer"] }, accent: str,
          subtitles: { type: "string", enum: [...SUBTITLE_MODES] }, chapters: { type: "string", enum: [...CHAPTER_MODES] },
          hud: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "kind", "edge", "corner", "rows", "means"],
            properties: { id: str, kind: { type: "string", enum: [...HUD_KINDS] }, edge: { type: "string", enum: [...EDGES] }, corner: { type: "string", enum: [...CORNERS] }, rows: strArr, means: str } } },
        },
      },
    },
  };
};

/* ------------------------------------------------------------------ repair and check */

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const clipList = (v: unknown, max: number, len: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => clip(x, len)).filter(Boolean).slice(0, max);
export const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/**
 * The reasons a treatment is refused, in words the model (or the assistant that wrote it) can act on. Empty means
 * it is a treatment. Used on the model's answer before the repair, and on a client's object at kleo_create_video.
 */
/**
 * `lenient` is the second attempt's rule, the one the planner already uses for its scenes: a soft problem is asked
 * to be fixed once, and then a valid answer is kept. Here the only soft problem is a short prose — measured, the
 * production model writes about a hundred words whatever it is asked for, and sometimes fifty, and its second
 * attempt is no longer than its first (10 of 15 delivered with the floor at 100). The structured fields are the
 * substance; a treatment with everything right and a thin prose is a treatment, not a rejection.
 */
export const PROSE_LENIENT_MIN = 60;
/**
 * The prose a film's length deserves. A 30-second Short does not need the 180 words a five-minute film does, and
 * the production model does not write them for it: measured on 14 September, an Italian 30-second film got 65 and
 * 87 words twice and no treatment at all. The floor and the target scale with the length, inside the table's bounds.
 */
export const proseFloor = (duration_s?: number): number => duration_s ? Math.round(Math.min(T.prose.minWords, Math.max(PROSE_LENIENT_MIN, duration_s * 1.6))) : T.prose.minWords;
export const proseTarget = (duration_s: number): [number, number] => [Math.round(Math.min(T.prose.target[0], Math.max(120, duration_s * 4))), T.prose.target[1]];

/**
 * `faithful` (24 September 2026): the treatment of a film the user described (spec mode "faithful"). Its angle is
 * the point of the user's own story and may say what the logline says — the overlap rule, written to stop a producer
 * restating the subject, would send back exactly the treatment that stays with the user — and its device is "as-told".
 * Left undefined, a treatment that carries device "as-told" is read as faithful (a client's, or one read back); passed
 * false, "as-told" is refused, because a draw was assigned.
 */
export interface TreatmentCheckOptions { lenient?: boolean; look?: FilmLook | null; faithful?: boolean }

export function treatmentProblems(raw: unknown, duration_s?: number, language?: string, opts: TreatmentCheckOptions = {}): string[] {
  const out: string[] = [];
  if (!isObj(raw)) return ["the treatment must be a JSON object"];
  const faithful = opts.faithful ?? raw.device === "as-told";
  if (opts.faithful === false && raw.device === "as-told")
    out.push(`device: "as-told" is the device of a film the user described; this one was left to Kleo — use the device assigned in the draw`);
  const need = (k: string, min: number, max: number) => {
    const v = raw[k];
    if (typeof v !== "string" || v.trim().length < min) out.push(`${k}: missing or shorter than ${min} characters`);
    else if (v.length > max) out.push(`${k}: ${v.length} characters, the limit is ${max}`);
  };
  need("logline", 20, T.logline); need("angle", 20, T.angle); need("opening", 20, T.opening); need("ending", 20, T.ending);
  need("visual", 30, T.visual); need("pacing", 20, T.pacing); need("narrator", 20, T.narrator);
  if (raw.device !== undefined && !(DEVICE_IDS as readonly string[]).includes(String(raw.device))) out.push(`device: "${String(raw.device)}" is not one of ${DEVICE_IDS.join(", ")}`);
  if (raw.look !== undefined && !(FILM_LOOKS as readonly string[]).includes(String(raw.look))) out.push(`look: "${String(raw.look)}" is not one of ${FILM_LOOKS.join(", ")}`);
  else if (opts.look && typeof raw.look === "string" && raw.look !== opts.look) out.push(`look: the treatment says "${raw.look}" but the film was asked in "${opts.look}" — write it for that look, or pass style "${raw.look}"`);
  const acts = Array.isArray(raw.acts) ? raw.acts : [];
  if (acts.length < T.acts.min || acts.length > T.acts.max) out.push(`acts: ${acts.length}, it needs ${T.acts.min}-${T.acts.max}`);
  acts.forEach((a, i) => {
    if (!isObj(a) || typeof a.name !== "string" || !a.name.trim()) out.push(`act ${i + 1}: needs a name`);
    if (!isObj(a) || typeof a.purpose !== "string" || a.purpose.trim().length < 10) out.push(`act ${i + 1}: needs a purpose (what the viewer knows or feels at its end)`);
    if (!isObj(a) || typeof a.seconds !== "number" || !(a.seconds > 0)) out.push(`act ${i + 1}: needs seconds (a positive number)`);
  });
  if (duration_s && acts.length && acts.every((a) => isObj(a) && typeof a.seconds === "number")) {
    const sum = acts.reduce((n, a) => n + (a as Act).seconds, 0);
    if (sum < duration_s * 0.5 || sum > duration_s * 2) out.push(`acts: their seconds add up to ${Math.round(sum)}, the film is ${duration_s} seconds`);
  }
  const motifs = Array.isArray(raw.motifs) ? raw.motifs.filter((m) => typeof m === "string" && m.trim()) : [];
  if (motifs.length < T.motifs.min) out.push(`motifs: ${motifs.length}, it needs at least ${T.motifs.min} recurring images`);
  if (raw.decisions !== undefined && !Array.isArray(raw.decisions)) out.push("decisions: must be a list of strings");
  const prose = typeof raw.prose === "string" ? raw.prose : "";
  const words = wordCount(prose);
  const floor = proseFloor(duration_s);
  if (words < (opts.lenient ? Math.min(PROSE_LENIENT_MIN, floor) : floor)) out.push(`prose: ${words} words, it needs at least ${floor} — the treatment told from the first image to the last`);
  else if (words > T.prose.maxWords * 1.3 || prose.length > T.prose.maxChars * 1.3) out.push(`prose: ${words} words, the limit is ${T.prose.maxWords}`);
  // The checklist visual ("The lens is standard, the light is fluorescent, the palette is …"): asked not to, the
  // production model still wrote it in a whole planned film on 14 September, and the direction copied it as the world.
  if (typeof raw.visual === "string" && (raw.visual.match(/\b(?:the |il |la )?(?:lens|light|lighting|palette|camera|obiettivo|luce|palette|camera)(?:'s temperament)? (?:is|are|è|sono)\b/gi) ?? []).length >= 2)
    out.push("visual: a checklist (\"the lens is X, the light is Y\"); write ONE sentence a cinematographer could shoot from — the place, the hour, the light on real surfaces, how the camera behaves");
  // THE DEFECTS THE PRODUCTION MODEL ACTUALLY HAS, measured on fifteen treatments on 13 September and sent back in
  // words: an angle that is the logline again, acts named for their function, the device said out loud, and an
  // Italian film treated in English. Each of these was in most of the fifteen; none is caught by a schema.
  if (!faithful && typeof raw.logline === "string" && typeof raw.angle === "string" && overlap(raw.logline, raw.angle) >= 0.6)
    out.push("angle: it restates the logline in other words; the logline is what happens, the angle is what the film claims because of it — write the claim");
  acts.forEach((a, i) => { if (isObj(a) && typeof a.name === "string" && GENERIC_ACT.test(a.name.trim())) out.push(`act ${i + 1}: "${a.name.trim()}" is a function, not a name; name the moment or the image on screen when this act starts`); });
  const tell = DEVICE_TELLS[raw.device as Device];
  if (tell && typeof raw.logline === "string" && (tell.test(raw.logline) || (typeof raw.angle === "string" && tell.test(raw.angle))))
    out.push(`logline or angle: it names the narrative device ("${(raw.logline.match(tell) ?? (raw.angle as string).match(tell))?.[0]}"); the device stays invisible — say what happens, not how it is told`);
  if (language && prose) {
    const written = languageOf(`${prose} ${String(raw.logline ?? "")} ${String(raw.angle ?? "")}`);
    if (written && written !== language) out.push(`language: the treatment is written in ${written === "it" ? "Italian" : "English"}, the film is in ${language === "it" ? "Italian" : "English"} — write every field in ${language === "it" ? "Italian" : "English"}`);
  }
  // The layer: "none" in any spelling is fine and needs no more; a layer is held to the grammar of src/graphics.ts.
  if (raw.graphics !== undefined && !isNoLayer(raw.graphics)) for (const p of graphicsProblems(raw.graphics)) out.push(p);
  return out;
}

/**
 * The model's answer fitted to the limits, or null when it is not a treatment (treatmentProblems says why). The
 * acts are rescaled to the film's length — a model that wrote 70 seconds for a 60-second film wrote the right
 * proportions and the wrong sum, and a sum is not what a retry is for. The device falls back to the draw.
 */
export function repairTreatment(raw: unknown, duration_s: number, v: Variation, language?: string, opts: TreatmentCheckOptions = {}): Treatment | null {
  if (!isObj(raw) || treatmentProblems(raw, duration_s, language, opts).length) return null;
  // A faithful film is told as the user told it whatever device the model wrote: the draw is not the model's to redo.
  if (opts.faithful) v = faithfulVariation();
  // An act name longer than the limit is cut at a word, never inside one: "A LAB TECHNICIAN EXAMINING SAMPL" was
  // measured, and a name the outline copies is a name the viewer's chapter pill shows.
  const nameOf = (v: unknown) => { const s = clip(v, T.acts.name + 40).toUpperCase(); if (s.length <= T.acts.name) return s; const cut = s.slice(0, T.acts.name + 1); const at = cut.lastIndexOf(" "); return (at > 8 ? cut.slice(0, at) : cut.slice(0, T.acts.name)).trim(); };
  const acts0 = (raw.acts as Record<string, unknown>[]).map((a) => ({
    name: nameOf(a.name), purpose: clip(a.purpose, T.acts.purpose), seconds: Number(a.seconds),
  }));
  const sum = acts0.reduce((n, a) => n + a.seconds, 0) || 1;
  const acts: Act[] = acts0.map((a) => ({ ...a, seconds: Math.max(3, Math.round((a.seconds * duration_s) / sum)) }));
  // Rounding drift lands on the longest act, which can afford it.
  const drift = acts.reduce((n, a) => n + a.seconds, 0) - duration_s;
  if (drift !== 0) { const i = acts.indexOf(acts.reduce((a, b) => (b.seconds > a.seconds ? b : a))); acts[i].seconds = Math.max(3, acts[i].seconds - drift); }
  let prose = clip(raw.prose, T.prose.maxChars);
  const words = prose.split(/\s+/);
  if (words.length > T.prose.maxWords) prose = words.slice(0, T.prose.maxWords).join(" ");
  const device = opts.faithful ? "as-told" : (DEVICE_IDS as readonly string[]).includes(String(raw.device)) ? (raw.device as Device) : v.device;
  return {
    look: opts.look ?? ((FILM_LOOKS as readonly string[]).includes(String(raw.look)) ? (raw.look as FilmLook) : "realistic"),
    logline: clip(raw.logline, T.logline), angle: clip(raw.angle, T.angle), device,
    opening: clip(raw.opening, T.opening), ending: clip(raw.ending, T.ending), acts,
    visual: clip(raw.visual, T.visual), pacing: clip(raw.pacing, T.pacing), narrator: clip(raw.narrator, T.narrator),
    motifs: clipList(raw.motifs, T.motifs.max, T.motifs.len),
    decisions: clipList(raw.decisions, T.decisions.max + 4, T.decisions.len).filter((d) => !NON_DECISION.test(d)).slice(0, T.decisions.max),
    prose, variation: !opts.faithful && typeof raw.variation === "string" && raw.variation ? clip(raw.variation, 80) : v.key,
    graphics: raw.graphics === undefined ? null : repairGraphics(raw.graphics),
    music: musicOf(raw.music),
  };
}

/**
 * THE USER'S TWO ANSWERS, applied to a treatment (22 September 2026). Whoever wrote the treatment — the assistant
 * under the method, the server's model, or a treatment reused from an earlier job — the film carries what the user
 * answered: music yes/no (with their words when the treatment wrote no brief), subtitles yes/no. A "yes" to subtitles
 * on a film with no layer makes the layer (subtitles alone, an empty hud), which the engine draws as subtitles and
 * nothing else. Nothing is asked here: what is undefined was not asked and stays as written.
 */
export function applySoundOptions(t: Treatment, sound: SoundOptions | undefined): Treatment {
  if (!sound) return t;
  const out: Treatment = { ...t };
  if (sound.music !== undefined && sound.music !== null) {
    out.music = sound.music.wanted ? (t.music ?? sound.music.brief ?? "a quiet instrumental bed that fits the film's mood, under the narration") : null;
  }
  if (sound.subtitles === true) {
    out.graphics = repairGraphics({ accent: "#ffffff", chapters: "none", hud: [], ...(t.graphics ?? {}), subtitles: "cinema" });
  } else if (sound.subtitles === false && t.graphics) {
    out.graphics = repairGraphics({ ...t.graphics, subtitles: "none" });   // null when the layer had nothing else on it
  }
  return out;
}

/** A treatment read back from a job's params or a storyboard: the shape is trusted only after this. */
export function treatmentOf(x: unknown): Treatment | null {
  if (!isObj(x) || !isObj(x.treatment)) return null;
  const t = x.treatment;
  const acts = Array.isArray(t.acts) ? t.acts.filter(isObj) : [];
  const sum = acts.reduce((n, a) => n + (typeof a.seconds === "number" ? a.seconds : 0), 0);
  // A treatment told "as-told" is read back as the faithful treatment it is: the angle-overlap rule was never its rule.
  const faithful = t.device === "as-told" || (typeof t.variation === "string" && t.variation.startsWith("as-told"));
  const v = faithful ? faithfulVariation() : variationFor(typeof t.variation === "string" ? t.variation : "");
  return repairTreatment(t, sum > 0 ? sum : 60, v, undefined, faithful ? { faithful: true } : {});
}

/* ------------------------------------------------------------------ how different two treatments are */

/**
 * The share of words (four letters and more) two texts do NOT have in common, over the union: 0 is the same film
 * written twice, 1 is nothing shared. The one number the variation is measured by (scripts/treatment-make.mjs and
 * the admin route both read it from here, so they cannot disagree).
 */
export function proseDistance(a: string, b: string): number {
  const bag = (s: string) => new Set((s.toLowerCase().match(/[\p{L}]{4,}/gu) ?? []));
  const A = bag(a), B = bag(b);
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  const union = new Set([...A, ...B]).size;
  return union ? 1 - both / union : 0;
}

/* ------------------------------------------------------------------ what the other stages read */

/**
 * The treatment as the direction, the outline and the scenes read it. `full` adds the prose, which the two stages
 * that shape the film get and the scene chunks do not: eight copies of four hundred words buy nothing a scene needs.
 */
/** The look as the other stages read it: one line that says what every picture IS. */
export const LOOK_LINES: Record<FilmLook, string> = {
  realistic: "REALISTIC — live-action photography: every picture is a photograph the camera could take",
  animation: "ANIMATION — a 2D animated film: every picture is a drawn frame, the characters designed once and drawn the same in every shot, nothing photographic",
};

export function treatmentBlock(t: Treatment, full = false): string {
  const acts = t.acts.map((a, i) => `  ${i + 1}. ${a.name} · ${a.seconds}s — ${a.purpose}`).join("\n");
  return `TREATMENT OF THIS FILM (the request as a producer expanded it; the direction and every scene follow it):
Look: ${LOOK_LINES[t.look] ?? LOOK_LINES.realistic}
Logline: ${t.logline}
Angle: ${t.angle}
Device: ${t.device} — ${DEVICES[t.device] ?? ""}
Opens on: ${t.opening}
Ends on: ${t.ending}
Acts (${t.acts.reduce((n, a) => n + a.seconds, 0)}s in all):
${acts}
Visual language (every shot lives inside this): ${t.visual}
Pacing: ${t.pacing}
Narrator: ${t.narrator}
Motifs (return to these): ${t.motifs.join("; ")}${t.graphics ? `\n${graphicsBlock(t.graphics)}` : "\nThe layer: none — nothing is drawn over the film."}
Music: ${t.music ? `${t.music} (an instrumental track under the narration, ducked under the voice; the narration leaves it room between the acts)` : "none — narration only."}${full ? `\nThe treatment, in prose:\n${t.prose}` : ""}`;
}

/**
 * THE FREE ROAD: the method handed to the assistant that called kleo_adapt_prompt, so that the assistant's own
 * model — Claude, GPT — writes the treatment instead of the 17B model on the server. Measured on 14 September on
 * two whole films: the server's model wrote a checklist for a world, a platitude for an angle, no layer for a
 * request full of dates and distances, and diagrams into the pictures; a frontier model writing under the same
 * method is the difference between that and the owner's own packages. The server still checks what comes back
 * (treatmentProblems, at kleo_create_video), and still writes its own when nothing comes.
 */
export function treatmentMethodText(input: TreatmentInput, v0: Variation): string {
  // With a spec the requirements are printed by treatmentPrompt() above the request (specBlock), and a FAITHFUL spec
  // replaces the caller's random draw with "as-told/as-asked" — so the assistant's treatment and the server's agree.
  const v = effectiveVariation(input, v0);
  const faithful = isFaithful(input.spec)
    ? `\nThis is the user's film (FAITHFUL): every MUST requirement above is seen or heard, their events keep their order, their characters look exactly as written; list in "decisions" only what LEFT TO KLEO allowed you to decide.`
    : "";
  return `WRITE THE TREATMENT YOURSELF, NOW, following this method exactly; then pass the JSON object as "treatment" to kleo_create_video. Do not paraphrase the method to the user: tell them the logline and the decisions once it is written.

${MASTER_PROMPT}

${treatmentPrompt(input, v)}

Add "variation":"${!input.spec && input.specPending ? `as-told/as-asked" when your spec is faithful, "${v.key}" when it is open` : `${v.key}"`} to the object. Kleo checks it before anything is charged and answers with the field to fix if something is off.${faithful}`;
}

/** The treatment for the assistant that called kleo_adapt_prompt: what to tell the user, and what to do next. */
export function treatmentText(t: Treatment): string {
  const acts = t.acts.map((a, i) => `${i + 1}. ${a.name} (${a.seconds}s): ${a.purpose}`).join(" · ");
  const decisions = t.decisions.length ? `\nKleo decided on its own (change any of these if the user disagrees):\n- ${t.decisions.join("\n- ")}` : "";
  return `Treatment written (draw ${t.variation}):
Logline: ${t.logline}
Angle: ${t.angle}
Opens on: ${t.opening}
Ends on: ${t.ending}
Acts: ${acts}
Look: ${t.look === "animation" ? "animation (a 2D animated film)" : "realistic (filmed)"}
Visual world: ${t.visual}
Pacing: ${t.pacing}
Narrator: ${t.narrator}
Motifs: ${t.motifs.join("; ")}
Layer over the film: ${t.graphics ? `${t.graphics.hud.map((h) => `${h.kind} "${h.id}" (${h.means})`).join(", ") || "no persistent element"}; subtitles ${t.graphics.subtitles}; chapters ${t.graphics.chapters}; accent ${t.graphics.accent}` : "none"}
Music: ${t.music ?? "none"}${decisions}

${t.prose}

NEXT STEP: tell the user the logline and the decisions in one or two sentences. If they want something changed, edit the fields and pass the whole object as "treatment" to kleo_create_video; otherwise pass it unchanged. Kleo plans the direction and every scene under it.`;
}
