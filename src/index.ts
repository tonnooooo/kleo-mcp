import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Env, AuthProps } from "./env";
import { getUser, touchUser } from "./db";
import { mcpHandlerFor } from "./mcp";
import { handleAuthorize } from "./auth";
import { handleInternal } from "./internal";
import { handleDownload } from "./dl";
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
    if (p.startsWith("/internal/")) ctx.waitUntil(tick(env).catch(() => undefined));
    if (p === "/authorize") return handleAuthorize(request, env);
    if (p.startsWith("/internal/")) return handleInternal(request, env);
    if (p.startsWith("/dl/")) return handleDownload(request, env);
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
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => { ctx.waitUntil(ensureSchema(env).then(() => tick(env))); },
} satisfies ExportedHandler<Env>;
