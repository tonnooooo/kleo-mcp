/**
 * The explainer sweep: twenty-four deliberately unlike prompts, each planned as a Short and as a long
 * video, in three languages, against a fake Workers AI that answers badly on purpose.
 *
 * It is not a test that the planner works on the hotel-lock video. It is a test that the look survives
 * subjects it was never designed around — a recipe, a volcano, a mortgage, a Roman aqueduct — because
 * that is what Kleo will actually be handed, and a style that only draws its own example is a demo.
 *
 * Two things are asserted for every one of the ninety-six plans: the storyboard is contract-valid (it
 * would boot a GPU), and the rules in src/explainer-plan.ts hold on the film that came back. The fake
 * model breaks a different rule on the first attempt of every case and writes properly on the second,
 * so the retry path — the one that carries the rule violations back as feedback — is exercised too.
 *
 * Run: node --test test/explainer-planner.test.mjs   (never calls Workers AI)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateStoryboard, planFor, normalizeStoryboard } from "../src/storyboard.ts";
import { checkExplainer, repairExplainer, EXPLAINER_RULES, anchorAt } from "../src/explainer-plan.ts";
import { validateStoryboard, SKETCH_ART, quotesVoice } from "../src/keou-contract.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ the twenty-four subjects */

/** Nothing here is about hotels, and nothing here is about cyber-security twice in a row. */
const PROMPTS = [
  ["en", "Why bread rises: what yeast is actually doing in the dough while you wait."],
  ["en", "How a volcano decides when to erupt, and why the warning signs are always the same three."],
  ["en", "What your bank actually does with the money you deposit on Monday morning."],
  ["en", "The Roman aqueduct that still carries water, and the one engineering idea behind it."],
  ["en", "Why planes are struck by lightning and nothing happens to anyone on board."],
  ["en", "How noise-cancelling headphones cancel a sound by making the opposite of it."],
  ["it", "Perché il caffè espresso esce amaro e i due errori che lo causano ogni volta."],
  ["it", "Come funziona davvero un vaccino a mRNA, spiegato senza una sola parola tecnica."],
  ["it", "La truffa del finto corriere: come arriva l'SMS e cosa succede se tocchi il link."],
  ["fr", "Pourquoi la Tour Eiffel grandit de quinze centimètres chaque été."],
  ["fr", "Comment une batterie de voiture électrique perd sa capacité, et à quelle vitesse."],
  ["en", "What happens in your body during the first ten minutes of a cold shower."],
  ["en", "Why supermarket eggs are never washed in Europe and always washed in America."],
  ["en", "How a mortgage rate is set, and who actually decides the number you are offered."],
  ["en", "The physics of a curveball: why the ball turns and the batter cannot see it coming."],
  ["en", "How doctors find a broken bone that does not show up on the first X-ray."],
  ["en", "Why the deep sea is dark but not empty, and what lives at four kilometres down."],
  ["en", "How your phone knows it is you before you touch it, and what it stores to do that."],
  ["en", "The day the Mississippi ran backwards, and the fault line that did it."],
  ["en", "Why concrete from two thousand years ago outlasts concrete poured last year."],
  ["en", "How a password becomes a hash, and why the website cannot read yours back."],
  ["en", "What a wildfire does to soil, and why the second year is worse than the first."],
  ["en", "How the postal system routes a letter with a wrong postcode to the right street."],
  ["en", "Why some songs get stuck in your head and the trick that reliably clears them."],
];

/* ------------------------------------------------------------------ a fake model that writes badly first */

const job = (template, duration_s, format, language, prompt) =>
  ({ id: "gt_sweep", template, prompt, params: JSON.stringify({ duration_s, format, language, voice: null, style: "explainer" }) });

const chunkRange = (user) => { const m = /write scenes (\d+)–(\d+)/.exec(user); return [Number(m[1]) - 1, Number(m[2])] };
const sceneCount = (user) => Number(/exactly (\d+) scenes/.exec(user)[1]);

