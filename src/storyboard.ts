/**
 * Storyboard generator: turns a Kleo job (template, prompt, duration, format, language, voice)
 * into a valid Keou storyboard with Workers AI, validated by keou-contract.ts.
 *
 * - Model: env.AI_MODEL, default @cf/meta/llama-3.3-70b-instruct-fp8-fast (JSON mode, free tier).
 * - One retry that feeds the validation errors back; then it throws with the errors.
 * - Test hook: env.STORYBOARD_FIXTURE === "example" or no AI binding → the cinema example, adapted (cartoon, with image prompts).
 * - Kleo styles: params.style (cartoon | realistic | cyber | stickman; pickKleoStyle() when the client gave none). cartoon and
 *   realistic are cinema projects whose scenes carry an image_prompt (the server draws a picture per scene, images.ts);
 *   cyber is the plain Keou look of the template; stickman is Keou's stickman (story scenes, 9:16 only).
 */
import type { Env } from "./env";
import type { Job, JobParams } from "./db";
import { findTemplate } from "./templates.ts";
import {
  validateStoryboard, defaultVoice, wordBudget, type Storyboard, type Format, type KleoStyle,
  KINDS, BEAT_KINDS, BEAT_ICONS, BEAT_FX, CINEMA_ACCENTS, VISUALS, FORBIDDEN_FIELDS,
  KLEO_STYLES, PICTURE_STYLES, IMAGE_PROMPT_MAX, kleoStyleOf, STORY_ACTS, STORY_CAST, STORY_PROPS, STORY_FX, STORY_ACCENTS,
} from "./keou-contract.ts";
import cinemaExample from "../worker/keou/examples/short-relay-cinema/project.json" with { type: "json" };

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** USD per million tokens (developers.cloudflare.com/workers-ai/platform/pricing, Sept 2026); 1 neuron = $0.000011. */
const PRICES: Record<string, { in: number; out: number }> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { in: 0.27, out: 0.85 },
  "@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
  "@cf/openai/gpt-oss-20b": { in: 0.2, out: 0.3 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { in: 0.051, out: 0.335 },
};

export type PlanJob = Pick<Job, "id" | "template" | "prompt" | "params">;
export interface Usage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
export interface PlanResult {
  storyboard: Storyboard;
  model: string;
  attempts: number;
  ms: number;
  usage: Usage;
  est_neurons: number | null;
  words: number;
  scenes: number;
  fixture: boolean;
  /** Problems found on each rejected attempt (diagnostics). */
  history: string[][];
  /** The Kleo style of the storyboard. */
  style: KleoStyle;
}

/** Errors that say nothing about the storyboard: quota, rate limit, upstream outage. The job should wait, not fail. */
export const isTransientAiError = (e: unknown): boolean => /4006|daily free allocation|429|rate limit|too many requests|5\d\d\b|ECONNRESET|fetch failed|capacity|overloaded/i.test(String(e));

export class StoryboardError extends Error {
  errors: string[];
  /** The last normalised (but invalid) storyboard, for debugging. */
  draft: unknown;
  constructor(message: string, errors: string[], draft?: unknown) { super(message); this.errors = errors; this.draft = draft; }
}

/* ------------------------------------------------------------------ template briefs */

type StyleId = "cinema" | "editorial" | "technical" | "illustrated" | "stickman";
interface Brief { style: StyleId; wordsPerScene: [number, number]; guidance: string }

const CINEMA_RULES = `Scenes are "cinema" (last one "closing"). Each scene: chapter (e.g. "01 HOOK", "02 THE TWIST", ≤32 chars), accent (red for threat/tension, green for the fix/win, cyan for neutral explanation, amber for warnings), title (≤90, short lockup line), hl (ONE word taken from the title, ≤24), voice (one narrated line), hold 0.2 (0.4 on the last scene), beats: 4–8 hero visuals of DIFFERENT kinds.
Beat shapes (ICON = one icon name from the enum, FX = one fx from the enum, WORDS = 1–3 consecutive words copied EXACTLY, same spelling and case, from that scene's voice; "?" marks optional keys):
{"kind":"type","text":"2-4 UPPERCASE WORDS ≤40","hl":"ONE WORD OF text ≤20","slam":true,"icon":ICON,"at"?:WORDS}
{"kind":"icon","name":ICON,"fx"?:FX,"size"?:0.6,"label"?:"≤24","at":WORDS}
{"kind":"split","items":[ICON,ICON],"fx"?:FX,"label"?:"≤24","at":WORDS}   (cause → effect)
{"kind":"grid","items":[ICON,ICON,ICON],"label"?:"≤24","at":WORDS}   (2–3 related objects)
{"kind":"steps","items":["≤14","≤14","≤14"],"lit"?:2,"at":WORDS}   (2–4 steps)
{"kind":"people","total":10,"lit":8,"label"?:"≤32","at":WORDS}   (x out of y, max 12)
{"kind":"bars","labels":["≤14","≤14"],"values":[850,722],"at":WORDS}   (1–4 integer values)
{"kind":"timeline","labels":["≤14","≤14","≤14"],"icons"?:[ICON,ICON,ICON],"at":WORDS}   (2–4 labels, one icon per label)
{"kind":"dialog","text":"≤32","count"?:3,"at":WORDS}   (a question card, count 1–5)
{"kind":"terminal","lines":["≤48","≤48"],"label"?:"≤16","at":WORDS}   (1–4 fake command lines)
{"kind":"cta","label"?:"≤24","toggles"?:["≤14","≤14"]}   (closing scene only)
The first beat of the hook scene is a slammed "type" beat. Every other beat carries "at", anchors in reading order. Icons: figure = the viewer, thief = the villain, phone/car/house/keyfob/pouch/timer/clock/wave/lock/shield/check/cross/bug/radar/alarm/hand/keyboard/desk/coffee/hoodie/amplifier are the only objects you can draw, so choose the closest metaphor. The closing scene keeps beats (a "type" beat with the loop question and a "cta" beat) plus a "detail" line ≤110.`;

const PICTURE_RULES: Record<"cartoon" | "realistic", string> = {
  cartoon: `PICTURES: this is a CARTOON video. Every scene (closing included) carries "image_prompt" (≤${IMAGE_PROMPT_MAX} chars): ONE sentence describing the picture drawn full-screen behind that scene as a flat vector cartoon: concrete subjects and setting from the story (pirates → a beach, sand, a ship at anchor; space → a rocket, a station, planets), the same characters drawn the same way in every scene, bright simple shapes, a clear mood. Never mention text, letters, numbers, logos, captions or the style itself; never name real people. The beats are drawn on top of the picture, so keep it a background: no tiny details.`,
  realistic: `PICTURES: this is a REALISTIC video. Every scene (closing included) carries "image_prompt" (≤${IMAGE_PROMPT_MAX} chars): ONE sentence describing the cinematic photograph shown full-screen behind that scene: the concrete subject and place (a product on a desk, a city street at dusk, a mountain road in rain), the light and the mood, a consistent look from scene to scene. Never mention text, letters, numbers, logos or captions; never name or depict real people. The beats are drawn on top of the picture, so keep it a background: no tiny details.`,
};

