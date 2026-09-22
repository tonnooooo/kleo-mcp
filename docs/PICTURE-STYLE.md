# Kleo "picture" style — specification (2026-09-10)

> **Phase note.** Today a shot is one still picture and the camera move is played as Ken Burns
> (a scale-and-translate of that still). In a later phase the still is replaced by **generated
> motion**: the same shot is rendered by a video model that receives the move, the strength and the
> prompt suffix of §1a. **The grammar does not change with it** — the same ten `shot_kind`s, the same
> moves, strengths and durations, the same routing and sequencing rules. Only the renderer changes,
> and only inside `kenBurns` / `paint` in worker/keou/engine/picture.js.

Why: the cartoon/realistic looks used to draw AI pictures *behind* the Keou cinema layout (tech icons such as
wave/wifi, alarm, lock, timelines, HUD corner brackets, red chapter dot). The owner rejected that: a pirate video
must not borrow the cybersecurity vocabulary. cartoon and realistic now have their own visual language, built
around **shots**: several full-screen pictures per scene, cut on the narration like a short documentary
(reference: Opus-style AI videos), with captions in a font that matches the look, and no icons at all.

This document is the contract shared by the engine (worker/keou), the worker (worker/kleo_worker.py) and the
server (src/). Every layer must implement exactly this.

## 1. Storyboard format (what the client model / planner writes)

```json
{ "schema_version": 1, "editorial_status": "ready", "title": "...", "brand": "Kleo",
  "kleo_style": "cartoon",            // or "realistic"
  "style": "picture",                 // the Keou engine style for both kleo styles
  "format": "9:16", "language": "en", "voice": "am_michael", "speed": 1.05, "music": "bed",
  "max_duration": 75, "description": "...",
  "scenes": [
    { "id": "01-hook", "kind": "cinema", "chapter": "01 THE CAPTAIN", "accent": "amber",
      "title": "She never came back", "hl": "never",
      "voice": "Captain Mara buried her treasure on Skull Beach in 1720. She never came back for it.",
      "hold": 0.4,
      "shots": [
        { "image_prompt": "a red-haired pirate captain in a tricorn hat digging on a sunset beach, wooden chest, palm trees",
          "shot_kind": "hook", "caption": "SHE NEVER CAME BACK", "hl": "NEVER" },
        { "image_prompt": "the same pirate captain walking away along the shoreline at dusk, footprints in the sand",
          "shot_kind": "action", "at": "never came back" }
      ] },
    { "id": "05-closing", "kind": "closing", "accent": "cyan",
      "title": "Follow for part two", "voice": "Is it still there? Follow, and next time we dig.",
      "button": "Follow",
      "shots": [ { "image_prompt": "a half-buried treasure chest on a sunset beach, gold coins spilling, palm trees",
                   "shot_kind": "closing" } ] }
  ] }
```

Rules (enforced by src/keou-contract.ts on the server and by worker/keou/contract.py in the engine):

- `kleo_style` cartoon | realistic ⇔ `style` "picture". (cyber keeps the Keou styles cinema/editorial/…; stickman
  keeps "stickman".) A cartoon/realistic storyboard with style "cinema" is rejected with a message that names "picture".
- Scenes of kind `cinema` and `closing` only. Last scene is a `closing`. Scene ids: unique slugs `[a-z0-9-]{1,50}`,
  and **must not contain `-s` followed by digits at the end** (reserved for shot ids).
- `shots`: required. 1–4 on a cinema scene, 1–2 on a closing. `beats` are **forbidden** in style picture.
  A scene-level `image_prompt` (old format) is accepted as shorthand and normalised to `shots: [{image_prompt}]`
  by the server validator before the storyboard is stored (the engine never sees scene-level image_prompt).
