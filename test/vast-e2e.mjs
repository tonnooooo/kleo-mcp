/**
 * REAL GPU test on Vast.ai (costs a few cents). Needs: a local `wrangler dev` on 127.0.0.1:8797 started with
 * RENDER_BACKEND=vast, VAST_API_KEY in .dev.vars, PUBLIC_URL=<public tunnel to that port>, VAST_IMAGE (public image),
 * VAST_BOOTSTRAP_URL (raw worker script). Creates one 20 s job, follows it, verifies the MP4, then sweeps
 * any instance labelled kleo-* that is still alive. Run: node test/vast-e2e.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE = process.env.KLEO_URL ?? "http://127.0.0.1:8797";
const MAX_MIN = parseInt(process.env.MAX_MIN ?? "25", 10);
const KEY = fs.readFileSync(".secrets.local", "utf8").match(/^VAST_API_KEY=(.+)$/m)?.[1]?.trim();
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const step = (m) => console.log("\x1b[36m▸\x1b[0m", m);
const vast = async (method, path, body) => {
  const r = await fetch(`https://console.vast.ai/api/v0${path}`, { method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
};
async function sweep(tag) {
  const { data } = await vast("GET", "/instances/?owner=me");
  const alive = (data.instances ?? []).filter((i) => (i.label ?? "").startsWith("kleo-"));
  console.log(`  [${tag}] Vast instances labelled kleo-*: ${alive.length}`);
  for (const i of alive) { const d = await vast("DELETE", `/instances/${i.id}/`); console.log(`  destroyed ${i.id} (${i.label}, ${i.actual_status}) → ${d.status}`); }
}
let client, jobId;
async function main() {
  assert(KEY && KEY.length === 64, "VAST_API_KEY not found in .secrets.local");
  const health = await (await fetch(`${BASE}/health`)).json();
  assert(health.backend === "vast", `local server is not in vast mode: ${JSON.stringify(health)}`);
  await sweep("before");

  step("oauth: register → authorize → token");
  const reg = await (await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "vast-e2e", redirect_uris: ["http://localhost:9999/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) })).json();
  const verifier = b64url(crypto.randomBytes(32)), challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://localhost:9999/cb", scope: "video:create video:read", state: "s", code_challenge: challenge, code_challenge_method: "S256" });
  const post = await fetch(`${BASE}/authorize`, { method: "POST", body: new URLSearchParams({ email: `vast-${Date.now()}@example.com`, invite: "KLEO-BETA", consent: "yes", oauth_query: q.toString() }), redirect: "manual" });
  const code = new URL(post.headers.get("location")).searchParams.get("code");
  const tok = await (await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/cb", client_id: reg.client_id, code_verifier: verifier }) })).json();
  assert(tok.access_token, "no token");
  client = new Client({ name: "vast-e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); };

  step("create_video → the orchestrator rents a GPU on the next tick");
  const job = await call("kleo_create_video", { template: "did-you-know", prompt: "Three surprising facts about octopuses, fast and cheerful", duration_s: 20, format: "9:16" });
  jobId = job.job_id; assert(jobId, "no job id");
  console.log("  job", jobId);

  const t0 = Date.now(); let view, lastLine = "";
  const audit = () => { try { const out = execSync(`npx wrangler d1 execute kleo-db --local --json --command "SELECT at,event,detail FROM audit WHERE job_id='${jobId}' ORDER BY id"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); return JSON.parse(out.slice(out.indexOf("[")))[0].results; } catch { return []; } };
  let seen = 0;
  while ((Date.now() - t0) / 60000 < MAX_MIN) {
    view = await call("kleo_get_job", { job_id: jobId });
    const line = `${view.state} ${view.percent}% ${view.track ?? ""}`;
    if (line !== lastLine) { console.log(`  ${Math.round((Date.now() - t0) / 1000)}s  ${line}`); lastLine = line; }
    const rows = audit(); for (const r of rows.slice(seen)) console.log(`     · ${r.at.slice(11, 19)} ${r.event} ${(r.detail ?? "").slice(0, 160)}`); seen = rows.length;
    if (view.state === "done" || view.state === "failed" || view.state === "cancelled") break;
    await new Promise((r) => setTimeout(r, 15000));
  }
  assert(view.state === "done", `job ended as ${view.state}: ${view.error ?? ""}`);

  step("download + verify");
  const res = await call("kleo_get_result", { job_id: jobId });
  const buf = Buffer.from(await (await fetch(res.video_url)).arrayBuffer());
  fs.writeFileSync("/tmp/claude-1000/vast-e2e.mp4", buf);
  const probe = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration -of csv=p=0 /tmp/claude-1000/vast-e2e.mp4`, { encoding: "utf8" }).trim();
  console.log("  video.mp4", buf.length, "bytes ·", probe, "· total", Math.round((Date.now() - t0) / 6000) / 10, "min");
  const [w, h, fps] = probe.split(",");
  assert(w === "2160" && h === "3840" && fps === "60/1", "unexpected geometry " + probe);
  console.log("\n\x1b[32mPASS\x1b[0m real GPU render on Vast.ai");
}
main().catch(async (e) => {
  console.error("\n\x1b[31mFAIL\x1b[0m", e.message);
  if (client && jobId) { try { const r = await client.callTool({ name: "kleo_cancel_job", arguments: { job_id: jobId } }); console.log("  cancelled:", r.content?.[0]?.text); } catch {} }
  process.exitCode = 1;
}).finally(async () => { await sweep("after"); try { await client?.close(); } catch {} process.exit(); });
