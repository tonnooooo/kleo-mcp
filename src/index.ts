import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Env, AuthProps } from "./env";
import { getUser, touchUser, audit } from "./db";
import { mcpHandlerFor } from "./mcp";
import { handleAuthorize } from "./auth";
import { handleInternal, handleDevPlan, handleAdmin } from "./internal";
import { handleCredits } from "./credits";
import { handleStripeWebhook } from "./stripe";
import { handleDownload } from "./dl";
import { handleUpload } from "./upload.ts";
import { handleProbe } from "./probe.ts";
import { tick } from "./orchestrator";
import { json } from "./util";
import { ensureSchema } from "./schema";

/** /mcp — only reached with a valid OAuth token; the provider puts the token props on ctx.props. */
const mcpApi: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    await ensureSchema(env);
    const props = (ctx as ExecutionContext & { props?: AuthProps }).props;
    if (!props?.userId) return json({ error: "unauthorized" }, 401);
    if (request.method === "POST") ctx.waitUntil(tick(env).catch(() => undefined)); // progress also without cron
    const user = await getUser(env, props.userId);
    if (!user) return json({ error: "account not found; reconnect Kleo" }, 401);
    ctx.waitUntil(touchUser(env, user.id));
    const base = new URL(request.url).origin; // links use the address the client actually reached us on
    const handler = mcpHandlerFor(env, user, base);
    try {
      return await handler.fetch(request);
    } finally {
      ctx.waitUntil(handler.close());
    }
  },
};

/** Everything that is not the authenticated MCP endpoint. */
const app: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    await ensureSchema(env);
    if (p === "/internal/dev/plan") return handleDevPlan(request, env);
    // Before handleInternal (whose router only knows /internal/jobs/… and /internal/pool/claim) and before the tick
    // it fires: pressing "pause" must not start one last GPU on its way in.
    // The probe's uploads (src/probe.ts) carry their own auth: an expiring capability the rented box can hold instead
    // of INTERNAL_SECRET, so they are routed before the admin router, whose only key is the secret itself.
    if (p.startsWith("/internal/admin/probe/")) return handleProbe(request, env);
    if (p.startsWith("/internal/admin/")) return handleAdmin(request, env);
    if (p === "/authorize") return handleAuthorize(request, env);
    if (p === "/credits") return handleCredits(request, env);
    // Deliberately OUTSIDE the /internal/ branch below: that one fires ctx.waitUntil(tick(env)), and a payment
    // webhook must not have the power to start renting a GPU. It also needs no auth of its own — the Stripe
    // signature IS the authentication, checked before anything is parsed.
    if (p === "/stripe/webhook") return handleStripeWebhook(request, env);
    if (p.startsWith("/internal/")) {
      const r = await handleInternal(request, env);
      // Progress also without the cron, but only for a call that proved it is one of ours: /internal/ is open to the
      // internet, and an unauthenticated request must not be able to drive the orchestrator (and the Vast API) at will.
      if (r.status !== 401 && r.status !== 404) ctx.waitUntil(tick(env).catch(() => undefined));
      return r;
    }
    if (p.startsWith("/dl/")) return handleDownload(request, env);
    // The upload page (24 September 2026, src/upload.ts): signed links from kleo_upload_link, where a user drops the
    // pictures Kleo should draw from. Outside /internal/ on purpose: an upload must never be able to start a tick.
    if (p.startsWith("/upload/")) return handleUpload(request, env);
    if (p === "/health") return json({ ok: true, backend: env.RENDER_BACKEND, time: new Date().toISOString() });
    if (p === "/mcp") return json({ error: "unauthorized" }, 401, { "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"` });
    if (p === "/") {
      return json({
        name: "Kleo", description: "Remote MCP server that renders YouTube videos and Shorts.",
        mcp_endpoint: `${url.origin}/mcp`, transport: "streamable-http", auth: "oauth2.1",
        connect: { claude: "Settings → Connectors → Add custom connector", claude_code: `claude mcp add --transport http kleo ${url.origin}/mcp`, cursor: { mcpServers: { kleo: { url: `${url.origin}/mcp` } } } },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApi as any,
  defaultHandler: app as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["video:create", "video:read"],
  accessTokenTTL: 3600,
  clientIdMetadataDocumentEnabled: true, // Claude.ai and ChatGPT can identify themselves via CIMD (needs global_fetch_strictly_public)
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil((async () => {
      try {
        await ensureSchema(env);
        const stats = await tick(env, { plan: true });
        await audit(env, null, null, "cron.tick", stats);
      } catch (e) {
        try { await audit(env, null, null, "cron.error", String(e).slice(0, 300)); } catch { /* ignore */ }
      }
    })());
  },
} satisfies ExportedHandler<Env>;
