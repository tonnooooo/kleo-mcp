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

/** The sentence a person reads when a seat's photo shows no person. */
export const noPersonText = (template: string, seat: string): string =>
  `${template} swaps people: ${seat} needs a clear photo of a real person. Cartoon characters, toys, animals and objects can't be swapped in — nothing was charged.`;