const STICKMAN_RULES = `Scenes are "story" (last one "closing"): a hand-drawn stickman acts out the narration, one situation per scene.
Scene shape ("?" marks optional keys; use these exact enum strings, nothing else):
{"id":"01-hook","kind":"story","act":"idle|explain|point-up|shrug|think|alarm|hold|drop|wave|walk|run|crouch","cast":["hero"] or ["hero","thief"] or ["hero","thief","thief2"],"props"?:[up to 3 distinct of ${STORY_PROPS.join(", ")}],"fx"?:"${STORY_FX.join("|")}","accent":"green|red|amber","bubble"?:"≤40 chars the character says","hl"?:"ONE word of the title ≤24","title":"≤90 short lockup line","voice":"one narrated sentence","hold"?:0.2}
hero = the viewer, thief/thief2 = villains; acts follow the narration (alarm when something goes wrong, explain/point-up when teaching, shrug for doubt, run/walk for movement, hold/drop with a prop). Accent red for danger, amber for warnings, green for the fix. The closing scene is {"id":"…","kind":"closing","title":"…","voice":"…","bubble"?:"≤40","hl"?:"≤24","hold":0.4} with the loop question or the call to action.`;

const EDITORIAL_RULES = `Every scene: id (unique slug), kind, eyebrow (UPPERCASE section label ≤40), title (≤90, a punchy on-screen line, not the narration), voice (the narration, ≤350 characters, 2–4 spoken sentences), optional hold 0.65–1.2 (1.8 on the closing).
Scene shapes ("?" marks optional keys; do not add other keys):
{"id":"01-hook","kind":"hero","eyebrow":"…","title":"…","voice":"…","visual":"focus|network|cycle|spark|globe|check|growth"}
{"id":"…","kind":"list","eyebrow":"…","title":"…","voice":"…","items":["≤42","≤42","≤42"]}   (exactly 3 items)
{"id":"…","kind":"steps","eyebrow":"…","title":"…","voice":"…","items":["≤42","≤42","≤42"]}   (exactly 3 steps, in order)
{"id":"…","kind":"compare","eyebrow":"…","title":"…","voice":"…","items":["≤42","≤42"]}   (exactly 2 sides)
{"id":"…","kind":"metric","eyebrow":"…","title":"…","voice":"…","value":"26,000","unit":"light-years from Earth","animate_value":true}   (value ≤12 chars; animate_value only when value starts with a plain number)
{"id":"…","kind":"quote","eyebrow":"…","title":"…","voice":"…","quote":"≤120"}
{"id":"…","kind":"closing","eyebrow":"…","title":"…","voice":"…","button":"≤40","hold":1.8}   (last scene only; "button" OR "detail" ≤110, never both)
Optional on any scene: "source":"≤80" (outlet or organisation), "detail":"≤110". Items mirror what the narration says.`;

const BRIEFS: Record<string, Brief> = {
  "viral-short": { style: "cinema", wordsPerScene: [10, 18], guidance: "A viral Short: hook in the first sentence (a surprising claim, a number, a fear), then the reveal, the proof, the fix or twist, and a loop question at the end that sends the viewer back to the start. Short punchy sentences, one narrated line per scene." },
  "did-you-know": { style: "cinema", wordsPerScene: [10, 16], guidance: "A 'did you know' Short: one striking fact per scene, each fact a self-contained sentence with a concrete number or comparison, escalating to the most surprising one. Open with 'Did you know' or a question." },
  "reddit-story": { style: "cinema", wordsPerScene: [12, 18], guidance: "A narrated Reddit-style story told in first person: setup, rising tension, the turning point, the payoff, a one-line reaction at the end. Keep the poster's voice and details from the prompt; chapters like '01 THE SETUP', '02 THE TWIST'. Use dialog beats for things people said (≤32 chars) and figure/thief/phone/house/car icons for characters and objects." },
  "motivational": { style: "cinema", wordsPerScene: [10, 16], guidance: "A motivational piece: short declarative lines that build, a personal 'you' address, one memorable quote-like line per scene, ending on a call to act today. Accent amber/green. Type beats carry the key words in caps." },
  "cinematic-trailer": { style: "cinema", wordsPerScene: [8, 14], guidance: "A cinematic trailer: terse ominous lines, escalating stakes, chapter cards like '01 THE CALM', a title reveal near the end (a slammed type beat with the title), one last line after it. Mostly type and icon beats, red/amber accents." },
  "story-documentary": { style: "editorial", wordsPerScene: [30, 45], guidance: "A calm documentary: cold open with a striking question or scene, context, chronological chapters (eyebrow = chapter name, e.g. 'CHAPTER 2 · THE CROSSING'), dates and numbers as metric scenes, a human quote as a quote scene, consequences, and a reflective closing. Facts must be accurate and specific; say 'about' when a number is approximate." },
  "weekly-news": { style: "editorial", wordsPerScene: [30, 45], guidance: "A weekly news roundup with FOUR stories: for each story 2–4 scenes (a hero with eyebrow 'STORY 1 · <TOPIC>', then a metric/list/compare/quote scene with the key figure), and a 'source' field (≤80, the outlet or organisation) on at least one scene per story. Hard, factual, neutral tone; finish with a short 'what to watch next week' closing." },
  "explainer": { style: "technical", wordsPerScene: [30, 45], guidance: "An explainer/tutorial: the question, why it matters, the concept built step by step (steps scenes with 3 items that mirror the narration), a comparison (compare scene), one or two concrete numbers (metric scenes), common mistakes (list scene), and a recap list scene right before the closing. Clear plain language, define every term once." },
  "top-10": { style: "illustrated", wordsPerScene: [30, 45], guidance: "A countdown from #10 to #1: an intro scene, then ONE scene per entry with eyebrow '#10', '#9' … '#1' and the entry name in the title; alternate scene kinds (hero, metric for a number, compare, list, quote) so consecutive entries look different; the #1 gets the longest narration; closing asks the viewer for their own #1." },
  "product-review": { style: "illustrated", wordsPerScene: [30, 45], guidance: "A product review: what it is and who it is for, design, key specs as metric scenes, a pros list, a cons list, a compare scene versus the obvious alternative, a final score as a metric (value like '8.5', unit '/ 10 · <verdict in two words>'), and a closing with the verdict as button text. Balanced, concrete, no marketing fluff." },
};

/** Keou style for a Kleo template and format in the cyber look (cinema is portrait-first; 16:9 motivational falls back to editorial). */
export function styleFor(template: string, format: Format): StyleId {
  const b = BRIEFS[template] ?? BRIEFS.explainer;
  if (b.style === "cinema" && format === "16:9" && template !== "cinematic-trailer") return "editorial";
  return b.style;
}

/** Keou style for a Kleo style: pictures live behind cinema scenes, the stickman has its own style, cyber keeps the template's look. */
export function keouStyleFor(kleo: KleoStyle, template: string, format: Format): StyleId {
  if (kleo === "stickman") return "stickman";
  if (kleo === "cartoon" || kleo === "realistic") return "cinema";
  return styleFor(template, format);
}

