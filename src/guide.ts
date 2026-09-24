/**
 * THE GUIDE: what kleo_storyboard_guide hands the calling assistant.
 *
 * This is the most valuable surface in the product and it used to be the least designed. One string of about six
 * thousand words described, all at once, four Kleo looks, six Keou looks, the picture schema, the cyber beat
 * vocabulary with its twenty-three icons, the stickman schema, the four editorial schemas, the entire validator
 * ruleset on a single line, and three worked examples. A model writing a cartoon Short read all of it — including the
 * instructions for three films it was not writing — and the instructions that mattered were diluted by the ones that
 * did not.
 *
 * Two things changed here.
 *
 * 1. THE GUIDE IS FOR ONE FILM. The caller says which look it wants and gets that look's vocabulary and that look's
 *    example, plus one line each about the others. The rules that apply to every look are written once.
 * 2. THE GUIDE TEACHES THE REASONING, NOT ONLY THE SCHEMA. It opens with the DIRECTION — the art direction of this one
 *    film, written before any scene exists — because that is the step the product was missing: Kleo went from the
 *    user's sentence straight to a list of scenes, and nothing in between ever decided what the film was made of.
 *
 * The text is assembled from the contract's own constants, never from copies of them: the shot range printed here is
 * the shot range the validator enforces, which is how the guide, the planner and the website stopped saying three
 * different numbers for the same rule.
 */
import {
  STYLES, CINEMA_ACCENTS, BEAT_KINDS, BEAT_ICONS, BEAT_FX, VISUALS, VOICES, KLEO_STYLES,
  STORY_ACTS, STORY_CAST, STORY_PROPS, STORY_FX,
  IMAGE_PROMPT_MAX, SHOT_CAPTION_MAX, SHOT_HL_MAX, SHOT_AT_MAX, CLOSING_BUTTON_MAX,
  MAX_PICTURES, SHOTS_MIN_CINEMA, shotRangeText, SHOTS_PER_SCENE, wordBudget,
  DIRECTION_LIMITS as DL, SHOT_KINDS,
  SKETCH_ACCENTS, SKETCH_ART, SKETCH_MOODS, SKETCH_MOTION, SKETCH_ENTER, SKETCH_EXIT,
  SHOT_ACTION_MAX, SHOT_COVERS_MAX, SHOT_CAST_MAX, SHOT_TAG_MAX,
} from "./keou-contract.ts";
import { GL, LINE_STATES } from "./graphics.ts";

/** The looks a job can be written in, and which schema section each one needs. */
export type GuideStyle = "cartoon" | "realistic" | "animation" | "cyber" | "stickman" | "explainer";
const PICTURE_LOOKS: readonly GuideStyle[] = ["cartoon", "realistic", "animation"];

export interface GuideOptions {
  /** The template the caller intends to use; only tailors the target length. */
  template?: string;
  templateName?: string;
  /** Target length in seconds. */
  duration_s?: number;
  /** The look this storyboard is for. Without it the guide teaches the picture looks and summarises the other two. */
  style?: GuideStyle | null;
  /** Languages kleo_create_video accepts, so the guide can never offer one the tool refuses. */
  languages: readonly string[];
  /** The frame the storyboard is written for: the explainer authors its art in the frame's own pixels. */
  format?: string;
}

const list = (a: readonly string[]) => a.join(", ");
const quoted = (a: readonly string[]) => a.map((x) => `"${x}"`).join(" | ");

/* ------------------------------------------------------------------ the direction */

/**
 * The direction block. Everything else in the guide describes a shape; this describes a decision, and it is the one
 * the finished video is actually judged on — whether it is about what the user wrote.
 */
