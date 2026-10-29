/**
 * KLEO STUDIO — THE WORKER (wrangler.studio.jsonc, Worker "kleo-studio", app.kleooai.com).
 *
 * A second Worker next to the MCP server, deployed on its own so a Studio release never redeploys the MCP server.
 * Same D1 database and R2 bucket: one account, one balance, one payment history for both.
 *
 *   /api/*          JSON API for the page (session cookie; every POST/PATCH/DELETE needs the header X-Kleo: 1)
 *   /auth/<google|microsoft|apple>[/callback]   social sign-in round trip (?link=1 adds it to the signed-in account;
 *                                              Apple's callback is a form POST)
 *   /media/...      the person's pictures and clips (cookie, or a signed link for sharing); an account that never paid
 *                   gets the copies with the Kleo mark (src/studio/watermark.ts); /media/raw/<upload> is the provider's
 *                   signed link to the clean file
 *   /r/<code>       a short link: counts the click, tags the visit, opens the link's page (src/studio/attribution.ts)
 *   /email/stop     the welcome e-mails' unsubscribe page and one-click POST (src/studio/onboarding.ts)
 *   /email/out      the outreach e-mails' unsubscribe page and one-click POST (src/studio/outreach.ts)
 *   /api/creators/* Kleo Creators: the public list, the application, the creator's posts and payout (src/studio/creators.ts)
 *   everything else the single-page app in studio-web/ (served by the ASSETS binding, index.html for app routes)
 *   cron            every minute: refresh the clips still with the provider, save the finished ones, refund the failed,
 *                   mail every new payment its receipt (src/studio/receipts.ts), the scout's search and readings
 *                   when the owner keeps it on (src/studio/scout.ts);
 *                   every 5 minutes the welcome e-mails that are due (src/studio/onboarding.ts) and, when the owner
 *                   switched it on, the outreach mailbox's replies and its next e-mail (src/studio/outreach.ts)
 */
import type { StudioEnv } from "./env.ts";
import type { Env } from "../env";
import { getUser, hasPaid, audit, countAuditTodayForUser } from "../db.ts";
import { PACKS, buyUrl } from "../stripe.ts";
import { rid, safeEqual } from "../util.ts";
import { DEFAULT_MODEL, freeModels, freeResolutions, publicCatalog, normalizeSettings, clipCredits } from "./models.ts";
import { IMAGE_MODELS, defaultImageModel, freeImageModels, pausedImageModels, publicImageCatalog } from "./image-models.ts";
import {
  ensureStudioSchema, listChats, getChat, createChat, touchChat, renameChat, deleteChat, listMessages, addMessage,
  getMessage, setMessageData, agentMessagesToday, addUpload, getUpload, uploadsOf, getGeneration, listGenerations,
  staleGenerations, autoWanOn, setAutoWan, type MessageRow, type GenerationRow,
} from "./store.ts";
import { deleteGeneration, StudioError, createGeneration, refreshGeneration, publicGeneration, marginOf, videoFactorOf, hasActivePlan, templateIsHd, runTool, freeTools, isAdmin, retryOnWan, declineWan, retryDescribed, declineRewrite, showsMark } from "./generate.ts";
import { servedKey } from "./watermark.ts";
import { publicPresets } from "./presets.ts";
import { planTool, publicTools, toolByKey, toolCredits, toolFactor, ToolRefusal, type Media } from "./tools.ts";
import { mediaInfo } from "./media.ts";
import { APP_PATH, serveSite } from "./site.ts";
import { handleProviderResume, refreshBalances, type Provider } from "./providers.ts";
import { withKeys } from "../key-overrides.ts";
import { normalizeFilm, orderFilm, quoteFilm } from "./films.ts";
import { runAgent, chatTitle, enhancePrompt, type Proposal } from "./agent.ts";
import { NO_GIFT_SENTENCE, giftCookie, visitorOf } from "../abuse.ts";
import { signUp, signIn, signInWithKey, addPassword, me, signedIn, endAllSessions, kleoKeyOf, setName, changePassword, activity, deleteAccount, googleEnabled, signupMode, microsoftEnabled, enabledSocial, socialEnabled, socialStart, socialCallback, forgotPassword, resetPassword, resetAvailable, type SocialKey } from "./auth.ts";
import { httpsRedirect, secureResponse } from "./security.ts";
import { SESSION_COOKIE, clearSessionCookie, readCookie, readSessionFull, normalizeEmail, signPath, checkSignedPath } from "./session.ts";
import { ipBucket } from "../accounts.ts";
import { studioConnect } from "../connect.ts";
import { planRef, publicPlans } from "../plans.ts";
import { createPaySession } from "./pay.ts";
import { adminApi } from "./admin.ts";
import { pruneIps, recordIp } from "./ips.ts";
import { ADMIN_SITE_API, ADMIN_SITE_PATH, CONSOLE_PATH, adminUrl, certProblem, isAdminHost, misdirected, noteRefused, refused } from "./admin-host.ts";
import { SHORT_LINK_PATH, arrivalOf, clearTouchCookie, firstVisit, shortLink } from "./attribution.ts";
import { handleStop, livePrices, mailTick, sendSeriesToOwner } from "./onboarding.ts";
import { handleOutreachStop, outreachTick, settingsOf } from "./outreach.ts";
import { scoutTick } from "./scout.ts";
import { morningDigest } from "./digest.ts";
import { receiptsTick } from "./receipts.ts";
import { addPost, applyAsCreator, creatorStatus, creatorsTick, leaveProgram, publicCreators, removePost, setPayout } from "./creators.ts";

