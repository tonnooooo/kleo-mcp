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
import { planFor, pickKleoStyle, pickKleoStyleWhy } from "../src/storyboard.ts";
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

/**
 * THE HELD-OUT SET. Ten requests written by another session (KLEO-3, the explainer look) that had NOT seen this file
 * and had not read the vocabularies since they were rewritten. Its own declaration, kept here because it changes how
 * much the number is worth: it had read the OLD monolingual word lists earlier in the day while looking for a place
 * to hook its own work, so it is not blind — but it did not reopen them before writing, and it deliberately chose
 * requests that AVOID the trigger words it remembered. A request with no obvious keyword is exactly where a
 * vocabulary classifier fails, so that choice makes the set harder, not softer.
 *
 * `also` are the answers its author called defensible: where a person could reasonably expect either, both count.
 * Nothing here was used to write or tune the vocabularies. Whatever it scores, it scored on requests never seen.
 *
 * One rule of scoring, stated rather than assumed: three of these expect "explainer", and a viral-short can never
 * return it — the drawn explainer is chosen BY NAME, on purpose, because it is a different product (no closing
 * scene, one drawing per phrase, karaoke captions) and nobody asking for a viral Short should be handed it by
 * accident. For a Short, the right answer to "explain this invisible mechanism" is the diagram look, cyber.
 */
const HELD_OUT = [
  { p: "Mia nonna diceva che il pane di una volta durava una settimana e adesso ammuffisce in due giorni. Fammi un video che spiega perché.", want: "realistic", lang: "it" },
  { p: "Mio nonno partì in nave a diciassette anni e non tornò più al paese. Voglio raccontarlo in un minuto.", want: "cartoon", lang: "it" },
  { p: "Come fa il semaforo a sapere che c'è una macchina che aspetta?", want: "cyber", lang: "it" },
  { p: "Ho comprato un materasso da ottocento euro e dormo peggio di prima. Fammi un video su come si sceglie.", want: "realistic", lang: "it" },
  { p: "Cosa succede al corpo quando smetti di bere alcol per trenta giorni?", want: "cyber", also: ["realistic"], lang: "it" },
  { p: "My landlord says the boiler is fine but the radiators are cold on the top floor only. Make a video explaining what's actually happening.", want: "cyber", lang: "en" },
  { p: "I want to tell people what happened the night the lights went out across half the country in 2003.", want: "realistic", lang: "en" },
  { p: "Explain what actually happens to the money when I tap my card.", want: "cyber", lang: "en" },
  { p: "A short about the woman who sold the Eiffel Tower twice.", want: "cartoon", also: ["realistic"], lang: "en" },
  { p: "Why does my sourdough smell like nail polish?", want: "cyber", lang: "en" },
];

/**
 * A SECOND HELD-OUT SET, from the coordinating session (BOSS), which states that it read neither this file, nor the
 * vocabularies, nor the body of pickKleoStyle, and wrote its labels before looking at anything. Kept separate from
 * the first because provenance is part of a number: two sources that did not see each other's requests are worth
 * more than twenty from one.
 *
 * Its author marked #6 uncertain on purpose — a nuclear reactor is a physical mechanism, which pulls towards the
 * drawn look, and a technical one, which pulls towards motion design — and asked for it to be counted as a boundary
 * rather than an error. A corpus where every answer is obvious measures nothing.
 *
 * It also named the pair that matters: 3 and 9 are both "how does this work", one domestic and one computing. The
 * same answer for both is where the mechanism still cannot tell them apart.
 */
const HELD_OUT_2 = [
  { p: "Come fanno i ladri a rubare una macchina senza la chiave", want: "cyber", lang: "it" },
  { p: "The lighthouse keeper who kept the light burning for forty years", want: "cartoon", lang: "en" },
  { p: "Perché il telefono si scarica più in fretta d'inverno", want: "cyber", lang: "it" },
  { p: "A 40 second Short about life on the International Space Station", want: "realistic", lang: "en" },
  { p: "I tre errori che fanno tutti quando cuociono la pasta", want: "cyber", also: ["cartoon"], lang: "it" },
  { p: "How a nuclear reactor actually works", want: "cyber", also: ["cartoon"], lang: "en" },
  { p: "La storia del pirata che seppellì il tesoro e non tornò mai", want: "cartoon", lang: "it" },
  { p: "Review of the new Sony headphones, 30 seconds", want: "realistic", lang: "en" },
  { p: "What happens to your data when you delete a file", want: "cyber", lang: "en" },
  { p: "Il borgo italiano più bello che non conosce nessuno", want: "realistic", lang: "it" },
];