const CYBER_WORDS = /\b(cyber|security|hacker|hacking|malware|phishing|scam(?:mer)?s?|ransomware|password|vpn|encryption|crypto(?:currency)?|bitcoin|blockchain|\bai\b|artificial intelligence|machine learning|llm|chatgpt|neural|algorithm|software|coding|programming|developer|javascript|python|linux|database|cloud|startup|tech|gadget|smartphone|app|api|server|network|wifi|bluetooth|data breach|privacy|surveillance|drone|robot|quantum|computer|gpu|chip|semiconductor|keyless|relay attack)\b/i;
const REALISTIC_WORDS = /\b(product|review|unboxing|specs?|price|buy|brand|camera|laptop|headphones|car|cars|bike|watch|sneakers?|restaurant|hotel|city|cities|street|beach|mountain|travel guide|itinerary|destination|landscape|nature|photograph|news|headline|election|economy|market|stocks?|inflation|company|ceo|launch|sport|match|championship|recipe|cooking|food|fitness|workout|real estate|apartment)\b/i;
const CARTOON_WORDS = /\b(story|stories|tale|fairy|kids?|children|bedtime|cartoon|animated|pirates?|dragons?|knights?|castle|princess|wizard|monster|animals?|cats?|dogs?|dinosaurs?|space|rocket|planet|history|ancient|medieval|legend|myth|fable|adventure|treasure|island|jungle|ocean|magic|school|funny|joke)\b/i;
const REALISTIC_TEMPLATES = new Set(["product-review", "weekly-news"]);
const CYBER_TEMPLATES = new Set(["explainer"]);

/**
 * The Kleo style when the client picked none: cyber for tech/security/AI topics, realistic for products, places and news,
 * cartoon for stories, kids, travel, animals and history; otherwise the template's natural look. Never stickman (on request only).
 */
export function pickKleoStyle(template: string, prompt: string): KleoStyle {
  const text = prompt.slice(0, 1500);
  if (CYBER_WORDS.test(text)) return "cyber";
  if (CARTOON_WORDS.test(text)) return "cartoon";
  if (REALISTIC_WORDS.test(text)) return "realistic";
  if (REALISTIC_TEMPLATES.has(template)) return "realistic";
  if (CYBER_TEMPLATES.has(template)) return "cyber";
  return "cartoon";
}

function sceneRange(words: number, wps: [number, number]): [number, number] {
  const lo = Math.max(4, Math.ceil(words / wps[1]));
  const hi = Math.min(60, Math.max(lo + 1, Math.round(words / wps[0])));
  return [lo, hi];
}

/* ------------------------------------------------------------------ prompt */

interface Plan { style: StyleId; kleo: KleoStyle; pictures: boolean; brief: Brief; format: Format; language: string; voice: string; duration: number; speed: number; words: ReturnType<typeof wordBudget>; scenes: [number, number]; maxDuration: number; chunk: number }

export function planFor(job: PlanJob): Plan {
  const p = JSON.parse(job.params) as JobParams;
  const format = p.format;
  const brief = BRIEFS[job.template] ?? BRIEFS.explainer;
  const kleo: KleoStyle = (KLEO_STYLES as readonly string[]).includes(p.style ?? "") ? (p.style as KleoStyle) : pickKleoStyle(job.template, job.prompt);
  const style = keouStyleFor(kleo, job.template, format);
  const speed = 1.1;
  const words = wordBudget(p.duration_s, speed);
  // Cinema/stickman scenes carry one spoken line each in Shorts; long videos in those styles use longer lines so the scene count stays sane.
  const perLine: [number, number] = p.duration_s > 120 ? [35, 50] : [10, 18];
  const wps: [number, number] = style === "cinema" || style === "stickman" ? (brief.style === "cinema" && p.duration_s <= 120 ? brief.wordsPerScene : perLine) : (brief.style === "cinema" ? [25, 40] : brief.wordsPerScene);
  return {
    style, kleo, pictures: PICTURE_STYLES.includes(kleo), brief, format, language: p.language, voice: defaultVoice(p.language, job.template, p.voice), duration: p.duration_s, speed, words,
    scenes: sceneRange(words.target, wps), maxDuration: Math.min(1800, Math.max(5, Math.round(p.duration_s * 1.6))),
    chunk: style === "cinema" ? 4 : 5, // scenes per model call: keeps every call under ~2k output tokens (Workers AI times out on long generations)
  };
}

const LANG_NAMES: Record<string, string> = { en: "English", it: "Italian", fr: "French" };
const list = (a: readonly string[]) => a.join(", ");
const editorialKinds = () => KINDS.filter((k) => !["image", "story", "cinema"].includes(k));

function systemPrompt(plan: Plan): string {
  const kinds = plan.style === "cinema" ? "cinema, closing" : plan.style === "stickman" ? "story, closing" : list(editorialKinds());
  const lang = LANG_NAMES[plan.language] ?? plan.language;
  const rules = plan.style === "cinema" ? CINEMA_RULES : plan.style === "stickman" ? STICKMAN_RULES : EDITORIAL_RULES;
  const pictures = plan.pictures ? `\n${PICTURE_RULES[plan.kleo as "cartoon" | "realistic"]}` : "";
  const enums = plan.style === "stickman"
    ? `acts: ${list(STORY_ACTS)}. cast: ${list(STORY_CAST)}. props: ${list(STORY_PROPS)}. fx: ${list(STORY_FX)}. accents: ${list(STORY_ACCENTS)}.`
    : `beat kinds: ${list(BEAT_KINDS)}. icons: ${list(BEAT_ICONS)}. fx: ${list(BEAT_FX)}. accents: ${list(CINEMA_ACCENTS)}. visuals: ${list(VISUALS)}.`;
  return `You are Kleo's storyboard writer for the Keou motion-design renderer. You output ONE JSON object and nothing else: no prose, no markdown fences, standard JSON with double-quoted keys and strings (never single quotes, never Python dict syntax).
The video is a Keou project in the "${plan.style}" style (Kleo look: ${plan.kleo}), ${plan.format}, ${plan.duration} seconds, narrated in ${lang} by a text-to-speech voice.
Allowed scene kinds for this style: ${kinds}. The LAST scene of the video must have kind "closing".
${rules}${pictures}
Enums (use these exact strings, nothing else): ${enums}
Never use scene kind "image", never reference files or URLs. Scene ids are unique lowercase slugs like "01-hook". Text limits are hard limits, count characters. Narration and all on-screen text are in ${lang}; enum values stay in English. Write the narration as spoken language: no emojis, no hashtags, no URLs, no stage directions. Do not invent quotes from real people.`;
}

function contextBlock(job: PlanJob, plan: Plan): string {
  const t = findTemplate(job.template);
  return `TEMPLATE: ${t?.name ?? job.template} (${job.template}). BRIEF: ${plan.brief.guidance}
USER REQUEST (the video is about this; keep every fact, name and constraint from it):
"""${job.prompt.trim()}"""`;
}

/** Outline entry: what the model plans for one scene before writing it. */
interface OutlineEntry { id: string; kind: string; label: string; accent?: string; summary: string; words: number }

function outlinePrompt(job: PlanJob, plan: Plan, n: number): string {
  const perScene = Math.round(plan.words.target / n);
  const cin = plan.style === "cinema", stick = plan.style === "stickman";
  const kind = cin ? "cinema" : stick ? "story" : "<kind>";
  const label = cin ? "chapter ≤32 like 01 HOOK" : stick ? "situation ≤32 like 01 THE SETUP" : "UPPERCASE eyebrow ≤40";
  return `${contextBlock(job, plan)}
TASK: plan the whole video as an outline of exactly ${n} scenes, in order. The narration will total about ${plan.words.target} words (${perScene} per scene on average; the hook and the closing may be shorter, key scenes longer). Return {"title":"<video title ≤120>","description":"<YouTube description, one paragraph>","tags":["…"],"scenes":[{"id":"01-slug","kind":"${kind}","label":"<${label}>",${cin ? '"accent":"<accent>",' : ""}"summary":"<what this scene says, ≤25 words>","words":<narration words for this scene>}, …]}.
${cin ? "Chapters group scenes (several scenes may share a chapter label); accents follow the mood." : stick ? "Each scene is one situation the stickman can act out." : "Vary the kinds: never more than two of the same kind in a row, at least four different kinds overall; use metric for numbers, compare for two-sided points, steps/list for three-part points, quote for a memorable line, hero for openings and transitions."} The last scene has kind "closing". The first scene is the hook.`;
}

