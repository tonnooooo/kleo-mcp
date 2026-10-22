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
  /** The clip looping on the app's card (its first 6 s at up to 1080p, with its "-p.mp4" → ".jpg" poster). */
  preview: string;
  /** A still of the fixed clip, with the seats marked on it by the page. */
  guide: string;
  seats: TrendSeat[];
  /** The room and the camera, to keep identical (templates whose prompt Kleo writes per seat). */
  scene?: string;
  /**
   * A fixed edit instruction ("Image 1", "Image 2", "Video 1"): the imported templates (./trends-catalog.ts). Every seat
   * then needs its photo, as on ausar.ai; without one, Kleo writes the prompt for the seats that have one (trendPrompt).
   */
  prompt?: string;
}

/** One imported template as the catalog stores it (./trends-catalog.ts). */
export interface CatalogTrend { slug: string; name: string; blurb: string; tint: string; seconds: number; seats: { key: string; label: string; hint: string; color: string }[]; prompt: string }

export const TRENDS_MEDIA = "https://media.kleooai.com/app/templates";
/** Every seat needs a photo when the template brings its own prompt. */
export const trendNeedsAllSeats = (t: Pick<Trend, "prompt">): boolean => !!t.prompt;
/** WaveSpeed's Wan 3.0 video edit: dollars per billed second (source + output). */
export const WAN30_EDIT_USD_PER_S: Record<TrendQuality, number> = { "480p": 0.05, "720p": 0.10, "1080p": 0.20 };
export const WAN30_EDIT_MODEL = "alibaba/wan-3.0/video-edit";
export const TREND_QUALITIES: TrendQuality[] = ["480p", "720p", "1080p"];
export const DEFAULT_TREND_QUALITY: TrendQuality = "720p";

const fromCatalog = (c: CatalogTrend): Trend => ({
  key: `trend-${c.slug}`, name: c.name, blurb: c.blurb, tint: c.tint,
  baseUrl: `${TRENDS_MEDIA}/${c.slug}/base.mp4`, baseSeconds: c.seconds,
  preview: `${TRENDS_MEDIA}/${c.slug}/preview3-p.mp4`, guide: `${TRENDS_MEDIA}/${c.slug}/guide.jpg`,
  seats: c.seats, prompt: c.prompt,
});

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
export function trendCostUsd(t: Pick<Trend, "baseSeconds">, q: TrendQuality): number {
  return Math.round(trendBilledSeconds(t) * WAN30_EDIT_USD_PER_S[q] * 1000) / 1000;
}

const ORDINAL = ["Image 1", "Image 2", "Image 3"];

/**
 * The edit instruction for the seats that have a photo, in seat order (Image 1 is the first filled seat). A seat
 * without a photo keeps its original person. The structure is the one that came out clean on 20 October 2026.
 */
export function trendPrompt(t: Trend, filled: string[]): string {
  const seats = t.seats.filter((s) => filled.includes(s.key));
  const kept = t.seats.filter((s) => !filled.includes(s.key));
  const img = (s: TrendSeat) => ORDINAL[seats.indexOf(s)];
  const one = seats.length === 1;
  const who = one ? `the person from ${img(seats[0])}` : `the people from ${seats.map(img).join(", ").replace(/, ([^,]*)$/, " and $1")}`;
  const lines: string[] = [];
  lines.push(`Recreate Video 1 exactly, frame for frame, with a new cast: ${one ? "one person is" : `${seats.length} people are`} replaced by ${who}. Everything else stays identical to Video 1${kept.length ? ", including the other people" : ""}.`);
  lines.push("", "CAST (identification only, nothing of the original look is kept)");
  for (const s of seats) lines.push(`- ${img(s)} replaces the person ${s.where ?? ""}.`);
  for (const s of kept) lines.push(`- The person ${s.where ?? ""} stays exactly as in Video 1: the same face, hair, clothes and movements.`);
  lines.push("This mapping is fixed for the whole video. Each new person appears exactly once per frame, only in their own seat. No swapping, no merging, no sharing faces, hair or clothes.");
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
  lines.push("", "NO NEW PEOPLE", "The number of people stays exactly the same, and no new people appear anywhere.");
  lines.push("", "SCENE AND CAMERA", `Identical to Video 1. ${t.scene ?? ""} One continuous shot, no cuts. No new objects, no new text.`.replace("  ", " "));
  lines.push("", "STYLE",
    "Natural handheld footage, looking like it was really filmed there. Each new person is lit naturally by the room's light with matching shadows. Anatomically correct hands with five fingers. No beauty filter, no skin smoothing, no over-sharpening, no face flicker, no morphing, no distorted faces in the background.");
  return lines.join("\n");
}

/** The WaveSpeed input of one run. `photos` are the filled seats' links, in seat order (all of them for a fixed prompt). */
export function trendTaskInput(t: Trend, filled: string[], photos: string[], q: TrendQuality): Record<string, unknown> {
  return {
    prompt: t.prompt ?? trendPrompt(t, filled), video: t.baseUrl, reference_images: photos.slice(0, t.seats.length), resolution: q,
    // false keeps the clip's own sound on the result (WaveSpeed: "the source audio track is preserved").
    generate_audio: false, enable_prompt_expansion: false, seed: -1,
  };
}
