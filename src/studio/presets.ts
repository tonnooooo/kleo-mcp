/**
 * KLEO STUDIO — CAMERA AND EFFECT PRESETS, the one-tap motions Higgsfield made popular. A preset is a sentence added
 * to the video prompt, written the way Seedance and Veo follow it best (camera first, then the effect, in plain
 * words). The page shows them as a grid; the agent and the direct mode both add the chosen one to the prompt.
 *
 * Pure module, shared by the Worker and (as JSON from /api/config) the page.
 */

export interface Preset { key: string; name: string; group: "camera" | "effect" | "style"; hint: string; text: string; tint: string }

export const PRESETS: Preset[] = [
  // camera moves
  { key: "crash-zoom", name: "Crash Zoom", group: "camera", hint: "Fast punch-in", tint: "#ff375f", text: "Camera: a sudden fast crash zoom pushes in onto the subject, then holds steady." },
  { key: "dolly-zoom", name: "Dolly Zoom", group: "camera", hint: "Vertigo effect", tint: "#bf5af2", text: "Camera: a dolly zoom (vertigo effect) — the camera moves back while zooming in, the background stretches behind the subject." },
  { key: "orbit-360", name: "360 Orbit", group: "camera", hint: "Circle the subject", tint: "#0a84ff", text: "Camera: a smooth 360-degree orbit around the subject at eye level." },
  { key: "fpv-drone", name: "FPV Drone", group: "camera", hint: "Fast fly-through", tint: "#30d158", text: "Camera: a fast FPV drone flight that dives and weaves through the scene, ending close on the subject." },
  { key: "crane-up", name: "Crane Up", group: "camera", hint: "Rise and reveal", tint: "#64d2ff", text: "Camera: a slow crane shot rising up and pulling back to reveal the whole scene." },
  { key: "dolly-in", name: "Slow Push-In", group: "camera", hint: "Cinematic tension", tint: "#ffd60a", text: "Camera: a slow, steady dolly push-in toward the subject's face." },
  { key: "dolly-out", name: "Super Pull-Out", group: "camera", hint: "Huge reveal", tint: "#ff9f0a", text: "Camera: a continuous pull-out that starts close on the subject and ends on a vast wide shot." },
  { key: "whip-pan", name: "Whip Pan", group: "camera", hint: "Snappy transition", tint: "#ff453a", text: "Camera: a quick whip pan with motion blur that snaps onto the subject." },
  { key: "handheld", name: "Handheld", group: "camera", hint: "Raw and real", tint: "#8e8e93", text: "Camera: handheld documentary style, natural shake, following the action closely." },
  { key: "bullet-time", name: "Bullet Time", group: "camera", hint: "Frozen moment", tint: "#5e5ce6", text: "Camera: bullet time — the action freezes in slow motion while the camera sweeps around it." },
  { key: "earth-zoom-out", name: "Earth Zoom Out", group: "camera", hint: "From face to space", tint: "#32ade6", text: "Camera: a continuous zoom out from the subject up through the sky until the whole Earth is visible from space." },
  { key: "top-down", name: "Top Down", group: "camera", hint: "Bird's-eye view", tint: "#66d4cf", text: "Camera: a top-down bird's-eye view slowly rotating above the subject." },
  // effects
  { key: "disintegrate", name: "Disintegration", group: "effect", hint: "Turns to dust", tint: "#a2845e", text: "Effect: the subject slowly disintegrates into glowing particles that drift away in the wind." },
  { key: "levitate", name: "Levitation", group: "effect", hint: "Floats up", tint: "#ac8e68", text: "Effect: the subject gently levitates off the ground, hair and clothes floating as if gravity faded." },
  { key: "explosion", name: "Explosion", group: "effect", hint: "Boom behind", tint: "#ff6b00", text: "Effect: a huge cinematic explosion erupts behind the subject, who walks calmly toward the camera." },
  { key: "melt", name: "Melting", group: "effect", hint: "Liquid surreal", tint: "#ff8a65", text: "Effect: the subject slowly melts into glossy liquid that pools on the floor, surreal and smooth." },
  { key: "lightning", name: "Thunder God", group: "effect", hint: "Electric power", tint: "#7d7aff", text: "Effect: crackling blue lightning wraps around the subject, eyes glowing, storm clouds swirling above." },
  { key: "paint-splash", name: "Paint Splash", group: "effect", hint: "Color burst", tint: "#ff2d55", text: "Effect: bursts of thick colorful paint splash around the subject in slow motion." },
  { key: "portal", name: "Portal", group: "effect", hint: "Step through", tint: "#5856d6", text: "Effect: a glowing swirling portal opens and the subject steps through it." },
  { key: "fire", name: "On Fire", group: "effect", hint: "Flames rise", tint: "#ff3b30", text: "Effect: stylized flames rise around the subject without burning them, embers flying." },
  // styles
  { key: "anime", name: "Anime", group: "style", hint: "Japanese animation", tint: "#ff7eb6", text: "Style: high-quality Japanese anime, cel shading, expressive motion." },
  { key: "clay", name: "Claymation", group: "style", hint: "Stop-motion clay", tint: "#d4a373", text: "Style: stop-motion claymation, handmade textures, slightly choppy frame rate." },
  { key: "vhs", name: "VHS 90s", group: "style", hint: "Retro tape", tint: "#6a994e", text: "Style: 1990s VHS home video, soft focus, color bleed, scan lines, date stamp in the corner." },
  { key: "noir", name: "Film Noir", group: "style", hint: "Black and white", tint: "#3a3a3c", text: "Style: black-and-white film noir, hard shadows through blinds, moody smoke." },
];

export const presetByKey = (key: string | null | undefined): Preset | null => PRESETS.find((p) => p.key === key) ?? null;

/** The prompt with the preset's sentence added (once). */
export function withPreset(prompt: string, key: string | null | undefined): string {
  const p = presetByKey(key);
  if (!p || prompt.includes(p.text)) return prompt;
  return `${prompt.trim()}${prompt.trim() ? "\n" : ""}${p.text}`;
}

export const publicPresets = () => PRESETS.map(({ key, name, group, hint, tint }) => ({ key, name, group, hint, tint }));
