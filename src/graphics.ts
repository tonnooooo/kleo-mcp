/**
 * THE LAYER: what is drawn OVER the film, decided per film and never by a template.
 *
 * On 13 September the realistic film lost every on-screen element at once — captions, chapter pills, karaoke,
 * music — because all of them came from the look, the same for every subject, and a pirate film wore the furniture
 * of a cybersecurity explainer. On 14 September the owner asked for the layer back, on one condition: that it adapts
 * to the prompt. So the layer is not a style. It is a small GRAMMAR of elements that mean something, and the
 * treatment decides, for this film, whether there is a layer at all, which elements it has, what each one means,
 * and what colour it is written in. "None" is a legal answer, and the usual one for a film that is a place or a face.
 *
 * The grammar, in full:
 *   - a LINE along one edge, whose STATE changes scene by scene: steady, pulse, square (a repeating 1 0 1 0),
 *     broken, flat, off. It carries one meaning through the film ("the health of the link", "her breathing").
 *   - a READOUT in one corner: one to four monospace rows, each a label and a value the scenes update
 *     ("EARTH 2023-11-14 · VOYAGER 2023-11-13 · ONE-WAY 22h 34m"). For the numbers the film is about.
 *   - a STAMP in one corner: one short line of tracked capitals the scenes may change (a place, a date, a time).
 *   - CARDS: a number or a date the viewer must READ, alone, centred, held for a moment on a dim; one per scene at
 *     most, cut on a spoken word like a shot.
 *   - SUBTITLES: none, or cinema (thin, white, lowercase, at most two short lines, no karaoke, no highlighted word).
 *   - CHAPTERS: none, or film (the scene's chapter in light tracked capitals behind a thin accent rule).
 *   - the ACCENT: the one ink of the layer, a hex colour the treatment takes from the film's own palette.
 * No icons, no cards with prose, no lower thirds, no logos, no music: what the grammar does not name does not exist.
 *
 * Three places read this file and nothing else: src/keou-contract.ts refuses a storyboard whose layer breaks the
 * grammar, src/storyboard.ts writes the layer from the treatment and repairs what the model returns per scene, and
 * worker/keou/engine/hud.js draws exactly these kinds and states. worker/keou/contract.py mirrors the checks.
 */

export const HUD_KINDS = ["line", "readout", "stamp"] as const;
export type HudKind = (typeof HUD_KINDS)[number];
export const LINE_STATES = ["steady", "pulse", "square", "broken", "flat", "off"] as const;
export type LineState = (typeof LINE_STATES)[number];
export const EDGES = ["bottom", "top"] as const;
export const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export const SUBTITLE_MODES = ["none", "cinema"] as const;
export const CHAPTER_MODES = ["none", "film"] as const;

/** Limits, in one table: the prompt prints them, the validator enforces them, the engine trusts them. */
export const GL = {
  hud: { max: 3 },
  id: 16,
  means: 60,
  rows: { min: 1, max: 4, len: 14 },
  value: 24,
  stamp: 32,
  card: { text: 28, at: 24, hold: [1.2, 4] as const, defaultHold: 2.2, perScene: 1 },
} as const;
export const ACCENT_RE = /^#[0-9a-f]{6}$/i;

export interface HudLine { id: string; kind: "line"; edge: (typeof EDGES)[number]; means: string }
export interface HudReadout { id: string; kind: "readout"; corner: (typeof CORNERS)[number]; rows: string[]; means: string }
export interface HudStamp { id: string; kind: "stamp"; corner: (typeof CORNERS)[number]; means: string }
export type HudElement = HudLine | HudReadout | HudStamp;

export interface Graphics {
  accent: string;
  subtitles: (typeof SUBTITLE_MODES)[number];
  chapters: (typeof CHAPTER_MODES)[number];
  hud: HudElement[];
}
/** What ONE scene says to the layer: a line's state, a readout's values (one per row), a stamp's text. */
export type SceneHud = Record<string, string | string[]>;
export interface Card { at?: string; text: string; hold: number }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const slug = (v: unknown): string => clip(v, GL.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, GL.id);

