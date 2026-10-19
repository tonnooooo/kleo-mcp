/**
 * THE PLANS (19 October 2026, the owner: "metti delle subscription come fa Ausar … stessa identica cosa").
 *
 * Four monthly subscriptions next to the one-off packs (src/stripe.ts PACKS), sold through Stripe Payment Links in
 * subscription mode on the same Italy account and the same webhook. Like PACKS, this ONE list ties a price to a number
 * of credits: the webhook reads it to decide what an invoice bought, the pricing page reads it to draw the cards.
 *
 * Kleo's credit is not Ausar's: one Kleo credit sells for 0.40-0.50 EUR in the packs and costs at most ~0.275 $ of
 * provider money (credits = cost x 1.6 / 0.44, src/studio/models.ts). So the plans keep Ausar's prices and shape and
 * give Kleo-sized credits: always more per euro than the packs, never under ~1.15x the worst-case cost even on the
 * annual Agency tiers (most of what people make — pictures, cheap models — costs far less than the worst case;
 * test/stripe.test.mjs checks every tier and period stays over 1.1x the worst case).
 *
 *   plan      EUR/mo   credits/mo   EUR per credit (monthly · annual)   top-up bonus
 *   Lite         9        22           0.41 · 0.33                         —
 *   Starter     19        50           0.38 · 0.30                       +10%
 *   Pro         39       110           0.35 · 0.28                       +15%
 *   Agency     149       430           0.35 · 0.28                       +25%   (also 199 → 590, 249 → 750)
 *
 * Annual = about 20% off, rounded to whole euros a month (€7 · €15 · €31 · €119), paid at once for twelve months; the
 * credits still arrive every month (the cron, grantDuePlanCredits).
 * Credits never expire: a month's credits stay when the next arrive (kinder than Ausar's reset, and simpler).
 *
 * Pure module: no Env, no I/O.
 */

export type PlanKey = "lite" | "starter" | "pro" | "agency";
export type PlanPeriod = "month" | "year";

export interface PlanTier { cents: number; credits: number }
export interface Plan {
  key: PlanKey;
  name: string;
  tagline: string;
  /** Monthly price and credits; Agency has several (the slider), the first is its headline. */
  tiers: PlanTier[];
  /** Extra credits on every one-off pack while subscribed (0.15 = +15%). */
  topupBonus: number;
  popular?: boolean;
  features: string[];
}

export const ANNUAL_DISCOUNT = 0.2;

export const PLANS: Plan[] = [
  { key: "lite", name: "Lite", tagline: "For trying Kleo", tiers: [{ cents: 900, credits: 22 }], topupBonus: 0,
    features: ["Every video, image and audio model", "New credits every month", "Every app: swaps, motion, talking photos", "Kleo films, up to 5 minutes", "Commercial use"] },
  { key: "starter", name: "Starter", tagline: "For beginners & explorers", tiers: [{ cents: 1900, credits: 50 }], topupBonus: 0.1,
    features: ["Every video, image and audio model", "New credits every month", "Every app: swaps, motion, talking photos", "Kleo films, up to 5 minutes", "Commercial use", "+10% credits on top-ups"] },
  { key: "pro", name: "Pro", tagline: "For serious creators", tiers: [{ cents: 3900, credits: 110 }], topupBonus: 0.15, popular: true,
    features: ["Every video, image and audio model", "New credits every month", "Every app: swaps, motion, talking photos", "Kleo films, up to 5 minutes", "Commercial use", "+15% credits on top-ups"] },
  { key: "agency", name: "Agency", tagline: "For teams & agencies", tiers: [{ cents: 14900, credits: 430 }, { cents: 19900, credits: 590 }, { cents: 24900, credits: 750 }], topupBonus: 0.25,
    features: ["Every video, image and audio model", "New credits every month", "Every app: swaps, motion, talking photos", "Kleo films, up to 5 minutes", "Commercial use", "+25% credits on top-ups", "Volume credit tiers"] },
];

export const planByKey = (key: string | null | undefined): Plan | null => PLANS.find((p) => p.key === key) ?? null;
/** What one period costs: a month as listed, a year at 20% off twelve months, in whole cents. */
export const periodCents = (tier: PlanTier, period: PlanPeriod): number => (period === "month" ? tier.cents : yearMonthCents(tier) * 12);
/** An annual plan's price per month, 20% off rounded to whole euros (Ausar's way: $39 → $31): €7, €15, €31, €119. */
export const yearMonthCents = (tier: PlanTier): number => Math.round((tier.cents * (1 - ANNUAL_DISCOUNT)) / 100) * 100;
/** The Payment Link key of a plan tier and period, as STRIPE_PLAN_LINKS names it: "pro:month", "agency-620:year". */
export const linkKey = (plan: Plan, tier: PlanTier, period: PlanPeriod): string => `${plan.key}${plan.tiers.length > 1 && tier !== plan.tiers[0] ? `-${tier.credits}` : ""}:${period}`;

export interface PlanMatch { plan: Plan; tier: PlanTier; period: PlanPeriod }
/** The plan an invoice paid for, by its amount in EUR cents (every amount is unique, and none is a pack's). */
export function planForAmount(cents: number): PlanMatch | null {
  for (const plan of PLANS) for (const tier of plan.tiers) for (const period of ["month", "year"] as PlanPeriod[]) {
    if (periodCents(tier, period) === cents) return { plan, tier, period };
  }
  return null;
}

/** The top-up bonus of an active plan, in credits, for a pack of `credits`. */
export const topupBonusCredits = (plan: Plan | null, credits: number): number => (plan ? Math.round(credits * plan.topupBonus) : 0);

/** Every Payment Link the owner configured (STRIPE_PLAN_LINKS: JSON {"lite:month": "https://buy.stripe.com/…", …}), live links only. */
export function planLinks(raw: string | undefined): Record<string, string> {
  try {
    const all = JSON.parse(raw || "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(all).filter(([, v]) => typeof v === "string" && v.startsWith("https://buy.stripe.com/") && !v.includes("/test_")) as [string, string][]);
  } catch { return {}; }
}

/** The catalog the pricing page draws: prices, credits, discounts and the buy links (with the account tied in). */
export function publicPlans(raw: string | undefined, userId: string | null): unknown[] {
  const links = planLinks(raw);
  const base = PLANS[0].tiers[0].cents / PLANS[0].tiers[0].credits; // Lite monthly cents per credit
  return PLANS.map((p) => ({
    key: p.key, name: p.name, tagline: p.tagline, popular: !!p.popular, topupBonus: p.topupBonus, features: p.features,
    tiers: p.tiers.map((t) => ({
      credits: t.credits,
      month: { cents: periodCents(t, "month"), perMonth: periodCents(t, "month"), off: Math.max(0, Math.round((1 - t.cents / t.credits / base) * 100)), ...link(links, linkKey(p, t, "month"), userId) },
      year: { cents: periodCents(t, "year"), perMonth: Math.round(periodCents(t, "year") / 12), off: Math.max(0, Math.round((1 - periodCents(t, "year") / 12 / t.credits / base) * 100)), ...link(links, linkKey(p, t, "year"), userId) },
    })),
  }));
}
/** A visitor gets no link (they sign up first, or the payment would belong to nobody); "open" says whether one exists. */
function link(links: Record<string, string>, key: string, userId: string | null): { url: string | null; open: boolean } {
  const url = links[key];
  return { url: url && userId ? `${url}?client_reference_id=${encodeURIComponent(userId)}&locale=en` : null, open: !!url }; // checkout in English for everyone
}
