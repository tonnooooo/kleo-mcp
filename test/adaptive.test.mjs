import test from "node:test";
import assert from "node:assert/strict";
import { adaptPrompt, adaptivePromptText, intakeText, lookFromText, INTAKE, REQUIRED_INTAKE, subjectFrom, lengthOf, languageAnswer, languageFromRequest, aiUpscaleAnswer } from "../src/adaptive.ts";
import { words, STOP, INTAKE_VOCAB } from "../src/format-vocab.ts";

test("the intake is a fixed list: nine things Kleo settles every time (music and subtitles since 22 September, the product, the film's AI upscale and the narration's language since 25 September), three it offers to ask", () => {
  assert.deepEqual(INTAKE.map((i) => i.key), ["subject", "duration", "format", "look", "product", "ai_upscale", "music", "subtitles", "language", "audience", "tone", "must_keep"]);
  assert.deepEqual([...REQUIRED_INTAKE], ["subject", "duration", "format", "look", "product", "ai_upscale", "music", "subtitles", "language"]);
  for (const i of INTAKE) { assert.ok(i.question.it.includes("?"), `${i.key}: the Italian question is a question`); assert.ok(i.question.en.includes("?"), `${i.key}: the English question is a question`); }
});

test("what the request says is read, what it does not say is asked — in the request's language, required first", () => {
  const brief = adaptPrompt("Creami un video realistico su una corsa automobilistica");
  assert.equal(brief.chat_language, "it"); assert.equal(brief.language, null, "the chat's language is not the film's: asked");
  assert.equal(brief.look, "realistic", "'realistico' names the look");
  assert.equal(brief.duration_s, null); assert.equal(brief.format, null, "nothing says where it goes: asked, not assumed 16:9");
  assert.deepEqual(brief.intake.missing, ["duration", "format", "music", "subtitles", "language"]);
  assert.deepEqual(brief.intake.optional, ["audience", "tone", "must_keep"]);
  assert.deepEqual(brief.questions.slice(0, 2), ["Quanto deve durare? (da 15 secondi a 5 minuti per un film; un animatic dura al massimo 60 secondi)", "Per dove è: YouTube (orizzontale, 16:9) o Short / TikTok / Reel (verticale, 9:16)?"]);
  assert.match(brief.questions[2], /^Vuoi la musica sotto la voce\?/); assert.match(brief.questions[3], /^Vuoi i sottotitoli impressi nel video/);
  assert.equal(brief.optional_questions.length, 3); assert.match(brief.optional_questions[0], /Per chi è\?/);
  const text = adaptivePromptText(brief);
  assert.match(text, /- Length: MISSING — ask/); assert.match(text, /- Look: realistic \(from the request\)/);
  assert.match(text, /ASK THE USER NOW, in ONE message, in Italian/); assert.match(text, /1\. Quanto deve durare/); assert.match(text, /2\. Per dove è/);
  assert.match(text, /Optional, in the SAME message/);
});

