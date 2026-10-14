/**
 * KLEO STUDIO — THE WORKER (wrangler.studio.jsonc, Worker "kleo-studio", app.kleooai.com).
 *
 * A second Worker next to the MCP server, deployed on its own so a Studio release never redeploys the MCP server.
 * Same D1 database and R2 bucket: one account, one balance, one payment history for both.
 *
 *   /api/*          JSON API for the page (session cookie; every POST/PATCH/DELETE needs the header X-Kleo: 1)
 *   /auth/<google|microsoft>[/callback]   social sign-in round trip (?link=1 adds it to the signed-in account)
 *   /media/...      the person's pictures and clips (cookie, or a signed link for the provider and for sharing)
 *   everything else the single-page app in studio-web/ (served by the ASSETS binding, index.html for app routes)
 *   cron            every minute: refresh the clips still with the provider, save the finished ones, refund the failed
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { getUser, hasPaid, audit, countAuditTodayForUser } from "../db.ts";
import { PACKS, buyUrl } from "../stripe.ts";
import { rid } from "../util.ts";
import { DEFAULT_MODEL, freeModels, publicCatalog, normalizeSettings, clipCredits } from "./models.ts";
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, freeImageModels, publicImageCatalog } from "./image-models.ts";
import {
  ensureStudioSchema, listChats, getChat, createChat, touchChat, renameChat, deleteChat, listMessages, addMessage,
  getMessage, setMessageData, agentMessagesToday, addUpload, getUpload, uploadsOf, getGeneration, listGenerations,
  staleGenerations, type MessageRow, type GenerationRow,
} from "./store.ts";
import { deleteGeneration, StudioError, createGeneration, refreshGeneration, publicGeneration, marginOf, runTool, freeTools } from "./generate.ts";
import { publicPresets } from "./presets.ts";
import { planTool, publicTools, toolByKey, toolCredits, ToolRefusal, type Media } from "./tools.ts";
import { mediaInfo } from "./media.ts";
import { APP_PATH, serveSite } from "./site.ts";
import { normalizeFilm, orderFilm, quoteFilm } from "./films.ts";
import { runAgent, chatTitle, enhancePrompt, type Proposal } from "./agent.ts";
import { NO_GIFT_SENTENCE, giftCookie, visitorOf } from "../abuse.ts";
import { signUp, signIn, signInWithKey, addPassword, me, signedIn, endAllSessions, kleoKeyOf, setName, changePassword, activity, deleteAccount, googleEnabled, signupMode, microsoftEnabled, enabledSocial, socialEnabled, socialStart, socialCallback, forgotPassword, resetPassword, resetAvailable, type SocialKey } from "./auth.ts";
import { httpsRedirect, secureResponse } from "./security.ts";
import { SESSION_COOKIE, clearSessionCookie, readCookie, readSessionFull, normalizeEmail, signPath, checkSignedPath } from "./session.ts";
import { ipBucket } from "../accounts.ts";

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
const MAX_CLIP = 60 * 1024 * 1024;

async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  try { return (await request.json()) as T; } catch { throw new StudioError("Bad request."); }
}

/** The signed-in account, or null. A cookie from before the account's last "sign out everywhere" no longer counts. */
async function sessionUser(env: StudioEnv, request: Request): Promise<string | null> {
  const s = await readSessionFull(env.INTERNAL_SECRET, readCookie(request.headers.get("cookie"), SESSION_COOKIE));
  if (!s) return null;
  const row = await env.DB.prepare("SELECT studio_epoch FROM users WHERE id = ?").bind(s.userId).first<{ studio_epoch: number | null }>().catch(() => null);
  return row && Number(row.studio_epoch ?? 0) === s.epoch ? s.userId : null;
}

