/**
 * THE FIDELITY BENCH, shared plumbing (24 September 2026).
 *
 * The bench runs Kleo's own planner and stills engine (src/*.ts, imported directly: Node 24 strips the types) on this
 * machine, against the REAL Workers AI models, through the REST API instead of the Worker's `env.AI` binding. This file
 * is the bridge: a REST client (JSON calls, multipart calls, binary answers), an `env` shim that looks to src/ like the
 * Worker's environment (AI.run, an in-memory R2), a ledger that counts every call and what it cost, and the small
 * helpers every step shares (arguments, the cases, the output folders, JSON out of a chatty answer).
 *
 * Nothing here spends money by itself; every call a step makes goes through `runJson`/`runMultipart`, and the ledger
 * prices it from the Workers AI price list (developers.cloudflare.com/workers-ai/platform/pricing, read 24 September
 * 2026). The token comes from the wrangler OAuth session (the same account the deployed worker uses) or from
 * CLOUDFLARE_API_TOKEN; it is never printed.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";

export const BENCH_DIR = import.meta.dirname;
export const REPO_DIR = resolve(BENCH_DIR, "..", "..");
export const OUT_DIR = resolve(BENCH_DIR, "out");
/** The "Plural Juice" Cloudflare account (see memory: wrangler needs this account id). */
export const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "e4a5a1308df5b44c65497b85210c6845";

/* ------------------------------------------------------------------ the token */

let cachedToken = null;
/**
 * The API token: CLOUDFLARE_API_TOKEN when set, otherwise wrangler's OAuth token from its config file. On Windows
 * wrangler keeps it under %APPDATA%\xdg.config\.wrangler; on Linux/macOS under ~/.config/.wrangler or ~/.wrangler.
 * The OAuth token expires after about an hour: `npx wrangler whoami` refreshes it.
 */
export function apiToken() {
  if (cachedToken) return cachedToken;
  if (process.env.CLOUDFLARE_API_TOKEN) return (cachedToken = process.env.CLOUDFLARE_API_TOKEN);
  const candidates = [
    process.env.APPDATA && join(process.env.APPDATA, "xdg.config", ".wrangler", "config", "default.toml"),
    process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, ".wrangler", "config", "default.toml"),
    join(homedir(), ".config", ".wrangler", "config", "default.toml"),
    join(homedir(), ".wrangler", "config", "default.toml"),
  ].filter(Boolean);
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    const m = /^oauth_token\s*=\s*"([^"]+)"/m.exec(readFileSync(f, "utf8"));
    if (m) return (cachedToken = m[1]);
  }
  throw new Error("no Cloudflare token: set CLOUDFLARE_API_TOKEN or log in with `npx wrangler login` (then `npx wrangler whoami` refreshes it)");
}

/* ------------------------------------------------------------------ prices and the ledger */

/**
 * USD, Workers AI price list as read on 24 September 2026. Text models per million tokens; FLUX.2 klein per megapixel
 * of output (the first MP dearer) plus every input image's megapixels; SDXL-lightning is not on the list (beta, free).
 */