test("a complete request asks nothing, and the answers passed on the call count as the user's", () => {
  const said = adaptPrompt("Create a realistic film about a night race, 2 minutes, YouTube landscape, no music, with subtitles, narrated in English");
  assert.equal(said.duration_s, 120); assert.equal(said.format, "16:9"); assert.equal(said.look, "realistic");
  assert.deepEqual(said.music, { wanted: false, brief: null }); assert.equal(said.subtitles, true);
  assert.deepEqual(said.questions, []); assert.deepEqual(said.intake.missing, []);
  assert.equal(said.intake.answered.duration.from, "request"); assert.equal(said.intake.answered.format.from, "request"); assert.equal(said.intake.answered.music.from, "request");
  assert.equal(said.language, "en"); assert.equal(said.intake.answered.language.from, "request");
  const answered = adaptPrompt("A film about a night race", { duration_s: 120, format: "16:9", look: "animation", audience: "kids", tone: "warm", must_keep: "the number 7", music: "no", subtitles: false, language: "en" });
  assert.deepEqual(answered.questions, []); assert.deepEqual(answered.optional_questions, []);
  assert.equal(answered.intake.answered.look.from, "call"); assert.equal(answered.intake.answered.must_keep.value, "the number 7");
  assert.match(adaptivePromptText(answered), /Adaptive film brief ready/); assert.match(adaptivePromptText(answered), /- Must appear: the number 7/);
  assert.ok(answered.assumptions.some((value) => /no music/i.test(value)));
  assert.match(intakeText(answered), /- Look: animation \(the user's answer\)/);
});

test("the chat's language is read from the words only one language owns: 'video' decides nothing", () => {
  assert.equal(adaptPrompt("Create a video about accuracy in medicine").chat_language, "en");
  assert.equal(adaptPrompt("A film about a night race, 2 minutes").chat_language, "en");
  assert.equal(adaptPrompt("Fammi un video sui pirati, 30 secondi").chat_language, "it");
  assert.equal(adaptPrompt("Un documentario sulla laguna di Venezia").chat_language, "it");
});

test("the frame and the look are read only from words that say them", () => {
  assert.equal(adaptPrompt("A realistic vertical Short about rain", { duration_s: 30 }).format, "9:16");
  assert.equal(adaptPrompt("Un video per YouTube sui pirati").format, "16:9");
  assert.equal(adaptPrompt("Un reel sui pirati").format, "9:16");
  assert.equal(adaptPrompt("Un video sui pirati").format, null);
  assert.equal(adaptPrompt("Un cartone animato sui pirati").look, "animation");
  assert.equal(adaptPrompt("Un documentario sui pirati").look, "realistic");
  assert.equal(adaptPrompt("Un video sui pirati").look, null);
  assert.ok(adaptPrompt("Un video sui pirati").questions.some((q) => /Come lo vuoi: realistico/.test(q)));
});

/* ------------------------------------------------------------------ music, subtitles, "stupiscimi" (22 September) */

test("music and subtitles are asked every time, and 'no' is an answer that is honoured, not a gap", () => {
  const open = adaptPrompt("A realistic film about a night race, 2 minutes, YouTube");
  assert.deepEqual(open.intake.missing, ["music", "subtitles", "language"]);
  assert.equal(open.music, null); assert.equal(open.subtitles, null);
  assert.match(open.questions[0], /^Do you want music under the narration\?/); assert.match(open.questions[1], /^Do you want subtitles burned into the video/);
  assert.match(adaptivePromptText(open), /- Music: MISSING — ask/); assert.match(adaptivePromptText(open), /- Subtitles: MISSING — ask/);
  assert.match(adaptivePromptText(open), /their answers \(duration_s, format, style, product, ai_upscale, music, subtitles, language, audience, tone, must_keep; if the user says the narration's language does not matter, pass language "en"; if they leave the AI upscale question unanswered, pass ai_upscale "no"\)/);
  const no = adaptPrompt("A realistic film about a night race, 2 minutes, YouTube", { music: "No.", subtitles: "no", language: "en" });
  assert.deepEqual(no.music, { wanted: false, brief: null }); assert.equal(no.subtitles, false); assert.deepEqual(no.questions, []);
  assert.match(adaptivePromptText(no), /- Music: none — narration only/); assert.match(adaptivePromptText(no), /- Subtitles: none burned in/);
  assert.match(intakeText(no), /- Music: none \(the user's answer\)/);
  const yes = adaptPrompt("A realistic film about a night race, 2 minutes, YouTube", { music: "tense electronic, slow pulse", subtitles: "yes", language: "en" });
  assert.deepEqual(yes.music, { wanted: true, brief: "tense electronic, slow pulse" }); assert.equal(yes.subtitles, true);
  assert.match(adaptivePromptText(yes), /- Music: yes — an instrumental track under the narration, ducked under the voice; the user asked for: tense electronic, slow pulse/);
  assert.match(adaptivePromptText(yes), /- Subtitles: cinema — thin white lowercase subtitles burned in/);
  assert.deepEqual(adaptPrompt("x", { music: "yes" }).music, { wanted: true, brief: null }, "a bare yes: the treatment chooses the kind");
  assert.deepEqual(adaptPrompt("x", { music: "sì" }).music, { wanted: true, brief: null });
  assert.equal(adaptPrompt("x", { subtitles: "yes" }).subtitles, true); assert.equal(adaptPrompt("x", { subtitles: true }).subtitles, true);
  // Read off the request when it says so, the negative first.
  assert.deepEqual(adaptPrompt("Un video sui pirati senza musica e con i sottotitoli").music, { wanted: false, brief: null });
  assert.equal(adaptPrompt("Un video sui pirati senza musica e con i sottotitoli").subtitles, true);
  assert.deepEqual(adaptPrompt("A Short about rain with music").music, { wanted: true, brief: null });
  assert.equal(adaptPrompt("A Short about rain, no subtitles").subtitles, false);
  assert.equal(adaptPrompt("A Short about rain").music, null, "nothing said: asked");
});

test("'stupiscimi' delegates the subject: the answer is a list to pick from, never the same question again", () => {
  const it = adaptPrompt("stupiscimi tu", { duration_s: 30, format: "16:9", look: "realistic", music: "no", subtitles: "no", language: "it" });
  assert.equal(it.subject, "", "the whole delegation phrase goes, 'tu' included");
  assert.equal(it.delegated, true);
  assert.deepEqual(it.intake.missing, ["subject"], "the delegation words are not a subject");
  assert.equal(it.questions.length, 1); assert.match(it.questions[0], /Proponi 3-5 soggetti concreti/); assert.match(it.questions[0], /Non si rende nulla finché non hanno scelto/);
  assert.match(intakeText(it), /- Subject: MISSING — the user delegated it/);
  const en = adaptPrompt("Surprise me, you choose", { duration_s: 30, format: "16:9", look: "realistic", music: "no", subtitles: "no", language: "en" });
  assert.equal(en.delegated, true); assert.match(en.questions[0], /Propose 3-5 concrete, filmable, human-scale subjects/);
  const plain = adaptPrompt("Un video sui pirati", { duration_s: 30, format: "16:9", look: "realistic", music: "no", subtitles: "no", language: "it" });
  assert.equal(plain.delegated, false); assert.deepEqual(plain.questions, []);
});

/* ------------------------------------------------------------------ the whole request, the video's length, platform words (24 September) */

test("the whole request is read: what the user says at the end of a long story is not asked again", () => {
  // Detection used to stop at the first 240 characters: a story told first and "vertical, 30 seconds, animated, no
  // music, no subtitles" said last was asked all five again. The subject stays a capped label.
  const story = "Mara is a thin pastry chef with short blonde hair tied up and a lilac apron. Every morning she opens her tiny shop before dawn, "
    + "sweeps the floor, lights the old oven and waits for the first customer, an old man who always buys the same croissant and never says a word. "
    + "One day he does not come. ";
  const brief = adaptPrompt(`${story}Make it a vertical animated video of 30 seconds, no music, no subtitles.`);
  assert.ok(story.length > 240, "the answers are past the old 240-character window");
  assert.equal(brief.duration_s, 30); assert.equal(brief.format, "9:16"); assert.equal(brief.look, "animation");
  assert.deepEqual(brief.music, { wanted: false, brief: null }); assert.equal(brief.subtitles, false);
  assert.deepEqual(brief.intake.missing, ["language"], "only the narration's language, which the request does not say");
  assert.ok(brief.subject.length <= 240, "the subject is still a capped label");
  // The last sentence is how the video is made, not what it is about: it never reaches the subject.
  assert.equal(adaptPrompt("One day the old man does not come. Make it a vertical animated video of 30 seconds, no music, no subtitles.").subject, "One day the old man does not come");
});

test("the length is the VIDEO's, never the time inside the story", () => {
  // Story time: a number next to "dopo", "later", "ago", "every", "for the last"… is not the film's length (it used
  // to be: "dopo 30 secondi la bomba esplode" made a 30-second film, and priced it).
  assert.equal(adaptPrompt("Un film su una bomba: dopo 30 secondi esplode e tutti scappano").duration_s, null);
  assert.equal(adaptPrompt("The bomb goes off 30 seconds later and everybody runs").duration_s, null);
  assert.equal(adaptPrompt("A story about a man who waited for the last 20 minutes of his life").duration_s, null);
  assert.equal(adaptPrompt("Ogni 5 minuti passa un treno davanti alla casa della nonna").duration_s, null);
  assert.equal(adaptPrompt("Mio nonno è arrivato 10 minuti fa e racconta la guerra").duration_s, null);
  // The video's length, said in any of the usual ways.
  assert.equal(adaptPrompt("Un video di 30 secondi sui pirati").duration_s, 30);
  assert.equal(adaptPrompt("A 30-second video about pirates").duration_s, 30);
  assert.equal(adaptPrompt("A 2-minute animated film about a fox").duration_s, 120);
  assert.equal(adaptPrompt("Fammi un filmato lungo 45 secondi sul mare").duration_s, 45);
  assert.equal(adaptPrompt("Un cortometraggio, durata: 1 minuto, sul mare").duration_s, 60);
  assert.equal(adaptPrompt("A film about the sea, 30s, vertical").duration_s, 30);
  assert.equal(adaptPrompt("Un video di un minuto sul mare").duration_s, 60);
  assert.equal(adaptPrompt("Un video di 1 minuto e 30 secondi sul mare").duration_s, 90);
  assert.equal(adaptPrompt("Five surprising facts about octopuses in thirty seconds").duration_s, 30);
  // Bare, with no story word next to it: still the length (the tests above this block rely on it).
  assert.equal(adaptPrompt("Fammi un video sui pirati, 30 secondi").duration_s, 30);
  assert.equal(adaptPrompt("A realistic film about lighthouse keepers, 45 seconds").duration_s, 45);
  // Both in one request: the video's own length wins over the story's time, wherever each one is.
  assert.equal(adaptPrompt("Dopo 5 minuti il treno parte. Voglio un video di 40 secondi").duration_s, 40);
  // A decade is not a length.
  assert.equal(adaptPrompt("A film about my grandmother in the 30s and her radio").duration_s, null);
});

test("Shorts, reels, stories and Instagram frame the video only as platform words", () => {
  // Measured bug: "bedtime stories", "a short film", "a man in shorts" and "a video about Instagram" all made a vertical video.
  assert.equal(adaptPrompt("Bedtime stories about a dragon who is afraid of the dark").format, null);
  assert.equal(adaptPrompt("A short film about a stray dog that walked home").format, null);
  assert.equal(adaptPrompt("A man in shorts runs across the beach").format, null);
  assert.equal(adaptPrompt("A video about the history of Instagram").format, null);
  assert.equal(adaptPrompt("A reel of old film found in an attic").format, null);
  // The platform said: vertical.
  assert.equal(adaptPrompt("A YouTube Short about pirates").format, "9:16", "YouTube Shorts is vertical, not YouTube's 16:9");
  assert.equal(adaptPrompt("Make a Short about pirates").format, "9:16");
  assert.equal(adaptPrompt("Un video per gli shorts sui pirati").format, "9:16");
  assert.equal(adaptPrompt("An Instagram Reel about coffee").format, "9:16");
  assert.equal(adaptPrompt("Un video per Instagram sul caffè").format, "9:16");
  assert.equal(adaptPrompt("Something for my stories about the weekend").format, "9:16");
  assert.equal(adaptPrompt("A TikTok about coffee").format, "9:16");
  assert.equal(adaptPrompt("A film about coffee for YouTube").format, "16:9");
});

test("lookFromText names the look a request's words name, and nothing else (createJob's default)", () => {
  assert.equal(lookFromText("Un cartone animato sui pirati"), "animation");
  assert.equal(lookFromText("A documentary about the lagoon"), "realistic");
  assert.equal(lookFromText("Pirati e tesori"), null);
});

/* ------------------------------------------------------------------ decades, "da 30 secondi", the look's words (24 September, review) */

test("a decade is never the video's length: '90s fashion' asks the length instead of pricing a 90-second film", () => {
  // Measured the day the compact "30s" arrived: each of these was planned and priced at the decade's number.
  for (const p of ["A Short about 90s fashion", "a video about 80s music in Italy", "a film about 70s disco culture", "Make a video on 60s rock bands", "a YouTube video about 90s cartoons", "Un video sugli anni 80", "A documentary on the 1990s", "A video about the 80s", "90s"]) {
    const b = adaptPrompt(p);
    assert.equal(b.duration_s, null, p);
    assert.ok(b.intake.missing.includes("duration"), `${p}: the length is asked`);
  }
  // The compact form still reads a length where only a length can be.
  assert.equal(adaptPrompt("A film about the sea, 30s, vertical").duration_s, 30);
  assert.equal(adaptPrompt("a 30s clip about rain").duration_s, 30);
  assert.equal(adaptPrompt("A Short about rain. Clip: 45s").duration_s, 45);
  assert.equal(adaptPrompt("Un video sul mare, lungo 30s").duration_s, 30);
});

test("'da 30 secondi' / 'for 30 seconds' in the video's own clause is its length; the story's time still is not", () => {
  assert.equal(adaptPrompt("un video sui pirati da 30 secondi").duration_s, 30);
  assert.equal(adaptPrompt("un cortometraggio sui pirati da 2 minuti").duration_s, 120);
  assert.equal(adaptPrompt("Fammi un Short sui pirati da 45 secondi").duration_s, 45);
  assert.equal(adaptPrompt("Video per YouTube da 2 minuti sulla storia di Roma").duration_s, 120);
  assert.equal(adaptPrompt("un video sui pirati per 30 secondi").duration_s, 30);
  assert.equal(adaptPrompt("a video about pirates for 30 seconds").duration_s, 30);
  assert.equal(adaptPrompt("a video about the Titanic, for 60 seconds").duration_s, 60);
  // Story time, even with a video word in the request: "tra", a relative clause, a verb of waiting or holding.
  assert.equal(adaptPrompt("Un film su una bomba che esplode tra 30 secondi").duration_s, null);
  assert.equal(adaptPrompt("un video di un uomo che corre per 30 secondi").duration_s, null);
  assert.equal(adaptPrompt("Un video su un sub che trattiene il fiato per 30 secondi").duration_s, null);
  assert.equal(adaptPrompt("Un video sul mare. Per 30 secondi nessuno parla").duration_s, null, "another sentence: the video word does not reach it");
});

test("'Short di…' at the start and 'i miei Reels' are platform words too", () => {
  assert.equal(adaptPrompt("Short di 45 secondi sui delfini").format, "9:16");
  assert.equal(adaptPrompt("Shorts sui gatti").format, "9:16");
  assert.equal(adaptPrompt("Crea un video per i miei Reels sui gatti").format, "9:16");
  assert.equal(adaptPrompt("Un video per le nostre stories sul mare").format, "9:16");
  // Still not: a short film, clothing, a reel of film, being short of something.
  assert.equal(adaptPrompt("Short film about a dog").format, null);
  assert.equal(adaptPrompt("Short of breath, the runner stops at the top of the hill").format, null);
  assert.equal(adaptPrompt("A reel of old film found in an attic").format, null);
});

test("the look is named by words that describe the video, never by a topic noun; both looks named outright is asked", () => {
  // Measured: each of these used to become a 2D animation.
  assert.equal(lookFromText("A realistic documentary about the history of Pixar"), "realistic");
  assert.equal(lookFromText("a documentary about the Ghibli museum in Tokyo"), "realistic");
  assert.equal(lookFromText("A cinematic film about how anime took over the world"), "realistic");
  assert.equal(lookFromText("A story about a girl who rides in a horse-drawn carriage"), null);
  // A studio or "anime" as a STYLE still names animation.
  assert.equal(lookFromText("A film in the style of Pixar about a toaster"), "animation");
  assert.equal(lookFromText("Un video in stile Ghibli sul mare"), "animation");
  assert.equal(lookFromText("an anime-style short about robots"), "animation");
  assert.equal(lookFromText("A hand-drawn film about a fox"), "animation");
  assert.equal(lookFromText("An animated documentary about bees"), "animation", "an animation word beats a documentary");
  // Both named outright: neither wins, the intake asks (and createJob falls back to realistic).
  assert.equal(lookFromText("Un video realistico, tipo cartone animato"), null);
  assert.equal(adaptPrompt("Un video realistico, tipo cartone animato").look, null);
});

/* ------------------------------------------------------------------ the subject, the narration's language (25 September) */

/** What the film is about, as each request says it: the talk about the video is cut, the topic keeps its preposition. */
const SUBJECTS = [
  ["fammi un video in orizzontale, dei pirati di 15 secondi", "dei pirati"],
  ["Fammi un video sui pirati, 30 secondi", "sui pirati"],
  ["Make a 30-second vertical video about pirates", "about pirates"],
  ["Un cartone animato sui pirati, 45 secondi, verticale, senza musica", "sui pirati"],
  ["Create an animated 2-minute YouTube film about a lighthouse keeper, with music and subtitles", "about a lighthouse keeper"],
  ["Un video verticale di 30 secondi per TikTok sulle api", "sulle api"],
  ["a 30s clip about the sea", "about the sea"],
];
/** Requests whose every word is content: a story's time, a topic that sounds like a format, a decade, a soundtrack. */
const KEPT_WHOLE = ["su un uomo che aspetta per 30 secondi", "vertical farming", "90s fashion", "serie TV Lost", "history of YouTube", "soundtrack of Star Wars", "horizontal street"];

test("the subject is what the film is about: the video's length, format, look, music and subtitles are cut out of it", () => {
  for (const [request, subject] of SUBJECTS) assert.equal(adaptPrompt(request).subject, subject, request);
  const pirates = adaptPrompt("fammi un video in orizzontale, dei pirati di 15 secondi");
  assert.equal(pirates.duration_s, 15); assert.equal(pirates.format, "16:9");
  assert.equal(adaptPrompt("Create an animated 2-minute YouTube film about a lighthouse keeper, with music and subtitles").subtitles, true, "'with music and subtitles' answers both");
  for (const request of KEPT_WHOLE) assert.equal(adaptPrompt(request).subject, request, `${request}: nothing here is talk about the video`);
});

test("every content word of a request reaches the subject, and the subject says nothing the request did not", () => {
  const content = (s) => words(s).filter((w) => !STOP.has(w) && !INTAKE_VOCAB.has(w) && !/^\d+s?$/.test(w));
  for (const request of [...SUBJECTS.map(([r]) => r), ...KEPT_WHOLE]) {
    const subject = adaptPrompt(request).subject, said = new Set(words(request)), kept = new Set(words(subject));
    for (const w of content(request)) assert.ok(kept.has(w), `${request}: "${w}" is lost from the subject "${subject}"`);
    for (const w of words(subject)) assert.ok(said.has(w), `${request}: "${w}" in the subject is not the user's word`);
  }
});

test("a subject is asked when nothing but the video's own words is left; a short real one is taken", () => {
  const bare = adaptPrompt("fammi un video verticale di 30 secondi");
  assert.equal(bare.subject, ""); assert.equal(bare.intake.missing[0], "subject");
  assert.equal(bare.duration_s, 30); assert.equal(bare.format, "9:16");
  const rain = adaptPrompt("A video on rain");
  assert.equal(rain.subject, "on rain"); assert.equal(rain.intake.answered.subject.value, "on rain");
  const surprise = adaptPrompt("stupiscimi tu");
  assert.equal(surprise.subject, ""); assert.equal(surprise.delegated, true); assert.equal(surprise.intake.missing[0], "subject");
  assert.equal(subjectFrom("A video about music", null), "about music", "a topic made of a video word is still a topic");
  assert.ok(adaptPrompt("A video about music").intake.answered.subject);
});

test("lengthOf gives the seconds the intake has always read, and its span covers exactly the length's words", () => {
  const table = [
    ["Un video di 30 secondi sui pirati", 30], ["A 30-second video about pirates", 30], ["A 2-minute animated film about a fox", 120],
    ["Fammi un filmato lungo 45 secondi sul mare", 45], ["Un cortometraggio, durata: 1 minuto, sul mare", 60], ["A film about the sea, 30s, vertical", 30],
    ["Un video di 1 minuto e 30 secondi sul mare", 90], ["Five surprising facts about octopuses in thirty seconds", 30], ["Fammi un video sui pirati, 30 secondi", 30],
    ["un video sui pirati da 30 secondi", 30], ["a video about pirates for 30 seconds", 30], ["Dopo 5 minuti il treno parte. Voglio un video di 40 secondi", 40],
    ["Un film su una bomba: dopo 30 secondi esplode e tutti scappano", null], ["A Short about 90s fashion", null], ["un video di un uomo che corre per 30 secondi", null],
  ];
  for (const [p, s] of table) assert.equal(lengthOf(p)?.seconds ?? null, s, p);
  const cut = (p) => { const l = lengthOf(p); return p.slice(l.at, l.end); };
  assert.equal(cut("fammi un video in orizzontale, dei pirati di 15 secondi"), "15 secondi");
  assert.equal(cut("Make a 30-second vertical video about pirates"), "30-second");
  assert.equal(cut("a 30s clip about the sea"), "30s");
});

test("the narration's language is the user's answer: English or Italian, no preference is English, another language is asked again", () => {
  for (const a of ["en", "EN", "English", "inglese", "in English"]) assert.deepEqual(languageAnswer(a), { value: "en", defaulted: false, unsupported: null }, a);
  for (const a of ["it", "Italiano", "italian"]) assert.deepEqual(languageAnswer(a), { value: "it", defaulted: false, unsupported: null }, a);
  for (const a of ["whatever", "no preference", "you choose", "indifferente", "fai tu", "scegli tu", "non importa", "come vuoi", "qualsiasi", "è uguale"])
    assert.deepEqual(languageAnswer(a), { value: "en", defaulted: true, unsupported: null }, a);
  assert.deepEqual(languageAnswer("français"), { value: null, defaulted: false, unsupported: "français" });
  assert.equal(languageAnswer("spanish").unsupported, "spanish");
  assert.equal(languageAnswer(""), null); assert.equal(languageAnswer(undefined), null);
  // Another language: the question comes back naming the two Kleo speaks, in the chat's language.
  const fr = adaptPrompt("Un video sui pirati", { duration_s: 30, format: "16:9", look: "realistic", music: "no", subtitles: "no", language: "francese" });
  assert.equal(fr.language, null); assert.deepEqual(fr.intake.missing, ["language"]);
  assert.match(fr.questions[0], /solo in inglese o in italiano \(hai chiesto "francese"\)/);
  const any = adaptPrompt("Un video sui pirati", { duration_s: 30, format: "16:9", look: "realistic", music: "no", subtitles: "no", language: "indifferente" });
  assert.equal(any.language, "en"); assert.deepEqual(any.questions, []); assert.match(intakeText(any), /- Narration: English \(no preference: the default\)/);
});

test("the request names the narration's language only in so many words; the chat's language is never the answer", () => {
  assert.equal(languageFromRequest("A film about bees, narrated in Italian"), "it");
  assert.equal(languageFromRequest("un video sui pirati in inglese"), "en");
  assert.equal(languageFromRequest("life in Italian villages"), null);
  assert.equal(languageFromRequest("the Italian Renaissance, 30 seconds"), null);
  assert.equal(languageFromRequest("Fammi un video sui pirati, 30 secondi"), null);
  const b = adaptPrompt("Fammi un video sui pirati, 30 secondi");
  assert.equal(b.chat_language, "it"); assert.equal(b.language, null); assert.ok(b.intake.missing.includes("language"));
  assert.match(b.questions.at(-1), /^In che lingua vuoi la voce narrante: inglese o italiano\?/);
  assert.equal(adaptPrompt("un video sui pirati in inglese").subject, "sui pirati", "the language phrase is not the subject");
});

test("a language inside the story is not the narration's, and its words stay in the subject (review, 25 September)", () => {
  const story = [
    ["a documentary about an Italian voice actor, 30s vertical", "Italian voice actor"],
    ["un film sulla voce italiana di Topolino", "sulla voce italiana di Topolino"],
    ["un video su un bambino cinese che impara a parlare in italiano", "su un bambino cinese che impara a parlare in italiano"],
    ["a film about the Italian voice of Mickey Mouse", "about the Italian voice of Mickey Mouse"],
    ["a film about a boy who learns to speak in English", "about a boy who learns to speak in English"],
    ["un bambino che sogna in inglese", "un bambino che sogna in inglese"],
  ];
  for (const [request, kept] of story) {
    assert.equal(languageFromRequest(request), null, request);
    assert.ok(adaptPrompt(request).subject.includes(kept), `${request}: "${adaptPrompt(request).subject}"`);
    assert.ok(adaptPrompt(request).intake.missing.includes("language"), `${request}: the language is asked`);
  }
  // Said in so many words, it is still read.
  for (const [request, lang] of [["Un video sui pirati, voce inglese", "en"], ["Un video sui pirati con voce narrante italiana", "it"], ["A film about bees with Italian narration", "it"],
    ["un video sui pirati, in inglese", "en"], ["A film about bees, English voice-over", "en"], ["Un video sui pirati, lingua: inglese", "en"]])
    assert.equal(languageFromRequest(request), lang, request);
  assert.equal(adaptPrompt("Un video sui pirati, voce inglese").subject, "sui pirati");
});

test("a comma inside a number splits nothing, and a list of topics keeps its items (review, 25 September)", () => {
  assert.equal(adaptPrompt("a video about 1,000 soldiers at Thermopylae").subject, "about 1,000 soldiers at Thermopylae");
  assert.equal(adaptPrompt("un video su 2,5 milioni di anni fa").subject, "su 2,5 milioni di anni fa");
  assert.equal(adaptPrompt("a video about wine, food, music").subject, "about wine, food, music");
  assert.equal(adaptPrompt("un video su vino, musica, arte").subject, "su vino, musica, arte");
  assert.equal(adaptPrompt("a video about cinema, film, and art").subject, "about cinema, film, art");
  // A clause about the video still goes, list or not.
  assert.equal(adaptPrompt("Un video sui pirati, verticale").subject, "sui pirati");
  assert.equal(adaptPrompt("Un video sui pirati, 30 secondi, senza musica").subject, "sui pirati");
});

test("a video word that heads the topic stays, and a platform inside the story stays (review, 25 September)", () => {
  const heads = [
    ["Il nuovo film di Nolan spiegato in 60 secondi", "Il nuovo film di Nolan spiegato"],
    ["Animation history in 60 seconds, vertical", "Animation history"],
    ["Documentary photography tips, 30s", "Documentary photography tips"],
    ["un video su come TikTok ha cambiato la musica", "su come TikTok ha cambiato la musica"],
    ["la storia di come YouTube è nato, 30 secondi", "la storia di come YouTube è nato"],
    ["a video with tips for Instagram creators", "with tips for Instagram creators"],
    ["mistakes in YouTube history", "mistakes in YouTube history"],
    // The request's own video phrase still goes.
    ["a new video about pirates", "about pirates"],
    ["un video divertente sui gatti", "divertente sui gatti"],
    ["Un video per TikTok sui gatti", "sui gatti"],
    ["Un video sui gatti per TikTok", "sui gatti"],
    ["Un video sui gatti come un reel", "sui gatti"],
  ];
  for (const [request, subject] of heads) assert.equal(adaptPrompt(request).subject, subject, request);
  assert.ok(adaptPrompt("Film noir explained in a 60-second video").subject.startsWith("Film noir explained"));
});

test("the language answer is read for its words: no preference is English, another language is named back, anything else is asked plainly (review, 25 September)", () => {
  for (const a of ["nessuna preferenza", "per me è indifferente", "non mi importa", "fa lo stesso", "I don't mind", "either is fine", "it doesn't matter", "inglese o italiano, fai tu"])
    assert.deepEqual(languageAnswer(a), { value: "en", defaulted: true, unsupported: null }, a);
  for (const a of ["English please", "inglese, grazie", "en-US", "English narration", "in inglese per favore"])
    assert.deepEqual(languageAnswer(a), { value: "en", defaulted: false, unsupported: null }, a);
  for (const a of ["italiano grazie", "Italian narration", "it-IT"]) assert.deepEqual(languageAnswer(a), { value: "it", defaulted: false, unsupported: null }, a);
  assert.deepEqual(languageAnswer("en français"), { value: null, defaulted: false, unsupported: "en français" });
  for (const a of ["boh", "italiano o inglese?"]) assert.deepEqual(languageAnswer(a), { value: null, defaulted: false, unsupported: null }, a);
  const plain = adaptPrompt("Un video sui pirati", { duration_s: 30, format: "16:9", look: "realistic", music: "no", subtitles: "no", language: "boh" });
  assert.deepEqual(plain.intake.missing, ["language"]);
  assert.match(plain.questions[0], /^In che lingua vuoi la voce narrante: inglese o italiano\?/); assert.doesNotMatch(plain.questions[0], /hai chiesto/);
  assert.equal(adaptPrompt("Un video sui pirati", { duration_s: 30, format: "16:9", look: "realistic", music: "no", subtitles: "no", language: "nessuna preferenza" }).language, "en");
});

test("the live regression: an Italian chat asking for an English film gets an English film", () => {
  const b = adaptPrompt("fammi un video in orizzontale, dei pirati di 15 secondi", { duration_s: 15, format: "16:9", look: "animation", music: "yes", subtitles: false, language: "en" });
  assert.equal(b.language, "en"); assert.equal(b.intake.answered.language.from, "call");
  assert.equal(b.chat_language, "it"); assert.equal(b.subject, "dei pirati");
  assert.deepEqual(b.questions, []);
  assert.match(adaptivePromptText(b), /- Narration: English/);
  assert.ok(b.assumptions.some((a) => /narration in English: the user's answer/.test(a)));
});

/* ------------------------------------------------------------------ film or animatic, with the prices (25 September) */

/** The account as src/mcp.ts passes it: a paying one with 70 credits, a 15-second film at 10 credits. */
const ACCT = (over = {}) => ({ paid: true, credits: 70, filmCredits: 10, animaticCredits: 5, animaticMaxS: 60, tariff: "1 credit buys 2 seconds of film, 10 credits minimum", ...over });
const ANSWERS = { duration_s: 15, format: "16:9", look: "animation", music: "no", subtitles: "no", language: "en" };

test("with no account the product is not asked: a pure caller takes the product it passes", () => {
  const b = adaptPrompt("A film about pirates", ANSWERS);
  assert.equal(b.product, null); assert.deepEqual(b.questions, []); assert.ok(!b.intake.missing.includes("product"));
  assert.match(intakeText(b), /- Product: not asked here/);
  assert.equal(adaptPrompt("A film about pirates", { ...ANSWERS, product: "animatic" }).product, "animatic");
});

test("a paying account is asked film or animatic, with both prices, in the chat's language and in the same message", () => {
  const en = adaptPrompt("A film about pirates", { ...ANSWERS, account: ACCT() });
  assert.deepEqual(en.intake.missing, ["product"]); assert.equal(en.questions.length, 1);
  assert.match(en.questions[0], /^Film or animatic\?/); assert.match(en.questions[0], /10 credits for 15 seconds/); assert.match(en.questions[0], /5 credits flat, up to 60 seconds/);
  assert.match(en.questions[0], /You have 70 credits\.$/);
  const it = adaptPrompt("Un video sui pirati", { ...ANSWERS, account: ACCT() });
  assert.match(it.questions[0], /^Film o animatic\?/); assert.match(it.questions[0], /10 crediti per 15 secondi/); assert.match(it.questions[0], /5 crediti fissi/);
  // The length not known yet: the tariff, in the same question as the length's.
  const open = adaptPrompt("A film about pirates", { ...ANSWERS, duration_s: undefined, account: ACCT({ filmCredits: null }) });
  assert.deepEqual(open.intake.missing, ["duration", "product"]);
  assert.match(open.questions[1], /priced by its length \(1 credit buys 2 seconds of film, 10 credits minimum\)/);
  // Not enough credits for the film: said in the question.
  assert.match(adaptPrompt("A film about pirates", { ...ANSWERS, account: ACCT({ credits: 7 }) }).questions[0], /You have 7 credits, not enough for the film\./);
  // Answered: the product is the user's.
  const film = adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", account: ACCT() });
  assert.equal(film.product, "film"); assert.deepEqual(film.questions, []); assert.equal(film.intake.answered.product.from, "call");
  for (const q of [en.questions[0], it.questions[0], open.questions[1]]) assert.ok(q.includes("?"), q);
});

test("an account that never paid is offered the animatic and the way to the film: two exits, no loop", () => {
  const unpaid = ACCT({ paid: false });
  const none = adaptPrompt("A film about pirates", { ...ANSWERS, account: unpaid });
  assert.deepEqual(none.intake.missing, ["product"]);
  assert.match(none.questions[0], /credit pack/); assert.match(none.questions[0], /animatic/); assert.match(none.questions[0], /\?$/);
  const film = adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", account: unpaid });
  assert.equal(film.product, null); assert.deepEqual(film.intake.missing, ["product"], "a film is not for this account yet: asked again, with the way out");
  const anim = adaptPrompt("A film about pirates", { ...ANSWERS, duration_s: 45, product: "animatic", account: unpaid });
  assert.equal(anim.product, "animatic"); assert.deepEqual(anim.questions, []);
  const long = adaptPrompt("A film about pirates", { ...ANSWERS, duration_s: 90, product: "animatic", account: unpaid });
  assert.deepEqual(long.intake.missing, ["duration"]); assert.equal(long.duration_s, null);
  assert.match(long.questions[0], /An animatic is at most 60 seconds long \(you asked for 90\)/);
  // No product yet and a length past the animatic's: the offer says so in the same question.
  assert.match(adaptPrompt("A film about pirates", { ...ANSWERS, duration_s: 90, account: unpaid }).questions[0], /at most 60 seconds instead of 90/);
});

test("the request names the product only with the word itself; the animatic's brief never promises clips", () => {
  const said = adaptPrompt("An animatic about pirates", { ...ANSWERS, account: ACCT() });
  assert.equal(said.product, "animatic"); assert.equal(said.intake.answered.product.from, "request");
  assert.equal(said.subject, "about pirates");
  for (const p of ["A preview of a film about pirates", "Un'anteprima sui pirati", "Una bozza di video sui pirati"])
    assert.ok(adaptPrompt(p, { ...ANSWERS, account: ACCT() }).intake.missing.includes("product"), p);
  const text = adaptivePromptText(adaptPrompt("A film about pirates", { ...ANSWERS, product: "animatic", account: ACCT() }));
  assert.match(text, /- Product: animatic/); assert.match(text, /- Plan: the animatic: drawn frames with the camera moving over each one, no generated clip/);
  assert.doesNotMatch(text, /shot-by-shot real video clips/);
  assert.match(adaptivePromptText(adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", account: ACCT() })), /- Plan: shot-by-shot real video clips/);
});

/* ------------------------------------------------------------------ the AI upscale, an option that costs (25 September) */

/** A paying account the upscale is offered to: a 15-second film at 10 credits, the upscale at +10. */
const UP = (over = {}, up = { credits: 10, rule: { en: "as many credits again as the film, at least 5", it: "tanti crediti quanti ne costa il film, almeno 5" } }) => ACCT({ aiUpscale: up, ...over });

test("a film is asked about the AI upscale with its exact extra credits, in the chat's language and the same message", () => {
  const en = adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", account: UP() });
  assert.deepEqual(en.intake.missing, ["ai_upscale"]); assert.equal(en.ai_upscale, null);
  assert.equal(en.questions[0], "Do you want the AI upscale (Real-ESRGAN + RIFE: a sharper picture, +10 credits)? If not, the film comes out in classic 4K 60 fps.");
  const it = adaptPrompt("Un video sui pirati", { ...ANSWERS, product: "film", account: UP() });
  assert.equal(it.questions[0], "Vuoi l'ingrandimento AI (Real-ESRGAN + RIFE: immagine più nitida, +10 crediti)? Se no, il film esce in 4K 60 fps classico.");
  // The product still open on a paying account: asked for the film it may choose, next to the product question.
  const open = adaptPrompt("Un video sui pirati", { ...ANSWERS, account: UP() });
  assert.deepEqual(open.intake.missing, ["product", "ai_upscale"]);
  assert.match(open.questions[0], /L'ingrandimento AI facoltativo del film costa \+10 crediti\.$/, "the product question quotes it too");
  assert.equal(open.questions[1], "Se scegli il film: Vuoi l'ingrandimento AI (Real-ESRGAN + RIFE: immagine più nitida, +10 crediti)? Se no, il film esce in 4K 60 fps classico.");
  // No length yet: the rule instead of the number.
  const noLen = adaptPrompt("A film about pirates", { ...ANSWERS, duration_s: undefined, product: "film", account: UP({ filmCredits: null }, { credits: null, rule: { en: "as many credits again as the film, at least 5", it: "x" } }) });
  assert.match(noLen.questions[1], /\+as many credits again as the film, at least 5\)\?/);
});

test("the AI upscale is never asked for an animatic, of an account that cannot order a film, or when it is switched off", () => {
  assert.ok(!adaptPrompt("A film about pirates", { ...ANSWERS, product: "animatic", account: UP() }).intake.missing.includes("ai_upscale"));
  assert.equal(adaptPrompt("A film about pirates", { ...ANSWERS, product: "animatic", account: UP() }).ai_upscale, false);
  assert.ok(!adaptPrompt("An animatic about pirates", { ...ANSWERS, account: UP() }).intake.missing.includes("ai_upscale"));
  assert.deepEqual(adaptPrompt("A film about pirates", { ...ANSWERS, account: UP({ paid: false }) }).intake.missing, ["product"]);
  // KLEO_SR "off": the caller passes no aiUpscale, and nothing about it is asked or shown.
  const off = adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", account: ACCT() });
  assert.deepEqual(off.questions, []); assert.equal(off.ai_upscale, false);
  assert.doesNotMatch(intakeText(off), /AI upscale/); assert.doesNotMatch(off.questions.join(" "), /upscale/i);
});

test("a balance that pays for the film but not for film + upscale is said in the question, and a yes it cannot pay for is asked again", () => {
  // 15 credits: the film (10) yes, film + upscale (20) no.
  const q = adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", account: UP({ credits: 15 }) });
  assert.equal(q.questions[0], "Do you want the AI upscale (Real-ESRGAN + RIFE: a sharper picture, +10 credits; film + upscale come to 20 credits, not enough (you have 15))? If not, the film comes out in classic 4K 60 fps.");
  const qi = adaptPrompt("Fammi un film sui pirati", { ...ANSWERS, product: "film", account: UP({ credits: 15 }) });
  assert.equal(qi.questions[0], "Vuoi l'ingrandimento AI (Real-ESRGAN + RIFE: immagine più nitida, +10 crediti; film + ingrandimento fanno 20 crediti, non bastano (hai 15 crediti))? Se no, il film esce in 4K 60 fps classico.");
  const yes = adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", ai_upscale: "yes", account: UP({ credits: 15 }) });
  assert.equal(yes.ai_upscale, null, "not taken: the brief is not ready"); assert.deepEqual(yes.intake.missing, ["ai_upscale"]);
  assert.equal(yes.questions[0], "You chose the AI upscale, but film + upscale come to 20 credits and you have 15: not enough. Do you want the film in classic 4K 60 fps (10 credits), or buy more credits first for the upscale?");
  const no = adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", ai_upscale: "no", account: UP({ credits: 15 }) });
  assert.equal(no.ai_upscale, false); assert.deepEqual(no.questions, []);
  // Exactly enough is enough.
  const even = adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", ai_upscale: "yes", account: UP({ credits: 20 }) });
  assert.equal(even.ai_upscale, true); assert.deepEqual(even.questions, []);
  assert.doesNotMatch(adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", account: UP({ credits: 20 }) }).questions[0], /not enough/);
});

test("the answer: only a clear yes buys the upscale; no, whatever or no answer is the classic finish", () => {
  for (const y of ["yes", "Yes please", "sì", "si, grazie", "ok", "certo", "voglio provarlo", "let's try it", true]) assert.equal(aiUpscaleAnswer(y), true, String(y));
  for (const n of ["no", "No grazie", "nope", "classico", "whatever", "fai tu", "non lo so", "don't bother", "boh", false]) assert.equal(aiUpscaleAnswer(n), false, String(n));
  for (const u of [undefined, null, "", "   "]) assert.equal(aiUpscaleAnswer(u), null);
  // The label an assistant echoes, and a clear yes with a politeness tail, are still a yes.
  for (const y of ["AI upscale: yes", "Ingrandimento AI: sì", "sì!", "yes, thanks", "ok, proviamo", "Sì grazie."]) assert.equal(aiUpscaleAnswer(y), true, y);
  // A negation or "classic" ANYWHERE is a no, and a word that is not a yes on its own ("voglio", "con", "ai") buys
  // nothing (review, 25 September 2026: each of these used to read as yes and double the film's price).
  for (const n of ["AI upscale: no", "Ingrandimento AI: no", "upscale: no", "ingrandimento no", "certo che no", "ok, niente upscale",
    "va bene il 4K classico", "voglio il 4K classico", "voglio il classico", "vorrei quello normale", "con il classico", "vai col classico",
    "with the classic finish", "I want the classic one", "please no", "sì ma dopo", "yes, I don't think so",
    "ai", "upscale", "ingrandimento", "con", "with", "voglio", "vorrei", "i want", "dai", "vai", "please", "per favore"]) assert.equal(aiUpscaleAnswer(n), false, n);
  const yes = adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", ai_upscale: "sì", account: UP() });
  assert.equal(yes.ai_upscale, true); assert.deepEqual(yes.questions, []);
  assert.match(intakeText(yes), /- AI upscale: yes \(\+10 credits\) \(the user's answer\)/);
  assert.match(adaptivePromptText(yes), /- AI upscale: yes — Real-ESRGAN \+ RIFE on every shot, \+10 credits on top of the film; refunded automatically if the finish cannot apply it/);
  const no = adaptPrompt("A film about pirates", { ...ANSWERS, product: "film", ai_upscale: "whatever", account: UP() });
  assert.equal(no.ai_upscale, false); assert.deepEqual(no.questions, []);
  assert.match(adaptivePromptText(no), /- AI upscale: no — the classic 4K 60 fps finish/);
  // Without an account (a pure caller) the answer is taken as passed, and nothing is asked.
  assert.equal(adaptPrompt("A film about pirates", { ...ANSWERS, ai_upscale: "yes" }).ai_upscale, true);
  assert.deepEqual(adaptPrompt("A film about pirates", ANSWERS).questions, []);
});
