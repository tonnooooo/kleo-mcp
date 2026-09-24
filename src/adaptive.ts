/**
 * THE INTAKE. What Kleo must know about a film before anything is written, and what it asks when the request does
 * not say it. The owner's rule (14 September 2026): "se l'utente non scrive determinate cose, Kleo deve chiedere" —
 * a fixed list, read off the request first, then asked for, all at once, never invented.
 *
 * Six things are ALWAYS settled before a film is written and refuse to be guessed: the subject, the length, the
 * format, the look — a wrong length is the wrong price, a wrong format is a video that does not fit where it goes,
 * a wrong look is the wrong film — and, since 22 September 2026, MUSIC and SUBTITLES: both are options the user
 * decides, and "no" is an answer like any other, so the question is asked every time and the answer is honoured
 * every time (the owner: "li deve chiedere sempre"). Three things are optional (audience, tone, what must appear)
 * and are asked in the same message as the required ones, never on their own: a clear short request is not
 * interrogated.
 *
 * One more thing the same day: a user who says "stupiscimi" / "surprise me" is not refusing to give a subject, they
 * are delegating it. Kleo still never spends a credit on a subject nobody chose, but the answer to a delegation is
 * a short list of concrete subjects to pick from, not the same question a third time (the Grok chat of 22
 * September asked "di cosa deve parlare?" three times to a user who had said "stupiscimi tu" twice).
 */
import type { Format } from "./templates.ts";

export type Look = "realistic" | "animation";
export type IntakeKey = "subject" | "duration" | "format" | "look" | "music" | "subtitles" | "audience" | "tone" | "must_keep";
export interface IntakeItem { key: IntakeKey; required: boolean; label: { en: string; it: string }; question: { en: string; it: string } }