- Shot fields: `image_prompt` (required, 2–240 chars, no text/logos in the picture), `shot_kind` (one of the ten
  story kinds of §1a — what the shot is FOR; optional today, expected on every new shot), `caption` (≤40 chars, big
  words on that shot; optional), `hl` (≤20, one word of the caption to colour; optional), `at` (≤24 chars taken from
  the scene voice: the shot cuts when those words are spoken; optional, never on the first shot), `motion`
  ("in" | "out" | "left" | "right"; **deprecated**, see §1a).
  (In the example above: a `hook` is a PUSH and the `action` after it is a LATERAL, so the pair already obeys
  sequencing rule 4 of §1a — two shots of the same move class may not follow each other.)
- The planner and the client model write `shot_kind` and **never write camera language by hand**: no "zoom", no "pan",
  no "dolly" anywhere in a storyboard. The camera is chosen by the preset table, not by the author.
- A shot's `at` is checked by `quotesVoice` (src/keou-contract.ts) on **two** counts, both required (a cinema beat's
  `at`, in the cyber style, is still the older substring-only test):
  it must be a case-insensitive **substring** of that scene's `voice` (punctuation and spacing included) **and** it
  must line up on **whole words** — an unbroken run of the spoken tokens. So "swam back" passes against "…boy swam
  back to shore", while the fragment "wam bac" fails the word check and "1720 Captain" (from "In 1720, Captain Mara")
  fails the substring check because it jumps a comma. Neither test implies the other, which is why both run.
- Scene fields kept from cinema: `chapter` (≤32, optional), `accent` (green | cyan | red | amber), `title` (≤90),
  `hl` (≤24), `voice` (≤350), `hold` (0.15–3). Closing adds `button` (≤24, optional; default "Subscribe").
- Everything else in the storyboard (voices per language, speed, music, duration, forbidden fields such as
  scene.image or top-level id/script_file) stays as today.

## 1a. Shot grammar (what a shot is FOR, and the camera that follows from it)

A shot carries a **story kind**, never a camera move. One preset table turns the kind into everything the camera
needs. It is written twice — `src/shot-grammar.ts` for the server and its Python twin for the worker — and a test
proves the two are identical, field for field, so the planner and the renderer can never disagree.
worker/keou/engine/picture.js carries the same ten kinds with the same moves and the same strengths, and
test/engine-picture.test.mjs fails when the engine and the table below drift apart.

Each preset holds: the **camera move**, **min** and **max duration**, **motion strength** (0–1), a **prompt suffix** in
the vendor dialect *with explicit negatives*, a **text anchor** (where words may sit without fighting the move), and an
unused **`trajectory`** field reserved for real camera conditioning in the generated-motion phase.

| `shot_kind` | what it is for | camera move | class | duration | strength | Ken Burns today (at that strength) |
|---|---|---|---|---|---|---|
| `hook` | the first second: grab, do not explain | `crash_zoom_in` | PUSH | 1.6–2.2 s | 0.85 | zoom 1.00 → 1.15, front-loaded |
| `establish` | where we are | `crane_down` | VERTICAL | 3.5–4.5 s | 0.35 | a steady 1.10 crop, the picture drifts down |
| `face` | a person, held long enough to read | `push_in` | PUSH | 2.5–3.5 s | 0.25 | zoom 1.00 → 1.025, barely there |
| `detail` | one object, one fact | `track_right` | LATERAL | 2.0–3.0 s | 0.30 | a steady 1.06 crop, drifts right |
| `detail_orbit` | the same object, given weight | `orbit_left` | LATERAL | 2.5–3.5 s | 0.45 | drifts left inside a 1.08 crop while zooming to 1.06 |
| `action` | something happening, followed | `track_alongside` | LATERAL | 2.0–3.0 s | 0.55 | a steady 1.10 crop, a longer drift right |
| `reveal` | the thing was bigger than you thought | `pull_out` | PUSH | 2.8–3.8 s | 0.40 | zoom 1.04 → 1.00 |
| `tension` | something is wrong | `push_in_dutch` | PUSH | 2.2–3.0 s | 0.60 | zoom 1.01 → 1.08 with a slight lean (the roll waits for generated motion) |
| `closing` | the last breath before the button | `pull_out` | PUSH | 3.0–4.0 s | 0.15 | zoom 1.015 → 1.00 |
| `static_forced` | the picture cannot survive a move | `static_hold` | STILL | 2.0–3.0 s | 0.00 | nothing moves, not even the 3 % cut punch |