/** Ten tries a minute per visitor (an IPv6 visitor is its /64) and, for a sign-in, per e-mail address as well. */
async function rateLimited(env: StudioEnv, request: Request, email?: string): Promise<boolean> {
  if (!env.AUTH_LIMIT) return false;
  const ip = request.headers.get("cf-connecting-ip");
  if (!(await env.AUTH_LIMIT.limit({ key: `auth:${ip ? ipBucket(ip) : "unknown"}` })).success) return true;
  return !!email && !(await env.AUTH_LIMIT.limit({ key: `signin:${email}` })).success;
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
    const ext = (u.key.split(".").pop() ?? "jpg").replace("jpeg", "jpg");
    return serveFile(env, request, u.key, `kleo-${u.id}.${ext}`, url.searchParams.get("dl") === "1", "private, max-age=86400");
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
      google: googleEnabled(env), microsoft: microsoftEnabled(env), social: enabledSocial(env), signup: signupMode(env), noGift: NO_GIFT_SENTENCE, turnstile: env.TURNSTILE_SITEKEY ?? null, defaultModel: DEFAULT_MODEL,
      models: publicCatalog(marginOf(env), freeModels(env.STUDIO_FREE_MODELS)), freeCredits: Number(env.FREE_CREDITS ?? 5),
      defaultImageModel: DEFAULT_IMAGE_MODEL, imageModels: publicImageCatalog(marginOf(env), freeImageModels(env.STUDIO_FREE_IMAGE_MODELS)),
      emailReset: resetAvailable(env), presets: publicPresets(), tools: publicTools(marginOf(env)), freeTools: freeTools(env.STUDIO_FREE_TOOLS),
    });
  }
  if (path.startsWith("/api/auth/") && method === "POST" && path !== "/api/auth/password" && path !== "/api/auth/password/change" && path !== "/api/auth/signout-all") {
    if (path === "/api/auth/signout") return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
    const b = await body(request);
    // Guessing one person's password from many addresses is throttled per e-mail too, not only per visitor.
    const email = path === "/api/auth/signin" ? normalizeEmail(String(b.email ?? "")) : undefined;
    if (await rateLimited(env, request, email)) return json({ error: "Too many tries. Wait a minute.", code: "rate" }, 429);
    if (path === "/api/auth/signup") {
      // The answer says whether the gift came, and a gifted browser keeps a mark of it (src/abuse.ts).
      const made = await signUp(env, b, visitorOf(request));
      const res = await signedIn(env, made.userId, { ok: true, gift: made.gifted, ...(made.gifted ? {} : { note: NO_GIFT_SENTENCE }) });
      if (made.gifted) res.headers.append("set-cookie", giftCookie());
      return res;
    }
    if (path === "/api/auth/signin") return signedIn(env, await signIn(env, b));
    if (path === "/api/auth/key") return signedIn(env, await signInWithKey(env, String(b.key ?? "")));
    if (path === "/api/auth/forgot") { ctx.waitUntil(forgotPassword(env, b, origin)); return json({ ok: true }); }
    if (path === "/api/auth/reset") return signedIn(env, await resetPassword(env, b));
    return json({ error: "Not found." }, 404);
  }

  const userId = await sessionUser(env, request);
  if (!userId) return json({ error: "Please sign in.", code: "signin" }, 401);

  if (path === "/api/auth/password" && method === "POST") { await addPassword(env, userId, await body(request)); return json({ ok: true }); }
  // Every browser and phone signed in to this account is signed out (this one too).
  if (path === "/api/auth/signout-all" && method === "POST") {
    await endAllSessions(env, userId);
    await audit(asEnv(env), userId, null, "studio.signout_all", {});
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
  }
  // The Kleo key only on request; "reset" retires the old one everywhere (MCP sign-in cookies, the assistants connected
  // with it, every Studio session) and signs THIS browser in again under the new epoch.
  if (path === "/api/me/key" && method === "POST") {
    const fresh = (await body(request)).reset === true;
    const key = await kleoKeyOf(env, userId, fresh);
    if (!fresh) return json({ key });
    const res = await signedIn(env, userId, { key });
    res.headers.set("cache-control", "no-store"); // a credential, like every other answer of this API
    return res;
  }

  if (path === "/api/me" && method === "GET") {
    const info = await me(env, userId);
    if (!info) return json({ error: "Please sign in.", code: "signin" }, 401, { "set-cookie": clearSessionCookie() });
    const paid = await hasPaid(asEnv(env), userId);
    return json({
      ...info, paid, allowed: paid ? publicCatalog().map((m: any) => m.key) : freeModels(env.STUDIO_FREE_MODELS),
      allowedImages: paid ? IMAGE_MODELS.map((m) => m.key) : freeImageModels(env.STUDIO_FREE_IMAGE_MODELS), packs: packsFor(env, userId),
      allowedTools: paid ? freeTools("*") : freeTools(env.STUDIO_FREE_TOOLS),
    });
  }

  // ── the account page ──
  if (path === "/api/me/activity" && method === "GET") return json(await activity(env, userId));
  if (path === "/api/me/profile" && method === "POST") return json({ name: await setName(env, userId, (await body(request)).name) });
  if (path === "/api/auth/password/change" && method === "POST") { await changePassword(env, userId, await body(request)); return signedIn(env, userId); }
  if (path === "/api/me/delete" && method === "POST") {
    await deleteAccount(env, userId, (await body(request)).confirm);
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
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
    const b = await body<{ chatId?: string; text?: string; imageIds?: string[]; settings?: Record<string, unknown>; imageSettings?: Record<string, unknown>; mode?: string; preset?: string }>(request);
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
    const attachments = uploads.map((u) => ({ id: u.id, url: `/media/u/${u.id}`, width: u.width, height: u.height, kind: u.kind ?? "image", duration: u.duration ?? null }));
    const userMsgId = rid("m", 12);
    await addMessage(env, { id: userMsgId, chatId: chat.id, userId, role: "user", text, data: attachments.length ? { attachments } : null });
    const paid = await hasPaid(asEnv(env), userId);
    const allowed = paid ? (publicCatalog().map((m: any) => m.key) as any) : freeModels(env.STUDIO_FREE_MODELS);
    const allowedImages = paid ? IMAGE_MODELS.map((m) => m.key) : freeImageModels(env.STUDIO_FREE_IMAGE_MODELS);
    const reply = await runAgent(env, {
      history, text, uploads, ui: b.settings ?? {}, uiImage: b.imageSettings ?? {}, mode: b.mode === "image" ? "image" : "video",
      credits: user.credits, allowed, allowedImages, margin: marginOf(env),
    },
      await picturesForAgent(env, uploads.filter((u) => (u.kind ?? "image") === "image").map((u) => u.key)));
    // A film card carries the MCP server's price (and what this account may order: film or animatic).
    if (reply.proposal?.kind === "film") {
      try {
        const q = await quoteFilm(env, userId, normalizeFilm(reply.proposal.settings as unknown as Record<string, unknown>));
        reply.proposal.credits = q.credits_for_choice;
        (reply.proposal as unknown as Record<string, unknown>).quote = q;
      } catch { /* the card still shows; the price is asked again on Generate */ }
    }
    // The chosen camera/effect preset rides on a video card and is added to its prompt when it is generated.
    if (reply.proposal && reply.proposal.kind === "video" && b.preset) (reply.proposal.settings as unknown as Record<string, unknown>).preset = String(b.preset);
    const botId = rid("m", 12);
    await addMessage(env, { id: botId, chatId: chat.id, userId, role: "assistant", text: reply.text, data: reply.proposal || reply.fallback ? { proposal: reply.proposal ?? undefined, fallback: reply.fallback || undefined } : null });
    await touchChat(env, chat.id);
    return json({ chat: await getChat(env, userId, chat.id), messages: (await messagesWithClips(env, chat.id)).filter((m) => m.id === userMsgId || m.id === botId) });
  }

  // ── generating ──
  if (path === "/api/generate" && method === "POST") {
    const b = await body<{ chatId?: string; proposalId?: string; prompt?: string; settings?: Record<string, unknown>; imageIds?: string[]; kind?: string; preset?: string; noChat?: boolean }>(request);
    if (b.noChat && !b.proposalId) {
      // The Video and Image pages: a generation with no conversation around it.
      const g = await createGeneration(env, userId, { kind: b.kind === "image" ? "image" : "video", prompt: String(b.prompt ?? ""), settings: b.settings ?? {}, imageIds: Array.isArray(b.imageIds) ? b.imageIds : [], chatId: null, messageId: null, preset: b.preset ?? null }, origin);
      const user = await getUser(asEnv(env), userId);
      return json({ generation: publicGeneration(g), credits: user?.credits ?? 0 });
    }
    let chat = b.chatId ? await getChat(env, userId, b.chatId) : null;
    let kind: "video" | "image" | "film" = b.kind === "image" ? "image" : "video";
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
      kind = p.kind === "image" ? "image" : p.kind === "film" ? "film" : "video";
    }
    // The clip is ordered FIRST: a refusal (locked model, too few credits, full day) must leave no empty chat behind.
    const newMessages: string[] = [];
    const chatId = chat?.id ?? rid("c", 12);
    const userMsgId = proposalMsg ? null : rid("m", 12);
    const preset = b.preset ?? (typeof settings.preset === "string" ? settings.preset : null);
    const g = kind === "film"
      ? await orderFilm(env, userId, { prompt, settings: normalizeFilm(settings), chatId, messageId: proposalMsg?.id ?? userMsgId })
      : await createGeneration(env, userId, { kind, prompt, settings, imageIds, chatId, messageId: proposalMsg?.id ?? userMsgId, preset }, origin);
    if (!chat) {
      await createChat(env, chatId, userId, chatTitle(prompt, imageIds.length > 0));
      chat = (await getChat(env, userId, chatId))!;
    }
    if (userMsgId) {
      // Direct mode: the prompt itself is the person's message.
      const uploads = await uploadsOf(env, userId, imageIds);
      await addMessage(env, { id: userMsgId, chatId: chat.id, userId, role: "user", text: prompt.trim(), data: uploads.length ? { attachments: uploads.map((u) => ({ id: u.id, url: `/media/u/${u.id}`, width: u.width, height: u.height, kind: u.kind ?? "image", duration: u.duration ?? null })) } : null });
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
    // The exact price of a video with clips attached (their seconds are billed too), as the page cannot know it.
    const b = await body<{ settings?: Record<string, unknown>; imageIds?: string[] }>(request);
    const all = await uploadsOf(env, userId, Array.isArray(b.imageIds) ? b.imageIds : []);
    const pics = all.filter((u) => (u.kind ?? "image") === "image").length;
    const vids = all.filter((u) => u.kind === "video");
    const secs = vids.reduce((a, v) => a + (v.duration ?? 0), 0);
    const s = normalizeSettings(b.settings ?? {}, pics, { images: pics, videos: vids.length, audios: all.filter((u) => u.kind === "audio").length, videoSeconds: secs });
    return json({ settings: s, credits: clipCredits(s, marginOf(env), secs) });
  }
  if (path === "/api/film/quote" && method === "POST") {
    const b = await body<{ settings?: Record<string, unknown> }>(request);
    return json(await quoteFilm(env, userId, normalizeFilm(b.settings ?? {})));
  }
  if (path === "/api/enhance" && method === "POST") {
    const b = await body<{ kind?: string; prompt?: string; seconds?: number; aspect?: string; model?: string }>(request);
    if ((await countAuditTodayForUser(asEnv(env), userId, "studio.enhance")) >= Number(env.STUDIO_AGENT_PER_DAY ?? 200)) throw new StudioError("You've reached today's limit for prompt help.", 429, "agent_limit");
    await audit(asEnv(env), userId, null, "studio.enhance", {});
    const kind = (["video", "image", "music", "sfx", "edit"] as const).find((k) => k === b.kind) ?? "video";
    return json({ prompt: await enhancePrompt(env, kind, String(b.prompt ?? ""), { seconds: Number(b.seconds) || undefined, aspect: typeof b.aspect === "string" ? b.aspect.slice(0, 8) : undefined, model: typeof b.model === "string" ? b.model.slice(0, 40) : undefined }) });
  }
  if (path === "/api/tools/price" && method === "POST") {
    const b = await body<{ tool?: string; inputs?: Record<string, string> }>(request);
    const tool = toolByKey(b.tool);
    if (!tool) return json({ error: "Not found." }, 404);
    const inputs = b.inputs ?? {};
    const rows = await uploadsOf(env, userId, Object.values(inputs).map(String));
    const media: Record<string, Media | undefined> = {};
    for (const f of tool.fields) {
      const u = rows.find((r) => r.id === inputs[f.key]);
      if (u) media[f.key] = { id: u.id, url: "", kind: u.kind ?? "image", seconds: u.duration ?? null, width: u.width, height: u.height, type: u.content_type ?? "" };
    }
    try {
      const plan = planTool(tool.key, inputs, media);
      return json({ credits: toolCredits(plan.usd, marginOf(env)), summary: plan.summary, estimate: !!plan.speech });
    } catch (e) {
      if (e instanceof ToolRefusal) return json({ credits: null, missing: e.message });
      throw e;
    }
  }
  if (path === "/api/tools/run" && method === "POST") {
    const b = await body<{ tool?: string; inputs?: Record<string, string>; consent?: boolean; chatId?: string }>(request);
    const g = await runTool(env, userId, { tool: String(b.tool ?? ""), inputs: b.inputs ?? {}, consent: b.consent === true, chatId: b.chatId ?? null }, origin);
    const user = await getUser(asEnv(env), userId);
    return json({ generation: publicGeneration(g), credits: user?.credits ?? 0 });
  }
  if (path === "/api/generations" && method === "GET") {
    const before = url.searchParams.get("before") ?? undefined;
    const rows = await listGenerations(env, userId, Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 60) || 60)), before,
      { model: url.searchParams.get("model") ?? undefined, kind: url.searchParams.get("kind") ?? undefined });
    return json({ generations: rows.map(publicGeneration) });
  }
  const genM = path.match(/^\/api\/generations\/(g_[a-z0-9]+)(\/share)?$/);
  if (genM) {
    let g = await getGeneration(env, genM[1]);
    if (!g || g.user_id !== userId) return json({ error: "Not found." }, 404);
    if (genM[2] && method === "POST") {
      if (g.status !== "done") throw new StudioError("It isn't ready yet.");
      if (g.kind === "image") {
        // One picture of the set: the upload id the page shows under it.
        const upload = String((await body(request)).upload ?? "");
        const own = (await uploadsOf(env, userId, [upload]))[0];
        if (!own) return json({ error: "Not found." }, 404);
        return json({ url: `${origin}${await signPath(env.INTERNAL_SECRET, `/media/u/${own.id}`, SHARE_DAYS * 86_400)}` });
      }
      return json({ url: `${origin}${await signPath(env.INTERNAL_SECRET, `/media/${g.id}.mp4`, SHARE_DAYS * 86_400)}` });
    }
    if (method === "GET") {
      g = await refreshGeneration(env, g);
      const user = await getUser(asEnv(env), userId);
      return json({ generation: publicGeneration(g), credits: user?.credits ?? 0 });
    }
    if (!genM[2] && method === "DELETE") { await deleteGeneration(env, userId, g); return json({ ok: true }); }
  }

  // ── pictures ──
  if (path === "/api/uploads" && method === "POST") {
    const len = Number(request.headers.get("content-length") ?? 0);
    if (len > MAX_CLIP) throw new StudioError("That file is too big (60 MB max).", 413);
    // A daily allowance per account (14 October 2026): storage is the owner's money, and uploads are kept. Only the
    // files this route stored count (their keys sit under the account's up/ prefix): the pictures, clips and speech
    // Kleo made for the account are upload rows too, and must not use up the room for the person's own files.
    const today = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM studio_uploads WHERE user_id = ? AND key LIKE ? AND created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')")
      .bind(userId, `studio/${userId}/up/%`).first<{ n: number; bytes: number }>();
    if ((today?.n ?? 0) >= Number(env.STUDIO_UPLOADS_PER_DAY ?? 200) || (today?.bytes ?? 0) + len > Number(env.STUDIO_UPLOAD_MB_PER_DAY ?? 2048) * 1048576) {
      throw new StudioError("You've reached today's upload allowance. Use the files you already added, or come back tomorrow.", 429, "uploads");
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const info = mediaInfo(bytes);
    if (!info || info.type === "audio/mp4") throw new StudioError("Use a JPG, PNG or WebP picture, an MP4 or MOV video, or an MP3 or WAV sound.", 415);
    if (info.fragmented) throw new StudioError("This video is a streaming (fragmented) MP4. Export it as a regular MP4 or MOV and try again.", 415, "fragmented");
    const cap = info.kind === "image" ? MAX_UPLOAD : info.kind === "audio" ? 15 * 1024 * 1024 : MAX_CLIP;
    if (bytes.byteLength > cap) throw new StudioError(`That ${info.kind === "image" ? "picture" : info.kind} is too big (${Math.round(cap / 1048576)} MB max).`, 413);
    const id = rid("up", 12);
    const key = `studio/${userId}/up/${id}.${info.ext}`;
    await env.RENDERS.put(key, bytes, { httpMetadata: { contentType: info.type } });
    // Pictures: the page measured them while shrinking; clips: the Worker read their header.
    const w = info.width ?? (Number(request.headers.get("x-width") ?? 0) || null), h = info.height ?? (Number(request.headers.get("x-height") ?? 0) || null);
    await addUpload(env, { id, userId, key, contentType: info.type, size: bytes.byteLength, width: w, height: h, kind: info.kind, duration: info.duration });
    return json({ id, url: `/media/u/${id}`, kind: info.kind, width: w, height: h, duration: info.duration });
  }

  return json({ error: "Not found." }, 404);
}