/** The lines the fake writes: a hook that speaks to the viewer, a turn early on, a payoff at the end. */
const LINES = {
  en: {
    hook: "Your bread is not rising for the reason you think.",
    turn: "But the yeast was never the part that mattered here.",
    body: (i) => `Step number ${i} moves the warm water through the flour and waits.`,
    payoff: "So what else have you been getting wrong every single time?",
  },
  it: {
    hook: "Il tuo caffè non è amaro per il motivo che pensi.",
    turn: "Ma in realtà la macchina non c'entra quasi niente qui.",
    body: (i) => `Il passaggio numero ${i} spinge l'acqua calda dentro il caffè macinato.`,
    payoff: "Quindi cos'altro stai sbagliando ogni singola mattina a casa?",
  },
  fr: {
    hook: "Ta tour ne mesure pas ce que tu crois vraiment.",
    turn: "Mais le métal ne se comporte pas comme tu le penses.",
    body: (i) => `L'étape numéro ${i} pousse la chaleur dans le fer et attend.`,
    payoff: "Alors qu'est-ce que tu regardes sans jamais vraiment le voir?",
  },
};
/** Real drawings, cycled so no case leans on one. */
const NAMES = ["laptop", "clock", "crowd", "globe", "chart", "book", "gear", "warning", "coin", "tree", "car", "brain", "signal", "lock"];
/** The defects a real model produces: each case gets one on its first attempt, none on its second. */
const DEFECTS = ["anchor", "drawn", "early", "zoom", "focus", "synonym", "closing", "junk"];

function scenesFor(user, attempt, lang, defect, wordWindow) {
  const [from, to] = chunkRange(user);
  const total = Number(/VIDEO OUTLINE \((\d+) scenes/.exec(user)[1]);
  const L = LINES[lang];
  const bad = attempt === 1;
  const out = [];
  for (let i = from; i < to; i++) {
    const voice = i === 0 ? L.hook : i === 1 ? L.turn : i === total - 1 ? L.payoff : L.body(i);
    const w = voice.split(/\s+/);
    const late = w.slice(Math.ceil(w.length / 2)).slice(0, 2).join(" ");
    const early = w.slice(1, 3).join(" ");
    const name = NAMES[i % NAMES.length];
    const art = [
      { name: bad && defect === "synonym" ? "smartphone" : name, drawn: i === 0 && !(bad && defect === "drawn") ? true : undefined },
      { name: NAMES[(i + 5) % NAMES.length], at: bad && defect === "anchor" ? "words this line never says" : bad && defect === "early" ? early : late, motion: "drift" },
    ].map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)));
    const s = {
      id: `${String(i + 1).padStart(2, "0")}-part`,
      kind: bad && defect === "closing" && i === total - 1 ? "closing" : "sketch",
      voice, accent: ["red", "blue", "green", "yellow"][i % 4],
      shot: bad && defect === "zoom" ? { zoom: [1.4, 1.1], focus: [540, 860] }
        : bad && defect === "focus" ? { zoom: [1, 1.3], focus: [99999, -400] }
        : { zoom: [1, 1.25], focus: [540, 860] },
      art, hold: 0.05,
    };
    if (bad && defect === "junk") Object.assign(s, { chapter: "01 PART", title: "A title nobody asked for", beats: [{ kind: "cta" }], items: ["a", "b", "c"] });
    out.push(s);
  }
  void wordWindow;
  return { scenes: out };
}

function fakeEnv(lang, defect) {
  const attempts = new Map();
  const feedback = [];
  return {
    feedback,
    env: {
      AI: { async run(_m, inputs) {
        const user = inputs.messages.at(-1).content;
        if (/TASK: write the DIRECTION/.test(user)) {
          const n = Number(/add up to exactly (\d+)/.exec(user)?.[1] ?? 5);
          const accents = ["amber", "red", "cyan", "green"];
          const per = Math.max(1, Math.ceil(n / 3));
          const sections = [];
          for (let left = n, i = 0; left > 0; i++) { const take = Math.min(left, per); sections.push({ name: `0${i + 1} PART`, accent: accents[i % accents.length], means: "a part of it", scenes: take }); left -= take }
          if (sections.length < 2) { sections[0].scenes -= 1; sections.push({ name: "02 PART", accent: "red", means: "the end", scenes: 1 }) }
          return { response: { direction: { subject: "The subject", goal: "The viewer understands it", audience: "Anyone", tone: "Plain", must_keep: [], world: "A plain drawn world on black", cast: [], objects: ["a thing"], forbidden: ["a logo"], sections } }, usage: {} };
        }
        if (/TASK: plan the whole video/.test(user)) {
          const n = sceneCount(user);
          return { response: {
            title: "A test explainer", description: "desc", tags: ["a"],
            scenes: Array.from({ length: n }, (_, i) => ({ id: `${String(i + 1).padStart(2, "0")}-part`, kind: "sketch", label: `0${i + 1} PART`, accent: "cyan", summary: `part ${i + 1}`, words: 12 })),
          }, usage: {} };
        }
        const key = `chunk-${chunkRange(user).join("-")}`;
        const a = (attempts.get(key) ?? 0) + 1; attempts.set(key, a);
        if (a > 1) feedback.push(user.slice(user.indexOf("YOUR PREVIOUS ANSWER WAS REJECTED")));
        return { response: scenesFor(user, a, lang, defect), usage: {} };
      } },
      INTERNAL_SECRET: "x",
    },
  };
}

