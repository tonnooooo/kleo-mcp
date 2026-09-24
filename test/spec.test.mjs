/**
 * The request spec (src/spec.ts, 24 September 2026): the user's request taken apart into typed, checkable items, and
 * the deterministic checks every later stage is held to — the quote guard against invented items, the repair, the
 * FAITHFUL/OPEN decision, the coverage of a storyboard, the narrator's lines, the folded looks and the questions a
 * vision model is asked about a still. Nothing here calls a model.
 * Run: node --test test/spec.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  S, SPEC_KINDS, REF_ROLES, norm, quoteInRequest, modeFor, specProblems, repairSpec, specOf, mustItems, shotItems, eventsInOrder,
  itemById, castById, fullLook, specBlock, owedBlock, coverage, lineSaid, SPEC_METHOD, specPrompt, specMethodText, specText,
  specSchema, visualChecks, castOfItem, bodyOnlyLook,
} from "../src/spec.ts";

/** The request every test below takes apart: an Italian story with a named character, her look, two events and a line. */
const REQ = "Mara, una pasticcera magra con i capelli biondi corti e il grembiule lilla, prepara una torta al limone per i bambini del paese. Poi i bambini le fanno una festa a sorpresa. Il narratore dice: «la torta più buona del mondo».";

/** A spec a writer would return for REQ: legal, so every test can break exactly one thing about it. */
const RAW = (over = {}) => ({
  v: 1, mode: "faithful",
  summary: "Mara, a thin pastry chef, bakes a lemon cake for the village children, who then throw her a surprise party.",
  cast: [{ id: "c1", name: "Mara", look: "a thin woman with short blonde hair", ref: null }],
  items: [
    { id: "R1", kind: "character", text: "Mara, a thin pastry chef", quote: "Mara, una pasticcera magra", must: true, who: "c1", order: null },
    { id: "R2", kind: "look", text: "Mara has short blonde hair", quote: "capelli biondi corti", must: true, who: "c1", order: null },
    { id: "R3", kind: "look", text: "Mara wears a lilac apron", quote: "grembiule lilla", must: true, who: "c1", order: null },
    { id: "R4", kind: "event", text: "Mara bakes a lemon cake for the village children", quote: "prepara una torta al limone per i bambini del paese", must: true, who: "c1", order: 1 },
    { id: "R5", kind: "event", text: "the children throw Mara a surprise party", quote: "i bambini le fanno una festa a sorpresa", must: true, who: null, order: 2 },
    { id: "R6", kind: "line", text: "the narrator says 'la torta più buona del mondo'", quote: "la torta più buona del mondo", must: true, who: null, order: null },
  ],
  refs: [], open: ["the ending"], narration: "lines", script: null,
  ...over,
});
const SPEC = (over = {}) => { const s = repairSpec(RAW(over), REQ); assert.ok(s, specProblems(RAW(over), REQ).join("\n")); return s; };
const item = (id, kind, text, quote, over = {}) => ({ id, kind, text, quote, must: true, who: null, order: null, ...over });

/* ------------------------------------------------------------------ the quote guard */

test("norm folds case, accents and punctuation; quoteInRequest finds the user's words, and only theirs", () => {
  assert.equal(norm("  Perché?  È «così»! "), "perche e cosi");
  assert.equal(norm("Crème brûlée, 3 volte"), "creme brulee 3 volte");
  // Verbatim, whatever the case, the accents and the punctuation.
  assert.equal(quoteInRequest("la torta più buona del mondo", REQ), true);
  assert.equal(quoteInRequest("LA TORTA PIU BUONA DEL MONDO", REQ), true, "accents dropped by the writer");
  assert.equal(quoteInRequest("Mara, una pasticcera magra", REQ), true);
  assert.equal(quoteInRequest("perché no", "Perche no!"), true, "an accent the user did not type");
  // Stitched or inflected: 70% of the words of three letters or more, a five-letter prefix standing for the word.
  assert.equal(quoteInRequest("grembiuli lilla", REQ), true, "grembiule/grembiuli: the same word");
  assert.equal(quoteInRequest("una torta al limone per i bambini", REQ), true);
  assert.equal(quoteInRequest("torta limone bambini festa sorpresa", REQ), true, "shortened: every word is in the request");
  // Invented: the words are not there.
  assert.equal(quoteInRequest("un drago rosso sul tetto", REQ), false);
  assert.equal(quoteInRequest("lemon cake for children party", "a lemon cake"), false, "two of five words is not the user's sentence");
  assert.equal(quoteInRequest("a lemon cake for the children party", "a lemon cake for the children"), true, "five of six is");
  assert.equal(quoteInRequest("", REQ), false, "no quote is no proof");
  assert.equal(quoteInRequest("   ", REQ), false);
});

/* ------------------------------------------------------------------ the mode */

