/**
 * KLEO STUDIO — VIRAL TEMPLATES (20 October 2026, the owner: "fare esattamente gli stessi video" as ausar.ai).
 *
 * A template is a viral clip Kleo keeps (the "fixed video") with one to three seats. The person uploads a photo per
 * seat; Wan 3.0 video edit swaps each photo into its seat and keeps everything else: the room, the camera, every
 * movement and its timing, and the clip's own sound. This is the recipe ausar.ai's people-swap templates run, read
 * from its public pages on 19 October 2026: one shot, `alibaba/wan-3.0-prime/video-edit` on WaveSpeed, the photos as
 * reference images, and a long structured prompt (cast and seats, exact likeness, nothing of the original people,
 * the motion second by second, the scene, the style). Kleo uses the standard Wan 3.0 edit, which its sellers describe
 * as the same quality, slower and a third cheaper.
 *
 * What passes: photos of people, the customer's own face or a film character played by an actor. Disney and Pixar
 * renders are refused (WALL-E, EVE and the Captain were flagged on 19 October; Thomas Shelby went through on the 20th).
 *
 * PRICE (WaveSpeed's list, checked with its own price quote on 19 October 2026): the source clip's seconds, rounded up
 * and capped at 15, plus the output's seconds (the same length), at $0.05 / $0.10 / $0.20 a second for 480p / 720p /
 * 1080p. "You Talking Bout Me?" (14 s) costs $1.40 / $2.80 / $5.60.
 *
 * THE CATALOG (20 October 2026, the owner: "prendile tutte"): You Talking Bout Me, written here seat by seat, then the
 * templates imported from ausar.ai with their own fixed prompts (./trends-catalog.ts).
 *
 * Pure module (no Env, no fetch), so the tests import it directly under Node's type stripping.
 */

import { IMPORTED_TRENDS } from "./trends-catalog.ts";
import type { PhotoFacts } from "./person-check.ts";

export type TrendQuality = "480p" | "720p" | "1080p";

export interface TrendSeat {
  /** The upload field of this seat: person1, person2, … */
  key: string;
  /** The seat in two or three words, under its photo box on the page. */
  label: string;
  /** Who sits there, in a few words, for a template with its own fixed prompt (the imported ones). */
  hint?: string;
  /** Where the person sits, as the page and the prompt name it (templates whose prompt Kleo writes per seat). */
  where?: string;
  /** What the original person wears or carries, so nothing of it survives. */
  original?: string;
  /** What this seat does in the clip, second by second. */
  motion?: string;
  /** Seat colour on the page's seat guide. */
  color: string;
  /** Where the seat is on the guide picture, in percent of its width and height (when it was measured). */
  at?: [number, number];
  /** Templates written shot by shot (Trend.shots): the seat's name in capitals, as the prompt calls it ("THE DUNKER"). */
  role?: string;
  /** Who it is in Video 1, by place and action ("the player with the ball"). */
  who?: string;
  /** The three or four most visible things the original person wears, to find them (never to keep them). */
  wears?: string;
  /** When the face is seen, and from where the rest of the time. */
  seen?: string;
  /** When the person is in the clip at all, when they leave it before the end ("0-4.0 s"). */
  onScreen?: string;
  /** Seen from behind for a long stretch: the prompt asks for the photo's hair, build and the back of its outfit. */
  back?: boolean;
}

/** One shot of a template's clip, for the templates written shot by shot. */
export interface TrendShot {
  from: number;
  to: number;
  /** The camera, its speed and how the shot starts ("hard cut to a view from behind the defender, normal speed"). */
  view: string;
  /** Who does what, by role, with the times. */
  cast: string;
}

export interface Trend {
  /** The app key: "trend-<slug>". */
  key: `trend-${string}`;
  name: string;
  blurb: string;
  tint: string;
  /** The fixed clip, public (WaveSpeed fetches it). */
  baseUrl: string;
  /** Its length in seconds. */
  baseSeconds: number;
  /**
   * The clip looping on the app's card, with its "-p.mp4" → ".jpg" poster: the first 6 s for the older templates, the
   * whole clip since 23 October 2026 (the owner paid for Crossover King Pt 2 thinking its 6 s preview was the clip).
   */
  preview: string;
  /** A still of the fixed clip, with the seats marked on it by the page. */
  guide: string;
  seats: TrendSeat[];
  /** The room and the camera, to keep identical (templates whose prompt Kleo writes per seat). */
  scene?: string;
  /** The clip's cuts and speed changes, when it is not one continuous shot. */
  edit?: string;
  /** What the person may change around the people (the court, the opponent, the crowd …), each a choice on the page. */
  changes?: TrendChange[];
  /**
   * Written shot by shot (23 October 2026, after the first paid Crossover King Pt 2 came back wrong): a short ordered
   * prompt (trendPromptV2) instead of the long seat-by-seat one. `world` is Video 1's place in one sentence; `worldParts`
   * the parts of it that must be gone when the place changes, each kept when its own change (by key) stays Original.
   */
  shots?: TrendShot[];
  /**
   * Video 1's place in parts, so a change never sits next to a description of what it changes: `place` without its
   * light, people or signs; `light`, `people` and `signs` each written only while their own change stays Original.
   */
  world?: { place: string; light: string; people?: string; signs?: string };
  worldParts?: { text: string; keptBy?: string }[];
  /**
   * A fixed edit instruction ("Image 1", "Image 2", "Video 1"): the imported templates (./trends-catalog.ts). Every seat
   * then needs its photo, as on ausar.ai; without one, Kleo writes the prompt for the seats that have one (trendPrompt).
   */
  prompt?: string;
  /**
   * Runs on Wan 3.0 Prime video edit, the model Ausar runs its templates on, at half again the price (25 October 2026:
   * the standard model moved You Tweaking's cuts by up to a second and put two people in one shot; Ausar's Prime run of
   * the same clip kept every cut).
   */
  prime?: boolean;
}

/**
 * One thing around the people that the person may change (23 October 2026, the owner: "voglio anche che sostituisca
 * l'esterno … il campo, l'avversario, gli spettatori … dai più opzioni per cambiare"). The page shows "Original" (no
 * change), the choices, and "Your idea" with a line of the person's own words when `custom` is set.
 */
export interface TrendChange {
  /** The form field: court, rival, crowd … */
  key: string;
  label: string;
  /** The choices after "Original": the button's words and the instruction the prompt carries. */
  options: TrendOption[];
  /** The start of the sentence the person's own words finish ("Change the court and everything around it into"). */
  custom?: string;
  /** The seat this change is about: when that seat has a photo, the photo wins and the choice is ignored. */
  seat?: string;
  /**
   * For the templates written shot by shot: what the change is about. A picked light always wins over the light a place
   * brings with it (`time` on a place option), so "New York street" and "Daytime" never ask for night and day at once.
   */
  kind?: "place" | "light" | "people" | "signs";
}

/** One choice of a change; a place may bring its own light (`time`) and may keep the original place (`same`). */
export interface TrendOption { value: string; label: string; text: string; time?: string; same?: boolean }

/** One imported template as the catalog stores it (./trends-catalog.ts). */
export interface CatalogTrend { slug: string; name: string; blurb: string; tint: string; seconds: number; seats: { key: string; label: string; hint: string; color: string }[]; prompt: string }

export const TRENDS_MEDIA = "https://media.kleooai.com/app/templates";
/** Every seat needs a photo when the template brings its own prompt. */
export const trendNeedsAllSeats = (t: Pick<Trend, "prompt">): boolean => !!t.prompt;
/** WaveSpeed's Wan 3.0 video edit: dollars per billed second (source + output). */
export const WAN30_EDIT_USD_PER_S: Record<TrendQuality, number> = { "480p": 0.05, "720p": 0.10, "1080p": 0.20 };
export const WAN30_EDIT_MODEL = "alibaba/wan-3.0/video-edit";
/** WaveSpeed's Wan 3.0 Prime video edit (its price quote, 25 October 2026: $2.25 / $4.50 / $9.00 for 15 s in + 15 s out). */
export const WAN30_PRIME_EDIT_USD_PER_S: Record<TrendQuality, number> = { "480p": 0.075, "720p": 0.15, "1080p": 0.30 };
export const WAN30_PRIME_EDIT_MODEL = "alibaba/wan-3.0-prime/video-edit";
/** The WaveSpeed model a template runs on. */
export const trendModel = (t: Pick<Trend, "prime">): string => (t.prime ? WAN30_PRIME_EDIT_MODEL : WAN30_EDIT_MODEL);
export const TREND_QUALITIES: TrendQuality[] = ["480p", "720p", "1080p"];
export const DEFAULT_TREND_QUALITY: TrendQuality = "720p";

/** The free line under every template that has changes: anything else the person wants different. */
export const TREND_EXTRA_MAX = 300;
/** The person's own words for a "Your idea" choice. */
export const TREND_CUSTOM_MAX = 200;

