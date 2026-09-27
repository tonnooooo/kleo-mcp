import type { Env } from "./env";
import type { Job } from "./db";
import { audit } from "./db.ts";
import { deliveryAddressFor, sendEmail, unsubscribeLink } from "./email.ts";

/**
 * Emails the download links when a job finishes, through Resend (src/email.ts sendEmail; a no-op without
 * RESEND_API_KEY). The address is the one given with the job (notify_email) or, since 27 September 2026, the account's
 * VERIFIED contact email; a mail to the contact email carries the link that removes it.
 */
export async function notifyDone(env: Env, job: Job, links: Record<string, string>): Promise<void> {
  const to = await deliveryAddressFor(env, job);
  if (!to) return;
  const lines = Object.entries(links).map(([k, v]) => `${k.replace("_url", "")}: ${v}`).join("\n");
  const unsubscribe = to.contact ? await unsubscribeLink(env, env.PUBLIC_URL, job.user_id) : undefined;
  const sent = await sendEmail(env, {
    to: to.to,
    subject: `Your video is ready (${job.id})`,
    text: `Your Kleo video ${job.id} is rendered.\n\n${lines}\n\nLinks expire on ${job.expires_at}.${unsubscribe ? `\n\nYou get this email because you verified this address on your Kleo account. Stop these emails: ${unsubscribe}` : ""}`,
    unsubscribe,
  });
  if (to.contact) await audit(env, job.user_id, job.id, sent ? "email.delivered" : "email.delivery_failed", {});
}