function chunkPrompt(job: PlanJob, plan: Plan, outline: OutlineEntry[], from: number, to: number, prevVoice: string | null, feedback?: string[]): string {
  const entries = outline.slice(from, to);
  const words = entries.reduce((n, e) => n + e.words, 0);
  const total = outline.length;
  const cin = plan.style === "cinema", stick = plan.style === "stickman";
  const lineWords = plan.duration > 120 ? "35–50" : "10–18";
  const how = cin ? `Each voice line is ${plan.duration > 120 ? "two or three spoken sentences" : "one spoken sentence"} of ${lineWords} words; every scene needs 4–8 beats of different kinds, each anchored with "at" to words of its own voice line.`
    : stick ? `Each voice line is one spoken sentence of ${lineWords} words; every scene has an act, a cast with hero, an accent and a title; add a bubble when the character says something.`
    : "Fill the kind-specific fields exactly as the shapes show: list/steps need 3 items, compare 2 items, metric needs value and unit, quote needs quote, hero needs visual.";
  let msg = `${contextBlock(job, plan)}
VIDEO OUTLINE (${total} scenes; you write scenes ${from + 1}–${to} now):
${outline.map((e, i) => `${i + 1}. [${e.id}] ${e.kind} · ${e.label}${e.accent ? ` · ${e.accent}` : ""} — ${e.summary} (${e.words} words)`).join("\n")}
${prevVoice ? `The previous scene ended with this narration, continue naturally from it: "${prevVoice}"` : "This is the start of the video."}
TASK: write scenes ${from + 1}–${to} in full, in order, keeping their ids, kinds${cin ? ", chapters (as \"chapter\") and accents" : stick ? " and titles" : " and eyebrows"} from the outline. Their narration together totals about ${words} words (${entries.map((e) => `${e.id}: ${e.words}`).join(", ")}). ${how}${plan.pictures ? ` Every scene carries its "image_prompt" (one sentence, ≤${IMAGE_PROMPT_MAX} characters, no text in the picture).` : ""}
Return {"scenes":[…]} with exactly ${entries.length} scene objects and nothing else.`;
  if (feedback?.length) msg += `\n\nYOUR PREVIOUS ANSWER WAS REJECTED by the validator with these problems (scene numbers count within the scenes you returned, "beat n" counts inside that scene). Fix every one of them and return all ${entries.length} scenes again:\n- ${feedback.join("\n- ")}`;
  return msg;
}

/** JSON schemas for response_format (kept flat: no oneOf, so constrained decoding stays cheap). */
const str = { type: "string" };
const strArr = { type: "array", items: str };

/** Every property the contract knows, closed with additionalProperties:false (open objects let the grammar accept
 * garbled keys). Junk the model puts in irrelevant properties is removed per kind by normalizeStoryboard. */
function sceneSchema(plan: Plan): Record<string, unknown> {
  if (plan.style === "cinema") {
    const beat = {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...BEAT_KINDS] }, at: str, name: { type: "string", enum: [...BEAT_ICONS] }, fx: { type: "string", enum: [...BEAT_FX] },
        size: { type: "number" }, label: str, text: str, hl: str, slam: { type: "boolean" }, icon: { type: "string", enum: [...BEAT_ICONS] },
        lines: strArr, items: strArr, lit: { type: "integer" }, total: { type: "integer" }, labels: strArr, values: { type: "array", items: { type: "integer" } },
        icons: { type: "array", items: { type: "string", enum: [...BEAT_ICONS] } }, count: { type: "integer" }, toggles: strArr,
      },
      required: ["kind"],
      additionalProperties: false,
    };
    return {
      type: "object",
      properties: {
        id: str, kind: { type: "string", enum: ["cinema", "closing"] }, chapter: str, accent: { type: "string", enum: [...CINEMA_ACCENTS] },
        title: str, hl: str, voice: str, hold: { type: "number" }, beats: { type: "array", items: beat }, detail: str,
        ...(plan.pictures ? { image_prompt: str } : {}),
      },
      required: ["id", "kind", "chapter", "accent", "title", "hl", "voice", "beats", ...(plan.pictures ? ["image_prompt"] : [])],
      additionalProperties: false,
    };
  }
  if (plan.style === "stickman") {
    return {
      type: "object",
      properties: {
        id: str, kind: { type: "string", enum: ["story", "closing"] }, act: { type: "string", enum: [...STORY_ACTS] },
        cast: { type: "array", items: { type: "string", enum: [...STORY_CAST] } }, props: { type: "array", items: { type: "string", enum: [...STORY_PROPS] } },
        fx: { type: "string", enum: [...STORY_FX] }, accent: { type: "string", enum: [...STORY_ACCENTS] }, bubble: str, hl: str, title: str, voice: str, hold: { type: "number" },
      },
      required: ["id", "kind", "act", "cast", "accent", "title", "voice"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: {
      id: str, kind: { type: "string", enum: editorialKinds() }, eyebrow: str, title: str, voice: str, visual: { type: "string", enum: [...VISUALS] },
      items: strArr, value: str, unit: str, animate_value: { type: "boolean" }, quote: str, detail: str, source: str, button: str, hold: { type: "number" },
    },
    required: ["id", "kind", "eyebrow", "title", "voice"],
    additionalProperties: false,
  };
}

function outlineSchema(plan: Plan): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: "object",
    properties: {
      id: str, kind: { type: "string", enum: plan.style === "cinema" ? ["cinema", "closing"] : plan.style === "stickman" ? ["story", "closing"] : editorialKinds() }, label: str,
      ...(plan.style === "cinema" ? { accent: { type: "string", enum: [...CINEMA_ACCENTS] } } : {}), summary: str, words: { type: "integer" },
    },
    required: ["id", "kind", "label", "summary", "words", ...(plan.style === "cinema" ? ["accent"] : [])],
    additionalProperties: false,
  };
  return {
    type: "object",
    properties: { title: str, description: str, tags: strArr, scenes: { type: "array", items: entry } },
    required: ["title", "description", "scenes"],
    additionalProperties: false,
  };
}

const chunkSchema = (plan: Plan): Record<string, unknown> => ({
  type: "object", properties: { scenes: { type: "array", items: sceneSchema(plan) } }, required: ["scenes"], additionalProperties: false,
});

/* ------------------------------------------------------------------ normalisation */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Drops null/empty values (JSON mode emits them for optional keys), trims strings, recursively. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean).filter((x) => x !== undefined);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [rawKey, val] of Object.entries(v)) {
      const k = rawKey.trim().replace(/\?$/, ""); // models sometimes emit "at " or "label?" as keys
      const c = clean(val);
      if (!k || c === undefined || c === null || c === "" || (Array.isArray(c) && c.length === 0)) continue;
      out[k] = c;
    }
    return out;
  }
  if (typeof v === "string") { const s = v.trim(); return s === "" ? undefined : s; }
  return v;
}

