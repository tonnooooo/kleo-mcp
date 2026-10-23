/**
 * KLEO STUDIO — APPS. The one-purpose tools of the Higgsfield kind, each a short form (a picture here, a clip there, a
 * line of text) in front of one or two provider calls:
 *
 *   face-swap        two pictures              → Nano Banana Pro edit          (picture)
 *   video-face-swap  a clip + a face           → HappyHorse video edit         (video)
 *   talking-photo    a portrait + words/voice  → speech, then Kling avatar     (video)
 *   lipsync          a clip + words/voice      → speech, then Kling lip sync   (video)
 *   motion-control   a character + a dance     → Kling 3.0 motion control      (video)
 *   outfit-swap      a person + a garment      → FLUX virtual try-on           (picture)
 *   video-edit       a clip + an instruction   → FLUX video edit               (video)
 *   video-upscale    a clip                    → FLUX video upscale            (video)
 *   voice            words                     → gpt-4o-mini-tts               (sound)
 *   music            a description             → Suno                          (2 songs)
 *   sfx              a description             → Suno sounds                   (sound)
 *   trend-…          a photo per seat          → Wan 3.0 video edit, on WaveSpeed (video; src/studio/trends.ts)
 *
 * planTool() is pure: from the form and what the uploads are (kind, seconds, size) it answers the provider calls and
 * their price, or a refusal a person can act on. The Worker runs the plan (generate.ts runTool).
 *
 * Prices (ePhone price list, 13 October 2026; CNY at 7 per dollar; Kling 1 credit = ¥1 × 0.8):
 *   Nano Banana Pro ~$0.073 a picture · HappyHorse edit ¥0.9/s 720P × 0.8 on input + output seconds
 *   Kling avatar 0.4 (std) / 0.8 (pro) credit per second · Kling lip sync 0.5 credit per 5 s
 *   Kling motion control 0.9 (720p) / 1.2 (1080p) credit per second · FLUX try-on $0.0375 · FLUX video edit $0.03/s
 *   FLUX upscale $0.07 per output megapixel-second (precise) · speech ≈ $0.00025/s · Suno $0.08 · Suno sounds $0.069
 *   (FLUX and the speech model × 0.53 on the official_cheap channel, Suno × 0.8)
 *
 * FACES. The face tools ask the person to confirm they have the right to use the face, and refuse nothing by
 * themselves beyond that: the providers moderate public figures, minors and sexual content, and every use is in the
 * audit table with the account. Kleo never removes a provider's own refusal.
 */
import { CREDIT_USD, DEFAULT_MARGIN } from "./models.ts";
import { DEFAULT_TREND_QUALITY, TRENDS, TREND_CUSTOM_MAX, TREND_EXTRA_MAX, TREND_QUALITIES, WAN30_EDIT_MODEL, trendByKey, trendChangeLines, trendCostUsd, trendNeedsAllSeats, trendQuality, trendTaskInput, type Trend, type TrendChange } from "./trends.ts";

export type ToolKey = "face-swap" | "video-face-swap" | "talking-photo" | "lipsync" | "character-swap" | "photo-character-swap" | "motion-control" | "outfit-swap" | "video-edit" | "video-upscale" | "voice" | "music" | "sfx" | `trend-${string}`;
export type FieldKind = "image" | "video" | "audio" | "text" | "select" | "voice";
export interface ToolField {
  key: string; kind: FieldKind; label: string; hint?: string; required?: boolean;
  options?: { value: string; label: string }[]; default?: string; maxLength?: number; placeholder?: string;
  /** Show the field only when another field has one of these values. */
  when?: { field: string; is: string[] };
  /** Filled by the page itself, never shown (Character Swap's first frame). */
  hidden?: boolean;
}
export interface ToolDef {
  key: ToolKey; name: string; blurb: string; group: "trend" | "face" | "video" | "image" | "audio";
  icon: string; tint: string; output: "video" | "image" | "audio"; consent?: boolean; badge?: string;
  fields: ToolField[];
  /** Viral templates only (src/studio/trends.ts): the looping example, the seat guide still and its seat marks. */
  preview?: string; guide?: string; seats?: { key: string; color: string; at?: [number, number] }[];
}

