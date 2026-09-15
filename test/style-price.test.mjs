/**
 * The price list may not fall behind the styles.
 *
 * A style costs what its GPU minutes cost, and those differ by an order of magnitude between drawing a picture and
 * generating motion. The danger is not a wrong number: it is a MISSING one — somebody adds a style, nobody prices
 * it, and Kleo quietly sells the most expensive thing it can make for the price of the cheapest. This file is the
 * thing that has to fail on that day, in the same commit that adds the style.
 *
 * Run: node --test test/style-price.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STYLE_CREDITS, STYLE_MACHINE, VIDEO, creditsFor, creditsForProduct, filmCredits, freeCreditsFor, machineFor, isVideoStyle, filmedStoryboard, filmedJob, finishForProduct, BARE_LAYER, tariffSentence, MIN_FILM_CREDITS, ANIMATIC_CREDITS, ANIMATIC_MAX_S, animaticEtaFor } from "../src/templates.ts";
import { KLEO_STYLES } from "../src/keou-contract.ts";

test("every style Kleo can render has a declared price", () => {
  const unpriced = KLEO_STYLES.filter((s) => !(s in STYLE_CREDITS));
  assert.deepEqual(unpriced, [],
    `these styles have no entry in STYLE_CREDITS (src/templates.ts): ${unpriced.join(", ")}. ` +
    "Add one in this same commit — what a style costs on a GPU is part of adding it, not a later chore.");
});

test("the price list carries no style that does not exist", () => {
  const ghosts = Object.keys(STYLE_CREDITS).filter((s) => !KLEO_STYLES.includes(s));
  assert.deepEqual(ghosts, [], `priced but unrenderable: ${ghosts.join(", ")}`);
});

test("a price is a whole number of credits, and at least one", () => {
  for (const [style, price] of Object.entries(STYLE_CREDITS)) {
    assert.ok(Number.isInteger(price) && price >= 1, `${style} is priced ${price}; a credit cannot be split`);
  }
});

test("the price is length alone: one credit per two seconds, ten at least (14 September)", () => {
  assert.equal(creditsFor(15, "realistic"), 10, "the floor: the shortest film is the 5 EUR pack");
  assert.equal(creditsFor(20, "realistic"), 10);
  assert.equal(creditsFor(30, "realistic"), 15, "a 30-second Short");
  assert.equal(creditsFor(31, "realistic"), 16, "an odd second rounds up, never down");
  assert.equal(creditsFor(60, "realistic"), 30);
  assert.equal(creditsFor(90, "realistic"), 45);
  assert.equal(creditsFor(300, "realistic"), 150, "five minutes");
});

test("a film is never sold under its cost: the tariff returns at least 1.4x what kie.ai and the GPU take, on the cheapest credit", () => {
  // Measured 13 September 2026: fifteen MiniMax H3 shots at their 4 s minimum for a 30 s Short = 3.90 $ of clips,
  // ~0.13 $ a second, plus ~0.10-0.30 $ of a 16 GB card. The cheapest credit is the 40 EUR pack: 0.40 EUR ≈ 0.43 $.
  const COST_USD_PER_S = 0.13, GPU_USD = 0.30, CHEAPEST_CREDIT_USD = 0.43;
  for (const s of [15, 20, 30, 45, 60, 90, 120, 300]) {
    const income = creditsFor(s, "realistic") * CHEAPEST_CREDIT_USD, cost = s * COST_USD_PER_S + GPU_USD;
    assert.ok(income >= 1.4 * cost, `${s} s: sold for ${income.toFixed(2)} $, costs ${cost.toFixed(2)} $`);
  }
});

test("every look is charged as a film, none below it", () => {
  // The three lengths the pricing has always had, at the cheapest style.
  assert.equal(creditsFor(45, "cartoon"), 23, "a picture Short costs what the film costs: the 1-credit Short was the loophole");
  assert.equal(creditsFor(300, "cartoon"), 150);
  assert.equal(creditsFor(480, "cartoon"), 240);
  // No style named: the caller is quoted the base price, which is what an unstyled request has always cost.
  assert.equal(creditsFor(45), 23);
  assert.equal(creditsFor(480), 240);
});

test("an unpriced style is charged the DEAREST price, never the cheapest", () => {
  const dearest = Math.max(...Object.values(STYLE_CREDITS));
  assert.equal(creditsFor(45, "a-style-nobody-priced"), creditsFor(45, "realistic") * dearest / STYLE_CREDITS.realistic,
    "forgetting a price must cost the user a loud complaint, not cost the owner a silent bill");
  assert.equal(creditsFor(45, "a-style-nobody-priced"), 23, "which today is the film's own price");
});

test("the sign-up gift is a fixed 7 credits, below the shortest film on purpose; with the 5 EUR pack it is a 30 s Short", () => {
  // 14 September: the owner keeps the free tier (0 EUR, one button) but a kie.ai film must never be free. So the
  // gift is a credit count again, and the test pins the two facts that make it work: it cannot buy the 10-credit
  // film by itself, and together with the smallest pack (5 EUR = 10 credits, src/stripe.ts) it buys a 30 s Short.
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(!/"FREE_FILMS"/.test(cfg), "FREE_FILMS is gone: it tied the gift to the film's price, the one thing it must not be");
  const gift = Number(/"FREE_CREDITS":\s*"(\d+)"/.exec(cfg)?.[1]);
  assert.equal(gift, 7, "production gives 7 credits");
  assert.equal(freeCreditsFor({ FREE_CREDITS: String(gift) }), gift);
  assert.equal(freeCreditsFor({}), 0, "a missing value means no gift");
  assert.ok(gift < MIN_FILM_CREDITS, "the gift alone never buys a film");
  const SMALLEST_PACK = 10;
  assert.ok(gift + SMALLEST_PACK >= filmCredits(30), "gift + 5 EUR pack = a 30-second Short");
  assert.ok(gift + SMALLEST_PACK < filmCredits(40), "and not more than that");
});

test("the animatic (15 September): 5 credits flat, under the gift and under the shortest film; drawn, never filmed; its price sits in one function", () => {
  // The owner's rule: kie.ai clips are bought with his money, so the film is for paying accounts and the free
  // credits have to buy SOMETHING — the animatic, the same storyboard drawn. Two facts pinned: the gift covers one,
  // and an animatic never costs more than the shortest film, at any length or look.
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const gift = Number(/"FREE_CREDITS":\s*"(\d+)"/.exec(cfg)?.[1]);
  assert.ok(ANIMATIC_CREDITS <= gift, "the sign-up gift pays for an animatic");
  assert.ok(ANIMATIC_CREDITS < MIN_FILM_CREDITS, "and an animatic is cheaper than the shortest film");
  for (const s of [15, 30, 45, ANIMATIC_MAX_S]) for (const look of ["realistic", "animation"]) {
    assert.equal(creditsForProduct(s, look, "animatic"), ANIMATIC_CREDITS, `flat at ${s} s in ${look}`);
    assert.equal(creditsForProduct(s, look, "film"), creditsFor(s, look), "the film keeps the tariff");
    assert.equal(creditsForProduct(s, look, undefined), creditsFor(s, look), "no product means film, as on every row before this day");
  }
  assert.equal(ANIMATIC_MAX_S, 60, "a preview, not a five-minute film drawn on the cheap");
  assert.match(tariffSentence(), /animatic[^.]*costs 5 credits flat/, "the one tariff sentence names it");
  // filmed or drawn: the look, the engine style and the product — the third term is what this day added
  assert.equal(filmedStoryboard("realistic", "picture", "film"), true);
  assert.equal(filmedStoryboard("realistic", "picture", undefined), true);
  assert.equal(filmedStoryboard("animation", "picture", "animatic"), false, "an animatic is never filmed");
  assert.equal(filmedStoryboard("cartoon", "picture", "film"), false, "a picture look is not filmed either way");
  assert.equal(filmedJob({ params: JSON.stringify({ style: "realistic" }) }), true);
  assert.equal(filmedJob({ params: JSON.stringify({ style: "realistic", product: "animatic" }) }), false, "so it takes the pictures card and no video-GPU slot");
  assert.equal(filmedJob({ params: "not json" }), false);
  // the last touch: no music bed, and a layer that draws nothing when the storyboard has none
  const a = finishForProduct({ music: "bed" }, "animatic");
  assert.equal(a.music, "none");
  assert.deepEqual(a.graphics, { ...BARE_LAYER, hud: [] });
  const kept = finishForProduct({ music: "bed", graphics: { accent: "#ffb347", subtitles: "cinema", chapters: "none", hud: [] } }, "animatic");
  assert.equal(kept.graphics.subtitles, "cinema", "a real layer stays the film's own");
  assert.deepEqual(finishForProduct({ music: "bed" }, "film"), { music: "bed" }, "a film is left alone");
  assert.ok(animaticEtaFor(60) >= 8 && animaticEtaFor(60) <= 15, "an animatic is minutes, not the film's twenty");
});

/* ------------------------------------------------------------------ what a style needs of a machine */