function directionSection(scenes: string): string {
  return `1. THE DIRECTION — write this FIRST, before a single scene
Read the user's request as a request, not as raw material, and answer these ten questions once. Everything after this obeys it. It travels with the storyboard as "direction" and Kleo enforces it: the pictures are drawn from it, and a storyboard that contradicts it is refused before anything is billed.

"direction": {
 "subject":   "<=${DL.subject}  the one thing the video is about, in the user's own terms",
 "goal":      "<=${DL.goal}  what the viewer should understand or feel by the end",
 "audience":  "<=${DL.audience}  who is watching",
 "tone":      "<=${DL.tone}  calm and factual / playful / ominous / warm",
 "must_keep": [up to ${DL.mustKeep.max} strings <=${DL.mustKeep.len}],
 "world":     "<=${DL.world}  the place, period, light and material everything is drawn in — one sentence a picture can be built from",
 "cast":      [up to ${DL.cast.max} {"name":"<=${DL.cast.name}","look":"<=${DL.cast.look}"}],
 "objects":   [${DL.objects.min}-${DL.objects.max} strings <=${DL.objects.len}],
 "forbidden": [${DL.forbidden.min}-${DL.forbidden.max} strings <=${DL.forbidden.len}],
 "sections":  [${DL.sections.min}-${DL.sections.max} {"name":"<=${DL.sections.name} UPPERCASE","accent":${quoted(CINEMA_ACCENTS)},"means":"<=${DL.sections.means}","scenes":<whole number>}]
}

 must_keep is QUOTED FROM THE REQUEST, never invented. If the user wrote "5 mistakes", "in Naples", "for beginners", "under 300 euros" or any number, it goes here — and Kleo checks that the finished narration still says it. A fact listed here and missing from the narration is a rejected storyboard, not a warning. An APPEARANCE the user asked for ("a lilac apron", "short blonde hair") is kept here too, but it is proven by the pictures, never read aloud: write it into the cast look, not into a voice line.
 world is what stops twelve independently drawn pictures from looking like twelve different films. Write it once, concretely.
 cast is the reason a character stays the same character: the "look" string is repeated word for word in every picture that shows them. Write the FULL look, up to ${DL.cast.look} characters — every attribute the user gave (age, build, face, hair, clothes and their colours, what they carry), plus whatever a painter still needs; never shortened to a role. The name is the one the user gave: a fictional character the user named keeps that name ("Mara", "Captain Oyelaran"); a character they did not name is called by their role ("the captain", "the cabin boy"). Never a real living person or a celebrity. Every shot then says who is in its picture with "cast" (below): that list, not a guess from the words, is what attaches each look to the picture.
 objects is the vocabulary of THIS film and nothing else. Pirates: beach, sand, wooden chest, red-sailed ship, rope, lantern. Space: launch pad, rocket, orbital station, visor, cable.
 forbidden is what makes a film its own, and it is the field most people skip. Name (a) the things an image generator adds by habit — text in the picture, logos, watermarks, extra fingers — and (b) the things that belong to a DIFFERENT subject than this one. A pirate film forbids wifi symbols, phones, screens and modern clothing. Kleo sends this to the image model as a negative prompt and refuses any picture description that asks for something on the list.
 sections are the colour law. They tile the video in order, and their "scenes" add up to EXACTLY the number of scenes you write — you choose that number (${scenes} is the range for this length), then make the sections sum to the number you chose, not to the range. Two sections in a row NEVER share an accent. Every scene then wears its section's accent — you do not pick accents per scene, and Kleo refuses a scene wearing the wrong one. One colour, one part of the story, one meaning: that is the whole of it.`;
}

/* ------------------------------------------------------------------ the user's requirements (the spec) */

/**
 * THE SPEC (24 September 2026): when kleo_adapt_prompt took the user's request apart into requirements (src/spec.ts),
 * the storyboard is written against them and says, shot by shot, which ones it shows. This is how a film stops being
 * "about the subject" and becomes the film the user described: the planner, the stills engine and the fidelity judge
 * all read the same three shot fields, and the numbers here are the contract's.
 */
function specSection(): string {
  return `1b. THE USER'S REQUIREMENTS — when the job has a SPEC
When kleo_adapt_prompt gave you a spec for this film (requirements R1, R2… and a cast c1, c2…), it is the brief and the storyboard is checked against it before anything is billed:
 Every MUST requirement is in the film: a VISUAL one (a character, a look, a place, an object, an action, an event, a framing, a text) is shown by at least one shot that lists its id in "covers"; a LINE the narrator must say is said in a scene's "voice", in the user's words. None is dropped or made generic.
 The user's EVENTS keep the user's ORDER: the first shot that covers event #2 comes after the first one that covers event #1.
 The CAST: one direction cast member per spec cast member, with the spec's name and its full look; every shot lists the characters in its picture in "cast" (their spec id "c1" or their cast name).
 A shot that covers a "text" requirement may, and must, draw THOSE EXACT WORDS in the picture (in quotes in its image_prompt) — the one exception to "no text in the picture". Nothing else in any picture is written.
 FAITHFUL mode: the story is the user's — their characters, their events in their order, their place, their style; add only what the spec leaves open. Spectacle the user asked for is shown; human scale is the rule only where they left it to you.
The three shot fields (Kleo reads them on the server; the engine never sees them):
 "covers": [up to ${SHOT_COVERS_MAX} spec item ids this picture SHOWS] — only what a viewer could point at in the frame.
 "cast":   [up to ${SHOT_CAST_MAX} spec cast ids or cast names, each <=${SHOT_TAG_MAX} chars] — who is in the picture; [] or absent when nobody is.
 "action": "<=${SHOT_ACTION_MAX} chars, English: what moves or happens during the shot" — the clip is generated from it; the picture is drawn from image_prompt alone.`;
}

/* ------------------------------------------------------------------ the layer (optional) */

/**
 * What may be drawn OVER the film, decided for THIS film and never by a look: src/graphics.ts is the grammar, and
 * this prints it from the same constants. Most films have no layer; the ones about a number, a date, a delay or a
 * state that holds through the film get one, and every element on it means one thing.
 */
