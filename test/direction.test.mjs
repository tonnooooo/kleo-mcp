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
  directionProblems, sectionOfScene, missingFacts, forbiddenInPrompts, pictureContext, negativeFor, notEnglish, foreignPictureFields, lightsPictures, headNounIn, thinLook, formatTalk, storyRequest, dropLookFacts,
  castFor, conformity, ACCENT_LIGHT, negatedTerms, stillness, enliven, livingClause, ENLIVEN_CLAUSES, D,
  motionHint, spokenFacts, lookFact, formatOnly, screenTextProblems, stripFormatTalk,
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

test("pictureContext appends the cast look and the world — and no section light, on any look (22 September)", () => {
  const d = good();
  const ctx = pictureContext(d, "The captain walks along the shoreline at dusk", "red");
  assert.ok(ctx.startsWith("the captain: a pirate captain with a red bandana"), ctx);
  assert.ok(ctx.includes("A tropical island in 1720"), ctx);
  assert.ok(!ctx.includes("light source"), ctx);
  // A picture that shows nobody carries no cast description.
  assert.ok(!pictureContext(d, "An empty beach at dawn", null).includes("red bandana"));
  assert.equal(pictureContext(null, "anything", "red"), "");
  assert.deepEqual(castFor(d.cast, "the captain looks out to sea").map((m) => m.name), ["the captain"]);
  assert.deepEqual(castFor(d.cast, "an empty deck"), []);
});

test("no look gets the section's light in its pictures any more, and the cast still leads", () => {
  // On the turbo SDXL model "a single warm red light source" was a colour cast (gt_ad2musq5, 19 September: a red
  // kitchen for a pastel story); on RealVisXL, the realistic model since the 20th, the same (gt_hxed87em, 22
  // September: red graphite dust, a glowing green pencil line, a green lamp). The accent stays on the layer.
  const d = good();
  for (const look of ["animation", "realistic", "cartoon", null]) {
    const drawn = pictureContext(d, "The captain walks along the shoreline at dusk", "red", look);
    assert.ok(drawn.startsWith("the captain: a pirate captain with a red bandana"), drawn);
    assert.ok(!drawn.includes("light source"), `${look}: ${drawn}`);
    assert.equal(lightsPictures(look), false);
  }
  assert.ok(ACCENT_LIGHT.red, "the table stays for the layer's own words");
});

test("what a cast look or the world denies goes to the negative prompt, with face and portrait when a face is denied", () => {
  assert.deepEqual(negatedTerms("a middle-aged hand and forearm, pale skin, a frayed cream shirt cuff, no visible face"), ["visible face", "face", "portrait"]);
  assert.deepEqual(negatedTerms("Only a hand and a forearm are ever seen, never a face"), ["face", "portrait"], "a treatment decision, the shape gt_b2campbw wrote it in");
  assert.deepEqual(negatedTerms("a room with one window, never a logo or a screen"), ["logo"]);
  assert.deepEqual(negatedTerms("a pirate captain with a red bandana"), []);
  assert.deepEqual(negatedTerms("she is no longer young, without a hat"), ["hat"]);
  const d = { ...good(), cast: [{ name: "the writer", look: "a hand and a forearm, no visible face" }], world: "A desk by one window before dawn, without a single screen" };
  const neg = negativeFor(d, NEGATIVE_PROMPT);
  assert.ok(neg.includes("visible face") && neg.includes("face, portrait") && neg.includes("single screen"), neg);
  assert.ok(neg.startsWith(NEGATIVE_PROMPT) && neg.includes("wifi symbol"), "the forbidden list still comes first");
});

