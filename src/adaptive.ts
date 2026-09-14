/**
 * THE INTAKE. What Kleo must know about a film before anything is written, and what it asks when the request does
 * not say it. The owner's rule (14 September 2026): "se l'utente non scrive determinate cose, Kleo deve chiedere" —
 * a fixed list, read off the request first, then asked for, all at once, never invented.
 *
 * Four things are required (subject, length, format, look) and refuse to be guessed: a wrong length is the wrong
 * price, a wrong format is a video that does not fit where it goes, a wrong look is the wrong film. Three are
 * optional (audience, tone, what must appear) and are asked in the same message as the required ones, never on
 * their own: a clear short request is not interrogated.
 */
import type { Format } from "./templates.ts";

export type Look = "realistic" | "animation";
export type IntakeKey = "subject" | "duration" | "format" | "look" | "audience" | "tone" | "must_keep";
export interface IntakeItem { key: IntakeKey; required: boolean; label: { en: string; it: string }; question: { en: string; it: string } }

export const INTAKE: readonly IntakeItem[] = [
  { key: "subject", required: true, label: { en: "Subject", it: "Soggetto" },
    question: { en: "What is the video about, in one sentence?", it: "Di cosa parla il video, in una frase?" } },
  { key: "duration", required: true, label: { en: "Length", it: "Durata" },
    question: { en: "How long should it be? (15 seconds to 5 minutes)", it: "Quanto deve durare? (da 15 secondi a 5 minuti)" } },
  { key: "format", required: true, label: { en: "Format", it: "Formato" },
    question: { en: "Where is it for: YouTube (landscape, 16:9) or a Short / TikTok / Reel (vertical, 9:16)?", it: "Per dove è: YouTube (orizzontale, 16:9) o Short / TikTok / Reel (verticale, 9:16)?" } },
  { key: "look", required: true, label: { en: "Look", it: "Look" },
    question: { en: "How do you want it: realistic (filmed, cinematic photography) or animation (a 2D animated film)?", it: "Come lo vuoi: realistico (girato, fotografia cinematografica) o animazione (film animato 2D)?" } },
  { key: "audience", required: false, label: { en: "Audience", it: "Pubblico" },
    question: { en: "Who is it for?", it: "Per chi è?" } },
  { key: "tone", required: false, label: { en: "Tone", it: "Tono" },
    question: { en: "What tone should it have (serious, warm, playful, ominous…)?", it: "Che tono deve avere (serio, caldo, ironico, inquietante…)?" } },
  { key: "must_keep", required: false, label: { en: "Must appear", it: "Deve esserci" },
    question: { en: "Anything that must appear (names, numbers, places, a message), or that you do not want to see?", it: "C'è qualcosa che deve comparire per forza (nomi, numeri, luoghi, un messaggio) o che non vuoi vedere?" } },
];
export const REQUIRED_INTAKE: readonly IntakeKey[] = INTAKE.filter((i) => i.required).map((i) => i.key);

/** One line of the intake as it was read: the value and where it came from. */
export interface IntakeAnswer { value: string; from: "request" | "call" }

export interface AdaptiveBrief {
  subject: string;
  /** The look the request or the call names; null until it is answered (it is asked, never guessed). */
  look: Look | null;
  goal: string;
  duration_s: number | null;
  /** null until the request or the call says where the video goes. */
  format: Format | null;
  audience: string;
  tone: string;
  must_keep: string | null;
  language: "en" | "it";
  /** The intake as read: what was answered (and from where), what required item is missing, what optional one was not given. */
  intake: { answered: Partial<Record<IntakeKey, IntakeAnswer>>; missing: IntakeKey[]; optional: IntakeKey[] };
  /** The questions for the missing REQUIRED items, in the request's language. Empty means nothing blocks. */
  questions: string[];
  /** The questions for the optional items not given, in the request's language: asked together with the required ones. */
  optional_questions: string[];
  assumptions: string[];
}

const first = (value: string, max = 240) => value.trim().replace(/\s+/g, " ").slice(0, max);

function durationFrom(text: string): number | null {
  const t = text.toLowerCase();
  const minute = t.match(/(\d+(?:[.,]\d+)?)\s*(?:minutes?|minuti|minuto|min\b)/i);
  if (minute) return Math.round(Number(minute[1].replace(",", ".")) * 60);
  const second = t.match(/(\d+)\s*(?:seconds?|secondi|secondo|sec\b)/i);
  if (second) return Number(second[1]);
  return null;
}

