/**
 * THE BENCH. Not part of Kleo: a Worker whose only job is to ask the real model, on the real Workers AI binding,
 * to choose a look for one request — phase 0 and nothing else.
 *
 * Why it exists: the word-list fallback (pickKleoStyle) has been measured at 26% on held-out requests, and that
 * number has been quoted for hours as if it were Kleo's accuracy. It is not. Since the planner learned to prefer
 * the direction's answer, the word list only decides when the model call fails — and what the MODEL chooses had
 * never been measured by anyone. This runs that measurement, and only that, so it costs one call per request
 * (~83 neurons) instead of a whole storyboard.
 *
 * It is run with `wrangler dev --remote`, so the model runs on Cloudflare's edge and nothing executes on the
 * owner's computer. It never touches the production Worker, D1 or R2: no bindings but AI.
 */
import { planFor, directionPrompt, directionSchema, callModel } from "../../src/storyboard.ts";
import type { Env } from "../../src/env.ts";

const DEFAULT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("POST {template, prompt, duration_s, format, language}", { status: 405 });
    const b = (await request.json()) as { template?: string; prompt?: string; duration_s?: number; format?: string; language?: string; model?: string };
    const job = {
      id: "bench",
      template: b.template ?? "viral-short",
      prompt: String(b.prompt ?? ""),
      // No style: this is exactly the shape that makes the planner ask the model to choose one.
      params: JSON.stringify({ duration_s: b.duration_s ?? 45, format: b.format ?? "9:16", language: b.language ?? "en", voice: null }),
    };
    const plan = planFor(job);
    const model = b.model || env.AI_MODEL || DEFAULT_MODEL;
    const t0 = Date.now();
    try {
      const { raw, usage } = await callModel(env, model, [{ role: "user", content: directionPrompt(job, plan) }], directionSchema(), 900);
      const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as { style?: string; why?: string; direction?: Record<string, unknown> };
      return Response.json({
        ok: true,
        style: r?.style ?? null,
        why: r?.why ?? null,
        // What the direction actually decided, so a wrong look can be read rather than guessed at.
        subject: (r?.direction as { subject?: string } | undefined)?.subject ?? null,
        sections: ((r?.direction as { sections?: { name: string; accent: string }[] } | undefined)?.sections ?? []).map((s) => `${s.name}:${s.accent}`),
        prior: plan.kleo,           // what the word list would have said on its own
        usage, ms: Date.now() - t0, model,
      });
    } catch (e) {
      return Response.json({ ok: false, error: String(e).slice(0, 300), prior: plan.kleo, ms: Date.now() - t0 }, { status: 200 });
    }
  },
};