/* ------------------------------------------------------------------ the sweep */

const ART_SET = new Set(SKETCH_ART);

/** What must be true of a finished explainer, whatever it is about. */
function problemsWith(sb, plan) {
  const bad = [];
  const r = validateStoryboard(sb, { format: plan.format, language: plan.language });
  if (!r.ok) bad.push(...r.errors);
  if (sb.style !== "sketch") bad.push(`style is ${sb.style}`);
  if (sb.kleo_style !== "explainer") bad.push(`kleo_style is ${sb.kleo_style}`);
  sb.scenes.forEach((s, i) => {
    if (s.kind !== "sketch") bad.push(`scene ${i + 1}: kind ${s.kind} — the explainer has no closing scene`);
    if (!Array.isArray(s.art) || s.art.length < 2) bad.push(`scene ${i + 1}: fewer than two drawings`);
    for (const a of s.art ?? []) if (!ART_SET.has(a.name)) bad.push(`scene ${i + 1}: ${a.name} is not a drawing`);
    for (const a of s.art ?? []) for (const k of ["at", "until"]) if (typeof a[k] === "string" && !quotesVoice(a[k], s.voice)) bad.push(`scene ${i + 1}: ${k} "${a[k]}" is not in the line`);
    if (!(s.shot.zoom[1] > s.shot.zoom[0])) bad.push(`scene ${i + 1}: the camera stopped`);
    const [fw, fh] = plan.format === "9:16" ? [1080, 1920] : [1920, 1080];
    if (s.shot.focus[0] < 0 || s.shot.focus[0] > fw || s.shot.focus[1] < 0 || s.shot.focus[1] > fh) bad.push(`scene ${i + 1}: focus off the page`);
    for (const k of ["chapter", "title", "beats", "shots", "items", "hl", "eyebrow"]) if (k in s) bad.push(`scene ${i + 1}: ${k} belongs to another look`);
  });
  // The two rules arithmetic is allowed to fix must never survive to the finished film.
  for (const v of checkExplainer(sb.scenes, { duration: plan.duration, language: plan.language }))
    if (v.rule === "scene-drawn" || v.rule === "cue-spread") bad.push(`repairable rule survived: ${v.rule} — ${v.message}`);
  return bad;
}

for (const [i, [lang, prompt]] of PROMPTS.entries()) {
  const defect = DEFECTS[i % DEFECTS.length];
  const label = prompt.slice(0, 46);
  for (const [template, dur, format] of [["explainer-short", 45, "9:16"], ["explainer-long", 300, "16:9"]]) {
    test(`sweep ${String(i + 1).padStart(2, "0")} ${template.replace("explainer-", "")} ${lang} · ${label}…`, async () => {
      const { env, feedback } = fakeEnv(lang, defect);
      const j = job(template, dur, format, lang, prompt);
      const plan = planFor(j);
      assert.equal(plan.style, "sketch", "the explainer template must plan the sketch look");
      const res = await generateStoryboard(env, j);
      const bad = problemsWith(res.storyboard, plan);
      assert.deepEqual(bad, [], `${template}/${lang}/${defect}:\n  ${bad.join("\n  ")}`);
      // A defect the model can only fix by writing again has to have been sent back to it in words.
      if (["anchor", "early", "drawn", "synonym"].includes(defect)) return;   // those are repaired, not retried
      assert.ok(feedback.length > 0, `defect "${defect}" was accepted silently instead of being sent back`);
    });
  }
}

/* ------------------------------------------------------------------ the rules themselves */

