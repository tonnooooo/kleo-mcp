import type { Env } from "./env";
import { getUser, creditPurchase, paymentByIntent, takeBackCredits, audit } from "./db";
import { json, hmacHex, safeEqual } from "./util";
import { isFlagActive } from "./schema";
import { rewardReferral, takeBackReferral } from "./referral.ts";
import { periodCents, planByKey, planForAmount, topupBonusCredits, type Plan } from "./plans.ts";

/**
 * The credit packs. ONE list, and it is the only place a price and a number of credits are tied together: the
 * webhook reads it to decide what an amount bought, and the account page reads it to draw the buttons. Two lists
 * would be a way to sell 100 credits for 5 EUR the day somebody edits one of them.
 *
 * `cents` is what Stripe reports in `amount_total`, so it is the thing actually paid — never a label parsed back
 * out of a price string.
 */
export const PACKS: { cents: number; credits: number; label: string; linkVar: "STRIPE_LINK_5" | "STRIPE_LINK_15" | "STRIPE_LINK_40" }[] = [
  { cents: 500, credits: 10, label: "5 EUR", linkVar: "STRIPE_LINK_5" },
  { cents: 1500, credits: 35, label: "15 EUR", linkVar: "STRIPE_LINK_15" },
  { cents: 4000, credits: 100, label: "40 EUR", linkVar: "STRIPE_LINK_40" },
];

/** Every webhook signing secret configured: the Italy account's and the New Zealand one's (src/env.ts). */
export const webhookSecrets = (env: Env): string[] =>
  [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_2].filter((s): s is string => !!s);

/** True when the owner has actually configured selling: three links and a webhook secret. Everything degrades to
 *  "not open yet" until then, the same way notify.ts stays silent without RESEND_API_KEY. */
export const sellingOpen = (env: Env): boolean =>
  webhookSecrets(env).length > 0 && PACKS.every((p) => {
    const link = env[p.linkVar] ?? "";
    // Must be a real Stripe Payment Link, and NOT a test one. This is the second half of the livemode check, at the
    // other end of the road: a test dashboard hands out /test_ links, and a page that offers them takes nobody's
    // money while looking exactly as if it does.
    return link.startsWith("https://buy.stripe.com/") && !link.includes("/test_");
  });

/**
 * The Payment Link for one pack, with the account tied to it. `client_reference_id` is what comes back in the
 * webhook and is the only way a payment knows whose credits it is: Stripe passes it through untouched.
 * The buyer can edit it in the address bar — and all that does is give THEIR credits to somebody else, which is
 * their money and their choice, so it is not a hole. What it must never do is reach the database unchecked, and it
 * does not: the webhook looks the account up before crediting anything.
 */
export const buyUrl = (env: Env, pack: (typeof PACKS)[number], userId: string): string =>
  `${env[pack.linkVar]}?client_reference_id=${encodeURIComponent(userId)}&locale=${CHECKOUT_LOCALE}`;
/** Checkout always in English, wherever the buyer is (19 October 2026, the owner: "per tutti … in inglese"). */
export const CHECKOUT_LOCALE = "en";

/**
 * What a Checkout Session paid, in EUR cents, or null when it was not a EUR sale. Every link is created in EUR, but
 * Adaptive Pricing (on for the Italy account) lets a buyer abroad pay in their own money: the session's `currency`
 * and `amount_total` are then THEIRS (usd, 1049) and `currency_conversion` carries the EUR it was made from
 * (source_currency eur, amount_total 900). That EUR amount is what names the pack or plan. A link created in another
 * currency (the old USD ones) has no EUR source and stays refused.
 */
export function eurCents(s: Record<string, any>): number | null {
  if (s.currency === "eur") return typeof s.amount_total === "number" ? s.amount_total : null;
  const c = s.currency_conversion;
  return c?.source_currency === "eur" && typeof c.amount_total === "number" ? c.amount_total : null;
}

