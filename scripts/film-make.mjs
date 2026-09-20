#!/usr/bin/env node
/**
 * One film, planned by the real chain: treatment → direction → outline → scenes, on the production model, with no
 * job, no credit and no GPU. It prints what a person needs to judge whether the planner FOLLOWS its own treatment:
 * the treatment's angle and layer, the direction's subject and world, the acts against the sections, the narration
 * scene by scene, the layer states the scenes wrote, and the cost.
 *
 *   node scripts/film-make.mjs "<request>" [--duration 45] [--format 9:16] [--lang it] [--out file.json] [--model <workers-ai id>] [--budget <minutes>]
 *
 * Reads the Cloudflare account from wrangler.jsonc and the token from the wrangler OAuth session (the same Workers AI
 * the deployed worker uses; the token expires, `npx wrangler whoami` refreshes it). Renders nothing, rents nothing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateStoryboard } from "../src/storyboard.ts";
import { validateStoryboard, narrationOf } from "../src/keou-contract.ts";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const request = args[0];
if (!request || request.startsWith("--")) { console.error('usage: film-make.mjs "<request>" [--duration 45] [--format 9:16] [--lang it] [--out file.json]'); process.exit(2); }
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const duration_s = Number(opt("--duration", 45)), format = opt("--format", "9:16"), language = opt("--lang", "en"), out = opt("--out", null);

const jsonc = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
const account = /"account_id"\s*:\s*"([0-9a-f]+)"/.exec(jsonc)?.[1];
const token = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(`${process.env.HOME}/.wrangler/config/default.toml`, "utf8"))?.[1];
const model = opt("--model", /"AI_MODEL"\s*:\s*"([^"]+)"/.exec(jsonc)?.[1]);   // --model @cf/openai/gpt-oss-120b to try another Workers AI model
if (!account || !token) { console.error("no Cloudflare account or wrangler session"); process.exit(2); }

const env = {
  INTERNAL_SECRET: "x", AI_MODEL: model, PLAN_BUDGET_MIN: opt("--budget", undefined),
  // An external model (--model anthropic/claude-sonnet-5) needs the road: PLAN_API_URL and PLAN_API_KEY from the shell
  // (`set -a; . ./.secrets.local; set +a`) or ANTHROPIC_API_KEY for a claude-… model.
  PLAN_API_URL: process.env.PLAN_API_URL, PLAN_API_KEY: process.env.PLAN_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  AI: { async run(m, inputs) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${m}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(inputs) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
    return j.result;
  } },
};
const job = { id: `gt_film_${Date.now().toString(36)}`, template: duration_s > 90 ? "film-long" : "film", prompt: request, params: JSON.stringify({ duration_s, format, language, voice: null, style: "realistic" }) };
const t0 = Date.now();
let r;
try { r = await generateStoryboard(env, job); }
catch (e) { console.log(JSON.stringify({ ok: false, request, error: String(e).slice(0, 600) })); process.exit(1); }
const sb = r.storyboard, v = validateStoryboard(sb, { format, language }), t = r.treatment, d = r.direction;
const lines = [];
lines.push(`REQUEST: ${request}  (${duration_s}s ${format} ${language}) · model ${r.model} · ${r.attempts} calls · ${Math.round(r.ms / 1000)}s · ~${r.est_neurons} neurons · valid: ${v.ok}`);
if (t) {
  lines.push(`TREATMENT [${t.variation}]\n  logline: ${t.logline}\n  angle:   ${t.angle}\n  acts:    ${t.acts.map((a) => `${a.name} (${a.seconds}s)`).join(" · ")}\n  visual:  ${t.visual}\n  layer:   ${t.graphics ? `${t.graphics.hud.map((h) => `${h.kind} "${h.id}" (${h.means})`).join(", ") || "no element"}; subtitles ${t.graphics.subtitles}; chapters ${t.graphics.chapters}; accent ${t.graphics.accent}` : "none"}`);
} else lines.push("TREATMENT: none (" + r.history.filter((h) => h.some((m) => /^treatment/.test(m))).flat().join(" | ") + ")");
if (d) lines.push(`DIRECTION\n  subject: ${d.subject}\n  world:   ${d.world}\n  sections: ${d.sections.map((s) => `${s.name}=${s.accent}(${s.scenes})`).join(" · ")}\n  forbidden: ${d.forbidden.join(", ")}`);
lines.push(`SCENES (${sb.scenes.length}, ${r.words} words)`);
for (const s of sb.scenes) {
  const hud = s.hud ? " · hud " + JSON.stringify(s.hud) : "", cards = s.cards ? " · cards " + JSON.stringify(s.cards) : "";
  lines.push(`  ${s.id} [${s.chapter ?? ""}] ${s.voice}${hud}${cards}\n     shots: ${(s.shots ?? []).map((x) => x.image_prompt.slice(0, 70) + (x.at ? ` @"${x.at}"` : "")).join(" | ")}`);
}
if (sb.graphics) lines.push(`GRAPHICS on the storyboard: ${JSON.stringify(sb.graphics)} · music ${sb.music}`);
if (r.missing_facts.length) lines.push(`MISSING FACTS: ${r.missing_facts.join("; ")}`);
if (r.history.length) lines.push(`RETRIES: ${r.history.map((h) => h[0]).slice(0, 6).join(" | ")}`);
console.log(lines.join("\n"));
if (out) writeFileSync(out, JSON.stringify({ request, duration_s, format, language, result: { ...r, storyboard: sb } }, null, 1) + "\n");
