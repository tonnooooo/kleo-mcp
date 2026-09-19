/**
 * Unit tests for src/direction.ts and the rules it puts into src/keou-contract.ts: the art direction of one film,
 * the colour law, the fidelity gate (does the narration still say what the user asked for) and the exclusion list
 * (does any picture ask for something this film forbids).
 * Run: node --test test/direction.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  directionProblems, sectionOfScene, missingFacts, forbiddenInPrompts, pictureContext, negativeFor, notEnglish, foreignPictureFields, lightsPictures, headNounIn,
  castFor, conformity, ACCENT_LIGHT, stillness, enliven, livingClause, ENLIVEN_CLAUSES, D,
} from "../src/direction.ts";
import { validateStoryboard, qualityProblems, directionOf, narrationOf, pictureScenes, CINEMA_ACCENTS, SHOTS_MIN_CINEMA, shotRangeText } from "../src/keou-contract.ts";
import { fullPrompt, modelInputs, NEGATIVE_PROMPT, STYLE_SUFFIX, DEFAULT_IMAGE_MODELS } from "../src/images.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "test", "fixtures", `${name}.json`), "utf8"));
const pirates = () => fixture("cartoon-pirates");
const opts = { accents: CINEMA_ACCENTS };

/** A direction that passes, so every test below can break exactly one thing about it. */
const good = (over = {}) => ({
  subject: "The pirate captain who buried a treasure and never came back",
  goal: "The viewer wants to know what happened to the treasure",
  audience: "People who like short adventure stories",
  tone: "Warm and a little eerie",
  must_keep: ["1720", "Skull Beach"],
  world: "A tropical island in 1720: golden beaches, turquoise water, palm trees, wooden ships with red sails",
  cast: [{ name: "the captain", look: "a pirate captain with a red bandana and a long dark braid" }],
  objects: ["wooden chest", "red-sailed ship", "palm trees", "wet sand"],
  forbidden: ["wifi symbol", "phone", "brand logo", "text in the picture"],
  sections: [
    { name: "01 THE BURIAL", accent: "amber", means: "what was hidden", scenes: 2 },
    { name: "02 THE STORM", accent: "red", means: "what went wrong", scenes: 2 },
    { name: "03 THE QUESTION", accent: "green", means: "what you are left with", scenes: 1 },
  ],
  ...over,
});

/* ------------------------------------------------------------------ shape */

test("a well-formed direction has no problems, and every limit is enforced", () => {
  assert.deepEqual(directionProblems(good(), { ...opts, scenes: 5 }), []);
  assert.ok(directionProblems("nope", opts)[0].includes("must be a JSON object"));

  const long = directionProblems(good({ subject: "x".repeat(D.subject + 1) }), opts);
  assert.ok(long.some((p) => /direction\.subject is \d+ characters/.test(p)), long.join("\n"));

  for (const field of ["subject", "goal", "audience", "tone", "world"]) {
    const missing = directionProblems(good({ [field]: "" }), opts);
    assert.ok(missing.some((p) => p === `direction.${field} is required`), `${field}: ${missing.join("; ")}`);
  }

  const fewObjects = directionProblems(good({ objects: ["one"] }), opts);
  assert.ok(fewObjects.some((p) => /direction\.objects has 1 entries, it needs 3-12/.test(p)), fewObjects.join("\n"));

  const dupes = directionProblems(good({ forbidden: ["phone", "Phone", "logo", "text"] }), opts);
  assert.ok(dupes.some((p) => /direction\.forbidden\[1\] repeats "Phone"/.test(p)), dupes.join("\n"));

  // must_keep may legitimately be empty: a one-line prompt states no facts to preserve.
  assert.deepEqual(directionProblems(good({ must_keep: [] }), { ...opts, scenes: 5 }), []);
  assert.ok(directionProblems(good({ must_keep: "1720" }), opts).some((p) => /must_keep must be an array/.test(p)));

  // A cast member is optional, but a listed one must carry the description that keeps a face a face.
  assert.deepEqual(directionProblems(good({ cast: [] }), { ...opts, scenes: 5 }), []);
  assert.ok(directionProblems(good({ cast: [{ name: "the captain" }] }), opts).some((p) => /cast\[0\]\.look is required/.test(p)));
});

