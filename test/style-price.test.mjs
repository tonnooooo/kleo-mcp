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

test("length still sets the base price, and the style multiplies it", () => {
  // The three lengths the pricing has always had, at the cheapest style.
  assert.equal(creditsFor(45, "cartoon"), 1, "a Short");
  assert.equal(creditsFor(300, "cartoon"), 3, "up to five minutes");
  assert.equal(creditsFor(480, "cartoon"), 6, "and one more credit per extra minute");
  // No style named: the caller is quoted the base price, which is what an unstyled request has always cost.
  assert.equal(creditsFor(45), 1);
  assert.equal(creditsFor(480), 6);
});

test("an unpriced style is charged the DEAREST price, never the cheapest", () => {
  const dearest = Math.max(...Object.values(STYLE_CREDITS));
  assert.equal(creditsFor(45, "a-style-nobody-priced"), dearest,
    "forgetting a price must cost the user a loud complaint, not cost the owner a silent bill");
});

test("the free tier is counted in films and computed from the price: one film in production, whatever it costs", () => {
  // FREE_CREDITS stayed at 2 (two 1-credit Shorts) after the reset of 13 September made the 7-credit film the only
  // product, so a new account was invited to "start free" and could render nothing. The fix is the unit: the
  // config says FILMS, the code turns them into credits at the price it charges, and there is no second number.
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(!/"FREE_CREDITS"/.test(cfg), "FREE_CREDITS is gone from the config: a credit count would drift from the price again");
  const films = Number(/"FREE_FILMS":\s*"(\d+)"/.exec(cfg)?.[1]);
  assert.equal(films, 1, "production gives one free film: not zero (a dead trial), not two (twice the GPU per stranger)");
  assert.equal(freeCreditsFor({ FREE_FILMS: String(films) }), filmCredits(90), "and the credits handed out are exactly that film's price");
  assert.equal(freeCreditsFor({}), filmCredits(90), "a missing value means one film, never the old two credits");
  assert.equal(freeCreditsFor({ FREE_FILMS: "0" }), 0, "0 switches the trial off");
  assert.ok(freeCreditsFor({ FREE_FILMS: String(films) }) < filmCredits(300), "and never a long film");
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

test("a style that needs the dear card is also priced above the free credits", () => {
  // The two tables are one decision seen twice. A style that rents a $0.90/h card while costing 1 credit is a
  // machine bought with the owner's money and sold for a seventh of it — to an account that got its credits free.
  const FREE = 2;
  for (const [style, m] of Object.entries(STYLE_MACHINE)) {
    if (!isVideoStyle(style)) continue;
    assert.ok(creditsFor(45, style) > FREE,
      `${style} rents a ${m.minVramGb} GB card at up to $${m.maxDph}/h but a free account can still afford it`);
    assert.ok(STYLE_CREDITS[style] > 1, `${style} needs the dear machine and is still priced as if it did not`);
  }
});

test("the video profile is real, and an unknown style gets the ordinary one", () => {
  assert.ok(VIDEO.minVramGb >= 32, "24 GB was measured failing on Wan 2.2: the floor is not negotiable downwards");
  assert.equal(machineFor("a-style-nobody-declared").minVramGb, 16, "renting nothing at all would take the service down");
  assert.equal(isVideoStyle("a-style-nobody-declared"), false);
});