const asEnv = (env: StudioEnv): Env => env as unknown as Env;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const fail = (e: unknown): Response => {
  if (e instanceof StudioError) return json({ ...(e.data ?? {}), error: e.message, code: e.code }, e.status);
  console.error("studio error", e instanceof Error ? e.stack ?? e.message : e);
  return json({ error: "Something went wrong on our side. Please try again.", code: "internal" }, 500);
};
const SHARE_DAYS = 30;
const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_CLIP = 60 * 1024 * 1024;

async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  try { return (await request.json()) as T; } catch { throw new StudioError("Bad request."); }
}

/**
 * The signed-in account, or null. A cookie from before the account's last "sign out everywhere" no longer counts, and
 * neither does any cookie of an account the owner closed from the admin console (users.blocked_at) or of an old
 * anonymous account merged into another one (users.merged_into, auth.ts accountMerged).
 */
async function sessionUser(env: StudioEnv, request: Request): Promise<string | null> {
  const s = await readSessionFull(env.INTERNAL_SECRET, readCookie(request.headers.get("cookie"), SESSION_COOKIE));
  if (!s) return null;
  const row = await env.DB.prepare("SELECT studio_epoch, blocked_at, merged_into FROM users WHERE id = ?").bind(s.userId)
    .first<{ studio_epoch: number | null; blocked_at: string | null; merged_into: string | null }>().catch(() => null);
  return row && !row.blocked_at && !row.merged_into && Number(row.studio_epoch ?? 0) === s.epoch ? s.userId : null;
}

/** Ten tries a minute per visitor (an IPv6 visitor is its /64) and, for a sign-in, per e-mail address as well. */
async function rateLimited(env: StudioEnv, request: Request, email?: string): Promise<boolean> {
  if (!env.AUTH_LIMIT) return false;
  const ip = request.headers.get("cf-connecting-ip");
  if (!(await env.AUTH_LIMIT.limit({ key: `auth:${ip ? ipBucket(ip) : "unknown"}` })).success) return true;
  return !!email && !(await env.AUTH_LIMIT.limit({ key: `signin:${email}` })).success;
}