export const VOICES = [
  { value: "nova", label: "Nova · bright, friendly" }, { value: "shimmer", label: "Shimmer · soft, warm" },
  { value: "coral", label: "Coral · lively" }, { value: "sage", label: "Sage · calm" },
  { value: "alloy", label: "Alloy · neutral" }, { value: "ash", label: "Ash · clear, male" },
  { value: "onyx", label: "Onyx · deep, male" }, { value: "echo", label: "Echo · smooth, male" },
  { value: "ballad", label: "Ballad · expressive" }, { value: "verse", label: "Verse · storyteller" },
  { value: "fable", label: "Fable · British" },
];
const TONES = [
  { value: "natural", label: "Natural" }, { value: "excited", label: "Excited" }, { value: "calm", label: "Calm" },
  { value: "narrator", label: "Narrator" }, { value: "whisper", label: "Whisper" }, { value: "sales", label: "Salesy" },
];
const TONE_TEXT: Record<string, string> = {
  natural: "Speak naturally and clearly, like a real person talking to a friend.",
  excited: "Speak with high energy and excitement, upbeat and fast.",
  calm: "Speak slowly and calmly, warm and reassuring.",
  narrator: "Speak like a documentary narrator: rich, measured, cinematic.",
  whisper: "Speak in a soft, intimate whisper.",
  sales: "Speak like an enthusiastic product presenter on social media, confident and punchy.",
};
const SPEECH: ToolField[] = [
  { key: "source", kind: "select", label: "Voice from", options: [{ value: "script", label: "Type the words" }, { value: "audio", label: "Upload a voice" }], default: "script" },
  { key: "script", kind: "text", label: "What should they say?", maxLength: 1000, placeholder: "Hi! I'm so excited to show you…", when: { field: "source", is: ["script"] } },
  { key: "voice", kind: "voice", label: "Voice", default: "nova", when: { field: "source", is: ["script"] } },
  { key: "tone", kind: "select", label: "Tone", options: TONES, default: "natural", when: { field: "source", is: ["script"] } },
  { key: "audio", kind: "audio", label: "Voice clip", hint: "MP3 or WAV, 2–60 seconds", when: { field: "source", is: ["audio"] } },
];

