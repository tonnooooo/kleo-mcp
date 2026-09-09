import type { Env } from "./env";
import type { Job } from "./db";

/** Emails the download links when a job finishes. Uses Resend if RESEND_API_KEY is set; otherwise a no-op. */
export async function notifyDone(env: Env, job: Job, links: Record<string, string>): Promise<void> {
  if (!job.notify_email || !env.RESEND_API_KEY) return;
  const lines = Object.entries(links).map(([k, v]) => `${k.replace("_url", "")}: ${v}`).join("\n");
  const body = {
    from: env.NOTIFY_FROM ?? "Gatto <noreply@example.com>",
    to: [job.notify_email],
    subject: `Your video is ready (${job.id})`,
    text: `Your ${job.template} video is rendered.\n\n${lines}\n\nLinks expire on ${job.expires_at}.`,
  };
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