/** The plan an account is on, as the pricing page shows it (null for none, or one that ran out). */
async function planOf(env: StudioEnv, userId: string): Promise<Record<string, unknown> | null> {
  const r = await env.DB.prepare("SELECT plan, plan_period, plan_credits, plan_until, plan_status FROM users WHERE id = ?").bind(userId).first<Record<string, any>>().catch(() => null);
  if (!r?.plan_until || Date.parse(r.plan_until) <= Date.now() || r.plan === "trial") return null;
  return { key: r.plan, period: r.plan_period, credits: r.plan_credits, until: r.plan_until, status: r.plan_status };
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
  // A provider reading one of the person's files: always the clean file, and only through a signed link (generate.ts providerLink).
  const raw = url.pathname.match(/^\/media\/raw\/(up_[a-z0-9]+)$/);
  if (raw) {
    const u = signed ? await getUpload(env, raw[1]) : null;
    if (!u) return new Response("Not found", { status: 404 });
    return serveFile(env, request, u.key, `kleo-${u.id}.${(u.key.split(".").pop() ?? "jpg").replace("jpeg", "jpg")}`, false, "private, max-age=3600");
  }
  const up = url.pathname.match(/^\/media\/u\/(up_[a-z0-9]+)$/);
  if (up) {
    const u = await getUpload(env, up[1]);
    if (!u || (!signed && u.user_id !== viewer)) return new Response("Not found", { status: 404 });
    const ext = (u.key.split(".").pop() ?? "jpg").replace("jpeg", "jpg");
    // ?name=song-1 names the download (two songs of one set were told apart by nothing but their ids).
    const name = /^[a-z0-9-]{1,40}$/.test(url.searchParams.get("name") ?? "") ? url.searchParams.get("name") : u.id;
    // The Kleo mark (src/studio/watermark.ts) is on pictures and clips only; a marked copy is kept a short while by the
    // browser, so the first purchase shows the clean file soon after.
    const file = u.kind === "audio" ? { key: u.key, marked: false } : await servedKey(env, u.user_id, u.key, (id) => showsMark(env, id), u.kind ?? "image");
    return serveFile(env, request, file.key, `kleo-${name}.${ext}`, url.searchParams.get("dl") === "1", file.marked ? "private, max-age=600" : "private, max-age=86400");
  }
  const clip = url.pathname.match(/^\/media\/(g_[a-z0-9]+)\.mp4$/);
  if (clip) {
    const g = await getGeneration(env, clip[1]);
    if (!g || g.status !== "done" || !g.file_key || (!signed && g.user_id !== viewer)) return new Response("Not found", { status: 404 });
    const file = await servedKey(env, g.user_id, g.file_key, (id) => showsMark(env, id), "video");
    return serveFile(env, request, file.key, `kleo-${g.id}.mp4`, url.searchParams.get("dl") === "1", file.marked ? "private, max-age=600" : undefined);
  }
  return new Response("Not found", { status: 404 });
}

