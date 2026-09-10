# Project JSON contract

`contract.py` is the executable source of truth. All paths are relative to the containing project directory. Validate before spending money.

## Project fields

| Field | Value |
|---|---|
| schema_version | `1` |
| editorial_status | `ready` to render; use `draft` while preparing |
| id | Lowercase ASCII slug, max 70 characters |
| title | Nonempty, max 120 characters |
| brand | Nonempty, max 28 characters |
| style | `terminal` (cyber default), `editorial`, `technical`, `illustrated` |
| format | `9:16` or `16:9` |
| width | Portrait 540/1080/2160; landscape 960/1920/3840 |
| fps | 30 or 60 |
| language / voice | `en`: af_heart, am_michael, bf_emma; `fr`: ff_siwis |
| speed | 0.8–1.3; default 1 |
| max_duration | 5–1800 seconds; recommended short ceiling 90–100 |
| script_file | Local text file; exact concatenation of scene voice text |
| description / tags | Publication metadata; no upload is performed |
| scenes | 2–240 scene objects; last must be closing |

Only English and French are supported by this release. Other voice/model identifiers are rejected.

## Scene fields

Required: unique slug `id` (max 50), `kind`, nonempty `title` (max 90), and `voice` (max 350). Optional: `eyebrow` ≤40, `detail` ≤110, `source` ≤80, `button` ≤40, `hold` 0.3–3 seconds (default 0.65). Final hold is at least 1.5 seconds in preparation.

| Kind | Additional fields |
|---|---|
| hero | Optional visual: focus/network/cycle/spark/globe/check/growth |
| image | image path; image_credit ≤180 |
| metric | value ≤12; unit ≤45 |
| compare | Exactly 2 items, each ≤42 |
| steps / list | Exactly 3 items, each ≤42 |
| quote | quote ≤120 |
| closing | button or detail, never both |
| cinema / story / closing | Optional `image` (Kleo backdrop): a local picture drawn full-bleed behind the scene with a slow Ken Burns zoom (1.0 → 1.08), a soft pan and a dark gradient/vignette overlay. Same asset rules as the image kind. Any other kind carrying `image` is rejected. In the editorial styles a closing `image` is validated but not drawn |

Image files must live inside the project: .png, .jpg, .jpeg, .webp or .svg. SVG must be self-contained without scripts, event handlers, foreign objects or remote references. Assets copied from an example must be updated if the subject changes.

Inspect the complete example JSON files for practical scene authoring. Do not add unsupported composition names and expect the renderer to infer them. Accepted maximum text length is not a guarantee of aesthetic readability; shorter is usually better.

## Optional motion fields (1.1)

Image scenes: base modes `galaxy` / `orbit-compare`, plus cyber modes `voice-signal`, `ai-network`, `data-flow`. Cyber diagrams accept optional `motion_labels`: exactly three strings, each ≤20 characters. Metric scenes: `animate_value: true` for a nonnegative English-formatted numeric prefix with an optional suffix. See [MOTION.md](MOTION.md) for timing, limits and examples. These additions preserve the original project schema.

See [CYBER-STYLE.md](CYBER-STYLE.md) for cyber mode semantics and custom-label examples.

Terminal scenes optionally accept `terminal_lines`: 1–3 nonempty strings, each ≤48 characters, without control characters. Valid only with `style: terminal`. Display-only text; never executed. See CYBER-STYLE.md.
