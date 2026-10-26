/**
 * KLEO STUDIO — THE PAYMENT E-MAILS (27 October 2026, the owner: "fai anche mail di pagamento e quando si iscrivono a un
 * abbonamento dove gli dici tutti quanti gli accessi che ha sbloccato").
 *
 * Every paid payment the webhook writes down (src/stripe.ts, payments) gets one e-mail from hello@kleooai.com, sent by
 * the Studio cron within a few minutes:
 *  · a pack: the credits that arrived and the balance; on the account's first purchase, everything that purchase
 *    unlocked (every model, every app, the templates, Kleo films);
 *  · a plan: what the plan gives every month, and everything it unlocked, read from the live catalogue (the models,
 *    the picture models, the apps, the templates in 720p and 1080p, the top-up bonus), when its next credits come and
 *    when it renews;
 *  · a renewal: the new credits, the balance and the next renewal.
 * A receipt, not a mailing: no unsubscribe link (it is about money the person paid), the payment's own address, once
 * per payment (studio_receipts). Only payments made after the e-mails were first switched on ('receipts_since'), so
 * nobody gets a receipt for last week. The switch is studio_meta 'receipts_mode' (missing = on), in the console's
 * Emails page.
 */
import type { StudioEnv } from "./env.ts";
import { MODELS } from "./models.ts";
import { IMAGE_MODELS } from "./image-models.ts";
import { TOOLS } from "./tools.ts";
import { PLANS, planByKey, planForAmount, type Plan } from "../plans.ts";
import { PACKS, packForAmount } from "../stripe.ts";
import { deliver, factsOf, type Mail } from "./onboarding.ts";
export { RECEIPTS_SCHEMA } from "./mail-schema.ts";

const APP = "https://app.kleooai.com";

export type ReceiptKind = "pack" | "plan" | "renewal";

export interface ReceiptFacts {
  name: string | null;
  /** Credits this payment added (the pack's, with any plan or referral bonus the webhook gave). */
  credits: number;
  balance: number;
  /** Euros the payment was, in cents. */
  cents: number;
  /** The account's first purchase. */
  first: boolean;
  /** The plan, for a plan or a renewal (or the one the account is on, for a pack). */
  plan: Plan | null;
  period: "month" | "year" | null;
  planCredits: number | null;
  /** When the plan's next monthly credits come, and when it renews (ISO). */
  nextGrant: string | null;
  until: string | null;
}

