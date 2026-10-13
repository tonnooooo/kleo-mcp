/**
 * KLEO STUDIO — THE WORKER (wrangler.studio.jsonc, Worker "kleo-studio", app.kleooai.com).
 *
 * A second Worker next to the MCP server, deployed on its own so a Studio release never redeploys the MCP server.
 * Same D1 database and R2 bucket: one account, one balance, one payment history for both.
 *
 *   /api/*          JSON API for the page (session cookie; every POST/PATCH/DELETE needs the header X-Kleo: 1)
 *   /auth/google*   Google sign-in round trip
 *   /media/...      the person's pictures and clips (cookie, or a signed link for the provider and for sharing)
 *   everything else the single-page app in studio-web/ (served by the ASSETS binding, index.html for app routes)
 *   cron            every minute: refresh the clips still with the provider, save the finished ones, refund the failed
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { getUser, hasPaid } from "../db.ts";
import { PACKS, buyUrl } from "../stripe.ts";
import { rid } from "../util.ts";
import { DEFAULT_MODEL, freeModels, publicCatalog, normalizeSettings, clipCredits } from "./models.ts";
import {
  ensureStudioSchema, listChats, getChat, createChat, touchChat, renameChat, deleteChat, listMessages, addMessage,
  getMessage, setMessageData, agentMessagesToday, addUpload, getUpload, uploadsOf, getGeneration, listGenerations,
  staleGenerations, type MessageRow, type GenerationRow,
} from "./store.ts";
import { StudioError, createGeneration, refreshGeneration, publicGeneration, marginOf } from "./generate.ts";
import { runAgent, chatTitle, type Proposal } from "./agent.ts";
import { signUp, signIn, signInWithKey, addPassword, me, signedIn, googleEnabled, googleStart, googleCallback } from "./auth.ts";
import { SESSION_COOKIE, clearSessionCookie, readCookie, readSession, signPath, checkSignedPath } from "./session.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const fail = (e: unknown): Response => {
  if (e instanceof StudioError) return json({ error: e.message, code: e.code }, e.status);
  console.error("studio error", e instanceof Error ? e.stack ?? e.message : e);
  return json({ error: "Something went wrong on our side. Please try again.", code: "internal" }, 500);
};
const SHARE_DAYS = 30;
const MAX_UPLOAD = 10 * 1024 * 1024;

async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  try { return (await request.json()) as T; } catch { throw new StudioError("Bad request."); }
}

async function sessionUser(env: StudioEnv, request: Request): Promise<string | null> {
  return readSession(env.INTERNAL_SECRET, readCookie(request.headers.get("cookie"), SESSION_COOKIE));
}

async function rateLimited(env: StudioEnv, request: Request): Promise<boolean> {
  if (!env.AUTH_LIMIT) return false;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.AUTH_LIMIT.limit({ key: `auth:${ip}` });
  return !success;
}

/** The credit packs with this account's buy links (only real, live Stripe Payment Links). */
function packsFor(env: StudioEnv, userId: string) {
  return PACKS.map((p) => {
    const link = (env as unknown as Record<string, string | undefined>)[p.linkVar] ?? "";
    const live = link.startsWith("https://buy.stripe.com/") && !link.includes("/test_");
    return { label: p.label, credits: p.credits, url: live ? buyUrl(asEnv(env), p, userId) : null };
  });
}

/** One chat message as the page reads it, with the clips it refers to. */
function publicMessage(m: MessageRow, gens: Map<string, GenerationRow>): Record<string, unknown> {
  let data: Record<string, any> = {};
  try { data = m.data ? JSON.parse(m.data) : {}; } catch { /* text only */ }
  const out: Record<string, unknown> = { id: m.id, role: m.role, text: m.text ?? "", createdAt: m.created_at };
  if (Array.isArray(data.attachments)) out.attachments = data.attachments;
  if (data.proposal) out.proposal = data.proposal;
  if (Array.isArray(data.generations)) {
    out.generations = (data.generations as string[]).map((id) => gens.get(id)).filter((g): g is GenerationRow => !!g).map(publicGeneration);
  }
  if (data.generation && gens.get(data.generation)) out.generation = publicGeneration(gens.get(data.generation)!);
  if (data.fallback) out.fallback = true;
  return out;
}

async function messagesWithClips(env: StudioEnv, chatId: string): Promise<Record<string, unknown>[]> {
  const msgs = await listMessages(env, chatId);
  const ids = new Set<string>();
  for (const m of msgs) {
    try {
      const d = m.data ? JSON.parse(m.data) : {};
      if (d.generation) ids.add(d.generation);
      for (const g of d.generations ?? []) ids.add(g);
    } catch { /* ignore */ }
  }
  const gens = new Map<string, GenerationRow>();
  for (const id of ids) { const g = await getGeneration(env, id); if (g) gens.set(id, g); }
  return msgs.map((m) => publicMessage(m, gens));
}