export const TOOLS: ToolDef[] = [
  { key: "face-swap", name: "Face Swap", blurb: "Put a face on any photo", group: "face", icon: "user", tint: "#ff375f", output: "image", consent: true, badge: "Popular",
    fields: [
      { key: "target", kind: "image", label: "Photo", hint: "The picture to change", required: true },
      { key: "face", kind: "image", label: "Face", hint: "A clear, front-facing face", required: true },
    ] },
  { key: "video-face-swap", name: "Video Face Swap", blurb: "Swap a face in a video", group: "face", icon: "film", tint: "#bf5af2", output: "video", consent: true,
    fields: [
      { key: "video", kind: "video", label: "Video", hint: "MP4 or MOV, 3–15 seconds", required: true },
      { key: "face", kind: "image", label: "Face", hint: "A clear, front-facing face", required: true },
    ] },
  { key: "talking-photo", name: "Talking Photo", blurb: "Make any portrait speak", group: "face", icon: "mic", tint: "#0a84ff", output: "video", consent: true, badge: "New",
    fields: [
      { key: "image", kind: "image", label: "Portrait", hint: "One face, looking at the camera", required: true },
      ...SPEECH,
      { key: "quality", kind: "select", label: "Quality", options: [{ value: "std", label: "Standard 720p" }, { value: "pro", label: "Pro 1080p" }], default: "std" },
    ] },
  { key: "lipsync", name: "Lipsync", blurb: "Make a video say new words", group: "face", icon: "lips", tint: "#ff9f0a", output: "video", consent: true,
    fields: [
      { key: "video", kind: "video", label: "Video", hint: "MP4 or MOV with one face, 2–60 seconds", required: true },
      ...SPEECH,
    ] },
  // 18 October 2026, the owner: "video character swap ma fatto bene … uguale o più di Higgsfield". Compared on a real
  // 1080p clip: Kling O1 makes a perfect character but rebuilds the room from the reference photo; Runway Aleph 2 keeps
  // the room but the character's hands smear. Both now start from the video's first frame REDRAWN with the character
  // (FLUX.2 Pro, frame + character): given to Kling as its reference, the reference IS the original scene, so Kling has
  // no other room to copy; given to Aleph as the keyframe at 0 s, it is what Aleph carries through. Kling is the
  // default (the character the owner liked); Aleph stays for the exact-scene cases. The page takes the first frame itself.
  { key: "character-swap", name: "Character Swap", blurb: "Put your character in any video", group: "video", icon: "user", tint: "#ff9f0a", output: "video", consent: true, badge: "Pro",
    fields: [
      { key: "video", kind: "video", label: "Video", hint: "MP4 or MOV, 3–10 seconds, 720p or more", required: true },
      { key: "image", kind: "image", label: "Character", hint: "Clear face, the clothes you want", required: true },
      { key: "frame", kind: "image", label: "First frame", hidden: true, required: true },
      { key: "prompt", kind: "text", label: "Extra details (optional)", maxLength: 500, placeholder: "Keep the red jacket from the photo" },
      { key: "engine", kind: "select", label: "Engine", options: [{ value: "kling", label: "Best character · Kling O1" }, { value: "aleph", label: "Exact scene · Runway Aleph 2" }], default: "kling" },
      { key: "quality", kind: "select", label: "Quality", options: [{ value: "1080p", label: "1080p" }, { value: "720p", label: "720p" }], default: "1080p", when: { field: "engine", is: ["kling"] } },
    ] },
  // The same swap for a photo (18 Oct 2026): one FLUX.2 Pro edit with the photo and the character as references.
  { key: "photo-character-swap", name: "Photo Character Swap", blurb: "Put your character in any photo", group: "image", icon: "user", tint: "#ff6b00", output: "image", consent: true, badge: "New",
    fields: [
      { key: "photo", kind: "image", label: "Photo", hint: "The picture to change", required: true },
      { key: "image", kind: "image", label: "Character", hint: "Clear face, the clothes you want", required: true },
      { key: "prompt", kind: "text", label: "Extra details (optional)", maxLength: 500, placeholder: "Keep the red jacket from the photo" },
    ] },
  { key: "motion-control", name: "Motion Control", blurb: "Copy any dance or move", group: "video", icon: "run", tint: "#30d158", output: "video",
    fields: [
      { key: "image", kind: "image", label: "Character", hint: "Full body works best", required: true },
      { key: "video", kind: "video", label: "Moves", hint: "A clip of the motion, 3–30 seconds", required: true },
      { key: "prompt", kind: "text", label: "Extra details (optional)", maxLength: 500, placeholder: "On a neon stage, cinematic light" },
      { key: "quality", kind: "select", label: "Quality", options: [{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }], default: "720p" },
    ] },
  { key: "outfit-swap", name: "Outfit Swap", blurb: "Try any clothes on anyone", group: "image", icon: "shirt", tint: "#64d2ff", output: "image",
    fields: [
      { key: "person", kind: "image", label: "Person", hint: "Full or half body", required: true },
      { key: "garment", kind: "image", label: "Clothes", hint: "A photo of the outfit", required: true },
    ] },
  { key: "video-edit", name: "Edit Video", blurb: "Change anything in a clip", group: "video", icon: "wand", tint: "#5e5ce6", output: "video",
    fields: [
      { key: "video", kind: "video", label: "Video", hint: "MP4, up to 15 seconds", required: true },
      { key: "prompt", kind: "text", label: "What should change?", required: true, maxLength: 1000, placeholder: "Make it snow · turn day into night · make the car red" },
    ] },
  { key: "video-upscale", name: "Upscale Video", blurb: "Sharper, up to 4K", group: "video", icon: "hd", tint: "#ffd60a", output: "video",
    fields: [{ key: "video", kind: "video", label: "Video", hint: "MP4 up to 20 seconds and 1440p", required: true }] },
  { key: "voice", name: "Voiceover", blurb: "Text to a natural voice", group: "audio", icon: "mic", tint: "#ff2d55", output: "audio",
    fields: [
      { key: "script", kind: "text", label: "Text to read", required: true, maxLength: 3000, placeholder: "Write the words to speak…" },
      { key: "voice", kind: "voice", label: "Voice", default: "nova" },
      { key: "tone", kind: "select", label: "Tone", options: TONES, default: "natural" },
    ] },
  { key: "music", name: "Music", blurb: "Songs and soundtracks", group: "audio", icon: "music", tint: "#af52de", output: "audio",
    fields: [
      { key: "prompt", kind: "text", label: "Describe your new song", required: true, maxLength: 1000, placeholder: "Kleo writes a new song: upbeat K-pop for a 4th birthday · dark cinematic trailer score" },
      { key: "vocals", kind: "select", label: "Vocals", options: [{ value: "none", label: "Instrumental" }, { value: "female", label: "Female voice" }, { value: "male", label: "Male voice" }], default: "none" },
    ] },
  { key: "sfx", name: "Sound Effects", blurb: "Any sound from words", group: "audio", icon: "wave", tint: "#32ade6", output: "audio",
    fields: [
      { key: "prompt", kind: "text", label: "Describe the sound", required: true, maxLength: 300, placeholder: "Thunder rolling far away · a sword unsheathed · crowd cheering" },
      { key: "loop", kind: "select", label: "Type", options: [{ value: "one-shot", label: "One shot" }, { value: "loop", label: "Loop" }], default: "one-shot" },
    ] },
  // The viral templates (20 October 2026, ausar.ai's people-swap templates): a photo per seat, swapped into the clip.
  ...TRENDS.map(trendTool),
];

