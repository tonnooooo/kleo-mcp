/**
 * Unit tests for the Kleo "picture" style (docs/PICTURE-STYLE.md §3 and §4).
 *
 * worker/keou/engine/picture.js is a browser script (it assigns window.KEOU_PICTURE at load), so
 * only the pure planning block between the `@kleo-pure picture-plan` and `@end picture-plan`
 * markers is evaluated here — shot timing, the Ken Burns rect and caption fitting. Everything
 * else is checked as source: the wiring in film.js / film.html and the rules in contract.py.
 * No rendering, no canvas, no browser, no Playwright.
 * Run: node --test test/engine-picture.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEOU = join(ROOT, "worker", "keou");
const ENGINE = join(KEOU, "engine");
const pictureSource = readFileSync(join(ENGINE, "picture.js"), "utf8");
const filmSource = readFileSync(join(ENGINE, "film.js"), "utf8");
const htmlSource = readFileSync(join(ENGINE, "film.html"), "utf8");
const EXAMPLE = join(KEOU, "examples", "cartoon-pirates", "project.json");

function pureBlock() {
  const a = pictureSource.indexOf("/* @kleo-pure picture-plan");
  const b = pictureSource.indexOf("/* @end picture-plan */");
  assert.ok(a >= 0 && b > a, "picture.js must keep the @kleo-pure picture-plan … @end picture-plan markers");
  return pictureSource.slice(a, b);
}
const P = new Function(pureBlock() + `
  return { shotStarts, shotMotion, sceneShots, kenBurns, fitLines, groupWords, keyWord,
           shotFade, shotPunch, MOTIONS, SHOT_FADE, PUNCH, PUNCH_IN, MIN_SHOT, ZOOM };`)();

const FRAMES = [[1080, 1920], [1920, 1080]];                       // 9:16 and 16:9 design spaces
const IMAGES = [[720, 1280], [1280, 720], [1024, 1024], [1080, 1920], [1920, 1080], [300, 2000], [2000, 300]];
const STEPS = Array.from({ length: 21 }, (_, i) => i / 20);
const EPS = 1e-6;
const covers = (r, W, H) => r.x <= EPS && r.y <= EPS && r.x + r.w >= W - EPS && r.y + r.h >= H - EPS;
const words = (list, from = 10) => list.map((text, i) => ({ text, start: from + i * .5 }));

/* ---- the pure block ------------------------------------------------------- */

test("the pure block is self-contained: no canvas, no page, no engine globals", () => {
  const block = pureBlock();
  for (const forbidden of ["ctx", "document", "window", "drawImage", "images[", "A.project", "A.images", "geo("])
    assert.ok(!block.includes(forbidden), `the pure block must not reference ${forbidden}`);
  for (const name of ["shotStarts", "shotMotion", "kenBurns", "fitLines", "groupWords"])
    assert.equal(typeof P[name], "function", `${name} must live in the pure block`);
  assert.equal(P.SHOT_FADE, .35, "the crossfade is 0.35 s");
  assert.equal(P.PUNCH, .03, "the incoming shot gets a 3% scale punch");
  assert.ok(P.PUNCH_IN >= .18 && P.PUNCH_IN <= .35, "the punch settles in 0.18–0.35 s");
  assert.deepEqual(P.MOTIONS, ["in", "out", "left", "right"]);
});

test("shot timing: the first shot opens the scene, the others cut on their `at` word", () => {
  const s = { start: 10, end: 18, words: words(["Every", "pirate", "wears", "an", "eye", "patch", "but", "both", "eyes", "worked"]) };
  const shots = [{}, { at: "eye patch" }, { at: "both eyes" }];
  const starts = P.shotStarts(s, shots, 8);
  assert.equal(starts[0], 0, "shot 1 always starts with the scene");
  assert.ok(Math.abs(starts[1] - (2 - .12)) < 1e-9, "shot 2 cuts just before the words 'eye patch'");
  assert.ok(Math.abs(starts[2] - (3.5 - .12)) < 1e-9, "shot 3 cuts just before 'both eyes'");
  assert.deepEqual(P.shotStarts(s, shots, 8), starts, "deterministic");
  assert.deepEqual(P.shotStarts(s, [{ at: "both eyes" }], 8), [0], "an `at` on the first shot is ignored");
});