/**
 * Whether the buttons should be SHOWN right now: selling is configured and the "selling_pause" flag is not raised.
 * Until 27 September 2026 the orchestrator raised that flag by itself whenever the Vast balance fell under
 * VAST_MIN_BALANCE_TO_SELL ($1). The owner removed that automatic pause on 27 September ("togli sta roba"): the shop
 * stays open whatever the GPU balance, and keeping Vast topped up is his job. Nothing raises the flag any more; the
 * check stays so a flag left over from before the deploy expires on its own (fifteen minutes) instead of sticking.
 *
 * Only the BUTTONS follow this. The webhook does not: anyone who already paid — from a cached page, an old
 * message, a link opened just before the balance fell — is credited regardless. Not showing the door is a
 * kindness; refusing somebody who already walked through it is theft.
 */
export async function sellingAvailable(env: Env): Promise<boolean> {
  return sellingOpen(env) && !(await isFlagActive(env, SELLING_PAUSE));
}
export const SELLING_PAUSE = "selling_pause";

/** The pack an amount bought, or null. Matched on the amount Stripe reports, never on what the page displayed. */
export const packForAmount = (cents: number): (typeof PACKS)[number] | null =>
  PACKS.find((p) => p.cents === cents) ?? null;

/**
 * Stripe signs `<timestamp>.<raw body>` with the endpoint secret and sends it as
 * `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`. Verifying it is what makes this endpoint safe to leave open:
 * without it anyone who learns the URL can post themselves a hundred credits.
 *
 * Two things this must get right and one it must not do. It compares with safeEqual (a byte-by-byte compare that
 * leaks nothing through timing), and it refuses anything older than five minutes so a captured request cannot be
 * replayed later. What it must NOT do is parse the body first: the signature covers the RAW bytes, so re-serialising
 * JSON before checking would verify a different string than the one Stripe signed.
 */
export async function verifyStripeSignature(secret: string, header: string, rawBody: string, nowMs: number): Promise<boolean> {
  const parts = Object.create(null) as Record<string, string[]>;
  for (const piece of header.split(",")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const k = piece.slice(0, eq).trim();
    (parts[k] ??= []).push(piece.slice(eq + 1).trim());
  }
  const t = parts.t?.[0];
  const signatures = parts.v1 ?? [];
  if (!t || !/^\d+$/.test(t) || !signatures.length) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > 300) return false; // five minutes: a captured POST stops working
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return signatures.some((s) => safeEqual(s, expected));
}

/**
 * POST /stripe/webhook — the only way credits are ever bought.
 *
 * It answers 200 to everything it has understood, INCLUDING an event it decides to ignore, because a non-2xx makes
 * Stripe retry the same event for days; the only 4xx here is a signature that does not check out, which is the one
 * case where retrying is exactly what should happen to a forgery: nothing.
 */