export const INTAKE: readonly IntakeItem[] = [
  { key: "subject", required: true, label: { en: "Subject", it: "Soggetto" },
    question: { en: "What is the video about, in one sentence?", it: "Di cosa parla il video, in una frase?" } },
  { key: "duration", required: true, label: { en: "Length", it: "Durata" },
    question: { en: "How long should it be? (15 seconds to 5 minutes for a film; an animatic is at most 60 seconds)", it: "Quanto deve durare? (da 15 secondi a 5 minuti per un film; un animatic dura al massimo 60 secondi)" } },
  { key: "format", required: true, label: { en: "Format", it: "Formato" },
    question: { en: "Where is it for: YouTube (landscape, 16:9) or a Short / TikTok / Reel (vertical, 9:16)?", it: "Per dove è: YouTube (orizzontale, 16:9) o Short / TikTok / Reel (verticale, 9:16)?" } },
  { key: "look", required: true, label: { en: "Look", it: "Look" },
    question: { en: "How do you want it: realistic (filmed, cinematic photography) or animation (a 2D animated film)?", it: "Come lo vuoi: realistico (girato, fotografia cinematografica) o animazione (film animato 2D)?" } },
  { key: "music", required: true, label: { en: "Music", it: "Musica" },
    question: { en: "Do you want music under the narration? If yes, what kind (a mood or a genre: quiet piano, tense electronic, warm strings…); if not, say no.", it: "Vuoi la musica sotto la voce? Se sì, di che tipo (un'atmosfera o un genere: pianoforte quieto, elettronica tesa, archi caldi…); se no, dì no." } },
  { key: "subtitles", required: true, label: { en: "Subtitles", it: "Sottotitoli" },
    question: { en: "Do you want subtitles burned into the video (yes or no)?", it: "Vuoi i sottotitoli impressi nel video (sì o no)?" } },
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

/** The music answer: wanted or not, and the words the user gave for it (a mood, a genre) when they gave any. */
export interface MusicAnswer { wanted: boolean; brief: string | null }

export interface AdaptiveBrief {
  subject: string;
  /** The look the request or the call names; null until it is answered (it is asked, never guessed). */
  look: Look | null;
  goal: string;
  duration_s: number | null;
  /** null until the request or the call says where the video goes. */
  format: Format | null;
  /** null until the user answered; then wanted or not, with their words for it. */
  music: MusicAnswer | null;
  /** null until the user answered; then burned-in cinema subtitles (true) or none (false). */
  subtitles: boolean | null;
  audience: string;
  tone: string;
  must_keep: string | null;
  language: "en" | "it";
  /** True when the request hands the subject to Kleo ("stupiscimi", "surprise me"): the answer is a list to pick from. */
  delegated: boolean;
  /** The intake as read: what was answered (and from where), what required item is missing, what optional one was not given. */
  intake: { answered: Partial<Record<IntakeKey, IntakeAnswer>>; missing: IntakeKey[]; optional: IntakeKey[] };
  /** The questions for the missing REQUIRED items, in the request's language. Empty means nothing blocks. */
  questions: string[];
  /** The questions for the optional items not given, in the request's language: asked together with the required ones. */
  optional_questions: string[];
  assumptions: string[];
}

const first = (value: string, max = 240) => value.trim().replace(/\s+/g, " ").slice(0, max);

/* ------------------------------------------------------------------ the length */

/**
 * THE LENGTH OF THE VIDEO, NOT THE TIME IN THE STORY (24 September 2026). The first number of minutes or seconds in a
 * request used to be the film's length, whatever it measured: "dopo 30 secondi la bomba esplode" made a 30-second film,
 * "ogni 5 minuti passa un treno" a five-minute one, and the price followed. A length is now read only where the words
 * say it is the VIDEO's: next to a video word ("video di 30 secondi", "a 30-second video", "2-minute film", "30 secondi
 * di video"), after a length word ("lungo 30 secondi", "durata: 1 minuto", "it should be 45 seconds", "30s"), or bare
 * ("…, 45 seconds") only when no story word is next to it ("dopo", "prima", "before", "after", "later", "ago", "fa",
 * "for the last", "ogni"…). When nothing qualifies the length is ASKED, which is what the intake does with any gap.
 */
const NUM_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, one: 1, a: 1, an: 1, due: 2, two: 2, tre: 3, three: 3, quattro: 4, four: 4, cinque: 5, five: 5,
  quindici: 15, fifteen: 15, venti: 20, twenty: 20, trenta: 30, thirty: 30, quaranta: 40, forty: 40, quarantacinque: 45,
  "forty-five": 45, cinquanta: 50, fifty: 50, sessanta: 60, sixty: 60, novanta: 90, ninety: 90,
};
const NUM_ALT = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).map((w) => w.replace(/[- ]/g, "[- ]")).join("|");
const MIN_UNIT = "minut[oi]|minutes?|mins?";
const SEC_UNIT = "second[oi]|seconds?|secs?";
const LEN_RE = new RegExp(`(?<![\\w.,'’])(\\d{1,4}(?:[.,]\\d+)?|(?:${NUM_ALT})(?![\\w]))\\s*-?\\s*(${MIN_UNIT}|${SEC_UNIT})\\b`, "gi");
/** "30s": seconds in the compact form, never a decade ("the 90s", "in her 30s", "'80s") — the guards are below. */
const COMPACT_RE = /(?<![\w'’.,])(\d{1,3})s\b/gi;
const HALF_MINUTE_RE = /\b(?:mezzo minuto|half a minute|half[- ]minute)\b/gi;
const VIDEO_WORDS = "videos?|film|short|clip|animatic|filmato|cortometraggio|corto|reel|spot|trailer|movie|documentario|documentary|animazione|animation|cartone(?: animato)?";
/** The words that may stand between a length and its video word: articles, "of", and what kind of video it is. */
const LEN_GLUE = "(?:of|di|de|del|dello|della|a|an|the|il|lo|un|uno|una|vertical[ei]?|horizontal|orizzontale|animated|animat[oa]|realistic|realistic[oa]|cinematic|cinematografico|youtube|long|lung[oaie]|narrated|narrato)";
/** The number measures the video: "30-second video", "2 minute animated film", "30 secondi di video". */
const VIDEO_AFTER_RE = new RegExp(`^\\s*-?\\s*(?:${LEN_GLUE}\\s+){0,2}(?:${VIDEO_WORDS})\\b`, "i");
/** "video di 30 secondi", "a film of 2 minutes", "clip: 30s", "Short (45 seconds", "video verticale di 30 secondi". */
const VIDEO_BEFORE_RE = new RegExp(`\\b(?:${VIDEO_WORDS})\\s*(?:${LEN_GLUE}\\s+)?(?:(?:of|di|da|lasting|lungo|lunga|long|that lasts|che dura|in|:|,|-|–|—|\\()\\s*)?(?:(?:about|circa|around|max|massimo|at most|al massimo)\\s+)?$`, "i");
/** "lungo 30 secondi", "durata: 1 minuto", "length 90 seconds", "it should be 45 seconds". */
const LENGTH_BEFORE_RE = /\b(?:lung[oaie]|long|lasting|durata(?: di)?|duration|length|lunghezza|runtime|run time|deve durare|che duri|should (?:be|last)|must (?:be|last)|to last|da durare)\s*(?:[:=]\s*)?(?:(?:about|circa|around|di|of|max|massimo|esattamente|exactly)\s+)?$/i;
/** Story time: a number that measures something IN the film ("dopo 30 secondi", "for the last 20 minutes"). */
const STORY_BEFORE_RE = /\b(?:dopo|after|before|prima(?: di)?|every|ogni|each|for the (?:last|next|first)|negli ultimi|nei primi|nei prossimi|in the (?:last|first|next)|within|since|da|tra|fra|until|fino a|waited|aspett\w*|wait|lasted|took|ci mis[eo]|ci vollero|impieg\w*|for|per|another|altri|last|ultimi|next|prossimi)\s+(?:(?:the|i|gli|le|about|circa|almost|quasi|over|oltre|nearly|some|qualche)\s+)?$/i;
const STORY_AFTER_RE = /^\s*(?:later|ago|earlier|after(?:wards)?|before|dopo|prima|fa\b|più tardi|piu tardi|of silence|di silenzio|of (?:his|her|their|my|our|your)\b|passed|pass\b|went by|go by|passano|passarono|passati|to (?:go|live|midnight|spare)\b|of fame|di fama|remaining|rimast\w*|left\b|away|di distanza|from (?:here|home|the)\b|da (?:qui|casa)\b)/i;
/** What stands before a decade: "the 90s", "in her 30s", "early 20s", "anni 80". */
const DECADE_BEFORE_RE = /\b(?:the|his|her|their|my|your|our|its|early|late|mid|anni|years|gli|negli|nei)\s*$/i;

interface LenHit { at: number; end: number; seconds: number }

/** Every "number + unit" in the text, as seconds, with where it sits. "1 minuto e 30 secondi" is one hit of 90. */
function lengthHits(t: string): LenHit[] {
  const hits: LenHit[] = [];
  for (const m of t.matchAll(LEN_RE)) {
    const rawN = m[1].toLowerCase();
    const word: number | undefined = NUM_WORDS[rawN.replace(/[-\s]+/g, "-")];
    const n = word ?? Number(rawN.replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) continue;
    const isMin = new RegExp(`^(?:${MIN_UNIT})$`, "i").test(m[2]);
    // "un secondo" / "a second" is "a moment", never a length; a spelled number of seconds is fifteen or more.
    if (!isMin && word !== undefined && n < 15) continue;
    let seconds = Math.round(isMin ? n * 60 : n);
    let end = (m.index ?? 0) + m[0].length;
    if (isMin) {
      const rest = t.slice(end);
      const half = rest.match(/^\s*(?:e|and)\s+(?:mezzo|a half)\b/i);
      const secs = rest.match(new RegExp(`^\\s*(?:e|and|,)?\\s*(\\d{1,2})\\s*(?:${SEC_UNIT})\\b`, "i"));
      if (half) { seconds += 30; end += half[0].length; }
      else if (secs) { seconds += Number(secs[1]); end += secs[0].length; }
    }
    hits.push({ at: m.index ?? 0, end, seconds });
  }
  for (const m of t.matchAll(HALF_MINUTE_RE)) hits.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, seconds: 30 });
  for (const m of t.matchAll(COMPACT_RE)) {
    const at = m.index ?? 0, n = Number(m[1]);
    if (n < 5 || n > 600 || DECADE_BEFORE_RE.test(t.slice(Math.max(0, at - 12), at))) continue;
    hits.push({ at, end: at + m[0].length, seconds: n });
  }
  hits.sort((a, b) => a.at - b.at);
  // A seconds part folded into the minutes before it is not a hit of its own.
  return hits.filter((h, i) => !hits.slice(0, i).some((p) => h.at >= p.at && h.at < p.end));
}

