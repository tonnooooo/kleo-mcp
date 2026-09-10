/**
 * Unit tests for the Kleo "picture" style (docs/PICTURE-STYLE.md §1a, §3 and §4).
 *
 * worker/keou/engine/picture.js and film.js are browser scripts, so they are evaluated three ways:
 *  - the pure planning block between the `@kleo-pure picture-plan` and `@end picture-plan` markers
 *    on its own (shot timing, the shot grammar and the Ken Burns rect it plays for each of the ten
 *    story kinds, caption fitting, the karaoke word match), including a check that the grammar in
 *    the engine and the table in docs/PICTURE-STYLE.md §1a have not drifted apart;
 *  - the whole of picture.js against a recording fake 2D context, which is the only way to see the
 *    timing that lives in S.scene: which picture is moving, how large the next one comes in, when
 *    a caption replays its entrance;
 *  - film.js against a fake page (canvas, fonts, fetch, Image) to drive window.init, so a picture
 *    that will not decode can be proved non-fatal.
 * The rest is checked as source: film.html, the film.js wiring, the fonts layer of the worker
 * image and the rules in contract.py.
 * No real canvas, no browser, no Playwright, nothing rendered.
 * Run: node --test test/engine-picture.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHOT_GRAMMAR } from "../src/shot-grammar.ts";
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
  return { shotStarts, shotMotion, shotGrammar, sceneShots, kenBurns, fitLines, groupWords, keyWord,
           flatten, shotFade, shotPunch, shotProgress, MOTIONS, SHOT_FADE, PUNCH, PUNCH_IN, MIN_SHOT,
           MOVES, LEGACY_MOVE };`)();

/* A recording 2D context. Enough of the canvas API for picture.js to draw a whole scene into it,
   so the timing that only shows up in S.scene (which picture is moving, how large it comes in,
   when a caption replays its entrance) is asserted on the calls, not on the source text.
   measureText is 0.5 em per character, taken from the size in ctx.font, so fitLines shrinks and
   wraps the way it does in the browser. */
function fakeCtx(rec) {
  const stack = [], grad = () => ({ addColorStop() { } });
  return {
    globalAlpha: 1, fillStyle: "", strokeStyle: "", font: "800 100px X", letterSpacing: "0px",
    textAlign: "left", textBaseline: "alphabetic", lineJoin: "", lineCap: "", miterLimit: 0, lineWidth: 0,
    shadowColor: "", shadowBlur: 0, shadowOffsetY: 0, imageSmoothingEnabled: false, imageSmoothingQuality: "",
    save() { stack.push(this.globalAlpha) },
    restore() { this.globalAlpha = stack.length ? stack.pop() : 1 },
    fillRect() { }, beginPath() { }, roundRect() { }, fill() { }, stroke() { },
    translate() { }, scale() { }, rotate() { },
    createLinearGradient: grad, createRadialGradient: grad,
    measureText(t) { return { width: String(t).length * (Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1]) || 100) * .5 } },
    strokeText() { },
    fillText(t, x, y) { rec.text.push({ text: String(t), x, y, alpha: this.globalAlpha, fill: this.fillStyle }) },
    // The veil is blitted as drawImage(canvas, 0, 0); only the five-argument calls are pictures.
    drawImage(img, x, y, w, h) { if (arguments.length >= 5) rec.draw.push({ img, x, y, w, h, alpha: this.globalAlpha }) },
  };
}
// picture.js in a page-shaped sandbox: no OffscreenCanvas, so the veil uses document.createElement.
function pictureModule() {
  const win = {}, doc = { createElement: () => ({ getContext: () => fakeCtx({ text: [], draw: [] }) }) };
  new Function("window", "document", "OffscreenCanvas", pictureSource)(win, doc, undefined);
  return win.KEOU_PICTURE;
}
// One frame of one scene. Returns what reached the context.
function drawScene(scene, u, { look = "cartoon", images = {}, brand = "Kleo", W = 1080, H = 1920 } = {}) {
  const rec = { text: [], draw: [] }, ctx = fakeCtx(rec);
  const M = pictureModule();
  M.attach({ ctx, W, H, project: { look, brand, style: "picture" }, images, issues: [], frameTime: scene.start + u });
  M.scene(scene, u, scene.start + u, 0);
  return rec;
}
const COVER = (iw, ih, W, H) => Math.max(W / iw, H / ih);

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
  // Every frame is a pure function of time: the renderer splits one video across parallel workers,
  // so two workers drawing the same frame must draw the same pixels.
  for (const impure of ["Math.random", "Date.now", "new Date", "performance.now"])
    assert.ok(!pictureSource.includes(impure), `picture.js must stay deterministic: no ${impure}`);
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

/* ---- the shot grammar ----------------------------------------------------- */

