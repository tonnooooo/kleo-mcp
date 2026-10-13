/**
 * KLEO STUDIO — THE AGENT. The chat half of Studio: the person says what they want, Kleo answers like a creative
 * friend and, as soon as the idea is clear, PROPOSES one clip: a polished prompt, a model and its settings, and the
 * price in credits. The agent never spends anything — the page shows the proposal as a card and only the person's
 * own tap on "Generate" moves credits (generate.ts). A model that misreads a sentence can cost a reply, never money.
 *
 * The model is an OpenAI-compatible chat model bought through ePhone (default Claude Haiku 5.5, a fraction of a cent
 * per message), with one tool, `propose_video`. It sees the pictures the person attaches, so "animate this photo"
 * or "make my product spin" works. When the model cannot be reached the person still gets a usable proposal built
 * from their own words and the settings they picked.
 */
import type { StudioEnv } from "./env.ts";
import { ephone } from "../ephone.ts";
import { MODELS, clipCredits, normalizeSettings, type ClipSettings, type ModelKey } from "./models.ts";
import { IMAGE_MODELS, imageCredits, normalizeImageSettings, type ImageModelKey, type ImageSettings } from "./image-models.ts";
import type { MessageRow, UploadRow } from "./store.ts";

export const DEFAULT_AGENT_MODEL = "claude-haiku-5-5";
const CHAT_ROUTING = { "X-Provider-Order": "official_cheap,official", "X-Provider-Only": "true" };
const HISTORY = 24;

export interface Proposal {
  /** A video clip or a set of pictures (old proposals have no kind: video). */
  kind?: "video" | "image";
  title: string;
  prompt: string;
  settings: ClipSettings | ImageSettings;
  credits: number;
  imageIds: string[];
}
export interface AgentReply { text: string; proposal: Proposal | null; fallback: boolean }

export interface AgentContext {
  history: MessageRow[];
  text: string;
  uploads: UploadRow[];
  /** The settings chosen on the page (model, duration, resolution, aspect, audio). */
  ui: Partial<Record<keyof ClipSettings, unknown>>;
  /** The picture settings chosen on the page (model, aspect, quality, count). */
  uiImage?: Partial<Record<keyof ImageSettings, unknown>>;
  /** What the page is set to make: the agent leans that way when the request does not say. */
  mode?: "video" | "image";
  credits: number;
  allowed: ModelKey[];
  allowedImages?: ImageModelKey[];
  margin: number;
}

const TOOL = {
  type: "function",
  function: {
    name: "propose_video",
    description: "Show the user a ready-to-generate video card. Call it as soon as the idea is clear enough to make a good clip. The user decides whether to generate it.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "2-5 word title for the card, in the user's language." },
        prompt: { type: "string", description: "The full English prompt for the video model (60-160 words): subject, action, setting, camera, light, style, sound." },
        model: { type: "string", enum: MODELS.map((m) => m.key) },
        duration: { type: "integer", description: "Seconds. Seedance: 5, 10 or 15. Veo: 4, 6 or 8." },
        resolution: { type: "string", enum: ["480p", "720p", "1080p"] },
        aspect: { type: "string", enum: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] },
        audio: { type: "boolean", description: "Generate sound (ambience, effects, dialogue). Default true." },
        image_role: { type: "string", enum: ["first_frame", "reference", "none"], description: "How to use the attached pictures: first_frame = the video starts from the picture (animate a photo); reference = keep the look of a character/product/style; none = ignore them." },
      },
      required: ["title", "prompt"],
    },
  },
};