function durationFrom(text: string): number | null {
  const t = text.toLowerCase();
  let bare: number | null = null;
  for (const h of lengthHits(t)) {
    const before = t.slice(Math.max(0, h.at - 48), h.at);
    const after = t.slice(h.end, h.end + 48);
    // Said to be the video's length: taken at once, whatever else the request measures.
    if (VIDEO_AFTER_RE.test(after) || VIDEO_BEFORE_RE.test(before) || LENGTH_BEFORE_RE.test(before)) return h.seconds;
    // Time inside the story: never the length.
    if (STORY_BEFORE_RE.test(before) || STORY_AFTER_RE.test(after)) continue;
    if (bare === null) bare = h.seconds;
  }
  return bare;
}

/* ------------------------------------------------------------------ the frame */

/**
 * Where the video goes, read off the words that say it; null when nothing does (then it is asked). "Shorts", "reels",
 * "stories" and "Instagram" count only as PLATFORM words (24 September 2026): "bedtime stories" is a genre, "a short
 * film" is an adjective, "a man in shorts" is clothing and "a video about Instagram" is a topic — each used to turn a
 * YouTube film vertical. They count as "YouTube Shorts", "a Short", "for Shorts", "Instagram Reel", "un reel", "for my
 * stories", "for Instagram".
 */
