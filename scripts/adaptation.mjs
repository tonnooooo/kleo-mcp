/**
 * HOW MUCH OF A KLEO VIDEO IS DECIDED BY THE PROMPT?
 *
 * The verdict that started this was "ha le stesse immagini, non si è adattato". That is a claim about the reasoning,
 * not about the renderer, so it can be measured without a GPU and without a deploy: everything below runs the
 * DETERMINISTIC half of the planner — the half that decides, before a single model call, which look the film has, how
 * many scenes it gets, how long each line is and which brief the model will be handed.
 *
 * If those decisions barely move when the prompt changes, no amount of good writing downstream can make the film fit
 * the request: the shape was chosen before anyone read the sentence.
 *
 * Four numbers, all reproducible:
 *   1. ACCURACY   — how often the look Kleo picks is the one a person would obviously expect.
 *   2. FALLBACK   — how often nothing matched and the default fired. A default is not a decision.
 *   3. INFLUENCE  — how many of the plan's fields vary with the PROMPT at all, rather than with the template.
 *   4. FRAGILITY  — prompts that mean the same thing and get different plans, and prompts that mean different
 *                   things and get the same one.
 *
 * Run: node scripts/adaptation.mjs          (prints a report; exits 1 if accuracy falls under the floor)
 * It reads src/storyboard.ts and changes nothing.
 */
import { planFor, pickKleoStyle } from "../src/storyboard.ts";
import { TEMPLATES, findTemplate } from "../src/templates.ts";

/**
 * The corpus. Each entry is a request a real person might type, and `want` is the look a person would obviously
 * expect — not the look the code happens to produce. Written before running anything, so the labels cannot drift
 * towards whatever the current rules do.
 *
 * Half of it is Italian on purpose: kleo_create_video accepts Italian jobs, the owner is Italian, and his first
 * users write Italian. A reasoning layer that only understands English is not a reasoning layer, it is a phrasebook.
 */
const CORPUS = [
  // ---- stories, characters, history: drawn ----
  { p: "A Short about pirates who find an island that isn't on any map", want: "cartoon", lang: "en" },
  { p: "The story of the lighthouse keeper who kept a light burning for forty years", want: "cartoon", lang: "en" },
  { p: "Tell the myth of Icarus as a bedtime story for children", want: "cartoon", lang: "en" },
  { p: "A short film about a stray dog that walked five hundred kilometres home", want: "cartoon", lang: "en" },
  { p: "The history of hacking, told as a bedtime story", want: "cartoon", lang: "en" },
  { p: "Racconta la storia dei pirati che trovarono un'isola che non era su nessuna mappa", want: "cartoon", lang: "it" },
  { p: "Una favola della buonanotte sul drago che aveva paura del buio", want: "cartoon", lang: "it" },
  { p: "La leggenda del cavaliere che non voleva combattere, per bambini", want: "cartoon", lang: "it" },
  { p: "La storia del cane che tornò a casa a piedi dopo cinquecento chilometri", want: "cartoon", lang: "it" },

  // ---- places, products, news, sport: photographed ----
  { p: "A 5-minute video about the new electric car everyone is talking about", want: "realistic", lang: "en" },
  { p: "Three days in Lisbon: what to see, what to eat, what to skip", want: "realistic", lang: "en" },
  { p: "What happened at the election last night, four stories with sources", want: "realistic", lang: "en" },
  { p: "Review of a 300 euro drone, pros and cons and a final score", want: "realistic", lang: "en" },
  { p: "Tre giorni a Lisbona: cosa vedere, cosa mangiare, cosa evitare", want: "realistic", lang: "it" },
  { p: "Recensione di un drone da 300 euro, pregi e difetti e un voto finale", want: "realistic", lang: "it" },
  { p: "Cosa è successo alle elezioni ieri sera, quattro notizie con le fonti", want: "realistic", lang: "it" },
  { p: "Il nuovo treno ad alta velocità Napoli-Milano, quanto costa e quanto ci mette", want: "realistic", lang: "it" },

  // ---- tech, security, abstractions: diagrams ----
  { p: "Explain how a phishing attack works and how to spot one", want: "cyber", lang: "en" },
  { p: "How does an MCP server actually work, with diagrams", want: "cyber", lang: "en" },
  { p: "Why your passwords leak, and what a password manager really does", want: "cyber", lang: "en" },
  { p: "Spiega come funziona un attacco di phishing e come riconoscerlo", want: "cyber", lang: "it" },
  { p: "Perché le tue password finiscono in rete, e cosa fa davvero un gestore di password", want: "cyber", lang: "it" },
  { p: "Come funziona la crittografia dei messaggi, spiegata semplice", want: "cyber", lang: "it" },

  // ---- everyday how-to and human advice: drawn, no jargon ----
  { p: "The five mistakes beginners make at the gym, told with humour", want: "cartoon", lang: "en" },
  { p: "How to say no at work without feeling guilty", want: "cartoon", lang: "en" },
  { p: "I cinque errori che fanno tutti i principianti in palestra, con ironia", want: "cartoon", lang: "it" },
  { p: "Come dire di no al lavoro senza sentirsi in colpa", want: "cartoon", lang: "it" },
  { p: "Perché di notte non riesci a dormire, e le due abitudini che aiutano", want: "cartoon", lang: "it" },
];