const good = (over = {}) => ({
  id: "01-x", kind: "sketch", accent: "red", voice: "Your hotel door is not locked the way you think.",
  shot: { zoom: [1, 1.3], focus: [540, 860] },
  art: [{ name: "door", drawn: true }, { name: "lock", at: "the way you", motion: "turn" }], hold: 0.05, ...over,
});
const film = (scenes) => checkExplainer(scenes, { duration: 45, language: "en" }).map((v) => v.rule);

test("every rule has an id, a reason and finds nothing on a film that obeys it", () => {
  const ids = EXPLAINER_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "rule ids must be unique");
  for (const r of EXPLAINER_RULES) assert.ok(r.why.length > 20, `${r.id} has no reason written down`);
  const clean = [
    good(),
    good({ id: "02-x", accent: "blue", voice: "But the card in your pocket is a radio, quietly.", art: [{ name: "keycard", at: "the card" }, { name: "signal", at: "is a radio", tint: "blue" }] }),
    good({ id: "03-x", accent: "green", voice: "So who else has been walking into your room lately?", art: [{ name: "room", at: "who else" }, { name: "footprints", at: "into your room" }] }),
  ];
  assert.deepEqual(film(clean), []);
});

test("each rule fires on the film that breaks it, and only then", () => {
  const cases = {
    "hook-shape": [good({ voice: "The mechanism of the lock is described in the manual." }), good({ id: "02-x", accent: "blue", voice: "But nothing else about it works the way described." }), good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" })],
    "hook-length": [good({ voice: "Your hotel door is not locked the way you think it is, and that is because of a radio chip nobody looked at." }), good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years." }), good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" })],
    "scene-drawn": [good({ art: [{ name: "door", at: "hotel door" }, { name: "lock", at: "the way you" }] }), good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years." }), good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" })],
    "hook-object": [good({ art: [{ name: "question", drawn: true }, { name: "warning", at: "the way you" }] }), good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years." }), good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" })],
    "art-count": [good(), good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years.", art: [{ name: "chip", at: "that chip" }] }), good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" })],
    "variety": [good(), good({ id: "02-x", accent: "blue", voice: "But nobody checked that door for eleven whole years.", art: [{ name: "door", at: "that door" }, { name: "clock", at: "eleven whole years" }] }), good({ id: "03-x", accent: "green", voice: "So what door do you check tonight before you sleep?", art: [{ name: "door", at: "what door" }, { name: "bell", at: "before you sleep" }] })],
    "turn": [good(), good({ id: "02-x", accent: "blue", voice: "The chip inside it answers anyone who asks it." }), good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" })],
    "payoff": [good(), good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years." }), good({ id: "03-x", accent: "green", voice: "The lock was replaced in some places during 2024." })],
    "colour": [good({ accent: "red" }), good({ id: "02-x", accent: "red", voice: "But nobody checked that chip for eleven whole years." }), good({ id: "03-x", accent: "red", voice: "So what do you check tonight before you sleep?" })],
    "word-window": [good({ voice: "Your door is open." }), good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years." }), good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" })],
    "motion": [good(), good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years.", art: [{ name: "chip" }, { name: "clock" }] }), good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" })],
    "cue-spread": [good(), good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years.", art: [{ name: "chip", at: "But nobody" }, { name: "clock", at: "nobody checked" }] }), good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" })],
  };
  for (const [rule, scenes] of Object.entries(cases)) {
    const fired = film(scenes);
    assert.ok(fired.includes(rule), `${rule} did not fire on a film that breaks it (got: ${fired.join(", ") || "nothing"})`);
  }
});

test("what arithmetic can fix is fixed without asking the model again", () => {
  const scenes = [
    good({ art: [{ name: "door", at: "hotel door" }, { name: "lock", at: "Your hotel" }] }),
    good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years.", art: [{ name: "chip", at: "But nobody" }, { name: "clock", at: "nobody checked" }] }),
    good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" }),
  ];
  assert.ok(film(scenes).includes("scene-drawn"));
  assert.ok(film(scenes).includes("cue-spread"));
  repairExplainer(scenes, "9:16");
  const left = film(scenes);
  assert.ok(!left.includes("scene-drawn"), "the opening drawing should now be on the page at frame zero");
  assert.ok(!left.includes("cue-spread"), `a late anchor should have been chosen (left: ${left.join(", ")})`);
});

