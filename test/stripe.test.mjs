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
    stdin: { contents: `export * from "./src/stripe.ts"; export * from "./src/db.ts"; export * from "./src/schema.ts"; export * from "./src/plans.ts";`, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent", external: ["@anthropic-ai/sdk"], // the planner on Claude (20 September) loads the SDK only when called, which no test here does
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

/* ------------------------------------------------------------------ do not sell what cannot be rendered */

test("i bottoni spariscono quando la bandiera 'selling_pause' e' alzata, e il webhook accredita lo stesso", async () => {
  const env = newEnv(); user(env, "u_buyer");
  env.DB.db.exec("CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, until TEXT NOT NULL)");
  assert.equal(await m.sellingAvailable(env), true, "configurata e con benzina: si vende");

  // Il 12 settembre: vendita aperta, saldo Vast 0,00 $. L'orchestratore alza la bandiera per 15 minuti.
  await m.setFlagUntil(env, m.SELLING_PAUSE, 900);
  assert.equal(await m.sellingAvailable(env), false, "senza benzina i bottoni non si mostrano");
  assert.equal(m.sellingOpen(env), true, "ma la configurazione resta: e' una pausa, non una chiusura");

  // Chi ha gia' pagato — da una pagina in cache, un vecchio messaggio, un link aperto un attimo prima — viene
  // accreditato comunque. Non mostrare la porta e' una cortesia; rifiutare chi l'ha gia' attraversata e' un furto.
  const r = await post(env, session());
  assert.equal(r.status, 200);
  assert.equal(balance(env, "u_buyer"), 10, "pagato = accreditato, bandiera o no");
});

test("27 September 2026: the shop never closes itself on a low Vast balance (the owner removed the automatic pause)", async () => {
  // The orchestrator used to raise "selling_pause" whenever the Vast balance fell under VAST_MIN_BALANCE_TO_SELL.
  // The owner's words: «no sotto $1 il negozio si mette in pausa da solo. togli sta roba». Nothing may raise it now.
  const { readFileSync } = await import("node:fs");
  const orchestrator = readFileSync(new URL("../src/orchestrator.ts", import.meta.url), "utf8");
  assert.ok(!/SELLING_PAUSE|guardSelling|vastCredit/.test(orchestrator), "the tick no longer reads the Vast balance to close the shop");
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(!/VAST_MIN_BALANCE_TO_SELL/.test(cfg), "the threshold is gone from the configuration");
  const env = newEnv();
  env.DB.db.exec("CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, until TEXT NOT NULL)");
  assert.equal(await m.sellingAvailable(env), true, "configured means open");
});

/* ------------------------------------------------------------------ two Stripe accounts, one webhook */

test("4 October 2026: the Italy account's events and the New Zealand account's events are both accepted", async () => {
  // The shop moved to a new Italy account (PayPal is only offered to EEA accounts); the New Zealand account still holds
  // the first real payment, whose refund or dispute must keep reaching Kleo. Each account signs with its own secret.
  const SECOND = "whsec_italy_account";
  const env = newEnv({ STRIPE_WEBHOOK_SECRET_2: SECOND }); user(env, "u_buyer");
  const body = JSON.stringify(session());
  const r = await m.handleStripeWebhook(new Request("https://k/stripe/webhook", { method: "POST", body, headers: signed(body, SECOND) }), env);
  assert.equal(r.status, 200, "signed by the second account: accepted");
  assert.equal(balance(env, "u_buyer"), 10);

  const forged = await m.handleStripeWebhook(new Request("https://k/stripe/webhook", { method: "POST", body, headers: signed(body, "whsec_someone_else") }), env);
  assert.equal(forged.status, 400, "a third secret is still a forgery");

  assert.equal(m.sellingOpen(newEnv({ STRIPE_WEBHOOK_SECRET: undefined, STRIPE_WEBHOOK_SECRET_2: SECOND })), true, "either secret opens the shop");
});

/* ------------------------------------------------------------------ the plans (19 October 2026, src/plans.ts) */
const subCheckout = (o = {}) => ({ id: "evt_s1", type: "checkout.session.completed", livemode: true,
  data: { object: { id: "cs_sub1", mode: "subscription", client_reference_id: "u_sub", amount_total: 3900, currency: "eur", payment_status: "paid",
    subscription: "sub_1", customer: "cus_1", customer_details: { email: "s@example.com", address: { country: "IT" } }, ...o } } });
const invoice = (o = {}) => ({ id: "evt_i1", type: "invoice.paid", livemode: true,
  data: { object: { id: "in_2", billing_reason: "subscription_cycle", amount_paid: 3900, currency: "eur", payment_intent: "pi_i2",
    parent: { subscription_details: { subscription: "sub_1" } }, lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 31 * 86400 } }] }, ...o } } });