/**
 * A THIRD HELD-OUT SET, from the explainer session again, and built to probe one thing the other two cannot: the
 * border between the diagram look and the drawn explainer. Its author's framing, which is the useful part:
 *   cyber wants something to DIAGRAM — a flow, a comparison, numbers.
 *   explainer wants ONE IDEA TAKEN APART — every sentence has a literal object to draw, and the viewer ends up
 *   believing something different.
 * A topic can sit in either. "Cybersecurity" decides nothing.
 *
 * `pivotal` marks 1, 3 and 5: same semantic field as 2, 6 and 7, opposite answer. If the classifier gets the twins
 * right and the pivotal ones wrong, the overall score stays high while the measure says nothing — it is a classifier
 * of TOPICS posing as a classifier of LOOKS. `pair` names the twin, so the collapse is reported and not averaged away.
 * Number 4 carries no technical word at all, and it does NOT reach the drawn explainer. That is not a defect. The
 * session that owns that look does not want it reachable from a prompt, on purpose: it is a different product — no
 * closing scene, one drawing per phrase, the film ends on the last drawing — and nobody asking for a viral Short
 * should be handed it by accident. What the request really shows is that if the prompt is not a road to it, the
 * TEMPLATE is the only road, and one road with no guard is a single point of failure. That guard now exists.
 */
const HELD_OUT_3 = [
  { p: "Spiegami cos'è una VPN a mia madre.", want: "explainer", lang: "it", pivotal: true, pair: "attacchi" },
  { p: "Fammi un video sui cinque attacchi informatici più costosi della storia.", want: "cyber", lang: "it", id: "attacchi" },
  { p: "Perché il wi-fi dell'hotel è pericoloso? Voglio una cosa corta che capisca chiunque.", want: "explainer", lang: "it", pivotal: true, pair: "flusso" },
  { p: "Spiega in un minuto perché l'acqua bollente in freezer a volte ghiaccia prima di quella fredda.", want: "explainer", lang: "it", pivotal: true },
  { p: "Explain why a password manager is safer than remembering them, to someone who is sure it is less safe.", want: "explainer", lang: "en", pivotal: true, pair: "bolletta" },
  { p: "Show how our data goes from the app to the servers to the third parties nobody reads about.", want: "cyber", lang: "en", id: "flusso" },
  { p: "Break down how much of a phone bill is actually the network and how much is everything else.", want: "cyber", lang: "en", id: "bolletta" },
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
// A request is DECIDED only when its words moved the answer away from what an empty request gets. Anything else is
// indistinguishable from the default landing on the right answer by luck — and that is not a rounding error, it is
// the flaw: while the default is itself one of the real categories, a decision and a coincidence look identical from
// the outside. Every prompt whose expected look IS the default therefore proves nothing either way.
const decided = rows.filter((r) => pickKleoStyle(TEMPLATE, r.p) !== pickKleoStyle(TEMPLATE, ""));
const undecided = rows.filter((r) => !decided.includes(r));
const fellBack = undecided;

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
line(`2. FALLBACK   ${fellBack.length}/${rows.length} = ${pct(fellBack.length, rows.length)} of requests never move the answer: they land on the default "${DEFAULT_LOOK}" whatever they say`);
const rightDecided = decided.filter((r) => r.got.look === r.want).length;
const rightUndecided = undecided.filter((r) => r.got.look === r.want).length;
line(`              when the words DO decide: ${rightDecided}/${decided.length} right${decided.length ? ` = ${pct(rightDecided, decided.length)}` : ""}`);
line(`              when they do not:        ${rightUndecided}/${undecided.length} right${undecided.length ? ` = ${pct(rightUndecided, undecided.length)}` : ""} — the default landing on it, not a decision`);
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
  line("EVERY REQUEST THAT GOT THE WRONG LOOK, with the reason it gave");
  for (const r of wrong) {
    line(`  [${r.lang}] want ${r.want.padEnd(9)} got ${r.got.look.padEnd(9)} "${r.p.slice(0, 62)}"`);
    line(`         because: ${pickKleoStyleWhy(TEMPLATE, r.p).why}`);
  }
  line();
}

