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
});

/* ---------------------------------------------------------------------------------------------
 * Picture preloading, run for real.
 * film.js is a browser script, so it is evaluated here with a hand-made `document`, `window`,
 * `Image` and `fetch`: no canvas, no DOM, no network — the ctx stub only records drawImage calls
 * and the Image stub decides per path whether decode() succeeds. That is enough to drive
 * window.init / window.renderFrame and assert on what they actually do, instead of on how film.js
 * happens to be spelled.
 * ------------------------------------------------------------------------------------------- */

function fakeCtx(record) {
  const grad = { addColorStop() {} }, noop = () => {}, alphas = [];
  const ctx = {
    globalAlpha: 1, font: "", textAlign: "left", textBaseline: "alphabetic", fillStyle: "#000", strokeStyle: "#000",
    lineWidth: 1, lineCap: "butt", lineJoin: "miter", lineDashOffset: 0, imageSmoothingEnabled: false, imageSmoothingQuality: "low",
    save() { alphas.push(ctx.globalAlpha); }, restore() { ctx.globalAlpha = alphas.length ? alphas.pop() : 1; },
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, rect: noop, roundRect: noop, clip: noop,
    fill: noop, stroke: noop, fillRect: noop, strokeRect: noop, translate: noop, rotate: noop, scale: noop,
    setTransform: noop, setLineDash: noop, fillText: noop,
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    measureText: (text) => ({ width: String(text).length * 6 }),
    drawImage: (img) => record.drawn.push(img),
  };
  return ctx;
}

/** decode(path) -> "ok" | "fail" | "empty" (a decoded-but-zero-sized picture). Default: everything decodes. */
function loadFilm(decode = () => "ok") {
  const record = { requested: [], drawn: [], warned: [] };
  const ctx = fakeCtx(record);
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const document = {
    getElementById: () => canvas,
    fonts: { load: async () => {}, ready: Promise.resolve(), check: () => true },
  };
  const styleModule = { attach: () => {}, background: () => {}, scene: () => {}, subtitle: () => {}, progress: () => {}, header: () => {}, closing: () => {} };
  const win = { KEOU_CINEMA: styleModule, KEOU_PICTURE: styleModule, KEOU_STICKMAN: styleModule, KEOU_MODES: {} };
  class FakeImage {
    constructor() { this.width = 0; this.height = 0; this._src = ""; }
    set src(value) { this._src = value; record.requested.push(value); }
    get src() { return this._src; }
    async decode() {
      const verdict = decode(this._src.replace(/^\/project\//, ""));
      if (verdict === "fail") throw new Error("The source image cannot be decoded");
      if (verdict === "empty") return;                              // decodes, but stays 0x0
      this.width = 1024; this.height = 1024;
    }
  }
  const fetchStub = async () => ({ json: async () => ({ features: [] }) });
  const consoleStub = { warn: (...a) => record.warned.push(a.join(" ")), log: () => {}, error: () => {} };
  new Function("document", "window", "Image", "fetch", "console", filmSource)(document, win, FakeImage, fetchStub, consoleStub);
  return { win, record, ctx };
}

const scene = (id, kind, image, shots, start, end) => ({ id, kind, title: "A short title", image, shots, start, end, captions: [] });
const config = (style) => ({ style, format: "16:9", brand: "Kleo" });

test("init preloads every scene picture and every shot picture before the first frame, each fetched once", async () => {
  const tl = {
    duration: 9,
    scenes: [
      scene("01-hook", "cinema", "img/a.png", [{ image: "img/a.png" }, { image: "img/b.png" }], 0, 3),   // the worker copies shot 1's picture onto scene.image
      scene("02-crew", "cinema", "img/c.png", null, 3, 6),
      scene("03-end", "closing", null, [{ image: null }], 6, 9),
    ],
  };
  const { win, record } = loadFilm();
  assert.equal(await win.init(config("picture"), tl, 540), true, "a clean load reports plain success");
  assert.deepEqual([...record.requested].sort(), ["/project/img/a.png", "/project/img/b.png", "/project/img/c.png"]);
  assert.equal(record.requested.length, 3, "the picture shared by scene.image and shot 1 is decoded once, not twice");
});

test("a picture that fails to decode is recorded and the render carries on — in every style", async () => {
  for (const style of ["picture", "cinema", "stickman", "terminal", "editorial", "technical", "illustrated"]) {
    const tl = { duration: 6, scenes: [scene("01-hook", "cinema", "img/broken.png", [{ image: "img/broken.png" }], 0, 3), scene("02-crew", "image", "img/fine.png", null, 3, 6)] };
    const { win, record } = loadFilm((path) => (path === "img/broken.png" ? "fail" : "ok"));
    const out = await win.init(config(style), tl, 540);                    // must not reject: one picture is never worth the job
    assert.deepEqual(out, { ok: true, images: [{ error: "Picture failed to load", image: "img/broken.png", detail: "The source image cannot be decoded" }] }, `${style}: init reports the broken picture`);
    assert.deepEqual(win.KEOU_IMAGE_ISSUES, out.images, `${style}: the QA layer sees the same list`);
    assert.equal(record.requested.filter((s) => s.endsWith("broken.png")).length, 1, `${style}: a failed path is remembered, not retried on every reference`);
    assert.equal(record.warned.filter((w) => w.startsWith("PICTURE_LOAD_FAILED")).length, 1, `${style}: reported once`);
  }
});

test("a picture that decodes to 0x0 counts as a failure and is not handed to drawImage", async () => {
  const tl = { duration: 3, scenes: [scene("01-hook", "image", "img/empty.png", null, 0, 3)] };
  const { win, record } = loadFilm(() => "empty");
  const out = await win.init(config("editorial"), tl, 540);
  assert.equal(out.ok, true);
  assert.deepEqual(out.images.map((i) => [i.image, i.detail]), [["img/empty.png", "Empty picture"]]);
  assert.deepEqual(win.renderFrame(1), [], "the frame still renders, with no frame issue");
  assert.equal(record.drawn.length, 0, "nothing is drawn for a 0x0 picture");
});

test("a missing picture degrades gracefully outside the picture style: the frame renders without it", async () => {
  const tl = { duration: 3, scenes: [scene("01-hook", "image", "img/broken.png", null, 0, 3)] };
  const broken = loadFilm(() => "fail");
  await broken.win.init(config("editorial"), tl, 540);
  assert.doesNotThrow(() => broken.win.renderFrame(1.5), "scene kind 'image' must not take the frame down with the picture");
  assert.deepEqual(broken.win.renderFrame(1.5), []);
  assert.equal(broken.record.drawn.length, 0);

  const good = loadFilm();
  await good.win.init(config("editorial"), tl, 540);
  assert.deepEqual(good.win.renderFrame(1.5), []);
  assert.ok(good.record.drawn.length >= 1, "the same scene draws the picture when it decoded");
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
