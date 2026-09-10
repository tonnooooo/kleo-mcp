/**
 * Unit tests for the Kleo full-bleed backdrop geometry in worker/keou/engine/film.js.
 * film.js is a browser script (it touches `document` at load), so the pure block between the
 * `@kleo-pure backdropPlan` and `@end backdropPlan` markers is extracted and evaluated here on
 * its own. No rendering, no canvas, no browser.
 * Run: node --test test/engine-image-plan.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEOU = join(ROOT, "worker", "keou");
const filmSource = readFileSync(join(KEOU, "engine", "film.js"), "utf8");

function pureBlock() {
  const a = filmSource.indexOf("/* @kleo-pure backdropPlan");
  const b = filmSource.indexOf("/* @end backdropPlan */");
  assert.ok(a >= 0 && b > a, "film.js must keep the @kleo-pure backdropPlan … @end backdropPlan markers");
  return filmSource.slice(a, b);
}
const { backdropPlan, backdropSeed, BACKDROP_ZOOM } = new Function(pureBlock() + "\nreturn { backdropPlan, backdropSeed, BACKDROP_ZOOM };")();

const FRAMES = [[1080, 1920], [1920, 1080]];                       // 9:16 and 16:9 design spaces
const IMAGES = [[720, 1280], [1280, 720], [1024, 1024], [1080, 1920], [1920, 1080], [300, 2000], [2000, 300]];
const STEPS = Array.from({ length: 41 }, (_, i) => i / 40);
const EPS = 1e-6;

function covers(r, W, H) {
  return r.x <= EPS && r.y <= EPS && r.x + r.w >= W - EPS && r.y + r.h >= H - EPS;
}

test("the pure block is self-contained (no canvas, no globals from film.js)", () => {
  const block = pureBlock();
  for (const forbidden of ["ctx", "images[", "document", "window", "drawImage"]) assert.ok(!block.includes(forbidden), `pure block must not reference ${forbidden}`);
  assert.equal(typeof backdropPlan, "function");
  assert.equal(BACKDROP_ZOOM, 0.08);
});

test("the draw rect covers the whole frame for every image shape, frame, seed and progress", () => {
  for (const [W, H] of FRAMES) for (const [iw, ih] of IMAGES) for (const seed of [0, 1, 2, 3, 7, 12345, backdropSeed("01-hook"), backdropSeed("02-crew")]) for (const p of STEPS) {
    const r = backdropPlan(iw, ih, W, H, p, seed);
    assert.ok(covers(r, W, H), `uncovered: image ${iw}x${ih} on ${W}x${H} seed ${seed} p ${p} -> ${JSON.stringify(r)}`);
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0, "finite positive rect");
  }
});

test("the picture is cover-fitted: its aspect ratio is preserved and it is not larger than needed at p=0", () => {
  for (const [W, H] of FRAMES) for (const [iw, ih] of IMAGES) {
    const r = backdropPlan(iw, ih, W, H, 0, 7);
    assert.ok(Math.abs(r.w / r.h - iw / ih) < 1e-9, "aspect preserved");
    const fit = Math.max(W / iw, H / ih);                        // cover scale
    assert.ok(Math.abs(r.w - iw * fit) < EPS && Math.abs(r.h - ih * fit) < EPS, "exact cover-fit at the first frame");
    assert.ok(Math.abs(Math.min(r.w - W, r.h - H)) < EPS, "one axis touches the frame exactly at p=0");
  }
});

test("Ken Burns: zoom goes from 1.0 to 1.08 and grows monotonically across the scene", () => {
  for (const [W, H] of FRAMES) for (const [iw, ih] of IMAGES) for (const seed of [0, 1, 2, 3]) {
    let last = -Infinity, lastW = -Infinity;
    for (const p of STEPS) {
      const r = backdropPlan(iw, ih, W, H, p, seed);
      assert.ok(r.zoom >= last - EPS, "zoom never shrinks");
      assert.ok(r.w >= lastW - EPS, "drawn width never shrinks");
      last = r.zoom; lastW = r.w;
    }
    assert.ok(Math.abs(backdropPlan(iw, ih, W, H, 0, seed).zoom - 1) < EPS);
    assert.ok(Math.abs(backdropPlan(iw, ih, W, H, 1, seed).zoom - 1.08) < EPS);
    assert.ok(backdropPlan(iw, ih, W, H, 1, seed).w > backdropPlan(iw, ih, W, H, 0, seed).w, "the picture is visibly larger at the end");
  }
});