async function api(env: StudioEnv, request: Request, url: URL, ctx: ExecutionContext, adminHost = false): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  if (method !== "GET" && method !== "HEAD" && request.headers.get("x-kleo") !== "1") return json({ error: "Forbidden" }, 403);
  // The admin host answers only the console's own routes and its sign-in (src/studio/admin-host.ts).
  if (adminHost && !ADMIN_SITE_API.test(path)) return json({ error: "Not found." }, 404);
  const origin = url.origin;

  // ── no session needed ──
  if (path === "/api/config" && method === "GET") {
    return json({
      // On the admin host the page shows only the console, signed in with a password (no Google redirect is registered there).
      ...(adminHost ? { adminSite: true } : {}),
      google: googleEnabled(env), microsoft: microsoftEnabled(env), social: enabledSocial(env), signup: signupMode(env), noGift: NO_GIFT_SENTENCE, turnstile: env.TURNSTILE_SITEKEY ?? null, defaultModel: DEFAULT_MODEL,
      models: publicCatalog(marginOf(env), freeModels(env.STUDIO_FREE_MODELS), videoFactorOf(env)), freeCredits: Number(env.FREE_CREDITS ?? 5),
      defaultImageModel: defaultImageModel(pausedImageModels(env.STUDIO_PAUSED_IMAGE_MODELS)),
      imageModels: publicImageCatalog(marginOf(env), freeImageModels(env.STUDIO_FREE_IMAGE_MODELS), pausedImageModels(env.STUDIO_PAUSED_IMAGE_MODELS)),
      emailReset: resetAvailable(env), plans: publicPlans(env.STRIPE_PLAN_LINKS, null), presets: publicPresets(), tools: publicTools(marginOf(env), videoFactorOf(env)), freeTools: freeTools(env.STUDIO_FREE_TOOLS),
      ...(adminHost ? { google: false, microsoft: false, social: [], signup: "none" } : {}),
    });
  }
  // The creators in Kleo Creators (src/studio/creators.ts): public, so anybody can check that a creator is real; the
  // site's /creators/ page (another origin) reads it too, with no cookie.
  if (path === "/api/creators/public" && method === "GET") return json(await publicCreators(env), 200, { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
  if (path.startsWith("/api/auth/") && method === "POST" && path !== "/api/auth/password" && path !== "/api/auth/password/change" && path !== "/api/auth/signout-all") {
    if (path === "/api/auth/signout") return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
    const b = await body(request);
    // Guessing one person's password from many addresses is throttled per e-mail too, not only per visitor.
    const email = path === "/api/auth/signin" ? normalizeEmail(String(b.email ?? "")) : undefined;
    if (await rateLimited(env, request, email)) return json({ error: "Too many tries. Wait a minute.", code: "rate" }, 429);
    if (path === "/api/auth/signup") {
      // The answer says whether the gift came, and a gifted browser keeps a mark of it (src/abuse.ts). Where the browser
      // came from becomes the account's attribution row, and its first-touch cookie goes (src/studio/attribution.ts).
      const from = arrivalOf(request);
      const made = await signUp(env, b, visitorOf(request), from);
      const res = await signedIn(env, made.userId, { ok: true, gift: made.gifted, ...(made.gifted ? {} : { note: NO_GIFT_SENTENCE }) });
      if (made.gifted) res.headers.append("set-cookie", giftCookie());
      if (from.hadCookie) res.headers.append("set-cookie", clearTouchCookie());
      ctx.waitUntil(recordIp(env, made.userId, "signup", request));
      return res;
    }
    // Where each sign-in came from is kept 90 days (src/studio/ips.ts), for the admin console.
    const signedInHere = async (id: string) => { const res = await signedIn(env, id); ctx.waitUntil(recordIp(env, id, "signin", request)); return res; };
    if (path === "/api/auth/signin") return signedInHere(await signIn(env, b));
    if (path === "/api/auth/key") return signedInHere(await signInWithKey(env, String(b.key ?? "")));
    if (path === "/api/auth/forgot") { ctx.waitUntil(forgotPassword(env, b, origin)); return json({ ok: true }); }
    if (path === "/api/auth/reset") return signedInHere(await resetPassword(env, b));
    return json({ error: "Not found." }, 404);
  }

  const userId = await sessionUser(env, request);
  if (!userId) return json({ error: "Please sign in.", code: "signin" }, 401);

  // THE ADMIN CONSOLE (23 October 2026, src/studio/admin.ts): on the admin host only (whose every request carried the
  // owner's certificate), for the accounts in STUDIO_ADMINS only, checked here on the session; to anybody else it does
  // not exist. Its reads want the X-Kleo header too.
  if (path.startsWith("/api/admin/")) {
    if (!adminHost || !isAdmin(env, userId)) return json({ error: "Not found." }, 404);
    if (request.headers.get("x-kleo") !== "1") return json({ error: "Forbidden" }, 403);
    return adminApi(env, request, url, userId);
  }

  // ONE ACCOUNT EVERYWHERE (19 October 2026, src/connect.ts): this account finishes an assistant's connection, and takes in
  // the old anonymous account that came with it, credits and films included.
  if (path === "/api/connect" && method === "POST") {
    const r = await studioConnect(asEnv(env), userId, await body(request));
    if (!("error" in r)) ctx.waitUntil(recordIp(env, userId, "connect", request));
    return "error" in r ? json({ error: r.error, code: r.code ?? "connect" }, 400) : json(r);
  }
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
    const paid = (await hasPaid(asEnv(env), userId)) || isAdmin(env, userId);
    return json({
      ...info, paid, admin: isAdmin(env, userId), adminUrl: isAdmin(env, userId) ? adminUrl(env) : undefined, allowed: paid ? publicCatalog().map((m: any) => m.key) : freeModels(env.STUDIO_FREE_MODELS),
      freeResolutions: paid ? null : freeResolutions(env.STUDIO_FREE_RESOLUTIONS),
      allowedImages: (paid ? IMAGE_MODELS.map((m) => m.key) : freeImageModels(env.STUDIO_FREE_IMAGE_MODELS)).filter((k) => !pausedImageModels(env.STUDIO_PAUSED_IMAGE_MODELS).includes(k)), packs: packsFor(env, userId),
      allowedTools: paid ? freeTools("*") : freeTools(env.STUDIO_FREE_TOOLS),
      // Templates in 720p and 1080p (src/studio/generate.ts hasActivePlan): a running plan, or an admin.
      hdTemplates: await hasActivePlan(env, userId),
      // Monthly plans (src/plans.ts): the buy links with this account tied in, and the plan it is on now.
      plans: publicPlans(env.STRIPE_PLAN_LINKS, await planRef(env.INTERNAL_SECRET, userId)), plan: await planOf(env, userId),
      // Copyright refusals made on Wan 3.0 by themselves (generate.ts switchToWan).
      autoWan: await autoWanOn(env, userId),
      // A place in Kleo Creators, for the menu (src/studio/creators.ts).
      creator: await env.DB.prepare("SELECT status, level FROM creators WHERE user_id = ?").bind(userId).first<{ status: string; level: string }>().catch(() => null),
    });
  }
  // Apple Pay / Google Pay inside the app (src/studio/pay.ts): the Checkout Session a phone's wallet button pays.
  if (path === "/api/pay/session" && method === "POST") {
    const b = await body<{ pack?: unknown; plan?: unknown; tier?: unknown; period?: unknown }>(request);
    const u = await getUser(asEnv(env), userId);
    const s = await createPaySession(env, userId, (u as { email?: string | null } | null)?.email ?? null, b, origin);
    await audit(asEnv(env), userId, null, "pay.session", { label: s.label, cents: s.cents });
    ctx.waitUntil(recordIp(env, userId, "pay", request));
    return json(s);
  }
  // ── Kleo Creators (src/studio/creators.ts) ──
  if (path === "/api/creators/me" && method === "GET") return json(await creatorStatus(env, userId));
  if (path === "/api/creators/apply" && method === "POST") return json(await applyAsCreator(env, userId, await body(request)));
  if (path === "/api/creators/posts" && method === "POST") return json(await addPost(env, userId, await body(request)));
  const cpM = path.match(/^\/api\/creators\/posts\/(cp_[a-z0-9]+)$/);
  if (cpM && method === "DELETE") { await removePost(env, userId, cpM[1]); return json(await creatorStatus(env, userId)); }
  if (path === "/api/creators/payout" && method === "POST") { await setPayout(env, userId, await body(request)); return json(await creatorStatus(env, userId)); }
  if (path === "/api/creators/leave" && method === "POST") {
    if ((await body(request)).confirm !== true) throw new StudioError("Confirm that you want to leave.", 400, "confirm");
    await leaveProgram(env, userId);
    return json(await creatorStatus(env, userId));
  }
  if (path === "/api/me/auto-wan" && method === "POST") {
    const on = (await body<{ on?: boolean }>(request)).on === true;
    await setAutoWan(env, userId, on);
    await audit(asEnv(env), userId, null, "studio.auto_wan", { on });
    return json({ autoWan: on });
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
    const paid = (await hasPaid(asEnv(env), userId)) || isAdmin(env, userId);
    const allowed = paid ? (publicCatalog().map((m: any) => m.key) as any) : freeModels(env.STUDIO_FREE_MODELS);
    const allowedImages = (paid ? IMAGE_MODELS.map((m) => m.key) : freeImageModels(env.STUDIO_FREE_IMAGE_MODELS)).filter((k) => !pausedImageModels(env.STUDIO_PAUSED_IMAGE_MODELS).includes(k));
    const reply = await runAgent(env, {
      history, text, uploads, ui: b.settings ?? {}, uiImage: b.imageSettings ?? {}, mode: b.mode === "image" ? "image" : "video",
      credits: user.credits, allowed, allowedImages, margin: marginOf(env), videoFactor: videoFactorOf(env), freeResolutions: paid ? undefined : freeResolutions(env.STUDIO_FREE_RESOLUTIONS),
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
    const b = await body<{ chatId?: string; proposalId?: string; prompt?: string; settings?: Record<string, unknown>; imageIds?: string[]; kind?: string; preset?: string; noChat?: boolean; engine?: string }>(request);
    // After the name check asked: the person's choice (generate.ts createGeneration).
    const engine = b.engine === "wan" || b.engine === "seedance" ? b.engine : null;
    if (b.noChat && !b.proposalId) {
      // The Video and Image pages: a generation with no conversation around it.
      const g = await createGeneration(env, userId, { kind: b.kind === "image" ? "image" : "video", prompt: String(b.prompt ?? ""), settings: b.settings ?? {}, imageIds: Array.isArray(b.imageIds) ? b.imageIds : [], chatId: null, messageId: null, preset: b.preset ?? null, engine }, origin);
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
      : await createGeneration(env, userId, { kind, prompt, settings, imageIds, chatId, messageId: proposalMsg?.id ?? userMsgId, preset, engine }, origin);
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
    return json({ settings: s, credits: clipCredits(s, marginOf(env), secs, videoFactorOf(env)) });
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
      const factor = toolFactor(tool.key, videoFactorOf(env));
      // A template's price is told in full only to whoever can make it (25 October 2026): an account that never paid,
      // or one without a plan asking for 720p or 1080p, is told the 480p price only, and what opens the rest.
      if (tool.group === "trend") {
        const paid = (await hasPaid(asEnv(env), userId)) || isAdmin(env, userId);
        const hd = templateIsHd(tool.key, inputs);
        if (!paid || (hd && !(await hasActivePlan(env, userId)))) {
          const low = planTool(tool.key, { ...inputs, quality: "480p" }, media);
          return json({ credits: null, from: toolCredits(low.usd, marginOf(env), factor), locked: paid ? "plan" : "pack", summary: low.summary });
        }
      }
      return json({ credits: toolCredits(plan.usd, marginOf(env), factor), summary: plan.summary, estimate: !!plan.speech });
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
  const genM = path.match(/^\/api\/generations\/(g_[a-z0-9]+)(\/share|\/wan|\/describe)?$/);
  if (genM) {
    let g = await getGeneration(env, genM[1]);
    if (!g || g.user_id !== userId) return json({ error: "Not found." }, 404);
    if ((genM[2] === "/wan" || genM[2] === "/describe") && method === "POST") {
      // A creation refused for copyright: "/wan" makes the clip again on Wan 3.0, "/describe" makes it again with its
      // names turned into descriptions; {decline: true} drops the offer.
      const wan = genM[2] === "/wan";
      if ((await body<{ decline?: boolean }>(request)).decline === true) return json({ original: publicGeneration(await (wan ? declineWan : declineRewrite)(env, userId, g)) });
      const made = await (wan ? retryOnWan : retryDescribed)(env, userId, g, origin);
      // In a chat the new clip comes as Kleo's next message, under the refused one.
      let message: Record<string, unknown> | null = null;
      if (g.chat_id) {
        const botId = rid("m", 12);
        await addMessage(env, { id: botId, chatId: g.chat_id, userId, role: "assistant", text: "", data: { generation: made.id } });
        await touchChat(env, g.chat_id);
        message = (await messagesWithClips(env, g.chat_id)).find((m) => m.id === botId) ?? null;
      }
      const user = await getUser(asEnv(env), userId);
      return json({ generation: publicGeneration(made), original: publicGeneration((await getGeneration(env, g.id))!), message, credits: user?.credits ?? 0 });
    }
    if (genM[2] === "/share" && method === "POST") {
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

/**
 * admin.kleooai.com (src/studio/admin-host.ts): the owner's client certificate first, on every request, then only the
 * console: its page and files, media previews, its API and its sign-in. Everything else is 404 there.
 */
async function adminSite(request: Request, env: StudioEnv, ctx: ExecutionContext, url: URL): Promise<Response> {
  const why = certProblem(env, request);
  // No certificate at all: most often the browser reused the app's connection; 421 sends it to a connection of its own.
  if (why === "no_cert") return misdirected();
  if (why) { ctx.waitUntil(noteRefused(env, request, why)); return refused(); }
  const p = url.pathname;
  if (p === "/") return Response.redirect(url.origin + "/admin", 302);
  if (!ADMIN_SITE_PATH.test(p)) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    if (p.startsWith("/api/") || p.startsWith("/media/")) await ensureStudioSchema(env);
    if (p.startsWith("/api/")) return await api(env, request, url, ctx, true);
    if (p.startsWith("/media/")) return await handleMedia(env, request, url);
  } catch (e) {
    return fail(e);
  }
  return appAsset(request, env, url);
}

/**
 * A browser's first page of the app gets the first-touch cookie, and the visit is counted (src/studio/attribution.ts).
 * Only pages: scripts, pictures and the site behind the app never set it.
 */
function withFirstVisit(env: StudioEnv, request: Request, url: URL, ctx: ExecutionContext, res: Response): Response {
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  const cookie = firstVisit(env, request, url, ctx);
  if (!cookie) return res;
  const out = new Response(res.body, res);
  out.headers.append("set-cookie", cookie);
  return out;
}

/** The single-page app: real files as they are, every other path gets index.html (client-side routes). */
async function appAsset(request: Request, env: StudioEnv, url: URL): Promise<Response> {
  let asset = await env.ASSETS.fetch(request);
  if (asset.status === 404 && request.method === "GET") asset = await env.ASSETS.fetch(new Request(new URL("/", url).toString(), request));
  // The page itself is never cached, so a release reaches everybody on the next load (its scripts carry ?v=).
  if ((asset.headers.get("content-type") ?? "").includes("text/html")) {
    asset = new Response(asset.body, asset);
    asset.headers.set("cache-control", "no-store");
  }
  return asset;
}

async function route(request: Request, env: StudioEnv, ctx: ExecutionContext, url: URL, adminHost: boolean): Promise<Response> {
  if (adminHost) return adminSite(request, env, ctx, url);
  // One address for the app: www and the old app.kleooai.com send people to the canonical host.
  const canonical = (env.CANONICAL_HOST ?? "").trim();
  if (canonical && url.hostname !== canonical && (url.hostname === `www.${canonical}` || url.hostname.startsWith("app."))) {
    return Response.redirect(`https://${canonical}${url.pathname}${url.search}`, 301);
  }
  // A short link (src/studio/attribution.ts): the click is counted, the visit tagged, and the link's page opened. Whatever
  // goes wrong, the person still lands in the app.
  const short = url.pathname.match(SHORT_LINK_PATH);
  if (short) {
    try {
      await ensureStudioSchema(env);
      return await shortLink(env, request, url, short[1], ctx);
    } catch (e) {
      console.error("studio short link", e instanceof Error ? e.message : e);
      return new Response(null, { status: 302, headers: { location: "/", "cache-control": "no-store" } });
    }
  }
  // The welcome e-mails' unsubscribe link (src/studio/onboarding.ts): its signature is the authorisation, and the mail
  // client's one-click POST comes without the page's header or any cookie.
  if ((url.pathname === "/email/stop" || url.pathname === "/email/out") && (request.method === "GET" || request.method === "POST")) {
    try {
      await ensureStudioSchema(env);
      return url.pathname === "/email/out" ? await handleOutreachStop(env, request, url) : await handleStop(env, request, url);
    } catch (e) {
      return fail(e);
    }
  }
  // Everything that is not the app is the Kleo site (kleooai.com/mcp, /pricing/, /guides/…). The admin console does not
  // exist on this host: its paths get the site's 404, like any page that is not there.
  if (!APP_PATH.test(url.pathname) || CONSOLE_PATH.test(url.pathname)) {
    try { return await serveSite(request, url); } catch { return new Response("The site is not reachable right now.", { status: 502 }); }
  }
  try {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/") || url.pathname.startsWith("/auth/")) await ensureStudioSchema(env);
    // The owner's "it's topped up" link from an alert e-mail (src/studio/providers.ts): its signature is the authorisation,
    // so it is answered before api(), whose POSTs need the page's own header.
    // The owner's own preview of the welcome e-mails, sent to the Email Routing address only (src/studio/onboarding.ts):
    // for scripts on the owner's machine, with the INTERNAL_SECRET as bearer, like the MCP server's admin routes.
    if (url.pathname === "/api/internal/mail/preview" && request.method === "POST") {
      const auth = request.headers.get("authorization") ?? "";
      if (!env.INTERNAL_SECRET || !safeEqual(auth, `Bearer ${env.INTERNAL_SECRET}`)) return json({ error: "Not found." }, 404);
      return json(await sendSeriesToOwner(env, livePrices(env)));
    }
    const resume = url.pathname.match(/^\/api\/provider-resume\/(ephone|wavespeed|apimart)$/);
    if (resume && (request.method === "GET" || request.method === "POST")) {
      const signed = await checkSignedPath(env.INTERNAL_SECRET, url.pathname, url.searchParams.get("exp"), url.searchParams.get("sig"));
      return await handleProviderResume(env, request, url, resume[1] as Provider, signed);
    }
    if (url.pathname.startsWith("/api/")) return await api(env, request, url, ctx);
    if (url.pathname.startsWith("/media/")) return await handleMedia(env, request, url);
    const social = url.pathname.match(/^\/auth\/(google|microsoft|apple)(\/callback)?$/);
    if (social) {
      const key = social[1] as SocialKey;
      if (!socialEnabled(env, key)) return Response.redirect(`${url.origin}/`, 302);
      if (!social[2]) return socialStart(env, key, url.origin, url.searchParams.get("link") === "1");
      if (request.method === "POST" && key !== "apple") return json({ error: "Not found." }, 404);
      return await socialCallback(env, key, request, url.origin, await sessionUser(env, request), visitorOf(request));
    }
    if (url.pathname === "/health") return json({ ok: true, service: "kleo-studio" });
  } catch (e) {
    return fail(e);
  }
  return withFirstVisit(env, request, url, ctx, await appAsset(request, env, url));
}

export default {
  async fetch(request: Request, env: StudioEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const toHttps = httpsRedirect(url);
    if (toHttps) return toHttps;
    // The admin host: its own CSP, never indexed, never cached (src/studio/admin-host.ts).
    const adminHost = isAdminHost(env, url.hostname);
    const app = APP_PATH.test(url.pathname) && !CONSOLE_PATH.test(url.pathname);
    // The keys changed in the admin console replace the Worker secrets (src/key-overrides.ts). A request the admin host
    // refuses for its certificate is answered before even that read.
    const keyed = adminHost && certProblem(env, request) ? env : await withKeys(env);
    return secureResponse(await route(request, keyed, ctx, url, adminHost), { site: !adminHost && !app, admin: adminHost });
  },

  async scheduled(_event: ScheduledController, raw: StudioEnv, ctx: ExecutionContext): Promise<void> {
    const env = await withKeys(raw);
    await ensureStudioSchema(env);
    // What each provider can still spend, so an order it cannot pay for stops before the charge (providers.ts).
    ctx.waitUntil(refreshBalances(env));
    const rows = await staleGenerations(env, 20, 25);
    for (const g of rows) {
      try { await refreshGeneration(env, g, 15); } catch (e) { console.error("studio cron", g.id, e instanceof Error ? e.message : e); }
    }
    // The payment e-mails, every minute, so a buyer hears within one (src/studio/receipts.ts).
    try { await receiptsTick(env); } catch (e) { console.error("studio receipts", e instanceof Error ? e.message : e); }
    // The welcome e-mails that are due, every 5 minutes, when the owner switched them on (src/studio/onboarding.ts).
    if (new Date(_event.scheduledTime || Date.now()).getUTCMinutes() % 5 === 2) {
      try { await mailTick(env, livePrices(env)); } catch (e) { console.error("studio mail", e instanceof Error ? e.message : e); }
    }
    // Outreach, two minutes later: the mailbox's replies every quarter of an hour, one e-mail at most (outreach.ts).
    if (new Date(_event.scheduledTime || Date.now()).getUTCMinutes() % 5 === 4) {
      try { await outreachTick(env); } catch (e) { console.error("studio outreach", e instanceof Error ? e.message : e); }
      // The owner's morning e-mail about both, at 8:00 in Auckland (src/studio/digest.ts).
      try { await morningDigest(env); } catch (e) { console.error("studio digest", e instanceof Error ? e.message : e); }
    }
    // The scout, every minute: one search at most and a few websites checked, while the owner keeps it on (scout.ts).
    try { await scoutTick(env, await settingsOf(env)); } catch (e) { console.error("studio scout", e instanceof Error ? e.message : e); }
    // Kleo Creators, once an hour: commissions, program credits that expire, the month's grants and judgement (creators.ts).
    if (new Date(_event.scheduledTime || Date.now()).getUTCMinutes() === 23) {
      try { await creatorsTick(env); } catch (e) { console.error("studio creators", e instanceof Error ? e.message : e); }
    }
    // Sign-in addresses older than 90 days go, once an hour (src/studio/ips.ts; the privacy page promises it).
    if (new Date(_event.scheduledTime || Date.now()).getUTCMinutes() === 17) {
      try { await pruneIps(env); } catch (e) { console.error("studio ip prune", e instanceof Error ? e.message : e); }
    }
  },
};