test("the colour law: sections tile the film and no two in a row share an accent", () => {
  const short = directionProblems(good(), { ...opts, scenes: 9 });
  assert.ok(short.some((p) => /sections cover 5 scenes but the video has 9/.test(p)), short.join("\n"));

  const repeated = good({
    sections: [
      { name: "A", accent: "red", means: "one", scenes: 2 },
      { name: "B", accent: "red", means: "two", scenes: 3 },
    ],
  });
  const problems = directionProblems(repeated, { ...opts, scenes: 5 });
  assert.ok(problems.some((p) => /sections\[1\] repeats the accent "red"/.test(p)), problems.join("\n"));

  assert.ok(directionProblems(good({ sections: [] }), opts).some((p) => /sections must be an array of 2-8/.test(p)));
  assert.ok(directionProblems(good({ sections: [{ name: "A", accent: "purple", means: "x", scenes: 5 }, { name: "B", accent: "red", means: "y", scenes: 1 }] }), opts)
    .some((p) => /sections\[0\]\.accent must be one of/.test(p)));
});

test("sectionOfScene walks the sections, and covers a film that gained a scene", () => {
  const d = good();
  const owners = sectionOfScene(d.sections, 5).map((s) => s.accent);
  assert.deepEqual(owners, ["amber", "amber", "red", "red", "green"]);
  // A storyboard whose sections do not add up is a validation error, not a crash: the last section covers the rest.
  assert.deepEqual(sectionOfScene(d.sections, 7).map((s) => s.name).slice(-2), ["03 THE QUESTION", "03 THE QUESTION"]);
  assert.deepEqual(sectionOfScene([], 2), [null, null]);
});

/* ------------------------------------------------------------------ fidelity */

test("missingFacts: a number that changed is a fact that changed", () => {
  assert.deepEqual(missingFacts(["1720", "Skull Beach"], "In 1720 the captain buried her chest on Skull Beach."), []);
  assert.deepEqual(missingFacts(["1720"], "In 1719 the captain buried her chest."), ["1720"], "a rounded-away number is a missing fact");
  assert.deepEqual(missingFacts(["3 million doors"], "Three million doors are affected."), ["3 million doors"], "digits are checked as digits");
  assert.deepEqual(missingFacts(["Skull Beach"], "She buried it on a beach somewhere."), ["Skull Beach"]);
  // Forgiving on wording, strict on substance: most of the content words have to survive, not all of them.
  assert.deepEqual(missingFacts(["five common beginner mistakes"], "Here are the five mistakes beginners make."), []);
  // An item made only of stop words proves nothing and is skipped rather than failed.
  assert.deepEqual(missingFacts(["and the"], "anything at all"), []);
  assert.deepEqual(missingFacts([], "anything at all"), []);
});

test("forbiddenInPrompts catches the wrong world, on whole words only", () => {
  const prompts = [
    { id: "01-a-s1", image_prompt: "A pirate captain on a golden beach at sunset" },
    { id: "02-b-s1", image_prompt: "A storm at sea with a wifi symbol glowing over the mast" },
    { id: "03-c-s1", image_prompt: "A map in context, drawn on old paper" },
  ];
  const hits = forbiddenInPrompts(["wifi symbol", "text"], prompts);
  assert.deepEqual(hits, [{ id: "02-b-s1", term: "wifi symbol" }], "'text' must not fire on 'context'");
  assert.deepEqual(forbiddenInPrompts([], prompts), []);
  assert.deepEqual(forbiddenInPrompts(["WIFI SYMBOL"], prompts).map((h) => h.id), ["02-b-s1"], "case does not matter");
});