/** A template's change as the page shows it: "Original", the choices, "Your idea" with a line for the person's words. */
function changeFields(c: TrendChange): ToolField[] {
  const options = [{ value: "original", label: "Original" }, ...c.options.map((o) => ({ value: o.value, label: o.label })), ...(c.custom ? [{ value: "custom", label: "Your idea" }] : [])];
  return [
    { key: c.key, kind: "select", label: c.label, options, default: "original" },
    ...(c.custom ? [{ key: `${c.key}Text`, kind: "text" as const, label: `Your ${c.label.toLowerCase()}`, maxLength: TREND_CUSTOM_MAX, placeholder: "Describe it in a few words", when: { field: c.key, is: ["custom"] } }] : []),
  ];
}

/** One viral template as an app: a photo box per seat (any of them may stay empty), its changes and the output quality. */
function trendTool(t: Trend): ToolDef {
  return {
    key: t.key, name: t.name, blurb: t.blurb, group: "trend", icon: "film", tint: t.tint, output: "video", consent: true, badge: "Viral",
    preview: t.preview, guide: t.guide, seats: t.seats.map((s) => ({ key: s.key, color: s.color, ...(s.at ? { at: s.at } : {}) })),
    fields: [
      // A template with its own fixed prompt needs every seat (as on ausar.ai); Kleo's own may leave seats empty.
      ...t.seats.map((s, i): ToolField => trendNeedsAllSeats(t)
        ? { key: s.key, kind: "image", label: `Person ${i + 1}`, hint: s.hint ?? "A clear photo", required: true }
        : { key: s.key, kind: "image", label: `Person ${i + 1}`, hint: i === 0 ? `${s.label} · a clear photo` : `${s.label} · optional` }),
      ...(t.changes ?? []).flatMap(changeFields),
      ...(t.changes?.length ? [{ key: "extra", kind: "text" as const, label: "Anything else to change? (optional)", maxLength: TREND_EXTRA_MAX, placeholder: "Make it rain · everyone in red jerseys" }] : []),
      { key: "quality", kind: "select", label: "Quality", options: TREND_QUALITIES.map((q) => ({ value: q, label: q })), default: DEFAULT_TREND_QUALITY },
    ],
  };
}

export const toolByKey = (key: string | null | undefined): ToolDef | null => TOOLS.find((t) => t.key === key) ?? null;

/** What the plan knows about an attached file. */
export interface Media { id: string; url: string; kind: "image" | "video" | "audio"; seconds: number | null; width: number | null; height: number | null; type: string }
/** One provider call. `{{speech}}` in the input is replaced by the link to the spoken audio once it exists. */
export interface PlannedTask {
  model: string; input: Record<string, unknown>; routing?: Record<string, string>; output: "image" | "video" | "audio";
  /** Who runs it: ePhone (the default), or WaveSpeed for the viral templates (src/wavespeed.ts). */
  provider?: "wavespeed";
  /** A second task started when this one finishes; "{{prev}}" in its input becomes this task's result link. */
  then?: PlannedTask;
}
export interface Plan { usd: number; speech?: { text: string; voice: string; tone: string }; tasks: PlannedTask[]; output: ToolDef["output"]; summary: string }
export class ToolRefusal extends Error {}

const CNY = 1 / 7;
const CHEAP = { "X-Provider-Order": "official_cheap", "X-Provider-Only": "true" };
const KLING_CREDIT_USD = 1 * 0.8 * CNY;
/** Runway Aleph 2 video-to-video, per output second (billed at Runway's own rate in the 18 Oct 2026 probe). */
const ALEPH2_USD_PER_S = 0.28;
/** One FLUX.2 Pro edit with two reference pictures ($0.06 measured on 18 Oct 2026: the references are billed too). */
const FLUX_EDIT_USD = 0.06;
/** One Nano Banana Pro picture at its top quality (4K: 2,000 image tokens at $120 per 1M, two input pictures, × 0.53). */
const NBP_MAX_USD = 0.13;
/** Speech is ~$0.00025 a second on the cheap channel; one generous flat figure covers it. */
const SPEECH_USD = 0.01;
/** Characters of speech per second, to price a script before it is spoken (fast talkers ~17, slow ~12). */
export const CHARS_PER_SECOND = 12;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function toolCredits(usd: number, margin = DEFAULT_MARGIN): number {
  return Math.max(1, Math.ceil((usd * margin) / CREDIT_USD - 1e-9));
}