test("shot timing: without a matching word the shots share the scene evenly", () => {
  assert.deepEqual(P.shotStarts({ start: 0, end: 6 }, [{}, {}, {}], 6), [0, 2, 4]);
  assert.deepEqual(P.shotStarts({ start: 0, end: 6, words: words(["nothing", "matches", "here"], 0) }, [{}, { at: "absent quote" }, {}], 6), [0, 2, 4]);
  assert.deepEqual(P.shotStarts({ start: 0, end: 4 }, [{}], 4), [0], "a single shot holds the whole scene");
});

test("shot timing is always increasing, readable and inside the scene", () => {
  const said = words(["one", "two", "three", "four", "five", "six", "seven", "eight"], 0);
  for (const dur of [1.2, 2, 3.4, 6, 12, 30]) for (const n of [1, 2, 3, 4]) {
    for (const ats of [[], ["two"], ["three", "seven"], ["seven", "two"], ["absent"]]) {
      const shots = Array.from({ length: n }, (_, i) => (i && ats[i - 1] ? { at: ats[i - 1] } : {}));
      const starts = P.shotStarts({ start: 0, end: dur, words: said }, shots, dur);
      const min = Math.min(P.MIN_SHOT, dur / n);
      assert.equal(starts.length, n);
      assert.equal(starts[0], 0);
      for (let i = 1; i < n; i++) {
        assert.ok(Number.isFinite(starts[i]), "finite");
        assert.ok(starts[i] >= starts[i - 1] + min - EPS, `shot ${i + 1} is at least ${min}s after shot ${i} (${starts})`);
      }
      assert.ok(starts[n - 1] <= dur - min + EPS, `the last shot keeps ${min}s before the scene ends (${starts})`);
    }
  }
});

test("the default camera move alternates in / out / left / right, a shot may ask for its own", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(i => P.shotMotion({}, i)), ["in", "out", "left", "right", "in"]);
  assert.equal(P.shotMotion({ motion: "left" }, 0), "left");
  assert.equal(P.shotMotion({ motion: "zoom-of-doom" }, 1), "out", "an unknown motion falls back to the rotation");
  assert.equal(P.shotMotion(null, 2), "left");
});

test("Ken Burns: the picture covers the whole frame for every shape, frame, move and progress", () => {
  for (const [W, H] of FRAMES) for (const [iw, ih] of IMAGES) for (const m of P.MOTIONS) for (const p of STEPS)
    for (const punch of [1, 1.03]) {
      const r = P.kenBurns(m, iw, ih, W, H, p, punch);
      assert.ok(covers(r, W, H), `uncovered: ${m} ${iw}x${ih} on ${W}x${H} at ${p} -> ${JSON.stringify(r)}`);
      assert.ok(Math.abs(r.w / r.h - iw / ih) < 1e-9, "the picture is never distorted");
      assert.ok(r.w > 0 && r.h > 0 && Number.isFinite(r.x) && Number.isFinite(r.y));
    }
});