/** Pairs that mean the same thing. A plan that changes between them is reacting to words, not to meaning. */
const SAME_MEANING = [
  ["A Short about pirates who find an island that isn't on any map",
   "Racconta la storia dei pirati che trovarono un'isola che non era su nessuna mappa"],
  ["Explain how a phishing attack works and how to spot one",
   "Spiega come funziona un attacco di phishing e come riconoscerlo"],
  ["Three days in Lisbon: what to see, what to eat, what to skip",
   "Tre giorni a Lisbona: cosa vedere, cosa mangiare, cosa evitare"],
  ["The five mistakes beginners make at the gym, told with humour",
   "I cinque errori che fanno tutti i principianti in palestra, con ironia"],
];

/** Pairs that mean different things. A plan that is identical for both has not read either of them. */
const DIFFERENT_MEANING = [
  ["Tell the myth of Icarus as a bedtime story for children",
   "Explain how a phishing attack works and how to spot one"],
  ["Three days in Lisbon: what to see, what to eat, what to skip",
   "The story of the lighthouse keeper who kept a light burning for forty years"],
];

const job = (prompt, template, language) => ({
  id: "measure", template, prompt,
  params: JSON.stringify({ duration_s: findTemplate(template).defaultSeconds, format: findTemplate(template).formats[0], language, voice: null }),
});

/** Everything the planner settles before the model is asked anything at all. */
function decide(prompt, template, language) {
  const plan = planFor(job(prompt, template, language));
  return {
    look: plan.kleo,
    engine: plan.style,
    scenes: `${plan.scenes[0]}-${plan.scenes[1]}`,
    words: plan.words.target,
    brief: (plan.brief.guidance || "").slice(0, 40),
  };
}

const FIELDS = ["look", "engine", "scenes", "words", "brief"];
const TEMPLATE = "viral-short";   // one template throughout, so anything that moves moved because of the PROMPT

const rows = CORPUS.map((c) => ({ ...c, got: decide(c.p, TEMPLATE, c.lang) }));

/* ---------------------------------------------------------------- 1. accuracy */
const right = rows.filter((r) => r.got.look === r.want);
const wrong = rows.filter((r) => r.got.look !== r.want);
const byLang = (l) => {
  const s = rows.filter((r) => r.lang === l);
  return { n: s.length, ok: s.filter((r) => r.got.look === r.want).length };
};

/* ---------------------------------------------------------------- 2. fallback */
// pickKleoStyle falls through to a default when none of its three word lists matches. Detected by asking it for a
// prompt that certainly matches nothing and seeing what comes back, then counting the prompts that give the same.
const DEFAULT_LOOK = pickKleoStyle(TEMPLATE, "zzzz qqqq wwww");
const fellBack = rows.filter((r) => {
  // A prompt "fell back" when emptying it changes nothing: the words contributed no decision.
  return pickKleoStyle(TEMPLATE, r.p) === DEFAULT_LOOK && pickKleoStyle(TEMPLATE, "") === DEFAULT_LOOK
    && pickKleoStyle(TEMPLATE, r.p) === pickKleoStyle(TEMPLATE, "");
});