**Perche' i ritagli sono piu' larghi di prima (11 settembre 2026).** `kenBurns` limita la corsa all'eccedenza che
lo zoom lascia: `pan = min(over, |t|/2)`. Con una sorgente che ha quasi le stesse proporzioni del fotogramma
quell'eccedenza vale circa `(hold + z)/2`, quindi **serve `hold >= |dx|`** o la corsa viene tagliata a meta'.
Misurato: `track_left/right` consegnava il 67% della corsa che chiede, `crane_down` e `track_alongside` il 50%,
`orbit_left` il 38%, `push_in_dutch` il 20%. Il commento sopra la tabella diceva gia' a cosa serve `hold` -- il
ritaglio che un movimento ha bisogno per avere dove andare -- ma i numeri non lo mantenevano. Il prezzo di
alzarli e' un'inquadratura piu' stretta sull'immagine, che e' il compromesso che il cinema fa da sempre per avere
una camera che si muove.
- **Durations** are multiplied by **0.7** and capped at **3.0 s** for 9:16.
- **Universal negative**, appended to every shot in the vendor dialect:
  `no morphing, no extra fingers, no warping faces, no floating objects, no camera shake beyond the specified move, no zoom, no text, no watermark, no logo`.
- Every suffix also names what the move is **not**: a `push_in` says "NOT a dolly out, NOT a pull-back", a `pull_out`
  says "NOT a push-in", and so on. A move stated only in the positive comes back reversed often enough to matter.

### The `static_forced` routing rule

`static_forced` is a **routing rule, not a taste**. The planner forces it, whatever the shot was going to be, whenever
the `image_prompt` implies any of: **visible hands doing something**, **a crowd**, **legible signage**, **a mechanism
with moving parts**, or **two people interacting**. Those four categories break under motion — fingers multiply, faces
in a crowd melt, lettering turns to soup, gears slide through each other — so the shot holds still instead.

### Sequencing rules (the validator **fails**, it does not warn)

1. **One move per shot**, never a list.
2. No shot longer than **4.0 s** when a person is implied, or **5.0 s** for anything at all.
3. At most **2 loud moves** per 40 s (`crash_zoom_in`, `whip_pan`, `push_in_dutch`, any orbit), and **never adjacent**.
4. Never two consecutive shots of the same **move class** (PUSH / LATERAL / VERTICAL / STILL).
5. Never two consecutive shots at the **same scale on the same subject**.
6. **Screen direction stays consistent inside a scene**: once a scene tracks right, it does not track left.

### `motion` is deprecated

The old `motion` field ("in" | "out" | "left" | "right") still renders, so storyboards written before the grammar keep
working: `in` → `push_in`, `out` → `pull_out`, `left` → `track_left`, `right` → `track_right`, each at full strength.
`shot_kind` always wins over it. With neither field the engine still falls back to the in/out/left/right rotation by
shot index — that fallback is deprecated too, and is exactly the arbitrary movement the grammar exists to end.

## 2. Pictures: ids, files, caps

- Every shot is one picture. Picture id = `<sceneId>-s<n>` with n = 1-based shot index (`01-hook-s1`, `01-hook-s2`).
  File in the project: `img/<pictureId>.png` (or .jpg when the server stored a JPEG).
- `pictureScenes(sb)` (src/keou-contract.ts) returns the flattened list `[{ id, image_prompt }]` in scene → shot order.
  The images endpoint (`POST /internal/jobs/:id/images`) keys its `images` and `missing` maps by picture id.