test("Ken Burns: in 1.00→1.10, out 1.10→1.00, left/right hold 1.04 and pan at most 6%", () => {
  const [W, H] = FRAMES[0], [iw, ih] = IMAGES[0];
  const z = (m, p) => P.kenBurns(m, iw, ih, W, H, p, 1).zoom;
  assert.ok(Math.abs(z("in", 0) - 1) < EPS && Math.abs(z("in", 1) - 1.1) < EPS);
  assert.ok(Math.abs(z("out", 0) - 1.1) < EPS && Math.abs(z("out", 1) - 1) < EPS);
  for (const m of ["left", "right"]) for (const p of STEPS) assert.ok(Math.abs(z(m, p) - 1.04) < EPS, `${m} keeps a steady 1.04 zoom`);
  for (const [WW, HH] of FRAMES) for (const [w2, h2] of IMAGES) for (const m of P.MOTIONS) {
    const all = STEPS.map(p => P.kenBurns(m, w2, h2, WW, HH, p, 1));
    for (const r of all) { assert.ok(Math.abs(r.panX) <= WW * .03 + EPS, "half of the 6% travel on each side"); assert.equal(r.panY, 0) }
    const travel = Math.max(...all.map(r => r.panX)) - Math.min(...all.map(r => r.panX));
    assert.ok(travel <= WW * .06 + EPS, "the total pan never exceeds 6% of the width");
    if (m === "in" || m === "out") assert.equal(travel, 0, "a zoom move does not pan");
  }
  const left = STEPS.map(p => P.kenBurns("left", 720, 1280, 1080, 1920, p, 1).panX);
  const right = STEPS.map(p => P.kenBurns("right", 720, 1280, 1080, 1920, p, 1).panX);
  assert.ok(left[0] > 0 && left.at(-1) < 0, "left drifts the picture leftwards");
  assert.ok(right[0] < 0 && right.at(-1) > 0, "right drifts the other way");
  assert.ok(Math.abs(left[1] - left[0]) <= Math.abs(left[11] - left[10]) + EPS, "eased: the drift starts slower than mid-shot");
});

test("Ken Burns: the punch only ever enlarges, and progress is clamped and deterministic", () => {
  const a = P.kenBurns("in", 720, 1280, 1080, 1920, .4, 1), b = P.kenBurns("in", 720, 1280, 1080, 1920, .4, 1.03);
  assert.ok(Math.abs(b.zoom / a.zoom - 1.03) < 1e-9 && b.w > a.w, "the punch scales the picture up, never down");
  assert.deepEqual(P.kenBurns("in", 720, 1280, 1080, 1920, .4, 1), a, "deterministic");
  assert.deepEqual(P.kenBurns("in", 720, 1280, 1080, 1920, -4, 1), P.kenBurns("in", 720, 1280, 1080, 1920, 0, 1));
  assert.deepEqual(P.kenBurns("in", 720, 1280, 1080, 1920, 9, 1), P.kenBurns("in", 720, 1280, 1080, 1920, 1, 1));
  assert.deepEqual(P.kenBurns("in", 720, 1280, 1080, 1920, NaN, 0), P.kenBurns("in", 720, 1280, 1080, 1920, 0, 1));
  assert.equal(P.kenBurns("nonsense", 720, 1280, 1080, 1920, 0, 1).motion, "in", "an unknown move zooms in");
});

test("the crossfade and the punch are short and snappy", () => {
  assert.equal(P.shotFade(0), 0);
  assert.equal(P.shotFade(P.SHOT_FADE), 1);
  assert.equal(P.shotFade(9), 1);
  assert.ok(P.shotFade(P.SHOT_FADE / 2) > .5, "most of the crossfade is done at half time");
  assert.ok(Math.abs(P.shotPunch(0) - 1.03) < EPS, "the incoming picture starts 3% large");
  assert.equal(P.shotPunch(P.PUNCH_IN), 1);
  assert.equal(P.shotPunch(4), 1);
  for (let u = 0; u <= P.PUNCH_IN; u += .01) assert.ok(P.shotPunch(u) >= P.shotPunch(u + .01) - EPS, "the punch only settles");
});

test("caption fitting: wraps, then shrinks, and reports what still does not fit", () => {
  const measure = (value, size) => value.length * size * .5;            // a stub: 0.5 em per character
  const one = P.fitLines("SHE NEVER CAME BACK", measure, 900, 3, 100, 50);
  assert.ok(one.lines.length <= 3 && one.fits && one.width <= 900);
  assert.equal(one.size, 100, "big type first: it breaks the line rather than shrinking while lines are left");
  assert.equal(P.fitLines("NEVER", measure, 900, 3, 100, 50).lines.join(" "), "NEVER");
  const many = P.fitLines("SHE NEVER CAME BACK FOR THE TREASURE SHE BURIED", measure, 600, 3, 100, 50);
  assert.ok(many.lines.length <= 3 && many.width <= 600 && many.fits);
  assert.equal(many.lines.join(" "), "SHE NEVER CAME BACK FOR THE TREASURE SHE BURIED", "no word is lost or duplicated");
  assert.ok(many.size >= 50, "never smaller than the floor");
  const hopeless = P.fitLines("ANTIDISESTABLISHMENTARIANISM", measure, 120, 2, 100, 50);
  assert.equal(hopeless.size, 50, "stops at the floor");
  assert.equal(hopeless.fits, false, "and says so, so the caller can raise an issue");
  assert.deepEqual(P.fitLines("   ", measure, 900, 3, 100, 50).lines, []);
  assert.deepEqual(P.fitLines(null, measure, 900, 3, 100, 50).lines, []);
  const two = P.fitLines("below deck it is pitch black", measure, 400, 2, 60, 30);
  assert.ok(two.lines.length <= 2 && two.lines.every(l => measure(l, two.size) <= 400));
});