const fromCatalog = (c: CatalogTrend): Trend => ({
  key: `trend-${c.slug}`, name: c.name, blurb: c.blurb, tint: c.tint,
  baseUrl: `${TRENDS_MEDIA}/${c.slug}/base.mp4`, baseSeconds: c.seconds,
  preview: `${TRENDS_MEDIA}/${c.slug}/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/${c.slug}/guide.jpg`,
  seats: c.seats, prompt: c.prompt,
});

// 23 October 2026, the owner sent an Instagram reel (@chipmunk.7664054, 15.8 s at 1080x1920 60 fps): a night 1-on-1 on
// a park court in China. The player crosses over his defender, flies at the basket, tosses the ball straight up and it
// drops in; then a replay with slow motion. The owner: "taglialo e metti due template, pt1 e pt2": Part 1 is the play
// (0-5.8 s, one shot, no slow motion), Part 2 the replay's first 6 s (5.8-11.8 s: the drive, the flight in slow motion,
// a hard cut, the ball dropping in). Both let the person change the world around them.
//
// The first paid run (Pt 2, two photos, New York street + cheerleaders + daytime + KLEO) came back wrong: the defender
// never swapped, the second photo's face landed on the dunker, the green court and the blue pole stayed, daylight only
// in the last shot. The prompt was the reason: it re-described the whole original park after the changes ("replace
// only what they name"), asked for a street "at night" and a "sunny day" at once, named the cut only at its end, and
// told the two players apart only by their tops. Both parts are now written shot by shot (trendPromptV2).
const COURT_WORLD = {
  place: "an outdoor park basketball court: a green court with a red key, a light-blue pole holding a glass backboard with a mint-green frame, dark trees and a pergola",
  light: "night under floodlights on tall poles",
  people: "young spectators standing in a line behind the basket",
  signs: "red oval sponsor boards with white Chinese lettering",
};
const COURT_GONE: { text: string; keptBy?: string }[] = [
  { text: "no green or red court surface" }, { text: "no light-blue pole" }, { text: "no mint-green backboard frame" },
  { text: "no floodlight poles" }, { text: "no park trees" }, { text: "no pergola" }, { text: "no red boards with Chinese lettering", keptBy: "boards" },
];
const COURT_CHANGES: TrendChange[] = [
  { key: "court", label: "Court", kind: "place", custom: "Change the court and everything around it into",
    options: [
      { value: "nba", label: "NBA arena", time: "bright indoor arena lights from above",
        text: "a packed NBA arena: a glossy light hardwood floor with painted lines and a big centre logo, a professional glass backboard on a padded stanchion with an orange rim and a white net where the basket is now, big screens and dark tiered stands full of fans" },
      { value: "street", label: "New York street", time: "night under yellow street lights",
        text: "a New York street court inside a chain-link fence: cracked dark asphalt with faded white lines, a steel backboard with a chain net where the basket is now, red-brick buildings with fire escapes and graffiti walls all around" },
      { value: "beach", label: "Beach at sunset", time: "sunset: warm low sunlight, long shadows and a golden-orange sky",
        text: "a basketball court on a sandy beach: a sand-coloured hard court with white lines, the basket where it is now, palm trees and the ocean behind" },
      { value: "rooftop", label: "City rooftop", time: "night: the lit windows of the skyscrapers and the lamps on the rooftop",
        text: "a rooftop court high above a big city: a blue court with white lines, the basket where it is now, a tall fence at the edge and glass skyscrapers all around" },
      { value: "snow", label: "Snowy night", time: "night under the floodlights", same: true,
        text: "the same park court covered in fresh snow: snow on the ground around the court, on the trees and on the pergola roof, snowflakes falling, everyone's breath steaming; the court lines stay visible" },
    ] },
  { key: "rival", label: "Opponent", seat: "person2", custom: "The defender becomes",
    options: [
      { value: "giant", label: "Giant", text: "The defender becomes a huge 2.2-metre-tall centre in a plain black long-sleeve top and grey shorts, towering over everyone, with the same movements." },
      { value: "grandpa", label: "Grandpa", text: "The defender becomes a grey-haired grandpa in his seventies with glasses, in a burgundy tracksuit and white sneakers, with the same movements." },
      { value: "mascot", label: "Mascot", text: "The defender becomes a person in a big furry bear mascot costume with a huge smiling head, with the same movements." },
      { value: "robot", label: "Robot", text: "The defender becomes a sleek white-and-black humanoid robot with a glowing visor for a face, with the same movements." },
    ] },
  { key: "crowd", label: "Crowd", kind: "people", custom: "Change the spectators into",
    options: [
      { value: "packed", label: "Packed", text: "a much bigger crowd of excited fans, several rows deep, many filming with phones, cheering and grabbing their heads when the ball drops in" },
      { value: "cheer", label: "Cheerleaders", text: "a row of cheerleaders in matching red and white uniforms with silver pom-poms in front of the crowd, dancing and cheering" },
      { value: "empty", label: "Empty", text: "nobody: no spectators anywhere around the court" },
    ] },
  { key: "light", label: "Light", kind: "light",
    options: [
      { value: "golden", label: "Sunset", text: "sunset: low warm golden light and long shadows, an orange and pink sky wherever the sky shows" },
      { value: "day", label: "Daytime", text: "bright daylight with short shadows, a blue sky wherever the sky shows, no lamps lit" },
      { value: "neon", label: "Neon", text: "night lit by pink and blue neon light falling on the court and on everyone" },
    ] },
  { key: "boards", label: "Sponsor boards", kind: "signs", custom: "Change the red oval sponsor boards into boards that read",
    options: [
      { value: "kleo", label: "KLEO", text: "black oval boards that read \"KLEO\" in bold white letters, where the red boards stand now" },
      { value: "none", label: "None", text: "no boards: the red oval sponsor boards are removed" },
    ] },
];
const DUNKER = { key: "person1", label: "The dunker", color: "#ff9f0a", role: "THE DUNKER", who: "the player with the ball",
  wears: "black sleeveless top, grey shiny shorts over black knee-length tights, white socks", seen: "He faces the camera most of the time." };
const DEFENDER = { key: "person2", label: "The defender", color: "#0a84ff", role: "THE DEFENDER", who: "the player guarding the player with the ball", back: true,
  wears: "black long-sleeve top with thin white lines, white snakeskin-print shorts" };

