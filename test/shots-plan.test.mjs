/**
 * The seam between the engine and the worker: build/shots.json.
 *
 * The engine decides when every shot cuts; the worker films each shot to exactly that length and lays the track.
 * Between them is one JSON file that nobody had ever produced and read in the same test. The worker's parser was
 * written from the engine's SOURCE, and a parser written from source is a guess about what the source produces.
 * A wrong guess here does not throw: the ids simply do not match, every clip is filed under a key nobody looks up,
 * every shot becomes black — and the first time anyone finds out is watching a finished film that was paid for.
 *
 * So this test produces a real shots.json with the ENGINE'S OWN CODE and reads it with the WORKER'S OWN CODE.
 * Neither side is imitated. The --shots branch is lifted out of render.mjs by its own text at test time rather
 * than copied here, so a rename in the engine breaks this test instead of quietly diverging from it.
 *
 * No GPU, no Chromium, no ffmpeg, nothing rendered: the branch is pure arithmetic over a timeline, and the
 * timeline is a fixture. render.mjs itself cannot be run here because it imports playwright at module load, which
 * is why the branch is evaluated rather than spawned.
 *
 * Run: node --test test/shots-plan.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = join(ROOT, "worker", "keou", "engine");
const FPS = 60;

/** A project and the timeline prepare.py would have written for it: three scenes, six shots, one anchored cut. */
function fixture(dir) {
  const src = [
    ["01-hook", "A lone figure runs down a rain soaked alley at night.", [
      { image_prompt: "a figure running through neon rain", motion: "crash_zoom_in", strength: 0.8 },
      { image_prompt: "water spraying from every step", motion: "track_alongside", strength: 0.6, at: "alley" }]],
    ["02-city", "The city never stops moving underneath her.", [
      { image_prompt: "a rain lashed city from above", motion: "crane_down", strength: 0.7 }]],
    ["03-closing", "Nobody ever found out where she was going.", [
      { image_prompt: "an empty floodlit pier", motion: "pull_out", strength: 0.5 },
      { image_prompt: "the sea heaving black behind it", motion: "push_in", strength: 0.4 },
      { image_prompt: "the lights dissolving into grey", motion: "static_hold", strength: 0 }]],
  ];
  const project = {
    schema_version: 1, id: "probe", title: "Night run", style: "picture", look: "realistic", backdrop: "video",
    format: "16:9", width: 1920, fps: FPS, language: "en", voice: "am_michael",
    editorial_status: "ready", music: "bed", brand: "Kleo", scenes: [],
  };
  const timeline = { duration: 0, fps: FPS, scenes: [] };
  let cursor = 0;
  src.forEach(([id, voice, shots], i) => {
    project.scenes.push({ id, kind: i === src.length - 1 ? "closing" : "cinema", chapter: `0${i + 1} PART`,
      accent: "amber", title: `part ${i + 1}`, voice, hold: 0.4, shots });
    const words = voice.split(" "), dur = 0.42 * words.length, lead = 0.22, hold = 0.65;
    const end = Math.ceil((cursor + lead + dur + hold) * FPS) / FPS, step = dur / words.length;
    timeline.scenes.push({ id, start: cursor, end, audio_start: cursor + lead, audio_end: cursor + lead + dur,
      captions: [{ text: voice, start: cursor + lead, end: cursor + lead + dur }],
      words: words.map((text, k) => ({ text, start: cursor + lead + k * step })), shots });
    cursor = end;
  });
  timeline.duration = cursor;
  mkdirSync(join(dir, "build"), { recursive: true });
  writeFileSync(join(dir, "project.json"), JSON.stringify(project, null, 1));
  writeFileSync(join(dir, "build", "timeline.json"), JSON.stringify(timeline, null, 1));
  return { project, timeline };
}

/** render.mjs's own --shots branch, taken from its source and run with the bindings it expects. */
function runShotsBranch(dir, project, timeline) {
  const src = readFileSync(join(ENGINE, "render.mjs"), "utf8");
  const a = src.indexOf("if(shotsOnly){"), b = src.indexOf("process.exit(0);", a);
  assert.ok(a >= 0 && b > a, "the --shots branch is not where it was: this test must be repaired, not deleted");
  const body = src.slice(src.indexOf("{", a) + 1, b);
  const width = project.width, height = width * (project.format === "9:16" ? 16 / 9 : 9 / 16);
  const said = [];
  new Function("readFileSync", "writeFileSync", "resolve", "engine", "build", "timeline", "fps", "width", "height", "console", body)(
    readFileSync, writeFileSync, resolve, ENGINE, join(dir, "build"), timeline, project.fps, width, height,
    { log: (...a) => said.push(a.join(" ")) });
  return said;
}