/* ------------------------------------------------------------------ the direction reaches the picture */

test("pictureContext appends the cast look, the world and the section light — in that order", () => {
  const d = good();
  const ctx = pictureContext(d, "The captain walks along the shoreline at dusk", "red");
  assert.ok(ctx.startsWith("the captain: a pirate captain with a red bandana"), ctx);
  assert.ok(ctx.includes("A tropical island in 1720"), ctx);
  assert.ok(ctx.endsWith(ACCENT_LIGHT.red), ctx);
  // A picture that shows nobody carries no cast description.
  assert.ok(!pictureContext(d, "An empty beach at dawn", null).includes("red bandana"));
  assert.equal(pictureContext(null, "anything", "red"), "");
  assert.deepEqual(castFor(d.cast, "the captain looks out to sea").map((m) => m.name), ["the captain"]);
  assert.deepEqual(castFor(d.cast, "an empty deck"), []);
});

test("the animation look gets no light in its pictures, and the cast still leads", () => {
  // On the turbo SDXL model "a single warm red light source" is a colour cast: a pastel story about a pastry chef
  // opened on a red kitchen, a red apron and a red sauce (job gt_ad2musq5, 19 September 2026).
  const d = good();
  const drawn = pictureContext(d, "The captain walks along the shoreline at dusk", "red", "animation");
  assert.ok(drawn.startsWith("the captain: a pirate captain with a red bandana"), drawn);
  assert.ok(!drawn.includes("light source"), drawn);
  assert.ok(pictureContext(d, "The captain walks along the shoreline at dusk", "red", "realistic").endsWith(ACCENT_LIGHT.red));
  assert.ok(pictureContext(d, "The captain walks along the shoreline at dusk", "red", "cartoon").endsWith(ACCENT_LIGHT.red));
  assert.equal(lightsPictures("animation"), false);
  assert.equal(lightsPictures("realistic"), true);
  assert.equal(lightsPictures(null), true, "an unknown look keeps the light");
});

test("castFor: the cast name, its head noun, or — with one character — a pronoun, attaches the look", () => {
  // Job gt_7f7aaac6 (19 September 2026): "She holds a spoon and mixes a bowl of batter" carried no look and was drawn
  // as a brunette in a red apron, between eight pictures of the blonde pastry chef in lilac.
  const chef = [{ name: "the pastry chef", look: "a thin woman with short blonde hair tied up, in a lilac apron" }];
  const names = (cast, p) => castFor(cast, p).map((m) => m.name);
  assert.deepEqual(names(chef, "The pastry chef decorates a cake"), ["the pastry chef"], "the whole name");
  assert.deepEqual(names(chef, "The chef decorates a cake with colorful frosting"), ["the pastry chef"], "the head noun of the name");
  assert.deepEqual(names(chef, "She holds a spoon and mixes a bowl of batter"), ["the pastry chef"], "a pronoun, when the film has one character");
  assert.deepEqual(names(chef, "Children gather around her, happy and excited"), ["the pastry chef"]);
  assert.deepEqual(names(chef, "A colorful party scene with balloons and streamers"), [], "nobody named, nobody drawn");
  assert.deepEqual(names(chef, "The families of the children are whispering to each other"), [], "'their' and 'they' are not her");
  assert.deepEqual(names(chef, "A chefs' hat on the counter"), [], "'chefs' is not the whole word 'chef'");
  // Two characters: a pronoun could be either, so only a name attaches a look.
  const two = [...chef, { name: "the baker", look: "a tall man in a white apron" }];
  assert.deepEqual(names(two, "She holds a spoon"), []);
  assert.deepEqual(names(two, "The baker and the pastry chef at the oven"), ["the pastry chef", "the baker"]);
  assert.deepEqual(names(two, "The chef at the oven"), ["the pastry chef"]);
  assert.equal(headNounIn("the man", "a man at the window"), false, "a three-letter head is never matched (manuscript)");
  assert.equal(headNounIn("the captain", "the captain's chair"), true);
  // pictureContext follows the same rule, so the worker (its mirror) and the server draw the same picture.
  const d = { ...good(), cast: chef };
  assert.ok(pictureContext(d, "She turns the cake out of its tin", null, "animation").startsWith("the pastry chef: a thin woman"));
});