export const TRENDS: Trend[] = [
  {
    key: "trend-you-talking-bout-me", name: "You Talking Bout Me?", blurb: "Put up to three friends in this viral clip", tint: "#bf5af2",
    baseUrl: `${TRENDS_MEDIA}/you-talking-bout-me/base.mp4`, baseSeconds: 14,
    preview: `${TRENDS_MEDIA}/you-talking-bout-me/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/you-talking-bout-me/guide.jpg`,
    scene: "Same counter with the white tabletop, phones and small objects on it, wooden wall panel with the \"SHAPED BY TRADITION\" lettering, red-and-white striped flag, dark ceiling lights, screens and the \"RULES\" sign in the background. Same low handheld camera angle, same slight shake and movement, same framing, focus and depth of field, same warm indoor lighting.",
    seats: [
      { key: "person1", label: "Front, right", where: "in the FRONT on the right, closest to the camera, large in the frame, talking and laughing the most",
        original: "no black cap, no black T-shirt, no diamond chain, no iced-out watch",
        motion: "0-4s leans toward the camera, talking and smiling widely, then laughing; 4-6s turns away, laughs and covers the mouth with a hand; 6-9s gestures with an open hand while talking to the person in the middle; 9-11s laughs and turns the head away, a hand at the face; 11-14s leans out of the frame on the right, then points toward the people at the counter",
        color: "#bf5af2", at: [72, 62] },
      { key: "person2", label: "Middle", where: "in the MIDDLE, sitting at the counter between the front person and the far person, watching and reacting, talking near the end",
        original: "no grey printed T-shirt, no braids",
        motion: "sits at the counter watching the front person, reacting with the face and raising a hand at about 3s; looks over at the front person while he talks; 11-14s talks, gesturing with both hands at the chest",
        color: "#0a84ff", at: [47, 80] },
      { key: "person3", label: "Far left", where: "FURTHEST from the camera, on the left, sitting at the counter and mostly looking down at a phone",
        original: "no red patterned shirt, no blond twisted hair",
        motion: "sits at the counter, looking down at a phone in the hands most of the time, glancing up briefly",
        color: "#30d158", at: [34, 80] },
    ],
  },
  // 25 October 2026, the owner: "riesci a trovare la clip originale? … scarica quella max quality" (an Instagram reel
  // of Ausar's own "You Tweaking" result, with its watermark). The source is Quante Savage's YouTube show "20 GUYS VS 1
  // OF MODEL: LADIISCORPIO" (the 2024 upload is members-only; its public re-upload ov0xf73JxnE, 12:00.95-12:15.9, VP9
  // 1920x1080 at 23.976 fps), cropped below the channel's logo with no scaling.
  // The first paid run (two photos, standard Wan 3.0, a long prompt with times to the tenth of a second) came back wrong:
  // the cuts moved by up to a second in the first 8.7 s, the second photo's person stood next to the original woman in
  // one shot, and he got her long hair. The owner: "fai come fa ausar.ai". Ausar runs this clip on Wan 3.0 Prime with
  // the two photos and a 30 fps clip, and its result keeps every cut. So: Prime, a 30 fps base (frames repeated, never
  // blended) cut to exactly 4:3 (1336x1002, the shape Wan returns, so nothing is stretched), and a short prompt in
  // Ausar's own style that tells the two apart by what they look like, with no times in it.
  {
    key: "trend-you-tweaking", name: "You Tweaking", blurb: "Put two friends in this viral clip", tint: "#ff375f",
    baseUrl: `${TRENDS_MEDIA}/you-tweaking/base-30.mp4`, baseSeconds: 14.97,
    preview: `${TRENDS_MEDIA}/you-tweaking/preview5-p.mp4`, guide: `${TRENDS_MEDIA}/you-tweaking/guide-hd.jpg`,
    prime: true,
    seats: [
      { key: "person1", label: "Person 1", hint: "Takes the place of the guy in black · a clear photo", color: "#0a84ff", at: [24, 45] },
      { key: "person2", label: "Person 2", hint: "Takes the place of the girl in white · a clear photo", color: "#ff375f", at: [77, 45] },
    ],
    prompt: [
      "Replace the two people in Video 1 with the people from Image 1 and Image 2, for the entire video, in every shot, from the first frame to the last.",
      "",
      "PERSON 1 -> Image 1",
      "Original: the young man in a black durag, a black T-shirt with a small white script print on the chest, a silver chain with a big iced-out letter pendant and light-blue jeans, with a tattoo sleeve on his right forearm. He laughs shyly with a hand at his mouth, raises his left arm and points down, and talks in profile with small hand gestures.",
      "Replace his face with the face from Image 1 - the face is the most important part: it must clearly be the person from Image 1 in every frame, including the quick close-up and the shots in profile. Replace his durag, hair, chain, build, hands and clothes with the hair, accessories, build, hands and clothes from Image 1. Nothing of his durag, black T-shirt, chain, jeans or tattoos stays unless Image 1 has them.",
      "",
      "PERSON 2 -> Image 2",
      "Original: the young woman with very long straight black hair, a white cropped T-shirt with red \"MOTHER\" lettering and low-rise dark-blue lace-up jeans. She holds a small black object in her right hand and carries a small red handbag on her right forearm; she pulls her hair out to the side, turns her back to the camera, then smiles and talks to the camera.",
      "Replace her face with the face from Image 2 - clearly the person from Image 2 in every frame, including when she turns away. Replace her hair, jewellery, piercings, nails, build, hands and clothes with the hair, accessories, build, hands and clothes from Image 2. Nothing of her long hair, crop top, bare midriff, jeans, long nails or piercings stays unless Image 2 has them. The person from Image 2 keeps the red handbag and the small black object. When she pulls her long hair out to the side, the person from Image 2 makes the same hand movement with their own hair, exactly as long or short as it is in Image 2.",
      "",
      "The video cuts back and forth between the two: every shot shows only ONE person, alone on the white backdrop, and the two never appear together. Every shot of the man shows only the person from Image 1; every shot of the woman shows only the person from Image 2. Never add a second person to a shot.",
      "",
      "Both keep their exact movement, gestures, facial expressions, mouth movement and timing from Video 1. If a person in an image is a different gender, they replace the original in that position as they are in the image. No part of the original two people appears anywhere.",
      "",
      "Nothing else in the video changes: the same pure white backdrop, as bright as in Video 1, the same static camera, framing, quick zoom-in, cuts, speed and timing.",
    ].join("\n"),
  },
  // 25 October 2026, the owner: "nuovo template … i video sono tutti uguali ma con persone diverse" (TikTok
  // @therealrodentspawn, CapCut "window peeper" filters, 14 s at 1080x1920 30 fps). The format has no real original: every
  // post is already AI-made, the first one (Mr Bean) at the highest bitrate is the base. One seat, one continuous shot.
  {
    key: "trend-window-peeper", name: "Window Peeper", blurb: "Caught eating at the window", tint: "#ffd60a",
    baseUrl: `${TRENDS_MEDIA}/window-peeper/base.mp4`, baseSeconds: 14,
    preview: `${TRENDS_MEDIA}/window-peeper/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/window-peeper/guide.jpg`,
    scene: "Same night shot of a tall concrete apartment block: a dark facade with rows of windows, a few of them lit, and one warm-lit window on an upper floor. The camera pushes in from the wide facade to that window (0-2.2 s), then holds close on it with a slow drift, the white window frame and the sill in the foreground. Inside the room: warm indoor light, white walls, a framed painting with orange flowers at the top left, a small light-wood table with a fast-food burger box (orange, with a dark sleeve and a white sticker) and a brown paper fast-food bag with yellow arches on the left, a grey chair, and a long beige curtain on the right that is pulled across the window at the end (12-14 s). Same long-lens look through the glass, the same reflections and soft focus, the same warm orange room against the dark night outside.",
    seats: [
      { key: "person1", label: "The eater", where: "at the small table BEHIND THE WINDOW, eating a burger and staring out at the camera, then getting up and pulling the curtain closed",
        original: "no olive-brown tweed jacket, no white shirt, no thin dark red tie, no silver wristwatch, no short dark hair with a side parting",
        motion: "0-2.2s already the new person from the very first frame, seen small through the lit window far away, sitting at the table unwrapping the burger box, while the camera pushes in from the dark apartment block; 2.2-4.0s holds a burger in both hands at the mouth and takes big bites, eyes down on the burger; 4.0-7.0s chews slowly with the burger held at the chin, the eyes turned up to stare straight out of the window at the camera; 7.0-10.5s keeps chewing and staring at the camera with a suspicious, wide-eyed look; 10.7-11.3s lowers the burger onto its box, still staring; 11.5-11.8s stands up from the chair, both arms out, eyes on the camera; 12.0-12.4s steps to the right with an arm stretched out to the curtain and grabs it; 12.5-13.3s hides behind the curtain, gripping it with one hand and peeking out at the camera with one eye; 13.5-14.0s swings the curtain fully closed with a big sweep of the arm, looking at the camera, and the window is covered",
        color: "#ffd60a", at: [56, 48] },
    ],
  },
  {
    key: "trend-crossover-king-pt1", name: "Crossover King Pt 1", blurb: "Put yourself in this viral clip, on any court", tint: "#ff9f0a",
    baseUrl: `${TRENDS_MEDIA}/crossover-king-pt1/base.mp4`, baseSeconds: 5.83,
    preview: `${TRENDS_MEDIA}/crossover-king-pt1/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/crossover-king-pt1/guide.jpg`,
    changes: COURT_CHANGES, world: COURT_WORLD, worldParts: COURT_GONE,
    shots: [
      { from: 0, to: 5.8, view: "one continuous handheld shot at court level, running with the play, at normal speed",
        cast: "THE DUNKER crosses over THE DEFENDER and drives to the basket (0-1.4 s), takes off and hangs in the air in front of the backboard, legs split wide, the ball in his left hand and his right hand raised with one finger up, his head turned to his right and down, looking straight at THE DEFENDER below him with a cocky, mocking face (1.4-2.0 s), tosses the ball straight up with his left hand instead of dunking (2.0-2.1 s) and lands on the right (2.4 s); he watches the ball fall through the hoop (3.0-3.3 s) with his right hand at his mouth, walks to the middle with his left arm out, then stands with his right hand raised, one finger up, while the ball drops from the net and bounces in front of him, up past his face (4.3-4.7 s) and toward the lens (5.4-5.8 s); he steps toward the camera smiling, looking off to his right (4.7-5.8 s). THE DEFENDER guards him, chases him, looks up from the left, swings his right arm up and puts a hand on his head (to 3.9 s), then leaves the shot on the left (4.0 s)." },
    ],
    seats: [
      { ...DUNKER, at: [46, 49] },
      { ...DEFENDER, at: [17, 44], onScreen: "0-4.0 s",
        seen: "His face is seen from the front in the first 1.4 s, large at the left edge from 0.8 to 1.4 s, then in profile looking up (1.5-1.9 s); after that only from behind." },
    ],
  },
  {
    key: "trend-crossover-king-pt2", name: "Crossover King Pt 2", blurb: "The replay in slow motion, on any court", tint: "#0a84ff",
    // The owner, 23 October 2026: "per pt2 mi andava bene solo 6 secondi": the replay's first 6.0 s, to the catch.
    baseUrl: `${TRENDS_MEDIA}/crossover-king-pt2/base-6s.mp4`, baseSeconds: 6,
    preview: `${TRENDS_MEDIA}/crossover-king-pt2/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/crossover-king-pt2/guide.jpg`,
    changes: COURT_CHANGES, world: COURT_WORLD, worldParts: COURT_GONE,
    shots: [
      { from: 0, to: 6, view: "one continuous handheld shot at court level beside and then behind THE DEFENDER, no cut: normal speed to 1.6 s, slow motion about 8 times slower with a darker grade from 1.6 to 4.4 s, then back to normal speed and normal colour at 4.4 s on the same framing; the place and the light stay the same through the slow motion",
        cast: "THE DUNKER crosses over THE DEFENDER and drives (0-1.2 s), takes off (1.2-1.4 s) and hangs in the air in front of the backboard, legs split wide, the ball in his left hand by his head, half covering his face, and his right hand raised with one finger up, his head turned to his right and down, looking straight at THE DEFENDER below him with a cocky, mocking face the whole time he is in the air, then slowly pushes the ball high with his left hand (3.4-4.4 s); THE DEFENDER stands below on the left, back half-turned to the camera, looking up. At normal speed again THE DUNKER tosses the ball straight up (4.4 s) and lands on the right of THE DEFENDER; he stands there, right hand at his mouth (5.0-5.4 s), then left arm out, palm open (5.4-5.7 s), while the ball falls through the hoop (5.3-5.6 s); THE DEFENDER, his back to the camera in the foreground, swings his right arm up (5.7-5.9 s) and raises his hand to his head as the clip ends at 6.0 s with the ball still falling." },
    ],
    seats: [
      { ...DUNKER, at: [61, 49] },
      { ...DEFENDER, at: [11, 44],
        seen: "His face is seen from the front in the first 1.4 s, large at the left edge from 0.8 to 1.4 s; from 1.5 s he is seen from behind his left shoulder, looking up, and at the end only from behind." },
    ],
  },
  // 22 October 2026, the owner sent an Instagram reel by @collinskey (6.6 s, one take, 1080x1080 30 fps): from inside a
  // restroom stall, someone works the latch with a reacher-grabber over the top of the door, pushes it open and lunges at
  // the camera. The whole clip, one seat, the prompt written seat by seat.
  {
    key: "trend-stall-grabber", name: "Stall Grabber", blurb: "Put yourself in this viral clip", tint: "#64d2ff",
    baseUrl: `${TRENDS_MEDIA}/stall-grabber/base.mp4`, baseSeconds: 6.6,
    preview: `${TRENDS_MEDIA}/stall-grabber/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/stall-grabber/guide.jpg`,
    scene: "Same public restroom stall seen from inside at seated height: the closed warm grey-beige metal stall door in the centre with a chrome coat hook near its top right corner and a chrome slide-bolt latch on its right edge at mid height; the matching grey side panel on the left with its aluminium strip and screws; the right side panel with a large oval satin stainless-steel jumbo-roll dispenser close to the lens in the lower right; a bright ceiling light above the door, and the beige floor tiles in the gap under it. The same reacher-grabber: a long white-silver pole with a black band, a black pistol-grip handle with a blue trigger and a black U-shaped jaw lined with blue pads. From 4.7 s the door swings into the stall toward the camera on its left hinges and stays open along the left edge of the frame, showing the restroom behind it: white subway-tiled walls, a stainless hand dryer left of centre, a tall mirror above a white wall-mounted sink on the right, a bright ceiling light and the beige tiled floor. Same square handheld camera at seated height, level, with the same slight drift and jolts, same framing, same even neutral-white overhead light, the same motion blur on fast moves.",
    seats: [
      { key: "person1", label: "The grabber", where: "OUTSIDE the stall: first only the grabber, then the right hand and sleeve reaching over the top of the door to work the latch, the top of the head showing above the door and the feet in the gap under it; from 5.0 s half-hidden in the widening gap right of the swinging door, then standing in the open doorway in the CENTRE facing the camera with both hands on the grabber, and lunging at the lens",
        original: "no cream oversized hoodie, no pink, orange and teal wavy bubble-letter slogan print on the chest, no small black label on the left forearm above the cuff, no baggy black cargo trousers, no white lace-up trainers, no wide silver ring on the right hand, no tousled dark-blond hair with lighter blond tips swept up off the forehead",
        motion: "0-0.6s nothing until 0.2s, then the blue jaw end of the grabber pokes up over the top edge of the door left of centre and rises, tilting right, while the feet step into the gap under the door from 0.4s, both planted by 1.0s; 0.7-0.8s the right hand comes over the top edge holding the grabber's handle and swings the pole level above the door; 0.9-1.1s swings the pole down the inside of the door in an arc until the jaw reaches the latch at 1.2s, the top of the head appearing above the door right of the hand from 1.1s; 1.2-2.5s the forearm rests on the top edge while the jaw pinches and pulls at the latch; 2.6-2.9s the jaw slips off, swings out to the middle of the door and back; 3.0-4.0s works the latch again, slipping just off its left side at 3.1-3.3s; 4.1-4.3s yanks the jaw up off the latch and whips the grabber up and out past the top right corner of the door; 4.4-4.8s pulls the grabber back over the door, the jaw sticking up above the edge, the head showing until 4.7s; 4.7-5.2s the door swings in toward the camera, a strip of the body and a leg appearing in the widening gap at its edge; 5.3-5.4s stands in that gap side-on, back half to the camera, the grabber held low at the hip; 5.5-5.6s turns to face the camera at the door edge, staring into the lens; 5.7-5.9s sidesteps into the open doorway in the centre, facing the camera and staring straight into the lens with a blank deadpan face, the right hand on the handle at the hip, the left arm across the body holding the pole lower, the jaw tipping toward the lens; 6.0-6.1s steps toward the camera and thrusts the jaw at the lens, the jaw growing huge in the lower left; 6.2-6.6s lunges right up to the lens, the jaw dropping out of the bottom of the frame, the left hand gripping the pole near the lens, the face leaving the top of the frame and the chest filling it",
        color: "#64d2ff", at: [46, 38] },
    ],
  },
  // 22 October 2026, the owner: "importi questi due nuovi template" (an Instagram reel by @tisha_bimbo, a Higgsfield
  // Genjutsu clip, 19 s, one take at 1080x1920 24 fps): a CGI panda dribbles up a Knicks court, dunks and roars into the
  // lens. Its first 15 s, one seat (the panda), the prompt written seat by seat.
  {
    key: "trend-garden-dunk", name: "Garden Dunk", blurb: "Put yourself in this viral clip", tint: "#0a84ff",
    baseUrl: `${TRENDS_MEDIA}/garden-dunk/base.mp4`, baseSeconds: 15,
    preview: `${TRENDS_MEDIA}/garden-dunk/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/garden-dunk/guide.jpg`,
    scene: "Same New York Knicks home court at Madison Square Garden: the light maple floor with blue and white lines, the blue lane under the basket and the orange, blue and grey Knicks centre-court logo; the packed dark stands and the courtside front row of seated fans, the photographer in blue sitting at the sideline with a camera to the eye, and a red box held up by a seated fan behind him. The Knicks players in white home jerseys: number 8 with a white leg sleeve, starting half-hidden behind the dunker; number 1 running up behind on the right from 4.5 s and trailing the play to the basket; and bearded number 6, who walks in from the left at 12.5 s and ends right of the dunker's head with a hand in front of his face. The same orange ball, which drops through the net and bounces up behind on the left at the end. The basket with its glass backboard, padded frame, small US flag, red stanchion padding and the camera above the rim; the net flips up over the rim after the dunk (12-13.7 s) and drops back by 14 s; the red, white and blue LED ribbon boards high in the arena. The blurred heads and a raised phone of courtside people at the bottom of the frame, and the out-of-focus arm with a blue wristband that swings in from the right edge in front of the lens at 13.3 s and pumps until the end. Same low vertical camera at courtside, about waist height: it pans right with the run across the logo, tracks backward down the court ahead of the run with the dunker centred, tilts up from 9.5 s to follow the leap with the backboard entering at the top right, looks up at the dunk from below, then pushes in close at chest height for the roar. Same shallow depth of field, slight handheld float and dim arena light with warm spotlights on the court.",
    seats: [
      { key: "person1", label: "The dunker", where: "in the CENTRE of the court, the CGI giant panda in patchwork kung-fu shorts who runs the ball up the court toward the camera, dunks and roars into the lens",
        original: "no giant panda body, no black-and-white fur, no round white furry head, no dark eye patches, no round dark ears, no cartoon eyes, no fangs, no big round white belly, no paws or claws, no short black tail, no tan patchwork kung-fu shorts with a striped rope waistband, no cloth wraps round the ankles and feet, no chubby cartoon proportions",
        motion: "0-1s runs to the right across the centre-court logo, seen from the side, crouched, arms out in front, the ball balanced on top of the head rolling down behind it; 1-2s stops on one leg in a kung-fu stance, the other knee lifted high and one hand raised beside the face catching the ball, stern frown, then runs on with the ball at the chest in both hands, turning toward the camera; 2-3s runs straight at the camera in a low crouch, ball in both hands in front of the belly, elbows wide, frowning into the lens; 3-4s moves the ball to the right hand and bounces it once beside the right foot in a long stride; 4-6s keeps charging at the camera, the ball up from the hip to the chest (4.7-5.7s) and back to the hip, left arm swinging out wide, a small hop at 5s, eyes narrowed; 6-7s bounces the ball again with the right hand, left arm reaching forward; 7-8s gathers the ball in both hands and carries it to the left hip, eyes opening wide; 8-9s last steps, ball at the left hip, chin up, looking up at the basket; 9-10s jumps off the left foot, right knee driven up, lifts the ball in both hands, then high in the right hand with the left arm out wide; 10-11s rises through the air, ball high over the head in the right hand, eyes on the rim; 11-12s slams the ball down through the hoop with the right hand (through the net at 11.6-11.9s), body three-quarters toward the basket, head in profile tipped back, left arm hanging open beside the hip, then drops down with the right arm still up; 12-13s lands facing the camera, right hand raised high and open, mouth open in a grin, then swings the arm down and steps toward the camera; 13-15s leans in and roars straight into the lens, mouth wide open, fierce narrowed eyes, head pushing forward, arms down at the sides, coming closer",
        color: "#0a84ff", at: [46, 60] },
    ],
  },
  // Same day, the second reel (@motomotohumano, 15 s, one take at 1080x1920 30 fps): a man squatting on a branch over a
  // river chops the branch he sits on until it snaps and he falls into the water. One seat, the prompt seat by seat.
  {
    key: "trend-branch-chop", name: "Branch Chop", blurb: "Put yourself in this viral clip", tint: "#30d158",
    baseUrl: `${TRENDS_MEDIA}/branch-chop/base.mp4`, baseSeconds: 15,
    preview: `${TRENDS_MEDIA}/branch-chop/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/branch-chop/guide.jpg`,
    scene: "Same calm green river seen from up in a tree: the thick grey-barked branch running up from the bottom of the frame out over the water, with its fork and a thin leafy side branch to the left; the pale notch of fresh-cut wood on the camera-left side of the branch just below the fork, growing deeper with every chop, with wood chips flying off it; the same long-handled axe (a thin brown wooden handle about as long as an arm, a pale grip band, a small dark iron head); the branch snapping at 13 s, its outer part falling into the river while the cut stump with its jagged top stays in the foreground, and the big white splash among the leafy twigs at the end. The greyish-green water with floating white specks and tree reflections, the bright strip of reflected sky behind on the right, the far bank with dry golden grass and green bushes, the tall pale-trunked tree with long narrow hanging leaves right behind the squatting person, its crown filling the top of the frame, leafy twigs at the left and bottom edges, bare grey twigs hanging at the right edge and a patch of hazy sky at the top left; no other people. Same handheld vertical phone camera one to one and a half metres in front on the trunk side, a little above head height, looking down along the branch at the whole squatting body and the cut with a gentle sway, then from 13 s tilting sharply down and leaning out past the stump to follow the fall, ending straight down on the splash. Same soft hazy daylight, warm sun on the far bank, no hard shadows.",
    seats: [
      { key: "person1", label: "The lumberjack", where: "on the BRANCH over the river in the centre of the frame, squatting and facing the camera with the axe in the right hand",
        original: "no red Adidas polo shirt, no cream piping on the collar, placket and sleeve hems, no white Adidas logo on the chest, no white logo on the sleeve, no navy blue shorts, no bald shaved head, no big heavy-set build with broad shoulders and thick arms and legs, no bare round belly under a riding-up shirt",
        motion: "0-1s squats on the branch facing the camera, knees wide, feet gripping the wood, the left hand down behind the left knee holding the branch, head bowed, eyes on the cut below the feet, then raises the axe upright above the head with the right hand and chops down into the branch at 0.6s; 1-3s keeps the same calm rhythm with a faint focused smile: levers the blade loose, raises the axe above the head and chops at 1.6s and 2.6s; 3-4s a short tap at 3.4s, then holds the axe low and upright at the right side, the hand by the right knee; 4-8s chops at about 4.0s, 5.0s, 6.0s and 7.0s, wiggling and levering the blade in the cut between strokes, head bowed watching the cut; 8-11s raises the axe high above the head and chops at 8.3s and 10.0s, then short taps working the blade in the deep cut; 11-13s two big overhead swings, the right arm high above the head, chopping down hard at 11.7s and 13.0s; 13-14s the branch snaps at 13.1s: still squatting on the broken piece, sinks down behind the stump holding the axe halfway along the handle, slides off past the stump on the frame-right side reaching down with the left hand, then drops head first into the water with the right arm and the axe raised, hitting the water at about 13.9s; 14-15s is gone under the big white splash",
        color: "#30d158", at: [51, 44] },
    ],
  },
  // 20 October 2026, the owner: "mi serve il template per questo" (an Instagram reel by @cantbemelo, 42 s, one take):
  // its first 15 s at 1080x1920, one seat, the prompt written seat by seat like You Talking Bout Me.
  {
    key: "trend-wings-and-vibes", name: "Wings & Vibes", blurb: "Put yourself in this viral clip", tint: "#ff9f0a",
    baseUrl: `${TRENDS_MEDIA}/wings-and-vibes/base.mp4`, baseSeconds: 15,
    preview: `${TRENDS_MEDIA}/wings-and-vibes/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/wings-and-vibes/guide.jpg`,
    scene: "Same small room: the black desk on the left with a monitor, a microphone on a boom arm, an open Domino's box of chicken wings, a Vaseline lotion bottle, a two-litre Coca-Cola bottle and crumpled tissues; cream walls, white wall shelves at the top left, a window with white blinds and a white box fan behind him, the beige office chair. Same static vertical phone camera from behind on the left, the person seen in side profile, same framing, same soft daylight from the window.",
    seats: [
      { key: "person1", label: "At the desk", where: "sitting in the beige office chair on the RIGHT, seen in side profile, facing the desk on the left and eating chicken wings",
        original: "no white sauce-stained T-shirt, no cream over-ear headphones, no black trousers",
        motion: "0-2s leans toward the desk and picks chicken wings from the open box with both hands; 2-4s brings a wing to the mouth with both hands and eats it, chewing; 4-8s reaches back into the box with both hands and picks another piece, leaning forward over the desk; 8-12s leans back in the chair holding a wing in one hand, raises the other hand and waves it slowly as if conducting the music, swaying, eyes half closed; 12-15s stretches the right arm to the box, takes another wing and brings it toward the mouth",
        color: "#ff9f0a", at: [86, 52] },
    ],
  },
  // 21 October 2026, the owner: "altro template" (an Instagram reel by @bisouboge, 14 s, one take, 1080x1920): a young
  // man dancing in a Paris street in front of a burning fire. One seat, the prompt written seat by seat.
  {
    key: "trend-paris-fire-dance", name: "Paris Fire Dance", blurb: "Put yourself in this viral clip", tint: "#ff453a",
    baseUrl: `${TRENDS_MEDIA}/paris-fire-dance/base.mp4`, baseSeconds: 14,
    preview: `${TRENDS_MEDIA}/paris-fire-dance/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/paris-fire-dance/guide.jpg`,
    scene: "Same wide Paris street: grey asphalt with scattered litter and debris, a fire burning on the road behind the dancer with thick grey and black smoke rising, cream Haussmann buildings with wrought-iron balconies, the corner building with its arched doors, the newspaper kiosk and the cafe-tabac sign on the left, the trees along the street, and the crowd of people mostly dressed in black walking and running behind him, every one of them with their exact movements. Same handheld vertical phone camera a few metres in front of him at chest height, moving back a little and following him, same framing, shake, focus and hazy daylight.",
    seats: [
      { key: "person1", label: "The dancer", where: "in the CENTRE of the street, facing the camera, dancing in front of the fire",
        original: "no white shirt, no black waistcoat, no black tie, no black glasses, no yellow rubber gloves, no tattooed forearm",
        motion: "0-1s stands facing the camera, arms down, looking straight into the lens; 1-2s hops on one leg with one hand raised by the face; 2-3s skips toward the camera, arms out, one knee lifted; 3-5s stands, then steps forward with the arms slightly out; 5-6s dances with the arms spread wide and one knee up; 6-7s turns his back to the camera and kicks one leg back; 7-8s turns back, waves one hand high and hops on one leg; 8-10s stands loosely, a hand at the hip, looking at the camera; 10-11s dips and dances with the arms out wide and one leg lifted; 11-12s hops with one arm across the chest, pointing; 12-14s side-steps to the right and dances with bent knees",
        color: "#ff453a", at: [51, 50] },
    ],
  },
  // 21 October 2026, the owner: "stessa identica cosa per questo" (an Instagram post of Ausar's own result, with its
  // watermark), then "per aiutarti: https://ausar.ai/templates/bby-why". The clean fixed clip and the prompt come from
  // that public template page (10 s, one dancer at a party), the prompt in WaveSpeed's words (Image 1, Video 1).
  fromCatalog({
    slug: "bby-wow", name: "Bby Wow", blurb: "Put yourself in this viral clip", tint: "#bf5af2", seconds: 10,
    seats: [{ key: "person1", label: "Person 1", hint: "The dancer in the cream graphic tee", color: "#bf5af2" }],
    prompt: "CHARACTER REPLACEMENT - SINGLE SUBJECT ONLY.\nReplace ONLY the young man who is the main dancer in Video 1 (the man in the center of frame, wearing the oversized cream \"DAKITI\" graphic tee, baggy black pants, black sneakers and a silver chain) with the person from Image 1. Every other element of Video 1 stays 100% identical, frame by frame.\n\nIDENTITY (from Image 1):\nThe replacement person must be an exact, photorealistic match of Image 1: identical face shape, facial structure, jawline, nose, eyes, eyebrows, lips, ears, skin tone, skin texture, facial hair, hairline, hairstyle, hair color and hair texture. Take the exact body proportions from Image 1: height relative to the frame, shoulder width, torso length, arm and leg length, body build and weight. Do not slim, enlarge, beautify or stylize the person. The face stays recognizable and consistent in every frame, including fast turns, motion blur, side profiles, close-ups near the camera and full rear views, where hair shape, neck, ears and body build must still match Image 1.\n\nOUTFIT (from Image 1):\nDress the person exactly in the clothing and accessories shown in Image 1: same garments, colors, fabrics, prints, logos, fit, length, shoes and jewelry. Do not keep any clothing from the original dancer. If something in the reference is not visible (for example the back of the shirt or the shoes), continue it logically and realistically in the same style, color and material. The clothes behave like real fabric: natural folds, wrinkles, weight, stretching at the shoulders and knees, and swinging and settling with each dance move and turn. Changing the outfit must never change identity, hairstyle or body proportions.\n\nMOTION (from Video 1, 1:1):\nCopy the motion of the original dancer exactly, with no changes in timing, speed, rhythm or amplitude: the relaxed, laid-back party dance with loose shuffling footwork, hip and shoulder bounce, arm swings, the moment he raises his hand to his mouth, the slow walk toward the camera, the turn away from the camera, the rear-facing dance steps and the turn back. Keep his exact position in frame, his distance to the camera, the placement of his feet on the floor, his hand positions and his head movements. He holds a phone in his right hand exactly as in Video 1 and keeps holding it. The facial expression and mouth movements follow the original performance, rendered naturally on the new face.\n\nSCENE, CAMERA AND LIGHTING (from Video 1, unchanged):\nKeep the exact original scene: the indoor party hall with tiled floor, white draped walls, the softbox photo light on its stand, flower centerpieces, gold chiavari chairs, decorated tables, the guests (woman in the red dress, man in the white shirt, woman in the pale mint ball gown, little girl in the white dress, everyone else) and all of their movements. Keep the exact handheld camera movement, shake, framing, crop, zoom, focus shifts, motion blur, 9:16 vertical format and frame rate.\nRelight the new person exactly with the scene's real lighting: green uplight at the start, then shifting magenta, pink and purple party lights, warm ceiling light and the soft white flash/softbox light. The colored light must fall on the new person's skin, hair and clothes the same way it falls on the original dancer, with correct shadows, rim light, reflections on the floor and contact shadows under the feet. Match the original video's color grading, white balance, exposure, grain/noise, sharpness and compression so the person blends in seamlessly as if filmed in the same shot.\n\nAUDIO:\nKeep the original audio track completely unchanged: same music, crowd noise, timing and sync.\n\nREALISM:\nUltra-photorealistic, real smartphone footage. Natural skin with visible pores, fine imperfections, natural shine and subsurface scattering; real individual hair strands that move with the motion; correct anatomy with five fingers on each hand; physically correct body weight and ground contact. It must look like real filmed video and must not look AI-generated, CGI, airbrushed, plastic, waxy or doll-like.",
  }),
  ...IMPORTED_TRENDS.map(fromCatalog),
];