export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const secrets = webhookSecrets(env);
  if (!secrets.length) {
    // 503 e NON 404, e la differenza vale un incasso. Per Stripe qualunque risposta non-2xx e' un fallimento: con il
    // 503 ritenta per tre giorni e, se nel frattempo il segreto arriva, il pagamento si accredita da solo. Con il 200
    // smetterebbe di ritentare e quel pagamento sarebbe perso per sempre. Il 404 fallisce come il 503 ma non lascia
    // detto niente a chi legge i log — e il caso "il primo cliente paga prima che il webhook sia configurato" e' il
    // piu' probabile di tutti.
    await audit(env, null, null, "stripe.unconfigured", {});
    return json({ error: "payments are not configured yet" }, 503);
  }

  const raw = await request.text(); // raw, before any parsing: the signature covers these exact bytes
  if (raw.length > 256 * 1024) return json({ error: "too large" }, 413); // a Stripe event is a few KB; the rest is someone making the HMAC work for nothing
  const sig = request.headers.get("stripe-signature") ?? "";
  // Two accounts post here (src/env.ts STRIPE_WEBHOOK_SECRET_2): the event is genuine when either secret signed it.
  let signed = false;
  for (const secret of secrets) if (await verifyStripeSignature(secret, sig, raw, Date.now())) { signed = true; break; }
  if (!signed) return json({ error: "bad signature" }, 400);

  let event: { id?: string; type?: string; livemode?: boolean; data?: { object?: Record<string, unknown> } };
  try { event = JSON.parse(raw); } catch { return json({ error: "not json" }, 400); }

  // THE ONE THAT COSTS EVERYTHING. A new Stripe dashboard starts in TEST mode, and that is where its own
  // documentation invites you to try things. If the owner registers this endpoint in test mode and pastes that
  // whsec_ as the secret, a test event's signature is perfectly VALID here — and card 4242 4242 4242 4242 produces
  // amount_total 4000 and payment_status "paid", indistinguishable from a real purchase. That is 100 real credits,
  // 4.14 $ of real GPU, repeatable for ever, against a Vast balance of 0.34 $. One line stops it.
  if (event.livemode !== true) {
    await audit(env, null, null, "stripe.testmode", { type: event.type ?? null, event: event.id ?? null });
    return json({ ok: true, ignored: "test-mode event" });
  }
  // A payment method that settles later (bank debits) completes as async_payment_succeeded, not as the session
  // event. Ignoring it means the money arrives and the credits never do.
  const BUYS = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];
  if (event.type === "charge.refunded" || event.type === "charge.dispute.created")
    return handleChargeTrouble(env, event.type, event.data?.object ?? {});
  // THE PLANS (19 October 2026, src/plans.ts): a renewal pays an invoice; a cancelled plan ends the subscription.
  if (event.type === "invoice.paid") return handleInvoicePaid(env, event);
  if (event.type === "customer.subscription.deleted") return handleSubscriptionEnded(env, event.data?.object ?? {});
  if (!BUYS.includes(event.type ?? "")) return json({ ok: true, ignored: event.type ?? "unknown" });

  const s = event.data?.object ?? {};
  if (s.mode === "subscription") return handlePlanCheckout(env, event, s);
  const sessionId = typeof s.id === "string" ? s.id : "";
  const userId = typeof s.client_reference_id === "string" ? s.client_reference_id : "";
  const eur = eurCents(s);
  const cents = eur ?? -1;
  const currency = "eur";
  const shown = typeof s.currency === "string" ? s.currency : "";
  const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
  const email = typeof (s.customer_details as { email?: unknown } | undefined)?.email === "string"
    ? ((s.customer_details as { email: string }).email) : null;

  // Everything below is a reason to accept the event and do nothing — never a reason to make Stripe retry.
  if (!sessionId || !paid) return json({ ok: true, ignored: "not a completed payment" });
  // The live catalogue is EUR-only (a buyer abroad pays in their money, converted from EUR: eurCents). Amounts alone
  // are not enough here: the old USD links must never be able to mint credits if one of them is still reachable
  // from a cached page or an old message.
  if (eur === null) {
    await audit(env, null, null, "stripe.wrong_currency", { session: sessionId, currency: shown || null });
    return json({ ok: true, ignored: `unsupported currency ${shown || "unknown"}` });
  }
  const pack = packForAmount(cents);
  if (!pack) return json({ ok: true, ignored: `no pack costs ${cents} ${currency}` });
  // A subscriber's top-up carries the plan's bonus (+10/15/25%, src/plans.ts).
  const bonus = userId ? topupBonusCredits(await activePlan(env, userId), pack.credits) : 0;

  const pi = typeof s.payment_intent === "string" ? s.payment_intent : null;
  const country = (s.customer_details as { address?: { country?: unknown } } | undefined)?.address?.country;
  // An account that does not exist does not stop the row being written: money that arrived has to be written down
  // even when nobody can be credited for it, or the payment exists and the record does not. Only the credits are
  // withheld, and the audit says orphan so it can be found and fixed by hand.
  const known = userId && (await getUser(env, userId)) ? userId : null;

  const credited = await creditPurchase(env, {
    sessionId, userId: known, credits: pack.credits + bonus, cents, currency, email,
    paymentIntent: pi, eventId: event.id ?? null, eventType: event.type ?? null,
    country: typeof country === "string" ? country : null, rawRef: userId || null,
  });
  // THE REFERRAL REWARD (27 September 2026, src/referral.ts): on the referred account's first real payment only, once.
  // A failure here must never make Stripe retry a payment that is already credited: it is written down instead.
  let referral: Awaited<ReturnType<typeof rewardReferral>> = null;
  if (credited && known) {
    try { referral = await rewardReferral(env, known, sessionId); }
    catch (e) { await audit(env, known, null, "referral.error", { session: sessionId, error: String(e).slice(0, 300) }); }
  }
  return json({ ok: true, credits: known ? pack.credits + bonus : 0, orphan: !known, already: !credited, ...(bonus ? { plan_bonus: bonus } : {}), ...(referral ? { referral_bonus: referral.referred_credits } : {}) });
}