export const PRICES = {
  "@cf/moonshotai/kimi-k2.6": { in: 0.95, out: 4.0 },
  "@cf/google/gemma-4-26b-a4b-it": { in: 0.1, out: 0.3 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { in: 0.27, out: 0.85 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
  "@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
  "@cf/openai/gpt-oss-20b": { in: 0.2, out: 0.3 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { in: 0.051, out: 0.335 },
};
export const IMAGE_PRICES = {
  "@cf/black-forest-labs/flux-2-klein-9b": { firstMp: 0.015, nextMp: 0.002, inputMp: 0.002 },
  "@cf/bytedance/stable-diffusion-xl-lightning": { perImage: 0 },
};

/** Every call of this process: model, kind, status, ms, tokens, estimated dollars, and the tag the step set. */
export const ledger = [];
let ledgerTag = "";
const tagStore = new AsyncLocalStorage();
/** The label the next calls are filed under (a case id, "judge:<case>"…), so a step can sum its own cost. */
export function setTag(tag) { ledgerTag = tag; }
/** Runs fn with every call inside it filed under tag, even when several cases run at once. */
export const withTag = (tag, fn) => tagStore.run(tag, fn);
const currentTag = () => tagStore.getStore() ?? ledgerTag;

function textCost(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  return ((Number(usage.prompt_tokens) || 0) * p.in + (Number(usage.completion_tokens) || 0) * p.out) / 1e6;
}
function imageCost(model, fields) {
  const p = IMAGE_PRICES[model];
  if (!p) return 0;
  if (p.perImage !== undefined) return p.perImage;
  const w = Number(fields?.width) || 1024, h = Number(fields?.height) || 1024;
  const mp = (w * h) / 1e6;
  const inputs = Number(fields?.inputMp) || 0;
  return p.firstMp + Math.max(0, mp - 1) * p.nextMp + inputs * p.inputMp;
}
/** Sum of the ledger, optionally for one tag prefix. */
export function ledgerSum(prefix = "") {
  const rows = ledger.filter((r) => r.tag.startsWith(prefix));
  const by = {};
  for (const r of rows) {
    const b = (by[r.model] ??= { calls: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, usd: 0, ms: 0 });
    b.calls++; if (!r.ok) b.errors++;
    b.prompt_tokens += r.prompt_tokens; b.completion_tokens += r.completion_tokens; b.usd += r.usd; b.ms += r.ms;
  }
  return { calls: rows.length, errors: rows.filter((r) => !r.ok).length, usd: rows.reduce((s, r) => s + r.usd, 0), by_model: by };
}

/* ------------------------------------------------------------------ the REST client */

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (model) => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${model}`;

/** An error carrying the HTTP status in its message, the way src/storyboard.ts isTransientAiError() reads Workers AI's. */
export class AiRestError extends Error {
  constructor(model, status, detail) { super(`workers ai ${status} (${model}): ${detail}`); this.status = status; this.model = model; }
}

/**
 * One POST to /ai/run/<model>, with up to `retries` retries on 429/5xx and network failures (Workers AI answers "capacity"
 * errors under load; a bench that gives up on the first one measures the weather, not Kleo). Returns what the binding
 * would return: the `result` object of a JSON answer, or the bytes of a binary (image) answer.
 */
async function post(model, init, meta, { timeoutMs = 180_000, retries = 2 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    const row = { tag: currentTag(), model, kind: meta.kind, ok: false, status: 0, ms: 0, prompt_tokens: 0, completion_tokens: 0, usd: 0, at: new Date().toISOString() };
    try {
      const r = await fetch(url(model), { method: "POST", ...init, headers: { Authorization: `Bearer ${apiToken()}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
      row.status = r.status; row.ms = Date.now() - t0;
      const ctype = r.headers.get("content-type") ?? "";
      if (r.ok && /^image\//.test(ctype)) {
        const bytes = new Uint8Array(await r.arrayBuffer());
        row.ok = true; row.usd = imageCost(model, meta.fields); ledger.push(row);
        return { binary: bytes, mime: ctype.split(";")[0] };
      }
      const txt = await r.text();
      let j; try { j = JSON.parse(txt); } catch { j = null; }
      if (!r.ok || !j || j.success === false) {
        const detail = j ? JSON.stringify(j.errors ?? j).slice(0, 400) : txt.slice(0, 400);
        ledger.push(row);
        last = new AiRestError(model, r.status, detail);
        if (RETRY_STATUS.has(r.status) && attempt < retries) { await sleep(4000 * (attempt + 1)); continue; }
        throw last;
      }
      const result = j.result;
      const usage = result && typeof result === "object" ? result.usage : null;
      row.ok = true;
      row.prompt_tokens = Number(usage?.prompt_tokens) || 0; row.completion_tokens = Number(usage?.completion_tokens) || 0;
      row.usd = meta.kind === "json" && !IMAGE_PRICES[model] ? textCost(model, usage) : imageCost(model, meta.fields);
      ledger.push(row);
      return { result };
    } catch (e) {
      if (e instanceof AiRestError) throw e;
      row.ms = Date.now() - t0; ledger.push(row);
      last = new AiRestError(model, /timeout|abort/i.test(String(e?.name ?? e)) ? 504 : 503, `fetch failed: ${String(e?.message ?? e).slice(0, 200)}`);
      if (attempt < retries && !/timeout|abort/i.test(String(e?.name ?? e))) { await sleep(4000 * (attempt + 1)); continue; }
      throw last;
    }
  }
  throw last;
}

