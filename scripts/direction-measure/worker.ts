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

/** The sentence in directionPrompt that tells the model how to choose a look. Copied verbatim; the bench refuses to
 *  run a variant if it can no longer find it, so a change to the real prompt cannot be measured as if it were this. */
const BASELINE_RULE =
  "- Choose the style from the request, not from a keyword: cartoon = drawn stories, kids, history, animals, travel; realistic = products, places, news, sport, documentary; cyber = motion design with no pictures at all, only for tech and security topics that want diagrams rather than scenes; stickman = only if the user asked for a stickman.";

/**
 * What the bench is here to settle.
 *
 * The schema offers the model FIVE looks (KLEO_STYLES) and the sentence above describes FOUR: "explainer" is in the
 * enum with no word said about it, so a model that answers it answers blind. Four of the twenty-seven held-out
 * requests want exactly that look, and the border set scores 0 of 7 today.
 *
 * Two coherent answers, and the measurement decides between them rather than an argument:
 *   described — tell the model what the explainer is, using the distinction the product already writes in mcp.ts:
 *               "cyber wants something to diagram, the explainer wants one thing explained".
 *   hidden    — take it out of the enum, matching the stated rule that the explainer is asked for by name only.
 */
const VARIANTS: Record<string, string> = {
  described:
    "- Choose the style from the request, not from a keyword: cartoon = drawn stories, kids, history, animals, travel; realistic = products, places, news, sport, documentary; cyber = motion design with no pictures, for tech and security topics that want something DIAGRAMMED; explainer = hand-drawn line art, for a request that wants ONE idea taken apart and the viewer's mind changed (\"explain why\", \"how does X really work\", \"spiegami\") — cyber and explainer share their subjects, so choose by what the viewer is meant to end up with, a picture of the system or an understanding; stickman = only if the user asked for a stickman.",
  hidden:
    "- Choose the style from the request, not from a keyword: cartoon = drawn stories, kids, history, animals, travel; realistic = products, places, news, sport, documentary; cyber = motion design with no pictures at all, only for tech and security topics that want diagrams rather than scenes; stickman = only if the user asked for a stickman. Never answer \"explainer\": that look is chosen by name only, and answering it here is an error.",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // GET / answers without touching the model: the readiness probe of tre-prompt.sh. Before this route the only
    // way to ask "is the bench up?" was a real request, which cost ~50 neurons when the quota was there and made the
    // ledger lie by one call when it was not.
    if (request.method === "GET") return Response.json({ ok: true, bench: true, model: env.AI_MODEL ?? DEFAULT_MODEL });
    if (request.method !== "POST") return new Response("POST {template, prompt, duration_s, format, language}", { status: 405 });
    const b = (await request.json()) as { template?: string; prompt?: string; duration_s?: number; format?: string; language?: string; model?: string; variant?: string };
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
    // VARIANTS. The bench must be able to compare two wordings on the same requests in one sitting, because a
    // prompt changed without a baseline is a prompt nobody can say anything about — which is how four correct
    // instructions made every other rule work worse tonight, in a different session, caught only by the number
    // from before. Each variant is a replacement of ONE sentence of the real prompt, never a copy of it.
    let text = directionPrompt(job, plan);
    const variant = b.variant ?? "baseline";
    if (variant !== "baseline") {
      const rule = VARIANTS[variant];
      if (!rule) return Response.json({ ok: false, error: `unknown variant ${variant}`, prior: plan.kleo }, { status: 400 });
      const before = text;
      text = text.replace(BASELINE_RULE, rule);
      if (text === before) return Response.json({ ok: false, error: "the sentence this variant replaces is no longer in the prompt: the bench is measuring something else", prior: plan.kleo }, { status: 500 });
    }
    try {
      const { raw, usage } = await callModel(env, model, [{ role: "user", content: text }], directionSchema(), 900);
      const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as { style?: string; why?: string; direction?: Record<string, unknown> };
      return Response.json({
        ok: true,
        style: r?.style ?? null,
        why: r?.why ?? null,
        // What the direction actually decided, so a wrong look can be read rather than guessed at.
        subject: (r?.direction as { subject?: string } | undefined)?.subject ?? null,
        sections: ((r?.direction as { sections?: { name: string; accent: string }[] } | undefined)?.sections ?? []).map((s) => `${s.name}:${s.accent}`),
        prior: plan.kleo,           // what the word list would have said on its own
        usage, ms: Date.now() - t0, model, variant,
      });
    } catch (e) {
      return Response.json({ ok: false, error: String(e).slice(0, 300), prior: plan.kleo, ms: Date.now() - t0 }, { status: 200 });
    }
  },
};