// One row per kind: what the engine must resolve it to, and what that must look like on screen.
// `move` and `strength` are the contract with the preset table (docs/PICTURE-STYLE.md §1a); the
// rest describes the Ken Burns the engine plays for it today.
const KINDS = [
  { kind: "hook",          move: "crash_zoom_in",   cls: "PUSH",     strength: .85, zoom: "in",   dx: 0,  dy: 0 },
  { kind: "establish",     move: "crane_down",      cls: "VERTICAL", strength: .35, zoom: "flat", dx: 0,  dy: 1 },
  { kind: "face",          move: "push_in",         cls: "PUSH",     strength: .25, zoom: "in",   dx: 0,  dy: 0 },
  { kind: "detail",        move: "track_right",     cls: "LATERAL",  strength: .3,  zoom: "flat", dx: 1,  dy: 0 },
  { kind: "detail_orbit",  move: "orbit_left",      cls: "LATERAL",  strength: .45, zoom: "in",   dx: -1, dy: 0 },
  { kind: "action",        move: "track_alongside", cls: "LATERAL",  strength: .55, zoom: "flat", dx: 1,  dy: 0 },
  { kind: "reveal",        move: "pull_out",        cls: "PUSH",     strength: .4,  zoom: "out",  dx: 0,  dy: 0 },
  { kind: "tension",       move: "push_in_dutch",   cls: "PUSH",     strength: .6,  zoom: "in",   dx: 1,  dy: 0 },
  { kind: "closing",       move: "pull_out",        cls: "PUSH",     strength: .15, zoom: "out",  dx: 0,  dy: 0 },
  { kind: "static_forced", move: "static_hold",     cls: "STILL",    strength: 0,   zoom: "flat", dx: 0,  dy: 0 },
];
// The grammar now has one home: src/shot-grammar.ts on the server, which resolves shot_kind into the concrete move
// before a storyboard is stored. The engine never sees a kind, so these tests reference the kind table only to prove
// the engine can DRAW every move the server can name, and the strengths come from the same list below.
const GRAMMAR = Object.fromEntries(KINDS.map((k) => [k.kind, {
  move: k.move, strength: k.strength, min: SHOT_GRAMMAR[k.kind].min_s, max: SHOT_GRAMMAR[k.kind].max_s,
}]));
const SHOT_KINDS_ORDER = KINDS.map((k) => k.kind);

// A wide picture on the portrait frame: plenty of horizontal overflow, so a lateral drift is never
// clamped away and the direction of every move is actually visible.
const rectAt = (move, p, strength, [iw, ih] = [2000, 1400], [W, H] = FRAMES[0]) =>
  P.kenBurns(move, iw, ih, W, H, p, 1, strength);

test("the shot grammar: ten story kinds, one camera move each, nothing else", () => {
  assert.deepEqual(SHOT_KINDS_ORDER, KINDS.map(k => k.kind), "the ten kinds, in order");
  for (const k of KINDS) assert.ok(P.MOVES[k.move], `the engine can draw ${k.move}, the move ${k.kind} resolves to`);
  for (const k of KINDS) {
    const g = GRAMMAR[k.kind];
    assert.equal(g.move, k.move, `${k.kind} is a ${k.move}`);
    assert.equal(g.strength, k.strength, `${k.kind} has strength ${k.strength}`);
    assert.equal(typeof P.MOVES[g.move], "object", `${g.move} must exist in the move table`);
    assert.equal(P.MOVES[g.move].cls, k.cls, `${k.move} belongs to the ${k.cls} class`);
    assert.ok(g.min > 0 && g.max > g.min, `${k.kind} carries a duration range`);
    assert.ok(typeof g.move === "string", "one move per kind, never a list");
  }
  // The sequencing rules count classes and loud moves, so both have to be on the move itself.
  assert.deepEqual([...new Set(Object.values(P.MOVES).map(m => m.cls))].sort(),
    ["LATERAL", "PUSH", "STILL", "VERTICAL"], "four move classes and no fifth");
  const loud = Object.entries(P.MOVES).filter(([, m]) => m.loud).map(([n]) => n).sort();
  assert.deepEqual(loud, ["crash_zoom_in", "orbit_left", "push_in_dutch"], "the loud moves are marked as such");
});