/** A JSON call: the chat models, SDXL-lightning. Returns { result } or { binary, mime }. */
export function runJson(model, body, opts) {
  return post(model, { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, { kind: "json", fields: body }, opts);
}

/**
 * A multipart call (FLUX.2): `fields` is a FormData, or a plain object whose values are strings, numbers, Blobs or
 * Uint8Arrays (bytes become image/jpeg-or-png blobs). Returns { result } (FLUX.2 answers { image: base64 }).
 */
export async function runMultipart(model, fields, opts) {
  let fd = fields;
  const meta = { kind: "multipart", fields: {} };
  if (!(fields instanceof FormData)) {
    fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      if (v instanceof Uint8Array) fd.append(k, new Blob([v], { type: mimeOfBytes(v) }), `${k}.${mimeOfBytes(v).split("/")[1]}`);
      else if (v instanceof Blob) fd.append(k, v, k);
      else fd.append(k, String(v));
    }
  }
  meta.fields = await formMeta(fd);
  return post(model, { body: fd }, meta, opts);
}

/** The width, height and input-image megapixels of a form, for the price (an image whose size cannot be read counts 1 MP). */
async function formMeta(fd) {
  const out = { width: fd.get("width"), height: fd.get("height"), inputMp: 0 };
  for (const [k, v] of fd.entries()) {
    if (!/^input_image/.test(k) || !(v instanceof Blob)) continue;
    const dim = imageSize(new Uint8Array(await v.arrayBuffer()));
    out.inputMp += dim ? (dim.width * dim.height) / 1e6 : 1;
  }
  return out;
}

/** Width and height of a PNG or JPEG from its header, or null. */
export function imageSize(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b.length > 24) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + len;
    }
  }
  return null;
}

export function mimeOfBytes(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return "image/jpeg";
}

/* ------------------------------------------------------------------ the env shim */

/**
 * `env.AI` as src/ sees it on the Worker: run(model, inputs) resolves to the `result` object (chat answers:
 * {response} or {choices}; FLUX.2: {image}); a binary answer (SDXL) resolves to a ReadableStream like the binding's.
 * `inputs.multipart` = { body, contentType } is the binding's multipart form (a stream made from a FormData by
 * `new Response(form)`); the body is read and re-sent with the same boundary. A FormData body is sent as it is.
 */
export function makeAi(opts = {}) {
  return {
    async run(model, inputs = {}) {
      // A floor under max_tokens for chat calls (off unless asked, and then the same for both runs): kimi-k2.6 thinks
      // before it answers and the thinking is billed against max_tokens, so a planner budget written for a
      // non-reasoning model can come back cut off. The bench can measure Kleo as deployed (no floor) or Kleo given room.
      if (opts.minMaxTokens && inputs && typeof inputs === "object" && Array.isArray(inputs.messages))
        inputs = { ...inputs, max_tokens: Math.max(Number(inputs.max_tokens) || 0, opts.minMaxTokens) };
      // Kimi's instant mode (measured 24 September 2026 on a 6-word title: thinking on 19 s and 786 tokens, of which
      // ~3,000 characters of reasoning; chat_template_kwargs {thinking:false} 1 s and 30 tokens, same quality of answer).
      // With thinking on, the planner's own budgets (1,800 tokens for a treatment) came back EMPTY every time — the
      // reasoning ate max_tokens — and a call long enough to finish would pass storyboard.ts's 90-second call timeout.
      if (opts.thinking === "off" && /kimi/i.test(model) && inputs && typeof inputs === "object" && Array.isArray(inputs.messages))
        inputs = { ...inputs, chat_template_kwargs: { ...(inputs.chat_template_kwargs ?? {}), thinking: false } };
      if (inputs && typeof inputs === "object" && inputs.multipart) {
        const { body, contentType } = inputs.multipart;
        if (body instanceof FormData) return unwrap(await runMultipart(model, body, opts));
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        // The form is re-parsed only to price it (width/height/input images); the bytes go out untouched.
        let meta = { kind: "multipart", fields: {} };
        try { meta.fields = await formMeta(await new Response(bytes, { headers: { "content-type": contentType } }).formData()); } catch { /* priced as 1 MP */ }
        return unwrap(await post(model, { headers: { "content-type": contentType }, body: bytes }, meta, opts));
      }
      return unwrap(await runJson(model, inputs, opts));
    },
  };
}
const unwrap = (r) => (r.binary ? new Response(r.binary).body : r.result);