const IMAGE_TOOL = {
  type: "function",
  function: {
    name: "propose_image",
    description: "Show the user a ready-to-generate picture card (photo, poster, thumbnail, product shot, character, logo idea…). The user decides whether to generate it.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "2-5 word title for the card, in the user's language." },
        prompt: { type: "string", description: "The full English prompt for the image model (40-120 words): subject, composition, setting, light, style, lens; exact text to render in quotes." },
        model: { type: "string", enum: IMAGE_MODELS.map((m) => m.key) },
        aspect: { type: "string", enum: ["1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "21:9"] },
        quality: { type: "string", enum: ["1K", "2K", "4K"] },
        count: { type: "integer", enum: [1, 2, 4], description: "How many variations." },
        use_images: { type: "boolean", description: "Use the attached pictures as references (edit or keep a person/product/style)." },
      },
      required: ["title", "prompt"],
    },
  },
};

export function systemPrompt(ctx: AgentContext): string {
  const ui = normalizeSettings(ctx.ui, ctx.uploads.length);
  const lines = MODELS.map((m) => {
    const p5 = clipCredits({ model: m.key, duration: m.defaultDuration, resolution: m.defaultResolution, aspect: "16:9", audio: true, imageRole: "none" }, ctx.margin);
    const lock = ctx.allowed.includes(m.key) ? "" : " [LOCKED for this user until they buy a pack]";
    return `- ${m.key} (${m.name}): ${m.blurb}. Durations ${m.durations.join("/")} s, ${m.resolutions.join("/")}, ratios ${m.aspects.join(" ")}. ${m.defaultDuration} s ${m.defaultResolution} ≈ ${p5} credits.${lock}`;
  }).join("\n");
  const ui2 = normalizeImageSettings(ctx.uiImage ?? {});
  const imageLines = IMAGE_MODELS.map((m) => {
    const lock = (ctx.allowedImages ?? []).includes(m.key) ? "" : " [LOCKED for this user until they buy a pack]";
    return `- ${m.key} (${m.name}): ${m.blurb}. Qualities ${m.qualities.join("/")}. 1 picture ≈ ${imageCredits({ model: m.key, aspect: "1:1", quality: m.defaultQuality, count: 1 }, ctx.margin)} credit(s), 4 pictures ≈ ${imageCredits({ model: m.key, aspect: "1:1", quality: m.defaultQuality, count: 4 }, ctx.margin)}.${lock}`;
  }).join("\n");
  return `You are Kleo, the creative director inside Kleo Studio, an app where people make AI videos and pictures.
Talk like a friendly, talented creator: short (1-3 sentences), warm, zero jargon. Always reply in the language the user writes in.

Your job: turn the user's idea into ONE great result and show it as a card: propose_video for a clip, propose_image for a picture.
The app is set to make ${ctx.mode === "image" ? "PICTURES" : "VIDEOS"} right now: use that unless the user clearly asks for the other.
- If the idea is clear enough, call the tool right away. Do not ask permission first.
- Ask at most one short question, and only when something essential is missing (for example "a video" with no subject).
- Never say the video is being generated: the user taps Generate on the card. Mention the price in credits only if useful.
- If the user asks to change something (longer, vertical, cheaper, different style), call propose_video again with the change.
- Pictures the user attached: use image_role first_frame to animate a photo, reference to keep a person/product/style.

Video models (keys for propose_video):
${lines}
Picture models (keys for propose_image):
${imageLines}
Pictures chosen now: model ${ui2.model}, ${ui2.aspect}, ${ui2.quality}, ${ui2.count} at a time. Text inside a picture: Nano Banana Pro is best.
Pick the user's chosen settings unless the idea clearly needs something else. Chosen now: model ${ui.model}, ${ui.duration} s, ${ui.resolution}, ${ui.aspect}, sound ${ui.audio ? "on" : "off"}.
Social posts, TikTok, Reels, Shorts = 9:16. YouTube, film, trailer = 16:9. The user has ${ctx.credits} credits.

Writing the prompt (English, 60-160 words, one paragraph):
subject and what it looks like → the action, in present tense → the setting → camera (shot size and movement: slow dolly-in, handheld, drone orbit, close-up…) → light and color mood → style (photoreal, anime, 3D, claymation…) → sound (ambience, effects, music mood; dialogue in quotes with the language it is spoken in).
For 10-15 s Seedance clips you may describe 2-3 shots in order ("Shot 1: … Shot 2: …"). Keep one clear subject. No on-screen text unless asked.
Refuse sexual content involving minors, sexual content about real people, and realistic fakes of real public figures; offer a safe alternative instead.`;
}