test("karaoke: a caption group is matched onto the word timings of the scene", () => {
  const said = words(["Below", "deck", "it", "is", "pitch", "black."], 12);
  const group = { text: "it is pitch", start: 13 };
  assert.deepEqual(P.groupWords(said, group), [{ text: "it", start: 13 }, { text: "is", start: 13.5 }, { text: "pitch", start: 14 }]);
  assert.deepEqual(P.groupWords(said, { text: "it is pitch", start: 99 }), [{ text: "it", start: 13 }, { text: "is", start: 13.5 }, { text: "pitch", start: 14 }], "falls back to matching the text");
  assert.deepEqual(P.groupWords(said, { text: "nothing like it", start: 99 }).map(w => w.start), [null, null, null]);
  assert.deepEqual(P.groupWords(undefined, group).map(w => w.start), [null, null, null], "a timeline without word times still yields the words");
  assert.equal(P.keyWord("Below deck it is pitch black", "pitch"), "pitch");
  assert.equal(P.keyWord("keep one eye covered and always ready", ""), "covered", "no scene keyword: the longest word that carries meaning");
  assert.equal(P.keyWord("it is in the of to", ""), "", "nothing worth colouring");
  assert.equal(P.keyWord("", ""), "");
});

test("a scene without shots still draws one picture", () => {
  assert.deepEqual(P.sceneShots({ image: "img/a.png" }), [{ image: "img/a.png" }]);
  assert.equal(P.sceneShots({ shots: [{ image: "img/a.png" }, { caption: "B" }] }).length, 2);
  assert.deepEqual(P.sceneShots({ shots: [null] }), [{}], "a broken shot renders as the accent gradient");
});

/* ---- the module and its wiring -------------------------------------------- */

test("picture.js exports the same surface as cinema.js and borrows none of its icons", () => {
  for (const forbidden of ["I.wave", "figure", "radar", "shield", "brackets"])
    assert.ok(!pictureSource.includes(forbidden), `the picture style must not reference the cinema icon set (${forbidden})`);
  assert.ok(/window\.KEOU_PICTURE\s*=\s*\{\s*attach\(api\)\s*\{\s*A\s*=\s*api\s*\}/.test(pictureSource), "attach(api) like KEOU_CINEMA");
  for (const member of ["background", "chrome", "progress", "scene", "subtitle"])
    assert.ok(new RegExp(`S\\.${member}\\s*=\\s*function`).test(pictureSource), `S.${member} must exist`);
  assert.ok(pictureSource.includes("'#0b0b0f'"), "near-black background");
  assert.ok(pictureSource.includes("KleoCartoon, Manrope") && pictureSource.includes("KleoReal, Manrope"),
    "both font stacks fall back to Manrope when the downloaded file is missing");
  assert.ok(!/S\.progress\s*=\s*function\s*\([^)]*\)\s*\{\s*[^}\s]/.test(pictureSource), "no progress bar in this style");
});