function layerSection(): string {
  return `3b. THE LAYER — optional, and "none" is the usual answer
A film that is about something the viewer must READ (a number that keeps changing, a date, a delay, a distance, a state that holds through the film) may carry a layer over the footage. Decide it for this film; write it at the top level and speak to it from every scene. Nothing outside this grammar exists: no icons, no logos, no lower thirds, no sentences on cards. SUBTITLES are the USER'S answer, not yours: when they said yes, "graphics" exists and carries "subtitles":"cinema" (an empty hud is fine); when they said no, "none". MUSIC is the user's answer too: when they said yes, write at the top level "music":"track" and "music_brief":"<=300 chars, one line for a composer: instrumental, genre or instruments, tempo, mood, how it follows the acts — never a known song or artist"; when they said no, "music":"none". A DISSOLVE between two acts is placed by Kleo (one per 25 seconds, at a chapter change): you may pre-empt it with "transition":"dissolve" on the scene that OPENS an act, never on the first scene and never inside an act.
"graphics": {"accent":"#rrggbb from the film's own palette, the layer's only ink","subtitles":"none"|"cinema" (thin, white, lowercase, no karaoke),"chapters":"none"|"film" (the scene's chapter in light capitals),
 "hud":[up to ${GL.hud.max} of: {"id":"<slug>","kind":"line","edge":"bottom"|"top","means":"<=${GL.means}, the one thing it stands for"} · {"id":"<slug>","kind":"readout","corner":"top-left"|"top-right"|"bottom-left"|"bottom-right","rows":["LABEL" x${GL.rows.min}-${GL.rows.max}, <=${GL.rows.len} chars],"means":"…"} · {"id":"<slug>","kind":"stamp","corner":"…","means":"…"}]}
Then on every scene: "hud":{"<line id>":${LINE_STATES.map((s) => `"${s}"`).join("|")}, "<readout id>":["<value per row, <=${GL.value}>", …], "<stamp id>":"<=${GL.stamp}"} — the state or the values AT THAT SCENE, changing only when the story changes them — and, at most ${GL.card.perScene} per scene, "cards":[{"at":"<words copied from this scene's voice>","text":"<=${GL.card.text}, a figure or a date, never a sentence","hold":${GL.card.defaultHold}}].
Kleo refuses a scene that speaks to an element the film does not have, a card that is not a figure, and hud or cards on a film with no "graphics".
`;
}

/* ------------------------------------------------------------------ per-look sections */

function pictureSection(look: "cartoon" | "realistic" | "animation", dur: number): string {
  const kind = look === "cartoon" ? "flat vector cartoon illustration" : look === "animation" ? "frame of a 2D animated feature film (a painted background; drawn characters designed once in the direction's cast and described the same way in every shot; cel colour; nothing photographic)" : "cinematic photograph";
  return `3. THE SCENES — ${look}: full-screen pictures cut on the narration
The whole video is these pictures, cut like a short documentary. No icons, no cards, no beats, no HUD.
The same storyboard serves the FILM (each frame becomes a generated clip) and the ANIMATIC (the camera moves over the frame itself): write every image_prompt as one still that also reads well when it moves.

SCENE: {"id":"01-hook","kind":"cinema","chapter":"01 THE CAPTAIN <=32","accent":<its section's accent>,"title":"<=90, the line shown on the first picture","hl":"<=24, ONE word of the title","voice":"1-3 sentences <=350 chars","hold":0.2,"shots":[${shotRangeText("cinema")} pictures]}
CLOSING (always the last scene): {"id":"…","kind":"closing", …, "shots":[${shotRangeText("closing")}, one is the norm], "button":"<=${CLOSING_BUTTON_MAX}, default Subscribe" OR "detail":"<=110", never both}

SHOT: {"image_prompt":"ONE sentence <=${IMAGE_PROMPT_MAX} chars","caption"?:"2-5 BIG WORDS <=${SHOT_CAPTION_MAX}","hl"?:"ONE WORD OF caption <=${SHOT_HL_MAX}","at"?:"<=${SHOT_AT_MAX} chars","shot_kind"?:${quoted(SHOT_KINDS)},"cast"?:["c1" or a cast name, up to ${SHOT_CAST_MAX}],"covers"?:["R1", up to ${SHOT_COVERS_MAX}],"action"?:"<=${SHOT_ACTION_MAX}, English, what moves during the shot"}
 A shot carries these eight keys and no others. "cast" names who is in the picture, "covers" the spec requirements it shows (when the job has a spec, 1b), "action" what moves in it.

 EVERY SCENE SHOWS AT LEAST ${SHOTS_MIN_CINEMA} PICTURES. ${SHOTS_MIN_CINEMA}-3 is the usual rhythm. One picture held for a whole narrated line is a slideshow, and Kleo refuses it: split the line into its moments and give each moment its own picture.
 EVERY PICTURE AFTER THE FIRST CARRIES "at". "at" is an unbroken run of whole words copied character for character out of THAT scene's own "voice" — punctuation included, case ignored. The picture cuts the instant those words are spoken. From "only one cabin boy swam back to shore" take "swam back"; never a fragment ("wam bac"), never a paraphrase ("he swam"), never a jump across punctuation. The first shot of a scene opens with the scene and must NOT carry "at". Place the anchors along the line in reading order.
 image_prompt is ALWAYS WRITTEN IN ENGLISH, whatever language the film is narrated in: the picture model reads English only, and a prompt in another language is drawn wrong (Kleo refuses it). It describes ONE ${kind}: a concrete subject, a place, an action, the light and the mood. A recurring character is called by their cast name in every picture that shows them ("the pastry chef" or "Mara", never "she") AND listed in the shot's "cast": that is what attaches their one full description to the picture. Consecutive shots of one scene are the next moment or a new angle of the same place. Everything you write must come from the direction's world and objects; anything on the direction's forbidden list is refused. Never ask for text, letters, numbers, logos or captions inside the picture — except the exact words of a spec "text" requirement on the shot that covers it — and never a real person.
 SOMETHING IN EVERY PICTURE MUST BE DOING SOMETHING. Name a subject and give it an action, in the -ing form: "mist DRIFTING fast across the tarmac", "the flame GUTTERING", "waves BREAKING against the hull", "sand BLOWING across the road" — and say it again, for the clip, in the shot's "action". Naming the thing is not enough — "low mist" and "dust in the air" are states, and a shot with only those in it comes back (in the film) as a frozen frame; it was measured at 0.03 pixels of movement. The one exception is a person or an animal: they breathe and turn their head on their own, so a picture that shows someone needs nothing added. Write the action yourself — if you leave it out, Kleo writes one into "action" for you (never into your image_prompt), and it will not be the one you would have chosen.
 caption is optional and rare: 2-5 strong words on the shot that carries the idea (the first shot falls back to the scene title).

 shot_kind says what the shot is FOR. NEVER write a camera move, a zoom, a pan or a direction anywhere — Kleo owns the camera and picks the move from the kind; a hand-written move is refused.
  hook = the opening jolt, the first shot of the video · establish = where we are · face = one face or animal carrying the feeling · detail = one object, close · detail_orbit = one object worth circling · action = something moving through the frame · reveal = the frame opens on the answer · tension = the moment before it goes wrong · closing = the last picture of the video
  static_forced = the picture must NOT move. Use it whenever the shot shows visible hands doing something, a crowd, readable signs or writing, a mechanism with moving parts, or two people interacting: those break under any camera move. Kleo forces this kind when it recognises them; two such pictures in a row both hold (allowed), and a different subject on the next shot cuts better.
  Leave shot_kind out and Kleo chooses. Two shots in a row never get the same sort of move, and the loud kinds (hook, tension, detail_orbit) stay rare and never touch.

 Kleo draws a picture for every shot you write: about ${MAX_PICTURES(dur)} is the ceiling for a video of this length. Each is named "<scene id>-s<shot number>", so a scene id must never itself end in "-s" and a number. Never set scene.image, shot.image or a scene-level image_prompt.`;
}

