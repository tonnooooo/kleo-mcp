# Kleo "picture" style — specification (2026-09-10)

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
          "caption": "SHE NEVER CAME BACK", "hl": "NEVER" },
        { "image_prompt": "the same pirate captain walking away along the shoreline at dusk, footprints in the sand",
          "at": "never came back", "motion": "left" }
      ] },
    { "id": "05-closing", "kind": "closing", "accent": "cyan",
      "title": "Follow for part two", "voice": "Is it still there? Follow, and next time we dig.",
      "button": "Follow",
      "shots": [ { "image_prompt": "a half-buried treasure chest on a sunset beach, gold coins spilling, palm trees" } ] }
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
- Shot fields: `image_prompt` (required, 2–240 chars, no text/logos in the picture), `caption` (≤40 chars, big words on
  that shot; optional), `hl` (≤20, one word of the caption to colour; optional), `at` (≤24 chars quoted verbatim from
  the scene voice: the shot cuts when that word is spoken; optional, never on the first shot), `motion`
  ("in" | "out" | "left" | "right"; optional, the engine alternates when absent).
- Scene fields kept from cinema: `chapter` (≤32, optional), `accent` (green | cyan | red | amber), `title` (≤90),
  `hl` (≤24), `voice` (≤350), `hold` (0.15–3). Closing adds `button` (≤24, optional; default "Subscribe").
- Everything else in the storyboard (voices per language, speed, music, duration, forbidden fields such as
  scene.image or top-level id/script_file) stays as today.

## 2. Pictures: ids, files, caps

- Every shot is one picture. Picture id = `<sceneId>-s<n>` with n = 1-based shot index (`01-hook-s1`, `01-hook-s2`).
  File in the project: `img/<pictureId>.png` (or .jpg when the server stored a JPEG).
- `pictureScenes(sb)` (src/keou-contract.ts) returns the flattened list `[{ id, image_prompt }]` in scene → shot order.
  The images endpoint (`POST /internal/jobs/:id/images`) keys its `images` and `missing` maps by picture id.
- Caps: total pictures per video = 24 when duration_s ≤ 90, else 48 (constant `MAX_PICTURES(duration)` in
  src/images.ts). The server draws at most `IMAGE_SERVER_MAX` (env, default 10) pictures with Workers AI per job,
  spread over the list like today (pickImageScenes), and lists the others as `missing`; the worker draws the missing
  ones on the GPU (worker/kleo_pictures.py, policy KLEO_PICTURES=auto). Nothing is fatal: a shot without a picture
  renders as a flat accent-coloured gradient.
- The worker attaches `shot.image = "img/<pictureId>.<ext>"` on success, sets `scene.image` to the first shot's image
  (kept for compatibility, unused by the picture style), strips every `image_prompt` (scene and shot level) and the
  top-level `kleo_style`, and writes `look: "cartoon" | "realistic"` at the top level of project.json so the engine
  knows which typography to use.

## 3. Engine project (what worker/keou/contract.py validates)

- `STYLES` gains `picture`. `look` (cartoon | realistic) is required when style is picture and forbidden otherwise.
- Style picture: kinds cinema/closing only; `shots` 1–4 (closing 1–2), each `{image?: local asset under img/,
  caption?, hl?, at?, motion?}`; `beats` forbidden; scene.image optional (local asset rules as today).
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
- Picture: cover-fit; Ken Burns per shot: `in` 1.00→1.10, `out` 1.10→1.00, `left`/`right` pan ≤ 6 % with zoom 1.04;
  default alternates in/out/left/right by shot index. Then dim 0.12, bottom gradient 0.65 (for the subtitles), a top
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

- `kleo_storyboard_guide` describes shots for cartoon/realistic (2–4 per scene, 1 for the closing; the same characters
  described the same way in every prompt; captions of 2–5 strong words; `at` quoted from the voice; no icons, no
  beats), gives one full example in each of the two looks, and keeps the cinema/stickman documentation for cyber.
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