/** Where the video goes, read off the words that say it; null when nothing does (then it is asked). */
const PORTRAIT_RE = /\b(9\s*:\s*16|vertical(?:e)?|portrait|verticale|shorts?|tiktok|reels?|stories|instagram)\b/i;
const LANDSCAPE_RE = /\b(16\s*:\s*9|youtube|landscape|orizzontale|widescreen|televisione|tv|schermo)\b/i;
function formatFrom(lower: string): Format | null {
  if (PORTRAIT_RE.test(lower)) return "9:16";
  if (LANDSCAPE_RE.test(lower)) return "16:9";
  return null;
}

/** The look, when the request names it: drawn words mean animation, filmed words mean realistic; otherwise null (asked). */
const ANIMATION_RE = /\b(anima(?:to|ta|zione)|animated|animation|cartoon|cartone|anime|disegnat[oa]|drawn|illustrat(?:ed|o|a)|pixar|ghibli)\b/i;
const REALISTIC_RE = /\b(realistic|realistico|realistica|filmed|girato|footage|documentary|documentario|photograph|fotograf|cinematografico|cinematic)/i;
function lookFrom(lower: string): Look | null {
  if (ANIMATION_RE.test(lower)) return "animation";
  if (REALISTIC_RE.test(lower)) return "realistic";
  return null;
}

/**
 * Italian when the request has more Italian-only words than English ones. It used to be one regular expression
 * that counted "video" as Italian, so "Create a video about accuracy in medicine" was answered in Italian and its
 * treatment would have been written in Italian (found by test/mcp-adapt.test.mjs). Words both languages share
 * ("video", "film") decide nothing.
 */
const IT_WORDS = /\b(il|lo|gli|le|un|una|uno|della|dello|degli|delle|che|crea|creami|fammi|voglio|vorrei|minuti|secondi|realistico|realistica|sulla|sul|sui|sugli|perch[eé]|storia|filmato|cortometraggio|racconta|spiega|documentario|cartone|animato|animazione)\b/gi;
const EN_WORDS = /\b(the|a|an|about|make|create|minutes?|seconds?|with|for|and|that|story|explain|tell|show|how|why|what|realistic|documentary|animated|cartoon)\b/gi;
function languageFrom(text: string): "en" | "it" {
  const it = (text.match(IT_WORDS) ?? []).length, en = (text.match(EN_WORDS) ?? []).length;
  return it > en ? "it" : "en";
}

export type AdaptOverrides = Partial<Pick<AdaptiveBrief, "duration_s" | "format" | "audience" | "tone" | "look" | "must_keep">>;

/**
 * Reads the request against the intake: every item is taken from the call first (the user's answers, passed back by
 * the assistant), then from the request's own words, and what is still missing becomes a question. Deterministic,
 * and it costs nothing: the questions come back before any model or GPU is touched.
 */