const planRow = (env, id) => ({ ...env.DB.db.prepare("SELECT plan, plan_period, plan_credits, plan_status, plan_sub FROM users WHERE id = ?").get(id) });

test("plans: prices and credits come from one table, and no plan costs what a pack costs", () => {
  assert.deepEqual([m.planForAmount(3900).plan.key, m.planForAmount(3900).period], ["pro", "month"]);
  assert.deepEqual([m.planForAmount(37200).plan.key, m.planForAmount(37200).period], ["pro", "year"], "€31 a month, billed €372 a year");
  assert.equal(m.planForAmount(19900).tier.credits, 590, "Agency's middle tier");
  for (const p of [500, 1500, 4000]) assert.equal(m.planForAmount(p), null, "a pack is never read as a plan");
  for (const plan of m.PLANS) for (const t of plan.tiers) for (const per of ["month", "year"]) {
    const perCredit = m.periodCents(t, per) / (per === "year" ? 12 : 1) / t.credits / 100 * 1.16; // dollars per credit
    assert.ok(perCredit >= 0.275 * 1.1, `${plan.key} ${t.credits} ${per}: ${perCredit.toFixed(3)} $/credit stays over the worst-case cost`);
  }
});

test("plans: the checkout gives the first month and remembers the subscription; a renewal gives the next; nothing twice", async () => {
  const env = newEnv(); user(env, "u_sub");
  assert.equal((await post(env, subCheckout())).status, 200);
  assert.equal(balance(env, "u_sub"), 110);
  assert.deepEqual(planRow(env, "u_sub"), { plan: "pro", plan_period: "month", plan_credits: 110, plan_status: "active", plan_sub: "sub_1" });
  await post(env, subCheckout());
  assert.equal(balance(env, "u_sub"), 110, "the same checkout twice credits once");
  await post(env, invoice({ id: "in_1", billing_reason: "subscription_create" }));
  assert.equal(balance(env, "u_sub"), 110, "the first invoice IS the checkout");
  await post(env, invoice());
  assert.equal(balance(env, "u_sub"), 220, "next month");
  await post(env, invoice());
  assert.equal(balance(env, "u_sub"), 220, "the same invoice twice credits once");
  // A top-up while subscribed: Pro's +15%.
  await post(env, session({ id: "cs_pack", client_reference_id: "u_sub", amount_total: 4000, payment_intent: "pi_pack" }));
  assert.equal(balance(env, "u_sub"), 335, "100 + 15 credits");
  // Cancelled: nothing is taken, the plan lasts to the end of what was paid.
  await post(env, { id: "evt_d", type: "customer.subscription.deleted", livemode: true, data: { object: { id: "sub_1" } } });
  assert.equal(planRow(env, "u_sub").plan_status, "canceled");
  assert.equal((await m.activePlan(env, "u_sub")).key, "pro");
  assert.equal(balance(env, "u_sub"), 335);
});

