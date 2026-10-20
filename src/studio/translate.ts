/**
 * ANY LANGUAGE IN, ENGLISH TO THE MODEL (15 October 2026, the owner: "se scrivo in italiano, in russo, in francese …
 * il prompt lo produce tranquillamente"). The chat agent and Enhance already write English; a prompt typed straight into
 * the Video page, the Image page or an app went to the model as it was, and Seedance, Seedream and Veo follow English
 * (and Chinese) far better than Italian or Russian. So a prompt that is not English is translated first, by the same
 * small fast model as Enhance (about a second, a fraction of a cent): the meaning kept word for word, words in quotes
 * (what someone says, text on screen) left in their own language, so a character still speaks Italian. The person's own
 * words stay on their card; only the model reads the English. English goes straight through with no call at all, and
 * a translation that fails sends the original: a slow translator never costs anybody their video.
 */
import type { StudioEnv } from "./env.ts";
import { ephone } from "../ephone.ts";

const CHAT_ROUTING = { "X-Provider-Order": "official_cheap,official", "X-Provider-Only": "true" };

const EN = new Set(("the a an and or of in on at to with without from into onto over under through across toward towards by for is are was were be " +
  "his her its their our your my this that these those it he she they we you who which while as then slowly quickly camera shot close up " +
  "wide light lights sky street city man woman girl boy dog cat car walks runs looks stands sits holding wearing behind front above below").split(" "));
const OTHER = new Set(("il lo la gli le un una uno di del della dello dei delle che e è con per nel nella sul sulla tra fra mentre sono " +
  "el los las y del que en por con una unos unas es está mientras muy " +
  "une des du le les et avec dans sur est sont pendant très au aux " +
  "der die das und mit ein eine einen im auf ist sind während sehr nicht " +
  "o os as um uma com para não é está muito do da dos das no na " +
  "een het de en met op is zijn van niet").split(" "));