test("modeFor: what the spec contains decides FAITHFUL or OPEN, whatever the writer claimed", () => {
  const ev = (n) => item(`E${n}`, "event", `event ${n}`, "q", { order: n });
  assert.equal(modeFor([ev(1), ev(2)], "x"), "faithful", "two events are a story");
  assert.equal(modeFor([item("R1", "shot", "a close-up of her hands", "q")], "x"), "faithful", "a described shot");
  assert.equal(modeFor([item("R1", "line", "the narrator says hi", "q")], "x"), "faithful", "a line to say");
  assert.equal(modeFor([item("R1", "text", "a sign reading 'Da Mara'", "q")], "x"), "faithful", "a text to read");
  assert.equal(modeFor([item("R1", "character", "Mara", "q"), item("R2", "look", "a lilac apron", "q")], "x"), "faithful", "a character and anything about her");
  assert.equal(modeFor([item("R1", "place", "a harbour", "q"), item("R2", "action", "boats come in", "q")], "x"), "faithful", "a place and what happens there");
  assert.equal(modeFor([item("R1", "character", "a cat", "q")], "x"), "open", "a bare subject");
  assert.equal(modeFor([item("R1", "object", "a", "q"), item("R2", "object", "b", "q"), item("R3", "object", "c", "q")], "x"), "open");
  assert.equal(modeFor(["a", "b", "c", "d"].map((x, i) => item(`R${i}`, "object", x, "q")), "x"), "faithful", "four musts is a described film");
  assert.equal(modeFor([ev(1), ev(2)].map((e) => ({ ...e, must: false })), "x"), "open", "hints do not make a film the user described");
  // A delegation is OPEN by definition, in either language.
  assert.equal(modeFor([ev(1), ev(2)], "Stupiscimi con un video sui gatti"), "open");
  assert.equal(modeFor([ev(1), ev(2)], "A film about owls, surprise me"), "open");
  assert.equal(modeFor([ev(1), ev(2)], "scegli tu la storia"), "open");
});

/* ------------------------------------------------------------------ problems, in words */