- Caps: `MAX_PICTURES(duration)` (24 when duration_s ≤ 90, else 48; src/images.ts) bounds what the SERVER considers,
  not the video: shots past it are simply never offered to Workers AI, and the GPU worker still draws them, because the
  worker builds its own missing list from the storyboard. The server draws at most `IMAGE_SERVER_MAX` (env, default 10) pictures with Workers AI per job,
  spread over the list like today (pickImageScenes), and lists the others as `missing`; the worker draws the missing
  ones on the GPU (worker/kleo_pictures.py, policy KLEO_PICTURES=auto). **`IMAGE_SERVER_MAX=0` is honoured and turns
  server-side drawing off entirely**: no Workers AI call at all, every picture is left to the GPU worker (`int()`
  keeps the configured 0 — a `|| DEFAULT_SERVER_MAX` would have turned it back into 10). Nothing is fatal: a shot
  without a picture renders as a flat accent-coloured gradient.
- The worker attaches `shot.image = "img/<pictureId>.<ext>"` on success, sets `scene.image` to the first shot's image
  (kept for compatibility, unused by the picture style), strips every `image_prompt` (scene and shot level) and the
  top-level `kleo_style`, and writes `look: "cartoon" | "realistic"` at the top level of project.json so the engine
  knows which typography to use.

## 3. Engine project (what worker/keou/contract.py validates)

- `STYLES` gains `picture`. `look` (cartoon | realistic) is required when style is picture and forbidden otherwise.
- Style picture: kinds cinema/closing only; `shots` 1–4 (closing 1–2), each `{image?: local asset under img/,
  shot_kind?: one of the ten kinds of §1a, caption?, hl?, at?, motion?: deprecated}`; `beats` forbidden;
  scene.image optional (local asset rules as today). `shot_kind` survives the worker's strip pass (unlike
  `image_prompt`): the engine needs it to know what the camera is doing.