/** True when the text reads as English (or has no words to judge): no call needed. */
export function looksEnglish(text: string): boolean {
  const t = text.replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, " "); // quoted words may be in any language on purpose
  if (/[Ѐ-ӿͰ-Ͽ֐-ۿऀ-෿฀-๿぀-ヿ㐀-鿿가-힯]/.test(t)) return false;
  const words = t.toLowerCase().match(/[a-zà-ÿ']+/g) ?? [];
  if (!words.length) return true;
  let en = 0, other = 0;
  for (const w of words) { if (EN.has(w)) en++; else if (OTHER.has(w)) other++; }
  const accents = (t.match(/[àèéìòùáíóúñçâêîôûäöüßãõ]/gi) ?? []).length;
  // Not one English function word ("gatto nero", "chat noir") is not proof of English: those get translated too.
  return en > 0 && en >= other + Math.min(3, accents);
}

const WHAT: Record<"video" | "image" | "edit" | "sound", string> = {
  video: "an AI video model", image: "an AI image model", edit: "an AI video editing model", sound: "an AI sound effects model",
};

/** The prompt in English for the model, or the prompt itself when it already is (or the translation failed). */
export async function toEnglish(env: StudioEnv, text: string, what: keyof typeof WHAT): Promise<string> {
  const src = text.trim();
  if (!src || looksEnglish(src)) return text;
  try {
    const r = await ephone<{ choices?: { message?: { content?: unknown } }[] }>(env, "POST", "/v1/chat/completions", {
      model: (env.STUDIO_ENHANCE_MODEL ?? "").trim() || "gpt-4.1-mini",
      max_tokens: Math.min(1500, 60 + Math.ceil(src.length / 2)),
      messages: [
        { role: "system", content: `Translate the user's prompt for ${WHAT[what]} into natural English. Keep the meaning exactly: every subject, name, number, colour, object, action, camera and style word, in the same order. Add nothing and drop nothing. Words inside quotes (what someone says, text that must appear) stay exactly as written, in their own language. Answer with the translation only.` },
        { role: "user", content: src.slice(0, 4000) },
      ],
    }, { timeoutMs: 8_000, routing: CHAT_ROUTING });
    const out = r.choices?.[0]?.message?.content;
    const said = (typeof out === "string" ? out : "").trim();
    return said.length >= 3 ? said.slice(0, 4000) : text;
  } catch {
    return text;
  }
}

/**
 * NAMES A MODEL'S MAKER REFUSES (21 October 2026, the owner: "cerca di diminuire i problemi" with copyright). Seedance
 * refuses well-known characters, franchises, brands and famous people only after the order went out, so the person
 * waited for a failed card. The same small model now reads the prompt first and lists the names it finds; Studio then
 * asks (or, with the automatic switch on, goes) to Wan 3.0 before anything is made. Null when the check could not run:
 * the order then goes on as before, so a slow checker never costs anybody their video.
 */
export const NAMES_RULES = `You check prompts for an AI video model whose maker refuses copyrighted material. List every specific copyrighted fictional character, franchise (film, series, cartoon, anime, game, band, song), brand or logo, and real famous person that the prompt NAMES, exactly as written. Generic words (a superhero, a princess, a robot, a pop star) and invented names do not count. Answer with JSON only: {"names": ["..."]}, with an empty list when there are none.`;
export async function namedCharacters(env: StudioEnv, text: string): Promise<string[] | null> {
  const src = text.trim();
  if (!src) return [];
  try {
    const r = await ephone<{ choices?: { message?: { content?: unknown } }[] }>(env, "POST", "/v1/chat/completions", {
      model: (env.STUDIO_ENHANCE_MODEL ?? "").trim() || "gpt-4.1-mini",
      max_tokens: 150,
      messages: [{ role: "system", content: NAMES_RULES }, { role: "user", content: src.slice(0, 3000) }],
    }, { timeoutMs: 6_000, routing: CHAT_ROUTING });
    return parseNames(r.choices?.[0]?.message?.content);
  } catch {
    return null;
  }
}
/** The names in the checker's answer (JSON, perhaps inside prose or a code block); null when it cannot be read. */
export function parseNames(out: unknown): string[] | null {
  const m = /\{[\s\S]*\}/.exec(typeof out === "string" ? out : "");
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { names?: unknown };
    if (!Array.isArray(v.names)) return null;
    return [...new Set(v.names.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x.length > 1 && x.length <= 60))].slice(0, 8);
  } catch {
    return null;
  }
}

/**
 * A prompt with its names turned into descriptions (21 October 2026): the last try once Wan 3.0 or FLUX 3 refused a
 * well-known character too. Every named character, franchise, brand or famous person becomes how they look (build,
 * face, hair, clothes, colours, art style), with no names, titles or logos; everything else stays. English. Null when
 * the rewrite failed.
 */
export const DESCRIBE_RULES = (what: string) => `Rewrite the user's prompt for ${what} so that it names no copyrighted character, franchise, brand, logo or famous person. Replace each of them with a vivid visual description of how they look: build, age, face, hair, clothes and their colours, accessories, art style. Keep everything else exactly: the actions, the setting, the camera, the mood, the light, the sound, and any words in quotes. No names, no titles, no logos. Write in English. Answer with the new prompt only.`;
export async function describeWithoutNames(env: StudioEnv, text: string, what: "video" | "image"): Promise<string | null> {
  const src = text.trim();
  if (!src) return null;
  try {
    const r = await ephone<{ choices?: { message?: { content?: unknown } }[] }>(env, "POST", "/v1/chat/completions", {
      model: (env.STUDIO_ENHANCE_MODEL ?? "").trim() || "gpt-4.1-mini",
      max_tokens: Math.min(1500, 250 + Math.ceil(src.length / 2)),
      messages: [{ role: "system", content: DESCRIBE_RULES(WHAT[what]) }, { role: "user", content: src.slice(0, 4000) }],
    }, { timeoutMs: 12_000, routing: CHAT_ROUTING });
    const out = r.choices?.[0]?.message?.content;
    const said = (typeof out === "string" ? out : "").trim().replace(/^["“]|["”]$/g, "");
    return said.length >= 10 ? said.slice(0, 4000) : null;
  } catch {
    return null;
  }
}
