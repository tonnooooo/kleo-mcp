# Kleo "explainer" style — specification (2026-09-11)

Hand-drawn white marker line art on pure black. One spoken phrase, one drawing, and the drawing is
literally what the words say. The only text on screen is the caption, burned in from the narration,
ALL CAPS, one word lit green as it is spoken. No title card, no logo, no end card, no call to action:
**the film ends on its last drawing.**

Kleo style `explainer` · Keou engine style `sketch` · scene kind `sketch`.
Two templates, because a Short and a long film are not the same film at two lengths:

| template | frame | length | scenes | line | credits |
|---|---|---|---|---|---|
| `explainer-short` | 9:16 | 20–60 s (default 45) | 5–8 | 8–14 words | 1 |
| `explainer-long` | 16:9 | 180–480 s (default 300) | 18–38 | 12–20 words | 3 |

Everything below is enforced in **two** places, and a rule that lives in one and not the other is a job
that passes the free gate, boots a GPU, spends a credit and dies: `src/keou-contract.ts` (before a GPU
is rented) and `worker/keou/contract.py` (on the rented machine). `test/explainer-contract.test.mjs`
parses the Python literals and fails the build when the two disagree.

## 1. What the author writes

```json
{ "schema_version": 1, "editorial_status": "ready", "title": "Your hotel door isn't locked",
  "kleo_style": "explainer", "style": "sketch",
  "format": "9:16", "language": "en", "voice": "am_michael", "speed": 1.22, "music": "none",
  "lead": 0.15, "loudness": -14.5, "max_duration": 75,
  "scenes": [
    { "id": "01-card", "kind": "sketch", "accent": "red",
      "voice": "This looks like a normal hotel key card. It isn't.",
      "shot": { "zoom": [1.0, 1.42], "focus": [660, 900] },
      "enter": "cut", "exit": "flare", "hold": 0.05,
      "art": [
        { "name": "keycard", "x": 540, "y": 880, "size": 1.85, "drawn": true, "until": "a normal" },
        { "name": "hand", "x": 506, "y": 938, "size": 1.25, "at": "a normal", "motion": "turn" }
      ] }
  ] }
```

There is **no closing scene** and scene titles are optional — the caption is the only text, so a title
would be a line nobody ever sees.

### The shot
`zoom` is `[start, end]` and **`end` must be greater than `start`**: the camera never stops pushing in.
This is not taste. `qa.py` fails a master that holds a second of identical frames, and a still camera
over a still drawing produces exactly that. `focus` is the point it pushes toward, **in the frame's own
pixels** — 0–1080 by 0–1920 in portrait, 0–1920 by 0–1080 in landscape. A storyboard authored against
one frame and rendered in the other puts every drawing off the page, which is why
`kleo_storyboard_guide` takes a `format` and prints that frame's numbers.

### The art
1–8 elements per scene, drawn in the order written.

- `at` / `until` — **when** a drawing arrives and leaves. Either a fraction of the scene, or 1–4 words
  **copied exactly from that scene's own `voice`**. The engine matches them on a folded character
  stream, so apostrophes and case do not matter but the words must really be spoken; a cue that matches
  nothing **fails the render** rather than silently sliding to zero, which is how a reveal used to be
  burned. Give one drawing an `until` and its successor an `at` on the same words: they overlap by
  0.26 s, so the frame is never empty.
- `drawn: true` — it is already on the page at the first frame. The first drawing of the film needs it,
  and so does the first drawing after a `flare`, or the video opens on black.
- `x`, `y`, `size`, `motion` (`turn slide rise tap shake walk pulse drift`), `motion_over`.
  **The caption owns the bottom 22 % of the frame.** `SKETCH_DROP` records how far each drawing really
  reaches below its own centre — measured by `scripts/sketch-extent.mjs`, which runs every builder
  against a context that records where it puts ink — and both validators refuse a drawing whose body
  would sit under the caption band. A `tag` is 53 pixels tall and a `figure` is 246: one number for
  both would be either useless or wrong. The planner lifts an offending drawing rather than failing it.
- Per-drawing extras: `tint` (the whole drawing in an accent), `led`/`beam`/`chip` (an accent on one
  part of it), `mood` on `face`, `count` 1–12 on `crowd`/`footprints`/`blank`/`chain`, `text` ≤24 on
  `tag` (the only drawing that carries words), `open`/`open_to`/`swing_over` on `door` and `lock`,
  `reach` on `figure`, and the flags `no sweat xray flash flip leader`.

### The colour law
One accent per scene, **never two in a frame**: `red` the hidden threat · `blue` the attacker's radio ·
`green` the light that says everything is fine · `yellow` scale and money · `white` no accent. The
direction (`src/direction.ts`) owns which stretch of the film wears which colour; the style owns the
palette, and `sketchAccent()` maps the direction's cinema accents onto these five.