test("specProblems: a legal spec has none, and every refusal names the field and the fix", () => {
  assert.deepEqual(specProblems(RAW(), REQ), []);
  assert.deepEqual(specProblems("nope", REQ), ["the spec must be a JSON object"]);
  assert.deepEqual(specProblems({ items: "no" }, REQ), ["spec.items: missing — the list of what the user asked for"]);
  const has = (raw, re, opts) => { const p = specProblems(raw, REQ, opts); assert.ok(p.some((m) => re.test(m)), `${re}\n${p.join("\n")}`); };
  has(RAW({ items: [] }), /^spec\.items: empty — every request asks for at least its subject$/);
  has(RAW({ items: Array.from({ length: S.items + 1 }, (_, i) => item(`R${i + 1}`, "object", "a torta", "torta")) }), /^spec\.items: 41, the limit is 40 — merge/);
  has(RAW({ cast: Array.from({ length: 7 }, (_, i) => ({ id: `c${i + 1}`, name: `N${i}`, look: "a person with a coat" })) }), /^spec\.cast: 7 characters, the limit is 6$/);
  has(RAW({ cast: [{ name: "Mara", look: "a thin woman with short blonde hair" }] }), /^spec\.cast\[0\]: needs an id \("c1"\)$/);
  has(RAW({ cast: [{ id: "c1", look: "a thin woman with short blonde hair" }] }), /^spec\.cast\[0\]: needs a name/);
  has(RAW({ cast: [{ id: "c1", name: "Mara", look: "the chef" }] }), /^spec\.cast\[0\] "Mara": "look" must describe how they look in English/);
  has(RAW({ refs: [{ id: "ref1", handle: "kref_12345678", role: "portrait" }] }), /^spec\.refs ref1: role must be one of character, object, place, style$/);
  has(RAW({ refs: [{ id: "ref1", handle: "kref_deadbeef", role: "character" }] }), /^spec\.refs ref1: "kref_deadbeef" is not an image Kleo received/, { handles: ["kref_12345678"] });
  assert.deepEqual(specProblems(RAW({ refs: [{ id: "ref1", handle: "kref_12345678", role: "character" }] }), REQ, { handles: ["kref_12345678"] }), [], "a held handle is fine");
  const items = (patch) => RAW().items.map((it, i) => (i === 0 ? { ...it, ...patch } : it));
  has(RAW({ items: items({ id: "" }) }), /^spec\.items\[0\]: needs an id \("R1"\)$/);
  has(RAW({ items: items({ id: "R2" }) }), /^spec\.items: id "R2" is used twice$/);
  has(RAW({ items: items({ kind: "banana" }) }), /^spec item R1: kind "banana" is not one of character, look, place/);
  has(RAW({ items: items({ text: "x" }) }), /^spec item R1: needs "text", the requirement in plain English$/);
  has(RAW({ items: items({ quote: "" }) }), /^spec item R1: needs "quote", the user's own words it comes from$/);
  has(RAW({ items: items({ quote: "un drago rosso sul tetto" }) }), /^spec item R1: the quote "un drago rosso sul tetto" is not in the user's request — an item must come from what the user wrote/);
  has(RAW({ items: items({ kind: "look", who: null }) }), /^spec item R1: a "look" item names the cast member it describes in "who" \(one of c1\)$/);
  has(RAW({ items: items({ who: "c9" }) }), /^spec item R1: "who" is "c9", which is not a cast id$/);
  has(RAW({ items: RAW().items.map((it) => (it.id === "R5" ? { ...it, order: null } : it)) }), /^spec: every "event" item carries its "order"/);
  has(RAW({ narration: "verbatim", script: "too short" }), /^spec: narration "verbatim" needs the user's narration in "script", word for word$/);
});

/* ------------------------------------------------------------------ the repair */

test("repairSpec: strict refuses an invented item, lenient drops it; the shape is fitted and the mode re-decided", () => {
  const s = SPEC();
  assert.equal(s.v, 1);
  assert.equal(s.mode, "faithful");
  assert.equal(s.items.length, 6);
  assert.deepEqual(s.cast, [{ id: "c1", name: "Mara", look: "a thin woman with short blonde hair", ref: null }]);
  assert.equal(s.narration, "lines"); assert.equal(s.script, null);
  assert.deepEqual(s.open, ["the ending"]);
  // One invented item: the first attempt is sent back, the second keeps the user's spec without it.
  const invented = RAW({ items: [...RAW().items, item("R7", "object", "a red dragon on the roof", "un drago rosso sul tetto")] });
  assert.equal(repairSpec(invented, REQ), null, "strict: an item the user never wrote refuses the spec");
  const lenient = repairSpec(invented, REQ, { lenient: true });
  assert.deepEqual(lenient.items.map((i) => i.id), ["R1", "R2", "R3", "R4", "R5", "R6"], "lenient: the invention is dropped, the rest kept");
  assert.equal(repairSpec(RAW({ items: [item("R1", "object", "a red dragon", "un drago rosso sul tetto")] }), REQ, { lenient: true }), null, "nothing of the user's left: no spec");
  // Lenient REPAIRS what can be repaired (24 September 2026: kimi lost whole specs on one stray field): a "who" that
  // names nobody is cleared, a thin cast look is completed from the character's own look items, events are numbered.
  const strayWho = RAW({ items: RAW().items.map((it) => (it.id === "R1" ? { ...it, who: "c9" } : it)) });
  assert.equal(repairSpec(strayWho, REQ), null, "strict: a who that names nobody refuses the spec");
  assert.equal(repairSpec(strayWho, REQ, { lenient: true }).items.find((i) => i.id === "R1").who, null);
  const thin = repairSpec(RAW({ cast: [{ id: "c1", name: "Mara", look: "baker" }] }), REQ, { lenient: true });
  assert.ok(thin, "a thin look is completed, not refused");
  assert.ok(thin.cast[0].look.split(/\s+/).length >= 3, thin.cast[0].look);
  // Only a spec with nothing of the user's in it, or no items at all, still refuses.
  assert.equal(repairSpec({ items: [] }, REQ, { lenient: true }), null);
  assert.equal(repairSpec("nope", REQ), null);
  // The writer's claim of the mode does not matter: the items decide.
  assert.equal(repairSpec(RAW({ mode: "open" }), REQ).mode, "faithful");
  const bare = repairSpec({ items: [item("R1", "character", "a pastry chef", "una pasticcera")], cast: [], refs: [], open: [] }, REQ);
  assert.equal(bare.mode, "open", "a bare subject is an open film when the writer claimed nothing (a writer's \"faithful\" is kept: see the test below)");
  assert.equal(bare.summary, "a pastry chef", "no summary: the first item stands for it");
  assert.equal(bare.narration, "free");
  // Defaults and clipping.
  const fitted = repairSpec(RAW({
    cast: [{ id: "c1", name: "M".repeat(60), look: `a thin woman ${"with short blonde hair ".repeat(40)}` }],
    items: [
      { id: "R1", kind: "character", text: "Mara, a thin pastry chef", quote: "Mara, una pasticcera magra", who: "c1" },
      { id: "R2", kind: "event", text: "Mara bakes a lemon cake", quote: "prepara una torta al limone", must: false, who: "", order: 1.6 },
      { id: "R3", kind: "object", text: "a lemon cake", quote: "torta al limone", order: 4 },
    ],
    open: ["x".repeat(150), ...Array.from({ length: 10 }, (_, i) => `open ${i}`)],
  }), REQ);
  assert.equal(fitted.cast[0].name.length, S.name); assert.equal(fitted.cast[0].look.length, S.look);
  assert.equal(fitted.items[0].must, true, "must defaults to true: what the user said is required");
  assert.equal(fitted.items[1].must, false);
  assert.equal(fitted.items[1].who, null, "an empty who is no who");
  assert.equal(fitted.items[1].order, 2, "an event's order is a whole number");
  assert.equal(fitted.items[2].order, null, "only events carry an order");
  assert.equal(fitted.open.length, S.open); assert.equal(fitted.open[0].length, S.openLen);
  // The narration: verbatim with its script, or lines when the items carry one.
  const script = "Mara accende il forno all'alba. I bambini aspettano fuori. Poi la festa.";
  const verbatim = repairSpec(RAW({ narration: "verbatim", script }), REQ);
  assert.equal(verbatim.narration, "verbatim"); assert.equal(verbatim.script, script);
  assert.equal(repairSpec(RAW({ narration: undefined }), REQ).narration, "lines", "a line item makes it lines");
  assert.equal(repairSpec(RAW({ narration: "free", script }), REQ).script, null, "a script belongs to verbatim only");
  // References: the ones Kleo holds and with a known role.
  const refd = repairSpec(RAW({ refs: [{ id: "ref1", handle: "kref_12345678", role: "character", for: "c1", description: "a woman in a lilac apron" }] }), REQ, { handles: ["kref_12345678"] });
  assert.deepEqual(refd.refs, [{ id: "ref1", handle: "kref_12345678", role: "character", for: "c1", description: "a woman in a lilac apron" }]);
  assert.deepEqual(REF_ROLES, ["character", "object", "place", "style"]);
});

test("specOf trusts only a stored spec of the right shape", () => {
  const s = SPEC();
  assert.equal(specOf({ spec: s }), s);
  assert.equal(specOf({}), null); assert.equal(specOf(null), null); assert.equal(specOf("x"), null);
  assert.equal(specOf({ spec: { ...s, v: 2 } }), null);
  assert.equal(specOf({ spec: { ...s, items: [] } }), null);
  assert.equal(specOf({ spec: [s] }), null);
});

/* ------------------------------------------------------------------ reading a spec */

test("the readers: must items, shot items, events in order, lookups by id and by name", () => {
  const s = SPEC({ items: [...RAW().items.slice(0, 3), RAW().items[4], RAW().items[3], { ...RAW().items[5], must: false }] });
  assert.deepEqual(mustItems(s).map((i) => i.id), ["R1", "R2", "R3", "R5", "R4"]);
  assert.deepEqual(shotItems(s).map((i) => i.id), ["R1", "R2", "R3", "R5", "R4"], "a line is heard, not shown");
  assert.deepEqual(eventsInOrder(s).map((i) => i.id), ["R4", "R5"], "sorted by the user's order, not the list's");
  assert.equal(itemById(s, "R3").text, "Mara wears a lilac apron");
  assert.equal(itemById(s, "R99"), undefined);
  assert.equal(castById(s, "c1").name, "Mara");
  assert.equal(castById(s, "mara").id, "c1", "by name, case folded");
  assert.equal(castById(s, "Màra").id, "c1", "by name, accents folded");
  assert.equal(castById(s, "c7"), undefined);
});

test("fullLook folds every look item the writer's sentence forgot into the look the painter gets", () => {
  const s = SPEC();
  // R2 (short blonde hair) is already in the sentence; R3 (lilac apron) is not, and is added.
  assert.equal(fullLook(s, "c1"), "a thin woman with short blonde hair; Mara wears a lilac apron");
  assert.equal(fullLook(s, "Mara"), fullLook(s, "c1"), "by name too");
  assert.equal(fullLook(s, "c9"), "");
  const all = SPEC({ cast: [{ id: "c1", name: "Mara", look: "Mara, a thin woman who wears a lilac apron, with short blonde hair." }] });
  assert.equal(fullLook(all, "c1"), "Mara, a thin woman who wears a lilac apron, with short blonde hair", "nothing to add, the full stop trimmed");
});

test("specBlock, owedBlock and specText print the spec for the planner and for the user", () => {
  const s = SPEC();
  const b = specBlock(s);
  assert.match(b, /^THE USER'S REQUEST, AS REQUIREMENTS \(the brief — FAITHFUL: this is the user's film/);
  assert.match(b, /CAST \(draw each exactly like this[^\n]*\n {2}c1 Mara: a thin woman with short blonde hair; Mara wears a lilac apron/);
  assert.match(b, / {2}R4 \[event #1, MUST\] happens: Mara bakes a lemon cake for the village children \(c1\) — user: "prepara una torta al limone per i bambini del paese"/);
  assert.match(b, /ORDER: the events happen in this order: R4 → R5\. Never reorder them\./);
  assert.match(b, /LEFT TO KLEO \(decide these, and list each decision\): the ending\./);
  assert.match(specBlock(SPEC({ open: [] })), /LEFT TO KLEO: only how it is told — nothing about WHAT happens\./);
  const script = "Mara accende il forno all'alba. I bambini aspettano fuori. Poi la festa.";
  assert.match(specBlock(SPEC({ narration: "verbatim", script })), /THE NARRATION IS THE USER'S, WORD FOR WORD/);
  assert.match(specBlock({ ...s, mode: "open" }), /the brief — OPEN: the user gave a subject/);
  const owed = owedBlock(s, ["R4", "R99", "R6"]);
  assert.match(owed, /^THESE SCENES MUST SHOW OR SAY/);
  assert.match(owed, /R4 \[event\] Mara bakes/); assert.match(owed, /R6 \[line\]/); assert.ok(!owed.includes("R99"));
  assert.equal(owedBlock(s, []), ""); assert.equal(owedBlock(s, ["R99"]), "");
  const t = specText(s);
  assert.match(t, /^What Kleo understood \(your film, as you described it\): Mara, a thin pastry chef/);
  assert.match(t, /Characters:\n- Mara: a thin woman with short blonde hair; Mara wears a lilac apron/);
  assert.match(t, /What happens, in order: Mara bakes a lemon cake for the village children; the children throw Mara a surprise party/);
  assert.match(t, /The narrator says: the narrator says 'la torta più buona del mondo'/);
  assert.match(t, /Left to Kleo: the ending/);
});

test("the method and the prompts: extraction, not creativity, with the user's answers and images", () => {
  assert.match(SPEC_METHOD, /You invent nothing: you extract/);
  assert.match(SPEC_METHOD, /"quote" is the user's own words, copied verbatim/);
  for (const k of SPEC_KINDS) assert.ok(SPEC_METHOD.includes(k), `the method names the kind ${k}`);
  const p = specPrompt({ prompt: `  ${REQ}  `, language: "it", must_keep: "il grembiule lilla", audience: "bambini", tone: "tenero", refs: [{ handle: "kref_12345678", description: "a woman in a lilac apron", role: "character", name: "Mara" }] });
  assert.match(p, /^USER REQUEST \(language: it\):\n"""Mara, una pasticcera/);
  assert.match(p, /The user answered "what must appear or must not": "il grembiule lilla"/);
  assert.match(p, /The user said the film is for: "bambini"/);
  assert.match(p, /The user asked for this tone: "tenero"/);
  assert.match(p, /- kref_12345678 \(the user says: character — Mara\): a woman in a lilac apron/);
  assert.ok(!/REJECTED/.test(p));
  assert.match(specPrompt({ prompt: REQ, language: "it" }, ["spec item R1: needs a quote"]), /YOUR PREVIOUS ANSWER WAS REJECTED[\s\S]*- spec item R1: needs a quote/);
  const m = specMethodText({ prompt: REQ, language: "it", refs: [{ handle: "kref_12345678", description: "a woman" }] });
  assert.ok(m.includes(SPEC_METHOD));
  assert.match(m, /IMAGES KLEO HOLDS FOR THIS FILM: kref_12345678 \(a woman\)/);
  assert.match(m, /kleo_upload_link/);
  const schema = specSchema();
  assert.deepEqual(schema.properties.items.items.properties.kind.enum, [...SPEC_KINDS]);
  assert.ok(schema.required.includes("items") && schema.required.includes("cast") && schema.required.includes("narration"));
});

/* ------------------------------------------------------------------ the narrator's lines */

test("lineSaid: the user's words in the narration, verbatim or 80% of them in order", () => {
  assert.equal(lineSaid("festa a sorpresa", "Poi arriva la festa a sorpresa!"), true);
  assert.equal(lineSaid("la torta più buona del mondo", "Dicono: LA TORTA PIU BUONA DEL MONDO."), true, "case and accents folded");
  assert.equal(lineSaid("the best cake in the world", "It was, they said, the best lemon cake in all the world"), true, "the grammar adapted, the words in order");
  assert.equal(lineSaid("best cake world", "the world has a cake that is best"), false, "the words out of order are another sentence");
  assert.equal(lineSaid("the best cake in the world", "a cake"), false);
  assert.equal(lineSaid("", "anything"), true, "nothing to say is said");
  assert.equal(lineSaid("a b", "anything else"), false, "only short words, and not there verbatim");
});

/* ------------------------------------------------------------------ coverage */

/** A storyboard that covers the whole spec: R1 and R3 and R4 in the first shot, R2 in the second, R5 later, R6 said. */
const BOARD = () => ({
  scenes: [
    { id: "01-oven", voice: "All'alba Mara accende il forno. Dicono: la torta più buona del mondo.", shots: [
      { image_prompt: "Mara at the oven", covers: ["R1", "R3", "R4"], cast: ["c1"] },
      { image_prompt: "Mara's hair", covers: ["R2"], cast: ["Mara"] },
    ] },
    { id: "02-party", voice: "Poi i bambini arrivano.", shots: [{ image_prompt: "The party", covers: ["R5"], cast: ["c1"] }] },
  ],
});

test("coverage: a storyboard that covers every must item in the user's order has no problem", () => {
  const c = coverage(SPEC(), BOARD());
  assert.deepEqual(c, { uncovered: [], outOfOrder: [], unknownIds: [], unknownCast: [], problems: [] });
});

test("coverage: an uncovered visual item, an unsaid line, an event out of order, unknown ids and cast", () => {
  const s = SPEC();
  const lost = BOARD(); lost.scenes[1].shots[0].covers = [];
  const c1 = coverage(s, lost);
  assert.deepEqual(c1.uncovered, ["R5"]);
  assert.match(c1.problems[0], /^R5 \(event\): no shot shows "the children throw Mara a surprise party" — give it to the shot where it happens, write it into that shot's image_prompt, and list "R5" in its "covers"$/);
  const mute = BOARD(); mute.scenes[0].voice = "All'alba Mara accende il forno.";
  const c2 = coverage(s, mute);
  assert.deepEqual(c2.uncovered, ["R6"]);
  assert.match(c2.problems[0], /^R6: the narrator never says "la torta più buona del mondo", which the user asked to be said/);
  const swapped = BOARD(); swapped.scenes[0].shots[0].covers = ["R1", "R3", "R5"]; swapped.scenes[1].shots[0].covers = ["R4"];
  const c3 = coverage(s, swapped);
  assert.deepEqual(c3.outOfOrder, ["R5"]);
  assert.ok(c3.problems.some((p) => /^R5 \(event #2\) is shown before R4, but the user told it after: keep the user's order of events$/.test(p)), c3.problems.join("\n"));
  const odd = BOARD(); odd.scenes[1].shots[0].covers = ["R5", "R99", "R98"]; odd.scenes[1].shots[0].cast = ["c1", "c7", "Luigi"];
  const c4 = coverage(s, odd);
  assert.deepEqual(c4.unknownIds, ["R99", "R98"]);
  assert.deepEqual(c4.unknownCast, ["c7", "Luigi"]);
  assert.ok(c4.problems.some((p) => p === `"covers" names "R99", "R98", which are not items of the spec — use the spec's ids (R1, R2…)`), c4.problems.join("\n"));
  assert.ok(c4.problems.some((p) => /^"cast" names "c7", "Luigi", which are not in the spec's cast/.test(p)), c4.problems.join("\n"));
  // One unknown id reads in the singular.
  const one = BOARD(); one.scenes[1].shots[0].covers = ["R5", "R99"];
  assert.ok(coverage(s, one).problems.includes(`"covers" names "R99", which is not an item of the spec — use the spec's ids (R1, R2…)`));
});

test("coverage: a character is covered by the shots that show her; a hint, a mood and an exclusion are not owed to a shot", () => {
  const s = SPEC();
  // R1 no longer claimed anywhere, but Mara is in the cast of three shots: she is on screen.
  const board = BOARD(); board.scenes[0].shots[0].covers = ["R3", "R4"];
  assert.deepEqual(coverage(s, board).uncovered, []);
  // Nobody lists her and nobody claims R1: the character is lost.
  const gone = BOARD(); gone.scenes[0].shots[0].covers = ["R3", "R4"]; for (const sc of gone.scenes) for (const sh of sc.shots) sh.cast = [];
  assert.deepEqual(coverage(s, gone).uncovered, ["R1"]);
  // A nice-to-have, a mood, a style and an exclusion never need a shot.
  const soft = SPEC({ items: [...RAW().items, item("R7", "object", "a lemon cake", "torta al limone", { must: false }), item("R8", "mood", "tender", "per i bambini"), item("R9", "exclude", "no adults", "i bambini")] });
  assert.deepEqual(coverage(soft, BOARD()).uncovered, []);
  // Garbage in, no crash out.
  assert.deepEqual(coverage(s, null).uncovered.sort(), ["R1", "R2", "R3", "R4", "R5", "R6"].sort());
  assert.deepEqual(coverage(s, { scenes: "x" }).unknownIds, []);
});

/* ------------------------------------------------------------------ the questions a still is judged by */

test("visualChecks: the style always, then one question per claimed item and per attribute of each character shown", () => {
  assert.deepEqual(visualChecks(null, {}, "realistic"), [{ id: "style", question: "Does this image look like a real photograph (not a drawing, painting or 3D render)?", expect: "yes", must: true }]);
  assert.match(visualChecks(null, {}, "animation")[0].question, /drawn 2D animation frame/);
  const s = SPEC();
  const checks = visualChecks(s, { covers: ["R4", "R6"], cast: ["c1"] }, "realistic");
  assert.deepEqual(checks.map((c) => c.id), ["style", "R4", "R2", "R3", "no-text"], "the line is heard, not seen; Mara's two look items are asked one by one");
  assert.deepEqual(checks[1], { id: "R4", question: "Could this image be a moment of this: Mara bakes a lemon cake for the village children?", expect: "yes", must: false }, "an event is a story beat: asked softly");
  assert.deepEqual(checks.filter((c) => c.must).map((c) => c.id), ["style", "R2", "R3"]);
  assert.deepEqual(checks.at(-1), { id: "no-text", question: "Is there any written text, lettering, caption or watermark in the image?", expect: "no", must: false });
  // A claimed look item brings its character in, and is not asked twice.
  assert.deepEqual(visualChecks(s, { covers: ["R3"] }, "realistic").map((c) => c.id), ["style", "R3", "R2", "no-text"]);
  // A character with no look item is asked about as a whole, by her description; a name is as good as an id.
  const plain = SPEC({ items: RAW().items.filter((i) => i.kind !== "look") });
  const whole = visualChecks(plain, { cast: ["Mara"] }, "animation");
  assert.deepEqual(whole.find((c) => c.id === "cast:c1"), { id: "cast:c1", question: "Is there a character matching this description: a thin woman with short blonde hair?", expect: "yes", must: true });
  // A text to read replaces the no-text check; a style is asked softly; an exclusion is a must answered "no".
  const signed = SPEC({ items: [...RAW().items, item("R7", "text", "the shop sign reads 'Da Mara'", "pasticcera"), item("R8", "style", "warm pastel colours", "bambini", { must: true }), item("R9", "exclude", "no adults", "bambini")] });
  const sc = visualChecks(signed, { covers: ["R7"] }, "realistic");
  assert.equal(sc.find((c) => c.id === "R7").question, "Is the following text clearly written and readable in the image: the shop sign reads 'Da Mara'?");
  assert.ok(!sc.some((c) => c.id === "no-text"), "the words are the point of this picture");
  assert.deepEqual(sc.find((c) => c.id === "R8"), { id: "R8", question: "Is the image in this style: warm pastel colours?", expect: "yes", must: false });
  assert.deepEqual(sc.find((c) => c.id === "exclude:R9"), { id: "exclude:R9", question: "Does the image show any of this: adults?", expect: "no", must: true });
  // Unknown ids and cast are ignored, never asked about.
  assert.deepEqual(visualChecks(s, { covers: ["R99"], cast: ["c9"] }, "realistic").map((c) => c.id), ["style", "no-text"]);
});

test("visualChecks (24 September, the fidelity bench): only what one frame proves is a must — a cast character by her look, never her role; events, actions, build and age asked softly", () => {
  const s = SPEC();
  // R1 "Mara, a thin pastry chef" asks nothing of its own: Mara is in the cast, her look items are asked instead (and,
  // when the still is drawn from her sheet, an identity question: src/stills.ts).
  assert.deepEqual(visualChecks(s, { covers: ["R1"] }, "realistic").map((c) => c.id), ["style", "R2", "R3", "no-text"]);
  assert.ok(!visualChecks(s, { covers: ["R1"], cast: ["c1"] }, "realistic").some((c) => /pastry chef/.test(c.question)), "a role is never asked about");
  // Found by name when the writer left "who" empty; a role-named cast ("the pastry chef") is found in "a pastry chef".
  const noWho = SPEC({ items: RAW().items.map((i) => (i.id === "R1" ? { ...i, who: null } : i)) });
  assert.deepEqual(visualChecks(noWho, { covers: ["R1"] }, "realistic").map((c) => c.id), ["style", "R2", "R3", "no-text"]);
  const role = SPEC({ cast: [{ id: "c1", name: "the pastry chef", look: "a woman with short blonde hair and a lilac apron" }], items: [item("R1", "character", "a pastry chef", "una pasticcera magra"), ...RAW().items.slice(1)] });
  assert.equal(castOfItem(role, role.items[0]).id, "c1");
  assert.deepEqual(visualChecks(role, { covers: ["R1"] }, "realistic").map((c) => c.id), ["style", "R2", "R3", "no-text"]);
  assert.equal(castOfItem(s, { text: "a Marathon runner", quote: "x", who: null }), undefined, "a name inside another word is not the name");
  // A character the cast does not hold (a crowd, a passer-by) is asked about concretely, and stays a must.
  const crowd = SPEC({ items: [...RAW().items, item("R7", "character", "the village children.", "i bambini del paese")] });
  assert.equal(castOfItem(crowd, crowd.items[6]), undefined);
  assert.deepEqual(visualChecks(crowd, { covers: ["R7"] }, "realistic").find((c) => c.id === "R7"), { id: "R7", question: "Does the image show the village children?", expect: "yes", must: true });
  // An action is a story beat like an event: a frame can be a moment of it, never prove it.
  const act = SPEC({ items: [...RAW().items, item("R7", "action", "Mara pipes cream onto the cake", "prepara una torta", { who: "c1" })] });
  assert.deepEqual(visualChecks(act, { covers: ["R7"] }, "realistic").find((c) => c.id === "R7"), { id: "R7", question: "Could this image be a moment of this: Mara pipes cream onto the cake?", expect: "yes", must: false });
  // Build and age are soft, claimed or folded in by the cast; hair, clothes and colours stay musts.
  const body = SPEC({ items: [...RAW().items, item("R7", "look", "Mara has a thin build", "pasticcera magra", { who: "c1" }), item("R8", "look", "Mara is in her thirties", "Mara", { who: "c1" })] });
  assert.deepEqual(visualChecks(body, { cast: ["c1"] }, "realistic").filter((c) => /^R\d$/.test(c.id)).map((c) => [c.id, c.must]), [["R2", true], ["R3", true], ["R7", false], ["R8", false]]);
  assert.equal(visualChecks(body, { covers: ["R7"] }, "realistic").find((c) => c.id === "R7").must, false);
  for (const t of ["Mara is thin", "a thin build", "tall", "short in height", "an elderly man", "in her thirties", "a 70-year-old", "muscular", "slim and young"]) assert.equal(bodyOnlyLook(t), true, t);
  for (const t of ["Mara has short blonde hair tied up", "Mara wears a lilac apron", "a tall man in a red coat", "an old-fashioned hat", "green eyes", "a scar on the left cheek", "a thin gold necklace"]) assert.equal(bodyOnlyLook(t), false, t);
});

/* ------------------------------------------------------------------ review fixes (24 September 2026) */

test("modeFor keeps the writer's FAITHFUL when it stands on the user's story; never on a bare topic, never on a delegation", () => {
  // "un film su mio nonno Pietro": one character, nothing about him. The assistant was told "faithful when the user
  // described who is in it" and wrote an as-told treatment; the spec used to be re-decided OPEN and the treatment refused.
  const nonno = [item("R1", "character", "the user's grandfather Pietro", "mio nonno Pietro")];
  assert.equal(modeFor(nonno, "un film su mio nonno Pietro"), "open", "no claim: the contents decide");
  assert.equal(modeFor(nonno, "un film su mio nonno Pietro", "faithful"), "faithful", "the writer's claim, on a character");
  for (const k of ["event", "shot", "text", "line"]) assert.equal(modeFor([item("R1", k, `a ${k}`, "q")], "x", "faithful"), "faithful", k);
  // A claim on nothing of the user's story, or on hints only, or against a delegation: open.
  assert.equal(modeFor([item("R1", "object", "a lighthouse", "q")], "x", "faithful"), "open", "a topic is not a story");
  assert.equal(modeFor([item("R1", "character", "a cat", "q", { must: false })], "x", "faithful"), "open", "a hint is not a story");
  assert.equal(modeFor(nonno, "Stupiscimi con un film su mio nonno Pietro", "faithful"), "open", "a delegation is open whatever anybody claims");
  // An "open" claim is still overruled upwards by the contents.
  assert.equal(modeFor([item("E1", "event", "a", "q", { order: 1 }), item("E2", "event", "b", "q", { order: 2 })], "x", "open"), "faithful");
  // repairSpec passes the claim on.
  const claimed = repairSpec({ mode: "faithful", items: [item("R1", "character", "a pastry chef", "una pasticcera")], cast: [], refs: [], open: [] }, REQ);
  assert.equal(claimed.mode, "faithful");
  const topic = repairSpec({ mode: "faithful", items: [item("R1", "object", "a lemon cake", "torta al limone")], cast: [], refs: [], open: [] }, REQ);
  assert.equal(topic.mode, "open");
  assert.match(SPEC_METHOD, /A faithful spec carries at least one such item with "must": true/);
});

test("the user's corrections are what the user said: the refusal names them, the server's writer is given them", () => {
  const p = specProblems(RAW({ items: [...RAW().items, item("R7", "character", "the user's dog Pepe with a red collar", "il mio cane Pepe col collare rosso")] }), REQ);
  assert.ok(p.some((x) => /R7: the quote "il mio cane Pepe col collare rosso" is not in the user's request — an item must come from what the user wrote: the prompt, their answers \(must_keep, audience, tone\), or the corrections they gave after the read-back, passed word for word as "corrections"/.test(x)), p.join("\n"));
  assert.ok(!p.some((x) => /put what Kleo decides under "open"/.test(x)), "a user's correction is never sent to open");
  // With the corrections in the request text, the same item is the user's.
  assert.deepEqual(specProblems(RAW({ items: [...RAW().items, item("R7", "character", "the user's dog Pepe with a red collar", "il mio cane Pepe col collare rosso")] }), `${REQ}\naggiungi il mio cane Pepe col collare rosso`), []);
  assert.match(specPrompt({ prompt: REQ, language: "it", corrections: "aggiungi il mio cane Pepe" }), /After reading back what Kleo understood, the user corrected it: "aggiungi il mio cane Pepe"/);
  assert.ok(!/corrected it/.test(specPrompt({ prompt: REQ, language: "it" })));
  assert.match(specMethodText({ prompt: REQ, language: "it" }), /pass their correction, in their own words, as "corrections" to kleo_create_video/);
});

test("coverage: a shot's cast may name the direction's own characters, not only the spec's", () => {
  // An open request ("a Short about pirates"): the spec has no cast, the direction invents Captain Rook.
  const open = repairSpec({ mode: "open", items: [item("R1", "object", "pirates", "pirates")], cast: [], refs: [], open: ["the characters"] }, "a Short about pirates");
  const sb = { direction: { cast: [{ name: "Captain Rook", look: "a tall woman in a salt-stained blue coat" }] }, scenes: [
    { id: "01-deck", voice: "The pirates sail at dawn.", shots: [{ image_prompt: "Captain Rook on the deck", covers: ["R1"], cast: ["Captain Rook"] }] },
  ] };
  assert.deepEqual(coverage(open, sb).problems, []);
  assert.deepEqual(coverage(open, sb).unknownCast, []);
  // A planner chunk carries only its scenes: the names can be passed.
  assert.deepEqual(coverage(open, { scenes: sb.scenes }, { cast: ["Captain Rook"] }).unknownCast, []);
  // A name nobody declared is still refused, and the message says where names come from.
  const c = coverage(open, { scenes: sb.scenes });
  assert.deepEqual(c.unknownCast, ["Captain Rook"]);
  assert.ok(c.problems.some((x) => x === `"cast" names "Captain Rook", which is not in the spec's cast or the direction's — use the spec's ids (it has none) or a name from direction.cast`), c.problems.join("\n"));
  // A faithful spec plus a direction sidekick: both known.
  const s = SPEC();
  const board = BOARD(); board.direction = { cast: [{ name: "Mara", look: "x", id: "c1" }, { name: "Nino the baker's boy", look: "a boy" }] };
  board.scenes[1].shots[0].cast = ["c1", "Nino the baker's boy"];
  assert.deepEqual(coverage(s, board).unknownCast, []);
});

test("a look is asked with its character's name, and stays a must with two characters in the frame (24 September 2026)", () => {
  // Production probes: a bare "curly red hair" was answered "no" on a picture that showed it (whose hair?), and softening
  // every look with two characters let the fisherman's dog lose the one white ear the user asked for.
  const base = SPEC();
  const s = { ...base, cast: [...base.cast, { id: "c2", name: "black dog", look: "a black dog with one white ear", ref: null }], items: [...base.items, item("R7", "look", "one white ear", "orecchio bianco", { who: "c2" })] };
  const two = visualChecks(s, { covers: ["R7"], cast: ["c1", "c2"] }, "realistic");
  const ear = two.find((c) => c.id === "R7");
  assert.equal(ear.question, "Does the black dog have or wear this: one white ear?");
  assert.equal(ear.must, true, "a distinctive look stays a must with two characters");
  // A look that already names its character is asked as written; a proper name takes no article.
  const own = two.find((c) => c.id === "R2");
  assert.ok(own && !/Does the Mara/.test(own.question), own && own.question);
});
