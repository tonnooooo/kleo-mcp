/**
 * KLEO STUDIO — IS THERE A PERSON IN THIS PHOTO? (22 October 2026)
 *
 * The viral templates (src/studio/trends.ts) swap PEOPLE into a clip, and their instructions to Wan 3.0 ask for an exact
 * human likeness: face, skin, hair, five fingers. On 22 October the owner put a cartoon sausage into "Bby Wow": Wan 3.0
 * ran, was paid for, and gave back the same dancer as the original clip, because there was no person to put in.
 *
 * So before any charge each template photo is shown to a vision model on Workers AI (Llama 4 Scout), which answers
 * whether its main subject is a real human being. Workers Paid includes 10,000 neurons a day; one check is a small part
 * of that. A photo the model says shows no person is refused with a sentence the person can act on, and nothing is
 * charged. A check that cannot run (no binding, a picture too big to send, an error, an answer it cannot read) lets the
 * order go on as before: the check may only ever save a customer's credits, never block a good photo by accident.
 *
 * Pure parts (the question, the reading of the answer) are tested directly; the call is in generate.ts.
 */

export const PERSON_CHECK_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
/** Photos larger than this are not sent (the request would carry it base64 encoded): the order goes on unchecked. */
export const PERSON_CHECK_MAX_BYTES = 4_000_000;

export const PERSON_CHECK_QUESTION =
  "Look at this photo. Is its main subject a real human being (a photo of an actual person, any age, any pose, face or body visible)? "
  + "Answer no for cartoon or animated characters, illustrations, toys, figurines, statues, masks, animals, food, objects, logos, text or empty scenes. "
  + 'Answer with JSON only: {"person": true} or {"person": false}.';

/** The model's answer read as yes (true), no (false) or unreadable (null). */
export function readPersonAnswer(out: unknown): boolean | null {
  const text = typeof out === "string" ? out
    : out && typeof out === "object" && typeof (out as { response?: unknown }).response === "string" ? (out as { response: string }).response
      : out && typeof out === "object" && (out as { response?: unknown }).response && typeof (out as { response: unknown }).response === "object"
        ? JSON.stringify((out as { response: unknown }).response) : "";
  const m = /"person"\s*:\s*(true|false)/i.exec(text);
  if (m) return m[1].toLowerCase() === "true";
  const word = text.trim().toLowerCase();
  if (/^(yes|true)\b/.test(word)) return true;
  if (/^(no|false)\b/.test(word)) return false;
  return null;
}

/** The input of one check: the question and the photo as a data URL. */
export function personCheckInput(bytes: Uint8Array, contentType: string): Record<string, unknown> {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const type = /^image\/(png|jpeg|jpg|webp|gif)$/i.test(contentType) ? contentType.toLowerCase().replace("jpg", "jpeg") : "image/jpeg";
  return {
    messages: [{ role: "user", content: [
      { type: "text", text: PERSON_CHECK_QUESTION },
      { type: "image_url", image_url: { url: `data:${type};base64,${btoa(bin)}` } },
    ] }],
    max_tokens: 20,
  };
}

/**
 * PHOTO FACTS (23 October 2026). The same call now also says what kind of photo it is, because a template run came back
 * wrong on two black-and-white suit portraits, one of them a wide shot with the man small in the middle. The answer is
 * read as fixed words only (never the model's free text), so nothing it says can steer the edit instruction.
 */
export interface PhotoFacts {
  /** A real human being is the main subject (null: the model did not say). */
  person: boolean | null;
  people?: number;
  colour?: "colour" | "greyscale";
  framing?: "head" | "waist-up" | "knees-up" | "full-body";
  face?: "large" | "medium" | "small";
  hair?: "black" | "brown" | "blond" | "red" | "grey" | "white" | "bald" | "other";
  beard?: boolean;
  glasses?: boolean;
}