/** Seconds a script takes to say, for the price shown before it is spoken. */
export const scriptSeconds = (text: string): number => Math.max(2, Math.ceil(text.trim().length / CHARS_PER_SECOND));

function nearestAspect(w: number | null, h: number | null): string {
  if (!w || !h) return "1:1";
  const r = w / h;
  const all = [["1:1", 1], ["4:5", 0.8], ["3:4", 0.75], ["2:3", 0.667], ["9:16", 0.5625], ["4:3", 1.333], ["3:2", 1.5], ["16:9", 1.778], ["21:9", 2.333]] as const;
  return all.reduce((best, a) => (Math.abs(Math.log(a[1] / r)) < Math.abs(Math.log(best[1] / r)) ? a : best))[0];
}

function need(m: Media | undefined, kind: Media["kind"], label: string): Media {
  if (!m) throw new ToolRefusal(`Add the ${label.toLowerCase()}.`);
  if (m.kind !== kind) throw new ToolRefusal(`The ${label.toLowerCase()} must be ${kind === "image" ? "a picture" : kind === "video" ? "a video" : "a sound file"}.`);
  return m;
}
function seconds(m: Media, label: string, min: number, max: number): number {
  const s = m.seconds;
  if (!s) throw new ToolRefusal(`Kleo couldn't read the length of the ${label.toLowerCase()}. Use an MP4/MOV video or an MP3/WAV sound.`);
  if (s < min) throw new ToolRefusal(`The ${label.toLowerCase()} is too short (${s.toFixed(1)} s, at least ${min} s).`);
  if (s > max + 0.5) throw new ToolRefusal(`The ${label.toLowerCase()} is too long (${Math.round(s)} s, at most ${max} s).`);
  return Math.min(s, max);
}

/** The voice of a talking-photo or lipsync: the person's clip, or words to speak. */
function speechPart(inputs: Record<string, string>, media: Record<string, Media | undefined>): { seconds: number; speech?: Plan["speech"]; audioUrl: string } {
  if ((inputs.source ?? "script") === "audio") {
    const a = need(media.audio, "audio", "Voice clip");
    return { seconds: seconds(a, "Voice clip", 2, 60), audioUrl: a.url };
  }
  const text = String(inputs.script ?? "").trim();
  if (text.length < 3) throw new ToolRefusal("Type what they should say.");
  if (text.length > 1000) throw new ToolRefusal("Keep the words under 1000 characters (about a minute).");
  return { seconds: Math.min(60, scriptSeconds(text)), speech: { text, voice: inputs.voice || "nova", tone: inputs.tone || "natural" }, audioUrl: "{{speech}}" };
}

/** A viral template: every seat with a photo is swapped in; at least one seat needs one. */
function planTrend(trend: Trend, inputs: Record<string, string>, media: Record<string, Media | undefined>): Plan {
  const filled = trend.seats.filter((s) => media[s.key]);
  for (const s of filled) {
    const m = need(media[s.key], "image", `Person ${trend.seats.indexOf(s) + 1}`);
    // Wan 3.0 reads reference pictures from 240 to 8000 pixels a side (the page shrinks big photos before upload).
    const lo = Math.min(m.width ?? 1000, m.height ?? 1000), hi = Math.max(m.width ?? 0, m.height ?? 0);
    if (lo < 240) throw new ToolRefusal(`The photo of person ${trend.seats.indexOf(s) + 1} is too small (${lo} pixels). Use a photo at least 240 pixels on each side.`);
    if (hi > 8000) throw new ToolRefusal(`The photo of person ${trend.seats.indexOf(s) + 1} is too big (${hi} pixels). Use a photo under 8000 pixels.`);
  }
  if (trendNeedsAllSeats(trend) && filled.length < trend.seats.length) throw new ToolRefusal(trend.seats.length === 1 ? "Add your photo." : `Add a photo for each of the ${trend.seats.length} people.`);
  if (!filled.length) throw new ToolRefusal("Add a photo of at least one person.");
  const q = trendQuality(inputs.quality);
  const changes = trendChangeLines(trend, filled.map((s) => s.key), inputs).length;
  return {
    usd: trendCostUsd(trend, q), output: "video",
    summary: `${trend.name} · ${filled.length === 1 ? "1 person" : `${filled.length} people`}${changes ? ` · ${changes === 1 ? "1 change" : `${changes} changes`}` : ""} · ${q}`,
    tasks: [{ provider: "wavespeed", model: WAN30_EDIT_MODEL, output: "video",
      input: trendTaskInput(trend, filled.map((s) => s.key), filled.map((s) => media[s.key]!.url), q, inputs) }],
  };
}

