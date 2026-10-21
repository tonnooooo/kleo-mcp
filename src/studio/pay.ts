/**
 * KLEO STUDIO — APPLE PAY AND GOOGLE PAY INSIDE THE APP (21 October 2026, the owner: "dal telefono la conversione più
 * easy … Safari Apple Pay, Android Google Pay, in modo da semplificare all'utente tutto quanto").
 *
 * On a phone, the Get credits sheet and the plans page show Stripe's own Apple Pay or Google Pay button (the Express
 * Checkout Element of Stripe.js) instead of sending the buyer to Stripe's checkout page: one tap, Face ID, paid, and the
 * buyer never leaves Kleo. The button pays a Checkout Session made here with the account's restricted key
 * (STRIPE_SECRET_KEY: Checkout Sessions, Customers, Subscriptions and Payment Method Domains write; Products, Prices
 * and Invoices read), for the very Stripe Price the matching Payment Link sells:
 *
 *   POST /v1/checkout/sessions  mode=payment|subscription  ui_mode=elements  line_items[0][price]=…  client_reference_id=<account>
 *
 * (docs.stripe.com, Express Checkout Element with the Checkout Sessions API, read 21 October 2026.)
 *
 * NOTHING HERE MINTS CREDITS. They arrive exactly as they do for a Payment Link: Stripe sends checkout.session.completed
 * to the MCP Worker's webhook (src/stripe.ts), which names the pack or plan by the EUR amount actually paid and the
 * account by client_reference_id. A session only says what the buyer is about to pay for.
 *
 * The Prices are found by amount (src/stripe.ts PACKS, src/plans.ts periodCents) among the account's active EUR prices,
 * read once and kept for ten minutes. app.kleooai.com and kleooai.com are registered payment method domains (Apple
 * Pay, Google Pay, Link and PayPal active, 21 October 2026).
 */
import type { StudioEnv } from "./env.ts";
import { PACKS } from "../stripe.ts";
import { periodCents, planByKey } from "../plans.ts";
import { StudioError } from "./generate.ts";

const STRIPE_API = "https://api.stripe.com";
interface Price { id: string; currency: string; unit_amount: number | null; type: string; active?: boolean; recurring?: { interval?: string } | null }
let priceCache: { key: string; at: number; prices: Price[] } | null = null;
const PRICE_TTL_MS = 10 * 60_000;

async function stripe<T>(key: string, method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`stripe ${method} ${path} → ${res.status}: ${String(data.error?.message ?? "").slice(0, 200)}`);
  return data;
}

async function activePrices(key: string): Promise<Price[]> {
  if (priceCache && priceCache.key === key && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.prices;
  const d = await stripe<{ data?: Price[] }>(key, "GET", "/v1/prices?active=true&limit=100");
  const prices = (d.data ?? []).filter((p) => p.currency === "eur" && typeof p.unit_amount === "number");
  priceCache = { key, at: Date.now(), prices };
  return prices;
}

export interface PayRequest { pack?: unknown; plan?: unknown; tier?: unknown; period?: unknown }
export interface PaySession { clientSecret: string; publishableKey: string; label: string; cents: number }

const UNAVAILABLE = () => new StudioError("Apple Pay and Google Pay aren't available right now. Use the checkout instead — nothing was charged.", 503, "pay_unavailable");

/**
 * The Checkout Session the wallet button pays: a credit pack ({pack: 10 | 35 | 100}) or a plan ({plan, tier, period}).
 * Throws "pay_unavailable" (503) when the keys or the Price are missing: the page then opens the Payment Link instead.
 */
export async function createPaySession(env: StudioEnv, userId: string, email: string | null, req: PayRequest, origin: string): Promise<PaySession> {
  const key = (env.STRIPE_SECRET_KEY ?? "").trim();
  const publishableKey = (env.STRIPE_PUBLISHABLE_KEY ?? "").trim();
  if (!key || !publishableKey) throw UNAVAILABLE();

  let mode: "payment" | "subscription", cents: number, interval: "month" | "year" | null = null, label: string;
  if (req.pack !== undefined && req.pack !== null) {
    const pack = PACKS.find((p) => p.credits === Number(req.pack));
    if (!pack) throw new StudioError("That credit pack doesn't exist.", 400, "pay_unknown");
    mode = "payment"; cents = pack.cents; label = `${pack.credits} credits`;
  } else {
    const plan = planByKey(typeof req.plan === "string" ? req.plan : null);
    const tier = plan?.tiers[Math.max(0, Math.floor(Number(req.tier ?? 0)) || 0)];
    if (!plan || !tier) throw new StudioError("That plan doesn't exist.", 400, "pay_unknown");
    interval = req.period === "year" ? "year" : "month";
    mode = "subscription"; cents = periodCents(tier, interval); label = `Kleo ${plan.name}`;
  }

  let prices: Price[];
  try { prices = await activePrices(key); } catch { throw UNAVAILABLE(); }
  const price = prices.find((p) => p.unit_amount === cents && (mode === "payment" ? p.type === "one_time" : p.type === "recurring" && p.recurring?.interval === interval));
  if (!price) throw UNAVAILABLE();

  const form: Record<string, string> = {
    mode, ui_mode: "elements", "line_items[0][price]": price.id, "line_items[0][quantity]": "1",
    client_reference_id: userId, return_url: `${origin}/?paid=1`, locale: "en",
    "metadata[kleo_user]": userId, "metadata[kleo_source]": "studio-wallet",
  };
  // The account's own address, so the receipt reaches it (accounts opened with a Kleo key have none).
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.endsWith(".invalid")) form.customer_email = email;
  let session: { id?: string; client_secret?: string };
  try { session = await stripe(key, "POST", "/v1/checkout/sessions", form); } catch { throw UNAVAILABLE(); }
  if (!session.client_secret) throw UNAVAILABLE();
  return { clientSecret: session.client_secret, publishableKey, label, cents };
}