function cyberSection(): string {
  return `3. THE SCENES — cyber: motion design, no pictures at all
Dark ground, glowing icons, big type. Every scene is "cinema" (last one "closing").

SCENE: {"id":"01-hook","kind":"cinema","chapter":"01 HOOK <=32","accent":<its section's accent>,"title":"<=90","hl":"<=24 word of the title","voice":"1-3 sentences <=350","hold":0.2,"beats":[4-8 beats of DIFFERENT kinds]}
BEATS (each may carry "at": 1-3 words <=${SHOT_AT_MAX} copied verbatim from that scene's voice, to sync the cut; the first beat of the hook is a slammed "type"):
 {"kind":"type","text":"2-4 UPPERCASE WORDS <=40","hl":"<=20","slam":true,"icon"?:<icon>}   big typographic card
 {"kind":"icon","name":<icon>,"label"?:"<=24","fx"?:<fx>,"size"?:0.6}                        one hero icon
 {"kind":"split","items":[<icon>,<icon>],"label"?:"<=24"}   cause → effect
 {"kind":"grid","items":[2-3 icons],"label"?:"<=24"}
 {"kind":"steps","items":["<=14","<=14","<=14"],"lit"?:2}   2-4 steps
 {"kind":"people","total":10,"lit":8,"label"?:"<=32"}   x out of y, max 12
 {"kind":"bars","labels":["<=14"],"values":[integers 0-1000000]}   1-4 values
 {"kind":"timeline","labels":["<=14" x2-4],"icons"?:[<icon> per label]}
 {"kind":"dialog","text":"<=32","count"?:3} · {"kind":"terminal","lines":["<=48" x1-4],"label"?:"<=16"} · {"kind":"cta","label"?:"<=24","toggles"?:["<=14" x1-3]}  (cta: closing only)
BEAT KINDS: ${list(BEAT_KINDS)}
ICONS (the only objects this look can draw — pick the closest metaphor and lean on "type" beats for everything else): ${list(BEAT_ICONS)}
 figure = the viewer · thief = the villain · radar = search · shield = safety · timer/clock = time · wave = signal · house/car/phone = places and things
FX: ${list(BEAT_FX)}
The closing scene keeps beats (a "type" beat with the loop question, then a "cta") plus a "detail" line <=110.`;
}

/**
 * The explainer. Everything the model would otherwise invent is printed here: the drawings grouped by
 * what they MEAN (a flat list of fifty-nine names is a list nobody chooses well from),
 * the eight motions, the five accents, the shot object and the rule that a cue must quote words that
 * are really spoken — because worker/keou/contract.py rejects anything else, and it rejects it on a
 * machine the account has already paid for.
 */