test("film.html loads picture.js before film.js and declares both look fonts", () => {
  const picture = htmlSource.indexOf("/engine/picture.js"), film = htmlSource.indexOf("/engine/film.js");
  assert.ok(picture > 0 && film > picture, "engine/picture.js must be loaded before engine/film.js");
  assert.ok(htmlSource.includes("font-family:KleoCartoon;src:url('/engine/assets/cartoon.ttf')"), "KleoCartoon @font-face");
  assert.ok(htmlSource.includes("font-family:KleoReal;src:url('/engine/assets/real.ttf')"), "KleoReal @font-face");
  assert.ok(/KleoCartoon;[^}]*font-weight:400 800/.test(htmlSource) && /KleoReal;[^}]*font-weight:200 700/.test(htmlSource), "variable weight ranges");
  assert.ok(/KleoCartoon;[^}]*font-display:block/.test(htmlSource) && /KleoReal;[^}]*font-display:block/.test(htmlSource));
});

test("film.js dispatches the picture style everywhere it dispatches cinema", () => {
  const lines = filmSource.split("\n");
  const dispatching = lines.filter(l => l.includes("project.style==='cinema'"));
  assert.ok(dispatching.length >= 5, "background, header, scene, subtitle and the frame loop dispatch on cinema");
  for (const l of dispatching) assert.ok(l.includes("'picture'"), `film.js dispatches cinema without picture:\n${l.trim().slice(0, 160)}`);
  const cut = (from, to) => filmSource.slice(filmSource.indexOf(from), to ? filmSource.indexOf(to) : undefined);
  const parts = {
    background: cut("function background(t){", "function mark("),
    header: cut("function header(i,t){", "function scene(s,u,t){"),
    scene: cut("function scene(s,u,t){", "function subtitle(s,t){"),
    subtitle: cut("function subtitle(s,t){", "window.init="),
    init: cut("window.init=", "window.renderFrame="),
    frame: cut("window.renderFrame="),
  };
  for (const [name, body] of Object.entries(parts)) assert.ok(body.includes("'picture'"), `${name}() must know about the picture style`);
  for (const name of ["background", "scene", "subtitle", "frame"]) assert.ok(parts[name].includes("KEOU_PICTURE"), `${name}() must call KEOU_PICTURE`);
  assert.ok(parts.background.includes("M.attach(stickApi());M.background(t)"), "the module is attached before the first draw");
  assert.ok(/KEOU_PICTURE[^)\n]*\)\.scene\(s,u,t,/.test(parts.scene), "scene() hands the picture module the same arguments as cinema");
  assert.ok(/KEOU_PICTURE[^)\n]*\)\.subtitle\(s,t\)/.test(parts.subtitle));
  assert.ok(/KEOU_PICTURE[^)\n]*\)\.progress\(t\)/.test(parts.frame));
  assert.ok(/picture:\{ink:'#0b0b0f'/.test(filmSource), "themes.picture exists");
  assert.ok(/function stickApi\(\)\{return \{[^}]*backdropPlan/.test(filmSource), "stickApi exposes backdropPlan to the style modules");
});

test("film.js preloads the picture of every shot as well as the scene picture", () => {
  const init = filmSource.slice(filmSource.indexOf("window.init="), filmSource.indexOf("window.renderFrame="));
  assert.ok(init.includes("s.shots") && init.includes("shot.image"), "every shot image is decoded before the first frame");
  assert.ok(init.includes("s.image"), "the compatibility scene image is still preloaded");
  assert.ok(/KleoCartoon/.test(init) && /KleoReal/.test(init) && init.includes("allSettled"),
    "the look fonts are requested but a missing file must never block the render");
});

/* ---- the contract --------------------------------------------------------- */