/* ---------------------------------------------------------------- 3. influence */
const varies = FIELDS.filter((f) => new Set(rows.map((r) => String(r.got[f]))).size > 1);
const distinctPlans = new Set(rows.map((r) => FIELDS.map((f) => r.got[f]).join("|"))).size;

/* ---------------------------------------------------------------- 4. fragility */
const same = SAME_MEANING.map(([a, b]) => {
  const x = decide(a, TEMPLATE, "en"), y = decide(b, TEMPLATE, "it");
  return { a, b, agree: FIELDS.every((f) => String(x[f]) === String(y[f])), x, y };
});
const diff = DIFFERENT_MEANING.map(([a, b]) => {
  const x = decide(a, TEMPLATE, "en"), y = decide(b, TEMPLATE, "en");
  return { a, b, identical: FIELDS.every((f) => String(x[f]) === String(y[f])) };
});

/* ---------------------------------------------------------------- report */
const pct = (n, d) => `${((n / d) * 100).toFixed(0)}%`;
const line = (s = "") => console.log(s);

line("ADAPTATION TO THE PROMPT — what Kleo decides before it asks a model anything");
line(`corpus: ${rows.length} requests, one template (${TEMPLATE}), ${byLang("en").n} English and ${byLang("it").n} Italian`);
line();
line(`1. ACCURACY   ${right.length}/${rows.length} = ${pct(right.length, rows.length)} of requests get the look a person would expect`);
line(`              English ${byLang("en").ok}/${byLang("en").n} = ${pct(byLang("en").ok, byLang("en").n)}   Italian ${byLang("it").ok}/${byLang("it").n} = ${pct(byLang("it").ok, byLang("it").n)}`);
line();
line(`2. FALLBACK   ${fellBack.length}/${rows.length} = ${pct(fellBack.length, rows.length)} of requests decide nothing: the words match no rule and the default "${DEFAULT_LOOK}" fires`);
line();
line(`3. INFLUENCE  ${varies.length}/${FIELDS.length} of the plan's fields move with the prompt: [${varies.join(", ") || "none"}]`);
line(`              fixed by the template whatever is asked: [${FIELDS.filter((f) => !varies.includes(f)).join(", ") || "none"}]`);
line(`              ${distinctPlans} distinct plans for ${rows.length} different requests`);
line();
line(`4. FRAGILITY  same meaning, same plan: ${same.filter((s) => s.agree).length}/${same.length}`);
for (const s of same.filter((x) => !x.agree)) line(`                MISMATCH  "${s.a.slice(0, 46)}…" -> ${s.x.look}   vs   "${s.b.slice(0, 46)}…" -> ${s.y.look}`);
line(`              different meaning, different plan: ${diff.filter((d) => !d.identical).length}/${diff.length}`);
for (const d of diff.filter((x) => x.identical)) line(`                COLLAPSED "${d.a.slice(0, 40)}…" and "${d.b.slice(0, 40)}…" get the same plan`);
line();
if (wrong.length) {
  line("EVERY REQUEST THAT GOT THE WRONG LOOK");
  for (const r of wrong) line(`  [${r.lang}] want ${r.want.padEnd(9)} got ${r.got.look.padEnd(9)} "${r.p.slice(0, 72)}"`);
  line();
}

/** The floor. Not a target — a line under which the reasoning is not reasoning. */
const FLOOR = 0.75;
const ok = right.length / rows.length >= FLOOR;
line(ok ? `PASS — ${pct(right.length, rows.length)} is at or above the ${pct(FLOOR, 1)} floor`
        : `FAIL — ${pct(right.length, rows.length)} is under the ${pct(FLOOR, 1)} floor`);
process.exit(ok ? 0 : 1);
