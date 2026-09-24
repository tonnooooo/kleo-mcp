import test from "node:test";
import assert from "node:assert/strict";
import { adaptPrompt, adaptivePromptText, intakeText, lookFromText, INTAKE, REQUIRED_INTAKE } from "../src/adaptive.ts";

test("the intake is a fixed list: six things Kleo settles every time (music and subtitles since 22 September), three it offers to ask", () => {
  assert.deepEqual(INTAKE.map((i) => i.key), ["subject", "duration", "format", "look", "music", "subtitles", "audience", "tone", "must_keep"]);
  assert.deepEqual([...REQUIRED_INTAKE], ["subject", "duration", "format", "look", "music", "subtitles"]);
  for (const i of INTAKE) { assert.ok(i.question.it.includes("?"), `${i.key}: the Italian question is a question`); assert.ok(i.question.en.includes("?"), `${i.key}: the English question is a question`); }
});

test("what the request says is read, what it does not say is asked — in the request's language, required first", () => {
  const brief = adaptPrompt("Creami un video realistico su una corsa automobilistica");
  assert.equal(brief.language, "it");
  assert.equal(brief.look, "realistic", "'realistico' names the look");
  assert.equal(brief.duration_s, null); assert.equal(brief.format, null, "nothing says where it goes: asked, not assumed 16:9");
  assert.deepEqual(brief.intake.missing, ["duration", "format", "music", "subtitles"]);
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
  const said = adaptPrompt("Create a realistic film about a night race, 2 minutes, YouTube landscape, no music, with subtitles");
  assert.equal(said.duration_s, 120); assert.equal(said.format, "16:9"); assert.equal(said.look, "realistic");
  assert.deepEqual(said.music, { wanted: false, brief: null }); assert.equal(said.subtitles, true);
  assert.deepEqual(said.questions, []); assert.deepEqual(said.intake.missing, []);
  assert.equal(said.intake.answered.duration.from, "request"); assert.equal(said.intake.answered.format.from, "request"); assert.equal(said.intake.answered.music.from, "request");
  const answered = adaptPrompt("A film about a night race", { duration_s: 120, format: "16:9", look: "animation", audience: "kids", tone: "warm", must_keep: "the number 7", music: "no", subtitles: false });
  assert.deepEqual(answered.questions, []); assert.deepEqual(answered.optional_questions, []);
  assert.equal(answered.intake.answered.look.from, "call"); assert.equal(answered.intake.answered.must_keep.value, "the number 7");
  assert.match(adaptivePromptText(answered), /Adaptive film brief ready/); assert.match(adaptivePromptText(answered), /- Must appear: the number 7/);
  assert.ok(answered.assumptions.some((value) => /no music/i.test(value)));
  assert.match(intakeText(answered), /- Look: animation \(the user's answer\)/);
});

test("the language is read from the words only one language owns: 'video' decides nothing", () => {
  assert.equal(adaptPrompt("Create a video about accuracy in medicine").language, "en");
  assert.equal(adaptPrompt("A film about a night race, 2 minutes").language, "en");
  assert.equal(adaptPrompt("Fammi un video sui pirati, 30 secondi").language, "it");
  assert.equal(adaptPrompt("Un documentario sulla laguna di Venezia").language, "it");
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
  assert.deepEqual(open.intake.missing, ["music", "subtitles"]);
  assert.equal(open.music, null); assert.equal(open.subtitles, null);
  assert.match(open.questions[0], /^Do you want music under the narration\?/); assert.match(open.questions[1], /^Do you want subtitles burned into the video/);
  assert.match(adaptivePromptText(open), /- Music: MISSING — ask/); assert.match(adaptivePromptText(open), /- Subtitles: MISSING — ask/);
  assert.match(adaptivePromptText(open), /their answers \(duration_s, format, style, music, subtitles, audience, tone, must_keep\)/);
  const no = adaptPrompt("A realistic film about a night race, 2 minutes, YouTube", { music: "No.", subtitles: "no" });
  assert.deepEqual(no.music, { wanted: false, brief: null }); assert.equal(no.subtitles, false); assert.deepEqual(no.questions, []);
  assert.match(adaptivePromptText(no), /- Music: none — narration only/); assert.match(adaptivePromptText(no), /- Subtitles: none burned in/);
  assert.match(intakeText(no), /- Music: none \(the user's answer\)/);
  const yes = adaptPrompt("A realistic film about a night race, 2 minutes, YouTube", { music: "tense electronic, slow pulse", subtitles: "yes" });
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
  const it = adaptPrompt("stupiscimi tu", { duration_s: 30, format: "16:9", look: "realistic", music: "no", subtitles: "no" });
  assert.equal(it.delegated, true);
  assert.deepEqual(it.intake.missing, ["subject"], "the delegation words are not a subject");
  assert.equal(it.questions.length, 1); assert.match(it.questions[0], /Proponi 3-5 soggetti concreti/); assert.match(it.questions[0], /Non si rende nulla finché non hanno scelto/);
  assert.match(intakeText(it), /- Subject: MISSING — the user delegated it/);
  const en = adaptPrompt("Surprise me, you choose", { duration_s: 30, format: "16:9", look: "realistic", music: "no", subtitles: "no" });
  assert.equal(en.delegated, true); assert.match(en.questions[0], /Propose 3-5 concrete, filmable, human-scale subjects/);
  const plain = adaptPrompt("Un video sui pirati", { duration_s: 30, format: "16:9", look: "realistic", music: "no", subtitles: "no" });
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
  assert.deepEqual(brief.questions, []);
  assert.ok(brief.subject.length <= 240, "the subject is still a capped label");
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