const eur = (cents: number): string => `€${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const day = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};
const hi = (f: ReceiptFacts): string => `Hi ${f.name ?? "there"},`;
const u = (path: string, key: string): string => `${APP}${path}${path.includes("?") ? "&" : "?"}utm_source=email&utm_medium=receipt&utm_campaign=${key}`;
const SIGN = { p: "Leonardo\nFounder, Kleo" };

/** Everything a paid account can use, from the live catalogue, so the e-mail never promises what the app does not have. */
export function unlocked(withPlan: boolean): string[] {
  const apps = TOOLS.filter((t) => t.group !== "trend").map((t) => t.name);
  const templates = TOOLS.filter((t) => t.group === "trend").length;
  return [
    `**Every video model**: ${MODELS.map((m) => m.name).join(", ")}, at every length and resolution each one offers.`,
    `**Every picture model**: ${IMAGE_MODELS.map((m) => m.name).join(", ")}.`,
    `**Every app**: ${apps.join(", ")}.`,
    withPlan ? `**All ${templates} viral templates in 480p, 720p and 1080p.**` : `**All ${templates} viral templates**, in 480p (720p and 1080p come with a plan).`,
    "**Kleo films** up to 5 minutes, in the app and inside Claude and ChatGPT.",
  ];
}

export function composeReceipt(kind: ReceiptKind, f: ReceiptFacts): Mail {
  const key = `r-${kind}`;
  if (kind === "plan" && f.plan) {
    const per = f.period === "year" ? "yearly" : "monthly";
    const perks = [
      ...unlocked(true),
      `**${f.planCredits ?? 0} new credits every month**${f.period === "year" ? ", every month of the year you paid for" : ""}; credits never expire.`,
      ...(f.plan.topupBonus ? [`**+${Math.round(f.plan.topupBonus * 100)}% credits on every top-up** while the plan is on.`] : []),
      "**Commercial use** of everything you make.",
    ];
    return { key, subject: `Welcome to Kleo ${f.plan.name}: everything you unlocked`, preheader: `${f.planCredits} credits are on your account, and every model is open.`, blocks: [
      { p: hi(f) },
      { p: `Thank you for choosing Kleo ${f.plan.name} (${per}, ${eur(f.cents)}). ${f.planCredits} credits are already on your account, and you have ${f.balance} in all.` },
      { h: "What your plan unlocks" },
      { list: perks },
      { h: "Your plan" },
      { list: [
        ...(day(f.nextGrant) ? [`Your next ${f.planCredits} credits arrive on ${day(f.nextGrant)}.`] : []),
        ...(day(f.until) ? [`It renews on ${day(f.until)}, ${f.period === "year" ? "once a year" : "every month"}.`] : []),
        "To change or cancel it, reply to this e-mail: you keep everything until the end of what you paid for.",
      ] },
      { button: { label: "Open Kleo", url: u("/", key) } },
      { p: "If anything doesn't work the way you expect, reply here. It comes straight to me." },
      SIGN] };
  }
  if (kind === "renewal" && f.plan) {
    return { key, subject: `Your Kleo ${f.plan.name} renewed: ${f.credits} new credits`, preheader: `You have ${f.balance} credits now.`, blocks: [
      { p: hi(f) },
      { p: `Your Kleo ${f.plan.name} plan renewed (${eur(f.cents)}), and ${f.credits} new credits are on your account. You have ${f.balance} in all; credits never expire.` },
      ...(day(f.until) ? [{ p: `The next renewal is on ${day(f.until)}. To change or cancel the plan, reply to this e-mail.` }] : []),
      { button: { label: "Open Kleo", url: u("/", key) } },
      SIGN] };
  }
  // A pack (or anything else that bought credits).
  const bonus = f.plan && f.plan.topupBonus ? ` (with your ${f.plan.name} plan's +${Math.round(f.plan.topupBonus * 100)}%)` : "";
  return { key, subject: f.first ? "Your Kleo credits are in, and everything is unlocked" : `Your ${f.credits} Kleo credits are in`, preheader: `You have ${f.balance} credits now.`, blocks: [
    { p: hi(f) },
    { p: `Thank you for your purchase (${eur(f.cents)}). ${f.credits} credits are on your account${bonus}, and you have ${f.balance} in all. Credits never expire.` },
    ...(f.first ? [{ h: "What your first purchase unlocked" }, { list: unlocked(!!f.plan) }] : []),
    ...(f.plan ? [] : [{ p: `Making videos every week? The [plans](${u("/plans", key)}) give credits every month for less per credit, and open the templates in 720p and 1080p.` }]),
    { button: { label: "Open Kleo", url: u("/", key) } },
    { p: "If anything doesn't work the way you expect, reply here. It comes straight to me." },
    SIGN] };
}

/** Sample facts for the console's previews and the owner's test send. */
export const sampleReceipt = (kind: ReceiptKind): ReceiptFacts => {
  const pro = PLANS.find((p) => p.key === "pro") ?? null;
  return kind === "pack"
    ? { name: "Alex", credits: PACKS[1].credits, balance: PACKS[1].credits + 3, cents: PACKS[1].cents, first: true, plan: null, period: null, planCredits: null, nextGrant: null, until: null }
    : { name: "Alex", credits: pro?.tiers[0].credits ?? 110, balance: (pro?.tiers[0].credits ?? 110) + 4, cents: pro?.tiers[0].cents ?? 3900, first: kind === "plan", plan: pro, period: "month",
      planCredits: pro?.tiers[0].credits ?? 110, nextGrant: new Date(Date.now() + 28 * 86_400_000).toISOString(), until: new Date(Date.now() + 31 * 86_400_000).toISOString() };
};
export const RECEIPT_KINDS: { key: string; kind: ReceiptKind; name: string }[] = [
  { key: "r-pack", kind: "pack", name: "Payment · credit pack" }, { key: "r-plan", kind: "plan", name: "Payment · plan started" }, { key: "r-renewal", kind: "renewal", name: "Payment · plan renewed" },
];

export async function receiptsOn(env: StudioEnv): Promise<boolean> {
  return ((await env.DB.prepare("SELECT value FROM studio_meta WHERE key = 'receipts_mode'").first<{ value: string }>())?.value ?? "on") === "on";
}

interface PayRow { session_id: string; user_id: string; credits: number; amount_cent: number; email: string | null; event_type: string | null; at: string }