const NOT_A_SHORT = "(?:film|films|video|videos|movie|story|stories|clip|documentar\\w*|animat\\w*|cartoon|piece|explainer|explanation|intro(?:duction)?|guide|tale|essay|history|sequence|scene|version|poem|text|summary|overview|storia|racconto|filmato|spot|ad|advert\\w*|commercial|trailer|answer|note|list|while|time|walk|distance|break|trip|drive|term|cut|circuit|supply|notice)";
const PORTRAIT_RE = new RegExp([
  "\\b9\\s*:\\s*16\\b", "\\bvertical[ei]?\\b", "\\bportrait\\b", "\\btik\\s?tok\\b",
  "\\b(?:youtube|yt)\\s+shorts?\\b",
  `\\b(?:a|an|the|my|our|this|one|un|uno|lo|questo|nuovo|new)\\s+short\\b(?!\\s*-)(?!\\s+${NOT_A_SHORT}\\b)`,
  "\\b(?:for|per|as|come|on|su|sui|sugli|negli|nei|gli)\\s+(?:(?:the|my|our|youtube|i|gli|miei|nostri)\\s+)?shorts\\b",
  "\\bshorts?\\s+(?:format|formato|verticale?|vertical)\\b",
  "\\b(?:instagram|ig|facebook|fb)\\s+(?:reels?|stor(?:y|ies))\\b",
  "\\b(?:a|an|the|un|uno|il|lo|my|our|for|per|as|come|i|gli|nei|in)\\s+reels?\\b(?!\\s+(?:of|di)\\b)",
  "\\b(?:for|per|on|su|sul|to|in)\\s+(?:(?:my|our|the|mio|nostro|il)\\s+)?instagram\\b",
  "\\b(?:for|per|on|in|nelle|sulle|nei|alle)\\s+(?:(?:my|our|le mie|mie|le)\\s+)?stories\\b",
].join("|"), "i");
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
 * The look a request's own words name, or null. Exported for createJob (src/jobs.ts): a job created with no style,
 * no treatment and no storyboard used to be realistic whatever it said, so "un cartone animato sui pirati" sent
 * straight to kleo_create_video became a live-action film (24 September 2026). Now the request is read first, and
 * realistic is only what nothing names.
 */
export const lookFromText = (text: string): Look | null => lookFrom(text.toLowerCase());

/**
 * Music and subtitles, when the request itself says so. "senza musica" / "no music" is an answer (no), "con musica"
 * / "with music" is an answer (yes, no brief yet); anything the request does not say is asked. The negative is read
 * first so "no music, with subtitles" does not read "music" as a yes.
 */
const MUSIC_NO_RE = /\b(senza (?:la )?musica|niente musica|nessuna musica|no music|without music|music[- ]?free|solo (?:la )?voce|voice[- ]only|narration only)\b/i;
const MUSIC_YES_RE = /\b(con (?:la |una )?musica|musica di sottofondo|colonna sonora|with (?:a )?(?:music|soundtrack|score)|background music|soundtrack|(?:a )?musical bed)\b/i;
const SUBS_NO_RE = /\b(senza (?:i )?sottotitoli|niente sottotitoli|nessun sottotitolo|no subtitles|without subtitles|no captions|without captions)\b/i;
const SUBS_YES_RE = /\b(con (?:i )?sottotitoli|sottotitolat[oaie]|sottotitoli|with (?:the )?subtitles|subtitled|with captions|burned[- ]in captions|captions on)\b/i;
function musicFrom(text: string): MusicAnswer | null {
  if (MUSIC_NO_RE.test(text)) return { wanted: false, brief: null };
  if (MUSIC_YES_RE.test(text)) return { wanted: true, brief: null };
  return null;
}
function subtitlesFrom(text: string): boolean | null {
  if (SUBS_NO_RE.test(text)) return false;
  if (SUBS_YES_RE.test(text)) return true;
  return null;
}