/** "None" in every spelling a model or a person uses for it. */
export function isNoLayer(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === false || raw === "") return true;
  if (typeof raw === "string") return /^(none|no|nessuno|nessuna|no layer|null)$/i.test(raw.trim());
  if (isObj(raw)) {
    if (raw.layer === "none" || raw.none === true) return true;
    return !Array.isArray(raw.hud) || raw.hud.length === 0 ? (raw.subtitles ?? "none") === "none" && (raw.chapters ?? "none") === "none" : false;
  }
  return false;
}

/** An unbroken run of whole words of the voice, case ignored, punctuation included: the same rule as a shot's `at`. */
export function quotesWords(at: string, voice: string): boolean {
  const a = at.trim().toLowerCase(), v = voice.toLowerCase();
  if (!a || !v) return false;
  let from = 0;
  for (;;) {
    const i = v.indexOf(a, from);
    if (i < 0) return false;
    const before = i === 0 ? " " : v[i - 1], after = i + a.length >= v.length ? " " : v[i + a.length];
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    from = i + 1;
  }
}

/* ------------------------------------------------------------------ the layer itself */

/** Why a layer is refused, in words the model (or the assistant that wrote it) can act on. Empty = a layer. */
export function graphicsProblems(raw: unknown): string[] {
  const out: string[] = [];
  if (!isObj(raw)) return ["graphics: must be an object, or absent when the film has no layer"];
  if (typeof raw.accent !== "string" || !ACCENT_RE.test(raw.accent)) out.push(`graphics.accent: a hex colour like #ffb347, the one ink of the layer`);
  if (raw.subtitles !== undefined && !(SUBTITLE_MODES as readonly string[]).includes(String(raw.subtitles))) out.push(`graphics.subtitles: ${SUBTITLE_MODES.join(" or ")}`);
  if (raw.chapters !== undefined && !(CHAPTER_MODES as readonly string[]).includes(String(raw.chapters))) out.push(`graphics.chapters: ${CHAPTER_MODES.join(" or ")}`);
  const hud = raw.hud === undefined ? [] : raw.hud;
  if (!Array.isArray(hud)) return [...out, "graphics.hud: a list of 0-3 elements"];
  if (hud.length > GL.hud.max) out.push(`graphics.hud: ${hud.length} elements, at most ${GL.hud.max} — a layer the viewer cannot read is decoration`);
  const ids = new Set<string>();
  hud.forEach((h, i) => {
    const hl = `graphics.hud[${i + 1}]`;
    if (!isObj(h)) { out.push(`${hl}: must be an object`); return; }
    const id = slug(h.id);
    if (!id) out.push(`${hl}: needs an id (a short slug the scenes refer to, like "signal")`);
    else if (ids.has(id)) out.push(`${hl}: id "${id}" is used twice`);
    ids.add(id);
    if (!(HUD_KINDS as readonly string[]).includes(String(h.kind))) out.push(`${hl}: kind must be one of ${HUD_KINDS.join(", ")}`);
    if (typeof h.means !== "string" || h.means.trim().length < 3) out.push(`${hl}: "means" says what this element stands for in the film, in a few words`);
    if (h.kind === "line" && !(EDGES as readonly string[]).includes(String(h.edge))) out.push(`${hl}: a line runs along an edge: ${EDGES.join(" or ")}`);
    if ((h.kind === "readout" || h.kind === "stamp") && !(CORNERS as readonly string[]).includes(String(h.corner))) out.push(`${hl}: a ${String(h.kind)} sits in a corner: ${CORNERS.join(", ")}`);
    if (h.kind === "readout") {
      const rows = Array.isArray(h.rows) ? h.rows.filter((r) => typeof r === "string" && r.trim()) : [];
      if (rows.length < GL.rows.min || rows.length > GL.rows.max) out.push(`${hl}: a readout has ${GL.rows.min}-${GL.rows.max} rows, each a short label (EARTH, VOYAGER, ONE-WAY)`);
      else for (const r of rows) if ((r as string).length > GL.rows.len) out.push(`${hl}: row label "${r}" is longer than ${GL.rows.len} characters`);
    }
  });
  return out;
}