export function planTool(key: ToolKey, inputs: Record<string, string>, media: Record<string, Media | undefined>): Plan {
  const t = toolByKey(key);
  if (!t) throw new ToolRefusal("That app doesn't exist.");
  const trend = trendByKey(key);
  if (trend) return planTrend(trend, inputs, media);
  switch (key) {
    case "face-swap": {
      const target = need(media.target, "image", "Photo"), face = need(media.face, "image", "Face");
      return {
        usd: 0.075, output: "image", summary: "Face swap",
        tasks: [{ model: "gemini-3-pro-image", routing: CHEAP, output: "image", input: {
          prompt: "Image 1 is the photo to keep. Image 2 shows a person's face. Replace the face of the person in image 1 with the face from image 2: the same identity, eyes, nose, mouth, jaw, face shape and skin tone as image 2. Keep image 1's pose, head angle, expression, hair, lighting, colors, clothes, body and background exactly as they are. Photorealistic and seamless, no visible edges.",
          images: [target.url, face.url], aspect_ratio: nearestAspect(target.width, target.height), quality: "high", output_format: "jpeg",
        } }],
      };
    }
    case "video-face-swap": {
      const video = need(media.video, "video", "Video"), face = need(media.face, "image", "Face");
      const s = seconds(video, "Video", 3, 15);
      return {
        usd: r3(2 * s * 0.9 * 0.8 * CNY), output: "video", summary: `Face swap · ${Math.round(s)} s`,
        tasks: [{ model: "happyhorse-1.0-video-edit", output: "video", input: {
          prompt: "Replace the face of the main person in the video with the face of the person in the reference image: same identity and facial features as the reference. Keep the motion, expressions, lip movement, head angles, lighting, clothes, background and sound of the video exactly as they are.",
          video: video.url, images: [face.url], resolution: "720P", audio_setting: "origin", watermark: false,
        } }],
      };
    }
    case "talking-photo": {
      const image = need(media.image, "image", "Portrait");
      const sp = speechPart(inputs, media);
      const pro = inputs.quality === "pro";
      return {
        usd: r3(sp.seconds * (pro ? 0.8 : 0.4) * KLING_CREDIT_USD + (sp.speech ? SPEECH_USD : 0)), output: "video", speech: sp.speech,
        summary: `Talking photo · ~${Math.round(sp.seconds)} s`,
        tasks: [{ model: "kling_avatar_image2video", output: "video", input: { image: image.url, sound_file: sp.audioUrl, mode: pro ? "pro" : "std", prompt: "Natural head movement and expressions while talking, steady camera." } }],
      };
    }
    case "lipsync": {
      const video = need(media.video, "video", "Video");
      const vs = seconds(video, "Video", 2, 60);
      const sp = speechPart(inputs, media);
      return {
        usd: r3(Math.max(vs, sp.seconds) / 5 * 0.5 * KLING_CREDIT_USD + (sp.speech ? SPEECH_USD : 0)), output: "video", speech: sp.speech,
        summary: `Lipsync · ${Math.round(vs)} s`,
        tasks: [{ model: "kling_advanced_lip_sync", output: "video", input: { video_url: video.url, sound_file: sp.audioUrl, original_audio_volume: 0, sound_volume: 1 } }],
      };
    }
    case "character-swap": {
      const video = need(media.video, "video", "Video"), image = need(media.image, "image", "Character");
      const frame = need(media.frame, "image", "First frame");
      const aleph = inputs.engine === "aleph";
      const s = aleph ? seconds(video, "Video", 2, 15) : seconds(video, "Video", 3, 10);
      // Kling reads the base video only from 700 px tall (and up to 2160).
      if (!aleph && video.height && (video.height < 700 || video.height > 2160)) throw new ToolRefusal("Use a video between 720p and 4K (at least 700 pixels tall), or the Exact scene engine.");
      const extra = String(inputs.prompt ?? "").trim().slice(0, 400);
      const still = "Replace the main person in image 1 with the character from image 2: the same face, hair, clothes and build as image 2. "
        + "Keep exactly the same pose, position, size in the frame, framing, camera angle, light and background as image 1. Realistic photograph, sharp, natural skin." + (extra ? ` ${extra}` : "");
      const redraw: Omit<PlannedTask, "then"> = { model: "flux-2-pro", routing: CHEAP, output: "image",
        input: { prompt: still, images: [frame.url, image.url], aspect_ratio: nearestAspect(frame.width ?? video.width, frame.height ?? video.height), output_format: "jpeg" } };
      if (aleph) {
        const motion = "Replace the main person in the video with the character shown in the keyframe: the same face, hair and clothes. "
          + "Keep every movement, gesture and their timing, the camera, the background and the light exactly as in the video. Realistic, sharp, natural skin, natural hands." + (extra ? ` ${extra}` : "");
        return {
          usd: r3(FLUX_EDIT_USD + s * ALEPH2_USD_PER_S), output: "video", summary: `Character swap · ${Math.round(s)} s`,
          tasks: [{ ...redraw, then: { model: "aleph2/video-to-video", routing: CHEAP, output: "video", input: { videoUri: video.url, promptText: motion.slice(0, 1000), keyframes: [{ uri: "{{prev}}", seconds: 0 }] } } }],
        };
      }
      const hd = inputs.quality !== "720p";
      const prompt = "Reference image 1 is the first frame of the finished video: the input video's own scene, objects, camera and light, with the new character already in place. "
        + "Edit the input video so it matches it: replace only the main person with the character (face, hair, clothes and build from the reference images) and keep the background, every object, the camera, the framing and the light exactly as in the input video — do not invent a new place. "
        + "Keep every movement, gesture and their timing. Realistic, sharp, natural skin and hands." + (extra ? ` ${extra}` : "");
      const a = nearestAspect(video.width, video.height);
      return {
        usd: r3(FLUX_EDIT_USD + s * (hd ? 1.2 : 0.9) * KLING_CREDIT_USD), output: "video", summary: `Character swap · ${Math.round(s)} s`,
        tasks: [{ ...redraw, then: { model: "kling-o1/omni-video", output: "video", input: {
          contents: [{ type: "prompt", text: prompt.slice(0, 2500) }, { type: "base_video", url: video.url }, { type: "refer_image", url: "{{prev}}" }, { type: "refer_image", url: image.url }],
          settings: { resolution: hd ? "1080p" : "720p", duration: Math.min(10, Math.max(3, Math.round(s))), audio: "original", aspect_ratio: a === "9:16" || a === "2:3" || a === "3:4" || a === "4:5" ? "9:16" : a === "1:1" ? "1:1" : "16:9" },
        } } }],
      };
    }
    case "photo-character-swap": {
      const photo = need(media.photo, "image", "Photo"), image = need(media.image, "image", "Character");
      const extra = String(inputs.prompt ?? "").trim().slice(0, 400);
      // Nano Banana Pro at its top quality (19 October 2026, the owner, after three live FLUX.2 Pro tests: the person was
      // right but the expression and the gesture came from the character's photo instead of the scene).
      const prompt = "Image 1 is the scene to keep. Image 2 shows the character. Put the character from image 2 into image 1 in place of the main person: "
        + "use image 2's face, identity, hair, skin tone, body and clothes. Keep from image 1, exactly: the facial expression (the same mouth shape, eyes and eyebrows), "
        + "the head angle and gaze, the pose and the hand gestures, the position and size in the frame, the framing and camera angle, the lighting, the colors and the whole background. "
        + "Photorealistic and seamless, sharp, natural skin texture, no visible edges." + (extra ? ` ${extra}` : "");
      return {
        usd: NBP_MAX_USD, output: "image", summary: "Photo character swap",
        tasks: [{ model: "gemini-3-pro-image", routing: CHEAP, output: "image", input: { prompt, images: [photo.url, image.url], aspect_ratio: nearestAspect(photo.width, photo.height), quality: "max", output_format: "jpeg" } }],
      };
    }
    case "motion-control": {
      const image = need(media.image, "image", "Character"), video = need(media.video, "video", "Moves");
      const s = seconds(video, "Moves", 3, 30);
      const hd = inputs.quality === "1080p";
      const contents: Record<string, unknown>[] = [{ type: "image", url: image.url }, { type: "video", url: video.url }];
      if (String(inputs.prompt ?? "").trim()) contents.unshift({ type: "prompt", text: String(inputs.prompt).trim().slice(0, 500) });
      return {
        usd: r3(s * (hd ? 1.2 : 0.9) * KLING_CREDIT_USD), output: "video", summary: `Motion control · ${Math.round(s)} s`,
        tasks: [{ model: "kling-3.0/motion-control", output: "video", input: { contents, settings: { character_orientation: "video", audio: "original", resolution: hd ? "1080p" : "720p" } } }],
      };
    }
    case "outfit-swap": {
      const person = need(media.person, "image", "Person"), garment = need(media.garment, "image", "Clothes");
      return {
        usd: 0.035, output: "image", summary: "Outfit swap",
        tasks: [{ model: "flux-tools/vto-v1", routing: CHEAP, output: "image", input: { prompt: "The person of image 1, maintaining exactly their face, hair, body and pose, wearing the garments of image 2.", images: [person.url, garment.url], output_format: "jpeg" } }],
      };
    }
    case "video-edit": {
      const video = need(media.video, "video", "Video");
      const s = seconds(video, "Video", 1, 15);
      const prompt = String(inputs.prompt ?? "").trim();
      if (prompt.length < 3) throw new ToolRefusal("Say what should change.");
      return {
        usd: r3(s * 0.03 * 0.53), output: "video", summary: `Video edit · ${Math.round(s)} s`,
        tasks: [{ model: "flux-tools/video-edit-v1", routing: CHEAP, output: "video", input: { prompt: prompt.slice(0, 1000), video: video.url } }],
      };
    }
    case "video-upscale": {
      const video = need(media.video, "video", "Video");
      const s = seconds(video, "Video", 1, 20);
      const w = video.width ?? 1280, h = video.height ?? 720;
      if (Math.max(w, h) > 2560 || Math.min(w, h) > 1440) throw new ToolRefusal("That video is already very sharp (over 1440p).");
      const factor = Math.max(1.5, Math.min(3, Math.round((3840 / Math.max(w, h)) * 10) / 10));
      const mp = Math.min(14, (w * h * factor * factor) / 1048576);
      return {
        usd: r3(mp * s * 0.07 * 0.53), output: "video", summary: `Upscale ×${factor} · ${Math.round(s)} s`,
        tasks: [{ model: "flux-tools/video-upscale-v1", routing: CHEAP, output: "video", input: { input_video: video.url, upscale_factor: factor, creativity: 0 } }],
      };
    }
    case "voice": {
      const text = String(inputs.script ?? "").trim();
      if (text.length < 2) throw new ToolRefusal("Write the words to speak.");
      if (text.length > 3000) throw new ToolRefusal("Keep it under 3000 characters.");
      return { usd: SPEECH_USD, output: "audio", speech: { text, voice: inputs.voice || "nova", tone: inputs.tone || "natural" }, tasks: [], summary: `Voiceover · ~${scriptSeconds(text)} s` };
    }
    case "music": {
      const prompt = String(inputs.prompt ?? "").trim();
      if (prompt.length < 3) throw new ToolRefusal("Describe the music.");
      const vocals = inputs.vocals === "female" || inputs.vocals === "male" ? inputs.vocals : "none";
      const input: Record<string, unknown> = { mv: "chirp-v6", custom: false, instrumental: vocals === "none", gpt_description_prompt: prompt.slice(0, 1000) };
      if (vocals !== "none") input.vocal_gender = vocals === "female" ? "Female" : "Male";
      return { usd: r3(0.08 * 0.8), output: "audio", summary: "Music · 2 songs", tasks: [{ model: "suno/music", output: "audio", input }] };
    }
    case "sfx": {
      const prompt = String(inputs.prompt ?? "").trim();
      if (prompt.length < 2) throw new ToolRefusal("Describe the sound.");
      return { usd: r3(0.069 * 0.8), output: "audio", summary: "Sound effect", tasks: [{ model: "suno/sounds", output: "audio", input: { mv: "chirp-v6", sound: prompt.slice(0, 300), type: inputs.loop === "loop" ? "loop" : "one-shot" } }] };
    }
  }
  throw new ToolRefusal("That app doesn't exist.");
}

