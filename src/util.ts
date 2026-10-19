export function rid(prefix: string, len = 10): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${prefix}_${s}`;
}

export const nowIso = (): string => new Date().toISOString();
export const addMinutes = (iso: string, m: number): string => new Date(new Date(iso).getTime() + m * 60_000).toISOString();
export const addDays = (iso: string, d: number): string => addMinutes(iso, d * 24 * 60);
export const minutesSince = (iso: string): number => (Date.now() - new Date(iso).getTime()) / 60_000;
export const secondsSince = (iso: string): number => (Date.now() - new Date(iso).getTime()) / 1000;

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

export const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export const int = (v: string | undefined, d: number): number => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : d;
};
export const num = (v: string | undefined, d: number): number => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : d;
};

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * THE PUBLIC WORDS (26 September 2026, the owner's rule): nothing a user or their assistant reads names the gateways
 * Kleo buys its models through. The sentences Kleo writes itself say "the video model", "the model provider" or "the
 * AI model gateway"; this is the net under them, for the free text a provider or a box sends back (a task's failure
 * reason, an HTTP error quoted into a job's error). A provider URL goes with its method; the key names go too.
 * Audit rows, admin routes and logs keep the real names: they are the operator's.
 */
export function publicText(s: string): string {
  return s
    .replace(/\b(?:kie\.ai|ephone\.ai)\s+(?:GET|POST|PUT|DELETE)\s+\S+/gi, "the model provider")
    .replace(/https?:\/\/[^\s"'<>)]*(?:kie\.ai|ephone\.ai)[^\s"'<>)]*/gi, "the model provider")
    .replace(/\b(?:KIE|EPHONE)_API_KEY\b/g, "the provider key")
    .replace(/\bkie\.ai's\b/gi, "the model provider's")
    .replace(/\bkie\.ai\b/gi, "the model provider")
    .replace(/\bePhone(?:\s+AI|\.ai)?'s\b/gi, "the AI model gateway's")
    .replace(/\bePhone(?:\s+AI|\.ai)?\b/gi, "the AI model gateway")
    // A provider's request id (ByteDance's run 50 characters with no space) means nothing to a person and broke the
    // card on a phone (19 October 2026): it stays in the audit, never in the sentence.
    .replace(/\s*Request id:\s*[0-9a-z-]{12,}\.?/gi, "");
}

/**
 * A browser POST that ANOTHER site started (14 October 2026, the security review): the login-CSRF guard of the forms
 * that bind a browser to an account (/authorize sets the kleo_id cookie, /credits writes to the account). A page on
 * any site can auto-submit a form to them, and the cookie the answer sets would then put the victim's browser on the
 * attacker's account. `Sec-Fetch-Site` is what every current browser sends: only "same-origin" (Kleo's own form) and
 * "none" (typed, a bookmark) are ours. A browser too old for it is judged by `Origin`, which it always sends on a
 * cross-site form POST ("null" from a sandboxed frame counts as foreign). A request with neither header (curl, the
 * e2e scripts, Node's fetch) is no victim's browser riding on its cookies, so it passes.
 */
export function crossSiteRequest(request: Request): boolean {
  const site = (request.headers.get("sec-fetch-site") ?? "").trim().toLowerCase();
  if (site) return site !== "same-origin" && site !== "none";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try { return origin.trim() !== new URL(request.url).origin; } catch { return true; }
}