### The alphabet
Fifty-nine drawings. The first nineteen are the hotel film's own world; the rest are what every other
subject needs, because one drawing per phrase only works when the phrase has a drawing.

    people      figure face crowd intruder handshake hand robot
    the body    eye brain fingerprint
    machines    phone laptop server router camera chip usb car satellite writer
    security    lock key keycard reader shield bug signal footprints crowbar
    data        code folder cloud graph chart envelope chain gear scale
    places      door room corridor hotels city globe tree
    quantities  coin clock calendar blank box
    ideas       question warning bulb magnifier book rocket bell suitcase tag

`test/sketch-engine.test.mjs` executes every one of them against a counting stub of the 2D context: it
proves each draws something and leaves the canvas exactly as it found it, because a builder that
forgets `restore()` corrupts every later drawing and only shows up on a paid GPU.

## 2. The rules the planner enforces (`src/explainer-plan.ts`)

A hook and "keep it entertaining" written into a prompt are ignored by every model that has ever read
them, because nothing measures whether they happened. Here each is a function over the finished
storyboard. What arithmetic can fix is fixed (`repairExplainer`); the rest comes back as `feedback` on
the next attempt, in the words the model has to act on.

Seventeen of them. The last four exist because three independent readers were asked to score eight films
that had already passed the first thirteen, and every complaint they made was about something no rule
looked at: "the script says the same sentence four different ways", "lock and key repeat four times and
nothing draws the mechanism", "line 1 opens a real gap and line 2 fills it with a platitude". The first
thirteen measure FORM. A film can satisfy all of it and be four sentences over one picture.

| rule | what it measures |
|---|---|
| `hook-shape` | the first line speaks to the viewer **and** contradicts, asks, or counts |
| `hook-length` | ≤14 words (Short) / ≤20 (long) — a hook that lands at second four has not landed |
| `hook-drawn` | something is on the page at frame zero — **repaired** |
| `hook-object` | the opening drawing is the thing itself, not a symbol for it |
| `art-count` | ≥2 drawings per scene |
| `art-pace` | ≤2.0 s per drawing (Short) / ≤2.6 s (long) |
| `cue-spread` | at least one drawing lands in the **second half** of its line — **repaired** |
| `motion` | something moves other than the camera |
| `variety` | no drawing opens three scenes running |
| `turn` | a reversal in the first third: *but*, *except*, *it turns out* |
| `payoff` | the last line asks a question or hands the viewer one thing to do |
| `word-window` | every line inside the template's window |
| `colour` | ≥2 accents (Short) / ≥3 (long) |
| `draws-what-it-says` | every scene draws at least one thing its own line names — the founding rule, made mechanical |
| `echo` | no line repeats what an earlier line already said |
| `promise` | a word the hook named comes back after the halfway point |
| `variety` (2/2) | no drawing opens two scenes running; no film drawn with fewer drawings than it has scenes |

`draws-what-it-says` reads `SKETCH_WORDS`: for each of the fifty-nine drawings, the words a narrator would
actually SAY that mean "draw this", in all three languages — 2,878 of them, drafted family by family and
then repaired against nine real films. A word may belong to two drawings when both are right answers, so
the check can only be kinder, never wrong; function words ("when", "who", "now", "chi", "quando") are
refused, because a rule that matches every sentence measures nothing.

**The shipped film is the arbiter of every rule here.** `worker/keou/examples/explainer-hotel` passes all
seventeen with nothing broken. That is the only thing that separates a rule which finds a defect from a
rule which enforces a preference — and it is what caught two rules of mine that were wrong: one could not
see that "hotel" and "hotels" are the same word, and one called two `figure` drawings for "two people" a
mistake.

`test/explainer-planner.test.mjs` runs twenty-four deliberately unlike prompts — bread, volcanoes,
mortgages, aqueducts — as Short and long, in three languages, against a model that answers badly on
purpose. It asserts each rule fires on a film that breaks it and on nothing else, and that the
repairable ones never survive into a finished film.
`scripts/explainer-plan-sweep.mjs` runs the same list against real Workers AI and prints which rule
failed how often, which is how you tell a rule that needs a better prompt from one that needs a repair.

## 3. Calibration

Measured frame by frame against the channel's reference Short, and unchanged since:

- caption baseline at **81.8 %** of frame height, cap-height **2.6 %** of it, tracking 1.5,
  max width 88 %, 1–4 words per block, ~0.25 s per word;
- ALL CAPS, white, the live word `#16FC2B`, **no outline, no shadow, no box, no pop**;
- accents `#EC1F20` red · `#15B3F6` blue · `#16FC2B` green · `#EBC705` yellow;
- `hold` floor 0.05 s — the explainer does not pause, it ends on the word and cuts;
- two-pass loudness to −14.5 LUFS, `qa.py` black-frame threshold 0.998 because the frame is 90 % black.

Both ratios, so 16:9 keeps the same reading rhythm on a wider, shorter frame.