/* ------------------------------------------------------------------ the plans (19 October 2026, src/plans.ts) */

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** The plan an account is on right now (paid through plan_until, even when cancelled), or null. */
export async function activePlan(env: Env, userId: string): Promise<Plan | null> {
  const row = await env.DB.prepare("SELECT plan, plan_until FROM users WHERE id = ?").bind(userId).first<{ plan: string | null; plan_until: string | null }>();
  return row?.plan_until && Date.parse(row.plan_until) > Date.now() ? planByKey(row.plan) : null;
}
const subscriptionOf = (o: Record<string, any>): string | null => {
  const s = o.subscription ?? o.parent?.subscription_details?.subscription; // the field moved in Stripe's 2025 API
  return typeof s === "string" ? s : typeof s?.id === "string" ? s.id : null;
};

/**
 * A plan bought through a subscription Payment Link: the first month's credits arrive with the checkout, the account
 * remembers its subscription so later invoices find it. Recorded in payments like a pack (the session id).
 */
async function handlePlanCheckout(env: Env, event: { id?: string; type?: string }, s: Record<string, any>): Promise<Response> {
  const sessionId = typeof s.id === "string" ? s.id : "";
  const userId = typeof s.client_reference_id === "string" ? s.client_reference_id : "";
  const eur = eurCents(s);
  const cents = eur ?? -1;
  const currency = "eur";
  const shown = typeof s.currency === "string" ? s.currency : "";
  const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
  if (!sessionId || !paid) return json({ ok: true, ignored: "not a completed payment" });
  if (eur === null) { await audit(env, null, null, "stripe.wrong_currency", { session: sessionId, currency: shown || null }); return json({ ok: true, ignored: `unsupported currency ${shown || "unknown"}` }); }
  const match = planForAmount(cents);
  if (!match) return json({ ok: true, ignored: `no plan costs ${cents} ${currency}` });
  const known = userId && (await getUser(env, userId)) ? userId : null;
  const email = typeof s.customer_details?.email === "string" ? s.customer_details.email : null;
  const country = typeof s.customer_details?.address?.country === "string" ? s.customer_details.address.country : null;
  const credited = await creditPurchase(env, {
    sessionId, userId: known, credits: match.tier.credits, cents, currency, email,
    paymentIntent: typeof s.payment_intent === "string" ? s.payment_intent : null, eventId: event.id ?? null, eventType: event.type ?? null,
    country, rawRef: userId || null,
  });
  if (known && credited) {
    const now = Date.now();
    await env.DB.prepare(`UPDATE users SET plan = ?, plan_period = ?, plan_credits = ?, plan_until = ?, plan_status = 'active', plan_sub = ?, plan_customer = ?, plan_next_grant = ? WHERE id = ?`)
      .bind(match.plan.key, match.period, match.tier.credits, iso(now + (match.period === "year" ? 366 : 31) * DAY_MS),
        typeof s.subscription === "string" ? s.subscription : null, typeof s.customer === "string" ? s.customer : null, iso(now + 28 * DAY_MS), known).run();
    await audit(env, known, null, "plan.started", { plan: match.plan.key, period: match.period, credits: match.tier.credits, cents, session: sessionId });
    try { await rewardReferral(env, known, sessionId); } catch (e) { await audit(env, known, null, "referral.error", { session: sessionId, error: String(e).slice(0, 300) }); }
  }
  return json({ ok: true, plan: match.plan.key, period: match.period, credits: known ? match.tier.credits : 0, orphan: !known, already: !credited });
}

