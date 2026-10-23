/**
 * KLEO STUDIO — THE SITE BEHIND IT (14 October 2026). The owner's layout, like higgsfield.ai: kleooai.com IS the app
 * (chat, Video, Image, Audio, Apps, Library), and the MCP site moves to kleooai.com/mcp, its other pages (pricing,
 * guides, examples, connect…) keeping their addresses.
 *
 * The site stays where it is written: the kleo-site repository. This Worker answers every path that is not the app
 * with the file from that repository's main branch (cached at the edge), with the right content type and, for videos,
 * byte ranges (iPhones refuse a video that cannot seek). /mcp and /mcp/ are the site's home page.
 */

export const SITE_ORIGIN = "https://raw.githubusercontent.com/tonnooooo/kleo-site/main";

/** Paths the app answers; everything else is the site. */
export const APP_PATH = /^\/(?:$|video(?:\/(?:edit|motion))?$|image$|audio$|explore$|account$|showcase\.json$|apps(?:\/[a-z0-9-]*)?$|templates$|library$|connect$|plans$|c\/[a-z0-9_]+$|reset$|admin(?:\/[a-z0-9_-]+){0,2}$|api\/|media\/|auth\/|health$|(?:app|admin)\.(?:js|css)$|qr\.js$|manifest\.webmanifest$|kleo-(?:mark|favicon)\.svg$|kleo-icon-dark-(?:192|512)\.png$)/;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8", txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", ico: "image/x-icon", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav",
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", webmanifest: "application/manifest+json", pdf: "application/pdf",
};
const extOf = (p: string): string => /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase() ?? "";

/**
 * The repository file a site address stands for. Only what a visitor's browser needs is served (14 October 2026):
 * the extensions in TYPES, never a dot-folder or dot-file (.github, .gitignore — .well-known excepted), never the
 * repository's tooling (tools/, README, Markdown). Everything else is the 404 page, as if it did not exist.
 */
export function sitePath(pathname: string): string {
  let p: string;
  try { p = decodeURIComponent(pathname); } catch { return "/404.html"; }
  // kleooai.com/mcp is the connect page (kleo-site mcp/index.html, 14 October 2026), like higgsfield.ai/mcp.
  if (p === "/mcp" || p === "/mcp/") return "/mcp/index.html";
  if (p.includes("..") || p.includes("\\") || p.includes("\0")) return "/404.html";
  const parts = p.split("/").filter(Boolean);
  if (parts.some((x, i) => x.startsWith(".") && !(i === 0 && x === ".well-known"))) return "/404.html";
  if (parts[0] === "tools" || /^readme/i.test(parts[parts.length - 1] ?? "")) return "/404.html";
  if (p.endsWith("/")) p += "index.html";
  const ext = extOf(p);
  if (ext && !TYPES[ext] && parts[0] !== ".well-known") return "/404.html";
  return p;
}

async function fromRepo(path: string, long: boolean): Promise<Response> {
  return fetch(SITE_ORIGIN + path.split("/").map(encodeURIComponent).join("/"), {
    cf: { cacheTtl: long ? 86_400 : 300, cacheEverything: true },
  } as RequestInit);
}

export async function serveSite(request: Request, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  let path = sitePath(url.pathname);
  let ext = extOf(path);
  const media = ["mp4", "webm", "mov", "mp3", "wav", "png", "jpg", "jpeg", "webp", "gif", "avif", "woff2", "woff"].includes(ext);
  let res = await fromRepo(path, media);
  if (res.status === 404 && !ext) {
    // "/pricing" is the folder "/pricing/": say so, the way a static host does.
    const dir = await fromRepo(`${path}/index.html`, false);
    if (dir.ok) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  }
  // A blocked or unknown path is answered by the 404 page, with the 404 status (sitePath returns "/404.html" for it).
  let status = path === "/404.html" ? 404 : res.status;
  if (status === 404) { path = "/404.html"; ext = "html"; res = await fromRepo(path, false); status = 404; }
  if (!res.ok && status !== 404) return new Response("The site is not reachable right now.", { status: 502 });
  const headers = new Headers({
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "cache-control": ext === "html" ? "public, max-age=60" : media ? "public, max-age=86400" : "public, max-age=300",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  });
  const range = request.headers.get("range");
  if (range && ["mp4", "webm", "mov", "mp3", "wav"].includes(ext)) {
    const all = new Uint8Array(await res.arrayBuffer());
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const size = all.byteLength;
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      headers.set("content-range", `bytes ${start}-${end}/${size}`);
      headers.set("content-length", String(end - start + 1));
      return new Response(request.method === "HEAD" ? null : all.slice(start, end + 1), { status: 206, headers });
    }
  }
  return new Response(request.method === "HEAD" ? null : res.body, { status, headers });
}
