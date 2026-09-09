# Meaningful motion — revision 1.1

Motion should explain the idea while the voice speaks. Preserve the editorial typography, color and whitespace; animate the meaningful objects within the diagram.

## Animated diagrams

Image scenes can opt into `"motion": "galaxy"` or `"motion": "orbit-compare"`. Keep `image` and `image_credit`: the SVG is the static fallback and source illustration, while the selected motion is drawn natively in Canvas. These two modes are astronomy-specific; do not attach them to unrelated subjects.

- `galaxy`: stylized rotating spiral arms, living star field, black-hole ring and a tracked location marker. Labels stay readable. Motion is illustrative, not a measured galactic simulation.
- `orbit-compare`: three stylized planets orbit a Sun and an equal-mass black hole. Matching objects stay synchronized on both sides. Radius determines relative speed. The Earth orbit is highlighted; subtle trails make the movement clear. The scene explicitly labels its scale/time simplification.

No JavaScript or executable code is accepted inside an SVG. Native Canvas motion is deterministic: seeking the same time produces the same frame, even when rendering frames out of order in separate workers.

## Animated values

Metric scenes can set `"animate_value": true`. Values must have a nonnegative numeric prefix in English-style formatting, optionally followed by a suffix: `4 MILLION`, `26,000`, `3.5%`. The value rises over 1.45 seconds after a short entrance, then displays the exact original `value`. Font sizing is held stable across the count. The final claim and unit must still be fact-checked.

Use this option when the number benefits from emphasis. For a nonnumeric metric, omit it. Localized decimal-comma and negative-number animation are not supported in this revision; their fixed values still work without the option.

## Reusable production rule

For each diagram, identify what should move: orbit, flow, connection, progression or comparison. Make it move meaningfully rather than merely zooming a flat image. Use the existing native modes when relevant. A new subject-specific native mode is a reviewed engine extension requiring its own motion and layout tests; this is not an arbitrary animation generator.

The closing check is now drawn progressively. Ordinary image scenes retain their original gentle push unless a motion mode is selected. The approved French example remains an archived reference film; the revised English example demonstrates the new movements.

## Verification

`node tests/motion_check.mjs` checks actual Canvas planet draw positions, synchronized equal-mass orbits, changing star positions, counter progression and exact final values. It also checks timestamp determinism and 5,232 entrance frames across three palettes and two aspect ratios. Node/Playwright/Chromium are required. The test can build its own layout fixture from the bundled English example; this is never delivered as a film.

The release revision is 1.1; the existing artifact/pipeline version 1.0.0 and project schema 1 remain unchanged. Animation is an additive opt-in field, so older project files remain valid.

## Cyber edition

The original galaxy and orbit modes remain available. The default cyber project uses three additional diagrams with configurable labels: see [CYBER-STYLE.md](CYBER-STYLE.md). These diagrams animate objects inside the scene, using the same deterministic timeline and entrance easing.
