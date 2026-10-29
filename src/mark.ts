/**
 * THE KLEO MARK (28-29 October 2026): what an account that never paid makes carries "Made with Kleo", so every free
 * creation shared online advertises Kleo. One rule for both Workers:
 *   - kleo-studio serves marked copies of its pictures and clips (src/studio/watermark.ts, generate.ts showsMark);
 *   - kleo-mcp decides it once per video when the job is created (src/jobs.ts createJob, params.mark), and the box
 *     burns the mark into the delivered video.mp4 (worker/kleo_mark.py), so every road the video leaves by carries it:
 *     Studio's copy, the MCP /dl links, the job-done e-mail. In practice that is the animatic (the free product) and the
 *     launch-code trial film; every other film needs a payment.
 * No mark for: a payment on record (a pack or a plan; refunded or disputed ones do not count, src/db.ts hasPaid), a
 * Studio admin (STUDIO_ADMINS; the owner's own account also carries a tester payment), a Pro partner of Kleo Creators
 * (a plan from the program, with no Stripe payment), or STUDIO_WATERMARK = "off" (set it on each Worker that should stop).
 */
import type { Env } from "./env";
import { hasPaid } from "./db.ts";
import { compPlanActive } from "./studio/creators-schema.ts";
import type { StudioEnv } from "./studio/env.ts";

export interface MarkEnv { DB: D1Database; STUDIO_WATERMARK?: string; STUDIO_ADMINS?: string }

export const markSwitchedOff = (env: MarkEnv): boolean => (env.STUDIO_WATERMARK ?? "").trim() === "off";
export const isMarkFreeAdmin = (env: MarkEnv, userId: string): boolean =>
  (env.STUDIO_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(userId);

/** True when what this account makes carries the Kleo mark. `paid` skips the payment read when the caller has it. */
export async function marksAccount(env: MarkEnv, userId: string, paid?: boolean): Promise<boolean> {
  if (markSwitchedOff(env) || isMarkFreeAdmin(env, userId)) return false;
  // Both reads at once: Studio asks this on every /media request of such an account, Range requests of a clip included.
  const [hasPayment, comp] = await Promise.all([
    paid ?? hasPaid(env as unknown as Env, userId),
    compPlanActive(env as unknown as StudioEnv, userId),
  ]);
  return !hasPayment && !comp;
}