/** The layer, fitted to the grammar: ids slugged, strings clipped, unknown fields dropped; null when it is not a layer. */
export function repairGraphics(raw: unknown): Graphics | null {
  if (isNoLayer(raw) || !isObj(raw)) return null;
  const hudIn = Array.isArray(raw.hud) ? raw.hud.filter(isObj) : [];
  const seen = new Set<string>();
  const hud: HudElement[] = [];
  for (const h of hudIn) {
    const id = slug(h.id) || slug(h.kind);
    if (!id || seen.has(id)) continue;
    const means = clip(h.means, GL.means);
    if (h.kind === "line") hud.push({ id, kind: "line", edge: (EDGES as readonly string[]).includes(String(h.edge)) ? (h.edge as HudLine["edge"]) : "bottom", means });
    else if (h.kind === "readout") hud.push({ id, kind: "readout", corner: (CORNERS as readonly string[]).includes(String(h.corner)) ? (h.corner as HudReadout["corner"]) : "top-right", rows: (Array.isArray(h.rows) ? h.rows : []).map((r) => clip(r, GL.rows.len).toUpperCase()).filter(Boolean).slice(0, GL.rows.max), means });
    else if (h.kind === "stamp") hud.push({ id, kind: "stamp", corner: (CORNERS as readonly string[]).includes(String(h.corner)) ? (h.corner as HudStamp["corner"]) : "top-left", means });
    else continue;
    seen.add(id);
  }
  const accent = typeof raw.accent === "string" && ACCENT_RE.test(raw.accent.trim()) ? raw.accent.trim().toLowerCase() : "";
  const g: Graphics = {
    accent: accent || "#ffffff",
    subtitles: raw.subtitles === "cinema" ? "cinema" : "none",
    chapters: raw.chapters === "film" ? "film" : "none",
    hud: hud.slice(0, GL.hud.max),
  };
  if (!g.hud.length && g.subtitles === "none" && g.chapters === "none") return null;   // a layer with nothing on it is no layer
  return graphicsProblems(g).length ? null : g;
}

/** The layer a storyboard carries, or null. */
export function graphicsOf(sb: unknown): Graphics | null {
  return isObj(sb) && isObj(sb.graphics) ? repairGraphics(sb.graphics) : null;
}

/* ------------------------------------------------------------------ what one scene says to the layer */

/** Why a scene's `hud` is refused against the film's layer. */
export function sceneHudProblems(g: Graphics, hud: unknown, label: string): string[] {
  const out: string[] = [];
  if (hud === undefined) return out;
  const map = hudAsMap(hud);
  if (!map) return [`${label} hud: an object keyed by element id ({"signal": "square", "clocks": ["…", "…"]})`];
  const known = new Map(g.hud.map((h) => [h.id, h]));
  for (const [id, v] of Object.entries(map)) {
    const h = known.get(id);
    if (!h) { out.push(`${label} hud: "${id}" is not an element of this film's layer (${[...known.keys()].join(", ") || "none"})`); continue; }
    if (h.kind === "line") { if (typeof v !== "string" || !(LINE_STATES as readonly string[]).includes(v)) out.push(`${label} hud.${id}: a line's state is one of ${LINE_STATES.join(", ")}`); }
    else if (h.kind === "readout") {
      if (!Array.isArray(v) || v.length !== h.rows.length) out.push(`${label} hud.${id}: ${h.rows.length} values, one per row (${h.rows.join(", ")})`);
      else for (const x of v) if (typeof x !== "string" || x.length > GL.value) out.push(`${label} hud.${id}: each value is text of at most ${GL.value} characters`);
    } else if (typeof v !== "string" || v.length > GL.stamp) out.push(`${label} hud.${id}: a stamp is one line of at most ${GL.stamp} characters`);
  }
  return out;
}