test("notEnglish reads Italian and French off their function words; foreignPictureFields names what must be English", () => {
  assert.equal(notEnglish("una dolce pasticcera magra con i capelli biondi corti e raccolti, con il grembiule lilla"), true);
  assert.equal(notEnglish("le grand phare au bord de la mer, avec une lumière chaude"), true);
  assert.equal(notEnglish("a thin pastry chef with short blonde hair tied up, in a lilac apron, in her warm kitchen"), false);
  assert.equal(notEnglish("the captain"), false, "one name is not a sentence");
  assert.equal(notEnglish("grembiule lilla"), false, "two nouns cannot be told apart; the direction pass translates them anyway");
  assert.equal(notEnglish(""), false); assert.equal(notEnglish(null), false);
  const d = { world: "Un paesino di campagna con case piccole e strade sterrate", cast: [{ name: "la pasticcera", look: "una donna magra con i capelli biondi corti e il grembiule lilla" }, { name: "the baker", look: "a tall man in a white apron" }], objects: ["cucina", "grembiule", "torta"], forbidden: ["uomini d'affari", "computer", "telefono"] };
  assert.deepEqual(foreignPictureFields(d), ["world", "cast[0]"], "single words cannot be judged; sentences can");
  assert.deepEqual(foreignPictureFields({ world: "A country village of small houses and dirt roads", cast: [{ name: "the pastry chef", look: "a thin woman with short blonde hair tied up and a lilac apron" }], objects: ["kitchen"], forbidden: ["phone"] }), []);
  assert.deepEqual(foreignPictureFields(null), []);
});

test("negativeFor puts this film's exclusion list behind the product-wide one", () => {
  const neg = negativeFor(good(), NEGATIVE_PROMPT);
  assert.ok(neg.startsWith(NEGATIVE_PROMPT), neg);
  assert.ok(neg.includes("wifi symbol"), neg);
  assert.equal(negativeFor(null, NEGATIVE_PROMPT), NEGATIVE_PROMPT);
});

test("the image call carries the direction: prompt context and per-film negatives", () => {
  const d = good();
  const plain = fullPrompt("cartoon", "A ship at anchor");
  assert.equal(plain, `A ship at anchor. ${STYLE_SUFFIX.cartoon}`, "with no direction, nothing changes");

  const rich = fullPrompt("cartoon", "The captain on the deck", d, "amber");
  assert.ok(rich.startsWith("The captain on the deck."), rich);
  assert.ok(rich.includes("red bandana"), rich);
  assert.ok(rich.endsWith(STYLE_SUFFIX.cartoon), rich);

  const inputs = modelInputs(DEFAULT_IMAGE_MODELS.realistic, "realistic", "The captain on the deck", "9:16", 7, d, "red");
  assert.ok(String(inputs.negative_prompt).includes("wifi symbol"), String(inputs.negative_prompt));
  assert.ok(String(inputs.prompt).includes(ACCENT_LIGHT.red), String(inputs.prompt));
});

/* ------------------------------------------------------------------ the validator holds a storyboard to its direction */

/** The pirates fixture with a direction whose sections tile its five scenes and match its accents. */
function withDirection(over = {}) {
  const sb = pirates();
  sb.direction = good({
    must_keep: [],
    sections: sb.scenes.map((s, i) => ({ name: `0${i + 1} PART`, accent: s.accent, means: "a part", scenes: 1 })),
    ...over,
  });
  // The fixture's accents happen to repeat (red, amber, red, green, cyan); neighbouring sections must not, so this
  // only builds a legal direction when they alternate. They do, which is why the fixture is usable here at all.
  return sb;
}