function explainerSection(dur: number, format: string): string {
  const [fw, fh] = format === "9:16" ? [1080, 1920] : [1920, 1080];
  const short = dur <= 90;
  return `THE CYBER EXPLAINER LOOK (style "explainer", ${format})
Hand-drawn white marker line art on pure black. Rough, pressure-varying stroke, never clean vector.
Objects in three-quarter view with a soft grey interior; everything else is outline. White dust drifts.
The ONLY text on screen is the caption line, burned in, ALL CAPS, one word lit green as it is spoken.
No titles, no logos, no end card, no subscribe: the film ends on its last drawing.

THE ONE RULE THAT MAKES IT WORK: every phrase gets its own picture, and the picture is literally what
the words say. "If you are worried" is a face with raised inner brows, not a mood. "Read one card" is
a hand holding a card against a reader. Never a symbol where the thing itself can be drawn.

COLOUR LAW: one accent per scene and never two in a frame.
  ${quoted(SKETCH_ACCENTS)}
  red = the hidden threat · blue = the attacker's radio · green = the light that says everything is fine
  yellow = scale and money · white = no accent, the plain world.

SCENE (kind "sketch"): {"id","kind":"sketch","voice","accent","enter","exit","shot":{"zoom":[a,b],"focus":[x,y]},"art":[…],"hold"}
  voice   one narrated sentence, ${short ? "8-14" : "12-20"} words.
  enter   ${quoted(SKETCH_ENTER)} — "whip" smears into the shot, "cut" is a hard cut.
  exit    ${quoted(SKETCH_EXIT)} — "flare" blooms the accent out of the frame; use it once per film.
  shot    the camera. zoom [start,end] with end GREATER than start: it never stops pushing in.
          focus is the point it pushes toward, in this frame's pixels (0-${fw} by 0-${fh}).
  hold    silence after the line, 0.05 is normal — the explainer does not pause.

ART (1-8 per scene, drawn in order, each one anchored to the words it illustrates):
  {"name","at","until","x","y","size","motion","motion_over","drawn", …}
  name    one of these, and nothing else. They are grouped by what they say, not by what they look like:
          people      figure (the viewer, with "reach") · face (a feeling, with "mood") · crowd (many, "count")
                      intruder (the attacker) · handshake (a deal) · hand (holding something) · robot (a machine that decides)
          the body    eye (being watched, "no" strikes it out) · brain (thinking, a model) · fingerprint (identity)
          machines    phone · laptop · server (a rack) · router (the box the signal leaves) · camera (CCTV)
                      chip (the silicon) · usb (what you plug in) · car · satellite · writer (the card writer)
          security    lock ("open" 0-1 swings the shackle) · key · keycard · reader · shield ("flash" ticks it, "no" cracks it)
                      bug (malware) · signal (a broadcast) · footprints (someone was here) · crowbar (nothing was forced)
          data        code (a window of it) · folder · cloud · graph (a network) · chart (a line, "flip" sends it down)
                      envelope (the message) · chain (links, "no" breaks one) · gear (the mechanism) · scale (the trade-off)
          places      door ("open_to") · room · corridor · hotels · city · globe · tree
          quantities  coin (money) · clock (time) · calendar (the date) · blank (how many, "count") · box (a parcel)
          ideas       question · warning · bulb (the idea, "flash" lights it) · magnifier (looking closer)
                      book (the rule nobody read) · rocket (a launch) · bell (an alarm that did not ring)
                      suitcase (the guest) · tag (a label, "text" ≤24 — the ONLY drawing that carries words)
  at      WHEN it appears: either a number (fraction of the scene) or a quoted piece of THIS scene's
          voice, e.g. "at":"read one card". Quote the words exactly as they are spoken.
  until   when it leaves, same two forms. Give a drawing an "until" and its successor an "at" on the
          same words: they overlap, so the frame is never empty.
  x,y     where it sits, in this frame's pixels. size 1 is the drawing's natural size.
          ROOM (measured, not guessed): a drawing is about 420 wide and 383 tall at size 1, so two of
          them need roughly 450 pixels between their centres or they overlap. The big ones need more:
          crowbar 949x840, chain 750 wide, bell 680x684, door 761 tall, face and intruder about 620.
          The small ones need far less: tag 178x107, lock 245x286, coin 257x343.
          OVERLAP IS ALLOWED AND SOMETIMES RIGHT — a hand ON a card is the point of that shot — but only
          when you mean it. Two drawings that merely landed on each other read as one broken object,
          because the nearer one paints an opaque black body over the other.
          These six ARE the space the rest stand in, and everything goes ON them, never beside them:
          room, corridor, blank, reader, city, hotels.
          THE CAPTION OWNS THE BOTTOM ${Math.round(fh * .22)} PIXELS: it is burned in from ${Math.round(fh * .78)} down, so
          nothing may sit under it. Keep y at or under ${Math.round(fh * .70)} for anything the viewer has to read.
  motion  ${quoted(SKETCH_MOTION)} — what the drawing DOES while it is on screen.
  drawn   true means it is already on the page at the scene's first frame. Use it on the very first
          drawing of the film and on the first drawing after a flare, or the film opens on black.
  extras  tint (the whole drawing in an accent) · led/beam/chip (an accent on ONE part of it)
          mood ${quoted(SKETCH_MOODS)} on "face" · count 1-12 on crowd/footprints/blank/chain
          text (≤24) on "tag" · open/open_to/swing_over on "door" and "lock" · reach on "figure"
          flags: no (crossed out, broken), sweat, xray (see inside), flash (it lights up), flip
          (mirrored, or a chart that falls), leader.

PACE: ${short ? "one drawing per caption block, 20-60 s, 5-7 scenes" : "one drawing per caption block, 3-8 minutes, 18-30 scenes"}. Nothing holds still.`;
}

