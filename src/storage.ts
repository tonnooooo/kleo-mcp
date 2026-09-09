import type { Env } from "./env";

/**
 * File store: R2 when the binding exists (production), otherwise KV (temporary accounts, small mock files).
 * Keys look like renders/<job>/<file>. KV values are capped at 20 MB, which is fine for the mock backend only.
 */
const KV_PREFIX = "file:";
const KV_MAX = 20 * 1024 * 1024;

export interface StoredFile { body: ReadableStream | ArrayBuffer; size: number; contentType: string; etag: string; range?: { offset: number; length: number } }

export const hasR2 = (env: Env): boolean => !!env.RENDERS;

export async function putFile(env: Env, key: string, body: ArrayBuffer | Uint8Array | string | ReadableStream, contentType: string): Promise<number> {
  if (env.RENDERS) {
    const obj = await env.RENDERS.put(key, body as any, { httpMetadata: { contentType } });
    return obj?.size ?? 0;
  }
  let buf: ArrayBuffer;
  if (typeof body === "string") buf = new TextEncoder().encode(body).buffer as ArrayBuffer;
  else if (body instanceof ReadableStream) buf = await new Response(body).arrayBuffer();
  else if (body instanceof Uint8Array) buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  else buf = body;
  if (buf.byteLength > KV_MAX) throw new Error(`file too large for KV storage (${buf.byteLength} bytes); configure an R2 bucket`);
  await env.OAUTH_KV.put(KV_PREFIX + key, buf, { metadata: { contentType, size: buf.byteLength } });
  return buf.byteLength;
}

export async function getFile(env: Env, key: string, rangeHeader: string | null): Promise<StoredFile | null> {
  if (env.RENDERS) {
    const headers = new Headers();
    if (rangeHeader) headers.set("range", rangeHeader);
    const obj = await env.RENDERS.get(key, rangeHeader ? { range: headers } : undefined);
    if (!obj) return null;
    const range = rangeHeader && obj.range && "offset" in obj.range ? { offset: obj.range.offset ?? 0, length: obj.range.length ?? obj.size - (obj.range.offset ?? 0) } : undefined;
    return { body: obj.body, size: obj.size, contentType: obj.httpMetadata?.contentType ?? "application/octet-stream", etag: obj.httpEtag, range };
  }
  const r = await env.OAUTH_KV.getWithMetadata<{ contentType?: string; size?: number }>(KV_PREFIX + key, "arrayBuffer");
  if (!r.value) return null;
  const size = r.value.byteLength;
  let body: ArrayBuffer = r.value, range: StoredFile["range"];
  const m = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/);
  if (m) {
    const start = parseInt(m[1], 10), end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    body = r.value.slice(start, end + 1);
    range = { offset: start, length: end - start + 1 };
  }
  return { body, size, contentType: r.metadata?.contentType ?? "application/octet-stream", etag: `"kv-${size}"`, range };
}

export async function deleteFile(env: Env, key: string): Promise<void> {
  if (env.RENDERS) await env.RENDERS.delete(key);
  else await env.OAUTH_KV.delete(KV_PREFIX + key);
}