const slug = (s: unknown, i: number) => {
  const base = typeof s === "string" ? s.toLowerCase().normalize("NFD").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") : "";
  return base || `s${i + 1}`;
};

/** Closest drawable icon for names the models like to invent; anything else drops the beat. */
const ICON_SYNONYMS: Record<string, string> = {
  battery: "phone", charger: "phone", power: "phone", smartphone: "phone", mobile: "phone", app: "phone", screen: "phone",
  cold: "wave", snow: "wave", ice: "wave", winter: "wave", signal: "wave", wifi: "wave", bluetooth: "wave", sound: "wave", voice: "wave",
  temperature: "timer", heat: "alarm", fire: "alarm", warning: "alarm", alert: "alarm", danger: "alarm", siren: "alarm", bell: "alarm",
  error: "cross", fail: "cross", failure: "cross", wrong: "cross", no: "cross", stop: "cross", success: "check", ok: "check", yes: "check", done: "check", growth: "check", chart: "check", graph: "check", trophy: "check", star: "check",
  time: "clock", hour: "clock", calendar: "clock", speed: "timer", stopwatch: "timer", hourglass: "timer",
  network: "radar", science: "radar", lab: "radar", chemistry: "radar", scan: "radar", search: "radar", satellite: "radar", globe: "radar", world: "radar",
  server: "desk", computer: "keyboard", laptop: "keyboard", code: "keyboard", key: "keyfob", password: "lock", padlock: "lock", secure: "shield", security: "shield", protect: "shield",
  door: "house", home: "house", building: "house", office: "desk", money: "pouch", cash: "pouch", wallet: "pouch", bag: "pouch", box: "pouch",
  person: "figure", user: "figure", people: "figure", man: "figure", woman: "figure", you: "figure", brain: "figure", idea: "figure", question: "figure",
  hacker: "thief", scammer: "thief", attacker: "thief", criminal: "thief", virus: "bug", malware: "bug", glitch: "bug",
  vehicle: "car", truck: "car", road: "car", cup: "coffee", mug: "coffee", finger: "hand", touch: "hand", click: "hand", jacket: "hoodie", amp: "amplifier", speaker: "amplifier", radio: "amplifier",
};
const iconFor = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const k = v.trim().toLowerCase();
  if ((BEAT_ICONS as readonly string[]).includes(k)) return k;
  return ICON_SYNONYMS[k] ?? ICON_SYNONYMS[k.replace(/s$/, "")] ?? null;
};
const inSet = (v: unknown, set: readonly string[]) => typeof v === "string" && set.includes(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "" && x.length <= max) : []);
/** Cuts narration at a sentence boundary so it fits the contract (350 chars) instead of failing the whole plan. */
function fitVoice(v: string, max = 350): string {
  if (v.length <= max) return v;
  const head = v.slice(0, max);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf(".\n"));
  return cut > max * 0.4 ? head.slice(0, cut + 1) : head.slice(0, head.lastIndexOf(" ")) + ".";
}
const BEAT_KEYS: Record<string, string[]> = {
  icon: ["name", "fx", "size", "label", "at"], type: ["text", "hl", "slam", "icon", "fx", "at", "mono"], terminal: ["lines", "label", "enter", "at"],
  steps: ["items", "lit", "at"], people: ["total", "lit", "label", "last", "at"], bars: ["labels", "values", "at"], timeline: ["labels", "icons", "at"],
  dialog: ["text", "count", "at"], cta: ["label", "toggles", "at"], split: ["items", "fx", "label", "at"], grid: ["items", "label", "at"],
};
const SCENE_KEYS: Record<string, string[]> = { list: ["items"], steps: ["items"], compare: ["items"], metric: ["value", "unit", "animate_value"], quote: ["quote"], closing: ["button"] };
const KIND_ONLY_KEYS = ["items", "value", "unit", "animate_value", "quote", "button"];

/** Keeps only what the contract reads for this beat kind and drops beats missing their required fields. */
function repairBeat(b: Record<string, unknown>, voice: string): Record<string, unknown> | null {
  const k = typeof b.kind === "string" ? b.kind.toLowerCase() : "";
  const keys = BEAT_KEYS[k];
  if (!keys) return null;
  const out: Record<string, unknown> = { kind: k };
  for (const key of keys) if (key in b) out[key] = b[key];
  if (k === "icon") { const n = iconFor(out.name ?? b.icon); if (!n) return null; out.name = n; }
  if (k === "type") {
    if (typeof out.text !== "string") return null;
    let text = out.text;
    if (text.length > 40) text = text.slice(0, 40).replace(/\s+\S*$/, "") || text.slice(0, 40);
    out.text = text;
    if (typeof out.hl !== "string" || out.hl.length > 20 || !text.toLowerCase().includes(out.hl.toLowerCase())) delete out.hl;
    if ("icon" in out) { const n = iconFor(out.icon); if (n) out.icon = n; else delete out.icon; }
    if ("slam" in out && typeof out.slam !== "boolean") out.slam = Boolean(out.slam);
    if ("mono" in out && typeof out.mono !== "boolean") delete out.mono;
  }
  if (k === "terminal") {
    const lines = strs(out.lines, 48).filter(printableStr).slice(0, 4);
    if (!lines.length) return null;
    out.lines = lines;
    if (typeof out.label !== "string" || out.label.length > 16) delete out.label;
    if ("enter" in out && typeof out.enter !== "boolean") delete out.enter;
  }
  if (k === "steps") {
    const items = strs(out.items, 14).slice(0, 4);
    if (items.length < 2) return null;
    out.items = items;
    if (!isInt(out.lit) || out.lit < 0 || out.lit > items.length) delete out.lit;
  }
  if (k === "people") {
    if (!isInt(out.total)) return null;
    const total = Math.min(12, Math.max(0, out.total));
    out.total = total;
    out.lit = isInt(out.lit) ? Math.min(total, Math.max(0, out.lit)) : total;
    if (typeof out.label !== "string" || out.label.length > 32) delete out.label;
    if ("last" in out && typeof out.last !== "boolean") delete out.last;
  }
  if (k === "bars") {
    const labels = strs(out.labels, 14).slice(0, 4);
    const values = Array.isArray(out.values) ? out.values.map((v) => (typeof v === "number" ? Math.round(Math.min(1000000, Math.max(0, v))) : NaN)) : [];
    if (!labels.length || labels.length !== values.length || values.some((v) => !Number.isFinite(v))) return null;
    out.labels = labels; out.values = values;
  }
  if (k === "timeline") {
    const labels = strs(out.labels, 14).slice(0, 4);
    if (labels.length < 2) return null;
    out.labels = labels;
    const icons = Array.isArray(out.icons) ? out.icons.map(iconFor) : null;
    if (icons && icons.length === labels.length && icons.every(Boolean)) out.icons = icons; else delete out.icons;
  }
  if (k === "dialog") {
    if (typeof out.text !== "string") return null;
    if (out.text.length > 32) out.text = out.text.slice(0, 32).replace(/\s+\S*$/, "") || out.text.slice(0, 32);
    if (!isInt(out.count) || out.count < 1 || out.count > 5) delete out.count;
  }
  if (k === "cta") {
    if (typeof out.label !== "string" || out.label.length > 24) delete out.label;
    const t = strs(out.toggles, 14).slice(0, 3);
    if (t.length) out.toggles = t; else delete out.toggles;
  }
  if (k === "split" || k === "grid") {
    const items = (Array.isArray(out.items) ? out.items : []).map(iconFor).filter((x): x is string => !!x);
    if (items.length < 2) return null;
    out.items = items.slice(0, k === "split" ? 2 : 3);
  }
  if ((k === "icon" || k === "split" || k === "grid") && (typeof out.label !== "string" || out.label.length > 24)) delete out.label;
  if ("fx" in out && !inSet(out.fx, BEAT_FX)) delete out.fx;
  if ("size" in out && (typeof out.size !== "number" || out.size < 0.3 || out.size > 1)) delete out.size;
  if (typeof out.at === "string" && (out.at.length > 24 || !voice.includes(out.at.toLowerCase()))) delete out.at;
  return out;
}
const printableStr = (x: string) => ![...x].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