test("the grammar table in the engine and the one in docs/PICTURE-STYLE.md §1a are the same table", () => {
  const doc = readFileSync(join(ROOT, "docs", "PICTURE-STYLE.md"), "utf8");
  const sec = doc.slice(doc.indexOf("## 1a."), doc.indexOf("## 2."));
  assert.ok(sec.length > 500, "docs/PICTURE-STYLE.md must keep the §1a shot grammar section");
  const rows = sec.split("\n").filter(l => /^\|\s*`/.test(l)).map(l => l.split("|").slice(1, -1).map(c => c.trim()))
    .filter(r => r[0] !== "`shot_kind`");                                  // the header row of the table
  assert.equal(rows.length, KINDS.length, "the documented table has one row per kind");
  for (const [kindCell, , moveCell, clsCell, durCell, strengthCell] of rows) {
    const kind = kindCell.replace(/`/g, ""), g = GRAMMAR[kind];
    assert.ok(g, `the doc documents an unknown kind: ${kind}`);
    assert.equal(moveCell.replace(/`/g, ""), g.move, `${kind}: the doc and the engine disagree on the move`);
    assert.equal(clsCell, P.MOVES[g.move].cls, `${kind}: the doc and the engine disagree on the move class`);
    const [min, max] = durCell.replace(/\s*s$/, "").split(/[–-]/).map(Number);
    assert.deepEqual([min, max], [g.min, g.max], `${kind}: the doc and the engine disagree on the duration`);
    assert.equal(Number(strengthCell), g.strength, `${kind}: the doc and the engine disagree on the strength`);
  }
  for (const rule of [
    "no morphing, no extra fingers, no warping faces, no floating objects, no camera shake beyond the specified move, no zoom, no text, no watermark, no logo",
    "multiplied by **0.7** and capped at **3.0 s** for 9:16",
  ]) assert.ok(sec.includes(rule), `§1a must state: ${rule}`);
});

test("the engine draws the move and the strength the server resolved, and the old spellings still work", () => {
  for (const k of KINDS) {
    // The server hands the engine the resolved move and its strength; shot_kind never reaches the GPU.
    const g = P.shotGrammar({ motion: k.move, strength: k.strength }, 3);
    assert.deepEqual([g.move, g.strength, g.cls], [k.move, k.strength, k.cls]);
    assert.equal(g.kind, null, "the story kind stays on the server");
    assert.deepEqual(P.shotGrammar({ motion: k.move, strength: k.strength }, 0), P.shotGrammar({ motion: k.move, strength: k.strength }, 7),
      `${k.kind} does not depend on where the shot sits`);
    assert.equal(P.shotGrammar({ motion: k.move, strength: k.strength }, 1).move, k.move,
      "a named move is drawn as named, wherever the shot sits");
  }
  assert.deepEqual(P.shotGrammar({ motion: "left" }, 0), { kind: null, move: "track_left", strength: 1, cls: "LATERAL", loud: false });
  assert.equal(P.shotGrammar({ motion: "out" }, 3).move, "pull_out");
  assert.deepEqual([0, 1, 2, 3, 4].map(i => P.shotGrammar({}, i).move),
    ["push_in", "pull_out", "track_left", "track_right", "push_in"], "no field at all: the deprecated index rotation");
  assert.equal(P.shotGrammar({ motion: "money_shot" }, 1).move, "pull_out", "an unknown kind falls back, it never throws");
  assert.equal(P.shotGrammar({ motion: "constructor" }, 0).move, "push_in", "an inherited property is not a kind");
  assert.equal(P.shotGrammar(null, 2).move, "track_left");
  assert.equal(P.shotGrammar({ shot_kind: 7 }, 0).move, "push_in", "a kind that is not a string is ignored");
});

test("every kind covers the frame, keeps the picture undistorted and is deterministic", () => {
  for (const k of KINDS) for (const [W, H] of FRAMES) for (const [iw, ih] of IMAGES) for (const p of STEPS)
    for (const punch of [1, 1.03]) {
      const r = P.kenBurns(k.move, iw, ih, W, H, p, punch, GRAMMAR[k.kind].strength);
      assert.ok(covers(r, W, H), `uncovered: ${k.kind} ${iw}x${ih} on ${W}x${H} at ${p} -> ${JSON.stringify(r)}`);
      assert.ok(Math.abs(r.w / r.h - iw / ih) < 1e-9, `${k.kind} must never distort the picture`);
      assert.ok(r.w > 0 && r.h > 0 && Number.isFinite(r.x) && Number.isFinite(r.y));
      assert.deepEqual(P.kenBurns(k.move, iw, ih, W, H, p, punch, GRAMMAR[k.kind].strength), r,
        "every frame is a pure function of its arguments: the renderer splits the video across workers");
      assert.equal(r.move, k.move);
      assert.equal(r.cls, k.cls);
    }
});

test("every kind moves the way its story asks: direction, and how much", () => {
  for (const k of KINDS) {
    const s = GRAMMAR[k.kind].strength;
    const all = STEPS.map(p => rectAt(k.move, p, s));
    const [z0, z1] = [all[0].zoom, all.at(-1).zoom];
    if (k.zoom === "in") assert.ok(z1 > z0 + 1e-9, `${k.kind} must push in (${z0} → ${z1})`);
    if (k.zoom === "out") assert.ok(z1 < z0 - 1e-9, `${k.kind} must pull out (${z0} → ${z1})`);
    if (k.zoom === "flat") assert.ok(Math.abs(z1 - z0) < 1e-9, `${k.kind} holds its zoom (${z0} → ${z1})`);
    const dx = all.at(-1).panX - all[0].panX, dy = all.at(-1).panY - all[0].panY;
    assert.equal(Math.sign(dx), k.dx, `${k.kind}: horizontal drift ${dx}`);
    assert.equal(Math.sign(dy), k.dy, `${k.kind}: vertical drift ${dy}`);
    for (const r of all) {
      assert.ok(Math.abs(r.panX) <= FRAMES[0][0] * .05 + EPS, `${k.kind} never slides half a frame away`);
      assert.ok(r.zoom <= 1.2 + EPS, `${k.kind} never blows the picture up past 1.2 (${r.zoom})`);
      assert.ok(r.zoom >= 1 - EPS, `${k.kind} never zooms below the cover fit (${r.zoom})`);
    }
    // Monotonic: a camera move that changes its mind mid-shot reads as a wobble, never as a camera.
    const mono = list => list.every((v, i) => !i || v >= list[i - 1] - EPS) || list.every((v, i) => !i || v <= list[i - 1] + EPS);
    assert.ok(mono(all.map(r => r.zoom)), `${k.kind} zooms one way only`);
    assert.ok(mono(all.map(r => r.panX)), `${k.kind} drifts one way only`);
    assert.ok(mono(all.map(r => r.panY)), `${k.kind} drifts one way only`);
  }
});

test("a hook punches, a face barely breathes, a closing barely breathes the other way", () => {
  const span = k => { const s = GRAMMAR[k].strength, m = GRAMMAR[k].move;
    const all = STEPS.map(p => rectAt(m, p, s).zoom); return Math.abs(all.at(-1) - all[0]) };
  assert.ok(Math.abs(span("hook") - .18 * GRAMMAR.hook.strength) < 1e-9, "the hook crashes in by 15%");
  assert.ok(span("face") <= .03, `a face is a slow push, not a zoom (${span("face")})`);
  assert.ok(span("closing") <= .02, `a closing barely drifts (${span("closing")})`);
  assert.ok(span("hook") > span("tension") && span("tension") > span("face"), "hook > tension > face");
  // Front-loaded: the crash has done most of its travel in the first third of the shot.
  const z = p => rectAt("crash_zoom_in", p, 1).zoom;
  assert.ok((z(.3) - z(0)) / (z(1) - z(0)) > .6, "a crash zoom lands most of its travel at once");
  const e = p => rectAt("push_in", p, 1).zoom;
  assert.ok(Math.abs((e(.5) - e(0)) / (e(1) - e(0)) - .5) < 1e-9, "a push-in is even, it does not crash");
});

test("an action shot travels further than a detail, and a detail_orbit both slides and pushes", () => {
  const travel = k => { const g = GRAMMAR[k], all = STEPS.map(p => rectAt(g.move, p, g.strength).panX);
    return Math.abs(all.at(-1) - all[0]) };
  assert.ok(travel("action") > travel("detail"), "the action shot is the livelier lateral");
  assert.ok(travel("detail") > 0 && travel("tension") > 0, "a lean is still a lean");
  const orbit = STEPS.map(p => rectAt("orbit_left", p, GRAMMAR.detail_orbit.strength));
  assert.ok(orbit.at(-1).panX < orbit[0].panX && orbit.at(-1).zoom > orbit[0].zoom,
    "an orbit slides and pushes at the same time: that is what makes it read as an orbit");
  const crane = STEPS.map(p => rectAt("crane_down", p, GRAMMAR.establish.strength));
  assert.ok(crane.at(-1).panY > crane[0].panY && crane.every(r => r.panX === 0), "a crane is vertical only");
});

test("static_forced holds absolutely still, at any strength, on any picture", () => {
  for (const [W, H] of FRAMES) for (const [iw, ih] of IMAGES) {
    const box = r => [r.x, r.y, r.w, r.h, r.zoom, r.panX, r.panY];
    const first = box(P.kenBurns("static_hold", iw, ih, W, H, 0, 1, 0));
    for (const p of STEPS) for (const k of [0, .5, 1])
      assert.deepEqual(box(P.kenBurns("static_hold", iw, ih, W, H, p, 1, k)), first,
        "a static hold is the same rect at every time and every strength: the frame is frozen by design");
    assert.deepEqual(first.slice(4), [1, 0, 0], "and it sits exactly on the cover fit, dead centre");
  }
});

test("the deprecated motion names render exactly as they always did", () => {
  const same = (a, b) => assert.deepEqual(a, b);
  for (const [motion, move] of Object.entries(P.LEGACY_MOVE)) for (const p of STEPS)
    same(P.kenBurns(motion, 720, 1280, 1080, 1920, p, 1), P.kenBurns(move, 720, 1280, 1080, 1920, p, 1, 1));
  assert.equal(P.kenBurns("in", 720, 1280, 1080, 1920, 1, 1).zoom, 1.1);
  assert.equal(P.kenBurns("out", 720, 1280, 1080, 1920, 0, 1).zoom, 1.1);
  assert.equal(P.kenBurns("left", 720, 1280, 1080, 1920, .5, 1).zoom, 1.04);
  assert.equal(P.kenBurns("in", 720, 1280, 1080, 1920, 0, 1).move, "push_in", "and they carry their new name");
  assert.equal(P.kenBurns("nonsense", 720, 1280, 1080, 1920, 0, 1).move, "push_in", "an unknown move pushes in");
});

test("strength scales the amplitude and nothing else", () => {
  const z = (move, p, k) => rectAt(move, p, k).zoom;
  assert.ok(Math.abs((z("push_in", 1, .5) - 1) / (z("push_in", 1, 1) - 1) - .5) < 1e-9, "half the strength, half the push");
  assert.equal(z("push_in", 1, 0), 1, "strength 0 is a static frame");
  assert.equal(z("push_in", 1, -3), z("push_in", 1, 0), "strength is clamped to 0…1");
  assert.equal(z("push_in", 1, 9), z("push_in", 1, 1));
  assert.equal(z("push_in", 1, undefined), z("push_in", 1, 1), "no strength given means the full move");
  const a = rectAt("track_right", 1, .5).panX - rectAt("track_right", 0, .5).panX;
  const b = rectAt("track_right", 1, 1).panX - rectAt("track_right", 0, 1).panX;
  assert.ok(a > 0 && b > a, "a weaker lateral travels less far");
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

test("karaoke: an s.words entry that holds several script words never shifts the highlight", () => {
  // prepare.py glues a token with no letters onto the entry before it ("back" + "—"), and splits
  // nothing: "don't" is one entry but two spoken tokens. The caption group splits on whitespace,
  // so entry-by-entry matching drifts by one word for the rest of the line.
  const said = [
    { text: "She", start: 1 }, { text: "never", start: 1.5 }, { text: "came", start: 2 },
    { text: "back —", start: 2.5 }, { text: "she", start: 3 }, { text: "didn't", start: 3.5 }, { text: "dig.", start: 4 },
  ];
  const timed = P.groupWords(said, { text: "came back — she didn't dig.", start: 2 });
  assert.deepEqual(timed.map(w => w.text), ["came", "back", "—", "she", "didn't", "dig."]);
  assert.deepEqual(timed.map(w => w.start), [2, 2.5, null, 3, 3.5, 4],
    "every written word keeps the time of the word actually spoken; the dash gets none");
  const late = P.groupWords(said, { text: "she didn't dig.", start: 3 });
  assert.deepEqual(late.map(w => w.start), [3, 3.5, 4], "a group that opens after the merged entry is still aligned");
  assert.deepEqual(P.groupWords(said, { text: "came back — she didn't dig.", start: 99 }).map(w => w.start),
    [2, 2.5, null, 3, 3.5, 4], "the text fallback matches on the same token stream");
  assert.deepEqual(P.groupWords([{ text: "—", start: 1 }, { text: "Go", start: 2 }], { text: "— Go", start: 1 }).map(w => w.start),
    [null, 2], "an entry that says nothing at all is skipped, not counted");
  assert.deepEqual(P.groupWords(said, { text: "— —", start: 1 }).map(w => w.start), [null, null],
    "a group with nothing spoken in it carries no time");
  assert.deepEqual(P.flatten([{ text: "17,600", start: 5 }]).map(x => x.k), ["17", "600"],
    "one written word can hold several spoken tokens");
});

test("shot timing: an `at` still finds its word across a merged s.words entry", () => {
  const s = {
    start: 0, end: 8, words: [
      { text: "She", start: 0 }, { text: "buried", start: .5 }, { text: "it —", start: 1 },
      { text: "she", start: 1.5 }, { text: "never", start: 2 }, { text: "came", start: 2.5 }, { text: "back.", start: 3 },
    ],
  };
  assert.ok(Math.abs(P.shotStarts(s, [{}, { at: "it — she never" }], 8)[1] - (1 - .12)) < 1e-9,
    "the cut lands on the entry that carries the first quoted word");
  assert.ok(Math.abs(P.shotStarts(s, [{}, { at: "never came back" }], 8)[1] - (2 - .12)) < 1e-9,
    "a quote after the merged entry is not shifted by one word");
  assert.deepEqual(P.shotStarts(s, [{}, { at: "—" }], 8), P.shotStarts(s, [{}, {}], 8),
    "a quote with nothing spoken in it falls back to the even split");
  // A stand-alone "$" or "%" is a script token that carries no letters, so prepare.py glues it
  // onto the number before it: the entry reads "500 $" while the quote reads "500" then "$".
  const money = {
    start: 0, end: 8, words: [
      { text: "It", start: 0 }, { text: "cost", start: .5 }, { text: "500 $", start: 1 },
      { text: "per", start: 1.5 }, { text: "year.", start: 2 },
    ],
  };
  assert.ok(Math.abs(P.shotStarts(money, [{}, { at: "500 $ per" }], 8)[1] - (1 - .12)) < 1e-9,
    "the cut lands on the spoken number, not on the even split");
});

test("a picture keeps moving while the next one fades over it", () => {
  const mid = P.shotProgress(2.5, 5, true), cut = P.shotProgress(5, 5, true), after = P.shotProgress(5.2, 5, true);
  assert.ok(cut > mid && after > cut, "the outgoing picture travels on through the crossfade");
  assert.ok(Math.abs(P.shotProgress(5 + P.SHOT_FADE, 5, true) - 1) < 1e-9, "it lands exactly when the fade ends");
  assert.equal(P.shotProgress(5, 5, false), 1, "the last picture of a scene has nothing to fade under and lands on the cut");
  assert.equal(P.shotProgress(-3, 5, true), 0);
  assert.equal(P.shotProgress(99, 5, true), 1);
  assert.ok(Number.isFinite(P.shotProgress(1, 0, true)));
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

/* ---- the scene, drawn into a recording context ---------------------------- */

const SQUARE = { width: 1024, height: 1024 };
const cinema = () => ({
  id: "01-hook", kind: "cinema", accent: "amber", title: "SHE NEVER CAME BACK", start: 10, end: 20,
  captions: [], words: [], shots: [{ image: "a" }, { image: "b" }],
});

test("the 3% punch fires on a cut inside a scene, never on the scene's own first frame", () => {
  const s = cinema(), images = { a: SQUARE, b: SQUARE };
  const plain = 1024 * COVER(1024, 1024, 1080, 1920);      // shot 1 moves 'in': zoom 1.00 at p=0
  const open = drawScene(s, 0, { images });
  assert.equal(open.draw.length, 1, "one picture on the opening frame");
  assert.ok(Math.abs(open.draw[0].w - plain) < 1e-6,
    `a scene opens on a hard cut and must not be punched 3% out of frame (${open.draw[0].w} vs ${plain})`);
  const cut = drawScene(s, 5, { images });                 // shot 2 starts at the even split, moves 'out': zoom 1.10
  assert.equal(cut.draw.length, 2, "the outgoing picture is drawn underneath the incoming one");
  assert.ok(Math.abs(cut.draw[1].w / (plain * 1.1) - 1.03) < 1e-6, "the incoming picture arrives 3% large");
  assert.ok(Math.abs(drawScene(s, 5.3, { images }).draw.at(-1).w / (plain * 1.1) - 1.03) > .02, "and settles");
});

test("a static_forced shot does not move on screen, not even the 3% punch of the cut", () => {
  const images = { a: SQUARE, b: SQUARE };
  // As the server hands them over: the kind is already resolved into a move and a strength.
  const s = { ...cinema(), shots: [{ image: "a", motion: "push_in", strength: .25 },
                                   { image: "b", motion: "static_hold", strength: 0 }] };
  const plain = 1024 * COVER(1024, 1024, 1080, 1920);
  const held = [5, 5.15, 5.3, 7, 9.9].map(u => drawScene(s, u, { images }).draw.at(-1));
  for (const r of held) {
    assert.ok(Math.abs(r.w - plain) < 1e-6, `a static hold must arrive at the cover fit and stay there (${r.w} vs ${plain})`);
    assert.deepEqual([r.x, r.y], [held[0].x, held[0].y], "and never travel");
  }
  // The shot before it is a `face`: a real, if slow, push. The kinds are read, not ignored.
  const face = [0, 2, 4.9].map(u => drawScene(s, u, { images }).draw[0].w);
  assert.ok(face[1] > face[0] && face[2] > face[1], `a face shot still pushes in gently (${face})`);
  assert.ok(face.at(-1) / face[0] < 1.03, "gently: a quarter of a full push");
});

test("a resolved crash zoom opens harder than the old index rotation, which still works", () => {
  const images = { a: SQUARE, b: SQUARE };
  const at = (shots, u) => drawScene({ ...cinema(), shots }, u, { images }).draw[0].w;
  const legacy = [0, .5].map(u => at([{ image: "a" }, { image: "b" }], u));            // no field: 'in' by index
  const hook = [0, .5].map(u => at([{ image: "a", motion: "crash_zoom_in", strength: .85 }, { image: "b" }], u));
  assert.ok(hook[1] > legacy[1], `a hook opens harder than the deprecated rotation (${hook[1]} vs ${legacy[1]})`);
  const kept = [0, .5].map(u => at([{ image: "a", motion: "left" }, { image: "b" }], u));
  assert.ok(Math.abs(kept[0] - 1024 * COVER(1024, 1024, 1080, 1920) * 1.04) < 1e-6,
    "and a storyboard written before the grammar still renders its `motion`");
});

test("the outgoing picture keeps its Ken Burns running through the crossfade", () => {
  const s = cinema(), images = { a: SQUARE, b: SQUARE };
  const at = u => drawScene(s, u, { images }).draw;
  const [w0, w1, w2] = [at(5)[0].w, at(5.15)[0].w, at(5.3)[0].w];
  assert.ok(w1 > w0 && w2 > w1, `the picture being faded out must not freeze (${w0} ${w1} ${w2})`);
  assert.ok(at(5)[1].alpha < at(5.3)[1].alpha, "while the incoming one fades in over it");
  assert.equal(at(5)[0].alpha, 1, "the outgoing picture stays fully opaque underneath");
});

test("a closing with two shots replays the caption entrance on the cut", () => {
  const base = {
    id: "05-closing", kind: "closing", accent: "cyan", title: "FOLLOW FOR PART TWO", button: "Follow",
    start: 0, end: 8, captions: [], words: [],
  };
  const images = { a: SQUARE, b: SQUARE };
  const alpha = (rec, word) => rec.text.filter(x => x.text === word).map(x => x.alpha);
  const swap = { ...base, shots: [{ image: "a" }, { image: "b", caption: "NEXT TIME WE DIG" }] };
  assert.deepEqual(alpha(drawScene(swap, 3.9, { images }), "FOLLOW"), [1], "the first caption is settled before the cut");
  const onCut = alpha(drawScene(swap, 4, { images }), "NEXT");
  assert.equal(onCut.length, 1);
  assert.ok(onCut[0] < .05, `new words on the cut must animate in, not appear (alpha ${onCut[0]})`);
  assert.ok(alpha(drawScene(swap, 4.06, { images }), "NEXT")[0] > onCut[0], "and keep rising");
  assert.deepEqual(alpha(drawScene(swap, 4.5, { images }), "NEXT"), [1], "settled a quarter of a second later");
  const hold = { ...base, shots: [{ image: "a" }, { image: "b" }] };
  assert.deepEqual(alpha(drawScene(hold, 4, { images }), "FOLLOW"), [1],
    "words that do not change keep the scene clock: the entrance is never replayed under the viewer");
});

test("a shot whose picture never loaded is drawn as the accent gradient, not skipped", () => {
  // film.js leaves a picture it could not decode out of `images`; the shot must still play.
  const s = { ...cinema(), shots: [{ image: "a" }, { image: "gone", caption: "NEVER CAME BACK" }] };
  const rec = drawScene(s, 6, { images: { a: SQUARE } });
  assert.equal(rec.draw.length, 0, "no picture is drawn, and nothing throws");
  assert.ok(rec.text.some(x => x.text === "NEVER"), "the words of the shot are still on screen");
  assert.ok(drawScene(s, 0, { images: { a: SQUARE } }).draw.length === 1, "the shot that did load is unaffected");
});

/* ---- film.js init: a broken picture must not cost the job ------------------ */

// film.js is a page script; run it in a sandbox that gives it a canvas, fonts, fetch and Image.
function loadFilm(decode) {
  const win = {}, warned = [], rec = { text: [], draw: [] };
  const doc = {
    getElementById: () => ({ getContext: () => fakeCtx(rec) }),
    createElement: () => ({ getContext: () => fakeCtx({ text: [], draw: [] }) }),
    fonts: { load: async () => { }, ready: Promise.resolve(), check: () => true },
  };
  class FakeImage {
    constructor() { this.width = 1024; this.height = 1024; this.src = "" }
    async decode() { return decode(this.src, this) }
  }
  const fetchStub = async () => ({ json: async () => ({}) });
  new Function("window", "document", "Image", "fetch", "console", filmSource)(
    win, doc, FakeImage, fetchStub, { warn: (...a) => warned.push(a.join(" ")), log() { } });
  return { win, warned };
}
const shotTimeline = () => ({
  duration: 10, fps: 30,
  scenes: [{ id: "01-hook", kind: "cinema", start: 0, end: 10, captions: [], words: [], shots: [{ image: "img/01-hook-s1.png" }, { image: "img/01-hook-s2.png" }] }],
});

test("init: one unreadable picture is recorded and the render carries on", async () => {
  const broken = "img/01-hook-s2.png";
  const { win, warned } = loadFilm(src => { if (src.endsWith(broken)) throw Error("Truncated PNG"); });
  const out = await win.init({ style: "picture", format: "9:16", look: "cartoon" }, shotTimeline(), 540);
  assert.ok(out, "init must resolve: a paid job is not lost over one corrupt shot");
  assert.equal(win.KEOU_IMAGE_ISSUES.length, 1, "the failure is recorded, not swallowed");
  assert.equal(win.KEOU_IMAGE_ISSUES[0].image, broken);
  assert.match(win.KEOU_IMAGE_ISSUES[0].detail, /Truncated PNG/);
  assert.ok(warned.some(w => w.includes("PICTURE_LOAD_FAILED") && w.includes(broken)), "and logged for the worker");
  assert.deepEqual(out.images, win.KEOU_IMAGE_ISSUES, "init hands the list back to its caller");
});

test("init: a picture that decodes but has no pixels counts as missing", async () => {
  const { win } = loadFilm((src, img) => { if (src.endsWith("s1.png")) { img.width = 0; img.height = 0 } });
  await win.init({ style: "picture", format: "9:16", look: "cartoon" }, shotTimeline(), 540);
  assert.deepEqual(win.KEOU_IMAGE_ISSUES.map(x => x.image), ["img/01-hook-s1.png"]);
});

test("init: every picture readable leaves nothing to report", async () => {
  const { win, warned } = loadFilm(() => { });
  assert.equal(await win.init({ style: "picture", format: "9:16", look: "cartoon" }, shotTimeline(), 540), true);
  assert.deepEqual(win.KEOU_IMAGE_ISSUES, []);
  assert.deepEqual(warned, []);
});

test("init: a broken picture is never fatal, in any style, and is reported", async () => {
  // Every drawing path guards on img.width (film.js backdrop() and the image-kind branch), so a picture that cannot
  // be decoded costs that one picture, not the whole paid render. It must still be visible: KEOU_IMAGE_ISSUES.
  for (const style of ["picture", "cinema", "editorial"]) {
    const { win } = loadFilm(() => { throw Error("Truncated PNG") });
    const tl = { duration: 10, fps: 30, scenes: [{ id: "01", kind: "image", start: 0, end: 10, captions: [], image: "img/01.png" }] };
    const r = await win.init({ style, format: "9:16", look: "cartoon" }, tl, 540);
    assert.equal(r && r.ok, true, style);                       // init resolves, the render goes on
    assert.equal(win.KEOU_IMAGE_ISSUES.length, 1, style);
    assert.deepEqual(r.images, win.KEOU_IMAGE_ISSUES, style);   // and hands the same record back
    assert.match(JSON.stringify(win.KEOU_IMAGE_ISSUES[0]), /img\/01\.png/);
  }
});

/* ---- the worker image ----------------------------------------------------- */

test("Dockerfile.keou pins the two OFL fonts to a commit and verifies what it downloaded", () => {
  const df = readFileSync(join(ROOT, "worker", "Dockerfile.keou"), "utf8");
  const fonts = df.slice(df.indexOf("# --- Kleo picture-style fonts"), df.indexOf("COPY worker/kleo_pictures.py"));
  assert.ok(fonts, "the fonts layer must still exist");
  assert.ok(!/google\/fonts\/(raw\/)?main\//.test(fonts), "the fonts must not be fetched from a moving branch");
  const ref = /ARG GOOGLE_FONTS_REF=([0-9a-f]{40})\b/.exec(fonts);
  assert.ok(ref, "the google/fonts commit must be pinned to a full 40-character sha");
  const urls = [...fonts.matchAll(/raw\.githubusercontent\.com\/google\/fonts\/\$\{GOOGLE_FONTS_REF\}\/(\S+?)"/g)].map(m => m[1]);
  assert.deepEqual(urls, ["ofl/baloo2/Baloo2%5Bwght%5D.ttf", "ofl/oswald/Oswald%5Bwght%5D.ttf"],
    "Baloo 2 for cartoon.ttf, Oswald for real.ttf, both at the pinned commit");
  assert.equal((fonts.match(/\b[0-9a-f]{40}\b/g) || []).length, 3, "the commit plus one expected digest per font");
  assert.ok(/\b683200\b/.test(fonts) && /\b172088\b/.test(fonts), "the exact byte length of each font is checked too");
  assert.ok(fonts.includes("hashlib.sha1") && fonts.includes("sys.exit"), "a mismatch must fail the build, not warn");
  // engine/assets/ lives inside worker/keou, so the fonts have to land after that COPY.
  assert.ok(df.indexOf("COPY worker/keou /opt/kleo/keou") < df.indexOf("# --- Kleo picture-style fonts"),
    "the fonts layer stays after the engine COPY");
});