/** The words that mean "no" to the music question, in every spelling an assistant passes them back. */
const NO_WORDS = /^\s*(no|none|nope|nessuna|nessuno|niente|senza|not?\s+music|no\s+music|senza\s+musica|niente\s+musica|off|false|0)\s*\.?\s*$/i;
const YES_WORDS = /^\s*(yes|y|s[iì]|ok|okay|sure|certo|va bene|with music|con musica|true|1)\s*\.?\s*$/i;
/**
 * The music answer as the call passes it: a "no" in any spelling means none; a bare "yes" means music with no brief
 * yet (the treatment writes one); anything else is the brief itself (a mood, a genre, an instrument).
 */
export function musicAnswer(raw: string | null | undefined): MusicAnswer | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (NO_WORDS.test(s)) return { wanted: false, brief: null };
  if (YES_WORDS.test(s)) return { wanted: true, brief: null };
  return { wanted: true, brief: s.slice(0, 200) };
}
/** The subtitles answer as the call passes it: a boolean, or yes/no in words. */
export function subtitlesAnswer(raw: boolean | string | null | undefined): boolean | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim();
  if (!s) return null;
  if (NO_WORDS.test(s)) return false;
  if (YES_WORDS.test(s) || /^\s*(cinema|burned[- ]?in|impressi|sottotitoli|subtitles)\s*$/i.test(s)) return true;
  return null;
}

/**
 * "Stupiscimi": the user hands Kleo the subject. Kleo does not take it (the credit is theirs), but it does not send
 * the same question back either: it proposes. The phrase is also taken OUT of the subject before the subject is
 * measured, so "stupiscimi tu" is not mistaken for a subject of thirteen characters.
 */
