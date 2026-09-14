/**
 * The layer (src/graphics.ts): the grammar, the validator on both sides of the contract, the planner that writes it
 * from the treatment and repairs what the model returns per scene, and the engine that draws it (hud.js's pure
 * block, the film.html wiring, the picture.js hooks). No browser, no Playwright, nothing rendered.
 * Run: node --test test/graphics.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  GL, LINE_STATES, HUD_KINDS, graphicsProblems, repairGraphics, isNoLayer, quotesWords, sceneHudProblems, repairSceneHud,
  cardProblems, repairCards, graphicsBlock, sceneHudSchema, LAYER_METHOD,
} from "../src/graphics.ts";
import { validateStoryboard } from "../src/keou-contract.ts";
import { generateStoryboard, fixtureStoryboard, normalizeStoryboard, planFor } from "../src/storyboard.ts";
import { MASTER_PROMPT, repairTreatment, treatmentProblems, treatmentSchema, variationFor, treatmentBlock } from "../src/treatment.ts";
import { TREATMENT_FIXTURE } from "./fixtures/treatment.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = join(ROOT, "worker", "keou", "engine");

/** The layer of a Voyager film: the one the owner's own package describes, in the grammar. */
const LAYER = {
  accent: "#FFB347", subtitles: "cinema", chapters: "film",
  hud: [
    { id: "signal", kind: "line", edge: "bottom", means: "the health of the link" },
    { id: "clocks", kind: "readout", corner: "top-right", rows: ["EARTH", "VOYAGER", "ONE-WAY"], means: "the delay" },
    { id: "where", kind: "stamp", corner: "top-left", means: "the place and the date" },
  ],
};

/* ------------------------------------------------------------------ the grammar */

test("a layer is held to the grammar, in words that name the field", () => {
  assert.deepEqual(graphicsProblems(LAYER), []);
  const g = repairGraphics(LAYER);
  assert.equal(g.accent, "#ffb347", "the accent is lowercased");
  assert.deepEqual(g.hud.map((h) => h.id), ["signal", "clocks", "where"]);
  assert.deepEqual(g.hud[1].rows, ["EARTH", "VOYAGER", "ONE-WAY"]);
  const bad = { accent: "amber", subtitles: "karaoke", hud: [{ id: "Signal Line!", kind: "gauge" }, { id: "x", kind: "readout", corner: "middle", rows: [] }, { id: "x", kind: "line", edge: "left", means: "y" }, { id: "d", kind: "stamp", corner: "top-left", means: "dates" }] };
  const p = graphicsProblems(bad);
  assert.ok(p.some((m) => /^graphics\.accent: a hex colour/.test(m)), p.join(" | "));
  assert.ok(p.some((m) => /^graphics\.subtitles: none or cinema/.test(m)));
  assert.ok(p.some((m) => /^graphics\.hud: 4 elements, at most 3/.test(m)));
  assert.ok(p.some((m) => /hud\[1\]: kind must be one of line, readout, stamp/.test(m)));
  assert.ok(p.some((m) => /hud\[2\]: a readout sits in a corner/.test(m)));
  assert.ok(p.some((m) => /hud\[2\]: a readout has 1-4 rows/.test(m)));
  assert.ok(p.some((m) => /hud\[3\]: id "x" is used twice/.test(m)));
  assert.ok(p.some((m) => /hud\[3\]: a line runs along an edge/.test(m)));
  // "none" in every spelling, and a layer with nothing on it, is no layer.
  for (const none of [null, undefined, "none", "None", "nessuno", { layer: "none" }, { accent: "#ffffff", hud: [] }, { accent: "#ffffff", subtitles: "none", chapters: "none", hud: [] }]) assert.equal(repairGraphics(none), null, JSON.stringify(none));
  assert.ok(isNoLayer("no layer") && isNoLayer({ layer: "none", accent: "#123456", hud: [{ id: "a", kind: "line", edge: "top", means: "m" }] }));
  assert.ok(!isNoLayer(LAYER));
  assert.equal(repairGraphics({ accent: "#ffffff", subtitles: "cinema", hud: [] }).subtitles, "cinema", "subtitles alone are a layer");
});