test("a cast look is a description a painter can draw twice, never a name; the narration never describes the video", () => {
  // Job gt_6xchnk99 (20 September 2026): look "a young Jedi-like warrior", narration "In a 30-second vertical YouTube
  // Short, a young warrior receives a transmission…" — a new face in every picture, and the format read out loud.
  assert.equal(thinLook("a young Jedi-like warrior"), true);
  assert.equal(thinLook("the captain"), true);
  assert.equal(thinLook("a tall grey-bearded man in a red coat"), false);
  assert.equal(thinLook("a young man in his twenties, short dark hair, light stubble, sand-coloured hooded robe"), false);
  const d = { ...good(), cast: [{ name: "the young warrior", look: "a young Jedi-like warrior" }] };
  const p = directionProblems(d, { accents: CINEMA_ACCENTS, scenes: d.sections.reduce((n, s) => n + s.scenes, 0) });
  assert.ok(p.some((m) => /cast\[0\]\.look "a young Jedi-like warrior" is a name, not a look/.test(m)), p.join("\n"));
  assert.deepEqual(directionProblems(good(), { accents: CINEMA_ACCENTS, scenes: good().sections.reduce((n, s) => n + s.scenes, 0) }), []);
  assert.equal(formatTalk("In a 30-second vertical YouTube Short, a young warrior receives a transmission."), "30-second");
  assert.equal(formatTalk("A young warrior receives a transmission in this video about a lost temple."), "in this video");
  assert.equal(formatTalk("Il narratore racconta la storia di una pasticcera."), "narratore");
  assert.ok(formatTalk("In uno Short verticale di 30 secondi, la pasticcera prepara una torta."), "Italian format words are caught too");
  assert.equal(formatTalk("Il primo Short della serie apre sulla cucina."), "Short");
  assert.equal(formatTalk("A young warrior receives a transmission from a planet that no longer exists."), null);
  assert.equal(formatTalk("She waits thirty seconds before she answers."), null, "spelled-out time in the story is the story");
  assert.equal(formatTalk("The ship shorts out and falls silent."), null, "'shorts' as a verb is not the format");
  // THE REQUEST REACHES THE PLANNER WHOLE (24 September 2026). storyRequest() used to delete every sentence with a
  // format word (gt_jm5btrj8), and with them "the narrator says 'festa a sorpresa'", "a vertical blind in a 1990s
  // bedroom" — what the user asked for. It is non-destructive now: whitespace folded, nothing removed. The narration
  // is still protected where the damage was, by formatTalk() on every voice line.
  const req = "A 30-second vertical YouTube Short set in an original space-fantasy universe. A young warrior receives a transmission saying the enemy survived.\n\n  Make it cinematic and tense. Use original characters, not copyrighted Star Wars characters.";
  const story = storyRequest(req);
  assert.equal(story, req.replace(/\s+/g, " ").trim(), "the whole request, whitespace folded");
  assert.match(story, /^A 30-second vertical YouTube Short set in an original space-fantasy universe\. A young warrior/, "the format sentence is no longer cut");
  assert.equal(storyRequest("  Una pasticcera prepara torte per i bambini poveri del paese.  "), "Una pasticcera prepara torte per i bambini poveri del paese.");
  assert.equal(storyRequest("Il narratore dice 'festa a sorpresa'. Una stanza anni '90 con una tenda verticale."), "Il narratore dice 'festa a sorpresa'. Una stanza anni '90 con una tenda verticale.", "a sentence with a format word that IS the story stays");
  assert.equal(storyRequest(""), "");
  // must_keep KEEPS the look now: it is something the user asked for, and the pictures are checked for it. Only an
  // item that is nothing but the film's own format goes ("durata 30 secondi, circa 6 scene" was read aloud in scene 5).
  const cast = [{ name: "the pastry chef", look: "a thin woman with short blonde hair tied up, in a lilac apron" }];
  assert.deepEqual(dropLookFacts(["short blonde hair tied up", "lilac apron", "festa a sorpresa", "the children of the village", "five mistakes"], cast), ["short blonde hair tied up", "lilac apron", "festa a sorpresa", "the children of the village", "five mistakes"]);
  assert.deepEqual(dropLookFacts(["capelli biondi corti e raccolti", "grembiule lilla", "durata 30 secondi, circa 6 scene", "festa a sorpresa"], cast), ["capelli biondi corti e raccolti", "grembiule lilla", "festa a sorpresa"], "the appearance stays, the film's own length goes");
  assert.deepEqual(dropLookFacts(["a 30-second vertical Short", "narrated in Italian, 9:16", "the narrator must say festa a sorpresa"], []), ["the narrator must say festa a sorpresa"], "a format word beside real content is content");
  // …and the narrator is never held to the look: spokenFacts() is what missingFacts() reads.
  assert.deepEqual(spokenFacts(["short blonde hair tied up", "lilac apron", "grembiule lilla", "festa a sorpresa", "the children of the village"], cast), ["festa a sorpresa", "the children of the village"]);
  assert.deepEqual(spokenFacts(["lilac apron", "the harbour at dawn"], []), ["the harbour at dawn"], "an appearance word is a look even with no cast to compare");
  assert.deepEqual(spokenFacts(undefined, undefined), []);
  assert.equal(lookFact("a thin woman with blonde hair", []), true);
  assert.equal(lookFact("festa a sorpresa", cast), false);
  assert.equal(formatOnly("durata 30 secondi, circa 6 scene"), true);
  assert.equal(formatOnly("the narrator must say festa a sorpresa"), false);
  assert.equal(formatOnly("the harbour at dawn"), false, "no format word, never format-only");
});