function stickmanSection(): string {
  return `3. THE SCENES — stickman: a hand-drawn stickman acts the story (9:16 only)
SCENE: {"id":"01-hook","kind":"story","act":${quoted(STORY_ACTS)},"cast":[${quoted(STORY_CAST)}],"props"?:[up to 3 of ${list(STORY_PROPS)}],"fx"?:${quoted(STORY_FX)},"accent":<its section's accent>,"bubble"?:"<=40 the character says this","hl"?:"<=24 word of the title","title":"<=90","voice":"one narrated sentence","hold"?:0.2}
CLOSING: {"id":"…","kind":"closing","title":"…","voice":"…","bubble"?:"<=40","hl"?:"<=24","hold":0.4}
hero = the viewer, thief/thief2 = villains. The act follows the narration: alarm when something goes wrong, explain/point-up when teaching, shrug for doubt, walk/run for movement, hold/drop with a prop.`;
}

/* ------------------------------------------------------------------ the whole guide */

export function buildGuide(o: GuideOptions): string {
  const dur = o.duration_s ?? 45;
  const words = wordBudget(dur, 1.1).target;
  const scenes = dur <= 90 ? "4-8" : dur <= 300 ? "10-20" : "18-30";
  const look = o.style && (KLEO_STYLES as readonly string[]).includes(o.style) ? o.style : null;
  const keou = look ? (PICTURE_LOOKS.includes(look) ? "picture" : look === "stickman" ? "stickman" : look === "explainer" ? "sketch" : "cinema") : "picture";
  const voiceLine = o.languages.map((l) => `${l}: ${(VOICES[l] ?? []).join("|")}`).join(" · ");

  const scenesSection = !look
    ? `${pictureSection("cartoon", dur)}

OTHER LOOKS: call kleo_storyboard_guide again with style "cyber" (motion design with icons and big type, no pictures — tech and security topics that want diagrams), style "explainer" (the cyber explainer: hand-drawn white marker line art on pure black, one drawing per phrase, karaoke captions — the strongest look for teaching one idea fast) or style "stickman" (a hand-drawn stickman acting the story, 9:16 only, on request) to get that look's vocabulary instead of this one.`
    : PICTURE_LOOKS.includes(look)
    ? pictureSection(look as "cartoon" | "realistic" | "animation", dur)
    : look === "cyber"
    ? cyberSection()
    : look === "explainer"
    ? explainerSection(dur, o.format ?? "9:16")
    : stickmanSection();

  return `KLEO STORYBOARD GUIDE${look ? ` — ${look}` : ""}
Engine: Keou, canvas motion design, 4K 60 fps, local text-to-speech. Target ${dur}s: about ${words} narrated words across ${scenes} scenes.
Write the storyboard in three passes, in this order: the DIRECTION, then the OUTLINE, then the SCENES. The direction is the pass Kleo cannot do for you and the one the finished video is judged on.

${directionSection(scenes)}
${!look || PICTURE_LOOKS.includes(look) ? `\n${specSection()}\n` : ""}
2. THE TOP-LEVEL OBJECT
{"schema_version":1,"editorial_status":"ready","title":"<=120","brand":"<=28","direction":{…as above…},
 "kleo_style":${quoted(look ? [look] : KLEO_STYLES)},"style":"${keou}","format":"9:16"|"16:9","language":${quoted(o.languages)},
 "voice":"${voiceLine}","speed":1.1,"music":"none"|"track" (the user's answer; with "track" add "music_brief"),"max_duration":${Math.round(dur * 1.6)},"description":"<=180","tags":["…"],"scenes":[…]}
(music is always "none": the film is the narration over the footage, nothing else — 13 September 2026)
"format" and "language" are not free choices: they must equal what you pass to kleo_create_video, and "voice" must be one of that language's voices. Never write a storyboard in any other language.
${look ? `This guide is for kleo_style "${look}", which needs style "${keou}".` : `kleo_style cartoon and realistic need style "picture"; cyber keeps the template's look; stickman needs style "stickman" and 9:16.`}

${scenesSection}

${!look || PICTURE_LOOKS.includes(look) ? layerSection() : ""}
4. WHAT KLEO REFUSES, BEFORE ANYTHING IS BILLED
 2-240 scenes; ids are unique lowercase slugs and must not end in "-s" + a number; the last scene is "closing"; every scene needs "title" and "voice".
 The direction's sections must add up to the scene count, no two neighbouring sections share an accent, and every scene wears its section's accent.
 Every fact in direction.must_keep must appear in the narration (an appearance is proven by the pictures instead); no image_prompt may ask for anything in direction.forbidden.
 With a spec: every MUST requirement covered by a shot's "covers" or said in a voice, the user's events in the user's order, and "covers"/"cast" naming only the spec's own ids.
 THE PICTURES SPEAK ENGLISH whatever the film speaks: every image_prompt, and the direction's world, cast names and looks, objects and forbidden terms, are written in English (they are pasted into the picture prompts, and the picture model reads English only). Subject, goal, audience, tone, must_keep, the narration, titles and chapters stay in the film's language.
 Picture looks: only cinema and closing scenes, ${shotRangeText("cinema")} shots each (closing ${shotRangeText("closing")}), "at" on every shot after the first, no "beats".
 A shot carries only image_prompt, caption, hl, at, shot_kind, cast, covers and action. A hand-written camera move is refused.
 scene.image, scene.motion and shot.image are refused (Kleo generates the pictures; no asset travels with a job).
 Total narration must fit the length: never more than about ${Math.round(words * 1.25)} words for ${dur}s.

5. WRITING IT WELL
 When the job has a spec, the user's story is the structure: open where they open, tell their events in their order, end where they end. Otherwise open with the hook in the FIRST sentence — a surprising claim, a number, or a fear. One idea per scene. End on a question or a promise that sends the viewer back to the start.
 Write the narration as speech: no emojis, no hashtags, no URLs, no stage directions, no invented quotes from real people.
 Do not copy the example below. Take its shape and write the user's subject, in the user's tone, for the user's audience.`;
}