test("what a scene says to the layer is checked against the film's own elements, and repaired the same way", () => {
  const g = repairGraphics(LAYER);
  const voice = "In November 2023, twenty-four billion kilometres out, Voyager 1 began repeating itself.";
  assert.deepEqual(sceneHudProblems(g, { signal: "square", clocks: ["2023-11-14", "2023-11-13", "22h 34m"], where: "JPL, PASADENA" }, "scene 1"), []);
  const p = sceneHudProblems(g, { signal: "wobbly", clocks: ["only one"], radar: "x" }, "scene 1");
  assert.ok(p.some((m) => /^scene 1 hud\.signal: a line's state is one of/.test(m)), p.join(" | "));
  assert.ok(p.some((m) => /^scene 1 hud\.clocks: 3 values, one per row \(EARTH, VOYAGER, ONE-WAY\)/.test(m)));
  assert.ok(p.some((m) => /^scene 1 hud: "radar" is not an element of this film's layer \(signal, clocks, where\)/.test(m)));
  // The model's list form is read too, and the repair fits without refusing.
  assert.deepEqual(repairSceneHud(g, [{ id: "signal", state: "SQUARE" }, { id: "clocks", values: ["a", "b"] }, { id: "radar", value: "x" }, { id: "where", value: "  JPL  " }]),
    { signal: "square", clocks: ["a", "b", ""], where: "JPL" });
  assert.deepEqual(repairSceneHud(g, "garbage"), {});
  // Cards: one per scene, a figure not a sentence, cut on the words of the voice like a shot.
  assert.deepEqual(cardProblems([{ at: "twenty-four billion", text: "24 400 000 000 km", hold: 2.5 }], voice, "scene 1"), []);
  const c = cardProblems([{ at: "twenty-four billio", text: "x".repeat(40) }, { text: "second" }], voice, "scene 1");
  assert.ok(c.some((m) => /^scene 1 cards: 2, at most 1 per scene/.test(m)), c.join(" | "));
  assert.ok(c.some((m) => /^scene 1 card 1: text is 40 characters, the limit is 28/.test(m)));
  assert.ok(c.some((m) => /^scene 1 card 1: at must quote whole words/.test(m)));
  assert.ok(quotesWords("Voyager 1 began", voice) && !quotesWords("oyager 1", voice) && !quotesWords("began repeating itself twice", voice));
  const fitted = repairCards([{ at: "oyager", text: " 45 hours ", hold: 9 }, { text: "dropped: second" }], voice);
  assert.deepEqual(fitted, [{ text: "45 hours", hold: 4 }], "a bad anchor falls back to the scene start, the hold is clamped, the second card is dropped");
  assert.equal(repairCards([{ at: "Voyager 1", text: "1977" }], voice)[0].at, "Voyager 1");
});

test("the words the model reads: the method, the block, the per-scene schema", () => {
  assert.match(LAYER_METHOD, /"none" is a legal answer/);
  assert.match(LAYER_METHOD, new RegExp(`At most ${GL.hud.max} elements`));
  assert.match(MASTER_PROMPT, /^11\. THE LAYER/m, "the treatment's method has the layer as its eleventh decision");
  assert.match(MASTER_PROMPT, /NO karaoke captions, NO icons, NO logos/);
  const g = repairGraphics(LAYER), block = graphicsBlock(g);
  assert.match(block, /accent #ffb347; subtitles: cinema; chapters: film/);
  assert.match(block, /"signal": a line along the bottom edge — the health of the link; each scene sets its state: steady \| pulse/);
  assert.match(block, /"clocks": a readout in the top-right corner with rows "EARTH", "VOYAGER", "ONE-WAY"/);
  const schema = sceneHudSchema(g);
  assert.deepEqual(schema.hud.items.properties.id.enum, ["signal", "clocks", "where"]);
  assert.deepEqual(schema.hud.items.properties.state.enum, [...LINE_STATES]);
  assert.ok(schema.cards.items.required.includes("text"));
  assert.deepEqual(HUD_KINDS, ["line", "readout", "stamp"]);
});

/* ------------------------------------------------------------------ the treatment decides it */

test("the treatment carries the layer: 'none' stays none, a layer is fitted, a broken one is sent back", () => {
  const v = variationFor("gt_layer");
  const none = repairTreatment({ ...TREATMENT_FIXTURE(60), graphics: { layer: "none", accent: "", subtitles: "none", chapters: "none", hud: [] } }, 60, v);
  assert.equal(none.graphics, null);
  assert.match(treatmentBlock(none), /The layer: none/);
  const withLayer = repairTreatment({ ...TREATMENT_FIXTURE(60), graphics: { layer: "layer", ...LAYER } }, 60, v);
  assert.equal(withLayer.graphics.hud.length, 3);
  assert.match(treatmentBlock(withLayer), /THE LAYER OF THIS FILM \(accent #ffb347/);
  const broken = treatmentProblems({ ...TREATMENT_FIXTURE(60), graphics: { layer: "layer", accent: "amber", hud: [] } }, 60);
  assert.ok(broken.some((m) => /^graphics\.accent/.test(m)), broken.join(" | "));
  assert.equal(repairTreatment(TREATMENT_FIXTURE(60), 60, v).graphics, null, "a treatment written before the layer existed has none");
  const s = treatmentSchema();
  assert.ok(s.required.includes("graphics"));
  assert.deepEqual(s.properties.graphics.properties.layer.enum, ["none", "layer"]);
  assert.equal(s.properties.graphics.additionalProperties, false);
});

/* ------------------------------------------------------------------ the contract, both sides */

/** The realistic fixture with the Voyager layer and one scene speaking to it. */
function filmWithLayer() {
  const sb = structuredClone(fixtureStoryboard({ id: "gt_layer", template: "film", prompt: "Voyager", params: JSON.stringify({ duration_s: 45, format: "9:16", language: "en", voice: null, style: "realistic" }) }));
  sb.graphics = structuredClone(LAYER);
  const s0 = sb.scenes[0];
  s0.hud = { signal: "square", clocks: ["2023-11-14", "2023-11-13", "22h 34m"], where: "JPL, PASADENA" };
  s0.cards = [{ at: s0.voice.split(/\s+/).slice(1, 3).join(" "), text: "24 400 000 000 KM" }];
  return sb;
}

test("keou-contract.ts: a storyboard with a layer validates, keeps it, and refuses a scene that speaks to elements it does not have", () => {
  const sb = filmWithLayer();
  const r = validateStoryboard(sb, { format: "9:16", language: "en" });
  assert.ok(r.ok, (r.errors ?? []).join(" | "));
  assert.equal(r.storyboard.graphics.accent, "#ffb347");
  assert.deepEqual(r.storyboard.scenes[0].hud.signal, "square");
  assert.equal(r.storyboard.scenes[0].cards.length, 1);
  const wrong = filmWithLayer(); wrong.scenes[1].hud = { radar: "on" }; wrong.scenes[1].cards = [{ text: "x".repeat(30) }, { text: "y" }];
  const w = validateStoryboard(wrong, { format: "9:16", language: "en" });
  assert.ok(!w.ok);
  assert.ok(w.errors.some((m) => /scene 2 hud: "radar" is not an element/.test(m)), w.errors.join(" | "));
  assert.ok(w.errors.some((m) => /scene 2 cards: 2, at most 1/.test(m)));
  const orphan = filmWithLayer(); delete orphan.graphics;
  const o = validateStoryboard(orphan, { format: "9:16", language: "en" });
  assert.ok(o.errors.some((m) => /scene 1: hud and cards belong to a film with a layer/.test(m)), o.errors.join(" | "));
  const noLayer = filmWithLayer(); noLayer.graphics = { accent: "#ffffff", hud: [] }; delete noLayer.scenes[0].hud; delete noLayer.scenes[0].cards;
  const n = validateStoryboard(noLayer, { format: "9:16", language: "en" });
  assert.ok(n.ok && !("graphics" in n.storyboard), "a layer with nothing on it is dropped, not refused");
});

test("contract.py mirrors the layer: the same film passes, the same mistakes are refused", (t) => {
  const sb = filmWithLayer();
  const PY = `
import json, sys, tempfile, os, copy
sys.path.insert(0, ${JSON.stringify(join(ROOT, "worker", "keou"))})
import contract
base = json.loads(${JSON.stringify(JSON.stringify(sb))})
base.update(id="layer-test", brand="Kleo", width=1080, fps=60)
for s in base["scenes"]:
    for sh in s.get("shots") or []:
        sh.pop("clip", None); sh.pop("image", None)
def check(mutate):
    c = copy.deepcopy(base); mutate(c)
    d = tempfile.mkdtemp(); p = os.path.join(d, "project.json")
    json.dump(c, open(p, "w"))
    try:
        contract.validate(p); return "ok"
    except ValueError as e:
        return str(e)
cases = {
 "accepts the layer": lambda c: None,
 "unknown element": lambda c: c["scenes"][1].__setitem__("hud", {"radar": "on"}),
 "bad line state": lambda c: c["scenes"][0]["hud"].__setitem__("signal", "wobbly"),
 "wrong value count": lambda c: c["scenes"][0]["hud"].__setitem__("clocks", ["one"]),
 "two cards": lambda c: c["scenes"][0].__setitem__("cards", [{"text": "a"}, {"text": "b"}]),
 "card not in voice": lambda c: c["scenes"][0].__setitem__("cards", [{"at": "never spoken here", "text": "1977"}]),
 "hud without a layer": lambda c: c.pop("graphics"),
 "bad accent": lambda c: c["graphics"].__setitem__("accent", "amber"),
 "four elements": lambda c: c["graphics"]["hud"].append({"id": "more", "kind": "stamp", "corner": "bottom-left", "means": "too many"}),
}
print(json.dumps({k: check(f) for k, f in cases.items()}))
`;
  const py = spawnSync("python3", ["-c", PY], { encoding: "utf8" });
  if (py.error) { t.skip("python3 not available"); return; }
  assert.equal(py.status, 0, py.stderr);
  const out = JSON.parse(py.stdout.trim());
  assert.equal(out["accepts the layer"], "ok");
  assert.match(out["unknown element"], /"radar" is not an element/);
  assert.match(out["bad line state"], /a line state is one of/);
  assert.match(out["wrong value count"], /3 values of at most 24/);
  assert.match(out["two cards"], /at most 1 per scene/);
  assert.match(out["card not in voice"], /at must quote words/);
  assert.match(out["hud without a layer"], /belong to a film with a layer/);
  assert.match(out["bad accent"], /a hex colour/);
  assert.match(out["four elements"], /0-3 elements/);
});

/* ------------------------------------------------------------------ the planner */

test("the planner writes the layer from the treatment: the scenes are asked for it, the storyboard carries it with no music, bad answers are fitted", async () => {
  const treatment = { ...TREATMENT_FIXTURE(45), graphics: { layer: "layer", ...LAYER } };
  const calls = [];
  const env = {
    INTERNAL_SECRET: "x",
    AI: { async run(_m, inputs) {
      const user = inputs.messages.at(-1).content;
      const kind = /TASK: write the TREATMENT/.test(user) ? "treatment" : /TASK: write the DIRECTION/.test(user) ? "direction" : /TASK: plan the whole video/.test(user) ? "outline" : "chunk";
      calls.push({ kind, user, schema: inputs.response_format?.json_schema });
      let out;
      if (kind === "treatment") out = treatment;
      else if (kind === "direction") {
        const n = (user.match(/^ {2}\d+\. /gm) || []).length || 3;
        out = { direction: { subject: "Voyager 1", goal: "how a 1977 computer was fixed from far away", audience: "space viewers", tone: "calm", must_keep: [], world: "JPL at night, amber phosphor, deep space", cast: [], objects: ["dish", "printout", "terminal", "probe", "chart"], forbidden: ["text in the picture", "logo", "real person", "flare"], sections: Array.from({ length: n }, (_, i) => ({ name: `0${i + 1} PART`, means: "a part" })) } };
      } else if (kind === "outline") {
        const n = Number(/exactly (\d+) scenes/.exec(user)[1]);
        out = { title: "Signal Delay", description: "d", tags: ["space"], scenes: Array.from({ length: n }, (_, i) => ({ id: `${String(i + 1).padStart(2, "0")}-part`, kind: i === n - 1 ? "closing" : "cinema", label: `0${i + 1} PART`, accent: "amber", summary: `part ${i + 1}`, words: 16 })) };
      } else {
        const m = /write scenes (\d+)–(\d+)/.exec(user); const from = Number(m[1]) - 1, to = Number(m[2]);
        const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
        out = { scenes: Array.from({ length: to - from }, (_, k) => { const i = from + k, closing = i === total - 1; return {
          id: `${String(i + 1).padStart(2, "0")}-part`, kind: closing ? "closing" : "cinema", chapter: `0${i + 1} PART`, accent: "amber", title: `Part ${i + 1}`, hl: "Part",
          voice: `Scene ${i + 1} waits forty five hours for the answer while the dish turns slowly toward the dark.`,
          shots: closing ? [{ image_prompt: "The dish at dawn, mist drifting across the desert floor" }] : [{ image_prompt: `A printout unrolling on a desk under a lamp, scene ${i + 1}` }, { image_prompt: "The dish turning against the night sky, stars wheeling", at: "the dish" }],
          // The model's list form, one wrong element, one wrong value count, a card on the right words and one on the wrong ones.
          hud: [{ id: "signal", state: i % 2 ? "square" : "pulse" }, { id: "clocks", values: ["2023-11-14", "2023-11-13"] }, { id: "radar", value: "no" }, { id: "where", value: "JPL" }],
          cards: i === 0 ? [{ at: "forty five hours", text: "45 HOURS" }, { text: "second" }] : [{ at: "not in the line", text: "1977" }],
          ...(closing ? { button: "Follow" } : {}) }; }) };
      }
      return { response: out, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    } },
  };
  const r = await generateStoryboard(env, { id: "gt_layer", template: "film", prompt: "Voyager 1's five-month rescue", params: JSON.stringify({ duration_s: 45, format: "9:16", language: "en", voice: null, style: "realistic" }) });
  const chunk = calls.find((c) => c.kind === "chunk");
  assert.match(chunk.user, /THE LAYER OF THIS FILM \(accent #ffb347/, "the scenes are written under the layer");
  assert.match(chunk.user, /Every scene you write carries "hud"/);
  const sceneSchema = chunk.schema.properties.scenes.items;
  assert.deepEqual(sceneSchema.properties.hud.items.properties.id.enum, ["signal", "clocks", "where"], "the schema offers exactly this film's elements");
  assert.ok(sceneSchema.required.includes("hud") && sceneSchema.required.includes("cards"));
  const sb = r.storyboard;
  assert.equal(sb.graphics.accent, "#ffb347"); assert.equal(sb.music, "none", "a film with a layer takes no music bed");
  assert.ok(validateStoryboard(sb, { format: "9:16", language: "en" }).ok, "and it is a valid storyboard");
  const s0 = sb.scenes[0];
  assert.equal(s0.hud.signal, "pulse"); assert.deepEqual(s0.hud.clocks, ["2023-11-14", "2023-11-13", ""]); assert.equal(s0.hud.where, "JPL"); assert.ok(!("radar" in s0.hud));
  assert.deepEqual(s0.cards, [{ at: "forty five hours", text: "45 HOURS", hold: GL.card.defaultHold }], "one card, on its words, the second dropped");
  assert.deepEqual(sb.scenes[1].cards, [{ text: "1977", hold: GL.card.defaultHold }], "a card whose anchor is not in the voice opens with the scene");
  // Without a layer in the treatment nothing of this exists, and the schema does not even offer it.
  const plain = planFor({ id: "gt_plain", template: "film", prompt: "x", params: JSON.stringify({ duration_s: 45, format: "9:16", language: "en", voice: null, style: "realistic" }) });
  const norm = normalizeStoryboard({ ...sb, graphics: undefined, scenes: sb.scenes.map((s) => ({ ...s })) }, plain);
  assert.ok(!("graphics" in norm) && norm.scenes.every((s) => !("hud" in s) && !("cards" in s)));
});

/* ------------------------------------------------------------------ the engine */

const hudSource = readFileSync(join(ENGINE, "hud.js"), "utf8");
const pictureSource = readFileSync(join(ENGINE, "picture.js"), "utf8");

function pureBlock() {
  const a = hudSource.indexOf("/* @kleo-pure hud-plan"), b = hudSource.indexOf("/* @end hud-plan */");
  assert.ok(a >= 0 && b > a, "hud.js must keep the @kleo-pure hud-plan … @end hud-plan markers");
  return hudSource.slice(a, b);
}
const H = new Function(pureBlock() + `; return { STATES, layout, lineShape, lineAlpha, cardTimes, tint, safe };`)();

test("hud.js: the pure block plans where things sit, what a line looks like, when a card starts — with no canvas and no clock", () => {
  for (const forbidden of ["A.", "ctx", "document", "window", "Math.random", "Date.now", "performance.now"]) assert.ok(!pureBlock().includes(forbidden), `the pure block must not reference ${forbidden}`);
  for (const impure of ["Math.random", "Date.now", "new Date", "performance.now"]) assert.ok(!hudSource.includes(impure), `hud.js must stay deterministic: no ${impure}`);
  assert.deepEqual(H.STATES, [...LINE_STATES], "the engine draws exactly the states the contract allows");
  // Layout stays inside the safe areas, landscape and portrait, and scales with the height.
  const l4k = H.layout("line", "bottom", 3840, 2160), l1080 = H.layout("line", "bottom", 1920, 1080);
  assert.ok(l4k.y > 2160 - 150 && l4k.y < 2160, "a bottom line lives inside the bottom safe area");
  assert.ok(Math.abs(l4k.width / l1080.width - 2) < 0.6, "the line is twice as thick at twice the height");
  const rp = H.layout("readout", "top-right", 2160, 3840);
  assert.equal(rp.align, "right"); assert.ok(rp.y > 180 && rp.x === 2160 - 60);
  assert.ok(H.layout("stamp", "bottom-left", 3840, 2160).up, "a bottom corner grows upward");
  // The line's shapes: straight when steady or flat, a travelling bump when pulsing, a 1 0 1 0 wave when square,
  // jags when broken — and the same jags on every worker, because they come from a hash, not a clock.
  const n = 40;
  assert.ok(H.lineShape("steady", 3, n).every((y) => y === 0) && H.lineShape("flat", 3, n).every((y) => y === 0));
  assert.ok(H.lineShape("pulse", 1, n).some((y) => y < -0.5) && H.lineShape("pulse", 1, n).filter((y) => y < -0.5).length < n / 4, "one bump, not a wave");
  const sq = H.lineShape("square", 0, n); assert.ok(sq.every((y) => y === 0 || y === -1) && sq.includes(0) && sq.includes(-1));
  assert.deepEqual(H.lineShape("broken", 2.5, n), H.lineShape("broken", 2.5, n));
  assert.notDeepEqual(H.lineShape("broken", 2.5, n), H.lineShape("broken", 3.5, n), "and they move");
  assert.equal(H.lineAlpha("off"), 0); assert.ok(H.lineAlpha("flat") < H.lineAlpha("steady"));
  // A card starts on its word, minus a breath; without one, at the scene start; never past the scene.
  const s = { start: 10, end: 16, words: [{ text: "In", start: 10.0 }, { text: "November", start: 10.3 }, { text: "twenty-four", start: 11.2 }, { text: "billion", start: 11.6 }] };
  const [a, b, c] = H.cardTimes(s, [{ at: "twenty-four billion", text: "x", hold: 2 }, { text: "y" }, { at: "billion", text: "z", hold: 9 }], 6);
  assert.ok(Math.abs(a.at - (11.2 - 10 - 0.08)) < 1e-9 && a.hold === 2);
  assert.equal(b.at, 0); assert.equal(b.hold, 2.2);
  assert.ok(c.hold <= 4 && c.at + c.hold <= 6 + 1e-9, "a hold is clamped to the window and to the scene");
  assert.equal(H.tint("#ffb347", 0.5), "rgba(255,179,71,0.5)"); assert.equal(H.tint("amber", 0.5), "rgba(255,255,255,0.5)");
});

test("the wiring: film.html loads hud.js, picture.js hands a film with a layer to it and draws nothing of the picture look over it", () => {
  const html = readFileSync(join(ENGINE, "film.html"), "utf8");
  assert.ok(html.includes('<script src="/engine/hud.js"></script>'), "film.html must load hud.js");
  assert.ok(html.indexOf("/engine/hud.js") < html.indexOf("/engine/film.js"), "before film.js, which drives the frames");
  assert.match(pictureSource, /if \(A\.project && A\.project\.graphics && window\.KEOU_HUD\)/, "S.scene branches on the layer");
  assert.match(pictureSource, /window\.KEOU_HUD\.draw\(s, u, t, i, G, g\)/);
  assert.match(pictureSource, /if \(g\.chapters === 'film'\) S\.chrome\(s, i, t\)/, "chapters only when the layer asks");
  assert.match(pictureSource, /graphics\.subtitles === 'cinema' && window\.KEOU_HUD\) \{ window\.KEOU_HUD\.attach\(A\); window\.KEOU_HUD\.subtitle/, "cinema subtitles only when the layer asks, otherwise none");
  assert.match(hudSource, /window\.KEOU_HUD = HUD/);
  for (const fn of ["draw(s, u, t, i, G, g)", "subtitle(s, t, G)", "attach(api)"]) assert.ok(hudSource.includes(fn), `hud.js exposes ${fn}`);
});