/** The speech instruction for a tone. */
export const toneText = (tone: string): string => TONE_TEXT[tone] ?? TONE_TEXT.natural;

/** The catalog the page draws the Apps grid from (prices are credit estimates for a typical use). */
export function publicTools(margin = DEFAULT_MARGIN): unknown[] {
  const typical: Partial<Record<ToolKey, number>> = {
    "face-swap": 0.075, "video-face-swap": 2 * 8 * 0.9 * 0.8 * CNY, "talking-photo": 10 * 0.4 * KLING_CREDIT_USD + SPEECH_USD,
    lipsync: 10 / 5 * 0.5 * KLING_CREDIT_USD, "character-swap": FLUX_EDIT_USD + 5 * 1.2 * KLING_CREDIT_USD, "photo-character-swap": NBP_MAX_USD, "motion-control": 8 * 0.9 * KLING_CREDIT_USD, "outfit-swap": 0.035,
    "video-edit": 8 * 0.03 * 0.53, "video-upscale": 8 * 3.6 * 0.07 * 0.53, voice: SPEECH_USD, music: 0.064, sfx: 0.055,
  };
  // A template's "from" is its cheapest quality (480p).
  const usd = (k: ToolKey) => typical[k] ?? (trendByKey(k) ? trendCostUsd(trendByKey(k)!, "480p") : 0.1);
  return TOOLS.map((t) => ({ ...t, from: toolCredits(usd(t.key), margin) }));
}