test("a storyboard is held to the direction it carries", () => {
  const sb = withDirection();
  const r = validateStoryboard(sb, { format: "9:16", language: "en" });
  assert.deepEqual(r.ok ? [] : r.errors, [], "the fixture plus a matching direction validates");
  assert.equal(directionOf(sb).subject, sb.direction.subject);
  assert.equal(directionOf(pirates()), null, "a storyboard written before the direction existed still has none");

  // A scene wearing the wrong colour is refused: one accent per section is the whole colour law.
  const wrong = withDirection();
  wrong.scenes[0].accent = wrong.scenes[0].accent === "red" ? "green" : "red";
  const errors = validateStoryboard(wrong, { format: "9:16", language: "en" });
  assert.equal(errors.ok, false);
  assert.ok(errors.errors.some((e) => /scene 1: accent .* but it is in section .* which owns/.test(e)), errors.errors.join("\n"));

  // A direction whose sections do not tile the film is refused before anything is billed.
  const short = withDirection();
  short.direction.sections = short.direction.sections.slice(0, 2);
  const r2 = validateStoryboard(short, { format: "9:16", language: "en" });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => /sections cover 2 scenes but the video has 5/.test(e)), r2.errors.join("\n"));
});

test("a storyboard that contradicts its own direction is refused", () => {
  const facts = withDirection({ must_keep: ["a fact this narration never states anywhere at all"] });
  const problems = qualityProblems(facts);
  assert.ok(problems.some((p) => /direction\.must_keep says .* but the narration never says it/.test(p)), problems.join("\n"));

  const banned = withDirection();
  banned.direction.forbidden = ["treasure chest", "phone", "logo", "text in the picture"];
  banned.scenes[0].shots[0].image_prompt = "A treasure chest half buried in the wet sand at sunset";
  const hits = qualityProblems(banned);
  assert.ok(hits.some((p) => /picture 01-hook-s1: its image_prompt asks for "treasure chest"/.test(p)), hits.join("\n"));

  assert.ok(narrationOf(pirates()).length > 40, "narrationOf joins the spoken lines");
  assert.equal(narrationOf(null), "");
});

/* ------------------------------------------------------------------ a video, not a slideshow */

test("one picture per scene is refused, and every picture after the first cuts on a spoken word", () => {
  assert.equal(SHOTS_MIN_CINEMA, 2);
  assert.equal(shotRangeText("cinema"), "2-4");
  assert.equal(shotRangeText("closing"), "1-2");

  const thin = pirates();
  thin.scenes[1].shots = [thin.scenes[1].shots[0]];
  const problems = qualityProblems(thin);
  assert.ok(problems.some((p) => /scene 2 \(02-ship\): 1 picture, a scene needs at least 2/.test(p)), problems.join("\n"));
  const r = validateStoryboard(thin, { format: "9:16", language: "en" });
  assert.equal(r.ok, false, "and the whole storyboard is refused, before a GPU is rented");

  // The closing is exempt: it is meant to rest on one picture.
  assert.deepEqual(qualityProblems(pirates()), [], "the fixture already obeys both rules");

  const loose = pirates();
  delete loose.scenes[0].shots[1].at;
  const anchors = qualityProblems(loose);
  assert.ok(anchors.some((p) => /scene 1 \(01-hook\) shot 2: needs "at"/.test(p)), anchors.join("\n"));

  // Neither rule touches a look that has no shots at all.
  assert.deepEqual(qualityProblems({ style: "cinema", scenes: [{ id: "01-a", kind: "cinema" }] }), []);
  assert.deepEqual(qualityProblems(null), []);
});

/* ------------------------------------------------------------------ nothing in the frame may be dead */

