# Incident-timeline motion extension (renderer revision 1.1.0+cyber.2+escape.1)

A bounded, explicit extension for long-form incident storytelling: ten native
animated diagrams that let one film narrate a dated, multi-stage technical
event instead of a single idea per scene. The base editorial and cyber
compositions are untouched; nothing in the approved layout, pacing, speech or
caption pipeline changed.

## What was added

| Layer | Change |
|---|---|
| `contract.py` | `ESCAPE_MOTION` mode names; `motion_text` ≤64, `motion_date` ≤18, `motion_count` / `motion_total` integers 0–1000000, `motion_stage` 0–1. All rejected on non-extension modes. `music_quiet` scene-id window. |
| `engine/film.js` | `escapeApi()` — a fixed drawing API handed to each mode. Modes are dispatched from `movingDiagram` and draw in the same clipped 880×620 diagram pane as the existing cyber diagrams. |
| `engine/modes/*.js` | One file per mode. Plain display drawing: no imports, no network, no timers, no randomness, no execution. |
| `engine/film.html` | Loads the ten module files. |
| `engine/render.mjs` | The module files join the render fingerprint, so a changed diagram invalidates cached segments. |
| `prepare.py` | `music_quiet` dips the procedural bed by ~24 dB across one scripted window, with 0.9 s fades. Narration is untouched. |
| `prepare.py` (speech gate) | The script/transcript ratio is measured on a number-folded character stream. A recogniser writing "17,600", "Open AI" or "data set" where the script says "seventeen thousand six hundred", "OpenAI" or "dataset" is hearing the words correctly, and the gate no longer fails a correct reading over spelling. **Trade-off:** it is correspondingly blind to one mangled word inside a long sentence, so pronunciation review stays a human step — see `test_known_limitation_single_word_in_a_long_sentence`. |
| `tests/` | `escape_motion_check.mjs` renders every fixture of a mode across its whole scene and fails on exceptions, out-of-bounds text and a static diagram pane. `escape_fixtures.json` holds the fixtures. |

## The modes

| Mode | Explains |
|---|---|
| `timeline-track` | The dated incident spine: month ticks, a travelling marker, amber date pins that accumulate. |
| `package-server` | An internal package server, its file tree, and messages encoded in directory names. |
| `sandbox-grid` | Isolated sandboxes, one agent each, cracking and finally breached. |
| `swarm-board` | The agent message board, the swarm graph, and the command-and-control shape. |
| `cluster-intrusion` | Movement inside a target cluster: commands, datasets, workers, pods, secrets. |
| `kill-chain` | The five-stage chain and cooperating agents with no operator. |
| `flag-grid` | A benchmark grid of challenges and the unsolved subset. |
| `defense-side` | Log stream, alert triage, identity-log correlation, model refusals. |
| `paper-grader` | Benchmark paper, grader, task checklist, transcript editing. |
| `terminal-quote` | One verbatim monospace message, typed, in a quiet pane. |

`motion_stage` (0–1) selects which point of the story that instance of a mode
shows, so one diagram serves several scenes without duplicating code.

## Honesty rules these modes are built to

* No people. An agent is a glowing hexagon; a human is at most an empty chair or
  a dashboard outline. Nothing resembling a hooded figure.
* Colour is reserved: red for alerts, breakage, exfiltration and swarm messages;
  amber for dates and timestamps; cyan for infrastructure; phosphor green for
  everything else.
* Every string on screen comes from the project JSON. The renderer never
  executes, resolves, transmits or evaluates any of it.
* These are conceptual diagrams. They are not packet captures, live scans,
  telemetry, real cluster topology or any company's actual logo or interface.
* Numbers shown are only those supplied in `motion_count` / `motion_total` /
  `value`, which the project's editorial preparation sourced.

## Running the checks

```bash
for m in timeline-track package-server sandbox-grid swarm-board cluster-intrusion \
         kill-chain flag-grid defense-side paper-grader terminal-quote; do
  node tests/escape_motion_check.mjs "$m" || echo "FAILED: $m"
done
python -m unittest discover -s tests -v
python kit.py layout projects/the-ai-that-escaped/project.json
```

After any change to the engine or contract, re-record the manifest with
`python scripts/reseal.py` — `keou.py` refuses to render against an unrecorded
source tree.
