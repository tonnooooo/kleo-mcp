/**
 * Buying credits. The money path, so the tests are about what an attacker or an accident can do, not about
 * whether the happy case works.
 * Run: node --test test/stripe.test.mjs
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import * as esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "whsec_" + "a".repeat(32);

let m;
before(async () => {
  const r = await esbuild.build({
    stdin: { contents: `export * from "./src/stripe.ts"; export * from "./src/db.ts"; export * from "./src/schema.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent",
  });
  m = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
});

/* ------------------------------------------------------------------ D1 look-alike */
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)); return this; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}
function fakeDB() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(join(ROOT, "migrations")).sort()) db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  return { db, prepare: (sql) => new Stmt(db, sql), batch: async (sts) => { const out = []; for (const s of sts) out.push(await s.run()); return out; } };
}
const newEnv = (extra = {}) => ({ DB: fakeDB(), INTERNAL_SECRET: "s", STRIPE_WEBHOOK_SECRET: SECRET,
  STRIPE_LINK_5: "https://buy.stripe.com/aaa", STRIPE_LINK_15: "https://buy.stripe.com/bbb", STRIPE_LINK_40: "https://buy.stripe.com/ccc", ...extra });
const user = (env, id, credits = 0) => env.DB.db.exec(`INSERT INTO users (id,email,credits) VALUES ('${id}','${id}@anon.kleo.invalid',${credits})`);
const balance = (env, id) => env.DB.db.prepare("SELECT credits FROM users WHERE id = ?").get(id)?.credits;

const signed = (body, secret = SECRET, at = Date.now()) => {
  const t = Math.floor(at / 1000);
  return { "stripe-signature": `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}` };
};
const post = (env, obj, headers) => {
  const body = JSON.stringify(obj);
  return m.handleStripeWebhook(new Request("https://k/stripe/webhook", { method: "POST", body, headers: headers ?? signed(body) }), env);
};
const session = (o = {}) => ({ id: "evt_1", type: "checkout.session.completed", livemode: true,
  data: { object: { id: "cs_1", client_reference_id: "u_buyer", amount_total: 500, currency: "eur",
    payment_status: "paid", payment_intent: "pi_1", customer_details: { email: "b@example.com", address: { country: "NZ" } }, ...o } } });

/* ------------------------------------------------------------------ the signature is the authentication */

test("nessuna firma, nessun credito", async () => {
  const env = newEnv(); user(env, "u_buyer");
  const r = await post(env, session(), { "stripe-signature": "t=1,v1=deadbeef" });
  assert.equal(r.status, 400);
  assert.equal(balance(env, "u_buyer"), 0, "una firma sbagliata non accredita niente");
});

test("un corpo modificato dopo la firma non passa", async () => {
  const env = newEnv(); user(env, "u_buyer");
  const honest = JSON.stringify(session());
  const tampered = JSON.stringify(session({ amount_total: 4000 })); // 5 EUR pagati, 40 EUR chiesti
  const r = await m.handleStripeWebhook(new Request("https://k/stripe/webhook", { method: "POST", body: tampered, headers: signed(honest) }), env);
  assert.equal(r.status, 400);
  assert.equal(balance(env, "u_buyer"), 0);
});

test("una firma vecchia di un'ora non vale piu'", async () => {
  const env = newEnv(); user(env, "u_buyer");
  const body = JSON.stringify(session());
  const r = await m.handleStripeWebhook(new Request("https://k/stripe/webhook", { method: "POST", body, headers: signed(body, SECRET, Date.now() - 3600_000) }), env);
  assert.equal(r.status, 400);
});

/* ------------------------------------------------------------------ the one that costs everything */

test("modalita' di PROVA: firma valida, ma zero crediti", async () => {
  // Una console Stripe nuova parte in test mode. Con quel segreto la firma e' valida davvero, e la carta
  // 4242 4242 4242 4242 produce un evento identico a un pagamento vero.
  const env = newEnv(); user(env, "u_buyer");
  const r = await post(env, session()); // livemode true qui sotto viene tolto
  assert.equal(r.status, 200);
  assert.equal(balance(env, "u_buyer"), 10, "il caso vero accredita");

  const env2 = newEnv(); user(env2, "u_buyer");
  const fake = session(); fake.livemode = false;
  const r2 = await post(env2, fake);
  assert.equal(r2.status, 200, "200 perche' l'evento e' stato capito: non c'e' niente da ritentare");
  assert.equal(balance(env2, "u_buyer"), 0, "ma nessun credito da una carta finta");
});

