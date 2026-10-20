/**
 * KLEO STUDIO — BACKUP PROVIDERS (20 October 2026).
 *
 * ePhone ran out of credit and Studio stopped generating. The owner's rule: ePhone stays first for every model; when it
 * refuses an order for money (402) or is down (429, 5xx, unreachable), the order goes to the cheapest other provider
 * that sells the SAME model — but only where that provider costs the same as ePhone or less. Where the other providers
 * are dearer (Seedance 2.5 and 2.0, Veo 3.1, FLUX 3, Kling Avatar and lip sync, speech, the chat models…) nothing moves:
 * the owner decides those himself (kleo\PROVIDER_COSTS.md, section 6).
 *
 * Every price below was read on 20 October 2026 from APIMart's playground estimate and price API (Gold level, what our
 * account pays) and from WaveSpeed's price API with our account's discount. ePhone's figures are the ones in
 * models.ts, image-models.ts and tools.ts.
 *
 *   ePhone model                         backup                                    ePhone → backup
 *   doubao-seedance-2-0-fast-260128      APIMart seedance-2.0-fast                 480p $0.048 → $0.040/s · 720p $0.103 → $0.086/s
 *                                                                                  (reference video: $0.028 → $0.024 / $0.062 → $0.051 per s)
 *   veo-3.1-fast-generate-preview        APIMart veo3.1-fast-official, 720p only   $0.0795 → $0.080/s with sound (1080p is $0.096: stays)
 *   kling-3.0-omni/omni-video            APIMart kling-v3-omni                     $0.103 → $0.101/s (720p) · $0.137 → $0.134/s (1080p)
 *   kling-o1/omni-video                  APIMart kling-video-o1                    the same
 *   kling-3.0/motion-control             APIMart kling-v3-motion-control           $0.1029 → $0.1029/s · $0.1371 → $0.1371/s
 *   happyhorse-1.0-video-edit            APIMart happyhorse-1.0 (edit)             $0.206 → $0.13 per clip second (720P)
 *   gemini-3-pro-image                   APIMart gemini-3-pro-image-preview (ext)  $0.071 → $0.03 (1K-2K) · $0.127 → $0.04 (4K)
 *   gemini-3.1-flash-image               APIMart gemini-3.1-flash-image-preview    $0.036/$0.053/$0.080 → $0.015/$0.02/$0.025
 *   gemini-nano-banana-2.1               APIMart gemini-nano-banana-2.1-ext        $0.022/$0.031/$0.064 → $0.02/$0.025/$0.03
 *   doubao-seedream-5-0-260128 (lite)    APIMart seedream-5-0-lite                 $0.0283 → $0.028
 *   suno/music                           APIMart suno (v6)                         $0.064 → $0.05
 *   suno/sounds                          APIMart suno sounds (v6)                  $0.055 → $0.0096
 *   gpt-image-2.5-sunburst (≤ 3 refs)    WaveSpeed gpt-image-2.5-sunburst, high    priced by Kleo at $0.15/$0.30 → $0.09-0.135 / $0.15-0.195
 *   flux-2-pro with 2-3 references       WaveSpeed flux-2-pro/edit                 ≈ $0.06 → $0.06 (Character Swap's first frame)
 *
 * "ext" is APIMart's third-party route to the same Google model (its own page: "both use the same upstream model"),
 * priced per picture. `official_fallback` is sent false: a fallback to Google's own route is billed by tokens at about
 * three times ePhone's price, so an ext failure fails (and is refunded) instead.
 *
 * Pure module (no Env, no fetch): the tests import it directly.
 */

export type BackupProvider = "apimart" | "wavespeed";

export interface BackupRoute {
  provider: BackupProvider;
  /** The provider's model id. */
  model: string;
  /** APIMart: the submit path. WaveSpeed: the model slug (POST /api/v3/<slug>). */
  path: string;
  body: Record<string, unknown>;
  /** APIMart music tasks are read at /v1/music/tasks/<id>. */
  music?: boolean;
  /** What the backup charges for this order, when the order alone says it (for the audit); null when it depends on a clip's length. */
  usd: number | null;
}

const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * The routes an order Kleo priced at `budgetUsd` (the ePhone cost its credits were set from) may take: a backup that
 * would cost more than that is never used. A plain FLUX.2 Pro picture with references is priced at ePhone's
 * first-megapixel rate, so WaveSpeed's flat edit price is skipped there and taken only for Character Swap's frame.
 * Within 1%: Veo 3.1 Fast at 720p is $0.0800 against $0.0795 a second.
 */
