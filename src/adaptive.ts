import type { Format } from "./templates.ts";

export interface AdaptiveBrief {
  subject: string;
  /** The look the request names, or null when the treatment decides (step 0 of the method). */
  look: "realistic" | "animation" | null;
  goal: string;
  duration_s: number | null;
  format: Format;
  audience: string;
  tone: string;
  language: "en" | "it";
  questions: string[];
  assumptions: string[];
}

const first = (value: string, max = 240) => value.trim().replace(/\s+/g, " ").slice(0, max);

function durationFrom(text: string): number | null {
  const t = text.toLowerCase();
  const minute = t.match(/(\d+(?:[.,]\d+)?)\s*(?:minutes?|minuti|min\b)/i);
  if (minute) return Math.round(Number(minute[1].replace(",", ".")) * 60);
  const second = t.match(/(\d+)\s*(?:seconds?|secondi|sec\b)/i);
  if (second) return Number(second[1]);
  return null;
}

/**
 * Italian when the request has more Italian-only words than English ones. It used to be one regular expression
 * that counted "video" as Italian, so "Create a video about accuracy in medicine" was answered in Italian and its
 * treatment would have been written in Italian (found by test/mcp-adapt.test.mjs). Words both languages share
 * ("video", "film") decide nothing.
 */
const IT_WORDS = /\b(il|lo|gli|le|un|una|uno|della|dello|degli|delle|che|crea|creami|fammi|voglio|vorrei|minuti|secondi|realistico|realistica|sulla|sul|sui|sugli|perch[eé]|storia|filmato|cortometraggio|racconta|spiega|documentario)\b/gi;
const EN_WORDS = /\b(the|a|an|about|make|create|minutes?|seconds?|with|for|and|that|story|explain|tell|show|how|why|what|realistic|documentary)\b/gi;
function languageFrom(text: string): "en" | "it" {
  const it = (text.match(IT_WORDS) ?? []).length, en = (text.match(EN_WORDS) ?? []).length;
  return it > en ? "it" : "en";
}

/**
 * Turns a short request into an explicit film brief without choosing a subject for the user.
 * This is intentionally deterministic: the MCP can ask for missing production decisions before any AI/GPU cost.
 */
export function adaptPrompt(prompt: string, overrides: Partial<Pick<AdaptiveBrief, "duration_s" | "format" | "audience" | "tone" | "look">> = {}): AdaptiveBrief {
  const text = first(prompt);
  const lower = text.toLowerCase();
  const language = languageFrom(text);
  const duration_s = overrides.duration_s ?? durationFrom(text);
  const format: Format = overrides.format ?? (/\b(9\s*:\s*16|vertical|portrait|shorts?|tiktok|reels?)\b/i.test(lower) ? "9:16" : "16:9");
  const subject = first(text
    .replace(/\b(?:fammi|creami|crea|genera|make me|create|generate)\b/gi, "")
    .replace(/\b(?:un|una|a|an|the|il|la)\s+video\b/gi, "")
    .replace(/\b(?:realistico|realistica|realistic|cinematico|cinematic)\b/gi, ""));
  // The look, when the request names it: drawn words mean animation, filmed words mean realistic; otherwise the treatment decides.
  const look: AdaptiveBrief["look"] = overrides.look
    ?? (/\b(anima(?:to|ta|zione)|animated|animation|cartoon|cartone|anime|disegnat[oa]|drawn|illustrat(?:ed|o|a)|pixar|ghibli)\b/i.test(lower) ? "animation"
      : /\b(realistic|realistico|realistica|filmed|girato|footage|documentary|documentario|photograph|fotograf)/i.test(lower) ? "realistic" : null);
  const questions: string[] = [];
  if (subject.length < 8) questions.push(language === "it" ? "Qual è il soggetto preciso del film?" : "What is the precise subject of the film?");
  if (duration_s === null) questions.push(language === "it" ? "Quanto deve durare il video (secondi o minuti)?" : "How long should the video be (seconds or minutes)?");
  const goal = /\b(spiega|explain|documentario|documentary|tutorial|how to|come funziona)\b/i.test(lower)
    ? (language === "it" ? "Spiegare il soggetto in modo chiaro e cinematografico" : "Explain the subject clearly and cinematically")
    : look === "animation" ? (language === "it" ? "Raccontare il soggetto come un film animato" : "Tell the subject as an animated film")
    : (language === "it" ? "Raccontare il soggetto come un film realistico" : "Tell the subject as a realistic film");
  const assumptions = [
    format === "16:9" ? "16:9 landscape: inferred for YouTube/film delivery" : "9:16 portrait: inferred from the request",
    look === "animation" ? "animation look: a 2D animated film, named by the request" : look === "realistic" ? "realistic cinematic look, named by the request" : "look not named: the treatment decides between realistic and animation (step 0 of the method)",
    "no music, no burned-in subtitles, no slideshow fallback",
  ];
  return { subject, look, goal, duration_s, format, audience: overrides.audience ?? "the audience implied by the request", tone: overrides.tone ?? "cinematic, naturalistic, emotionally coherent", language, questions, assumptions };
}

export function adaptivePromptText(brief: AdaptiveBrief): string {
  if (brief.questions.length) return `Before I render anything, I need:\n- ${brief.questions.join("\n- ")}\n\nI will then build the shot list, continuity rules, cinematography and real video clips automatically.`;
  return `Adaptive film brief ready:\n- Subject: ${brief.subject}\n- Goal: ${brief.goal}\n- Duration: ${brief.duration_s}s\n- Format: ${brief.format}\n- Look: ${brief.look === "animation" ? "animation, a 2D animated film" : brief.look === "realistic" ? "realistic cinematic" : "decided by the treatment (realistic unless the request or the subject asks to be drawn)"}\n- Audio: narration only; no music or burned-in subtitles\n- Plan: shot-by-shot real video clips, continuity checks, then edit.`;
}
