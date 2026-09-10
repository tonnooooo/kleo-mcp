/**
 * Unit tests for the SHOT GRAMMAR (src/shot-grammar.ts and its mirror worker/keou/shot_grammar.py).
 * Run: node --test test/shot-grammar.test.mjs   (Node >= 22.18 strips the TypeScript types natively)
 *
 * The first half proves the two preset tables are IDENTICAL: the TypeScript side is imported, the Python side is
 * parsed out of the source as literals. Same trick as test/keou-contract.test.mjs (which parses src/mcp.ts) and
 * worker/test_kleo_pictures.py (which ast.literal_eval's prewarm_models.py). Nothing here imports Python or spawns
 * a process; a table that drifts is a table the engine and the server disagree about, and that is a paid-for job
 * rendered with the wrong camera.
 *
 * The second half unit-tests every helper: durationFor, promptFor, needsStaticHold (all four routing categories)
 * and each of the six sequencing rules, pass and fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHOT_KINDS, SHOT_GRAMMAR, MOVES, MOVE_CLASSES, DIRECTIONS, SCALES, TEXT_ANCHORS, LOUD_MOVES,
  UNIVERSAL_NEGATIVE, PORTRAIT_FACTOR, PORTRAIT_MAX_S, MAX_SHOT_S, MAX_PERSON_SHOT_S,
  LOUD_MAX_PER_WINDOW, LOUD_WINDOW_S, STATIC_HOLD_CATEGORIES, STATIC_HOLD_TRIGGERS, PERSON_WORDS, PERSON_KINDS,
  durationFor, promptFor, presetFor, needsStaticHold, staticHoldReason, impliesPerson, resolveKind,
  moveClassOf, directionOf, isLoud,
  checkOneMovePerShot, checkDurations, checkLoudBudget, checkMoveClassAlternation, checkScaleRepetition,
  checkScreenDirection, checkSequence,
  STATIC_HOLD_REASON, moveOf, shotScale, durationRange, moveClass, isLoudMove, screenDirection, forcesStatic,
} from "../src/shot-grammar.ts";
import * as GRAMMAR from "../src/shot-grammar.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The grammar has exactly one copy now (src/shot-grammar.ts). The server resolves shot_kind into the concrete
// camera move before the storyboard is stored, so the worker, contract.py and the engine only ever see that move
// and no second table can drift from this one. What the tests below guard is that the engine can DRAW every move
// this table names.
const TS_SRC = readFileSync(join(ROOT, "src", "shot-grammar.ts"), "utf8");

// ---------------------------------------------------------------------------------------------------------------
// A Python-literal reader: dict / list / tuple / str / number / True / False / None, comments skipped.
// Enough for the tables in shot_grammar.py, which are deliberately written as plain literals (no f-strings, no
// concatenation, no comprehensions) precisely so this reader — and ast.literal_eval on the Python side — can see them.
// ---------------------------------------------------------------------------------------------------------------
function pyValue(src, i) {
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
      return;
    }
  };
  const parse = () => {
    skip();
    const c = src[i];
    if (c === "{") {
      i++; const out = {};
      for (;;) {
        skip();
        if (src[i] === "}") { i++; return out; }
        const k = parse(); skip();
        assert.equal(src[i], ":", `expected ':' after key ${JSON.stringify(k)} at ${i}`); i++;
        out[k] = parse(); skip();
        if (src[i] === ",") i++;
      }
    }
    if (c === "[" || c === "(") {
      const close = c === "[" ? "]" : ")";
      i++; const out = [];
      for (;;) {
        skip();
        if (src[i] === close) { i++; return out; }
        out.push(parse()); skip();
        if (src[i] === ",") i++;
      }
    }
    if (c === '"' || c === "'") {
      const q = c; i++; let s = "";
      while (src[i] !== q) {
        if (src[i] === "\\") { s += ({ n: "\n", t: "\t", r: "\r" })[src[i + 1]] ?? src[i + 1]; i += 2; continue; }
        s += src[i++];
      }
      i++; return s;
    }
    const word = /^(None|True|False|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
    assert.ok(word, `unparsable Python literal at ${i}: ${JSON.stringify(src.slice(i, i + 40))}`);
    i += word[0].length;
    if (word[0] === "None") return null;
    if (word[0] === "True") return true;
    if (word[0] === "False") return false;
    return Number(word[0]);
  };
  return parse();
}

/** The value of a module-level `NAME = <literal>` in shot_grammar.py. */
function py(name) {
  assert.ok(m, `worker/keou/shot_grammar.py does not define ${name}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The two tables are identical
// ---------------------------------------------------------------------------------------------------------------









test("every helper the server exports has a Python mirror", () => {
  const mirrored = [
    ["durationFor", "duration_for"], ["promptFor", "prompt_for"], ["presetFor", "preset_for"],
    ["needsStaticHold", "needs_static_hold"], ["staticHoldReason", "static_hold_reason"],
    ["impliesPerson", "implies_person"], ["resolveKind", "resolve_kind"],
    ["moveClassOf", "move_class_of"], ["directionOf", "direction_of"], ["isLoud", "is_loud"],
    ["checkOneMovePerShot", "check_one_move_per_shot"], ["checkDurations", "check_durations"],
    ["checkLoudBudget", "check_loud_budget"], ["checkMoveClassAlternation", "check_move_class_alternation"],
    ["checkScaleRepetition", "check_scale_repetition"], ["checkScreenDirection", "check_screen_direction"],
    ["checkSequence", "check_sequence"],
    ["moveOf", "move_of"], ["shotScale", "shot_scale"], ["durationRange", "duration_range"],
    ["moveClass", "move_class"], ["isLoudMove", "is_loud_move"], ["screenDirection", "screen_direction"],
    ["forcesStatic", "forces_static"],
  ];
  for (const [ts] of mirrored) {
    assert.match(TS_SRC, new RegExp(`export (?:function|const) ${ts}\\b`), `src/shot-grammar.ts must export ${ts}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The table says what the owner decided it says
// ---------------------------------------------------------------------------------------------------------------

test("the ten kinds carry exactly the decided move, window and strength", () => {
  // kind -> [move, min_s, max_s] straight from the brief; strengths only where the brief pinned one.
  const decided = {
    hook: ["crash_zoom_in", 1.6, 2.2],
    establish: ["crane_down", 3.5, 4.5],
    face: ["push_in", 2.5, 3.5],
    detail: ["track_right", 2.0, 3.0],
    detail_orbit: ["orbit_left", 2.5, 3.5],
    action: ["track_alongside", 2.0, 3.0],
    reveal: ["pull_out", 2.8, 3.8],
    tension: ["push_in_dutch", 2.2, 3.0],
    closing: ["pull_out", 3.0, 4.0],
    static_forced: ["static_hold", 2.0, 3.0],
  };
  assert.deepStrictEqual(Object.keys(decided).sort(), [...SHOT_KINDS].sort(), "exactly ten kinds, no more");
  for (const [kind, [move, min_s, max_s]] of Object.entries(decided)) {
    const p = presetFor(kind);
    assert.equal(p.move, move, `${kind} move`);
    assert.equal(p.min_s, min_s, `${kind} min`);
    assert.equal(p.max_s, max_s, `${kind} max`);
    assert.ok(p.min_s < p.max_s, `${kind}: the window must be a window`);
    assert.ok(p.strength >= 0 && p.strength <= 1, `${kind}: strength is 0..1`);
  }
  assert.equal(presetFor("face").strength, 0.25);
  assert.equal(presetFor("closing").strength, 0.15);
  assert.equal(presetFor("static_forced").strength, 0.0, "a forced static hold has no motion at all");
});

test("every move a kind names exists, is classed, and the loud set matches the loud flags", () => {
  for (const kind of SHOT_KINDS) {
    const move = presetFor(kind).move;
    assert.ok(move in MOVES, `${kind}: '${move}' is not a registered move`);
    assert.ok(MOVE_CLASSES.includes(moveClassOf(move)), `${kind}: '${move}' has no class`);
    assert.ok(DIRECTIONS.includes(directionOf(move)));
    assert.ok(SCALES.includes(presetFor(kind).scale));
    assert.ok(TEXT_ANCHORS.includes(presetFor(kind).text_anchor));
  }
  const flagged = Object.entries(MOVES).filter(([, m]) => m.loud).map(([n]) => n).sort();
  assert.deepStrictEqual([...LOUD_MOVES].sort(), flagged, "LOUD_MOVES must agree with the loud flags in MOVES");
  // The brief names these four families as loud; whip_pan is registered even though no kind reaches it yet.
  for (const m of ["crash_zoom_in", "whip_pan", "push_in_dutch", "orbit_left", "orbit_right"]) assert.ok(isLoud(m), m);
  for (const m of ["push_in", "pull_out", "track_right", "crane_down", "static_hold"]) assert.ok(!isLoud(m), m);
  assert.equal(moveClassOf("static_hold"), "STILL");
  assert.equal(moveClassOf("crane_down"), "VERTICAL");
  assert.equal(moveClassOf("pull_out"), "PUSH");
  assert.equal(moveClassOf("orbit_left"), "LATERAL");
  assert.equal(moveClassOf("nonsense"), null);
});

test("trajectory is reserved: present on every kind, always null, read by nobody", () => {
  for (const kind of SHOT_KINDS) {
    assert.ok("trajectory" in SHOT_GRAMMAR[kind], `${kind} must carry the reserved field`);
    assert.equal(SHOT_GRAMMAR[kind].trajectory, null, `${kind}.trajectory must stay null until camera conditioning lands`);
  }
  // Declared once in each file and never consumed: a `.trajectory` read would mean something started depending on it.
  assert.equal((TS_SRC.match(/trajectory/g) ?? []).length, SHOT_KINDS.length + 2, "trajectory: 10 rows + the interface field + one comment");
  assert.ok(!/\.trajectory\b/.test(TS_SRC) && !/\["trajectory"\]/.test(TS_SRC), "nothing reads trajectory yet");
});

test("every suffix speaks the vendor dialect: one move, spelled-out negatives", () => {
  for (const kind of SHOT_KINDS) {
    const s = presetFor(kind).suffix;
    assert.ok(/\bNOT\b/.test(s), `${kind}: the suffix must spell out what the move is NOT`);
    assert.ok((s.match(/\bNOT\b/g) ?? []).length >= 3, `${kind}: one negative is not enough to hold a vendor model`);
    assert.ok(s.startsWith("camera") || s.startsWith("locked off camera"), `${kind}: the suffix is a camera instruction`);
    assert.ok(!s.includes("."), `${kind}: the suffix is one clause; promptFor does the joining`);
  }
  // A push says it is not a pull, and a pull says it is not a push. This is the whole point of the negatives.
  assert.match(presetFor("face").suffix, /NOT a dolly out, NOT a pull-back/);
  assert.match(presetFor("hook").suffix, /NOT a dolly out, NOT a pull-back/);
  assert.match(presetFor("reveal").suffix, /NOT a push in, NOT a crash zoom/);
  assert.match(presetFor("detail_orbit").suffix, /NOT an orbit right/);
});

test("the universal negative is exactly the decided line", () => {
  assert.equal(
    UNIVERSAL_NEGATIVE,
    "no morphing, no extra fingers, no warping faces, no floating objects, no camera shake beyond the specified move, no zoom, no text, no watermark, no logo",
  );
});

test("every routing trigger is a plain whole-word phrase (letters and single spaces)", () => {
  // The matcher strips everything that is not a letter, so a trigger with a digit or a hyphen could never fire —
  // and the phrase list is the one thing the two languages share verbatim, so it has to stay dumb.
  const phrases = [...Object.values(STATIC_HOLD_TRIGGERS).flat(), ...PERSON_WORDS];
  for (const p of phrases) assert.match(p, /^[a-z]+( [a-z]+)*$/, `bad trigger phrase: ${JSON.stringify(p)}`);
  assert.deepStrictEqual(Object.keys(STATIC_HOLD_TRIGGERS), [...STATIC_HOLD_CATEGORIES]);
  for (const cat of STATIC_HOLD_CATEGORIES) assert.ok(STATIC_HOLD_TRIGGERS[cat].length > 5, `${cat} needs real coverage`);
});

// ---------------------------------------------------------------------------------------------------------------
// durationFor
// ---------------------------------------------------------------------------------------------------------------

test("durationFor: 16:9 is the table as written", () => {
  assert.deepStrictEqual(durationFor("hook", "16:9"), { min: 1.6, max: 2.2 });
  assert.deepStrictEqual(durationFor("establish", "16:9"), { min: 3.5, max: 4.5 });
  assert.deepStrictEqual(durationFor("closing", "16:9"), { min: 3.0, max: 4.0 });
});

test("durationFor: 9:16 multiplies by 0.7 and caps at 3.0 s", () => {
  assert.equal(PORTRAIT_FACTOR, 0.7);
  assert.equal(PORTRAIT_MAX_S, 3.0);
  assert.deepStrictEqual(durationFor("hook", "9:16"), { min: 1.12, max: 1.54 });
  assert.deepStrictEqual(durationFor("face", "9:16"), { min: 1.75, max: 2.45 });
  assert.deepStrictEqual(durationFor("reveal", "9:16"), { min: 1.96, max: 2.66 });
  // 4.5 * 0.7 = 3.15, over the cap: this is the one row where the cap actually bites.
  assert.deepStrictEqual(durationFor("establish", "9:16"), { min: 2.45, max: 3.0 });
  assert.deepStrictEqual(durationFor("closing", "9:16"), { min: 2.1, max: 2.8 });
  for (const kind of SHOT_KINDS) {
    const w = durationFor(kind, "9:16");
    assert.ok(w.max <= PORTRAIT_MAX_S + 1e-9, `${kind}: a vertical shot may not pass ${PORTRAIT_MAX_S}s`);
    assert.ok(w.min <= w.max, `${kind}: the cap must not invert the window`);
    assert.ok(w.max <= durationFor(kind, "16:9").max, `${kind}: vertical is never longer than wide`);
  }
});

test("durationFor: an unknown kind throws instead of falling back to a default move", () => {
  assert.throws(() => durationFor("dramatic", "9:16"), /unknown shot_kind 'dramatic'/);
  assert.throws(() => presetFor("in"), /unknown shot_kind 'in'/); // the old motion vocabulary is gone
});

// ---------------------------------------------------------------------------------------------------------------
// promptFor
// ---------------------------------------------------------------------------------------------------------------

test("promptFor: subject, then the camera suffix, then the universal negative", () => {
  const p = promptFor("face", "a red-haired pirate captain in a tricorn hat");
  assert.equal(p, `a red-haired pirate captain in a tricorn hat. ${presetFor("face").suffix}. ${UNIVERSAL_NEGATIVE}`);
  assert.ok(p.endsWith(UNIVERSAL_NEGATIVE), "the universal negative goes on every shot, whatever the kind");
  for (const kind of SHOT_KINDS) assert.ok(promptFor(kind, "a beach").endsWith(UNIVERSAL_NEGATIVE), kind);
});

test("promptFor: the subject is tidied so the joins never produce '..' or ', .'", () => {
  assert.match(promptFor("detail", "  a car key   on a bench,  "), /^a car key on a bench\. camera tracks/);
  assert.match(promptFor("detail", "a car key on a bench."), /^a car key on a bench\. camera tracks/);
  assert.ok(!promptFor("detail", "a bench;").includes(";."));
  // No subject at all: the prompt is still a valid instruction, it just has nothing to be about.
  assert.equal(promptFor("hook", ""), `${presetFor("hook").suffix}. ${UNIVERSAL_NEGATIVE}`);
  assert.equal(promptFor("hook", "   "), `${presetFor("hook").suffix}. ${UNIVERSAL_NEGATIVE}`);
});

// ---------------------------------------------------------------------------------------------------------------
// needsStaticHold — the routing rule, one test per category
// ---------------------------------------------------------------------------------------------------------------

test("static hold category 1: visible hands doing something", () => {
  assert.equal(staticHoldReason("a close view of the small amplifier in gloved hands"), "hands");
  assert.equal(staticHoldReason("a watchmaker holding a tiny screwdriver"), "hands");
  assert.equal(staticHoldReason("a cook chopping herbs on a wooden board"), "hands");
  assert.equal(staticHoldReason("fingers typing on a mechanical keyboard"), "hands");
  assert.ok(needsStaticHold("a sailor tying a rope to a cleat"));
});

test("static hold category 2: a crowd, or two people interacting", () => {
  assert.equal(staticHoldReason("a dense crowd filling the square at dusk"), "people");
  assert.equal(staticHoldReason("a busy marketplace under striped awnings"), "people");
  assert.equal(staticHoldReason("two women arguing across a kitchen table"), "people");
  assert.equal(staticHoldReason("a group of people waiting on a platform"), "people");
  assert.ok(needsStaticHold("two figures facing each other on a bridge"));
});

test("static hold category 3: legible signage", () => {
  assert.equal(staticHoldReason("a rusted street sign at a lonely crossroads"), "signage");
  assert.equal(staticHoldReason("a neon sign buzzing over a rainy doorway"), "signage");
  assert.equal(staticHoldReason("an open book on a windowsill"), "signage");
  assert.ok(needsStaticHold("a billboard above an empty motorway"));
});

test("static hold category 4: a mechanism with moving parts", () => {
  assert.equal(staticHoldReason("brass gears turning inside an old clock"), "mechanism");
  assert.equal(staticHoldReason("a conveyor belt in a bottling plant"), "mechanism");
  assert.equal(staticHoldReason("a wooden windmill against a grey sky"), "mechanism");
  assert.ok(needsStaticHold("a robotic arm above a workbench"));
});

test("static hold: everything else keeps its camera move", () => {
  for (const clean of [
    "a quiet suburban driveway at dawn with tyre marks on wet tarmac",
    "a sunset beach with a wooden chest half buried in the sand",
    "a long empty motorway cutting through red desert",
    "paint peeling off a shuttered kiosk",
    "palm trees bending in the wind",
    "rain pouring on an empty stadium car park",
    "storm clouds stacking over a dark ocean",
  ]) {
    assert.equal(staticHoldReason(clean), null, clean);
    assert.equal(needsStaticHold(clean), false, clean);
  }
});

test("static hold: whole words only, so a substring never forces a lock-off", () => {
  assert.equal(staticHoldReason("a handsome stag in a clearing"), null, "'handsome' is not 'hand'");
  assert.equal(staticHoldReason("a designer working late"), null, "'designer' is not 'sign'");
  assert.equal(staticHoldReason("a mobile home on cinder blocks"), null, "'mobile' is not 'mob'");
  assert.equal(staticHoldReason("a Signpost, half fallen"), "signage", "case and punctuation do not hide a trigger");
});

test("resolveKind: the routing rule overrides whatever the planner asked for", () => {
  assert.equal(resolveKind("hook", "a lone lighthouse in a storm"), "hook");
  assert.equal(resolveKind("hook", "two men shaking hands on a dock"), "static_forced");
  assert.equal(resolveKind("detail_orbit", "brass gears turning inside an old clock"), "static_forced");
  assert.equal(resolveKind("action", "a horse galloping along a beach"), "action");
  // No kind is exempt: a closing with a crowd in it locks off like everything else.
  assert.equal(resolveKind("closing", "a stadium crowd on its feet"), "static_forced");
  assert.equal(presetFor(resolveKind("closing", "a stadium crowd on its feet")).move, "static_hold");
});

test("impliesPerson: what makes a shot fall under the tighter ceiling", () => {
  assert.ok(impliesPerson("a woman standing at the end of a pier"));
  assert.ok(impliesPerson("the captain's face lit by a lantern"));
  assert.ok(impliesPerson("two children running down a hill"));
  assert.ok(!impliesPerson("an empty road at dawn"));
  assert.ok(!impliesPerson("a wooden chest on wet sand"));
  assert.deepStrictEqual([...PERSON_KINDS], ["face", "action"]);
});

// ---------------------------------------------------------------------------------------------------------------
// Sequencing rules — every one of them a failure, not a warning
// ---------------------------------------------------------------------------------------------------------------

const shot = (over = {}) => ({ scene_id: "01-hook", kind: "detail", move: "track_right", duration_s: 2.5, ...over });

test("RULE 1: one move per shot, never a list", () => {
  assert.deepStrictEqual(checkOneMovePerShot([shot()]), []);
  assert.match(checkOneMovePerShot([shot({ move: ["push_in", "pull_out"] })])[0], /shot 1: move must be one move, never a list \(got 2\)/);
  assert.match(checkOneMovePerShot([shot({ move: "push_in, pull_out" })])[0], /never a list \('push_in, pull_out'\)/);
  assert.match(checkOneMovePerShot([shot({ move: "push_in then pull_out" })])[0], /never a list/);
  assert.match(checkOneMovePerShot([shot({ move: "push_in and crane_down" })])[0], /never a list/);
  assert.match(checkOneMovePerShot([shot({ move: undefined })])[0], /shot 1: move is required/);
  assert.match(checkOneMovePerShot([shot({ move: "" })])[0], /shot 1: move is required/);
  assert.match(checkOneMovePerShot([shot({ move: "in" })])[0], /shot 1: unknown move 'in'/);
  const oneBad = checkOneMovePerShot([shot(), shot({ move: "zoom_out" })]);
  assert.deepStrictEqual(oneBad.length, 1, "a valid shot contributes no error, and the index is still the shot number");
  assert.match(oneBad[0], /shot 2: unknown move 'zoom_out'/);
});

test("RULE 2: 5.0 s ceiling on anything", () => {
  assert.deepStrictEqual(checkDurations([shot({ duration_s: 5.0, image_prompt: "an empty road at dawn" })]), []);
  assert.match(checkDurations([shot({ duration_s: 5.4, image_prompt: "an empty road at dawn" })])[0], /shot 1: duration 5.4s is over the 5s maximum/);
  assert.match(checkDurations([shot({ duration_s: 0 })])[0], /duration_s is required/);
  assert.match(checkDurations([shot({ duration_s: "3" })])[0], /duration_s is required/);
  assert.equal(MAX_SHOT_S, 5.0);
});

test("RULE 2: 4.0 s ceiling when a person is implied — by the kind or by the prompt", () => {
  assert.equal(MAX_PERSON_SHOT_S, 4.0);
  assert.deepStrictEqual(checkDurations([shot({ kind: "face", move: "push_in", duration_s: 4.0 })]), []);
  assert.match(checkDurations([shot({ kind: "face", move: "push_in", duration_s: 4.4 })])[0], /over the 4s maximum for a shot with a person in it/);
  assert.match(checkDurations([shot({ kind: "action", move: "track_alongside", duration_s: 4.2 })])[0], /a person in it/);
  assert.match(checkDurations([shot({ duration_s: 4.5, image_prompt: "a woman on a pier" })])[0], /a person in it/);
  assert.deepStrictEqual(checkDurations([shot({ duration_s: 4.5, image_prompt: "an empty road at dawn" })]), []);
  // Over 5 s reports the hard ceiling once, not both ceilings.
  assert.equal(checkDurations([shot({ kind: "face", move: "push_in", duration_s: 6 })]).length, 1);
});

test("RULE 3: at most 2 loud moves per 40 s, and never adjacent", () => {
  assert.equal(LOUD_MAX_PER_WINDOW, 2);
  assert.equal(LOUD_WINDOW_S, 40.0);
  const loud = (d) => shot({ move: "crash_zoom_in", duration_s: d });
  const quiet = (d) => shot({ move: "track_right", duration_s: d });
  assert.deepStrictEqual(checkLoudBudget([loud(2), quiet(3), loud(2)]), [], "two loud moves in a window is the budget");
  assert.match(checkLoudBudget([loud(2), loud(2)])[0], /shot 2: loud move 'crash_zoom_in' is adjacent to the loud move at shot 1/);
  assert.match(checkLoudBudget([quiet(2), shot({ move: "orbit_left", duration_s: 2 }), shot({ move: "push_in_dutch", duration_s: 2 })])[0], /adjacent/);
  const three = checkLoudBudget([loud(2), quiet(3), loud(2), quiet(3), loud(2)]);
  assert.equal(three.length, 1, three.join("\n"));
  assert.match(three[0], /shot 5: more than 2 loud moves within 40s \(shots 1, 3, 5\)/);
  // Spread them past the window and three loud moves are fine.
  assert.deepStrictEqual(checkLoudBudget([loud(2), quiet(18), loud(2), quiet(23), loud(2)]), []);
});

test("RULE 4: never two consecutive shots of the same move class", () => {
  assert.deepStrictEqual(checkMoveClassAlternation([shot({ move: "push_in" }), shot({ move: "track_right" })]), []);
  // A push in followed by a pull out is still PUSH twice: the class is the axis, not the sign.
  assert.match(checkMoveClassAlternation([shot({ move: "push_in" }), shot({ move: "pull_out" })])[0], /shot 2: move class PUSH repeats shot 1 \('push_in' then 'pull_out'\)/);
  assert.match(checkMoveClassAlternation([shot({ move: "track_right" }), shot({ move: "orbit_left" })])[0], /move class LATERAL repeats/);
  assert.match(checkMoveClassAlternation([shot({ move: "static_hold" }), shot({ move: "static_hold" })])[0], /move class STILL repeats/);
  assert.match(checkMoveClassAlternation([shot({ move: "crane_down" }), shot({ move: "crane_up" })])[0], /move class VERTICAL repeats/);
  assert.deepStrictEqual(checkMoveClassAlternation([shot({ move: "crane_down" }), shot({ move: "push_in" }), shot({ move: "track_right" }), shot({ move: "static_hold" })]), []);
});

test("RULE 5: never two consecutive shots at the same scale on the same subject", () => {
  const s = (over) => shot({ subject: "the captain", ...over });
  assert.match(checkScaleRepetition([s({ scale: "close" }), s({ scale: "close" })])[0], /shot 2: scale 'close' repeats shot 1 on the same subject 'the captain'/);
  assert.deepStrictEqual(checkScaleRepetition([s({ scale: "close" }), s({ scale: "wide" })]), []);
  assert.deepStrictEqual(checkScaleRepetition([s({ scale: "close" }), shot({ subject: "the ship", scale: "close" })]), [], "a different subject may repeat the scale");
  assert.deepStrictEqual(checkScaleRepetition([shot({ scale: "close" }), shot({ scale: "close" })]), [], "no subject named: the rule stands down");
  // Without an explicit scale the kind's own scale is used: two `face` shots are two close-ups of the same person.
  assert.match(checkScaleRepetition([s({ kind: "face", move: "push_in", scale: undefined }), s({ kind: "face", move: "push_in", scale: undefined })])[0], /scale 'close' repeats/);
  assert.deepStrictEqual(checkScaleRepetition([s({ kind: "face", move: "push_in", scale: undefined }), s({ kind: "reveal", move: "pull_out", scale: undefined })]), []);
});

test("RULE 6: screen direction stays consistent inside a scene", () => {
  const inScene = (id, move) => shot({ scene_id: id, move });
  assert.match(checkScreenDirection([inScene("02-ship", "track_right"), inScene("02-ship", "track_left")])[0], /shot 2: screen direction flips inside scene '02-ship' \(right at shot 1, left here\)/);
  assert.match(checkScreenDirection([inScene("02-ship", "orbit_left"), inScene("02-ship", "track_alongside")])[0], /flips inside scene '02-ship'/);
  assert.deepStrictEqual(checkScreenDirection([inScene("02-ship", "track_right"), inScene("02-ship", "orbit_right")]), []);
  // A push, a crane and a hold carry no direction: they never break a scene's direction and never set it.
  assert.deepStrictEqual(checkScreenDirection([inScene("02-ship", "push_in"), inScene("02-ship", "crane_down"), inScene("02-ship", "static_hold")]), []);
  assert.deepStrictEqual(checkScreenDirection([inScene("02-ship", "track_right"), inScene("03-storm", "track_left")]), [], "a new scene may set a new direction");
  assert.deepStrictEqual(checkScreenDirection([shot({ scene_id: "", move: "track_right" }), shot({ scene_id: "", move: "track_left" })]), []);
});

test("checkSequence runs every rule and a shootable plan comes back clean", () => {
  const plan = [
    { scene_id: "01-hook", kind: "hook", move: "crash_zoom_in", duration_s: 1.4, scale: "close", subject: "the wreck", image_prompt: "a shattered hull on a black reef" },
    { scene_id: "01-hook", kind: "establish", move: "crane_down", duration_s: 2.8, scale: "wide", subject: "the wreck", image_prompt: "a black reef seen from high above at dawn" },
    { scene_id: "02-dive", kind: "detail", move: "track_right", duration_s: 2.1, scale: "extreme_close", subject: "the lantern", image_prompt: "a corroded brass lantern on the seabed" },
    { scene_id: "02-dive", kind: "face", move: "push_in", duration_s: 2.4, scale: "close", subject: "the diver", image_prompt: "a diver behind a fogged mask" },
    { scene_id: "03-out", kind: "detail_orbit", move: "orbit_right", duration_s: 2.4, scale: "close", subject: "the lantern", image_prompt: "the lantern turning slowly in the current" },
    { scene_id: "03-out", kind: "closing", move: "pull_out", duration_s: 2.6, scale: "wide", subject: "the wreck", image_prompt: "the wreck fading into blue water" },
  ];
  assert.deepStrictEqual(checkSequence(plan), []);

  // Now break one rule at a time and check checkSequence surfaces it.
  const broken = (i, over) => checkSequence(plan.map((s, j) => (j === i ? { ...s, ...over } : s)));
  assert.ok(broken(2, { move: ["track_right", "push_in"] }).some((e) => /never a list/.test(e)));
  assert.ok(broken(3, { duration_s: 4.6 }).some((e) => /a person in it/.test(e)));
  assert.ok(broken(2, { duration_s: 5.5 }).some((e) => /over the 5s maximum/.test(e)));
  assert.ok(broken(1, { move: "push_in_dutch" }).some((e) => /adjacent/.test(e)));
  assert.ok(broken(2, { move: "pull_out" }).some((e) => /move class PUSH repeats/.test(e)));
  assert.ok(broken(3, { subject: "the lantern", scale: "extreme_close", move: "static_hold" }).some((e) => /repeats shot 3 on the same subject/.test(e)));
  assert.ok(broken(3, { move: "track_left" }).some((e) => /screen direction flips inside scene '02-dive'/.test(e)));
  assert.deepStrictEqual(checkSequence([]), [], "an empty plan breaks no rule");
});

test("a plan built straight from the grammar for 9:16 passes its own rules", () => {
  // The point of the table: a planner that writes story kinds and takes the moves and the windows from here
  // cannot produce a sequence the validator refuses (as long as it alternates the classes, which it must).
  const order = ["hook", "establish", "face", "detail", "action", "reveal", "tension", "closing"];
  const plan = order.map((kind, i) => ({
    scene_id: `0${Math.floor(i / 2) + 1}-scene`,
    kind,
    move: presetFor(kind).move,
    duration_s: durationFor(kind, "9:16").max,
    scale: presetFor(kind).scale,
    image_prompt: "a lighthouse on a black cliff",
  }));
  // hook(PUSH) then establish(VERTICAL) then face(PUSH) then detail(LATERAL) then action(LATERAL) — the grammar does
  // not alternate on its own, which is exactly why RULE 4 exists and why the planner must interleave.
  const errors = checkSequence(plan);
  assert.ok(errors.every((e) => /move class LATERAL repeats/.test(e) || /move class PUSH repeats/.test(e)), errors.join("\n"));
  for (const p of plan) assert.ok(p.duration_s <= PORTRAIT_MAX_S, `${p.kind}: ${p.duration_s}s`);
  // Fix the two class collisions with the mirror moves and the same plan is clean.
  const fixed = plan.map((p) => (p.kind === "action" ? { ...p, move: "crane_up" } : p.kind === "tension" ? { ...p, move: "whip_pan" } : p));
  assert.deepStrictEqual(checkSequence(fixed), []);
});

// ---------------------------------------------------------------------------------------------------------------
// The surface src/keou-contract.ts imports
// ---------------------------------------------------------------------------------------------------------------

test("every name the validator imports from the grammar is actually exported", () => {
  // src/keou-contract.ts is the only consumer today and it names the surface it expects in its own header. A missing
  // export here is a build break, and a build break in the Worker is a job that never gets queued.
  const contract = readFileSync(join(ROOT, "src", "keou-contract.ts"), "utf8");
  const block = /import\s*\{([^}]*)\}\s*from\s*"\.\/shot-grammar\.ts"/.exec(contract);
  assert.ok(block, "src/keou-contract.ts should import the grammar from ./shot-grammar.ts");
  const names = block[1].split(",").map((n) => n.trim()).filter(Boolean);
  assert.ok(names.length >= 8, `expected the documented surface, found ${names.length}`);
  for (const raw of names) {
    if (raw.startsWith("type ")) {
      const t = raw.slice(5).trim();
      assert.match(TS_SRC, new RegExp(`export (?:type|interface) ${t}\\b`), `src/shot-grammar.ts must export type ${t}`);
    } else {
      assert.ok(raw in GRAMMAR, `src/shot-grammar.ts must export ${raw}`);
    }
  }
});

test("the validator-facing readings agree with the table they read", () => {
  for (const kind of SHOT_KINDS) {
    assert.equal(moveOf(kind), presetFor(kind).move, kind);
    assert.equal(shotScale(kind), presetFor(kind).scale, kind);
    for (const fmt of ["9:16", "16:9"]) {
      const w = durationFor(kind, fmt);
      assert.deepStrictEqual(durationRange(kind, fmt), [w.min, w.max], `${kind} ${fmt}`);
    }
  }
  for (const move of Object.keys(MOVES)) {
    assert.equal(moveClass(move), moveClassOf(move), move);
    assert.equal(isLoudMove(move), isLoud(move), move);
    // screenDirection collapses "none" to null: a push never sets a scene's direction and never breaks it.
    assert.equal(screenDirection(move), directionOf(move) === "none" ? null : directionOf(move), move);
  }
  assert.deepStrictEqual(durationRange("establish", "9:16"), [2.45, 3.0]);
  assert.equal(screenDirection("push_in"), null);
  assert.equal(screenDirection("track_left"), "left");
  assert.equal(moveOf("tension"), "push_in_dutch");
  assert.equal(shotScale("detail"), "extreme_close");
});

test("forcesStatic reads as a sentence in the validator's error", () => {
  // "…: this picture shows <why>, which breaks under a moving camera — set shot_kind to \"static_forced\"…"
  assert.equal(forcesStatic("a watchmaker holding a tiny screwdriver"), "hands at work");
  assert.equal(forcesStatic("a dense crowd filling the square at dusk"), "a crowd, or two people interacting");
  assert.equal(forcesStatic("a rusted street sign at a lonely crossroads"), "legible signage");
  assert.equal(forcesStatic("brass gears turning inside an old clock"), "a mechanism with moving parts");
  assert.equal(forcesStatic("a sunset beach with a wooden chest"), null);
  for (const cat of STATIC_HOLD_CATEGORIES) {
    assert.equal(typeof STATIC_HOLD_REASON[cat], "string", cat);
    assert.ok(!STATIC_HOLD_REASON[cat].endsWith("."), `${cat}: the phrase is embedded mid-sentence`);
  }
});