export const withinBudget = (routes: BackupRoute[], budgetUsd: number | null | undefined): BackupRoute[] =>
  budgetUsd === null || budgetUsd === undefined || !(budgetUsd > 0) ? routes : routes.filter((r) => r.usd === null || r.usd <= budgetUsd * 1.01 + 1e-9);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const urls = (v: unknown): string[] => (Array.isArray(v) ? v.filter((u): u is string => typeof u === "string" && u.length > 0) : []);
const num = (v: unknown, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** Kleo's Gemini quality, in either spelling ePhone was sent, as APIMart's resolution tier. */
export function geminiTier(q: unknown): "1K" | "2K" | "4K" {
  const v = str(q).toUpperCase();
  if (v === "4K" || v === "MAX") return "4K";
  if (v === "2K" || v === "HIGH") return "2K";
  return "1K";
}

/** Kleo's Seedream pixel sizes (image-models.ts) back to their aspect. */
const SEEDREAM_ASPECT: Record<string, string> = {
  "2048x2048": "1:1", "2304x1728": "4:3", "1728x2304": "3:4", "2560x1440": "16:9", "1440x2560": "9:16", "2496x1664": "3:2", "1664x2496": "2:3", "3024x1296": "21:9",
};

/** The aspect WaveSpeed's GPT Image offers nearest to a "WxH" size. */
const GPT_ASPECTS = ["1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "9:21", "21:9"];
export function gptAspect(size: string): { aspect: string; resolution: "1k" | "2k" } {
  const [w, h] = size.split("x").map(Number);
  if (!(w > 0 && h > 0)) return { aspect: "1:1", resolution: "1k" };
  const r = w / h;
  const aspect = GPT_ASPECTS.reduce((best, a) => {
    const [x, y] = a.split(":").map(Number);
    const [bx, by] = best.split(":").map(Number);
    return Math.abs(Math.log(x / y / r)) < Math.abs(Math.log(bx / by / r)) ? a : best;
  });
  return { aspect, resolution: w * h > 2_400_000 ? "2k" : "1k" };
}

/** APIMart's verified per-second prices for Seedance 2.0 Fast (Gold), without and with a reference video. */
const FAST_PER_S: Record<string, number> = { "480p": 0.03984, "720p": 0.0856 };
const FAST_REF_PER_S: Record<string, number> = { "480p": 0.02368, "720p": 0.05128 };

/**
 * The backups of one ePhone order, cheapest first, built from the very input ePhone was sent. Empty when the model has
 * none, or when this order would cost more on the backup than on ePhone.
 */
export function backupRoutes(ephoneModel: string, input: Record<string, unknown>): BackupRoute[] {
  const prompt = str(input.prompt);
  switch (ephoneModel) {
    case "doubao-seedance-2-0-fast-260128": {
      const res = str(input.resolution) || "720p";
      if (!FAST_PER_S[res]) return [];
      const duration = num(input.duration, 5);
      const body: Record<string, unknown> = {
        model: "seedance-2.0-fast", prompt, duration, resolution: res, size: str(input.aspect_ratio) || "16:9", generate_audio: input.generate_audio !== false,
      };
      const first = str(input.first_frame);
      const refs = urls(input.reference_images), videos = urls(input.reference_videos), audios = urls(input.reference_audio);
      if (first) body.image_with_roles = [{ url: first, role: "first_frame" }];
      else if (refs.length) body.image_urls = refs.slice(0, 9);
      if (videos.length) body.video_urls = videos.slice(0, 3);
      if (audios.length) body.audio_urls = audios.slice(0, 3);
      // With a reference video APIMart bills reference + output seconds at its lower rate; the clip's length is not
      // in the input, so the audit shows the output part only.
      const usd = r4((videos.length ? FAST_REF_PER_S[res] : FAST_PER_S[res]) * duration);
      return [{ provider: "apimart", model: "seedance-2.0-fast", path: "/v1/videos/generations", body, usd }];
    }
    case "veo-3.1-fast-generate-preview": {
      // Only 720p costs the same (with sound $0.08 against ePhone's $0.0795 a second); APIMart's 1080p is 21% dearer.
      // APIMart's official Veo takes a first frame but no reference pictures.
      if (str(input.resolution) !== "720p" || urls(input.reference_images).length) return [];
      const duration = num(input.duration, 8), audio = input.generate_audio !== false;
      const body: Record<string, unknown> = {
        model: "veo3.1-fast-official", prompt, duration, aspect_ratio: str(input.aspect_ratio) === "9:16" ? "9:16" : "16:9", resolution: "720p",
        generate_audio: audio, person_generation: "allow_adult",
      };
      const first = urls(input.images)[0];
      if (first) body.first_frame_image = first;
      return [{ provider: "apimart", model: "veo3.1-fast-official", path: "/v1/videos/generations", body, usd: r4((audio ? 0.08 : 0.064) * duration) }];
    }
    case "kling-3.0-omni/omni-video": {
      // "Move my picture like this video": the picture is the first frame, the clip a feature reference.
      const contents = Array.isArray(input.contents) ? (input.contents as Record<string, unknown>[]) : [];
      const settings = (input.settings ?? {}) as Record<string, unknown>;
      const text = str(contents.find((c) => c.type === "prompt")?.text);
      const first = str(contents.find((c) => c.type === "first_frame")?.url);
      const video = str(contents.find((c) => c.type === "feature_video")?.url);
      if (!first || !video) return [];
      const pro = str(settings.resolution) === "1080p";
      const duration = Math.max(3, Math.min(15, num(settings.duration, 5)));
      return [{
        provider: "apimart", model: "kling-v3-omni", path: "/v1/videos/generations",
        body: {
          model: "kling-v3-omni", prompt: text.slice(0, 2500), mode: pro ? "pro" : "std", duration, aspect_ratio: str(settings.aspect_ratio) || "16:9",
          image_with_roles: [{ url: first, role: "first_frame" }], video_list: [{ video_url: video, refer_type: "feature", keep_original_sound: "no" }],
        },
        usd: r4((pro ? 0.1344 : 0.1008) * duration),
      }];
    }
    case "kling-o1/omni-video": {
      // Character Swap: edit the base video with the redrawn first frame and the character as references, keep its sound.
      const contents = Array.isArray(input.contents) ? (input.contents as Record<string, unknown>[]) : [];
      const settings = (input.settings ?? {}) as Record<string, unknown>;
      const text = str(contents.find((c) => c.type === "prompt")?.text);
      const base = str(contents.find((c) => c.type === "base_video")?.url);
      const refs = contents.filter((c) => c.type === "refer_image").map((c) => str(c.url)).filter(Boolean);
      if (!base) return [];
      const named = refs.map((_, i) => `<<<image_${i + 1}>>> is reference image ${i + 1}.`).join(" ");
      return [{
        provider: "apimart", model: "kling-video-o1", path: "/v1/videos/generations",
        body: {
          model: "kling-video-o1", prompt: `${named} ${text}`.trim().slice(0, 2500), mode: str(settings.resolution) === "1080p" ? "pro" : "std",
          aspect_ratio: str(settings.aspect_ratio) || "16:9",
          video_list: [{ video_url: base, refer_type: "base", keep_original_sound: settings.audio === "original" ? "yes" : "no" }],
          ...(refs.length ? { image_with_roles: refs.map((url) => ({ url, role: "reference" })) } : {}),
        },
        usd: null,
      }];
    }
    case "kling-3.0/motion-control": {
      const contents = Array.isArray(input.contents) ? (input.contents as Record<string, unknown>[]) : [];
      const settings = (input.settings ?? {}) as Record<string, unknown>;
      const image = str(contents.find((c) => c.type === "image")?.url);
      const video = str(contents.find((c) => c.type === "video")?.url);
      if (!image || !video) return [];
      const text = str(contents.find((c) => c.type === "prompt")?.text);
      return [{
        provider: "apimart", model: "kling-v3-motion-control", path: "/v1/videos/generations",
        body: {
          model: "kling-v3-motion-control", ...(text ? { prompt: text } : {}), image_url: image, video_url: video,
          character_orientation: str(settings.character_orientation) || "video", mode: str(settings.resolution) === "1080p" ? "pro" : "std",
          keep_original_sound: settings.audio === "original" ? "yes" : "no",
        },
        usd: null,
      }];
    }
    case "happyhorse-1.0-video-edit": {
      // Video Face Swap. ePhone bills the source and the output seconds; APIMart only the output (= the source length).
      const video = str(input.video);
      if (!video) return [];
      return [{
        provider: "apimart", model: "happyhorse-1.0", path: "/v1/videos/generations",
        body: {
          model: "happyhorse-1.0", prompt, video_url: video, image_urls: urls(input.images).slice(0, 5),
          resolution: str(input.resolution).toUpperCase() === "1080P" ? "1080P" : "720P", audio_setting: str(input.audio_setting) || "origin", watermark: false,
        },
        usd: null,
      }];
    }
    case "gemini-3-pro-image":
    case "gemini-3.1-flash-image":
    case "gemini-nano-banana-2.1": {
      const tier = geminiTier(input.quality);
      const ext = ephoneModel === "gemini-3-pro-image" ? { model: "gemini-3-pro-image-preview", usd: { "1K": 0.03, "2K": 0.03, "4K": 0.04 } }
        : ephoneModel === "gemini-3.1-flash-image" ? { model: "gemini-3.1-flash-image-preview", usd: { "1K": 0.015, "2K": 0.02, "4K": 0.025 } }
          : { model: "gemini-nano-banana-2.1-ext", usd: { "1K": 0.02, "2K": 0.025, "4K": 0.03 } };
      const images = urls(input.images);
      return [{
        provider: "apimart", model: ext.model, path: "/v1/images/generations",
        body: { model: ext.model, prompt, size: str(input.aspect_ratio) || "1:1", resolution: tier, n: 1, official_fallback: false, ...(images.length ? { image_urls: images.slice(0, 14) } : {}) },
        usd: ext.usd[tier],
      }];
    }
    case "doubao-seedream-5-0-260128": {
      const images = urls(input.images);
      return [{
        provider: "apimart", model: "seedream-5-0-lite", path: "/v1/images/generations",
        body: {
          model: "seedream-5-0-lite", prompt, size: SEEDREAM_ASPECT[str(input.size)] ?? "1:1", resolution: "2K", n: 1, output_format: "jpeg", watermark: false,
          ...(images.length ? { image_urls: images.slice(0, 14) } : {}),
        },
        usd: 0.028,
      }];
    }
    case "suno/music": {
      const idea = str(input.gpt_description_prompt) || prompt;
      if (!idea || input.custom === true) return [];
      const gender = str(input.vocal_gender);
      return [{
        provider: "apimart", model: "suno", path: "/v1/music/generations", music: true,
        body: { model: "suno", custom: false, version: "v6", prompt: idea.slice(0, 3000), instrumental: input.instrumental === true, ...(gender ? { vocal_gender: gender } : {}) },
        usd: 0.05,
      }];
    }
    case "suno/sounds": {
      const sound = str(input.sound) || prompt;
      if (!sound) return [];
      return [{
        provider: "apimart", model: "suno", path: "/v1/music/generations/sounds", music: true,
        body: { model: "suno", version: "v6", prompt: sound.slice(0, 300), type: str(input.type) === "loop" ? "loop" : "one-shot" },
        usd: 0.0096,
      }];
    }
    case "gpt-image-2.5-sunburst": {
      // WaveSpeed's flat price, high quality; each reference past the first adds $0.015, so more than three would cost
      // more than Kleo's own price for the picture.
      const images = urls(input.images);
      if (images.length > 3) return [];
      const { aspect, resolution } = gptAspect(str(input.size));
      const edit = images.length > 0;
      const slug = `openai/gpt-image-2.5-sunburst/${edit ? "edit" : "text-to-image"}`;
      const base = resolution === "2k" ? (edit ? 0.165 : 0.15) : (edit ? 0.105 : 0.09);
      return [{
        provider: "wavespeed", model: slug, path: slug,
        body: { prompt, aspect_ratio: aspect, resolution, quality: "high", output_format: "jpeg", ...(edit ? { images } : {}) },
        usd: r4(base + Math.max(0, images.length - 1) * 0.015),
      }];
    }
    case "flux-2-pro": {
      // Only an edit with two or three references (Character Swap's first frame) costs the same on WaveSpeed ($0.06 flat;
      // ePhone bills each reference's megapixels and came to $0.06 on 18 October). A plain FLUX.2 Pro picture stays.
      const images = urls(input.images);
      if (images.length < 2 || images.length > 3) return [];
      return [{ provider: "wavespeed", model: "wavespeed-ai/flux-2-pro/edit", path: "wavespeed-ai/flux-2-pro/edit", body: { prompt, images }, usd: 0.06 }];
    }
  }
  return [];
}