export const trendByKey = (key: string | null | undefined): Trend | null => TRENDS.find((t) => t.key === key) ?? null;
export const isTrendKey = (key: string | null | undefined): boolean => !!trendByKey(key);

/** Seconds WaveSpeed bills for one run: the source rounded up and capped at 15, plus an output just as long. */
export function trendBilledSeconds(t: Pick<Trend, "baseSeconds">): number {
  const source = Math.min(15, Math.max(1, Math.ceil(t.baseSeconds - 1e-6)));
  return source * 2;
}
export const trendQuality = (q: string | undefined): TrendQuality => (TREND_QUALITIES.includes(q as TrendQuality) ? (q as TrendQuality) : DEFAULT_TREND_QUALITY);
export function trendCostUsd(t: Pick<Trend, "baseSeconds" | "prime">, q: TrendQuality): number {
  return Math.round(trendBilledSeconds(t) * (t.prime ? WAN30_PRIME_EDIT_USD_PER_S : WAN30_EDIT_USD_PER_S)[q] * 1000) / 1000;
}

const ORDINAL = ["Image 1", "Image 2", "Image 3"];

/** What the person picked on the page: a value per change ("original" or none = no change), `<key>Text`, `extra`. */
export type TrendPicks = Record<string, string | undefined>;
const oneLine = (s: string | undefined, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The picked changes in the template's order, each with the seat it restyles (a seat's photo wins over its change). */
function pickedChanges(t: Trend, filled: string[], picks: TrendPicks): { text: string; seat?: string }[] {
  const out: { text: string; seat?: string }[] = [];
  for (const c of t.changes ?? []) {
    if (c.seat && filled.includes(c.seat)) continue;
    const v = picks[c.key];
    const own = v === "custom" && c.custom ? oneLine(picks[`${c.key}Text`], TREND_CUSTOM_MAX).replace(/[.\s]+$/, "") : "";
    const text = own ? `${c.custom} ${own}.` : c.options.find((o) => o.value === v)?.text;
    if (text) out.push({ text, seat: c.seat });
  }
  const extra = t.changes?.length ? oneLine(picks.extra, TREND_EXTRA_MAX) : "";
  if (extra) out.push({ text: `Also: ${extra}${/[.!?]$/.test(extra) ? "" : "."}` });
  return out;
}
/** The instructions the person's picks add to the prompt, in order. */
export const trendChangeLines = (t: Trend, filled: string[], picks: TrendPicks = {}): string[] => pickedChanges(t, filled, picks).map((c) => c.text);