test("stillness: a state is not an action, and a person is always alive", () => {
  // The two descriptions that came back frozen on a real GPU. Both already contain the noun a keyword check hunts for.
  const deadLandscape = "a wide empty coastal road cutting through black volcanic rock at dawn, low mist, cold blue light, distant ocean, cinematic, 35mm";
  const deadObject = "a brass ship compass on a worn wooden table, candlelight from the left, dust in the air, macro detail, warm shadows, cinematic";
  assert.equal(stillness(deadLandscape).alive, false, "'low mist' is a state, not an action");
  assert.equal(stillness(deadObject).alive, false, "'dust in the air' is a state, not an action");

  // The same shots, with the subject given something to do.
  assert.equal(stillness("a coastal road at dawn, mist drifting fast across the tarmac").alive, true);
  assert.equal(stillness("a brass compass on a table, the candle flame guttering").alive, true);

  // A person or an animal in frame moves on its own: nothing more is asked of the description.
  assert.equal(stillness("a woman standing at a window in cold morning light").alive, true);
  assert.equal(stillness("a dog asleep on a doorstep").alive, true);
  assert.match(stillness("a crowd on a platform").reason, /on their own/);

  // "-ing" alone proves nothing: a building is not moving.
  assert.equal(stillness("a tall building at night, lighting from below, morning haze").alive, false);
  assert.equal(stillness("").alive, false);
});

test("every repair the table offers is one the detector accepts", () => {
  // The rule has to recognise its own repair. It did not: "clouds moving across the sky" was added to a still
  // picture and then still read as still, because "moving" was missing from the verb list. This is the invariant
  // that catches the next one, and it also proves enliven() converges in a single pass.
  assert.ok(ENLIVEN_CLAUSES.length >= 10, ENLIVEN_CLAUSES.length);
  for (const clause of ENLIVEN_CLAUSES)
    assert.ok(stillness(clause).alive, `the repair "${clause}" does not read as alive`);
  for (const clause of ENLIVEN_CLAUSES) {
    const once = enliven("a closed wooden door, flat even light with " + clause.split(" ")[0], 240);
    assert.equal(enliven(once, 240), once, "a repaired picture is never repaired twice");
  }
});

test("enliven repairs the shot instead of refusing it, using what the picture already shows", () => {
  const road = "a wide empty coastal road through black volcanic rock at dawn, low mist, cold blue light";
  const fixed = enliven(road, 240);
  assert.ok(fixed.startsWith(road), fixed);
  assert.ok(stillness(fixed).alive, fixed);
  assert.match(fixed, /mist drifting/, "the movement comes from what the picture already names");

  const compass = "a brass ship compass on a worn wooden table, candlelight from the left, dust in the air";
  assert.match(enliven(compass, 240), /flame guttering/, "the candle is the thing that can move here");

  // A picture that names nothing movable still gets the clause a cinematographer would add.
  assert.match(enliven("a closed wooden door, flat even light", 240), /dust drifting through the light/);

  const ship = "A wooden ship at anchor in a turquoise bay under a stormy sky";
  assert.ok(stillness(enliven(ship, 240)).alive, "the sky is the thing that can move in this one");

  // Already alive: left exactly as written.
  const alive = "waves breaking over a stone pier at dusk";
  assert.equal(enliven(alive, 240), alive);
  assert.equal(enliven("", 240), "");

  // The cap is never exceeded: the description gives up its tail rather than the movement.
  const long = "a brass ship compass on a worn wooden table with low mist around it, " + "carved detail ".repeat(14);
  const cut = enliven(long.trim(), 240);
  assert.ok(cut.length <= 240, cut.length);
  assert.ok(stillness(cut).alive, cut);
  assert.ok(!/\s,/.test(cut), "no dangling space before the added clause");

  // Too tight to say both: the author's words win, and nothing is truncated into nonsense.
  const tight = "a compass on a table with low mist";
  assert.equal(enliven(tight, tight.length + 5), tight);
});

