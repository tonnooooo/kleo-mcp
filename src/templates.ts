export type Format = "16:9" | "9:16";

export interface Template {
  id: string;
  name: string;
  formats: Format[];
  minSeconds: number;
  maxSeconds: number;
  defaultSeconds: number;
  description: string;
  voices: string[];
}

const EN_IT = ["narrator-en-m", "narrator-en-f", "narrator-it-m", "narrator-it-f"];

export const TEMPLATES: Template[] = [
  { id: "story-documentary", name: "Story / Documentary", formats: ["16:9"], minSeconds: 300, maxSeconds: 720, defaultSeconds: 480,
    description: "Calm narration over cinematic clips, chapter titles, a map or a date when it helps. History, science, true stories.", voices: EN_IT },
  { id: "top-10", name: "Top 10", formats: ["16:9"], minSeconds: 360, maxSeconds: 600, defaultSeconds: 420,
    description: "Countdown with a big on-screen number, one scene per entry, fast cuts on the beat.", voices: EN_IT },
  { id: "viral-short", name: "Viral Short", formats: ["9:16"], minSeconds: 30, maxSeconds: 60, defaultSeconds: 45,
    description: "Hook in the first two seconds, big word-by-word captions, a cut every 2–3 seconds. The default for any Short.", voices: EN_IT },
  { id: "reddit-story", name: "Reddit Story", formats: ["9:16"], minSeconds: 45, maxSeconds: 90, defaultSeconds: 60,
    description: "Post card on top, narrated story, continuous satisfying footage below. Paste the post text in the prompt.", voices: EN_IT },
  { id: "motivational", name: "Motivational", formats: ["9:16", "16:9"], minSeconds: 30, maxSeconds: 90, defaultSeconds: 60,
    description: "Centered quotes, slow-motion epic imagery, music that builds to the end.", voices: EN_IT },
  { id: "explainer", name: "Explainer / Tutorial", formats: ["16:9"], minSeconds: 240, maxSeconds: 480, defaultSeconds: 300,
    description: "Animated diagrams that build while the voice explains, with a recap at the end.", voices: EN_IT },
  { id: "weekly-news", name: "Weekly News", formats: ["16:9"], minSeconds: 180, maxSeconds: 300, defaultSeconds: 240,
    description: "Four stories, lower thirds with headline and source, hard cuts between segments.", voices: EN_IT },
  { id: "cinematic-trailer", name: "Cinematic Trailer", formats: ["16:9"], minSeconds: 60, maxSeconds: 90, defaultSeconds: 75,
    description: "2.39:1 letterbox, title cards between scenes, orchestral score, a beat of silence before the title.", voices: EN_IT },
  { id: "product-review", name: "Product Review", formats: ["16:9"], minSeconds: 240, maxSeconds: 360, defaultSeconds: 300,
    description: "Product centered, pros and cons appearing on the sides, final score and verdict.", voices: EN_IT },
  { id: "did-you-know", name: "Did You Know", formats: ["9:16"], minSeconds: 20, maxSeconds: 40, defaultSeconds: 30,
    description: "One fact per scene, karaoke captions, the image changes on every sentence.", voices: EN_IT },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id) as [string, ...string[]];
export const findTemplate = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

/** Credits: 1 for a Short (≤ 90 s), 3 for up to 5 minutes, +1 per extra minute. Pricing is a draft. */
export const creditsFor = (seconds: number): number => (seconds <= 90 ? 1 : seconds <= 300 ? 3 : 3 + Math.ceil((seconds - 300) / 60));

/** Rough wall-clock estimate on one RTX 4090 at 4K 60 fps: ~25 min for a Short, ~12 min per minute of long-form. */
export const etaFor = (seconds: number): number => (seconds <= 90 ? 25 : Math.max(35, Math.round((seconds / 60) * 12)));