test("the pan is soft: bounded by 4% of the width / 3% of the height and eased (no jump at the ends)", () => {
  for (const [W, H] of FRAMES) for (const [iw, ih] of IMAGES) for (const seed of [0, 1, 2, 3]) {
    const xs = STEPS.map((p) => backdropPlan(iw, ih, W, H, p, seed));
    for (const r of xs) { assert.ok(Math.abs(r.panX) <= W * 0.04 + EPS); assert.ok(Math.abs(r.panY) <= H * 0.03 + EPS); }
    const firstStep = Math.hypot(xs[1].panX - xs[0].panX, xs[1].panY - xs[0].panY);
    const midStep = Math.hypot(xs[21].panX - xs[20].panX, xs[21].panY - xs[20].panY);
    assert.ok(firstStep <= midStep + EPS, "smoothstep: the pan starts slower than it moves mid-scene");
  }
});

test("deterministic and clamped: the same inputs give the same rect, progress outside 0..1 is clamped", () => {
  const a = backdropPlan(720, 1280, 1080, 1920, 0.37, 99), b = backdropPlan(720, 1280, 1080, 1920, 0.37, 99);
  assert.deepEqual(a, b);
  assert.deepEqual(backdropPlan(720, 1280, 1080, 1920, -3, 99), backdropPlan(720, 1280, 1080, 1920, 0, 99));
  assert.deepEqual(backdropPlan(720, 1280, 1080, 1920, 7, 99), backdropPlan(720, 1280, 1080, 1920, 1, 99));
  assert.deepEqual(backdropPlan(720, 1280, 1080, 1920, NaN, 99), backdropPlan(720, 1280, 1080, 1920, 0, 99));
});

test("the seed steers the pan direction so consecutive scenes drift differently", () => {
  const dir = (seed) => { const r = backdropPlan(720, 1280, 1080, 1920, 0.9, seed); return [Math.sign(r.panX), Math.sign(r.panY)]; };
  assert.notDeepEqual(dir(0), dir(1));
  assert.notDeepEqual(dir(0), dir(2));
  assert.equal(typeof backdropSeed("01-hook"), "number");
  assert.equal(backdropSeed("01-hook"), backdropSeed("01-hook"));
  assert.notEqual(backdropSeed("01-hook"), backdropSeed("02-crew"));
  assert.ok(backdropSeed(undefined) >= 0 && backdropSeed("") >= 0);
});

test("engine drawing code routes pictures through the backdrop for cinema, closing and story scenes", () => {
  const cinema = readFileSync(join(KEOU, "engine", "cinema.js"), "utf8");
  const stickman = readFileSync(join(KEOU, "engine", "stickman.js"), "utf8");
  assert.ok(/backdrop,/.test(filmSource) && filmSource.includes("function stickApi()"), "film.js exposes backdrop in the style api");
  assert.ok(cinema.includes("A.backdrop(s, u"), "cinema.js draws the backdrop");
  assert.ok(cinema.indexOf("A.backdrop(s, u") < cinema.indexOf("S.chrome(s, i, t)"), "the picture goes under the chrome and the beats");
  assert.equal((stickman.match(/A\.backdrop\(s, u/g) || []).length, 2, "stickman story and closing slides draw the backdrop");
  assert.ok(filmSource.includes("for(const s of tl.scenes)if(s.image&&!images[s.image])"), "film.js preloads every scene image");
});

test("the cartoon-pirates example carries two pictures and validates with contract.py (skipped without python3)", (t) => {
  const dir = join(KEOU, "examples", "cartoon-pirates");
  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const withPicture = project.scenes.filter((s) => s.image);
  assert.deepEqual(withPicture.map((s) => [s.kind, s.image]), [["cinema", "img/01-hook.png"], ["cinema", "img/02-crew.png"]]);
  for (const s of withPicture) assert.ok(existsSync(join(dir, s.image)), `${s.image} must exist`);
  assert.equal(project.scenes.at(-1).kind, "closing");
  const py = spawnSync("python3", ["-c", "import sys, json; sys.path.insert(0, sys.argv[1]); import contract; c = contract.validate(sys.argv[2]); print(json.dumps([s.get('image') for s in c['scenes']]))", KEOU, join(dir, "project.json")], { encoding: "utf8" });
  if (py.error) { t.skip("python3 not available"); return; }
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout.trim()), ["img/01-hook.png", "img/02-crew.png", null]);
});
