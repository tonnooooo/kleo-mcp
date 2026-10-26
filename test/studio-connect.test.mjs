/**
 * The /connect page in studio-web/app.js (security review, 26 October 2026). A /connect link carries the tokens that,
 * posted by a signed-in browser to /api/connect, join an assistant (and the anonymous account behind it) to that
 * account. Anyone can send such a link, so opening one must never post it on its own: the page says what will happen to
 * the signed-in account and waits for a click.
 * Covers: nothing reaches /api/connect before the person's yes, a no forgets the link and posts nothing, and the
 * question names the account, has a way out and posts nothing itself.
 * Run: node --test test/studio-connect.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "studio-web", "app.js"), "utf8");
const view = app.slice(app.indexOf("async function connectView("), app.indexOf("function confirmConnect("));
const question = app.slice(app.indexOf("function confirmConnect("), app.indexOf("function requireAccount("));

test("a /connect link is posted only after the signed-in person says yes", () => {
  assert.ok(view.length > 0 && question.length > 0, "connectView and confirmConnect are where this test looks");
  const post = view.indexOf('api("/api/connect"');
  const yes = view.search(/if \(!\(await confirmConnect\(pend\)\)\) \{ store\.set\("connect", null\); S\.connecting = false; go\("\/"\); return; \}/);
  assert.ok(post > 0, "connectView still posts the link");
  assert.ok(yes > 0 && yes < post, "the question comes first, and a no forgets the link and posts nothing");
  assert.ok(view.indexOf("if (!S.me)") < yes, "signed out, the sign-in comes before the question");
  assert.equal(app.split('"/api/connect"').length - 1, 1, "connectView is the only place that posts it");
});

test("the question names the account, has a way out, and posts nothing itself", () => {
  assert.match(question, /S\.me\.email/);
  assert.match(question, /onclick: \(\) => done\(true\) \}, "Connect"/);
  assert.match(question, /onclick: \(\) => done\(false\) \}, "Not now"/);
  assert.doesNotMatch(question, /\bapi\(/);
  assert.doesNotMatch(question, /\b(?:window\.)?(?:alert|confirm|prompt)\(/, "no browser pop-ups");
});
