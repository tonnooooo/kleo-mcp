/**
 * THE OWNER'S MORNING E-MAIL (27 October 2026): once a day at 8:00 in Auckland, while the welcome e-mails or the
 * outreach are on, one plain e-mail to the owner's inbox with what the last 24 hours did: welcome e-mails sent and
 * stopped, outreach e-mails sent, replies by kind (the interested ones by name), bounces, and what today allows. Nothing
 * is sent on a day when both are off.
 */
import type { StudioEnv } from "./env.ts";
import { mailOwner } from "./providers.ts";

const ZONE = "Pacific/Auckland";

function aucklandDayHour(ms: number): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hour12: false }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

const n = async (env: StudioEnv, sql: string, ...a: unknown[]): Promise<number> => Number((await env.DB.prepare(sql).bind(...a).first<{ n: number }>())?.n ?? 0);

/** The morning e-mail, if it is 8:00 in Auckland, something is on, and today's has not gone yet. True when sent. */
export async function morningDigest(env: StudioEnv, nowMs = Date.now()): Promise<boolean> {
  const { day, hour } = aucklandDayHour(nowMs);
  if (hour !== 8) return false;
  const meta = async (k: string) => (await env.DB.prepare("SELECT value FROM studio_meta WHERE key = ?").bind(k).first<{ value: string }>())?.value ?? null;
  const welcomeOn = (await meta("onboarding_mode")) === "on", outreachOn = (await meta("outreach_mode")) === "on";
  if (!welcomeOn && !outreachOn) return false;
  if ((await meta("digest_sent_on")) === day) return false;
  await env.DB.prepare("INSERT INTO studio_meta (key, value) VALUES ('digest_sent_on', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(day).run();
  const since = new Date(nowMs - 86_400_000).toISOString();
  const lines: string[] = [];
  if (welcomeOn) {
    const sent = await n(env, "SELECT COUNT(*) AS n FROM studio_mail_log WHERE kind = 'live' AND ok = 1 AND at >= ?", since);
    const refused = await n(env, "SELECT COUNT(*) AS n FROM studio_mail_log WHERE kind = 'live' AND ok = 0 AND at >= ?", since);
    const unsub = await n(env, "SELECT COUNT(*) AS n FROM mail_suppress WHERE source = 'onboarding' AND at >= ?", since);
    const active = await n(env, "SELECT COUNT(*) AS n FROM studio_mail WHERE status = 'active'");
    const paid = await n(env, "SELECT COUNT(DISTINCT m.user_id) AS n FROM studio_mail m JOIN payments p ON p.user_id = m.user_id AND p.status = 'paid' AND p.amount_cent > 0 AND p.at >= ?", since);
    lines.push("WELCOME E-MAILS", `Sent in the last 24 hours: ${sent}${refused ? ` (${refused} refused)` : ""}. Unsubscribed or bounced: ${unsub}. Accounts in a series now: ${active}.`,
      `Accounts in a series that paid in the last 24 hours: ${paid}.`, "");
  }
  if (outreachOn) {
    const sent = await n(env, "SELECT COUNT(*) AS n FROM outreach_log WHERE ok = 1 AND step < 9 AND at >= ?", since);
    const yeses = await n(env, "SELECT COUNT(*) AS n FROM outreach_log WHERE ok = 1 AND step = 9 AND at >= ?", since);
    const firsts = await n(env, "SELECT COUNT(*) AS n FROM outreach_log WHERE ok = 1 AND step = 0 AND at >= ?", since);
    const replies = ((await env.DB.prepare(`SELECT r.class, r.summary, r.from_addr, p.company FROM outreach_replies r LEFT JOIN outreach_prospects p ON p.id = r.prospect_id
        WHERE r.at >= ? ORDER BY r.id`).bind(since).all<{ class: string; summary: string | null; from_addr: string; company: string | null }>()).results ?? []);
    const waiting = await n(env, "SELECT COUNT(*) AS n FROM outreach_prospects WHERE status = 'approved'");
    const toApprove = await n(env, "SELECT COUNT(*) AS n FROM outreach_prospects WHERE status = 'new'");
    const paused = ((await env.DB.prepare("SELECT from_addr FROM outreach_senders WHERE status = 'paused'").all<{ from_addr: string }>()).results ?? []).map((r) => r.from_addr);
    const boxes = await n(env, "SELECT COUNT(*) AS n FROM outreach_senders WHERE status != 'off'");
    const signedUp = ((await env.DB.prepare("SELECT company FROM outreach_prospects WHERE converted_at >= ?").bind(since).all<{ company: string }>()).results ?? []).map((r) => r.company);
    const scouted = await n(env, "SELECT COUNT(*) AS n FROM outreach_prospects WHERE batch LIKE 'scout%' AND added_at >= ?", since);
    const scoutError = await meta("scout_error");
    const by = (c: string) => replies.filter((r) => r.class === c).length;
    lines.push("OUTREACH", `Sent in the last 24 hours: ${sent} (${firsts} first e-mails, ${sent - firsts} follow-ups) from ${boxes} mailbox${boxes === 1 ? "" : "es"}.${paused.length ? ` PAUSED: ${paused.join(", ")} refused to send, check the app password in the console.` : ""}`,
      `Replies: ${replies.length - by("bounce")} (interested ${by("interested")}, questions ${by("question")}, no ${by("not_interested") + by("unsubscribe")}, out of office ${by("out_of_office")}). Bounced: ${by("bounce")}.`);
    for (const r of replies.filter((x) => x.class === "interested" || x.class === "question" || x.class === "other")) lines.push(`  - ${r.company ?? r.from_addr} (${r.class}): ${r.summary ?? ""}`);
    if (yeses) lines.push(`Answers to a yes, with their link: ${yeses}.`);
    if (signedUp.length) lines.push(`Signed up through their link: ${signedUp.join(", ")}.`);
    lines.push(`New businesses found by the scout: ${scouted}.${scoutError ? ` Scout trouble: ${scoutError}` : ""}`,
      `Approved and not written to yet: ${waiting}. Waiting for your approval: ${toApprove}.`, "");
  }
  lines.push("Details: https://admin.kleooai.com/admin/emails and https://admin.kleooai.com/admin/outreach", "One e-mail a day at 8:00 Auckland time while either is on.");
  return mailOwner(env, `Kleo e-mails, ${day}`, lines.join("\n"), nowMs);
}
