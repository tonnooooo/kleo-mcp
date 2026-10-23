/**
 * Kleo Studio's viral templates (src/studio/trends.ts) and their provider (src/wavespeed.ts): the price WaveSpeed
 * quoted, the edit instruction for any set of filled seats, the app each template becomes, and the client's reading
 * of WaveSpeed's answers. Imports the TypeScript sources directly (Node 22.18+ strips the types).
 * Run: node --test test/studio-trends.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TRENDS, trendByKey, trendCostUsd, trendBilledSeconds, trendPrompt, trendPromptV2, trendTaskInput, trendQuality, TREND_PROMPT_V2_MAX, WAN30_EDIT_MODEL } from "../src/studio/trends.ts";
import { TOOLS, planTool, publicTools, toolByKey, toolCredits, ToolRefusal } from "../src/studio/tools.ts";
import { wavespeed, wavespeedSubmit, wavespeedTask } from "../src/wavespeed.ts";

const YTBM = "trend-you-talking-bout-me";
const photo = (id) => ({ id, url: `https://app.example/media/u/${id}?sig=x`, kind: "image", seconds: null, width: 800, height: 1000, type: "image/jpeg" });

test("price: the same as WaveSpeed's own quote for the 14 s clip (19 October 2026)", () => {
  const t = trendByKey(YTBM);
  assert.equal(trendBilledSeconds(t), 28);
  assert.equal(trendCostUsd(t, "480p"), 1.4);
  assert.equal(trendCostUsd(t, "720p"), 2.8);
  assert.equal(trendCostUsd(t, "1080p"), 5.6);
  // A clip over 15 s is billed as 15 + 15.
  assert.equal(trendBilledSeconds({ baseSeconds: 22 }), 30);
  // Credits at margin 1.6 and 0.44 $ a credit: 6 / 11 / 21.
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => toolCredits(trendCostUsd(t, q))), [6, 11, 21]);
  assert.equal(trendQuality("4k"), "720p");
});

test("every template is an app: one photo box per seat, a quality, consent, its own key", () => {
  for (const t of TRENDS) {
    const app = toolByKey(t.key);
    assert.ok(app, t.key);
    assert.equal(app.group, "trend");
    assert.equal(app.consent, true);
    assert.deepEqual(app.fields.filter((f) => f.kind === "image").map((f) => f.key), t.seats.map((s) => s.key));
    assert.ok(app.fields.some((f) => f.key === "quality"));
    assert.ok(app.preview?.endsWith("-p.mp4") && app.guide);
    for (const s of t.seats) if (s.at) assert.ok(s.at[0] > 0 && s.at[0] < 100 && s.at[1] > 0 && s.at[1] < 100, s.key);
  }
  assert.equal(new Set(TOOLS.map((x) => x.key)).size, TOOLS.length);
  const card = publicTools().find((x) => x.key === YTBM);
  assert.equal(card.from, 6);
});

test("plan: only the filled seats are swapped, in seat order, on WaveSpeed's Wan 3.0 edit with the clip's own sound", () => {
  const plan = planTool(YTBM, { quality: "480p" }, { person1: photo("up_a"), person3: photo("up_c") });
  assert.equal(plan.usd, 1.4);
  assert.equal(plan.output, "video");
  assert.equal(plan.tasks.length, 1);
  const task = plan.tasks[0];
  assert.equal(task.provider, "wavespeed");
  assert.equal(task.model, WAN30_EDIT_MODEL);
  assert.equal(task.input.video, trendByKey(YTBM).baseUrl);
  assert.deepEqual(task.input.reference_images, [photo("up_a").url, photo("up_c").url]);
  assert.equal(task.input.resolution, "480p");
  assert.equal(task.input.generate_audio, false);
  const p = task.input.prompt;
  assert.match(p, /Image 1 replaces the person in the FRONT/);
  assert.match(p, /Image 2 replaces the person FURTHEST/);
  assert.match(p, /The person in the MIDDLE[^\n]* stays exactly as in Video 1/);
  assert.match(p, /no black cap/);
  assert.match(p, /no red patterned shirt/);
  assert.doesNotMatch(p, /no grey printed T-shirt/);
  assert.match(p, /- Image 1: 0-4s leans toward the camera/);
});

test("Wings & Vibes (20 October 2026): one seat, 15 s, the prompt written for that seat, the clip's own sound", () => {
  const t = trendByKey("trend-wings-and-vibes");
  assert.ok(t && !t.prompt, "a seat-by-seat prompt, not a fixed one");
  assert.equal(t.seats.length, 1);
  assert.equal(t.baseUrl, "https://media.kleooai.com/app/templates/wings-and-vibes/base.mp4");
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => toolCredits(trendCostUsd(t, q))), [6, 11, 22], "15 + 15 billed seconds");
  const plan = planTool(t.key, { quality: "720p" }, { person1: photo("up_w") });
  assert.equal(plan.usd, 3);
  const input = plan.tasks[0].input;
  assert.deepEqual(input.reference_images, [photo("up_w").url]);
  assert.equal(input.generate_audio, false);
  assert.match(input.prompt, /one person is replaced by the person from Image 1/);
  assert.match(input.prompt, /Image 1 replaces the person sitting in the beige office chair on the RIGHT/);
  assert.match(input.prompt, /no cream over-ear headphones/);
  assert.match(input.prompt, /8-12s leans back in the chair/);
  assert.match(input.prompt, /Domino's box of chicken wings/);
  assert.throws(() => planTool(t.key, {}, {}), ToolRefusal, "a photo is needed");
});

test("Paris Fire Dance and Bby Wow (21 October 2026): one seat each, their clips on R2, their prices", () => {
  const paris = trendByKey("trend-paris-fire-dance"), bby = trendByKey("trend-bby-wow");
  assert.ok(paris && !paris.prompt, "Paris Fire Dance: written seat by seat");
  assert.equal(paris.baseUrl, "https://media.kleooai.com/app/templates/paris-fire-dance/base.mp4");
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => toolCredits(trendCostUsd(paris, q))), [6, 11, 21], "14 + 14 billed seconds");
  const p = planTool(paris.key, { quality: "480p" }, { person1: photo("up_p") }).tasks[0].input.prompt;
  assert.match(p, /Image 1 replaces the person in the CENTRE of the street/);
  assert.match(p, /no yellow rubber gloves/);
  assert.match(p, /a fire burning on the road/);
  assert.ok(bby && bby.prompt, "Bby Wow: Ausar's own fixed prompt");
  assert.equal(bby.baseUrl, "https://media.kleooai.com/app/templates/bby-wow/base.mp4");
  assert.equal(bby.preview, "https://media.kleooai.com/app/templates/bby-wow/preview3-p.mp4");
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => toolCredits(trendCostUsd(bby, q))), [4, 8, 15], "10 + 10 billed seconds");
  assert.match(bby.prompt, /Image 1/);
  assert.match(bby.prompt, /Video 1/);
  assert.doesNotMatch(bby.prompt, /@|Reference Image|source video|ausar/i, "WaveSpeed's words, nothing of Ausar's");
  const input = planTool(bby.key, { quality: "720p" }, { person1: photo("up_b") }).tasks[0].input;
  assert.equal(input.prompt, bby.prompt);
  assert.deepEqual(input.reference_images, [photo("up_b").url]);
  assert.equal(input.generate_audio, false);
});

test("Garden Dunk and Branch Chop (22 October 2026): one seat each, 15 s clips on R2, written seat by seat", () => {
  const dunk = trendByKey("trend-garden-dunk"), chop = trendByKey("trend-branch-chop");
  for (const [t, slug] of [[dunk, "garden-dunk"], [chop, "branch-chop"]]) {
    assert.ok(t && !t.prompt, `${slug}: a seat-by-seat prompt, not a fixed one`);
    assert.equal(t.seats.length, 1);
    assert.equal(t.baseUrl, `https://media.kleooai.com/app/templates/${slug}/base.mp4`);
    assert.equal(t.preview, `https://media.kleooai.com/app/templates/${slug}/preview3-p.mp4`);
    assert.equal(t.guide, `https://media.kleooai.com/app/templates/${slug}/guide.jpg`);
    assert.deepEqual(["480p", "720p", "1080p"].map((q) => toolCredits(trendCostUsd(t, q))), [6, 11, 22], "15 + 15 billed seconds");
    assert.equal(planTool(t.key, { quality: "720p" }, { person1: photo("up_g") }).usd, 3);
  }
  const d = planTool(dunk.key, { quality: "720p" }, { person1: photo("up_d") }).tasks[0].input;
  assert.deepEqual(d.reference_images, [photo("up_d").url]);
  assert.equal(d.generate_audio, false);
  assert.match(d.prompt, /Image 1 replaces the person in the CENTRE of the court/);
  assert.match(d.prompt, /no black-and-white fur/);
  assert.match(d.prompt, /11-12s slams the ball down through the hoop/);
  assert.match(d.prompt, /Knicks centre-court logo/);
  const c = planTool(chop.key, { quality: "480p" }, { person1: photo("up_c") }).tasks[0].input.prompt;
  assert.match(c, /Image 1 replaces the person on the BRANCH over the river/);
  assert.match(c, /no red Adidas polo shirt/);
  assert.match(c, /13-14s the branch snaps at 13.1s/);
  assert.match(c, /the big white splash/);
});

test("Crossover King Pt 1 and Pt 2 (23 October 2026): two seats, cut at the reel's own cut, priced as WaveSpeed quoted them", () => {
  const p1 = trendByKey("trend-crossover-king-pt1"), p2 = trendByKey("trend-crossover-king-pt2");
  for (const [t, slug, preview] of [[p1, "crossover-king-pt1", "preview3-p.mp4"], [p2, "crossover-king-pt2", "preview3-p.mp4"]]) {
    assert.ok(t && !t.prompt && t.shots?.length, `${slug}: written shot by shot`);
    assert.deepEqual(t.seats.map((s) => s.key), ["person1", "person2"]);
    for (const [field, file] of [["baseUrl", t === p2 ? "base-6s.mp4" : "base.mp4"], ["preview", preview], ["guide", "guide.jpg"]]) assert.equal(t[field], `https://media.kleooai.com/app/templates/${slug}/${file}`);
  }
  // WaveSpeed's price API, 23 October 2026: Pt 1 (5.83 s) and Pt 2 (6.0 s) both $0.60 / $1.20 / $2.40.
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => trendCostUsd(p1, q)), [0.6, 1.2, 2.4]);
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => trendCostUsd(p2, q)), [0.6, 1.2, 2.4]);
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => toolCredits(trendCostUsd(p1, q))), [3, 5, 9]);
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => toolCredits(trendCostUsd(p2, q))), [3, 5, 9]);
  const plain = trendTaskInput(p1, ["person1"], [photo("up_1").url], "720p").prompt;
  assert.match(plain, /^Edit Video 1: replace THE DUNKER with the person from Image 1\. Keep Video 1's camera/);
  assert.match(plain, /SHOTS \(Video 1 has exactly 1 shot;/);
  assert.match(plain, /- THE DEFENDER, the player guarding the player with the ball \(in Video 1: [^)]*\), stays exactly as in Video 1/);
  assert.match(plain, /THE PLACE\nExactly as in Video 1: an outdoor park basketball court: [^\n]*; night under floodlights on tall poles; /);
  // Pt 2 is one continuous shot: at 4.4 s only the speed and the grade come back (the frames hold the same framing).
  const both = trendTaskInput(p2, ["person1", "person2"], [photo("up_1").url, photo("up_2").url], "720p").prompt;
  assert.match(both, /SHOTS \(Video 1 has exactly 1 shot;/);
  assert.doesNotMatch(both, /Hard cut|cuts, /);
  assert.match(both, /slow motion about 8 times slower with a darker grade from 1\.6 to 4\.4 s, then back to normal speed and normal colour at 4\.4 s on the same framing/);
  // The end of each clip as it really is: no catch in either part.
  assert.doesNotMatch(both + plain, /catches/);
});

test("a template says how long its video is, and Crossover King Pt 2's preview is the whole clip (23 October 2026)", () => {
  for (const t of TRENDS) assert.equal(toolByKey(t.key).seconds, Math.round(t.baseSeconds), t.key);
  assert.equal(toolByKey("trend-crossover-king-pt2").seconds, 6);
  assert.equal(toolByKey("trend-crossover-king-pt1").seconds, 6);
  assert.equal(trendByKey("trend-crossover-king-pt2").preview, "https://media.kleooai.com/app/templates/crossover-king-pt2/preview3-p.mp4");
  assert.equal(publicTools().find((x) => x.key === "trend-crossover-king-pt2").seconds, 6);
});

test("template changes (23 October 2026): the court, the opponent, the crowd, the light and the boards are choices on the page", () => {
  const app = toolByKey("trend-crossover-king-pt1");
  const field = (k) => app.fields.find((f) => f.key === k);
  for (const k of ["court", "rival", "crowd", "light", "boards"]) {
    assert.equal(field(k).kind, "select");
    assert.equal(field(k).default, "original");
    assert.equal(field(k).options[0].value, "original");
  }
  assert.ok(field("court").options.some((o) => o.value === "nba"));
  assert.equal(field("court").options.at(-1).value, "custom");
  assert.deepEqual(field("courtText").when, { field: "court", is: ["custom"] });
  assert.equal(field("light").options.some((o) => o.value === "custom"), false, "no free line for the light");
  assert.equal(field("extra").kind, "text");
  // The order on the page: the photos, the changes, the free line, the quality.
  assert.deepEqual(app.fields.map((f) => f.key).slice(0, 3), ["person1", "person2", "court"]);
  assert.equal(app.fields.at(-1).key, "quality");
  // A template without changes keeps its short form.
  assert.deepEqual(toolByKey("trend-stall-grabber").fields.map((f) => f.key), ["person1", "quality"]);

  const one = { person1: photo("up_1") };
  const input = (picks, media = one) => planTool("trend-crossover-king-pt1", { quality: "720p", ...picks }, media).tasks[0].input;
  const p = input({ court: "nba", rival: "grandpa", crowd: "original", light: "golden", boards: "kleo", extra: "  make it\nrain " });
  assert.match(p.prompt, /, change THE DEFENDER as written under WHO IS WHO, and change the place around them as written under THE PLACE\./);
  assert.match(p.prompt, /- PLACE: a packed NBA arena/);
  assert.match(p.prompt, /- THE DEFENDER, the player guarding the player with the ball \(in Video 1: [^)]*\): The defender becomes a grey-haired grandpa/);
  assert.match(p.prompt, /THE DUNKER and THE DEFENDER \(in the clip 0-4\.0 s\) are changed from the first frame/, "a restyled seat is anchored too");
  assert.match(p.prompt, /- LIGHT: sunset: low warm golden light/);
  assert.doesNotMatch(p.prompt, /arena lights/, "a picked light wins over the light the place brings");
  assert.match(p.prompt, /- BOARDS: black oval boards that read "KLEO"/);
  assert.match(p.prompt, /- ALSO: make it rain\./);
  assert.doesNotMatch(p.prompt, /SPECTATORS/, "Original changes nothing, and a new place does not keep the old crowd's description");
  assert.match(p.prompt, /No new text except "KLEO" on the boards\./);
  assert.equal(p.video, trendByKey("trend-crossover-king-pt1").baseUrl);
  assert.equal(p.generate_audio, false);
  // Two photos: two runs, one person each (23 October 2026: in one run Wan 3.0 left the defender as he was and put the
  // faces on the dunker). A photo of the defender wins over the opponent choice.
  const plan2 = planTool("trend-crossover-king-pt1", { quality: "720p", rival: "robot", court: "custom", courtText: "a volcano crater. " }, { person1: photo("up_1"), person2: photo("up_2") });
  assert.equal(plan2.usd, 2.4, "two runs, twice the price");
  const [two, second] = [plan2.tasks[0].input, plan2.tasks[0].then.input];
  assert.doesNotMatch(two.prompt + second.prompt, /robot/);
  assert.match(two.prompt, /- PLACE: a volcano crater\./);
  assert.match(two.prompt, /- THE DEFENDER, the player guarding the player with the ball \(in Video 1: [^)]*\), stays exactly as in Video 1/);
  assert.deepEqual(two.reference_images, [photo("up_1").url]);
  assert.equal(two.video, trendByKey("trend-crossover-king-pt1").baseUrl);
  assert.match(second.prompt, /^Edit Video 1: replace only THE DEFENDER with the person from the reference image\. Keep everything else in Video 1 exactly as it is: THE DUNKER with his own face, the place/);
  assert.match(second.prompt, /The reference image's face never goes on him or on any spectator\./);
  assert.doesNotMatch(second.prompt, /Image 1|Image 2|PLACE/);
  assert.deepEqual(second.reference_images, [photo("up_2").url]);
  assert.equal(second.video, "{{prev}}");
  assert.equal(plan2.tasks[0].then.provider, "wavespeed");
  // One photo: one run.
  assert.equal(planTool("trend-crossover-king-pt1", { quality: "720p" }, { person1: photo("up_1") }).tasks[0].then, undefined);
  // "Your idea" with no words, or a value the page never offers, changes nothing.
  const none = input({ court: "custom", courtText: "  ", crowd: "moon" }).prompt;
  assert.doesNotMatch(none, /- PLACE:/);
  assert.match(none, /THE PLACE\nExactly as in Video 1:/);
  // The price never moves with the changes; the summary counts them.
  const plan = planTool("trend-crossover-king-pt1", { quality: "720p", court: "beach", crowd: "packed" }, one);
  assert.equal(plan.usd, 1.2);
  assert.match(plan.summary, /2 changes/);
});

// ── 23 October 2026: the first paid Crossover King Pt 2 came back wrong (the defender never swapped, the second photo's
// face on the dunker, the old court kept, daylight only at the end). The order, rebuilt with the shot-by-shot prompt.
test("the failed Crossover King order, written shot by shot: who is who first, both shots, one light, no old park", () => {
  const t = trendByKey("trend-crossover-king-pt2");
  const facts = { person1: { person: true, colour: "greyscale", hair: "brown", beard: false }, person2: { person: true, colour: "greyscale", hair: "brown", beard: true } };
  const p = trendPromptV2(t, ["person1", "person2"], { court: "street", rival: "original", crowd: "cheer", light: "day", boards: "kleo" }, facts);
  assert.ok(p.length < TREND_PROMPT_V2_MAX, `${p.length} characters`);
  assert.ok(p.startsWith("Edit Video 1: replace THE DUNKER with the person from Image 1 and THE DEFENDER with the person from Image 2, and change the place"));
  assert.ok(p.indexOf("- Image 2 = THE DEFENDER") < 900, "both seats are named in the first lines");
  assert.match(p, /His face is seen from the front in the first 1\.4 s, large at the left edge from 0\.8 to 1\.4 s/);
  assert.match(p, /When THE DEFENDER is seen from the side or from behind, show the hair, head shape, build and the back of the outfit of the person in Image 2\./);
  assert.match(p, /their face never moves to anyone else, and no spectator becomes either of them/);
  assert.match(p, /- Image 1's face goes only on THE DUNKER, Image 2's face goes only on THE DEFENDER\./);
  // Hair colour read from a black-and-white photo is a guess: only the beard tells them apart.
  assert.match(p, /To tell them apart: Image 1 has no beard; Image 2 has a beard\./);
  assert.doesNotMatch(p, /must not look alike|brown hair/);
  assert.ok(p.indexOf("SHOTS (Video 1 has exactly 1 shot;") < p.indexOf("\nTHE PLACE\n"));
  assert.match(p, /THE DUNKER and THE DEFENDER are changed from the first frame, 0\.0 s, wherever Video 1 shows them; the changes under THE PLACE hold from the first frame to the last/);
  // One light: the street brings "night", the picked daytime wins.
  assert.match(p, /- LIGHT: bright daylight/);
  assert.doesNotMatch(p, /night|street lights|floodlights on/);
  // The old park is named only as gone, never as something to keep.
  const park = p.slice(p.indexOf("\nTHE PLACE\n"));
  for (const w of ["green or red court", "light-blue pole", "mint-green backboard"]) assert.equal(park.split(w).length - 1, 1, w);
  assert.match(park, /Nothing of Video 1's park is left: no green or red court surface, no light-blue pole/);
  assert.match(p, /- SPECTATORS: a row of cheerleaders/);
  assert.match(p, /- BOARDS: black oval boards that read "KLEO"/);
  assert.match(p, /Image 1 is a black-and-white photo: give that person natural, realistic colour/);
  assert.match(p, /Image 2 is a black-and-white photo/);
  assert.match(p, /the complete outfit from their image, head to toe, in every frame of every shot/);
  for (const gone of [/exactly once per frame/, /lips move/, /room's light/, /Recreate Video 1/, /NOTHING FROM THE ORIGINAL PEOPLE/]) assert.doesNotMatch(p, gone);
});

test("shot-by-shot prompts: a picked light always wins, kept boards stay, and every pick stays under the length cap", () => {
  const t = trendByKey("trend-crossover-king-pt1");
  const place = t.changes.find((c) => c.kind === "place"), light = t.changes.find((c) => c.kind === "light");
  for (const c of [{ value: "original" }, ...place.options]) {
    for (const l of [{ value: "original" }, ...light.options]) {
      const p = trendPromptV2(t, ["person1"], { court: c.value, light: l.value });
      const lines = p.split("\n").filter((x) => x.startsWith("- LIGHT:"));
      if (c.value === "original" && l.value === "original") { assert.equal(lines.length, 0); continue; }
      assert.equal(lines.length, 1, `${c.value} + ${l.value}`);
      if (l.text) assert.ok(lines[0].includes(l.text), `${c.value} + ${l.value}: the picked light`);
      else if (c.time) assert.ok(lines[0].includes(c.time), `${c.value}: the place's own light`);
    }
  }
  // A new place with the boards left as they are keeps the boards, and does not call them gone.
  const kept = trendPromptV2(t, ["person1"], { court: "beach" });
  assert.match(kept, /Of Video 1's park only the red oval sponsor boards stay; there is no green or red court surface/);
  assert.doesNotMatch(kept, /no red boards with Chinese lettering|Nothing of Video 1's park is left/);
  // The place left Original never re-describes what another change changes (the review of 23 October 2026).
  const same = trendPromptV2(t, ["person1"], { light: "day", crowd: "empty", boards: "kleo" });
  assert.match(same, /^Edit Video 1: replace THE DUNKER with the person from Image 1, and change the light, the spectators and the boards as written under THE PLACE\./);
  assert.match(same, /- PLACE: the same place as in Video 1, an outdoor park basketball court: a green court with a red key/);
  assert.doesNotMatch(same, /night|floodlights on tall poles|young spectators|Chinese lettering|the new place/);
  const night = trendPromptV2(t, ["person1"], { crowd: "packed" });
  assert.match(night, /- LIGHT: as in Video 1, night under floodlights on tall poles\./);
  assert.match(night, /- BOARDS: as in Video 1, red oval sponsor boards with white Chinese lettering\./);
  // A place in the person's own words brings its own light: no night is forced on it, no floodlights put back.
  const own = trendPromptV2(t, ["person1"], { court: "custom", courtText: "a sunny beach in Hawaii at noon" });
  assert.doesNotMatch(own, /- LIGHT:|night/);
  // Snow keeps the park: nothing of it is called gone.
  assert.doesNotMatch(trendPromptV2(t, ["person1"], { court: "snow" }), /Nothing of Video 1's park is left/);
  // Custom words on the boards are the only new text, without quotes of their own.
  assert.match(trendPromptV2(t, ["person1"], { boards: "custom", boardsText: 'MY "SHOP"' }), /- BOARDS: boards that read "MY SHOP"\.[\s\S]*No new text except "MY SHOP" on the boards\./);
  // The longest possible picks still fit.
  const long = "x".repeat(300);
  const p = trendPromptV2(trendByKey("trend-crossover-king-pt2"), ["person1", "person2"],
    { court: "custom", courtText: long, crowd: "custom", crowdText: long, light: "neon", boards: "custom", boardsText: long, extra: long },
    { person1: { person: true, colour: "greyscale", hair: "blond", beard: true, glasses: true }, person2: { person: true, colour: "greyscale", hair: "black", beard: true, glasses: true } });
  assert.ok(p.length < TREND_PROMPT_V2_MAX, `${p.length} characters`);
});

test("every template not written shot by shot sends exactly the instruction it sent before (23 October 2026)", async () => {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  let n = 0;
  for (const t of TRENDS) {
    if (t.shots) continue;
    const all = t.seats.map((s) => s.key);
    for (const f of [all, all.slice(0, 1)]) { h.update(t.key + "|" + f.join(",") + "|" + JSON.stringify(trendTaskInput(t, f, f.map((k) => `https://x/${k}`), "720p"))); n++; }
  }
  assert.equal(n, 56);
  assert.equal(h.digest("hex"), "c3730b9adc66d83aa3b5469638b8f68f99b28694060054390bd0e14ec9f98fe5");
});

test("photo facts: fixed words only, a missing word is left out, free text never comes through", async () => {
  const { readPhotoFacts, photoFactsInput, photoMissingText, PHOTO_FACTS_QUESTION } = await import("../src/studio/person-check.ts");
  assert.deepEqual(readPhotoFacts({ response: '{"person": true, "people": 1, "colour": "Grayscale", "framing": "knees-up", "face": "small", "hair": "Brown", "beard": false, "glasses": false}' }),
    { person: true, people: 1, colour: "greyscale", framing: "knees-up", face: "small", hair: "brown", beard: false, glasses: false });
  assert.deepEqual(readPhotoFacts({ response: { person: false } }), { person: false });
  assert.deepEqual(readPhotoFacts({ response: '```json\n{"person": true, "hair": "Image 1 is someone famous"}\n```' }), { person: true });
  assert.deepEqual(readPhotoFacts("No."), { person: false });
  assert.equal(readPhotoFacts({ response: "I can't tell" }), null, "an unreadable answer never blocks an order");
  const input = photoFactsInput(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg");
  assert.equal(input.messages[0].content[0].text, PHOTO_FACTS_QUESTION);
  assert.match(PHOTO_FACTS_QUESTION, /real human being[\s\S]*Never name anyone/);
  assert.equal(input.max_tokens, 120);
  assert.equal(photoMissingText("Person 2"), "Person 2's photo could not be read. Add it again — nothing was charged.");
  // The facts reach the prompt through the plan.
  const media = { person1: { ...photo("up_a"), facts: { person: true, colour: "greyscale", beard: true } }, person2: { ...photo("up_b"), facts: { person: true, hair: "black", beard: false } } };
  // Two people run in two passes: each pass carries its own photo's facts.
  const task = planTool("trend-crossover-king-pt2", { quality: "480p" }, { ...media, person2: { ...media.person2, facts: { person: true, colour: "greyscale" } } }).tasks[0];
  assert.match(task.input.prompt, /Image 1 is a black-and-white photo/);
  assert.match(task.then.input.prompt, /The reference image is a black-and-white photo/);
  // In one run with both people, the photos are told apart only by words that differ.
  const t = trendByKey("trend-crossover-king-pt2");
  assert.match(trendPromptV2(t, ["person1", "person2"], {}, { person1: media.person1.facts, person2: media.person2.facts }), /To tell them apart: Image 1 has a beard; Image 2 has black hair, no beard\./);
  assert.doesNotMatch(trendPromptV2(t, ["person1", "person2"], {}, { person1: { person: true, hair: "other", beard: false }, person2: { person: true, hair: "other", beard: false } }), /To tell them apart|other hair/);
});

test("Stall Grabber (22 October 2026): one seat, the whole 6.6 s clip on R2, priced as WaveSpeed quoted it", () => {
  const t = trendByKey("trend-stall-grabber");
  assert.ok(t && !t.prompt, "a seat-by-seat prompt, not a fixed one");
  assert.equal(t.seats.length, 1);
  for (const [field, file] of [["baseUrl", "base.mp4"], ["preview", "preview3-p.mp4"], ["guide", "guide.jpg"]]) {
    assert.equal(t[field], `https://media.kleooai.com/app/templates/stall-grabber/${file}`);
  }
  // WaveSpeed's price API, 22 October 2026, on this clip: $0.70 / $1.40 / $2.80 (7 s in + 7 s out).
  assert.equal(trendBilledSeconds(t), 14);
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => trendCostUsd(t, q)), [0.7, 1.4, 2.8]);
  assert.deepEqual(["480p", "720p", "1080p"].map((q) => toolCredits(trendCostUsd(t, q))), [3, 6, 11]);
  const input = planTool(t.key, { quality: "720p" }, { person1: photo("up_s") }).tasks[0].input;
  assert.equal(input.video, t.baseUrl);
  assert.deepEqual(input.reference_images, [photo("up_s").url]);
  assert.equal(input.generate_audio, false);
  assert.match(input.prompt, /Image 1 replaces the person OUTSIDE the stall/);
  assert.match(input.prompt, /no cream oversized hoodie/);
  assert.match(input.prompt, /reacher-grabber/);
  assert.match(input.prompt, /lunges/);
  assert.ok(input.prompt.length < 6500, `prompt ${input.prompt.length} characters`);
});

test("plan: no photo is a refusal a person can act on; a video in a seat is refused", () => {
  assert.throws(() => planTool(YTBM, {}, {}), (e) => e instanceof ToolRefusal && /at least one person/.test(e.message));
  assert.throws(() => planTool(YTBM, {}, { person1: { ...photo("up_v"), kind: "video" } }), (e) => e instanceof ToolRefusal && /picture/.test(e.message));
  // The default quality is 720p.
  assert.equal(planTool(YTBM, {}, { person2: photo("up_b") }).usd, 2.8);
});

test("prompt: one, two or three people read naturally", () => {
  const t = trendByKey(YTBM);
  assert.match(trendPrompt(t, ["person1"]), /^Recreate Video 1 exactly, frame for frame, with a new cast: one person is replaced by the person from Image 1\./);
  assert.match(trendPrompt(t, ["person1", "person2"]), /2 people are replaced by the people from Image 1 and Image 2\./);
  assert.match(trendPrompt(t, ["person1", "person2", "person3"]), /the people from Image 1, Image 2 and Image 3\. Everything else stays identical to Video 1\./);
  assert.equal(trendTaskInput(t, ["person2"], ["u2"], "1080p").reference_images.length, 1);
});

test("wavespeed client: submit, a running and a finished prediction, an empty balance as 402", async () => {
  const real = globalThis.fetch;
  const env = { WAVESPEED_API_KEY: "k" };
  try {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), init?.method, init?.headers?.authorization]);
      if (String(url).endsWith("/api/v3/alibaba/wan-3.0/video-edit")) return new Response(JSON.stringify({ code: 200, message: "success", data: { id: "p1", status: "created" } }));
      if (String(url).includes("/predictions/p1/")) return new Response(JSON.stringify({ code: 200, data: { id: "p1", status: "processing", outputs: [] } }));
      if (String(url).includes("/predictions/p2/")) return new Response(JSON.stringify({ code: 200, data: { id: "p2", status: "completed", outputs: ["https://cdn.example/out.mp4"] } }));
      if (String(url).includes("/predictions/p3/")) return new Response(JSON.stringify({ code: 200, data: { id: "p3", status: "failed", outputs: [], error: "Content flagged as potentially sensitive. Please try different prompts or images." } }));
      return new Response(JSON.stringify({ code: 400, message: "Insufficient credits. Please top up your account to continue." }), { status: 400 });
    };
    assert.equal(await wavespeedSubmit(env, "alibaba/wan-3.0/video-edit", { prompt: "x" }), "p1");
    assert.deepEqual(calls[0], ["https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/video-edit", "POST", "Bearer k"]);
    assert.equal((await wavespeedTask(env, "p1")).status, "in_progress");
    const done = await wavespeedTask(env, "p2");
    assert.equal(done.status, "completed");
    assert.deepEqual(done.outputs, ["https://cdn.example/out.mp4"]);
    const failed = await wavespeedTask(env, "p3");
    assert.equal(failed.status, "failed");
    assert.match(String(failed.error), /flagged/);
    await assert.rejects(wavespeedSubmit(env, "x/y", {}), (e) => e.status === 402);
    await assert.rejects(wavespeed({}, "GET", "/api/v3/x"), /WAVESPEED_API_KEY is not set/);
  } finally { globalThis.fetch = real; }
});

test("imported templates: their own prompt in WaveSpeed's words, every seat needed, at most 15 s billed twice", () => {
  const imported = TRENDS.filter((t) => t.prompt);
  assert.ok(imported.length >= 20, `${imported.length}`);
  for (const t of imported) {
    // No ausar.ai cite left: "@Image1" and "@[Video 1](video_1)" are "Image 1" and "Video 1".
    assert.doesNotMatch(t.prompt, /@\[|@Image|@Video|@photo|@Bild/, t.key);
    assert.match(t.prompt, /image 1/i, t.key);
    assert.ok(t.baseSeconds > 0 && t.baseSeconds <= 15.05, t.key);
    assert.ok(trendCostUsd(t, "720p") <= 3, t.key);
    assert.ok(t.baseUrl.startsWith("https://media.kleooai.com/app/templates/"), t.key);
    const app = toolByKey(t.key);
    const photos = app.fields.filter((f) => f.kind === "image");
    assert.equal(photos.length, t.seats.length, t.key);
    assert.ok(photos.every((f) => f.required && f.hint), t.key);
  }
  // The four clips with ausar.ai's own mascot are not in the catalog.
  for (const slug of ["burning-bridges-trend", "doja-trend", "pop-star-trend", "rain-dance"]) assert.equal(trendByKey(`trend-${slug}`), null);
  assert.equal(TRENDS.filter((t) => t.key === YTBM).length, 1);
});

test("imported template plan: refused until every seat has its photo, then the fixed prompt with the photos in order", () => {
  const t = trendByKey("trend-apt");
  assert.ok(t);
  assert.throws(() => planTool(t.key, {}, { person1: photo("up_a") }), (e) => e instanceof ToolRefusal && /each of the 2 people/.test(e.message));
  const plan = planTool(t.key, { quality: "480p" }, { person1: photo("up_a"), person2: photo("up_b") });
  assert.equal(plan.tasks[0].input.prompt, t.prompt);
  assert.deepEqual(plan.tasks[0].input.reference_images, [photo("up_a").url, photo("up_b").url]);
  assert.equal(plan.usd, trendCostUsd(t, "480p"));
  const one = TRENDS.find((x) => x.prompt && x.seats.length === 1);
  assert.throws(() => planTool(one.key, {}, {}), (e) => e instanceof ToolRefusal && /Add your photo/.test(e.message));
});

test("the Templates page is served by the app, not the website's 404", async () => {
  const { APP_PATH } = await import("../src/studio/site.ts");
  assert.ok(APP_PATH.test("/templates"));
  assert.ok(APP_PATH.test("/apps/trend-apt"));
  assert.ok(!APP_PATH.test("/templates/x"));
});

test("plan: a photo too small or too big for Wan 3.0 is refused before any charge", () => {
  const tiny = { ...photo("up_t"), width: 200, height: 180 };
  assert.throws(() => planTool(YTBM, {}, { person1: tiny }), (e) => e instanceof ToolRefusal && /too small \(180 pixels\)/.test(e.message));
  const huge = { ...photo("up_h"), width: 8064, height: 6048 };
  assert.throws(() => planTool(YTBM, {}, { person1: huge }), (e) => e instanceof ToolRefusal && /too big \(8064 pixels\)/.test(e.message));
  // Unknown sizes are let through (the page measures every picture it uploads).
  assert.equal(planTool(YTBM, { quality: "480p" }, { person1: { ...photo("up_u"), width: null, height: null } }).usd, 1.4);
});

test("wavespeed upload: a ticket, then the bytes PUT to the ticket's address with its headers, answering download_url", async () => {
  const real = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method, headers: init?.headers, size: init?.body?.byteLength ?? null, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (String(url).endsWith("/api/v3/media/uploads")) return new Response(JSON.stringify({ code: 200, data: { download_url: "https://cdn.example/m/up_a.jpg", upload: { method: "PUT", url: "https://store.example/signed", headers: { "Content-Type": "image/jpeg", "If-None-Match": "*" } } } }));
      if (String(url) === "https://store.example/signed") return new Response("", { status: 200 });
      return new Response("no", { status: 500 });
    };
    const { wavespeedUpload } = await import("../src/wavespeed.ts");
    const url = await wavespeedUpload({ WAVESPEED_API_KEY: "k" }, new Uint8Array(1234), "up_a.jpg", "image/jpeg");
    assert.equal(url, "https://cdn.example/m/up_a.jpg");
    assert.deepEqual(calls[0].body, { filename: "up_a.jpg", size: 1234, content_type: "image/jpeg" });
    assert.equal(calls[0].headers.authorization, "Bearer k");
    assert.equal(calls[1].method, "PUT");
    assert.equal(calls[1].size, 1234);
    assert.equal(calls[1].headers.authorization, undefined);
    assert.equal(calls[1].headers["If-None-Match"], "*");
  } finally { globalThis.fetch = real; }
});

// ── 22 October 2026: a template swaps PEOPLE; a photo with no person is refused before any charge ─────────────────────
import { readPersonAnswer, personCheckInput, noPersonText, PERSON_CHECK_MODEL } from "../src/studio/person-check.ts";

test("the person check reads the vision model's answer, and only a clear no counts as no", () => {
  assert.equal(readPersonAnswer({ response: '{"person": true}' }), true);
  assert.equal(readPersonAnswer({ response: '```json\n{"person": false}\n```' }), false);
  assert.equal(readPersonAnswer({ response: { person: false } }), false);
  assert.equal(readPersonAnswer("No."), false);
  assert.equal(readPersonAnswer("Yes, a man in a white tee"), true);
  assert.equal(readPersonAnswer({ response: "I can't tell" }), null, "an unreadable answer never blocks an order");
  assert.equal(readPersonAnswer(undefined), null);
  const input = personCheckInput(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpg");
  const parts = input.messages[0].content;
  assert.match(parts[0].text, /real human being/);
  assert.equal(parts[1].image_url.url, "data:image/jpeg;base64,/9j/4A==");
  assert.equal(input.max_tokens, 20);
  assert.match(PERSON_CHECK_MODEL, /^@cf\//);
  assert.equal(noPersonText("Bby Wow", "Person 1"), "Bby Wow swaps people: Person 1 needs a clear photo of a real person. Cartoon characters, toys, animals and objects can't be swapped in — nothing was charged.");
});