/** Deterministic repairs that never change the story: forced job fields, slugs, anchors, holds, xor button/detail. */
export function normalizeStoryboard(raw: unknown, plan: Plan): unknown {
  const c = clean(raw);
  if (!isObj(c)) return c;
  for (const f of FORBIDDEN_FIELDS) delete c[f];
  c.schema_version = 1;
  c.editorial_status = "ready";
  c.format = plan.format;
  c.language = plan.language;
  c.voice = plan.voice;
  c.speed = plan.speed;
  if (c.music !== "none") c.music = "bed";
  c.max_duration = plan.maxDuration;
  delete c.width; delete c.fps; delete c.brand;
  c.style = plan.style;
  c.kleo_style = plan.kleo;
  if (typeof c.title === "string" && c.title.length > 120) c.title = c.title.slice(0, 117) + "…";
  if (Array.isArray(c.scenes)) {
    const seen = new Set<string>();
    c.scenes = c.scenes.filter(isObj).map((s, i) => {
      let id = slug(s.id, i).slice(0, 50);
      if (seen.has(id)) id = `${id}-${i + 1}`.slice(0, 50);
      seen.add(id);
      s.id = id;
      if (typeof s.hold === "number") s.hold = Math.min(3, Math.max(0.15, s.hold)); else delete s.hold;
      if (s.kind === "closing" && s.button && s.detail) delete s.detail;
      if (typeof s.voice === "string") s.voice = fitVoice(s.voice);
      if (typeof s.eyebrow === "string" && s.eyebrow.length > 40) s.eyebrow = s.eyebrow.slice(0, 40).trim();
      if (typeof s.chapter === "string" && s.chapter.length > 32) s.chapter = s.chapter.slice(0, 32).trim();
      if (typeof s.source === "string" && s.source.length > 80) delete s.source;
      if (typeof s.detail === "string" && s.detail.length > 110) delete s.detail;
      if (typeof s.hl === "string" && s.hl.length > 24) delete s.hl;
      if ("visual" in s && !inSet(s.visual, VISUALS)) delete s.visual;
      if ("accent" in s && !inSet(s.accent, plan.style === "stickman" ? STORY_ACCENTS : CINEMA_ACCENTS)) delete s.accent;
      // Picture prompts: one trimmed sentence for the picture styles, nothing elsewhere (image is never accepted from a model).
      delete s.image; delete s.image_credit;
      if (!plan.pictures || typeof s.image_prompt !== "string") delete s.image_prompt;
      else if (s.image_prompt.length > IMAGE_PROMPT_MAX) s.image_prompt = s.image_prompt.slice(0, IMAGE_PROMPT_MAX).replace(/\s+\S*$/, "").trim() || s.image_prompt.slice(0, IMAGE_PROMPT_MAX);
      if (plan.style === "stickman") {
        delete s.beats; delete s.chapter; delete s.eyebrow; delete s.visual;
        for (const key of KIND_ONLY_KEYS) delete s[key];
        if (s.kind !== "closing") s.kind = "story";
        if (s.kind === "story") {
          if (!inSet(s.act, STORY_ACTS)) delete s.act;
          const cast = (Array.isArray(s.cast) ? s.cast : []).filter((x): x is string => inSet(x, STORY_CAST));
          s.cast = ["hero", ...[...new Set(cast)].filter((x) => x !== "hero")].slice(0, 3);
          const props = [...new Set((Array.isArray(s.props) ? s.props : []).filter((x): x is string => inSet(x, STORY_PROPS)))].slice(0, 3);
          if (props.length) s.props = props; else delete s.props;
          if ("fx" in s && !inSet(s.fx, STORY_FX)) delete s.fx;
        } else { delete s.act; delete s.cast; delete s.props; delete s.fx; }
        if (typeof s.bubble !== "string" || s.bubble.length > 40 || !printableStr(s.bubble)) delete s.bubble;
        if (typeof s.hl !== "string" || s.hl.length > 24 || !printableStr(s.hl)) delete s.hl;
        if (typeof s.title === "string" && s.title.length > 90) s.title = s.title.slice(0, 90).replace(/\s+\S*$/, "").trim() || s.title.slice(0, 90);
      } else if (plan.style !== "cinema") {
        const keep = SCENE_KEYS[s.kind as string] ?? [];
        for (const key of KIND_ONLY_KEYS) if (!keep.includes(key) && key in s) delete s[key];
        if (s.kind === "metric" && s.animate_value === true && !/^\d+(?:,\d{3})*(?:\.\d+)?[^\d]*$/.test(String(s.value ?? ""))) delete s.animate_value;
        if (s.kind === "metric" && "animate_value" in s && typeof s.animate_value !== "boolean") delete s.animate_value;
        delete s.beats;
        if (typeof s.title === "string" && s.title.length > 90) s.title = s.title.slice(0, 90).replace(/\s+\S*$/, "").trim() || s.title.slice(0, 90);
        const downgrade = () => { s.kind = "hero"; for (const key of KIND_ONLY_KEYS) delete s[key]; };
        if (s.kind === "list" || s.kind === "steps" || s.kind === "compare") {
          const n = s.kind === "compare" ? 2 : 3;
          const items = strs(s.items, 42);
          if (items.length >= n) s.items = items.slice(0, n); else downgrade();
        } else if (s.kind === "metric") {
          if (typeof s.value === "string" && s.value.length <= 12 && typeof s.unit === "string" && s.unit.length <= 45) { /* ok */ } else downgrade();
        } else if (s.kind === "quote") {
          if (typeof s.quote !== "string" || s.quote.length > 120) { if (typeof s.title === "string" && s.title.length <= 120) s.quote = s.title; else downgrade(); }
        }
      }
      const voice = typeof s.voice === "string" ? s.voice.toLowerCase() : "";
      if (Array.isArray(s.beats)) {
        const beats = s.beats.filter(isObj).map((b) => repairBeat(b, voice)).filter((b): b is Record<string, unknown> => !!b).slice(0, 8);
        s.beats = beats.length || typeof s.title !== "string" ? beats : [{ kind: "type", text: s.title.slice(0, 40), slam: true }];
      }
      return s;
    });
    // No closing at all: the last scene becomes the closing (content kept).
    const scenes = c.scenes as Record<string, unknown>[];
    if (scenes.length && !scenes.some((s) => s.kind === "closing")) {
      const last = scenes[scenes.length - 1];
      last.kind = "closing";
      for (const k of ["items", "value", "unit", "quote", "animate_value", "visual", "act", "cast", "props", "fx"]) delete last[k];
      if (plan.style !== "cinema") delete last.beats;
    }
  }
  return c;
}