/** A renewal: the month's (or the new year's first month of) credits, and the paid-through date moves on. */
async function handleInvoicePaid(env: Env, event: { id?: string; type?: string; data?: { object?: Record<string, any> } }): Promise<Response> {
  const inv = event.data?.object ?? {};
  // The first invoice is the checkout itself (handlePlanCheckout gave its credits).
  if (inv.billing_reason === "subscription_create") return json({ ok: true, ignored: "first invoice: credited at checkout" });
  const sub = subscriptionOf(inv);
  const paidAmount = typeof inv.amount_paid === "number" ? inv.amount_paid : -1;
  if (!sub) return json({ ok: true, ignored: "not a plan invoice" });
  const row = await env.DB.prepare("SELECT id, plan, plan_period, plan_credits FROM users WHERE plan_sub = ? LIMIT 1").bind(sub)
    .first<{ id: string; plan: string | null; plan_period: string | null; plan_credits: number | null }>();
  // A EUR invoice names its plan by amount. A buyer abroad (Adaptive Pricing) renews in their own currency, which
  // names nothing: then the subscription itself is the proof, and it renews the plan the account bought at checkout.
  // Only a real monthly or yearly renewal of a known subscription, never a proration or a one-off invoice.
  let match = inv.currency === "eur" ? planForAmount(paidAmount) : null;
  const stored = planByKey(row?.plan);
  if (!match && inv.currency !== "eur" && stored && paidAmount > 0 && inv.billing_reason === "subscription_cycle"
    && (row?.plan_period === "month" || row?.plan_period === "year")) {
    const tier = stored.tiers.find((t) => t.credits === row.plan_credits) ?? null;
    if (tier) match = { plan: stored, tier, period: row.plan_period };
  }
  if (!match) return json({ ok: true, ignored: `no plan costs ${paidAmount} ${inv.currency ?? ""}`.trim() });
  const cents = periodCents(match.tier, match.period); // recorded in EUR, what the plan costs
  const userId = row?.id ?? null;
  const pi = typeof inv.payment_intent === "string" ? inv.payment_intent : null;
  const credited = await creditPurchase(env, {
    sessionId: String(inv.id ?? `inv_${event.id}`), userId, credits: match.tier.credits, cents, currency: "eur",
    email: typeof inv.customer_email === "string" ? inv.customer_email : null, paymentIntent: pi, eventId: event.id ?? null, eventType: event.type ?? null, country: null, rawRef: sub,
  });
  if (userId && credited) {
    const end = Number(inv.lines?.data?.[0]?.period?.end ?? inv.period_end ?? 0) * 1000;
    const now = Date.now();
    await env.DB.prepare(`UPDATE users SET plan = ?, plan_period = ?, plan_credits = ?, plan_until = ?, plan_status = 'active', plan_next_grant = ? WHERE id = ?`)
      .bind(match.plan.key, match.period, match.tier.credits, iso(end > now ? end : now + (match.period === "year" ? 366 : 31) * DAY_MS), iso(now + 28 * DAY_MS), userId).run();
    await audit(env, userId, null, "plan.renewed", { plan: match.plan.key, period: match.period, credits: match.tier.credits, invoice: inv.id ?? null });
  }
  return json({ ok: true, credits: userId ? match.tier.credits : 0, orphan: !userId, already: !credited });
}

/** A cancelled plan: nothing is taken back; the account keeps its plan until the end of what it paid for. */
async function handleSubscriptionEnded(env: Env, sub: Record<string, any>): Promise<Response> {
  const id = typeof sub.id === "string" ? sub.id : "";
  if (!id) return json({ ok: true, ignored: "no subscription" });
  const row = await env.DB.prepare("SELECT id FROM users WHERE plan_sub = ? LIMIT 1").bind(id).first<{ id: string }>();
  if (row) {
    await env.DB.prepare("UPDATE users SET plan_status = 'canceled' WHERE id = ?").bind(row.id).run();
    await audit(env, row.id, null, "plan.canceled", { subscription: id });
  }
  return json({ ok: true, canceled: !!row });
}

/**
 * The cron's part (src/index.ts scheduled): an ANNUAL plan is paid once a year but gets its credits every month.
 * Monthly plans get theirs with each invoice. One conditional UPDATE per account, so two ticks never pay twice.
 */
