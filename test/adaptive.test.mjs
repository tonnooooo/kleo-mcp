import test from "node:test";
import assert from "node:assert/strict";
import { adaptPrompt, adaptivePromptText, intakeText, INTAKE, REQUIRED_INTAKE } from "../src/adaptive.ts";

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