export const countWords = (sb: unknown): number =>
  isObj(sb) && Array.isArray(sb.scenes) ? sb.scenes.reduce((n: number, s) => n + (isObj(s) && typeof s.voice === "string" ? s.voice.split(/\s+/).filter(Boolean).length : 0), 0) : 0;

/* ------------------------------------------------------------------ model call */

interface AiRunner { run(model: string, inputs: Record<string, unknown>): Promise<unknown> }

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new Error(`the model returned broken JSON (${String(e).slice(0, 80)}): …${t.slice(Math.max(0, t.length - 160))}`); }
  }
  throw new Error(`the model did not return JSON: ${t.slice(0, 200)}`);
}

async function callModel(env: Env, model: string, messages: { role: string; content: string }[], schema: Record<string, unknown>, maxTokens: number): Promise<{ raw: unknown; usage: Usage }> {
  const ai = env.AI as unknown as AiRunner;
  const base = { messages, max_tokens: maxTokens, temperature: 0.3 };
  let res: unknown;
  try {
    res = await ai.run(model, { ...base, response_format: { type: "json_schema", json_schema: schema } });
  } catch (e) {
    // Models without JSON mode (or a schema the grammar engine rejects): plain call, lenient parse.
    if (!/json|schema|response_format|unsupported|invalid/i.test(String(e))) throw e;
    res = await ai.run(model, base);
  }
  const r = isObj(res) ? res : {};
  const usage = (isObj(r.usage) ? r.usage : {}) as Usage;
  let raw: unknown = r.response;
  if (raw === undefined && Array.isArray(r.output)) { // Responses-API shaped models (gpt-oss)
    const msg = (r.output as Record<string, unknown>[]).find((o) => o.type === "message");
    const content = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]).find((x) => typeof x.text === "string") : null;
    raw = content?.text;
  }
  if (typeof raw === "string") raw = extractJson(raw);
  return { raw, usage };
}

/* ------------------------------------------------------------------ fixture */

/** Picture prompts for the fixture's scenes (short-relay-cinema), so local runs with IMAGE_FIXTURE=1 exercise the pictures. */
const FIXTURE_PROMPTS: Record<string, string> = {
  "01-gone": "A quiet suburban driveway at dawn, an empty parking spot with tyre marks, a house with a kitchen window lit, a car key on the bench inside",
  "02-relay": "Two hooded figures at night, one crouching by a front door holding a small boxy amplifier with a glowing antenna, the house dark",
  "03-believes": "A sleek modern car in a driveway at night, its headlights switching on by themselves, a faint radio wave arc reaching from the house",
  "04-test": "A long row of shiny new cars in a bright test hall, orange cones, a clipboard on a stand, clean industrial light",
  "05-fix": "A small dark fabric pouch on a wooden kitchen bench, a car key dropping into it, a soft green glow around the pouch",
  "06-loop": "A wide car park at sunset seen from above, rows of cars of many colours, one lane lit in green, calm warm sky",
};

/** The cinema example adapted to a job's format/language/voice (local dev and tests; never calls AI). Cartoon look with a picture per scene. */
export function fixtureStoryboard(job: PlanJob): Storyboard {
  const p = JSON.parse(job.params) as JobParams;
  const sb = structuredClone(cinemaExample) as Record<string, unknown>;
  for (const f of FORBIDDEN_FIELDS) delete sb[f];
  delete sb.width; delete sb.fps; delete sb.brand;
  const kleo: KleoStyle = p.style === "realistic" || p.style === "cyber" ? p.style : "cartoon"; // the example is a cinema project: stickman cannot be faked
  sb.kleo_style = kleo;
  for (const s of sb.scenes as Record<string, unknown>[]) {
    delete s.image; delete s.image_credit;
    if (PICTURE_STYLES.includes(kleo)) s.image_prompt = FIXTURE_PROMPTS[String(s.id)] ?? `A simple scene about ${String(s.title ?? "the story")}, no text`;
  }
  sb.format = p.format;
  sb.language = p.language;
  sb.voice = defaultVoice(p.language, job.template, p.voice);
  sb.speed = 1.1;
  sb.music = "bed";
  sb.max_duration = Math.min(1800, Math.max(5, Math.round(p.duration_s * 1.6)));
  sb.description = `${String(sb.description)}\n\n(fixture storyboard for job ${job.id}: ${job.prompt.slice(0, 80)})`;
  const r = validateStoryboard(sb, { format: p.format, language: p.language });
  if (!r.ok) throw new StoryboardError("fixture storyboard is invalid: " + r.errors.join("; "), r.errors);
  return r.storyboard;
}

/* ------------------------------------------------------------------ entry point */

export function useFixture(env: Env): boolean {
  return env.STORYBOARD_FIXTURE === "example" || !env.AI;
}

/** A temporary closing so a chunk of scenes can be validated as a project on its own. */
const TEMP_CLOSING = (plan: Plan): Record<string, unknown> =>
  plan.style === "cinema"
    ? { id: "zz-temp-closing", kind: "closing", chapter: "99 END", accent: "green", title: "end", hl: "end", voice: "the end", beats: [{ kind: "cta" }], ...(plan.pictures ? { image_prompt: "the end" } : {}) }
    : { id: "zz-temp-closing", kind: "closing", title: "end", voice: "the end" };

function header(plan: Plan, outline: { title?: unknown; description?: unknown; tags?: unknown }): Record<string, unknown> {
  return {
    schema_version: 1, editorial_status: "ready", title: outline.title, description: outline.description, tags: outline.tags,
    style: plan.style, kleo_style: plan.kleo, format: plan.format, language: plan.language, voice: plan.voice, speed: plan.speed, music: "bed", max_duration: plan.maxDuration,
  };
}

export interface GenerateOptions { model?: string }

/**
 * Outline first (title, description, one entry per scene), then the scenes in chunks of 4–5, each chunk
 * validated on its own and retried (up to 3 tries) with the validator's feedback; the assembled project is validated last.
 */