/** The cron's turn: every paid payment since the switch that has no receipt yet, at most ten. */
export async function receiptsTick(env: StudioEnv, nowMs = Date.now()): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  // The first run sets the line: only payments from now on get a receipt.
  await env.DB.prepare("INSERT OR IGNORE INTO studio_meta (key, value) VALUES ('receipts_since', ?)").bind(new Date(nowMs).toISOString()).run();
  if (!(await receiptsOn(env))) return out;
  const since = (await env.DB.prepare("SELECT value FROM studio_meta WHERE key = 'receipts_since'").first<{ value: string }>())?.value ?? new Date(nowMs).toISOString();
  const rows = (await env.DB.prepare(`SELECT p.session_id, p.user_id, p.credits, p.amount_cent, p.email, p.event_type, p.at FROM payments p
      WHERE p.at >= ? AND p.status = 'paid' AND p.user_id IS NOT NULL AND p.amount_cent > 0
      AND NOT EXISTS (SELECT 1 FROM studio_receipts r WHERE r.session_id = p.session_id) ORDER BY p.at LIMIT 10`).bind(since).all<PayRow>()).results ?? [];
  for (const p of rows) {
    const record = (kind: string, email: string | null, ok: number, error: string | null) =>
      env.DB.prepare("INSERT OR IGNORE INTO studio_receipts (session_id, user_id, kind, email, ok, error) VALUES (?, ?, ?, ?, ?, ?)").bind(p.session_id, p.user_id, kind, email, ok, error).run();
    const facts = await factsOf(env, p.user_id);
    const email = facts?.email ?? p.email;
    if (!facts || facts.closed || !email) { await record("skip", email, 0, facts?.closed ?? "no address"); out.skipped++; continue; }
    const u2 = await env.DB.prepare("SELECT plan, plan_period, plan_credits, plan_until, plan_next_grant, plan_status, credits FROM users WHERE id = ?").bind(p.user_id)
      .first<{ plan: string | null; plan_period: string | null; plan_credits: number | null; plan_until: string | null; plan_next_grant: string | null; plan_status: string | null; credits: number }>();
    const priorPaid = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND status = 'paid' AND amount_cent > 0 AND at < ?").bind(p.user_id, p.at).first<{ n: number }>())?.n ?? 0);
    const asPlan = planForAmount(p.amount_cent);
    const asPack = packForAmount(p.amount_cent);
    const kind: ReceiptKind | null = p.event_type === "invoice.paid" ? "renewal" : asPlan && !asPack ? "plan" : asPack ? "pack" : null;
    if (!kind) { await record("skip", email, 0, `no pack or plan costs ${p.amount_cent}`); out.skipped++; continue; }
    const activePlan = u2?.plan && u2.plan !== "trial" && (u2.plan_status ?? "active") === "active" ? planByKey(u2.plan) : null;
    const f: ReceiptFacts = {
      name: facts.name, credits: Number(p.credits) || 0, balance: Number(u2?.credits ?? facts.credits) || 0, cents: p.amount_cent, first: priorPaid === 0,
      plan: kind === "pack" ? activePlan : asPlan?.plan ?? activePlan, period: kind === "pack" ? null : (asPlan?.period ?? (u2?.plan_period === "year" ? "year" : "month")),
      planCredits: kind === "pack" ? null : (asPlan?.tier.credits ?? u2?.plan_credits ?? null), nextGrant: u2?.plan_next_grant ?? null, until: u2?.plan_until ?? null,
    };
    const r = await deliver(env, email, composeReceipt(kind, f), null, `receipt:${kind}`);
    // Kleo's own side refused (domain, quota): nothing is written, the receipt goes out on a later tick.
    if (!r.ok && /E_SENDER|E_DOMAIN|not verified|E_NO_BINDING|RATE|QUOTA|LIMIT|429/i.test(`${r.code} ${r.error}`)) { out.failed++; break; }
    await record(kind, email, r.ok ? 1 : 0, r.ok ? null : `${r.code}: ${r.error}`);
    await env.DB.prepare("INSERT INTO studio_mail_log (user_id, email, mail, kind, ok, error, message_id) VALUES (?, ?, ?, 'receipt', ?, ?, ?)")
      .bind(p.user_id, email, `r-${kind}`, r.ok ? 1 : 0, r.ok ? null : `${r.code}: ${r.error}`, r.ok ? r.id : null).run();
    if (r.ok) out.sent++; else out.failed++;
  }
  return out;
}