/** The worked example, kept apart from the rules so a caller can be given the rules alone when context is tight. */
export function guideExample(style: GuideStyle | null): string {
  if (style === "cyber") {
    return `EXAMPLE (cyber Short, 9:16, one scene of five):
{"id":"02-relay","kind":"cinema","chapter":"02 THE METHOD","accent":"cyan","title":"they never touch the key","hl":"never","voice":"Two people, one at your door and one at your car, pass the signal between them.","hold":0.2,"beats":[
 {"kind":"type","text":"THEY NEVER TOUCH IT","hl":"NEVER","slam":true},
 {"kind":"split","items":["thief","car"],"label":"door to car","at":"one at your"},
 {"kind":"icon","name":"amplifier","label":"the relay","fx":"lit","at":"pass the signal"}]}`;
  }
  if (style === "explainer") {
    // Two real scenes from worker/keou/examples/explainer-hotel, which the suite validates through the
    // contract: the guide cannot teach a shape the validator refuses. It shows the two things a model
    // gets wrong on its own — a drawing on the page at frame zero, and cues spread across the line so
    // the last one lands in its second half.
    return `EXAMPLE (explainer Short, 9:16, the first two scenes of six):
${JSON.stringify(EXAMPLE_SKETCH_SCENES, null, 0)}
Notice: every phrase has its own drawing and the drawing is the thing the words name; the first drawing carries "drawn":true so the film does not open on black; each "at" quotes words the scene really says, spread across the line so the last one lands in its second half; one accent per scene and never two in a frame; the camera only ever pushes in; there is no closing scene and no title — the caption is the only text.`;
  }
  if (style === "stickman") {
    return `EXAMPLE (stickman Short, 9:16, one scene):
{"id":"02-relay","kind":"story","act":"alarm","cast":["hero","thief"],"props":["keyfob","car"],"fx":"relay","accent":"red","bubble":"That's my car!","title":"they never touch the key","hl":"never","voice":"Two people pass your key's signal from your front door to your car, and it opens.","hold":0.2}`;
  }
  // The picture example carries a direction, because the direction is the part people skip. It is a real object, not
  // prose: test/keou-contract.test.mjs validates it through the contract, so the guide cannot teach an illegal shape.
  const d = EXAMPLE_DIRECTION;
  return `EXAMPLE (a realistic film, 9:16, 40s, en — the direction plus the first two scenes of six; the same shape, drawn as film${style === "animation" ? "; an ANIMATED film keeps this exact shape, with every image_prompt describing a drawn frame instead of a photograph" : ""}):
"direction":${JSON.stringify(d)}
"scenes":${JSON.stringify(EXAMPLE_SCENES)}
Notice: every scene has ${SHOTS_MIN_CINEMA} or more pictures; every picture after the first carries "at" quoted from its own voice line; the accents come from the sections, not from the mood; "${d.cast[0].name}" and "${d.cast[1].name}" are named exactly as the direction names them and listed in each shot's "cast", so Kleo appends their look to every picture that shows them; the moving shots say what moves in "action"; nothing on the forbidden list appears anywhere. (This example has no spec, so no shot carries "covers"; with one, each shot lists the requirement ids it shows.)`;
}

/**
 * The explainer's worked example, as data. Lifted from worker/keou/examples/explainer-hotel so the guide
 * teaches a film that was actually rendered, and validated by the suite so it can never teach an illegal one.
 */