export function adaptPrompt(prompt: string, overrides: AdaptOverrides = {}): AdaptiveBrief {
  const text = first(prompt);
  const lower = text.toLowerCase();
  const language = languageFrom(text);
  const subject = first(text
    .replace(/\b(?:fammi|creami|crea|genera|make me|create|generate)\b/gi, "")
    .replace(/\b(?:un|una|a|an|the|il|la)\s+video\b/gi, "")
    .replace(/\b(?:realistico|realistica|realistic|cinematico|cinematic)\b/gi, ""));
  const fromRequestDuration = durationFrom(text);
  const duration_s = overrides.duration_s ?? fromRequestDuration;
  const fromRequestFormat = formatFrom(lower);
  const format = overrides.format ?? fromRequestFormat;
  const fromRequestLook = lookFrom(lower);
  const look = overrides.look ?? fromRequestLook;
  const audience = overrides.audience?.trim() || null;
  const tone = overrides.tone?.trim() || null;
  const must_keep = overrides.must_keep?.trim() || null;

  const answered: Partial<Record<IntakeKey, IntakeAnswer>> = {};
  if (subject.length >= 8) answered.subject = { value: subject, from: "request" };
  if (duration_s !== null && duration_s !== undefined) answered.duration = { value: `${duration_s}s`, from: overrides.duration_s !== undefined && overrides.duration_s !== null ? "call" : "request" };
  if (format) answered.format = { value: format, from: overrides.format ? "call" : "request" };
  if (look) answered.look = { value: look, from: overrides.look ? "call" : "request" };
  if (audience) answered.audience = { value: audience, from: "call" };
  if (tone) answered.tone = { value: tone, from: "call" };
  if (must_keep) answered.must_keep = { value: must_keep, from: "call" };
  const missing = INTAKE.filter((i) => i.required && !answered[i.key]).map((i) => i.key);
  const optional = INTAKE.filter((i) => !i.required && !answered[i.key]).map((i) => i.key);
  const questions = INTAKE.filter((i) => missing.includes(i.key)).map((i) => i.question[language]);
  const optional_questions = INTAKE.filter((i) => optional.includes(i.key)).map((i) => i.question[language]);

  const goal = /\b(spiega|explain|documentario|documentary|tutorial|how to|come funziona)\b/i.test(lower)
    ? (language === "it" ? "Spiegare il soggetto in modo chiaro e cinematografico" : "Explain the subject clearly and cinematically")
    : look === "animation" ? (language === "it" ? "Raccontare il soggetto come un film animato" : "Tell the subject as an animated film")
    : (language === "it" ? "Raccontare il soggetto come un film realistico" : "Tell the subject as a realistic film");
  const assumptions = [
    format === "16:9" ? `16:9 landscape: ${overrides.format ? "the user's answer" : "the request says where it goes"}` : format === "9:16" ? `9:16 portrait: ${overrides.format ? "the user's answer" : "the request says where it goes"}` : "format not said: asked, never assumed",
    look === "animation" ? `animation look: a 2D animated film, ${overrides.look ? "the user's answer" : "named by the request"}` : look === "realistic" ? `realistic cinematic look, ${overrides.look ? "the user's answer" : "named by the request"}` : "look not said: asked, never assumed",
    "no music, no burned-in subtitles, no slideshow fallback",
  ];
  return {
    subject, look, goal, duration_s: duration_s ?? null, format: format ?? null,
    audience: audience ?? "the audience implied by the request", tone: tone ?? "cinematic, naturalistic, emotionally coherent", must_keep,
    language, intake: { answered, missing, optional }, questions, optional_questions, assumptions,
  };
}

const lang = (b: AdaptiveBrief) => (b.language === "it" ? "Italian" : "English");

/** The intake as a checklist the assistant reads: every item, its value and its source, or the fact that it is missing. */
export function intakeText(brief: AdaptiveBrief): string {
  const rows = INTAKE.map((i) => {
    const a = brief.intake.answered[i.key];
    if (a) return `- ${i.label.en}: ${a.value} (${a.from === "call" ? "the user's answer" : "from the request"})`;
    return i.required ? `- ${i.label.en}: MISSING — ask` : `- ${i.label.en}: not given (optional)`;
  });
  return `INTAKE — what Kleo knows about this film, and what it must ask before anything is written. These are never guessed:\n${rows.join("\n")}`;
}

export function adaptivePromptText(brief: AdaptiveBrief): string {
  if (brief.questions.length) {
    const q = brief.questions.map((s, i) => `${i + 1}. ${s}`).join("\n");
    const opt = brief.optional_questions.length ? `\nOptional, in the SAME message if it feels natural (never a message of their own): ${brief.optional_questions.join(" · ")}` : "";
    return `${intakeText(brief)}\n\nASK THE USER NOW, in ONE message, in ${lang(brief)}, exactly these questions — then call kleo_adapt_prompt again with the same prompt and their answers (duration_s, format, style, audience, tone, must_keep). Do not write the treatment, do not call kleo_create_video, and do not fill any of these in yourself:\n${q}${opt}`;
  }
  const lookLine = brief.look === "animation" ? "animation, a 2D animated film" : "realistic cinematic";
  return `${intakeText(brief)}\n\nAdaptive film brief ready:\n- Subject: ${brief.subject}\n- Goal: ${brief.goal}\n- Duration: ${brief.duration_s}s\n- Format: ${brief.format}\n- Look: ${lookLine}\n- Audience: ${brief.audience}\n- Tone: ${brief.tone}${brief.must_keep ? `\n- Must appear: ${brief.must_keep}` : ""}\n- Audio: narration only; no music or burned-in subtitles\n- Plan: shot-by-shot real video clips, continuity checks, then edit.`;
}