export async function grantDuePlanCredits(env: Env, nowMs = Date.now()): Promise<number> {
  const now = iso(nowMs);
  const due = await env.DB.prepare(`SELECT id, plan_credits, plan_next_grant FROM users WHERE plan_period = 'year' AND plan_until > ? AND plan_next_grant <= ? AND plan_credits > 0 LIMIT 100`)
    .bind(now, now).all<{ id: string; plan_credits: number; plan_next_grant: string }>();
  let n = 0;
  for (const u of due.results ?? []) {
    const r = await env.DB.prepare("UPDATE users SET credits = credits + ?, plan_next_grant = ? WHERE id = ? AND plan_next_grant = ?")
      .bind(u.plan_credits, iso(Date.parse(u.plan_next_grant) + 30 * DAY_MS), u.id, u.plan_next_grant).run();
    if ((r.meta?.changes ?? 0) === 1) { n++; await audit(env, u.id, null, "plan.credits", { credits: u.plan_credits, at: u.plan_next_grant }); }
  }
  return n;
}


/**
 * What happens after a payment: a refund, or a chargeback. Both arrive on a CHARGE and carry `payment_intent`,
 * never the session id — which is why payments.payment_intent exists.
 *
 * They are deliberately NOT treated the same, and the asymmetry is the whole point.
 *
 * A REFUND is only marked, never subtracted. A refund can still FAIL up to thirty days later (closed card, closed
 * account) and arrive back as refund.failed; taking the credits away the moment it starts would leave somebody
 * with neither their money nor their credits — robbed by an automatism. Marking it makes the case findable, and
 * the owner decides with the facts in front of him.
 *
 * A DISPUTE is subtracted at once. There the money is already gone: the card network pulls the amount plus a
 * non-refundable fee, and it stays gone for the months the case takes. Leaving the credits spendable on top of that
 * is paying twice for the same purchase. The balance is allowed to go negative — that is an honest record of what
 * happened, and every spend path already refuses to start a video without enough credits.
 *
 * ONCE, EVEN DELIVERED TWICE AT THE SAME MOMENT (14 October 2026, the security review). Stripe may deliver the same
 * dispute twice, and two deliveries can run side by side; this used to READ the status, see "paid" in both, and take
 * the credits back twice. The claim is now one conditional UPDATE — status becomes 'disputed' only where it is not yet
 * — and only the delivery whose UPDATE changed the row takes anything back. The claim goes FIRST on purpose: if the
 * Worker died between the claim and the take-back, the retry would find the row claimed and take nothing, so the
 * worst case is credits left with the customer and a 'disputed' row without its credits.chargeback audit, visible and
 * fixable by hand — never credits taken twice. A refund is marked the same careful way: it never overwrites
 * 'disputed', or a dispute delivered again after it would find the row "not disputed" and take the credits again.
 */
async function handleChargeTrouble(env: Env, type: string, charge: Record<string, unknown>): Promise<Response> {
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
  if (!pi) return json({ ok: true, ignored: "charge without a payment intent" });
  const row = await paymentByIntent(env, pi);
  if (!row) return json({ ok: true, ignored: "no payment of ours matches that charge" });

  if (type === "charge.refunded") {
    const marked = await env.DB.prepare("UPDATE payments SET status = 'refunded' WHERE session_id = ? AND status != 'disputed'").bind(row.session_id).run();
    if ((marked.meta.changes ?? 0) !== 1) return json({ ok: true, already: "disputed" });
    await audit(env, row.user_id, null, "stripe.refunded", { payment_intent: pi, session: row.session_id, credits: row.credits, note: "credits deliberately NOT removed: a refund can still fail" });
    return json({ ok: true, marked: "refunded" });
  }

  const claimed = await env.DB.prepare("UPDATE payments SET status = 'disputed' WHERE session_id = ? AND status != 'disputed'").bind(row.session_id).run();
  if ((claimed.meta.changes ?? 0) !== 1) return json({ ok: true, already: "disputed" });
  if (row.user_id && row.credits > 0) await takeBackCredits(env, row.user_id, row.credits, row.session_id);
  // The referral reward this payment earned goes with it, from both sides (src/referral.ts).
  await takeBackReferral(env, row.session_id);
  await audit(env, row.user_id, null, "stripe.disputed", { payment_intent: pi, session: row.session_id, credits_taken: row.credits });
  return json({ ok: true, marked: "disputed", credits_taken: row.credits });
}
