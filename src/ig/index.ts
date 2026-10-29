/**
 * kleo-ig-publisher (wrangler.ig.jsonc): every minute, one turn of the Instagram publisher (src/ig/publisher.ts).
 * No HTTP surface: workers.dev and preview URLs are off and no route points here. Posts arrive through D1
 * (scripts/ig-schedule.mjs), and each one goes out only after the owner's "sì" for it.
 */
import { tick, type IgEnv } from "./publisher.ts";

export default {
  async scheduled(_controller: ScheduledController, env: IgEnv): Promise<void> {
    await tick(env);
  },
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<IgEnv>;