## 4. How a request reaches this look, and why it is the only way

**The template chooses it. Nothing else can.**

Twenty-seven prompts written blind by two sessions that had not read the vocabularies scored **26 %** on
Kleo's look picker. One of them settled a design question rather than a classification one: *"why boiling
water sometimes freezes before cold water"* — a request with no technical word in it — comes out
`cartoon`, because the drawn look is only ever reached through a word list borrowed from the cyber one.

That is not a list to widen. What separates this look from `cyber` is **the shape of the answer, not the
topic**: cyber wants something to diagram — a flow, a comparison, numbers — and the explainer wants one
idea taken apart, where every phrase has a literal object and the viewer ends up having changed a belief.
Three paired prompts proved it from the other side: identical vocabulary, opposite correct answers, and
the picker told them apart *in the wrong direction*. "Cinque attacchi informatici più costosi **della
storia**" alone breaks it, because the Italian word carries both *story* and *history* and a list cannot
know which was meant.

So the look is named, never guessed, and `test/templates-narrative.test.mjs` guards the single point of
failure that creates: both templates are driven with prompts deliberately free of anything a word list
could catch, with no style named, and must still come out `explainer` / `sketch`. Without that guard, a
user who asked for the drawn Short would silently get cartoon pictures — the job validates, the GPU is
rented, and the video comes back in the wrong style with nothing anywhere reporting an error.

A caller who names a style still wins over the template, as everywhere else.

## 5. What the real model does, and the two things that had to change for it

Everything above is checkable offline. What is not checkable offline is whether a real model, handed
these rules, writes a film. Run `scripts/explainer-make.mjs "<subject>" out.json` to find out for one
subject: it calls the same Workers AI the deployed worker calls, and prints the rule report beside the
storyboard so the two are read together.

The first real run produced a contract-valid storyboard and a bad film, and the two causes were both in
the planner, not in the model:

**The rules were measured and then overruled.** The chunk loop accepted a contract-valid answer from the
second attempt onward, whatever `checkExplainer` said — so a hook that was not a hook and lines of three
words shipped with the violations recorded in the history and ignored. A rule that is checked and then
overridden is a rule the model learns to ignore. The explainer now spends all three attempts before it
will accept a chunk with rule violations; every other look still takes the second answer, because its
retry budget is better spent on real errors.

**The scene count starved the lines.** The planner took the midpoint of the scene range, which put every
line at the very bottom of the 8–14 word window with nowhere to go but under it: ten scenes for
ninety-two words, and the model answered with lines of three and four words. A model one word short of
the bottom of a window writes a *caption*, not a sentence — which is exactly the mistake this look
invites, since the caption on screen is derived from the line. The explainer now plans at the **fewest**
scenes its budget allows, which hands each line the top of the window instead, and the rules block says
so out loud with a good line and a refused line side by side, counted.

## 6. The pass that is not optional

Four defects in this style were found by watching a rendered film, and none of them failed a test:

| what it looked like | what it was |
|---|---|
| a hand read as a rock | three short strokes inside a silhouette instead of four fingers reaching its edge |
| a chain read as a row of eggs | links too round, rotated too little, not overlapping |
| a black hole opened for a third of a second | the opaque base of a drawing painted at full strength before its own outline existed |
| the caption was read through a face | nothing anywhere said the caption owns the bottom of the frame |

The pass costs a minute: extract one frame from the middle of every scene of a finished master and look
at them. `ffmpeg -ss <t> -i master.mp4 -frames:v 1 frame.png`, with `<t>` read from `build/timeline.json`.
Do it before calling a render good. The suite proves that what somebody thought to check still works; it
says nothing about what nobody thought of.

## 7. One repair that was measured and then not built

Two drawings landing on top of each other is the last visible defect class in this look — a lock over a
crowd reads as a lock standing on a row of little legs, because the nearer drawing paints an opaque black
body over the other. It looks like something a repair could fix: `scripts/sketch-extent.mjs` now measures
the full bounding box of all fifty-nine drawings, so overlap is arithmetic.

It was not built, because the discriminator does not exist. In the film the channel shipped, `hand` at
(506, 938) and `keycard` at (700, 900) **overlap by 75 % of the hand's height** — deliberately, because a
hand holding a card is the whole point of that shot. Every candidate signal that would separate that from
the accidental case was tried against it and failed: overlap fraction, size ratio, whether the nearer
drawing has an opaque body. Any rule strict enough to catch the lock refuses the reference.

So the numbers go in the guide instead, where they help the author decide, and nothing refuses anything:
a drawing is about 420 × 383 at size 1, so two want ~450 pixels between centres; the big ones
(`crowbar` 949 × 840, `door` 761 tall, `bell` 680 × 684) want more, the small ones (`tag` 178 × 107)
far less. Written here so the attempt is not repeated: the measurement exists, the rule cannot.