/**
 * The edit instruction for the seats that have a photo, in seat order (Image 1 is the first filled seat). A seat
 * without a photo keeps its original person. The structure is the one that came out clean on 20 October 2026.
 */
export function trendPrompt(t: Trend, filled: string[], picks: TrendPicks = {}): string {
  const seats = t.seats.filter((s) => filled.includes(s.key));
  const kept = t.seats.filter((s) => !filled.includes(s.key));
  const world = pickedChanges(t, filled, picks);
  const restyled = new Set(world.map((c) => c.seat).filter(Boolean));
  const img = (s: TrendSeat) => ORDINAL[seats.indexOf(s)];
  const one = seats.length === 1;
  const who = one ? `the person from ${img(seats[0])}` : `the people from ${seats.map(img).join(", ").replace(/, ([^,]*)$/, " and $1")}`;
  const lines: string[] = [];
  lines.push(`Recreate Video 1 exactly, frame for frame, with a new cast: ${one ? "one person is" : `${seats.length} people are`} replaced by ${who}. Everything else stays identical to Video 1${kept.length ? ", including the other people" : ""}${world.length ? ", except the WORLD CHANGES below" : ""}.`);
  lines.push("", "CAST (identification only, nothing of the original look is kept)");
  for (const s of seats) lines.push(`- ${img(s)} replaces the person ${s.where ?? ""}.`);
  for (const s of kept) lines.push(restyled.has(s.key) ? `- The person ${s.where ?? ""}. This person keeps the exact movements of Video 1 and changes only as the WORLD CHANGES say.`
    : `- The person ${s.where ?? ""} stays exactly as in Video 1: the same face, hair, clothes and movements.`);
  lines.push("This mapping is fixed for the whole video. Each new person appears exactly once per frame, only in their own seat. No swapping, no merging, no sharing faces, hair or clothes.");
  if (world.length) lines.push("", "WORLD CHANGES (only these; every position, every movement, the ball's path and the timing stay exactly as in Video 1)", ...world.map((c) => `- ${c.text}`));
  lines.push("", "EXACT LIKENESS - THE MOST IMPORTANT RULE",
    "Each new person must look IDENTICAL to their reference image, as if they were really filmed in this scene. Copy everything 1:1 and change nothing:",
    "- FACE: the exact face shape, bone structure, eyes, eye colour, eyebrows, nose, lips, ears, jawline, marks and facial hair.",
    "- SKIN: the exact skin tone and skin texture.",
    "- HAIR: the exact hairstyle, length, colour and hairline.",
    "- BODY: the exact age, build and proportions.",
    "- OUTFIT: the exact garments, colours, patterns, fabrics and fit; parts not visible in the reference are completed in the same style.",
    "- ACCESSORIES: the exact headwear, glasses, jewellery and watches of the reference, and only those.",
    "- LOOK: if the reference is a real photo, the person is photorealistic; a stylised reference keeps its own style.",
    "Nothing is beautified, smoothed, simplified, recoloured or reinterpreted. Each new person looks exactly like their reference in every frame, also in close-ups, when laughing, when covering the face and when turned away.");
  lines.push("", "NOTHING FROM THE ORIGINAL PEOPLE");
  lines.push(`${seats.map((s) => s.original).filter(Boolean).join("; ")}; no original faces. The replaced people are only invisible motion and performance guides.`);
  lines.push("", "MOTION AND PERFORMANCE",
    "Every new person copies the exact movements, gestures, head turns, facial expressions, lip movement and timing of the person they replace, frame-accurately, adapted naturally to their own body:");
  for (const s of seats) if (s.motion) lines.push(`- ${img(s)}: ${s.motion}.`);
  lines.push("All lips move in perfect sync with the original speech and laughter, with natural expressions and eye movement.");
  lines.push("", "IDENTITY LOCK",
    "Each new person keeps exactly the same face, hair and outfit from the first frame to the last, also when partly out of frame, turned away or out of focus. No morphing, no drift back to the original people.");
  lines.push("", "NO NEW PEOPLE", world.length ? "The players stay exactly the same in number, and no new people appear except as the WORLD CHANGES say."
    : "The number of people stays exactly the same, and no new people appear anywhere.");
  const edit = t.edit ?? "One continuous shot, no cuts.";
  lines.push("", "SCENE AND CAMERA", (world.length
    ? `The camera, the framing, the cuts and the timing are identical to Video 1. Video 1's world before the changes: ${t.scene ?? ""} The WORLD CHANGES replace only what they name; everything else stays as in Video 1. ${edit} No other new objects or text.`
    : `Identical to Video 1. ${t.scene ?? ""} ${edit} No new objects, no new text.`).replace("  ", " "));
  lines.push("", "STYLE",
    "Natural handheld footage, looking like it was really filmed there. Each new person is lit naturally by the room's light with matching shadows. Anatomically correct hands with five fingers. No beauty filter, no skin smoothing, no over-sharpening, no face flicker, no morphing, no distorted faces in the background.");
  return lines.join("\n");
}

