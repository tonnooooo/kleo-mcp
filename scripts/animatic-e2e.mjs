/**
 * The proof of the two products on PRODUCTION, over HTTP only (nothing renders here): a brand-new anonymous account
 * (7 free credits, never paid) asks for a FILM and is refused in words; asks for the ANIMATIC and gets it rendered on
 * a rented pictures card, then the links. No Vast sweep, no D1: other people's jobs are not touched.
 *   KLEO_URL=https://mcp.kleooai.com node scripts/animatic-e2e.mjs
 * Env: PROMPT, DURATION (15-60), FORMAT (16:9|9:16), LANGUAGE (en|it), STYLE (realistic|animation), MAX_MIN (default 40).
 */
import crypto from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE = process.env.KLEO_URL ?? "https://mcp.kleooai.com";
const MAX_MIN = parseInt(process.env.MAX_MIN ?? "40", 10);
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const step = (m) => console.log("\x1b[36m▸\x1b[0m", m);
const now = () => new Date().toISOString().slice(11, 19) + "Z";

async function main() {
  step("oauth: register → authorize (one button) → token");
  const reg = await (await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "animatic-e2e", redirect_uris: ["http://localhost:9999/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) })).json();
  const verifier = b64url(crypto.randomBytes(32)), challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://localhost:9999/cb", scope: "video:create video:read", state: "s", code_challenge: challenge, code_challenge_method: "S256" });
  const post = await fetch(`${BASE}/authorize`, { method: "POST", body: new URLSearchParams({ oauth_query: q.toString() }), redirect: "manual" });
  const loc = post.headers.get("location");
  assert(loc, `authorize did not redirect (${post.status}): ${(await post.text()).slice(0, 300)}`);
  const code = new URL(loc).searchParams.get("code");
  const tok = await (await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/cb", client_id: reg.client_id, code_verifier: verifier }) })).json();
  assert(tok.access_token, "no token");
  const client = new Client({ name: "animatic-e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { data: r.structuredContent ?? null, text: (r.content ?? []).map((c) => c.text ?? "").join("\n"), isError: !!r.isError }; };

  step("kleo_account: a fresh account, never paid");
  const acc = await call("kleo_account", {});
  console.log("  ", JSON.stringify({ credits: acc.data.credits_available, has_paid: acc.data.has_paid, can_order_film: acc.data.can_order_film, products: acc.data.products }));
  assert(acc.data.has_paid === false && acc.data.can_order_film === false, "a new account must not be able to order a film");

  const spec = { prompt: process.env.PROMPT ?? "Una corsa automobilistica tra due sfidanti: una macchina rossa contro una macchina blu, ruota a ruota fino all'ultima curva su un circuito costiero all'alba.",
    duration_s: parseInt(process.env.DURATION ?? "20", 10), format: process.env.FORMAT ?? "16:9", language: process.env.LANGUAGE ?? "it", style: process.env.STYLE ?? "animation" };

  step("kleo_create_video as a FILM → refused in words, nothing charged");
  const film = await call("kleo_create_video", { ...spec, product: "film" });
  console.log("  ", film.isError ? "refused:" : "ACCEPTED?!", film.text.slice(0, 400));
  // With the 7 free credits the courtesy check speaks first (10 needed); with more credits the paid rule does. Either
  // way the film is refused, nothing is charged, and the animatic is the way out named.
  assert(film.isError && /bought a credit pack|Not enough credits/.test(film.text) && /product: "animatic"/.test(film.text) && /Nothing was charged/.test(film.text), "the film must be refused with the animatic as the way out");
  const after = await call("kleo_account", {});
  assert(after.data.credits_available === acc.data.credits_available, "the refusal charged nothing");

  step("kleo_create_video as the ANIMATIC → queued");
  const anim = await call("kleo_create_video", { ...spec, product: "animatic" });
  console.log("  ", anim.text.slice(0, 500));
  assert(!anim.isError, "the animatic was refused: " + anim.text);
  const jobId = anim.data.job_id;
  assert(jobId && anim.data.credits === 5 && anim.data.product === "animatic", `unexpected: ${JSON.stringify(anim.data)}`);
  console.log(`  job ${jobId} · ${anim.data.credits} credits · eta ${anim.data.eta_min} min · ${now()}`);

  step("kleo_wait_for_video until the links");
  const t0 = Date.now(); let last = "";
  while (Date.now() - t0 < MAX_MIN * 60_000) {
    const w = await call("kleo_wait_for_video", { job_id: jobId, max_wait_s: 45 }); // under the SDK's own 60 s request timeout: at 60 the client timed out on itself (19 September)
    const line = w.text.split("\n")[0].slice(0, 160);
    if (line !== last) { console.log(`  ${now()} ${line}`); last = line; }
    // The state, never the words: the "still rendering" sentence itself says "as soon as it is ready", and a text
    // match on it ended the proof after one poll on 20 September 2026 with the job still queued.
    if (w.data?.state === "done") { console.log(w.text); return; }
    if (w.data?.state === "failed" || w.data?.state === "cancelled" || /could not be rendered|was cancelled/.test(w.text)) { console.log(w.text); throw new Error("the animatic did not finish"); }
  }
  throw new Error(`still not done after ${MAX_MIN} min`);
}
main().catch((e) => { console.error("\x1b[31m✗\x1b[0m", e.message); process.exit(1); });
