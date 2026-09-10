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
import { STYLE_CREDITS, creditsFor } from "../src/templates.ts";
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

test("two free credits cannot reach a style that costs more than a picture", () => {
  // The whole point of pricing by style: FREE_CREDITS is 2, so anything above 2 credits is out of reach of a brand
  // new account by construction — the same guard that already keeps long videos out of the free tier.
  const FREE = 2;
  for (const [style, price] of Object.entries(STYLE_CREDITS)) {
    if (price === 1) continue;
    assert.ok(creditsFor(45, style) > FREE,
      `${style} costs ${price} per Short, which a free account can still afford: the free tier would pay for it`);
  }
});