const PY = `
import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(KEOU)})
import contract
src = pathlib.Path(${JSON.stringify(EXAMPLE)})
base = json.loads(src.read_text())
tmp = src.parent / '.picture-contract-test.json'
def check(mutate):
    c = json.loads(json.dumps(base))
    mutate(c)
    tmp.write_text(json.dumps(c))
    try:
        contract.validate(tmp)
        return 'ok'
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)
    finally:
        tmp.unlink(missing_ok=True)
cases = {
 'accepts the example': lambda c: None,
 'beats': lambda c: c['scenes'][0].__setitem__('beats', [{'kind': 'type', 'text': 'NOPE'}]),
 'missing look': lambda c: c.pop('look'),
 'unknown look': lambda c: c.__setitem__('look', 'anime'),
 'look without the picture style': lambda c: (c.__setitem__('style', 'cinema'), [s.pop('shots') for s in c['scenes']]),
 'shots without the picture style': lambda c: (c.__setitem__('style', 'stickman'), c.pop('look')),
 'no shots': lambda c: c['scenes'][0].pop('shots'),
 'five shots': lambda c: c['scenes'][0].__setitem__('shots', c['scenes'][0]['shots'] * 2),
 'three shots on the closing': lambda c: c['scenes'][2].__setitem__('shots', c['scenes'][2]['shots'] * 3),
 'unknown motion': lambda c: c['scenes'][0]['shots'][1].__setitem__('motion', 'spin'),
 'at on the first shot': lambda c: c['scenes'][0]['shots'][0].__setitem__('at', 'eye patch'),
 'at not in the voice': lambda c: c['scenes'][0]['shots'][1].__setitem__('at', 'never spoken'),
 'caption too long': lambda c: c['scenes'][0]['shots'][0].__setitem__('caption', 'X' * 41),
 'hl too long': lambda c: c['scenes'][0]['shots'][0].__setitem__('hl', 'X' * 21),
 'button too long': lambda c: c['scenes'][2].__setitem__('button', 'X' * 25),
 'unknown shot field': lambda c: c['scenes'][0]['shots'][0].__setitem__('image_prompt', 'a pirate'),
 'missing picture file': lambda c: c['scenes'][0]['shots'][0].__setitem__('image', 'img/nope.png'),
 'wrong scene kind': lambda c: c['scenes'][0].__setitem__('kind', 'hero'),
 'a shot without a picture is fine': lambda c: c['scenes'][0]['shots'][1].pop('image'),
}
print(json.dumps({k: check(f) for k, f in cases.items()}))
`;

test("contract.py accepts the picture example and refuses everything the spec forbids", (t) => {
  const py = spawnSync("python3", ["-c", PY], { encoding: "utf8" });
  if (py.error) { t.skip("python3 not available"); return }
  assert.equal(py.status, 0, py.stderr);
  const out = JSON.parse(py.stdout.trim());
  assert.equal(out["accepts the example"], "ok", "the shipped example must validate");
  assert.equal(out["a shot without a picture is fine"], "ok", "a missing picture is never fatal");
  for (const [name, result] of Object.entries(out)) {
    if (name.startsWith("accepts") || name.endsWith("is fine")) continue;
    assert.ok(result.startsWith("ValueError"), `"${name}" must be refused with a ValueError, got: ${result}`);
  }
  assert.match(out["beats"], /beats/i, "the message must name beats");
  assert.match(out["missing look"], /look/, "the message must name look");
});

test("the cartoon-pirates example is a picture project whose pictures all exist", () => {
  const project = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  assert.equal(project.style, "picture");
  assert.equal(project.look, "cartoon");
  assert.equal(project.scenes.at(-1).kind, "closing");
  const dir = dirname(EXAMPLE);
  let pictures = 0;
  for (const s of project.scenes) {
    assert.ok(!("beats" in s), `${s.id} must not carry beats`);
    assert.ok(Array.isArray(s.shots) && s.shots.length >= 1 && s.shots.length <= (s.kind === "closing" ? 2 : 4), `${s.id} shot count`);
    s.shots.forEach((shot, i) => {
      if (!shot.image) return;
      pictures++;
      assert.ok(shot.image.startsWith("img/"), "shot pictures live in img/");
      assert.ok(existsSync(join(dir, shot.image)), `${shot.image} must exist`);
      if (shot.at) assert.ok(i > 0 && s.voice.toLowerCase().includes(shot.at.toLowerCase()), `${s.id} shot ${i + 1} quotes the voice`);
      if (shot.caption) assert.ok(shot.caption.length <= 40);
    });
  }
  assert.ok(pictures >= 7, "every shot of the example ships a picture");
  const script = readFileSync(join(dir, "script.txt"), "utf8").trim().split(/\s+/).join(" ");
  assert.equal(script, project.scenes.map(s => s.voice).join(" "), "script.txt still matches the narration");
});