test("an anchor is only ever chosen from words the scene really says", () => {
  for (const [, prompt] of PROMPTS) {
    const a = anchorAt(prompt, 0.6);
    if (a === null) continue;
    assert.ok(quotesVoice(a, prompt), `"${a}" is not a run of words in "${prompt}"`);
    assert.ok(a.length <= 32);
  }
});

test("normalizeStoryboard turns another look's scene into an explainer scene instead of refusing it", () => {
  const plan = planFor(job("explainer-short", 45, "9:16", "en", "x"));
  const out = normalizeStoryboard({
    scenes: [{
      id: "01 hook!", kind: "closing", chapter: "01 PART", title: "A title", hl: "A", eyebrow: "NO", beats: [{ kind: "cta" }],
      items: ["a", "b", "c"], accent: "cyan", voice: "Your bread is not rising for the reason you think.",
      shot: { zoom: [1.4, 1.1], focus: [-90, 99999] },
      art: [{ name: "smartphone", at: "nothing like this line" }, { name: "not-a-drawing" }], hold: 2.5,
    }],
  }, plan);
  const s = out.scenes[0];
  assert.equal(s.kind, "sketch");
  assert.equal(s.id, "01-hook");
  for (const k of ["chapter", "title", "hl", "eyebrow", "beats", "items"]) assert.ok(!(k in s), `${k} survived`);
  assert.ok(s.shot.zoom[1] > s.shot.zoom[0], "the camera was made to move again");
  assert.deepEqual(s.shot.focus, [540, 864]);
  assert.equal(s.hold, 0.6);
  assert.equal(s.art[0].name, "phone", "smartphone is a phone");
  assert.equal(s.art[0].drawn, true, "the first drawing of the first scene is on the page at frame zero");
  assert.ok(!("at" in s.art[0]));
  // The drawing nobody can draw is dropped — and the scene is not left with one picture for a whole line.
  // The repair reads the line, asks the word index what it named, and puts that on the page instead.
  assert.ok(!s.art.some((a) => a.name === "not-a-drawing"), "the drawing nobody can draw is dropped");
  assert.equal(s.art.length, 2, "a scene left with one drawing gets a second, chosen from its own line");
  assert.ok(s.art[1].at === undefined || quotesVoice(s.art[1].at, s.voice), "and its cue quotes that line");
  const r = validateStoryboard({ schema_version: 1, editorial_status: "ready", title: "Why bread rises", style: "sketch", format: "9:16", language: "en", voice: "am_michael", music: "none", scenes: [s, { ...s, id: "02-x" }] }, { format: "9:16", language: "en" });
  assert.deepEqual(r.errors ?? [], []);
});

/* ------------------------------------------------------------------ the invariant a repair owes */

test("a repair is recognised by the rule that asked for it, and a second pass changes nothing", () => {
  // The lesson another session paid for: a repair that adds something to a storyboard must satisfy the
  // rule that demanded it, or the planner "fixes" the scene and the checker flags it again for ever.
  // Two invariants, over every one of the twenty-four subjects: after one repair the repairable rules
  // are silent, and repairing twice is the same as repairing once.
  for (const [language, prompt] of PROMPTS) {
    const w = prompt.split(/\s+/).slice(0, 12).join(" ");
    const scenes = [
      // every cue deliberately in the first half, and nothing on the page at frame zero
      { id: "01-a", kind: "sketch", accent: "red", voice: w, hold: 0.05, shot: { zoom: [1, 1.3], focus: [540, 860] },
        art: [{ name: "laptop", at: w.split(/\s+/).slice(0, 2).join(" ") }, { name: "clock", at: w.split(/\s+/).slice(1, 3).join(" ") }] },
      { id: "02-b", kind: "sketch", accent: "blue", voice: w, hold: 0.05, shot: { zoom: [1, 1.3], focus: [540, 860] },
        art: [{ name: "server", at: w.split(/\s+/).slice(0, 2).join(" ") }, { name: "eye", at: w.split(/\s+/).slice(1, 3).join(" ") }] },
    ];
    const before = checkExplainer(scenes, { duration: 45, language }).map((v) => v.rule);
    assert.ok(before.includes("scene-drawn") && before.includes("cue-spread"), `${language}: the fixture should break both repairable rules`);

    repairExplainer(scenes, "9:16");
    const after = checkExplainer(scenes, { duration: 45, language }).map((v) => v.rule);
    for (const rule of ["scene-drawn", "cue-spread"])
      assert.ok(!after.includes(rule), `${language}: repairExplainer added something "${rule}" does not recognise — "${prompt.slice(0, 40)}…"`);

    const once = JSON.stringify(scenes);
    repairExplainer(scenes, "9:16");
    assert.equal(JSON.stringify(scenes), once, `${language}: repairing twice is not the same as repairing once`);
    // And the anchor it chose has to be words the scene really says, or the render dies on the cue.
    for (const s of scenes) for (const a of s.art) if (typeof a.at === "string") assert.ok(quotesVoice(a.at, s.voice), `"${a.at}" is not in "${s.voice}"`);
  }
});