async function route(request: Request, env: StudioEnv, ctx: ExecutionContext, url: URL): Promise<Response> {
  // One address for the app: www and the old app.kleooai.com send people to the canonical host.
  const canonical = (env.CANONICAL_HOST ?? "").trim();
  if (canonical && url.hostname !== canonical && (url.hostname === `www.${canonical}` || url.hostname.startsWith("app."))) {
    return Response.redirect(`https://${canonical}${url.pathname}${url.search}`, 301);
  }
  // Everything that is not the app is the Kleo site (kleooai.com/mcp, /pricing/, /guides/…).
  if (!APP_PATH.test(url.pathname)) {
    try { return await serveSite(request, url); } catch { return new Response("The site is not reachable right now.", { status: 502 }); }
  }
  try {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/") || url.pathname.startsWith("/auth/")) await ensureStudioSchema(env);
    if (url.pathname.startsWith("/api/")) return await api(env, request, url, ctx);
    if (url.pathname.startsWith("/media/")) return await handleMedia(env, request, url);
    const social = url.pathname.match(/^\/auth\/(google|microsoft)(\/callback)?$/);
    if (social) {
      const key = social[1] as SocialKey;
      if (!socialEnabled(env, key)) return Response.redirect(`${url.origin}/`, 302);
      if (!social[2]) return socialStart(env, key, url.origin, url.searchParams.get("link") === "1");
      return await socialCallback(env, key, request, url.origin, await sessionUser(env, request), visitorOf(request));
    }
    if (url.pathname === "/health") return json({ ok: true, service: "kleo-studio" });
  } catch (e) {
    return fail(e);
  }
  // The single-page app: real files as they are, every other path gets index.html (client-side routes).
  let asset = await env.ASSETS.fetch(request);
  if (asset.status === 404 && request.method === "GET") asset = await env.ASSETS.fetch(new Request(new URL("/", url).toString(), request));
  // The page itself is never cached, so a release reaches everybody on the next load (its scripts carry ?v=).
  if ((asset.headers.get("content-type") ?? "").includes("text/html")) {
    asset = new Response(asset.body, asset);
    asset.headers.set("cache-control", "no-store");
  }
  return asset;
}

export default {
  async fetch(request: Request, env: StudioEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const toHttps = httpsRedirect(url);
    if (toHttps) return toHttps;
    return secureResponse(await route(request, env, ctx, url), { site: !APP_PATH.test(url.pathname) });
  },

  async scheduled(_event: ScheduledController, env: StudioEnv, ctx: ExecutionContext): Promise<void> {
    await ensureStudioSchema(env);
    const rows = await staleGenerations(env, 20, 25);
    for (const g of rows) {
      try { await refreshGeneration(env, g, 15); } catch (e) { console.error("studio cron", g.id, e instanceof Error ? e.message : e); }
    }
  },
};