test("every style Kleo can render declares the machine it needs", () => {
  const undeclared = KLEO_STYLES.filter((s) => !(s in STYLE_MACHINE));
  assert.deepEqual(undeclared, [],
    `these styles have no entry in STYLE_MACHINE (src/templates.ts): ${undeclared.join(", ")}. ` +
    "A style whose machine nobody declared is rented a card that may not be able to run it — and the failure comes " +
    "AFTER the rental and the 15 GB image pull have been paid for.");
});

test("the machine list carries no style that does not exist", () => {
  const ghosts = Object.keys(STYLE_MACHINE).filter((s) => !KLEO_STYLES.includes(s));
  assert.deepEqual(ghosts, [], `given a machine but unrenderable: ${ghosts.join(", ")}`);
});

test("no profile asks for a card older than Ampere, whatever its memory", () => {
  // A Tesla V100 has 32 GB and rents for pennies, and is several times slower on diffusion work: compute capability
  // is the other half of the floor, and a profile that forgets it buys the wrong card cheaply.
  for (const [style, m] of Object.entries(STYLE_MACHINE)) {
    assert.ok(m.minComputeCap >= 800, `${style} accepts compute ${m.minComputeCap / 100}; 8.0 is the floor`);
    assert.ok(m.minVramGb >= 16 && m.maxDph > 0, `${style} has an impossible profile`);
  }
});

test("no look is priced under the film, whatever machine it rents", () => {
  // The two tables are one decision seen twice. A style that rents a dear card while costing less than the film is
  // a machine bought with the owner's money and sold under cost. Since 14 September every look is the film's price.
  for (const [style, m] of Object.entries(STYLE_MACHINE)) {
    assert.equal(creditsFor(45, style), creditsFor(45, "realistic"),
      `${style} rents a ${m.minVramGb} GB card at up to $${m.maxDph}/h and is priced differently from the film`);
    assert.equal(STYLE_CREDITS[style], 1, `${style}: the multipliers are retired, length is the price`);
  }
});

test("the video profile is real, and an unknown style gets the ordinary one", () => {
  assert.ok(VIDEO.minVramGb >= 32, "24 GB was measured failing on Wan 2.2: the floor is not negotiable downwards");
  assert.equal(machineFor("a-style-nobody-declared").minVramGb, 16, "renting nothing at all would take the service down");
  assert.equal(isVideoStyle("a-style-nobody-declared"), false);
});
