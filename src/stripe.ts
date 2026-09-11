import type { Env } from "./env";
import { getUser, creditPurchase, audit } from "./db";
import { json, hmacHex, safeEqual } from "./util";

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

/** True when the owner has actually configured selling: three links and a webhook secret. Everything degrades to
 *  "not open yet" until then, the same way notify.ts stays silent without RESEND_API_KEY. */
export const sellingOpen = (env: Env): boolean =>
  !!env.STRIPE_WEBHOOK_SECRET && PACKS.every((p) => (env[p.linkVar] ?? "").startsWith("https://"));

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
  if (!env.STRIPE_WEBHOOK_SECRET) {
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
  if (!(await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, sig, raw, Date.now())))
    return json({ error: "bad signature" }, 400);

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
  if (event.type !== "checkout.session.completed") return json({ ok: true, ignored: event.type ?? "unknown" });

  const s = event.data?.object ?? {};
  const sessionId = typeof s.id === "string" ? s.id : "";
  const userId = typeof s.client_reference_id === "string" ? s.client_reference_id : "";
  const cents = typeof s.amount_total === "number" ? s.amount_total : -1;
  const currency = typeof s.currency === "string" ? s.currency : "";
  const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
  const email = typeof (s.customer_details as { email?: unknown } | undefined)?.email === "string"
    ? ((s.customer_details as { email: string }).email) : null;

  // Everything below is a reason to accept the event and do nothing — never a reason to make Stripe retry.
  if (!sessionId || !paid) return json({ ok: true, ignored: "not a completed payment" });
  const pack = packForAmount(cents);
  if (!pack) return json({ ok: true, ignored: `no pack costs ${cents} ${currency}` });

  const pi = typeof s.payment_intent === "string" ? s.payment_intent : null;
  const country = (s.customer_details as { address?: { country?: unknown } } | undefined)?.address?.country;
  // An account that does not exist does not stop the row being written: money that arrived has to be written down
  // even when nobody can be credited for it, or the payment exists and the record does not. Only the credits are
  // withheld, and the audit says orphan so it can be found and fixed by hand.
  const known = userId && (await getUser(env, userId)) ? userId : null;

  const credited = await creditPurchase(env, {
    sessionId, userId: known, credits: pack.credits, cents, currency, email,
    paymentIntent: pi, eventId: event.id ?? null, eventType: event.type ?? null,
    country: typeof country === "string" ? country : null, rawRef: userId || null,
  });
  return json({ ok: true, credits: known ? pack.credits : 0, orphan: !known, already: !credited });
}