/** A scene's hud as a map, from the object form or the model's list form [{id, state | values | value}]. */
function hudAsMap(hud: unknown): Record<string, unknown> | null {
  if (isObj(hud)) return hud;
  if (!Array.isArray(hud)) return null;
  const out: Record<string, unknown> = {};
  for (const e of hud) {
    if (!isObj(e)) continue;
    const id = slug(e.id);
    if (!id) continue;
    out[id] = e.values !== undefined ? e.values : e.state !== undefined ? e.state : e.value;
  }
  return out;
}

/** A scene's hud fitted to the layer: unknown ids and bad values dropped, values clipped, states lowercased. */
export function repairSceneHud(g: Graphics, hud: unknown): SceneHud {
  const map = hudAsMap(hud) ?? {};
  const out: SceneHud = {};
  for (const h of g.hud) {
    const v = map[h.id];
    if (v === undefined) continue;
    if (h.kind === "line") { const s = String(v).trim().toLowerCase(); if ((LINE_STATES as readonly string[]).includes(s)) out[h.id] = s; }
    else if (h.kind === "readout") {
      const vals = (Array.isArray(v) ? v : typeof v === "string" ? v.split("|") : []).map((x) => clip(x, GL.value));
      if (vals.length === h.rows.length) out[h.id] = vals;
      else if (vals.length > h.rows.length) out[h.id] = vals.slice(0, h.rows.length);
      else if (vals.length) out[h.id] = [...vals, ...new Array(h.rows.length - vals.length).fill("")];
    } else { const s = clip(v, GL.stamp); if (s) out[h.id] = s; }
  }
  return out;
}

export function cardProblems(cards: unknown, voice: string, label: string): string[] {
  const out: string[] = [];
  if (cards === undefined) return out;
  if (!Array.isArray(cards)) return [`${label} cards: a list of at most ${GL.card.perScene} card`];
  if (cards.length > GL.card.perScene) out.push(`${label} cards: ${cards.length}, at most ${GL.card.perScene} per scene — a card is for the one number the viewer must read`);
  cards.forEach((c, i) => {
    const cl = `${label} card ${i + 1}`;
    if (!isObj(c)) { out.push(`${cl}: must be an object`); return; }
    if (typeof c.text !== "string" || !c.text.trim()) out.push(`${cl}: needs text`);
    else if (c.text.length > GL.card.text) out.push(`${cl}: text is ${c.text.length} characters, the limit is ${GL.card.text} — a card is a number or a date, not a sentence`);
    if (c.at !== undefined && (typeof c.at !== "string" || c.at.length > GL.card.at || !quotesWords(c.at, voice))) out.push(`${cl}: at must quote whole words from this scene's voice (${GL.card.at} characters at most)`);
    if (c.hold !== undefined && (typeof c.hold !== "number" || c.hold < GL.card.hold[0] || c.hold > GL.card.hold[1])) out.push(`${cl}: hold is seconds between ${GL.card.hold[0]} and ${GL.card.hold[1]}`);
  });
  return out;
}

/** A scene's cards fitted: at most one, anchored to the voice or to the scene start, held within the window. */
export function repairCards(cards: unknown, voice: string): Card[] {
  if (!Array.isArray(cards)) return [];
  const out: Card[] = [];
  for (const c of cards) {
    if (!isObj(c)) continue;
    const text = clip(c.text, GL.card.text);
    if (!text) continue;
    const at = typeof c.at === "string" && c.at.trim() && c.at.length <= GL.card.at && quotesWords(c.at, voice) ? c.at.trim() : undefined;
    const hold = typeof c.hold === "number" && isFinite(c.hold) ? Math.min(GL.card.hold[1], Math.max(GL.card.hold[0], c.hold)) : GL.card.defaultHold;
    out.push({ ...(at ? { at } : {}), text, hold });
    if (out.length >= GL.card.perScene) break;
  }
  return out;
}