/** The prompt of a template written shot by shot stays under this many characters, whatever the picks. */
export const TREND_PROMPT_V2_MAX = 6000;

/** The few photo facts the prompt may use: fixed words read from the vision check, never its free text. */
function factLine(f: PhotoFacts | undefined): string {
  if (!f) return "";
  // A hair colour read from a black-and-white photo is a guess; "other" says nothing.
  const hair = f.hair === "bald" ? "a bald head" : f.hair && f.hair !== "other" && f.colour !== "greyscale" ? `${f.hair} hair` : "";
  const parts = [
    hair,
    f.beard === true ? "a beard" : f.beard === false ? "no beard" : "",
    f.glasses === true ? "glasses" : "",
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * The edit instruction of a template written shot by shot (23 October 2026). Built from Alibaba's own rules for Wan 3.0
 * edits ("Edit the video: replace … keep the rest unchanged", one clear purpose per reference image, no feature bleeding
 * between subjects) and from the first paid Crossover King run that came back wrong. In order: the task, who is who (by
 * role, with what the original person wears only to find them), the shots with the cut, the place written once and
 * never contradicted, how the new people look, the style. Nothing re-describes the original place after a change.
 */
export function trendPromptV2(t: Trend, filled: string[], picks: TrendPicks = {}, facts: Record<string, PhotoFacts | undefined> = {}, later: string[] = []): string {
  const seats = t.seats.filter((s) => filled.includes(s.key));
  const img = (s: TrendSeat) => ORDINAL[seats.indexOf(s)];
  const changes = t.changes ?? [];
  const chosen = (c: TrendChange): { option?: TrendOption; own?: string } => {
    const v = picks[c.key];
    if (v === "custom" && c.custom) {
      const own = oneLine(picks[`${c.key}Text`], TREND_CUSTOM_MAX).replace(/[.\s]+$/, "");
      return own ? { own } : {};
    }
    const option = c.options.find((o) => o.value === v);
    return option ? { option } : {};
  };
  const byKind = (k: NonNullable<TrendChange["kind"]>) => changes.find((c) => c.kind === k);
  const place = byKind("place"), light = byKind("light"), people = byKind("people"), signs = byKind("signs");
  const placePick = place ? chosen(place) : {};
  const lightPick = light ? chosen(light) : {};
  const peoplePick = people ? chosen(people) : {};
  const signsPick = signs ? chosen(signs) : {};
  const extra = changes.length ? oneLine(picks.extra, TREND_EXTRA_MAX) : "";
  const placeChanged = !!(placePick.option || placePick.own);
  const placeReplaced = !!placePick.own || (!!placePick.option && !placePick.option.same);
  const lightChanged = !!(lightPick.option || lightPick.own), peopleChanged = !!(peoplePick.option || peoplePick.own), signsChanged = !!(signsPick.option || signsPick.own);
  const worldChanged = placeChanged || lightChanged || peopleChanged || signsChanged || !!extra;
  const seatChange = (s: TrendSeat) => changes.find((c) => c.seat === s.key);
  const role = (s: TrendSeat) => s.role ?? s.label;

  const roles = seats.map((s) => `${role(s)} with the person from ${img(s)}`);
  // A seat swapped in a later pass (trendPasses) stays exactly as it is in this one, whatever its own change says.
  const restyled = t.seats.filter((s) => !filled.includes(s.key) && !later.includes(s.key)).map((s) => ({ s, c: seatChange(s) })).filter(({ c }) => c && (chosen(c).option || chosen(c).own));
  const what = placeChanged ? "the place around them" : [lightChanged ? "the light" : "", peopleChanged ? "the spectators" : "", signsChanged ? "the boards" : "", extra && !lightChanged && !peopleChanged && !signsChanged ? "what is asked" : ""].filter(Boolean).join(", ").replace(/, ([^,]*)$/, " and $1");
  const lines: string[] = [];
  const asks = [`replace ${roles.join(" and ")}`, restyled.length ? `change ${restyled.map(({ s }) => role(s)).join(" and ")} as written under WHO IS WHO` : "", worldChanged ? `change ${what} as written under THE PLACE` : ""].filter(Boolean);
  lines.push(`Edit Video 1: ${asks.length === 1 ? asks[0] : `${asks.slice(0, -1).join(", ")}, and ${asks[asks.length - 1]}`}. Keep Video 1's camera, framing, ${(t.shots?.length ?? 1) > 1 ? "cuts, " : ""}speed, every movement, the ball's path and the timing exactly as they are.`);

  lines.push("", "WHO IS WHO");
  for (const s of t.seats) {
    const id = `${s.role ?? s.label}, ${s.who ?? "the person"} (in Video 1: ${s.wears ?? ""})`;
    if (filled.includes(s.key)) {
      lines.push(`- ${img(s)} = ${id}. ${s.seen ?? ""}`.trim());
      if (s.back) lines.push(`  When ${s.role ?? "this person"} is seen from the side or from behind, show the hair, head shape, build and the back of the outfit of the person in ${img(s)}.`);
    } else {
      const c = later.includes(s.key) ? undefined : seatChange(s), pick = c ? chosen(c) : {};
      if (pick.option) lines.push(`- ${id}: ${pick.option.text}`);
      else if (pick.own && c?.custom) lines.push(`- ${id}: ${c.custom} ${pick.own}.`);
      else lines.push(`- ${id}, stays exactly as in Video 1: the same face, hair, clothes and movements.`);
    }
  }
  if (t.seats.length > 1) lines.push("- Each face belongs only to its own person. When a person is turned away, small or out of the shot, their face never moves to anyone else, and no spectator becomes either of them.");
  if (seats.length > 1) {
    lines.push(`- ${seats.map((s) => `${img(s)}'s face goes only on ${role(s)}`).join(", ")}.`);
    const told = seats.map((s) => ({ s, d: factLine(facts[s.key]) }));
    if (told.every((x) => x.d) && new Set(told.map((x) => x.d)).size === told.length) lines.push(`  To tell them apart: ${told.map(({ s, d }) => `${img(s)} has ${d}`).join("; ")}.`);
  }

  const shots = t.shots ?? [];
  const changed = [...seats, ...restyled.map(({ s }) => s)];
  const anchors = [
    changed.length ? `${changed.map((s) => `${role(s)}${s.onScreen ? ` (in the clip ${s.onScreen})` : ""}`).join(" and ")} ${changed.length > 1 ? "are" : "is"} changed from the first frame, 0.0 s, wherever Video 1 shows ${changed.length > 1 ? "them" : "him"}` : "",
    worldChanged ? `the changes under THE PLACE hold from the first frame to the last` : "",
  ].filter(Boolean);
  lines.push("", `SHOTS (Video 1 has exactly ${shots.length === 1 ? "1 shot" : `${shots.length} shots`}${anchors.length ? `; ${anchors.join("; ")}` : ""})`);
  shots.forEach((sh, i) => {
    if (i > 0) lines.push(`- Hard cut at ${sh.from} s.`);
    lines.push(`- Shot ${i + 1}, ${sh.from}-${sh.to} s, ${sh.view}: ${sh.cast}`);
  });

  lines.push("", "THE PLACE");
  const w = t.world ?? { place: "the same place", light: "the same light" };
  if (!worldChanged) lines.push(`Exactly as in Video 1: ${[w.place, w.light, w.people, w.signs].filter(Boolean).join("; ")}.`);
  else {
    if (placePick.option) lines.push(`- PLACE: ${placePick.option.text}.`);
    else if (placePick.own) lines.push(`- PLACE: ${placePick.own}.`);
    else lines.push(`- PLACE: the same place as in Video 1, ${w.place}.`);
    if (placeReplaced) {
      const gone = (t.worldParts ?? []).filter((p) => !p.keptBy || (p.keptBy === signs?.key && signsChanged)).map((p) => p.text);
      const keep = !signsChanged && signs && w.signs ? `Of Video 1's park only the ${w.signs.replace(/ with .*$/, "")} stay; there is ` : "Nothing of Video 1's park is left: ";
      if (gone.length) lines.push(`  ${keep}${gone.join(", ")}.`);
    }
    // One light, written once: a picked light, else the light a new place brings, else Video 1's own; a place in the
    // person's own words brings its own light, so none is added.
    const lightText = lightPick.option?.text ?? lightPick.own ?? placePick.option?.time ?? (placePick.own ? "" : `as in Video 1, ${w.light}`);
    if (lightText) lines.push(`- LIGHT: ${lightText}.`);
    if (peoplePick.option) lines.push(`- SPECTATORS: ${peoplePick.option.text}.`);
    else if (peoplePick.own) lines.push(`- SPECTATORS: ${peoplePick.own}.`);
    else if (!placeReplaced && w.people) lines.push(`- SPECTATORS: as in Video 1, ${w.people}.`);
    if (signsPick.option) lines.push(`- BOARDS: ${signsPick.option.text}.`);
    else if (signsPick.own) lines.push(`- BOARDS: boards that read "${signsPick.own.replace(/"/g, "")}".`);
    else if (!placeReplaced && w.signs) lines.push(`- BOARDS: as in Video 1, ${w.signs}.`);
    if (extra) lines.push(`- ALSO: ${extra}${/[.!?]$/.test(extra) ? "" : "."}`);
    lines.push("All of this is the same through the whole clip, from the first frame to the last.");
  }

  if (seats.length) {
    lines.push("", "THE NEW PEOPLE",
      `Each new person looks exactly like the person in their image: the face, skin tone, hair, age and build, and the complete outfit from their image, head to toe, in every frame of every shot. What the image does not show is completed in the same style, never with Video 1's sports clothes (no sleeveless top, no basketball shorts, no tights, no white socks).`);
    for (const s of seats) if (facts[s.key]?.colour === "greyscale") lines.push(`${img(s)} is a black-and-white photo: give that person natural, realistic colour (skin, hair and clothes).`);
  }

  const words = signsPick.option?.text.match(/"([^"]+)"/)?.[1] ?? signsPick.own;
  lines.push("", "STYLE",
    `Real handheld phone footage, photorealistic, natural skin, five fingers on each hand. No beauty filter, no morphing, no face flicker. No new text${words ? ` except "${words.replace(/"/g, "")}" on the boards` : ""}.`);
  return lines.join("\n");
}

/**
 * The second pass of a two-person template written shot by shot (23 October 2026). With both photos in one run Wan 3.0
 * put the faces on the player it could see best and left the defender, seen mostly from behind, as he was (paid probe,
 * Crossover King Pt 2). Alibaba's own advice is one change at a time, so the second person goes in alone, on the first
 * pass's result: one reference image, one person to change, everything else (the first person, the new place) kept.
 */
export function trendPromptPass(t: Trend, seatKey: string, facts: Record<string, PhotoFacts | undefined> = {}): string {
  const seat = t.seats.find((s) => s.key === seatKey);
  if (!seat) throw new Error(`no seat ${seatKey}`);
  const role = (s: TrendSeat) => s.role ?? s.label;
  const others = t.seats.filter((s) => s.key !== seatKey);
  const lines: string[] = [];
  lines.push(`Edit Video 1: replace only ${role(seat)} with the person from the reference image. Keep everything else in Video 1 exactly as it is: ${others.length ? `${others.map((s) => `${role(s)} with his own face`).join(", ")}, ` : ""}the place, the light, the spectators, the boards, the camera, the speed, every movement and the timing.`);
  lines.push("", "WHO IS WHO",
    `- ${role(seat)} is ${seat.who ?? "the person"}, in Video 1 wearing ${seat.wears ?? "his own clothes"}. ${seat.seen ?? ""}`.trim());
  if (seat.back) lines.push(`  When ${role(seat)} is seen from the side or from behind, show the hair, head shape, build and the back of the outfit of the person in the reference image.`);
  for (const s of others) lines.push(`- ${role(s)} is ${s.who ?? "the other person"}: he stays exactly as in Video 1, with the same face, hair, clothes and movements. The reference image's face never goes on him or on any spectator.`);
  const shots = t.shots ?? [];
  lines.push("", `SHOTS (Video 1 has exactly ${shots.length === 1 ? "1 shot" : `${shots.length} shots`}; ${role(seat)}${seat.onScreen ? ` (in the clip ${seat.onScreen})` : ""} is changed from the first frame, 0.0 s, wherever Video 1 shows him)`);
  shots.forEach((sh, i) => {
    if (i > 0) lines.push(`- Hard cut at ${sh.from} s.`);
    lines.push(`- Shot ${i + 1}, ${sh.from}-${sh.to} s, ${sh.view}: ${sh.cast}`);
  });
  lines.push("", "THE NEW PERSON",
    `${role(seat)} looks exactly like the person in the reference image: the face, skin tone, hair, age and build, and the complete outfit from the image, head to toe, in every frame. What the image does not show is completed in the same style, never with what he wears in Video 1 (${seat.wears ?? "his old clothes"}).`);
  if (facts[seatKey]?.colour === "greyscale") lines.push("The reference image is a black-and-white photo: give the person natural, realistic colour (skin, hair and clothes).");
  lines.push("", "STYLE", "Real handheld phone footage, photorealistic, natural skin, five fingers on each hand. No beauty filter, no morphing, no face flicker. No new text.");
  return lines.join("\n");
}

/**
 * The WaveSpeed runs of one order, in order. One run for a template with its own prompt, for one person, or for a
 * template not written shot by shot. Two runs for two people in a template written shot by shot: the first person and
 * the world first, then the second person alone on that result ("{{prev}}" is the first run's video).
 */
export function trendPasses(t: Trend, filled: string[], photos: string[], q: TrendQuality, picks: TrendPicks = {}, facts: Record<string, PhotoFacts | undefined> = {}): Record<string, unknown>[] {
  if (t.prompt || !t.shots || filled.length < 2) return [trendTaskInput(t, filled, photos, q, picks, facts)];
  const [first, ...rest] = filled;
  if (rest.length > 1) throw new Error("two-pass templates take two people");
  const base = { resolution: q, generate_audio: false, enable_prompt_expansion: false, seed: -1 };
  return [
    { prompt: trendPromptV2(t, [first], picks, facts, rest).slice(0, TREND_PROMPT_V2_MAX), video: t.baseUrl, reference_images: [photos[0]], ...base },
    { prompt: trendPromptPass(t, rest[0], facts).slice(0, TREND_PROMPT_V2_MAX), video: "{{prev}}", reference_images: [photos[1]], ...base },
  ];
}

/**
 * What the prompt is told about the photos themselves, from the fixed words of the vision check (27 October 2026, before
 * the owner's next paid run of You Tweaking): a black-and-white photo, a photo with several people in it, a photo of
 * the head only. Nothing when the photos are ordinary, so every prompt sent without these facts stays as it was. The
 * templates written shot by shot say it in their own words (trendPromptV2).
 */
export function photoNotes(filled: string[], facts: Record<string, PhotoFacts | undefined> = {}): string[] {
  const out: string[] = [];
  filled.forEach((k, i) => {
    const f = facts[k], img = ORDINAL[i];
    if (!f || !img) return;
    if (f.colour === "greyscale") out.push(`${img} is a black-and-white photo: give that person natural, realistic colour (skin, hair and clothes).`);
    if ((f.people ?? 1) > 1) out.push(`${img} shows more than one person: use only the main person in it, the largest and closest to the camera, and nobody else from it.`);
    if (f.framing === "head") out.push(`${img} shows only the head: take the face and hair from it, and give that person simple everyday clothes that suit them, never the clothes of the person they replace.`);
  });
  return out;
}
const withNotes = (prompt: string, notes: string[]): string => (notes.length ? `${prompt}\n\nABOUT THE PHOTOS\n${notes.join("\n")}` : prompt);

/** The WaveSpeed input of one run. `photos` are the filled seats' links, in seat order (all of them for a fixed prompt). */
export function trendTaskInput(t: Trend, filled: string[], photos: string[], q: TrendQuality, picks: TrendPicks = {}, facts: Record<string, PhotoFacts | undefined> = {}): Record<string, unknown> {
  return {
    prompt: t.shots ? trendPromptV2(t, filled, picks, facts).slice(0, TREND_PROMPT_V2_MAX) : withNotes(t.prompt ?? trendPrompt(t, filled, picks), photoNotes(filled, facts)), video: t.baseUrl, reference_images: photos.slice(0, t.seats.length), resolution: q,
    // false keeps the clip's own sound on the result (WaveSpeed: "the source audio track is preserved").
    generate_audio: false, enable_prompt_expansion: false, seed: -1,
  };
}
