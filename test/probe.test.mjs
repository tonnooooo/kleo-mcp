/**
 * Unit tests for src/probe.ts: an A/B probe's outputs stored as extra files of a finished job (25 September 2026,
 * scripts/sr-ab.py), the capability the rented box holds instead of INTERNAL_SECRET, and the /dl round trip of a
 * signed link to one of them. In-memory env, no network. Run: node --test test/probe.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleProbe, probeUploadSig, PROBE_NAME_RE, PROBE_TOKEN_MAX_S } from "../src/probe.ts";
import { handleDownload } from "../src/dl.ts";
import { resultLinks } from "../src/jobs.ts";
import { hmacHex } from "../src/util.ts";

function fakeEnv({ r2 = false } = {}) {
  const files = new Map(), jobs = new Map(), kv = new Map(), objects = new Map(), auditRows = [];
  const db = {
    prepare(sql) {
      return {
        args: [], bind(...a) { this.args = a; return this; },
        async run() {
          if (sql.startsWith("INSERT OR REPLACE INTO job_files")) files.set(this.args[1], { job_id: this.args[0], name: this.args[1], key: this.args[2], size: this.args[3], content_type: this.args[4] });
          else if (sql.startsWith("INSERT INTO audit")) auditRows.push({ job_id: this.args[1], event: this.args[2] });
          return { meta: { changes: 1 } };
        },
        async all() { return { results: sql.startsWith("SELECT * FROM job_files") ? [...files.values()].filter((f) => f.job_id === this.args[0]) : [] }; },
        async first() { return (sql.startsWith("SELECT * FROM jobs") ? jobs.get(this.args[0]) : null) ?? null; },
      };
    },
  };
  const RENDERS = r2 ? {
    async put(key, body) { const b = new Uint8Array(await new Response(body).arrayBuffer()); objects.set(key, b); return { size: b.byteLength }; },
    async createMultipartUpload(key) { return { uploadId: `up/${key.length}+x=` }; },
    resumeMultipartUpload(key, uid) {
      return {
        async uploadPart(n, buf) { objects.set(`${key}#${uid}#${n}`, buf); return { partNumber: n, etag: `e${n}` }; },
        async complete(parts) { const size = parts.reduce((s, p) => s + objects.get(`${key}#${uid}#${p.partNumber}`).byteLength, 0); return { size }; },
      };
    },
  } : undefined;
  const env = { DB: db, INTERNAL_SECRET: "s3cret", ...(RENDERS ? { RENDERS } : {}),
    OAUTH_KV: { async put(k, v, o) { kv.set(k, { v, o }); }, async getWithMetadata(k) { const e = kv.get(k); return { value: e?.v ?? null, metadata: e?.o?.metadata }; } } };
  jobs.set("gt_ujavdzva", { id: "gt_ujavdzva", user_id: "u1", state: "done", purged_at: null, expires_at: new Date(Date.now() + 86_400_000).toISOString(), params: "{}" });
  return { env, files, jobs, objects, auditRows };
}

const put = (env, path, body, headers = {}) => handleProbe(new Request(`http://kleo.test/internal/admin/probe/${path}`, { method: "PUT", body, headers }), env);
const bearer = { authorization: "Bearer s3cret" };

test("the operator's secret stores a file under probe/ of a finished job, recorded for /dl and never for the user", async () => {
  const { env, files, auditRows, jobs } = fakeEnv();
  const r = await put(env, "gt_ujavdzva/results.json", '{"ok":true}', bearer);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { ok: true, name: "probe/results.json", size: 11 });
  const f = files.get("probe/results.json");
  assert.equal(f.key, "renders/gt_ujavdzva/probe/results.json");
  assert.equal(f.content_type, "application/json");
  assert.ok(auditRows.some((a) => a.event === "admin.probe.file"));
  const links = await resultLinks(env, "http://kleo.test", jobs.get("gt_ujavdzva"));
  assert.deepEqual(Object.keys(links), [], "a probe file is never among the user's links");
});

test("the box's capability: one job, the probe/ prefix, expiring within a day", async () => {
  const { env } = fakeEnv();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3 * 3600;
  const sig = await probeUploadSig("s3cret", "gt_ujavdzva", exp);
  assert.equal(sig, await hmacHex("s3cret", `probe/gt_ujavdzva/${exp}`));
  assert.equal((await put(env, `gt_ujavdzva/contact.jpg?exp=${exp}&sig=${sig}`, "jpg")).status, 200);
  assert.equal((await put(env, `gt_ujavdzva/contact.jpg?exp=${exp}&sig=${"0".repeat(64)}`, "jpg")).status, 401, "a wrong signature");
  assert.equal((await put(env, `gt_other/contact.jpg?exp=${exp}&sig=${sig}`, "jpg")).status, 401, "another job's capability");
  const old = now - 10;
  assert.equal((await put(env, `gt_ujavdzva/contact.jpg?exp=${old}&sig=${await probeUploadSig("s3cret", "gt_ujavdzva", old)}`, "jpg")).status, 401, "expired");
  const far = now + PROBE_TOKEN_MAX_S + 3600;
  assert.equal((await put(env, `gt_ujavdzva/contact.jpg?exp=${far}&sig=${await probeUploadSig("s3cret", "gt_ujavdzva", far)}`, "jpg")).status, 401, "longer than a day");
  assert.equal((await put(env, "gt_ujavdzva/contact.jpg", "jpg")).status, 401, "no auth at all");
  assert.equal((await put(env, "gt_ujavdzva/contact.jpg", "jpg", { authorization: "Bearer nope" })).status, 401);
});

test("names are flat and land under probe/ only: a probe can never overwrite a delivered file", async () => {
  const { env } = fakeEnv();
  for (const bad of ["gt_ujavdzva/..%2Fvideo.mp4", "gt_ujavdzva/a/b.mp4", "gt_ujavdzva/.hidden", "gt_ujavdzva/"]) {
    assert.equal((await put(env, bad, "x", bearer)).status, 404, bad);
  }
  assert.ok(PROBE_NAME_RE.test("probe/split-4k60.mp4"));
  assert.ok(!PROBE_NAME_RE.test("video.mp4") && !PROBE_NAME_RE.test("probe/../video.mp4") && !PROBE_NAME_RE.test("probe/a/b"));
  assert.equal((await put(env, "gt_nope/results.json", "{}", bearer)).status, 404, "an unknown job");
});

test("a purged job takes no probe file", async () => {
  const { env, jobs } = fakeEnv();
  jobs.get("gt_ujavdzva").purged_at = new Date().toISOString();
  assert.equal((await put(env, "gt_ujavdzva/results.json", "{}", bearer)).status, 410);
});

test("a big clip goes up in parts on R2, and the finished file is recorded once", async () => {
  const { env, files } = fakeEnv({ r2: true });
  const start = await handleProbe(new Request("http://kleo.test/internal/admin/probe/gt_ujavdzva/film-B-4k60.mp4/uploads", { method: "POST", headers: bearer }), env);
  assert.equal(start.status, 200);
  const { uploadId } = await start.json();
  const parts = [];
  for (const [n, size] of [[1, 7], [2, 3]]) {
    const r = await handleProbe(new Request(`http://kleo.test/internal/admin/probe/gt_ujavdzva/film-B-4k60.mp4/uploads/${uploadId}/parts/${n}`, { method: "PUT", body: new Uint8Array(size), headers: bearer }), env);
    assert.equal(r.status, 200);
    parts.push(await r.json());
  }
  assert.equal(files.size, 0, "nothing recorded before the upload is complete");
  const done = await handleProbe(new Request(`http://kleo.test/internal/admin/probe/gt_ujavdzva/film-B-4k60.mp4/uploads/${uploadId}/complete`, { method: "POST", body: JSON.stringify({ parts }), headers: bearer }), env);
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { ok: true, name: "probe/film-B-4k60.mp4", size: 10 });
  assert.equal(files.get("probe/film-B-4k60.mp4").content_type, "video/mp4");
});

test("without an R2 bucket a multipart upload is refused, not half-done", async () => {
  const { env } = fakeEnv();
  const r = await handleProbe(new Request("http://kleo.test/internal/admin/probe/gt_ujavdzva/film-A-4k60.mp4/uploads", { method: "POST", headers: bearer }), env);
  assert.equal(r.status, 501);
});

test("/dl serves a probe file with a signed link, and refuses it unsigned", async () => {
  const { env } = fakeEnv();
  assert.equal((await put(env, "gt_ujavdzva/contact.jpg", "JPEGDATA", bearer)).status, 200);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = await hmacHex("s3cret", `gt_ujavdzva/probe/contact.jpg/${exp}`);
  const res = await handleDownload(new Request(`http://kleo.test/dl/gt_ujavdzva/probe%2Fcontact.jpg?exp=${exp}&sig=${sig}`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(await res.text(), "JPEGDATA");
  assert.equal((await handleDownload(new Request(`http://kleo.test/dl/gt_ujavdzva/probe%2Fcontact.jpg?exp=${exp}&sig=${"0".repeat(64)}`), env)).status, 403);
});