/** An in-memory R2 bucket with the methods src/ uses: put, get, head, list, delete. */
export function makeR2() {
  const store = new Map();
  const toBytes = async (v) => {
    if (v === null || v === undefined) return new Uint8Array(0);
    if (typeof v === "string") return new TextEncoder().encode(v);
    if (v instanceof Uint8Array) return new Uint8Array(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    return new Uint8Array(await new Response(v).arrayBuffer());
  };
  const objectOf = (key, rec, withBody) => {
    const o = {
      key, size: rec.bytes.length, etag: String(rec.version), httpEtag: `"${rec.version}"`, version: String(rec.version), uploaded: rec.uploaded,
      httpMetadata: rec.httpMetadata, customMetadata: rec.customMetadata,
      writeHttpMetadata(h) { if (rec.httpMetadata?.contentType) h.set("content-type", rec.httpMetadata.contentType); },
    };
    if (withBody) Object.assign(o, {
      get body() { return new Response(rec.bytes).body; }, bodyUsed: false,
      async arrayBuffer() { return rec.bytes.slice().buffer; }, async bytes() { return rec.bytes.slice(); },
      async text() { return new TextDecoder().decode(rec.bytes); }, async json() { return JSON.parse(new TextDecoder().decode(rec.bytes)); },
      async blob() { return new Blob([rec.bytes], { type: rec.httpMetadata?.contentType ?? "" }); },
    });
    return o;
  };
  let version = 0;
  return {
    _store: store,
    async put(key, value, o = {}) {
      const rec = { bytes: await toBytes(value), httpMetadata: o.httpMetadata ?? {}, customMetadata: o.customMetadata ?? {}, uploaded: new Date(), version: ++version };
      store.set(key, rec);
      return objectOf(key, rec, false);
    },
    async get(key) { const rec = store.get(key); return rec ? objectOf(key, rec, true) : null; },
    async head(key) { const rec = store.get(key); return rec ? objectOf(key, rec, false) : null; },
    async list(o = {}) {
      const keys = [...store.keys()].filter((k) => !o.prefix || k.startsWith(o.prefix)).sort();
      const start = o.cursor ? Number(o.cursor) : 0, limit = o.limit ?? 1000;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map((k) => objectOf(k, store.get(k), false)), truncated, cursor: truncated ? String(start + limit) : undefined, delimitedPrefixes: [] };
    },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
  };
}

/** Writes every object of an in-memory R2 under `dir`, keeping the key's folders. */
export function dumpR2(r2, dir) {
  for (const [key, rec] of r2._store) {
    const f = join(dir, ...key.split("/"));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, rec.bytes);
  }
}

/**
 * The environment src/ modules receive: the AI shim, an in-memory R2, and the vars given. No D1: the steps call the
 * planner and the stills engine directly, never the orchestrator, so no table is ever read.
 */
export function makeEnv(opts = {}) {
  const { timeoutMs, retries, minMaxTokens, thinking, ...vars } = opts;
  return { AI: makeAi({ timeoutMs, retries, minMaxTokens, thinking }), RENDERS: makeR2(), PUBLIC_URL: "https://bench.invalid", ...vars };
}

/* ------------------------------------------------------------------ chat helpers for the bench's own judges */

/** The text of a chat answer in the shapes Workers AI returns (mirrors src/vision.ts answerText; reasoning is ignored). */
export function answerText(res) {
  const r = res && typeof res === "object" ? res : {};
  if (typeof r.response === "string") return r.response;
  if (r.response && typeof r.response === "object") return JSON.stringify(r.response);
  if (Array.isArray(r.choices)) {
    const msg = r.choices[0]?.message;
    if (typeof msg?.content === "string") return msg.content;
    if (Array.isArray(msg?.content)) return msg.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
  }
  if (Array.isArray(r.output)) {
    const msg = r.output.find((o) => o.type === "message");
    const c = Array.isArray(msg?.content) ? msg.content.find((x) => typeof x.text === "string") : null;
    if (c) return c.text;
  }
  return "";
}
/** Why a chat answer came back empty (finish_reason "length" = the reasoning ate max_tokens). */
export const finishReason = (res) => String(res?.choices?.[0]?.finish_reason ?? res?.finish_reason ?? "");