/* ---------------------------------------------------------------- the held-out sets */
const scoreHeld = (set) => set.map((h) => {
  const pick = pickKleoStyleWhy(TEMPLATE, h.p);
  const accept = [h.want, ...(h.also ?? [])];
  return { ...h, got: pick.style, why: pick.why, ok: accept.includes(pick.style), accept };
});
const report = (name, set) => {
  const r = scoreHeld(set);
  line(name);
  for (const h of r) {
    line(`  ${h.ok ? "OK  " : "MISS"} [${h.lang}] want ${h.accept.join("/").padEnd(18)} got ${h.got.padEnd(9)} "${h.p.slice(0, 56)}"`);
    if (!h.ok) line(`         because: ${h.why}`);
  }
  line(`  ${r.filter((h) => h.ok).length}/${r.length} = ${pct(r.filter((h) => h.ok).length, r.length)}`);
  line();
  return r;
};
const h1 = report("HELD-OUT A — written by the explainer session (had seen the OLD word lists, avoided them on purpose)", HELD_OUT);
const h2 = report("HELD-OUT B — written by the coordinating session (read nothing; labels written before looking)", HELD_OUT_2);
const h3 = report("HELD-OUT C — the border between the diagram look and the drawn explainer, from the explainer session", HELD_OUT_3);

/**
 * The question this set was built to answer, and the one a score cannot: can the classifier tell the two apart AT
 * ALL? A viral-short may not return the drawn explainer — that look is chosen by name, on purpose — so a request
 * that wants it and its twin that wants a diagram should still not be indistinguishable. They are twins in TOPIC
 * and opposites in FORM.
 */
line("THE BORDER — twins in topic, opposites in form");
const byId = new Map(h3.filter((x) => x.id).map((x) => [x.id, x]));
let collapsed = 0;
for (const a of h3.filter((x) => x.pair)) {
  const b = byId.get(a.pair);
  if (!b) continue;
  // Told apart is only told apart when it is told apart CORRECTLY. Two requests that get different answers, both
  // wrong, are not a distinction: they are two errors that happen not to coincide, and counting them as a success is
  // the same mistake as counting a lucky default as a decision.
  const differ = a.got !== b.got;
  const verdict = !differ ? "COLLAPSED" : a.ok && b.ok ? "told apart" : "differ, both wrong";
  if (!differ || !(a.ok && b.ok)) collapsed++;
  line(`  ${verdict.padEnd(19)} "${a.p.slice(0, 42)}" -> ${a.got}${a.ok ? "" : "  (wanted " + a.accept.join("/") + ")"}`);
  line(`  ${" ".repeat(19)} "${b.p.slice(0, 42)}" -> ${b.got}${b.ok ? "" : "  (wanted " + b.accept.join("/") + ")"}`);
}
const independent = h3.find((x) => x.p.startsWith("Spiega in un minuto perché l'acqua"));
line(`  independence: a request with no technical word at all -> ${independent ? independent.got : "?"}`);
line("                the drawn explainer is reachable only by naming its template, and that is deliberate — which is");
line("                why that template is a single point of failure, and why it now has a test of its own.");
line(`  ${collapsed} of 3 pairs are not a distinction: a classifier of topics cannot see a difference of FORM.`);
line();

const allHeld = [...h1, ...h2, ...h3];
line(`HELD-OUT TOTAL  ${allHeld.filter((h) => h.ok).length}/${allHeld.length} = ${pct(allHeld.filter((h) => h.ok).length, allHeld.length)} on requests this code never saw`);
line();

/**
 * THE GATE. It watches the HELD-OUT number, not the corpus written here: 100% on requests written by the same hand
 * that wrote the vocabularies means nothing, and 35% on twenty requests from two other sessions is what this
 * actually does. The floor is the measured baseline, so a change that makes it worse fails the build — but 35% is
 * NOT an acceptable score and this line is not permission to leave it there. It is the number to beat.
 *
 * The failure is not a missing word, and the fix is not more words. Thirteen of the twenty misses read "nothing in
 * the request names a subject": ordinary sentences do not contain the vocabulary, and every list long enough to
 * catch them would be longer than the language. A word list cannot read a sentence. What can is the direction —
 * src/direction.ts, step zero of the planner — which is why the honest role of this function is a LAST RESORT for
 * when there is no model to ask, and why what it needs next is to say "I do not know" instead of guessing a look
 * that costs money.
 */
// 0.35 was the baseline over the first twenty. The border set that followed added seven requests the classifier gets
// wrong in every case, so the same code now measures 26% — the number moved because the corpus got harder, not
// because anything regressed. This is a RATCHET against getting worse, and 26% is a failing grade written down.
const BASELINE = 0.25;
const heldScore = allHeld.filter((h) => h.ok).length / allHeld.length;
const ok = heldScore >= BASELINE;
line(ok
  ? `PASS — ${pct(allHeld.filter((h) => h.ok).length, allHeld.length)} held-out, at or above the ${pct(BASELINE, 1)} baseline. The baseline is what this scores today, not what it should score.`
  : `FAIL — ${pct(allHeld.filter((h) => h.ok).length, allHeld.length)} held-out is BELOW the ${pct(BASELINE, 1)} baseline: a change made the reasoning worse on requests it never saw.`);
process.exit(ok ? 0 : 1);