/* ------------------------------------------------------------------ delivered twice, credited once */

test("Stripe rimanda lo stesso evento: si accredita una volta sola", async () => {
  const env = newEnv(); user(env, "u_buyer");
  for (let i = 0; i < 4; i++) assert.equal((await post(env, session())).status, 200);
  assert.equal(balance(env, "u_buyer"), 10, "quattro consegne, dieci crediti");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM payments").get().n, 1);
});

test("un importo che non corrisponde a nessun pacchetto non compra niente", async () => {
  const env = newEnv(); user(env, "u_buyer");
  const r = await post(env, session({ amount_total: 499 }));
  assert.equal(r.status, 200);
  assert.equal(balance(env, "u_buyer"), 0);
});

test("una valuta diversa da EUR non accredita, anche se l'importo coincide", async () => {
  const env = newEnv(); user(env, "u_buyer");
  const r = await post(env, session({ currency: "usd" }));
  assert.equal(r.status, 200);
  assert.equal(balance(env, "u_buyer"), 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM payments").get().n, 0);
});

test("un pagamento senza account viene comunque registrato", async () => {
  const env = newEnv();
  const r = await post(env, session({ client_reference_id: "u_non_esiste" }));
  assert.equal(r.status, 200);
  const row = env.DB.db.prepare("SELECT * FROM payments").get();
  assert.ok(row, "il denaro arrivato si scrive comunque");
  assert.equal(row.credits, 0);
  assert.equal(row.raw_ref, "u_non_esiste", "e si tiene quello che era stato passato, per ritrovarlo a mano");
});

/* ------------------------------------------------------------------ afterwards */

test("un rimborso si segna e NON toglie i crediti", async () => {
  const env = newEnv(); user(env, "u_buyer");
  await post(env, session());
  const r = await post(env, { id: "evt_2", type: "charge.refunded", livemode: true, data: { object: { payment_intent: "pi_1" } } });
  assert.equal(r.status, 200);
  assert.equal(balance(env, "u_buyer"), 10, "un rimborso puo' ancora fallire: togliere subito lascerebbe senza soldi E senza crediti");
  assert.equal(env.DB.db.prepare("SELECT status FROM payments").get().status, "refunded");
});

test("una contestazione toglie i crediti subito, anche sotto zero", async () => {
  const env = newEnv(); user(env, "u_buyer");
  await post(env, session());
  env.DB.db.exec("UPDATE users SET credits = 3 WHERE id = 'u_buyer'"); // ne ha gia' spesi sette
  const r = await post(env, { id: "evt_3", type: "charge.dispute.created", livemode: true, data: { object: { payment_intent: "pi_1" } } });
  assert.equal(r.status, 200);
  assert.equal(balance(env, "u_buyer"), -7, "i soldi sono gia' andati: lasciare i crediti sarebbe pagare due volte");
  assert.equal(env.DB.db.prepare("SELECT status FROM payments").get().status, "disputed");
});

/* ------------------------------------------------------------------ closed until the owner opens it */

test("senza configurazione la vendita e' chiusa, e il webhook chiede di riprovare", async () => {
  assert.equal(m.sellingOpen({}), false);
  assert.equal(m.sellingOpen(newEnv({ STRIPE_LINK_5: "https://buy.stripe.com/test_xxx" })), false, "un link di prova non e' vendita vera");
  assert.equal(m.sellingOpen(newEnv()), true);

  const env = newEnv({ STRIPE_WEBHOOK_SECRET: undefined });
  const r = await post(env, session());
  assert.equal(r.status, 503, "503 e non 404: Stripe ritenta per tre giorni e il pagamento si accredita da solo quando il segreto arriva");
});