test("the validator holds the narration to the spoken facts only: a look in must_keep is never demanded aloud (24 September)", () => {
  const sb = withDirection({ must_keep: ["lilac apron", "short blonde hair tied up"], cast: [{ name: "the captain", look: "a pirate captain with a red bandana and a long dark braid, brown coat, wide belt" }] });
  const r = validateStoryboard(sb, { format: sb.format, language: sb.language });
  assert.equal(r.ok, true, (r.errors ?? []).join("\n"));
  assert.ok(!r.warnings.some((w) => /must_keep says/.test(w)), r.warnings.join("\n"));
  const said = withDirection({ must_keep: ["a fact this narration never states anywhere at all", "lilac apron"] });
  const r2 = validateStoryboard(said, { format: said.format, language: said.language });
  assert.deepEqual(r2.warnings.filter((w) => /must_keep says/.test(w)).map((w) => /says "([^"]+)"/.exec(w)[1]), ["a fact this narration never states anywhere at all"]);
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
  // A head noun two characters share stands for neither: "the warrior" and "the dark warrior" (job gt_jm5btrj8, the
  // hero drawn as the hooded villain in every shot). Only the whole name attaches a look then.
  const duel = [{ name: "the warrior", look: "a young man in a brown leather jacket" }, { name: "the dark warrior", look: "a hooded figure in a dark robe and a mask" }];
  assert.deepEqual(names(duel, "The warrior walks towards the ruins"), ["the warrior"], "the whole name of the hero, not the villain's head noun");
  assert.deepEqual(names(duel, "A warrior walks towards the ruins"), [], "the bare shared noun names nobody");
  assert.deepEqual(names(duel, "The dark warrior emerges from the shadows"), ["the warrior", "the dark warrior"].filter((n) => n === "the dark warrior" || "the dark warrior emerges from the shadows".includes("the warrior")), "the villain's whole name; 'the warrior' is not a substring of it");
  assert.equal(headNounIn("the man", "a man at the window"), false, "a three-letter head is never matched (manuscript)");
  assert.equal(headNounIn("the captain", "the captain's chair"), true);
  // pictureContext follows the same rule, so the worker (its mirror) and the server draw the same picture.
  const d = { ...good(), cast: chef };
  assert.ok(pictureContext(d, "She turns the cake out of its tin", null, "animation").startsWith("the pastry chef: a thin woman"));
});

