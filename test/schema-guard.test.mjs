/**
 * The schema checks of both Workers (src/schema.ts ensureSchema, src/studio/store.ts ensureStudioSchema), 20 October
 * 2026: a check that never answers must not hang the requests after it. The check used to be one promise kept for the
 * isolate; on Cloudflare a promise started by one request never settles once that request is gone, and every later
 * /api/ call of the isolate waited on it with no CPU (the app stayed on its logo). Now it is a flag set after a check
 * passed, and each request runs its own check until then.
 * Run: node --test test/schema-guard.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

class Stmt {
  constructor(d1, sql) { this.d1 = d1; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  async run() { this.d1.calls.push(this.sql); const r = this.d1.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
  async all() { this.d1.calls.push(this.sql); return { results: this.d1.db.prepare(this.sql).all(...this.args) }; }
}
/** A D1 look-alike on node:sqlite that counts its statements and can be told to hang. */
class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); this.calls = []; this.hang = false; }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) {
    if (this.hang) return new Promise(() => {});
    const out = [];
    for (const s of stmts) out.push(/^\s*SELECT/i.test(s.sql) ? await s.all() : await s.run());
    return out;
  }
}
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`still waiting after ${ms} ms`)), ms))]);

test("Studio: a first check that never answers does not hang the next request; a passed check is not run again", async () => {
  const { ensureStudioSchema } = await import(`../src/studio/store.ts?fresh=${Date.now()}`);
  const DB = new FakeD1();
  DB.db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, credits INTEGER)");
  DB.hang = true;
  ensureStudioSchema({ DB }); // the request that started it is gone; its D1 call never answers
  DB.hang = false;
  await within(ensureStudioSchema({ DB }), 1000);
  const cols = DB.db.prepare("SELECT name FROM pragma_table_info('users')").all().map((r) => r.name);
  assert.ok(cols.includes("studio_auto_wan") && cols.includes("key_version"), "the missing columns were added");
  const n = DB.calls.length;
  await ensureStudioSchema({ DB });
  assert.equal(DB.calls.length, n, "a passed check makes no D1 call");
});

test("Studio: columns already there are not ALTERed again (one pragma batch instead of seven ALTERs)", async () => {
  const { ensureStudioSchema, STUDIO_SCHEMA, STUDIO_COLUMNS } = await import(`../src/studio/store.ts?fresh=${Date.now()}-b`);
  const DB = new FakeD1();
  DB.db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, credits INTEGER)");
  for (const sql of [...STUDIO_SCHEMA, ...STUDIO_COLUMNS]) DB.db.exec(sql);
  await ensureStudioSchema({ DB });
  assert.equal(DB.calls.filter((s) => /^ALTER/i.test(s)).length, 0);
});

test("Studio: a failed check is tried again by the next request", async () => {
  const { ensureStudioSchema } = await import(`../src/studio/store.ts?fresh=${Date.now()}-c`);
  const DB = new FakeD1();
  DB.db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, credits INTEGER)");
  const real = DB.batch.bind(DB);
  DB.batch = async () => { throw new Error("D1 overloaded"); };
  await assert.rejects(ensureStudioSchema({ DB }), /overloaded/);
  DB.batch = real;
  await within(ensureStudioSchema({ DB }), 1000);
});

test("MCP server: a first check that never answers does not hang the next request", async () => {
  const { ensureSchema } = await import(`../src/schema.ts?fresh=${Date.now()}`);
  const DB = new FakeD1();
  DB.hang = true;
  ensureSchema({ DB });
  DB.hang = false;
  await within(ensureSchema({ DB }), 2000);
  const n = DB.calls.length;
  await ensureSchema({ DB });
  assert.equal(DB.calls.length, n, "a passed check makes no D1 call");
  const before = DB.calls.length;
  const { ensureSchema: again } = await import(`../src/schema.ts?fresh=${Date.now()}-2`);
  await again({ DB });
  assert.equal(DB.calls.slice(before).filter((s) => /^ALTER/i.test(s)).length, 0, "a new isolate on a full schema runs no ALTER");
});