- Engine assets: two fonts downloaded at image build time by worker/Dockerfile.keou (GitHub Actions, never the
  owner's PC) from the google/fonts repository (OFL): `engine/assets/cartoon.ttf` = Baloo 2 variable
  (ofl/baloo2/Baloo2[wght].ttf) and `engine/assets/real.ttf` = Oswald variable (ofl/oswald/Oswald[wght].ttf).
  film.html declares `@font-face` KleoCartoon (weight 400–800) and KleoReal (weight 200–700); every use falls back to
  Manrope when the file is missing (local dev). Licences noted in THIRD-PARTY-NOTICES.md.

## 4. Rendering (worker/keou/engine/picture.js, wired in film.js / film.html exactly like cinema.js)

- Layout: no HUD, no corner brackets, no red dot, no progress bar, no icons, no beats. Safe areas (portrait):
  top 180 px, bottom 420 px; landscape: top 90, bottom 150.
- Shot timing: shot n starts at the `at` word (same word-sync as cinema beats; copy beatStarts) or at an even split of
  the scene; the last shot holds to the scene end. Between shots: a 0.35 s crossfade (previous shot drawn beneath,
  fading out) plus a 3 % scale punch on the new shot. Hard cut between scenes.
- Picture: cover-fit; the camera comes from the shot grammar (§1a), never from the shot's position. `shot_kind` is
  resolved to one move and one strength (`shotGrammar`), and the move is played as Ken Burns (`kenBurns`): each move
  carries a zoom pair and a drift, `zoom = 1 + z * strength`, `drift = travel * strength` as a share of the width or
  the height, the drift always clamped to the overflow the zoom leaves on that side so no edge of the frame is ever
  empty. `crash_zoom_in` is front-loaded (most of its travel lands at once), every other move is eased. Direction
  names describe how the **picture** travels across the frame. `static_hold` does not move and does not take the 3 %
  cut punch. Deprecated `motion` maps to `push_in` / `pull_out` / `track_left` / `track_right` at strength 1, which is
  bit-for-bit the old behaviour (`in` 1.00→1.10, `out` 1.10→1.00, `left`/`right` pan ≤ 6 % with zoom 1.04), and with
  neither field the old index rotation still applies. Every frame stays a pure function of (shot, index, time): the
  renderer splits one video across parallel workers, so nothing here may consult a clock, a random source or a hash.
  Then dim 0.12, bottom gradient 0.65 (for the subtitles), a top
  gradient 0.35 only while a chapter or a caption is on screen, light vignette 0.35. Missing picture: vertical
  gradient from the scene accent (dark) to near-black.
- Chapter label (optional): cartoon = rounded pill filled with the accent, dark text, KleoCartoon 700 30 px, top-left
  inside the safe area, pops in; realistic = KleoReal 500 26 px uppercase, letter-spacing 4 px, white 75 %, with a
  3 px accent bar on the left, fades in.
- Caption (shot.caption; when the first shot has none, the scene `title` is used on shot 1): fitted to 84 % of the
  width, at most 3 lines, centred in the upper third (portrait y ≈ 36 % of H; landscape: lower-left above the
  subtitles). cartoon = KleoCartoon 800, white with a 10 px #111 stroke and a soft shadow, `hl` words in #FFD23F,
  −2° rotation, pop-in (scale 1.15→1 in 0.18 s). realistic = KleoReal 700 uppercase, letter-spacing 4 %, white with a
  dark shadow, `hl` word in the accent, an accent underline growing 0→100 % in 0.3 s, fade+rise in 0.25 s.
  Never drawn over the subtitles.
- Subtitles (karaoke): from `s.captions` groups and `s.words` (word-level timing from the timeline). cartoon =
  KleoCartoon 800 58 px, white with an 8 px #111 stroke, the word being spoken in #FFD23F at scale 1.12; realistic =
  KleoReal 600 52 px, white with a dark shadow, the spoken word in the accent. Max 2 lines, centred at
  y = H − 500 (portrait) / H − 150 (landscape). If `s.words` is absent, highlight the key word like cinema does.
- Closing: last shot picture + the scene `title` drawn as a caption in the middle + a button pill
  (`s.button` or "Subscribe"): cartoon = #FFD23F pill, dark KleoCartoon 800 text, bounces in; realistic = white
  outlined pill, KleoReal 600 text, fades in. A small brand tag (project.brand) at the bottom, above the safe area.
- Background: near-black #0b0b0f. Text colours: white #ffffff, dark #111111, accent from `COL` (green #00ff88,
  cyan #39d5ff, red #ff3b5c, amber #ffb020 — same table as cinema.js).
- `window.KEOU_PICTURE = { attach(api), background, chrome, progress, scene, subtitle }` with the same signatures as
  KEOU_CINEMA; film.js dispatches on `project.style === 'picture'` wherever it dispatches on 'cinema'; `themes.picture`
  exists; init preloads `s.image` and every `shot.image`.

## 5. Guide, planner, templates (server)

- `kleo_storyboard_guide` describes shots for cartoon/realistic (the counts of §1: 1–4 on a cinema scene, 1–2 on a
  closing, with 2–3 the usual rhythm and 1 the usual closing; the same characters described the same way in every
  prompt; captions of 2–5 strong words; `at` an unbroken, whole-word run of that scene's voice; no icons, no beats),
  gives one full example in each of the two looks, and keeps the cinema/stickman documentation for cyber. The counts
  are interpolated from `SHOTS_PER_SCENE` (src/keou-contract.ts) rather than written out, so the guide cannot drift
  from the validator; test/keou-contract.test.mjs fails on a hard-coded range.
- `kleo_create_video` `style` descriptions say what the viewer sees (cartoon: illustrated shots drawn for the topic —
  pirates get beaches and ships, space gets rockets and stations; realistic: cinematic photo shots; cyber: the dark
  motion-design look with glowing icons for tech topics; stickman: hand-drawn stickman story).
- The Workers AI planner (src/storyboard.ts) produces the same format (style "picture", shots) for cartoon/realistic.
- Fixtures: test/fixtures/cartoon-pirates.json and a new test/fixtures/realistic-space.json in the shots format;
  worker/keou/examples/cartoon-pirates/project.json in the engine format (look, shots with image paths).

## 6. What must never happen

- No local rendering, no Playwright, no podman on the owner's machine: unit tests with fakes only; the visual check is
  a real job on Vast.ai (test/vast-e2e.mjs) after the image rebuild on GitHub.
- No tech icon, HUD element or beat of the cinema style may appear in a picture-style video.

## 7. The pictures speak English, and the light stays out of the animation (20 September 2026)

Two findings from job `gt_ad2musq5` (19 September, an Italian animatic about a thin blonde pastry chef in a lilac apron, delivered with three different women in red aprons):

1. **Every picture prompt reaches an English-only text encoder.** Every model the GPU draws with (Dreamshaper-8, Realistic Vision, DreamShaper XL Turbo) reads its prompt through CLIP, and "capelli biondi corti e raccolti, grembiule lilla" is noise to it. So the `image_prompt` of every shot and the picture fields of the direction (`world`, every cast `name` and `look`, `objects`, `forbidden` — the last one becomes the negative prompt) are written in English whatever the film is narrated in; `subject`, `goal`, `audience`, `tone`, `must_keep`, the narration, titles and chapters stay in the film's language. The planner asks for it in the system, direction and chunk prompts, and then makes sure of it: one call at temperature 0 translates the direction's picture fields on every non-English film (`englishFieldsPrompt`, `applyEnglishFields`), and one call translates whatever prompts the chunks still wrote in the narration's language (`englishPromptsPrompt`), before the final assembly, so the routing rule and the forbidden-term check run on English text. `notEnglish()` in `src/direction.ts` is the detector (function words of Italian and French, two hits in one sentence); the validator reports a non-English prompt or cast look as a **warning** (`ValidateResult.warnings`), which the planner feeds back once and `kleo_create_video` refuses in words for a storyboard an assistant wrote. The cast NAME is translated too, because `castFor()` looks for it inside the (English) prompts.
2. **The section's accent is not a light in a drawn film.** `ACCENT_LIGHT` ("a single warm red light source") is appended for the photographic looks only; on the turbo SDXL model of the animation look it is a colour cast — a red kitchen, a red apron, a red sauce for a pastel story. `lightsPictures(look)` / `lights_pictures(style)` decide, on both sides. And on the GPU the cast's look now goes **in front** of the author's sentence (`cast_for()` → `full_prompt(lead=…)`): what comes first weighs most, and a face that changes is what a viewer notices.

The rhythm rules of the shot grammar (move class alternation, scale repetition, screen direction, loud budget) became warnings the same day: refusing on them produced storyboards with no legal answer (two forced static holds in a row), and two of this user's jobs died in planning on exactly that.

## 8. The section's accent leaves every picture (22 September 2026)

The first animatic with music and subtitles (`gt_hxed87em`, realistic look on RealVisXL V5) showed the colour law of §7 on
the photographic look too: red graphite dust in the "red" section, a glowing green pencil line and a green lamp in the
"green" one, against a treatment whose palette was slate blue, brass and cream. RealVisXL is an SDXL model like the
animation's turbo one, and "a single cool green light source" is a colour cast on it as well. `lightsPictures()` /
`lights_pictures()` now answer false for every look: the accent lives on the layer (`hud.js`) and nowhere else; the
pictures follow the treatment's visual language. Same film, second finding: the only character was "a middle-aged
hand and forearm … no visible face", and a man's face appeared in the sixth picture — a diffusion model reads "no
visible face" on the positive side as "face". `negatedTerms()` / `negated_terms()` move the clauses a cast look or
the world denies ("no visible face", "never a logo", "without a screen") to the negative prompt, with "face,
portrait" added whenever a face is what is denied.