/** kleo_worker.shot_plan() on that file, in the worker's own Python. */
function readWithTheWorker(dir) {
  const code = `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("kw", os.environ["WORKER"])
kw = importlib.util.module_from_spec(spec); spec.loader.exec_module(kw)
plan, seconds = kw.shot_plan(os.environ["BUILD"])
print(json.dumps({"width": plan["width"], "height": plan["height"], "fps": plan["fps"],
                  "duration": plan["duration"], "seconds": seconds}))`;
  const r = spawnSync("python3", ["-c", code], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, WORKER: join(ROOT, "worker", "kleo_worker.py"), BUILD: join(dir, "build") },
  });
  assert.equal(r.status, 0, (r.stdout ?? "") + (r.stderr ?? ""));
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("the engine writes the shot plan and the worker reads exactly what it wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "kleo-shots-"));
  try {
    const { project, timeline } = fixture(dir);
    const said = runShotsBranch(dir, project, timeline);
    assert.match(said.join(" "), /SHOTS_WRITTEN 6/, "six shots over three scenes");

    const got = readWithTheWorker(dir);

    // The ids are the whole seam: generate_clips files a clip under this key and build_footage looks it up again.
    assert.deepEqual(Object.keys(got.seconds).sort(),
      ["01-hook-s1", "01-hook-s2", "02-city-s1", "03-closing-s1", "03-closing-s2", "03-closing-s3"],
      "one entry per shot, keyed <sceneId>-s<n> with n counting from one");

    // The frame the worker films to is the frame the graphics will be drawn on, read and never recomputed.
    assert.equal(got.width, 1920);
    assert.equal(got.height, 1080);
    assert.equal(got.fps, FPS);

    // A track even a frame short desynchronises everything after it, so the lengths must tile the film exactly.
    const total = Object.values(got.seconds).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - got.duration) < 1e-6,
      `the shots must cover the whole timeline: ${total} vs ${got.duration}`);
    assert.ok(Object.values(got.seconds).every((s) => s > 0), "a shot filmed at zero seconds is a gap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cut anchored on a spoken word is where the worker is told to cut, not the even split", () => {
  // The second shot of scene one carries at:"alley". If the worker filmed the even split instead, the picture
  // would change while the word that motivates it is still being said, on every video with an anchored cut.
  const dir = mkdtempSync(join(tmpdir(), "kleo-shots-at-"));
  try {
    const { project, timeline } = fixture(dir);
    runShotsBranch(dir, project, timeline);
    const got = readWithTheWorker(dir);
    const scene = timeline.scenes[0], even = (scene.end - scene.start) / 2;
    assert.ok(Math.abs(got.seconds["01-hook-s1"] - even) > 0.2,
      `the anchored cut must not land on the even split (${got.seconds["01-hook-s1"]} vs ${even})`);
    const words = scene.words.find((w) => w.text.replace(/\W/g, "").toLowerCase() === "alley");
    assert.ok(Math.abs(got.seconds["01-hook-s1"] - (words.start - scene.start - 0.12)) < 1e-6,
      "the first shot must last until the anchored word, less the engine's lead-in");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no shot in an ordinary Short outruns what the model can film in one take", () => {
  // kleo_video caps a generated clip at 5 s, past which it drifts; a longer shot is filled by holding the last
  // frame. That is a freeze on screen, so it is worth knowing when the shot plan produces one at all.
  const dir = mkdtempSync(join(tmpdir(), "kleo-shots-max-"));
  try {
    const { project, timeline } = fixture(dir);
    runShotsBranch(dir, project, timeline);
    const got = readWithTheWorker(dir);
    const longest = Math.max(...Object.values(got.seconds));
    assert.ok(longest <= 5.0, `a shot of ${longest.toFixed(2)} s would freeze for ${(longest - 5).toFixed(2)} s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
