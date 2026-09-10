# Cinema style — the channel's reference look, as a reusable template

`"style": "cinema"` rebuilds the look of the channel's reference film (*AI Just Made
Hacking Ridiculously Faster*, 3840×2160/60): full-bleed near-black with drifting light
streaks and corner brackets, a chapter label with a dot ("• 02 THE RELAY"), **one hero
visual per beat** drawn in glowing line art, kinetic typography, a lower title lockup with
a blue bar and the keyword in the chapter's accent, and white captions with **one word in
green**. It works in 16:9 and 9:16 (Shorts safe area: content above y=1470, right 150px free).
No music by default for Shorts (`"music": "none"`); voice speed 1.3 matches the reference
pace of ~2.8 words per second.

## Project

```json
{ "style": "cinema", "format": "9:16", "width": 2160, "fps": 60,
  "voice": "am_michael", "speed": 1.3, "music": "none", "brand": "@TuNaaa0", ... }
```

## Scene (`"kind": "cinema"`)

| Field | Meaning |
|---|---|
| `chapter` (≤32) | label top-left, e.g. `01 HOOK`, `03 THE TEST` |
| `accent` | `green` · `cyan` · `red` · `amber` — colour of the chapter's hero glow, lockup keyword and step boxes |
| `title` / `hl` | lower lockup text and the word to colour; appears from ~35 % of the scene |
| `voice` | the narrated line (captions come from it; the caption keyword is `hl` when present, else the longest meaningful word) |
| `beats` | 1–8 hero visuals played in sequence across the scene. Pace rules built in: every beat is a hard cut with an accent flash (no fades), the last beat holds until the next scene, any beat longer than 1.3 s gets an automatic zoom punch-in (a second one at 2.6 s), and every reveal inside a beat (labels, arrows, typing, bar rise, dialog stagger) is scaled to the beat's length so a 0.8 s shot still lands its payload before the cut |
| `hold` | silence after the line, seconds. Shorts honour it down to 0.15 (the last scene keeps ≥0.4 before the loop); 16:9 keeps the editorial floor of 0.65 / 1.5 |
| `image` (Kleo) | optional local picture (`img/<sceneId>.png`, same asset rules as the image kind). Drawn **full-bleed under the beats**: cover-fit, a slow Ken Burns zoom from 1.0 to 1.08 across the scene, a soft pan whose direction is derived from the scene id, then a dark dim + top/bottom gradients + vignette so the chapter label (switched from muted to pale with a soft shadow), the beats and the captions keep their contrast. Kleo's worker sets this field itself from the scene's `image_prompt`; a missing picture simply falls back to the plain cyber background |

The closing scene (`"kind": "closing"`) draws the CTA beat: red SUBSCRIBE, comment box, toggles; it accepts `image` the same way.

## Beats

| kind | fields | draws |
|---|---|---|
| `icon` | `name`, `fx?` (`lit`, `dead`, `key`, `open`, `drive` = accelerates out of frame right and vanishes, `alarm`, `point`, `think`, `run`), `size?` | one big line icon: coffee · desk · hoodie · keyboard · hand · bug · alarm · shield · radar · car · keyfob · house · amplifier · pouch · lock · timer · check · cross · **figure** (white stick figure, pose = fx) · **thief** (red, with amplifier) · phone · wave · clock. `label?` (≤24) pops in under the icon mid-beat |
| `type` | `text` (≤40), `hl?`, `mono?`, `slam?`, `icon?`, `fx?` | kinetic caps, one word per line, staggered, glow; `slam: true` = instant, overshoot, shake and accent flash (the hook). `icon` draws a picture above the words (slammed with them) so no card is text-only |
| `terminal` | `lines` (1–4, ≤48), `label?`, `enter?` | prompt box, typed lines, ENTER key |
| `steps` | `items` (2–4, ≤14), `lit?` | `01 SCOPE - - 02 MAP` boxes, lit ones glow in the accent |
| `people` | `total`, `lit` (≤12), `label?`, `last?` | row of person icons, `2 / 10 STILL HERE` |
| `bars` | `labels`, `values` (1–4) | rising bars, last one in the accent |
| `timeline` | `labels` (2–4), `icons?` (one per label) | `01 → 02 → 03` nodes with travelling packets; with `icons` each node carries its object above the line |
| `dialog` | `text` (≤32), `count?` (1–5) | stacked `Continue? Y/N` cards |
| `cta` | `label?`, `toggles?` (1–3) | subscribe button + comment box |
| `split` | `items` (2 icon names), `fx?`, `label?` | two icons with an arrow between them: cause → effect |
| `grid` | `items` (2–3 icon names), `label?` | icons appearing left to right, joined by dots |

Everything is an enum or a bounded string validated by `contract.py`; the renderer never
executes, resolves or transmits any of it. Motion is deterministic — the same timestamp
always yields the same frame — and every frame moves (light streaks, glow, packets), so
the kit's frozen-frame QA passes by construction.

## Anchoring beats to words

Every beat may carry `"at": "<words from the voice line>"`. `prepare.py` stores the start
time of every narrated word in the timeline, and the renderer starts that beat about
0.12 s before the first anchored word is spoken; beats without `at` spread evenly
between anchored neighbours. Anchors must quote the scene's own voice text, and a
beat never lasts less than 0.8 s. Without anchors (or in the layout fixture) beats
split the scene into equal slots. `python scripts/beat_dwell.py <project.json>` prints the
resulting dwell table from the built timeline and fails on any shot longer than 1.6 s.

Safe area: the portrait hero box is 780 px wide around x=540 and the punch-in is clamped
per beat kind so nothing drawn crosses x=930 (the Shorts right-hand controls).

Portrait films also get phone-sized captions: at most 5 words / 32 characters per
group, broken at sentence punctuation first; groups too brief to read are merged into
their neighbour. Set `"music": "none"` for a voice-only Short; a closing scene may
carry `beats` instead of the subscribe CTA.

## Authoring rhythm for a Short

1. One narrated line per scene, 8–12 words; ~8 scenes ≈ 45–55 s at speed 1.3.
2. 5–8 beats per scene, each a different visual kind, every one anchored to a word
   (`at`). Hook scene: an object, then the consequence, then a number. Target: no shot
   over ~1.5 s, `hold` 0.2 on every scene, 0.4 on the loop scene.
3. Accent by chapter: red for the threat, green for the fix, cyan for neutral explanation.
4. `hl` = the one word you want green in both the lockup and the captions.

Check with `python kit.py layout <project.json>`; render a single beat at full size with
`node tests/story_still.mjs <layout-preview dir> <seconds> 1080 out.png`.