/** One stored message as the model reads it back. */
function historyLine(m: MessageRow): { role: "user" | "assistant"; content: string } | null {
  let data: Record<string, any> = {};
  try { data = m.data ? JSON.parse(m.data) : {}; } catch { /* plain text */ }
  if (m.role === "user") {
    const n = Array.isArray(data.attachments) ? data.attachments.length : 0;
    const text = `${m.text ?? ""}${n ? `\n[attached ${n} picture${n > 1 ? "s" : ""}]` : ""}`.trim();
    return text ? { role: "user", content: text } : null;
  }
  const parts = [m.text ?? ""];
  if (data.proposal) {
    const p = data.proposal as Proposal;
    const st = p.settings as unknown as Record<string, unknown>;
    parts.push(p.kind === "image"
      ? `[Proposed picture "${p.title}": ${st.model}, ${st.aspect}, ${st.quality}, ${st.count} at a time. Prompt: ${p.prompt}]`
      : `[Proposed clip "${p.title}": ${st.model}, ${st.duration} s, ${st.resolution}, ${st.aspect}. Prompt: ${p.prompt}]`);
    if (Array.isArray(data.generations) && data.generations.length) parts.push("[The user generated it.]");
  }
  if (data.generation) parts.push("[A clip was generated directly from the user's prompt.]");
  const text = parts.join("\n").trim();
  return text ? { role: "assistant", content: text } : null;
}