test("conformity reports what was asked against what was planned", () => {
  const rows = conformity(good(), { scenes: 5, pictures: 13, words: 104, missing: [] });
  assert.ok(rows.every((r) => r.ok), JSON.stringify(rows));
  assert.ok(rows.some((r) => r.delivered.includes("13 pictures")), JSON.stringify(rows));
  const bad = conformity(good(), { scenes: 5, pictures: 13, words: 104, missing: ["1720"] });
  assert.ok(bad.some((r) => !r.ok && /1 requested facts missing/.test(r.delivered)), JSON.stringify(bad));
});

test("every picture of a storyboard can be checked against the direction in one pass", () => {
  const sb = withDirection();
  const pics = pictureScenes(sb);
  assert.ok(pics.length >= 10, `${pics.length} pictures`);
  assert.deepEqual(forbiddenInPrompts(sb.direction.forbidden, pics), [], "the fixture asks for nothing it forbids");
  for (const p of pics) assert.ok(p.accent === null || CINEMA_ACCENTS.includes(p.accent), p.accent);
});

/* ------------------------------------------------------------------ the guide's promise, made true on the client's path */

// The guide tells an assistant "THE DIRECTION — write this FIRST, before a single scene" and then "Kleo enforces
// it". Until requireDirection existed that sentence was false: a storyboard with no direction was accepted, and the
// film it produced had no colour law, no fidelity gate and no forbidden list — silently, for the same money. These
// tests hold both halves: the flag refuses, and the flag stays off everywhere the planner works.

test("without the flag a storyboard needs no direction, which is what every planner draft depends on", () => {
  const r = validateStoryboard(pirates(), { format: "9:16", language: "en" });
  assert.equal(r.ok, true, "the fixture has no direction and must still validate for the planner");
});

test("with the flag a storyboard that carries no direction is refused, and told what to add", () => {
  const r = validateStoryboard(pirates(), { format: "9:16", language: "en", requireDirection: true });
  assert.equal(r.ok, false, "an assistant's storyboard without a direction may not be rendered");
  const said = r.errors.join("\n");
  assert.match(said, /direction is required/, "the error names the missing thing");
  assert.match(said, /kleo_storyboard_guide/, "and tells the assistant where the answer is written");
  assert.match(said, /sections/, "and lists the fields, so the fix needs no second call");
});

test("with the flag a storyboard that carries a direction passes exactly as before", () => {
  const r = validateStoryboard(withDirection(), { format: "9:16", language: "en", requireDirection: true });
  assert.deepEqual(r.ok ? [] : r.errors, [], "the flag adds no rule beyond presence");
});

test("the missing direction is reported together with the other problems, not instead of them", () => {
  // The check sits BEFORE the scene guard on purpose. A storyboard whose scenes are also wrong would otherwise
  // return early, hide the missing direction, and cost the assistant a second round trip after it had already
  // rewritten the scenes.
  const broken = pirates();
  broken.scenes = [];
  const r = validateStoryboard(broken, { format: "9:16", language: "en", requireDirection: true });
  assert.equal(r.ok, false);
  const said = r.errors.join("\n");
  assert.match(said, /direction is required/, "the direction error survives the scene guard");
  assert.match(said, /2–240 scenes/, "and the scene error is there too: one call learns everything");
});

test("the directed fixture is a complete client storyboard: what an assistant must now send", () => {
  // cartoon-pirates-directed.json exists because the production end-to-end test (DEPLOY.md, STORYBOARD_FILE) posts a
  // fixture as if it were an assistant's storyboard, and every other fixture carries no direction — so from the day
  // requireDirection shipped, the documented production test would have been refused by our own new rule. The other
  // fixtures stay as they are: they are the planner's shape, and the planner still validates with the flag off.
  const sb = fixture("cartoon-pirates-directed");
  const r = validateStoryboard(sb, { format: sb.format, language: sb.language, requireDirection: true });
  assert.deepEqual(r.ok ? [] : r.errors, [], "it must pass the rule it exists to demonstrate");
  assert.equal(sb.direction.sections.reduce((a, s) => a + s.scenes, 0), sb.scenes.length,
    "its sections tile the film exactly");
});