/* ------------------------------------------------------------------ the words the model reads */

/** The grammar as the treatment's method prints it: what a layer may be made of, and the bar for having one. */
export const LAYER_METHOD = `THE LAYER (what is drawn over the film). Decide it for THIS film; "none" is a legal answer and the usual one for a film that is a place, a face or a thing. A layer earns its place only when the film is about something the viewer has to READ: a number that keeps changing, a date, a delay, a distance, a state that holds through the film. THE TEST: if the request itself contains a date, a distance, a duration, a delay, a count or a quantity, the film HAS a layer — at least a readout or a card that shows that figure — and the pictures never draw it (no diagrams, no screens with text: the layer is where numbers live). The grammar is closed — nothing outside it exists:
- a LINE along the bottom or the top edge whose state changes scene by scene (${LINE_STATES.join(", ")}); it carries ONE meaning through the whole film ("the health of the link").
- a READOUT in a corner: ${GL.rows.min}-${GL.rows.max} monospace rows, each a short label the film keeps and a value the scenes update ("EARTH · VOYAGER · ONE-WAY").
- a STAMP in a corner: one short line the scenes may change (a place, a date, a time).
- CARDS: a number or a date the viewer must read, alone, centred, held two seconds on a dim; at most one per scene, cut on a spoken word.
- SUBTITLES "cinema" (thin, white, lowercase, no karaoke) or "none"; CHAPTERS "film" (the scene's chapter in light capitals) or "none".
- the ACCENT: one hex colour from the film's own palette, the only ink the layer uses.
At most ${GL.hud.max} elements. Every element means one thing and is named for it. No icons, no logos, no lower thirds, no sentences on cards, no music.`;

/** The layer as the direction, the outline and the scenes read it. */
export function graphicsBlock(g: Graphics): string {
  const el = g.hud.map((h) =>
    h.kind === "line" ? `  - "${h.id}": a line along the ${h.edge} edge — ${h.means}; each scene sets its state: ${LINE_STATES.join(" | ")}`
    : h.kind === "readout" ? `  - "${h.id}": a readout in the ${h.corner} corner with rows ${h.rows.map((r) => `"${r}"`).join(", ")} — ${h.means}; each scene gives ${h.rows.length} values (<=${GL.value} chars each)`
    : `  - "${h.id}": a stamp in the ${h.corner} corner — ${h.means}; each scene gives one line (<=${GL.stamp} chars)`).join("\n");
  return `THE LAYER OF THIS FILM (accent ${g.accent}; subtitles: ${g.subtitles}; chapters: ${g.chapters}):
${el || "  (no persistent element)"}
Every scene carries "hud" (the state or values of each element above, by id) and may carry "cards": [{"at":"<words of its voice>","text":"<=${GL.card.text} chars, a number or a date","hold":${GL.card.defaultHold}}] — at most ${GL.card.perScene} card per scene, only for a figure the viewer must read.`;
}

/** The JSON shape a scene's layer fields take, for the planner's constrained decoding. */
export function sceneHudSchema(g: Graphics): Record<string, unknown> {
  const str = { type: "string" };
  return {
    hud: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id"],
        properties: { id: { type: "string", enum: g.hud.map((h) => h.id) }, state: { type: "string", enum: [...LINE_STATES] }, values: { type: "array", items: str }, value: str },
      },
    },
    cards: { type: "array", items: { type: "object", additionalProperties: false, required: ["text"], properties: { at: str, text: str, hold: { type: "number" } } } },
  };
}