export async function generateStoryboard(env: Env, job: PlanJob, opts: GenerateOptions = {}): Promise<PlanResult> {
  const t0 = Date.now();
  const plan = planFor(job);
  if (useFixture(env)) {
    const sb = fixtureStoryboard(job);
    return { storyboard: sb, model: "fixture", attempts: 0, ms: Date.now() - t0, usage: {}, est_neurons: 0, words: countWords(sb), scenes: sb.scenes.length, fixture: true, history: [], style: kleoStyleOf(sb) };
  }
  const model = opts.model || env.AI_MODEL || DEFAULT_MODEL;
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const history: string[][] = [];
  let calls = 0;
  const system = systemPrompt(plan);
  const call = async (user: string, schema: Record<string, unknown>, maxTokens: number) => {
    calls++;
    const out = await callModel(env, model, [{ role: "system", content: system }, { role: "user", content: user }], schema, maxTokens);
    usage.prompt_tokens! += out.usage.prompt_tokens ?? 0; usage.completion_tokens! += out.usage.completion_tokens ?? 0; usage.total_tokens! += out.usage.total_tokens ?? 0;
    return out.raw;
  };
  const fail = (errors: string[], draft?: unknown): never => { throw new StoryboardError(`storyboard invalid (${model}, ${calls} calls): ${errors.join("; ")}`, errors, draft); };
  let transient: unknown = null; // the last quota/outage error: reported instead of a storyboard problem

  // 1. Outline
  const n = Math.max(plan.scenes[0], Math.min(plan.scenes[1], Math.round((plan.scenes[0] + plan.scenes[1]) / 2)));
  let outline: OutlineEntry[] = [];
  let meta: { title?: unknown; description?: unknown; tags?: unknown } = {};
  for (let attempt = 1; attempt <= 2 && !outline.length; attempt++) {
    let raw: unknown;
    try { raw = clean(await call(outlinePrompt(job, plan, n), outlineSchema(plan), 400 + n * 90)); }
    catch (e) { history.push([`outline: model call failed: ${String(e).slice(0, 200)}`]); if (isTransientAiError(e)) { transient = e; break; } continue; }
    const o = isObj(raw) ? raw : {};
    const entries = Array.isArray(o.scenes) ? o.scenes.filter(isObj) : [];
    if (entries.length < 2 || typeof o.title !== "string") { history.push([`outline: expected ${n} scenes and a title, got ${entries.length} scenes`]); continue; }
    const seen = new Set<string>();
    outline = entries.map((e, i) => {
      let id = slug(e.id, i).slice(0, 50); if (seen.has(id)) id = `${id}-${i + 1}`; seen.add(id);
      const words = typeof e.words === "number" && e.words > 3 ? Math.round(e.words) : Math.round(plan.words.target / entries.length);
      return { id, kind: typeof e.kind === "string" ? e.kind : "hero", label: typeof e.label === "string" ? e.label.slice(0, plan.style === "cinema" ? 32 : 40) : `PART ${i + 1}`, accent: typeof e.accent === "string" ? e.accent : undefined, summary: typeof e.summary === "string" ? e.summary : "", words };
    });
    outline.forEach((e, i) => { if (e.kind === "closing" && i < outline.length - 1) e.kind = plan.style === "cinema" ? "cinema" : "hero"; });
    outline[outline.length - 1].kind = "closing";
    // Scale the per-scene word plan to the budget.
    const sum = outline.reduce((a, e) => a + e.words, 0) || 1;
    outline.forEach((e) => { e.words = Math.max(5, Math.round((e.words * plan.words.target) / sum)); });
    meta = { title: o.title, description: o.description, tags: o.tags };
  }
  if (transient) throw transient;
  if (!outline.length) fail(history.flat());

  // 2. Scenes, chunk by chunk
  const scenes: Record<string, unknown>[] = [];
  const head = header(plan, meta);
  const chunkSize = Math.ceil(outline.length / Math.ceil(outline.length / plan.chunk)); // even chunks: no 1-scene tail
  for (let from = 0; from < outline.length; from += chunkSize) {
    const to = Math.min(outline.length, from + chunkSize);
    const isLast = to === outline.length;
    const prevVoice = scenes.length ? String(scenes[scenes.length - 1].voice ?? "") : null;
    let feedback: string[] | undefined;
    let accepted: Record<string, unknown>[] | null = null;
    let lastDraft: unknown;
    for (let attempt = 1; attempt <= 3 && !accepted; attempt++) {
      let raw: unknown;
      const maxTokens = plan.style === "cinema" ? 700 * (to - from) : 350 * (to - from);
      try { raw = await call(chunkPrompt(job, plan, outline, from, to, prevVoice, feedback), chunkSchema(plan), 400 + maxTokens); }
      catch (e) { history.push([`scenes ${from + 1}–${to}: model call failed: ${String(e).slice(0, 200)}`]); if (isTransientAiError(e)) throw e; feedback = undefined; continue; }
      const got = isObj(raw) && Array.isArray(raw.scenes) ? raw.scenes.filter(isObj) : [];
      // Validated in context (the scenes accepted so far + this chunk + a temporary closing unless it is the last chunk);
      // error labels are remapped so "scene n" counts within the scenes the model just returned.
      const temp = normalizeStoryboard({ ...head, scenes: [...structuredClone(scenes), ...got, ...(isLast ? [] : [TEMP_CLOSING(plan)])] }, plan) as Record<string, unknown>;
      lastDraft = temp;
      const problems: string[] = [];
      if (got.length !== to - from) problems.push(`expected exactly ${to - from} scenes, got ${got.length}`);
      const r = validateStoryboard(temp, { format: plan.format, language: plan.language });
      if (!r.ok) problems.push(...r.errors.map((m) => m.replace(/^scene (\d+)/, (_, n) => `scene ${Number(n) - scenes.length}`)).filter((m) => !/^scene (-\d+|0)\b/.test(m)));
      const chunkScenes = (temp.scenes as Record<string, unknown>[]).slice(scenes.length, isLast ? undefined : -1);
      const want = outline.slice(from, to).reduce((a, e) => a + e.words, 0);
      const words = countWords({ scenes: chunkScenes });
      if (words < want * 0.55) problems.push(`the narration of these scenes is far too short: ${words} words, it must total about ${want}`);
      if (words > want * 1.6) problems.push(`the narration of these scenes is far too long: ${words} words, it must total about ${want}`);
      if (plan.pictures) {
        const blank = chunkScenes.map((s, i) => (typeof s.image_prompt !== "string" ? i + 1 : 0)).filter(Boolean);
        if (blank.length) problems.push(`scene${blank.length > 1 ? "s" : ""} ${blank.join(", ")}: missing "image_prompt" (one sentence describing the picture behind the scene, no text in it)`);
      }
      if (plan.style === "cinema") {
        const thin = chunkScenes.map((s, i) => (!Array.isArray(s.beats) || s.beats.length < 3 ? i + 1 : 0)).filter(Boolean);
        if (thin.length) problems.push(`scene${thin.length > 1 ? "s" : ""} ${thin.join(", ")}: only 1–2 beats; every scene needs 4–8 beats of different kinds, each anchored with "at"`);
      } else if (plan.style !== "stickman") {
        got.forEach((g, i) => {
          const k = chunkScenes[i]?.kind;
          if (typeof g.kind === "string" && k && g.kind !== k) problems.push(`scene ${i + 1}: kind "${g.kind}" was missing its fields (${SCENE_KEYS[g.kind]?.join(", ") ?? "see the shapes"}) and was downgraded to hero; fill them in`);
        });
      }
      // Contract errors always retry; soft problems retry once, then the valid chunk is kept.
      if (r.ok && got.length === to - from && (attempt >= 2 || !problems.length)) { accepted = chunkScenes; break; }
      history.push(problems);
      feedback = problems;
    }
    if (!accepted) fail(history[history.length - 1] ?? ["no scenes"], lastDraft);
    scenes.push(...accepted!);
  }

  // 3. Assemble and validate the whole project once more (ids are re-deduplicated across chunks).
  const sb = normalizeStoryboard({ ...head, scenes }, plan);
  const r = validateStoryboard(sb, { format: plan.format, language: plan.language });
  if (!r.ok) fail(r.errors, sb);
  const price = PRICES[model];
  const est = price ? Math.round((((usage.prompt_tokens ?? 0) * price.in + (usage.completion_tokens ?? 0) * price.out) / 1e6) / 0.000011) : null;
  const ok = r as { ok: true; storyboard: Storyboard };
  return { storyboard: ok.storyboard, model, attempts: calls, ms: Date.now() - t0, usage, est_neurons: est, words: countWords(ok.storyboard), scenes: ok.storyboard.scenes.length, fixture: false, history, style: plan.kleo };
}