test("castFor: a shot's explicit cast decides before any guess from the words (24 September)", () => {
  const two = [
    { name: "Mara", look: "a thin woman in her thirties with short blonde hair tied up, a lilac apron, round glasses", id: "c1" },
    { name: "the baker", look: "a tall bald man in his fifties, flour on his forearms, a white apron" },
  ];
  const names = (shotCast, p, spec) => castFor(two, p, shotCast, spec).map((m) => m.name);
  // A pronoun in a two-character film attaches nobody by itself; the shot's cast says who it is.
  assert.deepEqual(names(undefined, "She turns the cake out of its tin"), [], "the old guess, for a shot with no cast");
  assert.deepEqual(names(["c1"], "She turns the cake out of its tin"), ["Mara"], "by the member's spec id");
  assert.deepEqual(names(["mara"], "She turns the cake out of its tin"), ["Mara"], "by name, case ignored");
  assert.deepEqual(names(["Baker"], "Hands on the counter"), ["the baker"], "a leading article is not part of the name");
  assert.deepEqual(names(["c2"], "Hands on the counter", [{ id: "c2", name: "The Baker" }]), ["the baker"], "by a spec id whose spec name is the member's name");
  assert.deepEqual(names(["c2", "c1"], "The baker and Mara at the oven", [{ id: "c2", name: "the baker" }]), ["the baker", "Mara"], "in the shot's order");
  // The explicit cast wins over a name the prompt happens to contain ("the baker's shop" with Mara alone in it).
  assert.deepEqual(names(["c1"], "Mara alone in the baker's shop at dawn"), ["Mara"]);
  // A cast that names nobody known, or an empty one, falls back to reading the prompt.
  assert.deepEqual(names(["c9"], "The baker at the oven"), ["the baker"]);
  assert.deepEqual(names([], "The baker at the oven"), ["the baker"]);
  // A direction may be passed whole, and pictureContext takes the same shot cast.
  assert.deepEqual(castFor({ cast: two }, "She waits", ["c1"]).map((m) => m.name), ["Mara"]);
  const d = { ...good(), cast: two };
  const ctx = pictureContext(d, "She turns the cake out of its tin", null, "realistic", ["c1"]);
  assert.ok(ctx.startsWith("Mara: a thin woman in her thirties"), ctx);
  assert.ok(!ctx.includes("bald man"), ctx);
  // The direction's cast is as roomy as the spec's: six people, a 40-character name, a 420-character look.
  assert.equal(D.cast.max, 6); assert.equal(D.cast.name, 40); assert.equal(D.cast.look, 420);
  const six = Array.from({ length: 6 }, (_, i) => ({ name: `Character number ${i + 1}`, look: `a person of about ${20 + i} years with dark hair, a green coat and a leather satchel, ${"x".repeat(300)}` }));
  assert.deepEqual(directionProblems(good({ cast: six }), { ...opts, scenes: 5 }), []);
  assert.ok(directionProblems(good({ cast: [...six, six[0]] }), opts).some((p) => /cast has 7 entries, the limit is 6/.test(p)));
  assert.ok(directionProblems(good({ cast: [{ ...six[0], id: 42 }] }), opts).some((p) => /cast\[0\]\.id must be the spec's cast id/.test(p)));
});

test("screenTextProblems skips the shots that must carry words: those covering a spec \"text\" item (24 September)", () => {
  const prompts = [
    { id: "01-a-s1", image_prompt: "A bakery front at dawn, the painted sign reading 'Da Mara' above the door" },
    { id: "01-a-s2", image_prompt: "A screen displaying the words of the recipe" },
    { id: "02-b-s1", image_prompt: "A wooden counter with flour and eggs" },
  ];
  assert.deepEqual(screenTextProblems(prompts).map((h) => h.id), ["01-a-s1", "01-a-s2"]);
  assert.deepEqual(screenTextProblems(prompts, new Set(["01-a-s1"])).map((h) => h.id), ["01-a-s2"], "the covered sign is allowed, the stray screen is not");
  assert.deepEqual(screenTextProblems(prompts, new Set()), screenTextProblems(prompts));
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
  assert.ok(!String(inputs.prompt).includes("light source"), String(inputs.prompt));
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
  // The fidelity gate warns (20 September 2026): the planner feeds it back and reports what is left, and only a
  // client-written storyboard is refused on it (jobs.ts) — a whole film died at the final assembly on one phrase.
  assert.deepEqual(qualityProblems(facts).filter((p) => /must_keep/.test(p)), []);
  const rf = validateStoryboard(facts, { format: facts.format, language: facts.language });
  assert.equal(rf.ok, true, (rf.errors ?? []).join("\n"));
  assert.ok(rf.warnings.some((p) => /direction\.must_keep says .* but the narration never says it/.test(p)), rf.warnings.join("\n"));

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

test("every movement the table offers is one the detector accepts", () => {
  // The rule has to recognise its own repair. It did not: "clouds moving across the sky" was offered for a still
  // picture and then still read as still, because "moving" was missing from the verb list. This is the invariant
  // that catches the next one: a picture that names the clause's own thing, with the clause added, needs nothing more.
  assert.ok(ENLIVEN_CLAUSES.length >= 10, ENLIVEN_CLAUSES.length);
  for (const clause of ENLIVEN_CLAUSES)
    assert.ok(stillness(clause).alive, `the movement "${clause}" does not read as alive`);
  for (const clause of ENLIVEN_CLAUSES)
    assert.equal(motionHint(`a closed wooden door, flat even light, ${clause}`), null, "a picture that already moves is given no movement");
});

test("motionHint names the movement for the clip, from what the picture already shows — and the picture is never rewritten (24 September)", () => {
  // Until 24 September enliven() appended this clause to the image_prompt and, near the length limit, CUT the
  // author's words to make room ("dust drifting through the light" replaced the end of what the user dictated). The
  // clause now travels in the shot's "action" for the clip model; the still is drawn from the author's words alone.
  const road = "a wide empty coastal road through black volcanic rock at dawn, low mist, cold blue light";
  assert.match(motionHint(road), /mist drifting/, "the movement comes from what the picture already names");
  const compass = "a brass ship compass on a worn wooden table, candlelight from the left, dust in the air";
  assert.match(motionHint(compass), /flame guttering/, "the candle is the thing that can move here");
  // A picture that names nothing movable still gets the clause a cinematographer would add.
  assert.equal(motionHint("a closed wooden door, flat even light"), "dust drifting through the light");
  assert.ok(stillness(motionHint("A wooden ship at anchor in a turquoise bay under a stormy sky")).alive, "the sky is the thing that can move in this one");
  // Already alive, or empty: nothing to add.
  assert.equal(motionHint("waves breaking over a stone pier at dusk"), null);
  assert.equal(motionHint("a woman standing at a window in cold morning light"), null, "a person moves on their own");
  assert.equal(motionHint(""), null);
  // enliven() is kept for old callers and changes nothing but the surrounding whitespace, whatever the limit.
  const long = "a brass ship compass on a worn wooden table with low mist around it, " + "carved detail ".repeat(14);
  assert.equal(enliven(`  ${long}  `, 240), long.trim(), "the author's words are never cut to make room");
  assert.equal(enliven(road, 240), road, "and never grown");
  assert.equal(enliven("", 240), "");
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

test("stripFormatTalk: only what is pure format talk leaves a kept voice, never the story around it (24 September 2026)", () => {
  // The leading clause of the 20 September line, in both languages.
  assert.equal(stripFormatTalk("In a 30-second vertical YouTube Short, the young warrior receives a transmission from a dead planet."), "The young warrior receives a transmission from a dead planet.");
  assert.equal(stripFormatTalk("In questo Short di 30 secondi, Mara sforna una torta al limone nella sua cucina."), "Mara sforna una torta al limone nella sua cucina.");
  // A whole sentence of it goes; the story sentence after it stays as it was.
  assert.equal(stripFormatTalk("This is a 30-second vertical Short. The warrior wakes in the ruins."), "The warrior wakes in the ruins.");
  // A trailing clause goes, and the sentence keeps its full stop.
  assert.equal(stripFormatTalk("The warrior wakes in the ruins, in this vertical Short."), "The warrior wakes in the ruins.");
  // A format word inside the story is the story: nothing is cut.
  assert.equal(stripFormatTalk("The narrator's voice breaks as the warrior falls."), "The narrator's voice breaks as the warrior falls.");
  // A line that would be left with nothing (or under four words) is left alone.
  assert.equal(stripFormatTalk("A 30-second Short."), "A 30-second Short.");
  // Nothing to do: the same string back.
  const clean = "Mara carries the lemon cake across the square.";
  assert.equal(stripFormatTalk(clean), clean);
  assert.equal(formatTalk(stripFormatTalk("In a 30-second vertical YouTube Short, the young warrior receives a transmission from a dead planet.")), null);
});