export const EXAMPLE_SKETCH_SCENES = [
  {
    id: "01-card", kind: "sketch", accent: "red", enter: "cut", exit: "cut", hold: 0.05,
    voice: "This looks like a normal hotel key card. It isn't.",
    shot: { zoom: [1.0, 1.42], focus: [660, 900] },
    art: [
      { name: "keycard", x: 700, y: 900, size: 1.15, drawn: true, until: "a normal" },
      { name: "hand", x: 506, y: 938, size: 1.25, drawn: true, until: "a normal" },
      { name: "keycard", x: 540, y: 880, size: 1.85, at: "a normal", until: "It isn't", motion: "turn", motion_over: 0.9 },
      { name: "keycard", x: 540, y: 880, size: 2.0, at: "It isn't", xray: true, motion: "pulse" },
    ],
  },
  {
    id: "02-read", kind: "sketch", accent: "blue", enter: "whip", exit: "flare", hold: 0.05,
    voice: "Read one card once, and the lock gives up its secret.",
    shot: { zoom: [1.0, 1.36], focus: [540, 820] },
    art: [
      { name: "reader", x: 540, y: 620, size: 1.0, drawn: true, beam: "blue" },
      { name: "keycard", x: 540, y: 1080, size: 1.2, at: "Read one card", motion: "rise" },
      { name: "lock", x: 540, y: 1000, size: 1.1, at: "gives up", open: 1, tint: "blue", motion: "shake" },
    ],
  },
];

/** The worked example as data, so the tests can put it through the validator instead of through a regular expression. */
export const EXAMPLE_DIRECTION = {
  subject: "The pirate captain who buried a treasure and never came back for it",
  goal: "The viewer wants to know what happened to the treasure",
  audience: "People who like short history and adventure stories",
  tone: "Warm and a little eerie",
  must_keep: ["1720", "Skull Beach", "one cabin boy"],
  world: "A tropical island in 1720: golden beaches, turquoise water, palm trees, wooden ships with red sails, warm low sunlight",
  cast: [
    { name: "the captain", look: "a pirate captain with a red bandana and a long dark braid, brown coat, wide belt" },
    { name: "the cabin boy", look: "a thin young boy in a striped blue and white shirt, bare feet, short sandy hair" },
  ],
  objects: ["wooden chest", "red-sailed ship", "palm trees", "wet sand", "lantern", "rope", "treasure map", "storm waves"],
  forbidden: ["text or letters in the picture", "modern clothing", "phone", "wifi symbol", "brand logo", "real person", "extra fingers"],
  sections: [
    { name: "01 THE BURIAL", accent: "amber", means: "what was hidden", scenes: 1 },
    { name: "02 THE STORM", accent: "red", means: "what went wrong", scenes: 1 },
  ],
};

export const EXAMPLE_SCENES = [
  {
    id: "01-burial", kind: "cinema", chapter: "01 THE BURIAL", accent: "amber", title: "she never came back", hl: "never",
    voice: "In 1720, the captain buried her treasure on Skull Beach. She never came back for it.", hold: 0.2,
    shots: [
      { image_prompt: "The captain burying a wooden chest on a golden beach at sunset, palm trees swaying, her red-sailed ship anchored in the bay", caption: "SHE NEVER CAME BACK", hl: "NEVER", shot_kind: "hook", cast: ["the captain"], action: "the captain shovels sand over the chest while the palms sway in the warm wind" },
      { image_prompt: "The captain walking away along the shoreline at dusk, waves breaking behind her, deep footprints in the wet sand", at: "never came back", shot_kind: "action", cast: ["the captain"], action: "she walks out of frame as the waves wash over her footprints" },
    ],
  },
  {
    id: "02-storm", kind: "cinema", chapter: "02 THE STORM", accent: "red", title: "three days later", hl: "three",
    voice: "Three days later a storm took her ship, and only one cabin boy swam back to shore.", hold: 0.2,
    shots: [
      { image_prompt: "A red-sailed ship tossed by huge black waves at night, lightning splitting the sky, torn sails flapping, rain falling across the deck", caption: "THREE DAYS LATER", hl: "THREE", shot_kind: "tension" },
      { image_prompt: "The cabin boy clinging to a broken plank in the dark water, the ship going down behind him", at: "one cabin boy", shot_kind: "establish", cast: ["the cabin boy"] },
      { image_prompt: "The cabin boy lying exhausted on an empty beach at dawn, calm turquoise water, palm trees, soft pink sky", at: "swam back", shot_kind: "face", cast: ["the cabin boy"] },
    ],
  },
];

/** Everything a caller gets in one string: the rules, then the one example that matches the look they asked for. */
export const guideText = (o: GuideOptions): string => `${buildGuide(o)}\n\n${guideExample(o.style ?? null)}`;

/** Kept so a caller can still see which Keou styles exist without the guide having to list them all. */
export const KEOU_STYLE_NAMES = STYLES;
export const GUIDE_VISUALS = VISUALS;
export const GUIDE_SHOTS_PER_SCENE = SHOTS_PER_SCENE;