/* ------------------------------------------------------------------ what a validator cannot see */

/**
 * Three rules that exist because of what three independent readers said about films that had already
 * passed every other rule. The films were contract-valid, inside every word window, correctly paced and
 * correctly coloured, and they were bad in ways no rule looked at: "the script says the same sentence
 * four different ways", "lock and key repeat four times and nothing draws the mechanism", "the hook opens
 * a real gap and line two fills it with a platitude".
 *
 * The reference for all three is the film the channel actually shipped: it must pass them, or the rules
 * are measuring taste instead of a defect.
 */
test("echo, promise and variety catch what thirteen rules did not, and the shipped film passes all of them", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const hotel = JSON.parse(readFileSync(resolve(import.meta.dirname, "../worker/keou/examples/explainer-hotel/project.json"), "utf8"));
  assert.deepEqual(checkExplainer(hotel.scenes, { duration: 25, language: "en" }).map((v) => v.rule), [],
    "the film the channel shipped must survive every rule, or the rule set is wrong and not the film");

  // A line that says what an earlier line already said, in different words.
  const echoed = [
    good({ voice: "Your hotel door is not locked the way you think." }),
    good({ id: "02-x", accent: "blue", voice: "But the hotel door you think is locked is not." }),
    good({ id: "03-x", accent: "green", voice: "So who else has been walking into your room lately?" }),
  ];
  assert.ok(film(echoed).includes("echo"), "a line repeating an earlier one in other words must fire");

  // The hook names a thing and the film changes the subject.
  const drifted = [
    good({ voice: "Your hotel door is not locked the way you think." }),
    good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years." }),
    good({ id: "03-x", accent: "green", voice: "Cameras record every corridor in most modern buildings." }),
    good({ id: "04-x", accent: "yellow", voice: "So what do you check tonight before you sleep?", art: [{ name: "bell", drawn: true }, { name: "clock", at: "before you sleep" }] }),
  ];
  assert.ok(film(drifted).includes("promise"), "a film that drops what its hook named must fire");

  // Two scenes opening on the same drawing: the drawing IS the cut.
  const stuck = [
    good(),
    good({ id: "02-x", accent: "blue", voice: "But nobody checked that door for eleven whole years.", art: [{ name: "door", at: "that door" }, { name: "clock", at: "eleven whole years" }] }),
    good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?" }),
  ];
  assert.ok(film(stuck).includes("variety"), "two scenes in a row opening on the same drawing must fire");

  // Singular and plural are the same word: the shipped film says "hotel key card" and "thirteen thousand
  // hotels", and a comparison that cannot see that accuses the reference of changing the subject.
  const plural = [
    good({ voice: "This looks like a normal hotel key card. It isn't." }),
    good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years." }),
    good({ id: "03-x", accent: "green", voice: "Three million doors, thirteen thousand hotels, everywhere you sleep.", art: [{ name: "hotels", drawn: true }, { name: "globe", at: "everywhere you sleep" }] }),
    good({ id: "04-x", accent: "yellow", voice: "So which hotel card opened your door last night?", art: [{ name: "keycard", drawn: true }, { name: "door", at: "your door" }] }),
  ];
  assert.ok(!film(plural).includes("promise"), "hotel and hotels are the same word");
});

