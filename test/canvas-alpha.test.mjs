/**
 * The canvas hands back its FIRST 2D context forever; a later getContext('2d', {alpha:true}) returns the same
 * opaque one. film.js used to create an opaque context at load and then ask init() for alpha when the project
 * declared backdrop "video": the request was silently ignored and every filmed film came out as graphics on black
 * (13 September). This test reads film.js and insists the only getContext call is the one in init(), with the alpha
 * tied to the backdrop. Run: node --test test/canvas-alpha.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "keou", "engine", "film.js"), "utf8");

test("the film canvas gets exactly one 2D context, inside init, transparent when a video track is underneath", () => {
  const calls = [...src.matchAll(/getContext\('2d'[^)]*\)/g)].map((m) => m[0]);
  assert.equal(calls.length, 1, `one getContext on the film canvas, found ${calls.length}: ${calls.join(" | ")}`);
  assert.match(calls[0], /alpha:\s*config\s*&&\s*config\.backdrop\s*===\s*'video'/, "alpha must follow the project's backdrop");
  const initAt = src.indexOf("window.init=");
  assert.ok(initAt > 0 && src.indexOf(calls[0]) > initAt, "the context must be made in init(), after the project is known");
});