test("plans: an annual plan is paid once and gets its credits every month from the cron, never twice for one month", async () => {
  const env = newEnv(); user(env, "u_year");
  await post(env, subCheckout({ id: "cs_y", client_reference_id: "u_year", amount_total: 37200, subscription: "sub_y" }));
  assert.equal(balance(env, "u_year"), 110);
  assert.equal(planRow(env, "u_year").plan_period, "year");
  const day = 86_400_000;
  assert.equal(await m.grantDuePlanCredits(env, Date.now() + 10 * day), 0, "not before its month");
  assert.equal(await m.grantDuePlanCredits(env, Date.now() + 29 * day), 1);
  assert.equal(balance(env, "u_year"), 220);
  assert.equal(await m.grantDuePlanCredits(env, Date.now() + 29 * day), 0, "the same tick again pays nothing");
  assert.equal(await m.grantDuePlanCredits(env, Date.now() + 59 * day), 1);
  assert.equal(balance(env, "u_year"), 330);
  assert.equal(await m.grantDuePlanCredits(env, Date.now() + 400 * day), 0, "after the paid year, nothing");
});

test("plans: an amount no plan costs, or another currency, buys nothing", async () => {
  const env = newEnv(); user(env, "u_sub");
  await post(env, subCheckout({ amount_total: 4100 }));
  await post(env, subCheckout({ id: "cs_usd", currency: "usd" }));
  assert.equal(balance(env, "u_sub"), 0);
});

/* ------------------------------------------------------------------ buyers abroad (Adaptive Pricing, 19 October 2026) */
const fx = (eurCents, local = "usd", localCents = Math.round(eurCents * 1.16)) => ({ currency: local, amount_total: localCents,
  currency_conversion: { source_currency: "eur", amount_total: eurCents, amount_subtotal: eurCents, fx_rate: "1.16" } });

test("abroad: a pack paid in dollars from a EUR link buys the pack its EUR price names", async () => {
  const env = newEnv(); user(env, "u_buyer");
  assert.equal((await post(env, session(fx(500)))).status, 200);
  assert.equal(balance(env, "u_buyer"), 10, "5 EUR shown as 5.80 USD is still the 5 EUR pack");
  const row = env.DB.db.prepare("SELECT amount_cent, currency FROM payments").get();
  assert.deepEqual({ ...row }, { amount_cent: 500, currency: "eur" }, "written down in EUR, like every other sale");
  // A link created in dollars has no EUR source: still refused, whatever its amount.
  await post(env, session({ id: "cs_usd", currency: "usd", amount_total: 500, payment_intent: "pi_usd" }));
  assert.equal(balance(env, "u_buyer"), 10);
});

test("abroad: a plan bought in another currency starts, and its renewals in that currency renew it", async () => {
  const env = newEnv(); user(env, "u_sub");
  await post(env, subCheckout(fx(3900, "gbp", 3350)));
  assert.equal(balance(env, "u_sub"), 110);
  assert.equal(planRow(env, "u_sub").plan, "pro");
  await post(env, invoice({ currency: "gbp", amount_paid: 3350 }));
  assert.equal(balance(env, "u_sub"), 220, "a pound renewal of a known subscription renews Pro");
  await post(env, invoice({ id: "in_pr", currency: "gbp", amount_paid: 120, billing_reason: "subscription_update" }));
  assert.equal(balance(env, "u_sub"), 220, "a proration is not a month");
  await post(env, invoice({ id: "in_x", currency: "gbp", amount_paid: 3350, parent: { subscription_details: { subscription: "sub_nobody" } } }));
  assert.equal(balance(env, "u_sub"), 220, "an unknown subscription names no plan");
});

test("abroad: every buy link opens in English", () => {
  const env = newEnv();
  assert.match(m.buyUrl(env, m.PACKS[0], "u_1"), /\?client_reference_id=u_1&locale=en$/);
  const pro = m.publicPlans(JSON.stringify({ "pro:month": "https://buy.stripe.com/xyz" }), "u_1").find((p) => p.key === "pro");
  assert.equal(pro.tiers[0].month.url, "https://buy.stripe.com/xyz?client_reference_id=u_1&locale=en");
});