/** The first balanced JSON object in a text (fences, prose and trailing commas tolerated), or null. */
export function firstJson(text) {
  const s = String(text ?? "").replace(/```(?:json)?/gi, "");
  for (let a = s.indexOf("{"); a >= 0; a = s.indexOf("{", a + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = a; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { return JSON.parse(s.slice(a, i + 1).replace(/,\s*([}\]])/g, "$1")); } catch { break; }
      }
    }
  }
  return null;
}

/**
 * The chat-template switch that turns a hybrid model's thinking off: gemma-4 reads `enable_thinking`, kimi-k2.6
 * `thinking` (both measured 24 September 2026: gemma on a three-item labelling task 4.8 s and 292 tokens with
 * thinking, 1 s and 37 tokens without, same labels; on the smoke run's whole-film judgement, thinking ran past 8,000
 * tokens in 103 s and answered nothing). Models that do not know a key ignore it.
 */
export const NO_THINKING = { chat_template_kwargs: { enable_thinking: false, thinking: false } };

/**
 * One chat call that must answer a JSON object: temperature 0, one retry when the answer is not JSON (or was cut off).
 * `thinking: "off"` (the bench's default for its judges) sends NO_THINKING; with thinking on, a round that runs out
 * of tokens is retried once with thinking off rather than lost. Returns { json, text, ms, model, finish, thinking }.
 */
export async function chatJson(model, messages, { maxTokens = 6000, retries = 1, timeoutMs, thinking = "off" } = {}) {
  let last = { json: null, text: "", finish: "" };
  let think = thinking !== "off";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    const { result } = await runJson(model, { messages, max_tokens: maxTokens, temperature: 0, ...(think ? {} : NO_THINKING) }, { timeoutMs });
    const text = answerText(result);
    const json = firstJson(text);
    last = { json, text, ms: Date.now() - t0, model, finish: finishReason(result), thinking: think ? "on" : "off" };
    if (json) return last;
    if (last.finish === "length") think = false;
  }
  return last;
}

/** A data: URL for an image's bytes (the vision models take images this way). */
export const dataUrl = (bytes, mime) => `data:${mime ?? mimeOfBytes(bytes)};base64,${Buffer.from(bytes).toString("base64")}`;

/* ------------------------------------------------------------------ cases, arguments, files */

export function loadCases(filter) {
  const all = JSON.parse(readFileSync(join(BENCH_DIR, "cases.json"), "utf8")).cases;
  if (!filter) return all;
  const want = String(filter).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = want.filter((w) => !all.some((c) => c.id === w));
  if (unknown.length) throw new Error(`unknown case id(s): ${unknown.join(", ")} (see cases.json)`);
  return all.filter((c) => want.includes(c.id));
}

/** --name value / --flag arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split("=", 2);
    if (v !== undefined) out[k] = v;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

export const runDir = (run) => {
  if (!/^[\w.-]+$/.test(String(run ?? ""))) throw new Error(`--run needs a plain name (letters, digits, - _ .), got "${run}"`);
  return join(OUT_DIR, run);
};
export function readJson(f, fallback = null) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } }
export function writeJson(f, x) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(x, null, 1) + "\n"); }
export const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []);

/** Runs `fn` over `items`, `n` at a time, in order of start; results in input order. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** The picture shots of a storyboard with their ids as the engine names them ("<sceneId>-s<n>"), plus the new authoring fields. */
export function shotsOf(sb) {
  const scenes = Array.isArray(sb?.scenes) ? sb.scenes : [];
  const out = [];
  scenes.forEach((sc, si) => {
    const shots = Array.isArray(sc?.shots) ? sc.shots : typeof sc?.image_prompt === "string" ? [{ image_prompt: sc.image_prompt }] : [];
    shots.forEach((sh, i) => {
      const p = typeof sh?.image_prompt === "string" ? sh.image_prompt.trim() : "";
      if (!p) return;
      out.push({
        id: `${sc.id ?? `scene-${si + 1}`}-s${i + 1}`, scene: si + 1, image_prompt: p, accent: sc.accent ?? null,
        shot_kind: sh.shot_kind ?? null, covers: Array.isArray(sh.covers) ? sh.covers.map(String) : [],
        cast: Array.isArray(sh.cast) ? sh.cast.map(String) : [], action: typeof sh.action === "string" ? sh.action : null,
        voice: typeof sc.voice === "string" ? sc.voice : "",
      });
    });
  });
  return out;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`);
export const usd = (x) => `$${(x ?? 0).toFixed(x >= 1 ? 2 : 4)}`;