/** The pictures of one message as data URLs, for the agent to look at (at most 4). */
async function picturesForAgent(env: StudioEnv, keys: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const key of keys.slice(0, 4)) {
    const obj = await env.RENDERS.get(key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    out.push(`data:${obj.httpMetadata?.contentType ?? "image/jpeg"};base64,${btoa(bin)}`);
  }
  return out;
}

function sniffImage(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** Streams a stored file with Range support. */
async function serveFile(env: StudioEnv, request: Request, key: string, filename: string, download: boolean, cache = "private, max-age=3600"): Promise<Response> {
  const range = request.headers.get("range");
  const obj = await env.RENDERS.get(key, range ? { range: request.headers } : undefined);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", etag: obj.httpEtag, "accept-ranges": "bytes",
    "cache-control": cache, "content-disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
  });
  const r = obj.range as { offset?: number; length?: number } | undefined;
  if (range && r && "offset" in r) {
    const offset = r.offset ?? 0, length = r.length ?? obj.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response((obj as R2ObjectBody).body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response((obj as R2ObjectBody).body, { status: 200, headers });
}

async function handleMedia(env: StudioEnv, request: Request, url: URL): Promise<Response> {
  const viewer = await sessionUser(env, request);
  const signed = await checkSignedPath(env.INTERNAL_SECRET, url.pathname, url.searchParams.get("exp"), url.searchParams.get("sig"));
  const up = url.pathname.match(/^\/media\/u\/(up_[a-z0-9]+)$/);
  if (up) {
    const u = await getUpload(env, up[1]);
    if (!u || (!signed && u.user_id !== viewer)) return new Response("Not found", { status: 404 });
    return serveFile(env, request, u.key, `${u.id}.jpg`, false, "private, max-age=86400");
  }
  const clip = url.pathname.match(/^\/media\/(g_[a-z0-9]+)\.mp4$/);
  if (clip) {
    const g = await getGeneration(env, clip[1]);
    if (!g || g.status !== "done" || !g.file_key || (!signed && g.user_id !== viewer)) return new Response("Not found", { status: 404 });
    return serveFile(env, request, g.file_key, `kleo-${g.id}.mp4`, url.searchParams.get("dl") === "1");
  }
  return new Response("Not found", { status: 404 });
}

async function api(env: StudioEnv, request: Request, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  if (method !== "GET" && method !== "HEAD" && request.headers.get("x-kleo") !== "1") return json({ error: "Forbidden" }, 403);
  const origin = url.origin;

  // ── no session needed ──
  if (path === "/api/config" && method === "GET") {
    return json({
      google: googleEnabled(env), turnstile: env.TURNSTILE_SITEKEY ?? null, defaultModel: DEFAULT_MODEL,
      models: publicCatalog(marginOf(env), freeModels(env.STUDIO_FREE_MODELS)), freeCredits: Number(env.FREE_CREDITS ?? 5),
    });
  }
  if (path.startsWith("/api/auth/") && method === "POST") {
    if (path !== "/api/auth/signout" && (await rateLimited(env, request))) return json({ error: "Too many tries. Wait a minute.", code: "rate" }, 429);
    const ip = request.headers.get("cf-connecting-ip");
    if (path === "/api/auth/signup") return signedIn(env, await signUp(env, await body(request), ip));
    if (path === "/api/auth/signin") return signedIn(env, await signIn(env, await body(request)));
    if (path === "/api/auth/key") return signedIn(env, await signInWithKey(env, String((await body(request)).key ?? "")));
    if (path === "/api/auth/signout") return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
  }

  const userId = await sessionUser(env, request);
  if (!userId) return json({ error: "Please sign in.", code: "signin" }, 401);

  if (path === "/api/auth/password" && method === "POST") { await addPassword(env, userId, await body(request)); return json({ ok: true }); }

  if (path === "/api/me" && method === "GET") {
    const info = await me(env, userId);
    if (!info) return json({ error: "Please sign in.", code: "signin" }, 401, { "set-cookie": clearSessionCookie() });
    const paid = await hasPaid(asEnv(env), userId);
    return json({ ...info, paid, allowed: paid ? publicCatalog().map((m: any) => m.key) : freeModels(env.STUDIO_FREE_MODELS), packs: packsFor(env, userId) });
  }

  // ── chats ──
  if (path === "/api/chats" && method === "GET") return json({ chats: await listChats(env, userId) });
  const chatM = path.match(/^\/api\/chats\/(c_[a-z0-9]+)$/);
  if (chatM) {
    const chat = await getChat(env, userId, chatM[1]);
    if (!chat) return json({ error: "Chat not found." }, 404);
    if (method === "GET") return json({ chat, messages: await messagesWithClips(env, chat.id) });
    if (method === "PATCH") { await renameChat(env, userId, chat.id, String((await body(request)).title ?? "").trim() || "Untitled"); return json({ ok: true }); }
    if (method === "DELETE") { await deleteChat(env, userId, chat.id); return json({ ok: true }); }
  }

  // ── the agent ──
  if (path === "/api/chat" && method === "POST") {
    const b = await body<{ chatId?: string; text?: string; imageIds?: string[]; settings?: Record<string, unknown> }>(request);
    const text = String(b.text ?? "").trim().slice(0, 4000);
    const uploads = await uploadsOf(env, userId, Array.isArray(b.imageIds) ? b.imageIds : []);
    if (!text && !uploads.length) throw new StudioError("Write a message or add a picture.");
    if ((await agentMessagesToday(env, userId)) >= Number(env.STUDIO_AGENT_PER_DAY ?? 200)) throw new StudioError("You've reached today's chat limit. You can still generate directly with the agent off.", 429, "agent_limit");
    const user = await getUser(asEnv(env), userId);
    if (!user) throw new StudioError("Please sign in again.", 401, "signin");
    let chat = b.chatId ? await getChat(env, userId, b.chatId) : null;
    if (!chat) {
      const id = rid("c", 12);
      await createChat(env, id, userId, chatTitle(text, uploads.length > 0));
      chat = (await getChat(env, userId, id))!;
    }
    const history = await listMessages(env, chat.id, 40);
    const attachments = uploads.map((u) => ({ id: u.id, url: `/media/u/${u.id}`, width: u.width, height: u.height }));
    const userMsgId = rid("m", 12);
    await addMessage(env, { id: userMsgId, chatId: chat.id, userId, role: "user", text, data: attachments.length ? { attachments } : null });
    const paid = await hasPaid(asEnv(env), userId);
    const allowed = paid ? (publicCatalog().map((m: any) => m.key) as any) : freeModels(env.STUDIO_FREE_MODELS);
    const reply = await runAgent(env, { history, text, uploads, ui: b.settings ?? {}, credits: user.credits, allowed, margin: marginOf(env) },
      await picturesForAgent(env, uploads.map((u) => u.key)));
    const botId = rid("m", 12);
    await addMessage(env, { id: botId, chatId: chat.id, userId, role: "assistant", text: reply.text, data: reply.proposal || reply.fallback ? { proposal: reply.proposal ?? undefined, fallback: reply.fallback || undefined } : null });
    await touchChat(env, chat.id);
    return json({ chat: await getChat(env, userId, chat.id), messages: (await messagesWithClips(env, chat.id)).filter((m) => m.id === userMsgId || m.id === botId) });
  }

  // ── generating ──
  if (path === "/api/generate" && method === "POST") {
    const b = await body<{ chatId?: string; proposalId?: string; prompt?: string; settings?: Record<string, unknown>; imageIds?: string[] }>(request);
    let chat = b.chatId ? await getChat(env, userId, b.chatId) : null;
    let proposalMsg: MessageRow | null = null;
    let prompt = String(b.prompt ?? "");
    let settings = b.settings ?? {};
    let imageIds = Array.isArray(b.imageIds) ? b.imageIds : [];
    if (b.proposalId) {
      proposalMsg = await getMessage(env, userId, b.proposalId);
      const p = proposalMsg?.data ? (JSON.parse(proposalMsg.data).proposal as Proposal | undefined) : undefined;
      if (!proposalMsg || !p) throw new StudioError("That proposal is gone. Ask again.");
      chat = await getChat(env, userId, proposalMsg.chat_id);
      // The person may have edited the prompt or the settings on the card before tapping Generate.
      if (!prompt.trim()) prompt = p.prompt;
      settings = { ...p.settings, ...settings };
      if (!b.imageIds) imageIds = p.imageIds;
    }
    // The clip is ordered FIRST: a refusal (locked model, too few credits, full day) must leave no empty chat behind.
    const newMessages: string[] = [];
    const chatId = chat?.id ?? rid("c", 12);
    const userMsgId = proposalMsg ? null : rid("m", 12);
    const g = await createGeneration(env, userId, { prompt, settings, imageIds, chatId, messageId: proposalMsg?.id ?? userMsgId }, origin);
    if (!chat) {
      await createChat(env, chatId, userId, chatTitle(prompt, imageIds.length > 0));
      chat = (await getChat(env, userId, chatId))!;
    }
    if (userMsgId) {
      // Direct mode: the prompt itself is the person's message.
      const uploads = await uploadsOf(env, userId, imageIds);
      await addMessage(env, { id: userMsgId, chatId: chat.id, userId, role: "user", text: prompt.trim(), data: uploads.length ? { attachments: uploads.map((u) => ({ id: u.id, url: `/media/u/${u.id}`, width: u.width, height: u.height })) } : null });
      newMessages.push(userMsgId);
    }
    if (proposalMsg) {
      const data = JSON.parse(proposalMsg.data!);
      data.generations = [...(data.generations ?? []), g.id];
      await setMessageData(env, proposalMsg.id, data);
      newMessages.push(proposalMsg.id);
    } else {
      const botId = rid("m", 12);
      await addMessage(env, { id: botId, chatId: chat.id, userId, role: "assistant", text: "", data: { generation: g.id } });
      newMessages.push(botId);
    }
    await touchChat(env, chat.id);
    const user = await getUser(asEnv(env), userId);
    return json({
      chat: await getChat(env, userId, chat.id), generation: publicGeneration(g), credits: user?.credits ?? 0,
      messages: (await messagesWithClips(env, chat.id)).filter((m) => newMessages.includes(String(m.id))),
    });
  }
  if (path === "/api/price" && method === "POST") {
    const b = await body<{ settings?: Record<string, unknown>; images?: number }>(request);
    const s = normalizeSettings(b.settings ?? {}, Number(b.images ?? 0));
    return json({ settings: s, credits: clipCredits(s, marginOf(env)) });
  }
  if (path === "/api/generations" && method === "GET") {
    const before = url.searchParams.get("before") ?? undefined;
    const rows = await listGenerations(env, userId, Math.min(100, Number(url.searchParams.get("limit") ?? 60)), before);
    return json({ generations: rows.map(publicGeneration) });
  }
  const genM = path.match(/^\/api\/generations\/(g_[a-z0-9]+)(\/share)?$/);
  if (genM) {
    let g = await getGeneration(env, genM[1]);
    if (!g || g.user_id !== userId) return json({ error: "Not found." }, 404);
    if (genM[2] && method === "POST") {
      if (g.status !== "done") throw new StudioError("The video isn't ready yet.");
      return json({ url: `${origin}${await signPath(env.INTERNAL_SECRET, `/media/${g.id}.mp4`, SHARE_DAYS * 86_400)}` });
    }
    if (method === "GET") {
      g = await refreshGeneration(env, g);
      const user = await getUser(asEnv(env), userId);
      return json({ generation: publicGeneration(g), credits: user?.credits ?? 0 });
    }
  }

  // ── pictures ──
  if (path === "/api/uploads" && method === "POST") {
    const len = Number(request.headers.get("content-length") ?? 0);
    if (len > MAX_UPLOAD) throw new StudioError("That picture is too big (10 MB max).", 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD) throw new StudioError("That picture is too big (10 MB max).", 413);
    const type = sniffImage(bytes);
    if (!type) throw new StudioError("Use a JPG, PNG or WebP picture.", 415);
    const id = rid("up", 12);
    const key = `studio/${userId}/up/${id}.${type.split("/")[1]}`;
    await env.RENDERS.put(key, bytes, { httpMetadata: { contentType: type } });
    const w = Number(request.headers.get("x-width") ?? 0) || null, h = Number(request.headers.get("x-height") ?? 0) || null;
    await addUpload(env, { id, userId, key, contentType: type, size: bytes.byteLength, width: w, height: h });
    return json({ id, url: `/media/u/${id}`, width: w, height: h });
  }

  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request: Request, env: StudioEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/") || url.pathname.startsWith("/auth/")) await ensureStudioSchema(env);
      if (url.pathname.startsWith("/api/")) return await api(env, request, url, ctx);
      if (url.pathname.startsWith("/media/")) return await handleMedia(env, request, url);
      if (url.pathname === "/auth/google") return googleEnabled(env) ? googleStart(env, url.origin) : Response.redirect(`${url.origin}/`, 302);
      if (url.pathname === "/auth/google/callback") return googleEnabled(env) ? await googleCallback(env, request, url.origin) : Response.redirect(`${url.origin}/`, 302);
      if (url.pathname === "/health") return json({ ok: true, service: "kleo-studio" });
    } catch (e) {
      return fail(e);
    }
    // The single-page app: real files as they are, every other path gets index.html (client-side routes).
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || request.method !== "GET") return asset;
    return env.ASSETS.fetch(new Request(new URL("/", url).toString(), request));
  },

  async scheduled(_event: ScheduledController, env: StudioEnv, ctx: ExecutionContext): Promise<void> {
    await ensureStudioSchema(env);
    const rows = await staleGenerations(env, 20, 25);
    for (const g of rows) {
      try { await refreshGeneration(env, g, 15); } catch (e) { console.error("studio cron", g.id, e instanceof Error ? e.message : e); }
    }
  },
};