test("the founding rule is checkable: a scene must draw something its own line names", () => {
  // "One phrase, one drawing, and the drawing is literally what the words say" was prose in the prompt
  // until the real model answered a line about a charging cable by drawing a crowd, and three readers all
  // saw it before any rule did.
  const bad = [
    good({ voice: "You lend someone a charging cable for ten minutes.", art: [{ name: "crowd", drawn: true }, { name: "warning", at: "ten minutes" }] }),
    good({ id: "02-x", accent: "blue", voice: "But that cable is never just a cable, it turns out.", art: [{ name: "usb", at: "that cable" }, { name: "chip", at: "just a cable" }] }),
    good({ id: "03-x", accent: "green", voice: "So which cable did you plug in this morning?", art: [{ name: "usb", drawn: true }, { name: "clock", at: "this morning" }] }),
  ];
  const fired = film(bad).filter((r) => r === "draws-what-it-says");
  assert.equal(fired.length, 1, "the crowd standing in for a cable must fire, and only that scene");

  // Two figures for "two people" is correct art, and an index where only "crowd" may own "people" called
  // it a mistake. A word may belong to more than one drawing when both are right answers.
  const fine = [
    good({ voice: "Two people can open your car without touching the key.", art: [{ name: "figure", drawn: true }, { name: "car", at: "your car" }] }),
    good({ id: "02-x", accent: "blue", voice: "But the radio in their hand is doing all of it.", art: [{ name: "signal", at: "the radio" }, { name: "hand", at: "their hand" }] }),
    good({ id: "03-x", accent: "green", voice: "So where do you leave your keys at night?", art: [{ name: "key", drawn: true }, { name: "room", at: "at night" }] }),
  ];
  assert.ok(!film(fine).includes("draws-what-it-says"), "two figures for two people is the drawing the line asks for");
});

test("every drawing has words in all three languages, or the rule is blind in two of them", () => {
  // A drawing with no Italian words can never be named by an Italian line, so the rule would accuse every
  // Italian film that used it correctly.
  const src = readFileSync(resolve(import.meta.dirname, "../src/explainer-plan.ts"), "utf8");
  const table = src.slice(src.indexOf("const SKETCH_WORDS"), src.indexOf("\n};", src.indexOf("const SKETCH_WORDS")));
  for (const name of SKETCH_ART) {
    const row = new RegExp(`^  ${name}: \\{ en: \\[([^\\]]*)\\], it: \\[([^\\]]*)\\], fr: \\[([^\\]]*)\\] \\},$`, "m").exec(table);
    assert.ok(row, `${name} has no row in SKETCH_WORDS`);
    ["en", "it", "fr"].forEach((lang, i) => {
      const n = row[i + 1].split(",").filter((x) => x.trim()).length;
      assert.ok(n >= 4, `${name} has only ${n} ${lang} words: the rule cannot see it in that language`);
    });
  }
});