const DELEGATE_RE = /\b(stupiscimi|stupiscimi tu|sorprendimi|scegli tu|decidi tu|fai tu|inventa tu|a tua scelta|come vuoi tu|surprise me|you (?:choose|pick|decide)|your (?:choice|call|pick)|dealer'?s choice|anything you (?:like|want)|whatever you (?:like|want|think))\b/gi;

/**
 * Italian when the request has more Italian-only words than English ones. It used to be one regular expression
 * that counted "video" as Italian, so "Create a video about accuracy in medicine" was answered in Italian and its
 * treatment would have been written in Italian (found by test/mcp-adapt.test.mjs). Words both languages share
 * ("video", "film") decide nothing.
 */
const IT_WORDS = /\b(il|lo|gli|le|un|una|uno|della|dello|degli|delle|che|crea|creami|fammi|voglio|vorrei|minuti|secondi|realistico|realistica|sulla|sul|sui|sugli|perch[eé]|storia|filmato|cortometraggio|racconta|spiega|documentario|cartone|animato|animazione|stupiscimi|sorprendimi|musica|sottotitoli)\b/gi;
const EN_WORDS = /\b(the|a|an|about|make|create|minutes?|seconds?|with|for|and|that|story|explain|tell|show|how|why|what|realistic|documentary|animated|cartoon|surprise|music|subtitles)\b/gi;
function languageFrom(text: string): "en" | "it" {
  const it = (text.match(IT_WORDS) ?? []).length, en = (text.match(EN_WORDS) ?? []).length;
  return it > en ? "it" : "en";
}

export type AdaptOverrides = Partial<Pick<AdaptiveBrief, "duration_s" | "format" | "audience" | "tone" | "look" | "must_keep">> & {
  /** The user's music answer, as they said it: "no", "yes", or the kind they want. */
  music?: string | null;
  /** The user's subtitles answer: true/false, or yes/no in words. */
  subtitles?: boolean | string | null;
};

/**
 * Reads the request against the intake: every item is taken from the call first (the user's answers, passed back by
 * the assistant), then from the request's own words, and what is still missing becomes a question. Deterministic,
 * and it costs nothing: the questions come back before any model or GPU is touched.
 */
export function adaptPrompt(prompt: string, overrides: AdaptOverrides = {}): AdaptiveBrief {
  // THE WHOLE REQUEST IS READ (24 September 2026). Detection used to run on the first 240 characters only, so a user
  // who told her story first and said "vertical, 30 seconds, no music" at the end was asked all three again — and a
  // look named in the last line was never seen. Only the SUBJECT stays capped: it is a label, not the request.
  const text = prompt.trim().replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  const language = languageFrom(text);
  const delegated = DELEGATE_RE.test(text);
  DELEGATE_RE.lastIndex = 0;
  const subject = first(text
    .replace(DELEGATE_RE, "")
    .replace(/\b(?:fammi|creami|crea|genera|make me|create|generate)\b/gi, "")
    .replace(/\b(?:un|una|a|an|the|il|la)\s+video\b/gi, "")
    .replace(/\b(?:realistico|realistica|realistic|cinematico|cinematic)\b/gi, "")
    .replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, ""));
  const fromRequestDuration = durationFrom(text);
  const duration_s = overrides.duration_s ?? fromRequestDuration;
  const fromRequestFormat = formatFrom(lower);
  const format = overrides.format ?? fromRequestFormat;
  const fromRequestLook = lookFrom(lower);
  const look = overrides.look ?? fromRequestLook;
  const callMusic = musicAnswer(overrides.music);
  const music = callMusic ?? musicFrom(text);
  const callSubs = subtitlesAnswer(overrides.subtitles);
  const subtitles = callSubs ?? subtitlesFrom(text);
  const audience = overrides.audience?.trim() || null;
  const tone = overrides.tone?.trim() || null;
  const must_keep = overrides.must_keep?.trim() || null;

  const answered: Partial<Record<IntakeKey, IntakeAnswer>> = {};
  if (subject.length >= 8) answered.subject = { value: subject, from: "request" };
  if (duration_s !== null && duration_s !== undefined) answered.duration = { value: `${duration_s}s`, from: overrides.duration_s !== undefined && overrides.duration_s !== null ? "call" : "request" };
  if (format) answered.format = { value: format, from: overrides.format ? "call" : "request" };
  if (look) answered.look = { value: look, from: overrides.look ? "call" : "request" };
  if (music) answered.music = { value: music.wanted ? (music.brief ? `yes — ${music.brief}` : "yes") : "none", from: callMusic ? "call" : "request" };
  if (subtitles !== null) answered.subtitles = { value: subtitles ? "cinema (burned in)" : "none", from: callSubs !== null ? "call" : "request" };
  if (audience) answered.audience = { value: audience, from: "call" };
  if (tone) answered.tone = { value: tone, from: "call" };
  if (must_keep) answered.must_keep = { value: must_keep, from: "call" };
  const missing = INTAKE.filter((i) => i.required && !answered[i.key]).map((i) => i.key);
  const optional = INTAKE.filter((i) => !i.required && !answered[i.key]).map((i) => i.key);
  const questions = INTAKE.filter((i) => missing.includes(i.key)).map((i) =>
    i.key === "subject" && delegated
      ? (language === "it"
        ? "L'utente ti ha chiesto di scegliere tu il soggetto (\"stupiscimi\"): non rifare la stessa domanda. Proponi 3-5 soggetti concreti e filmabili a misura d'uomo, una riga ciascuno, nello stesso messaggio, e chiedi di sceglierne uno (o di scriverne uno loro). Non si rende nulla finché non hanno scelto."
        : "The user asked YOU to choose the subject (\"surprise me\"): do not send the same question back. Propose 3-5 concrete, filmable, human-scale subjects, one line each, in the same message, and ask them to pick one (or write their own). Nothing is rendered until they have picked.")
      : i.question[language]);
  const optional_questions = INTAKE.filter((i) => optional.includes(i.key)).map((i) => i.question[language]);

  const goal = /\b(spiega|explain|documentario|documentary|tutorial|how to|come funziona)\b/i.test(lower)
    ? (language === "it" ? "Spiegare il soggetto in modo chiaro e cinematografico" : "Explain the subject clearly and cinematically")
    : look === "animation" ? (language === "it" ? "Raccontare il soggetto come un film animato" : "Tell the subject as an animated film")
    : (language === "it" ? "Raccontare il soggetto come un film realistico" : "Tell the subject as a realistic film");
  const assumptions = [
    format === "16:9" ? `16:9 landscape: ${overrides.format ? "the user's answer" : "the request says where it goes"}` : format === "9:16" ? `9:16 portrait: ${overrides.format ? "the user's answer" : "the request says where it goes"}` : "format not said: asked, never assumed",
    look === "animation" ? `animation look: a 2D animated film, ${overrides.look ? "the user's answer" : "named by the request"}` : look === "realistic" ? `realistic cinematic look, ${overrides.look ? "the user's answer" : "named by the request"}` : "look not said: asked, never assumed",
    music === null ? "music not said: asked, never assumed" : music.wanted ? `music: an instrumental track under the narration${music.brief ? ` (${music.brief})` : ""}, the user's answer` : "no music: narration only, the user's answer",
    subtitles === null ? "subtitles not said: asked, never assumed" : subtitles ? "subtitles: thin cinema subtitles burned in, the user's answer" : "no burned-in subtitles (an .srt sidecar is always delivered), the user's answer",
    "no slideshow fallback",
  ];
  return {
    subject, look, goal, duration_s: duration_s ?? null, format: format ?? null, music, subtitles,
    audience: audience ?? "the audience implied by the request", tone: tone ?? "cinematic, naturalistic, emotionally coherent", must_keep,
    language, delegated, intake: { answered, missing, optional }, questions, optional_questions, assumptions,
  };
}

