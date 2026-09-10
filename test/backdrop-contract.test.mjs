/**
 * The video backdrop, on both sides of the wire.
 *
 * A picture film is about to stop being drawn on an opaque canvas: the generated clip becomes a track of
 * its own and the engine draws only graphics and text over it. That switch changes how the canvas is
 * created, which happens once when the page loads — so it is a property of the project, never of a shot,
 * and this is where that is made true rather than remembered.
 *
 * Two guarantees matter here. The explainer must not be able to fall into transparent mode by accident,
 * because its whole look is white marker on pure black and a transparent ground would render it invisible.
 * And a film with a video track must carry a clip on every shot: one missing clip is a hole in the track,
 * which is a black hole in the finished film that only a viewing would find — after the GPU is paid for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateStoryboard, STYLES } from "../src/keou-contract.ts";

const PY = readFileSync(resolve(import.meta.dirname, "../worker/keou/contract.py"), "utf8");

const picture = (over = {}) => ({
  schema_version: 1, editorial_status: "ready", title: "A film", style: "picture", look: "cartoon", kleo_style: "cartoon",
  format: "9:16", language: "en", voice: "am_michael", music: "none",
  scenes: [
    { id: "01-a", kind: "cinema", chapter: "01 ONE", accent: "cyan", title: "The ship", hl: "ship",
      voice: "A wooden ship sat at anchor in the bay for eleven years.",
      shots: [{ image_prompt: "A wooden ship at anchor in a turquoise bay" }, { image_prompt: "The empty deck at dawn", at: "eleven years" }] },
    { id: "02-b", kind: "closing", chapter: "02 END", accent: "green", title: "Gone", hl: "Gone",
      voice: "Nobody ever came back for it.", button: "Follow",
      shots: [{ image_prompt: "An empty beach at sunset with no ship on the water" }] },
  ],
  ...over,
});
const errs = (sb) => validateStoryboard(sb, { format: "9:16", language: "en" }).errors ?? [];

test("a video backdrop is a project-level switch, and only the picture style has one", () => {
  assert.deepEqual(errs(picture({ backdrop: "video" })), []);
  assert.ok(errs(picture({ backdrop: "clip" })).some((m) => /backdrop must be 'video'/.test(m)),
    "the only value is the one the engine implements");
  // The guarantee the explainer depends on: white marker on pure black cannot be drawn on nothing.
  for (const style of STYLES.filter((s) => s !== "picture")) {
    const sb = picture({ style, backdrop: "video" });
    assert.ok(errs(sb).some((m) => /backdrop belongs to the picture style only/.test(m)),
      `style "${style}" must not be able to reach transparent mode`);
  }
});

test("a client never writes a clip: it is generated on the GPU and attached there", () => {
  const sb = picture({ backdrop: "video" });
  sb.scenes[0].shots[0].clip = "clips/01.mp4";
  const found = errs(sb);
  assert.ok(found.some((m) => /clip is not allowed in a storyboard/.test(m)));
  // And it says WHY, instead of the generic message an unlisted key would otherwise get.
  assert.ok(!found.some((m) => /unknown shot fields.*clip/.test(m)),
    "a field with a reason deserves its reason, not 'unknown shot fields'");
});

test("the rented machine refuses a video backdrop with a shot that has no clip", () => {
  // worker/keou/contract.py is the side that sees real files, so this is asserted against its source: it is
  // the only validator that can check a clip exists, and it runs after the GPU has been paid for.
  assert.match(PY, /CLIP_FORMATS = \{[^}]*'\.mp4'/, "contract.py should know what a clip file is");
  assert.match(PY, /def local_clip\(project, value\)/, "contract.py should validate a clip the way it validates an image");
  assert.match(PY, /clips\/ folder/, "a clip lives under clips\\/, so a stray path cannot reach the compositor");
  assert.match(PY, /every shot needs a 'clip' when the project has a video backdrop/,
    "a missing clip must be refused, not composited as a hole");
  assert.match(PY, /backdrop must be 'video'/, "the two validators must word the same rule the same way");
  assert.match(PY, /backdrop belongs to the picture style only/);
  assert.match(PY, /SHOT_FIELDS = \{[^}]*'clip'/, "contract.py must accept the field it requires");
});

/* ------------------------------------------------------------------ the explainer can never be filmed */

/**
 * The guarantee the drawn look depends on, checked from its own side.
 *
 * `backdrop: "video"` is now DERIVED — normalizeStoryboard sets it from the machine table, so a style whose
 * profile is raised above the ordinary one starts asking to be filmed. That derivation is the right design
 * and it is tested from the picture style's side. This is the other side of it: the explainer draws white
 * marker on pure black, so a transparent ground renders it as nothing at all — a film that is not wrong,
 * but empty. test/filmed-backdrop.test.mjs flips cyber; nothing flipped the explainer, and the explainer is
 * the style with the most to lose.
 */
test("raising the explainer's machine profile never turns the film transparent", async () => {
  const { planFor, normalizeStoryboard, fixtureStoryboard } = await import("../src/storyboard.ts");
  const { STYLE_MACHINE, VIDEO, isVideoStyle } = await import("../src/templates.ts");

  const job = (style, template, format, duration_s) => ({
    id: "gt_test", template, prompt: "How a password becomes a hash.",
    params: JSON.stringify({ duration_s, format, language: "en", voice: null, style }),
  });
  const scenes = [
    { id: "01-a", kind: "sketch", accent: "red", voice: "Your password was never stored anywhere at all.",
      shot: { zoom: [1, 1.3], focus: [540, 860] }, art: [{ name: "laptop", drawn: true }, { name: "lock", at: "never stored" }] },
    { id: "02-b", kind: "sketch", accent: "green", voice: "So what does the website actually keep instead?",
      shot: { zoom: [1, 1.3], focus: [540, 860] }, art: [{ name: "server", drawn: true }, { name: "code", at: "actually keep" }] },
  ];

  const before = STYLE_MACHINE.explainer;
  STYLE_MACHINE.explainer = VIDEO;   // the day someone decides the drawn look needs a bigger card
  try {
    assert.equal(isVideoStyle("explainer"), true, "the flip has to be real, or this test proves nothing");
    for (const [template, format, dur] of [["explainer-short", "9:16", 45], ["explainer-long", "16:9", 300]]) {
      const plan = planFor(job("explainer", template, format, dur), "explainer");
      assert.equal(plan.style, "sketch");
      const sb = normalizeStoryboard({ title: "Hashes", description: "d", tags: ["a"], scenes }, plan);
      assert.equal("backdrop" in sb, false,
        `${template}: the explainer asked to be filmed — on a transparent ground its white marker draws nothing`);
      // And the contract is the second lock: even if something did set it, the job would never reach a GPU.
      assert.ok(validateStoryboard({ ...sb, backdrop: "video" }, { format, language: "en" })
        .errors?.some((m) => /backdrop belongs to the picture style only/.test(m)));
    }
    // The fixture path writes the field too, and a fixture that describes a different product from the real
    // one is how a look ships broken to the one person who renders offline.
    const fx = fixtureStoryboard(job("explainer", "explainer-short", "9:16", 45));
    assert.equal("backdrop" in fx, false, "the offline fixture must describe the same product as the planner");
  } finally {
    STYLE_MACHINE.explainer = before;
  }
});
