/**
 * Kleo pictures on the worker side, without any rendering: runs worker/test_kleo_worker_images.py (python unittest;
 * a local http.server plays the Kleo API and the signed /dl route) so `node --test test/` covers the worker too.
 * Asserts there: pictures land in <project>/img/<sceneId>.<ext>, scene.image is set, kleo_style / image_prompt are
 * stripped, a failed download leaves the scene without picture, the images call retries once on 5xx and stops on 4xx,
 * and the written project.json passes the engine's contract.validate().
 * Run: node --test test/worker-images.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("worker downloads the pictures into <project>/img and sets scene.image (python unittest, no rendering)", () => {
  const r = spawnSync("python3", [join(ROOT, "worker", "test_kleo_worker_images.py"), "-v"], { encoding: "utf8", timeout: 180_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  assert.equal(r.status, 0, out);
  assert.match(out, /^OK$/m, out);
  const ran = /^Ran (\d+) tests?/m.exec(out);
  assert.ok(ran && Number(ran[1]) >= 15, "expected the full python suite to run: " + out);
  console.log(out.split("\n").filter((l) => /^test_|^Ran |^OK$/.test(l)).map((l) => "  " + l).join("\n"));
});