const lang = (b: AdaptiveBrief) => (b.language === "it" ? "Italian" : "English");

/** The intake as a checklist the assistant reads: every item, its value and its source, or the fact that it is missing. */
export function intakeText(brief: AdaptiveBrief): string {
  const rows = INTAKE.map((i) => {
    const a = brief.intake.answered[i.key];
    if (a) return `- ${i.label.en}: ${a.value} (${a.from === "call" ? "the user's answer" : "from the request"})`;
    if (i.key === "subject" && brief.delegated) return `- ${i.label.en}: MISSING — the user delegated it ("surprise me"): propose 3-5 subjects and let them pick`;
    return i.required ? `- ${i.label.en}: MISSING — ask` : `- ${i.label.en}: not given (optional)`;
  });
  return `INTAKE — what Kleo knows about this film, and what it must ask before anything is written. These are never guessed:\n${rows.join("\n")}`;
}

/** The two options as one line each, for the brief and for the treatment's method. */
export function musicLine(m: MusicAnswer | null): string {
  if (!m) return "not decided yet";
  if (!m.wanted) return "none — narration only";
  return `yes — an instrumental track under the narration, ducked under the voice${m.brief ? `; the user asked for: ${m.brief}` : "; the user named no kind: the treatment chooses one that fits the film"}`;
}
export const subtitlesLine = (s: boolean | null): string => (s === null ? "not decided yet" : s ? "cinema — thin white lowercase subtitles burned in (plus the .srt sidecar)" : "none burned in (the .srt sidecar is still delivered)");

export function adaptivePromptText(brief: AdaptiveBrief): string {
  if (brief.questions.length) {
    const q = brief.questions.map((s, i) => `${i + 1}. ${s}`).join("\n");
    const opt = brief.optional_questions.length ? `\nOptional, in the SAME message if it feels natural (never a message of their own): ${brief.optional_questions.join(" · ")}` : "";
    return `${intakeText(brief)}\n\nASK THE USER NOW, in ONE message, in ${lang(brief)}, exactly these questions — then call kleo_adapt_prompt again with the same prompt and their answers (duration_s, format, style, music, subtitles, audience, tone, must_keep). Do not write the treatment, do not call kleo_create_video, and do not fill any of these in yourself:\n${q}${opt}`;
  }
  const lookLine = brief.look === "animation" ? "animation, a 2D animated film" : "realistic cinematic";
  return `${intakeText(brief)}\n\nAdaptive film brief ready:\n- Subject: ${brief.subject}\n- Goal: ${brief.goal}\n- Duration: ${brief.duration_s}s\n- Format: ${brief.format}\n- Look: ${lookLine}\n- Audience: ${brief.audience}\n- Tone: ${brief.tone}${brief.must_keep ? `\n- Must appear: ${brief.must_keep}` : ""}\n- Music: ${musicLine(brief.music)}\n- Subtitles: ${subtitlesLine(brief.subtitles)}\n- Plan: shot-by-shot real video clips, continuity checks, one clean dissolve between acts (one per 25 seconds, never inside an act), then edit.`;
}