test("the repair chooses the drawing the line asked for, and leaves a good film alone", async () => {
  const { repairExplainer } = await import("../src/explainer-plan.ts");
  // A scene that draws none of the things it names. The word index knows which drawing the line wanted,
  // and the anchor comes from the same word that chose it, so the cut lands where the thing is named.
  const scenes = [
    good({ voice: "You lend someone a charging cable for ten minutes.", art: [{ name: "crowd", drawn: true }] }),
    good({ id: "02-x", accent: "blue", voice: "But that cable is never just a cable, it turns out.", art: [{ name: "chip", at: "just a cable" }, { name: "warning", at: "never" }] }),
    good({ id: "03-x", accent: "green", voice: "So which cable did you plug in this morning?", art: [{ name: "clock", drawn: true }, { name: "hand", at: "plug in" }] }),
  ];
  assert.ok(film(scenes).includes("draws-what-it-says"));
  repairExplainer(scenes, "9:16", "en");
  assert.ok(!film(scenes).includes("draws-what-it-says"), "the line said 'charging cable' and the index knows what draws one");
  const added = scenes[0].art.find((a) => a.name !== "crowd");
  assert.ok(added, "a drawing must have been added to the first scene");
  assert.ok(added.at === undefined || quotesVoice(added.at, scenes[0].voice), "its cue must quote the line");

  // Two scenes opening on the same drawing, where the other drawing is FREE: rotate rather than retry.
  const stuck = [
    good({ voice: "Your hotel door is not locked the way you think.", art: [{ name: "door", drawn: true }, { name: "lock", at: "the way you" }] }),
    good({ id: "02-x", accent: "blue", voice: "But the door was never the part that mattered here.", art: [{ name: "door", drawn: true }, { name: "chip", drawn: true }] }),
    good({ id: "03-x", accent: "green", voice: "So who else has been walking into your room lately?", art: [{ name: "room", drawn: true }, { name: "footprints", at: "walking into" }] }),
  ];
  assert.ok(film(stuck).includes("variety"));
  repairExplainer(stuck, "9:16", "en");
  assert.ok(!film(stuck).includes("variety"), "the second scene owned a free drawing: it opens on that one now");

  // And where the other drawing is CUED TO A WORD, it must refuse to rotate and let the model try again.
  // Promoting a cued drawing to the opening frame destroys its cue, so it arrives a beat behind its own
  // sentence — three blind readers out of three preferred the unrepaired cut for exactly that.
  const cued = [
    good({ voice: "Your hotel door is not locked the way you think.", art: [{ name: "door", drawn: true }, { name: "lock", at: "the way you" }] }),
    good({ id: "02-x", accent: "blue", voice: "But the door was never the part that mattered here.", art: [{ name: "door", drawn: true }, { name: "chip", at: "never the part" }] }),
    good({ id: "03-x", accent: "green", voice: "So who else has been walking into your room lately?", art: [{ name: "room", drawn: true }, { name: "footprints", at: "walking into" }] }),
  ];
  repairExplainer(cued, "9:16", "en");
  assert.equal(cued[1].art[0].name, "door", "a cued drawing must not be dragged into the opening frame");
  assert.equal(cued[1].art[1].name, "chip", "and it must still be the one that arrives on a word");
  assert.ok(typeof cued[1].art[1].at === "string" && quotesVoice(cued[1].art[1].at, cued[1].voice),
    "it keeps a cue quoting its own line — cue-spread may move it later in the sentence, which is its job, but it may never become a drawing that is simply there from the first frame");
  assert.ok(cued[1].art[1].drawn !== true, "promoting it to the opening frame is the damage this guard exists to prevent");

  // THE ONE THAT MATTERS: a film that is already right must come out byte for byte identical, twice.
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const hotel = JSON.parse(readFileSync(resolve(import.meta.dirname, "../worker/keou/examples/explainer-hotel/project.json"), "utf8"));
  const before = JSON.stringify(hotel.scenes);
  repairExplainer(hotel.scenes, "9:16", "en");
  assert.equal(JSON.stringify(hotel.scenes), before, "the shipped film must not be touched by a repair");
  repairExplainer(hotel.scenes, "9:16", "en");
  assert.equal(JSON.stringify(hotel.scenes), before, "and repairing twice must equal repairing once");
});

test("every scene opens on a drawing, and a scene that does not is repaired", async () => {
  // From a rented GPU, not a fixture: a planner film with a drawn element in 2 of 7 scenes produced three
  // black intervals of 0.15 s, one at each scene that opened waiting for a cue, and qa.py refused it. The
  // shipped hotel film has a drawing on the page in every one of its six scenes.
  const { repairExplainer } = await import("../src/explainer-plan.ts");
  const scenes = [
    good(),
    good({ id: "02-x", accent: "blue", voice: "But nobody checked that chip for eleven whole years.", art: [{ name: "chip", at: "that chip" }, { name: "clock", at: "eleven whole years" }] }),
    good({ id: "03-x", accent: "green", voice: "So what do you check tonight before you sleep?", art: [{ name: "bell", at: "you check" }, { name: "clock", at: "before you sleep" }] }),
  ];
  const fired = film(scenes).filter((r) => r === "scene-drawn");
  assert.equal(fired.length, 2, "scenes 2 and 3 open on nothing and both must be named");
  repairExplainer(scenes, "9:16", "en");
  assert.ok(!film(scenes).includes("scene-drawn"), "arithmetic puts the first drawing of each scene on the page");
  assert.equal(scenes[1].art[0].drawn, true); assert.ok(!("at" in scenes[1].art[0]));
  const { readFileSync } = await import("node:fs"); const { resolve } = await import("node:path");
  const hotel = JSON.parse(readFileSync(resolve(import.meta.dirname, "../worker/keou/examples/explainer-hotel/project.json"), "utf8"));
  assert.ok(hotel.scenes.every((s) => s.art.some((a) => a.drawn === true)), "the reference already does this in every scene");
});