/** Folds consecutive turns of the same role (some providers refuse two user turns in a row). */
function alternate(msgs: { role: "user" | "assistant"; content: any }[]) {
  const out: typeof msgs = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (!last || last.role !== m.role) { out.push({ ...m }); continue; }
    if (typeof last.content === "string" && typeof m.content === "string") { last.content += `\n\n${m.content}`; continue; }
    const parts = (c: any) => (typeof c === "string" ? [{ type: "text", text: c }] : c);
    last.content = [...parts(last.content), ...parts(m.content)];
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/** Turns the tool's arguments into a proposal the page can price and the person can generate. */
export function proposalFrom(args: Record<string, unknown>, ctx: AgentContext): Proposal | null {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return null;
  const imageRole = args.image_role === "none" ? "none" : args.image_role;
  const uploads = imageRole === "none" ? [] : ctx.uploads;
  let settings = normalizeSettings({
    model: args.model ?? ctx.ui.model, duration: args.duration ?? ctx.ui.duration, resolution: args.resolution ?? ctx.ui.resolution,
    aspect: args.aspect ?? ctx.ui.aspect, audio: typeof args.audio === "boolean" ? args.audio : ctx.ui.audio, imageRole,
  }, uploads.length);
  // A model this account cannot use yet is swapped for the user's own choice (or the first one it can use).
  if (!ctx.allowed.includes(settings.model)) {
    const fallback = ctx.allowed.includes(String(ctx.ui.model) as ModelKey) ? String(ctx.ui.model) : ctx.allowed[0];
    if (fallback) settings = normalizeSettings({ ...settings, model: fallback }, uploads.length);
  }
  return {
    kind: "video",
    title: String(args.title ?? "").trim().slice(0, 60) || "Your video",
    prompt: prompt.slice(0, 2000),
    settings,
    credits: clipCredits(settings, ctx.margin),
    imageIds: uploads.map((u) => u.id),
  };
}

/** The picture tool's arguments as a card, on a model this account may use. */
export function imageProposalFrom(args: Record<string, unknown>, ctx: AgentContext): Proposal | null {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return null;
  const ui = ctx.uiImage ?? {};
  let settings = normalizeImageSettings({ model: args.model ?? ui.model, aspect: args.aspect ?? ui.aspect, quality: args.quality ?? ui.quality, count: args.count ?? ui.count });
  const allowed = ctx.allowedImages ?? [];
  if (!allowed.includes(settings.model)) {
    const fallback = allowed.includes(String(ui.model) as ImageModelKey) ? String(ui.model) : allowed[0];
    if (fallback) settings = normalizeImageSettings({ ...settings, model: fallback });
  }
  const uploads = args.use_images === false ? [] : ctx.uploads;
  return {
    kind: "image",
    title: String(args.title ?? "").trim().slice(0, 60) || "Your picture",
    prompt: prompt.slice(0, 4000),
    settings,
    credits: imageCredits(settings, ctx.margin),
    imageIds: uploads.map((u) => u.id),
  };
}

/** A proposal straight from the person's words, for when the model is unreachable. */
export function fallbackProposal(ctx: AgentContext): Proposal | null {
  if (ctx.mode === "image") return ctx.text.trim() ? imageProposalFrom({ title: ctx.text.trim().split(/\s+/).slice(0, 4).join(" "), prompt: ctx.text.trim() }, ctx) : null;
  if (!ctx.text.trim() && !ctx.uploads.length) return null;
  return proposalFrom({ title: ctx.text.trim().split(/\s+/).slice(0, 4).join(" ") || "Your video", prompt: ctx.text.trim() || "Bring this picture to life with natural, cinematic motion." }, ctx);
}

export async function runAgent(env: StudioEnv, ctx: AgentContext, pictures: string[]): Promise<AgentReply> {
  const history = ctx.history.slice(-HISTORY).map(historyLine).filter((m): m is NonNullable<typeof m> => !!m);
  const current: any[] = [{ type: "text", text: ctx.text.trim() || "(no text — see the picture)" }];
  for (const url of pictures) current.push({ type: "image_url", image_url: { url } });
  const messages = [
    { role: "system", content: systemPrompt(ctx) },
    ...alternate([...history, { role: "user" as const, content: current }]),
  ];
  try {
    const r = await ephone<{ choices?: { message?: { content?: unknown; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[] }>(
      env, "POST", "/v1/chat/completions",
      { model: (env.STUDIO_AGENT_MODEL ?? "").trim() || DEFAULT_AGENT_MODEL, messages, tools: [TOOL, IMAGE_TOOL], tool_choice: "auto", max_tokens: 1200, temperature: 0.7 },
      { timeoutMs: 45_000, routing: CHAT_ROUTING },
    );
    const msg = r.choices?.[0]?.message ?? {};
    let text = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content) ? (msg.content as any[]).map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "";
    let proposal: Proposal | null = null;
    for (const call of msg.tool_calls ?? []) {
      const name = call.function?.name;
      if (name !== "propose_video" && name !== "propose_image") continue;
      try {
        const args = JSON.parse(call.function?.arguments ?? "{}");
        proposal = name === "propose_image" ? imageProposalFrom(args, ctx) : proposalFrom(args, ctx);
      } catch { /* malformed arguments: no card */ }
    }
    text = text.trim();
    if (!text && proposal) text = "Here's what I'd make. Tap Generate when you're ready, or tell me what to change.";
    if (!text) text = "Tell me what you'd like to see and I'll set it up.";
    return { text: text.slice(0, 4000), proposal, fallback: false };
  } catch (e) {
    const proposal = fallbackProposal(ctx);
    return {
      text: proposal
        ? "I can't think it through right now, but here's your idea ready to go. Tap Generate, or edit the prompt first."
        : "I can't answer right now. Try again in a moment, or switch the agent off to generate directly.",
      proposal, fallback: true,
    };
  }
}

/** A short chat title from the first message. */
export function chatTitle(text: string, hasPictures: boolean): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return hasPictures ? "Animate a picture" : "New video";
  return t.length > 42 ? `${t.slice(0, 40).replace(/\s+\S*$/, "")}…` : t;
}


