/**
 * Worker contract test, no GPU: local server with RENDER_BACKEND=manual, a real job created through MCP,
 * then the worker image runs in podman against it (fetch job → progress → render with ffmpeg → upload → done).
 * Checks the downloaded MP4 is real and has the requested geometry. Run: node test/worker-e2e.mjs
 */
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const PORT = "8798", BASE = `http://127.0.0.1:${PORT}`, IMAGE = process.env.KLEO_IMAGE ?? "localhost/kleo-worker:latest";
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const step = (m) => console.log("\x1b[36m▸\x1b[0m", m);
let dev;
const stopDev = () => { if (!dev) return; try { process.kill(-dev.pid, "SIGTERM"); } catch {} };

async function main() {
  step("wrangler dev (manual backend, no R2 needed but present)");
  dev = spawn("npx", ["wrangler", "dev", "--port", PORT, "--ip", "127.0.0.1", "--var", "RENDER_BACKEND:manual"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
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
  const job = await call("create_video", { template: "did-you-know", prompt: "Three facts about octopuses", duration_s: 20, format: "9:16" });
  assert(job.job_id, "no job");
  // the manual backend marks it "starting" on the next tick (any MCP POST triggers one)
  await call("get_job", { job_id: job.job_id });

  step("read the per-job worker secret from local D1");
  const out = execSync(`npx wrangler d1 execute kleo-db --local --json --command "SELECT worker_secret, state FROM jobs WHERE id='${job.job_id}'"`, { encoding: "utf8" });
  const row = JSON.parse(out.slice(out.indexOf("[")))[0].results[0];
  assert(row.worker_secret?.startsWith("wk_"), "no worker secret: " + out.slice(0, 200));
  console.log("  job", job.job_id, "state", row.state);

  step(`run the worker container (${IMAGE}) against the local server`);
  const t0 = Date.now();
  const log = execSync(`podman run --rm --network=host -e KLEO_API=${BASE} -e KLEO_JOB_ID=${job.job_id} -e KLEO_SECRET=${row.worker_secret} -e KLEO_SELF_DESTRUCT_MIN=30 ${IMAGE} 2>&1`, { encoding: "utf8", timeout: 600000 });
  console.log(log.split("\n").filter(Boolean).map((l) => "  │ " + l).join("\n"));
  console.log(`  worker finished in ${Math.round((Date.now() - t0) / 1000)} s`);

  step("job is done and the file is a real MP4 with the requested geometry");
  const view = await call("get_job", { job_id: job.job_id });
  assert(view.state === "done", "job not done: " + JSON.stringify(view));
  const res = await call("get_result", { job_id: job.job_id });
  assert(res.video_url && res.subtitles_url && res.thumbnail_url, "missing links: " + JSON.stringify(res));
  const buf = Buffer.from(await (await fetch(res.video_url)).arrayBuffer());
  fs.writeFileSync("/tmp/claude-1000/e2e.mp4", buf);
  const probe = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration -of csv=p=0 /tmp/claude-1000/e2e.mp4`, { encoding: "utf8" }).trim();
  console.log("  video.mp4", buf.length, "bytes ·", probe);
  const [w, h, fps, dur] = probe.split(",");
  assert(w === "2160" && h === "3840", "unexpected geometry " + probe);
  assert(fps === "60/1", "expected 60 fps, got " + fps);
  assert(Math.abs(parseFloat(dur) - 20) < 1, "expected ~20 s, got " + dur);
  await client.close();
  console.log("\n\x1b[32mPASS\x1b[0m worker contract end to end");
}
main().then(() => { stopDev(); process.exit(0); }).catch((e) => { console.error("\n\x1b[31mFAIL\x1b[0m", e.message); stopDev(); process.exit(1); });
process.on("SIGTERM", () => { stopDev(); process.exit(143); });
