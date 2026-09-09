/**
 * End-to-end smoke test against a local `wrangler dev` (or KLEO_URL if set):
 *  DCR → PKCE authorize (invite login) → token → MCP tools/list → create_video → cron ticks → get_job → get_result → download → cancel.
 * Run: npm run test:smoke
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const PORT = process.env.SMOKE_PORT ?? "8799";
const BASE = process.env.KLEO_URL ?? `http://127.0.0.1:${PORT}`;
const INVITE = process.env.KLEO_INVITE ?? "KLEO-BETA";
const EMAIL = `smoke-${Date.now()}@example.com`;
let dev;
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const step = (m) => console.log("\x1b[36m▸\x1b[0m", m);

async function waitHealthy(ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("dev server did not become healthy");
}

async function main() {
  if (!process.env.KLEO_URL) {
    step("starting wrangler dev");
    dev = spawn("npx", ["wrangler", "dev", "--test-scheduled", "--port", PORT, "--ip", "127.0.0.1", "--var", "MOCK_TOTAL_SECONDS:12"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    dev.stdout.on("data", (d) => process.env.SMOKE_VERBOSE && process.stdout.write(d));
    dev.stderr.on("data", (d) => process.env.SMOKE_VERBOSE && process.stderr.write(d));
  }
  await waitHealthy();

  step("unauthenticated /mcp is rejected with a WWW-Authenticate challenge");
  const un = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert(un.status === 401, `expected 401, got ${un.status}`);
  assert((un.headers.get("www-authenticate") ?? "").includes("resource_metadata"), "missing resource_metadata in WWW-Authenticate");
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json().catch(() => null);
  const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert(asm.token_endpoint && asm.authorization_endpoint, "authorization server metadata missing");
  console.log("  metadata ok", prm ? "(PRM present)" : "(PRM at path variant)");

  step("dynamic client registration");
  const reg = await (await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "smoke-test", redirect_uris: ["http://localhost:9999/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json();
  assert(reg.client_id, "no client_id from /register");

  step("authorize with PKCE + invite login");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://localhost:9999/cb", scope: "video:create video:read", state: "xyz", code_challenge: challenge, code_challenge_method: "S256" });
  const page = await fetch(`${BASE}/authorize?${q}`);
  assert(page.status === 200 && (await page.text()).includes("Invite code"), "login page not rendered");
  const form = new URLSearchParams({ email: EMAIL, invite: INVITE, consent: "yes", oauth_query: q.toString() });
  const post = await fetch(`${BASE}/authorize`, { method: "POST", body: form, redirect: "manual" });
  assert(post.status === 302, `expected 302 from login, got ${post.status}: ${(await post.text()).slice(0, 200)}`);
  const loc = new URL(post.headers.get("location"));
  const code = loc.searchParams.get("code");
  assert(code && loc.searchParams.get("state") === "xyz", "no code/state in redirect");

  step("exchange code for token");
  const tok = await (await fetch(asm.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/cb", client_id: reg.client_id, code_verifier: verifier }) })).json();
  assert(tok.access_token, "no access_token: " + JSON.stringify(tok));

  step("MCP: connect and list tools");
  const client = new Client({ name: "smoke", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  console.log("  tools:", tools.join(", "));
  for (const n of ["kleo_list_templates", "kleo_create_video", "kleo_get_job", "kleo_get_result", "kleo_generate_thumbnail", "kleo_cancel_job"]) assert(tools.includes(n), `missing tool ${n}`);

  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { r, data: r.structuredContent ?? (() => { try { return JSON.parse(r.content?.[0]?.text ?? ""); } catch { return null; } })() }; };

  step("kleo_list_templates");
  const lt = await call("kleo_list_templates", {});
  assert(lt.data?.templates?.length === 10, "expected 10 templates");
  assert(lt.data.credits_available === 3, `expected 3 trial credits, got ${lt.data.credits_available}`);

  step("create_video (viral-short)");
  const cv = await call("kleo_create_video", { template: "viral-short", prompt: "Pirates find an island that is missing from every map", duration_s: 45, format: "9:16", language: "en" });
  assert(!cv.r.isError, "create_video errored: " + cv.r.content?.[0]?.text);
  const jobId = cv.data.job_id;
  assert(jobId?.startsWith("gt_"), "no job id");
  console.log("  job", jobId, "eta", cv.data.eta_min, "min");

  step("validation: bad duration is refused without charging");
  const bad = await call("kleo_create_video", { template: "viral-short", prompt: "This should fail because it is far too long for a short", duration_s: 600, format: "9:16" });
  assert(bad.r.isError, "expected an error for out-of-range duration");

  step("orchestrator ticks (cron) until the mock render finishes");
  let view;
  for (let i = 0; i < (process.env.KLEO_URL ? 60 : 40); i++) {
    if (!process.env.KLEO_URL) { const t = await fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`); assert(t.ok, "scheduled trigger failed: " + t.status); }
    await new Promise((r) => setTimeout(r, process.env.KLEO_URL ? 4000 : 1000));
    view = (await call("kleo_get_job", { job_id: jobId })).data;
    process.stdout.write(`  ${view.state} ${view.percent}% ${view.track ?? ""}\n`);
    if (view.state === "done" || view.state === "failed") break;
  }
  assert(view.state === "done", "job did not finish: " + JSON.stringify(view));

  step("get_result and download");
  const gr = await call("kleo_get_result", { job_id: jobId });
  assert(gr.data.video_url, "no video_url: " + JSON.stringify(gr.data));
  const dl = await fetch(gr.data.video_url);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert(dl.status === 200 && buf.length > 1000 && buf.subarray(4, 8).toString() === "ftyp", `download failed: ${dl.status} ${buf.length}b`);
  console.log("  video.mp4", buf.length, "bytes,", dl.headers.get("content-type"));
  const tampered = await fetch(gr.data.video_url.replace(/sig=.{6}/, "sig=000000"));
  assert(tampered.status === 403, "tampered link should be refused");

  step("second job then cancel → refund");
  const cv2 = await call("kleo_create_video", { template: "did-you-know", prompt: "Five surprising facts about octopuses in thirty seconds", duration_s: 30 });
  assert(!cv2.r.isError, "second create failed: " + cv2.r.content?.[0]?.text);
  const cj = await call("kleo_cancel_job", { job_id: cv2.data.job_id });
  assert(cj.data.state === "cancelled" && cj.data.refunded === 1, "cancel/refund failed: " + JSON.stringify(cj.data));
  const lt2 = await call("kleo_list_templates", {});
  assert(lt2.data.credits_available === 2, `expected 2 credits left, got ${lt2.data.credits_available}`);

  step("recent jobs listing");
  const list = (await call("kleo_get_job", {})).data;
  assert(list.jobs?.length === 2, "expected 2 jobs in history");

  await client.close();
  console.log("\n\x1b[32mPASS\x1b[0m all smoke checks");
}

function stopDev() { if (!dev) return; try { process.kill(-dev.pid, "SIGTERM"); } catch {} try { dev.kill("SIGTERM"); } catch {} }
main().then(() => { stopDev(); process.exit(0); }).catch((e) => { console.error("\n\x1b[31mFAIL\x1b[0m", e.message); stopDev(); process.exit(1); });
process.on("SIGTERM", () => { stopDev(); process.exit(143); });
process.on("SIGINT", () => { stopDev(); process.exit(130); });
