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
import { STYLE_CREDITS, STYLE_MACHINE, VIDEO, creditsFor, filmCredits, freeCreditsFor, machineFor, isVideoStyle } from "../src/templates.ts";
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

test("a film is never sold under its cost: the tariff returns at least 1.6x what kie.ai and the GPU take", () => {
  // Measured 13 September 2026: fifteen MiniMax H3 shots at their 4 s minimum for a 30 s Short = 3.90 $ of clips,
  // ~0.13 $ a second, plus ~0.10-0.30 $ of a 16 GB card. The cheapest credit is the 40 EUR pack: 0.40 EUR ≈ 0.43 $.
  const COST_USD_PER_S = 0.13, GPU_USD = 0.30, CHEAPEST_CREDIT_USD = 0.43;
  for (const s of [15, 20, 30, 45, 60, 90, 120, 300]) {
    const income = creditsFor(s, "realistic") * CHEAPEST_CREDIT_USD, cost = s * COST_USD_PER_S + GPU_USD;
    assert.ok(income >= 1.6 * cost, `${s} s: sold for ${income.toFixed(2)} $, costs ${cost.toFixed(2)} $`);
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
  assert.equal(creditsFor(45, "a-style-nobody-priced"), dearest,
    "forgetting a price must cost the user a loud complaint, not cost the owner a silent bill");
});

test("the free tier is off in production (14 September): a new account starts at zero, and a value > 0 would give whole films", () => {
  // FREE_CREDITS stayed at 2 (two 1-credit Shorts) after the reset of 13 September made the 7-credit film the only
  // product, so a new account was invited to "start free" and could render nothing. The fix is the unit: the
  // config says FILMS, the code turns them into credits at the price it charges, and there is no second number.
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(!/"FREE_CREDITS"/.test(cfg), "FREE_CREDITS is gone from the config: a credit count would drift from the price again");
  const films = Number(/"FREE_FILMS":\s*"(\d+)"/.exec(cfg)?.[1]);
  assert.equal(films, 0, "production gives NO free film: a film costs 2-4 $ of kie.ai clips and the owner decided it is paid from the first one");
  assert.equal(freeCreditsFor({ FREE_FILMS: String(films) }), 0);
  assert.equal(freeCreditsFor({}), 0, "a missing value means none, not the old one film");
  assert.equal(freeCreditsFor({ FREE_FILMS: "1" }), filmCredits(20), "a value > 0 gives whole films at the shortest film's price");
  assert.ok(freeCreditsFor({ FREE_FILMS: "1" }) < filmCredits(30), "and never a 30-second Short");
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