export const PHOTO_FACTS_QUESTION =
  "Look at this photo and answer with JSON only, no other words: "
  + '{"person": true|false, "people": number of people clearly visible, "colour": "colour"|"greyscale", "framing": "head"|"waist-up"|"knees-up"|"full-body", "face": "large"|"medium"|"small", "hair": "black"|"brown"|"blond"|"red"|"grey"|"white"|"bald"|"other", "beard": true|false, "glasses": true|false}. '
  + '"person" is true only if the main subject is a real human being (a photo of an actual person, any age, any pose). It is false for cartoon or animated characters, illustrations, toys, figurines, statues, masks, animals, food, objects, logos, text or empty scenes. '
  + '"colour" is "greyscale" for a black-and-white photo. "framing" is how much of the body of the main person the photo shows. "face" is how big the face of the main person is in the photo. '
  + "The other fields describe the main person. Never name anyone.";

const ONE_OF = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (typeof v === "string" && (allowed as readonly string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as T) : undefined);

/** The model's answer read as facts; only known words are kept. Null when not even "person" can be read. */
export function readPhotoFacts(out: unknown): PhotoFacts | null {
  const raw = out && typeof out === "object" && (out as { response?: unknown }).response && typeof (out as { response: unknown }).response === "object"
    ? (out as { response: Record<string, unknown> }).response : null;
  let o: Record<string, unknown> | null = raw;
  if (!o) {
    const text = typeof out === "string" ? out : out && typeof out === "object" && typeof (out as { response?: unknown }).response === "string" ? (out as { response: string }).response : "";
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) { try { o = JSON.parse(m[0]) as Record<string, unknown>; } catch { o = null; } }
  }
  const person = o && typeof o.person === "boolean" ? o.person : readPersonAnswer(out);
  if (person === null && !o) return null;
  const f: PhotoFacts = { person };
  if (!o) return f;
  if (typeof o.people === "number" && Number.isFinite(o.people)) f.people = Math.max(0, Math.min(50, Math.round(o.people)));
  const colour = ONE_OF(o.colour, ["colour", "color", "greyscale", "grayscale"] as const);
  if (colour) f.colour = colour === "color" ? "colour" : colour === "grayscale" ? "greyscale" : colour;
  const framing = ONE_OF(o.framing, ["head", "waist-up", "knees-up", "full-body"] as const);
  if (framing) f.framing = framing;
  const face = ONE_OF(o.face, ["large", "medium", "small"] as const);
  if (face) f.face = face;
  const hair = ONE_OF(o.hair, ["black", "brown", "blond", "red", "grey", "white", "bald", "other"] as const);
  if (hair) f.hair = hair;
  if (typeof o.beard === "boolean") f.beard = o.beard;
  if (typeof o.glasses === "boolean") f.glasses = o.glasses;
  return f;
}

/** The input of one facts check: the question and the photo as a data URL. */
export function photoFactsInput(bytes: Uint8Array, contentType: string): Record<string, unknown> {
  const input = personCheckInput(bytes, contentType) as { messages: { content: { type: string; text?: string }[] }[] };
  input.messages[0].content[0].text = PHOTO_FACTS_QUESTION;
  return { ...input, max_tokens: 120 };
}

/** The sentence a person reads when a seat's photo cannot be read back from storage. */
export const photoMissingText = (seat: string): string =>
  `${seat}'s photo could not be read. Add it again — nothing was charged.`;

/**
 * The sentence a person reads on a template that takes characters (Trend.characters) when a seat's photo looks like no
 * real person but the seat was not marked as a character: a misread or a forgotten choice is stopped before the charge.
 */
export const characterUnmarkedText = (seat: string): string =>
  `${seat}'s photo looks like a character, not a real person. If it is one, choose ${seat} under "Is anyone a character?" — nothing was charged.`;

/** The sentence a person reads when a seat's photo shows no person. */
export const noPersonText = (template: string, seat: string): string =>
  `${template} swaps people: ${seat} needs a clear photo of a real person. Cartoon characters, toys, animals and objects can't be swapped in — nothing was charged.`;
