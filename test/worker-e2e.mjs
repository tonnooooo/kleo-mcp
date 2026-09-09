/**
 * Worker contract test, no GPU: local server with RENDER_BACKEND=manual, a real job created through MCP,
 * then the worker image runs in podman (host network) against it: fetch job → progress → render → upload → done.
 *
 * Two engines:
 *   REAL KEOU ENGINE (default):   node test/worker-e2e.mjs
 *       image localhost/kleo-worker:keou (override with KLEO_IMAGE). The storyboard of
 *       worker/keou/examples/short-relay-cinema (minus id/script_file/music_quiet) is injected into the local D1
 *       row, rendered in 9:16 at KLEO_WIDTH_PORTRAIT=1080 to keep it short (~40 s of video, 60 fps, Kokoro voice,
 *       whisper captions, KLEO_KEOU_WORKERS=4 Chromium workers so an 8-core laptop is not starved; override with
 *       KLEO_KEOU_WORKERS). Asserts: job done, MP4 1080 wide / 60 fps / AAC audio / > 20 s, SRT ≥ 5 cues, JPEG thumbnail.
 *   PLACEHOLDER (ffmpeg only):    KLEO_ENGINE=placeholder KLEO_IMAGE=localhost/kleo-worker:latest node test/worker-e2e.mjs
 *       no storyboard needed; asserts the old geometry contract (2160x3840, 60 fps, ~20 s).
 * KLEO_MOUNT_WORKER=1 bind-mounts the repo's worker/kleo_worker.py over /opt/kleo/kleo_worker.py in the container
 * (test worker changes without rebuilding the image). SMOKE_VERBOSE=1 streams the wrangler dev output.
 */
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const ENGINE = (process.env.KLEO_ENGINE ?? "keou").toLowerCase();
const KEOU = ENGINE === "keou";
const PORT = "8798", BASE = `http://127.0.0.1:${PORT}`;
const IMAGE = process.env.KLEO_IMAGE ?? (KEOU ? "localhost/kleo-worker:keou" : "localhost/kleo-worker:latest");
const WIDTH = process.env.KLEO_WIDTH_PORTRAIT ?? "1080";
const WORKERS = process.env.KLEO_KEOU_WORKERS ?? "4";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EXAMPLE = path.join(ROOT, "worker/keou/examples/short-relay-cinema/project.json");
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const step = (m) => console.log("\x1b[36m▸\x1b[0m", m);
const sql = (s) => s.replace(/'/g, "''");
let dev;
const stopDev = () => { if (!dev) return; try { process.kill(-dev.pid, "SIGTERM"); } catch {} };
const d1 = (args) => execSync(`npx wrangler d1 execute kleo-db --local --json ${args}`, { encoding: "utf8", cwd: ROOT });
const d1rows = (out) => JSON.parse(out.slice(out.indexOf("[")))[0].results;

async function main() {
  assert(["keou", "placeholder"].includes(ENGINE), `KLEO_ENGINE must be keou or placeholder, got ${ENGINE}`);
  try { execSync(`podman image exists ${IMAGE}`); } catch { throw new Error(`podman image ${IMAGE} not found (build it first, or set KLEO_IMAGE)`); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kleo-e2e-"));

  step("wrangler dev (manual backend, no R2 needed but present)");
  dev = spawn("npx", ["wrangler", "dev", "--port", PORT, "--ip", "127.0.0.1", "--var", "RENDER_BACKEND:manual"], { stdio: ["ignore", "pipe", "pipe"], detached: true, cwd: ROOT });
  dev.stdout.on("data", (d) => process.env.SMOKE_VERBOSE && process.stdout.write(d));
  dev.stderr.on("data", (d) => process.env.SMOKE_VERBOSE && process.stderr.write(d));
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

  step("oauth: register → authorize → token");
  const reg = await (await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "worker-e2e", redirect_uris: ["http://localhost:9999/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) })).json();
  const verifier = b64url(crypto.randomBytes(32)), challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://localhost:9999/cb", scope: "video:create video:read", state: "s", code_challenge: challenge, code_challenge_method: "S256" });
  const post = await fetch(`${BASE}/authorize`, { method: "POST", body: new URLSearchParams({ email: `e2e-${Date.now()}@example.com`, invite: "KLEO-BETA", consent: "yes", oauth_query: q.toString() }), redirect: "manual" });
  const code = new URL(post.headers.get("location")).searchParams.get("code");
  const tok = await (await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/cb", client_id: reg.client_id, code_verifier: verifier }) })).json();
  assert(tok.access_token, "no token");

  step("create_video via MCP");
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const job = await call("kleo_create_video", { template: "did-you-know", prompt: "Your car key never left the house. Your car did.", duration_s: 20, format: "9:16" });
  assert(job.job_id, "no job");
  // the manual backend marks it "starting" on the next tick (any MCP POST triggers one)
  await call("kleo_get_job", { job_id: job.job_id });

  step("read the per-job worker secret from local D1");
  const row = d1rows(d1(`--command "SELECT worker_secret, state FROM jobs WHERE id='${job.job_id}'"`))[0];
  assert(row.worker_secret?.startsWith("wk_"), "no worker secret: " + JSON.stringify(row));
  console.log("  job", job.job_id, "state", row.state);

  if (KEOU) {
    step("inject the short-relay-cinema storyboard into the local D1 row");
    const project = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
    for (const k of ["id", "script_file", "music_quiet"]) delete project[k];
    project.format = "9:16";
    project.scenes = project.scenes.filter((s) => s.kind !== "image");
    const sqlFile = path.join(tmp, "storyboard.sql");
    fs.writeFileSync(sqlFile, `UPDATE jobs SET storyboard = '${sql(JSON.stringify(project))}' WHERE id = '${job.job_id}';\n`);
    d1(`--file "${sqlFile}"`);
    const spec = await (await fetch(`${BASE}/internal/jobs/${job.job_id}`, { headers: { authorization: `Bearer ${row.worker_secret}` } })).json();
    assert(Array.isArray(spec.storyboard?.scenes) && spec.storyboard.scenes.length === project.scenes.length,
      "GET /internal/jobs/:id does not return the injected storyboard (server-side storyboard support missing?): " + JSON.stringify(spec).slice(0, 300));
    console.log("  storyboard:", project.scenes.length, "scenes, brand", JSON.stringify(spec.brand ?? null));
  }

  step(`run the worker container (${IMAGE}, engine ${ENGINE}) against the local server`);
  const t0 = Date.now();
  const envs = [`KLEO_API=${BASE}`, `KLEO_JOB_ID=${job.job_id}`, `KLEO_SECRET=${row.worker_secret}`, "KLEO_SELF_DESTRUCT_MIN=45", `KLEO_ENGINE=${ENGINE}`,
    ...(KEOU ? [`KLEO_WIDTH_PORTRAIT=${WIDTH}`, `KLEO_KEOU_WORKERS=${WORKERS}`, "KLEO_RENDER_TIMEOUT_MIN=40"] : [])].map((e) => `-e ${e}`).join(" ");
  let log;
  try {
    const mount = process.env.KLEO_MOUNT_WORKER ? `-v "${path.join(ROOT, "worker/kleo_worker.py")}:/opt/kleo/kleo_worker.py:ro"` : "";
    log = execSync(`podman run --rm --network=host ${mount} ${envs} ${IMAGE} 2>&1`, { encoding: "utf8", timeout: KEOU ? 45 * 60_000 : 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    log = String(e.stdout ?? "") + String(e.stderr ?? "");
    console.log(log.split("\n").filter(Boolean).slice(-80).map((l) => "  │ " + l).join("\n"));
    throw new Error(`podman run exited with ${e.status ?? e.signal ?? "error"}`);
  }
  console.log(log.split("\n").filter(Boolean).map((l) => "  │ " + l).join("\n"));
  console.log(`  worker finished in ${Math.round((Date.now() - t0) / 1000)} s`);

  step("job is done and the files are real");
  const view = await call("kleo_get_job", { job_id: job.job_id });
  assert(view.state === "done", "job not done: " + JSON.stringify(view));
  const res = await call("kleo_get_result", { job_id: job.job_id });
  assert(res.video_url && res.subtitles_url && res.thumbnail_url, "missing links: " + JSON.stringify(res));
  const mp4 = path.join(tmp, "e2e.mp4");
  const buf = Buffer.from(await (await fetch(res.video_url)).arrayBuffer());
  fs.writeFileSync(mp4, buf);
  const probe = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration -of csv=p=0 "${mp4}"`, { encoding: "utf8" }).trim();
  console.log("  video.mp4", buf.length, "bytes ·", probe);
  const [w, h, fps, dur] = probe.split(",");
  assert(fps === "60/1", "expected 60 fps, got " + fps);

  if (KEOU) {
    assert(w === WIDTH && h === String(Number(WIDTH) * 16 / 9), `unexpected geometry ${probe} (expected ${WIDTH}x${Number(WIDTH) * 16 / 9})`);
    assert(parseFloat(dur) > 20, "expected > 20 s of video, got " + dur);
    const audio = execSync(`ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,channels,sample_rate -of csv=p=0 "${mp4}"`, { encoding: "utf8" }).trim();
    console.log("  audio:", audio);
    assert(audio.startsWith("aac"), "expected an AAC audio stream, got " + JSON.stringify(audio));
    const srt = await (await fetch(res.subtitles_url)).text();
    const cues = srt.split(/\r?\n\r?\n/).filter((c) => /-->/.test(c));
    console.log("  subtitles.srt:", cues.length, "cues, first:", JSON.stringify(cues[0]?.split("\n").slice(-1)[0] ?? ""));
    assert(cues.length >= 5, "expected ≥ 5 caption cues, got " + cues.length);
    const jpg = Buffer.from(await (await fetch(res.thumbnail_url)).arrayBuffer());
    console.log("  thumbnail.jpg:", jpg.length, "bytes");
    assert(jpg.length > 1000 && jpg[0] === 0xff && jpg[1] === 0xd8 && jpg[2] === 0xff, "thumbnail is not a JPEG");
    fs.writeFileSync(path.join(tmp, "thumbnail.jpg"), jpg);
    fs.writeFileSync(path.join(tmp, "subtitles.srt"), srt);
  } else {
    assert(w === "2160" && h === "3840", "unexpected geometry " + probe);
    assert(Math.abs(parseFloat(dur) - 20) < 1, "expected ~20 s, got " + dur);
  }
  await client.close();
  console.log(`  outputs kept in ${tmp}`);
  console.log(`\n\x1b[32mPASS\x1b[0m worker contract end to end (${ENGINE})`);
}
main().then(() => { stopDev(); process.exit(0); }).catch((e) => { console.error("\n\x1b[31mFAIL\x1b[0m", e.message); stopDev(); process.exit(1); });
process.on("SIGTERM", () => { stopDev(); process.exit(143); });
