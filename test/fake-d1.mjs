/**
 * The tests' D1, on node:sqlite: one copy for every test file that moves credits (31 October 2026). Where it matters it
 * answers the way D1 does:
 * - meta.changes is total_changes() after the statement minus before, which is how D1 counts it (miniflare's D1,
 *   workers/d1/database.worker.js), so the rows a trigger changes count too. users_program_credits_spent changes the
 *   users row again whenever credits go down on an account with Kleo Creators program credits: a debit judged on
 *   meta.changes === 1 read 2 there and said "not enough credits" after the credits went. node:sqlite's own `changes`
 *   (sqlite3_changes) leaves trigger rows out, which is how the copies before this one hid it.
 * - A statement is prepared when it first runs, as D1 reports a bad statement then, not at prepare().
 * - Rows come back as plain objects.
 * - batch() runs the statements one after another, each through its own run(), so a test can make one of them fail.
 *   With { atomic: true } it is one transaction instead, all or nothing, run without a pause so that two batches
 *   started together cannot interleave, as D1 serialises them.
 * Binds as the tests always had them: undefined becomes NULL, a boolean 1 or 0.
 */
import { DatabaseSync } from "node:sqlite";

/** The rows a statement changed, as D1 counts them: total_changes() after it minus before, trigger rows included. */
export const d1Changes = (db) => Number(db.prepare("SELECT total_changes() AS n").get().n);

export class FakeStmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; this.prepared = null; }
  get stmt() { return (this.prepared ??= this.db.prepare(this.sql)); }
  bind(...a) { this.args = a.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)); return this; }
  /** run() without a pause, for an atomic batch. */
  runNow() {
    const before = d1Changes(this.db);
    this.stmt.run(...this.args);
    return { success: true, meta: { changes: d1Changes(this.db) - before } };
  }
  async run() { return this.runNow(); }
  async first() { const r = this.stmt.get(...this.args); return r ? { ...r } : null; }
  async all() { return { results: this.stmt.all(...this.args).map((r) => ({ ...r })) }; }
}

export class FakeD1 {
  constructor({ atomic = false } = {}) { this.db = new DatabaseSync(":memory:"); this.atomic = atomic; }
  prepare(sql) { return new FakeStmt(this.db, sql); }
  async batch(stmts) {
    if (!this.atomic) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    }
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s.runNow());
      this.db.exec("COMMIT");
      return out;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
}
