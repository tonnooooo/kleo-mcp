# Cyber art direction and reusable motion

## Keep the approved foundation

This edition keeps the approved Keou layout, readable titles, pacing and measured audio/caption pipeline. It adds three native cyber diagrams inside the existing image composition. The original editorial template remains a separate frozen product.

Default `style: terminal`: black #010503, near-black green #061109, bright phosphor green #3cff81, pale green #c9ffd7 and muted green #74a680. JetBrains Mono is bundled with its font license. The whole film uses terminal framing, monospace typography, numbered code lines and an animated cursor. The older technical palette remains optional. Use calm, legible motion rather than strobing warnings or decorative walls of code.

## Native motion modes

Every mode is selected on an `image` scene. Keep a self-contained fallback `image` file and `image_credit`, then add `motion` and optionally `motion_labels`.

```json
{
  "id": "verify",
  "kind": "image",
  "title": "Verify before you act.",
  "voice": "Pause and check the request through a channel you already trust.",
  "image": "assets/verify.svg",
  "image_credit": "Original illustrative diagram.",
  "motion": "data-flow",
  "motion_labels": ["REQUEST", "VERIFY", "DECISION"]
}
```

`motion_labels` must contain exactly three nonempty strings, each at most 20 characters. Keep them short; layout checks still apply. Labels can be translated for a French film. The small explanatory footer in these built-in cyber diagrams is English in this release; localized footer wording requires a reviewed renderer extension.

| Mode | Motion | Labels in order |
|---|---|---|
| voice-signal | Two changing audio bar displays with scanning cursors | Upper signal, lower signal, takeaway |
| ai-network | Moving impulses through a stylized three-layer network and pulsing nodes | Input, central model, output |
| data-flow | Moving packets between request, verification and decision nodes; scanning shield | Incoming, verification step, decision |

The signal display is decorative, not synchronized to phonemes or intended as a voice detector. The network is a conceptual illustration, not a measured model architecture. Data-flow is a verification story, not a live scan or certified defense system. Do not describe its output as real telemetry.

## Values and other compositions

Use `animate_value: true` on a numeric metric to count up and settle on the exact final value. The base engine also includes hero, list, compare, steps, quote and closing, plus galaxy/orbit-compare diagrams for relevant science subjects. The source images stay static unless a supported native motion is selected.

## Story rhythm

A concrete trigger → why it matters → a useful explanation → a practical distinction → a clear takeaway. The demo uses AI voice scams, but this is a content template for many cybersecurity, technology and AI subjects. Check facts and use relevant native diagrams; do not reuse a voice-scamming script for an unrelated topic by changing the title alone.

## New motion requirements

A new subject may need a new diagram. Preserve the existing style and make that extension explicit; add contract validation, tests on actual moving draw calls and layout coverage before rendering. Keep the base editorial edition untouched.

## Typed code and terminal identity

Set `style: "terminal"` at project level. Keep the brand short, for example `signal@kanakytech:~/security`. Every scene gets a small code pane above its diagram or content. Customize it with:

```json
"terminal_lines": [
  "// independent verification",
  "hang_up();",
  "call_back(known_number);"
]
```

Use 1–3 nonempty lines, maximum 48 characters each, with no tabs, newlines or control characters. Lines are scene text: the renderer never evaluates or executes them. They can show illustrative pseudocode, quoted commands or explanatory comments. Do not imply a real scan, real network access or actual execution. Pick meaningful lines for the topic. Without custom lines the renderer uses a generic illustrative snippet.

Text types at a deterministic 38 characters per second after a short entrance delay. The cursor blinks at one cycle per second. Titles remain fully readable while the code and diagrams animate. Code text automatically reduces in size for long lines, and browser bounds checks still apply. Keep code short enough to finish within the narrated scene.

This terminal look was requested after the first cyber draft. Keep the original editorial/galaxy template separate and unchanged.
